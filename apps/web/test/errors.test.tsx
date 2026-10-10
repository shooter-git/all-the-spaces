// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSettings } from '../src/components/ChatSettings.tsx';
import { NotificationsProvider } from '../src/lib/notifications.tsx';
import { Home } from '../src/routes/Home.tsx';
import { SignIn } from '../src/routes/SignIn.tsx';
import { FakeSocket, json, routes, until } from './helpers/fakes.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auth = vi.hoisted(() => ({
  signIn: { email: vi.fn(), passkey: vi.fn() },
  signOut: vi.fn(),
}));
vi.mock('../src/lib/auth-client.ts', () => ({ authClient: auth }));

let container: HTMLElement;
let root: Root;
const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent?.includes(label) || b.getAttribute('aria-label') === label,
  );
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
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
  vi.clearAllMocks();
});

describe('signing in without a connection', () => {
  it('says so, and the button works again', async () => {
    auth.signIn.email.mockImplementation(offline);
    const signedIn = vi.fn();
    act(() => root.render(<SignIn onSignedIn={signedIn} />));
    await act(async () =>
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(text()).toContain("Couldn't reach the server");
    expect(button('Sign in')?.disabled).toBe(false);
    expect(signedIn).not.toHaveBeenCalled();
  });

  it('with a passkey: says it did not work, instead of nothing at all', async () => {
    auth.signIn.passkey.mockImplementation(offline);
    act(() => root.render(<SignIn onSignedIn={() => {}} />));
    await act(async () => button('Use a passkey instead')?.click());
    expect(text()).toContain('Passkey sign-in did not work');
  });
});

describe('signing out without a connection', () => {
  it('says so and stays signed in', async () => {
    auth.signOut.mockImplementation(offline);
    vi.stubGlobal('fetch', routes({}));
    const signedOut = vi.fn();
    const me = {
      user: { id: 'u1', name: 'Ada', email: 'ada@example.test', image: null },
      groups: [],
    };
    await act(async () =>
      root.render(
        <MemoryRouter>
          <NotificationsProvider>
            <Home me={me} onSignedOut={signedOut} />
          </NotificationsProvider>
        </MemoryRouter>,
      ),
    );
    await act(async () => button('Sign out')?.click());
    await until(() => text().includes("Couldn't sign out"));
    expect(signedOut).not.toHaveBeenCalled();
  });
});

describe("an Architect's chat settings", () => {
  it("puts a choice back and says why when the server doesn't take it", async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/groups/g1/chat-settings': (init) =>
          init?.method === 'PUT'
            ? json({ error: 'Only Architects can change this.' }, 403)
            : { retentionDays: 30, voice: false, voiceAvailable: false },
        '/api/groups/g1/chat-reports': () => ({
          reports: [
            {
              id: 'r1',
              body: 'hi',
              reason: null,
              sender: 'Bea',
              reporter: 'Cy',
              createdAt: '2026-10-01T00:00:00Z',
            },
          ],
        }),
        '/api/chat/reports/r1/resolve': () => json({ error: 'That report is gone.' }, 404),
      }),
    );
    await act(async () => root.render(<ChatSettings groupId="g1" />));
    await until(() => button('A year') !== undefined && !button('A year')?.disabled);
    await act(async () => button('A year')?.click());
    await until(() => text().includes('Only Architects can change this.'));
    expect(button('A year')?.getAttribute('aria-pressed')).toBe('false');
    expect(button('A month')?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => button('Dealt with: dismiss it')?.click());
    await until(() => text().includes('That report is gone.'));
  });
});
