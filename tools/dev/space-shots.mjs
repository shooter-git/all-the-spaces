// Dev helper: opens a space in headless Chromium (software WebGL), walks around, and saves
// screenshots for desktop and phone (portrait + landscape). Uses the local dev account from .env.
//   node tools/dev/space-shots.mjs <spaceId> <outDir> [roomKey …]
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const [spaceId, outDir = '.data/shots', ...rooms] = process.argv.slice(2);
if (!spaceId) throw new Error('Usage: space-shots.mjs <spaceId> [outDir] [roomKey …]');
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const base = env.ATS_PUBLIC_URL;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});

async function open(viewport, label, opts = {}) {
  const context = await browser.newContext({ viewport, ...opts });
  const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
    headers: { origin: base },
    data: { email: env.DEV_ARCHITECT_EMAIL, password: env.DEV_ARCHITECT_PASSWORD },
  });
  if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()}`);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const started = Date.now();
  await page.goto(`${base}/space/${spaceId}?perf`);
  await page.waitForFunction(() => window.__atsViewer?.isReady, null, { timeout: 90_000 });
  const readyMs = Date.now() - started;
  await page.waitForTimeout(2500); // let full detail stream in
  await page.screenshot({ path: `${outDir}/${label}.png` });
  return { context, page, errors, readyMs };
}

const desktop = await open({ width: 1280, height: 720 }, 'desktop-start');
const d = desktop.page;
const stats0 = await d.evaluate(() => window.__atsViewer.stats());
console.log(`desktop: ready in ${desktop.readyMs} ms`, JSON.stringify(stats0));
// Walk forward for 2 seconds and turn a little.
await d.evaluate(() => window.__atsViewer.input.addLook(0.5, 0));
await d.keyboard.down('KeyW');
await d.waitForTimeout(2000);
await d.keyboard.up('KeyW');
await d.waitForTimeout(500);
console.log('after walking:', JSON.stringify(await d.evaluate(() => window.__atsViewer.pose())));
await d.screenshot({ path: `${outDir}/desktop-walked.png` });
for (const room of rooms) {
  await d.evaluate((r) => window.__atsViewer.travelTo(r), room);
  await d.waitForTimeout(2500);
  await d.screenshot({ path: `${outDir}/desktop-${room}.png` });
  console.log(
    `travelled to ${room}:`,
    JSON.stringify(await d.evaluate(() => window.__atsViewer.pose())),
  );
}
console.log('page errors:', desktop.errors.length ? desktop.errors : 'none');

const phone = { isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const portrait = await open({ width: 390, height: 844 }, 'phone-portrait', phone);
console.log(`phone portrait: ready in ${portrait.readyMs} ms, errors: ${portrait.errors.length}`);
const landscape = await open({ width: 844, height: 390 }, 'phone-landscape', phone);
console.log(
  `phone landscape: ready in ${landscape.readyMs} ms, errors: ${landscape.errors.length}`,
);
await browser.close();
