import { type Db, deleteExpiredChat, deleteOldPerfSamples } from '@ats/db';

/** What each maintenance job does: `alive` records a heartbeat. */
export const maintenanceJobs =
  (db: Db, alive: () => Promise<void>) => async (job: { name: string }) => {
    if (job.name === 'heartbeat') {
      await alive();
      return { at: new Date().toISOString() };
    }
    if (job.name === 'chat-retention')
      return { deleted: await deleteExpiredChat(db), perf: await deleteOldPerfSamples(db) };
    throw new Error(`Unknown maintenance job: ${job.name}`);
  };
