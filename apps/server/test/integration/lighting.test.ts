// Baking a place's lighting while the server builds it: in the workbench through the supervisor,
// with Blender here when there's no supervisor, or not at all (and the report says why).
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { schema } from '@ats/db';
import type { SpaceManifest } from '@ats/space-format';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addSampleSpace, adminUrl, createTestApp, seedGroup, type TestApp } from '../harness.ts';

// Tiny lightmaps: the fake bake job's output is the size asked for.
const settings = { ATS_BAKE: '1', ATS_BAKE_RES: 8, ATS_BAKE_SAMPLES: 1 };

/** Two rooms off a hall, with a table in the kitchen (`extra` adds furniture). */
const plan = (extra: object[] = []) => ({
  name: 'Our flat',
  spaceType: 'apartment',
  floors: [{ key: 'f1', name: 'Flat', elevation: 0 }],
  rooms: [
    { key: 'hall', name: 'Hall', floor: 'f1', rect: [0, 0, 3, 3] },
    { key: 'kitchen', name: 'Kitchen', floor: 'f1', rect: [3, 0, 6, 3] },
  ],
  openings: [{ kind: 'door', rooms: ['hall', 'kitchen'], at: [3, 1.5], width: 0.9 }],
  furniture: [
    { key: 'table', room: 'kitchen', kind: 'table', label: 'Table', at: [4.5, 1.5] },
    ...extra,
  ],
  spawns: [{ key: 's', room: 'hall', at: [1.5, 1.5] }],
});

