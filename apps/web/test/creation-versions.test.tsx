// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Studio, StudioVersion, StudioVersionConnector } from '../src/lib/studio.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let studio: Studio;
const madeLive: string[] = [];
const approved: unknown[] = [];
// Holds the next look at the studio back until the test lets it through.
let held: Promise<void> | null = null;
let refusal: string | null = null;

vi.mock('../src/lib/studio.ts', async (actual) => ({
  ...(await actual<typeof import('../src/lib/studio.ts')>()),
  loadStudio: async () => {
    await held;
    return studio;
  },
  loadFieldPerf: async () => ({ space: [], creations: [] }),
  makeLive: async (_creationId: string, versionId: string) => {
    if (refusal) throw new Error(refusal);
    madeLive.push(versionId);
    studio = {
      ...studio,
      creations: studio.creations.map((c) => ({
        ...c,
        versions: c.versions.map((v) => ({ ...v, live: v.id === versionId })),
      })),
    };
    return {};
  },
  approveConnectors: async (...args: unknown[]) => {
    approved.push(args);
    return {};
  },
}));
vi.mock('../src/lib/sources.ts', async (actual) => ({
  ...(await actual<typeof import('../src/lib/sources.ts')>()),
  loadSourceHosts: async () => [],
}));

const { Creations } = await import('../src/routes/Creations.tsx');

const version = (n: number, over: Partial<StudioVersion> = {}): StudioVersion => ({
  id: `v${n}`,
  number: n,
  status: 'published',
  live: false,
  createdAt: '2026-10-05T10:00:00Z',
  publishedAt: '2026-10-05T10:05:00Z',
  bytes: 2_400_000,
  qa: { ok: true, failed: 0, warned: 1, thumbnail: null, summary: null },
  buildId: null,
  saveVersion: 1,
  deviceTests: [],
  title: 'Marble run',
  connectors: [],
  sourceCommit: null,
  ...over,
});

const withVersions = (versions: StudioVersion[]): Studio => ({
  space: { id: 's1', name: 'The Workshop' },
  creations: [
    {
      id: 'c1',
      title: 'Marble run',
      description: '',
      defaultMode: 'solo',
      objectKey: 'shelf',
      object: { label: 'Shelf', room: 'Workshop' },
      currentVersionId: versions.find((v) => v.live)?.id ?? null,
      playing: 0,
      versions,
      source: null,
    },
  ],
  freeObjects: [],
  builds: [],
});

const weather: StudioVersionConnector = {
  id: 'weather',
  ops: ['forecast'],
  why: 'To show the sky outside.',
  displayName: 'Weather',
  operations: [{ name: 'forecast', kind: 'read', scope: 'weather', method: 'GET' }],
  approvedOps: [],
  approvedAt: null,
};

describe("a creation's versions, on the Creations page", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    madeLive.length = 0;
    approved.length = 0;
    held = null;
    refusal = null;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const show = async () => {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/space/s1/creations']}>
          <Routes>
            <Route path="/space/:spaceId/creations" element={<Creations />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
  };
  const button = (words: string) =>
    [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.includes(words) || b.getAttribute('aria-label')?.includes(words),
    );
  const row = (n: number) =>
    [...host.querySelectorAll('.studio-version')].find((r) =>
      r.textContent?.includes(`Version ${n}`),
    );
  const asking = () => host.querySelector('.studio-version .studio-confirm');

  it('makes a version that passed its checks live in one press, busy until it shows live', async () => {
    studio = withVersions([version(28, { status: 'candidate' }), version(27, { live: true })]);
    await show();
    let letThrough: () => void = () => {};
    held = new Promise((done) => {
      letThrough = done;
    });
    await act(async () => button('Make live')?.click());
    expect(madeLive).toEqual(['v28']);
    expect(asking()).toBeNull();
    // Gone live, but the shelf doesn't show it yet: the button stays busy rather than coming back.
    expect(button('Making it live')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => letThrough());
    expect(row(28)?.textContent).toContain('Live');
    expect(button('Make live')).toBeUndefined();
    expect(button('Making it live')).toBeUndefined();
  });

  it('goes back to an earlier version in one press too', async () => {
    studio = withVersions([version(28, { live: true }), version(27)]);
    await show();
    await act(async () => button('Details and')?.click());
    await act(async () => button('Go back to version 27')?.click());
    expect(madeLive).toEqual(['v27']);
    expect(asking()).toBeNull();
  });

  it('asks first when there are services to allow, and the question holds the only way on', async () => {
    studio = withVersions([
      version(28, { status: 'candidate', connectors: [weather] }),
      version(27, { live: true }),
    ]);
    await show();
    await act(async () => button('Make live')?.click());
    expect(madeLive).toEqual([]);
    expect(asking()?.textContent).toContain('To show the sky outside.');
    // One way on, not the row's button as well as the question's.
    expect(button('Make live')).toBeUndefined();
    await act(async () => button('Allow and make it live')?.click());
    expect(approved).toEqual([['c1', 'v28', [{ id: 'weather', ops: ['forecast'] }]]]);
    expect(madeLive).toEqual(['v28']);
    expect(asking()).toBeNull();
  });

  it('asks first when going back past a change in how it saves', async () => {
    studio = withVersions([version(28, { live: true, saveVersion: 2 }), version(27)]);
    await show();
    await act(async () => button('Details and')?.click());
    await act(async () => button('Go back to version 27')?.click());
    expect(madeLive).toEqual([]);
    expect(asking()?.textContent).toContain('saves things differently');
    await act(async () => button('Cancel')?.click());
    expect(asking()).toBeNull();
    expect(button('Go back to version 27')).toBeDefined();
  });

  it('says why when it could not go live, and offers it again', async () => {
    studio = withVersions([version(28, { status: 'candidate' }), version(27, { live: true })]);
    refusal = 'The server is restarting.';
    await show();
    await act(async () => button('Make live')?.click());
    expect(row(28)?.textContent).toContain('The server is restarting.');
    expect(button('Make live')?.getAttribute('aria-busy')).toBeNull();
  });
});
