/** Publish checks: each creation is checked in its own job volume, one step container at a time. */
import { DockerError, demux } from '../docker.ts';
import { type Containers, endedWithin, id } from './containers.ts';

export type Step = 'prepare' | 'finish';

/**
 * How long each step may run before it's stopped (from inside, so even if this service restarts).
 * Finishing is building (10 minutes at most: qa-browser's BUILD_MINUTES) plus playing, which may
 * take 25 minutes on a busy server and half a minute more to warm the browser up (see qa-browser's
 * PLAY_MINUTES): longer than those, so it's they that stop and say why.
 */
export const STEP_MINUTES: Record<Step, number> = { prepare: 10, finish: 36 };

/** A time a step said something, as Docker writes it in its log (UTC, to the nanosecond). */
const SAID_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/;
/** Docker trims a time's trailing zeros: with all nine digits, times compare as text. */
const fixed = (at: string) =>
  at.replace(/(?:\.(\d{1,9}))?Z$/, (_, f = '') => `.${f.padEnd(9, '0')}Z`);

/** The time an earlier call last heard a step say something, if it's one. */
export function saidAfter(value: unknown) {
  return typeof value === 'string' && SAID_AT.test(value) ? fixed(value) : undefined;
}

export function createJobs(ctx: Containers) {
  const {
    docker,
    cfg,
    name,
    ensureVolume,
    hardened,
    proxyEnv,
    egressHosts,
    run,
    remove,
    exec,
    withHelper,
  } = ctx;

  const jobVolume = (job: string) => name('job', id(job, 'job'));
  const jobMount = (job: string) => ({ name: jobVolume(job), target: '/job', role: 'job' });
  const stepName = (job: string, step: Step) => name('step', id(job, 'job'), step);
  const limited = (step: Step, cmd: string[]) => [
    'timeout',
    '-k',
    '30',
    `${STEP_MINUTES[step]}m`,
    ...cmd,
  ];

  /** Starts one step of checking a creation, in its own container (`waitStep` sees it end). */
  async function startStep(job: string, step: Step) {
    const container = stepName(job, step);
    await remove(container);
    const store = name('pnpm-store');
    await ensureVolume(store, 'pnpm-store');
    const cli = '/opt/ats/packages/qa-browser/src/cli.ts';
    const spec =
      step === 'prepare'
        ? {
            // Installing needs the npm registry: through the egress proxy only.
            Env: [...proxyEnv, 'CI=1'],
            Cmd: limited(step, [
              'node',
              cli,
              'prepare',
              '/job/project',
              '/job/out',
              '--store',
              '/store',
              '--json',
            ]),
            HostConfig: hardened({
              NetworkMode: cfg.sandboxNetwork,
              Dns: ['127.0.0.1'],
              ExtraHosts: await egressHosts(),
              Mounts: [
                { Type: 'volume', Source: jobVolume(job), Target: '/job' },
                { Type: 'volume', Source: store, Target: '/store' },
              ],
            }),
          }
        : {
            // Building and playing it: no network at all.
            Env: ['CI=1'],
            Cmd: limited(step, [
              'node',
              cli,
              'finish',
              '/job/project',
              '/job/dist',
              '/job/out',
              '--json',
            ]),
            HostConfig: hardened({
              NetworkMode: 'none',
              NanoCpus: Math.round(cfg.checkCpus * 1e9),
              Mounts: [{ Type: 'volume', Source: jobVolume(job), Target: '/job' }],
            }),
          };
    await run(container, spec, `step-${step}`);
    return { ok: true as const };
  }

  /**
   * What a step has said about what it's doing since `after` (its marked lines, see @ats/qa's
   * progress): each line with the time it said it, oldest first.
   */
  async function said(container: string, after?: string): Promise<[string, string][]> {
    // Docker's `since` counts whole seconds: the rest of that second is left out here.
    const since = after ? `&since=${Math.floor(Date.parse(after) / 1000)}` : '';
    let logs: AsyncIterable<unknown>;
    try {
      logs = await docker.raw(
        'GET',
        `/containers/${container}/logs?stdout=1&timestamps=1&tail=500${since}`,
      );
    } catch (err) {
      if (err instanceof DockerError && err.status === 404) return [];
      throw err;
    }
    const chunks: Buffer[] = [];
    for await (const c of logs) chunks.push(c as Buffer);
    const { stdout } = await demux(
      (async function* () {
        yield Buffer.concat(chunks);
      })(),
    );
    const lines: [string, string][] = [];
    for (const line of stdout.toString('utf8').split('\n')) {
      const space = line.indexOf(' ');
      const at = saidAfter(line.slice(0, space));
      const text = line.slice(space + 1);
      if (at && text.startsWith('::') && (!after || at > after))
        lines.push([at, text.slice(0, 2000)]);
    }
    return lines;
  }

  /**
   * Waits a while (at most HOLD_MS) for a step: still going, or how it ended (its last line of
   * output is its result) with what it said since `after`. An ended step's container is removed.
   */
  async function waitStep(job: string, step: Step, after?: string) {
    const container = stepName(job, step);
    const ended = await endedWithin(docker, container, 200);
    if (!ended) return { done: false as const };
    const lines = await said(container, after);
    await remove(container);
    const last = ended.stdout.toString().trim().split('\n').pop() ?? '';
    let result: Record<string, unknown> = {};
    try {
      result = JSON.parse(last);
    } catch {}
    return {
      done: true as const,
      code: ended.code,
      result,
      said: lines,
      error:
        ended.code === 124
          ? `It took longer than ${STEP_MINUTES[step]} minutes.`
          : ended.stderr.toString().slice(-2000),
    };
  }

  return {
    /** A publish check's workspace: the source goes in (as a tar archive). */
    async initJob(job: string, tar: Buffer) {
      return withHelper(
        job,
        true,
        async (helper) => {
          await exec(helper, ['mkdir', '-p', '/job/project', '/job/out', '/job/dist']);
          const r = await exec(helper, ['tar', '-x', '-C', '/job/project', '-f', '-'], {
            stdin: tar,
          });
          return r.code === 0
            ? { ok: true as const }
            : { ok: false as const, error: r.stderr.toString().slice(0, 500) };
        },
        jobMount(job),
      );
    },
    startStep,
    waitStep,
    /** What a step that's still going has said since `after` (see `said`). */
    async stepSaid(job: string, step: Step, after?: string) {
      return { said: await said(stepName(job, step), after) };
    },
    /** The report and the built creation, as a tar archive (`out/…` and `dist/…`). */
    async jobFiles(job: string) {
      return withHelper(
        job,
        false,
        async (helper) => {
          const r = await exec(helper, ['tar', '-C', '/job', '-cf', '-', 'out', 'dist'], {
            limit: 400 * 1024 * 1024,
          });
          return r.stdout;
        },
        jobMount(job),
      );
    },
    /** The job's step containers (if the server stopped waiting on one) and volume, gone. */
    async deleteJob(job: string) {
      await remove(stepName(job, 'prepare'));
      await remove(stepName(job, 'finish'));
      try {
        await docker.json('DELETE', `/volumes/${jobVolume(job)}`);
      } catch (err) {
        if (!(err instanceof DockerError) || err.status !== 404) throw err;
      }
    },
  };
}
