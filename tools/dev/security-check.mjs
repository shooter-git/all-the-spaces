// Security check for creations, against the running dev stack:
//   node tools/dev/security-check.mjs [spaceId]
//
// Publishes two misbehaving test creations into the newest dev studio apartment and opens them
// the way a person would:
//   - "Sneaky" tries every way out of its frame (cookies, storage, the app's API, other
//     creations, the internet, the page around it, navigation, pop-ups, forms, flooding).
//   - "Frozen" says it's ready and then locks up: the app must stay responsive, notice, and let
//     the person leave.
// Prints pass/FAIL per check and exits non-zero on any failure.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const base = env.ATS_PUBLIC_URL;
const sql = (q) =>
  execFileSync(
    'docker',
    ['exec', 'ats-dev-postgres-1', 'psql', '-U', 'ats', '-d', 'ats', '-tAc', q],
    {
      encoding: 'utf8',
    },
  ).trim();
const space =
  process.argv[2] ??
  sql("select id from spaces where sample = 'studio-apartment' order by created_at desc limit 1");

for (const [name, object] of [
  ['sneaky', 'bookshelf'],
  ['frozen', 'bed'],
]) {
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@ats/server',
      'creation:publish',
      // They misbehave on purpose, so they skip the checks.
      '--unchecked',
      `../../tools/dev/fixtures/${name}`,
      '--space',
      space,
      '--object',
      object,
      '--title',
      `Test: ${name}`,
      '--mode',
      'solo',
    ],
    { stdio: 'ignore' },
  );
}
const idOf = (object) =>
  sql(`select id from creations where space_id = '${space}' and object_key = '${object}'`);

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
await context.request.post(`${base}/api/auth/sign-in/email`, {
  headers: { origin: base },
  data: { email: env.DEV_ARCHITECT_EMAIL, password: env.DEV_ARCHITECT_PASSWORD },
});
const page = await context.newPage();
await page.goto(`${base}/space/${space}?quality=mid`);
await page.waitForFunction(() => window.__atsViewer?.isReady, null, { timeout: 120000 });
await page.waitForFunction(() => typeof window.__atsOpenCreation === 'function');
const open = async (id) => {
  await page.waitForFunction((id) => window.__atsOpenCreation(id), id, { timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelector('.creation-host') && !document.querySelector('.passage'),
    null,
    { timeout: 60000 },
  );
};
const creationFrame = () => page.frames().find((f) => f.url().includes('/c/'));
const backToSpace = async () => {
  await page.getByRole('button', { name: /Back to/ }).click();
  await page.waitForFunction(
    () => !document.querySelector('.creation-host') && !document.querySelector('.passage'),
    null,
    { timeout: 60000 },
  );
};

// ---- Sneaky -----------------------------------------------------------------------------------
const appUrl = page.url();
await open(idOf('bookshelf'));
await page.waitForTimeout(1500);
const sneaky = await creationFrame().evaluate(() => window.results);
for (const [name, outcome] of Object.entries(sneaky)) {
  if (name === 'identity') continue;
  check(`A creation can't reach ${name}`, outcome.startsWith('blocked'), outcome);
}
check(
  "A creation can't send a form anywhere",
  creationFrame()?.url().includes('/c/') ?? false,
  creationFrame()?.url(),
);
check(
  'Its frame has no origin of its own (sealed)',
  (await creationFrame().evaluate(() => self.origin)) === 'null',
);
check('The page stays on the app', page.url() === appUrl, page.url());
check('No pop-up windows opened', context.pages().length === 1, `${context.pages().length} pages`);
const t0 = Date.now();
await page.evaluate(() => 1);
check(
  'The app stays responsive after being flooded',
  Date.now() - t0 < 1000,
  `${Date.now() - t0} ms`,
);
check(
  "The app's own Back button is still there",
  await page.getByRole('button', { name: /Back to/ }).isVisible(),
);
await backToSpace();

// ---- Frozen -----------------------------------------------------------------------------------
await open(idOf('bed'));
await page.waitForTimeout(2500); // it locks up 1.5 s after saying it's ready
const t1 = Date.now();
await page.evaluate(() => 1);
check(
  'The app stays responsive while a creation is frozen',
  Date.now() - t1 < 1000,
  `${Date.now() - t1} ms`,
);
await page
  .getByRole('alertdialog')
  .waitFor({ timeout: 15000 })
  .catch(() => {});
check('The app notices it has stopped responding', await page.getByRole('alertdialog').isVisible());
await page
  .getByRole('button', { name: 'Leave' })
  .click()
  .catch(() => {});
await page
  .waitForFunction(() => !document.querySelector('.creation-host'), null, { timeout: 30000 })
  .catch(() => {});
check('…and lets the person leave', (await page.locator('.creation-host').count()) === 0);

await browser.close();
for (const r of results)
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
