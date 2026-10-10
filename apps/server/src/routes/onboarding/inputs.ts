import type { AddedInput, PlaceInput, Sent } from '@ats/api-types';
import { schema } from '@ats/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { OutputInfo } from 'sharp';
import { z } from 'zod';
import { isArchitect, notFound, requireUser } from '../../access.ts';
import { record } from '../../audit.ts';
import type { AppContext } from '../../context.ts';
import { openPicture } from '../../pictures.ts';
import { sendError } from '../../reply.ts';
import { chunkKey } from '../../spaces.ts';
import { getStorage } from '../../storage.ts';
import { inputKey, LIMITS, type OnboardingShared } from './shared.ts';

const { commissions, creations, spaces, spaceInputs, workspaces } = schema;

const INPUT_NAME = /^(plan|photo)-\d{1,2}$/;
const SPACE_TYPES = ['apartment', 'condo', 'house', 'office', 'building', 'other'] as const;

/** A new place (or discarding one), and the floor plans and photos given for it. */
export async function inputRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { ownSpace }: OnboardingShared,
) {
  const { db } = ctx;

  // ---- A new place -----------------------------------------------------------------------------

  app.post<{ Params: { groupId: string } }>('/api/groups/:groupId/places', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    if (!(await isArchitect(db, me.id, req.params.groupId))) return notFound(reply);
    const body = z
      .object({ name: z.string().trim().min(1).max(80), spaceType: z.enum(SPACE_TYPES) })
      .parse(req.body);
    const [space] = await db
      .insert(spaces)
      .values({
        groupId: req.params.groupId,
        name: body.name,
        spaceType: body.spaceType,
        status: 'draft',
      })
      .returning({ id: spaces.id });
    await record(db, {
      groupId: req.params.groupId,
      actorUserId: me.id,
      action: 'place.created',
      target: space?.id as string,
      metadata: {
        spaceType: body.spaceType,
      },
    });
    return { spaceId: space?.id };
  });

  /**
   * Discards a place that's still being set up (its workspace, what was added for it, drafts),
   * one that couldn't be built, or a sample nobody has made anything in.
   */
  app.delete<{ Params: { spaceId: string } }>('/api/spaces/:spaceId', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const space = await ownSpace(me.id, req.params.spaceId);
    if (!space) return notFound(reply);
    if (space.status === 'building')
      return sendError(reply, 409, 'It is being built. Try again when that has finished.');
    // A place built here stays; a sample, or one imported and not changed since, can go.
    if (space.status === 'ready' && !space.sample && !space.importedAt)
      return sendError(
        reply,
        409,
        'Only a sample, an imported place, or a place still being set up, can be removed.',
      );
    if (space.status === 'ready') {
      const [made] = await db
        .select({ id: creations.id })
        .from(creations)
        .where(eq(creations.spaceId, space.id))
        .limit(1);
      const [asked] = await db
        .select({ id: commissions.id })
        .from(commissions)
        .where(eq(commissions.spaceId, space.id))
        .limit(1);
      if (made || asked)
        return sendError(
          reply,
          409,
          `Creations or requests belong to this ${space.sample ? 'sample' : 'place'}, so it stays.`,
        );
    }
    if (space.buildState === 'building')
      return sendError(reply, 409, 'It is being built. Try again when that has finished.');
    const own = await db.select().from(workspaces).where(eq(workspaces.spaceId, space.id));
    if (own.some((w) => w.status !== 'archived') && !ctx.supervisor)
      return sendError(reply, 503, "The Studio isn't set up on this server yet.");
    for (const w of own) {
      if (w.status === 'archived' || !ctx.supervisor) continue;
      const r = await ctx.supervisor.call<{ ok: boolean; error?: string }>('workspace.delete', {
        ws: w.id,
      });
      if (!r.ok)
        return sendError(reply, 502, `Its workspace couldn't be removed: ${r.error ?? ''}`);
    }
    const storage = await getStorage(ctx);
    await storage.deletePrefix(`inputs/${space.id}/`);
    await storage.deletePrefix(chunkKey(space.id, ''));
    // Workspaces, inputs and versions go with it.
    await db.delete(spaces).where(eq(spaces.id, space.id));
    await record(db, {
      groupId: space.groupId,
      actorUserId: me.id,
      action: 'place.discarded',
      target: space.id,
      metadata: {
        name: space.name,
        ...(space.sample ? { sample: space.sample } : {}),
      },
    });
    return { ok: true };
  });

  // ---- Floor plans and photos ------------------------------------------------------------------

  await app.register(async (scope) => {
    // Images arrive as the request body (up to 25 MB each).
    scope.addContentTypeParser(
      /^image\//,
      { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.put<{ Params: { spaceId: string; name: string }; Querystring: { note?: string } }>(
      '/api/spaces/:spaceId/inputs/:name',
      async (req, reply) => {
        const me = await requireUser(ctx, req, reply);
        if (!me) return;
        const space = await ownSpace(me.id, req.params.spaceId);
        const name = req.params.name;
        if (!space || !INPUT_NAME.test(name)) return notFound(reply);
        const kind: 'plan' | 'photo' = name.startsWith('plan') ? 'plan' : 'photo';
        const existing = await db
          .select()
          .from(spaceInputs)
          .where(eq(spaceInputs.spaceId, space.id));
        if (
          !existing.some((i) => i.name === name) &&
          existing.filter((i) => i.kind === kind).length >= LIMITS[kind]
        )
          return sendError(
            reply,
            413,
            `Up to ${LIMITS[kind]} ${kind === 'plan' ? 'floor plans' : 'photos'} per place.`,
          );
        if (!Buffer.isBuffer(req.body))
          return sendError(
            reply,
            415,
            'Send a photo or picture of the plan (JPEG, PNG, WebP, HEIC…).',
          );
        // Re-encoded: upright, at most 3,000 px, with no location, camera or other hidden details.
        let jpeg: Buffer;
        let info: OutputInfo;
        try {
          ({ data: jpeg, info } = await (await openPicture(req.body, 100_000_000))
            .rotate()
            .resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 86, mozjpeg: true })
            .toBuffer({ resolveWithObject: true }));
        } catch {
          return sendError(reply, 415, "That file couldn't be read as a picture.");
        }
        await (await getStorage(ctx)).put(inputKey(space.id, name), jpeg, 'image/jpeg');
        const note = String(req.query.note ?? '').slice(0, 200);
        const values = {
          spaceId: space.id,
          name,
          kind,
          note,
          width: info.width,
          height: info.height,
          bytes: jpeg.length,
        };
        await db
          .insert(spaceInputs)
          .values(values)
          .onConflictDoUpdate({ target: [spaceInputs.spaceId, spaceInputs.name], set: values });
        return {
          name,
          kind,
          width: info.width,
          height: info.height,
          bytes: jpeg.length,
        } satisfies AddedInput;
      },
    );
  });

  app.get<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/inputs', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const space = await ownSpace(me.id, req.params.spaceId);
    if (!space) return notFound(reply);
    reply.header('cache-control', 'private, no-store');
    const inputs = await db.select().from(spaceInputs).where(eq(spaceInputs.spaceId, space.id));
    return { inputs: inputs satisfies Sent<PlaceInput>[] };
  });

  app.get<{ Params: { spaceId: string; name: string } }>(
    '/api/spaces/:spaceId/inputs/:name',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const space = await ownSpace(me.id, req.params.spaceId);
      if (!space || !INPUT_NAME.test(req.params.name)) return notFound(reply);
      try {
        const bytes = await (await getStorage(ctx)).getBytes(inputKey(space.id, req.params.name));
        return reply
          .header('content-type', 'image/jpeg')
          .header('cache-control', 'private, no-store')
          .send(Buffer.from(bytes));
      } catch {
        return notFound(reply);
      }
    },
  );

  app.delete<{ Params: { spaceId: string; name: string } }>(
    '/api/spaces/:spaceId/inputs/:name',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const space = await ownSpace(me.id, req.params.spaceId);
      if (!space || !INPUT_NAME.test(req.params.name)) return notFound(reply);
      await (await getStorage(ctx)).delete(inputKey(space.id, req.params.name)).catch(() => {});
      await db
        .delete(spaceInputs)
        .where(and(eq(spaceInputs.spaceId, space.id), eq(spaceInputs.name, req.params.name)));
      return { ok: true };
    },
  );
}
