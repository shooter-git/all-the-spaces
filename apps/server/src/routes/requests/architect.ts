import { schema } from '@ats/db';
import { and, desc, eq, gt, inArray, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { architectGroups, notFound, requireUser } from '../../access.ts';
import { record } from '../../audit.ts';
import { moveCommission, OPEN } from '../../commissions.ts';
import type { AppContext } from '../../context.ts';
import { sendError } from '../../reply.ts';
import { NO_SUCH_REQUEST, type RequestShared } from './shared.ts';

const { commissions, spaces, user } = schema;

/** The Architects' side: the queue, and answering or shaping a request. */
export async function architectRequestRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { requestFor, summary }: RequestShared,
) {
  const { db } = ctx;

  // ---- The Architects' queue ------------------------------------------------------------------

  /** Every request in the groups this person is an Architect of. */
  app.get<{ Querystring: { all?: string } }>('/api/studio/requests', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const groups = await architectGroups(db, me.id);
    if (groups.length === 0) return notFound(reply);
    const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const rows = await db
      .select({ c: commissions, spaceName: spaces.name, requesterName: user.name })
      .from(commissions)
      .innerJoin(spaces, eq(spaces.id, commissions.spaceId))
      .leftJoin(user, eq(user.id, commissions.requesterId))
      .where(
        and(
          inArray(commissions.groupId, groups),
          req.query.all
            ? undefined
            : or(inArray(commissions.status, OPEN), gt(commissions.closedAt, recent)),
        ),
      )
      .orderBy(desc(commissions.createdAt))
      .limit(500);
    const rank = { high: 0, normal: 1, low: 2 } as const;
    const list = rows
      .map((r) =>
        summary(r.c, {
          spaceName: r.spaceName,
          requesterName: r.requesterName,
          forArchitect: true,
        }),
      )
      .sort(
        (a, b) =>
          Number(b.open) - Number(a.open) ||
          rank[a.priority as keyof typeof rank] - rank[b.priority as keyof typeof rank] ||
          +new Date(a.createdAt) - +new Date(b.createdAt),
      );
    reply.header('cache-control', 'private, no-store');
    return { requests: list };
  });

  const architectRequest = async (userId: string, id: string, reply: FastifyReply) => {
    const found = await requestFor(userId, id);
    if (!found?.isArchitect) {
      await notFound(reply, NO_SUCH_REQUEST);
      return null;
    }
    return found.c;
  };

  app.patch<{ Params: { id: string } }>('/api/requests/:id', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const c = await architectRequest(me.id, req.params.id, reply);
    if (!c) return;
    const body = z
      .object({
        title: z.string().trim().min(1).max(80).optional(),
        brief: z.string().trim().max(10_000).nullable().optional(),
        priority: z.enum(['low', 'normal', 'high']).optional(),
        effort: z.enum(['small', 'medium', 'large']).nullable().optional(),
      })
      .parse(req.body);
    await db
      .update(commissions)
      .set({ ...body, ...(body.brief === '' ? { brief: null } : {}) })
      .where(eq(commissions.id, c.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/requests/:id/accept', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const c = await architectRequest(me.id, req.params.id, reply);
    if (!c) return;
    const { note } = z
      .object({ note: z.string().trim().max(2000).optional() })
      .parse(req.body ?? {});
    if (c.status !== 'submitted') return sendError(reply, 409, 'It’s already been answered.');
    await moveCommission(db, ctx.notifier, c, 'accepted', { actorId: me.id, note: note || null });
    await record(db, {
      groupId: c.groupId,
      actorUserId: me.id,
      action: 'request.accepted',
      target: c.id,
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/requests/:id/decline', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const c = await architectRequest(me.id, req.params.id, reply);
    if (!c) return;
    const { note } = z.object({ note: z.string().trim().min(1).max(2000) }).parse(req.body);
    if (!OPEN.includes(c.status)) return sendError(reply, 409, 'It’s already closed.');
    await moveCommission(db, ctx.notifier, c, 'declined', { actorId: me.id, note });
    await record(db, {
      groupId: c.groupId,
      actorUserId: me.id,
      action: 'request.declined',
      target: c.id,
    });
    return { ok: true };
  });
}
