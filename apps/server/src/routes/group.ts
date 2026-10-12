import type { ActivityEntry, Person, Sent, ServerInfo, SignedIn } from '@ats/api-types';
import { schema } from '@ats/db';
import { avatarColor } from '@ats/shared';
import { and, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, requireArchitect, requireUser } from '../access.ts';
import { record } from '../audit.ts';
import type { AppContext } from '../context.ts';
import { noEvents } from '../events.ts';
import { getInstallState } from '../install-state.ts';
import { sendError } from '../reply.ts';
import { getSession, membershipsFor } from '../session.ts';

const {
  auditLog,
  creations,
  groups,
  memberships,
  roomAccess,
  roomPolicies,
  session,
  spaces,
  user,
  workspaces,
} = schema;

/** What the activity page shows (the rest is housekeeping: opening files, status checks). */
export const ACTIVITY = [
  'setup.completed',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'group.changed',
  'invite.created',
  'invite.revoked',
  'room.visibility_changed',
  'place.created',
  'place.built',
  'place.published',
  'place.reverted',
  'place.discarded',
  'place.exported',
  'place.imported',
  'creation.exported',
  'creation.imported',
  'space.sample_added',
  'request.created',
  'request.accepted',
  'request.declined',
  'workspace.created',
  'workspace.published',
  'workspace.deleted',
  'assistant.installed',
  'connect.forget',
  'chat.settings_changed',
  'chat.reported',
  'studio.settings',
  'backup.settings_changed',
  'server.sources_changed',
  'server.owner_changed',
];

