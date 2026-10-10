// @vitest-environment happy-dom
import { type HostMessage, readHostMessage, wrap } from '@allthespaces/bridge-protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreationHost } from '../src/components/CreationHost.tsx';
import type { OpenedCreation } from '../src/lib/creations.ts';
import { json, routes } from './helpers/fakes.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// No live session in these tests: the creation plays alone.
vi.mock('@colyseus/sdk', () => ({
  Client: class {
    auth = { token: '' };
    joinOrCreate() {
      return Promise.reject(new Error('offline'));
    }
    create() {
      return Promise.reject(new Error('offline'));
    }
  },
  getStateCallbacks: () => () => ({}),
}));

const opened: OpenedCreation = {
  creation: {
    id: 'c1',
    title: 'Lending desk',
    version: 3,
    versionId: 'v3',
    protocolVersion: 1,
    defaultMode: 'solo',
    saveVersion: null,
  },
  trial: false,
  url: 'about:blank',
  playOrigin: 'http://play.test.localhost',
  ticket: 'ticket',
  connectors: [
    { id: 'lanternfield-library', ops: ['listShelves', 'borrowBook'], why: 'Shows the shelves.' },
  ],
};

const lanternfield = {
  id: 'lanternfield-library',
  displayName: 'Lanternfield Library',
  description: 'Borrow and return books.',
  scopes: ['shelves:read', 'loans:write'],
  linked: false,
  linkedAt: null,
  broken: false,
  accountName: null,
  checked: false,
};

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function play(options: { offline?: boolean; linkReturnTo?: string } = {}) {
  const heard: HostMessage[] = [];
  act(() =>
    root.render(
      <CreationHost
        opened={opened}
        mode="solo"
        me={{ id: 'u1', name: 'Ada', color: '#3F5B7C' }}
        tier="mid"
        leaving={false}
        onProgress={() => {}}
        onReady={() => {}}
        onLeft={() => {}}
        onToast={() => {}}
        offline={options.offline ?? false}
        {...(options.linkReturnTo ? { linkReturnTo: options.linkReturnTo } : {})}
      />,
    ),
  );
  const frame = container.querySelector('iframe') as HTMLIFrameElement;
  vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation((data: unknown) => {
    const m = readHostMessage(data);
    if (m) heard.push(m);
  });
  const say = (msg: object) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: wrap(msg),
          origin: 'null',
          source: frame.contentWindow,
        }),
      );
    });
  const result = (re: number) => heard.find((m) => m.type === 'result' && m.re === re);
  return { heard, say, result };
}
const settle = () => act(async () => {});

