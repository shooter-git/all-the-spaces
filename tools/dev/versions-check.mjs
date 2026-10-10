// Checks updating a creation while someone is inside it, against the dev stack:
//   node tools/dev/versions-check.mjs [spaceId]
//
// 1. Version 1 of a small creation (it saves a visit count as a number) goes live.
// 2. Someone opens it and it saves.
// 3. Version 2 goes live (it saves an object, and upgrades version 1's number with migrate).
//    The same person opens it on another device: it reads version 1's save through migrate.
// 4. Back on the first device, still in version 1, they save again: refused (version 2 has
//    saved since, in a shape version 1 doesn't know), and the app offers to rejoin.
// 5. Rejoining opens version 2, which carries on from what it saved.
// Prints pass/FAIL per step and exits non-zero on any failure.
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
const OBJECT = 'dining-table';
const publish = (version) =>
  execFileSync(
    'pnpm',
    [
      '-s',
      '--filter',
      '@ats/server',
      'creation:publish',
      `../../tools/dev/fixtures/versions/v${version}`,
      '--space',
      space,
      '--object',
      OBJECT,
    ],
    { stdio: 'inherit' },
  );

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// Start clean: an earlier run's creation (and its saves) would change the counts.
sql(`delete from creations where space_id = '${space}' and object_key = '${OBJECT}'`);
publish(1);
const id = sql(`select id from creations where space_id = '${space}' and object_key = '${OBJECT}'`);

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 960, height: 600 } });
await context.request.post(`${base}/api/auth/sign-in/email`, {
  headers: { origin: base },
  data: { email: env.DEV_MEMBER_EMAIL, password: env.DEV_MEMBER_PASSWORD },
});
const openIn = async (page) => {
  await page.goto(`${base}/space/${space}?quality=low`);
  await page.waitForFunction(() => window.__atsViewer?.isReady, null, { timeout: 120000 });
  await page.waitForFunction((id) => window.__atsOpenCreation?.(id), id, { timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelector('.creation-host') && !document.querySelector('.passage'),
    null,
    { timeout: 60000 },
  );
};
const frameOf = (page) => page.frames().find((f) => f.url().includes('/c/'));
const text = async (page, sel) =>
  (await frameOf(page)
    ?.locator(sel)
    .textContent()
    .catch(() => '')) ?? '';

const first = await context.newPage();
await openIn(first);
await frameOf(first)?.locator('#count', { hasText: 'Visit' }).waitFor();
check(
  'Version 1 opens and saves',
  (await text(first, '#count')) === 'Visit 1',
  await text(first, '#count'),
);

publish(2);
const second = await context.newPage();
await openIn(second);
await frameOf(second)
  ?.locator('#count', { hasText: 'Visits:' })
  .waitFor({ timeout: 30000 })
  .catch(() => {});
const upgraded = await text(second, '#count');
check(
  "Version 2 reads version 1's save through migrate",
  upgraded === 'Visits: 2 (upgraded from version 1)',
  upgraded,
);
await second.close();

await first.bringToFront();
await frameOf(first)?.locator('#again').click();
const dialog = first.getByRole('dialog', { name: 'A newer version is here' });
await dialog.waitFor({ timeout: 20000 }).catch(() => {});
await frameOf(first)
  ?.locator('#status', { hasText: 'Not saved' })
  .waitFor({ timeout: 5000 })
  .catch(() => {});
check(
  "Version 1 can't overwrite what version 2 saved",
  (await text(first, '#status')).startsWith('Not saved'),
  await text(first, '#status'),
);
check('The app offers to rejoin', await dialog.isVisible());
if (await dialog.isVisible()) {
  await first.getByRole('button', { name: 'Rejoin' }).click();
  await first
    .waitForFunction(
      () => document.querySelector('.creation-host') && !document.querySelector('.passage'),
      null,
      { timeout: 60000 },
    )
    .catch(() => {});
  await frameOf(first)
    ?.locator('#count', { hasText: 'Visits:' })
    .waitFor({ timeout: 60000 })
    .catch(() => {});
  const after = await text(first, '#count');
  check(
    'Rejoining opens version 2, carrying on',
    after === 'Visits: 3 (upgraded from version 1)',
    after,
  );
}

await browser.close();
for (const r of results)
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
