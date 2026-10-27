import type { PlaceVisits, Sent } from '@ats/api-types';
import { schema, VISIT_RETENTION_DAYS } from '@ats/db';
import { avatarColor, VISIT_DEVICES } from '@ats/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isArchitect, notFound, requireArchitect, requireUser } from '../access.ts';
import { record } from '../audit.ts';
import type { AppContext } from '../context.ts';
import { manifestOf } from '../manifests.ts';
import { placeVisitStats, timeZoneOf, VISIT_PERIODS } from '../visit-stats.ts';
import { recordsVisits, recordVisits } from '../visits.ts';
import { fromRealtime } from './realtime.ts';

const { creations, groupSettings, spaces, spaceVersions, user, visits } = schema;

const At = z.number().int().nonnegative();
const Started = z.intersection(
  z.object({
    id: z.uuid(),
    userId: z.string().min(1).max(64),
    device: z.enum(VISIT_DEVICES).optional(),
    startedAt: At,
    endedAt: At.optional(),
  }),
  z.union([
    z.object({ spaceId: z.uuid(), roomKey: z.string().min(1).max(64) }),
    z.object({
      creationId: z.uuid(),
      versionId: z.uuid(),
      session: z.string().min(1).max(64).optional(),
    }),
  ]),
);
const Batch = z.object({
  now: At,
  started: z.array(Started).max(1000),
  ended: z.array(z.object({ id: z.uuid(), at: At })).max(1000),
  going: z.array(z.uuid()).max(50_000).optional(),
});

/**
 * Visits: time people spend in each room of a place and in each creation. The real-time service
 * says who's where (coarse spans, never positions); only the group's Architects see the totals,
 * and they can turn it off for the group (which deletes what was recorded).
 */
export async function visitRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env } = ctx;

  // Internal: visits from the real-time service. Authenticated with the shared secret; not routed
  // by the public proxy. A heartbeat names every visit still going, hence the larger limit.
  app.post('/internal/visits', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    if (!fromRealtime(req, env.REALTIME_SECRET)) return reply.code(404).send();
    const batch = Batch.safeParse(req.body);
    if (!batch.success) return reply.code(400).send({ error: 'Not a batch of visits.' });
    return { recorded: await recordVisits(db, batch.data) };
  });

  /**
   * For Architects: where people spent time in a place over the last 7, 30 or 90 days (`days`),
   * by day and hour in the browser's time zone (`tz`): each room and creation, and each person.
   */
  app.get<{ Params: { spaceId: string }; Querystring: { days?: string; tz?: string } }>(
    '/api/spaces/:spaceId/visits',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const spaceId = req.params.spaceId;
      if (!z.uuid().safeParse(spaceId).success) return notFound(reply);
      const [space] = await db
        .select({ groupId: spaces.groupId, version: spaceVersions })
        .from(spaces)
        .leftJoin(spaceVersions, eq(spaceVersions.id, spaces.currentVersionId))
        .where(eq(spaces.id, spaceId));
      if (!space || !(await isArchitect(db, me.id, space.groupId))) return notFound(reply);
      reply.header('cache-control', 'private, no-store');
      const days = VISIT_PERIODS.find((d) => String(d) === req.query.days) ?? VISIT_RETENTION_DAYS;
      const timeZone = timeZoneOf(req.query.tz);
      const period = { days, kept: VISIT_RETENTION_DAYS, timeZone };
      if (!(await recordsVisits(db, space.groupId))) {
        return {
          ...period,
          recording: false,
          summary: {
            seconds: 0,
            people: 0,
            visits: 0,
            typicalSeconds: 0,
            cameBack: 0,
            togetherSeconds: 0,
            roomSeconds: 0,
          },
          trend: [],
          week: [],
          devices: [],
          rooms: [],
          creations: [],
          moves: [],
          people: [],
        } satisfies Sent<PlaceVisits>;
      }
      const [stats, made] = await Promise.all([
        placeVisitStats(db, spaceId, days, timeZone),
        db
          .select({ id: creations.id, title: creations.title })
          .from(creations)
          .where(eq(creations.spaceId, spaceId)),
      ]);
      const names = stats.people.length
        ? await db
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(
              inArray(
                user.id,
                stats.people.map((p) => p.userId),
              ),
            )
        : [];
      const nameOf = new Map(names.map((u) => [u.id, u.name]));

      // Every room of the live version, with any since removed that people spent time in.
      const manifest = space.version ? manifestOf(space.version) : null;
      const floors = new Map(manifest?.floors.map((f) => [f.key, f.name]));
      const none = { people: 0, seconds: 0, visits: 0, togetherSeconds: 0 };
      const rooms = [
        ...(manifest?.rooms ?? []).map((r) => ({
          key: r.key,
          name: r.name,
          floor: floors.size > 1 ? (floors.get(r.floorKey) ?? null) : null,
        })),
        ...[...stats.rooms.keys()]
          .filter((key) => !manifest?.rooms.some((m) => m.key === key))
          .map((key) => ({ key, name: null, floor: null })),
      ].map((r) => ({ ...r, ...(stats.rooms.get(r.key) ?? none) }));
      return {
        ...period,
        recording: true,
        summary: stats.summary,
        trend: stats.trend,
        week: stats.week,
        devices: stats.devices,
        rooms: rooms.sort((a, b) => b.seconds - a.seconds),
        creations: made
          .map((c) => ({ ...c, ...(stats.creations.get(c.id) ?? none) }))
          .sort((a, b) => b.seconds - a.seconds),
        moves: stats.moves,
        people: stats.people.flatMap((p) => {
          const name = nameOf.get(p.userId);
          return name === undefined ? [] : [{ ...p, name, color: avatarColor(p.userId) }];
        }),
      } satisfies Sent<PlaceVisits>;
    },
  );

  /** For Architects: whether the group records where people spend time. */
  app.get<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/visit-settings',
    async (req, reply) => {
      if (!(await requireArchitect(ctx, req, reply, req.params.groupId))) return;
      return { visits: await recordsVisits(db, req.params.groupId) };
    },
  );

  // Turning it off deletes everything recorded for the group, at once.
  app.put<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/visit-settings',
    async (req, reply) => {
      const groupId = req.params.groupId;
      const me = await requireArchitect(ctx, req, reply, groupId);
      if (!me) return;
      const { visits: on } = z.object({ visits: z.boolean() }).parse(req.body);
      await db.transaction(async (tx) => {
        await tx
          .insert(groupSettings)
          .values({ groupId, visits: on })
          .onConflictDoUpdate({ target: groupSettings.groupId, set: { visits: on } });
        if (!on) await tx.delete(visits).where(eq(visits.groupId, groupId));
        await record(tx, {
          groupId,
          actorUserId: me.id,
          action: 'visits.settings_changed',
          metadata: { visits: on },
        });
      });
      return { ok: true };
    },
  );
}
