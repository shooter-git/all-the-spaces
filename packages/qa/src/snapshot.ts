import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/** Folders that are never part of a creation's source. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vite',
  '.turbo',
  '.cache',
  'qa-output',
]);
/**
 * Top-level folders a workspace has that aren't the creation: `request/` holds the pictures a
 * member sent with their request, for the assistant to look at. They stay in the workspace.
 */
const SKIP_TOP = new Set(['request']);
const isSkipped = (path: string) => {
  const parts = path.split('/');
  return SKIP_TOP.has(parts[0] as string) || parts.some((p) => SKIP_DIRS.has(p));
};
const LIMITS = { files: 4000, bytes: 300 * 1024 * 1024, fileBytes: 100 * 1024 * 1024 };

export interface SnapshotFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** A creation's source at one moment: every file, by content hash. */
export interface Snapshot {
  hash: string;
  bytes: number;
  files: SnapshotFile[];
}

export class SnapshotError extends Error {}

/** Reads a project folder into a snapshot (skipping dependencies, builds and links). */
export async function readSource(
  dir: string,
): Promise<{ snapshot: Snapshot; contents: Map<string, Buffer>; skipped: string[] }> {
  const contents = new Map<string, Buffer>();
  const files: SnapshotFile[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  const walk = async (d: string) => {
    for (const entry of (await readdir(d)).sort()) {
      const full = join(d, entry);
      const path = relative(dir, full).split(sep).join('/');
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        skipped.push(`${path} (a link)`);
        continue;
      }
      if (info.isDirectory()) {
        if (!isSkipped(path)) await walk(full);
        continue;
      }
      if (!info.isFile()) continue;
      if (!isSourcePath(path)) throw new SnapshotError(`A file name can't be used: ${path}`);
      if (info.size > LIMITS.fileBytes) throw new SnapshotError(`${path} is over 100 MB.`);
      if (files.length >= LIMITS.files) throw new SnapshotError('More than 4,000 files.');
      bytes += info.size;
      if (bytes > LIMITS.bytes) throw new SnapshotError('The project is over 300 MB.');
      const data = await readFile(full);
      contents.set(path, data);
      files.push({ path, bytes: data.byteLength, sha256: sha256(data) });
    }
  };
  await walk(dir);
  const hash = sha256(Buffer.from(JSON.stringify(files.map((f) => [f.path, f.sha256]))));
  return { snapshot: { hash, bytes, files }, contents, skipped };
}

/** A snapshot of files already in memory (e.g. a workspace archive), with the same rules. */
export function snapshotOf(input: Map<string, Uint8Array>): {
  snapshot: Snapshot;
  contents: Map<string, Buffer>;
} {
  const contents = new Map<string, Buffer>();
  const files: SnapshotFile[] = [];
  let bytes = 0;
  for (const path of [...input.keys()].sort()) {
    if (isSkipped(path)) continue;
    if (!isSourcePath(path)) throw new SnapshotError(`A file name can't be used: ${path}`);
    const data = Buffer.from(input.get(path) as Uint8Array);
    if (data.byteLength > LIMITS.fileBytes) throw new SnapshotError(`${path} is over 100 MB.`);
    if (files.length >= LIMITS.files) throw new SnapshotError('More than 4,000 files.');
    bytes += data.byteLength;
    if (bytes > LIMITS.bytes) throw new SnapshotError('The project is over 300 MB.');
    contents.set(path, data);
    files.push({ path, bytes: data.byteLength, sha256: sha256(data) });
  }
  const hash = sha256(Buffer.from(JSON.stringify(files.map((f) => [f.path, f.sha256]))));
  return { snapshot: { hash, bytes, files }, contents };
}

/** Writes a snapshot back out as a folder. */
export async function writeSource(
  dir: string,
  snapshot: Snapshot,
  read: (sha256: string) => Promise<Uint8Array>,
) {
  for (const f of snapshot.files) {
    if (!isSourcePath(f.path)) throw new SnapshotError(`A file name can't be used: ${f.path}`);
    const data = await read(f.sha256);
    if (sha256(data) !== f.sha256) throw new SnapshotError(`${f.path} doesn't match its hash.`);
    const out = join(dir, f.path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, data);
  }
}

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** A relative path that stays inside the project. */
export function isSourcePath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith('/') &&
    path.split('/').every((p) => p !== '' && p !== '.' && p !== '..') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters
    !/[\u0000-\u001f\\]/.test(path)
  );
}
