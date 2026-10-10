/**
 * A journal — an example of a close-up creation. Write with a floating pen on paper; pages save
 * by themselves and only you can read them.
 *
 * It shows: pointer/pen input with pressure, personal saves with a schema version (and how to
 * upgrade older saves), saving on exit, sound, and a layout that fits portrait and landscape.
 */
import { connect, type Json } from '@allthespaces/portal';

/** A stroke: its ink and points as [x, y, width] in page units (0–1000 wide). */
interface Stroke {
  ink: string;
  points: [number, number, number][];
}
interface Page {
  strokes: Stroke[];
}

const INKS = [
  { name: 'Sumi', color: '#2e2c33' },
  { name: 'Indigo', color: '#3f5b7c' },
  { name: 'Rust', color: '#9a5b45' },
];
const PAGES = 12;
/** Page proportions: A5 (ISO paper is exactly √2 tall to wide). */
const ASPECT = Math.SQRT2;

const portal = await connect({
  save: {
    version: 2,
    // Version 1 saved a page as a bare list of strokes; version 2 wraps it in an object.
    migrate: (old, from) => (from === 1 && Array.isArray(old) ? { strokes: old } : old),
  },
});

// ---- The page on screen ----------------------------------------------------------------------
document.body.innerHTML = `
  <div class="desk">
    <div class="sheet"><canvas></canvas><span class="folio"></span></div>
    <nav class="tools" aria-label="Journal">
      <button class="prev" aria-label="Previous page">‹</button>
      <span class="inks"></span>
      <button class="clear">Clear page</button>
      <button class="next" aria-label="Next page">›</button>
    </nav>
    <svg class="pen" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21l3.5-1 12-12-2.5-2.5-12 12L3 21zM15 4.5l2.5 2.5 1.8-1.8a1 1 0 000-1.4l-1.1-1.1a1 1 0 00-1.4 0L15 4.5z"/></svg>
  </div>`;
const sheet = document.querySelector('.sheet') as HTMLElement;
const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const folio = document.querySelector('.folio') as HTMLElement;
const pen = document.querySelector('.pen') as SVGElement;
const inks = document.querySelector('.inks') as HTMLElement;

let ink = INKS[0]?.color ?? '#2e2c33';
for (const i of INKS) {
  const b = document.createElement('button');
  b.className = 'ink';
  b.style.color = i.color;
  b.setAttribute('aria-label', `${i.name} ink`);
  b.setAttribute('aria-pressed', String(i.color === ink));
  b.addEventListener('click', () => {
    ink = i.color;
    for (const other of inks.children) other.setAttribute('aria-pressed', String(other === b));
  });
  inks.append(b);
}

let pageNo = 0;
let page: Page = { strokes: [] };
let dirty = false;

/** Fits the page to the screen, in portrait or landscape. */
function layout() {
  const room = document.querySelector('.desk') as HTMLElement;
  // The tools sit below the page, or beside it on short landscape screens (see style.css).
  const beside = getComputedStyle(room).flexDirection === 'row';
  const tools = beside ? 68 : 64;
  const w = Math.min(
    room.clientWidth - 32 - (beside ? tools : 0),
    (room.clientHeight - 32 - (beside ? 0 : tools)) / ASPECT,
  );
  sheet.style.width = `${w}px`;
  sheet.style.height = `${w * ASPECT}px`;
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(w * ASPECT * dpr);
  draw();
}
addEventListener('resize', layout);
portal.onViewport(layout);

const scale = () => canvas.width / 1000;

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // Faint ruled lines.
  ctx.strokeStyle = 'rgba(63, 91, 124, 0.12)';
  ctx.lineWidth = 1;
  for (let y = 90; y < 1000 * ASPECT; y += 44) {
    ctx.beginPath();
    ctx.moveTo(40 * scale(), y * scale());
    ctx.lineTo(960 * scale(), y * scale());
    ctx.stroke();
  }
  for (const s of page.strokes) drawStroke(s);
  folio.textContent = `${pageNo + 1} / ${PAGES}`;
}

function drawStroke(s: Stroke, from = 1) {
  ctx.strokeStyle = s.ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const k = scale();
  for (let i = Math.max(1, from); i < s.points.length; i++) {
    const [x0, y0] = s.points[i - 1] as [number, number, number];
    const [x1, y1, w] = s.points[i] as [number, number, number];
    ctx.lineWidth = w * k;
    ctx.beginPath();
    ctx.moveTo(x0 * k, y0 * k);
    ctx.lineTo(x1 * k, y1 * k);
    ctx.stroke();
  }
}

