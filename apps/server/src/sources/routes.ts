import type { CreationSource, Sent, SourceHostInfo } from '@ats/api-types';
import { schema } from '@ats/db';
import { COMMIT, uniquePatterns } from '@ats/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  architectGroups,
  isArchitect,
  notFound,
  requireArchitect,
  requireUser,
} from '../access.ts';
import { record } from '../audit.ts';
import type { AppContext } from '../context.ts';
import { buildQueue } from '../creations/builds.ts';
import { manifestOf } from '../manifests.ts';
import { sendError } from '../reply.ts';
import { getStorage } from '../storage.ts';
import { settingsFor } from '../studio/settings.ts';
import { currentSourceHosts } from './registry.ts';
import {
  checkSource,
  lookUp,
  type SourceDeps,
  SourceError,
  type SourceSettings,
  startSourceBuild,
} from './service.ts';
import { sourceView } from './view.ts';

const { creations, creationSources, spaces, spaceVersions } = schema;

const Settings = z.strictObject({
  host: z.string().min(1).max(32),
  repository: z.string().min(3).max(201),
  path: z
    .string()
    .max(500)
    .default('')
    .transform((p) => p.replace(/^\/+|\/+$/g, '')),
  follows: z.enum(['release', 'branch', 'commit']).default('release'),
  ref: z.string().max(200).nullable().default(null),
  updateMode: z.enum(['candidate', 'live']).default('candidate'),
});

/**
 * Creations from repositories (ADR 0011): which hosts this server allows, linking a creation to a
 * repository (or making a new one from it), looking for what's newer, and building it. Every
 * build goes through the same checks as any creation's.
 */
