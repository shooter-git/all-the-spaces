/**
 * The quality a space or creation runs at on a device: the protocol's tiers, the one vocabulary
 * everywhere (the database stores `mid` as 'medium'; see packages/db/src/schema/perf.ts).
 */
import type { Tier } from '@allthespaces/bridge-protocol';

export type { Tier };

/** How smoothly something ran on this device, sent by those who share it (POST /api/perf). */
export interface PerfSample {
  kind: 'space' | 'creation';
  spaceId: string;
  creationVersionId?: string;
  tier: Tier;
  fps: number;
  p50Ms: number;
  p95Ms: number;
  scale: number;
}
