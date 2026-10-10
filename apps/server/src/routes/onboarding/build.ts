import type { PlanProblem, Review, Sent } from '@ats/api-types';
import { schema } from '@ats/db';
import { checkModels, modelPaths } from '@ats/space-builder';
import type { SpaceManifest } from '@ats/space-format';
import { checkPlan, type SpacePlan } from '@ats/space-format';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { notFound, requireUser } from '../../access.ts';
import { record } from '../../audit.ts';
import type { AppContext } from '../../context.ts';
import { sourcesFrom, storeSources } from '../../place-sources.ts';
import { sendError } from '../../reply.ts';
import { diffVersions, freeObjects, homelessIn, placementsOf } from '../../space-updates.ts';
import {
  bakeProgress,
  buildPlace,
  enqueue,
  publishBuiltSpace,
  sampleAssets,
} from '../../spaces.ts';
import { getStorage } from '../../storage.ts';
import { settingsFor } from '../../studio/settings.ts';
import type { OnboardingShared } from './shared.ts';

const { spaces, spaceVersions } = schema;

/** Different models one place can use (each read from the workspace and checked). */
const MAX_MODELS = 300;

/** Building the plan into a candidate version, and where the place is for its review. */
export async function buildRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { ownSpace, spaceWorkspace }: OnboardingShared,
) {
  const { db } = ctx;

  // ---- Building and publishing ------------------------------------------------------------------

  /** Builds the plan into a candidate version, in the background, for the Architect to review. */
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/build-space', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const ws = await spaceWorkspace(me.id, req.params.id);
    if (!ws?.spaceId || !ctx.supervisor) return notFound(reply);
    const spaceId = ws.spaceId;
    const [current] = await db
      .select({ state: spaces.buildState })
      .from(spaces)
      .where(eq(spaces.id, spaceId));
    if (current?.state === 'building') return sendError(reply, 409, "It's already being built.");
    const bytes = await ctx.supervisor.raw('workspace.read', { ws: ws.id }, { path: 'plan.json' });
    let raw: unknown = null;
    try {
      raw = JSON.parse(bytes?.toString('utf8') ?? 'null');
    } catch {}
    const { plan, problems } = checkPlan(raw);
    if (!plan || problems.some((p) => p.level === 'error'))
      return reply.code(422).send({ error: 'The plan has problems to fix first.', problems });
    // The models it uses, read from the workspace, checked and cleaned (they're untrusted files).
    const paths = modelPaths(plan as SpacePlan);
    if (paths.length > MAX_MODELS)
      return reply.code(422).send({
        error: `The plan uses ${paths.length} different models: at most ${MAX_MODELS}.`,
        problems,
      });
    const files = new Map<string, Uint8Array>();
    for (const path of paths) {
      const bytes = await ctx.supervisor.raw('workspace.read', { ws: ws.id }, { path });
      if (bytes) files.set(path, new Uint8Array(bytes));
    }
    const checked = await checkModels(plan as SpacePlan, files);
    if (checked.problems.length)
      return reply.code(422).send({
        error: 'Some models need fixing first.',
        problems: [
          ...problems,
          ...checked.problems.map((p) => ({ level: 'error' as const, message: p.message })),
        ],
      });
    // Recorded in the database, so a server restart shows up as an interrupted build.
    await db
      .update(spaces)
      .set({ buildState: 'building', buildError: null })
      .where(eq(spaces.id, spaceId));
    const storage = await getStorage(ctx);
    // Kept with the version (the models, and the scripts that made them): changing the place
    // later, here or on another server, starts from them.
    const sources = await sourcesFrom(ctx.supervisor, ws.id, files);
    void enqueue(async () => {
      try {
        // Its lighting is baked as part of the build (in the workbench); a room that can't be
        // baked uses real-time lighting, and the review says so.
        const { built, lighting } = await buildPlace(ctx, storage, spaceId, plan, {
          assets: sampleAssets(ctx.env),
          models: checked.models,
        });
        await publishBuiltSpace(db, storage, spaceId, built, {
          candidate: true,
          plan,
          lighting,
          sources: await storeSources(storage, spaceId, sources),
        });
        await db
          .update(spaces)
          .set({ buildState: null, buildError: null })
          .where(eq(spaces.id, spaceId));
      } catch (err) {
        await db
          .update(spaces)
          .set({ buildState: 'failed', buildError: (err as Error).message.slice(0, 500) })
          .where(eq(spaces.id, spaceId));
      }
    });
    await record(db, {
      groupId: ws.groupId,
      actorUserId: me.id,
      action: 'place.built',
      target: spaceId,
    });
    return { ok: true, problems: problems satisfies PlanProblem[] };
  });

  /** Where the place is: being built, a candidate to review, and what's live. */
  app.get<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/review', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const space = await ownSpace(me.id, req.params.spaceId);
    if (!space) return notFound(reply);
    const [latest] = await db
      .select()
      .from(spaceVersions)
      .where(eq(spaceVersions.spaceId, space.id))
      .orderBy(desc(spaceVersions.number))
      .limit(1);
    reply.header('cache-control', 'private, no-store');
    const candidate = latest && latest.status === 'candidate' ? latest : null;
    const [live] = space.currentVersionId
      ? await db.select().from(spaceVersions).where(eq(spaceVersions.id, space.currentVersionId))
      : [];
    let update = null;
    if (candidate) {
      const homeless = await homelessIn(db, space.id, candidate.manifest);
      const free = freeObjects(candidate.manifest, await placementsOf(db, space.id));
      update = {
        changes: diffVersions(live?.manifest ?? null, candidate.manifest),
        // Creations whose object isn't in the new version: each needs a new home, or the shelf.
        homeless: homeless.map((c) => ({
          id: c.id,
          title: c.title,
          objectLabel: labelIn(live?.manifest ?? null, c.objectKey),
        })),
        // Where they could go: objects in the new version that don't hold a creation.
        freeObjects: candidate.manifest.rooms.flatMap((r) =>
          r.objects
            .filter((o) => free.has(o.key))
            .map((o) => ({ key: o.key, label: o.label, room: r.name })),
        ),
      };
    }
    return {
      space: {
        id: space.id,
        name: space.name,
        status: space.status,
        live: Boolean(space.currentVersionId),
      },
      building: space.buildState === 'building',
      progress: space.buildState === 'building' ? bakeProgress(space.id) : null,
      deletesInputs: (await settingsFor(db, space.groupId)).deleteInputsAfterPublish,
      failed: space.buildState === 'failed' ? (space.buildError ?? 'It could not be built.') : null,
      candidate: candidate && {
        id: candidate.id,
        number: candidate.number,
        createdAt: candidate.createdAt,
        rooms: candidate.manifest.rooms.map((r) => ({ key: r.key, name: r.name })),
        objects: candidate.manifest.rooms.reduce((n, r) => n + r.objects.length, 0),
        lighting: candidate.lighting ?? null,
        ...update,
      },
    } satisfies Sent<Review>;
  });
}

/** "Bookshelf · Bedroom 1" for an object key in a version. */
function labelIn(manifest: SpaceManifest | null, key: string | null) {
  if (!manifest || !key) return null;
  for (const r of manifest.rooms) {
    const o = r.objects.find((x) => x.key === key);
    if (o) return `${o.label} · ${r.name}`;
  }
  return null;
}
