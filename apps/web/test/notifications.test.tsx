// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationSheet } from '../src/components/NotificationBell.tsx';
import { NotificationsProvider } from '../src/lib/notifications.tsx';
import { FakeSocket, routes, until } from './helpers/fakes.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const text = () => container.textContent ?? '';
const buttons = (label: string) =>
  [...container.querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
  );

const note = (id: string, title: string, read: boolean) => ({
  id,
  kind: 'request.new',
  title,
  body: '',
  url: null,
  read,
  createdAt: new Date().toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.open = true;
  });
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
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

describe('clearing notifications', () => {
  it('clears one with its ×, and all the read ones with Clear read', async () => {
    const deleted: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/notifications': (init) => {
          if (init?.method === 'DELETE') {
            deleted.push(JSON.parse(String(init.body)));
            return { ok: true };
          }
          return {
            notifications: [
              note('n1', 'A lamp is ready', false),
              note('n2', 'A desk clock is ready', true),
              note('n3', 'Marble run: a new commit in its repository', true),
            ],
            unread: 1,
            more: false,
          };
        },
      }),
    );
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NotificationsProvider>
            <NotificationSheet onClose={() => {}} />
          </NotificationsProvider>
        </MemoryRouter>,
      ),
    );
    await until(() => text().includes('A lamp is ready'));

    // Each has its own ×, beside its button rather than inside it.
    const clears = buttons('Clear');
    expect(clears).toHaveLength(3);
    for (const c of clears) expect(c.closest('.notify-item')).toBeNull();

    // The unread one, cleared by hand: gone, and no longer counted.
    await act(async () => clears[0]?.click());
    expect(text()).not.toContain('A lamp is ready');
    expect(deleted).toEqual([{ ids: ['n1'] }]);
    expect(buttons('Mark all read')).toHaveLength(0);

    // The read ones, all at once.
    await act(async () => buttons('Clear read')[0]?.click());
    expect(deleted.at(-1)).toEqual({ read: true });
    expect(text()).not.toContain('A desk clock');
    expect(text()).not.toContain('Marble run');
    expect(buttons('Clear read')).toHaveLength(0);
    expect(text()).toContain('Nothing yet');
  });
});
