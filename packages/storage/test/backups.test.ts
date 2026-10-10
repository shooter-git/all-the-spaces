import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupBucket,
  expiredBackups,
  fetchBackup,
  listOffsite,
  parseBackupName,
  pruneLocal,
  pruneOffsite,
  pushBackup,
  readManifest,
} from '../src/index.ts';
import { fakeS3 } from './fake-s3.ts';

const NOW = new Date('2026-09-30T12:00:00Z');
const daysAgo = (days: number, label: string) => {
  const t = new Date(NOW.getTime() - days * 86_400_000);
  return `${t
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-${label}`;
};

describe('backup retention', () => {
  it('reads backup folder names', () => {
    expect(parseBackupName('20260930T031500Z-auto')).toEqual({
      time: new Date('2026-09-30T03:15:00Z'),
      label: 'auto',
    });
    expect(parseBackupName('20260930T031500Z-before-v1.2.0')?.label).toBe('before-v1.2.0');
    for (const bad of ['auto', '2026-09-30-auto', '20260930T031500Z-', '../20260930T031500Z-x']) {
      expect(parseBackupName(bad)).toBeNull();
    }
  });

  it('only lets old scheduled backups expire, and always keeps the newest', () => {
    const names = [
      daysAgo(20, 'auto'),
      daysAgo(15, 'auto'),
      daysAgo(13, 'auto'),
      daysAgo(1, 'auto'),
      daysAgo(30, 'manual'),
      daysAgo(30, 'before-v1.0.0'),
      'notes',
    ];
    expect(expiredBackups(names, { keepDays: 14, now: NOW })).toEqual([
      daysAgo(20, 'auto'),
      daysAgo(15, 'auto'),
    ]);
    // Backups stopped working a month ago: the last one stays.
    expect(
      expiredBackups([daysAgo(40, 'auto'), daysAgo(31, 'auto')], { keepDays: 14, now: NOW }),
    ).toEqual([daysAgo(40, 'auto')]);
  });

  it('lets manual ones expire only when asked, never the protected one', () => {
    const names = [daysAgo(30, 'manual'), daysAgo(30, 'before-v1.0.0'), daysAgo(1, 'auto')];
    const opts = { keepDays: 14, now: NOW, includeManual: true };
    expect(expiredBackups(names, opts)).toEqual([
      daysAgo(30, 'manual'),
      daysAgo(30, 'before-v1.0.0'),
    ]);
    expect(expiredBackups(names, { ...opts, protect: [daysAgo(30, 'before-v1.0.0')] })).toEqual([
      daysAgo(30, 'manual'),
    ]);
  });
});

describe('backups on disk and off-site', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ats-backups-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A complete backup folder of `source` in `dir`, as ats-admin makes them. */
  const makeBackup = async (source: ReturnType<typeof fakeS3>, dir: string) => {
    const path = join(root, dir);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'database.sql.gz'), `database at ${dir}`);
    await writeFile(join(path, '.env'), 'SECRET=1\n');
    await writeFile(join(path, 'compose.yml'), 'services: {}\n');
    await backupBucket(source, path, null);
    return path;
  };

  it('prunes folders on disk', async () => {
    const source = fakeS3();
    await source.put('a.txt', 'A');
    await makeBackup(source, daysAgo(20, 'auto'));
    await makeBackup(source, daysAgo(2, 'auto'));
    await makeBackup(source, daysAgo(20, 'manual'));
    expect(await pruneLocal(root, { keepDays: 14, now: NOW })).toEqual([daysAgo(20, 'auto')]);
    expect((await readdir(root)).sort()).toEqual(
      [daysAgo(20, 'manual'), daysAgo(2, 'auto')].sort(),
    );
  });

  it('copies each stored file off-site once, prunes, and brings a backup back', async () => {
    const source = fakeS3('ats');
    const bucket = fakeS3('offsite');
    const target = { storage: bucket, prefix: 'all-the-spaces/test.example' };
    await source.put('shared.txt', 'in every backup');
    await source.put('old-only.txt', 'only in the old backup');
    const old = await makeBackup(source, daysAgo(20, 'auto'));
    const first = await pushBackup(target, old);
    expect(first).toMatchObject({ uploaded: 2, skipped: 0 });

    await source.delete('old-only.txt');
    await source.put('new.txt', 'added later');
    const recent = await makeBackup(source, daysAgo(1, 'auto'));
    const second = await pushBackup(target, recent);
    expect(second).toMatchObject({ uploaded: 1, skipped: 1 });
    expect(await listOffsite(target)).toEqual([daysAgo(20, 'auto'), daysAgo(1, 'auto')]);
    expect(
      bucket.objects.has(`all-the-spaces/test.example/backups/${daysAgo(1, 'auto')}/.env`),
    ).toBe(true);

    // An interrupted copy (no manifest) older than a complete one is a leftover.
    await bucket.put(
      `all-the-spaces/test.example/backups/${daysAgo(5, 'auto')}/database.sql.gz`,
      'x',
    );
    const pruned = await pruneOffsite(target, { keepDays: 14, now: NOW });
    expect(pruned).toEqual({ removed: [daysAgo(20, 'auto')], removedObjects: 1 });
    expect(await listOffsite(target)).toEqual([daysAgo(1, 'auto')]);
    const keys = [...bucket.objects.keys()];
    expect(keys.filter((k) => k.includes('/objects/'))).toHaveLength(2);
    expect(keys.some((k) => k.includes(daysAgo(5, 'auto')))).toBe(false);

    // On a new server: fetch the newest backup and check it's complete.
    const elsewhere = await mkdtemp(join(tmpdir(), 'ats-fetch-'));
    try {
      const fetched = await fetchBackup(target, elsewhere);
      expect(fetched).toMatchObject({ name: daysAgo(1, 'auto'), downloaded: 2, reused: 0 });
      const dir = join(elsewhere, fetched.name);
      expect(await readManifest(dir)).toEqual(await readManifest(recent));
      expect(await readFile(join(dir, 'database.sql.gz'), 'utf8')).toBe(
        `database at ${fetched.name}`,
      );
      expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600);
      await expect(fetchBackup(target, elsewhere)).rejects.toThrow(/already on this server/);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses a damaged off-site copy', async () => {
    const source = fakeS3('ats');
    const bucket = fakeS3('offsite');
    const target = { storage: bucket, prefix: '' };
    await source.put('a.txt', 'A');
    await pushBackup(target, await makeBackup(source, daysAgo(1, 'auto')));
    const [objectKey] = [...bucket.objects.keys()].filter((k) => k.startsWith('objects/'));
    await bucket.put(objectKey as string, 'tampered');
    const elsewhere = await mkdtemp(join(tmpdir(), 'ats-fetch-'));
    try {
      await expect(fetchBackup(target, elsewhere)).rejects.toThrow(/damaged/);
      await expect(readManifest(join(elsewhere, daysAgo(1, 'auto')))).rejects.toThrow();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
