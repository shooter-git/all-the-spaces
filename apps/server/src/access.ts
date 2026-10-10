import type { Db } from '@ats/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.ts';
import { sendError } from './reply.ts';
import { getSession, membershipsFor } from './session.ts';

/** Resolves the signed-in user or replies 401. */
export async function requireUser(ctx: AppContext, req: FastifyRequest, reply: FastifyReply) {
  const session = await getSession(ctx, req);
  if (!session) {
    await sendError(reply, 401, 'Please sign in.');
    return null;
  }
  return session.user;
}

/** The groups this person is one of the Architects of. */
export async function architectGroups(db: Db, userId: string) {
  return (await membershipsFor(db, userId))
    .filter((m) => m.role === 'architect')
    .map((m) => m.groupId);
}

/** Whether this person is one of the group's Architects. */
export async function isArchitect(db: Db, userId: string, groupId: string) {
  return (await architectGroups(db, userId)).includes(groupId);
}

/** What someone who isn't one of the group's Architects is told, unless a route says otherwise. */
const ONLY_ARCHITECTS = { status: 403, error: 'Only the group’s Architects can do this.' };

/**
 * The signed-in user, when they're one of the group's Architects. Otherwise replies (401 when
 * signed out, else `refusal`) and resolves null.
 */
export async function requireArchitect(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  groupId: string,
  refusal: { status: number; error: string } = ONLY_ARCHITECTS,
) {
  const me = await requireUser(ctx, req, reply);
  if (!me) return null;
  if (!(await isArchitect(ctx.db, me.id, groupId))) {
    await sendError(reply, refusal.status, refusal.error);
    return null;
  }
  return me;
}

/** 404: also the answer for what exists but isn't this person's, so nothing is given away. */
export const notFound = (reply: FastifyReply, error = 'Not found.') => sendError(reply, 404, error);
