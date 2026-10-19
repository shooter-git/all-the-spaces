import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConnectorFixture } from '@allthespaces/bridge-protocol';
import {
  BUDGETS,
  type Check,
  DOWNLOAD,
  MB,
  type Metrics,
  type QaScript,
  type Tier,
  type ViewportResult,
} from '@ats/qa';
import {
  type Browser,
  type BrowserContext,
  chromium,
  errors,
  type Frame,
  type Page,
} from 'playwright';
import sharp from 'sharp';
import { type QaServer, serveCreation } from './serve.ts';

/**
 * Connectors while checking: what ats.json declares, and the made-up answers in the project's
 * `qa/connectors/<connector>/<op>.json`. The stand-in app answers from those; nothing goes out.
 */
export interface ConnectorSetup {
  declared: { id: string; ops: string[] }[];
  fixtures: { [connector: string]: { [op: string]: ConnectorFixture } };
}

/** Every creation is played on each of these. */
export const VIEWPORTS = [
  { name: 'phone-portrait', label: 'Phone, upright', width: 390, height: 844, touch: true },
  { name: 'phone-landscape', label: 'Phone, on its side', width: 844, height: 390, touch: true },
  { name: 'tablet', label: 'Tablet', width: 820, height: 1180, touch: true },
  { name: 'desktop', label: 'Laptop', width: 1280, height: 800, touch: false },
] as const;

export interface RunOptions {
  distDir: string;
  outDir: string;
  title: string;
  tier: Tier;
  script: QaScript | null;
  /** How long to play at random when there's no script (seconds). */
  playSeconds?: number;
  viewports?: string[];
  connectors?: ConnectorSetup;
}

export interface RunResult {
  checks: Check[];
  viewports: ViewportResult[];
  saveVersion: number | null;
  initialBytes: number;
}

interface HostLog {
  readyAt: number | null;
  helloAt: number | null;
  saveVersion: number | null;
  errors: string[];
  ignored: number;
  exitRequestedAt: number | null;
  exitedAt: number | null;
  longestSilence: number;
  saveProblems: string[];
  connectorCalls: { connector: string; op: string; result: string }[];
  connectorProblems: string[];
}

/** The app offers to leave a creation that stops answering for this long. */
const FROZEN_MS = 5000;
/** For a creation drawing with WebGL in this browser, which draws on the CPU (see 'froze'). */
const FROZEN_DRAWING_MS = 20_000;

const LAUNCH_ARGS = [
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-precise-memory-info',
  '--host-resolver-rules=MAP *.qa.localhost 127.0.0.1',
];

