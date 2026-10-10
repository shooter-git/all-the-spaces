// @vitest-environment happy-dom
import { REMOVED_FROM_GROUP } from '@ats/shared/topics';
import type { SpaceViewer } from '@ats/viewer-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinPresence } from '../src/lib/presence.ts';
import { FakeViewer, json, routes } from './helpers/fakes.ts';

/** A live presence room, as the Colyseus SDK hands it over, that the test drives. */
const rooms = vi.hoisted(() => {
  class FakeRoom {
    sessionId = 'me';
    reconnection = { enabled: true };
    state = { players: new Map(), roster: new Map() };
    sent: unknown[] = [];
    left = false;
    handlers: Record<string, (...args: unknown[]) => void> = {};
    leaveHandler: ((code: number) => void) | null = null;
    add: Record<string, (...args: unknown[]) => void> = {};
    onMessage(type: string, handler: (...args: unknown[]) => void) {
      this.handlers[type] = handler;
    }
    onLeave(handler: (code: number) => void) {
      this.leaveHandler = handler;
    }
    send(type: string, message?: unknown) {
      this.sent.push([type, message]);
    }
    leave() {
      this.left = true;
      this.leaveHandler?.(4000);
      return Promise.resolve(4000);
    }
    /** Someone near you arrives. */
    arrive(sessionId: string) {
      const player = { id: sessionId, name: sessionId, color: '#000', x: 0, y: 0, z: 0, yaw: 0 };
      this.state.players.set(sessionId, player);
      this.add.players?.(player, sessionId);
    }
    /** The connection drops. */
    drop(code = 1006) {
      this.leaveHandler?.(code);
    }
  }
  return { FakeRoom, all: [] as InstanceType<typeof FakeRoom>[], joins: 0, fail: false };
});

vi.mock('@colyseus/sdk', () => ({
  CloseCode: { CONSENTED: 4000 },
  Client: class {
    auth = { token: '' };
    async joinOrCreate() {
      rooms.joins++;
      if (rooms.fail) throw new Error('unreachable');
      const room = new rooms.FakeRoom();
      rooms.all.push(room);
      return room;
    }
  },
  getStateCallbacks: (room: InstanceType<typeof rooms.FakeRoom>) => (target: unknown) =>
    target === room.state
      ? {
          players: {
            onAdd: (cb: (...args: unknown[]) => void) => {
              room.add.players = cb;
            },
            onRemove: () => {},
          },
          roster: { onAdd: () => {}, onRemove: () => {} },
        }
      : { onChange: () => {} },
}));

let tickets = 0;
let viewer: FakeViewer;
let status: string[];
const lastRoom = () => rooms.all.at(-1);

async function join() {
  status = [];
  return joinPresence(
    's1',
    viewer as unknown as SpaceViewer,
    () => {},
    (s) => status.push(s),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  rooms.all.length = 0;
  rooms.joins = 0;
  rooms.fail = false;
  tickets = 0;
  viewer = new FakeViewer(document.body, {});
  vi.stubGlobal(
    'fetch',
    routes({
      '/api/spaces/s1/realtime-ticket': () => {
        tickets++;
        return rooms.fail ? json({ error: 'down' }, 503) : { ticket: `t${tickets}`, voice: false };
      },
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live presence after a drop', () => {
  it('clears the people it showed and gets back in with a fresh ticket', async () => {
    const presence = await join();
    lastRoom()?.arrive('bea');
    expect(viewer.avatars.shown.has('bea')).toBe(true);
    expect(lastRoom()?.reconnection.enabled).toBe(false);

    lastRoom()?.drop();
    expect(viewer.avatars.shown.size).toBe(0);
    expect(status.at(-1)).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1000);
    expect(tickets).toBe(2);
    expect(rooms.all).toHaveLength(2);
    expect(status.at(-1)).toBe('connected');
    presence.leave();
  });

  it('waits longer between tries while the server stays away', async () => {
    const presence = await join();
    rooms.fail = true;
    lastRoom()?.drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tickets).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(tickets).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tickets).toBe(3);
    rooms.fail = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(status.at(-1)).toBe('connected');
    presence.leave();
  });

  it('tries straight away when the device comes back online', async () => {
    const presence = await join();
    rooms.fail = true;
    lastRoom()?.drop();
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    rooms.fail = false;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(status.at(-1)).toBe('connected');
    presence.leave();
  });

  it('stays out after leaving, being replaced by another tab, or being removed', async () => {
    const presence = await join();
    presence.leave();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rooms.joins).toBe(1);

    const replaced = await join();
    lastRoom()?.drop(4000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rooms.joins).toBe(2);
    expect(status.at(-1)).toBe('offline');
    replaced.leave();

    const removed = vi.fn();
    await joinPresence(
      's1',
      viewer as unknown as SpaceViewer,
      () => {},
      () => {},
      () => {},
      removed,
    );
    lastRoom()?.drop(REMOVED_FROM_GROUP);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(removed).toHaveBeenCalled();
    expect(rooms.joins).toBe(3);
  });
});
