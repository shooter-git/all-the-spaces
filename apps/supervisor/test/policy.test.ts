/**
 * The supervisor's mount and network policy (docs/compliance.md, C2 and C4), checked against a
 * fake Docker that records every container it's asked to create.
 */
import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Docker } from '../src/docker.ts';
import { checkCpus } from '../src/sandboxes/containers.ts';
import { type Config, createSandboxes, LABEL } from '../src/sandboxes.ts';

interface Spec {
  Env?: string[];
  Cmd?: string[];
  User?: string;
  Labels: Record<string, string>;
  NetworkDisabled?: boolean;
  HostConfig: {
    Mounts: { Source: string; Target: string; ReadOnly?: boolean }[];
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    CapDrop: string[];
    SecurityOpt: string[];
    Runtime: string;
    Dns?: string[];
    ExtraHosts?: string[];
    Memory?: number;
    NanoCpus?: number;
  };
}

/** The workbench image's PATH: the Architect's own tools first, for the assistants. */
const IMAGE_PATH =
  'PATH=/home/architect/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** A fake Docker: containers are created and started in memory; execs answer from `answers`. */
function fakeDocker(
  answers: {
    sha?: string;
    signedIn?: boolean;
    foreign?: string[];
    pane?: string;
    changes?: string;
    /** What a file shown to the Architect holds, and how its read ends (exit code). */
    view?: { out: string; code: number };
    /** How a no-follow read or write of a workspace file ends, and what it prints. */
    io?: { out: string; code: number };
  } = {},
) {
  const created = new Map<string, Spec>();
  const removed: string[] = [];
  /** Containers created and not removed since; volumes likewise, and the volumes removed. */
  const live = new Set<string>();
  const volumes = new Set<string>();
  const droppedVolumes: string[] = [];
  const frame = (stream: 1 | 2, text: string) => {
    const payload = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(payload.length, 4);
    return Buffer.concat([head, payload]);
  };
  let lastExec: string[] = [];
  /** Every command run in a container, in order, and the container each ran in. */
  const execs: string[][] = [];
  const execsIn: string[] = [];
  /** The environment each command was given. */
  const execEnvs: string[][] = [];
  const docker: Docker = {
    async json<T>(method: string, path: string, body?: unknown) {
      const container = /^\/containers\/([^/?]+)\/json$/.exec(path)?.[1];
      if (method === 'GET' && container === 'test-egress-1')
        return {
          Id: container,
          NetworkSettings: { Networks: { test_sandbox: { IPAddress: '172.30.0.2' } } },
        } as T;
      if (method === 'GET' && container) {
        if (answers.foreign?.includes(container))
          return { Id: container, State: { Running: true }, Config: { Labels: {} } } as T;
        const spec = live.has(container) ? created.get(container) : undefined;
        if (!spec)
          throw Object.assign(new Error('No such container'), { status: 404, name: 'DockerError' });
        return {
          Id: container,
          State: { Running: true, StartedAt: new Date().toISOString() },
          // As Docker reports it: the image's environment (its PATH) with the container's own.
          Config: { Labels: spec.Labels, Env: [IMAGE_PATH, ...(spec.Env ?? [])] },
          NetworkSettings: { Networks: {} },
        } as T;
      }
      const create = /^\/containers\/create\?name=(.+)$/.exec(path);
      if (method === 'POST' && create) {
        created.set(create[1] as string, body as Spec);
        live.add(create[1] as string);
        return { Id: create[1] } as T;
      }
      if (method === 'DELETE' && path.startsWith('/containers/')) {
        const name = path.split('/')[2]?.split('?')[0] as string;
        removed.push(name);
        live.delete(name);
        return undefined as T;
      }
      // Lists: every container still here counts as running (filtered by label and name).
      const list = /^\/(containers\/json|volumes)\?.*filters=([^&]+)/.exec(path);
      if (method === 'GET' && list) {
        const filters = JSON.parse(decodeURIComponent(list[2] as string)) as {
          label?: string[];
          name?: string[];
        };
        const named = (n: string) => (filters.name ?? []).every((f) => n.includes(f));
        if (list[1] === 'volumes')
          return { Volumes: [...volumes].filter(named).map((Name) => ({ Name })) } as T;
        return [...live]
          .filter((n) => {
            const labels = created.get(n)?.Labels ?? {};
            return (
              named(n) &&
              (filters.label ?? []).every((l) => {
                const [k, v] = l.split('=');
                return labels[k as string] === v;
              })
            );
          })
          .map((n) => ({ Names: [`/${n}`] })) as T;
      }
      if (method === 'POST' && path === '/volumes/create') {
        volumes.add((body as { Name: string }).Name);
        return {} as T;
      }
      if (method === 'DELETE' && path.startsWith('/volumes/')) {
        const name = path.slice('/volumes/'.length);
        volumes.delete(name);
        droppedVolumes.push(name);
        return undefined as T;
      }
      if (method === 'POST' && /\/exec$/.test(path)) {
        lastExec = (body as { Cmd: string[] }).Cmd;
        execs.push(lastExec);
        execsIn.push(path.split('/')[2] as string);
        execEnvs.push((body as { Env?: string[] }).Env ?? []);
        return { Id: 'exec' } as T;
      }
      if (method === 'GET' && path === '/exec/exec/json') {
        const cmd = lastExec.join(' ');
        const code = cmd.startsWith('/usr/bin/test -s')
          ? answers.signedIn
            ? 0
            : 1
          : cmd.includes('sha256sum') && !answers.sha
            ? 1
            : cmd.includes('realpath') && answers.view
              ? answers.view.code
              : cmd.startsWith('/usr/bin/python3') && answers.io
                ? answers.io.code
                : 0;
        return { ExitCode: code } as T;
      }
      if (method === 'GET' && path.startsWith('/volumes/')) {
        if (volumes.has(path.slice('/volumes/'.length))) return {} as T;
        throw Object.assign(new Error('No such volume'), { status: 404 });
      }
      return {} as T;
    },
    async raw() {
      throw new Error('not used');
    },
    async hijack() {
      const cmd = lastExec.join(' ');
      // Takes whatever is written to it (an exec's stdin), and answers with the command's output.
      const s = new Duplex({
        read() {},
        write(_chunk, _encoding, done) {
          done();
        },
      });
      s.push(
        cmd.includes('sha256sum') && answers.sha
          ? frame(1, `${answers.sha}\n`)
          : cmd.includes('display-message') && answers.pane
            ? frame(1, `${answers.pane}\n`)
            : cmd.includes('rev-list') && answers.changes
              ? frame(1, answers.changes)
              : cmd.includes('realpath') && answers.view
                ? frame(1, answers.view.out)
                : cmd.startsWith('/usr/bin/python3') && answers.io
                  ? frame(1, answers.io.out)
                  : Buffer.alloc(0),
      );
      s.push(null);
      return s;
    },
  };
  // DockerError checks use instanceof: make the 404 above look like one.
  return { docker, created, removed, execs, execsIn, execEnvs, live, volumes, droppedVolumes };
}

