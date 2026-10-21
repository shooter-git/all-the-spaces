// Phones, in real browser engines (Chromium as Android, WebKit as iPhone), portrait and landscape:
// inside a space everything in the corner menu answers a tap, pop-ups take taps and scroll, the 3D
// view still walks and looks without moving the page, a creation's Chat and Leave stay reachable,
// and held sideways the way into a creation puts its picture beside the words, with the way in on
// screen. Turned sideways and back (with fingers down that never lift, as phones can lose them in a
// turn), the page stays put, the menu and its pop-ups still take taps, and the walking stops.
// Runs against the built app like the axe checks (`pnpm --filter @ats/web build`, then
// `pnpm --filter @ats/web test:axe`). The server is played by fixtures; the space is a row of
// small rooms drawn with software WebGL. WebKit needs its system libraries (`playwright install
// --with-deps webkit`); `WEB_TOUCH_ENGINES=chromium` leaves it out.
import { createServer } from 'node:net';
import {
  type Browser,
  type BrowserContext,
  chromium,
  devices,
  type Locator,
  type Page,
  type Route,
  webkit,
} from 'playwright';
import { type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOOR_PHRASES } from '../src/lib/door-phrases.ts';

const run = process.env.WEB_AXE ? describe : describe.skip;
const engines = (process.env.WEB_TOUCH_ENGINES ?? 'chromium,webkit').split(',');

/** A 10 m square floor as a glTF file: every level of detail, and the collision, of each room. */
function floorGltf() {
  const positions = new Float32Array([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2]);
  const bytes = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.75, 0.7, 1] } }],
    buffers: [
      {
        byteLength: bytes.length,
        uri: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 },
      { buffer: 0, byteOffset: 48, byteLength: 12 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [-5, 0, -5],
        max: [5, 0, 5],
      },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  };
}

const chunk = { path: 'chunks/floor.gltf', bytes: 1, sha256: 'a'.repeat(64) };
/** Enough rooms that the "Go to another room" list is longer than a phone's screen. */
const room = (i: number) => ({
  key: `room${i}`,
  floorKey: 'ground',
  name: i === 0 ? 'Hall' : `Room ${i}`,
  isOutdoor: false,
  bounds: { min: [-5 + i * 20, 0, -5], max: [5 + i * 20, 3, 5] },
  neighbors: [],
  doorways: [],
  lods: { lod0: chunk, lod1: chunk, lod2: chunk },
  collision: chunk,
  labelPosition: [i * 20, 1, 0],
  objects: i === 0 ? [{ key: 'desk', label: 'Desk', kind: 'desk', position: [2, 0, -2] }] : [],
  sounds: [],
  files: [],
  credits: [],
});
const manifest = {
  format: 1,
  name: 'Test house',
  spaceType: 'house',
  floors: [{ key: 'ground', name: 'Ground', index: 0, elevation: 0 }],
  rooms: Array.from({ length: 40 }, (_, i) => room(i)),
  links: [],
  spawns: [{ key: 'start', roomKey: 'room0', position: [0, 0, 0], yaw: 0 }],
  lighting: { sky: '#dfe8f1', ground: '#c2b6a4', sunDirection: [0.4, 1, 0.3], exposure: 1 },
  resources: [],
  credits: [],
};

const creation = {
  id: 'c1',
  title: 'Marble run',
  description:
    'A marble run that two people can build together, one piece at a time, and then race marbles down.',
  objectKey: 'desk',
  roomKey: 'room0',
  defaultMode: 'shared',
  version: 1,
  playing: 2,
};

/**
 * A creation that says hello until the app answers (as the SDK does: the app may still be setting
 * up when the frame loads), is ready at once, and then asks to link an account at a service.
 */
const CREATION_PAGE = `<!doctype html><meta name="viewport" content="width=device-width">
<body style="margin:0;font:16px sans-serif"><p style="padding:80px 16px">A test creation.</p>
<script>
const say = (msg) => parent.postMessage({ ats: 'bridge', v: 1, msg }, '*');
const hello = () => say({ type: 'hello', sdkVersion: '1.0.0' });
let saying = setInterval(hello, 300);
hello();
addEventListener('message', (e) => {
  if (e.data?.msg?.type !== 'init' || !saying) return;
  clearInterval(saying);
  saying = 0;
  say({ type: 'ready' });
  setTimeout(() => say({ type: 'connector:link', id: 1, connector: 'boardgames' }), 2500);
});
</script>`;

