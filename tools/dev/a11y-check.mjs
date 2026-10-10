// Checks every 2D screen against WCAG 2.2 AA with axe: as the dev Architect and the dev member,
// in light and dark, on a laptop and a phone, and with the space's panels and dialogs open.
//   node tools/dev/a11y-check.mjs [spaceId] [--only <path-substring>] [--json out.json]
// Needs the dev stack (`pnpm dev`) and a space with a creation (`node tools/dev/add-samples.mjs`,
// `node tools/dev/publish-examples.mjs`). Exits 1 if anything fails. The 3D view itself is a
// canvas: what's checked there is everything drawn around it.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { chromium, devices } from 'playwright';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const base = env.ATS_PUBLIC_URL;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const only = flag('--only');
const jsonOut = flag('--json');
const spaceId =
  args[0] ??
  execFileSync(
    'docker',
    [
      'exec',
      'ats-dev-postgres-1',
      'psql',
      '-U',
      'ats',
      '-d',
      'ats',
      '-tAc',
      "select s.id from spaces s join creations c on c.space_id = s.id where s.sample = 'studio-apartment' and s.status = 'ready' order by s.created_at desc limit 1",
    ],
    { encoding: 'utf8' },
  ).trim();
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const signIn = async (ctx, who) => {
  if (!who) return;
  const res = await ctx.request.post(`${base}/api/auth/sign-in/email`, {
    headers: { origin: base },
    data: { email: env[`DEV_${who}_EMAIL`], password: env[`DEV_${who}_PASSWORD`] },
  });
  if (!res.ok()) throw new Error(`Could not sign in as the dev ${who.toLowerCase()}`);
};
const get = async (ctx, path) => (await ctx.request.get(`${base}${path}`)).json();

// What there is to look at.
const probe = await browser.newContext();
await signIn(probe, 'ARCHITECT');
const studio = await get(probe, `/api/spaces/${spaceId}/studio`);
const creation = studio.creations.find((c) => c.versions.length) ?? null;
const version = creation?.versions[0];
const build = studio.builds.find((b) => b.qa) ?? studio.builds[0];
const workspaces = (await get(probe, `/api/spaces/${spaceId}/workspaces`)).workspaces ?? [];
const queue = (await get(probe, '/api/studio/requests?all=1')).requests ?? [];
await probe.close();

/** Screens: [path, who, what to do first (optional)]. */
const screens = [
  ['/sign-in', null],
  ['/join', null],
  ['/', 'ARCHITECT'],
  ['/', 'MEMBER'],
  [`/space/${spaceId}`, 'MEMBER', 'space'],
  [`/space/${spaceId}`, 'MEMBER', 'chat'],
  [`/space/${spaceId}`, 'MEMBER', 'people'],
  [`/space/${spaceId}`, 'MEMBER', 'notifications'],
  [`/space/${spaceId}`, 'MEMBER', 'ask'],
  [`/space/${spaceId}/privacy`, 'ARCHITECT'],
  [`/space/${spaceId}/creations`, 'ARCHITECT'],
  [`/space/${spaceId}/studio`, 'ARCHITECT'],
  ...(workspaces[0] ? [[`/space/${spaceId}/studio/${workspaces[0].id}`, 'ARCHITECT']] : []),
  ['/studio/new-place', 'ARCHITECT'],
  ['/studio/assistants', 'ARCHITECT'],
  ['/group/people', 'ARCHITECT'],
  ['/group/settings', 'ARCHITECT'],
  ['/group/activity', 'ARCHITECT'],
  ['/group/server', 'ARCHITECT'],
  ['/account', 'ARCHITECT'],
  ['/account', 'MEMBER'],
  ...(build ? [[`/space/${spaceId}/builds/${build.id}`, 'ARCHITECT']] : []),
  ...(creation && version
    ? [[`/space/${spaceId}/creations/${creation.id}/try/${version.id}`, 'ARCHITECT']]
    : []),
  ['/requests', 'MEMBER'],
  ['/studio/requests', 'ARCHITECT'],
  ...(queue[0] ? [[`/requests/${queue[0].id}`, 'ARCHITECT']] : []),
];

