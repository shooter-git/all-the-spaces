// Any public repository, as the owner's choice (ADR 0012), against a fake GitHub on this machine:
// a repository read as public only never gets the token, is asked whether it's public before
// every look and fetch, and a private one is answered exactly like one that doesn't exist.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_GITHUB, parseSourceHostDefinition, studioSourcesOf } from '@ats/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  allowanceLow,
  archive,
  forgetAllowances,
  KEEP_FOR_ARCHITECTS,
  latest,
  SourceError,
} from '../src/sources/github.ts';
import {
  BUILT_IN_GITHUB_DEF,
  loadSourceHosts,
  type SourceHost,
  type SourceHostRegistry,
  sourceHostsOf,
  withStudioSources,
} from '../src/sources/registry.ts';
import { hostFor } from '../src/sources/service.ts';

const TOKEN = 'ghs_owner-read-only-token';
const C1 = '1'.repeat(40);

interface Repo {
  private: boolean;
  /** What the host says without a token (a well-behaved one: nothing, for a private one). */
  showsWithoutToken?: boolean;
}

interface Fake {
  port: number;
  repos: Record<string, Repo>;
  /** Every request: its path, whether it had the token, and the ETag it asked about. */
  seen: { path: string; token: boolean; ifNoneMatch?: string }[];
  /** What it says is left of the hourly allowance (and whether it refuses for that). */
  remaining: number;
  close(): Promise<void>;
}

function tarball(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-public-'));
  const top = 'open-club-lantern-toss-1111111';
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, top, path, '..'), { recursive: true });
    writeFileSync(join(dir, top, path), text);
  }
  return execFileSync('tar', ['--format=pax', '-czf', '-', top], { cwd: dir });
}

async function startFake(): Promise<Fake> {
  const fake = {
    repos: {
      'open-club/lantern-toss': { private: false },
      'club/hidden': { private: true },
      // A host that shows a private repository to anyone (it shouldn't): still refused.
      'club/shown': { private: true, showsWithoutToken: true },
    },
    seen: [],
    remaining: 59,
  } as unknown as Fake;
  const gz = tarball({ 'ats.json': '{}', 'index.html': '<p>toss</p>' });
  const send = (res: ServerResponse, status: number, body?: unknown, etag?: string) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-ratelimit-remaining': String(fake.remaining),
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
      ...(etag ? { etag } : {}),
    });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const token = req.headers.authorization === `Bearer ${TOKEN}`;
    const ifNoneMatch = req.headers['if-none-match'];
    fake.seen.push({ path, token, ...(typeof ifNoneMatch === 'string' ? { ifNoneMatch } : {}) });
    if (path.startsWith('/archive/')) {
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      res.end(gz);
      return;
    }
    if (fake.remaining <= 0) return send(res, 403, { message: 'API rate limit exceeded' });
    const m = /^\/repos\/([^/]+\/[^/]+)(?:\/(.+))?$/.exec(path);
    const name = m?.[1] ?? '';
    const repo = fake.repos[name];
    if (!repo || (repo.private && !token && !repo.showsWithoutToken))
      return send(res, 404, { message: 'Not Found' });
    const rest = m?.[2];
    if (!rest)
      return send(res, 200, {
        full_name: name,
        private: repo.private,
        visibility: repo.private ? 'private' : 'public',
      });
    if (rest === 'releases/latest') {
      const etag = '"release-v1"';
      if (token && ifNoneMatch === etag) return send(res, 304, undefined, etag);
      return send(res, 200, { tag_name: 'v1' }, etag);
    }
    if (rest.startsWith('commits/'))
      return send(res, 200, { sha: C1, commit: { message: 'First toss' } }, '"commit-1"');
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

