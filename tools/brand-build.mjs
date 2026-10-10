// Generates every icon, splash screen and social image from the SVG masters in brand/.
// Run with `pnpm brand:build` whenever a master changes; outputs are committed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import opentype from 'opentype.js';
import sharp from 'sharp';

const OUT = 'apps/web/public/icons';
mkdirSync(OUT, { recursive: true });

const PAPER = '#F5F1EE';
const CHARCOAL = '#2E2C33';
const read = (f) => readFileSync(f, 'utf8');
const icon = read('brand/icon.svg');
const mark = read('brand/mark.svg');
const mono = read('brand/mark-mono.svg');
const favicon = read('brand/favicon.svg');

/** Inner <svg> content of a master, for re-composition. */
const inner = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

// ---- Wordmark: "All the Spaces" set in Zen Kaku Gothic New Bold, converted to outlines. ----
const font = opentype.parse(
  readFileSync(
    'node_modules/@fontsource/zen-kaku-gothic-new/files/zen-kaku-gothic-new-latin-700-normal.woff',
  ).buffer,
);
/** Text as outlines, drawn with its baseline at the origin; position it with a transform. */
function wordmarkPath(text, size, fill) {
  // Serialise the outline commands ourselves: opentype.js's own formatter can emit "NaN".
  const n = (v) => {
    if (!Number.isFinite(v)) throw new Error('Font outline has a non-finite coordinate');
    return Number(v.toFixed(2));
  };
  // Lay out glyph by glyph (with kerning) rather than via opentype.js shaping, which does not
  // support every font's substitution tables.
  const scale = size / font.unitsPerEm;
  const commands = [];
  let x = 0;
  let prev = null;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    if (prev) x += font.getKerningValue(prev, glyph) * scale;
    commands.push(...glyph.getPath(x, 0, size).commands);
    x += glyph.advanceWidth * scale;
    prev = glyph;
  }
  const d = commands
    .map((c) => {
      switch (c.type) {
        case 'M':
        case 'L':
          return `${c.type}${n(c.x)} ${n(c.y)}`;
        case 'Q':
          return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
        case 'C':
          return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
        default:
          return 'Z';
      }
    })
    .join('');
  return { d: `<path d="${d}" fill="${fill}"/>`, width: x };
}
const at = (x, y, content) => `<g transform="translate(${x} ${y})">${content}</g>`;
{
  const size = 96;
  const w = wordmarkPath('All the Spaces', size, CHARCOAL);
  const width = Math.ceil(w.width);
  writeFileSync(
    'brand/wordmark.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${Math.ceil(size)}" role="img" aria-label="All the Spaces">${at(0, size * 0.8, w.d)}</svg>\n`,
  );
  // Horizontal lockup: mark + wordmark.
  const markSize = 160;
  const text = wordmarkPath('All the Spaces', size, CHARCOAL);
  const total = Math.ceil(markSize + 24 + text.width);
  writeFileSync(
    'brand/logo.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${markSize}" role="img" aria-label="All the Spaces">` +
      `<svg viewBox="0 0 512 512" width="${markSize}" height="${markSize}">${inner(mark)}</svg>` +
      `${at(markSize + 24, 110, text.d)}</svg>\n`,
  );
}

const png = (svg, size, file) =>
  sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(`${OUT}/${file}`);

// Square, full-bleed background (iOS rounds corners itself; maskable needs a safe zone). The
// drawing's middle is at 262, 254, and its furthest corner 240 from there: a maskable icon keeps
// it inside the 80% circle (scale ≤ 0.85).
const fullBleed = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${PAPER}"/>
  <g transform="translate(${(256 - 262 * scale).toFixed(1)} ${(256 - 254 * scale).toFixed(1)}) scale(${scale})">${inner(mark)}</g></svg>`;

await Promise.all([
  png(icon, 192, 'icon-192.png'),
  png(icon, 512, 'icon-512.png'),
  png(fullBleed(0.82), 512, 'maskable-512.png'),
  png(fullBleed(0.96), 180, 'apple-touch-icon.png'),
  png(mono.replaceAll('currentColor', '#FFFFFF'), 512, 'monochrome-512.png'),
  png(mono.replaceAll('currentColor', '#FFFFFF'), 96, 'badge-96.png'),
]);
writeFileSync(`${OUT}/favicon.svg`, favicon);

// ---- favicon.ico: PNG-encoded entries (supported by every current browser). ----
{
  const sizes = [16, 32, 48];
  const images = await Promise.all(
    sizes.map((s) => sharp(Buffer.from(favicon)).resize(s, s).png().toBuffer()),
  );
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(s, e);
    header.writeUInt8(s, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  writeFileSync('apps/web/public/favicon.ico', Buffer.concat([header, ...images]));
}

// ---- Branded canvases: iOS splash screens, manifest screenshots, social preview. ----
function canvas(w, h, { markRatio = 0.2, withWordmark = false } = {}) {
  const m = Math.round(Math.min(w, h) * markRatio);
  const textSize = Math.round(m * 0.3);
  const text = withWordmark ? wordmarkPath('All the Spaces', textSize, CHARCOAL) : null;
  const gap = withWordmark ? Math.round(m * 0.12) : 0;
  const blockH = m + (withWordmark ? gap + textSize : 0);
  const top = Math.round((h - blockH) / 2);
  const wm = text
    ? at(Math.round((w - text.width) / 2), top + m + gap + Math.round(textSize * 0.8), text.d)
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="${PAPER}"/>
    <svg x="${Math.round((w - m) / 2)}" y="${top}" width="${m}" height="${m}" viewBox="0 0 512 512">${inner(mark)}</svg>
    ${wm}</svg>`;
}
const toPng = (svg, file) =>
  sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(`${OUT}/${file}`);

// Logical size × device pixel ratio for current iPhones and iPads.
const devices = [
  [440, 956, 3],
  [402, 874, 3],
  [430, 932, 3],
  [393, 852, 3],
  [390, 844, 3],
  [414, 896, 2],
  [375, 667, 2],
  [1024, 1366, 2],
  [834, 1194, 2],
  [820, 1180, 2],
  [810, 1080, 2],
];
const head = [];
for (const [lw, lh, dpr] of devices) {
  for (const orientation of ['portrait', 'landscape']) {
    const [w, h] = orientation === 'portrait' ? [lw * dpr, lh * dpr] : [lh * dpr, lw * dpr];
    const file = `splash-${w}x${h}.png`;
    await toPng(canvas(w, h, { withWordmark: true }), file);
    head.push({
      tag: 'link',
      attrs: {
        rel: 'apple-touch-startup-image',
        href: `/icons/${file}`,
        media: `(device-width: ${lw}px) and (device-height: ${lh}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: ${orientation})`,
      },
    });
  }
}
await toPng(canvas(1080, 1920, { withWordmark: true }), 'screenshot-portrait.png');
await toPng(canvas(1920, 1080, { withWordmark: true }), 'screenshot-landscape.png');
await toPng(canvas(1200, 630, { markRatio: 0.42, withWordmark: true }), 'og-image.png');
writeFileSync(`${OUT}/head.json`, `${JSON.stringify(head, null, 2)}\n`);

console.log(`Brand assets written to ${OUT} (${head.length} splash screens).`);
