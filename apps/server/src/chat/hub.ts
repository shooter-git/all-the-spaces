import type { LiveEvent, Sent } from '@ats/api-types';
import type { WebSocket } from '@fastify/websocket';

/** Everyone's open live connections (a person may have several tabs or devices). */
export class LiveHub {
  private readonly sockets = new Map<string, Set<WebSocket>>();

  add(userId: string, socket: WebSocket) {
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(socket);
  }

  remove(userId: string, socket: WebSocket) {
    const set = this.sockets.get(userId);
    set?.delete(socket);
    if (set?.size === 0) this.sockets.delete(userId);
  }

  isOnline(userId: string) {
    return this.sockets.has(userId);
  }

  /** Sends to every connection of these people. */
  send(userIds: Iterable<string>, message: Sent<LiveEvent>) {
    const text = JSON.stringify(message);
    for (const id of userIds) {
      for (const socket of this.sockets.get(id) ?? []) {
        if (socket.readyState === socket.OPEN) socket.send(text);
      }
    }
  }

  closeAll() {
    for (const set of this.sockets.values()) for (const s of set) s.close(1001);
    this.sockets.clear();
  }
}