const config = {
  instance: 'test',
  image: 'ats-workbench:test',
  sandboxNetwork: 'test_sandbox',
  egressUrl: 'http://egress:3128',
  egressContainer: 'test-egress-1',
  runtime: 'runsc',
  cpus: 2,
  memoryMb: 2048,
  pids: 512,
  bakeCpus: 3,
  bakeParallel: 2,
  checkCpus: 4,
};

const mounts = (spec: Spec | undefined) =>
  (spec?.HostConfig.Mounts ?? [])
    .map((m) => `${m.Source}->${m.Target}${m.ReadOnly ? ' (ro)' : ''}`)
    .sort();

describe("the supervisor's container policy", async () => {
  // The fake's 404 must be a DockerError for the code paths that create things.
  const { DockerError } = await import('../src/docker.ts');
  const make = (answers?: Parameters<typeof fakeDocker>[0], extra: Partial<Config> = {}) => {
    const f = fakeDocker(answers);
    const json = f.docker.json;
    f.docker.json = async (method, path, body) => {
      try {
        return await json(method, path, body);
      } catch (err) {
        if ((err as { status?: number }).status === 404)
          throw new DockerError('No such container', 404);
        throw err;
      }
    };
    return { ...f, s: createSandboxes(f.docker, { ...config, ...extra }) };
  };

  it("gives sandboxes the server's own API key only in API-key mode, and only for that assistant", async () => {
    const off = make();
    await off.s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    expect((off.created.get('test-sandbox-w1')?.Env ?? []).some((e) => e.includes('API_KEY'))).toBe(
      false,
    );
    expect(off.s.apiKeys()).toEqual({ claude: false, codex: false });

    const on = make(undefined, { apiKeys: { claude: 'sk-test-claude' } });
    await on.s.startSandbox({
      ws: 'w2',
      architect: 'alice',
      provider: 'claude',
      // A caller still can't set (or replace) a key.
      env: { ANTHROPIC_API_KEY: 'sk-from-a-caller' },
    });
    await on.s.startSandbox({ ws: 'w3', architect: 'bob', provider: 'codex' });
    const claudeEnv = on.created.get('test-sandbox-w2')?.Env ?? [];
    expect(claudeEnv.filter((e) => e.startsWith('ANTHROPIC_API_KEY='))).toEqual([
      'ANTHROPIC_API_KEY=sk-test-claude',
    ]);
    expect((on.created.get('test-sandbox-w3')?.Env ?? []).some((e) => e.includes('API_KEY'))).toBe(
      false,
    );
    expect(on.s.apiKeys()).toEqual({ claude: true, codex: false });
  });

  it("mounts an Architect's sign-in only into their own sandbox, for the assistant in use", async () => {
    const { s, created } = make();
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    await s.startSandbox({ ws: 'w2', architect: 'bob', provider: 'codex' });
    expect(mounts(created.get('test-sandbox-w1'))).toEqual([
      'test-cache-w1->/home/architect/.cache',
      'test-chat-w1-claude-projects->/home/architect/.claude-config/projects',
      'test-cred-alice-claude->/home/architect/.claude-config',
      'test-tools-alice->/home/architect/.local (ro)',
      'test-ws-w1->/workspace',
    ]);
    expect(mounts(created.get('test-sandbox-w2'))).toEqual([
      'test-cache-w2->/home/architect/.cache',
      'test-chat-w2-codex-memories->/home/architect/.codex/memories',
      'test-chat-w2-codex-sessions->/home/architect/.codex/sessions',
      'test-cred-bob-codex->/home/architect/.codex',
      'test-tools-bob->/home/architect/.local (ro)',
      'test-ws-w2->/workspace',
    ]);
  });

  it('saves a checkpoint when a workspace goes to sleep, where nothing else runs (C4)', async () => {
    const { s, created, execs, execsIn, removed, live } = make();
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    // The assistant commits its own checkpoints as it goes (its instructions ask it to), as itself.
    expect(created.get('test-sandbox-w1')?.Env).toEqual(
      expect.arrayContaining([
        'GIT_AUTHOR_NAME=Claude Code',
        'GIT_AUTHOR_EMAIL=claude@workspace.local',
        'GIT_COMMITTER_NAME=Claude Code',
        'GIT_COMMITTER_EMAIL=claude@workspace.local',
      ]),
    );
    execs.length = 0;
    execsIn.length = 0;
    removed.length = 0;
    expect(await s.stopSandbox('w1')).toEqual({ checkpoint: 'saved' });
    // What it didn't commit is committed once its sandbox is gone, so nothing is half-way through
    // a change, in a helper with the workspace and nothing else, which is then put away.
    expect(removed[0]).toBe('test-sandbox-w1');
    const at = execs.findIndex((c) => c.join(' ').includes('core.hooksPath'));
    const helper = execsIn[at] as string;
    expect(helper).toMatch(/^test-helper-w1-/);
    expect(removed.indexOf(helper)).toBeGreaterThan(0);
    expect(live.has(helper)).toBe(false);
    const spec = created.get(helper);
    expect(spec?.HostConfig.NetworkMode).toBe('none');
    expect(spec?.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'test-ws-w1', Target: '/workspace', ReadOnly: false },
    ]);
    // As the Studio, without running the workspace's own git hooks, and never the place's floor
    // plans and photos, or the Architect's uploads.
    const [program, , script, , message] = execs[at] ?? [];
    expect(program).toBe('/usr/bin/sh');
    expect(script).toContain('git -c core.hooksPath=/dev/null -c core.fsmonitor=false');
    expect(script).toContain("add -A -- . ':(exclude)inputs' ':(exclude)uploads'");
    expect(script).toContain('-c user.name=Studio -c user.email=studio@workspace.local commit');
    expect(message).toBe('Checkpoint: saved when the workspace went to sleep');

    // Put to sleep twice at once (a request retried): both sleep, and both say how it went.
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'codex' });
    expect(created.get('test-sandbox-w1')?.Env).toContain('GIT_AUTHOR_NAME=Codex');
    expect(await Promise.all([s.stopSandbox('w1'), s.stopSandbox('w1')])).toEqual([
      { checkpoint: 'saved' },
      { checkpoint: 'saved' },
    ]);
  });

  it("keeps each workspace's conversations its own, though the sign-in is shared", async () => {
    const { s, created, droppedVolumes } = make();
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    await s.startSandbox({ ws: 'w2', architect: 'alice', provider: 'claude' });
    await s.startSandbox({ ws: 'w3', architect: 'alice', provider: 'codex' });
    // Every workspace is at /workspace, so to the assistant they'd all be one project: carrying on
    // in one could pick up another's conversation, or what it remembered there.
    const at = (name: string, target: string) =>
      created.get(name)?.HostConfig.Mounts.find((m) => m.Target === target)?.Source;
    expect(at('test-sandbox-w1', '/home/architect/.claude-config')).toBe(
      at('test-sandbox-w2', '/home/architect/.claude-config'),
    );
    expect(at('test-sandbox-w1', '/home/architect/.claude-config/projects')).toBe(
      'test-chat-w1-claude-projects',
    );
    expect(at('test-sandbox-w2', '/home/architect/.claude-config/projects')).toBe(
      'test-chat-w2-claude-projects',
    );
    // Codex's index of its conversations goes with them, not into the shared sign-in folder.
    expect(created.get('test-sandbox-w3')?.Env).toContain(
      'CODEX_SQLITE_HOME=/home/architect/.codex/sessions/.state',
    );
    expect(created.get('test-sandbox-w1')?.Env?.some((e) => e.startsWith('CODEX_'))).toBe(false);
    // They go with the workspace, whichever assistant it had.
    await s.deleteWorkspace('w3');
    expect(droppedVolumes).toEqual(
      expect.arrayContaining([
        'test-chat-w3-claude-projects',
        'test-chat-w3-codex-sessions',
        'test-chat-w3-codex-memories',
      ]),
    );
  });

  it("lets only the connect container write the Architect's tools (C2)", async () => {
    const { s, created, droppedVolumes } = make();
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    await s.startConnect('alice', 'claude');
    // A sandbox can't change the assistant it will be started as, plant a program, or alter
    // what another of the Architect's workspaces runs: only installs write there.
    const tools = (name: string) =>
      created.get(name)?.HostConfig.Mounts.find((m) => m.Target === '/home/architect/.local');
    expect(tools('test-sandbox-w1')?.ReadOnly).toBe(true);
    expect(tools('test-connect-alice-claude')?.ReadOnly).toBe(false);
    // What went there goes to the workspace's own cache (its packages, on disk) or its scratch
    // home (the assistant's lock files).
    expect(created.get('test-sandbox-w1')?.Env).toEqual(
      expect.arrayContaining([
        'XDG_STATE_HOME=/home/architect/.state',
        'npm_config_store_dir=/home/architect/.cache/pnpm-store',
      ]),
    );
    // Packages from the old shared store are relinked on start, without stopping to ask.
    expect(created.get('test-sandbox-w1')?.Cmd?.join(' ')).toContain(
      'pnpm install --config.confirm-modules-purge=false',
    );
    // The cache goes with its workspace.
    await s.deleteWorkspace('w1');
    expect(droppedVolumes).toEqual(expect.arrayContaining(['test-ws-w1', 'test-cache-w1']));
  });

  it('seals every container the same way, and uses the configured runtime (gVisor)', async () => {
    const { s, created } = make();
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    await s.startPreview('w1');
    await s.startConnect('alice', 'claude');
    for (const spec of created.values()) {
      expect(spec.User).toBe('2000:2000');
      expect(spec.Labels[LABEL]).toBe('test');
      expect(spec.HostConfig).toMatchObject({
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Runtime: 'runsc',
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
      });
    }
  });

  it('keeps sign-ins out of previews, and gives previews no network and a read-only workspace', async () => {
    const { s, created } = make();
    await s.startPreview('w1');
    const preview = created.get('test-preview-w1');
    expect(mounts(preview)).toEqual(['test-ws-w1->/workspace (ro)']);
    expect(preview?.HostConfig.NetworkMode).toBe('none');
  });

  it('gives the connect container the tools and sign-in, but no workspace', async () => {
    const { s, created } = make();
    await s.startConnect('alice', 'codex');
    expect(mounts(created.get('test-connect-alice-codex'))).toEqual([
      'test-cred-alice-codex->/home/architect/.codex',
      'test-tools-alice->/home/architect/.local',
    ]);
  });

  it('runs publish checks without any sign-in: installing via the proxy, building with no network', async () => {
    const { s, created } = make();
    await s.startStep('job1', 'prepare');
    await s.startStep('job1', 'finish');
    const prepare = created.get('test-step-job1-prepare');
    const finish = created.get('test-step-job1-finish');
    expect(mounts(prepare)).toEqual(['test-job-job1->/job', 'test-pnpm-store->/store']);
    expect(prepare?.HostConfig.NetworkMode).toBe('test_sandbox');
    expect(prepare?.HostConfig.Dns).toEqual(['127.0.0.1']);
    expect(prepare?.HostConfig.ExtraHosts).toEqual(['egress:172.30.0.2']);
    expect(mounts(finish)).toEqual(['test-job-job1->/job']);
    expect(finish?.HostConfig.NetworkMode).toBe('none');
    // 'none' alone: with NetworkDisabled too, gVisor takes away even the container's own
    // loopback, and the check can't serve the creation to its browser.
    expect(finish?.NetworkDisabled).toBeUndefined();
    await s.startPreview('w2');
    expect(created.get('test-preview-w2')?.HostConfig.NetworkMode).toBe('none');
    expect(created.get('test-preview-w2')?.NetworkDisabled).toBeUndefined();
    // Each with its own time limit, kept from inside (even if the supervisor restarts).
    expect(prepare?.Cmd?.slice(0, 5)).toEqual(['timeout', '-k', '30', '10m', 'node']);
    expect(finish?.Cmd?.slice(0, 5)).toEqual(['timeout', '-k', '30', '30m', 'node']);
    // Installing gets the Studio's CPUs; building and playing gets the checks' own.
    expect(prepare?.HostConfig.NanoCpus).toBe(2e9);
    expect(finish?.HostConfig.NanoCpus).toBe(4e9);
  });

  it('gives the checks 4 CPUs unless set, never more than the host has', () => {
    expect(checkCpus(8)).toBe(4);
    expect(checkCpus(2)).toBe(2);
    expect(checkCpus(8, 6)).toBe(6);
    expect(checkCpus(4, 6)).toBe(4);
    expect(checkCpus(8, 1.5)).toBe(1.5);
  });

  it('bakes lighting from a fixed template: read-only inputs, no network, one folder to write', async () => {
    const { s, created } = make();
    await s.bakeInit('bake1', Buffer.from('sky'));
    expect(await s.bakeRoom('bake1', 1, Buffer.from('{"receiver":{}}'))).toEqual({ ok: true });
    const bake = created.get('test-bake-bake1-run-1');
    expect(mounts(bake)).toEqual(['test-bake-bake1->/job (ro)', 'test-bake-bake1-out-1->/out']);
    expect(bake?.HostConfig.NetworkMode).toBe('none');
    expect(bake?.Env ?? []).toEqual([]);
    // Always the space builder's own script, with a time limit: nothing a caller sends is run.
    expect(bake?.Cmd).toEqual([
      'timeout',
      '-k',
      '30',
      '30m',
      'blender',
      '-b',
      '--factory-startup',
      '--python-exit-code',
      '1',
      '--python',
      '/opt/ats/packages/space-builder/blender/bake_room.py',
      '--',
      '/job/room-1.json',
      '/out',
    ]);
    // Sealed like every other container, with the workbench's memory limit and the bakes' own
    // CPU limit (ATS_BAKE_CPUS).
    expect(bake?.User).toBe('2000:2000');
    expect(bake?.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Runtime: 'runsc',
      Memory: 2048 * 1024 * 1024,
      NanoCpus: 3e9,
    });
    // The helpers that fill the input volume have no network either.
    const helpers = [...created.entries()].filter(([n]) => n.startsWith('test-helper-bake1-'));
    expect(helpers.length).toBeGreaterThan(0);
    for (const [, h] of helpers) {
      expect(h.HostConfig.NetworkMode).toBe('none');
      expect(mounts(h)).toEqual(['test-bake-bake1->/job']);
    }
    await expect(s.bakeRoom('../x', 0, Buffer.from('{}'))).rejects.toThrow('Bad job');
    // Only the slots there are (ATS_BAKE_PARALLEL of them).
    for (const slot of [2, -1, 0.5, '0'])
      await expect(s.bakeRoom('bake1', slot, Buffer.from('{}'))).rejects.toThrow('Bad slot');
  });

  it('never runs more bakes at once than it may, however many builds ask', async () => {
    const { s, live } = make(undefined, { bakeParallel: 2 });
    const room = Buffer.from('{}');
    // Three builds ask at the same moment: two start, the third is told to wait.
    const asked = await Promise.all(['a', 'b', 'c'].map((job) => s.bakeRoom(job, 0, room)));
    expect(asked.filter((r) => r.ok)).toHaveLength(2);
    expect(asked.filter((r) => !r.ok)).toEqual([{ ok: false, busy: true }]);
    const running = () => [...live].filter((n) => /-bake-.+-run-\d+$/.test(n));
    expect(running()).toHaveLength(2);
    // A room started again in a slot that's still baking replaces it (it isn't one more).
    const first = ['a', 'b', 'c'][asked.findIndex((r) => r.ok)] as string;
    expect(await s.bakeRoom(first, 0, room)).toEqual({ ok: true });
    expect(running()).toHaveLength(2);
    // Once a build's bakes are gone, the one that waited can start.
    const waited = ['a', 'b', 'c'][asked.findIndex((r) => !r.ok)] as string;
    await s.deleteBake(first);
    expect(await s.bakeRoom(waited, 0, room)).toEqual({ ok: true });
    expect(running()).toHaveLength(2);
  });

  it("clears away every container and volume of a build's bake job, in every slot", async () => {
    const { s, live, volumes, created } = make(undefined, { bakeParallel: 4 });
    await s.bakeInit('bake-1', null);
    for (const slot of [0, 1, 2]) await s.bakeRoom('bake-1', slot, Buffer.from('{}'));
    // Another build's job (whose name starts the same) is left alone.
    await s.bakeInit('bake-1-other', null);
    await s.bakeRoom('bake-1-other', 0, Buffer.from('{}'));
    expect([...live].filter((n) => n.startsWith('test-bake-bake-1-run-'))).toHaveLength(3);
    await s.deleteBake('bake-1');
    expect([...live].filter((n) => n.startsWith('test-bake-'))).toEqual([
      'test-bake-bake-1-other-run-0',
    ]);
    expect([...volumes].filter((v) => v.startsWith('test-bake-')).sort()).toEqual([
      'test-bake-bake-1-other',
      'test-bake-bake-1-other-out-0',
    ]);
    expect(created.has('test-bake-bake-1-run-2')).toBe(true);
  });

  it('sandboxes reach the internet only through the egress proxy, with no DNS of their own', async () => {
    const { s, created } = make();
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    const spec = created.get('test-sandbox-w1');
    expect(spec?.HostConfig.NetworkMode).toBe('test_sandbox');
    expect(spec?.HostConfig.Dns).toEqual(['127.0.0.1']);
    expect(spec?.Env).toContain('HTTPS_PROXY=http://egress:3128');
    // Its address is written in, since gVisor can't reach Docker's own name server.
    expect(spec?.HostConfig.ExtraHosts).toEqual(['egress:172.30.0.2']);
    await s.startConnect('alice', 'codex');
    expect(created.get('test-connect-alice-codex')?.HostConfig.ExtraHosts).toEqual([
      'egress:172.30.0.2',
    ]);
  });

  it('lets callers set only a few plain settings in a sandbox', async () => {
    const { s, created } = make();
    await s.startSandbox({
      ws: 'w1',
      architect: 'alice',
      provider: 'claude',
      env: {
        DISABLE_TELEMETRY: '1',
        LD_PRELOAD: '/evil.so',
        ANTHROPIC_API_KEY: 'x',
        ATS_MODEL: 'bad;rm -rf',
      },
    });
    const env = created.get('test-sandbox-w1')?.Env ?? [];
    expect(env).toContain('DISABLE_TELEMETRY=1');
    expect(
      env.some(
        (e) =>
          e.startsWith('LD_PRELOAD') ||
          e.startsWith('ANTHROPIC_API_KEY') ||
          e.startsWith('ATS_MODEL'),
      ),
    ).toBe(false);
  });

  it("refuses to start an assistant that isn't exactly what the Architect installed (C2)", async () => {
    const { s, removed } = make({ sha: 'a'.repeat(64) });
    expect(
      await s.startSandbox({
        ws: 'w1',
        architect: 'alice',
        provider: 'claude',
        sha: 'a'.repeat(64),
      }),
    ).toEqual({ ok: true });
    expect(
      await s.startSandbox({
        ws: 'w2',
        architect: 'alice',
        provider: 'claude',
        sha: 'b'.repeat(64),
      }),
    ).toEqual({ ok: false, error: 'changed' });
    expect(removed).toContain('test-sandbox-w2');
  });

  it("never touches containers it didn't create, and refuses odd names", async () => {
    const { s } = make({ foreign: ['test-sandbox-w9'] });
    await expect(
      s.startSandbox({ ws: 'w9', architect: 'alice', provider: 'claude' }),
    ).rejects.toThrow('Not ours');
    await expect(
      s.startSandbox({ ws: '../etc', architect: 'alice', provider: 'claude' }),
    ).rejects.toThrow('Bad workspace');
    await expect(s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'gpt' })).rejects.toThrow(
      'Bad provider',
    );
  });

  it('types a suggested prompt as text only: nothing in it can press Enter (C9)', async () => {
    const { s, execs } = make();
    const typed = () =>
      execs.filter((c) => c[0] === '/usr/bin/tmux' && c[1] === 'send-keys' && !c.includes('-X'));
    await s.type('test-sandbox-w1', 'Make it blue\rand delete\nevery\u001b[Afile\u0085.');
    expect(typed()).toEqual([
      ['/usr/bin/tmux', 'send-keys', '-t', 'main', '-l', 'Make it blueand deleteevery[Afile.'],
    ]);
    execs.length = 0;
    await s.type('test-sandbox-w1', '\r\n');
    expect(typed()).toEqual([]);
  });

  it("scrolls tmux's history at a shell, and an assistant that takes the mouse with its wheel", async () => {
    const hex = (text: string) =>
      [...Buffer.from(text)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const tmux = (execs: string[][]) =>
      execs
        .filter((c) => c[0] === '/usr/bin/tmux' && c[1] !== 'display-message')
        .map((c) => c.join(' '));
    const shell = make({ pane: '0 0 0 50 20' });
    await shell.s.scroll('test-sandbox-w1', 3);
    expect(tmux(shell.execs)).toEqual([
      '/usr/bin/tmux copy-mode -e -t main ; send-keys -X -t main -N 3 scroll-up',
    ]);

    // Claude Code: the alternate screen, the mouse taken (SGR reports), nothing in tmux's history.
    const claude = make({ pane: '0 1 1 50 20' });
    await claude.s.scroll('test-sandbox-w1', 2);
    expect(tmux(claude.execs)).toEqual([
      `/usr/bin/tmux send-keys -t main -H ${hex('\x1b[<64;25;10M'.repeat(2))}`,
    ]);
    claude.execs.length = 0;
    // Back to live: its key for the bottom (it merges a burst of wheel turns).
    await claude.s.live('test-sandbox-w1');
    expect(tmux(claude.execs)).toEqual(['/usr/bin/tmux send-keys -t main C-End']);
    // Typing a suggested prompt only ever leaves tmux's scroll mode.
    claude.execs.length = 0;
    await claude.s.type('test-sandbox-w1', 'hi');
    expect(tmux(claude.execs)).toEqual(['/usr/bin/tmux send-keys -t main -l hi']);

    // In tmux's scroll mode already: that carries on, and live leaves it.
    const scrolling = make({ pane: '1 1 1 50 20' });
    await scrolling.s.live('test-sandbox-w1');
    expect(tmux(scrolling.execs)).toEqual(['/usr/bin/tmux send-keys -X -t main cancel']);
  });

  it('lists what the assistant changed by name only, and nothing outside the workspace', async () => {
    const { s, execs } = make({
      changes: [
        'M',
        'src/main.ts',
        'D',
        'src/old.ts',
        'A',
        'staged.ts',
        'M',
        '../etc/passwd',
        '',
        'src/scenes/new.ts',
        'bad\nname',
        '/abs',
        'a//b',
        '',
      ].join('\0'),
    });
    expect(await s.changedFiles('w1')).toEqual({ files: [], more: false }); // asleep
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    execs.length = 0;
    expect(await s.changedFiles('w1')).toEqual({
      files: [
        { path: 'src/main.ts', change: 'changed' },
        { path: 'src/old.ts', change: 'removed' },
        { path: 'src/scenes/new.ts', change: 'added' },
        { path: 'staged.ts', change: 'added' },
      ],
      more: false,
    });
    // One fixed command, reading names (git's), never a file's contents.
    expect(execs).toHaveLength(1);
    expect(execs[0]?.slice(0, 2)).toEqual(['/usr/bin/sh', '-c']);
    expect(execs[0]?.[2]).not.toMatch(/\b(cat|show|blame)\b|diff (?!--name-status)/);
  });

  it("shows a file only from the reader, with the workspace and nothing else, never git's", async () => {
    const { s, execs, execsIn, created } = make({
      view: { out: 'export const a = 1;\n', code: 0 },
    });
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    execs.length = 0;
    execsIn.length = 0;
    expect((await s.viewFile('w1', 'src/main.ts'))?.toString()).toBe('export const a = 1;\n');
    // Read in the reader, not the running sandbox (which also has the assistant's sign-in, C4).
    expect(execsIn).toEqual(['test-reader-w1']);
    const reader = created.get('test-reader-w1');
    expect(reader?.HostConfig.Mounts.map((m) => [m.Target, m.ReadOnly])).toEqual([
      ['/workspace', true],
    ]);
    expect(reader?.HostConfig.NetworkMode).toBe('none');
    // The path is an argument, never part of the command.
    expect(execs[0]?.slice(0, 2)).toEqual(['/usr/bin/sh', '-c']);
    expect(execs[0]?.at(-1)).toBe('src/main.ts');
    expect(execs[0]?.[2]).not.toContain('src/main.ts');

    execs.length = 0;
    for (const path of ['../etc/passwd', '/etc/passwd', '.git/config', '.git', 'a//b', 'x\ny'])
      expect(await s.viewFile('w1', path)).toBeNull();
    expect(execs).toEqual([]);

    const missing = make({ view: { out: '', code: 4 } });
    expect(await missing.s.viewFile('w1', 'gone.ts')).toBeNull();
    const big = make({ view: { out: '9000000', code: 5 } });
    await expect(big.s.viewFile('w1', 'huge.bin')).rejects.toMatchObject({ status: 413 });
  });

  it('reads and writes workspace files without following a link (C4)', async () => {
    const { s, execs, execsIn } = make({ io: { out: '{"rooms":[]}', code: 0 } });
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    execs.length = 0;
    execsIn.length = 0;
    expect((await s.readFile('w1', 'plan.json'))?.toString()).toBe('{"rooms":[]}');
    expect(await s.writeFile('w1', 'CLAUDE.md', Buffer.from('# Instructions'))).toEqual({
      ok: true,
    });
    // The fixed program, by its full path on the read-only root (nothing the assistant can
    // replace), isolated from the workspace and the environment; the path is only an argument.
    for (const [cmd, mode, path] of [
      [execs[0], 'read', 'plan.json'],
      [execs[1], 'write', 'CLAUDE.md'],
    ] as const) {
      expect(cmd?.slice(0, 3)).toEqual(['/usr/bin/python3', '-I', '-c']);
      expect(cmd?.[3]).toContain('O_NOFOLLOW');
      // gVisor follows a link to a folder despite O_NOFOLLOW: what's opened must be what lstat saw.
      expect(cmd?.[3]).toContain('(got.st_dev, got.st_ino) != (seen.st_dev, seen.st_ino)');
      expect(cmd?.[3]).not.toContain(path);
      expect(cmd?.slice(4, 6)).toEqual([mode, path]);
    }
    expect(execs.flat().some((a) => a === 'cat' || a === 'sh')).toBe(false);

    // Only the allowed files, and nothing that isn't a plain file there (a link, a folder).
    execs.length = 0;
    await expect(s.readFile('w1', '../home/architect/.claude-config/x')).rejects.toThrow();
    await expect(s.writeFile('w1', 'src/main.ts', Buffer.from('x'))).rejects.toThrow();
    expect(execs).toEqual([]);
    const refused = make({ io: { out: '', code: 4 } });
    await refused.s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    expect(await refused.s.readFile('w1', 'plan.json')).toBeNull();
    expect(await refused.s.writeFile('w1', 'plan.json', Buffer.from('{}'))).toEqual({ ok: false });
  });

  it('runs its own commands from the read-only root, never a folder a sandbox can write (C2)', async () => {
    const { s, execs, execEnvs } = make({
      sha: 'c'.repeat(64),
      signedIn: true,
      pane: '0 0 0 50 20',
    });
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    execs.length = 0;
    execEnvs.length = 0;
    // The installed assistant's checksum (C2), the sign-in check, typing, scrolling, listing.
    expect((await s.connectStatus('alice', 'claude')).sha).toBe('c'.repeat(64));
    await s.type('test-sandbox-w1', 'hello');
    await s.scroll('test-sandbox-w1', 2);
    await s.changedFiles('w1');
    expect(execs.length).toBeGreaterThan(4);
    for (const [i, cmd] of execs.entries()) {
      // A planted ~/.local/bin/sha256sum (or sh) would otherwise answer for the real ones.
      expect(cmd[0], cmd.join(' ')).toMatch(/^\/usr\/bin\//);
      expect(execEnvs[i]?.filter((v) => v.startsWith('PATH='))).toEqual([
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ]);
    }
    const hash = execs.find((c) => c.join(' ').includes('sha256sum'));
    expect(hash?.[0]).toBe('/usr/bin/sh');
    // Only a program whose real file is in the tools volume counts (an older Codex install, in
    // its sign-in volume, could be changed from a workspace).
    expect(hash?.[2]).toContain('case "$f" in "$HOME"/.local/*) ;; *) exit 1;; esac');
  });

  it("starts the assistant as the terminal's program, never by typing it (C9)", async () => {
    const sha = 'c'.repeat(64);
    const installed = { provider: 'claude', sha };
    const atShell = make({ pane: 'bash', sha });
    await atShell.s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    atShell.execs.length = 0;
    expect(await atShell.s.launch('test-sandbox-w1', 'claude --model x\r', installed)).toEqual({
      ok: true,
    });
    // What's running is read from the pane's processes, never from tmux's name for the pane:
    // under gVisor tmux can't see them, and goes by the pane's last command ("exec -a …" → "a").
    const asked = atShell.execs.find((c) => c.join(' ').includes('#{pane_pid}'));
    expect(asked?.[2]).toContain('/proc/$1/cmdline');
    expect(asked?.[2]).toContain('pgrep -P "$p"');
    expect(atShell.execs.some((c) => c.join(' ').includes('pane_current_command'))).toBe(false);
    // Nothing is ever typed: the command is the pane's program, so even a session that lies
    // about being at a shell prompt can't turn it into a message to a running assistant.
    expect(atShell.execs.some((c) => c.includes('send-keys'))).toBe(false);
    const respawn = atShell.execs.find((c) => c.includes('respawn-pane'));
    const at = respawn?.indexOf('respawn-pane') ?? -1;
    expect(respawn?.slice(at, at + 6)).toEqual([
      'respawn-pane',
      '-k',
      '-t',
      'main',
      '-c',
      '#{pane_current_path}',
    ]);
    // A shell named as the program (tmux names the pane after it, so Start isn't run over it),
    // with the container's own PATH from Docker (not the sandbox: the assistant is in
    // ~/.local/bin), that runs it (control characters dropped), says so if it failed, then
    // becomes the Architect's shell: the pane's own program never ends.
    const started = respawn?.[at + 6] ?? '';
    expect(started.startsWith("exec -a 'claude' /bin/bash -c '")).toBe(true);
    expect(started).toContain('trap : INT');
    expect(started).toContain(`export PATH='\\''${IMAGE_PATH.slice('PATH='.length)}'\\''`);
    expect(started).toContain('\nclaude --model x\n');
    expect(started).toContain('It stopped with an error (see above).');
    expect(started).toContain('exec -a bash /bin/bash -l');
    expect(respawn?.[(respawn?.indexOf('pane-died') ?? -2) + 1]).toBe(
      'respawn-pane -k -t main "exec /bin/bash -l"',
    );

    // Something else running there (the assistant, say): it's left alone.
    const busy = make({ pane: 'claude', sha });
    await busy.s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    busy.execs.length = 0;
    expect(await busy.s.launch('test-sandbox-w1', 'claude', installed)).toMatchObject({
      ok: false,
      error: 'busy',
      running: 'claude',
    });
    expect(busy.execs.some((c) => c.includes('respawn-pane'))).toBe(false);

    // The assistant's program changed since it was installed (its tools volume is writable from
    // any of the Architect's sandboxes): it isn't started (C2).
    const changed = make({ pane: 'bash', sha: 'd'.repeat(64) });
    await changed.s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    changed.execs.length = 0;
    expect(await changed.s.launch('test-sandbox-w1', 'claude', installed)).toEqual({
      ok: false,
      error: 'changed',
    });
    expect(changed.execs.some((c) => c.includes('respawn-pane'))).toBe(false);
    expect(changed.execs.find((c) => c.join(' ').includes('sha256sum'))?.[0]).toBe('/usr/bin/sh');
  });

  it("puts the system's programs before the Architect's tools volume on PATH", async () => {
    const { s, created } = make();
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    await s.startConnect('alice', 'claude');
    // That volume is writable from every sandbox and shared by all of the Architect's
    // containers: a planted `ls` or `git` there must never win over the system's.
    const tools =
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/architect/.local/bin';
    for (const name of ['test-sandbox-w1', 'test-connect-alice-claude']) {
      const env = created.get(name)?.Env ?? [];
      expect(
        env.filter((v) => v.startsWith('PATH=')),
        name,
      ).toEqual([tools]);
      expect(created.get(name)?.HostConfig.Mounts.map((m) => m.Target)).toContain(
        '/home/architect/.local',
      );
    }
  });

  it("reads and writes a workspace's files only where no sign-in is mounted, never through a link (C4)", async () => {
    const { s, created, removed, execs, execsIn, live } = make();
    await s.startSandbox({ ws: 'w1', architect: 'alice', provider: 'claude' });
    execs.length = 0;
    execsIn.length = 0;
    await s.readFile('w1', 'plan.json');
    await s.readFile('w1', 'preview/rooms/hall.png');
    await s.listPictures('w1');
    await s.writeFile('w1', 'CLAUDE.md', Buffer.from('# hi'));
    await expect(s.readFile('w1', '../home/architect/.claude-config/x.json')).rejects.toThrow();
    await expect(s.writeFile('w1', 'plan.json.tmp', Buffer.from(''))).rejects.toThrow();

    const ran = execsIn.map((container, i) => ({ container, cmd: execs[i] as string[] }));
    expect(ran).toHaveLength(4);
    for (const { container, cmd } of ran) {
      expect(container).not.toBe('test-sandbox-w1');
      const spec = created.get(container);
      expect(mounts(spec)).toEqual([
        cmd[4] === 'write' ? 'test-ws-w1->/workspace' : 'test-ws-w1->/workspace (ro)',
      ]);
      expect(spec?.HostConfig.NetworkMode).toBe('none');
    }
    const [read, picture, list, write] = ran;
    // Reads share one reader, kept for the next (the Studio reads every few seconds).
    expect(new Set([read, picture, list].map((e) => e?.container))).toEqual(
      new Set(['test-reader-w1']),
    );
    // The no-follow program (see the test above), with the path as an argument.
    expect(read?.cmd.slice(0, 2)).toEqual(['/usr/bin/python3', '-I']);
    expect(read?.cmd.slice(4, 6)).toEqual(['read', 'plan.json']);
    expect(write?.cmd.slice(4, 6)).toEqual(['write', 'CLAUDE.md']);
    expect(write?.container).toMatch(/^test-helper-w1-/);
    expect(live.has(write?.container as string)).toBe(false);

    // Asleep, the same reader.
    await s.stopSandbox('w1');
    await s.readFile('w1', 'plan.json');
    expect(execsIn.at(-1)).toBe('test-reader-w1');
    // Put away before the workspace's volume goes.
    await s.deleteWorkspace('w1');
    expect(removed).toContain('test-reader-w1');
    expect(live.has('test-reader-w1')).toBe(false);
  });

  it('puts a reader away once it has been idle a minute', async () => {
    vi.useFakeTimers();
    try {
      const { s, live } = make();
      await s.readFile('w1', 'plan.json');
      expect(live.has('test-reader-w1')).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      await s.readFile('w1', 'trace.json'); // in use: the minute starts again
      await vi.advanceTimersByTimeAsync(45_000);
      expect(live.has('test-reader-w1')).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(live.has('test-reader-w1')).toBe(false);
      // The next read starts another.
      await s.readFile('w1', 'plan.json');
      expect(live.has('test-reader-w1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the vendor's installer with its tools folder last on PATH, and checks with system programs", async () => {
    const { s, execs, execsIn } = make({ sha: 'c'.repeat(64) });
    await s.startConnect('alice', 'codex');
    execs.length = 0;
    execsIn.length = 0;
    expect(await s.install('alice', 'codex')).toMatchObject({ ok: true, sha: 'c'.repeat(64) });
    const install = execs.find((c) => c.join(' ').includes('install.sh'));
    expect(install?.slice(0, 2)).toEqual(['/usr/bin/sh', '-c']);
    expect(install?.[2]).toMatch(
      /^export PATH="\$PATH:\$HOME\/\.local\/bin"; curl -fsSL https:\/\/chatgpt\.com\/codex\/install\.sh .*CODEX_HOME="\$HOME\/\.local\/share\/codex"/,
    );
    expect(execsIn.every((c) => c === 'test-connect-alice-codex')).toBe(true);
    const hash = execs.find((c) => c.join(' ').includes('sha256sum'));
    expect(hash?.[2]).not.toContain('.local/bin"; ');
  });

  it('checks sign-in by existence only, never reading it', async () => {
    const { s } = make({ sha: 'c'.repeat(64), signedIn: true });
    expect(await s.connectStatus('alice', 'claude')).toEqual({
      installed: true,
      sha: 'c'.repeat(64),
      signedIn: true,
      apiKey: false,
    });
  });
});
