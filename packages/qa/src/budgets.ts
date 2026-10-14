import type { Tier } from '@allthespaces/bridge-protocol';

/**
 * What a creation may use, by the least capable devices it has to run on (its `budgetTier` in
 * ats.json). Download limits apply to everyone.
 */
export type { Tier };

export interface Budget {
  /** Draw calls per frame (95th percentile). */
  drawCalls: number;
  /** Triangles drawn per frame (95th percentile). */
  triangles: number;
  textureMB: number;
  /** Textures, geometry and render targets together. */
  gpuMB: number;
  /** Sounds playing at once. */
  voices: number;
  heapMB: number;
}

export const BUDGETS: Record<Tier, Budget> = {
  low: { drawCalls: 150, triangles: 300_000, textureMB: 128, gpuMB: 256, voices: 16, heapMB: 150 },
  mid: {
    drawCalls: 400,
    triangles: 1_000_000,
    textureMB: 256,
    gpuMB: 512,
    voices: 32,
    heapMB: 300,
  },
  high: {
    drawCalls: 1000,
    triangles: 3_000_000,
    textureMB: 512,
    gpuMB: 1024,
    voices: 64,
    heapMB: 500,
  },
};

export const DOWNLOAD = {
  /** Everything fetched before the creation says it's ready. */
  initialMB: 10,
  /** The whole bundle. */
  totalMB: 80,
};

/** The longest side a texture inside a model is kept at, by tier. */
export const MAX_TEXTURE: Record<Tier, number> = { low: 2048, mid: 2048, high: 4096 };

export const MB = 1024 * 1024;
