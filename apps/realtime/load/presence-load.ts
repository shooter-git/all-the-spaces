// Presence load test: many simulated people walking around a sample building.
//   pnpm --filter @ats/realtime load-test [people=50] [sample=two-floor-building]
// `tall-building` is 20 floors (samples/tall-building, from tools/dev/make-tall-building.mjs).
//
// Starts its own copy of the real-time service (on a free port, using a separate Valkey
// database so it never meets the dev service), connects real WebSocket clients, and checks the
// Phase 1 budgets:
//   - each state update (patch) and each interest-management pass: p99 < 5 ms
//   - the service uses < 50% of one CPU core
//   - people in a busy room receive <= 20 KB/s each
//   - someone arriving on another floor by lift appears to people there within 200 ms
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { avatarColor, shardFor, signTicket } from '@ats/shared';
import { buildSpace } from '@ats/space-builder';
import { Client, getStateCallbacks, type Room } from '@colyseus/sdk';

const PEOPLE = Number(process.argv[2] ?? 50);
const SAMPLE = process.argv[3] ?? 'two-floor-building';
/** Per sample: who watches for the lift arriving, and which stops the lift rides between. */
const SAMPLES: Record<string, { observer: string; stops: [number, number]; liftShare: number }> = {
  'two-floor-building': { observer: 'office', stops: [0, 1], liftShare: 0 },
  // A fifth of everyone else waits by a lift door, the busiest spots in a tall building.
  'tall-building': { observer: 'lift-10', stops: [0, 10], liftShare: 0.2 },
};
const setup = SAMPLES[SAMPLE];
if (!setup) throw new Error(`No load-test set-up for ${SAMPLE}`);
const BUSY_ROOM = 'lobby';
const IN_BUSY_ROOM = Math.min(30, PEOPLE);
const WARMUP_S = 20; // past the service's first stats window, while its code is still being compiled
const MEASURE_S = 45;
const SEND_EVERY_MS = 50; // same as the web client
/** Chance someone (outside the busy room) goes next door on reaching where they were heading. */
const WANDER = 0.1;
const root = fileURLToPath(new URL('../../../', import.meta.url));

// --- The space: the two-floor sample's room graph and bounds --------------------------------
const plan = JSON.parse(readFileSync(`${root}samples/${SAMPLE}/plan.json`, 'utf8'));
const { manifest } = await buildSpace(plan);
const rooms = new Map(manifest.rooms.map((r) => [r.key, r]));
const graph = {
  rooms: manifest.rooms.map((r) => ({
    key: r.key,
    name: r.name,
    floorKey: r.floorKey,
    neighbors: r.neighbors,
  })),
  links: manifest.links.map((l) => ({ key: l.key, rooms: l.stops.map((s) => s.roomKey) })),
  // Everyone may see every room.
  access: {
    architects: [],
    rooms: Object.fromEntries(
      manifest.rooms.map((r) => [r.key, { visibility: 'group', users: [] as string[] }]),
    ),
  },
};
const spaceId = randomUUID();
const secret = randomBytes(32).toString('hex');

