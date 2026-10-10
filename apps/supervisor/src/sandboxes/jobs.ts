/** Publish checks: each creation is checked in its own job volume, one step container at a time. */
import { DockerError } from '../docker.ts';
import { type Containers, endedWithin, id } from './containers.ts';

export type Step = 'prepare' | 'finish';

/**
 * How long each step may run before it's stopped (from inside, so even if this service restarts).
 * Finishing is building plus playing, which may take 25 minutes on a busy server (see qa-browser's
 * PLAY_MINUTES).
 */
export const STEP_MINUTES: Record<Step, number> = { prepare: 10, finish: 30 };

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
   * Waits a while (at most HOLD_MS) for a step: still going, or how it ended (its last line of
   * output is its result). An ended step's container is removed.
   */
  async function waitStep(job: string, step: Step) {
    const container = stepName(job, step);
    const ended = await endedWithin(docker, container, 200);
    if (!ended) return { done: false as const };
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
