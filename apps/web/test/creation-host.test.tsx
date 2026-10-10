// @vitest-environment happy-dom
import {
  type HostMessage,
  type Person,
  readHostMessage,
  wrap,
} from '@allthespaces/bridge-protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreationHost } from '../src/components/CreationHost.tsx';
import type { OpenedCreation } from '../src/lib/creations.ts';
import { json, routes } from './helpers/fakes.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The live session service, as the Colyseus SDK hands it over. */
const live = vi.hoisted(() => ({ joins: 0, leaves: 0 }));
vi.mock('@colyseus/sdk', () => {
  const callbacks = () => ({ onAdd() {}, onRemove() {}, onChange() {} });
  return {
    Client: class {
      auth = { token: '' };
      async joinOrCreate() {
        live.joins++;
        return {
          roomId: 'session-1',
          state: { players: new Map(), shared: new Map(), hostId: 'u1' },
          onLeave() {},
          onMessage() {},
          send() {},
          leave() {
            live.leaves++;
            return Promise.resolve(4000);
          },
        };
      }
      create(...args: unknown[]) {
        return this.joinOrCreate(...(args as []));
      }
    },
    getStateCallbacks: () => () => ({
      players: callbacks(),
      shared: callbacks(),
      listen() {},
    }),
  };
});

const opened: OpenedCreation = {
  creation: {
    id: 'c1',
    title: 'Marbles',
    version: 1,
    versionId: 'v1',
    protocolVersion: 1,
    defaultMode: 'solo',
    saveVersion: null,
  },
  trial: false,
  url: 'about:blank',
  playOrigin: 'http://play.test.localhost',
  ticket: 'ticket',
};

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  live.joins = 0;
  live.leaves = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function show(embedded: boolean) {
  act(() =>
    root.render(
      <CreationHost
        opened={opened}
        mode="solo"
        me={{ id: 'u1', name: 'Ada', color: '#336699' }}
        tier="mid"
        leaving={false}
        onProgress={() => {}}
        onReady={() => {}}
        onLeft={() => {}}
        onToast={() => {}}
        offline
        embedded={embedded}
      />,
    ),
  );
  return container.querySelector('iframe') as HTMLIFrameElement;
}

/** The creation asks for full screen, as the Portal SDK's requestFullscreen() does. */
function askForFullscreen(frame: HTMLIFrameElement) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: wrap({ type: 'request-fullscreen' }),
        origin: 'null',
        source: frame.contentWindow,
      }),
    );
  });
}

describe('a creation going full screen', () => {
  it("can't take the screen itself: its frame isn't allowed to", () => {
    const frame = show(false);
    expect(frame.getAttribute('allow') ?? '').not.toMatch(/fullscreen/);
    expect(frame.hasAttribute('allowfullscreen')).toBe(false);
  });

  it('asks the app, which puts the whole page full screen (its own controls stay on top)', () => {
    const page = vi.fn(() => Promise.resolve());
    document.documentElement.requestFullscreen = page;
    askForFullscreen(show(false));
    expect(page).toHaveBeenCalledOnce();
  });

  it('in the Studio preview, only the preview goes full screen', () => {
    const page = vi.fn(() => Promise.resolve());
    document.documentElement.requestFullscreen = page;
    const frame = show(true);
    const box = frame.parentElement as HTMLElement;
    const preview = vi.fn(() => Promise.resolve());
    box.requestFullscreen = preview;
    askForFullscreen(frame);
    expect(preview).toHaveBeenCalledOnce();
    expect(page).not.toHaveBeenCalled();
  });
});

const ada: Person = { id: 'u1', name: 'Ada', color: '#3F5B7C' };

/** Shows a creation, and collects what the app tells it. */
function play(
  options: {
    me?: Person;
    offline?: boolean;
    mode?: 'solo' | 'shared';
    onOutdated?: () => void;
  } = {},
) {
  const heard: HostMessage[] = [];
  let frame: HTMLIFrameElement | null = null;
  const render = (me: Person) =>
    act(() =>
      root.render(
        <CreationHost
          opened={opened}
          mode={options.mode ?? 'solo'}
          me={me}
          tier="mid"
          leaving={false}
          onProgress={() => {}}
          onReady={() => {}}
          onLeft={() => {}}
          onToast={() => {}}
          {...(options.onOutdated ? { onOutdated: options.onOutdated } : {})}
          offline={options.offline ?? false}
        />,
      ),
    );
  render(options.me ?? ada);
  frame = container.querySelector('iframe') as HTMLIFrameElement;
  vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation((data: unknown) => {
    const m = readHostMessage(data);
    if (m) heard.push(m);
  });
  /** The creation says something, as the Portal SDK would. */
  const say = (msg: object) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: wrap(msg),
          origin: 'null',
          source: frame?.contentWindow,
        }),
      );
    });
  return { heard, say, render };
}

