// Who sees which rooms of a space.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSampleSpace,
  adminUrl,
  createTestApp,
  type Fakes,
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

  describe('room privacy (leak check)', () => {
    const get = (url: string, cookie: string) =>
      app.inject({ method: 'GET', url, headers: { cookie } });
    const share = (roomKey: string, cookie: string, payload: object) =>
      app.inject({
        method: 'PUT',
        url: `/api/spaces/${spaceId}/rooms/${roomKey}`,
        headers: { cookie },
        payload,
      });
    type Manifest = {
      rooms: {
        key: string;
        name: string;
        files: string[];
        lods: Record<string, { path: string }>;
        collision: { path: string };
        doorways: { to?: string; closed?: boolean }[];
      }[];
    };
    let full: Manifest;
    let bath: Manifest['rooms'][number];
    /** Every path only the bathroom uses. */
    let bathOnly: string[] = [];
    let memberId = '';

    beforeAll(async () => {
      full = (await get(`/api/spaces/${spaceId}/manifest`, architectCookie)).json();
      bath = full.rooms.find((r) => r.key === 'bath') as Manifest['rooms'][number];
      const others = new Set(full.rooms.filter((r) => r !== bath).flatMap((r) => r.files));
      bathOnly = [
        ...Object.values(bath.lods).map((l) => l.path),
        bath.collision.path,
        ...bath.files.filter((f) => !others.has(f)),
      ];
      memberId = (await get('/api/me', memberCookie)).json().user.id;
    });

    it('starts with every room of a sample shared with the group', async () => {
      const rooms = (await get(`/api/spaces/${spaceId}/rooms`, architectCookie)).json().rooms;
      expect(rooms.every((r: { visibility: string }) => r.visibility === 'group')).toBe(true);
      const member = (await get(`/api/spaces/${spaceId}/manifest`, memberCookie)).json();
      expect(member.rooms.length).toBe(full.rooms.length);
    });

    it('only lets Architects see or change who sees what', async () => {
      expect((await get(`/api/spaces/${spaceId}/rooms`, memberCookie)).statusCode).toBe(403);
      expect((await share('bath', memberCookie, { visibility: 'hidden' })).statusCode).toBe(403);
      expect((await share('nowhere', architectCookie, { visibility: 'hidden' })).statusCode).toBe(
        404,
      );
      const stranger = await share('bath', architectCookie, {
        visibility: 'limited',
        people: ['someone-not-in-the-group'],
      });
      expect(stranger.statusCode).toBe(400);
    });

    it('sends nothing about a hidden room to a member', async () => {
      announced.length = 0;
      expect((await share('bath', architectCookie, { visibility: 'hidden' })).statusCode).toBe(200);
      expect(announced).toEqual([spaceId]);

      const res = await get(`/api/spaces/${spaceId}/manifest`, memberCookie);
      expect(res.statusCode).toBe(200);
      const json = res.payload;
      expect(json).not.toContain('"bath"');
      expect(json).not.toContain(bath.name);
      for (const path of bathOnly) expect(json).not.toContain(path);
      // The hall's door to it is shown closed, with nothing saying where it leads.
      const hall = (JSON.parse(json) as Manifest).rooms.find((r) => r.key === 'hall');
      const closed = hall?.doorways.filter((d) => d.closed) ?? [];
      expect(closed.length).toBe(1);
      expect(closed[0]?.to).toBeUndefined();

      // Not one byte of its files, even when asked for directly.
      for (const path of bathOnly) {
        const file = await get(`/api/spaces/${spaceId}/${path}`, memberCookie);
        expect(file.statusCode).toBe(404);
        expect(file.payload).not.toContain('gltf');
      }
      // Architects still see everything.
      const own = await get(`/api/spaces/${spaceId}/${bath.lods.lod0?.path}`, architectCookie);
      expect(own.statusCode).toBe(200);
      // Its card on the home page neither draws nor counts it.
      const card = async (cookie: string) =>
        (await get('/api/spaces', cookie))
          .json()
          .spaces.find((s: { id: string }) => s.id === spaceId).sketch;
      const seen = await card(memberCookie);
      expect(seen.rooms).toBe(full.rooms.length - 1);
      expect(seen.ground.length).toBe(full.rooms.length - 1);
      expect((await card(architectCookie)).rooms).toBe(full.rooms.length);
    });

    it('tells the real-time service who may see it', async () => {
      const graph = await app.inject({
        method: 'GET',
        url: `/internal/spaces/${spaceId}/graph`,
        headers: { 'x-realtime-secret': realtimeSecret },
      });
      expect(graph.json().access.rooms.bath).toEqual({ visibility: 'hidden', users: [] });
      const wrong = await app.inject({
        method: 'GET',
        url: `/internal/spaces/${spaceId}/graph`,
        headers: { 'x-realtime-secret': 'x'.repeat(64) },
      });
      expect(wrong.statusCode).toBe(404);
    });

    it('shares a room with chosen people only', async () => {
      const res = await share('bath', architectCookie, {
        visibility: 'limited',
        people: [memberId],
      });
      expect(res.statusCode).toBe(200);
      const member = (await get(`/api/spaces/${spaceId}/manifest`, memberCookie)).json();
      expect(member.rooms.some((r: { key: string }) => r.key === 'bath')).toBe(true);
      const file = await get(`/api/spaces/${spaceId}/${bath.lods.lod0?.path}`, memberCookie);
      expect(file.statusCode).toBe(200);
    });

    it('explains when nothing has been shared yet', async () => {
      for (const r of full.rooms) await share(r.key, architectCookie, { visibility: 'hidden' });
      const res = await get(`/api/spaces/${spaceId}/manifest`, memberCookie);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/shared with you/);
      for (const r of full.rooms) await share(r.key, architectCookie, { visibility: 'group' });
    });

    it('records every change in the audit log', async () => {
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'room.visibility_changed'));
      expect(rows.length).toBeGreaterThanOrEqual(2 + 2 * full.rooms.length);
      expect(rows.every((r) => r.target?.startsWith(`${spaceId}/`))).toBe(true);
    });
  });
});
