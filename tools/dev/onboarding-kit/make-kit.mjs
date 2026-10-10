// Draws plain, estate-agent-style floor plans from a kit's truth.json (the place as it really is),
// for testing onboarding: give the plans and description.md to a new place, and compare what the
// assistant builds with compare.mjs.
//   node tools/dev/onboarding-kit/make-kit.mjs            the flat (one floor) → plan.jpg
//   node tools/dev/onboarding-kit/make-kit.mjs building   the building → building/plan-1-ground-floor.jpg …
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = fileURLToPath(
  new URL(`./${process.argv[2] ? `${process.argv[2]}/` : ''}`, import.meta.url),
);
const all = JSON.parse(readFileSync(`${here}truth.json`, 'utf8'));
const PX = 64; // pixels per metre (the assistant has to work this out from the drawing)
const M = 90; // margin
const T = 0.12; // wall thickness in metres
const xs = all.rooms.flatMap((r) => [r.rect[0], r.rect[2]]);
const zs = all.rooms.flatMap((r) => [r.rect[1], r.rect[3]]);
const [minX, maxX, minZ, maxZ] = [
  Math.min(...xs),
  Math.max(...xs),
  Math.min(...zs),
  Math.max(...zs),
];
const W = Math.round((maxX - minX) * PX + 2 * M);
const H = Math.round((maxZ - minZ) * PX + 2 * M + 40);
const px = (x) => M + (x - minX) * PX;
const pz = (z) => M + (z - minZ) * PX;
const floors = all.floors;
const elevation = new Map(floors.map((f) => [f.key, f.elevation]));
const allRooms = new Map(all.rooms.map((r) => [r.key, r]));
/** Which floor an opening is on: its level, or the higher of its two rooms' floors. */
const openingFloor = (o) =>
  o.level ??
  o.rooms.map((k) => allRooms.get(k).floor).sort((a, b) => elevation.get(b) - elevation.get(a))[0];
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

