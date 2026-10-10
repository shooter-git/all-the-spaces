// Moving places and creations between servers.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uploadSource } from '../../src/creations/sources.ts';
import { publishCreation } from '../../src/creations/store.ts';
import { sourceKey, storeSources } from '../../src/place-sources.ts';
import {
  addSampleSpace,
  adminUrl,
  createTestApp,
  ORIGIN,
  pyramidGlb,
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
    t = await createTestApp();
    ({ app, db, storage } = t);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('moving places and creations between servers', () => {
    const get = (url: string, cookie: string) =>
      app.inject({ method: 'GET', url, headers: { cookie } });
    const upload = (url: string, cookie: string, body: Uint8Array) =>
      app.inject({
        method: 'POST',
        url,
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/zip' },
        payload: Buffer.from(body),
      });
    const unzip = async (body: Buffer) => (await import('fflate')).unzipSync(new Uint8Array(body));
    const zip = async (files: Record<string, Uint8Array>) =>
      (await import('fflate')).zipSync(files);
    let exported: Buffer = Buffer.alloc(0);

    it('exports a place as one file: its model and plan, nothing about people', async () => {
      expect((await get(`/api/spaces/${spaceId}/export`, memberCookie)).statusCode).toBe(404);
      const res = await get(`/api/spaces/${spaceId}/export`, architectCookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename=".+\.atspace"/);
      exported = res.rawPayload;
      const files = await unzip(exported);
      const place = JSON.parse(new TextDecoder().decode(files['place.json']));
      expect(place).toMatchObject({ format: 'all-the-spaces/place', version: 1 });
      const manifest = (await get(`/api/spaces/${spaceId}/manifest`, architectCookie)).json();
      const { manifestFiles } = await import('@ats/space-format');
      const needed = [...manifestFiles(manifest)];
      expect(needed.every((p) => files[`files/${p}`])).toBe(true);
      // Nothing but the description and the model's files.
      expect(Object.keys(files).filter((n) => !n.startsWith('files/'))).toEqual(['place.json']);
    });

    let imported = '';
    it('imports a place as a new one, every room private to Architects', async () => {
      const url = `/api/groups/${groupId}/places/import`;
      expect((await upload(url, memberCookie, exported)).statusCode).toBe(404);
      const res = await upload(url, architectCookie, exported);
      expect(res.statusCode).toBe(200);
      imported = res.json().spaceId;
      expect(imported).not.toBe(spaceId);
      expect(res.json().name).toMatch(/\(\d\)$/); // the same name is already taken
      const original = (await get(`/api/spaces/${spaceId}/manifest`, architectCookie)).json();
      const copy = (await get(`/api/spaces/${imported}/manifest`, architectCookie)).json();
      expect(copy.rooms.map((r: { key: string }) => r.key)).toEqual(
        original.rooms.map((r: { key: string }) => r.key),
      );
      const path = original.rooms[0].lods.lod0.path;
      const a = await get(`/api/spaces/${spaceId}/${path}`, architectCookie);
      const b = await get(`/api/spaces/${imported}/${path}`, architectCookie);
      expect(b.statusCode).toBe(200);
      expect(Buffer.compare(a.rawPayload, b.rawPayload)).toBe(0);
      // Nobody else sees anything until the Architect shares it.
      expect((await get(`/api/spaces/${imported}/manifest`, memberCookie)).statusCode).toBe(403);
      const [version] = await db
        .select()
        .from(schema.spaceVersions)
        .where(eq(schema.spaceVersions.spaceId, imported));
      expect(version?.plan).not.toBeNull(); // so it can be changed later
    });

    it('refuses damaged, incomplete or unrelated files', async () => {
      const url = `/api/groups/${groupId}/places/import`;
      const files = await unzip(exported);
      const first = Object.keys(files).find((n) => n.startsWith('files/')) as string;
      const tampered = { ...files, [first]: new Uint8Array([...(files[first] as Uint8Array), 1]) };
      const damaged = await upload(url, architectCookie, await zip(tampered));
      expect(damaged.statusCode).toBe(422);
      expect(damaged.json().error).toMatch(/damaged/);
      const { [first]: _, ...missing } = files;
      expect((await upload(url, architectCookie, await zip(missing))).json().error).toMatch(
        /missing/,
      );
      expect(
        (await upload(url, architectCookie, new TextEncoder().encode('hello'))).statusCode,
      ).toBe(422);
      const other = await zip({ 'place.json': new TextEncoder().encode('{"format":"x"}') });
      expect((await upload(url, architectCookie, other)).statusCode).toBe(422);
    });

    it('carries the models made for a place, so it can be changed on the new server', async () => {
      // The live version's own models, and the script that made one, kept when it was built.
      const [space] = await db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId));
      const script = new TextEncoder().encode('import ats_model as m\n');
      const sources = await storeSources(
        storage,
        spaceId,
        new Map([
          ['models/lamp.glb', new Uint8Array(pyramidGlb())],
          ['models/lamp.py', script],
        ]),
      );
      await db
        .update(schema.spaceVersions)
        .set({ sources })
        .where(eq(schema.spaceVersions.id, space?.currentVersionId as string));
      const res = await get(`/api/spaces/${spaceId}/export`, architectCookie);
      const files = await unzip(res.rawPayload);
      expect(JSON.parse(new TextDecoder().decode(files['place.json'])).sources).toEqual(sources);
      expect(files[`sources/${sources['models/lamp.py']}`]).toEqual(script);

      const url = `/api/groups/${groupId}/places/import`;
      const tampered = {
        ...files,
        [`sources/${sources['models/lamp.py']}`]: new TextEncoder().encode('import os\n'),
      };
      expect((await upload(url, architectCookie, await zip(tampered))).json().error).toMatch(
        /damaged/,
      );
      const { [`sources/${sources['models/lamp.glb']}`]: _, ...missing } = files;
      expect((await upload(url, architectCookie, await zip(missing))).json().error).toMatch(
        /missing/,
      );

      const copy = (await upload(url, architectCookie, res.rawPayload)).json().spaceId;
      const [version] = await db
        .select()
        .from(schema.spaceVersions)
        .where(eq(schema.spaceVersions.spaceId, copy));
      expect(version?.sources).toEqual(sources);
      expect(
        Buffer.from(await storage.getBytes(sourceKey(copy, sources['models/lamp.py'] as string))),
      ).toEqual(Buffer.from(script));
      // Changing it there starts with them.
      const calls = t.fake.supCalls.length;
      const ws = await app.inject({
        method: 'POST',
        url: `/api/spaces/${copy}/workspace`,
        headers: { cookie: architectCookie, origin: ORIGIN },
        payload: { provider: 'claude', description: 'A brighter lamp.' },
      });
      expect(ws.statusCode).toBe(200);
      const seeded = t.fake.supCalls.slice(calls).find((c) => c.act === 'workspace.init')?.body
        ?.files as Record<string, string>;
      expect(Buffer.from(seeded['models/lamp.glb'] as string, 'base64')).toEqual(pyramidGlb());
      expect(Buffer.from(seeded['models/lamp.py'] as string, 'base64').toString()).toBe(
        'import ats_model as m\n',
      );
    });

    let creationFile: Buffer = Buffer.alloc(0);
    let source = '';
    it('exports a creation with its source, and imports it onto the shelf', async () => {
      const { snapshotOf } = await import('@ats/qa');
      const code = new Map([
        ['src/main.ts', new TextEncoder().encode('console.log("a lamp that hums")')],
        ['ats.json', new TextEncoder().encode('{"title":"Humming lamp"}')],
      ]);
      const { snapshot, contents } = snapshotOf(code);
      await uploadSource(storage, groupId, snapshot, contents);
      source = snapshot.hash;
      const { creationId } = await publishCreation(db, storage, {
        groupId,
        spaceId,
        objectKey: null,
        title: 'Humming lamp',
        description: 'It hums when you come near.',
        files: new Map([
          ['index.html', new TextEncoder().encode('<!doctype html><p>hum</p>')],
          ['main.js', new TextEncoder().encode('console.log("hum")')],
        ]),
        sdkVersion: '0.1.0',
        protocolVersion: 1,
        sourceHash: snapshot.hash,
        credits: [{ path: 'main.js', license: 'own' }],
      });
      expect((await get(`/api/creations/${creationId}/export`, memberCookie)).statusCode).toBe(404);
      const res = await get(`/api/creations/${creationId}/export`, architectCookie);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/humming-lamp\.atcreation/);
      expect(res.headers['content-disposition']).toContain("UTF-8''Humming%20lamp.atcreation");
      creationFile = res.rawPayload;
      const files = await unzip(creationFile);
      expect(Object.keys(files).sort()).toEqual([
        'bundle/index.html',
        'bundle/main.js',
        'creation.json',
        'source/ats.json',
        'source/src/main.ts',
      ]);

      const url = `/api/spaces/${imported}/creations/import`;
      expect((await upload(url, memberCookie, creationFile)).statusCode).toBe(404);
      const done = await upload(url, architectCookie, creationFile);
      expect(done.statusCode).toBe(200);
      const [copy] = await db
        .select()
        .from(schema.creations)
        .where(eq(schema.creations.id, done.json().creationId));
      expect(copy).toMatchObject({ spaceId: imported, objectKey: null, title: 'Humming lamp' });
      const [version] = await db
        .select()
        .from(schema.creationVersions)
        .where(eq(schema.creationVersions.creationId, copy?.id as string));
      expect(version?.sourceHash).toBe(source); // can be improved here too
      // Live, but marked as never checked on this server; the Studio says so.
      expect(version?.qa).toMatchObject({ ok: false, failed: 0, unchecked: 'imported' });
      const live = await app.inject({
        method: 'POST',
        url: `/api/creations/${copy?.id}/versions/${version?.id}/live`,
        headers: { cookie: architectCookie },
      });
      expect(live.statusCode).toBe(200);
    });

    it('refuses a creation holding anything that looks like a secret, and stores nothing', async () => {
      const files = await unzip(creationFile);
      const url = `/api/spaces/${imported}/creations/import`;
      const count = async () => (await db.select().from(schema.creations)).length;
      const before = await count();
      const inSource = await upload(
        url,
        architectCookie,
        await zip({
          ...files,
          'source/src/keys.ts': new TextEncoder().encode(`const k = "sk-ant-${'x'.repeat(30)}";`),
        }),
      );
      expect(inSource.statusCode).toBe(422);
      expect(inSource.json().error).toMatch(/look like secrets/);
      expect(inSource.json().secrets).toEqual([
        { path: 'source/src/keys.ts', line: 1, kind: 'an Anthropic key or sign-in token' },
      ]);
      // Its bundle too: it wasn't built here, and it's what people get.
      const inBundle = await upload(
        url,
        architectCookie,
        await zip({
          ...files,
          // Built at runtime so the repository holds no key-shaped literal.
          'bundle/main.js': new TextEncoder().encode(
            `const id = "${'AKIA' + 'ABCDEFGHIJKLMNOP'}";`,
          ),
        }),
      );
      expect(inBundle.statusCode).toBe(422);
      expect(inBundle.json().secrets).toEqual([
        { path: 'bundle/main.js', line: 1, kind: 'an AWS access key' },
      ]);
      expect(await count()).toBe(before);
    });

    it('stops unpacking a file once it unpacks past 300 MB', async () => {
      const { Zip, ZipDeflate } = await import('fflate');
      const files = await unzip(creationFile);
      const parts: Uint8Array[] = [];
      const archive = new Zip((_err, data) => {
        parts.push(data);
      });
      for (const [name, bytes] of Object.entries(files)) {
        const entry = new ZipDeflate(name, { level: 1 });
        archive.add(entry);
        entry.push(bytes, true);
      }
      // About 300 KB that unpacks to 301 MB.
      const bomb = new ZipDeflate('bundle/sounds.bin', { level: 9 });
      archive.add(bomb);
      const mb = new Uint8Array(1024 * 1024);
      for (let i = 0; i < 301; i++) bomb.push(mb, i === 300);
      archive.end();
      const body = Buffer.concat(parts);
      expect(body.length).toBeLessThan(2 * 1024 * 1024);
      const res = await upload(`/api/spaces/${imported}/creations/import`, architectCookie, body);
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('That file unpacks too big.');
    }, 60_000);

    it('lets an imported place go again, until something is made in it', async () => {
      // A creation now lives in the first copy, so it stays.
      const kept = await app.inject({
        method: 'DELETE',
        url: `/api/spaces/${imported}`,
        headers: { cookie: architectCookie },
      });
      expect(kept.statusCode).toBe(409);
      const again = await upload(`/api/groups/${groupId}/places/import`, architectCookie, exported);
      const second = again.json().spaceId as string;
      const listed = (await get('/api/spaces', architectCookie))
        .json()
        .spaces.find((s: { id: string }) => s.id === second);
      expect(listed).toMatchObject({ imported: true, status: 'ready' });
      const gone = await app.inject({
        method: 'DELETE',
        url: `/api/spaces/${second}`,
        headers: { cookie: architectCookie },
      });
      expect(gone.statusCode).toBe(200);
      expect([...storage.objects.keys()].some((k) => k.includes(second))).toBe(false);
    });

    it('refuses a creation with a licence it can’t accept', async () => {
      const files = await unzip(creationFile);
      const d = JSON.parse(new TextDecoder().decode(files['creation.json']));
      d.credits = [{ path: 'main.js', license: 'GPL-3.0' }];
      const bad = await zip({
        ...files,
        'creation.json': new TextEncoder().encode(JSON.stringify(d)),
      });
      const res = await upload(`/api/spaces/${imported}/creations/import`, architectCookie, bad);
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/GPL-3\.0/);
    });
  });
});
