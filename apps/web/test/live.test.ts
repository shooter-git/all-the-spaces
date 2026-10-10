// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveConnection, PING_EVERY_MS, SEND_TIMEOUT_MS, SILENCE_MS } from '../src/lib/live.ts';
import { FakeSocket } from './helpers/fakes.ts';

let live: LiveConnection;
let status: boolean[];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  live = new LiveConnection('ws://space.test/api/live');
  status = [];
  live.watchStatus((ok) => status.push(ok));
  FakeSocket.last?.accept();
});
afterEach(() => {
  live.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const pings = (socket = FakeSocket.last) =>
  socket?.sent.filter((m) => (m as { t: string }).t === 'ping').length ?? 0;

describe('the live connection', () => {
  it('keeps a connection that answers its pings', () => {
    const socket = FakeSocket.last;
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(PING_EVERY_MS);
      socket?.receive({ t: 'pong' });
    }
    expect(pings(socket)).toBe(5);
    expect(FakeSocket.all).toHaveLength(1);
    expect(status.at(-1)).toBe(true);
  });

  it('opens a new connection when the server goes silent, even though the old one looks open', () => {
    const silent = FakeSocket.last;
    vi.advanceTimersByTime(SILENCE_MS + PING_EVERY_MS);
    expect(status.at(-1)).toBe(false);
    expect(silent?.readyState).toBe(FakeSocket.CLOSED);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.last?.accept();
    expect(status.at(-1)).toBe(true);
  });

  it('gives up on a message the server never confirms: "Didn\'t send. Try again."', async () => {
    const sent = live.send('space:s1', 'hello');
    const outcome = sent.then(
      () => 'sent',
      (e: Error) => e.message,
    );
    vi.advanceTimersByTime(SEND_TIMEOUT_MS);
    expect(await outcome).toBe("Didn't send. Try again.");
  });

  it('still resolves a message confirmed in time', async () => {
    const sent = live.send('space:s1', 'hello');
    const nonce = (FakeSocket.last?.sent.at(-1) as { nonce?: string } | undefined)?.nonce;
    const message = { id: 'm1', channel: 'space:s1', body: 'hello' };
    FakeSocket.last?.receive({ t: 'ack', nonce, message });
    vi.advanceTimersByTime(SEND_TIMEOUT_MS);
    await expect(sent).resolves.toMatchObject({ id: 'm1' });
  });

  it('reconnects straight away when the device comes back online', () => {
    FakeSocket.last?.close();
    expect(status.at(-1)).toBe(false);
    // Waiting out a long back-off would leave chat down for up to 30 s.
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('checks the connection when the tab comes back, and replaces it if nobody answers', () => {
    const asleep = FakeSocket.last;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pings(asleep)).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(status.at(-1)).toBe(false);
    window.dispatchEvent(new Event('online'));
    expect(FakeSocket.all).toHaveLength(2);
  });
});
