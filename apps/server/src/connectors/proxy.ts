import { createHash } from 'node:crypto';
import type { Db } from '@ats/db';
import { type ConnectorOperation, expandPath } from '@ats/shared';
import { HttpError, isJson, pinningFor, send, userAgent } from './http.ts';
import { LinkBrokenError, type LinkRow, markBroken, refreshLink, tokensOf } from './links.ts';
import { TokenServiceError } from './oauth.ts';
import type { Connector } from './registry.ts';

/**
 * Why a call didn't work, as the bridge tells the creation (`code` on a failed `result`):
 *
 * - `not-linked`: the person hasn't linked their account, or it stopped working: link again.
 * - `not-approved`: this version doesn't declare the operation, or no Architect approved it.
 * - `denied`: not allowed (the service said 403, the link lacks the scope, too many calls).
 * - `trial`: an Architect trying a version that isn't live can only read.
 * - `clash`: the service said 409 (it changed in the meantime: read it again).
 * - `rejected`: what was sent doesn't fit (here, or the service's other 4xx answers).
 * - `upstream`: the service is unreachable, slow, busy (429) or failing (5xx), or answered
 *   something that isn't JSON. Trying again later may work.
 * - `too-big`: the answer was bigger than the operation allows.
 */
export type CallCode =
  | 'not-linked'
  | 'not-approved'
  | 'denied'
  | 'trial'
  | 'clash'
  | 'rejected'
  | 'upstream'
  | 'too-big';

/** What a service said when it refused, passed on only in this cleaned-up shape. */
export interface UpstreamError {
  status: number;
  /** Its machine-readable code, if it looks like one (`BOOK_UNAVAILABLE`). */
  code?: string;
  /** Its message, at most 200 characters. */
  message?: string;
  /** Its details, if they're JSON of at most 2 KB. */
  details?: unknown;
}

export type CallOutcome =
  | { ok: true; status: number; data: unknown }
  | { ok: false; code: CallCode; error: string; upstream?: UpstreamError };

const MAX_MESSAGE = 200;
const MAX_DETAILS = 2048;
const CODE = /^[A-Z_]{1,40}$/;

/** Keeps only `{status, code, message, details}` from a service's error answer, within limits. */
export function sanitizeUpstream(status: number, contentType: string, body: Buffer): UpstreamError {
  const out: UpstreamError = { status };
  if (!isJson(contentType)) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const top = parsed as Record<string, unknown>;
  // `{ code, message, details }`, or the same inside `error`.
  const e =
    top.error && typeof top.error === 'object' && !Array.isArray(top.error)
      ? (top.error as Record<string, unknown>)
      : top;
  if (typeof e.code === 'string' && CODE.test(e.code)) out.code = e.code;
  const message = typeof e.message === 'string' ? e.message : undefined;
  if (message) out.message = message.slice(0, MAX_MESSAGE);
  if (e.details !== undefined) {
    try {
      const text = JSON.stringify(e.details);
      if (text !== undefined && text.length <= MAX_DETAILS) out.details = JSON.parse(text);
    } catch {}
  }
  return out;
}

/** Which bridge code a service's status means. */
export function codeForStatus(status: number): CallCode {
  if (status === 401) return 'not-linked';
  if (status === 403) return 'denied';
  if (status === 409) return 'clash';
  if (status === 429) return 'upstream';
  if (status >= 400 && status < 500) return 'rejected';
  return 'upstream';
}

/** The idempotency key a service sees: derived, so it never carries anything a creation chose. */
export const idempotencyValue = (userId: string, creationId: string, key: string) =>
  `ats-${createHash('sha256').update(`${userId}\0${creationId}\0${key}`).digest('hex').slice(0, 40)}`;

const REFRESH_EARLY_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Calls one operation of a connector's service as this person, with their own token: refreshed
 * first when it's about to expire, and once more if the service says 401. Nothing a creation
 * sends reaches the service except what the operation's schema allowed, in the places it allows.
 */
