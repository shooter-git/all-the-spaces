// Compares a plan.json made from a kit's floor plans with how the place really is (truth.json):
//   node tools/dev/onboarding-kit/compare.mjs <plan.json>             the flat
//   node tools/dev/onboarding-kit/compare.mjs building <plan.json>    the three-floor building
// Acceptance: every wall within 10 cm of the plan, on the right floor; every room reachable.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [kit, file] = process.argv.length > 3 ? process.argv.slice(2) : [null, process.argv[2]];
const here = fileURLToPath(new URL(`./${kit ? `${kit}/` : ''}`, import.meta.url));
const truth = JSON.parse(readFileSync(`${here}truth.json`, 'utf8'));
if (!file) {
  console.error('Usage: compare.mjs [building] <plan.json>');
  process.exit(2);
}
const made = JSON.parse(readFileSync(file, 'utf8'));
const { checkPlan } = await import('../../../packages/space-format/src/check.ts');

// Floors are matched by height order (the assistant may name them differently).
const byHeight = (plan) =>
  [...plan.floors].sort((a, b) => a.elevation - b.elevation).map((f) => f.key);
const madeFloors = byHeight(made);
const floorOf = new Map(byHeight(truth).map((k, i) => [k, madeFloors[i]]));
if (madeFloors.length !== truth.floors.length)
  console.log(`note  ${truth.floors.length} floors in truth, ${madeFloors.length} in the plan`);

// Line the two up: the assistant may have put the origin anywhere.
const corner = (plan) => {
  const indoor = plan.rooms.filter((r) => !r.outdoor);
  return [Math.min(...indoor.map((r) => r.rect[0])), Math.min(...indoor.map((r) => r.rect[1]))];
};
const [tx, tz] = corner(truth);
const [mx, mz] = corner(made);
const shift = (r) => [
  r.rect[0] - mx + tx,
  r.rect[1] - mz + tz,
  r.rect[2] - mx + tx,
  r.rect[3] - mz + tz,
];
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iz = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iz;
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / (area(a) + area(b) - inter);
};

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
let worst = 0;
const matched = new Map();
for (const t of truth.rooms) {
  let best = null;
  for (const r of made.rooms.filter((x) => x.floor === floorOf.get(t.floor))) {
    const score = iou(t.rect, shift(r));
    if (!best || score > best.score) best = { room: r, score };
  }
  if (!best || best.score < 0.5) {
    check(
      `${t.name} is in the plan`,
      false,
      best ? `closest: ${best.room.name} (${Math.round(best.score * 100)}% overlap)` : 'no rooms',
    );
    continue;
  }
  matched.set(t.key, best.room.key);
  const r = shift(best.room);
  const off = Math.max(...t.rect.map((v, i) => Math.abs(v - r[i])));
  worst = Math.max(worst, off);
  check(
    `${t.name} (as "${best.room.name}"): walls within ${(off * 100).toFixed(0)} cm`,
    off <= 0.1,
  );
}
check(
  `Every wall within 10 cm of the plan (worst: ${(worst * 100).toFixed(0)} cm)`,
  worst <= 0.1 && matched.size === truth.rooms.length,
);

// Doors and openings between the same rooms.
const pairs = (plan, map = (k) => k) =>
  new Set(
    plan.openings.filter((o) => o.kind !== 'window').map((o) => o.rooms.map(map).sort().join('|')),
  );
const want = pairs(truth);
const reverse = new Map([...matched].map(([t, m]) => [m, t]));
const have = pairs(made, (k) => reverse.get(k) ?? `?${k}`);
const missing = [...want].filter((p) => !have.has(p));
check('Every door and opening between rooms is there', missing.length === 0, missing.join(', '));

const { problems } = checkPlan(made);
const errors = problems.filter((p) => p.level === 'error');
check(
  'plan.json passes the checks (fits, reachable)',
  errors.length === 0,
  errors.map((e) => e.message).join(' · '),
);

for (const r of results)
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
