import type { SourceHostDefinition } from '@ats/shared';
import { COMMIT } from '@ats/shared';
import { type HttpAnswer, HttpError, isJson, send } from '../connectors/http.ts';

/**
 * The few GitHub API calls a creation from a repository needs, made by the server: which commit
 * a release or branch is at, how many commits a creation is behind, and one commit's archive.
 * Every call goes through the connectors' `send`: addresses resolved once and public only, no
 * redirects followed (the one an archive needs is checked against the definition and followed by
 * hand), a deadline and a size cap.
 *
 * A repository is read one of two ways (ADR 0012): with the owner's read-only token, when the
 * host's definition file names it; or as a public one, with no token at all, after the host says
 * again that it's public. Without a token the host itself can't hand over a private repository.
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

/** A host, and how one repository on it may be read. */
export interface HostAccess {
  def: SourceHostDefinition;
  /** The host's token, when this repository may be read with it. */
  token: string | null;
  /**
   * Read as a public repository only: no token is ever sent, and the host must say it's public
   * before every look and every fetch.
   */
  publicOnly: boolean;
  /** What the server calls itself to the host. */
  userAgent: string;
}

const enc = encodeURIComponent;
const repoPath = (repository: string) => repository.split('/').map(enc).join('/');

/** The one place a token is chosen: never for a repository read as public only. */
const credential = (host: HostAccess) => (host.publicOnly ? null : host.token);

// ---- The host's hourly allowance -----------------------------------------------------------
//
// GitHub allows 60 requests an hour from one address without a token, and 5,000 with one. What
// it says is left is kept for each API and way of asking, so a used-up allowance is refused here
// (not asked again), and the hourly looks can stop early to leave some for Architects.

interface Allowance {
  remaining: number;
  /** When it fills up again (milliseconds). */
  resetsAt: number;
}
const allowances = new Map<string, Allowance>();
const allowanceKey = (host: HostAccess) =>
  `${host.def.apiUrl}|${credential(host) ? `token:${host.def.id}` : 'none'}`;

/** What the background looks leave for Architects' own Check, Update and linking. */
export const KEEP_FOR_ARCHITECTS = 10;

function noteAllowance(key: string, answer: HttpAnswer) {
  const remaining = answer.headers['x-ratelimit-remaining'];
  const reset = answer.headers['x-ratelimit-reset'];
  if (typeof remaining !== 'string' || typeof reset !== 'string') return;
  if (!/^\d{1,9}$/.test(remaining) || !/^\d{1,12}$/.test(reset)) return;
  allowances.set(key, { remaining: Number(remaining), resetsAt: Number(reset) * 1000 });
}

function limitReached(host: HostAccess, resetsAt: number | null) {
  const minutes = resetsAt ? Math.max(1, Math.ceil((resetsAt - Date.now()) / 60_000)) : null;
  return new SourceError(
    `${host.def.displayName}'s limit on requests from this server was reached; it resets ${
      minutes && minutes <= 60
        ? `in ${minutes} minute${minutes === 1 ? '' : 's'}`
        : 'within the hour'
    }.`,
  );
}

/** Whether the host's allowance for this way of asking is nearly used up (until it resets). */
export function allowanceLow(host: HostAccess, keep = KEEP_FOR_ARCHITECTS, now = Date.now()) {
  const a = allowances.get(allowanceKey(host));
  return Boolean(a && a.resetsAt > now && a.remaining < keep);
}

/** Forgets every allowance and remembered answer (tests). */
export function forgetAllowances() {
  allowances.clear();
  remembered.clear();
}

// ---- Conditional requests -------------------------------------------------------------------
//
// With a token, an answer that hasn't changed (304) doesn't count against the allowance, so the
// last answer to each question is kept with its ETag. Without a token a 304 counts all the same,
// so nothing is kept: a public repository is always asked afresh.

const remembered = new Map<string, { etag: string; answer: HttpAnswer }>();
const REMEMBER_AT_MOST = 500;
const REMEMBER_UP_TO_BYTES = 256 * 1024;

