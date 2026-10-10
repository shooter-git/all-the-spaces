// Copies every object in a bucket into a backup folder, and puts a bucket back from one.
//
// A backup folder's storage part:
//   storage.json         the manifest: each object's key, size, ETag, content type and SHA-256
//   objects/ab/abcd…     each distinct content once, named by its SHA-256
//
// Objects that haven't changed since the previous backup (same key, size and ETag) are hard-linked
// from it instead of downloaded again, so repeated backups are cheap, yet every backup folder is
// complete on its own: deleting an old one never affects the others. Keys are never used as file
// names, so nothing in the bucket can write outside the folder.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { Storage } from './s3.ts';

export const MANIFEST = 'storage.json';
const FORMAT = 'ats-storage-backup';
const CONCURRENCY = 8;

export interface ManifestEntry {
  key: string;
  size: number;
  etag: string;
  sha256: string;
  contentType?: string | undefined;
}

export interface Manifest {
  format: typeof FORMAT;
  version: 1;
  createdAt: string;
  /** 'external': the files live in the Architect's own bucket and weren't copied. */
  storage: 'builtin' | 'external';
  bucket: string;
  objects: ManifestEntry[];
}

export const blobPath = (dir: string, sha256: string) =>
  join(dir, 'objects', sha256.slice(0, 2), sha256);

export function parseManifest(text: string, where: string): Manifest {
  const m = JSON.parse(text) as Manifest;
  if (m.format !== FORMAT || m.version !== 1 || !Array.isArray(m.objects)) {
    throw new Error(`${where} isn't a storage backup this version understands`);
  }
  return m;
}

export async function readManifest(dir: string): Promise<Manifest> {
  const path = join(dir, MANIFEST);
  return parseManifest(await readFile(path, 'utf8'), path);
}

export async function writeManifest(dir: string, m: Manifest): Promise<void> {
  // Written last and atomically: a folder with a manifest is a complete backup.
  const tmp = join(dir, `${MANIFEST}.tmp`);
  await writeFile(tmp, `${JSON.stringify(m, null, 1)}\n`);
  await rename(tmp, join(dir, MANIFEST));
}

/** A manifest for installations whose files are in the Architect's own bucket (not copied). */
export async function writeExternalManifest(dir: string, bucket: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeManifest(dir, {
    format: FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    storage: 'external',
    bucket,
    objects: [],
  });
}

/** The newest complete backup in `root` (folder names start with a sortable timestamp). */
export async function latestBackup(root: string, except: string): Promise<string | null> {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && join(root, d.name) !== except)
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const name of names) {
    const dir = join(root, name);
    if (
      await readManifest(dir).then(
        (m) => m.storage === 'builtin',
        () => false,
      )
    )
      return dir;
  }
  return null;
}

export interface Listed {
  key: string;
  size: number;
  etag: string;
}

/** Every object in the bucket, or only those whose keys start with `prefix`. */
export async function listKeys(storage: Storage, prefix?: string): Promise<Listed[]> {
  const out: Listed[] = [];
  let token: string | undefined;
  do {
    const res = await storage.client.send(
      new ListObjectsV2Command({
        Bucket: storage.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, etag: o.ETag ?? '' });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function eachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

export const isMissing = (err: unknown) =>
  (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Hard-links (or, across file systems, copies) a stored file from an earlier backup. */
export async function reuse(from: string, to: string, size: number): Promise<boolean> {
  try {
    if ((await stat(from)).size !== size) return false;
    await mkdir(dirname(to), { recursive: true });
    await link(from, to).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return;
      if (err.code === 'EXDEV' || err.code === 'EPERM') await copyFile(from, to);
      else throw err;
    });
    return true;
  } catch {
    return false;
  }
}

export async function download(
  storage: Storage,
  key: string,
  dest: string,
): Promise<Omit<ManifestEntry, 'key'> | null> {
  let res: GetObjectCommandOutput;
  try {
    res = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }));
  } catch (err) {
    if (isMissing(err)) return null; // deleted since the listing
    throw err;
  }
  const tmp = join(dest, 'objects', `.part-${randomUUID()}`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      res.Body as Readable,
      new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          size += chunk.length;
          done(null, chunk);
        },
      }),
      createWriteStream(tmp, { flags: 'wx' }),
    );
    const sha256 = hash.digest('hex');
    const final = blobPath(dest, sha256);
    await mkdir(dirname(final), { recursive: true });
    await rename(tmp, final);
    return { size, etag: res.ETag ?? '', sha256, contentType: res.ContentType };
  } finally {
    await rm(tmp, { force: true });
  }
}