describe('repositories read as public only', () => {
  let gh: Fake;
  let hosts: SourceHostRegistry;
  const follow = (repository: string) => ({
    host: 'github',
    repository,
    path: '',
    follows: 'release' as const,
    ref: null,
  });
  const access = (repository: string, h = hosts) =>
    hostFor({ hosts: h, release: 'test' }, follow(repository));
  const errorOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      if (err instanceof SourceError) return err.message;
      throw err;
    }
    return null;
  };

  beforeAll(async () => {
    gh = await startFake();
    const def = parseSourceHostDefinition({
      id: 'github',
      displayName: 'GitHub',
      kind: 'github',
      tokenEnv: 'ATS_SOURCE_GITHUB_TOKEN',
      // The file names one owner (private ones too, with the token) and allows any public one.
      repositories: ['club/*', '*'],
      archiveHosts: ['127.0.0.1'],
      allowPrivateAddress: true,
    });
    hosts = sourceHostsOf([
      { def: { ...def, apiUrl: `http://127.0.0.1:${gh.port}` }, token: TOKEN },
    ]);
  });
  afterAll(() => gh?.close());
  beforeEach(() => {
    forgetAllowances();
    gh.seen.length = 0;
    gh.remaining = 59;
    gh.repos['open-club/lantern-toss'] = { private: false };
  });

  it('chooses the token only for what the file names', () => {
    expect(access('club/hidden')).toMatchObject({ token: TOKEN, publicOnly: false });
    expect(access('open-club/lantern-toss')).toMatchObject({ token: null, publicOnly: true });
  });

  it('reads a public repository without the token, asking first that it is public', async () => {
    const host = access('open-club/lantern-toss');
    expect(await latest(host, follow('open-club/lantern-toss'))).toEqual({
      commit: C1,
      label: 'v1',
    });
    expect(gh.seen.map((s) => s.path)).toEqual([
      '/repos/open-club/lantern-toss',
      '/repos/open-club/lantern-toss/releases/latest',
      `/repos/open-club/lantern-toss/commits/v1`,
    ]);
    // And again before fetching it: a repository can turn private any time.
    gh.seen.length = 0;
    const gz = await archive(host, 'open-club/lantern-toss', C1);
    expect(gz.length).toBeGreaterThan(0);
    expect(gh.seen.map((s) => s.path)).toEqual([
      '/repos/open-club/lantern-toss',
      `/repos/open-club/lantern-toss/tarball/${C1}`,
      `/archive/${C1}`,
    ]);
    expect(gh.seen.some((s) => s.token)).toBe(false);
  });

  it('even when the host has a token, never sends it for a repository "*" allows', async () => {
    // A private repository of an owner the file doesn't name: the token could read it, but it's
    // never sent, so the host says it doesn't exist.
    gh.repos['stranger/private-game'] = { private: true };
    const message = await errorOf(
      latest(access('stranger/private-game'), follow('stranger/private-game')),
    );
    expect(gh.seen.some((s) => s.token)).toBe(false);
    // Word for word what a repository that doesn't exist gets: nothing is given away.
    const missing = await errorOf(latest(access('stranger/nothing'), follow('stranger/nothing')));
    expect(message).toBe("GitHub says stranger/private-game doesn't exist, or isn't public.");
    expect(missing).toBe("GitHub says stranger/nothing doesn't exist, or isn't public.");
    delete gh.repos['stranger/private-game'];
  });

  it('refuses a private repository even if the host shows it without a token', async () => {
    const studio = withStudioSources(
      sourceHostsOf([{ def: (hosts.get('github') as SourceHost).def, token: null }]),
      studioSourcesOf({ added: { github: ['club/shown'] } }),
    );
    const host = hostFor({ hosts: studio, release: 'test' }, follow('club/shown'));
    expect(host).toMatchObject({ token: null, publicOnly: true });
    expect(await errorOf(latest(host, follow('club/shown')))).toBe(
      "GitHub says club/shown doesn't exist, or isn't public.",
    );
    // Nothing past the question whether it's public.
    expect(gh.seen.map((s) => s.path)).toEqual(['/repos/club/shown']);
  });

  it("doesn't fetch a repository that turned private after it was looked at", async () => {
    const host = access('open-club/lantern-toss');
    await latest(host, follow('open-club/lantern-toss'));
    gh.repos['open-club/lantern-toss'] = { private: true };
    gh.seen.length = 0;
    expect(await errorOf(archive(host, 'open-club/lantern-toss', C1))).toBe(
      "GitHub says open-club/lantern-toss doesn't exist, or isn't public.",
    );
    expect(gh.seen.map((s) => s.path)).toEqual(['/repos/open-club/lantern-toss']);
  });

  it('still reads what the file names with the token, asking again only if it changed', async () => {
    const host = access('club/hidden');
    gh.repos['club/hidden'] = { private: true };
    expect(await latest(host, follow('club/hidden'))).toMatchObject({ commit: C1 });
    expect(gh.seen.every((s) => s.token)).toBe(true);
    // No question whether it's public: the owner chose to let the token read it.
    expect(gh.seen.map((s) => s.path)).not.toContain('/repos/club/hidden');
    // The second time, the release is asked about by its ETag (free with a token when unchanged).
    gh.seen.length = 0;
    expect(await latest(host, follow('club/hidden'))).toMatchObject({ commit: C1, label: 'v1' });
    expect(gh.seen[0]).toMatchObject({
      path: '/repos/club/hidden/releases/latest',
      ifNoneMatch: '"release-v1"',
    });
    // Never for a public one: without a token a 304 counts all the same.
    gh.seen.length = 0;
    await latest(access('open-club/lantern-toss'), follow('open-club/lantern-toss'));
    await latest(access('open-club/lantern-toss'), follow('open-club/lantern-toss'));
    expect(gh.seen.some((s) => s.ifNoneMatch)).toBe(false);
  });

  it('stops asking once the hourly allowance is used up, and says when it comes back', async () => {
    const pub = access('open-club/lantern-toss');
    gh.remaining = KEEP_FOR_ARCHITECTS - 1;
    await latest(pub, follow('open-club/lantern-toss'));
    // Little left: background looks wait, Architects' own still go.
    expect(allowanceLow(pub)).toBe(true);
    expect(allowanceLow(access('club/hidden'))).toBe(false);
    gh.remaining = 0;
    const used = await errorOf(latest(pub, follow('open-club/lantern-toss')));
    expect(used).toMatch(
      /GitHub's limit on requests from this server was reached; it resets in 1\d minutes\./,
    );
    // Not asked again until it resets.
    gh.seen.length = 0;
    expect(await errorOf(latest(pub, follow('open-club/lantern-toss')))).toBe(used);
    expect(gh.seen).toEqual([]);
    // The token's own allowance is separate.
    gh.remaining = 59;
    expect(await latest(access('club/hidden'), follow('club/hidden'))).toMatchObject({
      commit: C1,
    });
  });
});

