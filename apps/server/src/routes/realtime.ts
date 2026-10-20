import { timingSafeEqual } from 'node:crypto';
import { schema } from '@ats/db';
import { avatarColor, shardFor, signTicket } from '@ats/shared';
import { count, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound, requireUser } from '../access.ts';
import type { AppContext } from '../context.ts';
import { spaceAccess } from '../privacy.ts';
import { membershipsFor } from '../session.ts';
import { voiceFor } from '../voice.ts';

const { memberships, spaces, spaceVersions } = schema;

/** Whether a request comes from the real-time service (it sends the shared secret). */
export function fromRealtime(req: FastifyRequest, secret: string) {
  const given = Buffer.from(String(req.headers['x-realtime-secret'] ?? ''));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function realtimeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env } = ctx;

  // A short-lived ticket to join the live presence room of a space you belong to.
  app.post<{ Params: { spaceId: string } }>(
    '/api/spaces/:spaceId/realtime-ticket',
    async (req, reply) => {
      const user = await requireUser(ctx, req, reply);
      if (!user) return;
      if (!z.uuid().safeParse(req.params.spaceId).success)
        return notFound(reply, 'That space does not exist.');
      const [space] = await db
        .select({ groupId: spaces.groupId })
        .from(spaces)
        .where(eq(spaces.id, req.params.spaceId));
      const mine = await membershipsFor(db, user.id);
      if (!space || !mine.some((m) => m.groupId === space.groupId)) {
        return notFound(reply, 'That space does not exist.');
      }
      // Big groups are spread over several live rooms (see `shardFor`).
      const [members] = await db
        .select({ n: count() })
        .from(memberships)
        .where(eq(memberships.organizationId, space.groupId));
      const shard = shardFor(user.id, members?.n ?? 1);
      const ticket = signTicket(
        {
          sub: user.id,
          name: user.name,
          color: avatarColor(user.id),
          spaceId: req.params.spaceId,
          shard,
        },
        env.REALTIME_SECRET,
      );
      return { ticket, shard, voice: (await voiceFor(db, env, space.groupId)).available };
    },
  );

  // Internal: the room graph of a space's current version, for the real-time service's interest
  // management. Authenticated with the shared secret; not routed by the public proxy.
  app.get<{ Params: { spaceId: string } }>(
    '/internal/spaces/:spaceId/graph',
    async (req, reply) => {
      if (!fromRealtime(req, env.REALTIME_SECRET)) return reply.code(404).send();
      if (!z.uuid().safeParse(req.params.spaceId).success) return reply.code(404).send();
      const [row] = await db
        .select({ manifest: spaceVersions.manifest, groupId: spaces.groupId })
        .from(spaces)
        .innerJoin(spaceVersions, eq(spaceVersions.id, spaces.currentVersionId))
        .where(eq(spaces.id, req.params.spaceId));
      if (!row) return reply.code(404).send();
      const m = row.manifest;
      return {
        rooms: m.rooms.map((r) => ({
          key: r.key,
          name: r.name,
          floorKey: r.floorKey,
          neighbors: r.neighbors,
        })),
        links: m.links.map((l) => ({ key: l.key, rooms: l.stops.map((s) => s.roomKey) })),
        access: await spaceAccess(db, req.params.spaceId),
        voice: (await voiceFor(db, env, row.groupId)).allowed,
      };
    },
  );
}
