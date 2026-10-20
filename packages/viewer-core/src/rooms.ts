import type { Room, SpaceManifest } from '@ats/space-format';

/** How far (in rooms) every room is from `from`, walking through doorways, stairs and lifts. */
export function roomDistances(manifest: SpaceManifest, from: string): Map<string, number> {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)?.add(b);
  };
  for (const r of manifest.rooms) {
    for (const n of r.neighbors) {
      link(r.key, n);
      link(n, r.key);
    }
  }
  for (const l of manifest.links) {
    for (const a of l.stops)
      for (const b of l.stops) if (a.roomKey !== b.roomKey) link(a.roomKey, b.roomKey);
  }
  const dist = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const k = queue.shift() as string;
    for (const n of neighbours.get(k) ?? []) {
      if (!dist.has(n)) {
        dist.set(n, (dist.get(k) ?? 0) + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

/**
 * The room a point is in. Rooms can overlap in plan (a stairwell spans two floors), so prefer the
 * room whose floor is closest below the point.
 */
export function roomAt(manifest: SpaceManifest, x: number, y: number, z: number): Room | null {
  let best: Room | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const r of manifest.rooms) {
    const { min, max } = r.bounds;
    if (x < min[0] || x > max[0] || z < min[2] || z > max[2]) continue;
    if (y < min[1] - 0.5 || y > max[1] + 0.5) continue;
    const gap = y - min[1];
    if (gap >= -0.5 && gap < bestGap) {
      best = r;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * How far every room is from `from` as you'd see it: an open passage costs nothing (an L-shaped
 * room, or a corridor in pieces, is one space you see all of), a door or a stair costs one step,
 * a lift too. Used to choose how much detail each room gets.
 */
export function sightDistances(manifest: SpaceManifest, from: string): Map<string, number> {
  const edges = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, cost: number) => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      if (!edges.has(x)) edges.set(x, new Map());
      const m = edges.get(x) as Map<string, number>;
      m.set(y, Math.min(m.get(y) ?? cost, cost));
    }
  };
  for (const r of manifest.rooms) {
    for (const n of r.neighbors) link(r.key, n, 1);
    for (const d of r.doorways) if (d.to && d.kind === 'open' && !d.closed) link(r.key, d.to, 0);
  }
  for (const l of manifest.links)
    for (const a of l.stops)
      for (const b of l.stops) if (a.roomKey !== b.roomKey) link(a.roomKey, b.roomKey, 1);
  // Shortest paths with steps of 0 or 1: free steps go to the front of the queue.
  const dist = new Map([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    const k = queue.shift() as string;
    const dk = dist.get(k) ?? 0;
    for (const [n, cost] of edges.get(k) ?? []) {
      if ((dist.get(n) ?? Number.POSITIVE_INFINITY) <= dk + cost) continue;
      dist.set(n, dk + cost);
      if (cost === 0) queue.unshift(n);
      else queue.push(n);
    }
  }
  return dist;
}

export type Lod = 'lod0' | 'lod1' | 'lod2';

/** How a room is drawn from where you stand: in full, or as its simple stand-in. */
export type RoomView = 'detail' | 'stand-in';

/** Rooms up to this many doors or stairs away are drawn in full detail (open passages are free). */
export const DETAIL_SIGHT = 2;
/** Beyond full detail, rooms up to this far away are drawn as their stand-ins; the rest not at all. */
export const MAX_SIGHT = 3;

/** How every room you could see from `current` is drawn. Rooms left out aren't drawn. */
export function roomViews(manifest: SpaceManifest, current: string): Map<string, RoomView> {
  const out = new Map<string, RoomView>();
  for (const [room, d] of sightDistances(manifest, current)) {
    if (d <= DETAIL_SIGHT) out.set(room, 'detail');
    else if (d <= MAX_SIGHT) out.set(room, 'stand-in');
  }
  return out;
}

/**
 * Rooms in full detail further away than this (metres, from you to the nearest part of the room)
 * are drawn with their lighter detail (lod1) when it's held, and without their smallest things.
 * Open-plan places see every room at once; only the ones near you need every triangle.
 */
export const NEAR_DETAIL_M = 8;
/** A room drawn lighter comes back to full detail only this much closer (so it doesn't flicker). */
export const NEAR_DETAIL_HYSTERESIS_M = 1;
/** Things smaller than this (radius, metres) aren't drawn in rooms beyond `NEAR_DETAIL_M`. */
export const SMALL_THING_M = 0.15;

/** How far a point is from a room (metres; 0 inside it). */
export function distanceToRoom(room: Room, x: number, y: number, z: number): number {
  const { min, max } = room.bounds;
  const dx = Math.max(min[0] - x, 0, x - max[0]);
  const dy = Math.max(min[1] - y, 0, y - max[1]);
  const dz = Math.max(min[2] - z, 0, z - max[2]);
  return Math.hypot(dx, dy, dz);
}

/**
 * Whether a place needs the sun's shadows drawn as you walk: not when every room is indoors with
 * its light baked (shadows included). Real-time shadows draw everything again from the sun each
 * frame, and every surface looks them up.
 */
export function needsSunShadows(manifest: SpaceManifest): boolean {
  return manifest.rooms.some((r) => r.isOutdoor || !r.lightmap);
}

/** Graphics memory a room's lighting image takes (1024 px square, RGBA, with mipmaps). */
const LIGHTMAP_BYTES = Math.round(1024 * 1024 * 4 * (4 / 3));
/** Geometry takes more room on the graphics card than in its compressed file. */
const GEOMETRY_EXPANSION = 4;

/** Roughly what holding a room in full detail costs in graphics memory (bytes). */
export function detailCost(room: Room, lod: Lod): number {
  return room.lods[lod].bytes * GEOMETRY_EXPANSION + (room.lightmap ? LIGHTMAP_BYTES : 0);
}

/**
 * Whether the device can hold every room's lighter detail (lod1) beside its full detail, to draw
 * rooms further away with. Only when the whole place fits both ways, so nothing loads as you walk.
 */
export function holdsLighterDetail(manifest: SpaceManifest, lod: Lod, budget: number): boolean {
  if (lod !== 'lod0') return false;
  let used = 0;
  for (const r of manifest.rooms) used += detailCost(r, 'lod0') + lighterCost(r);
  return used <= budget;
}

/** What holding a room's lighter detail beside its full detail adds (they share the lighting). */
export function lighterCost(room: Room): number {
  return room.lods.lod1.bytes * GEOMETRY_EXPANSION;
}

/**
 * The rooms to hold in full detail, nearest `current` first: the whole place when it fits in
 * `budget` bytes (it then never changes as you walk), otherwise the nearest rooms (walking, lifts
 * included) until it's full. The room you're in is always one of them.
 */
export function detailRooms(
  manifest: SpaceManifest,
  current: string,
  lod: Lod,
  budget: number,
): string[] {
  const dist = roomDistances(manifest, current);
  const far = Number.POSITIVE_INFINITY;
  const nearest = [...manifest.rooms].sort(
    (a, b) =>
      (a.key === current ? -1 : 0) - (b.key === current ? -1 : 0) ||
      (dist.get(a.key) ?? far) - (dist.get(b.key) ?? far),
  );
  const out: string[] = [];
  let used = 0;
  for (const room of nearest) {
    used += detailCost(room, lod);
    if (used > budget && out.length > 0) break;
    out.push(room.key);
  }
  return out;
}
