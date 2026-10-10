/**
 * Baking a place's lighting while the server builds it. With a supervisor (every installed
 * server), each room is baked by Blender in the workbench, as a short-lived job with no network
 * (the app image has no Blender). Without one (`pnpm dev` on a laptop), Blender on this machine
 * bakes it, if there is one. Either way a room whose inputs didn't change since an earlier build
 * keeps that build's bake, and a room that can't be baked uses real-time lighting: the place is
 * still built, and its report says why.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { LightingReport } from '@ats/api-types';
import { type ServerEnv, unpackTar } from '@ats/shared';
import {
  type BakeCache,
  BakeError,
  type BakeProgress,
  type BakeRunner,
  type BakeSettings,
  bakeQualityFromEnv,
  blenderBaker,
  blenderError,
  findBlender,
  type LightingStats,
} from '@ats/space-builder';
import type { Storage } from '@ats/storage';
import type { Supervisor } from './studio/supervisor.ts';

/** What a build needs to know to bake. */
export interface LightingDeps {
  env: Pick<ServerEnv, 'ATS_BAKE' | 'ATS_BAKE_RES' | 'ATS_BAKE_SAMPLES' | 'ATS_BLENDER'>;
  supervisor?: Supervisor | undefined;
  /** Blender on this machine (null: none); found from ATS_BLENDER or the PATH when absent. */
  blender?: string | null | undefined;
}

/** How one build bakes its lighting. */
export interface Lighting {
  bake: Omit<BakeSettings, 'hdriPath'> | null;
  /** Why nothing can be baked (null when it can). */
  unavailable: string | null;
  /** Clears up after the build (the supervisor's job, if it made one). */
  done(): Promise<void>;
}

/** Where the supervisor's bake job keeps the sky (its input volume, read-only to Blender). */
const JOB_SKY = '/job/sky.hdr';

/**
 * The bake for one build of one place: in the workbench (as many rooms at once as the supervisor
 * allows), here, or not at all. `progress` is told how far it has got.
 */
export async function lightingFor(
  deps: LightingDeps,
  storage: Storage,
  spaceId: string,
  progress?: (p: BakeProgress) => void,
): Promise<Lighting> {
  const none = (unavailable: string): Lighting => ({
    bake: null,
    unavailable,
    done: async () => {},
  });
  if (deps.env.ATS_BAKE === '0') return none('baking is turned off on this server (ATS_BAKE=0)');
  const quality = bakeQualityFromEnv(deps.env);
  const cache = bakeCache(storage, spaceId);
  const told = progress ? { progress } : {};
  if (deps.supervisor) {
    const job = await supervisorBaker(deps.supervisor);
    return {
      bake: { ...quality, cache, run: job.run, parallel: job.parallel, ...told },
      unavailable: null,
      done: job.done,
    };
  }
  const blender =
    deps.blender !== undefined
      ? deps.blender
      : findBlender({ ATS_BLENDER: deps.env.ATS_BLENDER, PATH: process.env.PATH });
  if (!blender) return none("there's no supervisor to bake it in, and no Blender on this server");
  return {
    bake: { ...quality, cache, run: blenderBaker(blender), ...told },
    unavailable: null,
    done: async () => {},
  };
}

/** The report a version keeps: baked, or not and why. */
export function lightingReport(stats: LightingStats, unavailable: string | null): LightingReport {
  const why = unavailable ?? stats.failure?.error ?? null;
  return {
    baked: stats.baked === stats.rooms,
    rooms: stats.rooms,
    bakedRooms: stats.baked,
    reused: stats.reused,
    reason: stats.baked === stats.rooms ? null : (why ?? 'it was not baked'),
  };
}

/**
 * Bakes kept beside the place's chunks (`spaces/<id>/bakes/<key>`): never served (only files a
 * manifest lists are), and deleted with the place.
 */
function bakeCache(storage: Storage, spaceId: string): BakeCache {
  const at = (key: string) => `spaces/${spaceId}/bakes/${key}`;
  return {
    async get(key) {
      return (await storage.has(at(key))) ? storage.getBytes(at(key)) : null;
    },
    put: (key, data) => storage.put(at(key), data),
  };
}

interface Ended {
  done: boolean;
  code?: number;
  timedOut?: boolean;
  outOfMemory?: boolean;
  minutes?: number;
  error?: string;
}

/** How long a room waits before asking again when other builds' bakes fill every place. */
const BUSY_RETRY_MS = 15_000;

