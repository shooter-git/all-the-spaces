import type { MaterialName, PlanFurniture } from '@ats/space-format';
import type { MeshBuilder, V3, YTransform } from './geometry.ts';

/**
 * Simple, recognisable stand-ins for furniture, built from boxes, cylinders and spheres.
 * Local coordinates: origin at the centre of the footprint on the floor, front facing +Z.
 * (Phase 6 replaces these with CC0 models chosen from the Architect's photos.)
 */

type Size = [number, number, number];
interface Ctx {
  b: MeshBuilder;
  t: YTransform;
  w: number;
  h: number;
  d: number;
  main: MaterialName;
  accent: MaterialName;
  /** LOD1 drops fine detail. */
  detail: boolean;
}

const DEFAULTS: Record<
  PlanFurniture['kind'],
  { size: Size; main: MaterialName; accent: MaterialName }
> = {
  sofa: { size: [2.0, 0.85, 0.9], main: 'fabric-linen', accent: 'walnut' },
  armchair: { size: [0.85, 0.85, 0.85], main: 'fabric-indigo', accent: 'oak' },
  bed: { size: [1.6, 0.55, 2.1], main: 'oak', accent: 'fabric-linen' },
  table: { size: [1.4, 0.75, 0.8], main: 'oak', accent: 'oak' },
  'coffee-table': { size: [1.0, 0.4, 0.6], main: 'walnut', accent: 'walnut' },
  chair: { size: [0.45, 0.88, 0.5], main: 'oak', accent: 'fabric-moss' },
  desk: { size: [1.4, 0.75, 0.7], main: 'oak', accent: 'metal-dark' },
  shelf: { size: [0.9, 1.9, 0.35], main: 'walnut', accent: 'paper' },
  cabinet: { size: [1.2, 0.8, 0.45], main: 'oak', accent: 'metal-dark' },
  counter: { size: [2.4, 0.92, 0.62], main: 'plaster-warm', accent: 'tile-light' },
  plant: { size: [0.45, 1.2, 0.45], main: 'ceramic', accent: 'leaf' },
  rug: { size: [2.0, 0.012, 1.4], main: 'carpet-stone', accent: 'carpet-stone' },
  lamp: { size: [0.4, 1.6, 0.4], main: 'metal-dark', accent: 'paper' },
  tv: { size: [1.2, 0.7, 0.05], main: 'metal-dark', accent: 'metal-dark' },
  frame: { size: [0.6, 0.8, 0.03], main: 'walnut', accent: 'paper' },
  box: { size: [0.5, 0.5, 0.5], main: 'oak', accent: 'oak' },
};

export function furnitureSize(item: PlanFurniture): Size {
  return item.size ?? DEFAULTS[item.kind].size;
}

/** True for items people could bump into (used for collision). */
export function isObstacle(item: PlanFurniture): boolean {
  return !['rug', 'frame', 'tv'].includes(item.kind);
}

export function furnitureTransform(item: PlanFurniture, floorY: number): YTransform {
  const [, h] = furnitureSize(item);
  const y = item.mountHeight !== undefined ? floorY + item.mountHeight - h / 2 : floorY;
  return { angle: (item.rotation * Math.PI) / 180, origin: [item.at[0], y, item.at[1]] };
}

export function buildFurniture(
  b: MeshBuilder,
  item: PlanFurniture,
  floorY: number,
  detail: boolean,
) {
  const def = DEFAULTS[item.kind];
  const [w, h, d] = furnitureSize(item);
  const ctx: Ctx = {
    b,
    t: furnitureTransform(item, floorY),
    w,
    h,
    d,
    main: item.material ?? def.main,
    accent: item.accent ?? def.accent,
    detail,
  };
  BUILDERS[item.kind](ctx);
}

const box = (c: Ctx, m: MaterialName, min: V3, max: V3) => c.b.box(m, min, max, c.t);
const legs = (c: Ctx, m: MaterialName, height: number, inset: number, size = 0.05) => {
  if (!c.detail) return;
  const x = c.w / 2 - inset;
  const z = c.d / 2 - inset;
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    box(
      c,
      m,
      [sx * x - size / 2, 0, sz * z - size / 2],
      [sx * x + size / 2, height, sz * z + size / 2],
    );
  }
};

