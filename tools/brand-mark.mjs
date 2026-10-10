// Draws the All the Spaces mark: three sheets of washi, one behind another, each a little further
// along — spaces behind spaces. Writes the masters in brand/ (then run `pnpm brand:build`).
//   node tools/brand-mark.mjs
// Every edge is generated from a fixed seed, so the drawing is the same on every run.
import { writeFileSync } from 'node:fs';

const PAPER = '#F5F1EE';

/**
 * The three sheets, back to front: colour, opacity, and their four corners (each is drawn as a soft
 * curve through its corners, so the sheets are pillowy, like washi held up to the light). The three
 * spaces: reality (warm sand), the place we share (sage), and what we create in it (indigo).
 */
const SHEETS = [
  {
    fill: '#DDB08F',
    opacity: 0.85,
    corners: [
      [92, 178],
      [302, 158],
      [322, 400],
      [108, 424],
    ],
    seed: 6,
  },
  {
    fill: '#94BBA0',
    opacity: 0.78,
    corners: [
      [168, 130],
      [372, 120],
      [386, 354],
      [180, 370],
    ],
    seed: 7,
  },
  {
    fill: '#4A5FA6',
    opacity: 0.92,
    corners: [
      [250, 88],
      [424, 84],
      [432, 294],
      [262, 306],
    ],
    seed: 8,
  },
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Smooth noise along a closed loop (period 1). */
function loopNoise(seed, knots) {
  const r = rng(seed);
  const k = Array.from({ length: knots }, () => r() * 2 - 1);
  return (t) => {
    const x = (((t % 1) + 1) % 1) * knots;
    const i = Math.floor(x);
    const f = x - i;
    const a = k[i % knots];
    const b = k[(i + 1) % knots];
    return a + (b - a) * f * f * (3 - 2 * f);
  };
}

/** Closed Catmull-Rom curve through points, sampled densely. */
function loop(pts, samples) {
  const n = pts.length;
  const out = [];
  for (let s = 0; s < samples; s++) {
    const u = (s / samples) * n;
    const i = Math.floor(u);
    const t = u - i;
    const p = (k) => pts[(i + k + n) % n];
    const f = (a, b, c, d) =>
      0.5 *
      (2 * b +
        (-a + c) * t +
        (2 * a - 5 * b + 4 * c - d) * t * t +
        (-a + 3 * b - 3 * c + d) * t ** 3);
    out.push([0, 1].map((k) => f(p(-1)[k], p(0)[k], p(1)[k], p(2)[k])));
  }
  return out;
}

/**
 * One sheet: a soft curve through its corners (each nudged a little, by hand as it were), with a
 * faint torn edge when `detail` is 1 (none at favicon sizes).
 */
function sheet({ corners, seed }, detail = 1) {
  const r = rng(seed);
  const jittered = corners.map(([x, y]) => [x + (r() - 0.5) * 14, y + (r() - 0.5) * 14]);
  const pts = loop(jittered, 480);
  const deckle = loopNoise(seed + 1, 120);
  const n = pts.length;
  const edged = pts.map(([x, y], i) => {
    const [ax, ay] = pts[(i - 1 + n) % n];
    const [bx, by] = pts[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const out = detail * deckle(i / n) * 0.9;
    return [x + ((by - ay) / len) * out, y - ((bx - ax) / len) * out];
  });
  return `M${edged.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`;
}

const sheets = (detail, colour) =>
  SHEETS.map(
    (s, i) =>
      `<path d="${sheet(s, detail)}" fill="${colour ?? s.fill}" fill-opacity="${colour ? [0.35, 0.6, 1][i] : s.opacity}"/>`,
  ).join('');

const svg = (viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="All the Spaces">${body}</svg>\n`;

// The mark, on its own.
writeFileSync('brand/mark.svg', svg('0 0 512 512', sheets(1)));
// One colour (notification badges, monochrome icons): the sheets in layered opacity.
writeFileSync('brand/mark-mono.svg', svg('0 0 512 512', sheets(1, 'currentColor')));
/** The sheets at `scale`, centred in a 512 square (the drawing's middle is at 262, 254). */
const centred = (scale, detail) =>
  `<g transform="translate(${(256 - 262 * scale).toFixed(1)} ${(256 - 254 * scale).toFixed(1)}) scale(${scale})">${sheets(detail)}</g>`;
// The app icon: on paper, the sheets filling most of it.
writeFileSync(
  'brand/icon.svg',
  svg(
    '0 0 512 512',
    `<rect width="512" height="512" rx="112" fill="${PAPER}"/>${centred(0.94, 1)}`,
  ),
);
// Favicon (16–48 px): clean edges, larger still in its square.
writeFileSync(
  'brand/favicon.svg',
  svg(
    '0 0 512 512',
    `<rect width="512" height="512" rx="112" fill="${PAPER}"/>${centred(1.08, 0)}`,
  ),
);
/**
 * Loose sheets, each centred on 0,0 and about 100 across, for drifting about the interface (the
 * veil into a creation, the welcome card). Same hand as the mark.
 */
const LOOSE = [
  {
    corners: [
      [-46, -54],
      [50, -50],
      [52, 48],
      [-50, 54],
    ],
    seed: 41,
  },
  {
    corners: [
      [-52, -44],
      [44, -52],
      [50, 50],
      [-44, 46],
    ],
    seed: 42,
  },
  {
    corners: [
      [-40, -56],
      [54, -46],
      [44, 56],
      [-52, 44],
    ],
    seed: 43,
  },
  {
    corners: [
      [-56, -40],
      [46, -48],
      [52, 40],
      [-46, 52],
    ],
    seed: 44,
  },
];

// For the interface (packages/ui): the mark's three sheets, and the loose ones.
writeFileSync(
  'packages/ui/src/mark-paths.ts',
  `// Generated by tools/brand-mark.mjs. Don't edit by hand.\n\n/** The three sheets of the mark, back to front. */\nexport const MARK_SHEETS = ${JSON.stringify(
    SHEETS.map((s) => ({ d: sheet(s, 1), fill: s.fill, opacity: s.opacity })),
    null,
    2,
  )} as const;\n\n/** Loose sheets of washi, each centred on 0,0 and about 100 across. */\nexport const LOOSE_SHEETS = ${JSON.stringify(
    LOOSE.map((s) => sheet(s, 1)),
    null,
    2,
  )} as const;\n`,
);
console.log('Mark written to brand/ (now run pnpm brand:build).');
