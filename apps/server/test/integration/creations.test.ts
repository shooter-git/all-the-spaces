// Creations: listing, the play origin, saved data, versions and builds.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, schema } from '@ats/db';
import { sha256 } from '@ats/qa';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runBuild } from '../../src/creations/builds.ts';
import { uploadSource } from '../../src/creations/sources.ts';
import { publishCreation } from '../../src/creations/store.ts';
import {
  addSampleSpace,
  adminUrl,
  cookieFrom,
  createTestApp,
  ORIGIN,
  seedGroup,
  type TestApp,
} from '../harness.ts';

describe.skipIf(!adminUrl)('server flows', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let db: Db;
  let storage: TestApp['storage'];
  let architectCookie = '';
  let memberCookie = '';
  let groupId = '';
  let spaceId = '';

  beforeAll(async () => {
    t = await createTestApp({ playAccessTtlMs: 100 });
    ({ app, db, storage } = t);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
  });

  afterAll(async () => {
    await t?.close();
  });

  const failInsertsInto = (table: string) => t.failInsertsInto(table);

  describe('creations', () => {
    const PLAY_HOST = 'play.test.localhost';
    let creationId = '';
    let hiddenId = '';
    const page = new TextEncoder().encode(
      '<!doctype html><script type="module" src="./main.js"></script>',
    );
    const script = new TextEncoder().encode('console.log("hello from a creation")');

    beforeAll(async () => {
      const [space] = await db
        .select({ groupId: schema.spaces.groupId })
        .from(schema.spaces)
        .where(eq(schema.spaces.id, spaceId));
      const make = (objectKey: string, title: string) =>
        publishCreation(db, storage, {
          groupId: space?.groupId as string,
          spaceId,
          objectKey,
          title,
          files: new Map([
            ['index.html', page],
            ['main.js', script],
          ]),
          sdkVersion: '0.1.0',
          protocolVersion: 1,
        });
      creationId = (await make('sofa', 'Sofa stories')).creationId;
      hiddenId = (await make('bath-vanity', 'Mirror game')).creationId;
    });

    const put = (url: string, cookie: string, payload: object) =>
      app.inject({ method: 'PUT', url, headers: { cookie }, payload });
    const open = (id: string, cookie: string) =>
      app.inject({
        method: 'POST',
        url: `/api/creations/${id}/open`,
        headers: { cookie },
        payload: {},
      });
    const playPath = (url: string) => new URL(url).pathname;

    it('lists the creations in rooms you can see', async () => {
      await put(`/api/spaces/${spaceId}/rooms/bath`, architectCookie, { visibility: 'hidden' });
      const list = async (cookie: string) =>
        (
          await app.inject({
            method: 'GET',
            url: `/api/spaces/${spaceId}/creations`,
            headers: { cookie },
          })
        )
          .json()
          .creations.map((c: { title: string }) => c.title);
      expect(await list(memberCookie)).toEqual(['Sofa stories']);
      expect((await list(architectCookie)).sort()).toEqual(['Mirror game', 'Sofa stories']);
      // Opening a creation in a hidden room: same answer as one that doesn't exist.
      expect((await open(hiddenId, memberCookie)).statusCode).toBe(404);
    });

    it('serves its files only on the play origin, sandboxed and pinned to itself', async () => {
      const res = await open(creationId, memberCookie);
      expect(res.statusCode).toBe(200);
      const { url, ticket } = res.json();
      expect(new URL(url).host).toBe(PLAY_HOST);
      expect(ticket).toBeTruthy();
      const path = playPath(url);
      const file = await app.inject({ method: 'GET', url: path, headers: { host: PLAY_HOST } });
      expect(file.statusCode).toBe(200);
      expect(file.payload).toContain('main.js');
      const csp = String(file.headers['content-security-policy']);
      expect(csp).toContain('sandbox allow-scripts allow-pointer-lock');
      expect(csp).not.toContain('allow-same-origin');
      expect(csp).toContain(`script-src http://${PLAY_HOST}${path.replace('index.html', '')} `);
      expect(csp).toContain("default-src 'none'");
      expect(file.headers['access-control-allow-origin']).toBe('*');
      // Never next to the app's cookies.
      const onApp = await app.inject({
        method: 'GET',
        url: path,
        headers: { host: 'app.test.localhost' },
      });
      expect(onApp.statusCode).toBe(404);
      // Only the files it was published with, and no tampered tokens.
      const other = await app.inject({
        method: 'GET',
        url: path.replace('index.html', 'secret.js'),
        headers: { host: PLAY_HOST },
      });
      expect(other.statusCode).toBe(404);
      const token = path.split('/')[2] as string;
      const forged = path.replace(token, `${token.slice(0, -2)}xx`);
      expect(
        (await app.inject({ method: 'GET', url: forged, headers: { host: PLAY_HOST } })).statusCode,
      ).toBe(404);
    });

    it('stops serving as soon as the room is hidden', async () => {
      await put(`/api/spaces/${spaceId}/rooms/bath`, architectCookie, { visibility: 'group' });
      const { url } = (await open(hiddenId, memberCookie)).json();
      await put(`/api/spaces/${spaceId}/rooms/bath`, architectCookie, { visibility: 'hidden' });
      // The play server re-checks access every playAccessTtlMs (2 s by default, short here).
      await vi.waitFor(
        async () => {
          const file = await app.inject({
            method: 'GET',
            url: playPath(url),
            headers: { host: PLAY_HOST },
          });
          expect(file.statusCode).toBe(404);
        },
        { timeout: 5_000, interval: 50 },
      );
      await put(`/api/spaces/${spaceId}/rooms/bath`, architectCookie, { visibility: 'group' });
    });

    it('saves personal and shared data, and refuses stale writes', async () => {
      const at = (scope: string, key: string) =>
        `/api/creations/${creationId}/data/${scope}/${key}`;
      const get = (url: string, cookie: string) =>
        app.inject({ method: 'GET', url, headers: { cookie } });
      // Personal: private to each person.
      expect(
        (
          await put(at('personal', 'page-1'), memberCookie, { value: { ink: 3 }, schemaVersion: 1 })
        ).json(),
      ).toEqual({ version: 1 });
      expect((await get(at('personal', 'page-1'), memberCookie)).json().value).toEqual({ ink: 3 });
      expect((await get(at('personal', 'page-1'), architectCookie)).json().value).toBeNull();
      // Shared: a write based on an old version is refused, not silently lost.
      await put(at('shared', 'board'), memberCookie, { value: [1], schemaVersion: 1 });
      await put(at('shared', 'board'), architectCookie, {
        value: [1, 2],
        schemaVersion: 1,
        basedOn: 1,
      });
      const stale = await put(at('shared', 'board'), memberCookie, {
        value: [1, 3],
        schemaVersion: 1,
        basedOn: 1,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe('stale');
      // An older build of the creation can't overwrite data a newer one has migrated.
      await put(at('shared', 'board'), architectCookie, {
        value: { cells: [1, 2] },
        schemaVersion: 2,
        basedOn: 2,
      });
      const old = await put(at('shared', 'board'), memberCookie, { value: [9], schemaVersion: 1 });
      expect(old.statusCode).toBe(409);
      // …and says so, so the app can offer to rejoin on the newer version.
      expect(old.json().code).toBe('outdated');
      expect((await get(at('shared', 'board'), memberCookie)).json()).toMatchObject({
        value: { cells: [1, 2] },
        schemaVersion: 2,
        version: 3,
      });
      // Hidden room: no reading or writing.
      await put(`/api/spaces/${spaceId}/rooms/bath`, architectCookie, { visibility: 'hidden' });
      const hiddenAt = `/api/creations/${hiddenId}/data/personal/x`;
      expect((await get(hiddenAt, memberCookie)).statusCode).toBe(404);
      expect((await put(hiddenAt, memberCookie, { value: 1, schemaVersion: 1 })).statusCode).toBe(
        404,
      );
      await put(`/api/spaces/${spaceId}/rooms/bath`, architectCookie, { visibility: 'group' });
    });

    it('limits how much each person can save in a creation, and how often', async () => {
      const at = (scope: string, key: string) =>
        `/api/creations/${creationId}/data/${scope}/${key}`;
      // Keys: the member already keeps one personal key here (page-1); 63 more fit.
      for (let i = 0; i < 63; i++) {
        const res = await put(at('personal', `k${i}`), memberCookie, {
          value: i,
          schemaVersion: 1,
        });
        expect(res.statusCode, `k${i}`).toBe(200);
      }
      const extra = await put(at('personal', 'one-more'), memberCookie, {
        value: 1,
        schemaVersion: 1,
      });
      expect(extra.statusCode).toBe(413);
      expect(extra.json()).toEqual({
        error: 'This creation already keeps as many separate things for you as it can (64).',
        code: 'too-big',
      });
      // Changing a key it already has still works; someone else's own keys aren't affected.
      expect(
        (await put(at('personal', 'k0'), memberCookie, { value: 'again', schemaVersion: 1 }))
          .statusCode,
      ).toBe(200);
      expect(
        (await put(at('personal', 'one-more'), architectCookie, { value: 1, schemaVersion: 1 }))
          .statusCode,
      ).toBe(200);

      // Bytes: 2 MiB per person, in shared data too (a shared key counts for whoever saved it).
      const big = 'x'.repeat(250_000);
      for (let i = 0; i < 8; i++) {
        const res = await put(at('shared', `big-${i}`), architectCookie, {
          value: big,
          schemaVersion: 1,
        });
        expect(res.statusCode, `big-${i}`).toBe(200);
      }
      const full = await put(at('shared', 'big-8'), architectCookie, {
        value: big,
        schemaVersion: 1,
      });
      expect(full.statusCode).toBe(413);
      expect(full.json()).toEqual({
        error: 'This creation already keeps as much for you as it can.',
        code: 'too-big',
      });
      expect(
        (await put(at('shared', 'big-8'), memberCookie, { value: big, schemaVersion: 1 }))
          .statusCode,
      ).toBe(200);

      // How often: 120 saves a minute for each signed-in session.
      const signIn = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'sam@example.test', password: 'another-long-password' }),
      });
      const session = cookieFrom(signIn.headers);
      for (let i = 0; i < 120; i++) {
        const res = await put(at('personal', 'k1'), session, { value: i, schemaVersion: 1 });
        expect(res.statusCode, `save ${i}`).toBe(200);
      }
      const tooOften = await put(at('personal', 'k1'), session, { value: 0, schemaVersion: 1 });
      expect(tooOften.statusCode).toBe(429);
      expect(tooOften.json().error).toBe(
        "That's a lot of saving at once. Wait a moment and it will work again.",
      );
      // Their other session isn't held up.
      expect(
        (await put(at('personal', 'k1'), memberCookie, { value: 1, schemaVersion: 1 })).statusCode,
      ).toBe(200);
    }, 60_000);

    it('keeps candidates to Architects, and makes a version live or goes back at once', async () => {
      const [space] = await db
        .select({ groupId: schema.spaces.groupId })
        .from(schema.spaces)
        .where(eq(schema.spaces.id, spaceId));
      const next = (status: 'candidate' | 'published', title: string, qaOk = true) =>
        publishCreation(db, storage, {
          creationId,
          groupId: space?.groupId as string,
          spaceId,
          objectKey: 'sofa',
          title,
          files: new Map([
            ['index.html', page],
            ['main.js', script],
          ]),
          sdkVersion: '0.1.0',
          protocolVersion: 1,
          status,
          qa: { ok: qaOk, failed: qaOk ? 0 : 1, warned: 0, thumbnail: null, summary: null },
        });
      const first = (await open(creationId, memberCookie)).json().creation;
      const candidate = await next('candidate', 'Sofa stories, retold');
      const openVersion = (cookie: string, versionId: string) =>
        app.inject({
          method: 'POST',
          url: `/api/creations/${creationId}/open`,
          headers: { cookie },
          payload: { versionId },
        });
      // Members still get the live version, and can't open the candidate.
      expect((await open(creationId, memberCookie)).json().creation.versionId).toBe(
        first.versionId,
      );
      expect((await openVersion(memberCookie, candidate.versionId)).statusCode).toBe(404);
      // Architects can try it: nothing it saves is kept.
      const tried = await openVersion(architectCookie, candidate.versionId);
      expect(tried.json()).toMatchObject({
        trial: true,
        creation: { versionId: candidate.versionId },
      });
      const file = await app.inject({
        method: 'GET',
        url: playPath(tried.json().url),
        headers: { host: PLAY_HOST },
      });
      expect(file.statusCode).toBe(200);

      const live = (versionId: string, cookie: string) =>
        app.inject({
          method: 'POST',
          url: `/api/creations/${creationId}/versions/${versionId}/live`,
          headers: { cookie },
          payload: {},
        });
      expect((await live(candidate.versionId, memberCookie)).statusCode).toBe(404);
      const started = Date.now();
      expect((await live(candidate.versionId, architectCookie)).statusCode).toBe(200);
      const now = (await open(creationId, memberCookie)).json().creation;
      expect(now).toMatchObject({ versionId: candidate.versionId, title: 'Sofa stories, retold' });
      // Going back: the very next open gets the earlier version (well within 5 seconds).
      expect((await live(first.versionId, architectCookie)).statusCode).toBe(200);
      expect((await open(creationId, memberCookie)).json().creation).toMatchObject({
        versionId: first.versionId,
        title: 'Sofa stories',
      });
      expect(Date.now() - started).toBeLessThan(5000);
      // A version that failed its checks can't go live.
      const failed = await next('candidate', 'Broken', false);
      expect((await live(failed.versionId, architectCookie)).statusCode).toBe(409);
    });

    it('shows versions, builds and reports to Architects only', async () => {
      const studio = (cookie: string) =>
        app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/studio`, headers: { cookie } });
      expect((await studio(memberCookie)).statusCode).toBe(404);
      const res = await studio(architectCookie);
      expect(res.statusCode).toBe(200);
      const sofa = res.json().creations.find((c: { id: string }) => c.id === creationId);
      expect(sofa.versions.map((v: { number: number }) => v.number)).toEqual([3, 2, 1]);
      expect(sofa.versions.find((v: { live: boolean }) => v.live).number).toBe(1);
    });

    it('refuses a build whose source holds a secret, and keeps the report', async () => {
      const [space] = await db
        .select({ groupId: schema.spaces.groupId })
        .from(schema.spaces)
        .where(eq(schema.spaces.id, spaceId));
      const groupId = space?.groupId as string;
      const files = new Map<string, Uint8Array>([
        ['ats.json', new TextEncoder().encode('{"title":"Leaky"}')],
        ['index.html', page],
        ['main.js', new TextEncoder().encode(`const key = "sk-ant-${'x'.repeat(30)}";`)],
      ]);
      const snapshot = {
        hash: 'test-leaky',
        bytes: 0,
        files: [...files].map(([path, data]) => ({
          path,
          bytes: data.byteLength,
          sha256: sha256(data),
        })),
      };
      await uploadSource(storage, groupId, snapshot, files);
      const [build] = await db
        .insert(schema.builds)
        .values({ groupId, spaceId, objectKey: 'rug', sourceHash: snapshot.hash })
        .returning();
      await runBuild(db, storage, build?.id as string);
      const [done] = await db
        .select()
        .from(schema.builds)
        .where(eq(schema.builds.id, build?.id as string));
      expect(done).toMatchObject({ status: 'failed', versionId: null });
      const report = await app.inject({
        method: 'GET',
        url: `/api/builds/${build?.id}/report/report.json`,
        headers: { cookie: architectCookie },
      });
      expect(report.json().checks[0]).toMatchObject({ id: 'secrets', status: 'fail' });
      expect(report.payload).not.toContain('sk-ant-');
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/builds/${build?.id}/report/report.json`,
            headers: { cookie: memberCookie },
          })
        ).statusCode,
      ).toBe(404);
    });
    it('publishes a new creation whole or not at all', async () => {
      const [space] = await db
        .select({ groupId: schema.spaces.groupId })
        .from(schema.spaces)
        .where(eq(schema.spaces.id, spaceId));
      const input = (title: string) => ({
        groupId: space?.groupId as string,
        spaceId,
        objectKey: null,
        title,
        files: new Map([
          ['index.html', page],
          ['main.js', script],
        ]),
        sdkVersion: '0.1.0',
        protocolVersion: 1,
      });
      const named = (title: string) =>
        db.select().from(schema.creations).where(eq(schema.creations.title, title));
      // Its files can't be stored: no creation is left behind.
      const down = {
        ...storage,
        put: async () => {
          throw new Error('The bucket is down');
        },
      };
      await expect(publishCreation(db, down, input('Upload fails'))).rejects.toThrow(
        'The bucket is down',
      );
      expect(await named('Upload fails')).toEqual([]);
      // Its first version can't be written: the creation goes with it.
      const undo = await failInsertsInto('creation_versions');
      try {
        await expect(publishCreation(db, storage, input('Version fails'))).rejects.toThrow();
      } finally {
        await undo();
      }
      expect(await named('Version fails')).toEqual([]);
      // And once nothing fails, it's published.
      const { creationId: made } = await publishCreation(db, storage, input('Nothing fails'));
      const [row] = await named('Nothing fails');
      expect(row).toMatchObject({ id: made });
      expect(row?.currentVersionId).toBeTruthy();
      await db.delete(schema.creationVersions).where(eq(schema.creationVersions.creationId, made));
      await db.delete(schema.creations).where(eq(schema.creations.id, made));
    });
  });
});
