import { type Snapshot, sha256, writeSource } from '@ats/qa';
import type { Storage } from '@ats/storage';

/**
 * A creation's source is kept content-addressed per group: each file once, by hash, plus a list
 * per snapshot. Builds start from a snapshot, and an Architect's workspace can be restored from
 * one later.
 */
const blobKey = (groupId: string, sha256: string) => `sources/${groupId}/blobs/${sha256}`;
const snapshotKey = (groupId: string, hash: string) => `sources/${groupId}/snapshots/${hash}.json`;

export async function uploadSource(
  storage: Storage,
  groupId: string,
  snapshot: Snapshot,
  contents: Map<string, Uint8Array>,
) {
  for (const f of snapshot.files) {
    const key = blobKey(groupId, f.sha256);
    if (await storage.has(key)) continue;
    await storage.put(key, contents.get(f.path) as Uint8Array);
  }
  await storage.put(
    snapshotKey(groupId, snapshot.hash),
    JSON.stringify(snapshot),
    'application/json',
  );
}

export async function downloadSource(storage: Storage, groupId: string, hash: string, dir: string) {
  const snapshot = JSON.parse(
    new TextDecoder().decode(await storage.getBytes(snapshotKey(groupId, hash))),
  ) as Snapshot;
  await writeSource(dir, snapshot, (sha) => storage.getBytes(blobKey(groupId, sha)));
  return snapshot;
}

/** A snapshot's files, in memory (each checked against its hash). */
export async function downloadSourceFiles(storage: Storage, groupId: string, hash: string) {
  const snapshot = JSON.parse(
    new TextDecoder().decode(await storage.getBytes(snapshotKey(groupId, hash))),
  ) as Snapshot;
  const files = new Map<string, Uint8Array>();
  for (const f of snapshot.files) {
    const data = await storage.getBytes(blobKey(groupId, f.sha256));
    if (sha256(data) !== f.sha256) throw new Error(`${f.path} doesn't match its hash`);
    files.set(f.path, data);
  }
  return files;
}
