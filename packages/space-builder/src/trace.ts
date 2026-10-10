import { type PlanRoom, type SpacePlan, sharedWall, type Trace } from '@ats/space-format';
import sharp from 'sharp';
import { furnitureSize } from './furniture.ts';

export { Trace, Traces, traceFor } from '@ats/space-format';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const COLOURS = [
  '#3f5b7c',
  '#9a5b45',
  '#4f7355',
  '#7a5c9a',
  '#a8782a',
  '#2f7f86',
  '#a63f4d',
  '#5b6b2f',
];

/**
 * The plan drawn over its floor-plan image (or on its own): rooms, doors, windows, furniture and
 * starting points, with a 1 m grid and scale bar. It's how the assistant (and the Architect)
 * check that the plan matches the drawing.
 */
export async function renderOverlay(
  plan: SpacePlan,
  opts: { trace?: Trace | null; image?: Uint8Array | null; floor?: string } = {},
): Promise<Buffer> {
  const floor = opts.floor ?? opts.trace?.floor ?? plan.floors[0]?.key;
  const rooms = plan.rooms.filter((r) => r.floor === floor || r.spansTo === floor);
  let width: number;
  let height: number;
  let toPx: (x: number, z: number) => [number, number];
  let pxPerM: number;
  let background: Buffer | null = null;
  if (opts.trace && opts.image) {
    const meta = await sharp(opts.image).metadata();
    width = meta.width ?? 1000;
    height = meta.height ?? 1000;
    pxPerM = 1 / opts.trace.metresPerPixel;
    const [ox, oy] = opts.trace.origin;
    toPx = (x, z) => [ox + x * pxPerM, oy + z * pxPerM];
    // Faded, so the plan stands out on top of it.
    background = await sharp(opts.image).rotate().grayscale().linear(0.55, 115).png().toBuffer();
  } else {
    const xs = rooms.flatMap((r) => [r.rect[0], r.rect[2]]);
    const zs = rooms.flatMap((r) => [r.rect[1], r.rect[3]]);
    const [minX, maxX, minZ, maxZ] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...zs),
      Math.max(...zs),
    ];
    pxPerM = Math.max(20, Math.min(120, 1100 / Math.max(maxX - minX, maxZ - minZ, 1)));
    width = Math.ceil((maxX - minX) * pxPerM + 120);
    height = Math.ceil((maxZ - minZ) * pxPerM + 120);
    toPx = (x, z) => [60 + (x - minX) * pxPerM, 60 + (z - minZ) * pxPerM];
  }
  const font = Math.max(11, Math.min(28, pxPerM * 0.22));
  const parts: string[] = [];
  const colour = new Map(rooms.map((r, i) => [r.key, COLOURS[i % COLOURS.length] as string]));

  // A 1 m grid, anchored at the plan's origin.
  const [gx0, gy0] = toPx(0, 0);
  const grid: string[] = [];
  for (let x = gx0 % pxPerM; x < width; x += pxPerM) grid.push(`M${x.toFixed(1)} 0V${height}`);
  for (let y = gy0 % pxPerM; y < height; y += pxPerM) grid.push(`M0 ${y.toFixed(1)}H${width}`);
  parts.push(
    `<path d="${grid.join('')}" stroke="#3f5b7c" stroke-opacity="0.12" stroke-width="1"/>`,
  );

  for (const r of rooms) {
    const [x0, y0] = toPx(r.rect[0], r.rect[1]);
    const [x1, y1] = toPx(r.rect[2], r.rect[3]);
    const c = colour.get(r.key) as string;
    parts.push(
      `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${c}" fill-opacity="0.12" stroke="${c}" stroke-width="${Math.max(2, pxPerM * 0.04)}"${r.outdoor ? ' stroke-dasharray="10 6"' : ''}/>`,
      // Top-left, so it doesn't sit on the drawing's own labels.
      `<text x="${x0 + font * 0.4}" y="${y0 + font * 1.2}" font-size="${font * 0.8}" fill="${c}" font-family="sans-serif" font-weight="700">${esc(r.name)}</text>`,
      `<text x="${x0 + font * 0.4}" y="${y0 + font * 2.1}" font-size="${font * 0.62}" fill="${c}" font-family="sans-serif">${esc(`${(r.rect[2] - r.rect[0]).toFixed(2)} × ${(r.rect[3] - r.rect[1]).toFixed(2)} m`)}</text>`,
    );
  }
  const byKey = new Map(plan.rooms.map((r) => [r.key, r]));
  for (const o of plan.openings) {
    if (o.kind === 'window') {
      const r = byKey.get(o.room);
      if (!r || !rooms.includes(r)) continue;
      const [x0, z0, x1, z1] = r.rect;
      const a = o.at - o.width / 2;
      const b = o.at + o.width / 2;
      const [p, q] =
        o.side === 'north'
          ? [toPx(a, z0), toPx(b, z0)]
          : o.side === 'south'
            ? [toPx(a, z1), toPx(b, z1)]
            : o.side === 'west'
              ? [toPx(x0, a), toPx(x0, b)]
              : [toPx(x1, a), toPx(x1, b)];
      parts.push(
        `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="#2f7f86" stroke-width="${Math.max(5, pxPerM * 0.1)}" stroke-linecap="butt"/>`,
      );
      continue;
    }
    const [k1, k2] = o.rooms;
    const a = byKey.get(k1);
    const b = byKey.get(k2);
    if (!a || !b || (!rooms.includes(a) && !rooms.includes(b))) continue;
    const wall = sharedWall(a as PlanRoom, b as PlanRoom);
    const along = wall && (wall.side === 'north' || wall.side === 'south') ? o.at[0] : o.at[1];
    const horizontal = wall ? wall.side === 'north' || wall.side === 'south' : true;
    const across = wall ? wall.at : horizontal ? o.at[1] : o.at[0];
    const [p, q] = horizontal
      ? [toPx(along - o.width / 2, across), toPx(along + o.width / 2, across)]
      : [toPx(across, along - o.width / 2), toPx(across, along + o.width / 2)];
    // A gap in the wall, marked in white with a coloured edge (red when it isn't on a shared wall).
    const mark = wall ? (o.kind === 'door' ? '#a8782a' : '#4f7355') : '#d0343f';
    parts.push(
      `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="#fff" stroke-width="${Math.max(7, pxPerM * 0.14)}"/>`,
      `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${mark}" stroke-width="${Math.max(3, pxPerM * 0.05)}" stroke-dasharray="${o.kind === 'door' ? 'none' : '6 4'}"/>`,
    );
  }
  for (const f of plan.furniture) {
    const r = byKey.get(f.room);
    if (!r || !rooms.includes(r)) continue;
    const [w, , d] = furnitureSize(f);
    const [cx, cy] = toPx(f.at[0], f.at[1]);
    parts.push(
      `<g transform="translate(${cx} ${cy}) rotate(${-f.rotation})"><rect x="${(-w / 2) * pxPerM}" y="${(-d / 2) * pxPerM}" width="${w * pxPerM}" height="${d * pxPerM}" fill="#2e2c33" fill-opacity="0.08" stroke="#2e2c33" stroke-opacity="0.6" stroke-width="1.5"/></g>`,
      `<text x="${cx}" y="${cy + font * 0.3}" font-size="${font * 0.62}" text-anchor="middle" fill="#2e2c33" font-family="sans-serif">${esc(f.label)}</text>`,
    );
  }
  for (const s of plan.spawns) {
    const r = byKey.get(s.room);
    if (!r || !rooms.includes(r)) continue;
    const [cx, cy] = toPx(s.at[0], s.at[1]);
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="${Math.max(6, pxPerM * 0.15)}" fill="#a63f4d" stroke="#fff" stroke-width="2"/>`,
    );
  }
  // Scale bar: 1 m.
  parts.push(
    `<g transform="translate(20 ${height - 24})"><rect x="-8" y="-${font + 8}" width="${pxPerM + 16}" height="${font + 20}" fill="#fff" fill-opacity="0.8" rx="4"/><line x1="0" y1="0" x2="${pxPerM}" y2="0" stroke="#2e2c33" stroke-width="3"/><text x="${pxPerM / 2}" y="-6" font-size="${font * 0.8}" text-anchor="middle" font-family="sans-serif" fill="#2e2c33">1 m</text></g>`,
  );
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`,
  );
  const base = background
    ? sharp(background)
    : sharp({ create: { width, height, channels: 3, background: '#fbf9f7' } });
  return base
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/** Metres per pixel from two points on the image and the real distance between them. */
export function scaleFrom(a: [number, number], b: [number, number], metres: number) {
  const px = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (px < 5 || !(metres > 0))
    throw new Error('Pick two points at least a few pixels apart, and a length in metres.');
  return metres / px;
}
