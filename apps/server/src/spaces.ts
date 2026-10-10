import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BuildProgress, LightingReport } from '@ats/api-types';
import { PolyHaven } from '@ats/assets';
import { type Db, schema } from '@ats/db';
import type { ServerEnv } from '@ats/shared';
import type { BakeProgress, BuildOptions, BuiltSpace } from '@ats/space-builder';
import { buildSpace } from '@ats/space-builder';
import type { Storage } from '@ats/storage';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { type LightingDeps, lightingFor, lightingReport } from './lighting.ts';
import { type Log, silent } from './log.ts';
import { shareAllRooms } from './privacy.ts';

export const SAMPLES = {
  'studio-apartment': 'A furnished studio apartment with a balcony',
  'two-floor-building': 'A small two-floor building with a café, stairs, a lift and a terrace',
} as const;
export type SampleName = keyof typeof SAMPLES;

const samplesDir = new URL('../../../samples/', import.meta.url);

type AssetSettings = Pick<ServerEnv, 'ATS_OFFLINE' | 'ATS_ASSET_CACHE'> & LightingDeps['env'];

/**
 * CC0 assets for sample spaces, cached on disk. ATS_OFFLINE=1 builds plain versions instead
 * (tests, or servers without internet access).
 */
export function sampleAssets(env: AssetSettings): PolyHaven | null {
  if (env.ATS_OFFLINE) return null;
  return new PolyHaven(
    env.ATS_ASSET_CACHE ?? fileURLToPath(new URL('../../../.data/asset-cache', import.meta.url)),
  );
}

export const chunkKey = (spaceId: string, path: string) => `spaces/${spaceId}/${path}`;

/**
 * Builds a place from its plan, baking its lighting on the way (in the workbench, or with Blender
 * here: see lighting.ts). A room that can't be baked uses real-time lighting; the report says so.
 */
export async function buildPlace(
  deps: LightingDeps & { log?: Log | undefined },
  storage: Storage,
  spaceId: string,
  plan: unknown,
  options: Omit<BuildOptions, 'bake'>,
): Promise<{ built: BuiltSpace; lighting: LightingReport }> {
  const lighting = await lightingFor(deps, storage, spaceId, (p) => baking.set(spaceId, p));
  try {
    const built = await buildSpace(plan, { ...options, bake: lighting.bake });
    const report = lightingReport(built.stats.lighting, lighting.unavailable);
    if (!report.baked && report.rooms > 0)
      (deps.log ?? silent).warn(
        { spaceId, rooms: report.rooms, baked: report.bakedRooms, reason: report.reason },
        'lighting not baked',
      );
    return { built, lighting: report };
  } finally {
    baking.delete(spaceId);
    await lighting.done();
  }
}

/** How far the lighting bake of each place being built here has got. */
const baking = new Map<string, BakeProgress>();

/**
 * How far a place's build has got with its lighting (null when it isn't baking), and roughly how
 * long the rest will take: the rooms left, `parallel` at a time, at this build's average so far.
 */
export function bakeProgress(spaceId: string): BuildProgress | null {
  const p = baking.get(spaceId);
  if (!p) return null;
  const left = p.rooms - p.done;
  return {
    rooms: p.rooms,
    done: p.done,
    minutesLeft:
      p.secondsPerRoom === null || left === 0
        ? null
        : Math.max(1, Math.round((Math.ceil(left / p.parallel) * p.secondsPerRoom) / 60)),
  };
}

/**
 * Uploads a built space's files and publishes it as the space's next version (or, with
 * `candidate`, keeps it for the Architect to review first).
 */
