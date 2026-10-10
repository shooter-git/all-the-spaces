import { z } from 'zod';

/**
 * How a floor-plan image lines up with the plan: metres per pixel, and the pixel where the plan's
 * origin (x = 0, z = 0) sits. x grows to the right of the image and z downwards.
 */
export const Trace = z.object({
  image: z.string().min(1),
  metresPerPixel: z.number().positive(),
  origin: z.tuple([z.number(), z.number()]),
  /** Which floor this image shows (default: the first). */
  floor: z.string().optional(),
});
export type Trace = z.infer<typeof Trace>;

/**
 * trace.json: how each floor's drawing lines up (`{ "floors": { "f1": {…}, "f2": {…} } }`), or,
 * written by older versions, a single Trace.
 */
export const Traces = z.union([
  z.object({ floors: z.record(z.string(), Trace.omit({ floor: true })) }),
  Trace,
]);
export type Traces = z.infer<typeof Traces>;

/** The calibration for one floor's drawing, if there is one. */
export function traceFor(raw: unknown, floor: string, firstFloor: string): Trace | null {
  const t = Traces.safeParse(raw);
  if (!t.success) return null;
  if ('floors' in t.data) {
    const f = t.data.floors[floor];
    return f ? { ...f, floor } : null;
  }
  return (t.data.floor ?? firstFloor) === floor ? t.data : null;
}