/** Plays a built creation on phones, a tablet and a laptop, and reports what happened. */
export async function runInBrowser(opts: RunOptions): Promise<RunResult> {
  await mkdir(opts.outDir, { recursive: true });
  const server = await serveCreation(opts.distDir, opts.connectors ?? null);
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const checks: Check[] = [];
  const results: ViewportResult[] = [];
  let saveVersion: number | null = null;
  try {
    for (const vp of VIEWPORTS.filter((v) => !opts.viewports || opts.viewports.includes(v.name))) {
      const r = await playOn(browser, server, vp, opts, checks);
      results.push(r.result);
      saveVersion ??= r.saveVersion;
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return {
    checks,
    viewports: results,
    saveVersion,
    initialBytes: Math.max(0, ...results.map((r) => r.initialBytes)),
  };
}

async function playOn(
  browser: Browser,
  server: QaServer,
  vp: (typeof VIEWPORTS)[number],
  opts: RunOptions,
  checks: Check[],
): Promise<{ result: ViewportResult; saveVersion: number | null }> {
  const where = vp.label;
  const context: BrowserContext = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: vp.touch,
    ...(vp.touch && vp.name !== 'tablet' ? { isMobile: true } : {}),
    deviceScaleFactor: 1,
  });
  // Nothing leaves the machine, whatever the creation tries.
  const appOrigin = new URL(server.url({ title: '', tier: '' })).origin;
  await context.route(
    (url) => url.origin !== appOrigin && url.origin !== server.playOrigin,
    (route) => route.abort('blockedbyclient'),
  );
  const page = await context.newPage();
  const result: ViewportResult = {
    name: vp.name,
    label: vp.label,
    width: vp.width,
    height: vp.height,
    touch: vp.touch,
    screenshots: [],
    readyMs: null,
    initialBytes: 0,
    metrics: null,
  };
  const sizes: Promise<number>[] = [];
  let ready = false;
  page.on('requestfinished', (req) => {
    if (!ready && req.url().startsWith(server.playOrigin))
      sizes.push(
        req.sizes().then(
          (s) => s.responseBodySize,
          () => 0,
        ),
      );
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const host = () =>
    page.evaluate(() => (globalThis as unknown as { __host: { log: HostLog } }).__host.log);
  await page.goto(server.url({ title: opts.title, tier: opts.tier }));
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && (await host()).readyAt === null) await page.waitForTimeout(100);
  ready = true;
  const first = await host();
  result.readyMs = first.readyAt === null ? null : Math.round(first.readyAt);
  result.initialBytes = (await Promise.all(sizes)).reduce((a, b) => a + b, 0);
  const frame = page.frames().find((f) => f.url().startsWith(server.playOrigin)) ?? null;

  if (first.readyAt === null) {
    checks.push({
      id: 'ready',
      status: 'fail',
      where,
      title: first.helloAt === null ? "It didn't start" : 'It never said it was ready',
      detail:
        first.helloAt === null
          ? "The creation never connected to the app: connect() wasn't called, or the page failed before it."
          : 'The app keeps its veil up until the creation calls portal.ready().',
      fix:
        first.helloAt === null
          ? 'Call `await connect()` from @allthespaces/portal first thing, and check the errors below.'
          : 'Call portal.ready() once everything has loaded (within 45 seconds).',
    });
    reportErrors(checks, where, [
      ...((await metricsOf(frame))?.errors ?? []),
      ...first.errors,
      ...pageErrors,
    ]);
    await context.close();
    return { result, saveVersion: first.saveVersion };
  }

  await page.waitForTimeout(1500);
  await shoot(page, opts.outDir, result, 'start', checks);
  await frame?.evaluate(() => (globalThis as unknown as { __qa: { reset(): void } }).__qa.reset());
  await checkLayout(page, frame, vp.touch, where, checks);

  // Play: the creation's own script, or a few seconds of someone trying everything.
  if (opts.script) await runScript(page, opts, result, vp.touch, checks);
  else await playAtRandom(page, vp.touch, opts.playSeconds ?? 10);
  await page.waitForTimeout(500);
  await shoot(page, opts.outDir, result, 'after playing', checks);

  // Turn the phone mid-session.
  if (vp.name === 'phone-portrait') {
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await page.waitForTimeout(2000);
    await shoot(page, opts.outDir, result, 'turned on its side', checks);
    await checkLayout(page, frame, vp.touch, `${where}, turned`, checks);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(1000);
  }

  // Leaving: it gets a moment to save, then says goodbye.
  if (vp.name === 'desktop') {
    await page.evaluate(() =>
      (globalThis as unknown as { __host: { requestExit(): void } }).__host.requestExit(),
    );
    await page.waitForTimeout(2500);
    const log = await host();
    const took =
      log.exitedAt !== null && log.exitRequestedAt !== null
        ? log.exitedAt - log.exitRequestedAt
        : null;
    checks.push(
      took !== null && took <= 2000
        ? {
            id: 'exit',
            status: 'pass',
            title: `Lets go promptly when someone leaves (${Math.round(took)} ms)`,
          }
        : {
            id: 'exit',
            status: 'warn',
            title: "Doesn't let go in time when someone leaves",
            detail: 'The app waits 2 seconds for onExit handlers, then closes the creation anyway.',
            fix: 'Keep portal.onExit handlers short: save only what changed.',
          },
    );
  }

  const log = await host();
  const metrics = await metricsOf(frame);
  result.metrics = metrics;
  reportErrors(checks, where, [...(metrics?.errors ?? []), ...log.errors, ...pageErrors]);
  if (metrics?.blocked.length) {
    const what = [...new Set(metrics.blocked.map((b) => b.what))].slice(0, 5).join(', ');
    checks.push({
      id: 'network',
      status: 'fail',
      where,
      title: "Tries to reach things it can't",
      detail: `Blocked: ${what}`,
      fix: 'Creations have no internet and can only load their own files. Ship everything inside the creation and load it by relative path.',
    });
  }
  // This browser has no graphics card: it draws on the CPU. A creation that draws with WebGL can
  // pause here for seconds while its shaders are made, which takes milliseconds on any real
  // device, so for one a pause is only a warning, up to a point. Without WebGL a pause is its own
  // code running too long, and a long enough pause is a hang either way.
  const seconds = (log.longestSilence / 1000).toFixed(1);
  const drawsWithWebgl = (metrics?.contexts ?? 0) > 0;
  if (log.longestSilence > (drawsWithWebgl ? FROZEN_DRAWING_MS : FROZEN_MS)) {
    checks.push({
      id: 'froze',
      status: 'fail',
      where,
      title: `Stopped responding for ${seconds} seconds`,
      detail: 'The app offers to leave a creation that stops answering for 5 seconds.',
      fix: 'Split long work into pieces (or move it into a worker) so the page keeps responding.',
    });
  } else if (log.longestSilence > FROZEN_MS) {
    checks.push({
      id: 'froze',
      status: 'warn',
      where,
      title: `Paused for ${seconds} seconds while drawing`,
      detail:
        "Probably while making its shaders. The checks' browser has no graphics card and draws 3D on the CPU, far slower than any device; the app offers to leave a creation that stops answering for 5 seconds.",
      fix: 'Try it on a slow phone. Making shaders a few at a time (behind a loading screen) avoids pauses there too.',
    });
  }
  if (log.ignored > 0)
    checks.push({
      id: 'bridge',
      status: 'warn',
      where,
      title: `Sent ${log.ignored} message${log.ignored === 1 ? '' : 's'} the app ignored`,
      fix: 'Talk to the app only through @allthespaces/portal.',
    });
  for (const p of log.saveProblems)
    checks.push({
      id: 'save',
      status: 'fail',
      where,
      title: `A save was refused: ${p}`,
      fix: 'Keep each saved value under 256 KB.',
    });
  reportConnectors(checks, where, log);
  await context.close();
  return { result, saveVersion: log.saveVersion };
}

/** What it asked of connectors: every call, in the report, and anything it didn't declare. */
function reportConnectors(checks: Check[], where: string, log: HostLog) {
  const undeclared = [...new Set(log.connectorProblems)];
  if (undeclared.length)
    checks.push({
      id: 'connectors',
      status: 'fail',
      where,
      title: 'Calls a connector operation it doesn’t declare',
      detail: undeclared.slice(0, 5).join(' · '),
      fix: 'List every connector and operation it calls in ats.json "connectors" (with why), or stop calling it.',
    });
  if (!log.connectorCalls.length) return;
  const counts = new Map<string, number>();
  for (const c of log.connectorCalls) {
    const key = `${c.connector} ${c.op} → ${c.result}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missing = log.connectorCalls.filter((c) => c.result === 'no fixture');
  checks.push({
    id: 'connector-calls',
    status: missing.length ? 'warn' : 'pass',
    where,
    title: `Called connectors ${log.connectorCalls.length} time${log.connectorCalls.length === 1 ? '' : 's'}`,
    detail: [...counts]
      .slice(0, 12)
      .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
      .join(' · '),
    ...(missing.length
      ? {
          fix: 'Add qa/connectors/<connector>/<op>.json for each operation it calls, so the checks see real answers.',
        }
      : {}),
  });
}

async function metricsOf(frame: Frame | null): Promise<Metrics | null> {
  if (!frame) return null;
  try {
    return await frame.evaluate(() =>
      (globalThis as unknown as { __qa: { snapshot(): Metrics } }).__qa.snapshot(),
    );
  } catch {
    return null;
  }
}

function reportErrors(checks: Check[], where: string, errors: string[]) {
  const unique = [...new Set(errors)];
  if (!unique.length) return;
  checks.push({
    id: 'errors',
    status: 'fail',
    where,
    title: `${unique.length} error${unique.length === 1 ? '' : 's'} while playing`,
    detail: unique.slice(0, 4).join(' · '),
    fix: 'Open it on its own with `pnpm dev`, reproduce this on the same screen size, and fix the errors in the browser console.',
  });
}

/**
 * A screenshot waits for the browser to finish a frame, and this one draws 3D on the CPU: on a
 * busy or slower check machine one frame can take longer than Playwright's 30 seconds. Each shot
 * gets these tries.
 */
export const SHOT_TRIES_MS = [30_000, 60_000];

/**
 * Takes a screenshot, trying again with longer to wait. If the browser still hasn't drawn a frame,
 * that's a note, not a failure: the creation went on answering the app (a real hang is 'froze'),
 * so it's this machine's drawing that stalled. The run's later screenshots are skipped then.
 */
export async function screenshot(
  page: Pick<Page, 'screenshot'>,
  path: string,
  where: string,
  checks: Check[],
  tries = SHOT_TRIES_MS,
): Promise<Buffer | null> {
  if (checks.some((c) => c.id === 'stalled')) return null;
  for (const timeout of tries) {
    try {
      return await page.screenshot({ path, timeout });
    } catch (err) {
      if (!(err instanceof errors.TimeoutError)) throw err;
    }
  }
  const seconds = Math.round(tries.reduce((a, b) => a + b, 0) / 1000);
  checks.push({
    id: 'stalled',
    status: 'warn',
    where,
    title: "Couldn't take a screenshot",
    detail: `The checks' browser has no graphics card and draws 3D on the CPU; it hadn't finished a frame after ${seconds} seconds, so this and later screenshots were skipped. Everything else was still checked.`,
    fix: 'Nothing, if it draws smoothly on a real device. If it does pause there, draw less in a single frame.',
  });
  return null;
}

async function shoot(
  page: Page,
  outDir: string,
  result: ViewportResult,
  name: string,
  checks: Check[],
) {
  const file = `${result.name}-${result.screenshots.length + 1}.png`;
  // Waiting for a frame here can hold up the creation's page too: not its silence (see quiet()).
  const quiet = (on: boolean) =>
    page
      .evaluate(
        (q) => (globalThis as unknown as { __host: { quiet(on: boolean): void } }).__host.quiet(q),
        on,
      )
      .catch(() => {});
  await quiet(true);
  const png = await screenshot(
    page,
    join(outDir, file),
    `${result.label}, ${name}`,
    checks,
  ).finally(() => quiet(false));
  if (!png) return;
  result.screenshots.push({ name, file });
  // Blank: everything below the app's buttons is one flat colour.
  const { width, height } = await sharp(png).metadata();
  const top = Math.min(70, Math.floor((height ?? 0) / 4));
  const stats = await sharp(png)
    .extract({ left: 0, top, width: width ?? 1, height: (height ?? 1) - top })
    .stats();
  if (stats.channels.slice(0, 3).every((c) => c.stdev < 2))
    checks.push({
      id: 'blank',
      status: 'fail',
      where: `${result.label}, ${name}`,
      title: 'The screen is blank',
      detail: 'Nothing but a single flat colour is showing.',
      fix: 'Check it draws at this screen size: size the canvas from the window (createStage does this) and redraw after the screen turns.',
    });
}

async function checkLayout(
  page: Page,
  frame: Frame | null,
  touch: boolean,
  where: string,
  checks: Check[],
) {
  if (!frame) return;
  const appButtons = await page.evaluate(() =>
    (
      globalThis as unknown as {
        __host: { appButtons(): { x: number; y: number; w: number; h: number }[] };
      }
    ).__host.appButtons(),
  );
  const l = await frame.evaluate(
    ([t, b]) =>
      (
        globalThis as unknown as {
          __qa: {
            layout(
              t: boolean,
              b: unknown,
            ): {
              overflowX: boolean;
              overflowY: boolean;
              small: { label: string; w: number; h: number }[];
              cutOff: string[];
              underApp: string[];
            };
          };
        }
      ).__qa.layout(t as boolean, b),
    [touch, appButtons] as const,
  );
  if (l.overflowX || l.overflowY)
    checks.push({
      id: 'overflow',
      status: 'fail',
      where,
      title: `The page is ${l.overflowX ? 'wider' : 'taller'} than the screen`,
      fix: 'Lay it out to fit the window in both orientations (100% width and height, no fixed pixel sizes wider than a phone).',
    });
  if (l.small.length)
    checks.push({
      id: 'targets',
      status: 'fail',
      where,
      title: `${l.small.length} control${l.small.length === 1 ? ' is' : 's are'} too small to tap`,
      detail: l.small
        .slice(0, 5)
        .map((s) => `${s.label} (${s.w}×${s.h})`)
        .join(', '),
      fix: 'Make everything you tap at least 44 × 44 CSS pixels (padding counts).',
    });
  if (l.cutOff.length)
    checks.push({
      id: 'cut-off',
      status: 'fail',
      where,
      title: 'Controls are cut off at the edge of the screen',
      detail: l.cutOff.slice(0, 5).join(', '),
      fix: 'Keep controls inside the window at every size; test with the phone upright and on its side.',
    });
  if (l.underApp.length)
    checks.push({
      id: 'under-app',
      status: 'warn',
      where,
      title: "Controls sit under the app's menu button",
      detail: l.underApp.slice(0, 5).join(', '),
      fix: 'Keep the top-left corner clear: 56 × 56 pixels inside the safe area.',
    });
}

async function runScript(
  page: Page,
  opts: RunOptions,
  result: ViewportResult,
  touch: boolean,
  checks: Check[],
) {
  const size = page.viewportSize() ?? { width: 800, height: 600 };
  const at = ([x, y]: [number, number]) => ({ x: x * size.width, y: y * size.height });
  for (const step of opts.script?.steps ?? []) {
    if ('wait' in step) await page.waitForTimeout(step.wait * 1000);
    else if ('press' in step) await page.keyboard.press(step.press).catch(() => {});
    else if ('hold' in step) {
      await page.keyboard.down(step.hold).catch(() => {});
      await page.waitForTimeout(step.seconds * 1000);
      await page.keyboard.up(step.hold).catch(() => {});
    } else if ('tap' in step) {
      const p = at(step.tap);
      if (touch) await page.touchscreen.tap(p.x, p.y);
      else await page.mouse.click(p.x, p.y);
    } else if ('drag' in step)
      await drag(page, at(step.drag[0]), at(step.drag[1]), step.seconds ?? 0.5);
    else if ('type' in step) await page.keyboard.type(step.type, { delay: 40 });
    else if ('screenshot' in step) await shoot(page, opts.outDir, result, step.screenshot, checks);
  }
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  seconds: number,
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: Math.max(2, Math.round(seconds * 30)) });
  await page.mouse.up();
}

/** Someone trying everything: keys, taps, drags and scrolling, the same way every run. */
async function playAtRandom(page: Page, touch: boolean, seconds: number) {
  let seed = 0x5eed;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const keys = [
    'KeyW',
    'KeyA',
    'KeyS',
    'KeyD',
    'ArrowUp',
    'ArrowLeft',
    'ArrowRight',
    'Space',
    'KeyE',
    'Enter',
  ];
  const size = page.viewportSize() ?? { width: 800, height: 600 };
  // Stay clear of the app's own buttons along the top.
  const point = () => ({
    x: 20 + rand() * (size.width - 40),
    y: 80 + rand() * (size.height - 100),
  });
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const r = rand();
    if (r < 0.3) {
      const key = keys[Math.floor(rand() * keys.length)] ?? 'Space';
      await page.keyboard.down(key);
      await page.waitForTimeout(100 + rand() * 700);
      await page.keyboard.up(key);
    } else if (r < 0.55) {
      const p = point();
      if (touch) await page.touchscreen.tap(p.x, p.y);
      else await page.mouse.click(p.x, p.y);
    } else if (r < 0.75) await drag(page, point(), point(), 0.2 + rand() * 0.6);
    else if (r < 0.85) {
      const p = point();
      await page.mouse.move(p.x, p.y);
      await page.mouse.wheel(0, (rand() - 0.5) * 600);
    } else await page.waitForTimeout(200 + rand() * 300);
  }
}

/** Budget checks from the heaviest moment on any screen. */
export function judgeBudgets(
  tier: Tier,
  viewports: ViewportResult[],
  initialBytes: number,
  totalBytes: number,
) {
  const b = BUDGETS[tier];
  const ms = viewports.flatMap((v) => (v.metrics ? [v.metrics] : []));
  const max = (f: (m: Metrics) => number) => Math.max(0, ...ms.map(f));
  const summary = {
    drawCalls: max((m) => m.drawCalls.p95),
    triangles: max((m) => m.triangles.p95),
    textureMB: max((m) => m.textureBytes) / MB,
    gpuMB: max((m) => m.gpuBytes) / MB,
    voices: max((m) => m.voices),
    heapMB: max((m) => m.heapBytes) / MB,
    initialMB: initialBytes / MB,
    totalMB: totalBytes / MB,
    frameMsP95: max((m) => m.frameMs.p95),
  };
  const checks: Check[] = [];
  const budget = (
    id: string,
    value: number,
    limit: number,
    title: string,
    over: string,
    fix: string,
    unit = '',
  ) =>
    checks.push(
      value <= limit
        ? {
            id,
            status: 'pass',
            title: `${title}: ${fmt(value)}${unit} (up to ${fmt(limit)}${unit})`,
          }
        : {
            id,
            status: 'fail',
            title: `${over}: ${fmt(value)}${unit}, and ${tier}-powered devices allow ${fmt(limit)}${unit}`,
            fix,
          },
    );
  budget(
    'draw-calls',
    summary.drawCalls,
    b.drawCalls,
    'Draw calls per frame',
    'Too many draw calls per frame',
    'Merge meshes that share a material (BufferGeometryUtils.mergeGeometries), use InstancedMesh for repeated things, and share materials.',
  );
  budget(
    'triangles',
    summary.triangles,
    b.triangles,
    'Triangles per frame',
    'Too many triangles per frame',
    'Use simpler models, or lower-detail versions for things far away (LOD).',
  );
  budget(
    'textures',
    summary.textureMB,
    b.textureMB,
    'Texture memory',
    'Too much texture memory',
    'Use fewer or smaller textures (1024 px is plenty for most things on a phone), and reuse them.',
    ' MB',
  );
  budget(
    'gpu',
    summary.gpuMB,
    b.gpuMB,
    'Graphics memory',
    'Too much graphics memory',
    'Reduce textures and render targets, and dispose of things you no longer show.',
    ' MB',
  );
  budget(
    'voices',
    summary.voices,
    b.voices,
    'Sounds playing at once',
    'Too many sounds at once',
    'Limit how many copies of a sound play together, and stop sounds nobody can hear.',
  );
  budget(
    'heap',
    summary.heapMB,
    b.heapMB,
    'Script memory',
    'Uses too much memory',
    "Keep large data out of memory until it's needed, and release what you're done with.",
    ' MB',
  );
  budget(
    'initial-download',
    summary.initialMB,
    DOWNLOAD.initialMB,
    "Download before it's ready",
    'Downloads too much before it starts',
    'Load the essentials first, call portal.ready(), then load the rest in the background.',
    ' MB',
  );
  budget(
    'download',
    summary.totalMB,
    DOWNLOAD.totalMB,
    'Whole download',
    'The creation is too big',
    'Compress models (.glb) and textures, and use compressed audio (.ogg or .mp3).',
    ' MB',
  );
  const direct = max((m) => m.directToSpeakers);
  if (direct > 0)
    checks.push({
      id: 'audio-routing',
      status: 'fail',
      title: 'Some sounds skip the sound groups',
      detail: `${direct} sound connection${direct === 1 ? ' goes' : 's go'} straight to the speakers, so they keep playing when the app covers the creation or someone leaves.`,
      fix: "Connect sounds to portal.audio.bus('sfx') (or 'music', 'ambience', 'voice', 'ui') instead of context.destination.",
    });
  if (max((m) => m.clippedMoments) > 3)
    checks.push({
      id: 'audio-clipping',
      status: 'warn',
      title: 'Sound distorts at its loudest',
      fix: 'Turn down loud sounds or the music so the mix stays below full scale.',
    });
  return { checks, summary };
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en') : n.toFixed(1));
