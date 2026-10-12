// Where creations may come from, as the server's owner sets it in the Studio (ADR 0012): only the
// owner sees or changes it, every change is checked and recorded, it counts straight away, and
// anything allowed there (or by "*") is read as a public repository only, never with a token.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '@ats/db';
import { BUILT_IN_GITHUB, parseSourceHostDefinition } from '@ats/shared';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handServerTo } from '../../src/owner.ts';
import { forgetAllowances } from '../../src/sources/github.ts';
import { BUILT_IN_GITHUB_DEF, sourceHostsOf } from '../../src/sources/registry.ts';
import {
  addSampleSpace,
  adminUrl,
  cookieFrom,
  createTestApp,
  seedGroup,
  type TestApp,
} from '../harness.ts';

const TOKEN = 'ghs_owner-token-for-tests';
const C1 = '1'.repeat(40);

interface Fake {
  port: number;
  /** Repositories, and whether each is private. */
  repos: Record<string, boolean>;
  seen: { path: string; token: boolean }[];
  close(): Promise<void>;
}

function tarball() {
  const dir = mkdtempSync(join(tmpdir(), 'gh-owner-'));
  const top = 'open-club-lantern-toss-1111111';
  const files = {
    'ats.json': JSON.stringify({ title: 'Lantern toss', sessionMode: 'solo' }),
    'index.html': '<!doctype html><script type="module" src="./main.js"></script>',
    'main.js': 'console.log("toss")',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, top, path, '..'), { recursive: true });
    writeFileSync(join(dir, top, path), text);
  }
  return execFileSync('tar', ['--format=pax', '-czf', '-', top], { cwd: dir });
}