describe('the hosts allowed right now', () => {
  const file = (id: string, extra: object = {}) =>
    parseSourceHostDefinition({
      id,
      displayName: id,
      kind: 'github',
      repositories: ['club/*'],
      ...extra,
    });

  it('combines the files with what the owner chose in the Studio', () => {
    const files = sourceHostsOf([
      { def: file('github', { tokenEnv: 'ATS_SOURCE_GITHUB_TOKEN' }), token: TOKEN },
    ]);
    // Nothing chosen: the files alone, and no built-in GitHub.
    const none = withStudioSources(files, studioSourcesOf(null));
    expect(none.list().map((h) => h.def.id)).toEqual(['github']);
    expect(none.get(BUILT_IN_GITHUB)).toBeUndefined();
    const some = withStudioSources(
      files,
      studioSourcesOf({
        github: { on: true, repositories: ['*'] },
        added: { github: ['someone/game'], gone: ['x/y'] },
      }),
    );
    expect(some.list().map((h) => [h.def.id, h.from, h.added])).toEqual([
      ['github', 'file', ['someone/game']],
      [BUILT_IN_GITHUB, 'built-in', ['*']],
    ]);
    // The built-in host is github.com, public addresses only, and never has a token.
    expect(some.get(BUILT_IN_GITHUB)).toMatchObject({ def: BUILT_IN_GITHUB_DEF, token: null });
    expect(BUILT_IN_GITHUB_DEF).toMatchObject({
      apiUrl: 'https://api.github.com',
      archiveHosts: ['codeload.github.com'],
      allowPrivateAddress: false,
    });
    // Switched off, it's gone, whatever its list says.
    const off = withStudioSources(
      files,
      studioSourcesOf({ github: { on: false, repositories: ['*'] } }),
    );
    expect(off.get(BUILT_IN_GITHUB)).toBeUndefined();
    expect(() =>
      hostFor(
        { hosts: off, release: 'test' },
        { host: BUILT_IN_GITHUB, repository: 'a/b', path: '', follows: 'release', ref: null },
      ),
    ).toThrow(/switched off/);
  });

  it('never lets what was added in the Studio use a file host’s token', () => {
    const files = sourceHostsOf([
      { def: file('github', { tokenEnv: 'ATS_SOURCE_GITHUB_TOKEN' }), token: TOKEN },
    ]);
    const hosts = withStudioSources(files, studioSourcesOf({ added: { github: ['other/*'] } }));
    const look = (repository: string) =>
      hostFor(
        { hosts, release: 'test' },
        { host: 'github', repository, path: '', follows: 'release', ref: null },
      );
    expect(look('club/game')).toMatchObject({ token: TOKEN, publicOnly: false });
    expect(look('other/game')).toMatchObject({ token: null, publicOnly: true });
    expect(() => look('stranger/game')).toThrow(/isn't one of the repositories/);
  });

  it('skips a file that takes the built-in host’s id, and reads "*" in one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sources-'));
    const host = (id: string, repositories: string[]) =>
      JSON.stringify({ id, displayName: id, kind: 'github', repositories });
    writeFileSync(join(dir, `${BUILT_IN_GITHUB}.json`), host(BUILT_IN_GITHUB, ['*']));
    writeFileSync(join(dir, 'anything.json'), host('anything', ['*']));
    writeFileSync(join(dir, 'studio-only.json'), host('studio-only', []));
    const warned: string[] = [];
    const hosts = await loadSourceHosts(
      dir,
      {},
      { info() {}, warn: (o: { file?: string }) => warned.push(o.file ?? '') },
    );
    expect(hosts.list().map((h) => [h.def.id, h.def.repositories])).toEqual([
      ['anything', ['*']],
      ['studio-only', []],
    ]);
    expect(warned).toEqual([`${BUILT_IN_GITHUB}.json`]);
  });
});
