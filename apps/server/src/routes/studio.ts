import type { Sent, Studio } from '@ats/api-types';
import { schema } from '@ats/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isArchitect, notFound, requireUser } from '../access.ts';
import { record } from '../audit.ts';
import { afterLive, afterPlaced } from '../commissions.ts';
import { approvalsFor, declaredBy, reviewOf, unapproved } from '../connectors/approvals.ts';
import { NO_CONNECTORS } from '../connectors/registry.ts';
import type { AppContext } from '../context.ts';
import { reportKey } from '../creations/builds.ts';
import { makeCurrent } from '../creations/store.ts';
import { noEvents } from '../events.ts';
import { manifestOf } from '../manifests.ts';
import { sendError } from '../reply.ts';
import { NO_SOURCE_HOSTS } from '../sources/registry.ts';
import { sourceView } from '../sources/view.ts';
import { recordPlacements } from '../space-updates.ts';
import { getStorage } from '../storage.ts';

const { builds, creations, creationSources, creationVersions, spaces, spaceVersions } = schema;

/**
 * What Architects see of a space's creations: every version (live, candidates, earlier ones)
 * with its checks, the builds in progress, reports, going live or back, and device tests.
 */
export async function studioRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/studio', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    if (!z.uuid().safeParse(req.params.spaceId).success) return notFound(reply);
    const [space] = await db
      .select({ space: spaces, version: spaceVersions })
      .from(spaces)
      .innerJoin(spaceVersions, eq(spaceVersions.id, spaces.currentVersionId))
      .where(eq(spaces.id, req.params.spaceId));
    if (!space || !(await isArchitect(db, me.id, space.space.groupId))) return notFound(reply);
    const manifest = manifestOf(space.version);
    const objects = new Map(
      manifest.rooms.flatMap((r) =>
        r.objects.map((o) => [o.key, { label: o.label, room: r.name }] as const),
      ),
    );
    const rows = await db.select().from(creations).where(eq(creations.spaceId, req.params.spaceId));
    const versions = rows.length
      ? await db
          .select()
          .from(creationVersions)
          .where(
            inArray(
              creationVersions.creationId,
              rows.map((c) => c.id),
            ),
          )
          .orderBy(desc(creationVersions.number))
      : [];
    const approvals = await approvalsFor(
      db,
      versions.filter((v) => declaredBy(v).length).map((v) => v.id),
    );
    const recent = await db
      .select()
      .from(builds)
      .where(eq(builds.spaceId, req.params.spaceId))
      .orderBy(desc(builds.createdAt))
      .limit(20);
    const playing = await (ctx.events ?? noEvents).playing(rows.map((c) => c.id));
    const sources = rows.length
      ? await db
          .select()
          .from(creationSources)
          .where(
            inArray(
              creationSources.creationId,
              rows.map((c) => c.id),
            ),
          )
      : [];
    const taken = new Set(rows.map((c) => c.objectKey).filter(Boolean));
    reply.header('cache-control', 'private, no-store');
    return {
      space: { id: space.space.id, name: space.space.name },
      creations: rows
        .map((c) => ({
          id: c.id,
          title: c.title,
          description: c.description,
          defaultMode: c.defaultMode,
          objectKey: c.objectKey,
          object: c.objectKey ? (objects.get(c.objectKey) ?? null) : null,
          currentVersionId: c.currentVersionId,
          playing: playing[c.id] ?? 0,
          versions: versions
            .filter((v) => v.creationId === c.id)
            .map((v) => ({
              id: v.id,
              number: v.number,
              status: v.status,
              live: v.id === c.currentVersionId,
              createdAt: v.createdAt,
              publishedAt: v.publishedAt,
              bytes: v.bytes,
              qa: v.qa,
              buildId: v.buildId,
              saveVersion: v.saveVersion,
              deviceTests: v.deviceTests,
              title: v.details?.title ?? c.title,
              connectors: reviewOf(
                declaredBy(v),
                approvals.filter((a) => a.versionId === v.id),
                ctx.connectors ?? NO_CONNECTORS,
              ),
              sourceCommit: v.sourceCommit,
            })),
          source: (() => {
            const row = sources.find((r) => r.creationId === c.id);
            return row ? sourceView(row, ctx.sourceHosts ?? NO_SOURCE_HOSTS) : null;
          })(),
        }))
        .sort((a, b) => a.title.localeCompare(b.title)),
      // Objects a creation could go on (from the shelf, or moved).
      freeObjects: [...objects]
        .filter(([key]) => !taken.has(key))
        .map(([key, o]) => ({ key, ...o }))
        .sort((a, b) => a.room.localeCompare(b.room) || a.label.localeCompare(b.label)),
      builds: recent.map((b) => ({
        id: b.id,
        status: b.status,
        step: b.step,
        title: b.title,
        creationId: b.creationId,
        objectKey: b.objectKey,
        versionId: b.versionId,
        publish: b.publish,
        qa: b.qa,
        error: b.error,
        createdAt: b.createdAt,
        finishedAt: b.finishedAt,
        source: b.source
          ? { repository: b.source.repository, commit: b.source.commit, label: b.source.label }
          : null,
      })),
    } satisfies Sent<Studio>;
  });

  // ---- Builds and their reports ---------------------------------------------------------------

  const buildFor = async (userId: string, buildId: string) => {
    if (!z.uuid().safeParse(buildId).success) return null;
    const [b] = await db.select().from(builds).where(eq(builds.id, buildId));
    return b && (await isArchitect(db, userId, b.groupId)) ? b : null;
  };

  app.get<{ Params: { buildId: string } }>('/api/builds/:buildId', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const b = await buildFor(me.id, req.params.buildId);
    if (!b) return notFound(reply);
    reply.header('cache-control', 'private, no-store');
    return b;
  });

  const REPORT_TYPES: Record<string, string> = {
    json: 'application/json',
    html: 'text/html; charset=utf-8',
    png: 'image/png',
  };
  app.get<{ Params: { buildId: string; file: string } }>(
    '/api/builds/:buildId/report/:file',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const { file } = req.params;
      const type = REPORT_TYPES[file.split('.').pop() ?? ''];
      if (!type || !/^[\w.-]{1,80}$/.test(file)) return notFound(reply);
      const b = await buildFor(me.id, req.params.buildId);
      if (!b) return notFound(reply);
      let bytes: Uint8Array;
      try {
        bytes = await (await getStorage(ctx)).getBytes(reportKey(b.id, file));
      } catch {
        return notFound(reply);
      }
      return (
        reply
          .header('content-type', type)
          .header('cache-control', 'private, max-age=3600')
          .header('x-content-type-options', 'nosniff')
          // The report page is our own template; it only needs its styles and screenshots.
          .header(
            'content-security-policy',
            "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
          )
          .send(Buffer.from(bytes))
      );
    },
  );

  // ---- Where it lives -------------------------------------------------------------------------

  /**
   * Gives a creation its place (an object that doesn't hold another creation), moves it, or puts
   * it on the unplaced shelf (null). Its saved data stays as it is.
   */
  app.put<{ Params: { creationId: string } }>(
    '/api/creations/:creationId/place',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      if (!z.uuid().safeParse(req.params.creationId).success) return notFound(reply);
      const { objectKey } = z.object({ objectKey: z.string().max(100).nullable() }).parse(req.body);
      const [row] = await db
        .select({ creation: creations, version: spaceVersions })
        .from(creations)
        .innerJoin(spaces, eq(spaces.id, creations.spaceId))
        .innerJoin(spaceVersions, eq(spaceVersions.id, spaces.currentVersionId))
        .where(eq(creations.id, req.params.creationId));
      if (!row || !(await isArchitect(db, me.id, row.creation.groupId))) return notFound(reply);
      let label: string | null = null;
      if (objectKey) {
        const manifest = manifestOf(row.version);
        const room = manifest.rooms.find((r) => r.objects.some((o) => o.key === objectKey));
        if (!room) return sendError(reply, 400, 'No such object.');
        label = room.objects.find((o) => o.key === objectKey)?.label ?? null;
        const [holder] = await db
          .select({ id: creations.id, title: creations.title })
          .from(creations)
          .where(
            and(eq(creations.spaceId, row.creation.spaceId), eq(creations.objectKey, objectKey)),
          );
        if (holder && holder.id !== row.creation.id)
          return sendError(reply, 409, `It already holds ${holder.title}.`);
      }
      await db.update(creations).set({ objectKey }).where(eq(creations.id, row.creation.id));
      await recordPlacements(db, row.creation.spaceId);
      if (objectKey) await afterPlaced(db, ctx.notifier, row.creation.id, objectKey, label);
      await record(db, {
        groupId: row.creation.groupId,
        actorUserId: me.id,
        action: objectKey ? 'creation.placed' : 'creation.shelved',
        target: row.creation.id,
        metadata: { objectKey },
      });
      return { ok: true };
    },
  );

  // ---- Versions -------------------------------------------------------------------------------

  const versionFor = async (userId: string, creationId: string, versionId: string) => {
    if (!z.uuid().safeParse(creationId).success || !z.uuid().safeParse(versionId).success)
      return null;
    const [row] = await db
      .select({ creation: creations, version: creationVersions })
      .from(creationVersions)
      .innerJoin(creations, eq(creations.id, creationVersions.creationId))
      .where(and(eq(creationVersions.id, versionId), eq(creations.id, creationId)));
    return row && (await isArchitect(db, userId, row.creation.groupId)) ? row : null;
  };

  /** Make a version live: publish a candidate, or go back to an earlier version. */
  app.post<{ Params: { creationId: string; versionId: string } }>(
    '/api/creations/:creationId/versions/:versionId/live',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const row = await versionFor(me.id, req.params.creationId, req.params.versionId);
      if (!row) return notFound(reply);
      // An imported version wasn't checked here, but an Architect brought it in on purpose.
      if (row.version.qa && !row.version.qa.ok && !row.version.qa.unchecked)
        return sendError(reply, 409, "That version didn't pass its checks.");
      // Connectors it uses must be approved for this version first (imported ones too).
      const waiting = unapproved(declaredBy(row.version), await approvalsFor(db, [row.version.id]));
      if (waiting.length)
        return reply.code(409).send({
          error: `Approve what it uses first: ${waiting.map((w) => `${w.id} (${w.ops.join(', ')})`).join('; ')}.`,
          code: 'connectors-unapproved',
          connectors: waiting,
        });
      await makeCurrent(db, row.creation.id, row.version.id);
      await afterLive(db, ctx.notifier, row.version.id);
      return { ok: true };
    },
  );

  /** Results from "Try on this device". */
  app.post<{ Params: { creationId: string; versionId: string } }>(
    '/api/creations/:creationId/versions/:versionId/device-tests',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const row = await versionFor(me.id, req.params.creationId, req.params.versionId);
      if (!row) return notFound(reply);
      const n = z.number().min(0).max(100_000);
      const body = z
        .object({
          device: z.string().trim().min(1).max(80),
          width: z.number().int().min(1).max(20_000),
          height: z.number().int().min(1).max(20_000),
          seconds: n,
          fps: n,
          p50Ms: n,
          p95Ms: n,
          worstMs: n,
        })
        .parse(req.body);
      const tests = [
        ...row.version.deviceTests,
        { ...body, at: new Date().toISOString(), by: me.name },
      ].slice(-20);
      await db
        .update(creationVersions)
        .set({ deviceTests: tests })
        .where(eq(creationVersions.id, row.version.id));
      return { ok: true };
    },
  );
}
