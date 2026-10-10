import { type Db, schema } from '@ats/db';
import { atPointer } from '@ats/shared';
import { eq } from 'drizzle-orm';
import { type LinkRow, tokensOf } from './links.ts';
import { revokeToken } from './oauth.ts';
import { forward } from './proxy.ts';
import type { Connector } from './registry.ts';

const { connectorLinks } = schema;

/** The link check is waited for while the person watches: never longer than this per request. */
const CHECK_TIMEOUT_MS = 8000;
const MAX_NAME = 60;
const UPSTREAM_CODE = /^[A-Z_]{1,40}$/;

/**
 * What the link check found (docs/connectors.md):
 *
 * - `ok`: the service answered; `accountName` is who it says the account is, when it said.
 * - `refused`: the service said this account can't use it (401 even after a refresh, or 403).
 * - `unconfirmed`: anything else (unreachable, slow, too big, another error). The link may well
 *   be fine, so it's kept.
 */
export type LinkCheckResult =
  | { result: 'ok'; accountName: string | null }
  | {
      result: 'refused';
      /** The service's answer (403), or null when it took back the grant itself (401). */
      status: number | null;
      /** Its machine-readable code, when it gave one that looks like one. */
      code?: string;
    }
  | { result: 'unconfirmed' };

/**
 * Plain text for a name the service gave: no control or direction-changing characters, trimmed,
 * at most 60 characters. Null when nothing's left.
 */
export function cleanAccountName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const plain = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  const cut = [...plain].slice(0, MAX_NAME).join('').trim();
  return cut || null;
}

/**
 * Right after someone links: one call to the connector's `linkCheck` operation, as them, through
 * the same path creation calls take (pinning, headers, size cap, refresh once on 401). It proves
 * the link works, learns who they're linked as, and lets a service that records connected apps
 * only on first use see this one straight away. Nothing from the answer is kept but the name.
 */
export async function checkLink(
  db: Db,
  opts: { secret: string; release: string; connector: Connector; link: LinkRow },
): Promise<LinkCheckResult> {
  const check = opts.connector.def.linkCheck;
  const op = check && opts.connector.def.operations[check.op];
  // Only a GET read that needs nothing filled in (checked when the definition was read), and
  // only within what the person granted.
  if (!check || !op || op.kind !== 'read' || op.method !== 'GET') return { result: 'unconfirmed' };
  if (!opts.link.scopes.includes(op.scope)) return { result: 'unconfirmed' };
  const outcome = await forward(db, {
    secret: opts.secret,
    release: opts.release,
    connector: opts.connector,
    op: { ...op, timeoutMs: Math.min(op.timeoutMs ?? CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS) },
    link: opts.link,
    params: {},
  });
  if (outcome.ok) {
    const accountName =
      check.nameField !== undefined
        ? cleanAccountName(atPointer(outcome.data, check.nameField))
        : null;
    const now = new Date();
    await db
      .update(connectorLinks)
      .set({ checkedAt: now, lastUsedAt: now, accountName })
      .where(eq(connectorLinks.id, opts.link.id));
    return { result: 'ok', accountName };
  }
  if (
    outcome.code === 'not-linked' ||
    (outcome.code === 'denied' && outcome.upstream?.status === 403)
  ) {
    const code = outcome.upstream?.code;
    return {
      result: 'refused',
      status: outcome.upstream?.status ?? null,
      ...(code && UPSTREAM_CODE.test(code) ? { code } : {}),
    };
  }
  return { result: 'unconfirmed' };
}

/**
 * Takes a link away: the service is asked to revoke its tokens (best effort, when it has a
 * revoke address), and the link is deleted either way.
 */
export async function dropLink(
  db: Db,
  secret: string,
  connector: Connector | undefined,
  linkId: string,
): Promise<void> {
  const [link] = await db.select().from(connectorLinks).where(eq(connectorLinks.id, linkId));
  if (!link) return;
  if (connector) {
    try {
      const t = tokensOf(link, secret);
      if (t.refreshToken) await revokeToken(connector, t.refreshToken, 'refresh_token');
      await revokeToken(connector, t.accessToken, 'access_token');
    } catch {}
  }
  await db.delete(connectorLinks).where(eq(connectorLinks.id, link.id));
}
