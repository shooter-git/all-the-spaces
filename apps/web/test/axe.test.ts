// The app's main pages on phones, in a real browser, checked with axe-core (WCAG 2.2 A and AA).
// Runs against the built app: `pnpm --filter @ats/web build`, then `pnpm --filter @ats/web
// test:axe` (CI does both). The server is played by fixtures, so nothing else needs to run.
import { createServer } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, chromium, type Route } from 'playwright';
import { type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = process.env.WEB_AXE ? describe : describe.skip;

const architect = {
  user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.test', image: null },
  groups: [{ groupId: 'g1', groupName: 'The Workshop', themeColor: '#D3DDE8', role: 'architect' }],
};
const workspace = {
  id: 'w1',
  title: 'Marble run',
  kind: 'creation',
  request: null,
  brief: 'A marble run that two people can build together.',
  provider: 'claude',
  assistant: 'Claude Code',
  choice: { model: null, effort: null },
  runsWith: { model: 'claude-sonnet-5', effort: 'medium' },
  status: 'running',
  stoppedBecause: null,
  creationId: null,
  spaceId: 's1',
  objectKey: null,
  startedAt: '2026-10-03T09:00:00Z',
  limits: { idleMinutes: 30, sessionHours: 4 },
  // Soon, so its page shows the warning with Stay awake.
  sleepsAt: new Date(Date.now() + 4 * 60_000).toISOString(),
  lastBuild: null,
  blockedHosts: [],
};

const version = (n: number, live: boolean, sourceCommit: string | null) => ({
  id: `v${n}`,
  number: n,
  status: 'published',
  live,
  createdAt: '2026-10-05T10:00:00Z',
  publishedAt: '2026-10-05T10:05:00Z',
  bytes: 2_400_000,
  qa: { ok: true, failed: 0, warned: 0, thumbnail: null, summary: null },
  buildId: null,
  saveVersion: 1,
  deviceTests: [],
  title: 'Marble run',
  connectors: [],
  sourceCommit,
});
/** A space's creations: one following a repository (with something newer), one from the Studio. */
const studio = {
  space: { id: 's1', name: 'The Workshop' },
  creations: [
    {
      id: 'c1',
      title: 'Marble run',
      description: '',
      defaultMode: 'solo',
      objectKey: 'shelf',
      object: { label: 'Shelf', room: 'Workshop' },
      currentVersionId: 'v2',
      playing: 0,
      versions: [version(2, true, 'a1b2c3d4'.repeat(5)), version(1, false, 'f0e1d2c3'.repeat(5))],
      source: {
        host: 'github',
        hostName: 'GitHub',
        repository: 'lanternfield-club/marble-run',
        path: 'creation',
        follows: 'release',
        ref: null,
        updateMode: 'candidate',
        builtCommit: 'a1b2c3d4'.repeat(5),
        latestCommit: '0badc0de'.repeat(5),
        latestLabel: 'v1.2',
        behindBy: 2,
        checkedAt: '2026-10-07T09:00:00Z',
        checkError: null,
      },
    },
    {
      id: 'c2',
      title: 'Workbench journal',
      description: '',
      defaultMode: 'shared',
      objectKey: 'desk',
      object: { label: 'Desk', room: 'Workshop' },
      currentVersionId: 'v3',
      playing: 1,
      versions: [
        { ...version(3, true, 'c0ffee00'.repeat(5)), id: 'v3', title: 'Workbench journal' },
      ],
      // Up to date, so folded to one line: a long commit message there is cut short, and never
      // widens the card (or the page) on a phone.
      source: {
        host: 'github',
        hostName: 'GitHub',
        repository: 'lanternfield-club/workbench-journal',
        path: 'creation',
        follows: 'branch',
        ref: 'main',
        updateMode: 'candidate',
        builtCommit: 'c0ffee00'.repeat(5),
        latestCommit: 'c0ffee00'.repeat(5),
        latestLabel:
          'Fix the journal’s page turns on phones held upright, and keep every entry’s sketches',
        behindBy: 0,
        checkedAt: '2026-10-07T09:00:00Z',
        checkError: null,
      },
    },
  ],
  freeObjects: [{ key: 'lamp', label: 'Lamp', room: 'Workshop' }],
  builds: [],
};

/** What the server would say, by path. Anything else: 404. */
function answers(signedIn: boolean): Record<string, unknown> {
  return {
    '/api/setup/status': { setupComplete: true },
    '/api/me': signedIn ? architect : { user: null, groups: [] },
    '/api/spaces': {
      spaces: [
        {
          id: 's1',
          name: 'The Workshop',
          spaceType: 'house',
          sample: null,
          groupId: 'g1',
          status: 'ready',
          sketch: null,
        },
      ],
      samples: [],
    },
    '/api/notifications': { notifications: [], unread: 0, more: false },
    '/api/spaces/s1/studio': studio,
    '/api/spaces/s1/perf': { space: [], creations: [] },
    '/api/sources': [
      { id: 'github', displayName: 'GitHub', repositories: ['lanternfield-club/*'] },
    ],
    '/api/server': {
      release: 'v0.1.0',
      address: 'https://spaces.example.test',
      storage: 'builtin',
      backups: { schedule: 'nightly', keepDays: 14, offsite: false },
      features: { studio: true, voice: false, email: true },
      counts: { people: 4, spaces: 1, creations: 2 },
      owner: { name: 'Ada Lovelace', you: true },
    },
    // The owner's view: GitHub switched on for two lists, and a host set up in a file.
    '/api/server/sources': {
      hosts: [
        {
          id: 'github-public',
          displayName: 'GitHub',
          from: 'built-in',
          on: true,
          address: 'api.github.com',
          fileRepositories: [],
          token: false,
          repositories: ['lanternfield-club/*', 'someone/marble-run'],
        },
        {
          id: 'our-github',
          displayName: 'Our GitHub Enterprise',
          from: 'file',
          on: true,
          address: 'github.example.test',
          fileRepositories: ['workshop/*'],
          token: true,
          repositories: [],
        },
      ],
    },
    '/api/studio/assistants': { available: true, assistants: [] },
    '/api/studio/requests': { requests: [] },
    '/api/requests': { requests: [] },
    '/api/account/sessions': {
      sessions: [
        {
          id: 'x1',
          createdAt: '2026-10-01T09:00:00Z',
          lastActiveAt: '2026-10-03T09:00:00Z',
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1',
          current: true,
        },
      ],
    },
    '/api/auth/passkey/list-user-passkeys': [],
    '/api/workspaces/w1': workspace,
    '/api/workspaces/w1/uploads': { files: [] },
    '/api/workspaces/w1/preview': { state: 'off' },
  };
}

const PAGES = [
  { name: 'Home', path: '/', signedIn: true, ready: 'The Workshop' },
  { name: 'Sign-in', path: '/sign-in', signedIn: false, ready: 'Sign in' },
  { name: 'Account', path: '/account', signedIn: true, ready: 'Passkeys' },
  { name: 'Workspace', path: '/space/s1/studio/w1', signedIn: true, ready: 'Marble run' },
  {
    name: 'Creations',
    path: '/space/s1/creations',
    signedIn: true,
    ready: 'lanternfield-club/marble-run',
  },
  { name: 'Server', path: '/group/server', signedIn: true, ready: 'Our GitHub Enterprise' },
];
const SCREENS = [
  { name: 'portrait', viewport: { width: 390, height: 844 } },
  { name: 'landscape', viewport: { width: 844, height: 390 } },
];
const SCHEMES = ['light', 'dark'] as const;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port')),
      );
    });
  });

