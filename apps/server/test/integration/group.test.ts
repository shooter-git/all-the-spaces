// Running the group: people, roles, activity and sessions.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSampleSpace,
  adminUrl,
  cookieFrom,
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
  let removals: Fakes['removals'];
  let architectCookie = '';
  let memberCookie = '';
  let groupId = '';
  let spaceId = '';

  beforeAll(async () => {
    t = await createTestApp();
    ({ app, db, realtimeSecret } = t);
    ({ announced, removals } = t.fake);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
  });

  afterAll(async () => {
    await t?.close();
  });

  const signUp = (email: string, invite?: string) => t.signUp(email, invite);

  describe('running the group', () => {
    const req = (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: string,
      cookie: string,
      payload?: object,
    ) =>
      app.inject({
        method,
        url,
        headers: { cookie, origin: ORIGIN },
        ...(payload ? { payload } : {}),
      });
    let robinCookie = '';
    let robinId = '';
    let patId = '';

    beforeAll(async () => {
      const inv = await req('POST', `/api/groups/${groupId}/invite-links`, architectCookie, {});
      const invite = new URL(inv.json().url).hash.slice(1);
      robinCookie = cookieFrom((await signUp('robin@example.test', invite)).headers);
      await req('POST', '/api/invites/accept', robinCookie, { token: invite });
      robinId = (await req('GET', '/api/me', robinCookie)).json().user.id;
      patId = (await req('GET', '/api/me', architectCookie)).json().user.id;
    });

    it('shows Architects who is in the group, and no one else', async () => {
      expect((await req('GET', `/api/groups/${groupId}/people`, memberCookie)).statusCode).toBe(
        403,
      );
      const people = (await req('GET', `/api/groups/${groupId}/people`, architectCookie)).json()
        .people as { userId: string; email: string; role: string; you: boolean }[];
      expect(people.find((p) => p.you)).toMatchObject({ userId: patId, role: 'architect' });
      expect(people.find((p) => p.userId === robinId)).toMatchObject({
        email: 'robin@example.test',
        role: 'member',
        you: false,
      });
    });

    it('changes roles, but never leaves a group without an Architect', async () => {
      const role = (id: string, r: string, cookie = architectCookie) =>
        req('PUT', `/api/groups/${groupId}/people/${id}`, cookie, { role: r });
      expect((await role(robinId, 'architect', memberCookie)).statusCode).toBe(403);
      expect((await role(patId, 'member')).statusCode).toBe(409);
      expect((await role(robinId, 'architect')).statusCode).toBe(200);
      expect((await req('GET', '/api/me', robinCookie)).json().groups[0].role).toBe('architect');
      expect(announced).toContain(spaceId);
      expect((await role(robinId, 'member')).statusCode).toBe(200);
    });

    it('removes someone: out of the group, the rooms shared with them, and the space', async () => {
      const shared = await req('PUT', `/api/spaces/${spaceId}/rooms/bath`, architectCookie, {
        visibility: 'limited',
        people: [robinId],
      });
      expect(shared.statusCode).toBe(200);
      const remove = (id: string, cookie = architectCookie) =>
        req('DELETE', `/api/groups/${groupId}/people/${id}`, cookie);
      expect((await remove(robinId, memberCookie)).statusCode).toBe(403);
      expect((await remove(patId)).statusCode).toBe(409); // not yourself
      announced.length = 0;
      expect((await remove(robinId)).statusCode).toBe(200);
      expect(announced).toContain(spaceId);
      // …and of any creation session they're in.
      expect(removals).toEqual([{ groupId, userId: robinId }]);
      expect((await req('GET', '/api/me', robinCookie)).json().groups).toEqual([]);
      expect((await req('GET', `/api/spaces/${spaceId}/manifest`, robinCookie)).statusCode).toBe(
        404,
      );
      const left = await db
        .select()
        .from(schema.roomAccess)
        .where(eq(schema.roomAccess.userId, robinId));
      expect(left).toEqual([]);
      // The real-time service learns who's in the group, to take them out of the space.
      const graph = await app.inject({
        method: 'GET',
        url: `/internal/spaces/${spaceId}/graph`,
        headers: { 'x-realtime-secret': realtimeSecret },
      });
      expect(graph.json().access.members).not.toContain(robinId);
      expect(graph.json().access.members).toContain(patId);
      expect((await remove(robinId)).statusCode).toBe(404);
    });

    it('renames the group', async () => {
      const rename = (name: string, cookie = architectCookie) =>
        req('PUT', `/api/groups/${groupId}`, cookie, { name, themeColor: '#CFD8C2' });
      expect((await rename('Somewhere else', memberCookie)).statusCode).toBe(403);
      expect((await rename('The Test House')).statusCode).toBe(200);
      const g = (await req('GET', '/api/me', memberCookie)).json().groups[0];
      expect(g).toMatchObject({ groupName: 'The Test House', themeColor: '#CFD8C2' });
      expect(
        (await req('PUT', `/api/groups/${groupId}`, architectCookie, { themeColor: 'red' }))
          .statusCode,
      ).toBe(400);
      await rename('Test House');
    });

    it('shows Architects what happened, newest first, in names', async () => {
      expect((await req('GET', `/api/groups/${groupId}/activity`, memberCookie)).statusCode).toBe(
        403,
      );
      const { entries, more } = (
        await req('GET', `/api/groups/${groupId}/activity`, architectCookie)
      ).json();
      expect(entries[0].action).toBe('group.changed');
      const removed = entries.find((e: { action: string }) => e.action === 'member.removed');
      expect(removed).toMatchObject({ actor: { name: 'Pat' }, details: { name: 'Visitor' } });
      const role = entries.find((e: { action: string }) => e.action === 'member.role_changed');
      expect(role.about).toBe('Visitor');
      // Housekeeping only when asked for; older entries a page at a time.
      const all = (
        await req('GET', `/api/groups/${groupId}/activity?all=1`, architectCookie)
      ).json();
      expect(all.entries.length).toBeGreaterThanOrEqual(entries.length);
      if (more) {
        const older = (
          await req(
            'GET',
            `/api/groups/${groupId}/activity?before=${encodeURIComponent(entries.at(-1).at)}`,
            architectCookie,
          )
        ).json();
        expect(new Date(older.entries[0].at) <= new Date(entries.at(-1).at)).toBe(true);
      }
    });

    it('describes the server to Architects', async () => {
      expect((await req('GET', '/api/server', memberCookie)).statusCode).toBe(403);
      const info = (await req('GET', '/api/server', architectCookie)).json();
      expect(info).toMatchObject({
        address: ORIGIN,
        backups: { schedule: 'nightly', offsite: false },
        features: { studio: true, voice: true, email: true },
      });
      expect(info.counts.people).toBeGreaterThanOrEqual(3);
    });

    it('lists where you are signed in, and signs other devices out', async () => {
      const again = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          'user-agent': 'Firefox/140',
        },
        payload: JSON.stringify({ email: 'robin@example.test', password: 'another-long-password' }),
      });
      const second = cookieFrom(again.headers);
      const { sessions } = (await req('GET', '/api/account/sessions', robinCookie)).json();
      expect(sessions.length).toBe(2);
      const here = sessions.find((s: { current: boolean }) => s.current);
      const there = sessions.find((s: { current: boolean }) => !s.current);
      expect(there.userAgent).toBe('Firefox/140');
      expect(
        (await req('DELETE', `/api/account/sessions/${here.id}`, robinCookie)).statusCode,
      ).toBe(409);
      // Someone else's sign-in isn't yours to end.
      await req('DELETE', `/api/account/sessions/${there.id}`, memberCookie);
      expect((await req('GET', '/api/me', second)).json().user).not.toBeNull();
      expect(
        (await req('DELETE', `/api/account/sessions/${there.id}`, robinCookie)).statusCode,
      ).toBe(200);
      expect((await req('GET', '/api/me', second)).json().user).toBeNull();
      expect((await req('GET', '/api/me', robinCookie)).json().user).not.toBeNull();
    });
  });
});
