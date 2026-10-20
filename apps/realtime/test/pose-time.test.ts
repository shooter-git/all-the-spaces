import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signTicket } from '@ats/shared';
import { Server } from '@colyseus/core';
import { Client, type Room } from '@colyseus/sdk';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SpaceRoom } from '../src/space-room.ts';
import { listenOnFreePort } from './helpers.ts';

// One open room; a group big enough for two live rooms (shards).
const spaceId = randomUUID();
const secret = randomBytes(32).toString('hex');
const graph = {
  rooms: [{ key: 'lobby', name: 'Lobby', floorKey: 'f1', neighbors: [] }],
  links: [],
  access: { architects: [], rooms: { lobby: { visibility: 'group', users: [] } } },
};

let api: HttpServer;
let server: Server;
let port = 0;

beforeAll(async () => {
  api = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(graph));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  SpaceRoom.options = {
    secret,
    serverUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
  };
  server = new Server({ transport: new WebSocketTransport(), greet: false });
  server.define('space', SpaceRoom).filterBy(['spaceId', 'shard']);
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await server?.gracefullyShutdown(false);
  api?.close();
});

async function join(sub: string, shard: number) {
  const client = new Client(`http://127.0.0.1:${port}`);
  client.auth.token = signTicket({ sub, name: sub, color: '#888', spaceId, shard }, secret);
  return client.joinOrCreate('space', { spaceId, shard });
}

type PlayerSeen = { x: number; at: number };
const seen = (room: Room, other: Room) =>
  (room.state as { players?: Map<string, PlayerSeen> }).players?.get(other.sessionId);
const pose = (room: Room, x: number, at?: number) =>
  room.send('pose', { x, y: 0, z: 0, yaw: 0, room: 'lobby', moving: true, ...(at ? { at } : {}) });

/** Waits until everything a client sent so far has been handled (the server answers in order). */
const handled = (room: Room) =>
  new Promise<void>((resolve) => {
    // Without voice set up, asking for a pass is answered at once.
    const stop = room.onMessage('voice', () => {
      stop();
      resolve();
    });
    room.send('voice');
  });

describe('the time each pose was taken', () => {
  it('reaches people in another shard as the sender gave it, only ever going forward', async () => {
    const ana = await join('ana', 0);
    const ben = await join('ben', 1);
    expect(ana.roomId).not.toBe(ben.roomId);
    pose(ben, 2, 20); // in the room, so seeing who's there
    pose(ana, 1, 40);
    await vi.waitFor(() => expect(seen(ben, ana)).toMatchObject({ x: 1, at: 40 }));
    pose(ana, 1.0625, 90);
    await vi.waitFor(() => expect(seen(ben, ana)).toMatchObject({ x: 1.0625, at: 90 }));
    // Going back in time, or far ahead of how long they've been here: ignored.
    pose(ana, 1.09375, 60);
    pose(ana, 1.09375, 90);
    pose(ana, 1.09375, 3_600_000);
    await handled(ana);
    await new Promise((r) => setTimeout(r, 200)); // a few updates, here and between shards
    expect(seen(ben, ana)).toMatchObject({ x: 1.0625, at: 90 });
    pose(ana, 1.125, 140);
    await vi.waitFor(() => expect(seen(ben, ana)).toMatchObject({ x: 1.125, at: 140 }));
    // And back the other way, between shards.
    pose(ben, 2.0625, 70);
    await vi.waitFor(() => expect(seen(ana, ben)).toMatchObject({ x: 2.0625, at: 70 }));
    await Promise.all([ana.leave(), ben.leave()]);
  });

  it('is left at 0 for apps that don’t send it, which still move', async () => {
    const cat = await join('cat', 0);
    const dan = await join('dan', 1);
    pose(dan, 0);
    pose(cat, 3);
    await vi.waitFor(() => expect(seen(dan, cat)).toMatchObject({ x: 3, at: 0 }));
    pose(cat, 3.125);
    await vi.waitFor(() => expect(seen(dan, cat)).toMatchObject({ x: 3.125, at: 0 }));
    await Promise.all([cat.leave(), dan.leave()]);
  });
});
