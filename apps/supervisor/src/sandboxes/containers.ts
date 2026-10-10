/**
 * Every container the supervisor can run, built only from fixed templates. Nothing a caller sends
 * can change an image, a mount, a network, a capability or a limit: callers only choose *which*
 * workspace or Architect, by id.
 *
 * Mount policy (docs/security.md):
 * - An Architect's AI assistant sign-in (credential volume) is mounted only into that Architect's
 *   own sandbox or connect container, and only for the assistant being used. Never into previews,
 *   helpers or build steps, and never read by the supervisor.
 * - A workspace volume is mounted only into its own sandbox (read-write), its own preview
 *   (read-only), its reader (read-only) and short-lived helpers that write or archive it. The
 *   supervisor reads and writes a workspace's files only there, never in its sandbox (C4).
 * - A workspace's conversations with its assistant are its own too (see CONVERSATIONS), mounted
 *   only into its own sandbox.
 */
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { type Provider, VENDOR_CLIS } from '@ats/shared';
import { type Docker, DockerError, demux } from '../docker.ts';

export interface Config {
  /** Names and labels everything this supervisor creates (e.g. `ats` or `ats-dev`). */
  instance: string;
  image: string;
  /** The internal network whose only way out is the egress proxy. */
  sandboxNetwork: string;
  egressUrl: string;
  /** The egress proxy's container, so sandboxes can be told its address on sandboxNetwork. */
  egressContainer: string;
  /**
   * Shared with the egress proxy only: signs the pass of a workspace whose group allows the
   * whole internet. Without it, every workspace has the allow-list.
   */
  egressSecret?: string;
  /** `runsc` (gVisor) in production; `runc` on a development machine. */
  runtime: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  /** CPUs for each lighting bake job (ATS_BAKE_CPUS). */
  bakeCpus: number;
  /** CPUs for the step of checking a creation that builds and plays it (see checkCpus). */
  checkCpus: number;
  /** Lighting bake jobs at once, across every build (ATS_BAKE_PARALLEL, see bakeSlots). */
  bakeParallel: number;
  /**
   * API-key mode (off unless whoever runs the server turns it on, in a file only this service
   * reads): the server's own key per assistant, given to its sandboxes instead of a sign-in.
   */
  apiKeys?: Partial<Record<Provider, string>>;
}

/**
 * How many lighting bakes may run at once: ATS_BAKE_PARALLEL, or as many as the host's CPUs hold
 * at ATS_BAKE_CPUS each (at least one).
 */
export function bakeSlots(hostCpus: number, bakeCpus: number, parallel?: number) {
  return parallel ?? Math.max(1, Math.floor(hostCpus / bakeCpus));
}

/**
 * CPUs for playing a creation in the checks (ATS_CHECK_CPUS): 4 unless set, never more than the
 * host has (Docker refuses a limit above that). The browser there has no graphics card, so it
 * draws on the CPU, and with the Studio's 2 a 3D creation that's smooth on any phone can look
 * frozen while its shaders are made.
 */
export function checkCpus(hostCpus: number, setting?: number) {
  return Math.min(setting ?? 4, hostCpus);
}

export const LABEL = 'io.allthespaces.instance';
export const ROLE = 'io.allthespaces.role';
export const HOME = '/home/architect';
/** The folders the supervisor's own commands look in: all on the read-only root. */
export const SYSTEM_PATH = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/**
 * The PATH of a container with the Architect's tools volume (a sandbox, a connect container):
 * the system's programs first, the tools volume's last. That volume is shared by all of the
 * Architect's containers (read-only in sandboxes, written where they install), so a program put
 * there under a system program's name (`ls`, `git`) by an installer or an assistant never runs
 * in its place. The assistants, which are only there, are still found.
 */
export const TOOLS_PATH = `${SYSTEM_PATH}:${HOME}/.local/bin`;

/**
 * The folders each assistant keeps its conversations in, inside its sign-in folder: what carrying
 * on picks up, and what it remembers of a project (Claude Code's transcripts and memory, Codex's
 * sessions and memories). Every workspace is at /workspace, so to the assistant they'd all be one
 * project: with the sign-in folder shared, carrying on in one workspace could pick up another's
 * conversation. So each workspace has its own volume over each of these, and its sandbox keeps
 * Codex's state databases (its index of conversations) there too (CODEX_SQLITE_HOME). The sign-in
 * itself stays shared.
 */