describe('who you are, in a creation', () => {
  it('a colour that arrives later reaches the creation without leaving the live session', async () => {
    const { render } = play({ mode: 'shared' });
    await act(async () => {});
    expect(live.joins).toBe(1);
    render({ ...ada, color: '#8A6D3B' });
    await act(async () => {});
    expect(live.joins).toBe(1);
    expect(live.leaves).toBe(0);
  });

  it('playing alone, the creation hears the new colour as a players update, not a new init', () => {
    const { heard, say, render } = play({ offline: true });
    say({ type: 'hello', sdkVersion: '1.0.0' });
    expect(heard.filter((m) => m.type === 'init')).toHaveLength(1);
    render({ ...ada, color: '#8A6D3B' });
    const update = heard.find((m) => m.type === 'players');
    expect(update).toMatchObject({ data: { players: [{ id: 'u1', color: '#8A6D3B' }] } });
    expect(heard.filter((m) => m.type === 'init')).toHaveLength(1);
  });
});

describe('the bridge to a creation', () => {
  afterEach(() => vi.unstubAllGlobals());
  /** Lets pending requests (the stubbed server) answer. */
  const settle = () => act(async () => {});
  const result = (heard: HostMessage[], re: number) =>
    heard.find((m) => m.type === 'result' && m.re === re);

  it('answers hello with init: who you are, the session, and this device', async () => {
    const { heard, say } = play({ mode: 'solo' });
    await settle();
    say({ type: 'hello', sdkVersion: '1.0.0' });
    expect(heard.find((m) => m.type === 'init')).toMatchObject({
      data: {
        protocolVersion: 1,
        creation: { id: 'c1', title: 'Marbles' },
        me: { id: 'u1', name: 'Ada' },
        players: [{ id: 'u1' }],
        session: { id: 'session-1', mode: 'solo', hostId: 'u1' },
        tier: 'mid',
      },
    });
  });

  it('reads and writes saves through the server', async () => {
    const put = vi.fn();
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/creations/c1/data/personal/progress': (init) => {
          if (init?.method === 'PUT') {
            put(JSON.parse(String(init.body)));
            return { version: 4 };
          }
          return { value: { level: 3 }, schemaVersion: 1, version: 3 };
        },
      }),
    );
    const { heard, say } = play();
    say({ type: 'hello', sdkVersion: '1.0.0', saveVersion: 1 });
    say({ type: 'save:get', id: 1, scope: 'personal', key: 'progress' });
    await settle();
    expect(result(heard, 1)).toMatchObject({ ok: true, data: { value: { level: 3 }, version: 3 } });
    say({
      type: 'save:set',
      id: 2,
      scope: 'personal',
      key: 'progress',
      value: { level: 4 },
      schemaVersion: 1,
      basedOn: 3,
    });
    await settle();
    expect(put).toHaveBeenCalledWith({ value: { level: 4 }, schemaVersion: 1, basedOn: 3 });
    expect(result(heard, 2)).toMatchObject({ ok: true, data: { version: 4 } });
  });

  it('turns a save someone else got in first into a stale result', async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/creations/c1/data/shared/board': () =>
          json({ error: 'Someone else saved first.' }, 409),
      }),
    );
    const { heard, say } = play();
    say({ type: 'hello', sdkVersion: '1.0.0' });
    say({
      type: 'save:set',
      id: 7,
      scope: 'shared',
      key: 'board',
      value: [1],
      schemaVersion: 1,
      basedOn: 1,
    });
    await settle();
    expect(result(heard, 7)).toMatchObject({ ok: false, code: 'stale' });
  });

  it('says when saved data comes from a newer version of the creation', async () => {
    const outdated = vi.fn();
    vi.stubGlobal(
      'fetch',
      routes({
        // Saved by version 2's data format; this is version 1.
        '/api/creations/c1/data/personal/progress': () => ({
          value: { level: 9 },
          schemaVersion: 2,
          version: 5,
        }),
        '/api/creations/c1/data/shared/board': () =>
          json({ error: 'Saved by a newer version.', code: 'outdated' }, 409),
      }),
    );
    const { heard, say } = play({ onOutdated: outdated });
    say({ type: 'hello', sdkVersion: '1.0.0', saveVersion: 1 });
    say({ type: 'save:get', id: 1, scope: 'personal', key: 'progress' });
    await settle();
    expect(outdated).toHaveBeenCalledOnce();
    say({
      type: 'save:set',
      id: 2,
      scope: 'shared',
      key: 'board',
      value: [1],
      schemaVersion: 1,
      basedOn: 1,
    });
    await settle();
    expect(outdated).toHaveBeenCalledTimes(2);
    expect(result(heard, 2)).toMatchObject({ ok: false, code: 'stale' });
  });

  it("ignores messages that aren't from its own frame", async () => {
    const { heard } = play({ offline: true });
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: wrap({ type: 'hello', sdkVersion: '1.0.0' }),
          origin: 'null',
          source: window,
        }),
      );
    });
    expect(heard.filter((m) => m.type === 'init')).toHaveLength(0);
  });
});