const BUILDERS: Record<PlanFurniture['kind'], (c: Ctx) => void> = {
  sofa: (c) => {
    const { w, h, d } = c;
    box(c, c.main, [-w / 2, 0.12, -d / 2], [w / 2, 0.45, d / 2]); // seat
    box(c, c.main, [-w / 2, 0.12, -d / 2], [w / 2, h, -d / 2 + 0.22]); // back
    box(c, c.main, [-w / 2, 0.12, -d / 2], [-w / 2 + 0.18, 0.62, d / 2]); // arms
    box(c, c.main, [w / 2 - 0.18, 0.12, -d / 2], [w / 2, 0.62, d / 2]);
    if (c.detail) {
      box(c, c.accent, [-w / 2 + 0.05, 0, -d / 2 + 0.05], [w / 2 - 0.05, 0.12, d / 2 - 0.05]);
      for (const x of [-w / 4, w / 4])
        c.b.box(c.main, [x - 0.35, 0.45, -d / 2 + 0.2], [x + 0.35, 0.58, d / 2 - 0.05], c.t);
    }
  },
  armchair: (c) => {
    const { w, h, d } = c;
    box(c, c.main, [-w / 2, 0.15, -d / 2], [w / 2, 0.45, d / 2]);
    box(c, c.main, [-w / 2, 0.15, -d / 2], [w / 2, h, -d / 2 + 0.18]);
    box(c, c.main, [-w / 2, 0.15, -d / 2], [-w / 2 + 0.14, 0.62, d / 2]);
    box(c, c.main, [w / 2 - 0.14, 0.15, -d / 2], [w / 2, 0.62, d / 2]);
    legs(c, c.accent, 0.15, 0.08, 0.04);
  },
  bed: (c) => {
    const { w, h, d } = c;
    box(c, c.main, [-w / 2, 0.08, -d / 2], [w / 2, 0.32, d / 2]); // frame
    box(c, c.accent, [-w / 2 + 0.04, 0.32, -d / 2 + 0.04], [w / 2 - 0.04, h, d / 2 - 0.04]); // mattress
    box(c, c.main, [-w / 2 - 0.03, 0, -d / 2 - 0.06], [w / 2 + 0.03, 1.05, -d / 2]); // headboard
    if (c.detail) {
      box(c, 'fabric-indigo', [-w / 2 + 0.04, h, -d / 4], [w / 2 - 0.04, h + 0.05, d / 2 - 0.04]); // duvet
      for (const x of [-w / 4, w / 4])
        box(c, 'paper', [x - 0.3, h, -d / 2 + 0.1], [x + 0.3, h + 0.12, -d / 2 + 0.45]);
    }
  },
  table: (c) => {
    box(c, c.main, [-c.w / 2, c.h - 0.04, -c.d / 2], [c.w / 2, c.h, c.d / 2]);
    legs(c, c.main, c.h - 0.04, 0.07);
  },
  'coffee-table': (c) => {
    box(c, c.main, [-c.w / 2, c.h - 0.05, -c.d / 2], [c.w / 2, c.h, c.d / 2]);
    box(c, c.main, [-c.w / 2 + 0.06, 0.08, -c.d / 2 + 0.06], [c.w / 2 - 0.06, 0.1, c.d / 2 - 0.06]);
    legs(c, c.main, c.h - 0.05, 0.05, 0.04);
  },
  chair: (c) => {
    box(c, c.main, [-c.w / 2, 0.43, -c.d / 2], [c.w / 2, 0.47, c.d / 2]);
    box(c, c.main, [-c.w / 2, 0.47, -c.d / 2], [c.w / 2, c.h, -c.d / 2 + 0.04]);
    if (c.detail)
      box(
        c,
        c.accent,
        [-c.w / 2 + 0.03, 0.47, -c.d / 2 + 0.05],
        [c.w / 2 - 0.03, 0.51, c.d / 2 - 0.03],
      );
    legs(c, c.main, 0.43, 0.03, 0.035);
  },
  desk: (c) => {
    box(c, c.main, [-c.w / 2, c.h - 0.04, -c.d / 2], [c.w / 2, c.h, c.d / 2]);
    box(
      c,
      c.accent,
      [-c.w / 2 + 0.02, 0, -c.d / 2 + 0.05],
      [-c.w / 2 + 0.06, c.h - 0.04, c.d / 2 - 0.05],
    );
    box(
      c,
      c.accent,
      [c.w / 2 - 0.06, 0, -c.d / 2 + 0.05],
      [c.w / 2 - 0.02, c.h - 0.04, c.d / 2 - 0.05],
    );
  },
  shelf: (c) => {
    const { w, h, d } = c;
    box(c, c.main, [-w / 2, 0, -d / 2], [-w / 2 + 0.03, h, d / 2]);
    box(c, c.main, [w / 2 - 0.03, 0, -d / 2], [w / 2, h, d / 2]);
    box(c, c.main, [-w / 2, 0, -d / 2], [w / 2, h, -d / 2 + 0.015]);
    const shelves = 5;
    for (let i = 0; i < shelves; i++) {
      const y = (i * (h - 0.03)) / (shelves - 1);
      box(c, c.main, [-w / 2, y, -d / 2], [w / 2, y + 0.03, d / 2]);
      if (!c.detail || i === shelves - 1) continue;
      // A row of books in quiet colours.
      let x = -w / 2 + 0.05;
      let n = 0;
      const colours: MaterialName[] = [
        'fabric-indigo',
        'paper',
        'fabric-moss',
        'walnut',
        'fabric-linen',
      ];
      while (x < w / 2 - 0.12) {
        const bw = 0.025 + ((n * 7) % 5) * 0.008;
        const bh = 0.2 + ((n * 3) % 4) * 0.025;
        box(
          c,
          colours[n % colours.length] as MaterialName,
          [x, y + 0.03, -d / 2 + 0.04],
          [x + bw, y + 0.03 + bh, d / 2 - 0.05],
        );
        x += bw + 0.004;
        n++;
      }
    }
  },
  cabinet: (c) => {
    box(c, c.main, [-c.w / 2, 0.08, -c.d / 2], [c.w / 2, c.h, c.d / 2]);
    if (c.detail)
      box(
        c,
        c.accent,
        [-c.w / 2 + 0.03, 0, -c.d / 2 + 0.03],
        [c.w / 2 - 0.03, 0.08, c.d / 2 - 0.03],
      );
  },
  counter: (c) => {
    box(c, c.main, [-c.w / 2, 0, -c.d / 2], [c.w / 2, c.h - 0.04, c.d / 2]);
    box(
      c,
      c.accent,
      [-c.w / 2 - 0.02, c.h - 0.04, -c.d / 2],
      [c.w / 2 + 0.02, c.h, c.d / 2 + 0.02],
    );
  },
  plant: (c) => {
    const potH = Math.min(0.4, c.h * 0.35);
    c.b.cylinder(c.main, [0, 0, 0], c.w * 0.32, c.w * 0.4, potH, c.detail ? 18 : 10, c.t);
    const r = c.w * 0.55;
    c.b.sphere(
      c.accent,
      [0, potH + (c.h - potH) * 0.55, 0],
      r,
      c.detail ? 7 : 5,
      c.detail ? 12 : 8,
      c.t,
    );
    if (c.detail)
      c.b.sphere(c.accent, [r * 0.3, potH + (c.h - potH) * 0.85, -r * 0.2], r * 0.6, 6, 10, c.t);
  },
  rug: (c) => box(c, c.main, [-c.w / 2, 0.001, -c.d / 2], [c.w / 2, c.h, c.d / 2]),
  lamp: (c) => {
    c.b.cylinder(c.main, [0, 0, 0], 0.14, 0.14, 0.03, 16, c.t);
    c.b.cylinder(c.main, [0, 0.03, 0], 0.012, 0.012, c.h - 0.33, 8, c.t);
    c.b.cylinder(c.accent, [0, c.h - 0.32, 0], c.w / 2, c.w * 0.36, 0.3, c.detail ? 20 : 10, c.t);
  },
  tv: (c) => box(c, c.main, [-c.w / 2, 0, -c.d / 2], [c.w / 2, c.h, c.d / 2]),
  frame: (c) => {
    box(c, c.main, [-c.w / 2, 0, -c.d / 2], [c.w / 2, c.h, c.d / 2]);
    if (c.detail)
      box(
        c,
        c.accent,
        [-c.w / 2 + 0.05, 0.05, c.d / 2],
        [c.w / 2 - 0.05, c.h - 0.05, c.d / 2 + 0.004],
      );
  },
  box: (c) => box(c, c.main, [-c.w / 2, 0, -c.d / 2], [c.w / 2, c.h, c.d / 2]),
};
