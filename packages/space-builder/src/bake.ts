import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Doorway, MaterialName } from '@ats/space-format';
import sharp from 'sharp';
import { MeshBuilder, type SurfaceKey, type V3 } from './geometry.ts';
import { hexToLinear, MATERIALS } from './materials.ts';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../blender/bake_room.py', import.meta.url));

/** How finely and how carefully each room is baked (ATS_BAKE_RES, ATS_BAKE_SAMPLES). */
export interface BakeQuality {
  /** Lightmap width and height, in pixels. */
  resolution: number;
  /** Cycles samples per pixel. */
  samples: number;
}

/** What `bake_room.py` reads (see its docstring); `hdri` is the sky's file on this machine. */
export interface BakeInput {
  receiver: {
    positions: number[];
    faces: number[][];
    faceGroup: number[];
    groups: { albedo: [number, number, number] }[];
  };
  occluders: { positions: number[]; faces: number[][] };
  lights: ReturnType<typeof ceilingLights>;
  hdri: string | null;
  hdriStrength: number;
  hdriRotation: number;
  resolution: number;
  samples: number;
  margin: number;
}

/** What `bake_room.py` writes. */
export interface BakeOutput {
  meta: { width: number; height: number; seconds: number };
  /** Float32 lightmap UVs, one pair per receiver vertex. */
  uv2: Uint8Array;
  /** Float32 RGBA pixels, rows from the top. */
  lightmap: Uint8Array;
}

/** Why a room's lighting wasn't baked: Blender failed, or took longer than it may. */
export class BakeError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut = false) {
    super(message);
    this.timedOut = timedOut;
  }
}

/**
 * Runs `bake_room.py` on one room: Blender on this machine (`blenderBaker`), or a job somewhere
 * else (the server asks the supervisor to run it in the workbench). Throws a BakeError.
 */
export type BakeRunner = (input: BakeInput) => Promise<BakeOutput>;

/**
 * Bakes kept from earlier builds, by everything that went into them: a room whose inputs didn't
 * change isn't baked again.
 */
export interface BakeCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
}

/** How far a build's lighting bake has got: told as it starts, and as each room finishes. */
export interface BakeProgress {
  /** Indoor rooms (each baked, or kept from an earlier build). */
  rooms: number;
  /** Of those, finished: baked, kept, or not baked. */
  done: number;
  /** What baking a room took in this build so far, on average (null until one was baked). */
  secondsPerRoom: number | null;
  /** Rooms baking at once. */
  parallel: number;
}

export interface BakeSettings extends Partial<BakeQuality> {
  run: BakeRunner;
  cache?: BakeCache | null;
  /** The HDR sky file, so daylight through the windows matches what you see outside. */
  hdriPath?: string | null;
  /** How many rooms `run` may bake at once (1 when not set). */
  parallel?: number;
  /** Told how far the bake has got. */
  progress?: (p: BakeProgress) => void;
}

/** ATS_BAKE_RES and ATS_BAKE_SAMPLES, or the defaults (1024 pixels, 128 samples). */
export function bakeQualityFromEnv(env: {
  ATS_BAKE_RES?: string | number | undefined;
  ATS_BAKE_SAMPLES?: string | number | undefined;
}): BakeQuality {
  return {
    resolution: Number(env.ATS_BAKE_RES ?? 1024),
    samples: Number(env.ATS_BAKE_SAMPLES ?? 128),
  };
}

/**
 * Bake settings from the environment, baking with Blender on this machine: ATS_BLENDER (or
 * `blender` on the PATH), ATS_BAKE_RES and ATS_BAKE_SAMPLES. ATS_BAKE=0 turns baking off. Null
 * when Blender isn't available.
 */
export function bakeSettingsFromEnv(env = process.env): Omit<BakeSettings, 'hdriPath'> | null {
  if (env.ATS_BAKE === '0') return null;
  const blender = findBlender(env);
  if (!blender) return null;
  return { ...bakeQualityFromEnv(env), run: blenderBaker(blender) };
}

