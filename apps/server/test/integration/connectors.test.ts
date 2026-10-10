// Connectors: linking a person's own account at a service (OAuth with PKCE), approving what a
// creation uses, and creations calling the service through the server. A fake service (its
// OAuth endpoints and its API) runs on 127.0.0.1; the test connector allows that private address.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Db, schema } from '@ats/db';
import { parseConnectorDefinition } from '@ats/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveLink } from '../../src/connectors/links.ts';
import { type Connector, registryOf } from '../../src/connectors/registry.ts';
import { safeReturnTo } from '../../src/connectors/routes.ts';
import { publishCreation } from '../../src/creations/store.ts';
import {
  addSampleSpace,
  adminUrl,
  cookieFrom,
  createTestApp,
  ORIGIN,
  seedGroup,
  type TestApp,
} from '../harness.ts';

const CLIENT_ID = 'ats-test-client';
const CLIENT_SECRET = 'lanternfield-client-secret-for-tests';

/** Everything the fake service saw and decided; tests read and change it. */
interface FakeService {
  port: number;
  /** Codes it handed out at its consent page: code → what was agreed. */
  codes: Map<string, { challenge: string; redirectUri: string; account: string; scopes: string[] }>;
  /** Access tokens it accepts → whose account. */
  access: Map<string, string>;
  /** Refresh tokens it accepts → whose account. */
  refresh: Map<string, string>;
  /** Tokens it was asked to revoke. */
  revoked: string[];
  tokenRequests: { grant: string; auth: string | undefined }[];
  /** Every API request, as it arrived. */
  api: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[];
  /** How long new access tokens last (seconds). */
  expiresIn: number;
  /** Refuse every API call with 401 GRANT_REVOKED. */
  revokeAll: boolean;
  /** Refuse refreshing (as if the grant was withdrawn). */
  refuseRefresh: boolean;
  /** How it answers `GET /v1/me` (the link check) for an account, and how long it takes. */
  whoAmI: (account: string) => { status: number; body: unknown };
  whoAmIDelayMs: number;
  close(): Promise<void>;
}

