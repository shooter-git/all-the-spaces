import { type Db, schema } from '@ats/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireUser } from './access.ts';
import { record } from './audit.ts';
import type { AppContext } from './context.ts';
import { sendError } from './reply.ts';

/**
 * The server's owner: whoever installed it. In the app that's the account made with the
 * installer's one-time setup code (which only someone on the server itself can see), or whoever
 * `ats-admin owner` handed the role to since. It isn't a group's Architect: a server's Architects
 * run their group, the owner decides what the whole server allows (ADR 0012).
 */
export async function serverOwnerId(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ owner: schema.installState.ownerUserId })
    .from(schema.installState)
    .where(eq(schema.installState.id, 1));
  return row?.owner ?? null;
}

/** Whether this person is the server's owner. */
export const isServerOwner = async (db: Db, userId: string) => (await serverOwnerId(db)) === userId;

/**
 * The signed-in user, when they're the server's owner. Otherwise replies (401 when signed out,
 * else 403) and resolves null.
 */
export async function requireServerOwner(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const me = await requireUser(ctx, req, reply);
  if (!me) return null;
  if (!(await isServerOwner(ctx.db, me.id))) {
    await sendError(reply, 403, 'Only the server’s owner can do this.');
    return null;
  }
  return me;
}

/** Why the server's owner can't be handed to someone. */
export class OwnerError extends Error {}

/** Who owns the server now (name and email), if anyone. */
export async function serverOwner(db: Db) {
  const id = await serverOwnerId(db);
  if (!id) return null;
  const [who] = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, id));
  return who ?? null;
}

/**
 * Hands the server to the account with this email (`ats-admin owner EMAIL`, on the server itself).
 * They must be one of a group's Architects, since what the owner changes is in the Architects'
 * part of the app. Every group's Activity says so.
 */
export async function handServerTo(db: Db, email: string) {
  const [who] = await db
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = lower(${email.trim()})`);
  if (!who) throw new OwnerError(`there's no account with the email ${email.trim()}.`);
  const [architect] = await db
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, who.id), eq(schema.memberships.role, 'architect')));
  if (!architect)
    throw new OwnerError(
      `${who.name} isn't one of a group's Architects: make them one first (People, in the app).`,
    );
  await db.transaction(async (tx) => {
    await tx
      .update(schema.installState)
      .set({ ownerUserId: who.id, updatedAt: new Date() })
      .where(eq(schema.installState.id, 1));
    for (const g of await tx.select({ id: schema.groups.id }).from(schema.groups))
      await record(tx, {
        groupId: g.id,
        action: 'server.owner_changed',
        target: who.id,
      });
  });
  return who;
}
