/**
 * The live connection to the server: chat messages, Do Not Disturb changes and notifications.
 * One per tab (shared: see acquireLive); reconnects by itself.
 */

import type { ChatMessage, LiveEvent } from '@ats/api-types';

export type { AppNotification, ChatMessage } from '@ats/api-types';

type Listener = (event: LiveEvent) => void;

/** How often to ask the server whether it's still there. */
export const PING_EVERY_MS = 25_000;
/** No word from the server for this long: the connection is gone, even if it looks open. */
export const SILENCE_MS = 2 * PING_EVERY_MS + 5_000;
/** A message the server hasn't confirmed by then didn't send. */
export const SEND_TIMEOUT_MS = 10_000;
/** After coming back (online, or to the tab), how long the server has to answer a ping. */
const WAKE_CHECK_MS = 5_000;

export class LiveConnection {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<
    string,
    { resolve: (m: ChatMessage) => void; reject: (e: Error) => void; timer: number }
  >();
  private retry = 0;
  private closed = false;
  private pinger: number | undefined;
  private reopenTimer: number | undefined;
  private wakeTimer: number | undefined;
  /** When the server last said anything (a pong counts), and how many times it has. */
  private lastHeard = 0;
  private heard = 0;
  private nonce = 0;
  private connected = false;
  private readonly statusListeners = new Set<(connected: boolean) => void>();

  constructor(private readonly url = liveUrl()) {
    this.open();
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
  }

  private open() {
    if (this.closed) return;
    window.clearTimeout(this.reopenTimer);
    this.reopenTimer = undefined;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed) return socket.close(); // closed while it was still connecting
      this.retry = 0;
      this.lastHeard = Date.now();
      this.setStatus(true);
      this.pinger = window.setInterval(() => {
        // A connection that went quiet (Wi-Fi to cellular) can look open for minutes.
        if (Date.now() - this.lastHeard > SILENCE_MS) this.lost(socket);
        else this.raw({ t: 'ping' });
      }, PING_EVERY_MS);
    };
    socket.onmessage = (e) => {
      this.lastHeard = Date.now();
      this.heard++;
      let event: LiveEvent;
      try {
        event = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (event.t === 'ack' || event.t === 'error') {
        const p = this.pending.get(event.nonce);
        this.pending.delete(event.nonce);
        window.clearTimeout(p?.timer);
        if (event.t === 'ack') p?.resolve(event.message);
        else p?.reject(new Error(event.error));
      }
      for (const l of this.listeners) l(event);
    };
    socket.onclose = () => this.lost(socket);
  }

  /** The socket closed, or went silent: let it go and open another after a pause. */
  private lost(socket: WebSocket) {
    if (socket !== this.socket) return;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    if (socket.readyState !== WebSocket.CLOSED) closeSocket(socket);
    window.clearInterval(this.pinger);
    window.clearTimeout(this.wakeTimer);
    for (const p of this.pending.values()) {
      window.clearTimeout(p.timer);
      p.reject(new Error('Connection lost. Try again.'));
    }
    this.pending.clear();
    if (this.closed) return;
    this.setStatus(false);
    // Back off: 1 s, 2 s, 4 s … up to 30 s.
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
    this.reopenTimer = window.setTimeout(() => this.open(), delay);
  }

  /** Back online, or back to this tab: reconnect now, or check the connection still works. */
  private readonly wake = () => {
    if (this.closed || document.visibilityState !== 'visible') return;
    const socket = this.socket;
    if (!socket) {
      this.retry = 0;
      this.open();
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    const heard = this.heard;
    this.raw({ t: 'ping' });
    window.clearTimeout(this.wakeTimer);
    this.wakeTimer = window.setTimeout(() => {
      if (this.heard === heard) {
        this.retry = 0;
        this.lost(socket);
      }
    }, WAKE_CHECK_MS);
  };

  private setStatus(connected: boolean) {
    this.connected = connected;
    for (const l of this.statusListeners) l(connected);
  }

  /** Hears true when connected, false while reconnecting (straight away with how it is now). */
  watchStatus(listener: (connected: boolean) => void) {
    this.statusListeners.add(listener);
    listener(this.connected);
    return () => this.statusListeners.delete(listener);
  }

  private raw(message: object) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends a chat message; resolves with it as stored, or rejects with a reason to show. */
  send(channel: string, body: string): Promise<ChatMessage> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Reconnecting… try again in a moment.'));
    }
    const nonce = `m${++this.nonce}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!this.pending.delete(nonce)) return;
        reject(new Error("Didn't send. Try again."));
      }, SEND_TIMEOUT_MS);
      this.pending.set(nonce, { resolve, reject, timer });
      this.raw({ t: 'send', channel, body, nonce });
    });
  }

  close() {
    this.closed = true;
    window.clearInterval(this.pinger);
    window.clearTimeout(this.reopenTimer);
    window.clearTimeout(this.wakeTimer);
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
    if (this.socket) closeSocket(this.socket);
  }
}

/**
 * Closes a socket, waiting for it to open first if it's still connecting (closing a connecting
 * socket works too, but the browser complains about it).
 */
export function closeSocket(ws: WebSocket) {
  if (ws.readyState === WebSocket.CONNECTING) ws.addEventListener('open', () => ws.close());
  else ws.close();
}

let shared: LiveConnection | null = null;
let holders = 0;

/** The tab's one live connection, opened on first use and closed when nobody needs it. */
export function acquireLive(): LiveConnection {
  shared ??= new LiveConnection();
  holders++;
  return shared;
}

export function releaseLive() {
  holders = Math.max(0, holders - 1);
  if (holders === 0 && shared) {
    shared.close();
    shared = null;
  }
}

function liveUrl() {
  const url = new URL('/api/live', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export const spaceChannel = (spaceId: string) => `space:${spaceId}`;
export const roomChannel = (spaceId: string, roomKey: string) => `room:${spaceId}:${roomKey}`;
export const dmChannel = (a: string, b: string) => (a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`);