async function api(host: HostAccess, path: string, maxBytes = 2_000_000): Promise<HttpAnswer> {
  const token = credential(host);
  const key = allowanceKey(host);
  const left = allowances.get(key);
  if (left && left.remaining <= 0 && left.resetsAt > Date.now())
    throw limitReached(host, left.resetsAt);
  const known = token ? remembered.get(`${key} ${path}`) : undefined;
  let answer: HttpAnswer;
  try {
    answer = await send(`${host.def.apiUrl.replace(/\/$/, '')}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': host.userAgent,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(known ? { 'if-none-match': known.etag } : {}),
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
  noteAllowance(key, answer);
  if (known && answer.status === 304) return known.answer;
  const etag = answer.headers.etag;
  if (
    token &&
    answer.status === 200 &&
    typeof etag === 'string' &&
    answer.body.length <= REMEMBER_UP_TO_BYTES
  ) {
    remembered.delete(`${key} ${path}`);
    remembered.set(`${key} ${path}`, { etag, answer });
    if (remembered.size > REMEMBER_AT_MOST)
      remembered.delete(remembered.keys().next().value as string);
  }
  return answer;
}

function rateLimited(answer: HttpAnswer) {
  return (
    (answer.status === 403 || answer.status === 429) &&
    String(answer.headers['x-ratelimit-remaining']) === '0'
  );
}

function problem(host: HostAccess, answer: HttpAnswer, what: string): SourceError {
  const name = host.def.displayName;
  if (answer.status === 404)
    return new SourceError(
      `${name} says ${what} doesn't exist${
        host.publicOnly
          ? ''
          : credential(host)
            ? ", or the server's token can't see it"
            : ' (or is private: the server has no token for it)'
      }.`,
    );
  if (answer.status === 401) return new SourceError(`${name} refused the server's token.`);
  if (rateLimited(answer)) {
    const reset = Number(answer.headers['x-ratelimit-reset']);
    return limitReached(host, Number.isFinite(reset) && reset > 0 ? reset * 1000 : null);
  }
  if (answer.status === 403 || answer.status === 429)
    return new SourceError(`${name} refused to show ${what}.`);
  if (answer.status === 301)
    return new SourceError(`${name} says ${what} has moved: use its new name.`);
  return new SourceError(`${name} answered ${answer.status} for ${what}.`);
}

function json<T>(host: HostAccess, answer: HttpAnswer, what: string): T {
  if (answer.status !== 200) throw problem(host, answer, what);
  if (!isJson(answer.contentType))
    throw new SourceError(`${host.def.displayName} sent something unexpected.`);
  return JSON.parse(answer.body.toString('utf8')) as T;
}

/**
 * For a repository read as public only: the host must say, now, that it's public. A private
 * repository and one that doesn't exist get the same answer, so neither is given away.
 */
async function ensurePublic(host: HostAccess, repository: string) {
  if (!host.publicOnly) return;
  const answer = await api(host, `/repos/${repoPath(repository)}`);
  const hidden = new SourceError(
    `${host.def.displayName} says ${repository} doesn't exist, or isn't public.`,
  );
  if (answer.status !== 200) {
    if (rateLimited(answer)) throw problem(host, answer, repository);
    if ([401, 403, 404, 451].includes(answer.status)) throw hidden;
    throw problem(host, answer, repository);
  }
  const repo = json<{ private?: unknown; visibility?: unknown }>(host, answer, repository);
  if (repo.private !== false || (repo.visibility !== undefined && repo.visibility !== 'public'))
    throw hidden;
}

const firstLine = (message: string) => message.split('\n')[0]?.trim().slice(0, 120) ?? '';

/** The commit what it follows is at now. */
export async function latest(host: HostAccess, f: Follow): Promise<Found> {
  await ensurePublic(host, f.repository);
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

async function commitAt(host: HostAccess, repository: string, ref: string): Promise<Found> {
  const c = json<{ sha: string; commit: { message: string } }>(
    host,
    await api(host, `/repos/${repoPath(repository)}/commits/${enc(ref)}`),
    `${ref} in ${repository}`,
  );
  if (!COMMIT.test(c.sha))
    throw new SourceError(`${host.def.displayName} sent something unexpected.`);
  return { commit: c.sha, label: firstLine(c.commit.message) };
}

/**
 * How many commits `head` is ahead of `base` (null when they don't compare: history rewritten).
 * Only ever asked straight after `latest`, which checked the repository is still public.
 */
export async function behindBy(host: HostAccess, repository: string, base: string, head: string) {
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
export async function archive(
  host: HostAccess,
  repository: string,
  commit: string,
): Promise<Buffer> {
  if (!COMMIT.test(commit)) throw new SourceError('Not a commit.');
  await ensurePublic(host, repository);
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
