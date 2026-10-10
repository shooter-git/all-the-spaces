#!/usr/bin/env node
/**
 * ats-model: making 3D models in a workspace with Blender (headless, on the CPU), used by
 * `ats model …`. Works in any workspace: a place's furniture, or a creation's props.
 *
 *   ats-model build models/astronaut.py     run a Blender Python script that makes a model; it
 *                                           exports models/astronaut.glb (the path after `--`),
 *                                           which is checked and drawn from four sides
 *   ats-model preview models/sofa.glb       draw any model from four sides
 *   ats-model check [models/x.glb …]        check models the way building the place will
 *
 * Previews go to preview/models/<name>.png: look at them, and compare with the photos.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import sharp from 'sharp';
import { findBlender } from './bake.ts';
import { cleanModel, MODEL_LIMITS, ModelError } from './models.ts';

const run = promisify(execFile);
const BLENDER_DIR = fileURLToPath(new URL('../blender/', import.meta.url));
/** What Architects' scripts can import (`ats_model`), MIT unlike the scripts beside it. */
const HELPERS_DIR = fileURLToPath(new URL('../blender/helpers/', import.meta.url));

const ENGINES: Record<string, string> = {
  cycles: 'CYCLES',
  eevee: 'BLENDER_EEVEE',
  quick: 'BLENDER_WORKBENCH',
};

export function blender(): string {
  const found = findBlender();
  if (!found) throw new Error('Blender isn’t installed in this workspace.');
  return found;
}

/** One Blender at a time in a workspace: each can use a lot of memory. */
const LOCK = join(tmpdir(), 'ats-blender.lock');
/** flock's answer when the lock is taken and it was asked not to wait. */
const BUSY = 200;

/**
 * Runs Blender with a script. Jobs queue (one Blender at a time, so several started together
 * can't use up the workspace's memory), and Blender is the first thing stopped if memory still
 * runs out, never the assistant. Its own messages are passed through when it fails (a Python
 * traceback says what to fix).
 */
export async function runBlender(script: string, scriptArgs: string[], cwd: string) {
  const args = [
    '-b',
    '--factory-startup',
    // Blender otherwise exits successfully even when the script fails.
    '--python-exit-code',
    '1',
    // So scripts can `import ats_model` (helpers for materials and exporting).
    '--python-use-system-env',
    '--python',
    script,
    '--',
    ...scriptArgs,
  ];
  // Raises its own out-of-memory score (allowed without privileges), then becomes Blender.
  const giveWayFirst = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$@"';
  const attempt = (wait: boolean) =>
    run(
      'flock',
      [
        ...(wait ? [] : ['-n', '-E', String(BUSY)]),
        LOCK,
        'sh',
        '-c',
        giveWayFirst,
        'blender',
        blender(),
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, PYTHONPATH: HELPERS_DIR },
        timeout: 30 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  try {
    try {
      return (await attempt(false)).stdout;
    } catch (err) {
      if ((err as { code?: number }).code !== BUSY) throw err;
      console.log('Waiting for another Blender job in this workspace to finish…');
      return (await attempt(true)).stdout;
    }
  } catch (err) {
    const {
      stdout = '',
      stderr = '',
      signal,
      code,
    } = err as {
      stdout?: string;
      stderr?: string;
      signal?: string;
      code?: number;
    };
    if (signal === 'SIGKILL' || code === 137)
      throw new Error(
        'Blender ran out of memory and was stopped (the workspace has a fixed amount). Use fewer or simpler models, fewer --samples, or --engine quick, and run Blender jobs one at a time.',
      );
    const lines = `${stdout}\n${stderr}`
      .split('\n')
      .filter((l) => l.trim() && !/^(Blender quit|Read prefs|Warning: Unable to)/.test(l));
    throw new Error(`Blender stopped with an error:\n${lines.slice(-60).join('\n')}`);
  }
}

/**
 * Smooths a render's grain (Blender's own denoiser isn't in Ubuntu's build): ffmpeg's non-local
 * means keeps edges and texture. Leaves the picture as it is if ffmpeg isn't there.
 */
export async function denoise(png: string) {
  const out = png.replace(/\.png$/, '.clean.png');
  try {
    await run('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-i',
      png,
      '-vf',
      // Colour speckle is the worst of it: colour gets a wider search than brightness.
      'format=yuv444p,nlmeans=s=3:p=5:r=11:pc=7:rc=21,format=rgb24',
      out,
    ]);
    await rename(out, png);
  } catch {
    await rm(out, { force: true });
  }
}