function answers(base: string): Record<string, unknown> {
  return {
    '/api/setup/status': { setupComplete: true },
    '/api/me': {
      user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.test', image: null },
      groups: [{ groupId: 'g1', groupName: 'Home', themeColor: '#D3DDE8', role: 'architect' }],
    },
    '/api/spaces/s1/manifest': manifest,
    '/api/spaces/s1/chunks/floor.gltf': floorGltf(),
    '/api/spaces/s1/creations': { creations: [creation] },
    '/api/spaces/s1/requests/objects': { objects: {} },
    '/api/notifications': { notifications: [], unread: 0, more: false },
    '/api/creations/c1/open': {
      creation: {
        id: 'c1',
        title: creation.title,
        version: 1,
        versionId: 'v1',
        protocolVersion: 1,
        defaultMode: 'shared',
        saveVersion: null,
      },
      trial: false,
      url: `${base}/test-creation`,
      playOrigin: base,
      ticket: 'ticket',
      connectors: [{ id: 'boardgames', ops: ['list'], why: 'To list your saved games.' }],
    },
    '/api/connectors': {
      connectors: [
        {
          id: 'boardgames',
          displayName: 'Board games',
          description: 'Saved board games.',
          scopes: ['read'],
          linked: false,
          linkedAt: null,
          broken: false,
          accountName: null,
          checked: false,
        },
      ],
    },
  };
}

const PHONES = [
  { name: 'iPhone, portrait', engine: 'webkit', device: devices['iPhone 13'] },
  { name: 'iPhone, landscape', engine: 'webkit', device: devices['iPhone 13 landscape'] },
  { name: 'Android, portrait', engine: 'chromium', device: devices['Pixel 7'] },
  { name: 'Android, landscape', engine: 'chromium', device: devices['Pixel 7 landscape'] },
].filter((p) => engines.includes(p.engine));
/** More phones held sideways, by engine: today's larger iPhones (Pro, Pro Max) and Androids. */
const SIDEWAYS: Record<string, { width: number; height: number }[]> = {
  webkit: [
    { width: 852, height: 393 },
    { width: 932, height: 430 },
  ],
  chromium: [{ width: 915, height: 412 }],
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port')),
      );
    });
  });

interface Viewer {
  isReady: boolean;
  pose(): { x: number; z: number; yaw: number; roomKey: string | null };
}
const pose = (tab: Page) =>
  tab.evaluate(() => (window as unknown as { __atsViewer: Viewer }).__atsViewer.pose());

/**
 * How long to wait for the view to answer a finger: it moves on the next frames drawn, and
 * software WebGL on a busy CI machine can go a few seconds without drawing one.
 */
const FRAMES_MS = 10_000;

/**
 * Two frames drawn since now. After the screen changes size, the browser only works out again what
 * goes by its height (100dvh) when it next draws: until then the page is laid out with the old one.
 * Software WebGL on a busy machine can take seconds to draw, so this waits for the frames, not a time.
 */
const drawn = (tab: Page) =>
  tab.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );

/** Nothing covers the middle of what's tapped (an invisible layer would swallow the tap). */
async function reachable(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const hit = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return Boolean(top && (top === el || el.contains(top)));
  });
  expect(hit, `${await target.textContent()} is under something`).toBe(true);
}

/**
 * Whether a finger can scroll it: it's a scroll container with more to show, and nothing from it
 * up to the page sets a `touch-action` without vertical panning (that limits everything inside).
 */
function scrollableByTouch(el: Element) {
  const style = getComputedStyle(el);
  const scroller = ['auto', 'scroll'].includes(style.overflowY);
  const blocked: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    const t = getComputedStyle(n).touchAction;
    if (t !== 'auto' && t !== 'manipulation' && !t.includes('pan-y'))
      blocked.push(`${n.tagName.toLowerCase()}.${n.className} (${t})`);
  }
  return { scroller, overflows: el.scrollHeight > el.clientHeight + 1, blocked };
}

