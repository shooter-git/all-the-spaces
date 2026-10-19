// Creations from repositories (ADR 0011), against a fake GitHub on this machine: linking, making a
// new creation from a repository, looking for what's newer, updating, and everything refused.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schema } from '@ats/db';
import { parseSourceHostDefinition } from '@ats/shared';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadSourceFiles } from '../../src/creations/sources.ts';
import { publishCreation } from '../../src/creations/store.ts';
import type { Notice } from '../../src/notify.ts';
import { sourceCheckTick } from '../../src/sources/checks.ts';
import { type SourceHostRegistry, sourceHostsOf } from '../../src/sources/registry.ts';
import { recordSourceBuild } from '../../src/sources/service.ts';
import {
  addSampleSpace,
  addSofaCreation,
  adminUrl,
  createTestApp,
  seedGroup,
  type TestApp,
} from '../harness.ts';

const TOKEN = 'ghs_read-only-token-for-tests';
const sha = (n: number) => String(n).repeat(40).slice(0, 40);
const C1 = sha(1);
const C2 = sha(2);
const C3 = sha(3);
const LEAKY = sha(4);
const EMPTY = sha(5);
const C6 = sha(6);

interface FakeGitHub {
  port: number;
  release: { tag: string; commit: string };
  /** Every request: path, and whether it carried the token. */
  seen: { path: string; token: boolean }[];
  /** Where the archive redirect points (to test a host the definition doesn't allow). */
  archiveHost: string;
  close(): Promise<void>;
}

/** A gzipped tar the way GitHub makes them: one top folder, pax headers. */
function tarball(commit: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-'));
  const top = `lanternfield-club-marble-run-${commit.slice(0, 7)}`;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, top, path, '..'), { recursive: true });
    writeFileSync(join(dir, top, path), text);
  }
  return execFileSync('tar', ['--format=pax', '-czf', '-', top], { cwd: dir });
}

const creationFiles = (version: string) => ({
  'README.md': '# Marble run, the club app',
  'creation/ats.json': JSON.stringify({ title: 'Marble run', sessionMode: 'solo' }),
  'creation/index.html': '<!doctype html><script type="module" src="./main.js"></script>',
  'creation/main.js': `console.log(${JSON.stringify(version)})`,
});

