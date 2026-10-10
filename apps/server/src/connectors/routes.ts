import type { ConnectorInfo, Sent, StudioVersionConnector } from '@ats/api-types';
import { schema } from '@ats/db';
import { CONNECTOR_ID, OPERATION_NAME, validateConnectorValue } from '@ats/shared';
import { and, eq, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFound, requireArchitect, requireUser } from '../access.ts';
import { record } from '../audit.ts';
import type { AppContext } from '../context.ts';
import { versionAccess } from '../creations/access.ts';
import { open, seal } from '../crypto-box.ts';
import { getSession } from '../session.ts';
import { approvalsFor, approve, declaredBy, reviewOf } from './approvals.ts';
import { checkLink, dropLink } from './link-check.ts';
import { findLink, saveLink } from './links.ts';
import { authorizeUrl, exchangeCode, hashState, newAttempt } from './oauth.ts';
import {
  CALL_LIMITS,
  type CallCode,
  type CallOutcome,
  forward,
  idempotencyValue,
  MinuteLimiter,
} from './proxy.ts';
import { NO_CONNECTORS } from './registry.ts';

const { connectorLinks, connectorLinkAttempts, creations, creationVersions } = schema;

const ATTEMPT_MINUTES = 10;
const VERIFIER_PURPOSE = 'connector-verifier';
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,80}$/;
const NO_SUCH_CREATION = 'That creation does not exist.';

/** The HTTP status each failure goes back to the app with (the bridge code is in the body). */
const STATUS: Record<CallCode, number> = {
  'not-linked': 403,
  'not-approved': 403,
  denied: 403,
  trial: 403,
  clash: 409,
  rejected: 422,
  upstream: 502,
  'too-big': 502,
};

/**
 * A place in the app to come back to after linking: a path on the app's own origin, never
 * another site (`//elsewhere`, `/\elsewhere`) and never the API.
 */
