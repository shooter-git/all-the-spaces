// @vitest-environment happy-dom
import type { PlaceVisits } from '@ats/api-types';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioSpace } from '../src/routes/StudioSpace.tsx';
import { routes, until } from './helpers/fakes.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const text = () => container.textContent ?? '';
const tab = (name: string) =>
  [...container.querySelectorAll<HTMLElement>('[role=tab]')].find((t) => t.textContent === name);
const button = (label: string | RegExp) =>
  [...container.querySelectorAll('button')].find((b) =>
    typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''),
  );
let at = '';
function Where() {
  const location = useLocation();
  at = `${location.pathname}${location.search}`;
  return null;
}

const HOUR = 3600;
const visits = (days: number): PlaceVisits => ({
  days,
  kept: 90,
  recording: true,
  timeZone: 'Europe/Lisbon',
  summary: {
    seconds: 5 * HOUR,
    people: 2,
    visits: 9,
    typicalSeconds: 25 * 60,
    cameBack: 1,
    togetherSeconds: HOUR,
    roomSeconds: 4 * HOUR,
  },
  trend: Array.from({ length: days }, (_, i) => ({
    from: `2026-10-${String(i + 1).padStart(2, '0')}`,
    days: 1,
    seconds: i === 2 ? 2 * HOUR : 0,
    people: i === 2 ? 2 : 0,
  })),
  week: Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => (d === 6 && h === 19 ? HOUR : 0)),
  ),
  devices: [
    { device: 'phone', seconds: 3 * HOUR },
    { device: null, seconds: 2 * HOUR },
  ],
  rooms: [
    {
      key: 'kitchen',
      name: 'Kitchen',
      floor: null,
      people: 2,
      seconds: 3 * HOUR,
      visits: 6,
      togetherSeconds: HOUR,
    },
    {
      key: 'hall',
      name: 'Hall',
      floor: null,
      people: 1,
      seconds: HOUR,
      visits: 3,
      togetherSeconds: 0,
    },
    {
      key: 'attic',
      name: 'Attic',
      floor: null,
      people: 0,
      seconds: 0,
      visits: 0,
      togetherSeconds: 0,
    },
  ],
  creations: [
    { id: 'c1', title: 'Marble run', people: 2, seconds: HOUR, visits: 4, togetherSeconds: 1800 },
  ],
  moves: [{ from: 'hall', to: 'kitchen', times: 3 }],
  people: [
    {
      userId: 'u2',
      name: 'Sam',
      color: '#94BBA0',
      seconds: 3 * HOUR,
      inCreations: HOUR,
      lastAt: new Date().toISOString(),
      days: 2,
      visits: 5,
      typicalSeconds: 30 * 60,
      togetherSeconds: 1800,
      rooms: [{ key: 'kitchen', seconds: 2 * HOUR }],
      creations: [{ id: 'c1', seconds: HOUR }],
      devices: [{ device: 'phone', seconds: 3 * HOUR }],
      hours: Array.from({ length: 24 }, (_, h) => (h === 19 ? 3 * HOUR : 0)),
    },
    {
      userId: 'u1',
      name: 'Pat',
      color: '#DDB08F',
      seconds: 2 * HOUR,
      inCreations: 0,
      lastAt: new Date().toISOString(),
      days: 1,
      visits: 4,
      typicalSeconds: 20 * 60,
      togetherSeconds: 1800,
      rooms: [{ key: 'kitchen', seconds: HOUR }],
      creations: [],
      devices: [{ device: null, seconds: 2 * HOUR }],
      hours: Array.from({ length: 24 }, () => 0),
    },
  ],
});

let asked: string[] = [];
let recording = true;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  asked = [];
  recording = true;
  const table = routes({
    '/api/spaces/s1/workspaces': () => ({
      available: true,
      space: { id: 's1', name: 'The flat', groupId: 'g1' },
      workspaces: [],
      objects: [],
    }),
    '/api/studio/assistants': () => ({ available: true, assistants: [] }),
    '/api/spaces/s1/versions': () => ({ liveSince: null, versions: [] }),
    '/api/spaces/s1/perf': () => ({ space: [], creations: [] }),
    '/api/spaces/s1/visits': () =>
      recording
        ? visits(Number(new URL(asked.at(-1) ?? '', 'http://x').searchParams.get('days')))
        : { ...visits(30), recording: false },
  });
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/spaces/s1/visits')) asked.push(String(input));
    return table(input, init);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = async (path: string) =>
  act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/space/:spaceId/studio"
            element={
              <>
                <StudioSpace />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    ),
  );

