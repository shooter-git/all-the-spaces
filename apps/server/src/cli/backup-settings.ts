// Shows and changes the backup settings chosen in setup. Used by `ats-admin backup-settings`:
//
//   backup-settings.ts show
//   backup-settings.ts schedule nightly|weekly|off
//   backup-settings.ts keep-days DAYS
//   backup-settings.ts offsite        details on standard input, one per line: endpoint, region,
//                                     bucket, folder (empty for the default), access key ID, secret
//   backup-settings.ts offsite off
import { createInterface } from 'node:readline';
import { createDb, schema } from '@ats/db';
import { loadServerEnv } from '@ats/shared';
import { eq } from 'drizzle-orm';
import { record } from '../audit.ts';
import { getInstallState } from '../install-state.ts';
import { checkOffsite, offsiteInput, sealOffsite } from '../offsite.ts';

type Settings = NonNullable<typeof schema.installState.$inferSelect.backup>;

const [command = 'show', value] = process.argv.slice(2);
const env = loadServerEnv();
const db = createDb(env.DATABASE_URL);

function describe(b: Settings): string {
  const schedule = { nightly: 'Every night', weekly: 'Every week', off: 'Off' }[b.schedule];
  return [
    `Scheduled backups: ${schedule}`,
    `Kept for: ${b.keepDays} days`,
    `Off-site copy: ${b.offsite ? `bucket "${b.offsite.bucket}" at ${b.offsite.endpoint}, folder "${b.offsite.prefix}"` : 'not set up'}`,
  ].join('\n');
}

async function readDetails() {
  const lines: string[] = [];
  for await (const line of createInterface({ input: process.stdin })) lines.push(line.trim());
  const [endpoint, region, bucket, prefix, accessKeyId, secretAccessKey] = lines;
  return offsiteInput.parse({
    endpoint,
    region,
    bucket,
    prefix: prefix || undefined,
    accessKeyId,
    secretAccessKey,
  });
}

try {
  const state = await getInstallState(db);
  if (!state?.setupCompletedAt)
    throw new Error('finish setup first (open your space in a browser).');
  const current: Settings = state.backup ?? { schedule: 'nightly', keepDays: 14 };
  let next: Settings = current;

  if (command === 'schedule') {
    if (value !== 'nightly' && value !== 'weekly' && value !== 'off') {
      throw new Error('the schedule is one of: nightly, weekly, off.');
    }
    next = { ...current, schedule: value };
  } else if (command === 'keep-days') {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error('keep backups for 1 to 365 days.');
    }
    next = { ...current, keepDays: days };
  } else if (command === 'offsite' && value === 'off') {
    next = { ...current, offsite: undefined };
  } else if (command === 'offsite') {
    const details = await readDetails();
    try {
      await checkOffsite(details);
    } catch (err) {
      throw new Error(`couldn't save backups in that bucket: ${(err as Error).message}`);
    }
    next = {
      ...current,
      offsite: sealOffsite(details, env.BETTER_AUTH_SECRET, env.ATS_PUBLIC_URL),
    };
  } else if (command !== 'show') {
    throw new Error(`unknown setting "${command}".`);
  }

  if (next !== current) {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.installState)
        .set({ backup: next, updatedAt: new Date() })
        .where(eq(schema.installState.id, 1));
      await record(tx, {
        action: 'backup.settings_changed',
        metadata: {
          schedule: next.schedule,
          keepDays: next.keepDays,
          offsiteBackup: Boolean(next.offsite),
        },
      });
    });
    console.log('Saved.');
  }
  console.log(describe(next));
} catch (err) {
  console.error(`Sorry — ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