export function safeReturnTo(value: unknown, appOrigin: string): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, appOrigin);
  } catch {
    return null;
  }
  if (url.origin !== appOrigin || url.pathname.startsWith('/api/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The flags the app notices after linking; any already on the return path are replaced. */
const LINK_FLAGS = ['linked', 'link_error', 'link_check', 'link_connector', 'link_reason'];

/**
 * The return path with flags added for the app to notice (`?linked=<id>`, `?link_error=…`, and
 * after a link check `&link_check=unconfirmed` or `&link_connector=<id>&link_reason=<CODE>`).
 */
function withFlags(returnTo: string, appOrigin: string, flags: Record<string, string>) {
  const url = new URL(returnTo, appOrigin);
  for (const key of LINK_FLAGS) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(flags)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}
const withFlag = (returnTo: string, appOrigin: string, key: string, value: string) =>
  withFlags(returnTo, appOrigin, { [key]: value });

/** A plain page for the few answers a person sees directly (they arrived from the service). */
function page(reply: FastifyReply, status: number, title: string, text: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header(
      'content-security-policy',
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f1ea;color:#2b2a2e;font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;padding:24px}a{color:#3f5b7c}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to your spaces</a></p></main></body></html>`,
    );
}

/**
 * Connectors (docs/connectors.md): linking a person's own account at a service the server's
 * owner installed, and creations calling that service's declared operations through the app.
 */
export async function connectorRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env } = ctx;
  const registry = () => ctx.connectors ?? NO_CONNECTORS;
  const appOrigin = new URL(env.ATS_PUBLIC_URL).origin;
  const redirectUri = `${env.ATS_PUBLIC_URL.replace(/\/+$/, '')}/api/connectors/callback`;
  const limiter = new MinuteLimiter();
  const perSession = (req: { headers: { cookie?: string | undefined }; ip: string }) =>
    /(?:^|;\s*)(?:__Secure-)?ats\.session_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ??
    req.ip;

  // ---- Which there are, and linking -----------------------------------------------------------

  app.get('/api/connectors', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const links = await db.select().from(connectorLinks).where(eq(connectorLinks.userId, me.id));
    reply.header('cache-control', 'private, no-store');
    return {
      connectors: registry()
        .list()
        .map(({ def }) => {
          const link = links.find((l) => l.connectorId === def.id);
          return {
            id: def.id,
            displayName: def.displayName,
            description: def.description,
            scopes: def.oauth.scopes,
            linked: Boolean(link),
            linkedAt: link?.linkedAt ?? null,
            broken: Boolean(link?.brokenAt),
            accountName: link?.accountName ?? null,
            checked: Boolean(link?.checkedAt),
          };
        }),
    } satisfies Sent<{ connectors: ConnectorInfo[] }>;
  });

  app.post<{ Params: { connectorId: string } }>(
    '/api/connectors/:connectorId/link',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          keyGenerator: perSession,
          errorResponseBuilder: () => ({
            statusCode: 429,
            message: 'Too many tries at once. Wait a moment and try again.',
          }),
        },
      },
    },
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const connector = registry().get(req.params.connectorId);
      if (!connector) return notFound(reply, 'That isn’t set up on this server.');
      const returnTo = safeReturnTo(
        (req.body as { returnTo?: unknown } | null)?.returnTo,
        appOrigin,
      );
      if (!returnTo)
        return reply
          .code(400)
          .send({ error: 'Linking needs a page in the app to come back to.', code: 'rejected' });
      const attempt = newAttempt();
      await db.delete(connectorLinkAttempts).where(lt(connectorLinkAttempts.expiresAt, new Date()));
      await db.insert(connectorLinkAttempts).values({
        stateHash: attempt.stateHash,
        userId: me.id,
        connectorId: connector.def.id,
        verifierEnc: seal(attempt.verifier, env.BETTER_AUTH_SECRET, VERIFIER_PURPOSE),
        returnTo,
        expiresAt: new Date(Date.now() + ATTEMPT_MINUTES * 60_000),
      });
      return {
        authorizeUrl: authorizeUrl(connector, {
          state: attempt.state,
          verifier: attempt.verifier,
          redirectUri,
        }),
      };
    },
  );

  /** The service sends the person back here, with a code (or an error) and our state. */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/connectors/callback',
    async (req, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      const q = req.query;
      const state = typeof q.state === 'string' ? q.state : '';
      if (!state || state.length > 200)
        return page(reply, 400, 'That link didn’t work', 'Start linking again from the app.');
      const session = await getSession(ctx, req);
      if (!session) {
        // Signed out in the meantime (or another browser): sign in, then carry on from here.
        const back = new URLSearchParams();
        for (const k of ['state', 'code', 'error'] as const)
          if (typeof q[k] === 'string') back.set(k, (q[k] as string).slice(0, 2000));
        const resume = `/api/connectors/callback?${back}`;
        return reply.redirect(`/sign-in?${new URLSearchParams({ resume })}`, 302);
      }
      const [attempt] = await db
        .select()
        .from(connectorLinkAttempts)
        .where(eq(connectorLinkAttempts.stateHash, hashState(state)));
      if (!attempt)
        return reply.redirect(withFlag('/account', appOrigin, 'link_error', 'expired'), 302);
      if (attempt.userId !== session.user.id) {
        // Someone else's link (a link sent to them, or a forged one): it ends here, unused.
        await db
          .delete(connectorLinkAttempts)
          .where(eq(connectorLinkAttempts.stateHash, attempt.stateHash));
        return page(
          reply,
          403,
          'This link isn’t yours',
          'It was started by someone else, so it hasn’t been used. Start linking again from your own account.',
        );
      }
      // Once only: whatever happens next, this state can't be used again.
      const [taken] = await db
        .delete(connectorLinkAttempts)
        .where(eq(connectorLinkAttempts.stateHash, attempt.stateHash))
        .returning();
      if (!taken)
        return reply.redirect(withFlag('/account', appOrigin, 'link_error', 'expired'), 302);
      const back = (key: string, value: string) =>
        reply.redirect(withFlag(taken.returnTo, appOrigin, key, value), 302);
      if (taken.expiresAt.getTime() < Date.now()) return back('link_error', 'expired');
      const connector = registry().get(taken.connectorId);
      if (!connector) return back('link_error', 'not_installed');
      if (typeof q.error === 'string')
        // An OAuth error code (`access_denied`), or else just "refused": nothing else passes.
        return back('link_error', /^[a-z_]{1,40}$/.test(q.error) ? q.error : 'refused');
      if (typeof q.code !== 'string' || !q.code || q.code.length > 2000)
        return back('link_error', 'invalid_request');
      let tokens: Awaited<ReturnType<typeof exchangeCode>>;
      try {
        tokens = await exchangeCode(connector, {
          code: q.code,
          verifier: open(taken.verifierEnc, env.BETTER_AUTH_SECRET, VERIFIER_PURPOSE),
          redirectUri,
        });
      } catch (err) {
        ctx.log?.warn(
          { connector: connector.def.id, err: (err as Error).message },
          'connectors: a link could not be finished',
        );
        return back('link_error', 'exchange_failed');
      }
      const link = await saveLink(
        db,
        env.BETTER_AUTH_SECRET,
        taken.userId,
        connector.def.id,
        tokens,
      );
      await record(db, {
        groupId: null,
        actorUserId: taken.userId,
        action: 'connector.linked',
        target: connector.def.id,
        metadata: { connector: connector.def.id, scopes: tokens.scopes },
      });
      if (!connector.def.linkCheck) return back('linked', connector.def.id);

      // The link check: one harmless read as them, now, while they wait.
      const check = await checkLink(db, {
        secret: env.BETTER_AUTH_SECRET,
        release: env.ATS_RELEASE ?? 'development',
        connector,
        link,
      }).catch((err: Error) => {
        ctx.log?.warn(
          { connector: connector.def.id, err: err.message },
          'connectors: the link check failed',
        );
        return { result: 'unconfirmed' } as const;
      });
      const to = (flags: Record<string, string>) =>
        reply.redirect(withFlags(taken.returnTo, appOrigin, flags), 302);
      if (check.result === 'ok') return back('linked', connector.def.id);
      if (check.result === 'unconfirmed')
        return to({ linked: connector.def.id, link_check: 'unconfirmed' });
      // The service says this account can't use it: there's no point keeping the link.
      await dropLink(db, env.BETTER_AUTH_SECRET, connector, link.id);
      await record(db, {
        groupId: null,
        actorUserId: taken.userId,
        action: 'connector.link_refused',
        target: connector.def.id,
        metadata: {
          connector: connector.def.id,
          status: check.status,
          ...(check.code ? { code: check.code } : {}),
        },
      });
      return to({
        link_error: 'refused_by_service',
        link_connector: connector.def.id,
        ...(check.code ? { link_reason: check.code } : {}),
      });
    },
  );

  app.delete<{ Params: { connectorId: string } }>(
    '/api/connectors/:connectorId/link',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      if (!CONNECTOR_ID.test(req.params.connectorId)) return notFound(reply);
      const link = await findLink(db, me.id, req.params.connectorId);
      if (!link) return { ok: true };
      // Best effort: the service forgets the grant; the link goes either way.
      await dropLink(db, env.BETTER_AUTH_SECRET, registry().get(link.connectorId), link.id);
      await record(db, {
        groupId: null,
        actorUserId: me.id,
        action: 'connector.unlinked',
        target: link.connectorId,
        metadata: { connector: link.connectorId },
      });
      return { ok: true };
    },
  );

  // ---- Approving a version's connectors ---------------------------------------------------------

  app.post<{ Params: { creationId: string; versionId: string } }>(
    '/api/creations/:creationId/versions/:versionId/connectors/approve',
    async (req, reply) => {
      const p = z.object({ creationId: z.uuid(), versionId: z.uuid() }).safeParse(req.params);
      if (!p.success) return notFound(reply);
      const [row] = await db
        .select({ creation: creations, version: creationVersions })
        .from(creationVersions)
        .innerJoin(creations, eq(creations.id, creationVersions.creationId))
        .where(
          and(
            eq(creationVersions.id, p.data.versionId),
            eq(creationVersions.creationId, p.data.creationId),
          ),
        );
      if (!row) return notFound(reply);
      const me = await requireArchitect(ctx, req, reply, row.creation.groupId, {
        status: 404,
        error: 'Not found.',
      });
      if (!me) return;
      const { connectors } = z
        .object({
          connectors: z
            .array(
              z.object({
                id: z.string().regex(CONNECTOR_ID),
                ops: z.array(z.string().regex(OPERATION_NAME)).min(1).max(200),
              }),
            )
            .min(1)
            .max(20),
        })
        .parse(req.body);
      const declared = declaredBy(row.version);
      for (const c of connectors) {
        const d = declared.find((x) => x.id === c.id);
        const extra = c.ops.filter((op) => !d?.ops.includes(op));
        if (!d || extra.length)
          return reply.code(400).send({
            error: `Version ${row.version.number} doesn’t ask to use ${extra.length ? extra.join(', ') : c.id}.`,
            code: 'not-declared',
          });
        const installed = registry().get(c.id);
        const unknown = c.ops.filter((op) => !installed?.def.operations[op]);
        if (!installed || unknown.length)
          return reply.code(409).send({
            error: installed
              ? `${installed.def.displayName} on this server has no ${unknown.join(', ')}.`
              : `${c.id} isn’t set up on this server.`,
            code: 'connector-missing',
          });
      }
      await approve(db, row.version.id, connectors, me.id);
      await record(db, {
        groupId: row.creation.groupId,
        actorUserId: me.id,
        action: 'connector.approved',
        target: row.creation.id,
        metadata: { versionId: row.version.id, number: row.version.number, connectors },
      });
      return {
        ok: true,
        connectors: reviewOf(
          declared,
          await approvalsFor(db, [row.version.id]),
          registry(),
        ) satisfies Sent<StudioVersionConnector[]>,
      };
    },
  );

  // ---- A creation calling an operation ----------------------------------------------------------

  const CallBody = z.object({
    versionId: z.uuid(),
    op: z.string().regex(OPERATION_NAME),
    params: z.record(z.string(), z.unknown()).optional(),
    body: z.unknown().optional(),
    idempotencyKey: z.string().regex(IDEMPOTENCY_KEY).optional(),
  });

  app.post<{ Params: { creationId: string; connectorId: string } }>(
    '/api/creations/:creationId/connectors/:connectorId/call',
    async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const fail = (code: CallCode, error: string, status = STATUS[code]) =>
        reply.code(status).send({ ok: false, code, error });
      if (
        !z.uuid().safeParse(req.params.creationId).success ||
        !CONNECTOR_ID.test(req.params.connectorId)
      )
        return notFound(reply, NO_SUCH_CREATION);
      const parsed = CallBody.safeParse(req.body ?? {});
      if (!parsed.success) return fail('rejected', 'That call isn’t well-formed.', 400);
      const call = parsed.data;
      const connectorId = req.params.connectorId;

      // Who, through which version.
      const va = await versionAccess(db, me.id, req.params.creationId, call.versionId);
      if (!va) return notFound(reply, NO_SUCH_CREATION);
      if (va.denied)
        return fail('denied', 'This version of the creation can’t do that any more. Rejoin it.');
      const { version, trial, access } = va;

      // What the version declared, and what this server has.
      const declared = declaredBy(version).find((d) => d.id === connectorId);
      if (!declared?.ops.includes(call.op))
        return fail('not-approved', `This creation doesn’t ask to use ${connectorId} ${call.op}.`);
      const connector = registry().get(connectorId);
      const op = connector?.def.operations[call.op];
      if (!connector || !op) return fail('denied', `${connectorId} isn’t set up on this server.`);
      if (trial && op.kind === 'write')
        return fail(
          'trial',
          'Trying a version that isn’t live can only read, never change things.',
        );
      if (!trial) {
        const approval = (await approvalsFor(db, [version.id])).find(
          (a) => a.connectorId === connectorId,
        );
        if (!approval?.ops.includes(call.op))
          return fail(
            'not-approved',
            `An Architect hasn’t approved ${connector.def.displayName} for this version yet.`,
          );
      }

      // Whose account: always the caller's own.
      const link = await findLink(db, me.id, connectorId);
      if (!link || link.brokenAt)
        return fail('not-linked', `Link your ${connector.def.displayName} account to use this.`);
      if (!link.scopes.includes(op.scope))
        return fail(
          'denied',
          `Your ${connector.def.displayName} link doesn’t allow this. Link it again to allow it.`,
        );

      // What it sends.
      const params = call.params ?? {};
      const paramsProblem = op.params
        ? validateConnectorValue(op.params, params, 'params')
        : Object.keys(params).length
          ? 'params: this operation takes none'
          : null;
      if (paramsProblem) return fail('rejected', paramsProblem, 400);
      const bodyProblem = op.body
        ? validateConnectorValue(op.body, call.body, 'body')
        : call.body !== undefined && call.body !== null
          ? 'body: this operation takes none'
          : null;
      if (bodyProblem) return fail('rejected', bodyProblem, 400);
      if (op.kind === 'write' && !call.idempotencyKey)
        return fail(
          'rejected',
          'Changes need an idempotencyKey (8 to 80 letters, digits, _ or -).',
          400,
        );

      if (!limiter.take(`${me.id}:${connectorId}:${op.kind}`, CALL_LIMITS[op.kind]))
        return fail('denied', 'That’s a lot of calls at once. Wait a moment and try again.', 429);

      const outcome: CallOutcome = await forward(db, {
        secret: env.BETTER_AUTH_SECRET,
        release: env.ATS_RELEASE ?? 'development',
        connector,
        op,
        link,
        params,
        body: op.body ? call.body : undefined,
        idempotency:
          op.kind === 'write' && call.idempotencyKey
            ? idempotencyValue(me.id, access.creation.id, call.idempotencyKey)
            : undefined,
      });
      if (outcome.ok)
        await db
          .update(connectorLinks)
          .set({ lastUsedAt: new Date() })
          .where(eq(connectorLinks.id, link.id));
      if (op.kind === 'write')
        await record(db, {
          groupId: access.creation.groupId,
          actorUserId: me.id,
          action: 'connector.called',
          target: access.creation.id,
          metadata: {
            connector: connectorId,
            op: call.op,
            versionId: version.id,
            status: outcome.ok ? outcome.status : (outcome.upstream?.status ?? null),
            result: outcome.ok ? 'ok' : outcome.code,
          },
        });
      if (outcome.ok) return outcome;
      return reply.code(STATUS[outcome.code]).send(outcome);
    },
  );
}
