import { z } from 'zod';

/** ats.json: about the creation. */
export const AtsJson = z.looseObject({
  title: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  sessionMode: z.enum(['solo', 'shared', 'invite']).default('shared'),
  budgetTier: z.enum(['low', 'mid', 'high']).default('low'),
  /**
   * The operator-installed connectors it calls through the app (docs/connectors.md), and which
   * of their operations. An Architect approves these for each version before it goes live.
   */
  connectors: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]{2,32}$/),
        ops: z
          .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/))
          .min(1)
          .max(100)
          .refine((ops) => new Set(ops).size === ops.length, { message: 'ops are listed twice' }),
        /** Why, in a sentence for the Architect who approves it. */
        why: z.string().trim().min(1).max(200),
      }),
    )
    .max(10)
    .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, {
      message: 'a connector is listed twice',
    })
    .optional(),
});
export type AtsJson = z.infer<typeof AtsJson>;

/** assets.lock.json: every file the creation didn't make itself, and its licence. */
export const AssetsLock = z.looseObject({
  assets: z
    .array(
      z.looseObject({
        /** Where it is in the project, e.g. `public/models/chair.glb`. */
        path: z.string().min(1).max(300),
        /** `CC0-1.0`, `OFL-1.1`, … or `own` for something made for this creation. */
        license: z.string().min(1).max(64),
        /** Where it came from (a page, not a download link). */
        source: z.string().max(500).optional(),
        title: z.string().max(200).optional(),
        author: z.string().max(200).optional(),
      }),
    )
    .max(5000),
});
export type AssetsLock = z.infer<typeof AssetsLock>;
export type AssetCredit = AssetsLock['assets'][number];

/** qa/script.json: what a person might do, played on every screen size. */
const Point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export const QaStep = z.union([
  z.object({ wait: z.number().min(0).max(30) }),
  z.object({ press: z.string().max(40) }),
  z.object({ hold: z.string().max(40), seconds: z.number().min(0).max(10) }),
  z.object({ tap: Point }),
  z.object({ drag: z.tuple([Point, Point]), seconds: z.number().min(0).max(10).optional() }),
  z.object({ type: z.string().max(200) }),
  z.object({ screenshot: z.string().regex(/^[\w-]{1,40}$/) }),
]);
export type QaStep = z.infer<typeof QaStep>;
export const QaScript = z.looseObject({ steps: z.array(QaStep).max(200) });
export type QaScript = z.infer<typeof QaScript>;
