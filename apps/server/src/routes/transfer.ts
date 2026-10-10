import { schema } from '@ats/db';
import {
  ASSET_LICENSES,
  DEPENDENCY_LICENSES,
  SnapshotError,
  scanForSecrets,
  snapshotOf,
} from '@ats/qa';
import { CONNECTOR_ID, OPERATION_NAME } from '@ats/shared';
import { checkPlan, manifestFiles, SpaceManifest, validateManifest } from '@ats/space-format';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Unzip, UnzipInflate, type Unzipped, type Zippable, zipSync } from 'fflate';
import { z } from 'zod';
import { notFound, requireArchitect } from '../access.ts';
import { record } from '../audit.ts';
import type { AppContext } from '../context.ts';
import { downloadSourceFiles, uploadSource } from '../creations/sources.ts';
import { bundleKey, publishCreation } from '../creations/store.ts';
import { manifestOf } from '../manifests.ts';
import {
  loadSources,
  SOURCE_PATH,
  SOURCE_SHA,
  sha256,
  sourceKey,
  sourcesInWorkspaces,
} from '../place-sources.ts';
import { sendError } from '../reply.ts';
import { chunkKey } from '../spaces.ts';
import { getStorage } from '../storage.ts';

const { creations, creationVersions, spaces, spaceVersions, workspaces } = schema;

/**
 * Moving things between servers, as one file each:
 *
 * - a place (`.atspace`): the 3D model people walk around in (floors, rooms, furniture, textures,
 *   baked lighting), the plan it was built from and the models made for it (with their scripts),
 *   so it can be changed on the new server. Not its people, chat, requests, creations, or the
 *   floor plans and photos uploaded to build it.
 * - a creation (`.atcreation`): its live version and the source it was built from, so it can be
 *   improved on the new server. Not anything people saved in it.
 *
 * Both are zip files with a JSON description and the files. Importing checks everything (every
 * place file against the fingerprint in its name, every creation file's type and licence) and
 * makes something new: a place arrives with every room private to Architects, a creation on the
 * shelf.
 */
export const PLACE_FORMAT = 'all-the-spaces/place';
export const CREATION_FORMAT = 'all-the-spaces/creation';

const LIMITS = {
  placeUpload: 300 * 1024 * 1024,
  creationUpload: 150 * 1024 * 1024,
  /** Unpacked, all together, counted as it unpacks: the most a creation's source may be. */
  unpacked: 300 * 1024 * 1024,
  entries: 20_000,
};
/** A place's files: content-addressed, of the kinds the viewer loads. */
const PLACE_FILE = /^chunks\/([0-9a-f]{64})\.(glb|gltf|bin|jpg|png|webp|ktx2|hdr)$/;
const LICENSES = new Set([...ASSET_LICENSES, ...DEPENDENCY_LICENSES]);

const PlaceFile = z.object({
  format: z.literal(PLACE_FORMAT),
  version: z.literal(1),
  name: z.string().min(1).max(120),
  manifest: z.unknown(),
  plan: z.unknown().optional(),
  /** The models made for it, and their scripts: path → fingerprint (see place-sources.ts). */
  sources: z
    .record(z.string().regex(SOURCE_PATH), z.string().regex(SOURCE_SHA))
    .refine((s) => Object.keys(s).length <= 1000)
    .optional(),
});
const CreationFile = z.object({
  format: z.literal(CREATION_FORMAT),
  version: z.literal(1),
  title: z.string().min(1).max(120),
  description: z.string().max(4000).default(''),
  defaultMode: z.enum(['solo', 'shared', 'invite']).default('shared'),
  sdkVersion: z.string().max(40),
  protocolVersion: z.number().int().min(1),
  saveVersion: z.number().int().nullable().optional(),
  credits: z
    .array(
      z.object({
        path: z.string().max(400),
        license: z.string().max(80),
        source: z.string().max(400).optional(),
        title: z.string().max(200).optional(),
        author: z.string().max(200).optional(),
      }),
    )
    .max(5000)
    .default([]),
  /**
   * The connectors it uses. Approvals stay on the server that gave them: an imported version
   * that uses connectors arrives as a candidate, to be approved here before it goes live.
   */
  connectors: z
    .array(
      z.object({
        id: z.string().regex(CONNECTOR_ID),
        ops: z.array(z.string().regex(OPERATION_NAME)).min(1).max(100),
        why: z.string().max(200).default(''),
      }),
    )
    .max(10)
    .default([]),
});