/** Draws a model from four sides into one labelled picture. */
export async function previewModel(
  glbPath: string,
  outPng: string,
  caption: string,
  options: { engine?: string; samples?: number } = {},
) {
  const tmp = await mkdtemp(join(tmpdir(), 'ats-model-'));
  try {
    await writeFile(
      join(tmp, 'settings.json'),
      JSON.stringify({
        size: 512,
        engine: ENGINES[options.engine ?? 'cycles'] ?? 'CYCLES',
        samples: options.samples ?? 48,
      }),
    );
    await runBlender(
      join(BLENDER_DIR, 'render_model.py'),
      [glbPath, tmp, join(tmp, 'settings.json')],
      dirname(glbPath),
    );
    const views = ['front', 'three-quarter', 'side', 'top'];
    if ((options.engine ?? 'cycles') === 'cycles')
      await Promise.all(views.map((v) => denoise(join(tmp, `${v}.png`))));
    const label = (text: string, width: number) =>
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="34"><rect width="100%" height="100%" fill="#2e2c33"/><text x="12" y="23" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#f5f1ee">${escapeXml(text)}</text></svg>`,
      );
    const tiles = await Promise.all(
      views.map(async (v, i) => ({
        input: await sharp(join(tmp, `${v}.png`))
          .composite([{ input: label(v, 512), top: 478, left: 0 }])
          .png()
          .toBuffer(),
        left: (i % 2) * 512,
        top: 34 + Math.floor(i / 2) * 512,
      })),
    );
    await mkdir(dirname(outPng), { recursive: true });
    await sharp({ create: { width: 1024, height: 34 + 1024, channels: 3, background: '#ffffff' } })
      .composite([{ input: label(caption, 1024), top: 0, left: 0 }, ...tiles])
      .png()
      .toFile(outPng);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const escapeXml = (s: string) =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
const metres = (n: number) => (n < 1 ? `${Math.round(n * 1000) / 10} cm` : `${n.toFixed(2)} m`);

async function cli() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'no-preview': { type: 'boolean', default: false },
      engine: { type: 'string', default: 'cycles' },
      samples: { type: 'string' },
      dir: { type: 'string', default: process.cwd() },
    },
  });
  const dir = values.dir as string;
  const [command, ...args] = positionals;

  /** Checks a model file; prints what it is, or what to fix. */
  async function checkOne(path: string) {
    const name = relative(dir, path);
    try {
      const m = await cleanModel(new Uint8Array(await readFile(path)));
      const [w, h, d] = m.size;
      console.log(
        `${name}: ${metres(w)} wide × ${metres(h)} tall × ${metres(d)} deep · ${m.triangles.toLocaleString('en')} triangles · ${m.materials} material${m.materials === 1 ? '' : 's'}${m.textures ? ` · ${m.textures} texture${m.textures === 1 ? '' : 's'}` : ''}`,
      );
      return m;
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
      console.log(`FIX  ${name} ${err.message}`);
      process.exitCode = 1;
      return null;
    }
  }

  async function main() {
    if (command === 'build' && args[0]) {
      const script = resolve(dir, args[0]);
      if (extname(script) !== '.py')
        throw new Error('Give it a Blender Python script (a .py file).');
      await stat(script);
      const out = resolve(dir, values.out ?? script.replace(/\.py$/, '.glb'));
      await mkdir(dirname(out), { recursive: true });
      await rm(out, { force: true });
      const started = Date.now();
      await runBlender(script, [out], dirname(script));
      try {
        await stat(out);
      } catch {
        throw new Error(
          `The script ran but didn't write ${relative(dir, out)}. Export to the path after "--" (ats_model.finish() does).`,
        );
      }
      console.log(`Made ${relative(dir, out)} in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
      const m = await checkOne(out);
      if (m && !values['no-preview']) await preview(out, m);
    } else if (command === 'preview' && args[0]) {
      const path = resolve(dir, args[0]);
      const m = await checkOne(path);
      if (m) await preview(path, m);
    } else if (command === 'check') {
      const paths = args.length
        ? args.map((a) => resolve(dir, a))
        : (await readdir(join(dir, 'models')).catch(() => [] as string[]))
            .filter((f) => f.endsWith('.glb'))
            .map((f) => join(dir, 'models', f));
      if (!paths.length) console.log('No models yet (models/*.glb).');
      for (const p of paths) await checkOne(p);
    } else {
      console.log(`Usage:
    ats model build models/<name>.py     Run a Blender script that makes a model (it exports to the
                                         path after "--"; see ats_model.py), check it, and draw it
                                         from four sides into preview/models/<name>.png.
                                         Options: --out <file.glb>, --no-preview,
                                         --engine cycles|eevee|quick, --samples 48
    ats model preview <file.glb>         Draw any model from four sides.
    ats model check [<file.glb> …]       Check models the way building the place will.

  Models are in metres, with +Z up in Blender and the front facing -Y (Blender's Front view);
  they're exported as glTF (+Y up, front facing +Z). Limits per model: ${MODEL_LIMITS.triangles.toLocaleString('en')} triangles,
  ${MODEL_LIMITS.materials} materials, textures up to ${MODEL_LIMITS.textureSize} px.`);
      if (command && command !== 'help') process.exitCode = 2;
    }
  }

  async function preview(path: string, m: { size: number[]; triangles: number }) {
    const name = basename(path, '.glb');
    const out = join(dir, 'preview', 'models', `${name}.png`);
    const started = Date.now();
    const [w = 0, h = 0, d = 0] = m.size;
    await previewModel(
      path,
      out,
      `${name}  ·  ${metres(w)} × ${metres(h)} × ${metres(d)}  ·  ${m.triangles.toLocaleString('en')} triangles`,
      {
        engine: values.engine as string,
        ...(values.samples ? { samples: Number(values.samples) } : {}),
      },
    );
    console.log(
      `Drew ${relative(dir, out)} (front, three-quarter, side, top) in ${((Date.now() - started) / 1000).toFixed(1)} s. Look at it, and compare with the photos.`,
    );
  }

  await main();
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ''))
  cli().catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
