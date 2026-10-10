// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../src/lib/api.ts';
import { NotificationsProvider } from '../src/lib/notifications.tsx';
import { OPEN_TIMEOUT_MS, SpaceView } from '../src/routes/SpaceView.tsx';
import { FakeSocket, FakeViewer, json, routes, until } from './helpers/fakes.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@ats/viewer-core', async () => ({
  SpaceViewer: (await import('./helpers/fakes.ts')).FakeViewer,
}));
// No sound card here.
vi.mock('../src/lib/sound.ts', () => {
  const quiet = new Proxy({}, { get: (_t, key) => (key === 'out' ? () => null : () => {}) });
  return { sound: quiet, useSoundPrefs: () => ({ on: false, volume: 0 }) };
});

const manifest = {
  name: 'The Workshop',
  floors: [{ key: 'ground', name: 'Ground', elevation: 0 }],
  rooms: [{ key: 'hall', name: 'Hall', floorKey: 'ground', objects: [] }],
  spawns: [],
  links: [],
};
const ada: Me = {
  user: { id: 'u1', name: 'Ada', email: 'ada@example.test', image: null },
  groups: [{ groupId: 'g1', groupName: 'Home', themeColor: null, role: 'member' }],
};

let container: HTMLElement;
let root: Root;
let manifestLoads = 0;
let fetched: string[] = [];
const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

