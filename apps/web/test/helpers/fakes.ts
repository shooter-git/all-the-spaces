import { act } from 'react';
import { expect, vi } from 'vitest';

/** A stand-in for the 3D view: records what the page asks of it, and fires its events on demand. */
export class FakeViewer {
  static all: FakeViewer[] = [];
  static get last() {
    return FakeViewer.all.at(-1);
  }
  onReady?: () => void;
  onProgress?: (fraction: number) => void;
  onError?: (error: unknown) => void;
  onRoomChange?: (room: unknown) => void;
  onLift?: (link: unknown, stop: number) => void;
  onFrame?: (dt: number) => void;
  input = { onPointerLockChange: undefined as unknown, setJoystick() {}, addLook() {} };
  avatars = {
    shown: new Map<string, unknown>(),
    add(id: string, who: unknown) {
      this.shown.set(id, who);
    },
    push() {},
    remove(id: string) {
      this.shown.delete(id);
    },
    clear() {
      this.shown.clear();
    },
  };
  currentRoom = null;
  teleports = 0;
  disposed = false;
  constructor(
    readonly host: HTMLElement,
    readonly options: unknown,
  ) {
    FakeViewer.all.push(this);
  }
  pose() {
    return { x: 1, y: 0, z: 2, yaw: 0, roomKey: 'hall', moving: false };
  }
  dispose() {
    this.disposed = true;
  }
  pause() {}
  resume() {}
  setHighlighted() {}
  lookingAt() {
    return null;
  }
  pickObject() {
    return null;
  }
  travelTargets() {
    return [];
  }
  objectCenter() {
    return null;
  }
  approach() {
    return Promise.resolve();
  }
  retreat() {
    return Promise.resolve();
  }
  stats() {
    return null;
  }
}

/** A WebSocket that only does what the test tells it to. */
export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  static get last() {
    return FakeSocket.all.at(-1);
  }
  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly openListeners: (() => void)[] = [];
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    if (type === 'open') this.openListeners.push(listener);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  /** The server accepted the connection. */
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    for (const l of this.openListeners) l();
  }
  /** The server sent something. */
  receive(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

export const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

/** A fetch that answers from a table of paths (anything else is a 404). */
export function routes(table: Record<string, (init?: RequestInit) => unknown>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0] ?? '';
    const answer = table[path];
    if (!answer) return json({ error: 'Not found' }, 404);
    const body = answer(init);
    return body instanceof Promise ? body : json(body);
  });
}

/** Runs timers and pending work (on fake timers) until `done` holds, or fails after a while. */
export async function until(done: () => boolean, step = 100) {
  const giveUp = performance.now() + 5000;
  while (!done() && performance.now() < giveUp) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  expect(done()).toBe(true);
}