export async function forward(
  db: Db,
  opts: {
    secret: string;
    release: string;
    connector: Connector;
    op: ConnectorOperation;
    link: LinkRow;
    params?: Record<string, unknown> | undefined;
    body?: unknown;
    /** The idempotency header's value, for writes that have one. */
    idempotency?: string | undefined;
  },
): Promise<CallOutcome> {
  const { connector, op } = opts;
  const where = expandPath(op.path, opts.params as Parameters<typeof expandPath>[1]);
  if ('error' in where) return { ok: false, code: 'rejected', error: where.error };
  const target = `${connector.def.baseUrl.replace(/\/+$/, '')}${where.path}${where.query}`;
  // Belt and braces: whatever the path became, it's still on the service's own address.
  const base = new URL(connector.def.baseUrl);
  const url = new URL(target);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/+$/, '')))
    return { ok: false, code: 'rejected', error: 'That path leaves the service.' };

  let link = opts.link;
  const notLinked = (): CallOutcome => ({
    ok: false,
    code: 'not-linked',
    error: `Link your ${connector.def.displayName} account again to carry on.`,
  });
  const unreachable = (): CallOutcome => ({
    ok: false,
    code: 'upstream',
    error: `${connector.def.displayName} can't be reached right now. Try again in a moment.`,
  });
  const refresh = async () => {
    link = await refreshLink(db, opts.secret, connector, link);
  };
  const breakLink = async (): Promise<CallOutcome> => {
    await markBroken(db, link.id);
    return notLinked();
  };
  let refreshed = false;
  try {
    if (link.accessExpiresAt && link.accessExpiresAt.getTime() - Date.now() < REFRESH_EARLY_MS) {
      await refresh();
      refreshed = true;
    }
  } catch (err) {
    if (err instanceof LinkBrokenError) return notLinked();
    if (err instanceof TokenServiceError) return unreachable();
    throw err;
  }

  const once = () => {
    const { accessToken } = tokensOf(link, opts.secret);
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'user-agent': userAgent(opts.release),
    };
    let payload: string | undefined;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    if (op.kind === 'write' && op.idempotencyHeader && opts.idempotency)
      headers[op.idempotencyHeader.toLowerCase()] = opts.idempotency;
    return send(target, {
      method: op.method,
      headers,
      body: payload,
      timeoutMs: op.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: op.maxResponseBytes,
      pin: pinningFor(connector.def),
    });
  };

  let answer: Awaited<ReturnType<typeof send>>;
  try {
    answer = await once();
    if (answer.status === 401) {
      // An expired or revoked token: refresh once and try once more. Still 401 with a token the
      // service just issued means the grant itself is gone.
      if (refreshed) return await breakLink();
      await refresh();
      answer = await once();
      if (answer.status === 401) return await breakLink();
    }
  } catch (err) {
    if (err instanceof LinkBrokenError) return notLinked();
    if (err instanceof TokenServiceError) return unreachable();
    if (err instanceof HttpError) {
      if (err.kind === 'too-big')
        return {
          ok: false,
          code: 'too-big',
          error: `${connector.def.displayName} answered with more than this can carry.`,
        };
      return unreachable();
    }
    throw err;
  }

  const { status, contentType, body } = answer;
  if (status >= 200 && status < 300) {
    if (body.length === 0) return { ok: true, status, data: null };
    if (!isJson(contentType))
      return { ok: false, code: 'upstream', error: `${connector.def.displayName} answered oddly.` };
    try {
      return { ok: true, status, data: JSON.parse(body.toString('utf8')) };
    } catch {
      return { ok: false, code: 'upstream', error: `${connector.def.displayName} answered oddly.` };
    }
  }
  const upstream = sanitizeUpstream(status, contentType, body);
  // Redirects aren't followed: an answer that moves elsewhere is a service problem.
  const code = status >= 300 && status < 400 ? 'upstream' : codeForStatus(status);
  return {
    ok: false,
    code,
    error:
      upstream.message ??
      (code === 'upstream'
        ? `${connector.def.displayName} couldn't do that right now. Try again in a moment.`
        : `${connector.def.displayName} said no (${status}).`),
    upstream,
  };
}

/** Calls per minute, for each person and connector: reading, and changing things. */
export const CALL_LIMITS = { read: 120, write: 30 } as const;

/** A simple per-minute counter (one server process; nothing to share). */
export class MinuteLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  /** Counts a call; false when this key has had its share this minute. */
  take(key: string, max: number, now = Date.now()): boolean {
    const w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      if (this.windows.size > 10_000) {
        for (const [k, v] of this.windows) if (now - v.start >= 60_000) this.windows.delete(k);
      }
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= max) return false;
    w.count++;
    return true;
  }
}
