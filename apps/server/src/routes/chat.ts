import type { ChatMessage, ChatState, LiveEvent, Sent } from '@ats/api-types';
import { schema } from '@ats/db';
import { avatarColor } from '@ats/shared';
import type { WebSocket } from '@fastify/websocket';
import { and, desc, eq, inArray, isNull, like, lt, notInArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isArchitect, notFound, requireUser } from '../access.ts';
import { record } from '../audit.ts';
import { blockedBetween, channelAccess, parseChannel } from '../chat/channels.ts';
import type { AppContext } from '../context.ts';
import { noEvents } from '../events.ts';
import type { Notifier } from '../notify.ts';
import { sendError } from '../reply.ts';
import { getSession, membershipsFor } from '../session.ts';

const {
  chatMessages,
  chatBlocks,
  chatMutes,
  chatReports,
  userPrefs,
  groupSettings,
  memberships,
  user,
} = schema;

const MAX_LENGTH = 2000;
const PAGE = 50;
/** At most this many messages per person in any 10 seconds. */
const BURST = 8;
export const RETENTION_CHOICES = [7, 30, 90, 365, null] as const;

class ChatError extends Error {}

/** Text chat: live over one WebSocket per tab, history and settings over plain requests. */
export async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const hub = (ctx.notifier as Notifier).hub;
  const recent = new Map<string, number[]>();

  const namesOf = async (ids: string[]) =>
    new Map(
      ids.length
        ? (
            await db
              .select({ id: user.id, name: user.name })
              .from(user)
              .where(inArray(user.id, [...new Set(ids)]))
          ).map((u) => [u.id, u.name])
        : [],
    );

  /** Everyone who shares a group with this person (including them). */
  async function peopleAround(userId: string) {
    const groupIds = (await membershipsFor(db, userId)).map((m) => m.groupId);
    if (groupIds.length === 0) return [];
    return db
      .selectDistinct({ id: user.id, name: user.name, dnd: userPrefs.dnd })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .leftJoin(userPrefs, eq(userPrefs.userId, user.id))
      .where(inArray(memberships.organizationId, groupIds));
  }

  async function send(sender: { id: string; name: string }, channel: string, text: string) {
    const body = text.trim();
    if (!body) throw new ChatError('Type a message first.');
    if (body.length > MAX_LENGTH)
      throw new ChatError(`Messages can be up to ${MAX_LENGTH} characters.`);
    const now = Date.now();
    const times = (recent.get(sender.id) ?? []).filter((t) => now - t < 10_000);
    if (times.length >= BURST) throw new ChatError('Slow down a little.');
    const access = await channelAccess(db, sender.id, channel);
    if (!access) throw new ChatError("You can't post there.");
    const parsed = parseChannel(channel);
    if (parsed?.kind === 'dm') {
      const other = parsed.a === sender.id ? parsed.b : parsed.a;
      const blocks = await blockedBetween(db, sender.id, [other]);
      if (blocks.blockedByMe.size || blocks.blockingMe.size) {
        throw new ChatError("You can't message this person.");
      }
    }
    times.push(now);
    recent.set(sender.id, times);
    const [row] = await db
      .insert(chatMessages)
      .values({ groupId: access.groupId, channel, senderId: sender.id, body })
      .returning();
    if (!row) throw new ChatError('Something went wrong.');
    const message: ChatMessage = {
      id: row.id,
      channel,
      senderId: sender.id,
      senderName: sender.name,
      body,
      createdAt: row.createdAt.toISOString(),
    };
    const readers = await access.readers();
    const { blockingMe } = await blockedBetween(db, sender.id, readers);
    hub.send(
      readers.filter((r) => !blockingMe.has(r)),
      { t: 'message', message },
    );
    return message;
  }

  // ---- Live connection -----------------------------------------------------------------------

  const Incoming = z.discriminatedUnion('t', [
    z.object({
      t: z.literal('send'),
      channel: z.string().max(200),
      body: z.string().max(MAX_LENGTH * 2),
      nonce: z.string().max(64),
    }),
    z.object({ t: z.literal('ping') }),
  ]);

  app.get('/api/live', { websocket: true }, async (socket: WebSocket, req) => {
    // Only pages from this site may open a live connection with your cookies.
    const expected = new URL(ctx.env.ATS_PUBLIC_URL).origin;
    if (req.headers.origin !== expected) {
      socket.close(1008, 'origin');
      return;
    }
    const queued: string[] = [];
    let me: { id: string; name: string } | null = null;
    const handle = async (raw: string) => {
      if (!me) return;
      let msg: z.infer<typeof Incoming>;
      try {
        msg = Incoming.parse(JSON.parse(raw));
      } catch {
        return;
      }
      if (msg.t === 'ping') {
        socket.send(JSON.stringify({ t: 'pong' } satisfies LiveEvent));
        return;
      }
      try {
        const message = await send(me, msg.channel, msg.body);
        socket.send(JSON.stringify({ t: 'ack', nonce: msg.nonce, message } satisfies LiveEvent));
      } catch (err) {
        const error = err instanceof ChatError ? err.message : 'Something went wrong.';
        if (!(err instanceof ChatError)) req.log.error(err);
        socket.send(JSON.stringify({ t: 'error', nonce: msg.nonce, error } satisfies LiveEvent));
      }
    };
    socket.on('message', (data) => {
      const raw = data.toString();
      if (me) void handle(raw);
      else queued.push(raw);
    });
    const session = await getSession(ctx, req);
    if (!session) {
      socket.close(1008, 'sign in');
      return;
    }
    me = { id: session.user.id, name: session.user.name };
    const userId = me.id;
    hub.add(userId, socket);
    socket.on('close', () => hub.remove(userId, socket));
    socket.send(JSON.stringify({ t: 'hello', userId } satisfies LiveEvent));
    for (const raw of queued.splice(0)) void handle(raw);
  });

  // ---- History and state ---------------------------------------------------------------------

  app.get<{ Querystring: { channel?: string; before?: string } }>(
    '/api/chat/history',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const { channel, before } = z
        .object({ channel: z.string().max(200), before: z.iso.datetime().optional() })
        .parse(req.query);
      if (!(await channelAccess(db, me.id, channel))) {
        return notFound(reply, 'That conversation does not exist.');
      }
      const blocked = db
        .select({ id: chatBlocks.blockedId })
        .from(chatBlocks)
        .where(eq(chatBlocks.blockerId, me.id));
      const rows = await db
        .select({
          id: chatMessages.id,
          channel: chatMessages.channel,
          senderId: chatMessages.senderId,
          senderName: user.name,
          body: chatMessages.body,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .innerJoin(user, eq(user.id, chatMessages.senderId))
        .where(
          and(
            eq(chatMessages.channel, channel),
            before ? lt(chatMessages.createdAt, new Date(before)) : undefined,
            // Messages from people you've blocked are never sent to you.
            notInArray(chatMessages.senderId, blocked),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(PAGE);
      return {
        messages: rows.reverse().map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
        more: rows.length === PAGE,
      } satisfies { messages: ChatMessage[]; more: boolean };
    },
  );

  /** Everything the chat panel needs to start: people, blocks, mutes, recent conversations. */
  app.get('/api/chat/state', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const [people, blocks, mutes, dms] = await Promise.all([
      peopleAround(me.id),
      db.select().from(chatBlocks).where(eq(chatBlocks.blockerId, me.id)),
      db.select().from(chatMutes).where(eq(chatMutes.userId, me.id)),
      db
        .selectDistinctOn([chatMessages.channel], {
          channel: chatMessages.channel,
          at: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(
          or(
            like(chatMessages.channel, `dm:${me.id}:%`),
            like(chatMessages.channel, `dm:%:${me.id}`),
          ),
        )
        .orderBy(chatMessages.channel, desc(chatMessages.createdAt)),
    ]);
    return {
      me: { id: me.id, dnd: people.find((p) => p.id === me.id)?.dnd ?? false },
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        color: avatarColor(p.id),
        dnd: p.dnd ?? false,
        online: hub.isOnline(p.id),
      })),
      blocked: blocks.map((b) => b.blockedId),
      muted: mutes.map((m) => m.channel),
      conversations: dms
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, 30)
        .map((d) => ({ channel: d.channel, at: d.at.toISOString() })),
    } satisfies Sent<ChatState>;
  });

  // ---- Do Not Disturb, mute, block, report -------------------------------------------------

  app.put('/api/chat/dnd', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const { dnd } = z.object({ dnd: z.boolean() }).parse(req.body);
    await db
      .insert(userPrefs)
      .values({ userId: me.id, dnd })
      .onConflictDoUpdate({ target: userPrefs.userId, set: { dnd, updatedAt: new Date() } });
    const around = await peopleAround(me.id);
    hub.send(
      around.map((p) => p.id),
      { t: 'dnd', userId: me.id, dnd },
    );
    return { ok: true };
  });

  app.put('/api/chat/mute', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const { channel, muted } = z
      .object({ channel: z.string().max(200), muted: z.boolean() })
      .parse(req.body);
    if (!(await channelAccess(db, me.id, channel))) {
      return notFound(reply, 'That conversation does not exist.');
    }
    if (muted) await db.insert(chatMutes).values({ userId: me.id, channel }).onConflictDoNothing();
    else
      await db
        .delete(chatMutes)
        .where(and(eq(chatMutes.userId, me.id), eq(chatMutes.channel, channel)));
    return { ok: true };
  });

  app.put('/api/chat/block', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const { userId, blocked } = z
      .object({ userId: z.string().max(64), blocked: z.boolean() })
      .parse(req.body);
    if (userId === me.id || !(await peopleAround(me.id)).some((p) => p.id === userId)) {
      return notFound(reply, 'That person is not in your group.');
    }
    if (blocked) {
      await db
        .insert(chatBlocks)
        .values({ blockerId: me.id, blockedId: userId })
        .onConflictDoNothing();
    } else {
      await db
        .delete(chatBlocks)
        .where(and(eq(chatBlocks.blockerId, me.id), eq(chatBlocks.blockedId, userId)));
    }
    return { ok: true };
  });

  app.post('/api/chat/report', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const { messageId, reason } = z
      .object({ messageId: z.uuid(), reason: z.string().max(500).optional() })
      .parse(req.body);
    const [msg] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
    // Only messages you could read yourself.
    if (!msg || !(await channelAccess(db, me.id, msg.channel))) {
      return notFound(reply, 'That message does not exist.');
    }
    await db.insert(chatReports).values({
      groupId: msg.groupId,
      reporterId: me.id,
      messageId: msg.id,
      senderId: msg.senderId,
      body: msg.body,
      reason,
    });
    await record(db, {
      groupId: msg.groupId,
      actorUserId: me.id,
      action: 'chat.reported',
      target: msg.id,
    });
    return { ok: true };
  });

  // ---- Architects: reports and how long chat is kept ----------------------------------------

  app.get<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/chat-reports',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      if (!(await isArchitect(db, me.id, req.params.groupId))) {
        return sendError(reply, 403, 'Only Architects can see reports.');
      }
      const rows = await db
        .select()
        .from(chatReports)
        .where(and(eq(chatReports.groupId, req.params.groupId), isNull(chatReports.resolvedAt)))
        .orderBy(desc(chatReports.createdAt));
      const names = await namesOf(rows.flatMap((r) => [r.reporterId, r.senderId ?? '']));
      return {
        reports: rows.map((r) => ({
          id: r.id,
          body: r.body,
          reason: r.reason,
          sender: names.get(r.senderId ?? '') ?? 'Someone',
          reporter: names.get(r.reporterId) ?? 'Someone',
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post<{ Params: { reportId: string } }>(
    '/api/chat/reports/:reportId/resolve',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const id = z.uuid().safeParse(req.params.reportId);
      const [report] = id.success
        ? await db.select().from(chatReports).where(eq(chatReports.id, id.data))
        : [];
      if (!report || !(await isArchitect(db, me.id, report.groupId))) {
        return notFound(reply, 'That report does not exist.');
      }
      await db
        .update(chatReports)
        .set({ resolvedAt: new Date() })
        .where(eq(chatReports.id, report.id));
      return { ok: true };
    },
  );

  app.get<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/chat-settings',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      if (!(await isArchitect(db, me.id, req.params.groupId))) {
        return sendError(reply, 403, 'Only Architects can change chat settings.');
      }
      const [row] = await db
        .select()
        .from(groupSettings)
        .where(eq(groupSettings.groupId, req.params.groupId));
      return {
        retentionDays: row ? row.chatRetentionDays : 90,
        choices: RETENTION_CHOICES,
        voice: row?.voice ?? true,
        voiceAvailable: Boolean(ctx.env.LIVEKIT_API_KEY),
      };
    },
  );

  app.put<{ Params: { groupId: string } }>(
    '/api/groups/:groupId/chat-settings',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      if (!(await isArchitect(db, me.id, req.params.groupId))) {
        return sendError(reply, 403, 'Only Architects can change chat settings.');
      }
      const { retentionDays, voice } = z
        .object({
          retentionDays: z.union([
            z.literal(7),
            z.literal(30),
            z.literal(90),
            z.literal(365),
            z.null(),
          ]),
          voice: z.boolean().optional(),
        })
        .parse(req.body);
      const [before] = await db
        .select()
        .from(groupSettings)
        .where(eq(groupSettings.groupId, req.params.groupId));
      const set = { chatRetentionDays: retentionDays, ...(voice === undefined ? {} : { voice }) };
      await db
        .insert(groupSettings)
        .values({ groupId: req.params.groupId, ...set })
        .onConflictDoUpdate({ target: groupSettings.groupId, set });
      await record(db, {
        groupId: req.params.groupId,
        actorUserId: me.id,
        action: 'chat.settings_changed',
        metadata: set,
      });
      // Turning voice off takes everyone out of voice rooms straight away.
      if (voice !== undefined && voice !== (before?.voice ?? true)) {
        const groupSpaces = await db
          .select({ id: schema.spaces.id })
          .from(schema.spaces)
          .where(eq(schema.spaces.groupId, req.params.groupId));
        for (const s of groupSpaces) await (ctx.events ?? noEvents).policyChanged(s.id);
      }
      return { ok: true };
    },
  );
}