export const CONVERSATIONS: Record<Provider, string[]> = {
  claude: ['projects'],
  codex: ['sessions', 'memories'],
};
export const CODEX_SQLITE_HOME = `CODEX_SQLITE_HOME=${HOME}/.codex/sessions/.state`;

/**
 * The longest any one request waits on a job's container (a check step, a room's bake) before
 * answering "still going": the server asks again. Node's fetch gives up on a reply whose headers
 * take five minutes, and long-held requests don't survive proxies well either.
 */
export const HOLD_MS = 50_000;
/** A workspace's reader is put away after this long unused, and replaced after this long in use. */
const READER_IDLE_MS = 60_000;
const READER_MAX_MS = 30 * 60_000;

/**
 * Waits up to HOLD_MS for a job's container to end: null while it's still going, otherwise its
 * exit code and the last lines it printed.
 */
export async function endedWithin(docker: Docker, container: string, tail: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    docker.json<{ StatusCode: number }>('POST', `/containers/${container}/wait`),
    new Promise<null>((r) => {
      timer = setTimeout(() => r(null), HOLD_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!waited) return null;
  const logs = await docker.raw(
    'GET',
    `/containers/${container}/logs?stdout=1&stderr=1&tail=${tail}`,
  );
  const chunks: Buffer[] = [];
  for await (const c of logs) chunks.push(c as Buffer);
  const { stdout, stderr } = await demux(
    (async function* () {
      yield Buffer.concat(chunks);
    })(),
  );
  return { code: waited.StatusCode, stdout, stderr };
}

export const id = (value: unknown, what: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new Error(`Bad ${what}`);
  return value;
};
export const provider = (value: unknown): Provider => {
  if (value !== 'claude' && value !== 'codex') throw new Error('Bad provider');
  return value;
};

/** The fixed templates and helpers every part of the supervisor makes its containers from. */
export function createContainers(docker: Docker, cfg: Config) {
  const name = (...parts: string[]) => `${cfg.instance}-${parts.join('-')}`;
  const volumes = {
    workspace: (ws: string) => name('ws', id(ws, 'workspace')),
    tools: (architect: string) => name('tools', id(architect, 'architect')),
    credentials: (architect: string, p: Provider) => name('cred', id(architect, 'architect'), p),
    /** A workspace's own caches (its packages' store): kept on disk, removed with it. */
    cache: (ws: string) => name('cache', id(ws, 'workspace')),
    /** A workspace's own conversations with an assistant, one per folder (CONVERSATIONS). */
    conversation: (ws: string, p: Provider, folder: string) =>
      name('chat', id(ws, 'workspace'), p, folder),
  };
  const credentialPath = (p: Provider) =>
    p === 'claude' ? `${HOME}/.claude-config` : `${HOME}/.codex`;

  async function ensureVolume(volume: string, role: string) {
    try {
      await docker.json('GET', `/volumes/${volume}`);
    } catch (err) {
      if (!(err instanceof DockerError) || err.status !== 404) throw err;
      await docker.json('POST', '/volumes/create', {
        Name: volume,
        Labels: { [LABEL]: cfg.instance, [ROLE]: role },
      });
    }
  }

  /**
   * Containers with no network use NetworkMode 'none' alone: their own loopback only, nothing
   * outside. Not NetworkDisabled as well: under gVisor that takes away the loopback too, and the
   * checks and previews serve the creation to their browser on it.
   */
  const hardened = (extra: Record<string, unknown>) => ({
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    PidsLimit: cfg.pids,
    Memory: cfg.memoryMb * 1024 * 1024,
    MemorySwap: cfg.memoryMb * 1024 * 1024,
    NanoCpus: Math.round(cfg.cpus * 1e9),
    Runtime: cfg.runtime,
    ShmSize: 256 * 1024 * 1024,
    // Logs are capped (Docker keeps them forever otherwise), like the services' in compose.yml.
    LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
    // Programs may run from /tmp and the home folder here (installers do): these containers exist
    // to run the Architect's assistant. Previews and helpers override this with no-exec mounts.
    Tmpfs: {
      '/tmp': 'rw,exec,nosuid,nodev,size=2g',
      [HOME]: 'rw,exec,nosuid,nodev,uid=2000,gid=2000,size=1g',
    },
    ...extra,
  });

  const proxyEnvFor = (url: string) => [
    `HTTPS_PROXY=${url}`,
    `HTTP_PROXY=${url}`,
    `https_proxy=${url}`,
    `http_proxy=${url}`,
    'NO_PROXY=',
  ];
  const proxyEnv = proxyEnvFor(cfg.egressUrl);
  /** The proxy, with this workspace's pass for the whole internet (as the egress proxy checks it). */
  const openProxy = (ws: string, secret: string) => {
    const url = new URL(cfg.egressUrl);
    url.username = `ws-${ws}`;
    url.password = createHmac('sha256', secret).update(`open:${ws}`).digest('hex');
    return url.toString().replace(/\/$/, '');
  };

  /**
   * The egress proxy's address, for a container on sandboxNetwork's own hosts file. Under gVisor a
   * container can't reach Docker's built-in name server, so the proxy's name wouldn't resolve (and
   * these containers have no other DNS on purpose). Looked up each time: it changes on a restart.
   */
  async function egressHosts(): Promise<string[]> {
    const host = new URL(cfg.egressUrl).hostname;
    if (isIP(host)) return [];
    const c = await docker.json<{
      NetworkSettings: { Networks: Record<string, { IPAddress?: string }> };
    }>('GET', `/containers/${cfg.egressContainer}/json`);
    const ip = c.NetworkSettings.Networks[cfg.sandboxNetwork]?.IPAddress;
    if (!ip) throw new Error(`The egress proxy isn't on ${cfg.sandboxNetwork}`);
    return [`${host}:${ip}`];
  }

  /** Creates (if needed) and starts a container; returns its id. */
  async function run(containerName: string, spec: Record<string, unknown>, role: string) {
    try {
      const existing = await docker.json<{
        Id: string;
        State: { Running: boolean };
        Config: { Labels: Record<string, string> };
      }>('GET', `/containers/${containerName}/json`);
      if (existing.Config.Labels[LABEL] !== cfg.instance) throw new Error('Not ours');
      if (!existing.State.Running) await docker.json('POST', `/containers/${existing.Id}/start`);
      return existing.Id;
    } catch (err) {
      if (!(err instanceof DockerError) || err.status !== 404) throw err;
    }
    const created = await docker.json<{ Id: string }>(
      'POST',
      `/containers/create?name=${containerName}`,
      {
        Image: cfg.image,
        User: '2000:2000',
        Labels: { [LABEL]: cfg.instance, [ROLE]: role },
        ...spec,
      },
    );
    await docker.json('POST', `/containers/${created.Id}/start`);
    return created.Id;
  }

  /** Stops and removes a container of ours (its volumes stay). */
  /**
   * Removes a container this supervisor made. Asked twice (a request retried after a network blip,
   * say), the second waits for the first to finish: either way it's gone, which is what was asked.
   */
  async function remove(containerName: string) {
    try {
      const c = await docker.json<{ Id: string; Config: { Labels: Record<string, string> } }>(
        'GET',
        `/containers/${containerName}/json`,
      );
      if (c.Config.Labels[LABEL] !== cfg.instance) return;
      await docker.json('DELETE', `/containers/${c.Id}?force=true`);
    } catch (err) {
      if (!(err instanceof DockerError)) throw err;
      if (err.status === 404) return;
      if (err.status !== 409 || !/already in progress/i.test(err.message)) throw err;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          await docker.json('GET', `/containers/${containerName}/json`);
        } catch (e) {
          if (e instanceof DockerError && e.status === 404) return;
          throw e;
        }
      }
      throw new Error('The workspace is still being put to sleep. Try again in a moment.');
    }
  }

  async function status(containerName: string) {
    try {
      const c = await docker.json<{
        State: { Running: boolean; StartedAt: string };
        Config: { Labels: Record<string, string> };
      }>('GET', `/containers/${containerName}/json`);
      if (c.Config.Labels[LABEL] !== cfg.instance) return { running: false as const };
      return { running: c.State.Running, startedAt: c.State.StartedAt };
    } catch (err) {
      if (err instanceof DockerError && err.status === 404) return { running: false as const };
      throw err;
    }
  }

  /**
   * Runs a fixed command in one of our containers and collects its output. Its programs come
   * from the read-only root, never from a folder the container can write: the image's PATH puts
   * the Architect's ~/.local/bin first (for the assistants), where anything running in a sandbox
   * could leave a `sh` or a `sha256sum` of its own (a false checksum would defeat C2). So a bare
   * program name is run from /usr/bin, and everything it runs in turn finds only system folders.
   */
  async function exec(
    containerName: string,
    cmd: string[],
    opts: { env?: string[]; stdin?: Buffer; limit?: number } = {},
  ) {
    const [program = '', ...args] = cmd;
    const e = await docker.json<{ Id: string }>('POST', `/containers/${containerName}/exec`, {
      Cmd: [program.includes('/') ? program : `/usr/bin/${program}`, ...args],
      Env: [SYSTEM_PATH, ...(opts.env ?? []).filter((v) => !v.startsWith('PATH='))],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: Boolean(opts.stdin),
      Tty: false,
    });
    const stream = await docker.hijack(`/exec/${e.Id}/start`, { Detach: false, Tty: false });
    if (opts.stdin) {
      stream.write(opts.stdin);
      (stream as unknown as { end(): void }).end();
    }
    const out = await demux(stream as unknown as AsyncIterable<Buffer>, opts.limit);
    const info = await docker.json<{ ExitCode: number }>('GET', `/exec/${e.Id}/json`);
    return { code: info.ExitCode, ...out };
  }

  /** A short-lived container with no network, for writing or reading one workspace. */
  async function withHelper<T>(
    ws: string,
    writable: boolean,
    fn: (container: string) => Promise<T>,
    volume: { name: string; target: string; role: string } = {
      name: volumes.workspace(ws),
      target: '/workspace',
      role: 'workspace',
    },
  ) {
    const helper = name('helper', id(ws, 'workspace'), Math.random().toString(36).slice(2, 8));
    await ensureVolume(volume.name, volume.role);
    await run(
      helper,
      {
        Cmd: ['sleep', '600'],
        HostConfig: hardened({
          NetworkMode: 'none',
          Tmpfs: {
            '/tmp': 'rw,noexec,nosuid,nodev,size=256m',
            [HOME]: 'rw,noexec,nosuid,nodev,uid=2000,gid=2000,size=16m',
          },
          Mounts: [
            {
              Type: 'volume',
              Source: volume.name,
              Target: volume.target,
              ReadOnly: !writable,
            },
          ],
        }),
      },
      'helper',
    );
    try {
      return await fn(helper);
    } finally {
      await remove(helper);
    }
  }

  /**
   * Reads a workspace in a container with that workspace mounted read-only and nothing else (no
   * network, no sign-in), never in its sandbox: whatever runs there is the assistant's, and the
   * sandbox has the Architect's sign-in mounted. The Studio reads every few seconds (the plan,
   * each picture) and a new container takes a second, so a reader is kept until it's idle.
   */
  async function withReader<T>(ws: string, fn: (container: string) => Promise<T>) {
    const container = readerName(ws);
    await closing.get(ws);
    let r = readers.get(ws);
    if (r && !r.busy && Date.now() - r.since > READER_MAX_MS) {
      await putAway(ws);
      r = readers.get(ws);
    }
    if (!r) {
      const ready = ensureVolume(volumes.workspace(ws), 'workspace').then(() =>
        run(
          container,
          {
            // Ends by itself (and is removed) if the supervisor stops before it's put away.
            Cmd: ['sleep', String((2 * READER_MAX_MS) / 1000)],
            HostConfig: hardened({
              NetworkMode: 'none',
              AutoRemove: true,
              Tmpfs: {
                '/tmp': 'rw,noexec,nosuid,nodev,size=16m',
                [HOME]: 'rw,noexec,nosuid,nodev,uid=2000,gid=2000,size=16m',
              },
              Mounts: [
                {
                  Type: 'volume',
                  Source: volumes.workspace(ws),
                  Target: '/workspace',
                  ReadOnly: true,
                },
              ],
            }),
          },
          'reader',
        ),
      );
      r = { ready, busy: 0, since: Date.now() };
      readers.set(ws, r);
    }
    const reader = r;
    clearTimeout(reader.idle);
    reader.busy++;
    try {
      await reader.ready;
      return await fn(container);
    } catch (err) {
      // Gone (or never started): the next read starts another.
      if (readers.get(ws) === reader) readers.delete(ws);
      throw err;
    } finally {
      reader.busy--;
      if (!reader.busy && readers.get(ws) === reader)
        reader.idle = setTimeout(() => {
          if (!reader.busy && readers.get(ws) === reader) putAway(ws).catch(() => {});
        }, READER_IDLE_MS).unref();
    }
  }
  /**
   * Puts away a workspace's reader (before its volume is removed, say). Reads meanwhile wait, so
   * none finds the old one just as it goes.
   */
  async function putAway(ws: string) {
    clearTimeout(readers.get(ws)?.idle);
    readers.delete(ws);
    const done = (closing.get(ws) ?? Promise.resolve()).then(() => remove(readerName(ws)));
    // Those waiting only wait: whether it went is for the one who asked.
    const waited: Promise<void> = done
      .catch(() => {})
      .finally(() => {
        if (closing.get(ws) === waited) closing.delete(ws);
      });
    closing.set(ws, waited);
    await done;
  }
  const readers = new Map<
    string,
    { ready: Promise<unknown>; busy: number; since: number; idle?: NodeJS.Timeout }
  >();
  const closing = new Map<string, Promise<void>>();

  const sandboxName = (ws: string) => name('sandbox', id(ws, 'workspace'));
  const readerName = (ws: string) => name('reader', id(ws, 'workspace'));
  const previewName = (ws: string) => name('preview', id(ws, 'workspace'));
  const connectName = (architect: string, p: Provider) =>
    name('connect', id(architect, 'architect'), p);

  /**
   * The binary's real file and its SHA-256, computed by the image's own tools. Only a program in
   * the tools volume counts: anywhere else (an older Codex install, in its sign-in volume) a
   * workspace could change it between its check and its start, so it reads as not installed.
   */
  async function binaryHash(container: string, p: Provider) {
    const r = await exec(container, [
      'sh',
      '-c',
      `f="$(readlink -f "$HOME/${VENDOR_CLIS[p].binary}")" && [ -f "$f" ] && case "$f" in "$HOME"/.local/*) ;; *) exit 1;; esac && sha256sum "$f" | cut -d" " -f1`,
    ]);
    const sha = r.stdout.toString().trim();
    return r.code === 0 && /^[a-f0-9]{64}$/.test(sha) ? sha : null;
  }

  /**
   * An Architect's own volumes: their tools (the assistants as installed) and the assistant's
   * sign-in. Only where they install (the connect container) can the tools be written: in a
   * sandbox they're read-only, so nothing there can change the assistant between its check and
   * its start (C2), plant a program under a system program's name, or alter what another of
   * their workspaces runs.
   */
  const personal = (architect: string, p: Provider, tools: 'install' | 'use' = 'use') => [
    {
      Type: 'volume',
      Source: volumes.tools(architect),
      Target: `${HOME}/.local`,
      ReadOnly: tools !== 'install',
    },
    { Type: 'volume', Source: volumes.credentials(architect, p), Target: credentialPath(p) },
  ];

  /**
   * A workspace's own conversations, over the folders where its assistant would otherwise share
   * them with the Architect's other workspaces (CONVERSATIONS). Volumes are made from the image's
   * empty folders there, which gives them to the sandbox user.
   */
  const conversations = (ws: string, p: Provider) =>
    CONVERSATIONS[p].map((folder) => ({
      Type: 'volume',
      Source: volumes.conversation(ws, p, folder),
      Target: `${credentialPath(p)}/${folder}`,
    }));

  return {
    docker,
    cfg,
    name,
    volumes,
    ensureVolume,
    hardened,
    proxyEnvFor,
    proxyEnv,
    openProxy,
    egressHosts,
    run,
    remove,
    status,
    exec,
    withHelper,
    withReader,
    putAwayReader: putAway,
    sandboxName,
    previewName,
    connectName,
    binaryHash,
    personal,
    conversations,
  };
}

export type Containers = ReturnType<typeof createContainers>;
