import { execFile } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { MAX_TEXTURE, type Tier } from '@ats/qa';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import type { BundleFile } from './build.ts';

export interface Conversion {
  path: string;
  /** What was done, in plain words. */
  action: string;
  before: number;
  after: number;
}

export interface ConvertResult {
  conversions: Conversion[];
  notes: string[];
}

/**
 * Makes a built creation lighter without changing how it looks or sounds much: models get
 * compressed geometry and WebP textures (no larger than the tier allows), and sounds that are
 * too loud are brought down to a comfortable level. Files keep their names, so nothing that
 * refers to them breaks. A file is only replaced when the result is smaller or quieter.
 */
export async function convertAssets(
  dir: string,
  files: BundleFile[],
  tier: Tier,
  /** For tests: runs ffmpeg with these arguments (default: the real one). */
  run: FfmpegRunner = ffmpeg,
): Promise<ConvertResult> {
  const result: ConvertResult = { conversions: [], notes: [] };
  const ext = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';

  const models = files.filter((f) => ext(f.path) === 'glb');
  if (files.some((f) => ext(f.path) === 'gltf'))
    result.notes.push(
      'Models in .gltf form are left as they are: use .glb to have them compressed.',
    );
  if (models.length) {
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
    for (const f of models) {
      try {
        const full = join(dir, f.path);
        const doc = await io.read(full);
        const textures = doc.getRoot().listTextures();
        let resized = false;
        for (const t of textures) {
          const image = t.getImage();
          const mime = t.getMimeType();
          if (!image || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) continue;
          const meta = await sharp(image).metadata();
          const big = Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_TEXTURE[tier];
          if (mime === 'image/webp' && !big) continue;
          const normal = doc
            .getGraph()
            .listParentEdges(t)
            .some((e) => e.getName() === 'normalTexture');
          const webp = await sharp(image)
            .resize({
              width: MAX_TEXTURE[tier],
              height: MAX_TEXTURE[tier],
              fit: 'inside',
              withoutEnlargement: true,
            })
            .webp({ quality: normal ? 90 : 82, effort: 4 })
            .toBuffer();
          resized ||= big;
          t.setImage(new Uint8Array(webp)).setMimeType('image/webp');
          if (t.getURI()) t.setURI(t.getURI().replace(/\.(png|jpe?g)$/i, '.webp'));
        }
        if (textures.some((t) => t.getMimeType() === 'image/webp'))
          doc.createExtension(EXTTextureWebP).setRequired(true);
        // A creation's code may look up empty nodes by name (anchors, spots to put things) and
        // read UVs in its own shaders when no texture does, so prune keeps both.
        // It may also turn, move or scale its named parts, so positions stay floats: packing
        // them (as meshopt() does) folds an offset and scale into each part's own transform,
        // and a lid or head would then turn around its middle instead of its joint.
        const notPosition = /^(?!POSITION$).*$/;
        await doc.transform(
          dedup(),
          prune({ keepLeaves: true, keepAttributes: true }),
          reorder({ encoder: MeshoptEncoder, target: 'size' }),
          quantize({ pattern: notPosition, patternTargets: notPosition }),
        );
        doc
          .createExtension(EXTMeshoptCompression)
          .setRequired(true)
          .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
        const out = await io.writeBinary(doc);
        if (out.byteLength < f.bytes || resized) {
          await writeFile(full, out);
          result.conversions.push({
            path: f.path,
            action: resized
              ? `compressed, textures reduced to ${MAX_TEXTURE[tier]} px at most`
              : 'compressed',
            before: f.bytes,
            after: out.byteLength,
          });
          f.bytes = out.byteLength;
        }
      } catch (err) {
        result.notes.push(`${f.path} couldn't be compressed: ${(err as Error).message}`);
      }
    }
  }

  const sounds = files.filter((f) => ['mp3', 'ogg', 'opus', 'wav', 'm4a'].includes(ext(f.path)));
  if (sounds.length && !(await hasFfmpeg(run))) {
    result.notes.push("Sound levels weren't checked (ffmpeg isn't installed).");
  } else {
    // A few at a time: one by one, 158 sounds took most of a build's five minutes on a busy
    // server. Results are reported in file order, whichever finishes first.
    const outcomes = await pool(sounds, SOUND_CONCURRENCY, async (f) => {
      try {
        const change = await tameLoudness(join(dir, f.path), ext(f.path), run);
        return { change };
      } catch (err) {
        return { error: (err as Error).message };
      }
    });
    sounds.forEach((f, i) => {
      const { change, error } = outcomes[i] ?? {};
      if (error !== undefined)
        result.notes.push(`${f.path}: sound level couldn't be checked (${error})`);
      else if (change) {
        result.conversions.push({
          path: f.path,
          action: change.action,
          before: f.bytes,
          after: change.bytes,
        });
        f.bytes = change.bytes;
      }
    });
  }
  return result;
}

/** Loudness targets: EBU R128-style, a little quieter than music streaming. */
const LOUD = { maxLufs: -14, targetLufs: -16, maxPeak: -1, targetPeak: -1.5 };

const CODECS: Record<string, string[]> = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
  ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
  opus: ['-c:a', 'libopus', '-b:a', '128k'],
  wav: ['-c:a', 'pcm_s16le'],
  m4a: ['-c:a', 'aac', '-b:a', '160k'],
};

/** How many sounds are checked at once: each ffmpeg uses about one CPU. */
const SOUND_CONCURRENCY = Math.max(1, Math.min(4, availableParallelism()));

/** Runs `fn` on every item with at most `limit` running at once; results in item order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function tameLoudness(file: string, ext: string, run: FfmpegRunner) {
  const { stderr } = await run([
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ]);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const lufs = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const peak = Number(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]);
  if (!Number.isFinite(lufs) || !Number.isFinite(peak)) return null;
  if (lufs <= LOUD.maxLufs && peak <= LOUD.maxPeak) return null;
  const gain = Math.min(LOUD.targetLufs - lufs, LOUD.targetPeak - peak);
  if (gain >= 0) return null;
  const tmp = `${file}.tmp.${ext}`;
  await run([
    '-hide_banner',
    '-nostats',
    '-y',
    '-i',
    file,
    '-map_metadata',
    '-1',
    '-af',
    `volume=${gain.toFixed(1)}dB`,
    ...(CODECS[ext] ?? []),
    tmp,
  ]);
  await rename(tmp, file).catch(async (e) => {
    await rm(tmp, { force: true });
    throw e;
  });
  return {
    action: `made ${Math.abs(gain).toFixed(1)} dB quieter (it was ${lufs.toFixed(0)} LUFS, peaking at ${peak.toFixed(1)} dB)`,
    bytes: (await readFile(file)).byteLength,
  };
}

export type FfmpegRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

const ffmpeg: FfmpegRunner = (args) => {
  return new Promise((resolve, reject) =>
    execFile(
      'ffmpeg',
      args,
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err
          ? reject(new Error(stderr.split('\n').filter(Boolean).pop() ?? err.message))
          : resolve({ stdout, stderr }),
    ),
  );
};

const ffmpegChecked = new WeakMap<FfmpegRunner, Promise<boolean>>();
function hasFfmpeg(run: FfmpegRunner) {
  let checked = ffmpegChecked.get(run);
  if (!checked) {
    checked = run(['-version']).then(
      () => true,
      () => false,
    );
    ffmpegChecked.set(run, checked);
  }
  return checked;
}
