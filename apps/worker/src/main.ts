import { writeFile } from 'node:fs/promises';
import { createDb } from '@ats/db';
import { loadWorkerEnv } from '@ats/shared';
import { Queue, Worker } from 'bullmq';
import pino from 'pino';
import { maintenanceJobs } from './jobs.ts';

// Background jobs: a heartbeat (so operators, and the container's health check, can see the worker
// is alive) and the daily clean-up of old chat and performance samples. Notifications, cleaning
// uploaded pictures, building and publishing run in the server; backups run on the host, from a
// systemd timer (see deploy/install/ats-admin).
const env = loadWorkerEnv();
const log = pino({ level: 'info' });
const connection = { url: env.VALKEY_URL };
const db = createDb(env.DATABASE_URL);
const alive = async () => {
  if (env.ATS_HEARTBEAT_FILE) await writeFile(env.ATS_HEARTBEAT_FILE, new Date().toISOString());
};

const maintenance = new Queue('maintenance', { connection });
await maintenance.upsertJobScheduler('heartbeat', { every: 60_000 }, { name: 'heartbeat' });
// Chat older than each group's retention setting, and performance samples older than 90 days,
// are deleted once a day (at 03:30).
await maintenance.upsertJobScheduler(
  'chat-retention',
  { pattern: '30 3 * * *' },
  {
    name: 'chat-retention',
  },
);

const worker = new Worker('maintenance', maintenanceJobs(db, alive), {
  connection,
  concurrency: 1,
});
worker.on('failed', (job, err) => log.error({ job: job?.name, err: err.message }, 'job failed'));
// The queue is reachable (the schedules above were saved): alive until the heartbeats say otherwise.
await alive();
log.info('worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await worker.close();
    await maintenance.close();
    await db.close();
    process.exit(0);
  });
}
