import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * What a texture holds, which decides how it's compressed: colour (sRGB), or numbers the shader
 * reads (normals; roughness, metalness and occlusion), whose errors show up differently.
 */
export type TextureKind = 'color' | 'normal' | 'data';

/** Basis Universal settings for each kind of texture (see ktx2-encoder's options). */
export const KTX2_SETTINGS = {
  // ETC1S: about as sharp as the WebP it replaces, and 4–8× smaller on the graphics card.
  color: { isUASTC: false, qualityLevel: 255, compressionLevel: 1, srgb: true },
  data: { isUASTC: false, qualityLevel: 255, compressionLevel: 1, srgb: false },
  // UASTC: normal maps' small errors become bumpy lighting, and ETC1S's blocks show in them
  // (sharper than their WebP even at its fastest level; higher levels take 4–15× longer).
  normal: { isUASTC: true, uastcLDRQualityLevel: 0, needSupercompression: true, srgb: false },
} as const;

export interface EncodeJob {
  id: number;
  /** Width × height pixels, RGBA, 8 bits a channel. */
  rgba: Uint8Array;
  width: number;
  height: number;
  options: Record<string, boolean | number>;
}

/** Encoders running at once: each is single-threaded WebAssembly. */
const POOL_SIZE = Math.max(1, Math.min(4, availableParallelism() - 1));
/** Encoders that have had nothing to do this long close, giving back their memory. */
const IDLE_MS = 15_000;

interface Slot {
  worker: Worker;
  job: Pending | null;
  idle: ReturnType<typeof setTimeout> | null;
}
interface Pending {
  job: EncodeJob;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
}

const slots: Slot[] = [];
const queue: Pending[] = [];
let nextId = 1;

function spawn(): Slot {
  const worker = new Worker(new URL('./ktx2-worker.ts', import.meta.url));
  worker.unref(); // a finished build exits without waiting for idle encoders
  const slot: Slot = { worker, job: null, idle: null };
  worker.on('message', (m: { id: number; bytes?: Uint8Array; error?: string }) => {
    const p = slot.job;
    slot.job = null;
    if (p && m.bytes) p.resolve(m.bytes);
    else p?.reject(new Error(`KTX2 encoding failed: ${m.error ?? 'no output'}`));
    pump();
  });
  worker.on('error', (err) => {
    remove(slot);
    slot.job?.reject(err);
    slot.job = null;
    pump();
  });
  slots.push(slot);
  return slot;
}

function remove(slot: Slot) {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  if (slot.idle) clearTimeout(slot.idle);
}

function pump() {
  while (queue.length) {
    const slot = slots.find((s) => !s.job) ?? (slots.length < POOL_SIZE ? spawn() : undefined);
    if (!slot) return;
    const p = queue.shift() as Pending;
    if (slot.idle) clearTimeout(slot.idle);
    slot.idle = null;
    slot.job = p;
    slot.worker.ref();
    slot.worker.postMessage(p.job, [p.job.rgba.buffer as ArrayBuffer]);
  }
  for (const slot of slots) {
    if (slot.job || slot.idle) continue;
    slot.worker.unref();
    slot.idle = setTimeout(() => {
      remove(slot);
      void slot.worker.terminate();
    }, IDLE_MS);
    slot.idle.unref();
  }
}

/**
 * Compresses an RGBA image (8 bits a channel) to KTX2 with Basis Universal, mipmaps included,
 * the way `kind` needs. The graphics card keeps it compressed: 4–8× less memory than RGBA.
 * Runs in worker threads, so a server building a place keeps answering meanwhile.
 */
export function encodeKtx2(
  rgba: Uint8Array,
  width: number,
  height: number,
  kind: TextureKind,
): Promise<Uint8Array> {
  const { srgb, ...settings } = KTX2_SETTINGS[kind];
  const options = {
    ...settings,
    isPerceptual: srgb,
    isSetKTX2SRGBTransferFunc: srgb,
    isNormalMap: kind === 'normal',
  };
  return new Promise((resolve, reject) => {
    // Its own copy: the pixels move to the worker.
    const job = { id: nextId++, rgba: rgba.slice(), width, height, options };
    queue.push({ job, resolve, reject });
    pump();
  });
}