async function open(me: Me = ada) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/space/s1']}>
        <NotificationsProvider>
          <Routes>
            <Route path="/space/:spaceId" element={<SpaceView me={me} />} />
            <Route path="/" element={<p>Home</p>} />
          </Routes>
        </NotificationsProvider>
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  FakeViewer.all = [];
  FakeSocket.all = [];
  manifestLoads = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
  fetched = [];
  const table = routes({
    '/api/spaces/s1/manifest': () => {
      manifestLoads++;
      return manifest;
    },
    '/api/spaces/s1/creations': () => ({ creations: [] }),
    '/api/spaces/s1/requests/objects': () => ({ objects: {} }),
    '/api/notifications': () => ({ notifications: [], unread: 0, more: false }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input));
      return table(input, init);
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('opening a space', () => {
  it('shows what went wrong, with Try again, when the room you start in fails to load', async () => {
    await open();
    await until(() => FakeViewer.all.length === 1);
    const first = FakeViewer.last;
    act(() => first?.onError?.(new Error('403')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't be loaded");
    expect(first?.disposed).toBe(true);

    await act(async () => button('Try again')?.click());
    await until(() => FakeViewer.all.length === 2);
    expect(manifestLoads).toBe(2);
    expect(text()).not.toContain("couldn't be loaded");
  });

  it('says so when the space never finishes opening', async () => {
    await open();
    await until(() => FakeViewer.all.length === 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('too long');
    expect(button('Try again')).toBeTruthy();
    expect(button('Back home')).toBeTruthy();
  });

  it('shows how far it has got, and keeps waiting while it gets further', async () => {
    await open();
    await until(() => FakeViewer.all.length === 1);
    const bar = () => container.querySelector('[role="progressbar"]');
    act(() => FakeViewer.last?.onProgress?.(0.25));
    expect(bar()?.getAttribute('aria-valuenow')).toBe('25');
    // A big place on a slow connection: longer than the wait in all, but always getting further.
    for (const fraction of [0.5, 0.75, 0.99]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS - 1000);
      });
      act(() => FakeViewer.last?.onProgress?.(fraction));
    }
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(bar()?.getAttribute('aria-valuenow')).toBe('99');
    // Then it stops getting anywhere.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('too long');
  });

  it('stays quiet once the space is ready', async () => {
    await open();
    await until(() => FakeViewer.all.length === 1);
    act(() => FakeViewer.last?.onReady?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS * 2);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('who you are', () => {
  it('comes from the app, not another /api/me request', async () => {
    await open();
    await until(() => FakeViewer.all.length === 1);
    expect(fetched).not.toContain('/api/me');
  });

  it('signed out shows the error screen, not the veil', async () => {
    await open({ user: null, groups: [] });
    await act(async () => {});
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('signed out');
    expect(button('Back home')).toBeTruthy();
    expect(text()).not.toContain('Opening');
  });
});

describe('the installed app on a phone', () => {
  it('takes the whole screen from the first tap on the 3D view, and gives it back on leaving', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(pointer: coarse)' || query === '(display-mode: standalone)',
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    const page = document.documentElement;
    let full: Element | null = null;
    page.requestFullscreen = vi.fn(async () => {
      full = page;
    });
    Object.defineProperty(document, 'fullscreenElement', { get: () => full, configurable: true });
    const exit = vi.fn(async () => {
      full = null;
    });
    document.exitFullscreen = exit;

    await open();
    await until(() => FakeViewer.all.length === 1);
    expect(page.requestFullscreen).not.toHaveBeenCalled();
    const tap = (el: Element | null | undefined) =>
      act(() => {
        el?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        el?.dispatchEvent(new Event('pointerup', { bubbles: true }));
      });
    // Not from a control: the screen growing under the finger would make that tap miss.
    tap(container.querySelector('button[aria-label="Leave the space"]'));
    expect(page.requestFullscreen).not.toHaveBeenCalled();
    tap(container.querySelector('.space-canvas'));
    expect(page.requestFullscreen).toHaveBeenCalledOnce();
    tap(container.querySelector('.space-canvas'));
    expect(page.requestFullscreen).toHaveBeenCalledOnce();
    act(() => root.unmount());
    expect(exit).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});

describe('the keyboard in a space', () => {
  const press = (target: EventTarget, key: string) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  const chat = () => container.querySelector('aside[aria-label="Chat"]');

  it('Enter on the space opens the chat, Escape closes it', async () => {
    await open();
    await until(() => FakeViewer.all.length === 1);
    act(() => FakeViewer.last?.onReady?.());
    press(document.body, 'Enter');
    expect(chat()).not.toBeNull();
    press(document.body, 'Escape');
    expect(chat()).toBeNull();
  });

  it('Enter on one of its buttons presses the button and leaves the chat shut', async () => {
    await open();
    await until(() => FakeViewer.all.length === 1);
    act(() => FakeViewer.last?.onReady?.());
    const people = container.querySelector<HTMLButtonElement>('button[aria-label^="People here"]');
    people?.focus();
    press(people as HTMLButtonElement, 'Enter');
    expect(chat()).toBeNull();
  });
});

describe('back from linking an account', () => {
  const lanternfield = {
    id: 'lanternfield-library',
    displayName: 'Lanternfield Library',
    description: '',
    scopes: ['loans:read'],
    linked: false,
    linkedAt: null,
    broken: false,
    accountName: null,
    checked: false,
  };
  function withConnectors() {
    const base = fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/connectors'
        ? json({ connectors: [lanternfield] })
        : base(input, init),
    );
  }
  const toast = () => container.querySelector('.chat-toast')?.textContent ?? '';

  it('says plainly when the service refused the account, naming it', async () => {
    window.history.replaceState(
      null,
      '',
      '/space/s1?object=desk&link_error=refused_by_service&link_connector=lanternfield-library&link_reason=ACCOUNT_SUSPENDED',
    );
    withConnectors();
    await open();
    await until(() => toast() !== '');
    expect(toast()).toBe(
      'Lanternfield Library said this account can’t use it. Link a different account, or ask its owner.',
    );
    // Nothing technical, and the flags are gone from the address.
    expect(toast()).not.toContain('ACCOUNT_SUSPENDED');
    expect(window.location.search).toBe('?object=desk');
  });

  it('says when it couldn’t be checked yet', async () => {
    window.history.replaceState(
      null,
      '',
      '/space/s1?linked=lanternfield-library&link_check=unconfirmed',
    );
    withConnectors();
    await open();
    await until(() => toast() !== '');
    expect(toast()).toBe(
      'Linked, but Lanternfield Library couldn’t be reached to check it yet. Open the creation again to carry on.',
    );
    expect(window.location.search).toBe('');
  });
});
