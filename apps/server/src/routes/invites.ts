import { randomBytes } from 'node:crypto';
import type { InviteLink, Sent } from '@ats/api-types';
import { schema } from '@ats/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, requireArchitect, requireUser } from '../access.ts';
import { record } from '../audit.ts';
import type { AppContext } from '../context.ts';
import {
  hashInviteToken as hashToken,
  joinWithInvite,
  usableInvite as usable,
} from '../invite-tokens.ts';

const { inviteLinks, groups } = schema;

const ONLY_ARCHITECTS = { status: 403, error: 'Only Architects can manage invites.' };

export async function inviteRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env } = ctx;
  const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.post<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/invite-links',
    async (req, reply) => {
      const user = await requireArchitect(ctx, req, reply, req.params.groupId, ONLY_ARCHITECTS);
      if (!user) return;
      const body = z
        .object({
          role: z.enum(['architect', 'member']).default('member'),
          label: z.string().max(80).optional(),
          maxUses: z.number().int().min(1).max(500).optional(),
          expiresInDays: z.number().int().min(1).max(30).default(7),
        })
        .parse(req.body ?? {});
      const token = randomBytes(24).toString('base64url');
      const [row] = await db
        .insert(inviteLinks)
        .values({
          tokenHash: hashToken(token),
          groupId: req.params.groupId,
          role: body.role,
          label: body.label,
          maxUses: body.maxUses,
          createdBy: user.id,
          expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000),
        })
        .returning({ id: inviteLinks.id, expiresAt: inviteLinks.expiresAt });
      await record(db, {
        groupId: req.params.groupId,
        actorUserId: user.id,
        action: 'invite.created',
        target: row?.id,
        metadata: { role: body.role, maxUses: body.maxUses ?? null },
      });
      // The token lives in the URL fragment so it never reaches server logs or referrers.
      return { id: row?.id, expiresAt: row?.expiresAt, url: `${env.ATS_PUBLIC_URL}/join#${token}` };
    },
  );

  app.get<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/invite-links',
    async (req, reply) => {
      if (!(await requireArchitect(ctx, req, reply, req.params.groupId, ONLY_ARCHITECTS))) return;
      return (await db
        .select({
          id: inviteLinks.id,
          role: inviteLinks.role,
          label: inviteLinks.label,
          uses: inviteLinks.uses,
          maxUses: inviteLinks.maxUses,
          expiresAt: inviteLinks.expiresAt,
          revokedAt: inviteLinks.revokedAt,
        })
        .from(inviteLinks)
        .where(eq(inviteLinks.groupId, req.params.groupId))) satisfies Sent<InviteLink>[];
    },
  );

  app.delete<{ Params: { groupId: string; id: string } }>(
    '/api/groups/:groupId/invite-links/:id',
    async (req, reply) => {
      const user = await requireArchitect(ctx, req, reply, req.params.groupId, ONLY_ARCHITECTS);
      if (!user) return;
      await db
        .update(inviteLinks)
        .set({ revokedAt: new Date() })
        .where(and(eq(inviteLinks.id, req.params.id), eq(inviteLinks.groupId, req.params.groupId)));
      await record(db, {
        groupId: req.params.groupId,
        actorUserId: user.id,
        action: 'invite.revoked',
        target: req.params.id,
      });
      return { ok: true };
    },
  );

  app.post('/api/invites/inspect', limited, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const [row] = await db
      .select({ groupName: groups.name, themeColor: groups.themeColor, role: inviteLinks.role })
      .from(inviteLinks)
      .innerJoin(groups, eq(groups.id, inviteLinks.groupId))
      .where(and(eq(inviteLinks.tokenHash, hashToken(token)), usable()));
    if (!row) return notFound(reply, 'This invite link has expired or was turned off.');
    return row;
  });

  app.post('/api/invites/accept', limited, async (req, reply) => {
    const user = await requireUser(ctx, req, reply);
    if (!user) return;
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const result = await joinWithInvite(db, user.id, token);
    if (!result) return notFound(reply, 'This invite link has expired or was turned off.');
    return { ok: true, groupId: result };
  });
}