for (const [index, floor] of floors.entries()) {
  const out = [];
  // This floor's rooms (stairwells show on both floors they join).
  const plan = {
    ...all,
    rooms: all.rooms.filter((r) => r.floor === floor.key || r.spansTo === floor.key),
    openings: all.openings.filter((o) =>
      o.kind === 'window'
        ? allRooms.get(o.room)?.floor === floor.key
        : openingFloor(o) === floor.key,
    ),
  };
  const rooms = new Map(plan.rooms.map((r) => [r.key, r]));

  // Walls: each room's outline, drawn thick (shared walls overlap into one).
  for (const r of plan.rooms) {
    const [x0, z0, x1, z1] = r.rect;
    const t = r.outdoor ? T * 0.5 : T;
    out.push(
      `<rect x="${px(x0) - (t * PX) / 2}" y="${pz(z0) - (t * PX) / 2}" width="${(x1 - x0 + t) * PX}" height="${(z1 - z0 + t) * PX}" fill="none" stroke="#1d1c20" stroke-width="${t * PX}"/>`,
    );
  }
  // Openings: clear the wall, then draw doors (leaf and swing) and windows (thin double lines).
  const wallOf = (a, b) => {
    const eps = 1e-3;
    const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > eps;
    if (ov(a.rect[0], a.rect[2], b.rect[0], b.rect[2]) && Math.abs(a.rect[1] - b.rect[3]) < eps)
      return { horiz: true, at: a.rect[1] };
    if (ov(a.rect[0], a.rect[2], b.rect[0], b.rect[2]) && Math.abs(a.rect[3] - b.rect[1]) < eps)
      return { horiz: true, at: a.rect[3] };
    if (ov(a.rect[1], a.rect[3], b.rect[1], b.rect[3]) && Math.abs(a.rect[2] - b.rect[0]) < eps)
      return { horiz: false, at: a.rect[2] };
    return { horiz: false, at: a.rect[0] };
  };
  for (const o of plan.openings) {
    if (o.kind === 'window') {
      const r = rooms.get(o.room);
      const [x0, z0, x1, z1] = r.rect;
      const horiz = o.side === 'north' || o.side === 'south';
      const at = { north: z0, south: z1, west: x0, east: x1 }[o.side];
      const [a, b] = [o.at - o.width / 2, o.at + o.width / 2];
      const rect = horiz
        ? `x="${px(a)}" y="${pz(at) - (T * PX) / 2}" width="${o.width * PX}" height="${T * PX}"`
        : `x="${px(at) - (T * PX) / 2}" y="${pz(a)}" width="${T * PX}" height="${o.width * PX}"`;
      out.push(`<rect ${rect} fill="#fff" stroke="#1d1c20" stroke-width="1.5"/>`);
      out.push(
        horiz
          ? `<line x1="${px(a)}" y1="${pz(at)}" x2="${px(b)}" y2="${pz(at)}" stroke="#1d1c20" stroke-width="1.5"/>`
          : `<line x1="${px(at)}" y1="${pz(a)}" x2="${px(at)}" y2="${pz(b)}" stroke="#1d1c20" stroke-width="1.5"/>`,
      );
      continue;
    }
    const [a, b] = o.rooms.map((k) => rooms.get(k));
    const wall = wallOf(a, b);
    const w = o.width ?? 0.9;
    const along = wall.horiz ? o.at[0] : o.at[1];
    const s = along - w / 2;
    out.push(
      wall.horiz
        ? `<rect x="${px(s)}" y="${pz(wall.at) - (T * PX) / 2 - 1}" width="${w * PX}" height="${T * PX + 2}" fill="#fff"/>`
        : `<rect x="${px(wall.at) - (T * PX) / 2 - 1}" y="${pz(s)}" width="${T * PX + 2}" height="${w * PX}" fill="#fff"/>`,
    );
    if (o.kind === 'door') {
      // Hinged at the start; swings into the first room.
      const into = wall.horiz ? (a.rect[1] === wall.at ? 1 : -1) : a.rect[0] === wall.at ? 1 : -1;
      if (wall.horiz) {
        const hx = px(s),
          hy = pz(wall.at),
          r = w * PX;
        out.push(
          `<line x1="${hx}" y1="${hy}" x2="${hx}" y2="${hy + into * r}" stroke="#1d1c20" stroke-width="2"/>`,
        );
        out.push(
          `<path d="M${hx + r} ${hy} A${r} ${r} 0 0 ${into > 0 ? 1 : 0} ${hx} ${hy + into * r}" fill="none" stroke="#1d1c20" stroke-width="1" stroke-dasharray="4 3"/>`,
        );
      } else {
        const hx = px(wall.at),
          hy = pz(s),
          r = w * PX;
        out.push(
          `<line x1="${hx}" y1="${hy}" x2="${hx + into * r}" y2="${hy}" stroke="#1d1c20" stroke-width="2"/>`,
        );
        out.push(
          `<path d="M${hx} ${hy + r} A${r} ${r} 0 0 ${into > 0 ? 0 : 1} ${hx + into * r} ${hy}" fill="none" stroke="#1d1c20" stroke-width="1" stroke-dasharray="4 3"/>`,
        );
      }
    }
  }
  // Room names and sizes, as on an agent's plan.
  for (const r of plan.rooms) {
    const [x0, z0, x1, z1] = r.rect;
    const cx = px((x0 + x1) / 2),
      cy = pz((z0 + z1) / 2);
    const big = (x1 - x0) * PX > 150;
    out.push(
      `<text x="${cx}" y="${cy - 4}" font-family="Helvetica, Arial, sans-serif" font-size="${big ? 17 : 13}" font-weight="700" text-anchor="middle" fill="#1d1c20">${r.name.toUpperCase()}</text>`,
    );
    out.push(
      `<text x="${cx}" y="${cy + 16}" font-family="Helvetica, Arial, sans-serif" font-size="${big ? 14 : 11}" text-anchor="middle" fill="#1d1c20">${(x1 - x0).toFixed(2)}m × ${(z1 - z0).toFixed(2)}m</text>`,
    );
  }
  // Stairs (treads, and which way is up) and the lift.
  for (const st of all.stairs ?? []) {
    if (st.from !== floor.key && st.to !== floor.key) continue;
    const d = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[st.direction];
    const lat = st.direction === 'north' || st.direction === 'south' ? [1, 0] : [0, 1];
    const n = Math.round(st.run / 0.28);
    for (let i = 0; i <= n; i++) {
      const a = st.run * (i / n);
      const p = (side) => [
        st.start[0] + d[0] * a + lat[0] * side,
        st.start[1] + d[1] * a + lat[1] * side,
      ];
      const [x1, z1] = p(-st.width / 2);
      const [x2, z2] = p(st.width / 2);
      out.push(
        `<line x1="${px(x1)}" y1="${pz(z1)}" x2="${px(x2)}" y2="${pz(z2)}" stroke="#1d1c20" stroke-width="1"/>`,
      );
    }
    const [ax, az] = [st.start[0] + d[0] * st.run * 0.12, st.start[1] + d[1] * st.run * 0.12];
    out.push(
      `<text x="${px(ax) + st.width * PX * 0.7}" y="${pz(az)}" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="#1d1c20">${st.from === floor.key ? 'UP' : 'DOWN'}</text>`,
    );
  }
  for (const e of all.elevators ?? [])
    for (const stop of e.stops) {
      if (allRooms.get(stop.room)?.floor !== floor.key) continue;
      const [cx, cz] = stop.at;
      const h = 0.7;
      out.push(
        `<rect x="${px(cx - h)}" y="${pz(cz - h)}" width="${2 * h * PX}" height="${2 * h * PX}" fill="none" stroke="#1d1c20" stroke-width="2"/>`,
        `<line x1="${px(cx - h)}" y1="${pz(cz - h)}" x2="${px(cx + h)}" y2="${pz(cz + h)}" stroke="#1d1c20" stroke-width="1"/>`,
        `<line x1="${px(cx + h)}" y1="${pz(cz - h)}" x2="${px(cx - h)}" y2="${pz(cz + h)}" stroke="#1d1c20" stroke-width="1"/>`,
        `<text x="${px(cx)}" y="${pz(cz + h) + 14}" font-family="Helvetica, Arial, sans-serif" font-size="11" text-anchor="middle" fill="#1d1c20">LIFT</text>`,
      );
    }
  // Which floor this is, the front door, and a scale bar.
  if (floors.length > 1)
    out.push(
      `<text x="${M}" y="${M - 50}" font-family="Helvetica, Arial, sans-serif" font-size="20" font-weight="700" fill="#1d1c20">${floor.name.toUpperCase()}</text>`,
    );
  for (const sp of all.spawns)
    if (allRooms.get(sp.room)?.floor === floor.key)
      out.push(
        `<text x="${px(sp.at[0])}" y="${sp.at[1] < (minZ + maxZ) / 2 ? pz(minZ) - 22 : pz(maxZ) + 38}" font-family="Helvetica, Arial, sans-serif" font-size="13" text-anchor="middle" fill="#1d1c20">${sp.at[1] < (minZ + maxZ) / 2 ? '▼' : '▲'} ENTRANCE</text>`,
      );
  const sy = H - 30;
  for (let i = 0; i < 3; i++)
    out.push(
      `<rect x="${M + i * PX}" y="${sy}" width="${PX}" height="8" fill="${i % 2 ? '#fff' : '#1d1c20'}" stroke="#1d1c20"/>`,
    );
  for (let i = 0; i <= 3; i++)
    out.push(
      `<text x="${M + i * PX}" y="${sy - 5}" font-family="Helvetica, Arial, sans-serif" font-size="11" text-anchor="middle" fill="#1d1c20">${i}</text>`,
    );
  out.push(
    `<text x="${M + 3 * PX + 14}" y="${sy + 8}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#1d1c20">metres</text>`,
  );
  out.push(
    `<text x="${W - M}" y="${H - 22}" font-family="Helvetica, Arial, sans-serif" font-size="11" text-anchor="end" fill="#666">For illustration only. Not to scale unless stated.</text>`,
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>${out.join('')}</svg>`;
  // A photographed-plan look: slightly soft, as JPEG.
  const name = floors.length > 1 ? `plan-${index + 1}-${slug(floor.name)}.jpg` : 'plan.jpg';
  await sharp(Buffer.from(svg)).blur(0.4).jpeg({ quality: 88 }).toFile(`${here}${name}`);
  console.log(`Wrote ${here}${name} (${W}×${H}, ${PX} px per metre, not given to the assistant)`);
}
