// Voice chat check: twelve people talking in one room of a space.
//   pnpm --filter @ats/realtime voice-check [people=12] [spaceId]
//
// Needs the dev stack (`pnpm dev`, with LiveKit). Each test person joins the space's live
// presence (with a ticket signed like the server's), stands in the same room, gets a voice pass
// from the real-time service, and joins voice in headless Chromium with a fake microphone (a
// tone). Checks: everyone hears everyone else; talking is noticed (what ducking runs on);
// walking out of the room takes you out of its voice; a pass is only ever for your own room.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { avatarColor, signTicket } from '@ats/shared';
import { Client, type Room } from '@colyseus/sdk';
import { chromium, type Page } from 'playwright';

const PEOPLE = Number(process.argv[2] ?? 12);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = Object.fromEntries(
  readFileSync(`${root}.env`, 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => [m[1], m[2]]),
);
const sql = (q: string) =>
  execFileSync(
    'docker',
    ['exec', 'ats-dev-postgres-1', 'psql', '-U', 'ats', '-d', 'ats', '-tAc', q],
    {
      encoding: 'utf8',
    },
  ).trim();
const spaceId =
  process.argv[3] ??
  sql(
    "select id from spaces where sample = 'studio-apartment' and status = 'ready' order by created_at desc limit 1",
  );
type Box = { key: string; bounds: { min: number[]; max: number[] }; neighbors: string[] };
const rooms = JSON.parse(
  sql(
    `select v.manifest->'rooms' from spaces s join space_versions v on v.id = s.current_version_id where s.id = '${spaceId}'`,
  ),
) as Box[];
// Somewhere everyone can be, and the room next door.
const here = rooms.reduce((a, b) => (area(b) > area(a) ? b : a));
const nextDoor = rooms.find((r) => here.neighbors.includes(r.key)) as Box;
const realtime = `http://127.0.0.1:${env.ATS_PORT_REALTIME ?? 45120}`;
const signal = `ws://localhost:${env.ATS_PORT_VOICE ?? 45880}`;
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail]);
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}: ${detail}`);
};

// ---- People in the space ----------------------------------------------------------------------
interface Person {
  id: string;
  room: Room;
}
async function arrive(i: number): Promise<Person> {
  const id = `voice-test-${i}`;
  const client = new Client(realtime);
  client.auth.token = signTicket(
    { sub: id, name: `Voice ${i}`, color: avatarColor(id), spaceId, shard: 0 },
    env.REALTIME_SECRET as string,
    600,
  );
  const room = await client.joinOrCreate('space', { spaceId, shard: 0 });
  stand(room, here, true);
  return { id, room };
}
function stand(room: Room, box: Box, teleport: boolean) {
  const [x0, y0, z0] = box.bounds.min as [number, number, number];
  const [x1, , z1] = box.bounds.max as [number, number, number];
  const x = x0 + 0.5 + Math.random() * (x1 - x0 - 1);
  const z = z0 + 0.5 + Math.random() * (z1 - z0 - 1);
  room.send('pose', { x, y: y0, z, yaw: 0, room: box.key, moving: false, teleport });
}
function pass(p: Person): Promise<{ room?: string; token?: string; error?: string }> {
  return new Promise((resolve) => {
    p.room.onMessage('voice', resolve);
    p.room.send('voice');
  });
}
const voiceRoomOf = (token: string) =>
  (
    JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString()) as {
      video: { room: string };
    }
  ).video.room;

console.log(`${PEOPLE} people in "${here.key}" of ${spaceId}`);
const people: Person[] = [];
for (let i = 0; i < PEOPLE; i++) people.push(await arrive(i));
await sleep(600); // poses arrive
const passes = await Promise.all(people.map(pass));
check(
  'Everyone gets a pass, for the room they are in',
  passes.every((p) => p.token && voiceRoomOf(p.token) === `space:${spaceId}:${here.key}`),
  passes[0]?.error ?? `space:…:${here.key}`,
);

// ---- Voice, in headless Chromium with fake microphones ---------------------------------------
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const lk = fileURLToPath(
  new URL('../../web/node_modules/livekit-client/dist/livekit-client.umd.js', import.meta.url),
);
const page = fileURLToPath(new URL('./voice-page.js', import.meta.url));
const pages: Page[] = [];
for (const [i, p] of passes.entries()) {
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(`http://localhost:${env.ATS_PORT_VOICE ?? 45880}/`); // a secure context, for the microphone
  await tab.addScriptTag({ path: lk });
  await tab.addScriptTag({ path: page });
  await tab.evaluate(`voiceJoin(${JSON.stringify(signal)}, ${JSON.stringify(p.token)})`);
  pages.push(tab);
  if (i === 0) console.log('  (first person in voice)');
}
const ask = (expression: string) =>
  Promise.all(pages.map((tab) => tab.evaluate(expression) as Promise<number>));
let counts = await ask('voice.heard.size');
for (let t = 0; t < 40 && counts.some((n) => n < PEOPLE - 1); t++) {
  await sleep(500);
  counts = await ask('voice.heard.size');
}
check(
  'Everyone hears everyone else',
  counts.every((n) => n === PEOPLE - 1),
  `${Math.min(...counts)}–${Math.max(...counts)} of ${PEOPLE - 1} voices each`,
);

// Sound is really arriving (not just announced).
const bytes = await ask('voiceBytes()');
check(
  'Sound arrives from everyone',
  bytes.every((b) => b > 0),
  `${Math.round(Math.min(...bytes) / 1024)} KB at least, each`,
);

await sleep(4000);
const talking = await ask('voice.talking.size');
check(
  'Talking is noticed (what ducking other sound runs on)',
  talking.every((n) => n > 0),
  `${Math.min(...talking)}+ talkers noticed by each`,
);

// ---- Privacy: voice follows you ---------------------------------------------------------------
const walker = people[0] as Person;
stand(walker.room, nextDoor, true);
let gone = false;
for (let t = 0; t < 20 && !gone; t++) {
  await sleep(250);
  gone =
    (await (pages[1] as Page).evaluate(`voice.left.has(${JSON.stringify(walker.id)})`)) === true;
}
check(
  'Walking out of the room takes you out of its voice',
  gone,
  gone ? `out within ${'~'}seconds` : 'still there',
);
const again = await pass(walker);
check(
  'A new pass is only for the room you are in now',
  !!again.token && voiceRoomOf(again.token) === `space:${spaceId}:${nextDoor.key}`,
  again.token ? voiceRoomOf(again.token).replace(spaceId, '…') : (again.error ?? '?'),
);

for (const tab of pages) await tab.evaluate('voice.room?.disconnect()').catch(() => {});
await browser.close();
for (const p of people) await p.room.leave().catch(() => {});
console.log(results.every(([, ok]) => ok) ? '\nVoice chat works.' : '\nSome checks failed.');
process.exitCode = results.every(([, ok]) => ok) ? 0 : 1;
setTimeout(() => process.exit(), 500).unref();

function area(r: Box) {
  const [x0 = 0, , z0 = 0] = r.bounds.min;
  const [x1 = 0, , z1 = 0] = r.bounds.max;
  return (x1 - x0) * (z1 - z0);
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
