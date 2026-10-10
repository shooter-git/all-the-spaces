import type { FieldPerf } from '@ats/api-types';
import { schema } from '@ats/db';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isArchitect, notFound, requireUser } from '../access.ts';
import type { AppContext } from '../context.ts';
import { sendError } from '../reply.ts';
import { membershipsFor } from '../session.ts';

const { creations, creationVersions, perfSamples, spaces } = schema;

const TIERS = ['low', 'mid', 'high'] as const;
type Tier = (typeof TIERS)[number];
/** A coarse kind of device: form, system and a bucket of processor cores. */
const Device = z
  .string()
  .regex(/^(phone|tablet|laptop)-(ios|android|mac|windows|linux|other)-\d{1,2}c$/);
const Sample = z.object({
  kind: z.enum(['space', 'creation']),
  spaceId: z.uuid(),
  creationVersionId: z.uuid().optional(),
  tier: z.enum(TIERS),
  device: Device,
  fps: z.number().min(0).max(1000),
  p50Ms: z.number().min(0).max(10_000),
  p95Ms: z.number().min(0).max(10_000),
  scale: z.number().min(0.1).max(1),
});
/** Seconds between samples from one person (per kind). */
const EVERY = 25;
/** A tier runs smoothly on a kind of device when most of its frames are on time at near full resolution. */
const SMOOTH = { p95Ms: 33, scale: 0.75, samples: 5 };

/**
 * How smoothly things run, from the people who share it (a per-device choice). Samples carry
 * no user, stay on this server and are deleted after 90 days (worker).
 */
export async function perfRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const last = new Map<string, number>();

  app.post('/api/perf', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const body = Sample.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'Not a performance sample.');
    const s = body.data;
    const key = `${me.id}:${s.kind}`;
    if (Date.now() - (last.get(key) ?? 0) < EVERY * 1000) return reply.code(429).send({});
    const [space] = await db
      .select({ groupId: spaces.groupId })
      .from(spaces)
      .where(eq(spaces.id, s.spaceId));
    if (!space || !(await membershipsFor(db, me.id)).some((m) => m.groupId === space.groupId))
      return notFound(reply);
    if (s.kind === 'creation') {
      if (!s.creationVersionId) return sendError(reply, 400, 'Which creation?');
      const [v] = await db
        .select({ id: creationVersions.id })
        .from(creationVersions)
        .innerJoin(creations, eq(creations.id, creationVersions.creationId))
        .where(and(eq(creationVersions.id, s.creationVersionId), eq(creations.spaceId, s.spaceId)));
      if (!v) return notFound(reply);
    }
    last.set(key, Date.now());
    if (last.size > 10_000) last.clear();
    await db.insert(perfSamples).values({
      groupId: space.groupId,
      spaceId: s.spaceId,
      creationVersionId: s.kind === 'creation' ? (s.creationVersionId ?? null) : null,
      kind: s.kind,
      tier: s.tier,
      device: s.device,
      fps: s.fps,
      p50Ms: s.p50Ms,
      p95Ms: s.p95Ms,
      scale: s.scale,
    });
    return { ok: true };
  });

  /**
   * The quality to start at on this kind of device: the highest tier that has run smoothly on it
   * here, or one below the lowest that hasn't. Null until there's enough to go on.
   */
  app.get<{ Querystring: { device?: string } }>('/api/perf/advice', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const device = Device.safeParse(req.query.device);
    if (!device.success) return sendError(reply, 400, 'Which kind of device?');
    const rows = await summary(
      and(
        eq(perfSamples.kind, 'space'),
        eq(perfSamples.device, device.data),
        gt(perfSamples.createdAt, sql`now() - interval '30 days'`),
      ),
    );
    const known = rows.filter((r) => r.samples >= SMOOTH.samples);
    const smooth = (r: (typeof rows)[number]) => r.p95Ms <= SMOOTH.p95Ms && r.scale >= SMOOTH.scale;
    const rank = (t: Tier) => TIERS.indexOf(t);
    const good = known.filter(smooth).sort((a, b) => rank(b.tier) - rank(a.tier))[0];
    const bad = known.filter((r) => !smooth(r)).sort((a, b) => rank(a.tier) - rank(b.tier))[0];
    let tier: Tier | null = null;
    if (good && (!bad || rank(good.tier) < rank(bad.tier))) tier = good.tier;
    else if (bad) tier = TIERS[Math.max(0, rank(bad.tier) - 1)] ?? 'low';
    reply.header('cache-control', 'private, max-age=3600');
    return { tier, samples: known.reduce((n, r) => n + r.samples, 0) };
  });

  /** For Architects: how a place and each creation version in it run, by kind of device. */
  app.get<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/perf', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    if (!z.uuid().safeParse(req.params.spaceId).success) return notFound(reply);
    const [space] = await db
      .select({ groupId: spaces.groupId })
      .from(spaces)
      .where(eq(spaces.id, req.params.spaceId));
    if (!space || !(await isArchitect(db, me.id, space.groupId))) return notFound(reply);
    const recent = and(
      eq(perfSamples.spaceId, req.params.spaceId),
      gt(perfSamples.createdAt, sql`now() - interval '30 days'`),
    );
    reply.header('cache-control', 'private, no-store');
    return {
      space: await summary(and(recent, eq(perfSamples.kind, 'space'))),
      creations: await summary(and(recent, eq(perfSamples.kind, 'creation')), true),
    };
  });

  /** Medians per kind of device and tier (and creation version, when asked). */
  async function summary(where: ReturnType<typeof and>, byVersion = false) {
    const rows = await db
      .select({
        creationVersionId: byVersion ? perfSamples.creationVersionId : sql<null>`null`,
        device: perfSamples.device,
        tier: perfSamples.tier,
        samples: sql<number>`count(*)::int`,
        fps: sql<number>`percentile_cont(0.5) within group (order by ${perfSamples.fps})`,
        p50Ms: sql<number>`percentile_cont(0.5) within group (order by ${perfSamples.p50Ms})`,
        p95Ms: sql<number>`percentile_cont(0.5) within group (order by ${perfSamples.p95Ms})`,
        scale: sql<number>`percentile_cont(0.5) within group (order by ${perfSamples.scale})`,
      })
      .from(perfSamples)
      .where(where)
      .groupBy(
        ...(byVersion ? [perfSamples.creationVersionId] : []),
        perfSamples.device,
        perfSamples.tier,
      );
    return rows.map((r) => ({
      ...r,
      fps: Math.round(Number(r.fps)),
      p50Ms: Math.round(Number(r.p50Ms) * 10) / 10,
      p95Ms: Math.round(Number(r.p95Ms) * 10) / 10,
      scale: Math.round(Number(r.scale) * 100) / 100,
    })) satisfies FieldPerf[];
  }
}
