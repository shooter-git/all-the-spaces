/**
 * Work in the workbench that takes longer than Node's fetch waits for a reply (five minutes with
 * no response headers): the server's own supervisor client against the supervisor's real API,
 * with Docker faked and the clock too. No request may be held anywhere near that long.
 */
import type { AddressInfo } from 'node:net';
import { packTar } from '@ats/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Log } from '../../supervisor/src/log.ts';
import type { Containers } from '../../supervisor/src/sandboxes/containers.ts';
import { createJobs } from '../../supervisor/src/sandboxes/jobs.ts';
import type { Sandboxes } from '../../supervisor/src/sandboxes.ts';
import { createSupervisorServer } from '../../supervisor/src/server.ts';
import { checkInContainers } from '../src/creations/builds.ts';
import { createSupervisor } from '../src/studio/supervisor.ts';

const SECRET = 'x'.repeat(64);
const MINUTE = 60_000;
const quiet = { info: () => {} } as unknown as Log;
const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

/** One frame of Docker's multiplexed log stream (stdout). */
const frame = (text: string) => {
  const head = Buffer.alloc(8);
  head[0] = 1;
  head.writeUInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([head, Buffer.from(text)]);
};

/** The supervisor's API on a free port, and how long each request to it was held. */
async function supervisorFor(sandboxes: Sandboxes) {
  const server = createSupervisorServer(sandboxes, {
    secret: SECRET,
    egressContainer: 'egress',
    log: quiet,
  });
  const held: { act: string; ms: number }[] = [];
  server.prependListener('request', (req, res) => {
    const from = Date.now();
    res.on('finish', () => held.push({ act: req.url ?? '', ms: Date.now() - from }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { sup: createSupervisor(url, SECRET), held, close: () => server.close() };
}

/** Moves the clock on a second at a time (letting real sockets talk in between) until it's done. */
async function settle<T>(work: Promise<T>, minutes: number) {
  let done = false;
  work.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let s = 0; s < minutes * 60 && !done; s++) {
    await vi.advanceTimersByTimeAsync(1000);
    await new Promise((r) => setImmediate(r));
  }
  return work;
}

describe('work in the workbench that takes longer than five minutes', () => {
  const servers: { close(): void }[] = [];
  // One clock for every test here: Node's fetch keeps its own timer, made on the first clock it
  // saw, so a second clock would leave its time limit standing still.
  beforeAll(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it("a creation's checks: installing takes six minutes, and the report still comes back", async () => {
    // Each step's container ends a while after it starts: installing after six minutes.
    const ends = new Map<string, number>();
    const report = { ok: true, checks: [] };
    const ctx = {
      docker: {
        async json(_method: string, path: string) {
          const wait = /^\/containers\/([^/]+)\/wait$/.exec(path);
          if (wait) {
            const end = ends.get(wait[1] as string) ?? Date.now();
            return later(Math.max(0, end - Date.now()), { StatusCode: 0 });
          }
          return {};
        },
        async raw(_method: string, path: string) {
          const prepare = /prepare\/logs/.test(path);
          return (async function* () {
            yield frame(prepare ? '{"prepared":true}\n' : '{}\n');
          })();
        },
      },
      cfg: { sandboxNetwork: 'sandbox' },
      name: (...parts: string[]) => ['ats', ...parts].join('-'),
      ensureVolume: async () => {},
      hardened: (extra: object) => extra,
      proxyEnv: [],
      egressHosts: async () => [],
      async run(container: string) {
        ends.set(container, Date.now() + (container.endsWith('prepare') ? 6 : 1) * MINUTE);
        return container;
      },
      remove: async () => {},
      async exec(_container: string, cmd: string[]) {
        const tar = cmd.includes('-cf')
          ? packTar(
              new Map([
                ['out/report.json', Buffer.from(JSON.stringify(report))],
                ['dist/index.html', Buffer.from('<p>hi</p>')],
              ]),
            )
          : Buffer.alloc(0);
        return { code: 0, stdout: tar, stderr: Buffer.alloc(0) };
      },
      withHelper: async (_job: string, _writable: boolean, fn: (c: string) => unknown) =>
        fn('helper'),
    } as unknown as Containers;
    const s = await supervisorFor(createJobs(ctx) as unknown as Sandboxes);
    servers.push(s);

    const steps: string[] = [];
    const checked = await settle(
      checkInContainers(s.sup, 'build-1', new Map([['ats.json', Buffer.from('{}')]]), async (w) =>
        steps.push(w),
      ),
      20,
    );
    expect(checked.report).toEqual(report);
    expect([...(checked.dist?.keys() ?? [])]).toEqual(['index.html']);
    expect(steps.at(-1)).toBe('Writing the report');
    expect(Math.max(...s.held.map((h) => h.ms))).toBeLessThanOrEqual(MINUTE);
  });

  it("a workspace's checks and an assistant's installer that take six minutes still answer", async () => {
    const sandboxes = {
      check: () => later(6 * MINUTE, { ok: true, report: { ok: true, checks: [] } }),
      install: () => later(6 * MINUTE, { ok: true, log: 'installed', sha: 'abc', version: '1' }),
    } as unknown as Sandboxes;
    const s = await supervisorFor(sandboxes);
    servers.push(s);

    expect(await settle(s.sup.call('sandbox.check', { ws: 'w1' }), 20)).toEqual({
      ok: true,
      report: { ok: true, checks: [] },
    });
    expect(await settle(s.sup.call('connect.install', { a: 'u1', p: 'claude' }), 20)).toMatchObject(
      { ok: true, sha: 'abc' },
    );
    expect(Math.max(...s.held.map((h) => h.ms))).toBeLessThanOrEqual(MINUTE);
  });
});