describe('connectors, through the app', () => {
  it('calls the server with this version, and hands back what the service said', async () => {
    const sent = vi.fn();
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/creations/c1/connectors/lanternfield-library/call': (init) => {
          sent(JSON.parse(String(init?.body)));
          return { ok: true, status: 200, data: { shelves: ['Poetry'] } };
        },
      }),
    );
    const { say, result } = play();
    say({
      type: 'connector:call',
      id: 1,
      connector: 'lanternfield-library',
      op: 'listShelves',
      params: { page: 2 },
    });
    await settle();
    expect(sent).toHaveBeenCalledWith({ versionId: 'v3', op: 'listShelves', params: { page: 2 } });
    expect(result(1)).toEqual({
      type: 'result',
      re: 1,
      ok: true,
      data: { status: 200, data: { shelves: ['Poetry'] } },
    });
  });

  it('passes on a refusal with its code and the cleaned-up details', async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/creations/c1/connectors/lanternfield-library/call': () =>
          json(
            {
              ok: false,
              code: 'clash',
              error: 'Someone has it already.',
              upstream: { status: 409, code: 'ALREADY_ON_LOAN' },
            },
            409,
          ),
      }),
    );
    const { say, result } = play();
    say({
      type: 'connector:call',
      id: 2,
      connector: 'lanternfield-library',
      op: 'borrowBook',
      params: { bookId: '4' },
      body: { weeks: 1 },
      idempotencyKey: 'borrow-4-0001',
    });
    await settle();
    expect(result(2)).toMatchObject({
      ok: false,
      code: 'clash',
      error: 'Someone has it already.',
      details: { status: 409, code: 'ALREADY_ON_LOAN' },
    });
  });

  it('refuses what this version doesn’t declare without asking the server', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { say, result } = play();
    say({ type: 'connector:call', id: 3, connector: 'lanternfield-library', op: 'returnBook' });
    say({ type: 'connector:status', id: 4, connector: 'elsewhere' });
    await settle();
    expect(result(3)).toMatchObject({ ok: false, code: 'not-approved' });
    expect(result(4)).toMatchObject({ ok: false, code: 'not-approved' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('in an offline preview, nothing goes out', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { say, result } = play({ offline: true });
    say({ type: 'connector:call', id: 5, connector: 'lanternfield-library', op: 'listShelves' });
    await settle();
    expect(result(5)).toMatchObject({ ok: false, code: 'upstream' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says whether the person has linked their account', async () => {
    vi.stubGlobal('fetch', routes({ '/api/connectors': () => ({ connectors: [lanternfield] }) }));
    const { say, result } = play();
    say({ type: 'connector:status', id: 6, connector: 'lanternfield-library' });
    await settle();
    expect(result(6)).toMatchObject({
      ok: true,
      data: {
        installed: true,
        linked: false,
        broken: false,
        displayName: 'Lanternfield Library',
        scopes: ['shelves:read', 'loans:write'],
        accountName: null,
      },
    });
  });

  it('says who they’re linked as, when the service said', async () => {
    const linked = { ...lanternfield, linked: true, accountName: 'Ada', checked: true };
    vi.stubGlobal('fetch', routes({ '/api/connectors': () => ({ connectors: [linked] }) }));
    const { say, result } = play();
    say({ type: 'connector:status', id: 9, connector: 'lanternfield-library' });
    await settle();
    expect(result(9)).toMatchObject({
      ok: true,
      data: { installed: true, linked: true, accountName: 'Ada' },
    });
  });

  it('draws its own card to link, and leaves the whole page for the service', async () => {
    const linkBody = vi.fn();
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/connectors': () => ({ connectors: [lanternfield] }),
        '/api/connectors/lanternfield-library/link': (init) => {
          linkBody(JSON.parse(String(init?.body)));
          return { authorizeUrl: 'https://library.example.org/oauth/authorize?state=x' };
        },
      }),
    );
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      pathname: '/space/s1',
      search: '',
      assign,
    } as Location);
    const { say, result } = play({ linkReturnTo: '/space/s1?object=desk' });
    say({ type: 'connector:link', id: 7, connector: 'lanternfield-library' });
    await settle();
    expect(result(7)).toMatchObject({ ok: true });
    const card = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(card.textContent).toContain('Link your Lanternfield Library account');
    expect(card.textContent).toContain('See your shelves');
    expect(card.textContent).toContain('Change your loans');
    // It's the app's, outside the creation's frame.
    expect(card.closest('iframe')).toBeNull();
    const link = [...card.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Link account'),
    ) as HTMLButtonElement;
    await act(async () => link.click());
    await settle();
    expect(linkBody).toHaveBeenCalledWith({ returnTo: '/space/s1?object=desk' });
    expect(assign).toHaveBeenCalledWith('https://library.example.org/oauth/authorize?state=x');
  });

  it('“Not now” just closes the card', async () => {
    vi.stubGlobal('fetch', routes({ '/api/connectors': () => ({ connectors: [lanternfield] }) }));
    const { say } = play();
    say({ type: 'connector:link', id: 8, connector: 'lanternfield-library' });
    await settle();
    const notNow = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Not now',
    ) as HTMLButtonElement;
    act(() => notNow.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