run('accessibility on phones (axe)', () => {
  let server: PreviewServer;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    const port = await freePort();
    server = await preview({ preview: { host: '127.0.0.1', port, strictPort: true } });
    base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  });

  async function open(context: BrowserContext, page: (typeof PAGES)[number]) {
    const table = answers(page.signedIn);
    await context.route('**/api/**', (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      const body = table[path];
      return route.fulfill(
        body === undefined
          ? { status: 404, json: { error: 'Not found' } }
          : { status: 200, json: body },
      );
    });
    const tab = await context.newPage();
    // Live connections (chat, the terminal): accepted, and quiet.
    await tab.routeWebSocket(/\/api\//, () => {});
    await tab.goto(`${base}${page.path}`);
    await tab.getByText(page.ready, { exact: false }).first().waitFor({ timeout: 15_000 });
    // Let entrances finish (they fade in).
    await tab.waitForTimeout(400);
    return tab;
  }

  for (const scheme of SCHEMES) {
    for (const screen of SCREENS) {
      for (const page of PAGES) {
        it(`${page.name}, ${screen.name}, ${scheme}`, { timeout: 60_000 }, async () => {
          const context = await browser.newContext({
            viewport: screen.viewport,
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 2,
            colorScheme: scheme,
            reducedMotion: 'reduce',
            // Requests must reach the fixtures above, not a service worker's cache.
            serviceWorkers: 'block',
          });
          try {
            const tab = await open(context, page);
            if (process.env.WEB_AXE_SHOTS)
              await tab.screenshot({
                path: `${process.env.WEB_AXE_SHOTS}/${page.name}-${screen.name}-${scheme}.png`,
                fullPage: true,
              });
            // Nothing wider than the phone: the page never scrolls sideways. (Against the phone's
            // own width: a phone widens its layout to fit what overflows, innerWidth with it.)
            expect(
              await tab.evaluate(() => document.documentElement.scrollWidth),
              'page width',
            ).toBeLessThanOrEqual(screen.viewport.width);
            const result = await new AxeBuilder({ page: tab })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
              .analyze();
            const problems = result.violations.map(
              (v) =>
                `${v.id} (${v.impact}): ${v.help} — ${v.nodes
                  .map((n) => n.target.join(' '))
                  .join(', ')}`,
            );
            expect(problems).toEqual([]);
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});
