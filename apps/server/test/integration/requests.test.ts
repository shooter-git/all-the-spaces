// Members' requests, from asking to trying it out.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, schema } from '@ats/db';
import type { SpaceManifest } from '@ats/space-format';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { afterBuild, OPEN } from '../../src/commissions.ts';
import { publishCreation } from '../../src/creations/store.ts';
import { orphanRequests } from '../../src/space-updates.ts';
import {
  addSampleSpace,
  addSofaCreation,
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
  let storage: TestApp['storage'];
  let supCalls: Fakes['supCalls'];
  let pushed: Fakes['pushed'];
  let mailed: Fakes['mailed'];
  let architectCookie = '';
  let memberCookie = '';
  let groupId = '';
  let spaceId = '';

  beforeAll(async () => {
    t = await createTestApp();
    ({ app, db, storage } = t);
    ({ supCalls, pushed, mailed } = t.fake);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
    // As the creation tests leave it: the sofa already holds a creation, so asking for
    // something new there is refused.
    await addSofaCreation(t, groupId, spaceId);
  });

  afterAll(async () => {
    await t?.close();
  });

  const failInsertsInto = (table: string) => t.failInsertsInto(table);
  const signUpOutsider = () => t.signUpOutsider(architectCookie, groupId);

  describe('requests', () => {
    let requestId = '';
    let memberId = '';
    const req = (
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      cookie: string,
      payload?: object | Buffer,
      headers: Record<string, string> = {},
    ) =>
      app.inject({ method, url, headers: { cookie, ...headers }, ...(payload ? { payload } : {}) });
    const ask = (body: object, cookie = memberCookie) =>
      req('POST', `/api/spaces/${spaceId}/requests`, cookie, body);
    const notificationsOf = async (cookie: string) =>
      (await req('GET', '/api/notifications', cookie)).json();
    const room = (key: string, body: object) =>
      req('PUT', `/api/spaces/${spaceId}/rooms/${key}`, architectCookie, body);

    beforeAll(async () => {
      memberId = (await req('GET', '/api/me', memberCookie)).json().user.id;
      for (const key of ['hall', 'bath', 'living', 'balcony'])
        await room(key, { visibility: 'group', requests: 'anyone', ownerId: null });
    });

    it('only writes it down and tells the Architects: nothing is built or asked (C1)', async () => {
      const calls = supCalls.length;
      const builds = (await db.select().from(schema.builds)).length;
      const res = await ask({
        kind: 'new',
        objectKey: 'bookshelf',
        title: 'A book that reads itself',
        prompt: 'Open a book and it tells you a story, with the pages turning by themselves.',
      });
      expect(res.statusCode).toBe(200);
      requestId = res.json().id;
      // No sandbox, no assistant, no build.
      expect(supCalls.length).toBe(calls);
      expect((await db.select().from(schema.builds)).length).toBe(builds);
      const [c] = await db
        .select()
        .from(schema.commissions)
        .where(eq(schema.commissions.id, requestId));
      expect(c).toMatchObject({ status: 'submitted', objectLabel: 'Bookshelf', roomKey: 'living' });
      const architect = await notificationsOf(architectCookie);
      expect(architect.notifications[0]).toMatchObject({
        title: 'New request: A book that reads itself',
        url: `/space/${spaceId}/requests/${requestId}`,
        read: false,
      });
      const mine = (await req('GET', '/api/requests', memberCookie)).json().requests;
      expect(mine[0]).toMatchObject({ id: requestId, statusWords: 'Sent to the Architects' });
      // Members don't see the Architects' queue.
      expect((await req('GET', '/api/studio/requests', memberCookie)).statusCode).toBe(404);
      const queue = (await req('GET', '/api/studio/requests', architectCookie)).json().requests;
      expect(queue[0]).toMatchObject({
        id: requestId,
        requesterName: 'Visitor',
        priority: 'normal',
      });
    });

    it('shows what has been asked for on objects, only to people who can see them', async () => {
      const states = async (cookie: string) =>
        (await req('GET', `/api/spaces/${spaceId}/requests/objects`, cookie)).json().objects;
      expect(await states(memberCookie)).toEqual({ bookshelf: { state: 'requested', mine: true } });
      expect(await states(architectCookie)).toEqual({
        bookshelf: { state: 'requested', mine: false },
      });
      await room('living', { visibility: 'hidden' });
      expect(await states(memberCookie)).toEqual({});
      await room('living', { visibility: 'group' });
      // Someone outside the group sees nothing of it.
      const outsider = await signUpOutsider();
      expect((await req('GET', `/api/requests/${requestId}`, outsider)).statusCode).toBe(404);
      expect(
        (await req('GET', `/api/spaces/${spaceId}/requests/objects`, outsider)).statusCode,
      ).toBe(404);
    });

    it('follows the room’s rule on who may ask', async () => {
      await room('balcony', { visibility: 'group', requests: 'owner', ownerId: null });
      const wish = { kind: 'new', objectKey: 'balcony-table', title: 'Tea', prompt: 'A tea set.' };
      expect((await ask(wish)).statusCode).toBe(403);
      await room('balcony', { visibility: 'group', requests: 'owner', ownerId: memberId });
      const own = await ask(wish);
      expect(own.statusCode).toBe(200);
      await req('POST', `/api/requests/${own.json().id}/withdraw`, memberCookie, {});
      await room('balcony', { visibility: 'group', requests: 'architects' });
      expect((await ask(wish)).statusCode).toBe(403);
      // Hidden rooms: as if they weren't there.
      await room('bath', { visibility: 'hidden' });
      expect(
        (await ask({ kind: 'new', objectKey: 'bath-tub', title: 'Boats', prompt: 'Boats.' }))
          .statusCode,
      ).toBe(404);
      await room('bath', { visibility: 'group' });
      await room('balcony', { visibility: 'group', requests: 'anyone' });
    });

    it('asks for a change to what an object already holds, rather than something new', async () => {
      const sofa = await ask({ kind: 'new', objectKey: 'sofa', title: 'x', prompt: 'y' });
      expect(sofa.statusCode).toBe(409);
      expect(sofa.json().error).toMatch(/Suggest a change/);
      // A new object altogether: say which room.
      const telescope = await ask({
        kind: 'new',
        roomKey: 'balcony',
        title: 'A telescope',
        prompt: 'A telescope to look at the stars.',
      });
      expect(telescope.statusCode).toBe(200);
      await req('POST', `/api/requests/${telescope.json().id}/withdraw`, memberCookie, {});
    });

    it('keeps pictures private to the member and the Architects, without hidden details', async () => {
      const sharp = (await import('sharp')).default;
      const photo = await sharp({
        create: { width: 900, height: 600, channels: 3, background: '#7a5c42' },
      })
        .withExifMerge({ IFD0: { Make: 'PhoneCo' } })
        .jpeg()
        .toBuffer();
      const put = await req(
        'PUT',
        `/api/requests/${requestId}/images/snapshot`,
        memberCookie,
        photo,
        {
          'content-type': 'image/jpeg',
        },
      );
      expect(put.statusCode).toBe(200);
      expect(put.json().images).toEqual(['snapshot']);
      const got = await req('GET', `/api/requests/${requestId}/images/snapshot`, architectCookie);
      expect(got.statusCode).toBe(200);
      expect((await sharp(got.rawPayload).metadata()).exif).toBeUndefined();
      expect(
        (
          await req('PUT', `/api/requests/${requestId}/images/../x`, memberCookie, photo, {
            'content-type': 'image/jpeg',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await req('PUT', `/api/requests/${requestId}/images/sketch`, architectCookie, photo, {
            'content-type': 'image/jpeg',
          })
        ).statusCode,
      ).toBe(404);
    });

    it('takes up to 10,000 characters of their own words', async () => {
      const long = { kind: 'new', roomKey: 'balcony', title: 'A long plan' };
      expect((await ask({ ...long, prompt: 'a'.repeat(10_001) })).statusCode).toBe(400);
      const ok = await ask({ ...long, prompt: 'a'.repeat(10_000) });
      expect(ok.statusCode).toBe(200);
      await req('POST', `/api/requests/${ok.json().id}/withdraw`, memberCookie, {});
    });

    it('keeps Markdown documents with it, as text, private to the member and the Architects', async () => {
      const text = '# The storybook\n\n## Pages\n\nEach page turns by itself.\n';
      const put = (name: string, body: object, cookie = memberCookie) =>
        req('PUT', `/api/requests/${requestId}/documents/${name}`, cookie, body);
      const added = await put('doc-1', { file: 'C:\\plans\\story plan.md', text });
      expect(added.statusCode).toBe(200);
      expect(added.json().documents).toEqual([{ name: 'doc-1', file: 'story plan.md' }]);
      const got = await req('GET', `/api/requests/${requestId}/documents/doc-1`, architectCookie);
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      expect(got.payload).toBe(text);
      const detail = (await req('GET', `/api/requests/${requestId}`, memberCookie)).json();
      expect(detail.request.documents).toEqual([{ name: 'doc-1', file: 'story plan.md' }]);
      // Three at most, only from the person who asked, and only text that fits.
      expect((await put('doc-4', { file: 'a.md', text })).statusCode).toBe(404);
      expect((await put('doc-2', { file: 'a.md', text }, architectCookie)).statusCode).toBe(404);
      expect((await put('doc-2', { file: 'plan.pdf', text })).statusCode).toBe(415);
      expect((await put('doc-2', { file: 'a.md', text: 'a\0b' })).statusCode).toBe(415);
      expect((await put('doc-2', { file: 'a.md', text: ' \n' })).statusCode).toBe(415);
      expect((await put('doc-2', { file: 'a.md', text: 'a'.repeat(50_001) })).statusCode).toBe(413);
      const outsider = await signUpOutsider();
      expect(
        (await req('GET', `/api/requests/${requestId}/documents/doc-1`, outsider)).statusCode,
      ).toBe(404);
    });

    it('lets an Architect accept it, and start a workspace that carries it (C1, C9)', async () => {
      expect(
        (await req('POST', `/api/requests/${requestId}/accept`, memberCookie, {})).statusCode,
      ).toBe(404);
      await req('PATCH', `/api/requests/${requestId}`, architectCookie, {
        priority: 'high',
        effort: 'small',
      });
      const accept = await req('POST', `/api/requests/${requestId}/accept`, architectCookie, {
        note: 'Lovely idea.',
      });
      expect(accept.statusCode).toBe(200);
      const member = await notificationsOf(memberCookie);
      expect(member.notifications[0]).toMatchObject({
        title: 'Accepted: A book that reads itself',
        body: 'Lovely idea.',
        url: `/requests/${requestId}`,
      });
      expect(member.unread).toBeGreaterThan(0);

      const calls = supCalls.length;
      const ws = await req('POST', `/api/spaces/${spaceId}/workspaces`, architectCookie, {
        title: 'The storybook',
        brief: 'A book on the shelf that reads itself aloud.',
        provider: 'claude',
        requestId,
      });
      expect(ws.statusCode).toBe(200);
      // Preparing the workspace only writes files: no assistant is started or typed to.
      expect(supCalls.slice(calls).map((c) => c.act)).toEqual(['workspace.init']);
      const files = supCalls.at(-1)?.body?.files as Record<string, string>;
      expect(Object.keys(files)).toContain('request/snapshot.jpg');
      expect(Buffer.from(files['request/doc-1.md'] as string, 'base64').toString()).toMatch(
        /^# The storybook/,
      );
      const brief = Buffer.from(files['BRIEF.md'] as string, 'base64').toString();
      expect(brief).toContain('`request/doc-1.md`: a document they wrote for it (story plan.md)');
      expect(brief).toContain('It lives on: bookshelf in the living room');
      expect(brief).toContain('Visitor asked for this, in their own words');
      expect(brief).toContain('> Open a book and it tells you a story');
      const [row] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, ws.json().id));
      expect(row?.objectKey).toBe('bookshelf');
      // One workspace per request.
      const again = await req('POST', `/api/spaces/${spaceId}/workspaces`, architectCookie, {
        title: 'Again',
        brief: 'Again',
        provider: 'claude',
        requestId,
      });
      expect(again.statusCode).toBe(409);

      const detail = (await req('GET', `/api/requests/${requestId}`, memberCookie)).json();
      expect(detail.request.statusWords).toBe('Being built');
      expect(detail.request.canWithdraw).toBe(false);
      expect(detail.request.priority).toBeUndefined();
      expect(detail.events.map((e: { status: string }) => e.status)).toEqual([
        'submitted',
        'accepted',
        'in_progress',
      ]);
      expect(detail.events[1]).toMatchObject({ note: 'Lovely idea.', byArchitect: true });
    });

    it('follows its builds, and tells the member when it’s ready to try', async () => {
      const [c] = await db
        .select()
        .from(schema.commissions)
        .where(eq(schema.commissions.id, requestId));
      const [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, c?.workspaceId as string));
      const build = async (status: 'failed' | 'passed', versionOf?: string) => {
        const [b] = await db
          .insert(schema.builds)
          .values({
            groupId: c?.groupId as string,
            spaceId,
            objectKey: 'bookshelf',
            workspaceId: ws?.id,
            sourceHash: 'x'.repeat(64),
            status,
            creationId: versionOf ?? null,
          })
          .returning();
        await afterBuild(db, undefined, b?.id as string);
        return b?.id as string;
      };
      await build('failed');
      expect(
        (await req('GET', `/api/requests/${requestId}`, memberCookie)).json().request.statusWords,
      ).toBe('Being built');
      // It passes: a candidate an Architect tries before making it live.
      const published = await publishCreation(db, storage, {
        groupId: c?.groupId as string,
        spaceId,
        objectKey: 'bookshelf',
        title: 'The storybook',
        files: new Map([['index.html', new TextEncoder().encode('<!doctype html>')]]),
        sdkVersion: '0.1.0',
        protocolVersion: 1,
        status: 'candidate',
        qa: { ok: true, failed: 0, warned: 0, thumbnail: null, summary: null },
      });
      const buildId = await build('passed', published.creationId);
      await db
        .update(schema.creationVersions)
        .set({ buildId })
        .where(eq(schema.creationVersions.id, published.versionId));
      expect(
        (await req('GET', `/api/requests/${requestId}`, memberCookie)).json().request.statusWords,
      ).toBe('Nearly ready');
      const live = await req(
        'POST',
        `/api/creations/${published.creationId}/versions/${published.versionId}/live`,
        architectCookie,
        {},
      );
      expect(live.statusCode).toBe(200);
      const done = (await req('GET', `/api/requests/${requestId}`, memberCookie)).json();
      expect(done.request).toMatchObject({
        statusWords: 'Ready to try',
        open: false,
        creationId: published.creationId,
      });
      expect((await notificationsOf(memberCookie)).notifications[0]).toMatchObject({
        title: 'Ready to try: A book that reads itself',
        url: `/space/${spaceId}?object=bookshelf`,
      });
      // The object now holds a creation, so it's no longer "requested".
      expect(
        (await req('GET', `/api/spaces/${spaceId}/requests/objects`, memberCookie)).json().objects,
      ).toEqual({});
    });

    it('keeps a new object "nearly ready" until it has a place in the space', async () => {
      const r = await ask({
        kind: 'new',
        roomKey: 'balcony',
        title: 'A telescope',
        prompt: 'A telescope to look at the stars.',
      });
      const id = r.json().id;
      const ws = await req('POST', `/api/spaces/${spaceId}/workspaces`, architectCookie, {
        title: 'Telescope',
        brief: 'A telescope.',
        provider: 'claude',
        requestId: id,
      });
      expect(ws.statusCode).toBe(200);
      const [c] = await db.select().from(schema.commissions).where(eq(schema.commissions.id, id));
      const [b] = await db
        .insert(schema.builds)
        .values({
          groupId: c?.groupId as string,
          spaceId,
          objectKey: null,
          workspaceId: ws.json().id,
          sourceHash: 'y'.repeat(64),
          status: 'published',
        })
        .returning();
      await afterBuild(db, undefined, b?.id as string);
      const detail = (await req('GET', `/api/requests/${id}`, memberCookie)).json();
      expect(detail.request).toMatchObject({ status: 'ready', open: true });
      expect(detail.events.at(-1).note).toMatch(/gives it a place in the space/);
    });

    it('lets members withdraw or add detail, and Architects decline with a word of why', async () => {
      const r = await ask({
        kind: 'new',
        objectKey: 'desk',
        title: 'A typewriter',
        prompt: 'Type letters.',
      });
      const id = r.json().id;
      const note = await req('POST', `/api/requests/${id}/notes`, memberCookie, {
        note: 'Clackety, please.',
      });
      expect(note.statusCode).toBe(200);
      expect((await notificationsOf(architectCookie)).notifications[0].title).toBe(
        'More about: A typewriter',
      );
      expect(
        (await req('POST', `/api/requests/${id}/decline`, architectCookie, {})).statusCode,
      ).toBe(400);
      await req('POST', `/api/requests/${id}/decline`, architectCookie, {
        note: 'The desk is for work.',
      });
      const latest = (await notificationsOf(memberCookie)).notifications[0];
      expect(latest).toMatchObject({
        title: 'Not this time: A typewriter',
        body: 'The desk is for work.',
      });
      expect((await req('POST', `/api/requests/${id}/withdraw`, memberCookie, {})).statusCode).toBe(
        409,
      );
      expect(
        (await req('POST', `/api/requests/${id}/notes`, memberCookie, { note: 'x' })).statusCode,
      ).toBe(409);
      // Marking as read.
      await req('POST', '/api/notifications/read', memberCookie, {});
      expect((await notificationsOf(memberCookie)).unread).toBe(0);
    });

    it('writes a request and its timeline together, and moves it on the same way', async () => {
      const titled = (title: string) =>
        db.select().from(schema.commissions).where(eq(schema.commissions.title, title));
      const waiting = (
        await ask({ kind: 'new', objectKey: 'desk', title: 'A desk clock', prompt: 'Tick.' })
      ).json().id as string;
      const undo = await failInsertsInto('commission_events');
      try {
        // Its timeline can't be started: the request isn't kept either.
        const lost = await ask({
          kind: 'new',
          objectKey: 'desk',
          title: 'A lamp that never was',
          prompt: 'Light.',
        });
        expect(lost.statusCode).toBe(500);
        expect(await titled('A lamp that never was')).toEqual([]);
        // Accepting can't be put in its timeline: it stays as it was, and nobody is told.
        const before = (await notificationsOf(memberCookie)).notifications.length;
        const accept = await req('POST', `/api/requests/${waiting}/accept`, architectCookie, {});
        expect(accept.statusCode).toBe(500);
        expect((await titled('A desk clock'))[0]?.status).toBe('submitted');
        expect((await notificationsOf(memberCookie)).notifications.length).toBe(before);
      } finally {
        await undo();
      }
      const events = await db
        .select()
        .from(schema.commissionEvents)
        .where(eq(schema.commissionEvents.commissionId, waiting));
      expect(events.map((e) => e.status)).toEqual(['submitted']);
      await req('POST', `/api/requests/${waiting}/withdraw`, memberCookie, {});
    });

    it('pushes to devices only through the browsers’ push services, and holds back for DND', async () => {
      const settings = (await req('GET', '/api/notifications/settings', memberCookie)).json();
      expect(settings.pushKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
      expect(settings.canEmail).toBe(true);
      const device = (endpoint: string) =>
        req('POST', '/api/notifications/devices', memberCookie, {
          endpoint,
          keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
          device: 'Phone · Android · Chrome',
        });
      for (const bad of [
        'https://127.0.0.1/push',
        'https://supervisor:45140/x',
        'http://fcm.googleapis.com/fcm/send/x',
        'https://fcm.googleapis.com.evil.test/x',
      ])
        expect((await device(bad)).statusCode, bad).toBe(400);
      expect((await device('https://fcm.googleapis.com/fcm/send/abc')).statusCode).toBe(200);
      await req('PUT', '/api/notifications/settings', memberCookie, { email: true });

      pushed.length = 0;
      mailed.length = 0;
      const r = await ask({
        kind: 'new',
        objectKey: 'rug',
        title: 'A flying carpet',
        prompt: 'Fly!',
      });
      await req('POST', `/api/requests/${r.json().id}/accept`, architectCookie, {});
      expect(pushed).toHaveLength(1);
      expect(JSON.parse(pushed[0]?.payload as string)).toMatchObject({
        title: 'Accepted: A flying carpet',
        url: `/requests/${r.json().id}`,
      });
      expect(mailed[0]).toMatchObject({
        to: 'sam@example.test',
        subject: 'Accepted: A flying carpet',
      });

      // Do Not Disturb: it waits in the list, and nothing is pushed or emailed.
      await db
        .insert(schema.userPrefs)
        .values({ userId: memberId, dnd: true })
        .onConflictDoUpdate({
          target: schema.userPrefs.userId,
          set: { dnd: true },
        });
      pushed.length = 0;
      mailed.length = 0;
      await req('POST', `/api/requests/${r.json().id}/decline`, architectCookie, {
        note: 'No flying.',
      });
      expect(pushed).toHaveLength(0);
      expect(mailed).toHaveLength(0);
      expect((await notificationsOf(memberCookie)).notifications[0].title).toBe(
        'Not this time: A flying carpet',
      );
      await db
        .update(schema.userPrefs)
        .set({ dnd: false })
        .where(eq(schema.userPrefs.userId, memberId));
    });

    it('emails only addresses their owners confirmed', async () => {
      // Someone whose address isn't confirmed (it could be anyone's) but who asked for email.
      const confirmed = (emailVerified: boolean) =>
        db.update(schema.user).set({ emailVerified }).where(eq(schema.user.id, memberId));
      await confirmed(false);
      await req('PUT', '/api/notifications/settings', memberCookie, { email: true });
      expect((await req('GET', '/api/notifications/settings', memberCookie)).json().canEmail).toBe(
        false,
      );
      pushed.length = 0;
      mailed.length = 0;
      const r = await ask({
        kind: 'new',
        objectKey: 'rug',
        title: 'A paper moon',
        prompt: 'Hang it.',
      });
      await req('POST', `/api/requests/${r.json().id}/accept`, architectCookie, {});
      expect(pushed).toHaveLength(1);
      expect(mailed).toHaveLength(0);
      await confirmed(true);
    });

    it('keeps open requests whose object goes, now about a new object in the same room', async () => {
      const [space] = await db.select().from(schema.spaces).where(eq(schema.spaces.id, spaceId));
      const [version] = await db
        .select()
        .from(schema.spaceVersions)
        .where(eq(schema.spaceVersions.id, space?.currentVersionId as string));
      const manifest = version?.manifest as SpaceManifest;
      // The next version has no rug (the paper moon above was asked for there).
      const next = {
        ...manifest,
        rooms: manifest.rooms.map((r) => ({
          ...r,
          objects: r.objects.filter((o) => o.key !== 'rug'),
        })),
      };
      const open = (key: string) =>
        db
          .select()
          .from(schema.commissions)
          .where(
            and(eq(schema.commissions.spaceId, spaceId), eq(schema.commissions.objectKey, key)),
          );
      const before = await open('rug');
      const onRug = before.filter((c) => OPEN.includes(c.status));
      const kept = await open('bookshelf');
      expect(onRug.length).toBeGreaterThan(0);
      await orphanRequests(db, spaceId, next);
      // Closed requests are history: they keep the object they were about.
      expect((await open('rug')).map((c) => c.id)).toEqual(
        before.filter((c) => !OPEN.includes(c.status)).map((c) => c.id),
      );
      expect((await open('bookshelf')).length).toBe(kept.length);
      for (const c of onRug) {
        const [row] = await db
          .select()
          .from(schema.commissions)
          .where(eq(schema.commissions.id, c.id));
        expect(row?.status).toBe(c.status);
        const events = await db
          .select()
          .from(schema.commissionEvents)
          .where(eq(schema.commissionEvents.commissionId, c.id));
        expect(events.map((e) => e.note)).toContain(
          "The rug it was for isn't in the place any more.",
        );
      }
    });
  });
});
