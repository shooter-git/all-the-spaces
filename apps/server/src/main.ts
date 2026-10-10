import { createDb, runMigrations } from '@ats/db';
import { loadServerEnv } from '@ats/shared';
import { bootstrapGarage } from '@ats/storage';
import pino from 'pino';
import { buildApp } from './app.ts';
import { createAuth } from './auth.ts';
import type { AppContext } from './context.ts';
import { buildQueue, failStuckBuilds, startBuildWorker } from './creations/builds.ts';
import { valkeyEvents } from './events.ts';
import { ensureSetupCode } from './install-state.ts';
import { defaultTransport, mailFrom } from './notify.ts';
import { startSourceChecks } from './sources/checks.ts';
import { NO_SOURCE_HOSTS } from './sources/registry.ts';
import { failInterruptedBuilds } from './spaces.ts';
import { getStorage } from './storage.ts';
import { createSupervisor } from './studio/supervisor.ts';
import { startStudioTimers } from './studio/timeouts.ts';

const env = loadServerEnv();
const db = createDb(env.DATABASE_URL);
await runMigrations(db);
await failInterruptedBuilds(db);

if (env.GARAGE_ADMIN_URL && env.GARAGE_ADMIN_TOKEN) {
  await bootstrapGarage({
    adminUrl: env.GARAGE_ADMIN_URL,
    adminToken: env.GARAGE_ADMIN_TOKEN,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
  });
}

const notifyTransport = defaultTransport(env);
const auth = createAuth({
  db,
  secret: env.BETTER_AUTH_SECRET,
  publicUrl: env.ATS_PUBLIC_URL,
  // With email set up, everyone confirms their address (and it's how the links are sent).
  ...(env.SMTP_URL && {
    sendMail: (message) => notifyTransport.mail({ ...message, from: mailFrom(env) }),
  }),
});
// One logger for the app and everything it does in the background.
const log = pino({ level: 'info' });
const events = valkeyEvents(env.VALKEY_URL, (msg) => log.warn(msg));
// The Studio needs the supervisor (which starts sandboxes); without it, the Studio is off.
const supervisor =
  env.ATS_SUPERVISOR_URL && env.SUPERVISOR_SECRET
    ? createSupervisor(env.ATS_SUPERVISOR_URL, env.SUPERVISOR_SECRET)
    : undefined;
const ctx: AppContext = {
  env,
  db,
  auth,
  events,
  notifyTransport,
  log,
  ...(supervisor ? { supervisor } : {}),
};
const app = await buildApp(ctx);
const stopTimers = supervisor ? startStudioTimers(db, supervisor, log) : () => {};

// Creations are built and checked in the background, one at a time.
const builds = startBuildWorker(
  db,
  () => getStorage({ db, env }),
  env.VALKEY_URL,
  supervisor,
  ctx.notifier,
  log,
);
ctx.buildQueue = buildQueue(env.VALKEY_URL);
await failStuckBuilds(db, ctx.buildQueue);
// Followed repositories are looked at about once an hour (only with a repository host installed).
const stopSourceChecks = startSourceChecks(
  { db, hosts: ctx.sourceHosts ?? NO_SOURCE_HOSTS, release: env.ATS_RELEASE },
  ctx.notifier,
  log,
);

const code = await ensureSetupCode(db, env.BETTER_AUTH_SECRET);
if (code) {
  app.log.info(`Setup code: ${code}  — open ${env.ATS_PUBLIC_URL}/setup to finish installing.`);
}

await app.listen({ host: env.HOST, port: env.ATS_PORT_SERVER });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    // Never hang on the way out (closing can wait forever on a database that has already gone,
    // say when Docker restarts): give it five seconds.
    setTimeout(() => process.exit(0), 5000).unref();
    stopTimers();
    stopSourceChecks();
    await app.close();
    await builds.close();
    await events.close();
    await db.close();
    process.exit(0);
  });
}