/** The group, its people, what happened in it, and the server it runs on: for its Architects. */
export async function groupRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env } = ctx;
  const events = () => ctx.events ?? noEvents;

  /** Who may see what changed: the real-time service re-reads it for each of the group's spaces. */
  const accessChanged = async (groupId: string) => {
    const rows = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.groupId, groupId));
    for (const s of rows) await events().policyChanged(s.id);
  };
  const architectCount = async (groupId: string) =>
    (
      await db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.organizationId, groupId), eq(memberships.role, 'architect')))
    ).length;

  // ---- People ----------------------------------------------------------------------------------

  app.get<{ Params: { groupId: string } }>('/api/groups/:groupId/people', async (req, reply) => {
    const me = await requireArchitect(ctx, req, reply, req.params.groupId);
    if (!me) return;
    const rows = await db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(eq(memberships.organizationId, req.params.groupId))
      .orderBy(memberships.createdAt);
    // When each was last around (their newest sign-in session's activity).
    const seen = rows.length
      ? await db
          .select({ userId: session.userId, at: sql<Date>`max(${session.updatedAt})` })
          .from(session)
          .where(
            inArray(
              session.userId,
              rows.map((r) => r.userId),
            ),
          )
          .groupBy(session.userId)
      : [];
    return {
      people: rows.map(({ emailVerified, ...r }) => ({
        ...r,
        // Better Auth's plain text column, only ever architect or member (see membershipsFor).
        role: r.role as Person['role'],
        // Whether they've confirmed their email (only asked when the server sends email).
        emailConfirmed: env.SMTP_URL ? emailVerified : null,
        you: r.userId === me.id,
        color: avatarColor(r.userId),
        lastSeenAt: seen.find((s) => s.userId === r.userId)?.at ?? null,
      })) satisfies Sent<Person>[],
    };
  });

  app.put<{ Params: { groupId: string; userId: string } }>(
    '/api/groups/:groupId/people/:userId',
    async (req, reply) => {
      const { groupId, userId } = req.params;
      const me = await requireArchitect(ctx, req, reply, groupId);
      if (!me) return;
      const { role } = z.object({ role: z.enum(['architect', 'member']) }).parse(req.body);
      const [them] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.organizationId, groupId), eq(memberships.userId, userId)));
      if (!them) return notFound(reply, 'They aren’t in this group.');
      if (them.role === role) return { ok: true };
      if (role === 'member' && (await architectCount(groupId)) <= 1)
        return sendError(
          reply,
          409,
          'A group needs at least one Architect. Make someone else an Architect first.',
        );
      await db.update(memberships).set({ role }).where(eq(memberships.id, them.id));
      await record(db, {
        groupId,
        actorUserId: me.id,
        action: 'member.role_changed',
        target: userId,
        metadata: { role },
      });
      await accessChanged(groupId);
      return { ok: true };
    },
  );

  app.delete<{ Params: { groupId: string; userId: string } }>(
    '/api/groups/:groupId/people/:userId',
    async (req, reply) => {
      const { groupId, userId } = req.params;
      const me = await requireArchitect(ctx, req, reply, groupId);
      if (!me) return;
      if (userId === me.id)
        return sendError(reply, 409, 'You can’t remove yourself from the group.');
      const [them] = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.organizationId, groupId), eq(memberships.userId, userId)));
      if (!them) return notFound(reply, 'They aren’t in this group.');
      const [who] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId));
      const ids = (
        await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.groupId, groupId))
      ).map((s) => s.id);
      await db.transaction(async (tx) => {
        await tx.delete(memberships).where(eq(memberships.id, them.id));
        if (ids.length) {
          // Rooms shared with them, or theirs, aren't any more.
          await tx
            .delete(roomAccess)
            .where(and(inArray(roomAccess.spaceId, ids), eq(roomAccess.userId, userId)));
          await tx
            .update(roomPolicies)
            .set({ ownerId: null })
            .where(and(inArray(roomPolicies.spaceId, ids), eq(roomPolicies.ownerId, userId)));
        }
      });
      await record(db, {
        groupId,
        actorUserId: me.id,
        action: 'member.removed',
        target: userId,
        metadata: { name: who?.name ?? null },
      });
      // They leave any space they're walking in, and any creation they're playing, straight away.
      await accessChanged(groupId);
      await events().memberRemoved(groupId, userId);
      return { ok: true };
    },
  );

  // ---- The group -------------------------------------------------------------------------------

  app.put<{ Params: { groupId: string } }>('/api/groups/:groupId', async (req, reply) => {
    const me = await requireArchitect(ctx, req, reply, req.params.groupId);
    if (!me) return;
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        themeColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
      })
      .parse(req.body);
    if (!body.name && !body.themeColor) return { ok: true };
    await db.update(groups).set(body).where(eq(groups.id, req.params.groupId));
    await record(db, {
      groupId: req.params.groupId,
      actorUserId: me.id,
      action: 'group.changed',
      target: req.params.groupId,
      metadata: body,
    });
    return { ok: true };
  });

  // ---- What happened ---------------------------------------------------------------------------

  app.get<{ Params: { groupId: string }; Querystring: { before?: string; all?: string } }>(
    '/api/groups/:groupId/activity',
    async (req, reply) => {
      const me = await requireArchitect(ctx, req, reply, req.params.groupId);
      if (!me) return;
      const before = req.query.before ? new Date(req.query.before) : null;
      const rows = await db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          target: auditLog.target,
          metadata: auditLog.metadata,
          at: auditLog.createdAt,
          actorId: auditLog.actorUserId,
          actorName: user.name,
        })
        .from(auditLog)
        .leftJoin(user, eq(user.id, auditLog.actorUserId))
        .where(
          and(
            eq(auditLog.groupId, req.params.groupId),
            req.query.all === '1' ? undefined : inArray(auditLog.action, ACTIVITY),
            before && !Number.isNaN(before.getTime()) ? lt(auditLog.createdAt, before) : undefined,
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(51);
      // Names for the people and spaces entries are about.
      const targets = [...new Set(rows.map((r) => r.target).filter((t): t is string => !!t))];
      const people = targets.length
        ? await db
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(inArray(user.id, targets))
        : [];
      const uuids = targets
        .map((t) => t.split('/')[0] as string)
        .filter((t) => z.uuid().safeParse(t).success);
      const places = uuids.length
        ? await db
            .select({ id: spaces.id, name: spaces.name })
            .from(spaces)
            .where(inArray(spaces.id, uuids))
        : [];
      const made = uuids.length
        ? await db
            .select({ id: creations.id, name: creations.title })
            .from(creations)
            .where(inArray(creations.id, uuids))
        : [];
      const benches = uuids.length
        ? await db
            .select({ id: workspaces.id, name: workspaces.title })
            .from(workspaces)
            .where(inArray(workspaces.id, uuids))
        : [];
      const names = Object.fromEntries(
        [...people, ...places, ...made, ...benches].map((n) => [n.id, n.name] as const),
      );
      return {
        entries: rows.slice(0, 50).map((r) => {
          const key = r.target?.split('/')[0] ?? '';
          return {
            id: r.id,
            action: r.action,
            at: r.at,
            actor: r.actorId ? { id: r.actorId, name: r.actorName ?? 'Someone who left' } : null,
            about: names[key] ?? null,
            room: r.target?.includes('/') ? (r.target.split('/')[1] ?? null) : null,
            details: r.metadata,
          } satisfies Sent<ActivityEntry>;
        }),
        more: rows.length > 50,
      };
    },
  );

  // ---- The server ------------------------------------------------------------------------------

  app.get('/api/server', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const mine = await membershipsFor(db, me.id);
    if (!mine.some((m) => m.role === 'architect'))
      return sendError(reply, 403, 'Only Architects can see this.');
    const state = await getInstallState(db);
    const ownerId = state?.ownerUserId ?? null;
    const [owner] = ownerId
      ? await db.select({ name: user.name }).from(user).where(eq(user.id, ownerId))
      : [];
    const count = async (table: typeof user | typeof spaces | typeof creations) =>
      Number((await db.select({ n: sql<number>`count(*)` }).from(table))[0]?.n ?? 0);
    return {
      release: env.ATS_RELEASE ?? 'development',
      address: env.ATS_PUBLIC_URL,
      storage: state?.storageMode ?? 'builtin',
      backups: {
        schedule: state?.backup?.schedule ?? 'nightly',
        keepDays: state?.backup?.keepDays ?? 14,
        offsite: Boolean(state?.backup?.offsite),
      },
      features: {
        studio: Boolean(ctx.supervisor),
        voice: Boolean(env.LIVEKIT_API_KEY),
        email: Boolean(env.SMTP_URL),
      },
      counts: {
        people: await count(user),
        spaces: await count(spaces),
        creations: await count(creations),
      },
      owner: { name: owner?.name ?? null, you: ownerId === me.id },
    } satisfies Sent<ServerInfo>;
  });

  // ---- Your own sign-ins -----------------------------------------------------------------------

  app.get('/api/account/sessions', async (req, reply) => {
    const current = await getSession(ctx, req);
    if (!current) return sendError(reply, 401, 'Please sign in.');
    const rows = await db
      .select({
        id: session.id,
        createdAt: session.createdAt,
        lastActiveAt: session.updatedAt,
        userAgent: session.userAgent,
        expiresAt: session.expiresAt,
      })
      .from(session)
      .where(eq(session.userId, current.user.id))
      .orderBy(desc(session.updatedAt));
    return {
      sessions: rows
        .filter((s) => s.expiresAt > new Date())
        .map(({ expiresAt: _, ...s }) => ({
          ...s,
          current: s.id === current.session.id,
        })) satisfies Sent<SignedIn>[],
    };
  });

  app.delete<{ Params: { id: string } }>('/api/account/sessions/:id', async (req, reply) => {
    const current = await getSession(ctx, req);
    if (!current) return sendError(reply, 401, 'Please sign in.');
    if (req.params.id === current.session.id)
      return sendError(reply, 409, 'To sign out here, use Sign out.');
    await db
      .delete(session)
      .where(and(eq(session.id, req.params.id), eq(session.userId, current.user.id)));
    return { ok: true };
  });

  app.post('/api/account/sessions/sign-out-others', async (req, reply) => {
    const current = await getSession(ctx, req);
    if (!current) return sendError(reply, 401, 'Please sign in.');
    const others = await db
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.userId, current.user.id), isNotNull(session.id)));
    const ids = others.map((o) => o.id).filter((id) => id !== current.session.id);
    if (ids.length) await db.delete(session).where(inArray(session.id, ids));
    return { ok: true, signedOut: ids.length };
  });
}
