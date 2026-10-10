import type { Json, ResultCode } from '@allthespaces/bridge-protocol';
import type { ConnectorInfo } from '@ats/api-types';
import { ApiError, api } from './api.ts';

export type { ConnectorInfo };

/** The connectors this server has, and your links to them. */
export const loadConnectors = () =>
  api<{ connectors: ConnectorInfo[] }>('/api/connectors').then((r) => r.connectors);

/**
 * Starts linking your account: the server makes a one-time link to the service, and the whole
 * page goes there (never a pop-up, so it works in an installed app on a phone). The service
 * sends you back to `returnTo`, a page in this app.
 */
export async function startLink(connectorId: string, returnTo: string) {
  const { authorizeUrl } = await api<{ authorizeUrl: string }>(
    `/api/connectors/${encodeURIComponent(connectorId)}/link`,
    { method: 'POST', json: { returnTo } },
  );
  window.location.assign(authorizeUrl);
}

/** The flags the server adds to the page it sends you back to after linking. */
const LINK_FLAGS = ['linked', 'link_error', 'link_check', 'link_connector', 'link_reason'];

/** How linking went, from the flags on the page you came back to; null when there are none. */
export interface LinkReturn {
  /** The connector it was about, when the server said. */
  connector: string | null;
  outcome: 'linked' | 'unconfirmed' | 'refused' | 'cancelled' | 'expired' | 'failed';
}

export function readLinkReturn(search: string): LinkReturn | null {
  const q = new URLSearchParams(search);
  const linked = q.get('linked');
  const failed = q.get('link_error');
  if (linked)
    return {
      connector: linked,
      outcome: q.get('link_check') === 'unconfirmed' ? 'unconfirmed' : 'linked',
    };
  if (!failed) return null;
  return {
    connector: q.get('link_connector'),
    outcome:
      failed === 'refused_by_service'
        ? 'refused'
        : failed === 'access_denied'
          ? 'cancelled'
          : failed === 'expired'
            ? 'expired'
            : 'failed',
  };
}

/** Takes the flags off the address, so a reload doesn't say it again. */
export function clearLinkFlags() {
  const url = new URL(window.location.href);
  for (const key of LINK_FLAGS) url.searchParams.delete(key);
  window.history.replaceState(null, '', url);
}

/**
 * What to tell the person about a link-check result, naming the service: the service refused the
 * account, or couldn't be reached to check it. Null for the other outcomes.
 */
export function linkCheckWords(outcome: LinkReturn['outcome'], displayName: string | null) {
  if (outcome === 'refused')
    return `${displayName ?? 'The service'} said this account can’t use it. Link a different account, or ask its owner.`;
  if (outcome === 'unconfirmed')
    return `Linked, but ${displayName ?? 'the service'} couldn’t be reached to check it yet.`;
  return null;
}

export const unlink = (connectorId: string) =>
  api(`/api/connectors/${encodeURIComponent(connectorId)}/link`, { method: 'DELETE' });

/** "loans:write" → "Change your loans"; anything else as it is. */
export function scopeWords(scope: string): string {
  const m = /^([\w-]+)[:.](read|write)$/i.exec(scope);
  if (!m) return scope;
  const what = (m[1] as string).replace(/[_-]+/g, ' ');
  return `${(m[2] as string).toLowerCase() === 'read' ? 'See' : 'Change'} your ${what}`;
}

const CODES = new Set<ResultCode>([
  'not-linked',
  'not-approved',
  'denied',
  'trial',
  'clash',
  'rejected',
  'upstream',
  'too-big',
]);

/** A failed connector call, as the bridge tells the creation. */
export function callFailure(err: unknown): { error: string; code: ResultCode; details?: Json } {
  const e = err instanceof ApiError ? err : new ApiError('Something went wrong.', 0);
  const body = (e.body ?? {}) as { code?: string; upstream?: Json };
  const code: ResultCode =
    body.code && CODES.has(body.code as ResultCode)
      ? (body.code as ResultCode)
      : e.status === 0 || e.status >= 500
        ? 'upstream'
        : 'denied';
  return {
    error: e.message,
    code,
    ...(body.upstream !== undefined ? { details: body.upstream } : {}),
  };
}