async function startGitHub(): Promise<FakeGitHub> {
  const gh = {
    release: { tag: 'v1.1', commit: C2 },
    seen: [] as FakeGitHub['seen'],
    archiveHost: '127.0.0.1',
  } as FakeGitHub;
  const archives: Record<string, Buffer> = {
    [C1]: tarball(C1, creationFiles('one')),
    [C2]: tarball(C2, creationFiles('two')),
    [C3]: tarball(C3, creationFiles('three')),
    [LEAKY]: tarball(LEAKY, {
      ...creationFiles('leaky'),
      'creation/key.js': `export const k = "sk-ant-${'q'.repeat(40)}";`,
    }),
    [EMPTY]: tarball(EMPTY, { 'README.md': 'nothing here yet' }),
    [C6]: tarball(C6, creationFiles('six')),
  };
  const messages: Record<string, string> = {
    [C1]: 'First marbles',
    [C2]: 'Faster ramps\n\nAnd a bell.',
    [C3]: 'Two new levels',
    [LEAKY]: 'Oops',
    [EMPTY]: 'Start',
    [C6]: 'Even more levels',
  };
  const send = (res: import('node:http').ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    gh.seen.push({ path, token: req.headers.authorization === `Bearer ${TOKEN}` });
    const archive = /^\/archive\/([0-9a-f]{40})$/.exec(path);
    if (archive) {
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      res.end(archives[archive[1] as string]);
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return send(res, 404, { message: 'Not Found' });
    const m = /^\/repos\/lanternfield-club\/marble-run\/(.+)$/.exec(path);
    if (!m) return send(res, 404, { message: 'Not Found' });
    const rest = m[1] as string;
    if (rest === 'releases/latest') return send(res, 200, { tag_name: gh.release.tag });
    const commit = /^commits\/(.+)$/.exec(rest);
    if (commit) {
      const ref = decodeURIComponent(commit[1] as string);
      const at = ref === gh.release.tag ? gh.release.commit : ref === 'main' ? C3 : ref;
      if (!messages[at]) return send(res, 404, { message: 'No commit found' });
      return send(res, 200, { sha: at, commit: { message: messages[at] } });
    }
    const compare = /^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest);
    if (compare)
      return send(res, 200, {
        status: 'ahead',
        ahead_by: Number((compare[2] as string)[0]) - Number((compare[1] as string)[0]),
      });
    const tar = /^tarball\/([0-9a-f]{40})$/.exec(rest);
    if (tar) {
      res.writeHead(302, { location: `http://${gh.archiveHost}:${gh.port}/archive/${tar[1]}` });
      res.end();
      return;
    }
    send(res, 404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  gh.port = (server.address() as AddressInfo).port;
  gh.close = () => new Promise((r) => server.close(() => r()));
  return gh;
}

describe.skipIf(!adminUrl)('creations from repositories', () => {
  let t: TestApp;
  let gh: FakeGitHub;
  let groupId: string;
  let spaceId: string;
  let architectCookie: string;
  let memberCookie: string;
  const queued: string[] = [];
  let hosts: SourceHostRegistry;
  const req = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    cookie: string,
    payload?: object,
  ) => t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const buildOf = async (id: string) =>
    (await t.db.select().from(schema.builds).where(eq(schema.builds.id, id)))[0];

  /** What a passing build does with a build from a repository (builds.ts, without the checks). */
  async function pass(buildId: string) {
    const b = await buildOf(buildId);
    if (!b?.source) throw new Error('not from a repository');
    const made = await publishCreation(t.db, t.storage, {
      ...(b.creationId ? { creationId: b.creationId } : {}),
      groupId: b.groupId,
      spaceId: b.spaceId,
      objectKey: b.objectKey,
      title: 'Marble run',
      files: new Map([['index.html', new TextEncoder().encode('<p>marbles</p>')]]),
      sdkVersion: '0.2.0',
      protocolVersion: 1,
      status: b.publish ? 'published' : 'candidate',
    });
    await recordSourceBuild(
      t.db,
      { groupId: b.groupId, requestedBy: b.requestedBy, source: b.source },
      made,
    );
    return made;
  }

  beforeAll(async () => {
    gh = await startGitHub();
    const def = parseSourceHostDefinition({
      id: 'github',
      displayName: 'GitHub',
      kind: 'github',
      repositories: ['lanternfield-club/*'],
      archiveHosts: ['127.0.0.1'],
      allowPrivateAddress: true,
    });
    hosts = sourceHostsOf([
      { def: { ...def, apiUrl: `http://127.0.0.1:${gh.port}` }, token: TOKEN },
    ]);
    t = await createTestApp({
      sourceHosts: hosts,
      buildQueue: {
        add: async (_name: string, data: { buildId: string }) => {
          queued.push(data.buildId);
        },
        close: async () => {},
      } as unknown as Queue,
    });
    ({ groupId, architectCookie, memberCookie } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
    await addSofaCreation(t, groupId, spaceId);
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    await gh?.close();
  });

  it('shows Architects which repository hosts this server allows', async () => {
    const res = await req('GET', '/api/sources', architectCookie);
    expect(res.json()).toEqual([
      { id: 'github', displayName: 'GitHub', repositories: ['lanternfield-club/*'] },
    ]);
    expect((await req('GET', '/api/sources', memberCookie)).statusCode).toBe(404);
  });

  let creationId: string;

  it('makes a new creation from a repository folder: the newest release, checked like any source', async () => {
    const res = await req(
      'POST',
      `/api/spaces/${spaceId}/creations/from-repository`,
      architectCookie,
      {
        objectKey: 'rug',
        host: 'github',
        repository: 'lanternfield-club/marble-run',
        path: 'creation',
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ commit: C2, label: 'v1.1' });
    const build = await buildOf(res.json().buildId);
    expect(build).toMatchObject({
      creationId: null,
      objectKey: 'rug',
      publish: false,
      source: {
        repository: 'lanternfield-club/marble-run',
        path: 'creation',
        follows: 'release',
        commit: C2,
        label: 'v1.1',
      },
    });
    expect(queued).toContain(build?.id);
    // Only the creation's folder, with paths inside it.
    const files = await downloadSourceFiles(t.storage, groupId, build?.sourceHash as string);
    expect([...files.keys()].sort()).toEqual(['ats.json', 'index.html', 'main.js']);
    expect(new TextDecoder().decode(files.get('main.js'))).toContain('two');
    // The token goes to the API, never to the archive address.
    expect(gh.seen.filter((s) => s.path.startsWith('/repos/')).every((s) => s.token)).toBe(true);
    expect(gh.seen.filter((s) => s.path.startsWith('/archive/')).every((s) => !s.token)).toBe(true);
    // The build passes: the creation follows the repository from then on.
    const made = await pass(build?.id as string);
    creationId = made.creationId;
    const source = (await req('GET', `/api/creations/${creationId}/source`, architectCookie)).json()
      .source;
    expect(source).toMatchObject({
      hostName: 'GitHub',
      repository: 'lanternfield-club/marble-run',
      path: 'creation',
      follows: 'release',
      updateMode: 'candidate',
      builtCommit: C2,
      behindBy: 0,
    });
    const studio = (await req('GET', `/api/spaces/${spaceId}/studio`, architectCookie)).json();
    const marble = studio.creations.find((c: { id: string }) => c.id === creationId);
    expect(marble.source.builtCommit).toBe(C2);
    expect(marble.versions[0].sourceCommit).toBe(C2);
  });

  it('notices a new release, says how far behind it is, and updates to it as a candidate', async () => {
    gh.release = { tag: 'v1.2', commit: C3 };
    const checked = await req('POST', `/api/creations/${creationId}/source/check`, architectCookie);
    expect(checked.json().source).toMatchObject({
      latestCommit: C3,
      latestLabel: 'v1.2',
      behindBy: 1,
      checkError: null,
    });
    const res = await req('POST', `/api/creations/${creationId}/source/update`, architectCookie);
    expect(res.json()).toMatchObject({ commit: C3, label: 'v1.2' });
    const build = await buildOf(res.json().buildId);
    expect(build).toMatchObject({ creationId, objectKey: 'rug', publish: false });
    await pass(build?.id as string);
    const source = (await req('GET', `/api/creations/${creationId}/source`, architectCookie)).json()
      .source;
    expect(source).toMatchObject({ builtCommit: C3, behindBy: 0 });
  });

  it('follows a branch instead, straight to live, or one commit', async () => {
    const put = await req('PUT', `/api/creations/${creationId}/source`, architectCookie, {
      host: 'github',
      repository: 'lanternfield-club/marble-run',
      path: 'creation',
      follows: 'branch',
      ref: 'main',
      updateMode: 'live',
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().source).toMatchObject({
      follows: 'branch',
      ref: 'main',
      latestCommit: C3,
      builtCommit: C3,
      behindBy: 0,
    });
    const live = await req('POST', `/api/creations/${creationId}/source/update`, architectCookie);
    expect((await buildOf(live.json().buildId))?.publish).toBe(true);
    // A given commit (going back to an older one, say).
    const older = await req('POST', `/api/creations/${creationId}/source/update`, architectCookie, {
      commit: C1,
    });
    expect(older.json().commit).toBe(C1);
    expect((await buildOf(older.json().buildId))?.source?.commit).toBe(C1);
  });

  it('refuses what it should, and stores nothing then', async () => {
    const make = (body: object) =>
      req('POST', `/api/spaces/${spaceId}/creations/from-repository`, architectCookie, {
        host: 'github',
        repository: 'lanternfield-club/marble-run',
        path: 'creation',
        objectKey: 'bed',
        ...body,
      });
    const stored = t.storage.objects.size;
    const builds = (await t.db.select().from(schema.builds)).length;
    const refusals: [object, number, RegExp][] = [
      [{ repository: 'someone-else/game' }, 422, /isn't one of the repositories/],
      [{ host: 'gitlab' }, 422, /no repository host called/],
      [{ path: 'not-here' }, 422, /nothing in not-here/],
      [{ path: '../creation' }, 422, /folder name/],
      [{ follows: 'commit', ref: EMPTY, path: '' }, 422, /no ats.json/],
      [{ follows: 'commit', ref: LEAKY }, 422, /look like secrets/],
      [{ follows: 'branch', ref: 'nope' }, 422, /doesn't exist/],
      [{ objectKey: 'sofa' }, 409, /already has a creation/],
      [{ objectKey: 'no-such-thing' }, 404, /isn’t in this place/],
    ];
    for (const [body, status, words] of refusals) {
      const res = await make(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(status);
      expect(res.json().error).toMatch(words);
    }
    expect(
      JSON.stringify(await make({ follows: 'commit', ref: LEAKY }).then((r) => r.json())),
    ).not.toContain('qqqq');
    // An archive address the definition doesn't name is never fetched.
    gh.archiveHost = 'localhost';
    const elsewhere = await make({});
    expect(elsewhere.json().error).toMatch(/isn't allowed to \(localhost\)/);
    gh.archiveHost = '127.0.0.1';
    expect(t.storage.objects.size).toBe(stored);
    expect((await t.db.select().from(schema.builds)).length).toBe(builds);
    // Only the group's Architects.
    expect(
      (await req('POST', `/api/creations/${creationId}/source/update`, memberCookie)).statusCode,
    ).toBe(404);
  });

  it('links a creation made in the Studio, and lets go again', async () => {
    const [sofa] = await t.db
      .select()
      .from(schema.creations)
      .where(eq(schema.creations.objectKey, 'sofa'));
    const put = await req('PUT', `/api/creations/${sofa?.id}/source`, architectCookie, {
      host: 'github',
      repository: 'lanternfield-club/marble-run',
      path: 'creation',
    });
    // Nothing of it was built from the repository yet: how far behind is unknown until Update.
    expect(put.json().source).toMatchObject({
      latestCommit: C3,
      builtCommit: null,
      behindBy: null,
    });
    expect(
      (await req('DELETE', `/api/creations/${sofa?.id}/source`, architectCookie)).statusCode,
    ).toBe(200);
    expect(
      (await req('GET', `/api/creations/${sofa?.id}/source`, architectCookie)).json().source,
    ).toBeNull();
  });

  it('looks on its own about once an hour, and tells the Architects once about something new', async () => {
    // Back to following releases; the newest is still what's built.
    await req('PUT', `/api/creations/${creationId}/source`, architectCookie, {
      host: 'github',
      repository: 'lanternfield-club/marble-run',
      path: 'creation',
    });
    const sent: { to: string[]; title: string; url?: string }[] = [];
    const notifier = {
      send: async (to: Iterable<string>, n: { title: string; url?: string }) => {
        sent.push({ to: [...to], title: n.title, ...(n.url ? { url: n.url } : {}) });
      },
    };
    const deps = { db: t.db, files: hosts, release: 'test' };
    const hourAgo = () =>
      t.db
        .update(schema.creationSources)
        .set({ checkedAt: new Date(Date.now() - 2 * 3600_000) })
        .where(eq(schema.creationSources.creationId, creationId));
    // Looked at a moment ago: not due.
    gh.release = { tag: 'v1.3', commit: C6 };
    await sourceCheckTick(deps, notifier);
    expect(sent).toEqual([]);
    // An hour on: it notices v1.3 and says so, once.
    await hourAgo();
    await sourceCheckTick(deps, notifier);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: 'Marble run: v1.3 in its repository',
      url: `/space/${spaceId}/creations`,
    });
    const source = (await req('GET', `/api/creations/${creationId}/source`, architectCookie)).json()
      .source;
    expect(source).toMatchObject({ latestCommit: C6, latestLabel: 'v1.3', behindBy: 3 });
    await hourAgo();
    await sourceCheckTick(deps, notifier);
    expect(sent).toHaveLength(1);
  });

  it('clears "new in its repository" for everyone once the creation is updated', async () => {
    // v1.3 is still waiting (as the last look left it): looked at afresh, it's news again.
    await t.db
      .update(schema.creationSources)
      .set({ checkedAt: new Date(Date.now() - 2 * 3600_000), latestCommit: null })
      .where(eq(schema.creationSources.creationId, creationId));
    // Kept as the notifier keeps them, for each Architect it was sent to.
    const notifier = {
      send: async (to: Iterable<string>, n: Notice) => {
        await t.db.insert(schema.notifications).values(
          [...to].map((userId) => ({
            userId,
            groupId: n.groupId ?? null,
            kind: n.kind,
            title: n.title,
            subject: n.subject ?? null,
          })),
        );
      },
    };
    await sourceCheckTick({ db: t.db, files: hosts, release: 'test' }, notifier);
    const newer = () =>
      t.db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.kind, 'creation.source.newer'));
    const sent = await newer();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((n) => n.subject === `creation:${creationId}`)).toBe(true);
    // Another creation's notice stays.
    const userId = sent[0]?.userId as string;
    await t.db.insert(schema.notifications).values({
      userId,
      kind: 'creation.source.newer',
      title: 'Something else: a new commit in its repository',
      subject: `creation:${crypto.randomUUID()}`,
    });

    // Checking again doesn't clear it: only having it built does.
    await req('POST', `/api/creations/${creationId}/source/check`, architectCookie);
    expect(await newer()).toHaveLength(sent.length + 1);
    const res = await req('POST', `/api/creations/${creationId}/source/update`, architectCookie);
    expect(res.json()).toMatchObject({ commit: C6 });
    expect(await newer()).toHaveLength(sent.length + 1);
    await pass(res.json().buildId);
    const left = await newer();
    expect(left.map((n) => n.title)).toEqual(['Something else: a new commit in its repository']);
  });
});