export async function publishBuiltSpace(
  db: Db,
  storage: Storage,
  spaceId: string,
  built: BuiltSpace,
  opts: {
    candidate?: boolean;
    plan?: unknown;
    lighting?: LightingReport;
    /** Its own models' files, already kept (see place-sources.ts). */
    sources?: Record<string, string>;
  } = {},
): Promise<{ versionId: string; number: number }> {
  // Content-addressed: identical chunks across versions are stored once.
  for (const [path, bytes] of built.files) {
    await storage.put(chunkKey(spaceId, path), bytes);
  }
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ number: schema.spaceVersions.number })
      .from(schema.spaceVersions)
      .where(eq(schema.spaceVersions.spaceId, spaceId))
      .orderBy(desc(schema.spaceVersions.number))
      .limit(1);
    const number = (last?.number ?? 0) + 1;
    const [version] = await tx
      .insert(schema.spaceVersions)
      .values({
        spaceId,
        number,
        status: opts.candidate ? 'candidate' : 'published',
        manifest: built.manifest,
        plan: (opts.plan as Record<string, unknown> | undefined) ?? null,
        lighting: opts.lighting ?? null,
        sources: opts.sources ?? null,
        publishedAt: opts.candidate ? null : new Date(),
      })
      .returning({ id: schema.spaceVersions.id });
    const versionId = version?.id as string;
    if (!opts.candidate)
      await tx
        .update(schema.spaces)
        // A new version of an imported place makes it this server's own (it stays).
        .set({ currentVersionId: versionId, liveSince: new Date(), importedAt: null })
        .where(eq(schema.spaces.id, spaceId));
    return { versionId, number };
  });
}

/**
 * Starts building a sample space and returns its id straight away. Building (and especially
 * baking the lighting) takes minutes, so it happens in the background, one build at a time;
 * the space shows as `building` until it's ready.
 */
export async function createSampleSpace(
  db: Db,
  storage: Storage,
  groupId: string,
  sample: SampleName,
  opts: LightingDeps & { env: AssetSettings; log?: Log },
): Promise<{ spaceId: string; built: Promise<void> }> {
  const log = opts.log ?? silent;
  const plan = JSON.parse(await readFile(new URL(`${sample}/plan.json`, samplesDir), 'utf8'));
  const [space] = await db
    .insert(schema.spaces)
    .values({
      groupId,
      name: plan.name,
      spaceType: plan.spaceType,
      sample,
      status: 'building',
    })
    .returning({ id: schema.spaces.id });
  const spaceId = space?.id as string;
  const built = enqueue(async () => {
    try {
      const { built: result, lighting } = await buildPlace(opts, storage, spaceId, plan, {
        assets: sampleAssets(opts.env),
      });
      await publishBuiltSpace(db, storage, spaceId, result, { plan, lighting });
      // A sample has nothing private in it: everyone in the group sees every room.
      await shareAllRooms(
        db,
        spaceId,
        result.manifest.rooms.map((r) => r.key),
      );
      await db.update(schema.spaces).set({ status: 'ready' }).where(eq(schema.spaces.id, spaceId));
    } catch (err) {
      log.error({ spaceId, err }, 'building a sample space failed');
      await db.update(schema.spaces).set({ status: 'failed' }).where(eq(schema.spaces.id, spaceId));
    }
  });
  return { spaceId, built };
}

/** Builds run one after another: each one bakes its rooms' lighting, one room at a time. */
let queue: Promise<void> = Promise.resolve();
export function enqueue(job: () => Promise<void>): Promise<void> {
  queue = queue.then(job);
  return queue;
}

/** Builds that were running when the server stopped won't finish: mark them as failed. */
export async function failInterruptedBuilds(db: Db) {
  await db
    .update(schema.spaces)
    .set({ status: 'failed' })
    .where(and(eq(schema.spaces.status, 'building'), isNull(schema.spaces.currentVersionId)));
  // A place's new version that was being built from its plan: say so, so it can be built again.
  await db
    .update(schema.spaces)
    .set({
      buildState: 'failed',
      buildError: 'The server restarted while it was being built. Build it again.',
    })
    .where(eq(schema.spaces.buildState, 'building'));
}
