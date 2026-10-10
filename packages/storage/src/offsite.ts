// Copies backup folders to an off-site bucket (any S3-compatible storage), keeps it tidy, and
// brings a backup back from it. Under the chosen prefix:
//
//   objects/ab/abcd…         each distinct stored file once, named by its SHA-256 and shared by every
//                            backup there, so a file is only uploaded the first time it's seen
//   backups/<folder>/…       database.sql.gz, .env, compose.yml and, last, storage.json
//
// A backup there is complete once its storage.json is in place. Pruning removes whole backup
// folders, then any stored file that no remaining backup mentions.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  blobPath,
  download,
  eachLimited,
  isMissing,
  latestBackup,
  listKeys,
  MANIFEST,
  type Manifest,
  parseManifest,
  readManifest,
  reuse,
  writeManifest,
} from './backup.ts';
import { expiredBackups, parseBackupName, type RetentionOptions } from './retention.ts';
import type { Storage } from './s3.ts';

/** The files besides the stored ones that make up a backup folder. */
export const BACKUP_FILES = ['database.sql.gz', '.env', 'compose.yml'] as const;

/** A stored file's key below objects/. */
const SHA_KEY = /^[0-9a-f]{2}\/([0-9a-f]{64})$/;

export interface OffsiteTarget {
  storage: Storage;
  /** Folder in the bucket, so several servers (or other things) can share one. */
  prefix: string;
}

const under = (t: OffsiteTarget, ...parts: string[]) =>
  [t.prefix.replace(/^\/+|\/+$/g, ''), ...parts].filter(Boolean).join('/');

function checkName(name: string): string {
  if (!parseBackupName(name)) throw new Error(`"${name}" isn't a backup folder name`);
  return name;
}

async function put(t: OffsiteTarget, key: string, path: string): Promise<number> {
  const { size } = await stat(path);
  await t.storage.client.send(
    new PutObjectCommand({
      Bucket: t.storage.bucket,
      Key: key,
      Body: createReadStream(path),
      ContentLength: size,
    }),
  );
  return size;
}

/** Downloads one file (false when it isn't there). */
async function get(t: OffsiteTarget, key: string, path: string, mode: number): Promise<boolean> {
  let body: Readable;
  try {
    const res = await t.storage.client.send(
      new GetObjectCommand({ Bucket: t.storage.bucket, Key: key }),
    );
    body = res.Body as Readable;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
  const tmp = `${path}.part`;
  await pipeline(body, createWriteStream(tmp, { mode }));
  await rename(tmp, path);
  return true;
}

async function remove(t: OffsiteTarget, keys: string[]): Promise<void> {
  // One key per request (several at once): not every S3-compatible service has batch deletes.
  await eachLimited(keys, (key) => t.storage.delete(key));
}

/** The backups in the off-site bucket: complete ones, and leftovers of interrupted copies. */
async function listBackups(t: OffsiteTarget) {
  const root = `${under(t, 'backups')}/`;
  const folders = new Map<string, { keys: string[]; complete: boolean }>();
  for (const o of await listKeys(t.storage, root)) {
    const [name, file] = o.key.slice(root.length).split('/', 2);
    if (!name || !file || !parseBackupName(name)) continue;
    const f = folders.get(name) ?? { keys: [], complete: false };
    f.keys.push(o.key);
    if (file === MANIFEST) f.complete = true;
    folders.set(name, f);
  }
  return folders;
}

/** Names of the complete backups off-site, oldest first. */
export async function listOffsite(t: OffsiteTarget): Promise<string[]> {
  return [...(await listBackups(t))]
    .filter(([, f]) => f.complete)
    .map(([name]) => name)
    .sort();
}

async function readRemoteManifest(t: OffsiteTarget, name: string): Promise<Manifest> {
  const key = under(t, 'backups', name, MANIFEST);
  return parseManifest(new TextDecoder().decode(await t.storage.getBytes(key)), key);
}

export interface PushResult {
  name: string;
  uploaded: number;
  uploadedBytes: number;
  /** Stored files the bucket already had. */
  skipped: number;
}

/** Copies the backup folder `dir` off-site. Stored files already there (by SHA-256) are skipped. */
export async function pushBackup(t: OffsiteTarget, dir: string): Promise<PushResult> {
  const name = checkName(basename(dir));
  const manifest = await readManifest(dir);
  const present = new Set((await listKeys(t.storage, `${under(t, 'objects')}/`)).map((o) => o.key));
  const result: PushResult = { name, uploaded: 0, uploadedBytes: 0, skipped: 0 };
  const shas = [...new Set(manifest.objects.map((o) => o.sha256))];
  await eachLimited(shas, async (sha) => {
    const key = under(t, 'objects', sha.slice(0, 2), sha);
    if (present.has(key)) {
      result.skipped++;
      return;
    }
    result.uploadedBytes += await put(t, key, blobPath(dir, sha));
    result.uploaded++;
  });
  for (const file of BACKUP_FILES) {
    const path = join(dir, file);
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    ) {
      result.uploadedBytes += await put(t, under(t, 'backups', name, file), path);
    }
  }
  // Last: a folder with a manifest is a complete backup.
  await put(t, under(t, 'backups', name, MANIFEST), join(dir, MANIFEST));
  return result;
}

