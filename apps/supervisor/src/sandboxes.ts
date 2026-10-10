/**
 * Every container the supervisor can run, built only from the fixed templates in
 * `sandboxes/containers.ts`, with one part per role: publish checks (`jobs.ts`), lighting bakes
 * (`bake.ts`), workspaces (`workspace.ts`), previews (`preview.ts`), connect containers
 * (`connect.ts`) and terminals (`terminal.ts`).
 */
import { unpackTar as unpack } from '@ats/shared';
import type { Docker } from './docker.ts';
import { createBakes } from './sandboxes/bake.ts';
import { createConnect } from './sandboxes/connect.ts';
import { type Config, createContainers, LABEL, ROLE } from './sandboxes/containers.ts';
import { createJobs } from './sandboxes/jobs.ts';
import { createPreview } from './sandboxes/preview.ts';
import { createTerminal } from './sandboxes/terminal.ts';
import { createWorkspace } from './sandboxes/workspace.ts';

export { type Config, LABEL };

export function createSandboxes(docker: Docker, cfg: Config) {
  const ctx = createContainers(docker, cfg);
  const { volumes, sandboxName, previewName, connectName } = ctx;

  return {
    volumes,
    ...createJobs(ctx),
    ...createBakes(ctx),
    names: { sandbox: sandboxName, preview: previewName, connect: connectName },
    ...createWorkspace(ctx),
    ...createPreview(ctx),
    ...createConnect(ctx),
    ...createTerminal(ctx),

    /** Our containers still running, for clean-up and timeouts. */
    async list(role?: string) {
      const filters = { label: [`${LABEL}=${cfg.instance}`, ...(role ? [`${ROLE}=${role}`] : [])] };
      return docker.json<{ Names: string[]; State: string; Labels: Record<string, string> }[]>(
        'GET',
        `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`,
      );
    },
    unpack,
  };
}

export type Sandboxes = ReturnType<typeof createSandboxes>;
