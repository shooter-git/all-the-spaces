import { z } from 'zod';

/**
 * The editable description a space is built from. Hand-written for the sample spaces; later
 * produced by the Architect's AI assistant from floor plans and photos (`ats space …`).
 *
 * Coordinates are metres on the ground plane: x grows east, z grows south. Rooms are rectangles
 * for now (most real rooms are; L-shaped spaces are two rooms joined by an open opening).
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
  spawns: z
    .array(z.object({ key: z.string(), room: z.string(), at: XZ, yaw: z.number().default(0) }))
    .min(1),
});
export type SpacePlan = z.infer<typeof SpacePlan>;
