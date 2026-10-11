import { z } from 'zod';

/**
 * The editable description a space is built from. Hand-written for the sample spaces; later
 * produced by the Architect's AI assistant from floor plans and photos (`ats space …`).
 *
 * Coordinates are metres on the ground plane: x grows east, z grows south. Rooms are rectangles
 * for now (most real rooms are; L-shaped spaces are two rooms joined by an open opening).
 *
 * Everything added since the first version is optional, and a plan without it builds exactly as
 * it did: where a place is on Earth (`site`), floors that slope (`slope`), outdoor edges of any
 * height (`parapet`), and the building's own structure (`structure`: columns, beams, panels).
 */

const XZ = z.tuple([z.number(), z.number()]);
export type XZ = z.infer<typeof XZ>;

export const Side = z.enum(['north', 'south', 'east', 'west']);
export type Side = z.infer<typeof Side>;

export const MaterialName = z.enum([
  'plaster',
  'plaster-warm',
  'paint-sage',
  'paint-sky',
  'oak',
  'walnut',
  'tile-light',
  'tile-dark',
  'concrete',
  'carpet-stone',
  'fabric-linen',
  'fabric-indigo',
  'fabric-moss',
  'metal-dark',
  'ceramic',
  'leaf',
  'paper',
  'glass',
  /** Painted skirting boards, window frames and door casings. */
  'trim',
  // Outside: streets, ground and the building's own fabric.
  'asphalt',
  'grass',
  'brick',
  'stone',
  /** Painted steel (railings, posts, frames). */
  'metal-green',
  'metal-white',
  /** Metal mesh you can see through (screens, fences, guards). */
  'mesh',
  'mesh-green',
]);
export type MaterialName = z.infer<typeof MaterialName>;

export const PlanFloor = z.object({
  key: z.string(),
  name: z.string(),
  elevation: z.number(),
  /** Floor-to-ceiling height. */
  height: z.number().positive().default(2.7),
});

export const PlanRoom = z.object({
  key: z.string(),
  name: z.string(),
  floor: z.string(),
  /** [x0, z0, x1, z1] */
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  outdoor: z.boolean().default(false),
  /** Stairwells: the room continues up to this floor (no slab in between). */
  spansTo: z.string().optional(),
  floorMaterial: MaterialName.default('oak'),
  wallMaterial: MaterialName.default('plaster'),
  /**
   * A floor that slopes (a ramp, a sloping deck, ground that falls away): it climbs `rise` metres
   * from the floor's elevation, evenly across the room, up to its `toward` edge. Walls, ceiling,
   * doors and furniture follow it.
   */
  slope: z.object({ toward: Side, rise: z.number().positive() }).optional(),
  /**
   * Outdoors: how high the low wall around the edge is (1.05 m when left out; 0 for none, as for
   * open ground, a street or a pavement).
   */
  parapet: z.number().nonnegative().optional(),
});
export type PlanRoom = z.infer<typeof PlanRoom>;

export const PlanOpening = z.discriminatedUnion('kind', [
  /** A doorway (or open archway) through a wall two rooms share. */
  z.object({
    kind: z.enum(['door', 'open']),
    rooms: z.tuple([z.string(), z.string()]),
    /** Any point on the shared wall; the opening is centred here. */
    at: XZ,
    width: z.number().positive().default(0.9),
    height: z.number().positive().default(2.1),
    /** For openings into a stairwell's upper level: the floor this opening is on. */
    level: z.string().optional(),
  }),
  /** A window in one of a room's walls. */
  z.object({
    kind: z.literal('window'),
    room: z.string(),
    side: Side,
    /** Position of the window centre along the wall (x for north/south, z for east/west). */
    at: z.number(),
    width: z.number().positive().default(1.4),
    height: z.number().positive().default(1.3),
    sill: z.number().nonnegative().default(0.9),
  }),
]);
export type PlanOpening = z.infer<typeof PlanOpening>;

export const PlanStairs = z.object({
  room: z.string(),
  /** Where the bottom step starts, and which way you walk going up. */
  start: XZ,
  direction: Side,
  width: z.number().positive().default(1),
  /** Horizontal run from the first to the last step. */
  run: z.number().positive(),
  from: z.string(),
  to: z.string(),
});

export const FurnitureKind = z.enum([
  'sofa',
  'armchair',
  'bed',
  'table',
  'coffee-table',
  'chair',
  'desk',
  'shelf',
  'cabinet',
  'counter',
  'plant',
  'rug',
  'lamp',
  'tv',
  'frame',
  'box',
]);

/**
 * A real model for a piece of furniture: one the assistant made in the workspace
 * (`models/<name>.glb`, front facing +Z, metres, Y up as glTF has it), or a free (CC0) one from
 * Poly Haven (`polyhaven:<id>`).
 */
export const MODEL_REF = /^(models\/[A-Za-z0-9][\w-]{0,79}\.glb|polyhaven:[A-Za-z0-9_]{1,80})$/;

