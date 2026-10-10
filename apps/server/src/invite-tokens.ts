import { createHash, randomUUID } from 'node:crypto';
import { type Db, schema } from '@ats/db';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { record } from './audit.ts';

const { inviteLinks, memberships } = schema;

export const hashInviteToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** SQL condition for an invite link that can still be used. */
export const usableInvite = () =>
  and(
    isNull(inviteLinks.revokedAt),
    gt(inviteLinks.expiresAt, new Date()),
    or(isNull(inviteLinks.maxUses), gt(inviteLinks.maxUses, inviteLinks.uses)),
  );

export async function isUsableInviteToken(db: Db, token: string): Promise<boolean> {
  const rows = await db
    .select({ id: inviteLinks.id })
    .from(inviteLinks)
    .where(and(eq(inviteLinks.tokenHash, hashInviteToken(token)), usableInvite()));
  return rows.length > 0;
}

/**
 * Puts someone in the group an invite link is for, using up one of its uses (once: someone
 * already in the group just gets its id). Null if the link can't be used.
 */
export async function joinWithInvite(db: Db, userId: string, token: string) {
  return db.transaction(async (tx) => {
    // Someone already in by this link (signing up with it puts them in) needn't use it again.
    const [target] = await tx
      .select({ groupId: inviteLinks.groupId })
      .from(inviteLinks)
      .where(eq(inviteLinks.tokenHash, hashInviteToken(token)));
    if (!target) return null;
    const already = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.organizationId, target.groupId), eq(memberships.userId, userId)));
    if (already.length > 0) return target.groupId;
    // Claim one use atomically so a limited link can't be over-used by parallel requests.
    const [link] = await tx
      .update(inviteLinks)
      .set({ uses: sql`${inviteLinks.uses} + 1` })
      .where(and(eq(inviteLinks.tokenHash, hashInviteToken(token)), usableInvite()))
      .returning({ id: inviteLinks.id, groupId: inviteLinks.groupId, role: inviteLinks.role });
    if (!link) return null;
    await tx.insert(memberships).values({
      id: randomUUID(),
      organizationId: link.groupId,
      userId,
      role: link.role,
      createdAt: new Date(),
    });
    await record(tx, {
      groupId: link.groupId,
      actorUserId: userId,
      action: 'member.joined',
      target: link.id,
      metadata: { role: link.role },
    });
    return link.groupId;
  });
}