/**
 * Bakes through the supervisor: one job per build (the sky goes in once), and each room in a fresh
 * container from the workbench image, in one of the job's numbered slots. As many rooms bake at
 * once as the supervisor has places for (`bake.slots`); it holds every build to that, and says
 * it's busy when they're all taken, so a room then waits and asks again. Waits in short calls, so
 * no request is held open for a whole bake; the supervisor stops a room that runs past its time
 * limit. `done` stops whatever hasn't started and clears away every container and volume the job
 * made.
 */
export async function supervisorBaker(
  sup: Supervisor,
  busyRetryMs = BUSY_RETRY_MS,
): Promise<{ run: BakeRunner; parallel: number; done(): Promise<void> }> {
  const job = `bake-${randomUUID()}`;
  const { parallel = 1 } = await sup
    .call<{ parallel?: number }>('bake.slots', {})
    .catch(() => ({ parallel: 1 }));
  const slots = Math.max(1, Math.floor(parallel));
  const free = Array.from({ length: slots }, (_, i) => i);
  const waiting: ((slot: number) => void)[] = [];
  const take = () =>
    free.length
      ? Promise.resolve(free.shift() as number)
      : new Promise<number>((r) => waiting.push(r));
  const give = (slot: number) => {
    const next = waiting.shift();
    if (next) next(slot);
    else free.push(slot);
  };
  let ready: Promise<void> | undefined;
  let stopped = false;
  /** Calls that make containers or volumes: `done` lets them finish before clearing up. */
  const making = new Set<Promise<unknown>>();
  const made = <T>(p: Promise<T>) => {
    making.add(p);
    void p.then(
      () => making.delete(p),
      () => making.delete(p),
    );
    return p;
  };
  const stillGoing = () => {
    if (stopped) throw new BakeError('the build stopped');
  };

  const run: BakeRunner = async (input) => {
    const slot = await take();
    try {
      stillGoing();
      ready ??= made(
        (async () => {
          const sky = input.hdri ? await readFile(input.hdri) : null;
          const r = await sup.call<{ ok: boolean; error?: string }>(
            'bake.init',
            { ws: job },
            sky ? { sky: sky.toString('base64') } : {},
          );
          if (!r.ok) throw new BakeError(`the bake job couldn't start: ${r.error ?? 'no reason'}`);
        })(),
      );
      await ready;
      const room = Buffer.from(JSON.stringify({ ...input, hdri: input.hdri ? JOB_SKY : null }));
      for (;;) {
        stillGoing();
        const started = await made(
          sup.call<{ ok: boolean; busy?: boolean }>(
            'bake.room',
            { ws: job },
            { slot, input: room.toString('base64') },
          ),
        );
        if (started.ok) break;
        if (!started.busy) throw new BakeError("the bake job couldn't start the room");
        await new Promise((r) => setTimeout(r, busyRetryMs));
      }
      let ended: Ended;
      do {
        stillGoing();
        ended = await sup.call<Ended>('bake.wait', { ws: job }, { slot });
      } while (!ended.done);
      if (ended.timedOut)
        throw new BakeError(`the bake job timed out after ${ended.minutes} minutes`, true);
      if (ended.outOfMemory) throw new BakeError('the bake job ran out of memory');
      if (ended.code !== 0)
        throw new BakeError(
          `the bake job failed: ${blenderError(ended.error ?? '') ?? 'no reason'}`,
        );
      const tar = await sup.raw('bake.files', { ws: job }, { slot });
      if (!tar) throw new BakeError('the bake job failed: it wrote nothing');
      const files = unpackTar(tar);
      const meta = files.get('meta.json');
      const uv2 = files.get('uv2.f32');
      const lightmap = files.get('lightmap.f32');
      if (!meta || !uv2 || !lightmap)
        throw new BakeError('the bake job failed: some of what it writes is missing');
      return {
        meta: JSON.parse(meta.toString('utf8')),
        uv2: new Uint8Array(uv2),
        lightmap: new Uint8Array(lightmap),
      };
    } catch (err) {
      if (err instanceof BakeError) throw err;
      throw new BakeError(`the bake job failed: ${(err as Error).message}`);
    } finally {
      give(slot);
    }
  };
  return {
    run,
    parallel: slots,
    async done() {
      stopped = true;
      await Promise.allSettled([...making]);
      if (ready) await sup.call('bake.delete', { ws: job }).catch(() => {});
    },
  };
}
