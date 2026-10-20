import {
  type Db,
  deleteExpiredChat,
  deleteOldPerfSamples,
  deleteOldVisits,
  endStaleVisits,
} from '@ats/db';

/** What each maintenance job does: `alive` records a heartbeat. */
export const maintenanceJobs =
  (db: Db, alive: () => Promise<void>) => async (job: { name: string }) => {
    if (job.name === 'heartbeat') {
      await alive();
      return { at: new Date().toISOString() };
    }
    if (job.name === 'chat-retention')
      return {
        deleted: await deleteExpiredChat(db),
        perf: await deleteOldPerfSamples(db),
        // Visits left open by a real-time service that never came back end when last seen.
        ended: await endStaleVisits(db),
        visits: await deleteOldVisits(db),
      };
    throw new Error(`Unknown maintenance job: ${job.name}`);
  };
