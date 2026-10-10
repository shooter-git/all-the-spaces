// How smoothly things run: performance samples.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, deleteOldPerfSamples, schema } from '@ats/db';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addSampleSpace, adminUrl, createTestApp, seedGroup, type TestApp } from '../harness.ts';

describe.skipIf(!adminUrl)('server flows', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let db: Db;
  let architectCookie = '';
  let memberCookie = '';
  let groupId = '';
  let spaceId = '';

  beforeAll(async () => {
    t = await createTestApp();
    ({ app, db } = t);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
  });

  afterAll(async () => {
    await t?.close();
  });

  const signUpOutsider = () => t.signUpOutsider(architectCookie, groupId);

  describe('how smoothly things run', () => {
    const req = (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) =>
      app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
    const sample = {
      kind: 'space',
      tier: 'mid',
      device: 'phone-ios-6c',
      fps: 58,
      p50Ms: 16.7,
      p95Ms: 21,
      scale: 1,
    };
    const post = (cookie: string, body: object) => req('POST', '/api/perf', cookie, body);

    it('takes anonymous samples from people in the group, a few times a minute at most', async () => {
      expect(
        (await post(memberCookie, { ...sample, spaceId, device: 'iPhone 15 Pro' })).statusCode,
      ).toBe(400);
      expect((await post(await signUpOutsider(), { ...sample, spaceId })).statusCode).toBe(404);
      expect((await post(memberCookie, { ...sample, spaceId })).statusCode).toBe(200);
      expect((await post(memberCookie, { ...sample, spaceId })).statusCode).toBe(429);
      const rows = await db
        .select()
        .from(schema.perfSamples)
        .where(eq(schema.perfSamples.spaceId, spaceId));
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0] ?? {})).not.toContain('userId');
      // The middle tier is 'mid' everywhere; rows keep the word they were first stored with.
      expect(rows[0]?.tier).toBe('mid');
      const stored = await db.execute<{ tier: string }>(
        sql`select tier from perf_samples where space_id = ${spaceId}`,
      );
      expect(stored.map((r) => r.tier)).toEqual(['medium']);
      // A creation sample must name a version of a creation in that space.
      expect(
        (
          await post(architectCookie, {
            ...sample,
            kind: 'creation',
            spaceId,
            creationVersionId: '00000000-0000-4000-8000-000000000000',
          })
        ).statusCode,
      ).toBe(404);
    });

    it('starts each kind of device at a quality that has run smoothly on it', async () => {
      const [space] = await db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId));
      const add = (device: string, tier: 'low' | 'mid' | 'high', p95Ms: number, n = 6) =>
        db.insert(schema.perfSamples).values(
          Array.from({ length: n }, () => ({
            groupId: space?.groupId as string,
            spaceId,
            kind: 'space' as const,
            tier,
            device,
            fps: 1000 / p95Ms,
            p50Ms: p95Ms / 1.5,
            p95Ms,
            scale: 1,
          })),
        );
      const advice = async (device: string) =>
        (await req('GET', `/api/perf/advice?device=${device}`, memberCookie)).json();
      expect((await advice('tablet-android-8c')).tier).toBeNull(); // nothing to go on yet
      await add('phone-android-4c', 'mid', 48); // struggles
      expect((await advice('phone-android-4c')).tier).toBe('low');
      await add('laptop-mac-8c', 'mid', 17);
      await add('laptop-mac-8c', 'high', 19);
      expect((await advice('laptop-mac-8c')).tier).toBe('high');
      await add('laptop-windows-4c', 'mid', 18);
      await add('laptop-windows-4c', 'high', 45);
      expect((await advice('laptop-windows-4c')).tier).toBe('mid');
    });

    it('shows Architects how their place runs, and no one else', async () => {
      expect((await req('GET', `/api/spaces/${spaceId}/perf`, memberCookie)).statusCode).toBe(404);
      const res = await req('GET', `/api/spaces/${spaceId}/perf`, architectCookie);
      expect(res.statusCode).toBe(200);
      const row = res
        .json()
        .space.find(
          (r: { device: string; tier: string }) =>
            r.device === 'laptop-mac-8c' && r.tier === 'high',
        );
      expect(row).toMatchObject({ samples: 6, p95Ms: 19 });
      // Old samples go after 90 days.
      await db
        .update(schema.perfSamples)
        .set({ createdAt: new Date(Date.now() - 91 * 86_400_000) })
        .where(eq(schema.perfSamples.device, 'laptop-mac-8c'));
      expect(await deleteOldPerfSamples(db)).toBe(12);
    });
  });
});