async function startService(): Promise<FakeService> {
  let n = 0;
  const svc = {
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
    revoked: [] as string[],
    tokenRequests: [] as FakeService['tokenRequests'],
    api: [] as FakeService['api'],
    expiresIn: 3600,
    revokeAll: false,
    refuseRefresh: false,
    whoAmI: () => ({ status: 200, body: { member: { displayName: 'Ada' } } }),
    whoAmIDelayMs: 0,
  } as unknown as FakeService;
  const issue = (account: string, scopes: string[]) => {
    n++;
    const accessToken = `at-${account}-${n}`;
    const refreshToken = `rt-${account}-${n}`;
    svc.access.set(accessToken, account);
    svc.refresh.set(refreshToken, account);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: svc.expiresIn,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (status: number, value: unknown, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
      };
      if (url.pathname === '/oauth/token') {
        const form = new URLSearchParams(body);
        svc.tokenRequests.push({
          grant: form.get('grant_type') ?? '',
          auth: req.headers.authorization,
        });
        const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
        if (req.headers.authorization !== basic) return json(401, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          const agreed = svc.codes.get(form.get('code') ?? '');
          svc.codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (
            !agreed ||
            agreed.challenge !== challenge ||
            agreed.redirectUri !== form.get('redirect_uri')
          )
            return json(400, { error: 'invalid_grant' });
          return json(200, issue(agreed.account, agreed.scopes));
        }
        if (form.get('grant_type') === 'refresh_token') {
          const account = svc.refresh.get(form.get('refresh_token') ?? '');
          if (!account || svc.refuseRefresh) return json(400, { error: 'invalid_grant' });
          svc.refresh.delete(form.get('refresh_token') ?? '');
          return json(200, issue(account, ['shelves:read', 'loans:read', 'loans:write']));
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/oauth/revoke') {
        svc.revoked.push(new URLSearchParams(body).get('token') ?? '');
        return json(200, {});
      }
      svc.api.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const account = svc.access.get(token);
      if (svc.revokeAll)
        return json(401, { code: 'GRANT_REVOKED', message: 'This app was disconnected.' });
      if (!account) return json(401, { code: 'TOKEN_INVALID', message: 'Sign in again.' });
      const path = url.pathname;
      if (path === '/api/v1/shelves')
        return json(200, { shelves: ['Poetry', 'Maps'], page: url.searchParams.get('page') });
      if (path === '/api/v1/loans/me') return json(200, { account, loans: [] });
      if (path === '/api/v1/me') {
        const { status, body } = svc.whoAmI(account);
        if (!svc.whoAmIDelayMs) return json(status, body);
        setTimeout(() => json(status, body), svc.whoAmIDelayMs);
        return;
      }
      const loan = /^\/api\/v1\/books\/([^/]+)\/loan$/.exec(path);
      if (loan && req.method === 'PUT') {
        if (loan[1] === '409')
          return json(409, { code: 'ALREADY_ON_LOAN', message: 'Someone has it already.' });
        return json(200, { account, book: loan[1], body: JSON.parse(body || 'null') });
      }
      if (loan && req.method === 'DELETE') {
        res.writeHead(204);
        return res.end();
      }
      if (path === '/api/v1/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${svc.port}/api/v1/elsewhere` });
        return res.end();
      }
      if (path === '/api/v1/big') return json(200, { items: 'x'.repeat(5000) });
      if (path === '/api/v1/html') return json(200, '<html>hello</html>', 'text/html');
      if (path === '/api/v1/bad')
        return json(422, {
          code: 'not a code; drop table',
          message: 'm'.repeat(500),
          details: { big: 'd'.repeat(3000) },
        });
      if (path === '/api/v1/fussy')
        return json(422, {
          error: { code: 'SHELF_FULL', message: 'That shelf is full.', details: { max: 12 } },
        });
      if (path === '/api/v1/broken') return json(503, { message: 'Down for repairs.' });
      return json(404, { code: 'NOT_FOUND' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  svc.port = (server.address() as AddressInfo).port;
  svc.close = () => new Promise((r) => server.close(() => r()));
  return svc;
}

function lanternfield(port: number, overrides: Record<string, unknown> = {}) {
  const base = `http://127.0.0.1:${port}`;
  const params = (pattern: string) => ({
    type: 'object',
    properties: { bookId: { type: 'string', pattern } },
    required: ['bookId'],
    additionalProperties: false,
  });
  const read = (path: string, extra: Record<string, unknown> = {}) => ({
    method: 'GET',
    path,
    scope: 'shelves:read',
    kind: 'read',
    maxResponseBytes: 4000,
    ...extra,
  });
  return parseConnectorDefinition({
    id: 'lanternfield',
    displayName: 'Lanternfield Library',
    description: 'Borrow and return books from the club shelves.',
    baseUrl: `${base}/api`,
    allowPrivateAddress: true,
    oauth: {
      authorizeUrl: `${base}/oauth/authorize?prompt=consent`,
      tokenUrl: `${base}/oauth/token`,
      revokeUrl: `${base}/oauth/revoke`,
      clientId: CLIENT_ID,
      clientSecretEnv: 'ATS_CONNECTOR_LANTERNFIELD',
      scopes: ['shelves:read', 'loans:read', 'loans:write', 'admin:read'],
      pkce: true,
      tokenAuth: 'basic',
      extraAuthorizeParams: { audience: 'lanternfield' },
    },
    operations: {
      listShelves: read('/v1/shelves', {
        params: {
          type: 'object',
          properties: { page: { type: 'integer', minimum: 1, maximum: 50 } },
          additionalProperties: false,
        },
      }),
      getMyLoans: read('/v1/loans/me', { scope: 'loans:read' }),
      borrowBook: {
        method: 'PUT',
        path: '/v1/books/:bookId/loan',
        params: params('^[0-9]{1,6}$'),
        body: {
          type: 'object',
          properties: { weeks: { type: 'integer', minimum: 1, maximum: 4 } },
          required: ['weeks'],
          additionalProperties: false,
        },
        scope: 'loans:write',
        kind: 'write',
        idempotencyHeader: 'Idempotency-Key',
        maxResponseBytes: 4000,
      },
      returnBook: {
        method: 'DELETE',
        path: '/v1/books/:bookId/loan',
        params: params('^[0-9]{1,6}$'),
        scope: 'loans:write',
        kind: 'write',
        maxResponseBytes: 4000,
      },
      goElsewhere: read('/v1/redirect'),
      bigList: read('/v1/big', { maxResponseBytes: 1000 }),
      pageOfText: read('/v1/html'),
      refuse: read('/v1/bad'),
      fussy: read('/v1/fussy'),
      broken: read('/v1/broken'),
      adminReport: read('/v1/admin', { scope: 'admin:read' }),
      whoAmI: read('/v1/me', { scope: 'loans:read', timeoutMs: 500 }),
    },
    ...overrides,
  });
}

const ALL_OPS = [
  'listShelves',
  'getMyLoans',
  'borrowBook',
  'returnBook',
  'goElsewhere',
  'bigList',
  'pageOfText',
  'refuse',
  'fussy',
  'broken',
  'adminReport',
];

describe.skipIf(!adminUrl)('connectors', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let db: Db;
  let svc: FakeService;
  let architectCookie = '';
  let memberCookie = '';
  let groupId = '';
  let spaceId = '';
  let creationId = '';
  let versionId = '';

  beforeAll(async () => {
    svc = await startService();
    const connectors: Connector[] = [
      { def: lanternfield(svc.port), clientSecret: CLIENT_SECRET },
      // The same service, but the owner didn't allow private addresses: it's never reached.
      {
        def: { ...lanternfield(svc.port), id: 'lanternfield-public', allowPrivateAddress: false },
        clientSecret: CLIENT_SECRET,
      },
      // With a link check: who you are, asked right after linking.
      {
        def: lanternfield(svc.port, {
          id: 'lanternfield-checked',
          linkCheck: { op: 'whoAmI', nameField: '/member/displayName' },
        }),
        clientSecret: CLIENT_SECRET,
      },
      // Pinned: the name doesn't resolve, the owner's resolveTo says where it is.
      {
        def: lanternfield(svc.port, {
          id: 'lanternfield-pinned',
          baseUrl: 'http://library.lanternfield.invalid:8080/api',
          resolveTo: `127.0.0.1:${svc.port}`,
        }),
        clientSecret: CLIENT_SECRET,
      },
    ];
    t = await createTestApp({ connectors: registryOf(connectors) });
    ({ app, db } = t);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
    const published = await publishCreation(db, t.storage, {
      groupId,
      spaceId,
      objectKey: 'sofa',
      title: 'Lending desk',
      files: new Map([['index.html', new TextEncoder().encode('<!doctype html><p>desk</p>')]]),
      sdkVersion: '0.1.0',
      protocolVersion: 1,
      connectors: [
        { id: 'lanternfield', ops: ALL_OPS, why: 'Shows the shelves and lets you borrow books.' },
        { id: 'lanternfield-public', ops: ['listShelves'], why: 'The same, the public way.' },
        { id: 'lanternfield-pinned', ops: ['getMyLoans'], why: 'The same, pinned.' },
      ],
    });
    creationId = published.creationId;
    versionId = published.versionId;
    // It uses connectors, so it waits as a candidate however it was published.
    expect(published.live).toBe(false);
  });

  afterAll(async () => {
    await t?.close();
    await svc?.close();
  });

  const inject = (method: string, url: string, cookie: string, payload?: object) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { cookie, origin: ORIGIN },
      ...(payload ? { payload } : {}),
    });
  const call = (
    cookie: string,
    payload: Record<string, unknown>,
    connector = 'lanternfield',
    creation = creationId,
  ) =>
    inject('POST', `/api/creations/${creation}/connectors/${connector}/call`, cookie, {
      versionId,
      ...payload,
    });
  const userIdOf = async (cookie: string) =>
    (await inject('GET', '/api/me', cookie)).json().user.id as string;

  /** Starts linking, says yes at the service as `account`, and comes back. */
  async function startLink(cookie: string, connector = 'lanternfield', returnTo = '/account') {
    const res = await inject('POST', `/api/connectors/${connector}/link`, cookie, { returnTo });
    expect(res.statusCode).toBe(200);
    return new URL(res.json().authorizeUrl as string);
  }
  function consent(
    at: URL,
    account: string,
    scopes = ['shelves:read', 'loans:read', 'loans:write'],
  ) {
    const code = `code-${account}-${Math.random().toString(36).slice(2)}`;
    svc.codes.set(code, {
      challenge: at.searchParams.get('code_challenge') ?? '',
      redirectUri: at.searchParams.get('redirect_uri') ?? '',
      account,
      scopes,
    });
    return code;
  }
  const callback = (cookie: string, query: Record<string, string>) =>
    inject('GET', `/api/connectors/callback?${new URLSearchParams(query)}`, cookie);
  async function link(cookie: string, account: string, connector = 'lanternfield') {
    const at = await startLink(cookie, connector);
    const res = await callback(cookie, {
      state: at.searchParams.get('state') as string,
      code: consent(at, account),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/account?linked=${connector}`);
  }

  describe('linking an account', () => {
    it('lists what this server has, with no secrets', async () => {
      const res = await inject('GET', '/api/connectors', memberCookie);
      expect(res.statusCode).toBe(200);
      expect(res.json().connectors[0]).toEqual({
        id: 'lanternfield',
        displayName: 'Lanternfield Library',
        description: 'Borrow and return books from the club shelves.',
        scopes: ['shelves:read', 'loans:read', 'loans:write', 'admin:read'],
        linked: false,
        linkedAt: null,
        broken: false,
        accountName: null,
        checked: false,
      });
      expect(res.body).not.toContain(CLIENT_SECRET);
      expect(res.body).not.toContain('tokenUrl');
      expect((await app.inject({ method: 'GET', url: '/api/connectors' })).statusCode).toBe(401);
    });

    it('sends the person to the service with PKCE (S256) and a state kept only as a hash', async () => {
      const at = await startLink(architectCookie);
      expect(at.origin).toBe(`http://127.0.0.1:${svc.port}`);
      expect(Object.fromEntries(at.searchParams)).toMatchObject({
        prompt: 'consent',
        audience: 'lanternfield',
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: `${ORIGIN}/api/connectors/callback`,
        scope: 'shelves:read loans:read loans:write admin:read',
        code_challenge_method: 'S256',
      });
      const state = at.searchParams.get('state') as string;
      expect(state).toMatch(/^[\w-]{43}$/);
      const [row] = await db
        .select()
        .from(schema.connectorLinkAttempts)
        .where(
          eq(
            schema.connectorLinkAttempts.stateHash,
            createHash('sha256').update(state).digest('hex'),
          ),
        );
      expect(row?.returnTo).toBe('/account');
      // The verifier is sealed, and only its challenge went to the service.
      expect(row?.verifierEnc).not.toContain(at.searchParams.get('code_challenge'));
      const wrongVerifier = await callback(architectCookie, {
        state,
        // A code issued for a different challenge: the service refuses it.
        code: (() => {
          const c = 'code-forged';
          svc.codes.set(c, {
            challenge: 'not-the-challenge',
            redirectUri: `${ORIGIN}/api/connectors/callback`,
            account: 'pat',
            scopes: ['shelves:read'],
          });
          return c;
        })(),
      });
      expect(wrongVerifier.headers.location).toBe('/account?link_error=exchange_failed');
    });

    it('only comes back to a page in the app', async () => {
      for (const returnTo of [
        'https://elsewhere.example/',
        '//elsewhere.example/x',
        '/\\elsewhere.example',
        '/api/connectors/callback',
        'account',
        '/a b',
        '',
      ]) {
        const res = await inject('POST', '/api/connectors/lanternfield/link', memberCookie, {
          returnTo,
        });
        expect(res.statusCode, returnTo).toBe(400);
      }
      expect(safeReturnTo('/space/1?object=desk#x', ORIGIN)).toBe('/space/1?object=desk#x');
    });

    it('links, and keeps the tokens sealed', async () => {
      const before = svc.api.length;
      await link(architectCookie, 'pat');
      // This connector has no link check: linking calls nothing at the service's API.
      expect(svc.api.length).toBe(before);
      const listed = (await inject('GET', '/api/connectors', architectCookie)).json().connectors[0];
      expect(listed).toMatchObject({ linked: true, broken: false });
      const [row] = await db
        .select()
        .from(schema.connectorLinks)
        .where(eq(schema.connectorLinks.userId, await userIdOf(architectCookie)));
      expect(row?.scopes).toEqual(['shelves:read', 'loans:read', 'loans:write']);
      expect(row?.accessTokenEnc).not.toMatch(/at-pat/);
      expect(row?.refreshTokenEnc).not.toMatch(/rt-pat/);
      expect(svc.tokenRequests.at(-1)?.auth).toMatch(/^Basic /);
      const audit = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'connector.linked'));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toMatch(/at-pat|rt-pat/);
    });

    it("never finishes someone else's link: the attempt ends unused", async () => {
      const at = await startLink(architectCookie);
      const state = at.searchParams.get('state') as string;
      const res = await callback(memberCookie, { state, code: consent(at, 'pat') });
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      // Not even the person who started it can use it now.
      const again = await callback(architectCookie, { state, code: consent(at, 'pat') });
      expect(again.headers.location).toBe('/account?link_error=expired');
    });

    it('works once: a state used again is refused', async () => {
      const at = await startLink(architectCookie, 'lanternfield', '/space/x?object=desk');
      const state = at.searchParams.get('state') as string;
      const first = await callback(architectCookie, { state, code: consent(at, 'pat') });
      expect(first.headers.location).toBe('/space/x?object=desk&linked=lanternfield');
      const before = svc.tokenRequests.length;
      const replay = await callback(architectCookie, { state, code: consent(at, 'pat') });
      expect(replay.headers.location).toBe('/account?link_error=expired');
      expect(svc.tokenRequests.length).toBe(before);
    });

    it('expires after ten minutes', async () => {
      const at = await startLink(architectCookie);
      const state = at.searchParams.get('state') as string;
      await db
        .update(schema.connectorLinkAttempts)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(
          eq(
            schema.connectorLinkAttempts.stateHash,
            createHash('sha256').update(state).digest('hex'),
          ),
        );
      const res = await callback(architectCookie, { state, code: consent(at, 'pat') });
      expect(res.headers.location).toBe('/account?link_error=expired');
    });

    it('passes on a refusal at the service, cleaned up', async () => {
      for (const [error, flag] of [
        ['access_denied', 'access_denied'],
        ['access_denied<script>', 'refused'],
      ]) {
        const at = await startLink(architectCookie);
        const res = await callback(architectCookie, {
          state: at.searchParams.get('state') as string,
          error: error as string,
        });
        expect(res.headers.location).toBe(`/account?link_error=${flag}`);
      }
    });

    it('signed out, signs in first and then carries on', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/connectors/callback?state=abc&code=xyz&other=1',
      });
      expect(res.statusCode).toBe(302);
      const to = new URL(res.headers.location as string, ORIGIN);
      expect(to.pathname).toBe('/sign-in');
      expect(to.searchParams.get('resume')).toBe('/api/connectors/callback?state=abc&code=xyz');
    });
  });

  describe('approving what a version uses', () => {
    const live = () =>
      inject('POST', `/api/creations/${creationId}/versions/${versionId}/live`, architectCookie);
    const approveOps = (cookie: string, connectors: { id: string; ops: string[] }[]) =>
      inject(
        'POST',
        `/api/creations/${creationId}/versions/${versionId}/connectors/approve`,
        cookie,
        { connectors },
      );

    it('lets an Architect try reads before approving, but never writes', async () => {
      const read = await call(architectCookie, { op: 'getMyLoans' });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ ok: true, status: 200, data: { account: 'pat', loans: [] } });
      const write = await call(architectCookie, {
        op: 'borrowBook',
        params: { bookId: '7' },
        body: { weeks: 2 },
        idempotencyKey: 'borrow-0001',
      });
      expect(write.statusCode).toBe(403);
      expect(write.json()).toMatchObject({ ok: false, code: 'trial' });
      // Members don't even know a creation that isn't live yet is there.
      expect((await call(memberCookie, { op: 'getMyLoans' })).statusCode).toBe(404);
    });

    it("shows the Studio what it uses, and won't make it live until all of it is approved", async () => {
      const studio = (await inject('GET', `/api/spaces/${spaceId}/studio`, architectCookie)).json();
      const v = studio.creations
        .find((c: { id: string }) => c.id === creationId)
        .versions.find((x: { id: string }) => x.id === versionId);
      expect(v.connectors[0]).toMatchObject({
        id: 'lanternfield',
        displayName: 'Lanternfield Library',
        why: 'Shows the shelves and lets you borrow books.',
        approvedOps: [],
      });
      expect(v.connectors[0].operations[2]).toEqual({
        name: 'borrowBook',
        kind: 'write',
        scope: 'loans:write',
        method: 'PUT',
      });
      const refused = await live();
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('connectors-unapproved');

      expect(
        (await approveOps(memberCookie, [{ id: 'lanternfield', ops: ['getMyLoans'] }])).statusCode,
      ).toBe(404);
      const undeclared = await approveOps(architectCookie, [
        { id: 'lanternfield', ops: ['burnBooks'] },
      ]);
      expect(undeclared.statusCode).toBe(400);
      expect(
        (await approveOps(architectCookie, [{ id: 'lanternfield', ops: ['getMyLoans'] }]))
          .statusCode,
      ).toBe(200);
      expect((await live()).statusCode).toBe(409);
      const all = await approveOps(architectCookie, [
        { id: 'lanternfield', ops: ALL_OPS },
        { id: 'lanternfield-public', ops: ['listShelves'] },
        { id: 'lanternfield-pinned', ops: ['getMyLoans'] },
      ]);
      expect(all.statusCode).toBe(200);
      expect([...all.json().connectors[0].approvedOps].sort()).toEqual([...ALL_OPS].sort());
      expect((await live()).statusCode).toBe(200);
      const audit = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'connector.approved'));
      expect(audit.length).toBe(2);
      expect(audit[0]?.groupId).toBe(groupId);
    });
  });

  describe('calling the service', () => {
    beforeAll(async () => {
      await link(memberCookie, 'sam');
    });

    it('calls as the person, with their own token, and sends nothing of theirs but that', async () => {
      const res = await call(memberCookie, { op: 'listShelves', params: { page: 2 } });
      expect(res.json()).toEqual({
        ok: true,
        status: 200,
        data: { shelves: ['Poetry', 'Maps'], page: '2' },
      });
      const seen = svc.api.at(-1);
      expect(seen?.url).toBe('/api/v1/shelves?page=2');
      expect(seen?.headers.authorization).toMatch(/^Bearer at-sam-/);
      expect(Object.keys(seen?.headers ?? {}).sort()).toEqual([
        'accept',
        'authorization',
        'connection',
        'host',
        'user-agent',
      ]);
      expect(seen?.headers['user-agent']).toMatch(/^ATS-connector\//);
      // Pat's link is Pat's: Sam's calls never use it, and the other way round.
      expect((await call(memberCookie, { op: 'getMyLoans' })).json().data.account).toBe('sam');
      expect((await call(architectCookie, { op: 'getMyLoans' })).json().data.account).toBe('pat');
    });

    it('writes with a derived idempotency key, and records that it did', async () => {
      const res = await call(memberCookie, {
        op: 'borrowBook',
        params: { bookId: '42' },
        body: { weeks: 2 },
        idempotencyKey: 'borrow-42-try-1',
      });
      expect(res.json()).toMatchObject({
        ok: true,
        status: 200,
        data: { book: '42', body: { weeks: 2 } },
      });
      const seen = svc.api.at(-1);
      expect(seen?.method).toBe('PUT');
      expect(seen?.headers['content-type']).toBe('application/json');
      const sam = await userIdOf(memberCookie);
      const expected = `ats-${createHash('sha256').update(`${sam}\0${creationId}\0borrow-42-try-1`).digest('hex').slice(0, 40)}`;
      expect(seen?.headers['idempotency-key']).toBe(expected);
      const audit = await db
        .select()
        .from(schema.auditLog)
        .where(
          and(eq(schema.auditLog.action, 'connector.called'), eq(schema.auditLog.actorUserId, sam)),
        );
      expect(audit.at(-1)?.metadata).toMatchObject({
        connector: 'lanternfield',
        op: 'borrowBook',
        status: 200,
        result: 'ok',
      });
      expect(JSON.stringify(audit)).not.toMatch(/weeks|at-sam/);
      // A write without a key is refused before it reaches the service; a delete answers 204.
      const keyless = await call(memberCookie, {
        op: 'borrowBook',
        params: { bookId: '42' },
        body: { weeks: 1 },
      });
      expect(keyless.json().code).toBe('rejected');
      const back = await call(memberCookie, {
        op: 'returnBook',
        params: { bookId: '42' },
        idempotencyKey: 'return-42-1',
      });
      expect(back.json()).toEqual({ ok: true, status: 204, data: null });
    });

    it('checks what the creation sends against the definition', async () => {
      const bad = [
        { op: 'listShelves', params: { page: 0 } },
        { op: 'listShelves', params: { where: 'everything' } },
        { op: 'getMyLoans', params: { x: 1 } },
        {
          op: 'borrowBook',
          params: { bookId: '../admin' },
          body: { weeks: 1 },
          idempotencyKey: 'abcdefgh',
        },
        {
          op: 'borrowBook',
          params: { bookId: '1' },
          body: { weeks: 9 },
          idempotencyKey: 'abcdefgh',
        },
        { op: 'borrowBook', params: { bookId: '1' }, body: { weeks: 1 }, idempotencyKey: 'short' },
      ];
      const before = svc.api.length;
      for (const payload of bad) {
        const res = await call(memberCookie, payload);
        expect(res.json().code, JSON.stringify(payload)).toBe('rejected');
      }
      expect(svc.api.length).toBe(before);
    });

    it('refuses what the version doesn’t declare, or what isn’t approved', async () => {
      expect((await call(memberCookie, { op: 'burnBooks' })).json().code).toBe('not-approved');
      // Undeclared connector.
      expect((await call(memberCookie, { op: 'listShelves' }, 'elsewhere')).json().code).toBe(
        'not-approved',
      );
      await db
        .delete(schema.creationVersionConnectors)
        .where(eq(schema.creationVersionConnectors.connectorId, 'lanternfield-pinned'));
      expect(
        (await call(memberCookie, { op: 'getMyLoans' }, 'lanternfield-pinned')).json().code,
      ).toBe('not-approved');
      await db.insert(schema.creationVersionConnectors).values({
        versionId,
        connectorId: 'lanternfield-pinned',
        ops: ['getMyLoans'],
      });
    });

    it('needs the scope in the person’s own link', async () => {
      const res = await call(memberCookie, { op: 'adminReport' });
      expect(res.json().code).toBe('denied');
    });

    it('is only for the live version, except Architects trying one', async () => {
      const v2 = await publishCreation(db, t.storage, {
        creationId,
        groupId,
        spaceId,
        objectKey: 'sofa',
        title: 'Lending desk',
        files: new Map([['index.html', new TextEncoder().encode('<!doctype html><p>v2</p>')]]),
        sdkVersion: '0.1.0',
        protocolVersion: 1,
        status: 'candidate',
        connectors: [{ id: 'lanternfield', ops: ['getMyLoans'], why: 'Your loans.' }],
      });
      const asMember = await call(memberCookie, { op: 'getMyLoans', versionId: v2.versionId });
      expect(asMember.json().code).toBe('denied');
      const asArchitect = await call(architectCookie, {
        op: 'getMyLoans',
        versionId: v2.versionId,
      });
      expect(asArchitect.json().ok).toBe(true);
      // Another creation's version doesn't count.
      const outsider = await t.signUpOutsider(architectCookie, groupId);
      expect((await call(outsider, { op: 'getMyLoans' })).statusCode).toBe(404);
    });

    it('turns what the service says into the bridge’s codes, passing on only a cleaned-up error', async () => {
      const clash = await call(memberCookie, {
        op: 'borrowBook',
        params: { bookId: '409' },
        body: { weeks: 1 },
        idempotencyKey: 'borrow-409-1',
      });
      expect(clash.statusCode).toBe(409);
      expect(clash.json()).toMatchObject({
        ok: false,
        code: 'clash',
        error: 'Someone has it already.',
        upstream: { status: 409, code: 'ALREADY_ON_LOAN', message: 'Someone has it already.' },
      });
      const refused = (await call(memberCookie, { op: 'refuse' })).json();
      expect(refused.code).toBe('rejected');
      expect(refused.upstream.status).toBe(422);
      expect(refused.upstream.code).toBeUndefined();
      expect(refused.upstream.message).toHaveLength(200);
      expect(refused.upstream.details).toBeUndefined();
      const fussy = (await call(memberCookie, { op: 'fussy' })).json();
      expect(fussy.upstream).toEqual({
        status: 422,
        code: 'SHELF_FULL',
        message: 'That shelf is full.',
        details: { max: 12 },
      });
      expect((await call(memberCookie, { op: 'broken' })).json().code).toBe('upstream');
    });

    it("doesn't follow redirects, carry oversized answers, or pass on anything but JSON", async () => {
      const before = svc.api.length;
      const moved = await call(memberCookie, { op: 'goElsewhere' });
      expect(moved.json().code).toBe('upstream');
      expect(svc.api.slice(before).map((r) => r.url)).toEqual(['/api/v1/redirect']);
      expect((await call(memberCookie, { op: 'bigList' })).json().code).toBe('too-big');
      expect((await call(memberCookie, { op: 'pageOfText' })).json().code).toBe('upstream');
    });

    it('never reaches a private address unless the owner allowed it', async () => {
      const sam = await userIdOf(memberCookie);
      await saveLink(db, t.secret, sam, 'lanternfield-public', {
        accessToken: 'at-sam-public',
        refreshToken: null,
        expiresAt: null,
        scopes: ['shelves:read'],
      });
      const before = svc.api.length;
      const res = await call(memberCookie, { op: 'listShelves' }, 'lanternfield-public');
      expect(res.json().code).toBe('upstream');
      expect(svc.api.length).toBe(before);
    });

    it('connects where the owner pinned it, keeping the service’s own name', async () => {
      await link(memberCookie, 'sam', 'lanternfield-pinned');
      const res = await call(memberCookie, { op: 'getMyLoans' }, 'lanternfield-pinned');
      expect(res.json()).toMatchObject({ ok: true, data: { account: 'sam' } });
      expect(svc.api.at(-1)?.headers.host).toBe('library.lanternfield.invalid:8080');
    });

    it('refreshes a token about to expire before using it', async () => {
      svc.expiresIn = 30; // less than the minute the server refreshes ahead of
      await link(memberCookie, 'sam');
      svc.expiresIn = 3600;
      const refreshes = () => svc.tokenRequests.filter((r) => r.grant === 'refresh_token').length;
      const before = refreshes();
      const res = await call(memberCookie, { op: 'getMyLoans' });
      expect(res.json().ok).toBe(true);
      expect(refreshes()).toBe(before + 1);
      // Now good for an hour: no more refreshing.
      await call(memberCookie, { op: 'getMyLoans' });
      expect(refreshes()).toBe(before + 1);
    });

    it('refreshes once when the service says 401, and tries once more', async () => {
      // The service forgets the current access token (as if it expired early).
      for (const [token, who] of svc.access) if (who === 'sam') svc.access.delete(token);
      const before = svc.api.length;
      const res = await call(memberCookie, { op: 'getMyLoans' });
      expect(res.json()).toMatchObject({ ok: true, data: { account: 'sam' } });
      expect(svc.api.length).toBe(before + 2);
    });

    it('a grant the service took back breaks the link: the person links again', async () => {
      svc.revokeAll = true;
      const res = await call(memberCookie, { op: 'getMyLoans' });
      expect(res.json().code).toBe('not-linked');
      svc.revokeAll = false;
      const listed = (await inject('GET', '/api/connectors', memberCookie)).json().connectors[0];
      expect(listed).toMatchObject({ linked: true, broken: true });
      // Broken stays broken (no calls) until they link again.
      const before = svc.api.length;
      expect((await call(memberCookie, { op: 'getMyLoans' })).json().code).toBe('not-linked');
      expect(svc.api.length).toBe(before);
      await link(memberCookie, 'sam');
      expect((await call(memberCookie, { op: 'getMyLoans' })).json().ok).toBe(true);
    });

    it('a refresh the service refuses (invalid_grant) breaks the link', async () => {
      for (const [token, who] of svc.access) if (who === 'sam') svc.access.delete(token);
      svc.refuseRefresh = true;
      const res = await call(memberCookie, { op: 'getMyLoans' });
      svc.refuseRefresh = false;
      expect(res.json().code).toBe('not-linked');
      expect(
        (await inject('GET', '/api/connectors', memberCookie)).json().connectors[0].broken,
      ).toBe(true);
      await link(memberCookie, 'sam');
    });

    it('limits how often a person can change things', async () => {
      let limited = 0;
      for (let i = 0; i < 32; i++) {
        const res = await call(memberCookie, {
          op: 'returnBook',
          params: { bookId: String(i) },
          idempotencyKey: `return-many-${i}`,
        });
        if (res.statusCode === 429) {
          limited++;
          expect(res.json().code).toBe('denied');
        }
      }
      expect(limited).toBeGreaterThan(0);
      // Reading has its own allowance.
      expect((await call(memberCookie, { op: 'getMyLoans' })).json().ok).toBe(true);
    });

    it('unlinks: the service is asked to forget it, and it goes', async () => {
      const res = await inject('DELETE', '/api/connectors/lanternfield/link', architectCookie);
      expect(res.statusCode).toBe(200);
      expect(svc.revoked.some((t) => t.startsWith('rt-pat-'))).toBe(true);
      expect(
        (await inject('GET', '/api/connectors', architectCookie)).json().connectors[0].linked,
      ).toBe(false);
      expect((await call(architectCookie, { op: 'getMyLoans' })).json().code).toBe('not-linked');
    });
  });

  describe('moving and publishing', () => {
    it("an import never carries approvals: it waits until it's approved here", async () => {
      const exported = await inject('GET', `/api/creations/${creationId}/export`, architectCookie);
      expect(exported.statusCode).toBe(200);
      const { unzipSync, zipSync } = await import('fflate');
      const files = unzipSync(new Uint8Array(exported.rawPayload));
      const described = JSON.parse(new TextDecoder().decode(files['creation.json']));
      expect(described.connectors.map((c: { id: string }) => c.id)).toEqual([
        'lanternfield',
        'lanternfield-public',
        'lanternfield-pinned',
      ]);
      // Even a file that claims approvals gets none.
      files['creation.json'] = new TextEncoder().encode(
        JSON.stringify({ ...described, approvals: [{ id: 'lanternfield', ops: ALL_OPS }] }),
      );
      const res = await app.inject({
        method: 'POST',
        url: `/api/spaces/${spaceId}/creations/import`,
        headers: { cookie: architectCookie, origin: ORIGIN, 'content-type': 'application/zip' },
        payload: Buffer.from(zipSync(files)),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().live).toBe(false);
      const [version] = await db
        .select()
        .from(schema.creationVersions)
        .where(eq(schema.creationVersions.creationId, res.json().creationId));
      expect(version?.status).toBe('candidate');
      const approvals = await db
        .select()
        .from(schema.creationVersionConnectors)
        .where(eq(schema.creationVersionConnectors.versionId, version?.id as string));
      expect(approvals).toEqual([]);
      const live = await inject(
        'POST',
        `/api/creations/${res.json().creationId}/versions/${version?.id}/live`,
        architectCookie,
      );
      expect(live.statusCode).toBe(409);
      expect(live.json().code).toBe('connectors-unapproved');
    });

    it('the owner publishing from the command line can approve as it goes live', async () => {
      const published = await publishCreation(db, t.storage, {
        groupId,
        spaceId,
        objectKey: null,
        title: 'Returns slot',
        files: new Map([['index.html', new TextEncoder().encode('<!doctype html><p>slot</p>')]]),
        sdkVersion: '0.1.0',
        protocolVersion: 1,
        connectors: [{ id: 'lanternfield', ops: ['returnBook'], why: 'Returns books.' }],
        approveConnectors: { by: null },
      });
      expect(published.live).toBe(true);
      const approvals = await db
        .select()
        .from(schema.creationVersionConnectors)
        .where(eq(schema.creationVersionConnectors.versionId, published.versionId));
      expect(approvals).toMatchObject([
        { connectorId: 'lanternfield', ops: ['returnBook'], approvedBy: null },
      ]);
    });
  });

  describe('the link check', () => {
    const CHECKED = 'lanternfield-checked';
    // Sam again, in a new session each time (linking is limited per session, and these link a lot).
    let me = '';
    beforeEach(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'sam@example.test', password: 'another-long-password' }),
      });
      expect(res.statusCode).toBe(200);
      me = cookieFrom(res.headers);
    });
    /** Links as `account` and comes back: where to. */
    async function linkTo(cookie: string, account: string) {
      const at = await startLink(cookie, CHECKED);
      const res = await callback(cookie, {
        state: at.searchParams.get('state') as string,
        code: consent(at, account),
      });
      expect(res.statusCode).toBe(302);
      return res.headers.location as string;
    }
    const listed = async (cookie: string) =>
      (await inject('GET', '/api/connectors', cookie))
        .json()
        .connectors.find((c: { id: string }) => c.id === CHECKED);
    const rowOf = async (cookie: string) =>
      (
        await db
          .select()
          .from(schema.connectorLinks)
          .where(
            and(
              eq(schema.connectorLinks.userId, await userIdOf(cookie)),
              eq(schema.connectorLinks.connectorId, CHECKED),
            ),
          )
      )[0];
    const checks = (from: number) => svc.api.slice(from).filter((r) => r.url === '/api/v1/me');
    const answer = (status: number, body: unknown) => {
      svc.whoAmI = () => ({ status, body });
    };

    it('reads once, with the fresh token, and keeps who the service says you are', async () => {
      answer(200, { member: { displayName: 'Ada' }, shelf: 'secret' });
      const before = svc.api.length;
      expect(await linkTo(me, 'sam')).toBe(`/account?linked=${CHECKED}`);
      const seen = checks(before);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.method).toBe('GET');
      // The token it was just given, as sent with any call.
      const newest = [...svc.access.entries()].filter(([, who]) => who === 'sam').at(-1)?.[0];
      expect(seen[0]?.headers.authorization).toBe(`Bearer ${newest}`);
      expect(seen[0]?.headers['user-agent']).toMatch(/^ATS-connector\//);
      expect(await listed(me)).toMatchObject({
        linked: true,
        broken: false,
        accountName: 'Ada',
        checked: true,
      });
      const row = await rowOf(me);
      expect(row?.checkedAt).toBeInstanceOf(Date);
      expect(row?.lastUsedAt).toBeInstanceOf(Date);
      // Nothing else from the answer is kept.
      expect(JSON.stringify(row)).not.toContain('secret');
    });

    it('keeps only a plain, short name, and only a string', async () => {
      answer(200, { member: { displayName: ` \u0007Ada\u202e Lovelace\n${'x'.repeat(100)} ` } });
      await linkTo(me, 'sam');
      const name = (await listed(me)).accountName as string;
      expect(name.startsWith('Ada Lovelacexxx')).toBe(true);
      expect([...name]).toHaveLength(60);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: checking none are left
      expect(name).not.toMatch(/[\u0000-\u001f\u202e]/);

      for (const body of [{ member: { displayName: 42 } }, { member: {} }, ['Ada'], null]) {
        answer(200, body);
        expect(await linkTo(me, 'sam')).toBe(`/account?linked=${CHECKED}`);
        expect(await listed(me)).toMatchObject({ accountName: null, checked: true });
      }
    });

    it('a service that refuses the account: the link goes, and the person is told', async () => {
      answer(403, { code: 'ACCOUNT_SUSPENDED', message: 'This account is on hold.' });
      const revokedBefore = svc.revoked.length;
      const to = await linkTo(me, 'sam');
      expect(to).toBe(
        `/account?link_error=refused_by_service&link_connector=${CHECKED}&link_reason=ACCOUNT_SUSPENDED`,
      );
      expect(await rowOf(me)).toBeUndefined();
      expect(await listed(me)).toMatchObject({ linked: false, accountName: null });
      // The service was asked to forget the grant.
      const revoked = svc.revoked.slice(revokedBefore);
      expect(revoked.some((t) => t.startsWith('rt-sam-'))).toBe(true);
      expect(revoked.some((t) => t.startsWith('at-sam-'))).toBe(true);
      const audit = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'connector.link_refused'));
      expect(audit.map((a) => a.metadata)).toEqual([
        { connector: CHECKED, status: 403, code: 'ACCOUNT_SUSPENDED' },
      ]);
      expect(JSON.stringify(audit)).not.toMatch(/at-sam|rt-sam|on hold/);

      // A code that doesn't look like one isn't passed on.
      answer(403, { code: 'no; <b>', message: 'No.' });
      expect(await linkTo(me, 'sam')).toBe(
        `/account?link_error=refused_by_service&link_connector=${CHECKED}`,
      );
    });

    it('401 even after a refresh is a refusal too, and keeps the return page', async () => {
      svc.revokeAll = true;
      const before = svc.api.length;
      const at = await startLink(me, CHECKED, '/space/x?object=desk&linked=old');
      const res = await callback(me, {
        state: at.searchParams.get('state') as string,
        code: consent(at, 'sam'),
      });
      svc.revokeAll = false;
      expect(res.headers.location).toBe(
        `/space/x?object=desk&link_error=refused_by_service&link_connector=${CHECKED}`,
      );
      // Once, then once more after refreshing.
      expect(checks(before)).toHaveLength(2);
      expect(await rowOf(me)).toBeUndefined();
      const audit = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'connector.link_refused'));
      expect(audit.map((a) => a.metadata)).toContainEqual({ connector: CHECKED, status: null });
    });

    it('a service that is down or slow: the link stays, unconfirmed', async () => {
      answer(200, { member: { displayName: 'Ada' } });
      await linkTo(me, 'sam');
      expect((await listed(me)).accountName).toBe('Ada');

      answer(500, { message: 'Down for repairs.' });
      expect(await linkTo(me, 'sam')).toBe(`/account?linked=${CHECKED}&link_check=unconfirmed`);
      // Linking again starts afresh: the last check's name and time don't carry over.
      expect(await listed(me)).toMatchObject({
        linked: true,
        broken: false,
        accountName: null,
        checked: false,
      });

      answer(200, { member: { displayName: 'Ada' } });
      svc.whoAmIDelayMs = 1500; // the operation's own timeout is 500 ms
      const started = Date.now();
      const to = await linkTo(me, 'sam');
      svc.whoAmIDelayMs = 0;
      expect(to).toBe(`/account?linked=${CHECKED}&link_check=unconfirmed`);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(await listed(me)).toMatchObject({ linked: true, checked: false });

      // Too big for the operation, or not JSON: the same.
      answer(200, { member: { displayName: 'x'.repeat(5000) } });
      expect(await linkTo(me, 'sam')).toBe(`/account?linked=${CHECKED}&link_check=unconfirmed`);
      // It still works afterwards.
      answer(200, { member: { displayName: 'Ada' } });
      await linkTo(me, 'sam');
      expect(await listed(me)).toMatchObject({ accountName: 'Ada', checked: true });
    });
  });
});