export async function sourceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  /** Read for each request: the owner's changes in the Studio count straight away. */
  const deps = async (): Promise<SourceDeps> => ({
    db,
    hosts: await currentSourceHosts(db, ctx.sourceHosts),
    storage: () => getStorage(ctx),
    queue: () => (ctx.buildQueue ??= buildQueue(ctx.env.VALKEY_URL)),
    release: ctx.env.ATS_RELEASE ?? 'development',
  });
  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SourceError) return sendError(reply, 422, err.message);
    throw err;
  };
  const settingsOf = (input: z.infer<typeof Settings>): SourceSettings => ({
    ...input,
    // Releases need no ref; a commit is written in full and lower case.
    ref: input.follows === 'release' ? null : input.ref?.trim() || null,
  });

  /**
   * The repository hosts this server allows, and which repositories on each, from its files and
   * the owner's choices in the Studio together (only Architects see them; never a token).
   */
  app.get('/api/sources', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    if (!(await architectGroups(db, me.id)).length) return notFound(reply);
    reply.header('cache-control', 'private, no-store');
    return (await currentSourceHosts(db, ctx.sourceHosts))
      .list()
      .map((h) => ({
        id: h.def.id,
        displayName: h.def.displayName,
        repositories: uniquePatterns([...h.def.repositories, ...h.added]),
      }))
      .filter((h) => h.repositories.length > 0) satisfies Sent<SourceHostInfo>[];
  });

  /** A creation, if the person is one of its group's Architects. */
  const creationFor = async (userId: string, creationId: string) => {
    if (!z.uuid().safeParse(creationId).success) return null;
    const [c] = await db.select().from(creations).where(eq(creations.id, creationId));
    return c && (await isArchitect(db, userId, c.groupId)) ? c : null;
  };
  const sourceOf = async (creationId: string) =>
    (
      await db.select().from(creationSources).where(eq(creationSources.creationId, creationId))
    )[0] ?? null;

  app.get<{ Params: { creationId: string } }>(
    '/api/creations/:creationId/source',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const c = await creationFor(me.id, req.params.creationId);
      if (!c) return notFound(reply);
      const row = await sourceOf(c.id);
      reply.header('cache-control', 'private, no-store');
      return { source: row ? sourceView(row, (await deps()).hosts) : null } satisfies {
        source: Sent<CreationSource> | null;
      };
    },
  );

  /**
   * Links a creation to a repository (or changes what it follows). Nothing is built: the
   * repository is looked at once, to be sure it's there and readable, and Update builds it.
   */
  app.put<{ Params: { creationId: string } }>(
    '/api/creations/:creationId/source',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const c = await creationFor(me.id, req.params.creationId);
      if (!c) return notFound(reply);
      const settings = settingsOf(Settings.parse(req.body ?? {}));
      const using = await deps();
      let found: Awaited<ReturnType<typeof lookUp>>;
      try {
        found = await lookUp(using, settings);
      } catch (err) {
        return refuse(reply, err);
      }
      const existing = await sourceOf(c.id);
      const same =
        existing &&
        existing.host === settings.host &&
        existing.repository.toLowerCase() === settings.repository.toLowerCase() &&
        existing.path === settings.path;
      const values = {
        ...settings,
        // Another repository or folder: what was built before isn't from it.
        builtCommit: same ? existing.builtCommit : null,
        latestCommit: found.commit,
        latestLabel: found.label,
        behindBy: same && existing.builtCommit === found.commit ? 0 : null,
        checkedAt: new Date(),
        checkError: null,
      };
      const [row] = await db
        .insert(creationSources)
        .values({ creationId: c.id, groupId: c.groupId, createdBy: me.id, ...values })
        .onConflictDoUpdate({ target: creationSources.creationId, set: values })
        .returning();
      await record(db, {
        groupId: c.groupId,
        actorUserId: me.id,
        action: 'creation.source.linked',
        target: c.id,
        metadata: {
          host: settings.host,
          repository: settings.repository,
          path: settings.path,
          follows: settings.follows,
        },
      });
      return { source: row ? sourceView(row, using.hosts) : null };
    },
  );

  app.delete<{ Params: { creationId: string } }>(
    '/api/creations/:creationId/source',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const c = await creationFor(me.id, req.params.creationId);
      if (!c) return notFound(reply);
      await db.delete(creationSources).where(eq(creationSources.creationId, c.id));
      await record(db, {
        groupId: c.groupId,
        actorUserId: me.id,
        action: 'creation.source.unlinked',
        target: c.id,
      });
      return { ok: true };
    },
  );

  /** Looks at the repository now: what's newest, and how far behind the creation is. */
  app.post<{ Params: { creationId: string } }>(
    '/api/creations/:creationId/source/check',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const c = await creationFor(me.id, req.params.creationId);
      if (!c) return notFound(reply);
      const row = await sourceOf(c.id);
      if (!row) return sendError(reply, 409, "This creation doesn't follow a repository.");
      const using = await deps();
      return { source: sourceView(await checkSource(using, row), using.hosts) };
    },
  );

  /**
   * Builds the newest of what the creation follows (or a commit given), as a candidate or
   * straight to live, as its settings say (and the group's "try it first" setting allows).
   */
  app.post<{ Params: { creationId: string } }>(
    '/api/creations/:creationId/source/update',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const c = await creationFor(me.id, req.params.creationId);
      if (!c) return notFound(reply);
      const body = z.object({ commit: z.string().regex(COMMIT).optional() }).parse(req.body ?? {});
      const row = await sourceOf(c.id);
      if (!row) return sendError(reply, 409, "This creation doesn't follow a repository.");
      const studio = await settingsFor(db, c.groupId);
      try {
        const started = await startSourceBuild(await deps(), {
          groupId: c.groupId,
          spaceId: c.spaceId,
          creationId: c.id,
          objectKey: c.objectKey,
          settings: row,
          ...(body.commit
            ? { commit: { commit: body.commit, label: body.commit.slice(0, 7) } }
            : {}),
          requestedBy: me.id,
          publish: row.updateMode === 'live' && !studio.requireDeviceTest,
        });
        await record(db, {
          groupId: c.groupId,
          actorUserId: me.id,
          action: 'creation.source.updated',
          target: c.id,
          metadata: { build: started.buildId, commit: started.commit },
        });
        return started;
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  /** A new creation on an object, built from a repository (it follows the repository from then on). */
  app.post<{ Params: { spaceId: string } }>(
    '/api/spaces/:spaceId/creations/from-repository',
    async (req, reply) => {
      if (!z.uuid().safeParse(req.params.spaceId).success) return notFound(reply);
      const [space] = await db.select().from(spaces).where(eq(spaces.id, req.params.spaceId));
      if (!space) return notFound(reply);
      const me = await requireArchitect(ctx, req, reply, space.groupId);
      if (!me) return;
      const body = Settings.extend({ objectKey: z.string().min(1).max(120) }).parse(req.body ?? {});
      const { objectKey, ...input } = body;
      // An object in the live place, without a creation on it.
      const [live] = space.currentVersionId
        ? await db.select().from(spaceVersions).where(eq(spaceVersions.id, space.currentVersionId))
        : [];
      const exists =
        live && manifestOf(live).rooms.some((r) => r.objects.some((o) => o.key === objectKey));
      if (!exists) return sendError(reply, 404, 'That object isn’t in this place.');
      const occupied = (
        await db
          .select({ objectKey: creations.objectKey })
          .from(creations)
          .where(eq(creations.spaceId, space.id))
      ).some((r) => r.objectKey === objectKey);
      if (occupied) return sendError(reply, 409, 'That object already has a creation.');
      const settings = settingsOf(input);
      const studio = await settingsFor(db, space.groupId);
      try {
        const started = await startSourceBuild(await deps(), {
          groupId: space.groupId,
          spaceId: space.id,
          creationId: null,
          objectKey,
          settings,
          requestedBy: me.id,
          publish: settings.updateMode === 'live' && !studio.requireDeviceTest,
        });
        await record(db, {
          groupId: space.groupId,
          actorUserId: me.id,
          action: 'creation.source.created',
          target: space.id,
          metadata: { build: started.buildId, repository: settings.repository, objectKey },
        });
        return started;
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );
}
