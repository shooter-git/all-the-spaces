import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { toNodeHandler } from 'better-auth/node';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { ZodError } from 'zod';
import { LiveHub } from './chat/hub.ts';
import { loadConnectors } from './connectors/registry.ts';
import { connectorRoutes } from './connectors/routes.ts';
import type { AppContext } from './context.ts';
import { Notifier } from './notify.ts';
import { sendError } from './reply.ts';
import { chatRoutes } from './routes/chat.ts';
import { creationRoutes } from './routes/creations.ts';
import { groupRoutes } from './routes/group.ts';
import { inviteRoutes } from './routes/invites.ts';
import { metaRoutes } from './routes/meta.ts';
import { onboardingRoutes } from './routes/onboarding.ts';
import { perfRoutes } from './routes/perf.ts';
import { pictureRoutes } from './routes/pictures.ts';
import { realtimeRoutes } from './routes/realtime.ts';
import { requestRoutes } from './routes/requests.ts';
import { setupRoutes } from './routes/setup.ts';
import { spaceRoutes } from './routes/spaces.ts';
import { studioRoutes } from './routes/studio.ts';
import { transferRoutes } from './routes/transfer.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { workspaceRoutes } from './routes/workspaces.ts';
import { loadSourceHosts } from './sources/registry.ts';
import { sourceRoutes } from './sources/routes.ts';

/** The largest message the app's websockets take (chat, terminals, the live connection). */
const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024;

export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    ...(ctx.log
      ? { loggerInstance: ctx.log as FastifyBaseLogger }
      : { logger: ctx.env.NODE_ENV === 'test' ? false : { level: 'info' } }),
    // One proxy in front (the installer's Caddy): only the address it adds counts. Trusting every
    // hop would let anyone name their own address in X-Forwarded-For, and with it dodge the
    // per-address rate limits. (The same as `trustProxy: 1`, which Fastify's types don't take.)
    trustProxy: (_address, hop) => hop === 0,
    // Play URLs carry a signed token (about 220 characters) as a path segment.
    routerOptions: { maxParamLength: 512 },
  });
  ctx.log ??= app.log;
  // Connector definitions are read once, at start; a bad one is skipped (and logged).
  ctx.connectors ??= await loadConnectors(ctx.env.ATS_CONNECTORS_DIR, process.env, ctx.log);
  ctx.sourceHosts ??= await loadSourceHosts(ctx.env.ATS_SOURCES_DIR, process.env, ctx.log);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: MAX_SOCKET_MESSAGE_BYTES } });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: 'Some details are missing or invalid.', issues: err.issues });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return sendError(
      reply,
      status,
      status >= 500 ? 'Something went wrong on the server.' : err.message,
    );
  });

  // Better Auth parses its own bodies: give it an encapsulated scope where Fastify leaves the
  // request stream untouched, then hand over the raw request.
  const authHandler = toNodeHandler(ctx.auth);
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null));
    scope.all('/api/auth/*', async (req, reply) => {
      reply.hijack();
      await authHandler(req.raw, reply.raw);
    });
  });

  // One live connection per tab carries chat and notifications.
  const hub = new LiveHub();
  app.addHook('onClose', async () => hub.closeAll());
  app.addHook('onClose', async () => ctx.buildQueue?.close());
  ctx.notifier ??= new Notifier(ctx.db, ctx.env, hub, ctx.notifyTransport, (msg) =>
    app.log.warn(msg),
  );

  await metaRoutes(app, ctx);
  await setupRoutes(app, ctx);
  await inviteRoutes(app, ctx);
  await groupRoutes(app, ctx);
  await spaceRoutes(app, ctx);
  await realtimeRoutes(app, ctx);
  await chatRoutes(app, ctx);
  await creationRoutes(app, ctx);
  await studioRoutes(app, ctx);
  await workspaceRoutes(app, ctx);
  await onboardingRoutes(app, ctx);
  await uploadRoutes(app, ctx);
  await pictureRoutes(app, ctx);
  await requestRoutes(app, ctx);
  await perfRoutes(app, ctx);
  await transferRoutes(app, ctx);
  await connectorRoutes(app, ctx);
  await sourceRoutes(app, ctx);
  return app;
}
