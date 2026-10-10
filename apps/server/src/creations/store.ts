import { createHash, randomUUID } from 'node:crypto';
import { type Db, schema } from '@ats/db';
import { isBundlePath, typeOf } from '@ats/shared';
import type { Storage } from '@ats/storage';
import { and, desc, eq } from 'drizzle-orm';
import { approve } from '../connectors/approvals.ts';

const { creations, creationVersions } = schema;

export const bundleKey = (creationId: string, bundle: string, path: string) =>
  `creations/${creationId}/${bundle}/${path}`;

/**
 * Publishes a build of a creation as its next version (creating the creation if needed).
 * Versions are immutable: files go under a folder named by the bundle's content hash.
 */
export async function publishCreation(
  db: Db,
  storage: Storage,
  input: {
    creationId?: string;
    groupId: string;
    spaceId: string;
    objectKey: string | null;
    title: string;
    description?: string;
    defaultMode?: 'solo' | 'shared' | 'invite';
    files: Map<string, Uint8Array>;
    sdkVersion: string;
    protocolVersion: number;
    createdBy?: string | null;
    /** `candidate`: keep it for trying, don't make it live. Default: published (live). */
    status?: 'published' | 'candidate';
    qa?: schema.VersionQa | null;
    buildId?: string | null;
    sourceHash?: string | null;
    saveVersion?: number | null;
    credits?: (typeof creationVersions.$inferInsert)['credits'];
    /** The connectors it uses (its ats.json `connectors`). */
    connectors?: schema.DeclaredConnector[];
    /**
     * Approve those connectors now (the server's owner, publishing from the command line; null
     * `by`). Without it, a version that uses connectors is kept as a candidate, whatever
     * `status` asks: only an approved one goes live.
     */
    approveConnectors?: { by: string | null };
  },
) {
  const connectors = input.connectors ?? [];
  const live =
    (input.status ?? 'published') === 'published' &&
    (connectors.length === 0 || input.approveConnectors !== undefined);
  const paths = [...input.files.keys()].sort();
  if (!input.files.has('index.html')) throw new Error('A creation needs an index.html');
  for (const p of paths) {
    if (!isBundlePath(p)) throw new Error(`Not allowed in a creation: ${p}`);
    if (!typeOf(p)) throw new Error(`Unsupported file type: ${p}`);
  }
  const hash = createHash('sha256');
  for (const p of paths)
    hash
      .update(p)
      .update('\0')
      .update(input.files.get(p) as Uint8Array);
  const bundle = hash.digest('hex').slice(0, 32);

  // Files go up first: they're content-addressed, so a failed publish leaves only unreferenced
  // files behind, never a creation without a version. A new creation's id is chosen here so its
  // files have a folder before its row exists.
  const creationId = input.creationId ?? randomUUID();
  for (const p of paths) {
    await storage.put(bundleKey(creationId, bundle, p), input.files.get(p) as Uint8Array);
  }
  return db.transaction(async (tx) => {
    if (!input.creationId)
      await tx.insert(creations).values({
        id: creationId,
        groupId: input.groupId,
        spaceId: input.spaceId,
        objectKey: input.objectKey,
        title: input.title,
        description: input.description ?? '',
        defaultMode: input.defaultMode ?? 'shared',
        createdBy: input.createdBy ?? null,
      });
    const [last] = await tx
      .select({ number: creationVersions.number })
      .from(creationVersions)
      .where(eq(creationVersions.creationId, creationId))
      .orderBy(desc(creationVersions.number))
      .limit(1);
    const [version] = await tx
      .insert(creationVersions)
      .values({
        creationId,
        number: (last?.number ?? 0) + 1,
        bundle,
        files: paths.map((p) => ({
          path: p,
          bytes: (input.files.get(p) as Uint8Array).byteLength,
          type: typeOf(p) as string,
        })),
        bytes: paths.reduce((n, p) => n + (input.files.get(p) as Uint8Array).byteLength, 0),
        sdkVersion: input.sdkVersion,
        protocolVersion: input.protocolVersion,
        status: live ? 'published' : 'candidate',
        qa: input.qa ?? null,
        buildId: input.buildId ?? null,
        sourceHash: input.sourceHash ?? null,
        saveVersion: input.saveVersion ?? null,
        credits: input.credits ?? [],
        details: {
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
          ...(connectors.length ? { connectors } : {}),
        },
        publishedAt: live ? new Date() : null,
      })
      .returning();
    if (version && connectors.length && input.approveConnectors)
      await approve(tx, version.id, connectors, input.approveConnectors.by);
    if (live)
      await tx
        .update(creations)
        .set({
          currentVersionId: version?.id,
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
        })
        .where(eq(creations.id, creationId));
    return {
      creationId,
      versionId: version?.id as string,
      number: version?.number as number,
      /** It went live (false: kept as a candidate). */
      live,
    };
  });
}

/**
 * Makes a version the live one: publishing a candidate, or going back to an earlier version.
 * People already inside carry on with the version they opened; everyone who opens it next gets
 * this one. Its title, description and how people join come with it.
 */
export async function makeCurrent(db: Db, creationId: string, versionId: string) {
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select()
      .from(creationVersions)
      .where(and(eq(creationVersions.id, versionId), eq(creationVersions.creationId, creationId)));
    if (!version) return null;
    await tx
      .update(creationVersions)
      .set({ status: 'published', publishedAt: version.publishedAt ?? new Date() })
      .where(eq(creationVersions.id, versionId));
    const d = version.details;
    await tx
      .update(creations)
      .set({
        currentVersionId: versionId,
        ...(d?.title ? { title: d.title } : {}),
        ...(d?.description !== undefined ? { description: d.description } : {}),
        ...(d?.defaultMode ? { defaultMode: d.defaultMode } : {}),
      })
      .where(eq(creations.id, creationId));
    return version;
  });
}