async function startFake(): Promise<Fake> {
  const fake = {
    repos: {
      'open-club/lantern-toss': false,
      'open-club/secret': true,
      'lanternfield-club/marble-run': true,
    },
    seen: [],
  } as unknown as Fake;
  const gz = tarball();
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const token = req.headers.authorization === `Bearer ${TOKEN}`;
    fake.seen.push({ path, token });
    if (path.startsWith('/archive/')) {
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      res.end(gz);
      return;
    }
    const m = /^\/repos\/([^/]+\/[^/]+)(?:\/(.+))?$/.exec(path);
    const name = m?.[1] ?? '';
    const isPrivate = fake.repos[name];
    // As GitHub does: a private repository doesn't exist for anyone without a token for it.
    if (isPrivate === undefined || (isPrivate && !token))
      return send(res, 404, { message: 'Not Found' });
    const rest = m?.[2];
    if (!rest)
      return send(res, 200, {
        full_name: name,
        private: isPrivate,
        visibility: isPrivate ? 'private' : 'public',
      });
    if (rest === 'releases/latest') return send(res, 200, { tag_name: 'v1' });
    if (rest.startsWith('commits/'))
      return send(res, 200, { sha: C1, commit: { message: 'First toss' } });
    if (rest.startsWith('tarball/')) {
      res.writeHead(302, { location: `http://127.0.0.1:${fake.port}/archive/${C1}` });
      res.end();
      return;
    }
    send(res, 404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.port = (server.address() as AddressInfo).port;
  fake.close = () => new Promise((r) => server.close(() => r()));
  return fake;
}

describe.skipIf(!adminUrl)('where creations may come from, set by the server’s owner', () => {
  let t: TestApp;
  let gh: Fake;
  let groupId: string;
  let spaceId: string;
  let ownerCookie: string;
  let architectCookie: string;
  let memberCookie: string;
  const req = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    cookie: string | null,
    payload?: object,
  ) =>
    t.app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(payload ? { payload } : {}),
    });
  const change = (hosts: object[], cookie: string | null = ownerCookie) =>
    req('PUT', '/api/server/sources', cookie, { hosts });
  const fromRepository = (host: string, repository: string, objectKey = 'rug') =>
    req('POST', `/api/spaces/${spaceId}/creations/from-repository`, architectCookie, {
      objectKey,
      host,
      repository,
    });

  beforeAll(async () => {
    forgetAllowances();
    gh = await startFake();
    const api = `http://127.0.0.1:${gh.port}`;
    const def = parseSourceHostDefinition({
      id: 'github',
      displayName: 'Our GitHub',
      kind: 'github',
      tokenEnv: 'ATS_SOURCE_GITHUB_TOKEN',
      repositories: ['lanternfield-club/*'],
      archiveHosts: ['127.0.0.1'],
      allowPrivateAddress: true,
    });
    t = await createTestApp({
      sourceHosts: sourceHostsOf([{ def: { ...def, apiUrl: api }, token: TOKEN }], {
        // The built-in GitHub host, pointed at the fake.
        builtIn: {
          ...BUILT_IN_GITHUB_DEF,
          apiUrl: api,
          archiveHosts: ['127.0.0.1'],
          allowPrivateAddress: true,
        },
      }),
      buildQueue: { add: async () => {}, close: async () => {} } as unknown as Queue,
    });
    // Pat finishes setup with the setup code: the server's owner.
    ({ groupId, architectCookie: ownerCookie, memberCookie } = await seedGroup(t));
    // Another Architect of the group, who isn't.
    const link = await req('POST', `/api/groups/${groupId}/invite-links`, ownerCookie, {
      role: 'architect',
      maxUses: 1,
    });
    const token = new URL(link.json().url).hash.slice(1);
    const joined = await t.signUp('robin@example.test', token);
    architectCookie = cookieFrom(joined.headers);
    expect((await req('POST', '/api/invites/accept', architectCookie, { token })).statusCode).toBe(
      200,
    );
    spaceId = await addSampleSpace(t, ownerCookie, groupId);
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    await gh?.close();
  });

  it('knows who runs the server: whoever finished setup', async () => {
    expect((await req('GET', '/api/server', ownerCookie)).json().owner).toEqual({
      name: 'Pat',
      you: true,
    });
    expect((await req('GET', '/api/server', architectCookie)).json().owner).toEqual({
      name: 'Pat',
      you: false,
    });
  });

  it('lets only the owner see or change it, not the group’s other Architects', async () => {
    expect((await req('GET', '/api/server/sources', ownerCookie)).statusCode).toBe(200);
    for (const [cookie, status] of [
      [architectCookie, 403],
      [memberCookie, 403],
      [null, 401],
    ] as const) {
      expect((await req('GET', '/api/server/sources', cookie)).statusCode).toBe(status);
      const put = await change([{ id: BUILT_IN_GITHUB, on: true, repositories: ['*'] }], cookie);
      expect(put.statusCode).toBe(status);
    }
    // Nothing changed.
    expect((await req('GET', '/api/server/sources', ownerCookie)).json().hosts[0].on).toBe(false);
  });

  it('starts with the built-in GitHub off, so nothing more is allowed', async () => {
    const res = await req('GET', '/api/server/sources', ownerCookie);
    expect(res.json().hosts).toEqual([
      {
        id: BUILT_IN_GITHUB,
        displayName: 'GitHub',
        from: 'built-in',
        on: false,
        address: `127.0.0.1:${gh.port}`,
        fileRepositories: [],
        token: false,
        repositories: [],
      },
      {
        id: 'github',
        displayName: 'Our GitHub',
        from: 'file',
        on: true,
        address: `127.0.0.1:${gh.port}`,
        fileRepositories: ['lanternfield-club/*'],
        token: true,
        repositories: [],
      },
    ]);
    // The token itself, and where it's kept, are never shown.
    expect(res.body).not.toContain(TOKEN);
    expect(res.body).not.toContain('ATS_SOURCE');
    expect((await req('GET', '/api/sources', architectCookie)).json()).toEqual([
      { id: 'github', displayName: 'Our GitHub', repositories: ['lanternfield-club/*'] },
    ]);
    const off = await fromRepository(BUILT_IN_GITHUB, 'open-club/lantern-toss');
    expect(off.statusCode).toBe(422);
    expect(off.json().error).toMatch(/GitHub is switched off/);
  });

  it('checks every change, and changes nothing a file decides', async () => {
    const refusals: [object[], RegExp][] = [
      [[{ id: BUILT_IN_GITHUB, on: true, repositories: ['x/..'] }], /isn't a repository/],
      [[{ id: BUILT_IN_GITHUB, on: true, repositories: ['*/*'] }], /isn't a repository/],
      [[{ id: BUILT_IN_GITHUB, on: true, repositories: ['owner'] }], /isn't a repository/],
      [[{ id: 'gitlab', repositories: ['a/b'] }], /no repository host called "gitlab"/],
      [[{ id: 'github', on: false, repositories: [] }], /removing its file/],
      [
        [
          { id: 'github', repositories: [] },
          { id: 'github', repositories: ['a/b'] },
        ],
        /Each host once/,
      ],
      [
        [
          {
            id: BUILT_IN_GITHUB,
            on: true,
            repositories: Array.from({ length: 101 }, (_, i) => `o/r${i}`),
          },
        ],
        /At most 100/,
      ],
      // Tokens, addresses and private networks are for files only.
      [[{ id: 'github', repositories: [], tokenEnv: 'ATS_SOURCE_X' }], /missing or invalid/],
      [[{ id: 'github', repositories: [], apiUrl: 'https://evil.test' }], /missing or invalid/],
      [[{ id: 'github', repositories: [], allowPrivateAddress: true }], /missing or invalid/],
      [[{ id: BUILT_IN_GITHUB, on: true, repositories: ['*'], token: 'x' }], /missing or invalid/],
    ];
    for (const [hosts, words] of refusals) {
      const res = await change(hosts);
      expect(res.statusCode, JSON.stringify(hosts)).toBe(400);
      expect(res.json().error).toMatch(words);
    }
    expect((await req('GET', '/api/server/sources', ownerCookie)).json().hosts[0]).toMatchObject({
      on: false,
      repositories: [],
    });
  });

  it('switched on for any public repository, counts straight away, without a token', async () => {
    const res = await change([
      { id: BUILT_IN_GITHUB, on: true, repositories: ['*', ' * ', 'open-club/*', ''] },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().hosts[0]).toMatchObject({ on: true, repositories: ['*', 'open-club/*'] });
    expect((await req('GET', '/api/sources', architectCookie)).json()).toContainEqual({
      id: BUILT_IN_GITHUB,
      displayName: 'GitHub',
      repositories: ['*', 'open-club/*'],
    });
    gh.seen.length = 0;
    const made = await fromRepository(BUILT_IN_GITHUB, 'open-club/lantern-toss');
    expect(made.statusCode).toBe(200);
    expect(made.json()).toMatchObject({ commit: C1, label: 'v1' });
    expect(gh.seen.length).toBeGreaterThan(0);
    expect(gh.seen.some((s) => s.token)).toBe(false);
    // It asked whether the repository is public, before looking and before fetching.
    expect(gh.seen.filter((s) => s.path === '/repos/open-club/lantern-toss')).toHaveLength(2);
  });

  it('never reads a private repository through it, and never says whether one exists', async () => {
    const said = async (host: string, repository: string) => {
      const res = await fromRepository(host, repository, 'bed');
      expect(res.statusCode).toBe(422);
      return res.json().error as string;
    };
    gh.seen.length = 0;
    expect(await said(BUILT_IN_GITHUB, 'open-club/secret')).toBe(
      "GitHub says open-club/secret doesn't exist, or isn't public.",
    );
    expect(await said(BUILT_IN_GITHUB, 'open-club/nothing-here')).toBe(
      "GitHub says open-club/nothing-here doesn't exist, or isn't public.",
    );
    // Not even one the server's token could read: the built-in host never has the token.
    expect(await said(BUILT_IN_GITHUB, 'lanternfield-club/marble-run')).toBe(
      "GitHub says lanternfield-club/marble-run doesn't exist, or isn't public.",
    );
    expect(gh.seen.some((s) => s.token)).toBe(false);
  });

  it('adds repositories to a host in a file as public ones only, keeping the token for its own', async () => {
    expect(
      (await change([{ id: 'github', repositories: ['open-club/*', '*'] }])).json().hosts[1],
    ).toMatchObject({
      fileRepositories: ['lanternfield-club/*'],
      repositories: ['open-club/*', '*'],
    });
    gh.seen.length = 0;
    // The host has a token that could read it, but what was added here never uses it.
    const secret = await fromRepository('github', 'open-club/secret', 'bed');
    expect(secret.json().error).toBe(
      "Our GitHub says open-club/secret doesn't exist, or isn't public.",
    );
    expect(gh.seen.some((s) => s.token)).toBe(false);
    // What the file names still does.
    gh.seen.length = 0;
    const own = await fromRepository('github', 'lanternfield-club/marble-run', 'bed');
    expect(own.statusCode).toBe(200);
    expect(gh.seen.filter((s) => s.path.startsWith('/repos/')).every((s) => s.token)).toBe(true);
    // Emptied, it's as the file says again.
    await change([{ id: 'github', repositories: [] }]);
    expect((await req('GET', '/api/sources', architectCookie)).json()).toContainEqual({
      id: 'github',
      displayName: 'Our GitHub',
      repositories: ['lanternfield-club/*'],
    });
  });

  it('records every change for the group’s Architects to see', async () => {
    const rows = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'server.sources_changed'));
    // Only the accepted changes.
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.groupId === groupId)).toBe(true);
    expect(rows[0]?.metadata).toEqual({
      hosts: [{ id: BUILT_IN_GITHUB, on: true, repositories: ['*', 'open-club/*'] }],
    });
    const activity = await req('GET', `/api/groups/${groupId}/activity`, architectCookie);
    expect(
      activity
        .json()
        .entries.filter((e: { action: string }) => e.action === 'server.sources_changed'),
    ).toHaveLength(3);
  });

  it('switched off, stops at once: a creation following it says why', async () => {
    const [made] = await t.db
      .select()
      .from(schema.builds)
      .where(sql`${schema.builds.source}->>'host' = ${BUILT_IN_GITHUB}`);
    expect(made).toBeDefined();
    await change([{ id: BUILT_IN_GITHUB, on: false, repositories: ['*'] }]);
    // Its list is kept for when it's switched on again.
    expect((await req('GET', '/api/server/sources', ownerCookie)).json().hosts[0]).toMatchObject({
      on: false,
      repositories: ['*'],
    });
    const again = await fromRepository(BUILT_IN_GITHUB, 'open-club/lantern-toss', 'bed');
    expect(again.json().error).toMatch(/GitHub is switched off/);
    expect(
      (await req('GET', '/api/sources', architectCookie))
        .json()
        .some((h: { id: string }) => h.id === BUILT_IN_GITHUB),
    ).toBe(false);
  });

  it('gives a server set up before owners existed the account that finished setup', async () => {
    await t.db.update(schema.installState).set({ ownerUserId: null });
    const migration = readFileSync(
      new URL(
        '../../../../packages/db/migrations/0001_server_owner_and_sources.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const backfill = migration
      .split('--> statement-breakpoint')
      .find((s) => s.includes('UPDATE "install_state"'));
    await t.db.execute(sql.raw(backfill as string));
    expect((await req('GET', '/api/server', ownerCookie)).json().owner.you).toBe(true);
  });

  it('is handed to another Architect only from the server itself, never to a member', async () => {
    await expect(handServerTo(t.db, 'sam@example.test')).rejects.toThrow(
      /isn't one of a group's Architects/,
    );
    await expect(handServerTo(t.db, 'nobody@example.test')).rejects.toThrow(/no account/);
    const who = await handServerTo(t.db, ' ROBIN@example.test ');
    expect(who.email).toBe('robin@example.test');
    expect((await req('GET', '/api/server', architectCookie)).json().owner).toEqual({
      name: 'Visitor',
      you: true,
    });
    // Pat runs the group still, but no longer the server.
    expect((await req('GET', '/api/server/sources', ownerCookie)).statusCode).toBe(403);
    expect((await req('GET', '/api/server/sources', architectCookie)).statusCode).toBe(200);
    const [handed] = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'server.owner_changed'));
    expect(handed).toMatchObject({ groupId, actorUserId: null, target: who.id });
  });
});
