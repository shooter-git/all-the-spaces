import { availableParallelism } from 'node:os';
import { loadSupervisorEnv } from '@ats/shared';
import { docker } from './docker.ts';
import { log } from './log.ts';
import { bakeSlots, checkCpus } from './sandboxes/containers.ts';
import { createSandboxes } from './sandboxes.ts';
import { createSupervisorServer } from './server.ts';

const env = loadSupervisorEnv();
const instance = env.ATS_INSTANCE;
/** The egress proxy's container: sandboxes are told its address, and its log is read for blocks. */
const egressContainer = env.ATS_EGRESS_CONTAINER ?? `${instance}-egress-1`;
const engine = docker(env.DOCKER_SOCKET);
// The CPUs of the machine the containers run on (Docker's own count, not this container's).
const hostCpus = await engine
  .json<{ NCPU?: number }>('GET', '/info')
  .then((info) => info.NCPU || availableParallelism())
  .catch(() => availableParallelism());
const bakeParallel = bakeSlots(hostCpus, env.ATS_BAKE_CPUS, env.ATS_BAKE_PARALLEL);

const sandboxes = createSandboxes(engine, {
  instance,
  image: env.ATS_WORKBENCH_IMAGE,
  sandboxNetwork: env.ATS_SANDBOX_NETWORK ?? `${instance}_sandbox`,
  egressUrl: env.ATS_EGRESS_URL,
  egressContainer,
  ...(env.EGRESS_SECRET ? { egressSecret: env.EGRESS_SECRET } : {}),
  runtime: env.ATS_SANDBOX_RUNTIME,
  cpus: env.ATS_SANDBOX_CPUS,
  memoryMb: env.ATS_SANDBOX_MEMORY_MB,
  pids: env.ATS_SANDBOX_PIDS,
  bakeCpus: env.ATS_BAKE_CPUS,
  bakeParallel,
  checkCpus: checkCpus(hostCpus, env.ATS_CHECK_CPUS),
  // API-key mode: separate, and off unless the server's owner sets ATS_API_KEY_MODE=on (with the
  // keys) in api-keys.env, which only this service reads. See docs/self-hosting.md.
  apiKeys:
    env.ATS_API_KEY_MODE === 'on'
      ? {
          ...(env.ANTHROPIC_API_KEY ? { claude: env.ANTHROPIC_API_KEY } : {}),
          ...(env.OPENAI_API_KEY ? { codex: env.OPENAI_API_KEY } : {}),
        }
      : {},
});
const server = createSupervisorServer(sandboxes, {
  secret: env.SUPERVISOR_SECRET,
  egressContainer,
});
const port = env.ATS_PORT_SUPERVISOR;
server.listen(port, env.HOST, () =>
  log.info(
    {
      started: true,
      port,
      instance,
      bakes: { parallel: bakeParallel, cpus: env.ATS_BAKE_CPUS },
      checks: { cpus: checkCpus(hostCpus, env.ATS_CHECK_CPUS) },
    },
    'supervisor started',
  ),
);
// Stopping never waits on open terminals or kept-alive connections (sandboxes carry on without us).
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