export const PlanFurniture = z.object({
  /** Stable key (becomes the object's permanent ID when published). */
  key: z.string(),
  room: z.string(),
  kind: FurnitureKind,
  label: z.string(),
  /** Centre on the floor. */
  at: XZ,
  /** Rotation around the vertical axis in degrees. */
  rotation: z.number().default(0),
  /** Overrides the kind's default footprint and height [width, height, depth]. */
  size: z.tuple([z.number(), z.number(), z.number()]).optional(),
  material: MaterialName.optional(),
  accent: MaterialName.optional(),
  /** For wall-mounted items (frames, TVs): height of the centre above the floor. */
  mountHeight: z.number().optional(),
  /**
   * The model to show instead of the kind's simple shape. It keeps its own size (metres); with
   * `size`, it's scaled evenly to fit inside that box. `kind` still says what it is (whether
   * people bump into it, how the room sounds).
   */
  model: z
    .string()
    .regex(MODEL_REF, 'A model is "models/<name>.glb" or "polyhaven:<id>".')
    .optional(),
});
export type PlanFurniture = z.infer<typeof PlanFurniture>;

/**
 * Part of the building itself, not furniture: a column, a beam, a wall panel, a screen, a post.
 * People bump into it and see it, but can't pick it out (nothing lives on it). A box, standing on
 * its room's floor unless `elevation` lifts it.
 */
export const PlanStructure = z.object({
  /** The room it belongs to (it's shown and hidden with that room). */
  room: z.string(),
  /** What it is, in a word or two ("column", "spandrel", "mesh screen"), for people reading. */
  label: z.string().optional(),
  /** Centre of its footprint. */
  at: XZ,
  /** [width along x, height, depth along z], before rotation. */
  size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  /** Height of its bottom above the room's floor (beams and panels hang higher). */
  elevation: z.number().default(0),
  /** Rotation around the vertical axis in degrees. */
  rotation: z.number().default(0),
  material: MaterialName.default('concrete'),
  /** Copies in a row (a line of columns, a run of panels): `count` in all, each `step` [dx, dz] from the last. */
  repeat: z.object({ count: z.number().int().min(1).max(500), step: XZ }).optional(),
});
export type PlanStructure = z.infer<typeof PlanStructure>;

/**
 * Where a place is on Earth, so photos taken from known spots (street views, a survey) can be
 * matched against it: the latitude and longitude of the plan's origin (x = 0, z = 0), and the
 * compass bearing the plan's north (-z, the top of the drawing) faces (0 when the drawing is
 * north-up; 90 when its top faces east).
 */
export const PlanSite = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  bearing: z.number().min(-360).max(360).default(0),
});
export type PlanSite = z.infer<typeof PlanSite>;

export const SpacePlan = z.object({
  name: z.string(),
  spaceType: z.enum(['apartment', 'condo', 'house', 'office', 'building', 'other']),
  floors: z.array(PlanFloor).min(1),
  rooms: z.array(PlanRoom).min(1),
  openings: z.array(PlanOpening).default([]),
  stairs: z.array(PlanStairs).default([]),
  elevators: z
    .array(
      z.object({
        key: z.string(),
        name: z.string(),
        stops: z.array(z.object({ room: z.string(), at: XZ, yaw: z.number().default(0) })).min(2),
      }),
    )
    .default([]),
  furniture: z.array(PlanFurniture).default([]),
  structure: z.array(PlanStructure).optional(),
  site: PlanSite.optional(),
  spawns: z
    .array(z.object({ key: z.string(), room: z.string(), at: XZ, yaw: z.number().default(0) }))
    .min(1),
});
export type SpacePlan = z.infer<typeof SpacePlan>;

/** How far a room's floor has climbed at a point (0 for a level floor). */
export function slopeAt(room: Pick<PlanRoom, 'rect' | 'slope'>, x: number, z: number): number {
  if (!room.slope) return 0;
  const [x0, z0, x1, z1] = room.rect;
  const t = {
    east: (x - x0) / (x1 - x0),
    west: (x1 - x) / (x1 - x0),
    south: (z - z0) / (z1 - z0),
    north: (z1 - z) / (z1 - z0),
  }[room.slope.toward];
  return room.slope.rise * Math.min(1, Math.max(0, t));
}

/** Every copy of a piece of structure: its centre. */
export function structureCopies(s: PlanStructure): [number, number][] {
  const count = s.repeat?.count ?? 1;
  const [dx, dz] = s.repeat?.step ?? [0, 0];
  return Array.from({ length: count }, (_, i) => [s.at[0] + dx * i, s.at[1] + dz * i]);
}

const EARTH = 6_371_008.8;
/**
 * A place on Earth as a point in the plan (metres; x east of the origin along the plan's x, z
 * along its z), for a site. Exact enough across a few kilometres.
 */
export function planPoint(site: PlanSite, lat: number, lng: number): [number, number] {
  const rad = Math.PI / 180;
  const east = (lng - site.lng) * rad * EARTH * Math.cos(site.lat * rad);
  const north = (lat - site.lat) * rad * EARTH;
  const b = site.bearing * rad;
  // The plan's north (-z) faces `bearing`; its east (+x) faces `bearing` + 90°.
  return [east * Math.cos(b) - north * Math.sin(b), -(east * Math.sin(b) + north * Math.cos(b))];
}

/** A point in the plan as latitude and longitude (the inverse of `planPoint`). */
export function earthPoint(site: PlanSite, x: number, z: number): [number, number] {
  const rad = Math.PI / 180;
  const b = site.bearing * rad;
  const east = x * Math.cos(b) - z * Math.sin(b);
  const north = -x * Math.sin(b) - z * Math.cos(b);
  return [
    site.lat + north / (EARTH * rad),
    site.lng + east / (EARTH * rad * Math.cos(site.lat * rad)),
  ];
}

/** A compass heading (degrees) as a direction in the plan, [dx, dz]. */
export function planDirection(site: Pick<PlanSite, 'bearing'>, heading: number): [number, number] {
  const a = ((heading - site.bearing) * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}