export interface OffsitePruneResult {
  removed: string[];
  removedObjects: number;
}

/** Deletes expired backups off-site (same rules as on the server), leftovers of interrupted
 *  copies, and stored files no remaining backup needs. */
export async function pruneOffsite(
  t: OffsiteTarget,
  opts: RetentionOptions,
): Promise<OffsitePruneResult> {
  const folders = await listBackups(t);
  const complete = [...folders].filter(([, f]) => f.complete).map(([name]) => name);
  const expired = expiredBackups(complete, opts);
  const newest = complete.sort().at(-1);
  const leftovers = [...folders]
    .filter(([name, f]) => !f.complete && newest !== undefined && name < newest)
    .map(([name]) => name);
  for (const name of [...expired, ...leftovers]) {
    await remove(t, folders.get(name)?.keys ?? []);
  }

  // Keep every stored file a remaining backup mentions. With no complete backup left to go by
  // (it can't happen, since the newest is always kept), nothing is removed.
  const remaining = complete.filter((name) => !expired.includes(name));
  if (remaining.length === 0) return { removed: expired, removedObjects: 0 };
  const needed = new Set<string>();
  for (const name of remaining) {
    for (const o of (await readRemoteManifest(t, name)).objects) needed.add(o.sha256);
  }
  const objectsRoot = `${under(t, 'objects')}/`;
  const unused = (await listKeys(t.storage, objectsRoot))
    .map((o) => o.key)
    .filter((key) => {
      const sha = SHA_KEY.exec(key.slice(objectsRoot.length))?.[1];
      return sha !== undefined && !needed.has(sha);
    });
  await remove(t, unused);
  return { removed: expired, removedObjects: unused.length };
}

export interface FetchResult {
  name: string;
  downloaded: number;
  downloadedBytes: number;
  /** Stored files hard-linked from a backup already on this server. */
  reused: number;
}

/** Downloads the off-site backup `name` (default: the newest) into `root`/<name>, checking every
 *  stored file's SHA-256. The result is an ordinary backup folder that `restore` accepts. */
export async function fetchBackup(
  t: OffsiteTarget,
  root: string,
  name?: string,
): Promise<FetchResult> {
  const available = await listOffsite(t);
  const chosen = name ? checkName(name) : available.at(-1);
  if (!chosen || !available.includes(chosen)) {
    throw new Error(
      available.length
        ? `There's no complete backup called ${chosen} off-site. Available: ${available.join(', ')}`
        : `There are no backups in the folder "${t.prefix}" of that bucket.`,
    );
  }
  const dest = join(root, chosen);
  if (
    await readManifest(dest).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(`${chosen} is already on this server.`);
  }
  await mkdir(join(dest, 'objects'), { recursive: true });
  const manifest = await readRemoteManifest(t, chosen);
  const previous = await latestBackup(root, dest);
  const bySha = new Map(manifest.objects.map((o) => [o.sha256, o.size]));
  const result: FetchResult = { name: chosen, downloaded: 0, downloadedBytes: 0, reused: 0 };

  await eachLimited([...bySha], async ([sha, size]) => {
    if (previous && (await reuse(blobPath(previous, sha), blobPath(dest, sha), size))) {
      result.reused++;
      return;
    }
    const got = await download(t.storage, under(t, 'objects', sha.slice(0, 2), sha), dest);
    if (!got) throw new Error(`The off-site copy is missing a stored file (${sha}).`);
    if (got.sha256 !== sha) {
      await rm(blobPath(dest, got.sha256), { force: true });
      throw new Error(`A stored file in the off-site copy is damaged (${sha}).`);
    }
    result.downloaded++;
    result.downloadedBytes += got.size;
  });
  for (const file of BACKUP_FILES) {
    const path = join(dest, file);
    if (await get(t, under(t, 'backups', chosen, file), path, file === '.env' ? 0o600 : 0o644)) {
      result.downloadedBytes += (await stat(path)).size;
    }
  }
  await writeManifest(dest, manifest);
  return result;
}
