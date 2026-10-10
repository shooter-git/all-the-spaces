/**
 * Lighting bakes for the places the server builds: Blender runs the space builder's own
 * `bake_room.py` on one room per container, with no network. A build's job has one input volume
 * (the sky, and each room's input as it's sent), read-only to Blender, and bakes its rooms in
 * numbered slots, each with its own container and output volume. However many builds ask, at most
 * `cfg.bakeParallel` bakes run at once, each with `cfg.bakeCpus` CPUs.
 */
import { DockerError } from '../docker.ts';
import { type Containers, endedWithin, HOME, id, LABEL, ROLE } from './containers.ts';

/** The image's copy of the script the server would run with Blender of its own. */
const SCRIPT = '/opt/ats/packages/space-builder/blender/bake_room.py';

/**
 * How long one room may bake before it's stopped. The heaviest sample room (the two-floor
 * building's café, 380,000 furniture triangles) takes about 8 minutes at 1024 pixels and 128
 * samples on 2 CPUs; a tall-building room about 7. This leaves room for a slower or busier
 * machine. A room that takes longer is published unbaked, and the report says so.
 */
export const BAKE_ROOM_MINUTES = 30;

export function createBakes(ctx: Containers) {
  const { docker, cfg, name, ensureVolume, hardened, run, remove, exec, withHelper } = ctx;

  const inputs = (job: string) => name('bake', id(job, 'job'));
  const outputs = (job: string, slot: number) => name('bake', id(job, 'job'), 'out', String(slot));
  const container = (job: string, slot: number) =>
    name('bake', id(job, 'job'), 'run', String(slot));
  // The input volume is mounted where the image has a folder the bake's user owns (so a new
  // volume starts out writable by the helper that fills it).
  const inputMount = (job: string) => ({ name: inputs(job), target: '/job', role: 'bake' });
  const slotOf = (value: unknown) => {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= cfg.bakeParallel)
      throw new Error('Bad slot');
    return value as number;
  };

  async function dropVolume(volume: string) {
    try {
      await docker.json('DELETE', `/volumes/${volume}`);
    } catch (err) {
      if (!(err instanceof DockerError) || err.status !== 404) throw err;
    }
  }

  /** Writes one file into the job's input volume. */
  const writeInput = (job: string, file: string, data: Buffer) =>
    withHelper(
      job,
      true,
      (helper) => exec(helper, ['sh', '-c', `cat > /job/${file}`], { stdin: data }),
      inputMount(job),
    );

  const ours = (more: Record<string, string[]>) =>
    encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${cfg.instance}`], ...more }));
  /** The names of our bake containers that are (or are about to be) running, in every build. */
  async function baking() {
    const list = await docker.json<{ Names: string[] }[]>(
      'GET',
      `/containers/json?all=1&filters=${ours({
        label: [`${LABEL}=${cfg.instance}`, `${ROLE}=bake`],
        status: ['created', 'running', 'restarting'],
      })}`,
    );
    return list.map((c) => (c.Names[0] ?? '').replace(/^\//, ''));
  }
  /** Bakes are started one at a time, so two can't both take the last free place. */
  let starting: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>) => {
    const next = starting.then(fn);
    starting = next.catch(() => {});
    return next;
  };

  return {
    /** How many bakes may run at once, and with how many CPUs each. */
    bakeSlots: async () => ({ parallel: cfg.bakeParallel, cpus: cfg.bakeCpus }),

    /** A bake job for one build: the sky goes in once (none for a plain build). */
    async bakeInit(job: string, sky: Buffer | null) {
      const r = await writeInput(job, 'sky.hdr', sky ?? Buffer.alloc(0));
      return r.code === 0
        ? { ok: true as const }
        : { ok: false as const, error: r.stderr.toString().slice(0, 500) };
    },

    /**
     * Starts baking one room in one of the job's slots (its input replaces the slot's last room's,
     * into a fresh output volume), unless as many bakes as may run at once already are: then it
     * says it's busy, and the server asks again later.
     */
    async bakeRoom(job: string, slotValue: unknown, input: Buffer) {
      const slot = slotOf(slotValue);
      const c = container(job, slot);
      const full = async () => (await baking()).filter((n) => n !== c).length >= cfg.bakeParallel;
      if (await full()) return { ok: false as const, busy: true as const };
      await remove(c);
      await dropVolume(outputs(job, slot));
      const wrote = await writeInput(job, `room-${slot}.json`, input);
      if (wrote.code !== 0) throw new Error("The room's bake input couldn't be written");
      await ensureVolume(outputs(job, slot), 'bake');
      return oneAtATime(async () => {
        if (await full()) return { ok: false as const, busy: true as const };
        await run(
          c,
          {
            // Stopped from inside if it runs too long (exit 124), even if this service restarts.
            Cmd: [
              'timeout',
              '-k',
              '30',
              `${BAKE_ROOM_MINUTES}m`,
              'blender',
              '-b',
              '--factory-startup',
              // Blender otherwise exits successfully even when the script fails.
              '--python-exit-code',
              '1',
              '--python',
              SCRIPT,
              '--',
              `/job/room-${slot}.json`,
              '/out',
            ],
            HostConfig: hardened({
              NetworkMode: 'none',
              NanoCpus: Math.round(cfg.bakeCpus * 1e9),
              Tmpfs: {
                '/tmp': 'rw,noexec,nosuid,nodev,size=256m',
                [HOME]: 'rw,noexec,nosuid,nodev,uid=2000,gid=2000,size=64m',
              },
              Mounts: [
                { Type: 'volume', Source: inputs(job), Target: '/job', ReadOnly: true },
                { Type: 'volume', Source: outputs(job, slot), Target: '/out' },
              ],
            }),
          },
          'bake',
        );
        return { ok: true as const };
      });
    },

    /**
     * Waits a while for a slot's bake: still going, or how it ended (Blender's last lines when it
     * failed).
     */
    async bakeWait(job: string, slot: unknown) {
      const ended = await endedWithin(docker, container(job, slotOf(slot)), 60);
      if (!ended) return { done: false as const };
      const { code, stdout, stderr } = ended;
      return {
        done: true as const,
        code,
        timedOut: code === 124,
        minutes: BAKE_ROOM_MINUTES,
        // Killed with no time limit reached: it used up the workbench's memory.
        outOfMemory: code === 137,
        error: `${stdout.toString()}\n${stderr.toString()}`.trim().slice(-2000),
      };
    },

    /** What a slot's bake wrote, as a tar archive (meta.json, uv2.f32, lightmap.f32). */
    async bakeFiles(job: string, slotValue: unknown) {
      const slot = slotOf(slotValue);
      const r = await withHelper(
        job,
        false,
        (helper) =>
          exec(helper, ['tar', '-C', '/out', '-cf', '-', 'meta.json', 'uv2.f32', 'lightmap.f32'], {
            limit: 300 * 1024 * 1024,
          }),
        { name: outputs(job, slot), target: '/out', role: 'bake' },
      );
      if (r.code !== 0) throw Object.assign(new Error('The bake left nothing'), { status: 404 });
      return r.stdout;
    },

    /** Every container and volume the job made, in whichever slots, gone. */
    async deleteBake(job: string) {
      const prefix = `${inputs(job)}-`;
      const mine = (n: string) =>
        n.startsWith(prefix) && /^(run|out)(-\d+)?$/.test(n.slice(prefix.length));
      const containers = await docker.json<{ Names: string[] }[]>(
        'GET',
        `/containers/json?all=1&filters=${ours({ name: [prefix] })}`,
      );
      for (const c of containers) {
        const n = (c.Names[0] ?? '').replace(/^\//, '');
        if (mine(n)) await remove(n);
      }
      const { Volumes } = await docker.json<{ Volumes: { Name: string }[] | null }>(
        'GET',
        `/volumes?filters=${ours({ name: [prefix] })}`,
      );
      for (const v of Volumes ?? []) if (mine(v.Name)) await dropVolume(v.Name);
      await dropVolume(inputs(job));
    },
  };
}
