// Backs up and restores the stored files (creation bundles, sources, reports, built spaces) for
// `ats-admin backup|restore` and the installer's update rollback, and looks after the off-site
// copy and old backups. Runs as a one-off app container, the only place that can reach the
// built-in Garage and the saved backup settings:
//
//   storage-backup.ts backup /backups/<new backup folder>
//   storage-backup.ts restore /restore
//   storage-backup.ts offsite /backups/<backup folder>     copy it off-site, if that's set up
//   storage-backup.ts prune /backups [--all] [--protect NAME]
//                     remove backups older than the chosen number of days, here and off-site
//   storage-backup.ts fetch /backups [NAME]                bring an off-site backup back
//
// A backup reuses unchanged files from the newest earlier backup next to it (see
// packages/storage/src/backup.ts). An installation using the Architect's own S3 bucket records
// that and copies nothing: that bucket is theirs to back up.
//
// `fetch` on a server without off-site settings (a new one, after losing the old) reads them from
// standard input, one per line: endpoint, region, bucket, folder, access key ID, secret.

import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { createDb } from '@ats/db';
import { loadServerEnv } from '@ats/shared';
import {
  backupBucket,
  bootstrapGarage,
  createStorage,
  fetchBackup,
  latestBackup,
  type OffsiteTarget,
  pruneLocal,
  pruneOffsite,
  pushBackup,
  readManifest,
  restoreBucket,
  writeExternalManifest,
} from '@ats/storage';
import { getInstallState } from '../install-state.ts';
import { offsiteInput, offsiteTarget, offsiteTargetFrom } from '../offsite.ts';

const COMMANDS = ['backup', 'restore', 'offsite', 'prune', 'fetch'];
const [command, dir, ...rest] = process.argv.slice(2);
if (!command || !COMMANDS.includes(command) || !dir) {
  console.error(`Usage: storage-backup.ts ${COMMANDS.join('|')} DIR`);
  process.exit(2);
}
const flag = (name: string) => rest.includes(name);
const option = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};

const env = loadServerEnv();
const db = createDb(env.DATABASE_URL);
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** Off-site details typed in by `ats-admin offsite-fetch` on a server that has none saved. */
async function offsiteFromInput(): Promise<OffsiteTarget | null> {
  const lines: string[] = [];
  for await (const line of createInterface({ input: process.stdin })) lines.push(line.trim());
  const [endpoint, region, bucket, prefix, accessKeyId, secretAccessKey] = lines;
  if (!endpoint) return null;
  const input = offsiteInput.parse({
    endpoint,
    region,
    bucket,
    prefix,
    accessKeyId,
    secretAccessKey,
  });
  return offsiteTargetFrom(input, env.ATS_PUBLIC_URL);
}

try {
  const state = await getInstallState(db);
  const external = state?.storageMode === 'external';
  const storage = createStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });

  const offsite = offsiteTarget(state?.backup?.offsite, env.BETTER_AUTH_SECRET);
  const keepDays = state?.backup?.keepDays ?? 14;

  if (command === 'offsite') {
    if (!offsite) {
      console.log('Off-site copy: not set up.');
    } else {
      const r = await pushBackup(offsite, dir);
      console.log(
        `Off-site copy: done (${r.uploaded} new stored files and the database, ${mb(r.uploadedBytes)}; ${r.skipped} stored files were already there)`,
      );
    }
  } else if (command === 'prune') {
    const opts = {
      keepDays,
      includeManual: flag('--all'),
      protect: [option('--protect') ?? ''].filter(Boolean),
    };
    const removed = await pruneLocal(dir, opts);
    console.log(
      removed.length
        ? `Removed ${removed.length} backup(s) older than ${keepDays} days: ${removed.join(', ')}`
        : `No backups older than ${keepDays} days to remove.`,
    );
    if (offsite) {
      const r = await pruneOffsite(offsite, opts);
      console.log(
        `Off-site: removed ${r.removed.length} old backup(s) and ${r.removedObjects} stored file(s) no longer needed.`,
      );
    }
  } else if (command === 'fetch') {
    const from = offsite ?? (await offsiteFromInput());
    if (!from) throw new Error("it isn't set up on this server.");
    const r = await fetchBackup(from, dir, rest[0]);
    console.log(
      `Fetched ${r.name} (${r.downloaded} stored files downloaded, ${r.reused} already here, ${mb(r.downloadedBytes)})`,
    );
  } else if (command === 'backup') {
    if (external) {
      await writeExternalManifest(dir, state?.externalStorage?.bucket ?? '');
      console.log(
        'Stored files: in your own storage bucket, so not copied (back that up with your provider).',
      );
    } else {
      const r = await backupBucket(storage, dir, await latestBackup(dirname(dir), dir));
      console.log(
        `Stored files: ${r.objects} (${mb(r.bytes)}), ${r.fetched} new or changed (${mb(r.fetchedBytes)})`,
      );
    }
  } else {
    const manifest = await readManifest(dir).catch(() => null);
    if (!manifest) {
      console.log(
        'Stored files: this backup has no copy of them (made by an older version); left as they are.',
      );
    } else if (external || manifest.storage === 'external') {
      console.log('Stored files: in your own storage bucket, so left as they are.');
    } else {
      // A fresh installation may not have created its bucket yet.
      if (env.GARAGE_ADMIN_URL && env.GARAGE_ADMIN_TOKEN) {
        await bootstrapGarage({
          adminUrl: env.GARAGE_ADMIN_URL,
          adminToken: env.GARAGE_ADMIN_TOKEN,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          bucket: env.S3_BUCKET,
        });
      }
      const r = await restoreBucket(storage, dir);
      console.log(
        `Stored files: ${r.uploaded} put back, ${r.kept} already in place, ${r.removed} removed`,
      );
    }
  }
} catch (err) {
  const what = { offsite: 'Off-site copy', fetch: 'Off-site copy', prune: 'Removing old backups' };
  console.error(
    `${what[command as keyof typeof what] ?? 'Stored files'}: ${(err as Error).message}`,
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
