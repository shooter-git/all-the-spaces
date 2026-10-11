// Onboarding a real place, and changing it once it is live.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { publishCreation } from '../../src/creations/store.ts';
import {
  addSampleSpace,
  addSofaCreation,
  adminUrl,
  createTestApp,
  type Fakes,
  pyramidGlb,
  seedGroup,
  type TestApp,
} from '../harness.ts';

describe.skipIf(!adminUrl)('server flows', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let db: Db;
  let storage: TestApp['storage'];
  let fake: Fakes;
  let supCalls: Fakes['supCalls'];
  let announced: Fakes['announced'];
  let workspaceFiles: Fakes['workspaceFiles'];
  let architectCookie = '';
  let memberCookie = '';
  let groupId = '';
  let spaceId = '';

  beforeAll(async () => {
    t = await createTestApp();
    ({ app, db, storage } = t);
    fake = t.fake;
    ({ supCalls, announced, workspaceFiles } = t.fake);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
    // As the creation tests leave it: the sample has a creation in it, so removing it is
    // refused.
    await addSofaCreation(t, groupId, spaceId);
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('onboarding a real place', () => {
    let placeId = '';
    let placeWorkspace = '';
    const req = (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: string,
      cookie: string,
      payload?: object | Buffer,
      headers: Record<string, string> = {},
    ) =>
      app.inject({ method, url, headers: { cookie, ...headers }, ...(payload ? { payload } : {}) });

    it('keeps a place being set up to Architects', async () => {
      const res = await req('POST', `/api/groups/${groupId}/places`, architectCookie, {
        name: 'Our flat',
        spaceType: 'apartment',
      });
      placeId = res.json().spaceId;
      const names = async (cookie: string) =>
        (await req('GET', '/api/spaces', cookie))
          .json()
          .spaces.map((s: { name: string; status: string }) => `${s.name}:${s.status}`);
      expect(await names(architectCookie)).toContain('Our flat:draft');
      expect((await names(memberCookie)).some((n: string) => n.startsWith('Our flat'))).toBe(false);
      // Walking through a draft: no creations in it yet (and nothing at all for a member).
      expect(
        (await req('GET', `/api/spaces/${placeId}/creations`, architectCookie)).json(),
      ).toEqual({
        creations: [],
      });
      expect((await req('GET', `/api/spaces/${placeId}/creations`, memberCookie)).statusCode).toBe(
        404,
      );
      expect(
        (
          await req('POST', `/api/groups/${groupId}/places`, memberCookie, {
            name: 'x',
            spaceType: 'house',
          })
        ).statusCode,
      ).toBe(404);
    });

    it('saves floor plans and photos upright, without location or camera details', async () => {
      const sharp = (await import('sharp')).default;
      // A sideways phone photo, with a location and a camera in it.
      const photo = await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#c9b28f' },
      })
        .withMetadata({ orientation: 6 })
        .withExifMerge({
          IFD0: { Make: 'PhoneCo', Model: 'Phone 12' },
          IFD3: {
            GPSLatitudeRef: 'N',
            GPSLatitude: '51/1 30/1 0/1',
            GPSLongitudeRef: 'W',
            GPSLongitude: '0/1 7/1 0/1',
          },
        })
        .jpeg()
        .toBuffer();
      expect((await sharp(photo).metadata()).exif).toBeDefined();
      const put = await req(
        'PUT',
        `/api/spaces/${placeId}/inputs/photo-1?note=the%20kitchen`,
        architectCookie,
        photo,
        {
          'content-type': 'image/jpeg',
        },
      );
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ width: 300, height: 400 }); // turned upright
      const stored = await req('GET', `/api/spaces/${placeId}/inputs/photo-1`, architectCookie);
      const meta = await sharp(stored.rawPayload).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      // Only Architects, and only pictures.
      expect(
        (await req('GET', `/api/spaces/${placeId}/inputs/photo-1`, memberCookie)).statusCode,
      ).toBe(404);
      expect(
        (
          await req('PUT', `/api/spaces/${placeId}/inputs/photo-2`, memberCookie, photo, {
            'content-type': 'image/jpeg',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await req(
            'PUT',
            `/api/spaces/${placeId}/inputs/photo-2`,
            architectCookie,
            Buffer.from('not a picture'),
            { 'content-type': 'image/png' },
          )
        ).statusCode,
      ).toBe(415);
    });

    it('starts a space workspace from its floor plan and photos', async () => {
      const start = () =>
        req('POST', `/api/spaces/${placeId}/workspace`, architectCookie, {
          provider: 'claude',
          description: 'Two bedrooms.',
        });
      const sharp = (await import('sharp')).default;
      const plan = await sharp({
        create: { width: 800, height: 600, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer();
      expect(
        (
          await req('PUT', `/api/spaces/${placeId}/inputs/plan-1`, architectCookie, plan, {
            'content-type': 'image/png',
          })
        ).statusCode,
      ).toBe(200);
      const res = await start();
      expect(res.statusCode).toBe(200);
      placeWorkspace = res.json().id;
      const files = Object.keys(
        supCalls.findLast((c) => c.act === 'workspace.init')?.body?.files as object,
      );
      expect(files).toEqual(
        expect.arrayContaining([
          'inputs/plan-1.jpg',
          'inputs/photo-1.jpg',
          'plan.json',
          'BRIEF.md',
          'CLAUDE.md',
          'AGENTS.md',
        ]),
      );
    });

    it('adds pictures to a place while it’s built: cleaned, kept with the place, path pasted', async () => {
      const sharp = (await import('sharp')).default;
      const photo = await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#a0b0c0' },
      })
        .withMetadata({ orientation: 6 })
        .withExifMerge({ IFD0: { Make: 'PhoneCo' } })
        .jpeg()
        .toBuffer();
      const add = (name: string, body: Buffer, type: string, cookie = architectCookie) =>
        req('PUT', `/api/workspaces/${placeWorkspace}/uploads/${name}`, cookie, body, {
          'content-type': type,
        });
      const res = await add('Kitchen%20Window%20(2).JPG', photo, 'image/jpeg');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        path: 'uploads/kitchen-window-2.jpg',
        typed: true,
        input: 'photo-2',
      });
      const written = supCalls.findLast((c) => c.act === 'workspace.upload')?.body as {
        name: string;
        data: string;
      };
      expect(written.name).toBe('kitchen-window-2.jpg');
      const meta = await sharp(Buffer.from(written.data, 'base64')).metadata();
      expect([meta.width, meta.height, meta.exif, meta.orientation]).toEqual([
        300,
        400,
        undefined,
        undefined,
      ]);
      // Its path is pasted, never sent (C9).
      expect(supCalls.findLast((c) => c.act === 'sandbox.paste')?.body).toEqual({
        text: '@uploads/kitchen-window-2.jpg ',
      });
      const inputs = (await req('GET', `/api/spaces/${placeId}/inputs`, architectCookie)).json()
        .inputs as { name: string; kind: string; note: string }[];
      expect(inputs.find((i) => i.name === 'photo-2')).toMatchObject({
        kind: 'photo',
        note: 'kitchen window 2',
      });
      // A page of a PDF plan comes as a picture, added as a plan.
      const page = await req(
        'PUT',
        `/api/workspaces/${placeWorkspace}/uploads/plans-page-1.png?as=plan`,
        architectCookie,
        await sharp(photo).png().toBuffer(),
        { 'content-type': 'image/png' },
      );
      expect(page.json()).toMatchObject({ path: 'uploads/plans-page-1.jpg', input: 'plan-2' });
      // Only pictures, and only the Architect whose workspace it is.
      expect((await add('notes.txt', Buffer.from('hi'), 'text/plain')).statusCode).toBe(415);
      expect((await add('x.jpg', photo, 'image/jpeg', memberCookie)).statusCode).toBe(404);
      const audit = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'workspace.upload'));
      expect(audit.map((a) => (a.metadata as { input?: string }).input)).toEqual(
        expect.arrayContaining(['photo-2', 'plan-2']),
      );
    });

    it('unpacks a .zip into a place’s workspace: one folder, its names kept, pictures cleaned', async () => {
      const sharp = (await import('sharp')).default;
      const { zipSync } = await import('fflate');
      const photo = await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#a0b0c0' },
      })
        .withMetadata({ orientation: 6 })
        .withExifMerge({ IFD0: { Make: 'PhoneCo' } })
        .jpeg()
        .toBuffer();
      const text = (s: string) => Buffer.from(s);
      const zip = (files: Record<string, Uint8Array>) => Buffer.from(zipSync(files));
      const add = (name: string, body: Buffer, cookie = architectCookie) =>
        req('PUT', `/api/workspaces/${placeWorkspace}/uploads/${name}`, cookie, body, {
          'content-type': 'application/zip',
        });
      const inputsBefore = (
        await req('GET', `/api/spaces/${placeId}/inputs`, architectCookie)
      ).json().inputs.length;
      const res = await add(
        'Site%20photos.zip',
        zip({
          'site-photos/README.md': text('# The house\n\nStart with 01.'),
          'site-photos/manifest.json': text('{"images":[{"filename":"01_Overhead_North-up.jpg"}]}'),
          'site-photos/01_Overhead_North-up.jpg': photo,
          'site-photos/reference/site map.png': await sharp(photo).png().toBuffer(),
          'site-photos/reference/study.pdf': text('%PDF-1.4'),
          'site-photos/tool.exe': text('MZ'),
          'site-photos/.DS_Store': text('junk'),
          '__MACOSX/site-photos/._README.md': text('junk'),
        }),
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        path: 'uploads/site-photos/',
        typed: true,
        input: 'pack-1',
        files: 5,
        left: ['tool.exe'],
      });
      const written = supCalls.findLast((c) => c.act === 'workspace.uploadpack')?.body as {
        folder: string;
        files: { path: string; data: string }[];
      };
      expect(written.folder).toBe('site-photos');
      const files = new Map(written.files.map((f) => [f.path, Buffer.from(f.data, 'base64')]));
      // Names kept as the README and manifest give them (made plain only where they must be).
      expect([...files.keys()].sort()).toEqual([
        '01_Overhead_North-up.jpg',
        'README.md',
        'manifest.json',
        'reference/site-map.png',
        'reference/study.pdf',
      ]);
      expect(files.get('README.md')?.toString()).toBe('# The house\n\nStart with 01.');
      // Pictures lose their hidden details, and keep their format.
      const meta = await sharp(files.get('01_Overhead_North-up.jpg')).metadata();
      expect([meta.format, meta.width, meta.height, meta.exif, meta.orientation]).toEqual([
        'jpeg',
        300,
        400,
        undefined,
        undefined,
      ]);
      expect((await sharp(files.get('reference/site-map.png')).metadata()).format).toBe('png');
      // The folder is named in the terminal (pasted, never sent), and kept with the place.
      expect(supCalls.findLast((c) => c.act === 'sandbox.paste')?.body).toEqual({
        text: '@uploads/site-photos/ ',
      });
      const inputs = (await req('GET', `/api/spaces/${placeId}/inputs`, architectCookie)).json()
        .inputs as { name: string; kind: string; note: string; files?: number }[];
      expect(inputs.length).toBe(inputsBefore + 1);
      expect(inputs.find((i) => i.name === 'pack-1')).toMatchObject({
        kind: 'pack',
        note: 'site-photos',
        files: 5,
      });
      const again = await req(
        'POST',
        `/api/workspaces/${placeWorkspace}/uploads/site-photos/mention?folder=1`,
        architectCookie,
      );
      expect(again.json()).toEqual({ typed: true });
      expect(supCalls.findLast((c) => c.act === 'sandbox.paste')?.body).toEqual({
        text: '@uploads/site-photos/ ',
      });

      // Loose files at a zip's top go in a folder named after it.
      await add('Loose%20Notes.zip', zip({ 'a.md': text('a'), 'b.txt': text('b') }));
      expect(supCalls.findLast((c) => c.act === 'workspace.uploadpack')?.body).toMatchObject({
        folder: 'loose-notes',
      });
      // Nothing a place can take, a path that climbs out, and something that isn't a zip.
      const packs = supCalls.filter((c) => c.act === 'workspace.uploadpack').length;
      expect((await add('tools.zip', zip({ 'tool.exe': text('MZ') }))).statusCode).toBe(415);
      expect((await add('evil.zip', zip({ '../evil.md': text('x') }))).statusCode).toBe(400);
      expect((await add('fake.zip', text('not a zip at all'))).statusCode).toBe(400);
      expect((await add('a.zip', zip({ 'a.md': text('a') }), memberCookie)).statusCode).toBe(404);
      expect(supCalls.filter((c) => c.act === 'workspace.uploadpack').length).toBe(packs);
    });

    it('sets up a place from photos of the outside, with no floor plan', async () => {
      const { zipSync } = await import('fflate');
      const sharp = (await import('sharp')).default;
      const photo = await sharp({
        create: { width: 320, height: 200, channels: 3, background: '#9aa4ad' },
      })
        .jpeg()
        .toBuffer();
      const created = await req('POST', `/api/groups/${groupId}/places`, architectCookie, {
        name: 'The old mill',
        spaceType: 'building',
      });
      const millId = created.json().spaceId as string;
      const start = () =>
        req('POST', `/api/spaces/${millId}/workspace`, architectCookie, { provider: 'claude' });
      // Nothing to build it from yet.
      const nothing = await start();
      expect(nothing.statusCode).toBe(409);
      expect(nothing.json().error).toBe('Add a floor plan, photos or a .zip of them first.');

      const pack = Buffer.from(
        zipSync({
          'mill/README.md': Buffer.from('# The mill\n\nThree floors, brick.'),
          'mill/manifest.json': Buffer.from('{"photos":[{"file":"north_FACE.jpg","heading":180}]}'),
          'mill/north_FACE.jpg': photo,
          'mill/notes.exe': Buffer.from('MZ'),
        }),
      );
      const put = (file: string, body: Buffer, cookie = architectCookie) =>
        req('PUT', `/api/spaces/${millId}/packs/${file}`, cookie, body, {
          'content-type': 'application/zip',
        });
      const added = await put('Mill%20photos.zip', pack);
      expect(added.statusCode).toBe(200);
      expect(added.json()).toMatchObject({
        name: 'pack-1',
        kind: 'pack',
        files: 3,
        folder: 'mill',
        left: ['notes.exe'],
      });
      // Only its Architects, only zips, and only what a place can take.
      expect((await put('x.zip', pack, memberCookie)).statusCode).toBe(404);
      expect((await put('x.txt', pack)).statusCode).toBe(415);
      expect(
        (await put('tools.zip', Buffer.from(zipSync({ 'a.exe': Buffer.from('MZ') })))).statusCode,
      ).toBe(415);
      // A second pack with the same folder gets its own.
      expect((await put('again.zip', pack)).json()).toMatchObject({
        name: 'pack-2',
        folder: 'mill-2',
      });
      expect(
        (await req('DELETE', `/api/spaces/${millId}/inputs/pack-2`, architectCookie)).json(),
      ).toEqual({ ok: true });
      expect(await storage.has(`inputs/${millId}/pack-2.zip`)).toBe(false);
      expect(await storage.has(`inputs/${millId}/pack-1.zip`)).toBe(true);

      const inputs = (await req('GET', `/api/spaces/${millId}/inputs`, architectCookie)).json()
        .inputs;
      expect(inputs).toEqual([
        expect.objectContaining({ name: 'pack-1', kind: 'pack', note: 'mill', files: 3 }),
      ]);

      // Its workspace has the pack in inputs/, with every name kept, and a brief that says so.
      const res = await start();
      expect(res.statusCode).toBe(200);
      const init = supCalls.findLast((c) => c.act === 'workspace.init')?.body?.files as Record<
        string,
        string
      >;
      expect(Object.keys(init)).toEqual(
        expect.arrayContaining([
          'inputs/mill/README.md',
          'inputs/mill/manifest.json',
          'inputs/mill/north_FACE.jpg',
        ]),
      );
      expect(Buffer.from(init['inputs/mill/README.md'] as string, 'base64').toString()).toContain(
        'Three floors, brick.',
      );
      const brief = Buffer.from(init['BRIEF.md'] as string, 'base64').toString();
      expect(brief).toContain('`inputs/mill/` — 3 files the Architect gave together');
      const [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, res.json().id));
      expect(ws?.brief).toBe('The old mill, from its photos.');
    });

    it('builds a candidate from a sound plan, for Architects to walk through first', async () => {
      fake.workspacePlan = {
        name: 'Our flat',
        spaceType: 'apartment',
        floors: [{ key: 'f1', name: 'Flat', elevation: 0 }],
        rooms: [
          { key: 'a', name: 'Hall', floor: 'f1', rect: [0, 0, 2, 2] },
          { key: 'b', name: 'Kitchen', floor: 'f1', rect: [3, 0, 5, 2] },
        ],
        spawns: [{ key: 's', room: 'a', at: [1, 1] }],
      };
      const bad = await req(
        'POST',
        `/api/workspaces/${placeWorkspace}/build-space`,
        architectCookie,
        {},
      );
      expect(bad.statusCode).toBe(422);
      expect(bad.json().problems.map((p: { message: string }) => p.message)).toContain(
        "Kitchen can't be reached from where people start.",
      );

      fake.workspacePlan = JSON.parse(
        await (await import('node:fs/promises')).readFile(
          new URL('../../../../tools/dev/onboarding-kit/truth.json', import.meta.url),
          'utf8',
        ),
      );
      // A model the plan uses has to be in the workspace, and be a model.
      const truth = fake.workspacePlan as {
        rooms: { key: string; rect: [number, number, number, number] }[];
        furniture: object[];
      };
      const [rx0, rz0, rx1, rz1] = truth.rooms[0]?.rect ?? [0, 0, 1, 1];
      fake.workspacePlan = {
        ...truth,
        furniture: [
          ...truth.furniture,
          {
            key: 'figure',
            room: truth.rooms[0]?.key,
            kind: 'box',
            label: 'Figure',
            at: [(rx0 + rx1) / 2, (rz0 + rz1) / 2],
            size: [0.1, 0.2, 0.1],
            model: 'models/figure.glb',
          },
        ],
      };
      const missing = await req(
        'POST',
        `/api/workspaces/${placeWorkspace}/build-space`,
        architectCookie,
        {},
      );
      expect(missing.statusCode).toBe(422);
      expect(missing.json().problems.map((p: { message: string }) => p.message)).toContain(
        "models/figure.glb isn't in the workspace.",
      );
      workspaceFiles.set('models/figure.glb', Buffer.from('not a model'));
      const broken = await req(
        'POST',
        `/api/workspaces/${placeWorkspace}/build-space`,
        architectCookie,
        {},
      );
      expect(broken.json().problems.map((p: { message: string }) => p.message)).toContain(
        'models/figure.glb is not a .glb file (export it as "glTF Binary").',
      );
      expect(supCalls.findLast((c) => c.act === 'workspace.read')?.body).toEqual({
        path: 'models/figure.glb',
      });
      fake.workspacePlan = truth;

      expect(
        (await req('POST', `/api/workspaces/${placeWorkspace}/build-space`, architectCookie, {}))
          .statusCode,
      ).toBe(200);
      const review = await waitForBuild();
      expect(review.failed).toBeNull();
      expect(review.candidate.rooms.map((r: { name: string }) => r.name)).toContain(
        'Living and kitchen',
      );
      const vid = review.candidate.id;
      expect(
        (await req('GET', `/api/spaces/${placeId}/versions/${vid}/manifest`, architectCookie))
          .statusCode,
      ).toBe(200);
      expect(
        (await req('GET', `/api/spaces/${placeId}/versions/${vid}/manifest`, memberCookie))
          .statusCode,
      ).toBe(404);
      expect(
        (await req('GET', `/api/spaces/${placeId}/manifest`, architectCookie)).statusCode,
      ).toBe(404); // nothing live yet
      expect((await req('GET', `/api/spaces/${placeId}/review`, memberCookie)).statusCode).toBe(
        404,
      );
    }, 120_000);

    it('shows the assistant’s pictures, and says when the place has changed since its build', async () => {
      const now = Date.now() / 1000;
      fake.pictureListing = {
        pictures: [
          { path: 'preview/models/figure.png', bytes: 10, at: now - 60 },
          { path: 'preview/rooms/living-corner-1.png', bytes: 10, at: now - 5 },
          { path: 'preview/match/north-face.png', bytes: 10, at: now - 30 },
          { path: 'preview/../plan.json', bytes: 10, at: now },
        ],
        models: [],
      };
      const look = async () =>
        (await req('GET', `/api/workspaces/${placeWorkspace}/pictures`, architectCookie)).json();
      const seen = await look();
      // Newest first; nothing outside the assistant's picture folders.
      expect(seen.pictures.map((p: { path: string; kind: string }) => [p.path, p.kind])).toEqual([
        ['preview/rooms/living-corner-1.png', 'room'],
        ['preview/match/north-face.png', 'match'],
        ['preview/models/figure.png', 'model'],
      ]);
      // Just built from this plan: nothing new to build.
      expect(seen.build).toMatchObject({ changed: false });
      expect(seen.build.last).toBeGreaterThan(0);
      // The assistant changes the plan: there's something to build.
      const built = fake.workspacePlan as { name: string };
      fake.workspacePlan = { ...built, name: `${built.name} (changed)` };
      expect((await look()).build.changed).toBe(true);
      fake.workspacePlan = built;
      expect((await look()).build.changed).toBe(false);
      // A model the plan uses, written after the build: something to build too.
      const plan = fake.workspacePlan as { furniture: { model?: string }[] };
      const withModel = {
        ...plan,
        furniture: plan.furniture.map((f, i) =>
          i === 0 ? { ...f, model: 'models/chair.glb' } : f,
        ),
      };
      fake.workspacePlan = withModel;
      fake.pictureListing.models = [{ path: 'models/chair.glb', bytes: 10, at: now + 60 }];
      expect((await look()).build.changed).toBe(true);
      fake.workspacePlan = built;
      fake.pictureListing = { pictures: [], models: [] };
      // Only the Architect whose workspace it is; only pictures.
      expect(
        (await req('GET', `/api/workspaces/${placeWorkspace}/pictures`, memberCookie)).statusCode,
      ).toBe(404);
      expect(
        (await req('GET', `/api/workspaces/${placeWorkspace}/pictures/plan.json`, architectCookie))
          .statusCode,
      ).toBe(404);
    });

    it('lets the Studio look for the plan quietly: "not yet", or "unchanged"', async () => {
      const file = (path: string, headers: Record<string, string> = {}) =>
        app.inject({
          method: 'GET',
          url: `/api/workspaces/${placeWorkspace}/files/${path}`,
          headers: { cookie: architectCookie, ...headers },
        });
      const plan = await file('plan.json?ifexists=1');
      expect(plan.statusCode).toBe(200);
      const etag = plan.headers.etag as string;
      expect(etag).toMatch(/^".+"$/);
      expect((await file('plan.json?ifexists=1', { 'if-none-match': etag })).statusCode).toBe(304);
      // No overlay drawn: "not yet" when asked that way, otherwise not found.
      expect((await file('preview/overlay.png?ifexists=1')).statusCode).toBe(204);
      expect((await file('preview/overlay.png')).statusCode).toBe(404);
    });

    it('publishes it with every room private until the Architect shares it', async () => {
      const review = (await req('GET', `/api/spaces/${placeId}/review`, architectCookie)).json();
      expect(
        (
          await req(
            'POST',
            `/api/spaces/${placeId}/versions/${review.candidate.id}/publish`,
            memberCookie,
            {},
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await req(
            'POST',
            `/api/spaces/${placeId}/versions/${review.candidate.id}/publish`,
            architectCookie,
            {},
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (await req('GET', `/api/spaces/${placeId}/manifest`, architectCookie)).json().rooms.length,
      ).toBe(7);
      // A member is in the group, but nothing about any room has been shared with them.
      const member = await req('GET', `/api/spaces/${placeId}/manifest`, memberCookie);
      expect(member.statusCode).toBe(403);
      expect(member.payload).not.toContain('Bedroom');
      const cards = async (cookie: string) =>
        (await req('GET', '/api/spaces', cookie))
          .json()
          .spaces.find((s: { id: string }) => s.id === placeId);
      expect((await cards(memberCookie)).sketch).toBeNull();
      expect((await cards(architectCookie)).sketch.rooms).toBe(7);
    });

    it('discards a place that is still being set up, with everything added for it', async () => {
      // A published place isn't discarded this way.
      expect((await req('DELETE', `/api/spaces/${placeId}`, architectCookie)).statusCode).toBe(409);

      const draft = (
        await req('POST', `/api/groups/${groupId}/places`, architectCookie, {
          name: 'Second go',
          spaceType: 'house',
        })
      ).json().spaceId as string;
      const stage = async () =>
        (await req('GET', '/api/spaces', architectCookie))
          .json()
          .spaces.find((s: { id: string }) => s.id === draft)?.stage;
      expect(await stage()).toBe('details'); // no workspace yet
      const sharp = (await import('sharp')).default;
      const plan = await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer();
      await req('PUT', `/api/spaces/${draft}/inputs/plan-1`, architectCookie, plan, {
        'content-type': 'image/png',
      });
      // An iPhone photo (HEIC), even sent without its proper type, is turned into a JPEG.
      const heic = await (await import('node:fs/promises')).readFile(
        new URL('../fixtures/photo.heic', import.meta.url),
      );
      const photo = await req('PUT', `/api/spaces/${draft}/inputs/photo-1`, architectCookie, heic, {
        'content-type': 'image/jpeg',
      });
      expect(photo.statusCode).toBe(200);
      expect(photo.json()).toMatchObject({ width: 1200, height: 900 });
      const ws = (
        await req('POST', `/api/spaces/${draft}/workspace`, architectCookie, { provider: 'claude' })
      ).json().id as string;
      expect(await stage()).toBe('start'); // a workspace, never started
      await db
        .update(schema.workspaces)
        .set({ status: 'running' })
        .where(eq(schema.workspaces.id, ws));
      expect(await stage()).toBe('working');
      await db
        .update(schema.workspaces)
        .set({ status: 'stopped' })
        .where(eq(schema.workspaces.id, ws));
      expect(await stage()).toBe('asleep');
      await db
        .update(schema.spaces)
        .set({ buildState: 'building' })
        .where(eq(schema.spaces.id, draft));
      expect(await stage()).toBe('building');
      await db.update(schema.spaces).set({ buildState: null }).where(eq(schema.spaces.id, draft));
      const stored = () => [...storage.objects.keys()].filter((k) => k.includes(draft));
      expect(stored().length).toBeGreaterThan(0);

      expect((await req('DELETE', `/api/spaces/${draft}`, memberCookie)).statusCode).toBe(404);
      expect((await req('DELETE', `/api/spaces/${draft}`, architectCookie)).statusCode).toBe(200);
      expect(supCalls.some((c) => c.act === 'workspace.delete' && c.claims.ws === ws)).toBe(true);
      expect(stored()).toEqual([]);
      const names = (await req('GET', '/api/spaces', architectCookie))
        .json()
        .spaces.map((s: { name: string }) => s.name);
      expect(names).not.toContain('Second go');
      expect(names).toContain('Our flat');
    });

    it('removes a sample nobody has made anything in, and keeps one with creations', async () => {
      const kept = await req('DELETE', `/api/spaces/${spaceId}`, architectCookie);
      expect(kept.statusCode).toBe(409);
      const extra = (
        await req('POST', `/api/groups/${groupId}/sample-spaces`, architectCookie, {
          sample: 'studio-apartment',
        })
      ).json().spaceId as string;
      const status = async () =>
        (await req('GET', '/api/spaces', architectCookie))
          .json()
          .spaces.find((s: { id: string }) => s.id === extra)?.status;
      await vi.waitFor(async () => expect(await status()).not.toBe('building'), {
        timeout: 20_000,
        interval: 100,
      });
      expect(await status()).toBe('ready');
      expect((await req('DELETE', `/api/spaces/${extra}`, memberCookie)).statusCode).toBe(404);
      expect((await req('DELETE', `/api/spaces/${extra}`, architectCookie)).statusCode).toBe(200);
      expect(await status()).toBeUndefined();
      expect([...storage.objects.keys()].some((k) => k.includes(extra))).toBe(false);
    });

    // ---- Changing a live place (Phase 8) ----------------------------------------------------

    let deskCreation = '';
    let firstVersion = '';
    /** The place's review, once nothing is building any more. */
    const waitForBuild = () =>
      vi.waitFor(
        async () => {
          const review = (
            await req('GET', `/api/spaces/${placeId}/review`, architectCookie)
          ).json();
          expect(review.building).toBeFalsy();
          return review;
        },
        { timeout: 60_000, interval: 250 },
      );

    it('keeps the plan with each version, and reopens the place from it', async () => {
      const [space] = await db.select().from(schema.spaces).where(eq(schema.spaces.id, placeId));
      firstVersion = space?.currentVersionId as string;
      const [live] = await db
        .select()
        .from(schema.spaceVersions)
        .where(eq(schema.spaceVersions.id, firstVersion));
      expect((live?.plan as { name: string } | undefined)?.name).toBe('Two-bedroom flat');
      // A creation on the desk, with something saved in it.
      const made = await publishCreation(db, storage, {
        groupId: space?.groupId as string,
        spaceId: placeId,
        objectKey: 'desk',
        title: 'Letters',
        files: new Map([['index.html', new TextEncoder().encode('<!doctype html>')]]),
        sdkVersion: '0.1.0',
        protocolVersion: 1,
      });
      deskCreation = made.creationId;
      await db.insert(schema.creationDataShared).values({
        creationId: deskCreation,
        key: 'letters',
        value: { count: 3 },
        schemaVersion: 1,
      });

      const calls = supCalls.length;
      const res = await req('POST', `/api/spaces/${placeId}/workspace`, architectCookie, {
        provider: 'claude',
        description: 'Take the desk out of the study.',
      });
      expect(res.statusCode).toBe(200);
      placeWorkspace = res.json().id;
      const acts = supCalls.slice(calls).map((c) => c.act);
      // The workspace it was first built in is put away; a fresh one starts from the live plan.
      expect(acts).toEqual(['workspace.delete', 'workspace.init']);
      const files = supCalls.at(-1)?.body?.files as Record<string, string>;
      const plan = JSON.parse(Buffer.from(files['plan.json'] as string, 'base64').toString());
      expect(plan.furniture.some((f: { key: string }) => f.key === 'desk')).toBe(true);
      const brief = Buffer.from(files['BRIEF.md'] as string, 'base64').toString();
      expect(brief).toContain('# Changing Our flat');
      expect(brief).toContain('Take the desk out of the study.');
      // Asking again carries on with the same change.
      const again = await req('POST', `/api/spaces/${placeId}/workspace`, architectCookie, {
        provider: 'claude',
      });
      expect(again.json()).toEqual({ id: placeWorkspace, reopened: true });
    });

    it('shows what changes, and won’t publish until every creation has a home', async () => {
      const truth = JSON.parse(
        await (await import('node:fs/promises')).readFile(
          new URL('../../../../tools/dev/onboarding-kit/truth.json', import.meta.url),
          'utf8',
        ),
      );
      fake.workspacePlan = {
        ...truth,
        furniture: [
          ...truth.furniture.filter((f: { key: string }) => f.key !== 'desk'),
          {
            key: 'reading-lamp',
            room: 'study',
            kind: 'lamp',
            label: 'Reading lamp',
            at: [6.3, 7.6],
            size: [0.3, 1.4, 0.3],
            model: 'models/lamp.glb',
          },
        ],
      };
      // A model made for it, and the script that made it.
      workspaceFiles.set('models/lamp.glb', pyramidGlb());
      workspaceFiles.set('models/lamp.py', Buffer.from('import ats_model as m\n'));
      expect(
        (await req('POST', `/api/workspaces/${placeWorkspace}/build-space`, architectCookie, {}))
          .statusCode,
      ).toBe(200);
      const review = await waitForBuild();
      const c = review.candidate;
      expect(c.changes.objects.removed).toEqual([{ key: 'desk', label: 'Desk', room: 'Study' }]);
      expect(c.changes.objects.added.map((o: { key: string }) => o.key)).toEqual(['reading-lamp']);
      expect(c.changes.rooms.changed.map((r: { key: string }) => r.key)).toEqual(['study']);
      // Re-doing one room leaves the others exactly as they were.
      expect(c.changes.rooms.unchanged.map((r: { key: string }) => r.key).sort()).toEqual([
        'balcony',
        'bath',
        'bed1',
        'bed2',
        'hall',
        'living',
      ]);
      expect(c.homeless).toEqual([
        { id: deskCreation, title: 'Letters', objectLabel: 'Desk · Study' },
      ]);
      expect(c.freeObjects.map((o: { key: string }) => o.key)).toContain('reading-lamp');

      const publish = (moves: object) =>
        req('POST', `/api/spaces/${placeId}/versions/${c.id}/publish`, architectCookie, { moves });
      const gate = await publish({});
      expect(gate.statusCode).toBe(409);
      expect(gate.json().undecided).toEqual([{ id: deskCreation, title: 'Letters' }]);
      expect((await publish({ [deskCreation]: 'no-such-thing' })).statusCode).toBe(409);
      announced.length = 0;
      expect((await publish({ [deskCreation]: null })).statusCode).toBe(200);
      // On the shelf, with everything it saved.
      const [shelved] = await db
        .select()
        .from(schema.creations)
        .where(eq(schema.creations.id, deskCreation));
      expect(shelved?.objectKey).toBeNull();
      const saved = await db
        .select()
        .from(schema.creationDataShared)
        .where(eq(schema.creationDataShared.creationId, deskCreation));
      expect(saved[0]?.value).toEqual({ count: 3 });
      // People in the space get the new version straight away.
      expect(announced).toContain(placeId);
    });

    it('puts a creation from the shelf onto a free object', async () => {
      const place = (key: string | null, cookie = architectCookie) =>
        req('PUT', `/api/creations/${deskCreation}/place`, cookie, { objectKey: key });
      expect((await place('reading-lamp', memberCookie)).statusCode).toBe(404);
      expect((await place('desk')).statusCode).toBe(400);
      expect((await place('reading-lamp')).statusCode).toBe(200);
      const [c] = await db
        .select()
        .from(schema.creations)
        .where(eq(schema.creations.id, deskCreation));
      expect(c?.objectKey).toBe('reading-lamp');
    });

    it('goes back to an earlier version, with every creation where it was', async () => {
      const versions = (await req('GET', `/api/spaces/${placeId}/versions`, architectCookie)).json()
        .versions;
      expect(versions.map((v: { live: boolean }) => v.live)).toEqual([true, false]);
      const back = await req(
        'POST',
        `/api/spaces/${placeId}/versions/${firstVersion}/live`,
        architectCookie,
        {},
      );
      expect(back.statusCode).toBe(200);
      const [c] = await db
        .select()
        .from(schema.creations)
        .where(eq(schema.creations.id, deskCreation));
      expect(c?.objectKey).toBe('desk');
      // A change begun before going back is out of date: changing it now starts afresh, from
      // the plan of the version that's live again.
      const calls = supCalls.length;
      const change = await req('POST', `/api/spaces/${placeId}/workspace`, architectCookie, {
        provider: 'claude',
        description: 'Something else.',
      });
      expect(change.json().reopened).toBeUndefined();
      expect(change.json().id).not.toBe(placeWorkspace);
      const init = supCalls.slice(calls).find((x) => x.act === 'workspace.init');
      const seeded = JSON.parse(
        Buffer.from(
          (init?.body?.files as Record<string, string> | undefined)?.['plan.json'] as string,
          'base64',
        ).toString(),
      );
      expect(seeded.furniture.some((f: { key: string }) => f.key === 'desk')).toBe(true);
      // With that version's own models (it had none).
      expect(
        Object.keys(init?.body?.files as object).filter((p) => p.startsWith('models/')),
      ).toEqual([]);
      // And forward again: it's back on the lamp.
      await req(
        'POST',
        `/api/spaces/${placeId}/versions/${versions[0].id}/live`,
        architectCookie,
        {},
      );
      const [d] = await db
        .select()
        .from(schema.creations)
        .where(eq(schema.creations.id, deskCreation));
      expect(d?.objectKey).toBe('reading-lamp');
    });

    it('deletes the floor plans and photos once it’s published, when asked', async () => {
      const [space] = await db.select().from(schema.spaces).where(eq(schema.spaces.id, placeId));
      const settingsUrl = `/api/groups/${space?.groupId}/studio-settings`;
      const settings = (await req('GET', settingsUrl, architectCookie)).json();
      expect(settings.deleteInputsAfterPublish).toBe(false);
      await req('PUT', settingsUrl, architectCookie, {
        ...settings,
        deleteInputsAfterPublish: true,
      });
      const ws = (
        await req('POST', `/api/spaces/${placeId}/workspace`, architectCookie, {
          provider: 'claude',
          description: 'Brighter lamp.',
        })
      ).json().id;
      expect(
        (await req('POST', `/api/workspaces/${ws}/build-space`, architectCookie, {})).statusCode,
      ).toBe(200);
      const review = await waitForBuild();
      expect(review.deletesInputs).toBe(true);
      expect(review.candidate.homeless).toEqual([]);
      const calls = supCalls.length;
      const res = await req(
        'POST',
        `/api/spaces/${placeId}/versions/${review.candidate.id}/publish`,
        architectCookie,
        { moves: {} },
      );
      expect(res.json()).toEqual({ ok: true, inputsDeleted: true });
      // The uploads are gone, and the workspace holding copies of them.
      expect(
        await db.select().from(schema.spaceInputs).where(eq(schema.spaceInputs.spaceId, placeId)),
      ).toEqual([]);
      expect(
        (await req('GET', `/api/spaces/${placeId}/inputs/plan-1`, architectCookie)).statusCode,
      ).toBe(404);
      expect(
        supCalls
          .slice(calls)
          .filter((c) => c.act === 'workspace.delete')
          .map((c) => (c.claims as { ws?: string }).ws),
      ).toContain(ws);
      const [w] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, ws));
      expect(w?.status).toBe('archived');
      // Changing it later starts from the plan, which is kept, and the models made for it (with
      // their scripts), though the workspace that made them is gone.
      workspaceFiles.delete('models/lamp.glb');
      workspaceFiles.delete('models/lamp.py');
      const calls2 = supCalls.length;
      const later = await req('POST', `/api/spaces/${placeId}/workspace`, architectCookie, {
        provider: 'claude',
        description: 'Add a shelf.',
      });
      expect(later.statusCode).toBe(200);
      const seeded = supCalls.slice(calls2).find((x) => x.act === 'workspace.init')?.body
        ?.files as Record<string, string>;
      expect(Buffer.from(seeded['models/lamp.glb'] as string, 'base64')).toEqual(pyramidGlb());
      expect(Buffer.from(seeded['models/lamp.py'] as string, 'base64').toString()).toBe(
        'import ats_model as m\n',
      );
      await req('PUT', settingsUrl, architectCookie, settings);
    });
  });
});
