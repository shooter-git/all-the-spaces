// The Studio: workspaces and the assistants in them.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, schema } from '@ats/db';
import { scanForSecrets } from '@ats/qa';
import { packTar } from '@ats/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { studioTick } from '../../src/studio/timeouts.ts';
import {
  addSampleSpace,
  adminUrl,
  createTestApp,
  type Fakes,
  INSTALLED,
  seedGroup,
  type TestApp,
} from '../harness.ts';

describe.skipIf(!adminUrl)('server flows', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let db: Db;
  let storage: TestApp['storage'];
  let supervisor: TestApp['supervisor'];
  let fake: Fakes;
  let supCalls: Fakes['supCalls'];
  let instructionFiles: Fakes['instructionFiles'];
  let architectCookie = '';
  let memberCookie = '';
  let groupId = '';
  let spaceId = '';

  beforeAll(async () => {
    t = await createTestApp();
    ({ app, db, storage, supervisor } = t);
    fake = t.fake;
    ({ supCalls, instructionFiles } = t.fake);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('the Studio', () => {
    let workspaceId = '';
    const req = (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) =>
      app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

    it('is for Architects only: a member can reach none of it (C1)', async () => {
      const before = supCalls.length;
      expect((await req('GET', '/api/studio/assistants', memberCookie)).statusCode).toBe(404);
      expect((await req('GET', `/api/spaces/${spaceId}/workspaces`, memberCookie)).statusCode).toBe(
        404,
      );
      expect(
        (
          await req('POST', `/api/spaces/${spaceId}/workspaces`, memberCookie, {
            title: 'x',
            brief: 'y',
            provider: 'claude',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await req('POST', '/api/studio/assistants/claude/install', memberCookie, {})).statusCode,
      ).toBe(404);
      expect(supCalls.length).toBe(before);
    });

    it('prepares a workspace with the brief and instructions, and nothing secret', async () => {
      const res = await req('POST', `/api/spaces/${spaceId}/workspaces`, architectCookie, {
        title: 'Paper boats',
        brief: 'Fold a paper boat and float it across the rug.',
        objectKey: 'sofa',
        provider: 'claude',
      });
      expect(res.statusCode).toBe(200);
      workspaceId = res.json().id;
      const init = supCalls.findLast((c) => c.act === 'workspace.init');
      expect(init?.claims).toEqual({ ws: workspaceId });
      const files = new Map(
        Object.entries(init?.body?.files as Record<string, string>).map(([p, d]) => [
          p,
          Buffer.from(d, 'base64'),
        ]),
      );
      for (const f of [
        'BRIEF.md',
        'CLAUDE.md',
        'AGENTS.md',
        '.claude/settings.json',
        'vendor/allthespaces-portal/README.md',
      ])
        expect(files.has(f), f).toBe(true);
      expect(files.get('BRIEF.md')?.toString()).toContain('Fold a paper boat');
      expect(files.get('CLAUDE.md')?.toString()).toContain('Never publish');
      expect(scanForSecrets(files)).toEqual([]);
    });

    it('starts only an assistant the Architect installed, exactly as installed (C2)', async () => {
      const open = () => req('POST', `/api/workspaces/${workspaceId}/open`, architectCookie, {});
      const first = await open();
      expect(first.statusCode).toBe(409);
      expect(first.json().code).toBe('connect');
      const [me] = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, 'pat@example.test'));
      await db.insert(schema.assistantConnections).values({
        userId: me?.id as string,
        provider: 'claude',
        version: '1',
        binarySha256: INSTALLED,
        signedIn: true,
      });
      expect((await open()).statusCode).toBe(200);
      expect(supCalls.findLast((c) => c.act === 'sandbox.start')?.claims).toMatchObject({
        ws: workspaceId,
        sha: INSTALLED,
        p: 'claude',
      });
      expect(supCalls.some((c) => c.act === 'preview.start')).toBe(true);
      await db.update(schema.assistantConnections).set({ binarySha256: 'b'.repeat(64) });
      const changed = await open();
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe('changed');
      // Starting it later (Start, Carry on) or signing in checks it again: its program lives
      // where code in any of the Architect's sandboxes can write.
      const start = await req('POST', `/api/workspaces/${workspaceId}/type`, architectCookie, {
        what: 'start',
      });
      expect(start.statusCode).toBe(409);
      expect(start.json().code).toBe('changed');
      const signIn = await req(
        'POST',
        '/api/studio/assistants/claude/sign-in',
        architectCookie,
        {},
      );
      expect(signIn.statusCode).toBe(409);
      expect(signIn.json().error).toContain('has changed since you installed it');
      await db.update(schema.assistantConnections).set({ binarySha256: INSTALLED });
      expect((await open()).statusCode).toBe(200);
    });

    it('serves the live preview only while the workspace is still theirs, cached or not', async () => {
      fake.previewStatus = { stamp: 1_790_000_000, ok: true };
      const preview = await req('GET', `/api/workspaces/${workspaceId}/preview`, architectCookie);
      fake.previewStatus = null;
      expect(preview.json().state).toBe('ready');
      const url = new URL(preview.json().url);
      const file = () =>
        app.inject({ method: 'GET', url: url.pathname, headers: { host: url.host } });
      expect((await file()).statusCode).toBe(200);
      expect((await file()).body).toBe('preview of index.html'); // now served from the cache

      // Archived: the pass stops working, cached files included.
      const [before] = await db
        .select({ status: schema.workspaces.status })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId));
      await db
        .update(schema.workspaces)
        .set({ status: 'archived' })
        .where(eq(schema.workspaces.id, workspaceId));
      expect((await file()).statusCode).toBe(404);
      await db
        .update(schema.workspaces)
        .set({ status: before?.status })
        .where(eq(schema.workspaces.id, workspaceId));
      expect((await file()).statusCode).toBe(200);

      // No longer an Architect: the same.
      const [pat] = await db
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(eq(schema.user.email, 'pat@example.test'));
      const architect = and(
        eq(schema.memberships.userId, pat?.id as string),
        eq(schema.memberships.organizationId, groupId),
      );
      await db.update(schema.memberships).set({ role: 'member' }).where(architect);
      expect((await file()).statusCode).toBe(404);
      await db.update(schema.memberships).set({ role: 'architect' }).where(architect);
      expect((await file()).statusCode).toBe(200);
    });

    it('gives a workspace the whole internet only when its group chooses that', async () => {
      const settings = (path: string, method: 'GET' | 'PUT', payload?: object) =>
        app.inject({
          method,
          url: path,
          headers: { cookie: architectCookie },
          ...(payload ? { payload } : {}),
        });
      const path = `/api/groups/${groupId}/studio-settings`;
      const current = (await settings(path, 'GET')).json();
      expect(current.openInternet).toBe(false);
      const open = async () => {
        await app.inject({
          method: 'POST',
          url: `/api/workspaces/${workspaceId}/open`,
          headers: { cookie: architectCookie },
          payload: {},
        });
        return supCalls.findLast((c) => c.act === 'sandbox.start')?.claims.net;
      };
      expect(await open()).toBe('limited');
      expect((await settings(path, 'PUT', { ...current, openInternet: true })).statusCode).toBe(
        200,
      );
      expect(await open()).toBe('open');
      // Members can't change it.
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: path,
            headers: { cookie: memberCookie },
            payload: { ...current, openInternet: true },
          })
        ).statusCode,
      ).not.toBe(200);
      expect((await settings(path, 'PUT', { ...current, openInternet: false })).statusCode).toBe(
        200,
      );
      expect(await open()).toBe('limited');
    });

    it('brings the platform’s instructions up to date each time a workspace opens', async () => {
      const open = () =>
        app.inject({
          method: 'POST',
          url: `/api/workspaces/${workspaceId}/open`,
          headers: { cookie: architectCookie },
          payload: {},
        });
      // A workspace from before: its instructions are replaced, and the old ones kept aside.
      instructionFiles.set(`${workspaceId}/CLAUDE.md`, Buffer.from('# Boats\n\nOld advice.\n'));
      expect((await open()).statusCode).toBe(200);
      const claude = instructionFiles.get(`${workspaceId}/CLAUDE.md`)?.toString() ?? '';
      expect(claude).toMatch(/^<!-- All the Spaces: kept up to date/);
      expect(claude).toContain('# Boats');
      expect(claude).toContain('ats model build');
      expect(instructionFiles.get(`${workspaceId}/.ats/CLAUDE.md.before-update`)?.toString()).toBe(
        '# Boats\n\nOld advice.\n',
      );
      expect(instructionFiles.get(`${workspaceId}/AGENTS.md`)?.toString()).toContain(
        'ats model build',
      );
      // Notes added below the platform's part stay; nothing is set aside again.
      instructionFiles.set(
        `${workspaceId}/CLAUDE.md`,
        Buffer.from(`${claude}\n## Notes\n\nKeep the boats blue.\n`),
      );
      instructionFiles.delete(`${workspaceId}/.ats/CLAUDE.md.before-update`);
      expect((await open()).statusCode).toBe(200);
      expect(instructionFiles.get(`${workspaceId}/CLAUDE.md`)?.toString()).toContain(
        'Keep the boats blue.',
      );
      expect(instructionFiles.has(`${workspaceId}/.ats/CLAUDE.md.before-update`)).toBe(false);
    });

    it('types suggested prompts without sending them: the Architect presses Enter (C9)', async () => {
      const type = (payload: object) =>
        req('POST', `/api/workspaces/${workspaceId}/type`, architectCookie, payload);
      await type({ what: 'prompt', text: 'Make the boats sway.' });
      expect(supCalls.findLast((c) => c.act === 'sandbox.type')?.body).toEqual({
        text: 'Make the boats sway.',
      });
      // Starting the assistant isn't typed at all: it's started as the terminal's program, so
      // it can never reach a running assistant as a message.
      const typed = supCalls.filter((c) => c.act === 'sandbox.type').length;
      await type({ what: 'start' });
      const launched = supCalls.findLast((c) => c.act === 'sandbox.launch');
      expect(launched?.body).toEqual({ command: 'claude' });
      // Only as installed (C2): the supervisor checks the program against this first.
      expect(launched?.claims).toMatchObject({ ws: workspaceId, p: 'claude', sha: INSTALLED });
      expect(supCalls.filter((c) => c.act === 'sandbox.type').length).toBe(typed);
      // The assistant's sign-in likewise.
      await req('POST', '/api/studio/assistants/claude/sign-in', architectCookie, {});
      const signIn = supCalls.findLast((c) => c.act === 'connect.launch');
      expect(signIn?.body).toEqual({ command: 'claude' });
      expect(signIn?.claims).toMatchObject({ p: 'claude', sha: INSTALLED });
      expect(supCalls.some((c) => c.act === 'connect.type')).toBe(false);
      // The checks run directly, never typed.
      const checks = await req('POST', `/api/workspaces/${workspaceId}/check`, architectCookie, {});
      expect(checks.json()).toEqual({
        ok: false,
        problems: [
          { status: 'fail', title: 'The screen is blank', where: null, fix: 'Draw something' },
        ],
        passed: 0,
      });
      expect(supCalls.findLast((c) => c.act === 'sandbox.check')?.claims).toEqual({
        ws: workspaceId,
      });
      expect((await type({ what: 'check' })).statusCode).toBe(400);
      // There's no way to send free text with Enter.
      await type({ what: 'prompt', text: 'rm -rf /\n', enter: true });
      expect(supCalls.findLast((c) => c.act === 'sandbox.type')?.body).toEqual({
        text: 'rm -rf /\n',
      });
    });

    it('adds any file to a creation’s workspace, as it is, and pastes its path', async () => {
      const add = (
        name: string,
        payload: string | Buffer,
        type: string,
        cookie = architectCookie,
      ) =>
        app.inject({
          method: 'PUT',
          url: `/api/workspaces/${workspaceId}/uploads/${name}`,
          headers: { cookie, 'content-type': type },
          payload,
        });
      // A JSON file is a file here, not a request body to read.
      const level = '{"level": 1, "rm -rf": "/"}';
      const res = await add('Level%201.json', level, 'application/json');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ path: 'uploads/level-1.json', typed: true, input: null });
      const written = supCalls.findLast((c) => c.act === 'workspace.upload')?.body as {
        name: string;
        data: string;
      };
      expect(written.name).toBe('level-1.json');
      expect(Buffer.from(written.data, 'base64').toString()).toBe(level);
      expect(supCalls.findLast((c) => c.act === 'sandbox.paste')?.body).toEqual({
        text: '@uploads/level-1.json ',
      });
      // Codex takes the path as it is (its @ opens a file picker).
      await db
        .update(schema.workspaces)
        .set({ provider: 'codex' })
        .where(eq(schema.workspaces.id, workspaceId));
      await add('sketch.txt', 'x', 'text/plain');
      expect(supCalls.findLast((c) => c.act === 'sandbox.paste')?.body).toEqual({
        text: 'uploads/sketch.txt ',
      });
      await db
        .update(schema.workspaces)
        .set({ provider: 'claude' })
        .where(eq(schema.workspaces.id, workspaceId));
      // Names can't climb out of uploads/.
      expect((await add('..%2F..%2Fetc%2Fpasswd', 'x', 'text/plain')).json().path).toBe(
        'uploads/etc-passwd',
      );
      expect(
        (await add('a.bin', Buffer.alloc(26 * 1024 * 1024), 'application/zip')).statusCode,
      ).toBe(413);
      // A .zip is unpacked whole (a creation takes anything); a Word document stays as it is.
      const { zipSync } = await import('fflate');
      const pack = Buffer.from(
        zipSync({
          'sounds/README.md': Buffer.from('jump'),
          'sounds/jump.ogg': Buffer.from('OggS'),
        }),
      );
      expect((await add('sounds.zip', pack, 'application/zip')).json()).toEqual({
        path: 'uploads/sounds/',
        typed: true,
        input: null,
        files: 2,
        left: [],
        positioned: 0,
      });
      expect((await add('notes.docx', pack, 'application/octet-stream')).json().path).toBe(
        'uploads/notes.docx',
      );
      expect((await add('a.txt', 'x', 'text/plain', memberCookie)).statusCode).toBe(404);

      // What's been added, and naming one in the terminal again (pasted, not sent).
      const list = (cookie: string) =>
        app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspaceId}/uploads`,
          headers: { cookie },
        });
      expect((await list(architectCookie)).json()).toEqual({
        files: [{ name: 'level-1.json', bytes: 27, at: 1_790_000_000 }],
      });
      expect((await list(memberCookie)).statusCode).toBe(404);

      // What the assistant made or changed: names only, for its Architect only.
      const changes = (cookie: string) =>
        app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspaceId}/files`,
          headers: { cookie },
        });
      const seen = await changes(architectCookie);
      expect(seen.json()).toEqual({
        files: [
          { path: 'src/main.ts', change: 'changed' },
          { path: 'src/scenes/level.ts', change: 'added' },
        ],
        more: false,
      });
      expect(seen.headers['cache-control']).toBe('private, no-store');
      expect(supCalls.findLast((c) => c.act === 'workspace.changes')?.claims).toMatchObject({
        ws: workspaceId,
      });
      expect((await changes(memberCookie)).statusCode).toBe(404);

      // A file's contents, to look at: text, or a picture. Only for its Architect.
      fake.workspaceFiles.set('src/main.ts', Buffer.from('export const speed = 3;\n'));
      fake.workspaceFiles.set(
        'models/robot.glb',
        Buffer.from([0x67, 0x6c, 0x54, 0x46, 0, 0, 0, 2]),
      );
      const view = (path: string, cookie = architectCookie) =>
        app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspaceId}/files/view?path=${encodeURIComponent(path)}`,
          headers: { cookie },
        });
      const shown = await view('src/main.ts');
      expect(shown.json()).toEqual({
        path: 'src/main.ts',
        bytes: 24,
        kind: 'text',
        text: 'export const speed = 3;\n',
      });
      expect(shown.headers['cache-control']).toBe('private, no-store');
      expect(supCalls.findLast((c) => c.act === 'workspace.view')?.body).toEqual({
        path: 'src/main.ts',
      });
      expect((await view('models/robot.glb')).statusCode).toBe(415);
      expect((await view('huge.png')).statusCode).toBe(413);
      expect((await view('gone.ts')).statusCode).toBe(404);
      const asked = supCalls.filter((c) => c.act === 'workspace.view').length;
      for (const path of ['../../etc/passwd', '.git/config', '/etc/passwd'])
        expect((await view(path)).statusCode).toBe(404);
      expect((await view('src/main.ts', memberCookie)).statusCode).toBe(404);
      expect(supCalls.filter((c) => c.act === 'workspace.view').length).toBe(asked);
      const again = (name: string, cookie = architectCookie) =>
        app.inject({
          method: 'POST',
          url: `/api/workspaces/${workspaceId}/uploads/${name}/mention`,
          headers: { cookie },
        });
      expect((await again('level-1.json')).json()).toEqual({ typed: true });
      expect(supCalls.findLast((c) => c.act === 'sandbox.paste')?.body).toEqual({
        text: '@uploads/level-1.json ',
      });
      const pastes = supCalls.filter((c) => c.act === 'sandbox.paste').length;
      expect((await again('..%2Fsecrets')).statusCode).toBe(404);
      expect((await again('a%0Arm%20-rf')).statusCode).toBe(404);
      expect((await again('level-1.json', memberCookie)).statusCode).toBe(404);
      expect(supCalls.filter((c) => c.act === 'sandbox.paste').length).toBe(pastes);

      // Removing one: only that file, only by its plain name, only by its Architect.
      const remove = (name: string, cookie = architectCookie) =>
        app.inject({
          method: 'DELETE',
          url: `/api/workspaces/${workspaceId}/uploads/${name}`,
          headers: { cookie },
        });
      expect((await remove('level-1.json')).json()).toEqual({ ok: true });
      expect(supCalls.findLast((c) => c.act === 'workspace.unupload')?.body).toEqual({
        name: 'level-1.json',
      });
      const removals = supCalls.filter((c) => c.act === 'workspace.unupload').length;
      expect((await remove('..%2F..%2Fsrc')).statusCode).toBe(404);
      expect((await remove('*')).statusCode).toBe(404);
      expect((await remove('level-1.json', memberCookie)).statusCode).toBe(404);
      expect(supCalls.filter((c) => c.act === 'workspace.unupload').length).toBe(removals);
    });

    it("starts the assistant with the model and effort chosen for it, or the group's", async () => {
      const type = async (what: 'start' | 'resume') => {
        await req('POST', `/api/workspaces/${workspaceId}/type`, architectCookie, { what });
        const launched = supCalls.findLast((c) => c.act === 'sandbox.launch')?.body as
          | { command: string }
          | undefined;
        return launched?.command;
      };
      const choose = (body: object) =>
        req('POST', `/api/workspaces/${workspaceId}/assistant`, architectCookie, body);
      expect((await choose({ model: 'claude-opus-5-5', effort: 'max' })).statusCode).toBe(200);
      expect(await type('start')).toBe('claude --model claude-opus-5-5 --effort max');
      expect(await type('resume')).toBe('claude --continue --model claude-opus-5-5 --effort max');
      const detail = (await req('GET', `/api/workspaces/${workspaceId}`, architectCookie)).json();
      expect(detail.runsWith).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
      // Nothing that isn't a model name gets near the command line; an effort the assistant
      // doesn't have is ignored.
      expect((await choose({ model: 'opus; rm -rf ~', effort: null })).statusCode).toBe(400);
      await choose({ model: 'claude-sonnet-5', effort: 'ultra' });
      expect(await type('start')).toBe('claude --model claude-sonnet-5');
      // With nothing chosen, the group's defaults.
      await choose({ model: null, effort: null });
      const url = `/api/groups/${groupId}/studio-settings`;
      const settings = (await req('GET', url, architectCookie)).json();
      await app.inject({
        method: 'PUT',
        url,
        headers: { cookie: architectCookie },
        payload: { ...settings, claudeModel: 'claude-fable-5-1', claudeEffort: 'xhigh' },
      });
      expect(await type('start')).toBe('claude --model claude-fable-5-1 --effort xhigh');
      await app.inject({
        method: 'PUT',
        url,
        headers: { cookie: architectCookie },
        payload: { ...settings },
      });
      expect(await type('start')).toBe('claude');
    });

    it('keeps a workspace to the Architect whose assistant runs in it', async () => {
      // Make the member an Architect too, for a moment: still not their workspace.
      const members = await db
        .select({ userId: schema.memberships.userId })
        .from(schema.memberships)
        .where(eq(schema.memberships.role, 'member'));
      await db
        .update(schema.memberships)
        .set({ role: 'architect' })
        .where(eq(schema.memberships.role, 'member'));
      try {
        expect((await req('GET', `/api/workspaces/${workspaceId}`, memberCookie)).statusCode).toBe(
          404,
        );
        expect(
          (
            await req('POST', `/api/workspaces/${workspaceId}/type`, memberCookie, {
              what: 'start',
            })
          ).statusCode,
        ).toBe(404);
        const list = await req('GET', `/api/spaces/${spaceId}/workspaces`, memberCookie);
        expect(
          list.json().workspaces.find((w: { id: string }) => w.id === workspaceId),
        ).toMatchObject({ mine: false });
      } finally {
        for (const m of members)
          await db
            .update(schema.memberships)
            .set({ role: 'member' })
            .where(eq(schema.memberships.userId, m.userId));
      }
    });

    it('refuses to publish a workspace holding secrets, and stores nothing', async () => {
      fake.workspaceArchive = packTar(
        new Map([
          ['index.html', new TextEncoder().encode('<p>boats</p>')],
          ['ats.json', new TextEncoder().encode('{"title":"Paper boats"}')],
          ['src/key.ts', new TextEncoder().encode(`export const k = "sk-ant-${'z'.repeat(40)}";`)],
        ]),
      );
      const stored = [...storage.objects.keys()].length;
      const res = await req('POST', `/api/workspaces/${workspaceId}/publish`, architectCookie, {
        live: true,
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().secrets[0]).toMatchObject({
        path: 'src/key.ts',
        kind: 'an Anthropic key or sign-in token',
      });
      expect(JSON.stringify(res.json())).not.toContain('zzzz');
      expect([...storage.objects.keys()].length).toBe(stored);
    });

    it('keeps a workspace awake while the assistant is at work, though nobody types', async () => {
      await db
        .update(schema.workspaces)
        .set({
          status: 'running',
          startedAt: new Date(),
          lastActivityAt: new Date(Date.now() - 3 * 3600_000),
        })
        .where(eq(schema.workspaces.id, workspaceId));
      fake.assistantPrintedAt = Math.floor(Date.now() / 1000) - 60; // printed a minute ago
      await studioTick(db, supervisor);
      const [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId));
      expect(ws?.status).toBe('running');
      // The assistant's work isn't the Architect being there.
      expect(ws?.lastActivityAt?.getTime()).toBeLessThan(Date.now() - 2 * 3600_000);
      fake.assistantPrintedAt = null;
    });

    it('never cuts the Architect short at the time limit while they’re there', async () => {
      await db
        .update(schema.workspaces)
        .set({
          status: 'running',
          startedAt: new Date(Date.now() - 9 * 3600_000), // past the 4-hour limit
          lastActivityAt: new Date(Date.now() - 60_000), // their page said so a minute ago
        })
        .where(eq(schema.workspaces.id, workspaceId));
      await studioTick(db, supervisor);
      const [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId));
      expect(ws?.status).toBe('running');
      // Their page sees when it'd go to sleep if they stepped away now.
      const detail = await req('GET', `/api/workspaces/${workspaceId}`, architectCookie);
      const sleeps = Date.parse(detail.json().sleepsAt) - Date.now();
      expect(sleeps).toBeGreaterThan(10 * 60_000);
      expect(sleeps).toBeLessThan(15 * 60_000);
    });

    it('says the Architect is here only for an awake workspace that’s theirs', async () => {
      const long = new Date(Date.now() - 3 * 3600_000);
      await db
        .update(schema.workspaces)
        .set({ status: 'running', startedAt: long, lastActivityAt: long })
        .where(eq(schema.workspaces.id, workspaceId));
      expect(
        (await req('POST', `/api/workspaces/${workspaceId}/here`, memberCookie)).statusCode,
      ).toBe(404);
      let [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId));
      expect(ws?.lastActivityAt?.getTime()).toBe(long.getTime());
      const res = await req('POST', `/api/workspaces/${workspaceId}/here`, architectCookie);
      expect(res.statusCode).toBe(200);
      [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      expect(Date.now() - (ws?.lastActivityAt?.getTime() ?? 0)).toBeLessThan(5000);
      await studioTick(db, supervisor);
      [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      expect(ws?.status).toBe('running');
    });

    it('puts a workspace to sleep at the time limit once the Architect has stepped away', async () => {
      await db
        .update(schema.workspaces)
        .set({
          status: 'running',
          startedAt: new Date(Date.now() - 5 * 3600_000),
          lastActivityAt: new Date(Date.now() - 20 * 60_000),
        })
        .where(eq(schema.workspaces.id, workspaceId));
      // However busy the assistant is.
      fake.assistantPrintedAt = Math.floor(Date.now() / 1000) - 10;
      await studioTick(db, supervisor);
      const [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId));
      expect(ws).toMatchObject({ status: 'stopped', stoppedBecause: 'time-limit' });
      fake.assistantPrintedAt = null;
    });

    it('puts a workspace to sleep when nobody has typed and the assistant is quiet', async () => {
      await db
        .update(schema.workspaces)
        .set({
          status: 'running',
          startedAt: new Date(),
          lastActivityAt: new Date(Date.now() - 3 * 3600_000),
        })
        .where(eq(schema.workspaces.id, workspaceId));
      // It last printed long ago (waiting at its prompt).
      fake.assistantPrintedAt = Math.floor(Date.now() / 1000) - 3 * 3600;
      await studioTick(db, supervisor);
      const [ws] = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId));
      expect(ws).toMatchObject({ status: 'stopped', stoppedBecause: 'idle' });
      expect(supCalls.findLast((c) => c.act === 'sandbox.stop')?.claims).toEqual({
        ws: workspaceId,
      });
      fake.assistantPrintedAt = null;
    });
  });
});