async function prepare(page, what) {
  if (!what) return;
  await page.waitForFunction(() => window.__atsViewer?.isReady, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  if (what === 'chat') await page.getByRole('button', { name: /^Chat/ }).first().click();
  if (what === 'people')
    await page
      .getByRole('button', { name: /^People/ })
      .first()
      .click();
  if (what === 'notifications') await page.getByRole('button', { name: 'Notifications' }).click();
  if (what === 'ask') await page.getByRole('button', { name: 'Ask for something' }).click();
  await page.waitForTimeout(800);
}

/**
 * Tabs through the page: every stop must show a focus indicator and not be hidden under
 * something else (a fixed bar, a sheet). Reported in axe's shape.
 */
async function keyboard(page) {
  const problems = { hidden: [], unmarked: [] };
  await page
    .locator('body')
    .click({ position: { x: 1, y: 1 } })
    .catch(() => {});
  const seen = new Set();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const path = (e) => {
        const parts = [];
        for (let n = e; n && n !== document.body && parts.length < 4; n = n.parentElement)
          parts.unshift(
            n.tagName.toLowerCase() +
              (n.id ? `#${n.id}` : '') +
              (n.className && typeof n.className === 'string'
                ? `.${n.className.trim().split(/\s+/).slice(0, 2).join('.')}`
                : ''),
          );
        return parts.join(' > ');
      };
      // Focus inside a creation's frame or a terminal is that frame's business.
      if (el.tagName === 'IFRAME' || el.closest('.xterm')) return { key: path(el), skip: true };
      const style = getComputedStyle(el);
      const marked =
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
        (style.boxShadow && style.boxShadow !== 'none');
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const top = document.elementFromPoint(x, y);
      const visible = r.width > 0 && r.height > 0;
      const covered = visible && top && !(el === top || el.contains(top) || top.contains(el));
      return {
        key: path(el),
        marked,
        covered,
        visible,
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
      };
    });
    if (!stop) continue;
    if (seen.has(stop.key + stop.label)) break;
    seen.add(stop.key + stop.label);
    if (stop.skip || !stop.visible) continue;
    if (!stop.marked) problems.unmarked.push(stop);
    if (stop.covered) problems.hidden.push(stop);
  }
  const report = (id, help, list) =>
    list.length
      ? [
          {
            id,
            impact: 'serious',
            help,
            nodes: list.map((s) => ({ target: [s.key], failureSummary: `\n${s.label}` })),
          },
        ]
      : [];
  return [
    ...report('focus-not-visible', 'Keyboard focus is visible (2.4.7)', problems.unmarked),
    ...report('focus-obscured', 'Focused control is not hidden (2.4.11)', problems.hidden),
  ];
}

/** At 320 CSS pixels wide, nothing should need scrolling sideways (1.4.10). */
async function reflow(page) {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 320, height: before.height });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() =>
    document.documentElement.scrollWidth > innerWidth + 1
      ? [...document.querySelectorAll('body *')]
          .filter(
            (e) =>
              e.getBoundingClientRect().right > innerWidth + 1 &&
              getComputedStyle(e).position !== 'fixed',
          )
          .slice(0, 4)
          .map(
            (e) =>
              e.tagName.toLowerCase() +
              (typeof e.className === 'string' && e.className
                ? `.${e.className.split(' ')[0]}`
                : ''),
          )
      : [],
  );
  await page.setViewportSize(before);
  return wide.length
    ? [
        {
          id: 'reflow',
          impact: 'serious',
          help: 'Content fits 320px without scrolling sideways (1.4.10)',
          nodes: wide.map((t) => ({ target: [t], failureSummary: '' })),
        },
      ]
    : [];
}

const results = [];
let failed = 0;
for (const scheme of ['light', 'dark'])
  for (const [device, options] of [
    ['laptop', { viewport: { width: 1280, height: 800 } }],
    ['phone', devices['iPhone 13']],
  ]) {
    const contexts = {};
    for (const [path, who, what] of screens) {
      const label = `${path}${what ? ` (${what})` : ''} as ${who?.toLowerCase() ?? 'visitor'}`;
      if (only && !label.includes(only)) continue;
      const key = who ?? 'none';
      if (!contexts[key]) {
        contexts[key] = await browser.newContext({ ...options, colorScheme: scheme });
        await signIn(contexts[key], who);
      }
      const page = await contexts[key].newPage();
      try {
        await page.goto(`${base}${path}?quality=low`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(800);
        await prepare(page, what);
        const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        // What axe can't see: keyboard reach and focus (2.1.1, 2.4.7, 2.4.11), reflow (1.4.10).
        violations.push(
          ...(await keyboard(page)),
          ...(device === 'phone' ? await reflow(page) : []),
        );
        const found = violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 4).map((n) => ({
            target: n.target.join(' '),
            summary: n.failureSummary?.split('\n').slice(1, 3).join(' ').slice(0, 220),
          })),
          count: v.nodes.length,
        }));
        failed += found.length;
        results.push({ scheme, device, screen: label, violations: found });
        console.log(
          `${found.length ? 'FAIL' : 'pass'}  ${scheme}/${device}  ${label}${found.length ? `: ${found.map((f) => `${f.id}×${f.count}`).join(', ')}` : ''}`,
        );
      } catch (e) {
        failed++;
        results.push({ scheme, device, screen: label, error: e.message.split('\n')[0] });
        console.log(`ERR   ${scheme}/${device}  ${label}: ${e.message.split('\n')[0]}`);
      }
      await page.close();
    }
    for (const c of Object.values(contexts)) await c.close();
  }
await browser.close();
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
console.log(failed ? `\n${failed} problem(s).` : '\nEvery screen passes WCAG 2.2 AA checks.');
process.exitCode = failed ? 1 : 0;
