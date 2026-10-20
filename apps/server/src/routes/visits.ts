import type { PlaceVisits, Sent } from '@ats/api-types';
import { schema, VISIT_RETENTION_DAYS } from '@ats/db';
import { avatarColor } from '@ats/shared';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isArchitect, notFound, requireUser } from '../access.ts';
import type { AppContext } from '../context.ts';
import { manifestOf } from '../manifests.ts';
import { recentVisits, recordVisits, timeByPerson, visitEnd } from '../visits.ts';
import { fromRealtime } from './realtime.ts';

const { creations, spaces, spaceVersions, user, visits } = schema;

const At = z.number().int().nonnegative();
const Started = z.intersection(
  z.object({
    id: z.uuid(),
    userId: z.string().min(1).max(64),
    startedAt: At,
    endedAt: At.optional(),
  }),
  z.union([
    z.object({ spaceId: z.uuid(), roomKey: z.string().min(1).max(64) }),
    z.object({ creationId: z.uuid(), versionId: z.uuid() }),
  ]),
);
const Batch = z.object({
  now: At,
  started: z.array(Started).max(1000),
  ended: z.array(z.object({ id: z.uuid(), at: At })).max(1000),
  going: z.array(z.uuid()).max(50_000).optional(),
});

const people = sql<number>`count(distinct ${visits.userId})::int`;
const seconds = sql<number>`coalesce(sum(extract(epoch from ${visitEnd} - ${visits.startedAt})), 0)::float8`;

/**
 * Visits: time people spend in each room of a place and in each creation. The real-time service
 * says who's where (coarse spans, never positions); only the group's Architects see the totals.
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

  /** For Architects: time in each room and creation of a place, and each person's time there. */
  app.get<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/visits', async (req, reply) => {
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
    const here = and(eq(visits.spaceId, spaceId), recentVisits);
    const [roomRows, creationRows, made, everyone, inCreations] = await Promise.all([
      db
        .select({ key: visits.roomKey, people, seconds: seconds.mapWith(Number) })
        .from(visits)
        .where(and(here, isNotNull(visits.roomKey)))
        .groupBy(visits.roomKey),
      db
        .select({ id: visits.creationId, people, seconds: seconds.mapWith(Number) })
        .from(visits)
        .where(and(here, isNotNull(visits.creationId)))
        .groupBy(visits.creationId),
      db
        .select({ id: creations.id, title: creations.title })
        .from(creations)
        .where(eq(creations.spaceId, spaceId)),
      timeByPerson(db, eq(visits.spaceId, spaceId)),
      timeByPerson(db, and(eq(visits.spaceId, spaceId), isNotNull(visits.creationId))),
    ]);
    const names = everyone.size
      ? await db
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, [...everyone.keys()]))
      : [];

    // Every room of the live version, with any since removed that people spent time in.
    const manifest = space.version ? manifestOf(space.version) : null;
    const floors = new Map(manifest?.floors.map((f) => [f.key, f.name]));
    const spent = new Map(roomRows.map((r) => [r.key, r]));
    const rooms = [
      ...(manifest?.rooms ?? []).map((r) => ({
        key: r.key,
        name: r.name,
        floor: floors.size > 1 ? (floors.get(r.floorKey) ?? null) : null,
      })),
      ...roomRows
        .filter((r) => r.key && !manifest?.rooms.some((m) => m.key === r.key))
        .map((r) => ({ key: r.key as string, name: null, floor: null })),
    ].map((r) => ({
      ...r,
      people: spent.get(r.key)?.people ?? 0,
      seconds: Math.round(spent.get(r.key)?.seconds ?? 0),
    }));
    const inCreation = new Map(creationRows.map((c) => [c.id, c]));
    reply.header('cache-control', 'private, no-store');
    return {
      days: VISIT_RETENTION_DAYS,
      rooms: rooms.sort((a, b) => b.seconds - a.seconds),
      creations: made
        .map((c) => ({
          ...c,
          people: inCreation.get(c.id)?.people ?? 0,
          seconds: Math.round(inCreation.get(c.id)?.seconds ?? 0),
        }))
        .sort((a, b) => b.seconds - a.seconds),
      people: names
        .map((u) => {
          const time = everyone.get(u.id);
          return {
            userId: u.id,
            name: u.name,
            color: avatarColor(u.id),
            seconds: time?.seconds ?? 0,
            inCreations: inCreations.get(u.id)?.seconds ?? 0,
            lastAt: (time?.lastAt ?? new Date(0)).toISOString(),
          };
        })
        .sort((a, b) => b.seconds - a.seconds),
    } satisfies Sent<PlaceVisits>;
  });
}