// ---- Writing ---------------------------------------------------------------------------------
let current: Stroke | null = null;
const toPage = (e: PointerEvent): [number, number] => {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * 1000, ((e.clientY - r.top) / r.width) * 1000];
};
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = toPage(e);
  current = { ink, points: [[x, y, width(e)]] };
  page.strokes.push(current);
  scratch(0);
});
canvas.addEventListener('pointermove', (e) => {
  movePen(e);
  if (!current) return;
  const events = e.getCoalescedEvents?.() ?? [e];
  for (const ev of events) {
    const [x, y] = toPage(ev);
    const last = current.points.at(-1) as [number, number, number];
    const d = Math.hypot(x - last[0], y - last[1]);
    if (d < 0.8) continue;
    current.points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, width(ev)]);
    scratch(d);
  }
  drawStroke(current, current.points.length - events.length - 1);
});
const finish = () => {
  if (!current) return;
  current = null;
  dirty = true;
  scheduleSave();
  scratch(-1);
};
canvas.addEventListener('pointerup', finish);
canvas.addEventListener('pointercancel', finish);

/** Pen pressure makes the line fuller; fingers and mice get a steady medium line. */
function width(e: PointerEvent) {
  const p = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
  return Math.round((1.4 + p * 3.2) * 10) / 10;
}

/** The floating pen follows the pointer with a gentle lag. */
let penX = 0;
let penY = 0;
let aimX = 0;
let aimY = 0;
function movePen(e: PointerEvent) {
  aimX = e.clientX;
  aimY = e.clientY;
  pen.style.opacity = e.pointerType === 'touch' ? '0' : '1';
}
function animatePen() {
  const k = portal.reducedMotion ? 1 : 0.35;
  penX += (aimX - penX) * k;
  penY += (aimY - penY) * k;
  pen.style.transform = `translate(${penX}px, ${penY - 22}px)`;
  requestAnimationFrame(animatePen);
}
requestAnimationFrame(animatePen);
canvas.addEventListener('pointerleave', () => {
  pen.style.opacity = '0';
});

// ---- Turning pages and saving ----------------------------------------------------------------
async function open(n: number) {
  await saveNow();
  pageNo = (n + PAGES) % PAGES;
  page = ((await portal.save.personal.get<Json>(`page-${pageNo}`)) as unknown as Page | null) ?? {
    strokes: [],
  };
  draw();
}

let saveTimer: number | undefined;
function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 1200);
}
async function saveNow() {
  window.clearTimeout(saveTimer);
  if (!dirty) return;
  dirty = false;
  try {
    await portal.save.personal.set(`page-${pageNo}`, page as unknown as Json);
  } catch {
    dirty = true; // try again next time
  }
}
portal.onExit(saveNow);

(document.querySelector('.prev') as HTMLElement).addEventListener(
  'click',
  () => void open(pageNo - 1),
);
(document.querySelector('.next') as HTMLElement).addEventListener(
  'click',
  () => void open(pageNo + 1),
);
(document.querySelector('.clear') as HTMLElement).addEventListener('click', () => {
  page = { strokes: [] };
  dirty = true;
  scheduleSave();
  draw();
});

// ---- The sound of a pencil on paper ----------------------------------------------------------
let scratchGain: GainNode | null = null;
function startSound() {
  const a = portal.audio.context;
  const buf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const band = a.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 3200;
  band.Q.value = 0.7;
  scratchGain = a.createGain();
  scratchGain.gain.value = 0;
  src.connect(band).connect(scratchGain).connect(portal.audio.bus('sfx'));
  src.start();
}
/** Louder the faster you write; silent when the pen lifts (-1). */
function scratch(speed: number) {
  if (!scratchGain) return;
  const a = portal.audio.context;
  const level = speed < 0 ? 0 : Math.min(0.12, 0.02 + speed * 0.006);
  scratchGain.gain.setTargetAtTime(level, a.currentTime, speed < 0 ? 0.03 : 0.01);
}

layout();
await open(0);
portal.ready();
void portal.audio.unlock('Tap to open your journal').then(startSound);
