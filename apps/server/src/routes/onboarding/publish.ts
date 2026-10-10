import type { PlaceVersion, Sent } from '@ats/api-types';
import { schema } from '@ats/db';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, requireUser } from '../../access.ts';
import { record } from '../../audit.ts';
import type { AppContext } from '../../context.ts';
import { noEvents } from '../../events.ts';
import { sendError } from '../../reply.ts';
import {
  applyPlacements,
  homelessIn,
  orphanRequests,
  placementsOf,
  recordPlacements,
} from '../../space-updates.ts';
import { getStorage } from '../../storage.ts';
import { settingsFor } from '../../studio/settings.ts';
import type { OnboardingShared } from './shared.ts';

const { creations, spaces, spaceInputs, spaceVersions, workspaces } = schema;

/** Publishing a candidate, the versions that have been live, and going back to one. */
export async function publishRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { ownSpace }: OnboardingShared,
) {
  const { db } = ctx;

  /**
   * Makes a candidate the live space. Rooms start private to Architects: nothing about any room
   * reaches anyone else until it's shared on the privacy page. When it replaces a live version,
   * every creation whose object is gone must be given a new home or put on the shelf first
   * (`moves`: creation id → object key, or null for the shelf). Saved data always stays.
   */
  app.post<{ Params: { spaceId: string; versionId: string } }>(
    '/api/spaces/:spaceId/versions/:versionId/publish',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const space = await ownSpace(me.id, req.params.spaceId);
      if (!space || !z.uuid().safeParse(req.params.versionId).success) return notFound(reply);
      const { moves } = z
        .object({ moves: z.record(z.uuid(), z.string().max(100).nullable()).default({}) })
        .parse(req.body ?? {});
      const [version] = await db
        .select()
        .from(spaceVersions)
        .where(
          and(eq(spaceVersions.id, req.params.versionId), eq(spaceVersions.spaceId, space.id)),
        );
      if (version?.status !== 'candidate') return notFound(reply);
      const homeless = await homelessIn(db, space.id, version.manifest);
      const undecided = homeless.filter((c) => !(c.id in moves));
      if (undecided.length)
        return reply.code(409).send({
          error: 'Some creations need a new home (or the shelf) first.',
          undecided: undecided.map((c) => ({ id: c.id, title: c.title })),
        });
      // Each move: to a free object in the new version, one creation per object.
      const placements = await placementsOf(db, space.id);
      for (const id of Object.keys(moves)) if (!(id in placements)) delete moves[id];
      const keys = new Set(version.manifest.rooms.flatMap((r) => r.objects.map((o) => o.key)));
      const after = { ...placements, ...moves };
      const targets = Object.values(moves).filter((k): k is string => Boolean(k));
      for (const key of targets) {
        const holders = Object.values(after).filter((k) => k === key).length;
        if (!keys.has(key) || holders > 1)
          return sendError(reply, 409, 'Each creation needs its own object.');
      }
      // Remember where everything was on the version being replaced (to go back to it).
      await recordPlacements(db, space.id);
      await db.transaction(async (tx) => {
        for (const [id, key] of Object.entries(moves))
          await tx.update(creations).set({ objectKey: key }).where(eq(creations.id, id));
        await tx
          .update(spaceVersions)
          .set({ status: 'published', publishedAt: new Date() })
          .where(eq(spaceVersions.id, version.id));
        await tx
          .update(spaces)
          .set({ currentVersionId: version.id, liveSince: new Date(), status: 'ready' })
          .where(eq(spaces.id, space.id));
      });
      await recordPlacements(db, space.id);
      await orphanRequests(db, space.id, version.manifest);
      const inputsDeleted = await deleteInputsIfAsked(space.id, space.groupId);
      // People in the space now get the new version straight away.
      await (ctx.events ?? noEvents).policyChanged(space.id);
      await record(db, {
        groupId: space.groupId,
        actorUserId: me.id,
        action: 'place.published',
        target: space.id,
        metadata: {
          version: version.number,
          shelved: Object.values(moves).filter((k) => !k).length,
          moved: targets.length,
          inputsDeleted,
        },
      });
      return { ok: true, inputsDeleted };
    },
  );

  /** Every version of a place that has been live, newest first. */
  app.get<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/versions', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const space = await ownSpace(me.id, req.params.spaceId);
    if (!space) return notFound(reply);
    const rows = await db
      .select({
        id: spaceVersions.id,
        number: spaceVersions.number,
        status: spaceVersions.status,
        manifest: spaceVersions.manifest,
        lighting: spaceVersions.lighting,
        publishedAt: spaceVersions.publishedAt,
        createdAt: spaceVersions.createdAt,
      })
      .from(spaceVersions)
      .where(and(eq(spaceVersions.spaceId, space.id), eq(spaceVersions.status, 'published')))
      .orderBy(desc(spaceVersions.number));
    reply.header('cache-control', 'private, no-store');
    return {
      /** When the live version became live (a change started before then is out of date). */
      liveSince: space.liveSince,
      versions: rows.map((v) => ({
        id: v.id,
        number: v.number,
        live: v.id === space.currentVersionId,
        rooms: v.manifest.rooms.length,
        objects: v.manifest.rooms.reduce((n, r) => n + r.objects.length, 0),
        publishedAt: v.publishedAt ?? v.createdAt,
        lighting: v.lighting ?? null,
      })) satisfies Sent<PlaceVersion>[],
    };
  });

  /**
   * Makes an earlier (or later) version live again, with every creation back where it was then.
   * Creations made since keep their object if it's there, and otherwise wait on the shelf.
   */
  app.post<{ Params: { spaceId: string; versionId: string } }>(
    '/api/spaces/:spaceId/versions/:versionId/live',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const space = await ownSpace(me.id, req.params.spaceId);
      if (!space || !z.uuid().safeParse(req.params.versionId).success) return notFound(reply);
      const [version] = await db
        .select()
        .from(spaceVersions)
        .where(
          and(eq(spaceVersions.id, req.params.versionId), eq(spaceVersions.spaceId, space.id)),
        );
      if (version?.status !== 'published') return notFound(reply);
      if (version.id === space.currentVersionId) return { ok: true };
      await recordPlacements(db, space.id);
      await db
        .update(spaces)
        .set({ currentVersionId: version.id, liveSince: new Date() })
        .where(eq(spaces.id, space.id));
      const placed = await applyPlacements(db, space.id, version);
      await recordPlacements(db, space.id);
      await orphanRequests(db, space.id, version.manifest);
      await (ctx.events ?? noEvents).policyChanged(space.id);
      await record(db, {
        groupId: space.groupId,
        actorUserId: me.id,
        action: 'place.reverted',
        target: space.id,
        metadata: { version: version.number },
      });
      return { ok: true, shelved: Object.values(placed).filter((k) => !k).length };
    },
  );

  /**
   * When the group asks for it, a published place's floor plans and photos are deleted: the
   * uploads, and the workspaces that hold copies of them. The place itself (and its plan) stays;
   * changing it later starts from the plan.
   */
  async function deleteInputsIfAsked(spaceId: string, groupId: string) {
    const settings = await settingsFor(db, groupId);
    if (!settings.deleteInputsAfterPublish) return false;
    await (await getStorage(ctx)).deletePrefix(`inputs/${spaceId}/`);
    await db.delete(spaceInputs).where(eq(spaceInputs.spaceId, spaceId));
    const held = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.spaceId, spaceId),
          eq(workspaces.kind, 'space'),
          ne(workspaces.status, 'archived'),
        ),
      );
    for (const w of held)
      await ctx.supervisor?.call('workspace.delete', { ws: w.id }).catch(() => {});
    if (held.length)
      await db
        .update(workspaces)
        .set({ status: 'archived' })
        .where(
          inArray(
            workspaces.id,
            held.map((w) => w.id),
          ),
        );
    return true;
  }
}
