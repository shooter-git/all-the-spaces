import { execFile } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_TEXTURE, type Tier } from '@ats/qa';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
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
        await doc.transform(
          dedup(),
          prune(),
          meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
        );
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
  if (sounds.length && !(await hasFfmpeg())) {
    result.notes.push("Sound levels weren't checked (ffmpeg isn't installed).");
  } else {
    for (const f of sounds) {
      try {
        const change = await tameLoudness(join(dir, f.path), ext(f.path));
        if (change) {
          result.conversions.push({
            path: f.path,
            action: change.action,
            before: f.bytes,
            after: change.bytes,
          });
          f.bytes = change.bytes;
        }
      } catch (err) {
        result.notes.push(`${f.path}: sound level couldn't be checked (${(err as Error).message})`);
      }
    }
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

async function tameLoudness(file: string, ext: string) {
  const { stderr } = await ffmpeg([
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
  await ffmpeg([
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

function ffmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
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
}

let ffmpegChecked: Promise<boolean> | null = null;
function hasFfmpeg() {
  ffmpegChecked ??= ffmpeg(['-version']).then(
    () => true,
    () => false,
  );
  return ffmpegChecked;
}
