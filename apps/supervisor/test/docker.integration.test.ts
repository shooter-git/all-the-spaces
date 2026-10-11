// Runs the supervisor against the real Docker daemon (needs the dev stack's egress proxy and the
// workbench image): SUPERVISOR_DOCKER_TESTS=1 pnpm --filter @ats/supervisor test
import type { AddressInfo } from 'node:net';
import { signToken, unpackTar as unpack } from '@ats/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { docker } from '../src/docker.ts';
import { createContainers } from '../src/sandboxes/containers.ts';
import { createSandboxes } from '../src/sandboxes.ts';
import { createSupervisorServer } from '../src/server.ts';

const run = process.env.SUPERVISOR_DOCKER_TESTS ? describe : describe.skip;
const secret = 'test-secret-that-is-long-enough-for-tickets';
const instance = 'ats-dev-test';
const ws = `t${Date.now().toString(36)}`;
const architect = 'testArchitect';
// The bake test's job, and the one it's told is one too many.
const bakeJobs = [`bake-${ws}`, `bake-${ws}-x`] as const;

run('the supervisor, with Docker', () => {
  const d = docker();
  const cfg = {
    instance,
    image: process.env.ATS_WORKBENCH_IMAGE ?? 'ats-workbench:dev',
    sandboxNetwork: 'ats-dev_sandbox',
    egressUrl: 'http://egress:3128',
    egressContainer: 'ats-dev-egress-1',
    runtime: process.env.ATS_SANDBOX_RUNTIME ?? 'runc',
    cpus: 2,
    memoryMb: 2048,
    pids: 512,
    bakeCpus: 2,
    bakeParallel: 2,
    checkCpus: 2,
  };
  const sandboxes = createSandboxes(d, cfg);
  /** Runs a command in a container as the assistant would (to set up what it might do). */
  const { exec } = createContainers(d, cfg);
  const server = createSupervisorServer(sandboxes, { secret, egressContainer: 'ats-dev-egress-1' });
  let base = '';
  const post = (act: string, claims: Record<string, unknown>, body: Record<string, unknown>) =>
    fetch(`${base}/v1/${act}`, {
      method: 'POST',
      body: JSON.stringify({
        ticket: signToken('supervisor', { act, ...claims }, secret, 60),
        ...body,
      }),
    });
  const call = async (
    act: string,
    claims: Record<string, unknown>,
    body: Record<string, unknown> = {},
    // biome-ignore lint/suspicious/noExplicitAny: test responses
  ): Promise<{ status: number; body: any }> => {
    const res = await post(act, claims, body);
    return { status: res.status, body: await res.json() };
  };
  const callRaw = async (
    act: string,
    claims: Record<string, unknown>,
    body: Record<string, unknown> = {},
  ) => Buffer.from(await (await post(act, claims, body)).arrayBuffer());

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await sandboxes.deleteWorkspace(ws).catch(() => {});
    // Also here, for a bake test that timed out: its own clean-up never runs then.
    for (const job of bakeJobs) await sandboxes.deleteBake(job).catch(() => {});
    await sandboxes.stopConnect(architect, 'claude').catch(() => {});
    for (const v of [
      sandboxes.volumes.tools(architect),
      sandboxes.volumes.credentials(architect, 'claude'),
    ])
      await d.json('DELETE', `/volumes/${v}`).catch(() => {});
    server.close();
  });

  it('refuses requests without a valid ticket for that action', async () => {
    const res = await fetch(`${base}/v1/sandbox.start`, {
      method: 'POST',
      body: JSON.stringify({ ticket: 'nope' }),
    });
    expect(res.status).toBe(403);
    const wrong = signToken('supervisor', { act: 'sandbox.stop', ws }, secret, 60);
    const res2 = await fetch(`${base}/v1/sandbox.start`, {
      method: 'POST',
      body: JSON.stringify({ ticket: wrong }),
    });
    expect(res2.status).toBe(403);
  });

  it('writes a new workspace, runs its sandbox sealed off, and archives its source', {
    timeout: 120_000,
  }, async () => {
    const files = {
      'index.html': Buffer.from('<!doctype html><title>t</title><p>hello</p>').toString('base64'),
      'src/main.ts': Buffer.from('export {};\n').toString('base64'),
    };
    expect((await call('workspace.init', { ws }, { files })).body).toEqual({ ok: true });
    // Only into an empty workspace.
    expect((await call('workspace.init', { ws }, { files })).body).toMatchObject({
      ok: false,
      error: 'not-empty',
    });
    expect((await call('sandbox.start', { ws, a: architect, p: 'claude' })).body).toEqual({
      ok: true,
    });
    expect((await call('sandbox.status', { ws })).body).toMatchObject({ running: true });

    const container = sandboxes.names.sandbox(ws);
    const info = await d.json<{
      HostConfig: {
        ReadonlyRootfs: boolean;
        CapDrop: string[];
        Binds: null;
        Mounts: { Target: string }[];
      };
      Mounts: { Name: string; Destination: string; RW: boolean }[];
    }>('GET', `/containers/${container}/json`);
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.CapDrop).toEqual(['ALL']);
    // The Architect's tools (the assistant's program) can't be written from here; the
    // workspace's own cache volume (its packages) can.
    expect(info.Mounts.map((m) => `${m.Destination} ${m.RW ? 'rw' : 'ro'}`).sort()).toEqual([
      '/home/architect/.cache rw',
      '/home/architect/.claude-config rw',
      '/home/architect/.claude-config/projects rw',
      '/home/architect/.local ro',
      '/workspace rw',
    ]);
    // Its conversations are its own, and the assistant can write them there.
    expect(info.Mounts.find((m) => m.Destination.endsWith('/projects'))?.Name).toBe(
      sandboxes.volumes.conversation(ws, 'claude', 'projects'),
    );
    const chat = await exec(container, [
      'sh',
      '-c',
      'mkdir -p ~/.claude-config/projects/-workspace && echo hi > ~/.claude-config/projects/-workspace/a.jsonl && echo written',
    ]);
    expect(chat.stdout.toString()).toBe('written\n');

    // A terminal: typing runs commands in the workspace.
    const socket = new WebSocket(
      `${base.replace('http', 'ws')}/v1/terminal?ticket=${signToken('supervisor', { act: 'terminal', ws }, secret, 60)}&cols=100&rows=30`,
    );
    let screen = '';
    socket.on('message', (d) => {
      screen += d.toString();
    });
    await new Promise((r) => socket.once('open', r));
    await new Promise((r) => setTimeout(r, 800));
    socket.send(
      Buffer.from(
        'curl -s -o /dev/null -w "npm:%{http_code}\\n" https://registry.npmjs.org/three; curl -s -m 5 -o /dev/null -w "other:%{http_code}\\n" https://example.com; touch /etc/x 2>/dev/null || echo readonly; ls src\r',
      ),
    );
    await new Promise((r) => setTimeout(r, 6000));
    // The session takes the screen's size (set from inside too: see terminal), and follows it.
    const windowSize = async () =>
      (
        await exec(container, [
          'tmux',
          'display-message',
          '-p',
          '-t',
          'main',
          '#{window_width}x#{window_height}',
        ])
      ).stdout
        .toString()
        .trim();
    expect(await windowSize()).toBe('100x30');
    socket.send(JSON.stringify({ type: 'resize', cols: 163, rows: 47 }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(await windowSize()).toBe('163x47');
    socket.close();
    expect(screen).toContain('npm:200');
    expect(screen).toContain('other:000');
    expect(screen).toContain('readonly');
    expect(screen).toContain('main.ts');

    // A file the Architect adds goes into uploads/ under a free name (nothing is replaced)...
    const data = Buffer.from('a plan').toString('base64');
    expect((await call('workspace.upload', { ws }, { name: 'plan.txt', data })).body).toEqual({
      name: 'plan.txt',
      running: true,
    });
    expect((await call('workspace.upload', { ws }, { name: 'plan.txt', data })).body).toEqual({
      name: 'plan-2.txt',
      running: true,
    });
    expect((await call('workspace.upload', { ws }, { name: '../x', data })).status).not.toBe(200);
    expect(
      (await call('workspace.uploads', { ws })).body.files.map((f: { name: string }) => f.name),
    ).toEqual(['plan.txt', 'plan-2.txt']);
    expect((await call('workspace.unupload', { ws }, { name: 'plan.txt' })).body).toEqual({
      ok: true,
    });
    expect((await call('workspace.unupload', { ws }, { name: '*' })).status).not.toBe(200);
    expect(
      (await call('workspace.uploads', { ws })).body.files.map((f: { name: string }) => f.name),
    ).toEqual(['plan-2.txt']);
    // A pack (an unpacked .zip) goes in whole as a new folder, its files keeping their paths...
    const packed = (path: string, text: string) => ({
      path,
      data: Buffer.from(text).toString('base64'),
    });
    const pack = [packed('README.md', 'read me first'), packed('ref/01_Aerial.jpg', 'jpeg')];
    expect(
      (await call('workspace.uploadpack', { ws }, { folder: 'garage', files: pack })).body,
    ).toEqual({ name: 'garage', running: true });
    expect(
      (await call('workspace.uploadpack', { ws }, { folder: 'garage', files: pack })).body,
    ).toEqual({ name: 'garage-2', running: true });
    for (const files of [
      [packed('../x.md', 'x')],
      [packed('/etc/x.md', 'x')],
      [packed('.hidden', 'x')],
      [packed('a', 'x'), packed('a/b', 'x')],
    ])
      expect(
        (await call('workspace.uploadpack', { ws }, { folder: 'bad', files })).status,
      ).not.toBe(200);
    const read = await exec(container, ['cat', '/workspace/uploads/garage/ref/01_Aerial.jpg']);
    expect(read.stdout.toString()).toBe('jpeg');
    expect(
      (await call('workspace.uploads', { ws })).body.files.map(
        (f: { name: string; files?: number; folder?: true }) => [f.name, f.files, f.folder],
      ),
    ).toEqual([
      ['plan-2.txt', undefined, undefined],
      ['garage', 2, true],
      ['garage-2', 2, true],
    ]);
    // ...and is removed whole.
    expect((await call('workspace.unupload', { ws }, { name: 'garage-2' })).body).toEqual({
      ok: true,
    });
    expect(
      (await call('workspace.uploads', { ws })).body.files.map((f: { name: string }) => f.name),
    ).toEqual(['plan-2.txt', 'garage']);
    // ...and its path is pasted into the terminal, never run (a line break can't get through).
    expect(
      (await call('sandbox.paste', { ws }, { text: 'echo pasted-$((6*7)) uploads/plan-2.txt\r\n' }))
        .body,
    ).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 800));
    const again = new WebSocket(
      `${base.replace('http', 'ws')}/v1/terminal?ticket=${signToken('supervisor', { act: 'terminal', ws }, secret, 60)}&cols=100&rows=30`,
    );
    let shown = '';
    again.on('message', (d) => {
      shown += d.toString();
    });
    await new Promise((r) => again.once('open', r));
    await new Promise((r) => setTimeout(r, 1000));
    again.send(Buffer.from('\x15')); // clears the line
    await new Promise((r) => setTimeout(r, 300));
    again.close();
    expect(shown).toContain('echo pasted-$((6*7)) uploads/plan-2.txt');
    expect(shown).not.toContain('pasted-42');

    // Programs are started as the terminal's own, never typed, and only as installed (C2): with
    // no assistant installed to match the checksum, nothing starts.
    const launch = (command: string) =>
      call('sandbox.launch', { ws, p: 'claude', sha: 'a'.repeat(64) }, { command });
    expect((await launch('claude')).body).toEqual({ ok: false, error: 'changed' });
    // Never over a program that's running (here, one the Architect ran themselves) (C9).
    const typing = new WebSocket(
      `${base.replace('http', 'ws')}/v1/terminal?ticket=${signToken('supervisor', { act: 'terminal', ws }, secret, 60)}&cols=100&rows=30`,
    );
    await new Promise((r) => typing.once('open', r));
    await new Promise((r) => setTimeout(r, 800));
    typing.send(Buffer.from('sleep 30\r'));
    await new Promise((r) => setTimeout(r, 800));
    typing.close();
    expect((await launch('claude')).body).toMatchObject({
      ok: false,
      error: 'busy',
      running: 'sleep',
    });
    // Typing (a suggested prompt) never presses Enter.
    expect((await call('sandbox.type', { ws }, { text: 'hello' })).body).toEqual({ ok: true });

    const tar = await callRaw('workspace.archive', { ws });
    const archived = unpack(tar);
    expect(archived.get('src/main.ts')?.toString()).toBe('export {};\n');
    expect([...archived.keys()].some((k) => k.startsWith('.git'))).toBe(false);
    expect([...archived.keys()].some((k) => k.includes('uploads'))).toBe(false);

    // Links the assistant makes to its sign-in are never followed: the supervisor reads and
    // writes where no sign-in is mounted, and refuses anything but a plain file at that path (C4).
    const made = await exec(container, [
      'sh',
      '-c',
      [
        'cd /workspace',
        'echo \'{"token":"sign-in-secret"}\' > /home/architect/.claude-config/creds.json',
        'ln -s /home/architect/.claude-config/creds.json plan.json',
        'mkdir -p real && echo plain > real/a.png && ln -s real preview',
        'ln -s /home/architect/.claude-config .ats',
      ].join(' && '),
    ]);
    expect(made.code).toBe(0);
    for (const path of ['plan.json', 'preview/a.png'])
      expect((await post('workspace.read', { ws }, { path })).status).toBe(404);
    const write = (path: string, text: string) =>
      call('workspace.write', { ws }, { path, data: Buffer.from(text).toString('base64') });
    expect((await write('.ats/CLAUDE.md.before-update', 'x')).body).toEqual({ ok: false });
    // A link at the name itself is replaced by the file, never written through.
    expect((await write('plan.json', '{"rooms":[]}')).body).toEqual({ ok: true });
    expect((await callRaw('workspace.read', { ws }, { path: 'plan.json' })).toString()).toBe(
      '{"rooms":[]}',
    );
    const after = await exec(container, [
      'sh',
      '-c',
      'cat /home/architect/.claude-config/creds.json; ls -A /home/architect/.claude-config',
    ]);
    expect(after.stdout.toString()).toBe('{"token":"sign-in-secret"}\ncreds.json\nprojects\n');

    // Put to sleep twice at once (a request retried after a network blip): both succeed.
    // Whatever wasn't committed is saved as a checkpoint once: one says so, the other finds nothing.
    const stops = await Promise.all([call('sandbox.stop', { ws }), call('sandbox.stop', { ws })]);
    expect(stops.map((r) => r.body.checkpoint).sort()).toEqual(['nothing', 'saved']);
    expect(stops.map((r) => r.body.ok)).toEqual([true, true]);
    expect((await call('sandbox.status', { ws })).body).toMatchObject({ running: false });
    // In the workspace's own history, as the Studio, without the Architect's uploads.
    await call('sandbox.start', { ws, a: architect, p: 'claude' });
    const history = await exec(container, [
      'sh',
      '-c',
      'cd /workspace && git log --format="%an|%s" && echo --- && git show --name-only --format= HEAD && echo --- && git status --short',
    ]);
    const [log, committed, left] = history.stdout.toString().split('---\n');
    expect(log).toBe(
      'Studio|Checkpoint: saved when the workspace went to sleep\nArchitect|Start\n',
    );
    expect(committed).toContain('plan.json');
    expect(committed).toContain('real/a.png');
    expect(committed).not.toContain('uploads');
    // Left out even with no .gitignore saying so (a real workspace's has uploads/ in it).
    expect(left).toBe('?? uploads/\n');
    await call('sandbox.stop', { ws });
  });

  it('builds a live preview with no network and no sign-ins', { timeout: 120_000 }, async () => {
    await call('preview.start', { ws });
    let status: { stamp?: number; ok?: boolean } | null = null;
    for (let i = 0; i < 60 && !status?.ok; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      status = (await call('preview.status', { ws })).body.status;
    }
    expect(status?.ok).toBe(true);
    const html = await callRaw(
      'preview.file',
      { ws },
      { stamp: status?.stamp, path: 'index.html' },
    );
    expect(html.toString()).toContain('hello');
    const info = await d.json<{
      HostConfig: { NetworkMode: string };
      Mounts: { Destination: string; RW: boolean }[];
    }>('GET', `/containers/${sandboxes.names.preview(ws)}/json`);
    expect(info.HostConfig.NetworkMode).toBe('none');
    expect(info.Mounts).toEqual([
      expect.objectContaining({ Destination: '/workspace', RW: false }),
    ]);
    await call('preview.stop', { ws });
  });

  it('gives an Architect a place to connect their assistant', { timeout: 60_000 }, async () => {
    expect((await call('connect.start', { a: architect, p: 'claude' })).body).toEqual({ ok: true });
    expect((await call('connect.status', { a: architect, p: 'claude' })).body).toEqual({
      installed: false,
      sha: null,
      signedIn: false,
      apiKey: false,
    });
  });

  it("bakes two rooms' lighting at once with the image's Blender, then clears the job away", {
    timeout: 180_000,
  }, async () => {
    const [job, extra] = bakeJobs;
    // A 4 × 3 m room (floor, ceiling, four walls) and one ceiling light, as bake.ts sends it.
    const quad = (a: number[], b: number[], c: number[], d: number[]) => [a, b, c, d];
    const quads = [
      quad([0, 0, 3], [4, 0, 3], [4, 0, 0], [0, 0, 0]),
      quad([0, 2.5, 0], [4, 2.5, 0], [4, 2.5, 3], [0, 2.5, 3]),
      quad([0, 0, 0], [4, 0, 0], [4, 2.5, 0], [0, 2.5, 0]),
      quad([4, 0, 3], [0, 0, 3], [0, 2.5, 3], [4, 2.5, 3]),
      quad([0, 0, 3], [0, 0, 0], [0, 2.5, 0], [0, 2.5, 3]),
      quad([4, 0, 0], [4, 0, 3], [4, 2.5, 3], [4, 2.5, 0]),
    ];
    const input = {
      receiver: {
        positions: quads.flat(2),
        faces: quads.map((_, i) => [0, 1, 2, 3].map((k) => i * 4 + k)),
        faceGroup: quads.map(() => 0),
        groups: [{ albedo: [0.7, 0.7, 0.7] }],
      },
      occluders: { positions: [], faces: [] },
      lights: [{ center: [2, 2.47, 1.5], size: [0.7, 0.7], power: 80, color: [1, 0.93, 0.84] }],
      hdri: null,
      hdriStrength: 1,
      hdriRotation: Math.PI,
      resolution: 32,
      samples: 4,
      margin: 2,
    };
    try {
      expect((await call('bake.init', { ws: job })).body).toEqual({ ok: true });
      expect((await call('bake.slots', {})).body).toEqual({ parallel: 2, cpus: 2 });
      const encode = (room: object) => Buffer.from(JSON.stringify(room)).toString('base64');
      // First both of its slots get a room that takes a minute or more to bake (256 pixels at
      // 16,384 samples). A small room bakes in about 2 seconds, about as long as starting the
      // next one takes, so it could be done before a third is asked for. These can't.
      const slow = encode({ ...input, resolution: 256, samples: 16_384 });
      for (const slot of [0, 1])
        expect((await call('bake.room', { ws: job }, { slot, input: slow })).body).toEqual({
          ok: true,
        });
      // A third is one more than may run at once.
      expect((await call('bake.room', { ws: extra }, { slot: 0, input: slow })).body).toEqual({
        ok: false,
        busy: true,
      });
      // Then each slot's slow room is stopped and replaced by a small one (the second a little
      // smaller, so they differ), and those bake to the end.
      for (const [slot, resolution] of [32, 16].entries())
        expect(
          (await call('bake.room', { ws: job }, { slot, input: encode({ ...input, resolution }) }))
            .body,
        ).toEqual({ ok: true });
      for (const [slot, size] of [32, 16].entries()) {
        let ended: { done: boolean; code?: number; error?: string };
        do {
          const waited = await call('bake.wait', { ws: job }, { slot });
          // A failed wait has no `done`: asking again would never end.
          expect(waited.status, waited.body.error).toBe(200);
          ended = waited.body;
        } while (!ended.done);
        expect(ended.code, ended.error).toBe(0);
        const files = unpack(await callRaw('bake.files', { ws: job }, { slot }));
        expect(JSON.parse(files.get('meta.json')?.toString() ?? '{}')).toMatchObject({
          width: size,
          height: size,
        });
        expect(files.get('lightmap.f32')?.length).toBe(size * size * 4 * 4);
        expect(files.get('uv2.f32')?.length).toBe(24 * 2 * 4);
      }
    } finally {
      for (const j of bakeJobs) await call('bake.delete', { ws: j }).catch(() => {});
    }
    const volumes = await d.json<{ Volumes: { Name: string }[] | null }>('GET', '/volumes');
    expect((volumes.Volumes ?? []).filter((v) => v.Name.includes(job))).toEqual([]);
    const left = await d.json<{ Names: string[] }[]>('GET', '/containers/json?all=1');
    expect(left.filter((c) => c.Names[0]?.includes(job))).toEqual([]);
  });
});
