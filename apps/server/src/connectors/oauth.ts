import { createHash, randomBytes } from 'node:crypto';
import { HttpError, isJson, pinningFor, send } from './http.ts';
import type { Connector } from './registry.ts';

/**
 * Linking a person's account at a connector's service: OAuth 2 authorization code with PKCE
 * (S256). The server is a confidential client: its secret comes from the environment, and the
 * tokens never leave the server.
 */

const b64url = (b: Buffer) => b.toString('base64url');

/** A fresh `state` and PKCE verifier (32 random bytes each), and what's kept of them. */
export function newAttempt() {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  return { state, verifier, stateHash: hashState(state) };
}

export const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

export const challengeOf = (verifier: string) =>
  b64url(createHash('sha256').update(verifier).digest());

/** Where the person goes to say yes at the service. */
export function authorizeUrl(
  c: Connector,
  opts: { state: string; verifier: string; redirectUri: string },
): string {
  const url = new URL(c.def.oauth.authorizeUrl);
  for (const [k, v] of Object.entries(c.def.oauth.extraAuthorizeParams ?? {}))
    url.searchParams.set(k, v);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', c.def.oauth.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', c.def.oauth.scopes.join(' '));
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', challengeOf(opts.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

/** The service said no to the grant itself (revoked, expired, already used): link again. */
export class GrantError extends Error {}

/** Couldn't reach the service, or it answered something we can't use: try again later. */
export class TokenServiceError extends Error {}

const TOKEN_TIMEOUT_MS = 10_000;
const TOKEN_MAX_BYTES = 32 * 1024;

function clientAuth(c: Connector, form: URLSearchParams): Record<string, string> {
  if (c.def.oauth.tokenAuth === 'basic') {
    // RFC 6749 §2.3.1: each part form-encoded, then Basic.
    const id = encodeURIComponent(c.def.oauth.clientId);
    const secret = encodeURIComponent(c.clientSecret);
    return { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` };
  }
  form.set('client_id', c.def.oauth.clientId);
  form.set('client_secret', c.clientSecret);
  return {};
}

async function tokenRequest(
  c: Connector,
  form: URLSearchParams,
  previous?: { refreshToken: string | null; scopes: string[] },
): Promise<Tokens> {
  const headers = {
    ...clientAuth(c, form),
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };
  let answer: Awaited<ReturnType<typeof send>>;
  try {
    answer = await send(c.def.oauth.tokenUrl, {
      method: 'POST',
      headers,
      body: form.toString(),
      timeoutMs: TOKEN_TIMEOUT_MS,
      maxBytes: TOKEN_MAX_BYTES,
      pin: pinningFor(c.def),
    });
  } catch (err) {
    throw new TokenServiceError(err instanceof HttpError ? err.message : 'unreachable');
  }
  let body: Record<string, unknown> = {};
  try {
    if (isJson(answer.contentType)) body = JSON.parse(answer.body.toString('utf8'));
  } catch {}
  if (answer.status >= 400 && answer.status < 500) {
    // RFC 6749 §5.2: the grant is no good (invalid_grant), or the request was refused.
    if (
      body.error === 'invalid_grant' ||
      answer.status === 401 ||
      body.error === 'unauthorized_client'
    )
      throw new GrantError(String(body.error ?? answer.status));
    throw new TokenServiceError(`refused (${answer.status})`);
  }
  if (answer.status !== 200 || typeof body.access_token !== 'string' || !body.access_token)
    throw new TokenServiceError(`unexpected answer (${answer.status})`);
  if (typeof body.token_type === 'string' && body.token_type.toLowerCase() !== 'bearer')
    throw new TokenServiceError('not a bearer token');
  const expiresIn = Number(body.expires_in);
  const granted =
    typeof body.scope === 'string'
      ? body.scope.split(/\s+/).filter((s) => c.def.oauth.scopes.includes(s))
      : (previous?.scopes ?? c.def.oauth.scopes);
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : (previous?.refreshToken ?? null),
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
    scopes: granted,
  };
}

/** Swaps the code from the callback for tokens. */
export function exchangeCode(
  c: Connector,
  opts: { code: string; verifier: string; redirectUri: string },
): Promise<Tokens> {
  return tokenRequest(
    c,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
    }),
  );
}

/** A new access token from the refresh token (keeping the old refresh token unless rotated). */
export function refreshTokens(
  c: Connector,
  previous: { refreshToken: string; scopes: string[] },
): Promise<Tokens> {
  return tokenRequest(
    c,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }),
    previous,
  );
}

/** Tells the service to forget a token (RFC 7009). Best effort: failures are ignored. */
export async function revokeToken(
  c: Connector,
  token: string,
  hint: 'refresh_token' | 'access_token',
): Promise<void> {
  if (!c.def.oauth.revokeUrl) return;
  const form = new URLSearchParams({ token, token_type_hint: hint });
  try {
    await send(c.def.oauth.revokeUrl, {
      method: 'POST',
      headers: {
        ...clientAuth(c, form),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      timeoutMs: 5000,
      maxBytes: 8 * 1024,
      pin: pinningFor(c.def),
    });
  } catch {}
}