export interface BackupResult {
  objects: number;
  bytes: number;
  /** Objects downloaded because the previous backup didn't have them. */
  fetched: number;
  fetchedBytes: number;
}

/** Copies the whole bucket into `dest`, reusing unchanged files from the `previous` backup. */
export async function backupBucket(
  storage: Storage,
  dest: string,
  previous: string | null,
): Promise<BackupResult> {
  await mkdir(join(dest, 'objects'), { recursive: true });
  const before = previous ? await readManifest(previous).catch(() => null) : null;
  const known = new Map(before?.objects.map((o) => [o.key, o]));
  const entries: ManifestEntry[] = [];
  const result: BackupResult = { objects: 0, bytes: 0, fetched: 0, fetchedBytes: 0 };

  await eachLimited(await listKeys(storage), async (o) => {
    const old = known.get(o.key);
    if (
      previous &&
      old &&
      o.etag &&
      old.etag === o.etag &&
      old.size === o.size &&
      (await reuse(blobPath(previous, old.sha256), blobPath(dest, old.sha256), old.size))
    ) {
      entries.push(old);
    } else {
      const got = await download(storage, o.key, dest);
      if (!got) return;
      entries.push({ key: o.key, ...got });
      result.fetched++;
      result.fetchedBytes += got.size;
    }
  });

  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const e of entries) {
    result.objects++;
    result.bytes += e.size;
  }
  await writeManifest(dest, {
    format: FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    storage: 'builtin',
    bucket: storage.bucket,
    objects: entries,
  });
  return result;
}

export interface RestoreResult {
  /** Already in the bucket unchanged. */
  kept: number;
  uploaded: number;
  /** In the bucket but not in the backup (added after it was taken). */
  removed: number;
}

/** Makes the bucket match the backup in `src` exactly: missing or changed objects are put back and
 *  objects the backup doesn't have are removed. Checks every needed file before changing anything. */
export async function restoreBucket(storage: Storage, src: string): Promise<RestoreResult> {
  const manifest = await readManifest(src);
  if (manifest.storage !== 'builtin')
    throw new Error('This backup has no copy of the stored files');
  const current = new Map((await listKeys(storage)).map((o) => [o.key, o]));
  const unchanged = (e: ManifestEntry) => {
    const c = current.get(e.key);
    return Boolean(c && e.etag && c.etag === e.etag && c.size === e.size);
  };
  const needed = manifest.objects.filter((e) => !unchanged(e));

  const damaged: string[] = [];
  await eachLimited(needed, async (e) => {
    const ok = await sha256File(blobPath(src, e.sha256)).then(
      (h) => h === e.sha256,
      () => false,
    );
    if (!ok) damaged.push(e.key);
  });
  if (damaged.length > 0) {
    throw new Error(
      `${damaged.length} stored file(s) in this backup are missing or damaged (for example ${damaged[0]}). Nothing was changed.`,
    );
  }

  await eachLimited(needed, async (e) => {
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.bucket,
        Key: e.key,
        Body: createReadStream(blobPath(src, e.sha256)),
        ContentLength: e.size,
        ContentType: e.contentType,
      }),
    );
  });

  const wanted = new Set(manifest.objects.map((e) => e.key));
  const extra = [...current.keys()].filter((k) => !wanted.has(k));
  for (let i = 0; i < extra.length; i += 1000) {
    const res = await storage.client.send(
      new DeleteObjectsCommand({
        Bucket: storage.bucket,
        Delete: { Objects: extra.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
    if (res.Errors?.length) {
      throw new Error(`Couldn't remove ${res.Errors[0]?.Key}: ${res.Errors[0]?.Message}`);
    }
  }
  return {
    kept: manifest.objects.length - needed.length,
    uploaded: needed.length,
    removed: extra.length,
  };
}
