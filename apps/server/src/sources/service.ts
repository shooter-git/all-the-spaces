import { type Db, schema } from '@ats/db';
import { SnapshotError, scanForSecrets, snapshotOf } from '@ats/qa';
import { allowsRepository, COMMIT, GIT_REF, REPO_PATH } from '@ats/shared';
import type { Storage } from '@ats/storage';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { uploadSource } from '../creations/sources.ts';
import { filesFrom } from './archive.ts';
import { archive, behindBy, type Found, latest, SourceError } from './github.ts';
import type { SourceHostRegistry } from './registry.ts';

const { builds, creationSources, creationVersions } = schema;

export { SourceError };
export type SourceSettings = schema.SourceSettings;
export type SourceRow = typeof creationSources.$inferSelect;

export interface SourceDeps {
  db: Db;
  hosts: SourceHostRegistry;
  storage: () => Promise<Storage>;
  queue: () => Queue;
  /** This server's release, for the user agent it sends. */
  release: string;
}

/** Just the settings (a row or a stored build has more in it). */
export const settingsOf = (s: SourceSettings): SourceSettings => ({
  host: s.host,
  repository: s.repository,
  path: s.path,
  follows: s.follows,
  ref: s.ref,
  updateMode: s.updateMode,
});

/** The host for some settings, once they're checked against its definition. */
export function hostFor(deps: Pick<SourceDeps, 'hosts' | 'release'>, s: SourceSettings) {
  const host = deps.hosts.get(s.host);
  if (!host) throw new SourceError(`This server has no repository host called "${s.host}".`);
  if (!allowsRepository(host.def, s.repository))
    throw new SourceError(`${s.repository} isn't one of the repositories this server allows.`);
  if (s.path && !REPO_PATH.test(s.path)) throw new SourceError('That folder name can’t be used.');
  if (s.follows === 'branch' && !(s.ref && GIT_REF.test(s.ref)))
    throw new SourceError('Say which branch.');
  if (s.follows === 'commit' && !(s.ref && COMMIT.test(s.ref)))
    throw new SourceError('A commit is its full 40-character id.');
  return {
    def: host.def,
    token: host.token,
    userAgent: `ATS-sources/${deps.release.replace(/[^\w.+-]/g, '').slice(0, 40) || 'development'}`,
  };
}

/** What the settings point at now: the commit a new version would be built from. */
export async function lookUp(deps: Pick<SourceDeps, 'hosts' | 'release'>, s: SourceSettings) {
  return latest(hostFor(deps, s), s);
}

/**
 * Fetches one commit (the newest of what it follows, unless given), checks the files the way any
 * creation's source is checked, stores them, and queues a build. When the build passes, the
 * creation follows the repository from then on (recordSourceBuild).
 */
export async function startSourceBuild(
  deps: SourceDeps,
  b: {
    groupId: string;
    spaceId: string;
    /** Null for a new creation. */
    creationId: string | null;
    objectKey: string | null;
    settings: SourceSettings;
    commit?: Found;
    requestedBy: string | null;
    publish: boolean;
  },
) {
  const host = hostFor(deps, b.settings);
  const found = b.commit ?? (await latest(host, b.settings));
  const files = filesFrom(
    await archive(host, b.settings.repository, found.commit),
    b.settings.path,
  );
  let snap: ReturnType<typeof snapshotOf>;
  try {
    snap = snapshotOf(files);
  } catch (err) {
    if (err instanceof SnapshotError) throw new SourceError(err.message);
    throw err;
  }
  const where = b.settings.path || `${b.settings.repository}'s top folder`;
  if (!snap.contents.has('ats.json'))
    throw new SourceError(
      `There's no ats.json in ${where} at ${found.commit.slice(0, 7)}: it isn't shaped like a creation yet.`,
    );
  const secrets = scanForSecrets(snap.contents);
  if (secrets.length)
    throw new SourceError(
      `It contains things that look like secrets, so nothing was stored: ${secrets
        .slice(0, 3)
        .map((s) => s.path)
        .join(', ')}.`,
    );
  await uploadSource(await deps.storage(), b.groupId, snap.snapshot, snap.contents);
  const [build] = await deps.db
    .insert(builds)
    .values({
      groupId: b.groupId,
      spaceId: b.spaceId,
      creationId: b.creationId,
      objectKey: b.objectKey,
      publish: b.publish,
      sourceHash: snap.snapshot.hash,
      requestedBy: b.requestedBy,
      source: { ...settingsOf(b.settings), commit: found.commit, label: found.label },
    })
    .returning();
  if (!build) throw new Error('Build not created');
  await deps
    .queue()
    .add(
      'build',
      { buildId: build.id },
      { jobId: build.id, removeOnComplete: 200, removeOnFail: 200 },
    );
  return { buildId: build.id, ...found };
}

/** After a build from a repository passes: its version remembers the commit, and the creation follows. */
export async function recordSourceBuild(
  db: Db,
  build: { groupId: string; requestedBy: string | null; source: schema.BuildSource },
  made: { creationId: string; versionId: string },
) {
  const { commit, label } = build.source;
  const settings = settingsOf(build.source);
  await db
    .update(creationVersions)
    .set({ sourceCommit: commit })
    .where(eq(creationVersions.id, made.versionId));
  const now = new Date();
  const values = {
    ...settings,
    builtCommit: commit,
    latestCommit: commit,
    latestLabel: label,
    behindBy: 0,
    checkedAt: now,
    checkError: null,
  };
  await db
    .insert(creationSources)
    .values({
      creationId: made.creationId,
      groupId: build.groupId,
      createdBy: build.requestedBy,
      ...values,
    })
    .onConflictDoUpdate({ target: creationSources.creationId, set: values });
}

/** Looks at what a creation follows now, and records it (or why it couldn't). */
export async function checkSource(
  deps: Pick<SourceDeps, 'db' | 'hosts' | 'release'>,
  row: SourceRow,
) {
  const now = new Date();
  try {
    const host = hostFor(deps, row);
    const found = await latest(host, row);
    const behind = row.builtCommit
      ? await behindBy(host, row.repository, row.builtCommit, found.commit)
      : null;
    const [updated] = await deps.db
      .update(creationSources)
      .set({
        latestCommit: found.commit,
        latestLabel: found.label,
        behindBy: behind,
        checkedAt: now,
        checkError: null,
      })
      .where(eq(creationSources.creationId, row.creationId))
      .returning();
    return updated ?? row;
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    const [updated] = await deps.db
      .update(creationSources)
      .set({ checkedAt: now, checkError: err.message })
      .where(eq(creationSources.creationId, row.creationId))
      .returning();
    return updated ?? row;
  }
}