/** Blender: ATS_BLENDER, or `blender` on the PATH. */
export function findBlender(env = process.env): string | null {
  return env.ATS_BLENDER || findOnPath('blender', env.PATH ?? '');
}

function findOnPath(name: string, path: string): string | null {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return null;
}

/** Bakes with Blender on this machine (headless, CPU only), stopping it after `timeoutMs`. */
export function blenderBaker(blender: string, timeoutMs = 15 * 60_000): BakeRunner {
  return async (input) => {
    const dir = await mkdtemp(join(tmpdir(), 'ats-bake-'));
    try {
      const hdri = input.hdri ? resolve(input.hdri) : null;
      await writeFile(join(dir, 'input.json'), JSON.stringify({ ...input, hdri }));
      await run(
        blender,
        [
          '-b',
          '--factory-startup',
          // Blender otherwise exits successfully even when the script fails.
          '--python-exit-code',
          '1',
          '--python',
          SCRIPT,
          '--',
          join(dir, 'input.json'),
          dir,
        ],
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      );
      return {
        meta: JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')),
        uv2: await readFile(join(dir, 'uv2.f32')),
        lightmap: await readFile(join(dir, 'lightmap.f32')),
      };
    } catch (err) {
      const { message, stdout, stderr, killed } = err as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      if (killed)
        throw new BakeError(`Blender timed out after ${timeoutMs / 60_000} minutes`, true);
      throw new BakeError(
        `Blender failed: ${blenderError(`${stdout ?? ''}\n${stderr ?? ''}`) ?? message.split('\n')[0]}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** The line of Blender's output that says what went wrong (a Python error, usually). */
export function blenderError(output: string): string | null {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(Blender quit|Read prefs|Warning: Unable to)/.test(l));
  return (
    lines.filter((l) => /error/i.test(l) && !/script failed/i.test(l)).at(-1) ??
    lines.at(-1) ??
    null
  );
}

export interface BakedLightmap {
  /** WebP image, sRGB-encoded; multiply by `intensity` to get linear irradiance. */
  image: Uint8Array;
  intensity: number;
  /** How long the bake took (0 when it was reused from an earlier build). */
  seconds: number;
  /** Kept from an earlier build: nothing that goes into this room's bake changed. */
  reused: boolean;
}

/** A room's bake: its lightmap, or why there isn't one. */
export type BakeResult =
  | { ok: true; lightmap: BakedLightmap }
  | { ok: false; error: string; timedOut: boolean };

/**
 * Changes whenever the same inputs could bake differently: the script, and how the result is
 * encoded (see encodeLightmap).
 */
let recipe: string | undefined;
const bakeRecipe = async () => {
  recipe ??= createHash('sha256')
    .update(await readFile(SCRIPT))
    .update('webp q88 e4 blur1.2 p99/0.92')
    .digest('hex');
  return recipe;
};
const skyHashes = new Map<string, Promise<string>>();
const skyHash = (path: string) => {
  let h = skyHashes.get(path);
  if (!h) {
    h = readFile(path).then((b) => createHash('sha256').update(b).digest('hex'));
    skyHashes.set(path, h);
  }
  return h;
};

/**
 * Bakes a room's lightmap: light from the sky through the windows and from soft ceiling lights,
 * bouncing off the room's surfaces, with furniture casting soft shadows. The room is baked on its
 * own with its doorways closed, so no room's lighting reveals anything about another. A room
 * whose inputs are all the same as in an earlier build gets that build's bake back (`cache`).
 *
 * Writes each architecture group's lightmap UVs into `receiver` (uv2). When it can't be baked,
 * says why; the room then uses real-time lighting only.
 */
export async function bakeRoom(
  receiver: MeshBuilder,
  blockers: MeshBuilder,
  room: {
    rect: [number, number, number, number];
    base: number;
    top: number;
    outdoor: boolean;
    doorways: Doorway[];
  },
  settings: BakeSettings,
): Promise<BakeResult> {
  // Receiver: every architecture group merged, remembering which group each face came from.
  const positions: number[] = [];
  const faces: number[][] = [];
  const faceGroup: number[] = [];
  const groups: { albedo: [number, number, number] }[] = [];
  const ranges: { key: SurfaceKey; start: number; count: number }[] = [];
  for (const [key, g] of receiver.groups) {
    const offset = positions.length / 3;
    const count = g.positions.length / 3;
    for (const v of g.positions) positions.push(v);
    for (const f of g.faces) {
      faces.push(f.map((i) => i + offset));
      faceGroup.push(groups.length);
    }
    const name = (key.startsWith('floor:') ? key.slice(6) : key) as MaterialName;
    groups.push({ albedo: hexToLinear(MATERIALS[name].color) });
    ranges.push({ key, start: offset, count });
  }
  if (faces.length === 0) return { ok: false, error: 'The room has no surfaces', timedOut: false };

  // Blockers: furniture plus a panel in every doorway (baked with doors closed).
  const occluders = new MeshBuilder();
  occluders.append(blockers);
  for (const d of room.doorways) doorPanel(occluders, d);

  const [x0, z0, x1, z1] = room.rect;
  const input: BakeInput = {
    receiver: { positions, faces, faceGroup, groups },
    occluders: flatten(occluders),
    lights: room.outdoor ? [] : ceilingLights(x0, z0, x1, z1, room.top),
    hdri: settings.hdriPath ?? null,
    hdriStrength: 1,
    // Aligns Blender's sky with three.js's so sunlight falls the same way in both.
    hdriRotation: Math.PI,
    resolution: settings.resolution ?? 1024,
    samples: settings.samples ?? 128,
    margin: 6,
  };
  const putUv2 = (bytes: Uint8Array) => {
    const uv2 = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    for (const r of ranges) {
      const g = receiver.groups.get(r.key);
      if (g) g.uv2 = uv2.slice(r.start * 2, (r.start + r.count) * 2);
    }
  };

  // The same room, sky, settings and script bake the same lightmap: keep the earlier one.
  const cache = settings.cache ?? null;
  const key = cache
    ? createHash('sha256')
        .update(await bakeRecipe())
        .update(JSON.stringify({ ...input, hdri: input.hdri && (await skyHash(input.hdri)) }))
        .digest('hex')
    : '';
  if (cache) {
    const kept = await cache.get(key).catch(() => null);
    const entry = kept ? readCacheEntry(kept) : null;
    if (entry) {
      putUv2(entry.uv2);
      return {
        ok: true,
        lightmap: { image: entry.image, intensity: entry.intensity, seconds: 0, reused: true },
      };
    }
  }

  let out: BakeOutput;
  try {
    out = await settings.run(input);
  } catch (err) {
    const e = err as Error & { timedOut?: boolean };
    return { ok: false, error: e.message, timedOut: e.timedOut === true };
  }
  putUv2(out.uv2);
  const { meta } = out;
  const floats = new Float32Array(
    out.lightmap.buffer.slice(
      out.lightmap.byteOffset,
      out.lightmap.byteOffset + out.lightmap.byteLength,
    ),
  );
  if (floats.length !== meta.width * meta.height * 4)
    return { ok: false, error: 'The bake came back the wrong size', timedOut: false };
  const { image, intensity } = await encodeLightmap(floats, meta.width, meta.height);
  if (cache)
    await cache.put(key, writeCacheEntry({ image, intensity, uv2: out.uv2 })).catch(() => {});
  return { ok: true, lightmap: { image, intensity, seconds: meta.seconds, reused: false } };
}

/** A kept bake: a small JSON header (intensity and sizes), then the UVs, then the image. */
function writeCacheEntry(e: { image: Uint8Array; intensity: number; uv2: Uint8Array }) {
  const head = new TextEncoder().encode(
    JSON.stringify({ intensity: e.intensity, uv2: e.uv2.byteLength, image: e.image.byteLength }),
  );
  const out = new Uint8Array(4 + head.byteLength + e.uv2.byteLength + e.image.byteLength);
  new DataView(out.buffer).setUint32(0, head.byteLength);
  out.set(head, 4);
  out.set(e.uv2, 4 + head.byteLength);
  out.set(e.image, 4 + head.byteLength + e.uv2.byteLength);
  return out;
}

function readCacheEntry(bytes: Uint8Array) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(0);
    const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + size))) as {
      intensity: number;
      uv2: number;
      image: number;
    };
    const uv2 = bytes.slice(4 + size, 4 + size + head.uv2);
    const image = bytes.slice(4 + size + head.uv2, 4 + size + head.uv2 + head.image);
    if (uv2.byteLength !== head.uv2 || image.byteLength !== head.image) return null;
    return { intensity: head.intensity, uv2, image };
  } catch {
    return null;
  }
}

/**
 * Float irradiance → 8-bit sRGB WebP. Scaled so the brightest 1% just fits, keeping detail in
 * the shadows; `intensity` undoes the scaling in the viewer. A light blur smooths bake noise
 * (islands have padding, so it doesn't bleed across edges).
 */
async function encodeLightmap(rgba: Float32Array, width: number, height: number) {
  const lum: number[] = [];
  for (let i = 0; i < rgba.length; i += 4 * 7) {
    const l = 0.2126 * (rgba[i] ?? 0) + 0.7152 * (rgba[i + 1] ?? 0) + 0.0722 * (rgba[i + 2] ?? 0);
    if (l > 0) lum.push(l);
  }
  lum.sort((a, b) => a - b);
  const p99 = lum[Math.floor(lum.length * 0.99)] ?? 1;
  const k = p99 > 0 ? 0.92 / p99 : 1;
  const rgb = new Uint8Array(width * height * 3);
  for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, (rgba[p + c] ?? 0) * k));
      const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      rgb[q + c] = Math.round(s * 255);
    }
  }
  const image = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .blur(1.2)
    .webp({ quality: 88, effort: 4 })
    .toBuffer();
  return { image: new Uint8Array(image), intensity: 1 / k };
}

/** Soft ceiling lights on a ~3 m grid, like a well-lit home or office. */
export function ceilingLights(x0: number, z0: number, x1: number, z1: number, top: number) {
  const nx = Math.max(1, Math.round((x1 - x0) / 3));
  const nz = Math.max(1, Math.round((z1 - z0) / 3));
  const cellArea = ((x1 - x0) / nx) * ((z1 - z0) / nz);
  const lights = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      lights.push({
        center: [
          x0 + ((i + 0.5) * (x1 - x0)) / nx,
          top - 0.03,
          z0 + ((j + 0.5) * (z1 - z0)) / nz,
        ] as V3,
        size: [0.7, 0.7] as [number, number],
        power: 7 * cellArea,
        color: [1.0, 0.93, 0.84] as V3,
      });
    }
  }
  return lights;
}

/**
 * A panel closing a doorway, just beyond this room's boundary: it keeps light from other rooms
 * out without covering the sides of the doorway, which belong to this room.
 */
function doorPanel(b: MeshBuilder, d: Doorway) {
  const [px, py, pz] = d.position;
  const [nx, , nz] = d.normal;
  const half = d.width / 2 + 0.05;
  const depth = 0.05;
  // The doorway sits on the room's boundary; the room is on the -normal side.
  const along: V3 = [-nz, 0, nx];
  const a: V3 = [px - along[0] * half, py - 0.05, pz - along[2] * half];
  const c: V3 = [
    px + along[0] * half + nx * depth,
    py + d.height + 0.05,
    pz + along[2] * half + nz * depth,
  ];
  b.box(
    'concrete',
    [Math.min(a[0], c[0]), a[1], Math.min(a[2], c[2])],
    [Math.max(a[0], c[0]), c[1], Math.max(a[2], c[2])],
  );
}

function flatten(m: MeshBuilder) {
  const positions: number[] = [];
  const faces: number[][] = [];
  for (const g of m.groups.values()) {
    const offset = positions.length / 3;
    for (const v of g.positions) positions.push(v);
    for (const f of g.faces) faces.push(f.map((i) => i + offset));
  }
  return { positions, faces };
}