class TransferError extends Error {}
class SecretsError extends TransferError {
  readonly secrets: ReturnType<typeof scanForSecrets>;
  constructor(secrets: ReturnType<typeof scanForSecrets>) {
    super(
      'The creation in that file contains things that look like secrets, so nothing was stored.',
    );
    this.secrets = secrets;
  }
}

/** A file name every system accepts: "Test: two-bedroom flat" → "Test - two-bedroom flat". */
const fileName = (name: string) =>
  name
    .replace(/\s*[\\/:*?"<>|]+\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.-]+|[\s.-]+$/g, '')
    .slice(0, 80) || 'export';

/** "Harbour - Design Studio" → "harbour-design-studio". */
const slug = (name: string) =>
  name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'export';

/**
 * Unpacks an upload a piece at a time, refusing anything that unpacks too big (counting what
 * actually comes out, not what the archive says) or holds odd names.
 */
function unpack(body: Buffer): Unzipped {
  const files: Unzipped = {};
  let total = 0;
  let count = 0;
  let refused: TransferError | null = null;
  const unzip = new Unzip((file) => {
    if (refused) return;
    if (++count > LIMITS.entries) refused = new TransferError('That file holds too many things.');
    else if (file.name.includes('..') || file.name.startsWith('/') || file.name.includes('\\'))
      refused = new TransferError('That file holds something with an odd name.');
    if (refused || file.name.endsWith('/')) return;
    const parts: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (refused) return;
      if (err) {
        refused = new TransferError('That file is damaged.');
        return;
      }
      total += data.byteLength;
      if (total > LIMITS.unpacked) {
        refused = new TransferError('That file unpacks too big.');
        return;
      }
      parts.push(data);
      if (final) files[file.name] = Buffer.concat(parts);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small pieces: each one unpacks to at most about a thousand times its size.
  const piece = 16 * 1024;
  try {
    for (let at = 0; at < body.length && !refused; at += piece)
      unzip.push(body.subarray(at, at + piece), at + piece >= body.length);
  } catch {
    refused ??= new TransferError('That isn’t a file exported from All the Spaces.');
  }
  if (refused) throw refused;
  return files;
}

const describe = (zip: Unzipped, name: string): unknown => {
  const bytes = zip[name];
  if (!bytes) throw new TransferError('That isn’t a file exported from All the Spaces.');
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TransferError('That file is damaged.');
  }
};

/** Others' places and creations don't exist, as far as they can tell. */
const NOT_FOUND = { status: 404, error: 'Not found.' };

export async function transferRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env } = ctx;

  const sendFile = (reply: FastifyReply, name: string, ext: string, bytes: Uint8Array) =>
    reply
      .header('content-type', 'application/zip')
      .header(
        'content-disposition',
        `attachment; filename="${slug(name)}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${fileName(name)}.${ext}`)}`,
      )
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(bytes));
  const failed = (reply: FastifyReply, e: unknown) => {
    if (e instanceof SecretsError)
      return reply.code(422).send({ error: e.message, secrets: e.secrets.slice(0, 10) });
    if (e instanceof TransferError || e instanceof SnapshotError)
      return sendError(reply, 422, e.message);
    throw e;
  };

  // ---- A place ---------------------------------------------------------------------------------

  app.get<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/export', async (req, reply) => {
    if (!z.uuid().safeParse(req.params.spaceId).success) return reply.code(404).send();
    const [space] = await db.select().from(spaces).where(eq(spaces.id, req.params.spaceId));
    if (!space) return notFound(reply);
    const me = await requireArchitect(ctx, req, reply, space.groupId, NOT_FOUND);
    if (!me) return;
    const [version] = space.currentVersionId
      ? await db.select().from(spaceVersions).where(eq(spaceVersions.id, space.currentVersionId))
      : [];
    if (!version) return sendError(reply, 409, 'It has no published version to export yet.');
    const manifest = manifestOf(version);
    const storage = await getStorage(ctx);
    // A version from before its models were kept: from the workspace that built it, if it's there.
    const sources = version.sources
      ? await loadSources(storage, space.id, version.sources)
      : await sourcesInWorkspaces(
          ctx.supervisor,
          (
            await db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(
                and(
                  eq(workspaces.spaceId, space.id),
                  eq(workspaces.kind, 'space'),
                  ne(workspaces.status, 'archived'),
                ),
              )
              .orderBy(desc(workspaces.createdAt))
          ).map((w) => w.id),
          version.plan,
        );
    const shas = Object.fromEntries([...sources].map(([path, bytes]) => [path, sha256(bytes)]));
    const files: Zippable = {
      'place.json': [
        new TextEncoder().encode(
          JSON.stringify({
            format: PLACE_FORMAT,
            version: 1,
            name: space.name,
            exportedAt: new Date().toISOString(),
            from: env.ATS_RELEASE ?? 'development',
            manifest,
            plan: version.plan ?? undefined,
            sources: sources.size ? shas : undefined,
          }),
        ),
        { level: 6 },
      ],
    };
    // Already compressed (meshes, KTX2, WebP): stored as they are.
    for (const path of manifestFiles(manifest))
      files[`files/${path}`] = [await storage.getBytes(chunkKey(space.id, path)), { level: 0 }];
    for (const [path, bytes] of sources)
      files[`sources/${shas[path]}`] = [bytes, { level: path.endsWith('.py') ? 6 : 0 }];
    await record(db, {
      groupId: space.groupId,
      actorUserId: me.id,
      action: 'place.exported',
      target: space.id,
      metadata: { name: space.name },
    });
    return sendFile(reply, space.name, 'atspace', zipSync(files));
  });

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      ['application/zip', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: LIMITS.placeUpload },
      (_req, body, done) => done(null, body),
    );

    scope.post<{ Params: { groupId: string } }>(
      '/api/groups/:groupId/places/import',
      async (req, reply) => {
        const me = await requireArchitect(ctx, req, reply, req.params.groupId, NOT_FOUND);
        if (!me) return;
        if (!Buffer.isBuffer(req.body))
          return sendError(reply, 415, 'Send the .atspace file itself.');
        try {
          const zip = unpack(req.body);
          const parsed = PlaceFile.safeParse(describe(zip, 'place.json'));
          if (!parsed.success)
            throw new TransferError(
              'That isn’t a place exported from All the Spaces (or it’s from a newer version).',
            );
          const m = SpaceManifest.safeParse(parsed.data.manifest);
          if (!m.success || validateManifest(m.data).length)
            throw new TransferError('The place in that file is damaged.');
          const manifest = m.data;
          // Every file it needs is there, of a kind the viewer loads, and is what its name says.
          const files = new Map<string, Uint8Array>();
          for (const path of manifestFiles(manifest)) {
            const match = PLACE_FILE.exec(path);
            const bytes = zip[`files/${path}`];
            if (!match || !bytes) throw new TransferError('Some of the place’s files are missing.');
            if (sha256(bytes) !== match[1])
              throw new TransferError('Some of the place’s files are damaged.');
            files.set(path, bytes);
          }
          // The plan comes too (so the place can be changed later), if it still checks out, and
          // the models made for it. Those go only into workspaces, and are checked when it's built.
          const plan = parsed.data.plan ? checkPlan(parsed.data.plan).plan : null;
          const sources = new Map<string, Uint8Array>();
          for (const sha of new Set(Object.values(parsed.data.sources ?? {}))) {
            const bytes = zip[`sources/${sha}`];
            if (!bytes) throw new TransferError('Some of the place’s files are missing.');
            if (sha256(bytes) !== sha)
              throw new TransferError('Some of the place’s files are damaged.');
            sources.set(sha, bytes);
          }

          const taken = new Set(
            (
              await db
                .select({ name: spaces.name })
                .from(spaces)
                .where(eq(spaces.groupId, req.params.groupId))
            ).map((s) => s.name),
          );
          let name = parsed.data.name.trim();
          for (let n = 2; taken.has(name); n++) name = `${parsed.data.name.trim()} (${n})`;

          const [space] = await db
            .insert(spaces)
            .values({
              groupId: req.params.groupId,
              name,
              spaceType: manifest.spaceType,
              status: 'ready',
              importedAt: new Date(),
            })
            .returning({ id: spaces.id });
          const spaceId = space?.id as string;
          const storage = await getStorage(ctx);
          try {
            for (const [path, bytes] of files) await storage.put(chunkKey(spaceId, path), bytes);
            for (const [sha, bytes] of sources) await storage.put(sourceKey(spaceId, sha), bytes);
            await db.transaction(async (tx) => {
              const [version] = await tx
                .insert(spaceVersions)
                .values({
                  spaceId,
                  number: 1,
                  status: 'published',
                  manifest: { ...manifest, name },
                  plan: (plan as Record<string, unknown> | null) ?? null,
                  sources: plan && parsed.data.sources ? parsed.data.sources : null,
                  publishedAt: new Date(),
                })
                .returning({ id: spaceVersions.id });
              // No room policies: every room starts private to Architects.
              await tx
                .update(spaces)
                .set({ currentVersionId: version?.id, liveSince: new Date() })
                .where(eq(spaces.id, spaceId));
            });
          } catch (e) {
            await db.delete(spaces).where(eq(spaces.id, spaceId));
            await storage.deletePrefix(chunkKey(spaceId, ''));
            throw e;
          }
          await record(db, {
            groupId: req.params.groupId,
            actorUserId: me.id,
            action: 'place.imported',
            target: spaceId,
            metadata: {
              name,
              rooms: manifest.rooms.length,
            },
          });
          return { spaceId, name, rooms: manifest.rooms.length };
        } catch (e) {
          return failed(reply, e);
        }
      },
    );
  });

  // ---- A creation ------------------------------------------------------------------------------

  app.get<{ Params: { creationId: string } }>(
    '/api/creations/:creationId/export',
    async (req, reply) => {
      if (!z.uuid().safeParse(req.params.creationId).success) return reply.code(404).send();
      const [creation] = await db
        .select()
        .from(creations)
        .where(eq(creations.id, req.params.creationId));
      if (!creation) return notFound(reply);
      const me = await requireArchitect(ctx, req, reply, creation.groupId, NOT_FOUND);
      if (!me) return;
      const [version] = creation.currentVersionId
        ? await db
            .select()
            .from(creationVersions)
            .where(
              and(
                eq(creationVersions.id, creation.currentVersionId),
                eq(creationVersions.creationId, creation.id),
              ),
            )
        : [];
      if (!version) return sendError(reply, 409, 'It has no live version to export.');
      const storage = await getStorage(ctx);
      const files: Zippable = {
        'creation.json': [
          new TextEncoder().encode(
            JSON.stringify({
              format: CREATION_FORMAT,
              version: 1,
              title: creation.title,
              description: creation.description,
              defaultMode: creation.defaultMode,
              sdkVersion: version.sdkVersion,
              protocolVersion: version.protocolVersion,
              saveVersion: version.saveVersion,
              credits: version.credits,
              // What it uses, never who approved it (approvals belong to this server).
              ...(version.details?.connectors?.length
                ? { connectors: version.details.connectors }
                : {}),
              exportedAt: new Date().toISOString(),
              from: env.ATS_RELEASE ?? 'development',
            }),
          ),
          { level: 6 },
        ],
      };
      for (const f of version.files)
        files[`bundle/${f.path}`] = await storage.getBytes(
          bundleKey(creation.id, version.bundle, f.path),
        );
      // Its source, so it can be improved on the new server.
      if (version.sourceHash) {
        const source = await downloadSourceFiles(storage, creation.groupId, version.sourceHash);
        for (const [path, bytes] of source) files[`source/${path}`] = bytes;
      }
      await record(db, {
        groupId: creation.groupId,
        actorUserId: me.id,
        action: 'creation.exported',
        target: creation.id,
        metadata: {
          title: creation.title,
        },
      });
      return sendFile(reply, creation.title, 'atcreation', zipSync(files, { level: 6 }));
    },
  );

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      ['application/zip', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: LIMITS.creationUpload },
      (_req, body, done) => done(null, body),
    );

    scope.post<{ Params: { spaceId: string } }>(
      '/api/spaces/:spaceId/creations/import',
      async (req, reply) => {
        if (!z.uuid().safeParse(req.params.spaceId).success) return reply.code(404).send();
        const [space] = await db.select().from(spaces).where(eq(spaces.id, req.params.spaceId));
        if (!space) return notFound(reply);
        const me = await requireArchitect(ctx, req, reply, space.groupId, NOT_FOUND);
        if (!me) return;
        if (!Buffer.isBuffer(req.body))
          return sendError(reply, 415, 'Send the .atcreation file itself.');
        try {
          const zip = unpack(req.body);
          const parsed = CreationFile.safeParse(describe(zip, 'creation.json'));
          if (!parsed.success)
            throw new TransferError(
              'That isn’t a creation exported from All the Spaces (or it’s from a newer version).',
            );
          const d = parsed.data;
          const odd = d.credits.find((c) => !LICENSES.has(c.license));
          if (odd)
            throw new TransferError(
              `${odd.path} has a licence this server can't accept (${odd.license}).`,
            );
          const bundle = new Map<string, Uint8Array>();
          const source = new Map<string, Uint8Array>();
          for (const [name, bytes] of Object.entries(zip)) {
            if (name.startsWith('bundle/')) bundle.set(name.slice(7), bytes);
            else if (name.startsWith('source/')) source.set(name.slice(7), bytes);
          }
          if (!bundle.has('index.html'))
            throw new TransferError('The creation in that file is incomplete.');
          // Nothing that looks like a secret is stored, as when publishing from a workspace; nor
          // served, since its bundle wasn't built here.
          const secrets = [
            ...scanForSecrets(source).map((f) => ({ ...f, path: `source/${f.path}` })),
            ...scanForSecrets(bundle).map((f) => ({ ...f, path: `bundle/${f.path}` })),
          ];
          if (secrets.length) throw new SecretsError(secrets);
          const storage = await getStorage(ctx);
          let sourceHash: string | null = null;
          if (source.size) {
            const { snapshot, contents } = snapshotOf(source);
            await uploadSource(storage, space.groupId, snapshot, contents);
            sourceHash = snapshot.hash;
          }
          let published: Awaited<ReturnType<typeof publishCreation>>;
          try {
            published = await publishCreation(db, storage, {
              groupId: space.groupId,
              spaceId: space.id,
              // On the shelf: an Architect puts it on an object (and so decides where it lives).
              objectKey: null,
              title: d.title,
              description: d.description,
              defaultMode: d.defaultMode,
              files: bundle,
              sdkVersion: d.sdkVersion,
              protocolVersion: d.protocolVersion,
              createdBy: me.id,
              status: 'published',
              // Checked where it was made, not here: the Studio says so.
              qa: {
                ok: false,
                failed: 0,
                warned: 0,
                thumbnail: null,
                summary: null,
                unchecked: 'imported',
              },
              sourceHash,
              saveVersion: d.saveVersion ?? null,
              credits: d.credits,
              // Never approved by importing: it waits as a candidate until an Architect here says yes.
              ...(d.connectors.length ? { connectors: d.connectors } : {}),
            });
          } catch (e) {
            throw new TransferError((e as Error).message);
          }
          await record(db, {
            groupId: space.groupId,
            actorUserId: me.id,
            action: 'creation.imported',
            target: published.creationId,
            metadata: {
              title: d.title,
            },
          });
          return {
            creationId: published.creationId,
            title: d.title,
            /** False when it uses connectors: approve them, then make it live. */
            live: published.live,
          };
        } catch (e) {
          return failed(reply, e);
        }
      },
    );
  });
}
