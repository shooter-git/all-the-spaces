import type { SourceHostDefinition } from '@ats/shared';
import { COMMIT } from '@ats/shared';
import { type HttpAnswer, HttpError, isJson, send } from '../connectors/http.ts';

/**
 * The few GitHub API calls a creation from a repository needs, made by the server with the
 * owner's read-only token: which commit a release or branch is at, how many commits a creation is
 * behind, and one commit's archive. Every call goes through the connectors' `send`: addresses
 * resolved once and public only, no redirects followed (the one an archive needs is checked
 * against the definition and followed by hand), a deadline and a size cap.
 */

/** Something went wrong reaching the repository, in words an Architect can act on. */
export class SourceError extends Error {}

export interface Found {
  commit: string;
  /** The release's tag, or the commit's first line. */
  label: string;
}

export interface Follow {
  repository: string;
  follows: 'release' | 'branch' | 'commit';
  ref: string | null;
}

interface Host {
  def: SourceHostDefinition;
  token: string | null;
  /** What the server calls itself to the host. */
  userAgent: string;
}

const enc = encodeURIComponent;
const repoPath = (repository: string) => repository.split('/').map(enc).join('/');

async function api(host: Host, path: string, maxBytes = 2_000_000): Promise<HttpAnswer> {
  try {
    return await send(`${host.def.apiUrl.replace(/\/$/, '')}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': host.userAgent,
        ...(host.token ? { authorization: `Bearer ${host.token}` } : {}),
      },
      timeoutMs: 20_000,
      maxBytes,
      pin: { allowPrivateAddress: host.def.allowPrivateAddress },
    });
  } catch (err) {
    throw new SourceError(
      `${host.def.displayName} couldn't be reached (${(err as Error).message}).`,
    );
  }
}

function problem(host: Host, answer: HttpAnswer, what: string): SourceError {
  const name = host.def.displayName;
  if (answer.status === 404)
    return new SourceError(
      `${name} says ${what} doesn't exist${host.token ? ", or the server's token can't see it" : ' (or is private: the server has no token for it)'}.`,
    );
  if (answer.status === 401) return new SourceError(`${name} refused the server's token.`);
  if (answer.status === 403 || answer.status === 429)
    return new SourceError(
      String(answer.headers['x-ratelimit-remaining']) === '0'
        ? `${name}'s limit on requests was reached; it resets within the hour.`
        : `${name} refused to show ${what}.`,
    );
  return new SourceError(`${name} answered ${answer.status} for ${what}.`);
}

function json<T>(host: Host, answer: HttpAnswer, what: string): T {
  if (answer.status !== 200) throw problem(host, answer, what);
  if (!isJson(answer.contentType))
    throw new SourceError(`${host.def.displayName} sent something unexpected.`);
  return JSON.parse(answer.body.toString('utf8')) as T;
}

const firstLine = (message: string) => message.split('\n')[0]?.trim().slice(0, 120) ?? '';

/** The commit what it follows is at now. */
export async function latest(host: Host, f: Follow): Promise<Found> {
  const repo = repoPath(f.repository);
  if (f.follows === 'release') {
    const release = json<{ tag_name: string }>(
      host,
      await api(host, `/repos/${repo}/releases/latest`),
      `a release of ${f.repository}`,
    );
    const at = await commitAt(host, f.repository, release.tag_name);
    return { commit: at.commit, label: release.tag_name };
  }
  if (!f.ref) throw new SourceError('A branch or commit is needed.');
  return commitAt(host, f.repository, f.ref);
}

async function commitAt(host: Host, repository: string, ref: string): Promise<Found> {
  const c = json<{ sha: string; commit: { message: string } }>(
    host,
    await api(host, `/repos/${repoPath(repository)}/commits/${enc(ref)}`),
    `${ref} in ${repository}`,
  );
  if (!COMMIT.test(c.sha))
    throw new SourceError(`${host.def.displayName} sent something unexpected.`);
  return { commit: c.sha, label: firstLine(c.commit.message) };
}

/** How many commits `head` is ahead of `base` (null when they don't compare: history rewritten). */
export async function behindBy(host: Host, repository: string, base: string, head: string) {
  if (base === head) return 0;
  const answer = await api(
    host,
    `/repos/${repoPath(repository)}/compare/${base}...${head}`,
    4_000_000,
  );
  if (answer.status === 404) return null;
  const c = json<{ ahead_by: number; status: string }>(
    host,
    answer,
    `the changes in ${repository}`,
  );
  return c.status === 'diverged' || c.status === 'behind' ? null : c.ahead_by;
}

/**
 * One commit's archive (a gzipped tar). The API answers with a redirect to the host's archive
 * address, which must be one the definition allows; it's followed once, without the token (the
 * address carries its own short-lived permission).
 */
export async function archive(host: Host, repository: string, commit: string): Promise<Buffer> {
  if (!COMMIT.test(commit)) throw new SourceError('Not a commit.');
  const answer = await api(host, `/repos/${repoPath(repository)}/tarball/${commit}`, 64_000);
  if (answer.status !== 302 && answer.status !== 301)
    throw problem(host, answer, `${commit.slice(0, 7)} in ${repository}`);
  const location = String(answer.headers.location ?? '');
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new SourceError(`${host.def.displayName} sent an archive address that isn't one.`);
  }
  // The same protocol as the API (https: only http in tests), on a host the definition names.
  if (
    url.protocol !== new URL(host.def.apiUrl).protocol ||
    !host.def.archiveHosts.includes(url.hostname)
  )
    throw new SourceError(
      `${host.def.displayName} sent the archive somewhere it isn't allowed to (${url.hostname}).`,
    );
  const maxBytes = host.def.maxArchiveMb * 1024 * 1024;
  let file: HttpAnswer;
  try {
    file = await send(url.href, {
      method: 'GET',
      headers: { 'user-agent': host.userAgent },
      timeoutMs: 180_000,
      maxBytes,
      pin: { allowPrivateAddress: host.def.allowPrivateAddress },
    });
  } catch (err) {
    if (err instanceof HttpError && err.kind === 'too-big')
      throw new SourceError(`The repository's archive is over ${host.def.maxArchiveMb} MB.`);
    throw new SourceError(`The archive couldn't be fetched (${(err as Error).message}).`);
  }
  if (file.status !== 200)
    throw new SourceError(`The archive couldn't be fetched (${file.status}).`);
  return file.body;
}