describe.skipIf(!adminUrl)('lighting bakes', () => {
  describe('on a server with a supervisor and no Blender of its own', () => {
    let t: TestApp;
    let cookie = '';
    let groupId = '';
    let placeId = '';
    let workspace = '';
    const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer) =>
      t.app.inject({
        method,
        url,
        headers: {
          cookie,
          ...(Buffer.isBuffer(payload) ? { 'content-type': 'image/png' } : {}),
        },
        ...(payload ? { payload } : {}),
      });
    const acts = (name: string) => t.fake.supCalls.filter((c) => c.act === name);
    /** Presses "Build it" and waits for the build; the review the Studio then shows. */
    const build = async (p: object) => {
      t.fake.workspacePlan = p;
      expect((await req('POST', `/api/workspaces/${workspace}/build-space`, {})).statusCode).toBe(
        200,
      );
      let review = (await req('GET', `/api/spaces/${placeId}/review`)).json();
      await vi.waitFor(
        async () => {
          review = (await req('GET', `/api/spaces/${placeId}/review`)).json();
          expect(review.building).toBe(false);
        },
        { timeout: 20_000, interval: 100 },
      );
      return review;
    };
    const candidateManifest = async (review: { candidate: { id: string } }) =>
      (
        await req('GET', `/api/spaces/${placeId}/versions/${review.candidate.id}/manifest`)
      ).json() as SpaceManifest;

    beforeAll(async () => {
      t = await createTestApp({ env: settings, blender: null });
      ({ architectCookie: cookie, groupId } = await seedGroup(t));
      placeId = (
        await req('POST', `/api/groups/${groupId}/places`, {
          name: 'Our flat',
          spaceType: 'apartment',
        })
      ).json().spaceId;
      const drawing = await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer();
      expect((await req('PUT', `/api/spaces/${placeId}/inputs/plan-1`, drawing)).statusCode).toBe(
        200,
      );
      workspace = (
        await req('POST', `/api/spaces/${placeId}/workspace`, {
          provider: 'claude',
          description: 'Two rooms.',
        })
      ).json().id;
    });
    afterAll(async () => {
      await t?.close();
    });

    it('bakes each room in the workbench as part of the build, and the review says so', async () => {
      const review = await build(plan());
      expect(review.failed).toBeNull();
      expect(review.candidate.lighting).toEqual({
        baked: true,
        rooms: 2,
        bakedRooms: 2,
        reused: 0,
        reason: null,
      });
      // One job for the build: the room inputs go in one at a time, then it's cleared away.
      expect(acts('bake.init')).toHaveLength(1);
      expect(acts('bake.room')).toHaveLength(2);
      expect(acts('bake.delete')).toHaveLength(1);
      const job = acts('bake.init')[0]?.claims.ws;
      expect(acts('bake.room').every((c) => c.claims.ws === job)).toBe(true);
      // The same settings the server would bake with itself.
      const input = JSON.parse(
        Buffer.from(String(acts('bake.room')[0]?.body?.input), 'base64').toString('utf8'),
      );
      expect(input).toMatchObject({ resolution: 8, samples: 1, hdri: null });
      const manifest = await candidateManifest(review);
      for (const room of manifest.rooms) expect(room.lightmap).toBeDefined();
    });

    it('bakes again only the rooms whose inputs changed', async () => {
      const before = acts('bake.room').length;
      const same = await build(plan());
      expect(acts('bake.room').length).toBe(before);
      expect(same.candidate.lighting).toMatchObject({ baked: true, bakedRooms: 2, reused: 2 });

      // A chair in the hall: the hall is baked again, the kitchen isn't.
      const chair = { key: 'chair', room: 'hall', kind: 'chair', label: 'Chair', at: [1, 1] };
      const changed = await build(plan([chair]));
      expect(acts('bake.room').length).toBe(before + 1);
      expect(changed.candidate.lighting).toMatchObject({ baked: true, bakedRooms: 2, reused: 1 });
    });

    it('publishes the build unbaked when the bake job fails, and the review says why', async () => {
      t.fake.bake = 'fail';
      const lamp = { key: 'lamp', room: 'kitchen', kind: 'lamp', label: 'Lamp', at: [5, 2] };
      const review = await build(plan([lamp]));
      t.fake.bake = 'ok';
      // The build itself worked: a candidate to walk through, its kitchen lit in real time.
      expect(review.failed).toBeNull();
      expect(review.candidate.lighting).toEqual({
        baked: false,
        rooms: 2,
        bakedRooms: 1,
        reused: 1,
        reason: 'the bake job failed: TypeError: something broke',
      });
      const manifest = await candidateManifest(review);
      expect(manifest.rooms.find((r) => r.key === 'kitchen')?.lightmap).toBeUndefined();
      expect(manifest.rooms.find((r) => r.key === 'hall')?.lightmap).toBeDefined();
    });

    it('says so when a room takes longer than a bake job may', async () => {
      t.fake.bake = 'timeout';
      const rug = { key: 'rug', room: 'hall', kind: 'rug', label: 'Rug', at: [1.5, 2] };
      const review = await build(plan([rug]));
      t.fake.bake = 'ok';
      expect(review.failed).toBeNull();
      expect(review.candidate.lighting).toMatchObject({
        baked: false,
        reason: 'the bake job timed out after 30 minutes',
      });
    });

    it('clears away a bake job or a check step left behind by a build that stopped', async () => {
      const { studioTick } = await import('../../src/studio/timeouts.ts');
      const now = Date.now() / 1000;
      const bake = (job: string, age: number, slot = 0) => ({
        Names: [`/ats-bake-${job}-run-${slot}`],
        Labels: { 'io.allthespaces.role': 'bake' },
        Created: now - age,
      });
      // A creation's check step is cleared the same way (the server stopped waiting on it).
      const step = (job: string, age: number) => ({
        Names: [`/ats-step-${job}-finish`],
        Labels: { 'io.allthespaces.role': 'step-finish' },
        Created: now - age,
      });
      // Rooms bake side by side: a stopped build can leave a container in each of its slots.
      const before = acts('bake.delete').length;
      t.fake.containers = [
        bake('bake-old', 3 * 3600, 0),
        bake('bake-old', 3 * 3600, 1),
        bake('bake-old', 3 * 3600, 2),
        bake('bake-older', 5 * 3600, 3),
        bake('bake-current', 600, 0),
        bake('bake-current', 600, 1),
        step('build-old', 3 * 3600),
        step('build-current', 600),
      ];
      await studioTick(t.db, t.supervisor);
      t.fake.containers = [];
      // Each job is cleared once (the supervisor removes every slot's container and volumes).
      expect(
        acts('bake.delete')
          .slice(before)
          .map((c) => c.claims.ws),
      ).toEqual(['bake-old', 'bake-older']);
      expect(acts('job.delete').map((c) => c.claims.ws)).toEqual(['build-old']);
    });

    it('bakes a sample place the same way, and its versions say so', async () => {
      const spaceId = await addSampleSpace(t, cookie, groupId);
      const { versions } = (await req('GET', `/api/spaces/${spaceId}/versions`)).json();
      expect(versions[0].lighting).toMatchObject({ baked: true, reason: null });
      expect(versions[0].lighting.rooms).toBeGreaterThan(0);
    });
  });

  describe('on a server with neither a supervisor nor Blender', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp({ plain: true, env: settings, blender: null });
    });
    afterAll(async () => {
      await t?.close();
    });

    it('builds the place with real-time lighting, and its version says why', async () => {
      const { architectCookie, groupId } = await seedGroup(t);
      const spaceId = await addSampleSpace(t, architectCookie, groupId);
      const [version] = await t.db
        .select({
          lighting: schema.spaceVersions.lighting,
          manifest: schema.spaceVersions.manifest,
        })
        .from(schema.spaceVersions)
        .where(eq(schema.spaceVersions.spaceId, spaceId));
      expect(version?.lighting).toMatchObject({
        baked: false,
        bakedRooms: 0,
        reason: "there's no supervisor to bake it in, and no Blender on this server",
      });
      expect(version?.manifest.rooms.some((r) => r.lightmap)).toBe(false);
    });
  });
});
