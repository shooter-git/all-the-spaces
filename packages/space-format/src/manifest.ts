import { z } from 'zod';

/**
 * A published space, as the viewer receives it. Units are metres, +Y is up.
 *
 * A space is split into rooms; each room is streamed independently at three levels of detail
 * plus an invisible collision mesh. Rooms never contain geometry belonging to another room, so a
 * room can be withheld from someone who may not see it without affecting anything else.
 */
export const FORMAT_VERSION = 1;

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

export const Box3 = z.object({ min: Vec3, max: Vec3 });
export type Box3 = z.infer<typeof Box3>;

/** A streamable file, addressed by content hash so it can be cached forever. */
export const ChunkRef = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ChunkRef = z.infer<typeof ChunkRef>;

export const Floor = z.object({
  key: z.string(),
  name: z.string(),
  index: z.number().int(),
  /** Height of this floor's walking surface. */
  elevation: z.number(),
});
export type Floor = z.infer<typeof Floor>;

export const Doorway = z.object({
  /**
   * The room on the other side. Left out (with `closed`) when the viewer may not see that room:
   * the doorway shows as a closed door and says nothing about what's behind it.
   */
  to: z.string().optional(),
  closed: z.boolean().optional(),
  /** A real door (it swings open for people) or an open passage. */
  kind: z.enum(['door', 'open']).default('open'),
  /** Centre of the opening at floor level. */
  position: Vec3,
  width: z.number().positive(),
  height: z.number().positive(),
  /** Unit vector pointing from this room into the other room (horizontal). */
  normal: Vec3,
});
export type Doorway = z.infer<typeof Doorway>;

export const Room = z.object({
  key: z.string(),
  floorKey: z.string(),
  name: z.string(),
  isOutdoor: z.boolean().default(false),
  /** What the floor is made of (for footsteps and how the room sounds), e.g. `oak`, `tile-light`. */
  floorMaterial: z.string().optional(),
  /** Axis-aligned bounds; used to tell which room someone is in. Stairwells span two floors. */
  bounds: Box3,
  /** Rooms directly reachable or visible from this one (through doorways, stairs, open plan). */
  neighbors: z.array(z.string()),
  doorways: z.array(Doorway),
  lods: z.object({ lod0: ChunkRef, lod1: ChunkRef, lod2: ChunkRef }),
  collision: ChunkRef,
  labelPosition: Vec3,
  /**
   * Baked lighting for the room's walls, floor and ceiling (light from the sky and ceiling
   * lights bouncing around, with soft shadows). The image is sRGB; multiply by `intensity`.
   */
  lightmap: ChunkRef.extend({ intensity: z.number().positive() }).optional(),
  /**
   * The things in this room that can be picked out (and hold creations). Keys are stable across
   * rebuilds, so creations follow their objects when a space is reshaped.
   */
  objects: z
    .array(z.object({ key: z.string(), label: z.string(), kind: z.string(), position: Vec3 }))
    .default([]),
  /**
   * Everyday sounds that belong in the room, played now and then where they come from: typing
   * and mouse clicks at desks in workplaces, chairs creaking, cups at a café counter.
   */
  sounds: z
    .array(z.object({ kind: z.enum(['typing', 'mouse', 'chair', 'cups']), position: Vec3 }))
    .default([]),
  /** Every shared file (geometry buffers, textures) this room's chunks refer to. */
  files: z.array(z.string()).default([]),
  /** Ids of the credited assets used in this room. */
  credits: z.array(z.string()).default([]),
});
export type Room = z.infer<typeof Room>;

/** Elevators (and other ways to hop between places) that aren't walked physically. */
export const Link = z.object({
  key: z.string(),
  kind: z.enum(['elevator']),
  name: z.string(),
  stops: z
    .array(z.object({ floorKey: z.string(), roomKey: z.string(), position: Vec3, yaw: z.number() }))
    .min(2),
});
export type Link = z.infer<typeof Link>;

export const Spawn = z.object({
  key: z.string(),
  roomKey: z.string(),
  position: Vec3,
  /** Facing direction in radians around +Y (0 looks along -Z). */
  yaw: z.number(),
});
export type Spawn = z.infer<typeof Spawn>;

export const SpaceManifest = z.object({
  format: z.literal(FORMAT_VERSION),
  name: z.string(),
  spaceType: z.enum(['apartment', 'condo', 'house', 'office', 'building', 'other']),
  floors: z.array(Floor).min(1),
  rooms: z.array(Room).min(1),
  links: z.array(Link).default([]),
  spawns: z.array(Spawn).min(1),
  /** Sky/ambient lighting hint for the viewer until baked lighting exists. */
  lighting: z
    .object({
      sky: z.string(),
      ground: z.string(),
      sunDirection: Vec3,
      exposure: z.number(),
      /** An HDR sky: lights the rooms, shows through windows, and gives the sun's direction. */
      hdri: ChunkRef.optional(),
    })
    .default({ sky: '#dfe8f1', ground: '#c2b6a4', sunDirection: [0.4, 1, 0.3], exposure: 1 }),
  /**
   * Shared files the room chunks refer to (geometry buffers, textures), addressed by content
   * hash so each is downloaded once no matter how many rooms use it.
   */
  resources: z.array(z.string()).default([]),
  /** Every third-party asset in this space and its licence (all must be CC0 or compatible). */
  credits: z
    .array(
      z.object({
        source: z.string(),
        id: z.string(),
        name: z.string(),
        license: z.string(),
        url: z.string(),
        authors: z.array(z.string()),
      }),
    )
    .default([]),
});
export type SpaceManifest = z.infer<typeof SpaceManifest>;

/** Checks cross-references a schema can't express. Returns human-readable problems. */
export function validateManifest(m: SpaceManifest): string[] {
  const problems: string[] = [];
  const floors = new Set(m.floors.map((f) => f.key));
  const rooms = new Set(m.rooms.map((r) => r.key));
  for (const r of m.rooms) {
    if (!floors.has(r.floorKey)) problems.push(`room ${r.key}: unknown floor ${r.floorKey}`);
    for (const n of r.neighbors)
      if (!rooms.has(n)) problems.push(`room ${r.key}: unknown neighbour ${n}`);
    for (const d of r.doorways)
      if (d.to && !rooms.has(d.to)) problems.push(`room ${r.key}: doorway to unknown ${d.to}`);
    for (let i = 0; i < 3; i++) {
      if ((r.bounds.min[i] ?? 0) >= (r.bounds.max[i] ?? 0))
        problems.push(`room ${r.key}: empty bounds`);
    }
  }
  for (const s of m.spawns)
    if (!rooms.has(s.roomKey)) problems.push(`spawn ${s.key}: unknown room`);
  for (const l of m.links) {
    for (const s of l.stops) {
      if (!rooms.has(s.roomKey)) problems.push(`link ${l.key}: unknown room ${s.roomKey}`);
    }
  }
  const dupes = m.rooms.map((r) => r.key).filter((k, i, a) => a.indexOf(k) !== i);
  for (const d of dupes) problems.push(`duplicate room key ${d}`);
  return problems;
}
