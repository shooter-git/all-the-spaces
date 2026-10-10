import type { Db } from '@ats/db';
import { describe, expect, it, vi } from 'vitest';
import { maintenanceJobs } from '../src/jobs.ts';

vi.mock('@ats/db', () => ({
  deleteExpiredChat: vi.fn(async () => 3),
  deleteOldPerfSamples: vi.fn(async () => 5),
}));

describe('maintenance jobs', () => {
  const db = {} as Db;

  it('records a heartbeat', async () => {
    const alive = vi.fn(async () => {});
    const result = await maintenanceJobs(db, alive)({ name: 'heartbeat' });
    expect(alive).toHaveBeenCalledOnce();
    expect(Date.parse((result as { at: string }).at)).not.toBeNaN();
  });

  it('clears out old chat and performance samples, and says how many went', async () => {
    const alive = vi.fn(async () => {});
    expect(await maintenanceJobs(db, alive)({ name: 'chat-retention' })).toEqual({
      deleted: 3,
      perf: 5,
    });
    expect(alive).not.toHaveBeenCalled();
  });

  it('fails a job it does not know', async () => {
    await expect(maintenanceJobs(db, async () => {})({ name: 'mystery' })).rejects.toThrow(
      'Unknown maintenance job: mystery',
    );
  });
});