run('touch in a space (phones)', () => {
  let server: PreviewServer;
  const browsers: Record<string, Browser> = {};
  let base: string;

  beforeAll(async () => {
    const port = await freePort();
    server = await preview({ preview: { host: '127.0.0.1', port, strictPort: true } });
    base = `http://127.0.0.1:${port}`;
    if (engines.includes('chromium'))
      browsers.chromium = await chromium.launch({
        // Software WebGL, for the 3D view.
        args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
      });
    if (engines.includes('webkit'))
      browsers.webkit = process.env.WEBKIT_WS
        ? await webkit.connect(process.env.WEBKIT_WS)
        : await webkit.launch();
  }, 60_000);

  // Closing Chromium with its software WebGL takes about 10 s on a busy machine.
  afterAll(async () => {
    for (const b of Object.values(browsers)) await b.close();
    await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  }, 60_000);

  async function phone(p: (typeof PHONES)[number]): Promise<BrowserContext> {
    const browser = browsers[p.engine];
    if (!browser) throw new Error(`no ${p.engine}`);
    const context = await browser.newContext({
      ...p.device,
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    });
    const table = answers(base);
    await context.route('**/api/**', (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      const body = table[path];
      return route.fulfill(
        body === undefined
          ? { status: 404, json: { error: 'Not found' } }
          : { status: 200, json: body },
      );
    });
    await context.route('**/test-creation', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: CREATION_PAGE }),
    );
    return context;
  }

  async function enter(context: BrowserContext, query = ''): Promise<Page> {
    const tab = await context.newPage();
    // Live connections (chat, presence, a creation's session): accepted, and quiet.
    await tab.routeWebSocket(/\/(api|rt)\//, () => {});
    await tab.goto(`${base}/space/s1${query}`);
    await tab.waitForFunction(
      () => (window as unknown as { __atsViewer?: Viewer }).__atsViewer?.isReady,
      null,
      { timeout: 30_000 },
    );
    // The loading screen has faded away (it's over the view and the joystick until then). Its
    // fade, and this check, only move on when the page draws, and a busy machine has gone 11 s
    // without drawing.
    await tab.waitForFunction(
      () => {
        const veil = document.querySelector('.space-loading');
        return veil?.getAttribute('data-done') === 'true' && getComputedStyle(veil).opacity === '0';
      },
      null,
      { timeout: 30_000 },
    );
    return tab;
  }

  /** A finger dragged from one point to another (Chromium: the browser's own touch input). */
  async function drag(tab: Page, from: [number, number], to: [number, number], hold = 0) {
    const cdp = await tab.context().newCDPSession(tab);
    const at = (t: number) => ({
      x: from[0] + (to[0] - from[0]) * t,
      y: from[1] + (to[1] - from[1]) * t,
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(0)] });
    for (let i = 1; i <= 10; i++)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(i / 10)] });
    if (hold) await tab.waitForTimeout(hold);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  /** The phone turned a quarter: the screen's width and height swap, as the browser reports. */
  async function turn(tab: Page) {
    const size = tab.viewportSize();
    if (!size) throw new Error('no viewport');
    await tab.setViewportSize({ width: size.height, height: size.width });
    await tab.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await tab.waitForTimeout(400);
  }

  /** The page sits at its top-left corner: what's drawn is where taps land. */
  const still = (tab: Page) =>
    tab.evaluate(() => [
      window.scrollX,
      window.scrollY,
      Math.round(window.visualViewport?.offsetLeft ?? 0),
      Math.round(window.visualViewport?.offsetTop ?? 0),
    ]);

  /** The corner menu: its button, and the item named, each on top where it's drawn, tapped. */
  async function choose(tab: Page, name: RegExp) {
    const open = tab.locator('.creation-menu').getByRole('button', { name: /^Menu/ });
    await reachable(open);
    await open.tap();
    const item = tab.locator('.creation-menu-panel').getByRole('button', { name });
    await reachable(item);
    await item.tap();
  }

  /** Everything in the corner menu is on top where it's drawn, and opens what it should. */
  async function menuAnswers(tab: Page) {
    await choose(tab, /^People here/);
    const people = tab.getByRole('dialog', { name: 'People here' });
    await people.waitFor({ timeout: 5000 });
    await reachable(people.getByRole('button', { name: 'Close' }));
    await people.getByRole('button', { name: 'Close' }).tap();
    await people.waitFor({ state: 'detached', timeout: 5000 });

    await choose(tab, /^Chat/);
    const chat = tab.getByRole('complementary', { name: 'Chat' });
    await chat.waitFor({ timeout: 5000 });
    await choose(tab, /^Close chat/);
    await chat.waitFor({ state: 'detached', timeout: 5000 });

    await choose(tab, /^Sound and settings/);
    const settings = tab.getByRole('dialog', { name: 'Sound and settings' });
    await settings.waitFor({ timeout: 5000 });
    await reachable(settings.getByRole('button', { name: 'Close' }));
    await settings.getByRole('button', { name: 'Close' }).tap();
    await settings.waitFor({ state: 'detached', timeout: 5000 });

    await choose(tab, /^Go to another room/);
    const rooms = tab.getByRole('dialog', { name: 'Go to another room' });
    await rooms.waitFor({ timeout: 5000 });
    const room = rooms.getByRole('button', { name: 'Room 3', exact: true });
    await reachable(room);
    await room.tap();
    await rooms.waitFor({ state: 'detached', timeout: 5000 });
    await expect.poll(async () => (await pose(tab)).roomKey, { timeout: 10_000 }).toBe('room3');

    await choose(tab, /^Leave/);
    await tab.waitForURL(`${base}/`, { timeout: 5000 });
  }

  for (const p of PHONES) {
    describe(p.name, () => {
      it('everything in the corner menu answers a tap', { timeout: 90_000 }, async () => {
        const context = await phone(p);
        try {
          const tab = await enter(context);
          // Nothing else at the top: the menu is the space's one control up there.
          expect(await tab.getByRole('button', { name: /^People here/ }).count()).toBe(0);
          await menuAnswers(tab);
        } finally {
          await context.close();
        }
      });

      it('pop-ups take taps, and scroll when longer than the screen', {
        timeout: 90_000,
      }, async () => {
        const context = await phone(p);
        try {
          // The way into a creation (opened at its object, as after linking an account).
          const tab = await enter(context, '?object=desk');
          const picker = tab.getByRole('dialog', { name: creation.title });
          await picker.waitFor();
          const door = await picker.evaluate(scrollableByTouch);
          expect(door.blocked).toEqual([]);
          if (door.overflows) {
            expect(door.scroller).toBe(true);
            if (p.engine === 'chromium') {
              const box = await picker.boundingBox();
              if (!box) throw new Error('no picker');
              const x = box.x + box.width / 2;
              await drag(tab, [x, box.y + box.height - 30], [x, box.y + 30]);
              await expect.poll(() => picker.evaluate((d) => d.scrollTop)).toBeGreaterThan(20);
            }
          }
          await reachable(picker.getByRole('button', { name: 'Not now' }));
          await picker.getByRole('button', { name: 'Not now' }).tap();
          await picker.waitFor({ state: 'detached' });

          // The corner menu: held sideways it's taller than the screen, and scrolls on its own.
          await tab.locator('.creation-menu').getByRole('button', { name: /^Menu/ }).tap();
          const panel = tab.locator('.creation-menu-panel');
          await panel.waitFor();
          const menu = await panel.evaluate(scrollableByTouch);
          expect(menu.blocked).toEqual([]);
          if (menu.overflows) expect(menu.scroller).toBe(true);
          if (p.name.endsWith('landscape')) expect(menu.overflows).toBe(true);
          const leave = panel.getByRole('button', { name: /^Leave/ });
          await reachable(leave);
          await panel.getByRole('button', { name: /^Go to another room/ }).scrollIntoViewIfNeeded();

          // Its list of rooms: longer than any phone's screen.
          await panel.getByRole('button', { name: /^Go to another room/ }).tap();
          const rooms = tab.getByRole('dialog', { name: 'Go to another room' });
          await rooms.waitFor();
          expect(await rooms.evaluate(scrollableByTouch)).toEqual({
            scroller: true,
            overflows: true,
            blocked: [],
          });
          if (p.engine === 'chromium') {
            const box = await rooms.boundingBox();
            if (!box) throw new Error('no rooms');
            const x = box.x + box.width / 2;
            await drag(tab, [x, box.y + box.height - 40], [x, box.y + 40]);
            await expect.poll(() => rooms.evaluate((d) => d.scrollTop)).toBeGreaterThan(50);
            expect(await tab.evaluate(() => window.scrollY)).toBe(0);
          }
          const far = rooms.getByRole('button', { name: 'Room 20', exact: true });
          await reachable(far);
          await far.tap();
          await rooms.waitFor({ state: 'detached' });
          await expect
            .poll(async () => (await pose(tab)).roomKey, { timeout: 10_000 })
            .toBe('room20');
        } finally {
          await context.close();
        }
      });

      if (p.name.endsWith('landscape'))
        it('the way into a creation, sideways: the card beside the words, the way in on screen', {
          timeout: 90_000,
        }, async () => {
          const context = await phone(p);
          try {
            // A long name and nobody inside, as on the iPhone where the name went one word a line.
            const long = { ...creation, title: 'Riverside Bowling Clubhouse', playing: 0 };
            await context.route(
              (url) => url.pathname === '/api/spaces/s1/creations',
              (route) => route.fulfill({ status: 200, json: { creations: [long] } }),
            );
            // iPhones keep room for the notch at both sides. env() can't be played here, so the
            // tokens that carry it are set, from the start as on a phone.
            const notch = p.engine === 'webkit' ? 59 : 0;
            // The door picks its saying at random: this one has the longest meaning, the most
            // likely to run into the saying on a short card.
            const longest = DOOR_PHRASES.reduce(
              (best, p, i) => (p.en.length > (DOOR_PHRASES[best]?.en.length ?? 0) ? i : best),
              0,
            );
            await context.addInitScript(
              ([i, n]) => {
                Math.random = () => (i + 0.5) / n;
              },
              [longest, DOOR_PHRASES.length] as const,
            );
            await context.addInitScript((px) => {
              addEventListener('DOMContentLoaded', () => {
                const style = document.createElement('style');
                style.textContent = `:root { --ats-safe-left: ${px}px; --ats-safe-right: ${px}px; }`;
                document.head.append(style);
              });
            }, notch);
            const tab = await enter(context, '?object=desk');
            const picker = tab.getByRole('dialog', { name: long.title });
            await picker.waitFor();
            const measure = () =>
              picker.evaluate((d) => {
                const box = (el: Element | null) => {
                  if (!el) throw new Error('missing');
                  const { left, right, top, bottom, width, height } = el.getBoundingClientRect();
                  return { left, right, top, bottom, width, height };
                };
                const h2 = d.querySelector('h2') as HTMLElement;
                const go = [...d.querySelectorAll('button')].find(
                  (b) => b.textContent?.trim() === 'Go in',
                );
                return {
                  dialog: box(d),
                  art: box(d.querySelector('.door-art')),
                  saying: box(d.querySelector('.door-saying')),
                  meaning: box(d.querySelector('.door-art figcaption')),
                  body: box(d.querySelector('.portal-body')),
                  go: box(go ?? null),
                  lines: Math.round(
                    h2.getBoundingClientRect().height /
                      Number.parseFloat(getComputedStyle(h2).lineHeight),
                  ),
                  scrollTop: d.scrollTop,
                };
              });

            for (const size of [p.device.viewport, ...(SIDEWAYS[p.engine] ?? [])]) {
              await tab.setViewportSize(size);
              const where = `${size.width}×${size.height}`;
              // The card's height goes by the screen's (100dvh), which the browser only takes in
              // when it next draws: until then Chromium keeps the old one (seen for 2 s on a busy
              // machine), and WebKit can lay out a frame with it. Wait for frames drawn, then for the
              // card to reach the bottom before measuring the rest.
              await drawn(tab);
              await expect
                .poll(
                  async () => {
                    const now = await measure();
                    return Math.min(now.dialog.bottom, size.height) - now.art.bottom;
                  },
                  { timeout: FRAMES_MS },
                )
                .toBeLessThanOrEqual(30);
              const at = await measure();
              // Side by side, the card filling the right side, top to bottom (of the door, or of
              // the screen when the door is taller), the saying in it clear of what it means.
              expect(at.body.right, where).toBeLessThanOrEqual(at.art.left + 1);
              expect(at.art.top - at.dialog.top, where).toBeLessThanOrEqual(11);
              expect(
                Math.min(at.dialog.bottom, size.height) - at.art.bottom,
                where,
              ).toBeLessThanOrEqual(30);
              expect(at.saying.top, where).toBeGreaterThanOrEqual(at.art.top);
              expect(at.saying.bottom, where).toBeLessThanOrEqual(at.meaning.top + 1);
              // The name has room: half the door or more, and two lines at most.
              expect(at.body.width, where).toBeGreaterThanOrEqual(at.dialog.width * 0.5);
              expect(at.lines, where).toBeLessThanOrEqual(2);
              // The way in shows without scrolling, and the door is clear of the notch.
              expect(at.scrollTop, where).toBe(0);
              expect(at.go.bottom, where).toBeLessThanOrEqual(
                Math.min(at.dialog.bottom, size.height),
              );
              expect(at.dialog.left, where).toBeGreaterThanOrEqual(notch);
              expect(at.dialog.right, where).toBeLessThanOrEqual(size.width - notch);
            }

            // Upright again: the picture above the words, as before.
            await tab.setViewportSize({
              width: p.device.viewport.height,
              height: p.device.viewport.width,
            });
            const upright = await measure();
            expect(upright.art.bottom).toBeLessThanOrEqual(upright.body.top + 1);
            expect(upright.lines).toBeLessThanOrEqual(2);
          } finally {
            await context.close();
          }
        });

      it('the 3D view walks and looks by touch, and never moves the page', {
        timeout: 90_000,
      }, async () => {
        const context = await phone(p);
        try {
          const tab = await enter(context);
          // Only the view and the joystick hold touches to themselves.
          const held = await tab.evaluate(() =>
            ['.space-canvas', '.space-look', '.space-joystick'].map(
              (s) => getComputedStyle(document.querySelector(s) as Element).touchAction,
            ),
          );
          expect(held).toEqual(['none', 'none', 'none']);
          if (p.engine !== 'chromium') return; // a dragged finger can only be played in Chromium
          const size = tab.viewportSize();
          if (!size) throw new Error('no viewport');
          const before = await pose(tab);
          await drag(
            tab,
            [size.width * 0.7, size.height * 0.45],
            [size.width * 0.4, size.height * 0.5],
          );
          await expect
            .poll(async () => (await pose(tab)).yaw, { timeout: FRAMES_MS })
            .not.toBeCloseTo(before.yaw, 2);
          const stick = await tab.locator('.space-joystick').boundingBox();
          if (!stick) throw new Error('no joystick');
          const c: [number, number] = [stick.x + stick.width / 2, stick.y + stick.height / 2];
          await drag(tab, c, [c[0], stick.y + 4], 800);
          const after = await pose(tab);
          expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.3);
          expect(
            await tab.evaluate(() => [
              window.scrollX,
              window.scrollY,
              window.visualViewport?.scale,
            ]),
          ).toEqual([0, 0, 1]);
        } finally {
          await context.close();
        }
      });

      it('turned sideways and back: the menu and its pop-ups still take taps', {
        timeout: 90_000,
      }, async () => {
        const context = await phone(p);
        try {
          const tab = await enter(context);
          await turn(tab);
          expect(await still(tab)).toEqual([0, 0, 0, 0]);
          // iPhones can leave the page scrolled by the status bar's height after a turn (the page
          // taller than the screen for a moment): it goes back to the top.
          await tab.evaluate(() => {
            const tall = document.createElement('div');
            tall.style.height = '200vh';
            document.body.append(tall);
            window.scrollTo(0, 47);
          });
          await turn(tab);
          // The page settles over the next frames drawn (and timers up to 1.5 s), not at once.
          await expect.poll(() => still(tab), { timeout: FRAMES_MS }).toEqual([0, 0, 0, 0]);
          await menuAnswers(tab);
        } finally {
          await context.close();
        }
      });

      it('fingers on the view and the joystick as it turns, never lifted: the view lets go', {
        timeout: 90_000,
      }, async () => {
        const context = await phone(p);
        try {
          const tab = await enter(context);
          const size = tab.viewportSize();
          const stick = await tab.locator('.space-joystick').boundingBox();
          if (!size || !stick) throw new Error('no joystick');
          const thumb = { x: stick.x + stick.width / 2, y: stick.y + 6 };
          const finger = { x: size.width * 0.6, y: size.height * 0.45 };
          // Where the thumb goes down is the joystick (nothing over it to take the touch).
          expect(
            await tab.evaluate(
              ({ x, y }) => document.elementFromPoint(x, y)?.closest('.space-joystick') !== null,
              thumb,
            ),
          ).toBe(true);
          let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> | null = null;
          if (p.engine === 'chromium') {
            // Real touches: a thumb pushing the joystick forward, a finger dragging the view.
            cdp = await context.newCDPSession(tab);
            const points = (dx: number) => [
              { ...thumb, id: 1 },
              { x: finger.x + dx, y: finger.y, id: 2 },
            ];
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [{ ...thumb, id: 1 }],
            });
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: points(0),
            });
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchMove',
              touchPoints: points(-30),
            });
          } else {
            // WebKit can't hold a finger down from here: the pointers the page saw go down, whose
            // ends never come (as when an iPhone loses them in a turn).
            await tab.evaluate(
              ({ thumb, finger }) => {
                const down = (sel: string, id: number, at: { x: number; y: number }) =>
                  document.querySelector(sel)?.dispatchEvent(
                    new PointerEvent('pointerdown', {
                      pointerId: id,
                      pointerType: 'touch',
                      isPrimary: id === 41,
                      clientX: at.x,
                      clientY: at.y,
                      bubbles: true,
                    }),
                  );
                down('.space-joystick', 41, thumb);
                down('.space-look', 42, finger);
              },
              { thumb, finger },
            );
          }
          // Walking forward with the thumb down (software drawing can stall frames for a while).
          const before = await pose(tab);
          await expect
            .poll(
              async () => {
                const now = await pose(tab);
                return Math.hypot(now.x - before.x, now.z - before.z);
              },
              { timeout: FRAMES_MS },
            )
            .toBeGreaterThan(0.2);

          await turn(tab);
          await turn(tab);
          // The lost thumb no longer walks.
          const turned = await pose(tab);
          await tab.waitForTimeout(600);
          const later = await pose(tab);
          expect(Math.hypot(later.x - turned.x, later.z - turned.z)).toBeLessThan(0.05);
          expect(await still(tab)).toEqual([0, 0, 0, 0]);
          if (cdp) {
            await cdp.detach();
            // And the view still looks around by touch.
            await drag(
              tab,
              [size.width * 0.7, size.height * 0.45],
              [size.width * 0.4, size.height * 0.5],
            );
            await expect
              .poll(async () => (await pose(tab)).yaw, { timeout: FRAMES_MS })
              .not.toBeCloseTo(later.yaw, 2);
          }
          await menuAnswers(tab);
        } finally {
          await context.close();
        }
      });

      it("a creation: the app's Chat and Leave, and its link card, take taps", {
        timeout: 90_000,
      }, async () => {
        const context = await phone(p);
        try {
          const tab = await enter(context, '?object=desk');
          const picker = tab.getByRole('dialog', { name: creation.title });
          await picker.getByRole('button', { name: 'Go in on my own' }).tap();
          await tab.locator('iframe.creation-frame').waitFor();
          const card = tab.getByRole('dialog', { name: /Board games/ });
          await card.waitFor({ timeout: 15_000 });
          // The veil lifts: wait until it's gone, not a fixed time (WebKit can be slower).
          await tab.locator('.passage').waitFor({ state: 'detached', timeout: 15_000 });
          await tab.waitForTimeout(300);
          // The app's one control: a small glass button in the corner, opening Chat… and Leave, last.
          const menu = tab.locator('.creation-menu');
          const open = menu.getByRole('button', { name: /^Menu/ });
          await reachable(open);
          await open.tap();
          const chat = menu.getByRole('button', { name: /^Chat/ });
          await reachable(chat);
          if (process.env.WEB_TOUCH_SHOTS)
            await tab.screenshot({ path: `${process.env.WEB_TOUCH_SHOTS}/menu-${p.name}.png` });
          await chat.tap();
          await tab.getByRole('complementary', { name: 'Chat' }).waitFor();
          await reachable(open);
          await open.tap();
          await menu.getByRole('button', { name: /^Close chat/ }).tap();
          await tab.getByRole('complementary', { name: 'Chat' }).waitFor({ state: 'detached' });
          await reachable(card.getByRole('button', { name: 'Not now' }));
          await card.getByRole('button', { name: 'Not now' }).tap();
          await card.waitFor({ state: 'detached' });
          if (process.env.WEB_TOUCH_SHOTS)
            await tab.screenshot({ path: `${process.env.WEB_TOUCH_SHOTS}/closed-${p.name}.png` });
          await open.tap();
          const leave = menu.getByRole('button', { name: `Leave ${creation.title}`, exact: true });
          await reachable(leave);
          await leave.tap();
          await tab
            .locator('iframe.creation-frame')
            .waitFor({ state: 'detached', timeout: 15_000 });
        } finally {
          await context.close();
        }
      });
    });
  }
});
