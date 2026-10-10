// Chat: live delivery, privacy, blocking, voice and retention.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, deleteExpiredChat, schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSampleSpace,
  adminUrl,
  createTestApp,
  type Fakes,
  ORIGIN,
  seedGroup,
  type TestApp,
} from '../harness.ts';

describe.skipIf(!adminUrl)('server flows', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let db: Db;
  let realtimeSecret: string;
  let announced: Fakes['announced'];
  let architectCookie = '';
  let memberCookie = '';
  let groupId = '';
  let spaceId = '';

  beforeAll(async () => {
    t = await createTestApp();
    ({ app, db, realtimeSecret } = t);
    ({ announced } = t.fake);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
  });

  afterAll(async () => {
    await t?.close();
  });

  const signUpOutsider = () => t.signUpOutsider(architectCookie, groupId);

  describe('chat', () => {
    type Live = {
      messages: Record<string, unknown>[];
      send: (m: object) => void;
      close: () => void;
    };
    /** A live connection that records everything it receives. */
    async function connect(cookie: string): Promise<Live> {
      const ws = await app.injectWS('/api/live', { headers: { cookie, origin: ORIGIN } });
      const messages: Record<string, unknown>[] = [];
      ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
      await until(() => messages.some((m) => m.t === 'hello'));
      return { messages, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.terminate() };
    }
    async function until(check: () => boolean, ms = 2000) {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    /**
     * Waits until everything the server sent this connection so far has arrived: it answers a
     * ping on the same connection, after whatever it sent before. (Messages reach every reader
     * before the sender's ack, so after an ack this also covers that message.)
     */
    async function caughtUp(live: Live) {
      const pongs = () => live.messages.filter((m) => m.t === 'pong').length;
      const before = pongs();
      live.send({ t: 'ping' });
      await until(() => pongs() > before);
    }
    const got = (live: Live, body: string) =>
      live.messages.some((m) => m.t === 'message' && (m.message as { body: string }).body === body);
    const acked = (live: Live, nonce: string) =>
      live.messages.find((m) => (m.t === 'ack' || m.t === 'error') && m.nonce === nonce);
    const put = (url: string, cookie: string, payload: object) =>
      app.inject({ method: 'PUT', url, headers: { cookie }, payload });
    const history = (channel: string, cookie: string) =>
      app.inject({
        method: 'GET',
        url: `/api/chat/history?channel=${encodeURIComponent(channel)}`,
        headers: { cookie },
      });

    let architect: Live;
    let member: Live;
    let architectId = '';
    let memberId = '';
    let n = 0;
    /** Sends and waits for the server's answer. */
    async function say(live: Live, channel: string, body: string) {
      const nonce = `n${n++}`;
      live.send({ t: 'send', channel, body, nonce });
      await until(() => Boolean(acked(live, nonce)));
      return acked(live, nonce) as { t: string; error?: string; message?: { id: string } };
    }

    beforeAll(async () => {
      architect = await connect(architectCookie);
      member = await connect(memberCookie);
      const me = async (cookie: string) =>
        (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().user.id;
      architectId = await me(architectCookie);
      memberId = await me(memberCookie);
    });
    afterAll(() => {
      architect?.close();
      member?.close();
    });

    it('refuses live connections from other websites', async () => {
      const ws = await app.injectWS('/api/live', {
        headers: { cookie: memberCookie, origin: 'https://evil.example' },
      });
      const closed = await new Promise<number>((r) => ws.on('close', (code) => r(code)));
      expect(closed).toBe(1008);
    });

    it('delivers space chat to everyone in the group, and keeps history', async () => {
      const reply = await say(architect, `space:${spaceId}`, 'Welcome, everyone!');
      expect(reply.t).toBe('ack');
      await until(() => got(member, 'Welcome, everyone!'));
      const res = await history(`space:${spaceId}`, memberCookie);
      expect(res.json().messages.map((m: { body: string }) => m.body)).toContain(
        'Welcome, everyone!',
      );
    });

    it('keeps room chat to the people who may see the room', async () => {
      await put(`/api/spaces/${spaceId}/rooms/bath`, architectCookie, { visibility: 'hidden' });
      const room = `room:${spaceId}:bath`;
      expect((await say(member, room, 'hello?')).t).toBe('error');
      expect((await history(room, memberCookie)).statusCode).toBe(404);
      expect((await say(architect, room, 'Just me in here')).t).toBe('ack');
      await caughtUp(member);
      expect(got(member, 'Just me in here')).toBe(false);
      await put(`/api/spaces/${spaceId}/rooms/bath`, architectCookie, { visibility: 'group' });
      expect((await say(member, room, 'Now I can talk here')).t).toBe('ack');
      await until(() => got(architect, 'Now I can talk here'));
    });

    it('sends direct messages only between people in the same group', async () => {
      const dm =
        architectId < memberId ? `dm:${architectId}:${memberId}` : `dm:${memberId}:${architectId}`;
      expect((await say(member, dm, 'Hi Pat')).t).toBe('ack');
      await until(() => got(architect, 'Hi Pat'));
      // Someone outside the group can't join the conversation or start one.
      const outsider = await signUpOutsider();
      expect((await history(dm, outsider)).statusCode).toBe(404);
      const outsiderId = (
        await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: outsider } })
      ).json().user.id;
      const theirs =
        outsiderId < memberId ? `dm:${outsiderId}:${memberId}` : `dm:${memberId}:${outsiderId}`;
      expect((await history(theirs, memberCookie)).statusCode).toBe(404);
    });

    it('hides everything from someone you block, and stops direct messages both ways', async () => {
      const dm =
        architectId < memberId ? `dm:${architectId}:${memberId}` : `dm:${memberId}:${architectId}`;
      expect(
        (await put('/api/chat/block', memberCookie, { userId: architectId, blocked: true }))
          .statusCode,
      ).toBe(200);
      await say(architect, `space:${spaceId}`, 'Can you hear me?');
      await caughtUp(member);
      expect(got(member, 'Can you hear me?')).toBe(false);
      const seen = (await history(`space:${spaceId}`, memberCookie)).json().messages;
      expect(seen.some((m: { senderId: string }) => m.senderId === architectId)).toBe(false);
      expect((await say(architect, dm, 'hello')).error).toMatch(/can't message/);
      expect((await say(member, dm, 'hello')).error).toMatch(/can't message/);
      await put('/api/chat/block', memberCookie, { userId: architectId, blocked: false });
      expect((await say(architect, dm, 'Hello again')).t).toBe('ack');
    });

    it('lets Architects turn voice chat off, which ends it straight away', async () => {
      const ticket = async () =>
        (
          await app.inject({
            method: 'POST',
            url: `/api/spaces/${spaceId}/realtime-ticket`,
            headers: { cookie: memberCookie, origin: ORIGIN },
            payload: {},
          })
        ).json();
      const graph = async () =>
        (
          await app.inject({
            method: 'GET',
            url: `/internal/spaces/${spaceId}/graph`,
            headers: { 'x-realtime-secret': realtimeSecret },
          })
        ).json();
      expect((await ticket()).voice).toBe(true);
      expect((await graph()).voice).toBe(true);
      const settingsUrl = `/api/groups/${groupId}/chat-settings`;
      const settings = (
        await app.inject({ method: 'GET', url: settingsUrl, headers: { cookie: architectCookie } })
      ).json();
      expect(settings).toMatchObject({ voice: true, voiceAvailable: true });
      // Only Architects decide.
      expect(
        (await put(settingsUrl, memberCookie, { retentionDays: 90, voice: false })).statusCode,
      ).toBe(403);
      announced.length = 0;
      expect(
        (
          await put(settingsUrl, architectCookie, {
            retentionDays: settings.retentionDays,
            voice: false,
          })
        ).statusCode,
      ).toBe(200);
      // The real-time service is told at once (it takes everyone out of voice rooms).
      expect(announced).toContain(spaceId);
      expect((await ticket()).voice).toBe(false);
      expect((await graph()).voice).toBe(false);
      await put(settingsUrl, architectCookie, {
        retentionDays: settings.retentionDays,
        voice: true,
      });
      expect((await ticket()).voice).toBe(true);
    });

    it('lets people report a message to the Architects', async () => {
      const sent = await say(member, `space:${spaceId}`, 'Something unkind');
      const report = await app.inject({
        method: 'POST',
        url: '/api/chat/report',
        headers: { cookie: architectCookie },
        payload: { messageId: sent.message?.id, reason: 'Unkind' },
      });
      expect(report.statusCode).toBe(200);
      const denied = await app.inject({
        method: 'GET',
        url: `/api/groups/${groupId}/chat-reports`,
        headers: { cookie: memberCookie },
      });
      expect(denied.statusCode).toBe(403);
      const list = await app.inject({
        method: 'GET',
        url: `/api/groups/${groupId}/chat-reports`,
        headers: { cookie: architectCookie },
      });
      const [first] = list.json().reports;
      expect(first).toMatchObject({ body: 'Something unkind', reason: 'Unkind' });
      const resolved = await app.inject({
        method: 'POST',
        url: `/api/chat/reports/${first.id}/resolve`,
        headers: { cookie: architectCookie },
      });
      expect(resolved.statusCode).toBe(200);
    });

    it('shares Do Not Disturb with the group', async () => {
      await put('/api/chat/dnd', memberCookie, { dnd: true });
      await until(() =>
        architect.messages.some((m) => m.t === 'dnd' && m.userId === memberId && m.dnd === true),
      );
      const state = await app.inject({
        method: 'GET',
        url: '/api/chat/state',
        headers: { cookie: architectCookie },
      });
      const people = state.json().people as { id: string; dnd: boolean }[];
      expect(people.find((p) => p.id === memberId)?.dnd).toBe(true);
      await put('/api/chat/dnd', memberCookie, { dnd: false });
    });

    it('deletes chat older than the group keeps it', async () => {
      expect(
        (await put(`/api/groups/${groupId}/chat-settings`, memberCookie, { retentionDays: 7 }))
          .statusCode,
      ).toBe(403);
      expect(
        (await put(`/api/groups/${groupId}/chat-settings`, architectCookie, { retentionDays: 7 }))
          .statusCode,
      ).toBe(200);
      const old = await say(member, `space:${spaceId}`, 'From long ago');
      await db
        .update(schema.chatMessages)
        .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
        .where(eq(schema.chatMessages.id, old.message?.id as string));
      expect(await deleteExpiredChat(db)).toBeGreaterThanOrEqual(1);
      const left = (await history(`space:${spaceId}`, memberCookie)).json().messages;
      expect(left.some((m: { body: string }) => m.body === 'From long ago')).toBe(false);
      expect(left.some((m: { body: string }) => m.body === 'Welcome, everyone!')).toBe(true);
    });
  });
});
