// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What fetch does with no network, and a server that's up but nobody is signed in.
const noNetwork = () => Promise.reject(new TypeError('Failed to fetch'));
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const serverUp = (input: RequestInfo | URL) => {
  const path = String(input);
  if (path === '/api/setup/status') return json({ setupComplete: true });
  if (path === '/api/me') return json({ user: null, groups: [] });
  return json({});
};

let container: HTMLElement;
let root: Root;
const text = () => container.textContent ?? '';

/**
 * Lets the app run until `done` holds: the api helper's waits between tries (on fake timers), and
 * pages loading (real time: they're imported when first shown).
 */
async function until(done: () => boolean) {
  const giveUp = performance.now() + 5000;
  while (!done() && performance.now() < giveUp) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  expect(done()).toBe(true);
}

async function open() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
  });
}

describe('starting the app', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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

  it('says it is offline, with a Retry button, instead of "Loading…" forever', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    vi.stubGlobal('fetch', vi.fn(noNetwork));
    await open();
    await until(() => text().includes("You're offline"));
    expect(text()).not.toContain('Loading…');
    expect(container.querySelector('[role="alert"] button')?.textContent).toContain('Retry');
  });

  it("says the server can't be reached when the device is online", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json({ error: 'Bad gateway' }, 502)),
    );
    await open();
    await until(() => text().includes("Can't reach the server"));
  });

  it('starts once Retry is pressed and the server answers', async () => {
    const fetch = vi.fn(noNetwork);
    vi.stubGlobal('fetch', fetch);
    await open();
    await until(() => text().includes("Can't reach the server"));
    fetch.mockImplementation(serverUp);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    });
    await until(() => text().includes('Sign in'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('tries again by itself when the device comes back online', async () => {
    const fetch = vi.fn(noNetwork);
    vi.stubGlobal('fetch', fetch);
    await open();
    await until(() => text().includes("Can't reach the server"));
    fetch.mockImplementation(serverUp);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await until(() => text().includes('Sign in'));
  });

  it('tries again by itself when the app is brought back to the front', async () => {
    const fetch = vi.fn(noNetwork);
    vi.stubGlobal('fetch', fetch);
    await open();
    await until(() => text().includes("Can't reach the server"));
    fetch.mockImplementation(serverUp);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until(() => text().includes('Sign in'));
  });
});