describe("a place's Studio", () => {
  it('is in three parts, one at a time; the part is in the address, and arrow keys move', async () => {
    await open('/space/s1/studio');
    await until(() => text().includes('Workspaces'));
    expect(tab('Build')?.getAttribute('aria-selected')).toBe('true');
    // Time isn't added up until it's asked for.
    expect(asked).toEqual([]);

    await act(async () => {
      tab('Build')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(tab('The place')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('The place'));
    expect(at).toBe('/space/s1/studio?tab=place');
    expect(text()).toContain('The place itself');

    await act(async () => tab('Time spent')?.click());
    await until(() => text().includes('Typical visit'));
    expect(at).toBe('/space/s1/studio?tab=time');
    // The parts already opened stay (hidden), keeping whatever was typed in them.
    const hidden = [...container.querySelectorAll('[role=tabpanel][hidden]')].map((p) => p.id);
    expect(hidden.sort()).toEqual(['studio-panel-build', 'studio-panel-place']);
  });
});

describe('where people spend time', () => {
  it("adds up the period asked for, in this browser's time zone", async () => {
    await open('/space/s1/studio?tab=time');
    await until(() => text().includes('Typical visit'));
    const first = new URL(asked[0] ?? '', 'http://x').searchParams;
    expect(first.get('days')).toBe('30');
    expect(first.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(text()).toContain('5 h');
    expect(text()).toContain('1 of 2 people came back on another day');
    expect(text()).toContain('25% of time in rooms was with someone else');
    expect(text()).toMatch(/Busiest · .*2 h · 2 people/);
    // The day-by-day chart is one slider: the arrow keys move along the days.
    const days = container.querySelector<HTMLElement>('[role=slider]');
    expect(days?.getAttribute('aria-valuenow')).toBe('2');
    await act(async () => {
      days?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(days?.getAttribute('aria-valuenow')).toBe('3');
    expect(days?.getAttribute('aria-valuetext')).toMatch(/: nobody$/);
    // Phones and time from before devices were recorded, as shares of the whole.
    expect(text()).toContain('Phones60%');
    expect(text()).toContain('from before devices were recorded');

    await act(async () => button('7 days')?.click());
    await until(() => asked.length === 2);
    expect(at).toContain('days=7');
    expect(new URL(asked[1] ?? '', 'http://x').searchParams.get('days')).toBe('7');
  });

  it('ranks rooms, with the moves between them; and creations', async () => {
    await open('/space/s1/studio?tab=time&see=rooms');
    await until(() => text().includes('Moves between rooms'));
    expect(text()).toContain('2 people · 6 visits · about 30 min each · 33% with someone else');
    expect(text()).toContain('Nobody yet: Attic');
    expect(text()).toContain('HallKitchen · 3 times');
    await act(async () => tab('Creations')?.click());
    expect(text()).toContain('2 people · opened 4 times · 50% played together');
  });

  it('opens each person onto their own rooms, creations and hours', async () => {
    await open('/space/s1/studio?tab=time&see=people');
    await until(() => text().includes('5 visits · 2 days'));
    const sam = button(/^Sam/);
    expect(sam?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => sam?.click());
    expect(sam?.getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('Kitchen2 h');
    expect(text()).toContain('Marble run1 h');
    expect(container.querySelector('[aria-label^="Mostly"]')).not.toBeNull();
    expect(text()).toContain('On phones 100%');
  });

  it('says when the group turned it off', async () => {
    recording = false;
    await open('/space/s1/studio?tab=time');
    await until(() => text().includes('turned off in Group settings'));
    expect(text()).not.toContain('Typical visit');
  });
});