// --- A stand-in for the API server's internal graph endpoint ---------------------------------
const api: Server = createServer((req, res) => {
  const ok = req.url === `/internal/spaces/${spaceId}/graph` && req.headers['x-realtime-secret'];
  res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
  res.end(ok ? JSON.stringify(graph) : '{}');
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
const apiPort = (api.address() as AddressInfo).port;

// --- The real-time service under test ----------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(`${root}.env`, 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => [m[1], m[2]]),
);
const valkey = env.VALKEY_URL ?? `redis://127.0.0.1:${env.ATS_PORT_VALKEY ?? 45179}`;
const port = await freePort();
const stats: StatsLine[] = [];
const gcLog: string[] = [];
// LOAD_SERVICE_CPUS=6-7 pins the service to its own cores (taskset), so the simulated people
// don't compete with it for CPU time; LOAD_NODE_ARGS passes extra Node flags (e.g. --cpu-prof).
const nodeArgs = [...(process.env.LOAD_NODE_ARGS?.split(' ').filter(Boolean) ?? []), 'src/main.ts'];
const cpus = process.env.LOAD_SERVICE_CPUS;
const [command, args] = cpus
  ? ['taskset', ['-c', cpus, process.execPath, ...nodeArgs]]
  : [process.execPath, nodeArgs];
const service: ChildProcess = spawn(command, args, {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    ATS_PORT_REALTIME: String(port),
    VALKEY_URL: `${valkey.replace(/\/\d+$/, '')}/9`, // its own database: never mixes with dev
    REALTIME_SECRET: secret,
    SERVER_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
    ATS_PUBLIC_URL: env.ATS_PUBLIC_URL ?? 'http://app.ats.localhost',
    ATS_REALTIME_STATS: '15', // ~300 updates per window, so p99 is a real percentile
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
service.stdout?.setEncoding('utf8');
let ready: () => void;
const listening = new Promise<void>((r) => {
  ready = r;
});
service.stdout?.on('data', (chunk: string) => {
  for (const line of chunk.split('\n')) {
    if (line.includes('listening')) ready();
    if (line.includes('"stats":"space"')) stats.push(JSON.parse(line));
    else if (process.env.LOAD_NODE_ARGS && line.trim()) gcLog.push(line);
  }
});
await listening;

// --- Simulated people ------------------------------------------------------------------------
interface Person {
  room: Room;
  roomKey: string;
  pos: [number, number, number];
  target: [number, number];
  bytes: number;
  /** When they joined: poses carry the time since, as the web client's do. */
  joined: number;
  at: number;
}

async function connect(i: number, roomKey: string): Promise<Person> {
  const client = new Client(`http://127.0.0.1:${port}`);
  const sub = `bot-${i}`;
  // As the server would: everyone in a group this size spread over its shards.
  const shard = shardFor(sub, PEOPLE + 2);
  client.auth.token = signTicket(
    { sub, name: `Bot ${i}`, color: avatarColor(sub), spaceId, shard },
    secret,
    600,
  );
  const room = await client.joinOrCreate('space', { spaceId, shard });
  const person: Person = {
    room,
    roomKey,
    pos: randomPoint(roomKey),
    target: [0, 0],
    bytes: 0,
    joined: performance.now(),
    at: 0,
  };
  person.target = [person.pos[0], person.pos[2]];
  const ws = (room.connection.transport as unknown as { ws: WebSocket }).ws;
  ws.addEventListener('message', (e) => {
    person.bytes += (e.data as ArrayBuffer).byteLength ?? 0;
  });
  send(person, true);
  return person;
}

function randomPoint(roomKey: string): [number, number, number] {
  const r = rooms.get(roomKey);
  if (!r) throw new Error(`no room ${roomKey}`);
  const [x0, y0, z0] = r.bounds.min;
  const [x1, , z1] = r.bounds.max;
  return [x0 + 0.5 + Math.random() * (x1 - x0 - 1), y0, z0 + 0.5 + Math.random() * (z1 - z0 - 1)];
}

function send(p: Person, teleport = false) {
  const [x, y, z] = p.pos;
  const yaw = Math.atan2(p.target[0] - x, p.target[1] - z);
  p.at = Math.max(p.at + 1, Math.round(performance.now() - p.joined));
  p.room.send('pose', { x, y, z, yaw, room: p.roomKey, moving: !teleport, teleport, at: p.at });
}

/** Walk towards a random spot in the room at 1.4 m/s; pick a new one on arrival. */
function step(p: Person) {
  const dx = p.target[0] - p.pos[0];
  const dz = p.target[1] - p.pos[2];
  const d = Math.hypot(dx, dz);
  const move = 1.4 * (SEND_EVERY_MS / 1000);
  if (d <= move) {
    // Now and then, into a room next door (not the busy one, which keeps its crowd): people
    // wander, and every room change updates who sees whom.
    const doors = (rooms.get(p.roomKey)?.neighbors ?? []).filter((k) => k !== BUSY_ROOM);
    if (p.roomKey !== BUSY_ROOM && doors.length && Math.random() < WANDER) {
      p.roomKey = doors[Math.floor(Math.random() * doors.length)] as string;
      p.pos = randomPoint(p.roomKey);
      send(p, true);
    }
    const next = randomPoint(p.roomKey);
    p.target = [next[0], next[2]];
  } else {
    p.pos = [p.pos[0] + (dx / d) * move, p.pos[1], p.pos[2] + (dz / d) * move];
  }
  send(p);
}

const others = manifest.rooms.map((r) => r.key).filter((k) => k !== BUSY_ROOM);
const liftRooms = (manifest.links[0]?.stops ?? [])
  .map((s) => s.roomKey)
  .filter((k) => k !== BUSY_ROOM);
const people: Person[] = [];
for (let i = 0; i < PEOPLE; i++) {
  const byLift = liftRooms.length > 0 && (i % 100) / 100 < setup.liftShare;
  const roomKey =
    i < IN_BUSY_ROOM
      ? BUSY_ROOM
      : byLift
        ? (liftRooms[i % liftRooms.length] as string)
        : (others[i % others.length] as string);
  people.push(await connect(i, roomKey));
}
console.log(`${people.length} people connected (${IN_BUSY_ROOM} in the ${BUSY_ROOM})`);
const walking = setInterval(() => {
  for (const p of people) step(p);
}, SEND_EVERY_MS);

// --- Floor change: someone rides the lift up; a person upstairs should see them appear --------
const lift = manifest.links.find((l) => l.stops.length > 2) ?? manifest.links[0];
const down = lift?.stops[setup.stops[0]];
const up = lift?.stops[setup.stops[1]];
const observer = await connect(PEOPLE, setup.observer); // by the lift upstairs
const traveller = await connect(PEOPLE + 1, down?.roomKey ?? BUSY_ROOM);
const arrivals = new Map<string, number>();
getStateCallbacks(observer.room)(observer.room.state as { players: unknown }).players.onAdd(
  (_p: unknown, sessionId: string) => arrivals.set(sessionId, performance.now()),
);
async function rideLift(): Promise<number> {
  if (!up || !down) return 0;
  traveller.roomKey = up.roomKey;
  traveller.pos = [...up.position];
  const sent = performance.now();
  send(traveller, true);
  const deadline = sent + 2000;
  while (!arrivals.has(traveller.room.sessionId) && performance.now() < deadline) {
    await sleep(2);
  }
  const gap = (arrivals.get(traveller.room.sessionId) ?? deadline) - sent;
  arrivals.delete(traveller.room.sessionId);
  await sleep(1500);
  traveller.roomKey = down.roomKey;
  traveller.pos = [...down.position];
  send(traveller, true);
  await sleep(2500);
  return gap;
}

await sleep(WARMUP_S * 1000);
stats.length = 0;
for (const p of people) p.bytes = 0;
const started = performance.now();
const gaps: number[] = [];
while (performance.now() - started < MEASURE_S * 1000) gaps.push(await rideLift());
const seconds = (performance.now() - started) / 1000;
await sleep(15_500); // let the last stats window arrive

// --- Results ----------------------------------------------------------------------------------
clearInterval(walking);
const busy = people
  .filter((p) => p.roomKey === BUSY_ROOM)
  .map((p) => p.bytes / 1024 / seconds)
  .sort((a, b) => a - b);
const windows = stats.filter((s) => s.clients > 0);
/**
 * Percentile over the whole measured run, per live room (shard), from the windows' histograms;
 * the worst room counts. (The worst single window would count every hiccup on a busy machine.)
 */
function overRun(pick: (s: StatsLine) => Timing, q: number) {
  const byRoom = new Map<string, Map<number, number>>();
  for (const w of windows) {
    const h = byRoom.get(w.room) ?? new Map<number, number>();
    for (const [step, n] of Object.entries(pick(w).hist))
      h.set(Number(step), (h.get(Number(step)) ?? 0) + n);
    byRoom.set(w.room, h);
  }
  let worst = 0;
  for (const h of byRoom.values()) {
    const total = [...h.values()].reduce((a, b) => a + b, 0);
    let seen = 0;
    for (const step of [...h.keys()].sort((a, b) => a - b)) {
      seen += h.get(step) ?? 0;
      if (seen >= total * q) {
        worst = Math.max(worst, (step + 1) / 10);
        break;
      }
    }
  }
  return worst;
}
const results = {
  patchP99: overRun((s) => s.patchMs, 0.99),
  patchP50: overRun((s) => s.patchMs, 0.5),
  viewsP99: overRun((s) => s.viewsMs, 0.99),
  shards: new Set(windows.map((w) => w.room)).size,
  roomChanges: windows.reduce((n, w) => n + w.viewsMs.count, 0),
  cpu: windows.reduce((a, s) => a + s.cpu, 0) / Math.max(1, windows.length),
  busyRoomKBps: busy.at(-1) ?? 0,
  liftGapMs: Math.max(...gaps),
};
const checks: [string, boolean, string][] = [
  [
    `State update p99 < 5 ms (each of ${results.shards} live room${results.shards === 1 ? '' : 's'})`,
    results.patchP99 < 5,
    `${results.patchP99.toFixed(2)} ms (median ${results.patchP50.toFixed(2)} ms)`,
  ],
  [
    'Who-sees-whom p99 < 5 ms',
    results.viewsP99 < 5,
    `${results.viewsP99.toFixed(2)} ms (${results.roomChanges} room changes)`,
  ],
  ['CPU < 50% of one core', results.cpu < 0.5, `${(results.cpu * 100).toFixed(1)}%`],
  [
    `Download per person in a room of ${IN_BUSY_ROOM} <= 20 KB/s`,
    results.busyRoomKBps <= 20,
    `${results.busyRoomKBps.toFixed(1)} KB/s (median ${(busy[busy.length >> 1] ?? 0).toFixed(1)})`,
  ],
  [
    'Arriving by lift shows up upstairs < 200 ms',
    results.liftGapMs < 200,
    `${results.liftGapMs.toFixed(0)} ms worst of ${gaps.length}`,
  ],
];
if (process.env.LOAD_VERBOSE) for (const w of windows) console.log(JSON.stringify(w));
console.log(
  `\n${PEOPLE + 2} people in the ${SAMPLE} (${manifest.rooms.length} rooms), ${seconds.toFixed(0)} s measured:`,
);
for (const [name, ok, value] of checks) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}: ${value}`);
// Timings are elapsed time, so a busy machine inflates them: show how busy it was.
const pressure = cpuPressure();
if (pressure !== null) {
  console.log(
    `  (other programs kept this machine's processes waiting for a CPU ${pressure.toFixed(1)}% of the time${pressure > 1 ? ': timings are pessimistic' : ''})`,
  );
}

for (const p of [...people, observer, traveller]) await p.room.leave().catch(() => {});
service.kill('SIGTERM');
if (gcLog.length) console.log(gcLog.slice(-400).join('\n'));
api.close();
// Exit once output is flushed (process.exit() can cut off output going to a pipe).
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
setTimeout(() => process.exit(), 1000).unref();

interface Timing {
  count: number;
  p50: number;
  p99: number;
  hist: Record<string, number>;
}
interface StatsLine {
  room: string;
  clients: number;
  patchMs: Timing;
  viewsMs: Timing;
  cpu: number;
}

/** Linux CPU pressure: % of the last minute some task was waiting for a CPU. */
function cpuPressure(): number | null {
  try {
    const m = readFileSync('/proc/pressure/cpu', 'utf8').match(/^some .*avg60=([\d.]+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}
