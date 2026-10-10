import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { policyTopic, type SpaceAccess, signTicket } from '@ats/shared';
import { matchMaker, Server } from '@colyseus/core';
import { Client, type Room } from '@colyseus/sdk';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SpaceRoom } from '../src/space-room.ts';
import { listenOnFreePort } from './helpers.ts';

// Lobby and café are next to each other. The café is Architects-only to begin with.
const spaceId = randomUUID();
const secret = randomBytes(32).toString('hex');
const access: SpaceAccess = {
  architects: ['arch'],
  rooms: { lobby: { visibility: 'group', users: [] }, cafe: { visibility: 'hidden', users: [] } },
};
const graph = () => ({
  rooms: [
    { key: 'lobby', name: 'Lobby', floorKey: 'f1', neighbors: ['cafe'] },
    { key: 'cafe', name: 'Café', floorKey: 'f1', neighbors: ['lobby'] },
  ],
  links: [],
  access,
});

let api: HttpServer;
let server: Server;
let port = 0;

beforeAll(async () => {
  api = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(graph()));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  SpaceRoom.options = {
    secret,
    serverUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
  };
  const transport = new WebSocketTransport();
  server = new Server({ transport, greet: false });
  server.define('space', SpaceRoom).filterBy(['spaceId', 'shard']);
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await server?.gracefullyShutdown(false);
  api?.close();
});

interface Seen {
  room: Room;
  /** People this client receives (nearby, in rooms it may see). */
  readonly players: Map<string, { room: string }>;
  /** The people list. */
  readonly roster: Map<string, { room: string }>;
  changed: number;
}

async function join(sub: string): Promise<Seen> {
  const client = new Client(`http://127.0.0.1:${port}`);
  client.auth.token = signTicket({ sub, name: sub, color: '#888', spaceId }, secret);
  const room = await client.joinOrCreate('space', { spaceId });
  // The state fills in after joining, so read it when asked.
  const state = () => room.state as Partial<Pick<Seen, 'players' | 'roster'>>;
  const seen: Seen = {
    room,
    get players() {
      return state().players ?? new Map();
    },
    get roster() {
      return state().roster ?? new Map();
    },
    changed: 0,
  };
  room.onMessage('space-changed', () => {
    seen.changed++;
  });
  return seen;
}

const pose = (who: Seen, room: string, x: number) =>
  who.room.send('pose', { x, y: 0, z: 2, yaw: 0, room, moving: false, teleport: true });
/** Waits until everything a client sent so far has been handled (the server answers in order). */
const handled = (who: Seen) =>
  new Promise<void>((resolve) => {
    // Without voice set up, asking for a pass is answered at once.
    const stop = who.room.onMessage('voice', () => {
      stop();
      resolve();
    });
    who.room.send('voice');
  });
/**
 * Waits until both clients have had an update sent after now: someone joining is sent to
 * everyone in the next one, together with anything that changed before it.
 */
async function nextUpdate(a: Seen, b: Seen) {
  const marker = await join(`marker-${randomUUID()}`);
  const id = marker.room.sessionId;
  await vi.waitFor(() => {
    expect(a.roster.has(id)).toBe(true);
    expect(b.roster.has(id)).toBe(true);
  });
  await marker.room.leave();
  await vi.waitFor(() => {
    expect(a.roster.has(id)).toBe(false);
    expect(b.roster.has(id)).toBe(false);
  });
}

describe('presence in private rooms', () => {
  let member: Seen;
  let architect: Seen;

  beforeAll(async () => {
    member = await join('member');
    architect = await join('arch');
    pose(member, 'lobby', 2);
    pose(architect, 'cafe', 10);
    // Both poses are in: the member's people list has the Architect somewhere private, and the
    // Architect sees the member next door.
    await vi.waitFor(() => {
      expect(member.roster.get(architect.room.sessionId)?.room).toBe('private');
      expect(architect.players.get(member.room.sessionId)?.room).toBe('lobby');
    });
  });

  it("doesn't send someone in a hidden room to people who may not see it", () => {
    expect(member.players.has(architect.room.sessionId)).toBe(false);
    // The people list shows them, but not where.
    expect(member.roster.get(architect.room.sessionId)?.room).toBe('private');
    // The Architect sees the member next door.
    expect(architect.players.get(member.room.sessionId)?.room).toBe('lobby');
  });

  it('ignores anyone claiming to be in a room they may not see', async () => {
    pose(member, 'cafe', 9);
    await handled(member);
    await nextUpdate(member, architect);
    expect(architect.players.get(member.room.sessionId)?.room).toBe('lobby');
    expect(member.roster.get(member.room.sessionId)?.room).toBe('lobby');
  });

  it('applies a privacy change straight away', async () => {
    access.rooms.cafe = { visibility: 'group', users: [] };
    await matchMaker.presence.publish(policyTopic(spaceId), { spaceId });
    await vi.waitFor(() => {
      expect(member.changed).toBe(1);
      expect(member.players.get(architect.room.sessionId)?.room).toBe('cafe');
      expect(member.roster.get(architect.room.sessionId)?.room).toBe('cafe');
    });
    // Told once, not again with a later update.
    await nextUpdate(member, architect);
    expect(member.changed).toBe(1);
  });
});

describe('joining a space', () => {
  it('refuses a ticket for another space or shard, whatever the options claim', async () => {
    const here = await join('here');
    const intruder = (ticket: { spaceId: string; shard?: number }) => {
      const c = new Client(`http://127.0.0.1:${port}`);
      c.auth.token = signTicket({ sub: 'intruder', name: 'x', color: '#888', ...ticket }, secret);
      // The options match the ticket, so only the room itself can tell.
      return c.joinById(here.room.roomId, ticket);
    };
    await expect(intruder({ spaceId: randomUUID() })).rejects.toThrow();
    await expect(intruder({ spaceId, shard: 1 })).rejects.toThrow();
    expect(here.roster.size).toBeGreaterThan(0);
    expect([...here.roster.values()].some((r) => (r as { id?: string }).id === 'intruder')).toBe(
      false,
    );
    await here.room.leave();
  });
});
