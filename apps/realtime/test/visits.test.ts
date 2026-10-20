import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signTicket, signToken, VISIT_HEARTBEAT_MS, type VisitBatch } from '@ats/shared';
import { Server } from '@colyseus/core';
import { Client, type Room } from '@colyseus/sdk';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CreationRoom } from '../src/creation-room.ts';
import { SpaceRoom } from '../src/space-room.ts';
import { RoomVisits, SETTLE_MS, VisitLog } from '../src/visits.ts';
import { listenOnFreePort } from './helpers.ts';

/** A visit log on a clock the test moves, and what it sent. */
function recorder() {
  let now = 1_000_000;
  const sent: VisitBatch[] = [];
  let failing = false;
  const visits = new VisitLog(
    async (batch) => {
      if (failing) throw new Error('unreachable');
      sent.push(structuredClone(batch));
    },
    () => now,
  );
  return {
    visits,
    sent,
    at: () => now,
    pass: (ms: number) => {
      now += ms;
    },
    fail: (yes: boolean) => {
      failing = yes;
    },
    started: () => sent.flatMap((b) => b.started),
    ended: () => sent.flatMap((b) => b.ended),
  };
}

const place = { userId: 'pat', spaceId: 'space-1', roomKey: 'kitchen' };

describe('sending visits to the server', () => {
  it('sends a visit when it starts and again when it ends; a short one goes once, ended', async () => {
    const r = recorder();
    const long = r.visits.start(place);
    await r.visits.flush();
    expect(r.started()).toEqual([{ ...place, id: long, startedAt: r.at() }]);
    r.pass(5000);
    r.visits.end(long);
    const short = r.visits.start({ ...place, roomKey: 'hall' });
    r.pass(2000);
    r.visits.end(short);
    await r.visits.flush();
    expect(r.ended()).toEqual([{ id: long, at: r.at() - 2000 }]);
    expect(r.started()[1]).toMatchObject({ id: short, roomKey: 'hall', endedAt: r.at() });
  });

  it('says once a minute which visits are still going', async () => {
    const r = recorder();
    const id = r.visits.start(place);
    await r.visits.flush();
    expect(r.sent.at(-1)?.going).toEqual([id]);
    r.pass(10_000);
    r.visits.start({ ...place, roomKey: 'hall' });
    await r.visits.flush();
    expect(r.sent.at(-1)?.going).toBeUndefined();
    // Nothing new to say, but a minute is up: the heartbeat goes on its own.
    r.pass(VISIT_HEARTBEAT_MS);
    const before = r.sent.length;
    await r.visits.flush();
    expect(r.sent).toHaveLength(before + 1);
    expect(r.sent.at(-1)?.going).toHaveLength(2);
    // And nothing at all when there's nothing to say.
    await r.visits.flush();
    expect(r.sent).toHaveLength(before + 1);
  });

  it("keeps visits while the server can't be reached, and sends them when it can", async () => {
    const r = recorder();
    const first = r.visits.start(place);
    await r.visits.flush();
    r.fail(true);
    r.visits.end(first);
    const second = r.visits.start({ ...place, roomKey: 'hall' });
    await r.visits.flush();
    r.pass(3000);
    r.visits.end(second);
    r.fail(false);
    await r.visits.flush();
    expect(r.ended()).toEqual([{ id: first, at: r.at() - 3000 }]);
    expect(r.started().find((v) => v.id === second)).toMatchObject({ endedAt: r.at() });
  });

  it('ends a visit properly when it ends while being sent', async () => {
    let release = () => {};
    const sent: VisitBatch[] = [];
    let held = true;
    const visits = new VisitLog(async (batch) => {
      sent.push(batch);
      if (held) await new Promise<void>((r) => (release = r));
    });
    const id = visits.start(place);
    const sending = visits.flush();
    visits.end(id);
    held = false;
    release();
    await sending;
    await visits.flush();
    expect(sent.flatMap((b) => b.ended).map((e) => e.id)).toEqual([id]);
  });

  it('ends every visit still going when the service stops', async () => {
    const r = recorder();
    const sent = r.visits.start(place);
    await r.visits.flush();
    const unsent = r.visits.start({ ...place, roomKey: 'hall' });
    r.pass(1000);
    await r.visits.stop();
    expect(r.ended()).toEqual([{ id: sent, at: r.at() }]);
    expect(r.started().find((v) => v.id === unsent)).toMatchObject({ endedAt: r.at() });
  });
});

describe('visits to rooms', () => {
  /** The rooms someone's visits were in, with how long each lasted (null: still going). */
  async function visitsOf(r: ReturnType<typeof recorder>) {
    await r.visits.flush();
    const ends = new Map(r.ended().map((e) => [e.id, e.at]));
    return r.started().map((v) => {
      const end = v.endedAt ?? ends.get(v.id);
      return ['roomKey' in v ? v.roomKey : '', end === undefined ? null : end - v.startedAt];
    });
  }

  it("counts a room once someone has stayed; time walking through goes to the room they're from", async () => {
    const r = recorder();
    const rooms = new RoomVisits(r.visits, 'space-1');
    rooms.moved('s1', 'pat', 'living', r.at());
    r.pass(60_000);
    rooms.moved('s1', 'pat', 'hall', r.at());
    r.pass(3000);
    rooms.tick(r.at());
    rooms.moved('s1', 'pat', 'kitchen', r.at());
    r.pass(SETTLE_MS - 1);
    rooms.tick(r.at());
    expect(await visitsOf(r)).toEqual([['living', null]]);
    r.pass(1);
    rooms.tick(r.at());
    expect(await visitsOf(r)).toEqual([
      ['living', 63_000],
      ['kitchen', null],
    ]);
  });

  it('carries on the same visit when someone steps out and back in', async () => {
    const r = recorder();
    const rooms = new RoomVisits(r.visits, 'space-1');
    rooms.moved('s1', 'pat', 'living', r.at());
    rooms.moved('s1', 'pat', 'hall', r.at());
    r.pass(5000);
    rooms.moved('s1', 'pat', 'living', r.at());
    r.pass(SETTLE_MS);
    rooms.tick(r.at());
    expect(await visitsOf(r)).toEqual([['living', null]]);
  });

  it("doesn't count time with the app out of sight", async () => {
    const r = recorder();
    const rooms = new RoomVisits(r.visits, 'space-1');
    rooms.moved('s1', 'pat', 'living', r.at());
    r.pass(20_000);
    rooms.moved('s1', 'pat', 'kitchen', r.at());
    r.pass(2000);
    rooms.away('s1', true, r.at());
    r.pass(3_600_000);
    rooms.tick(r.at());
    rooms.away('s1', false, r.at());
    r.pass(30_000);
    rooms.left('s1', r.at());
    // Away in the kitchen doorway: back in the kitchen.
    expect(await visitsOf(r)).toEqual([
      ['living', 22_000],
      ['kitchen', 30_000],
    ]);
  });
});

describe('the rooms record visits', () => {
  const r = recorder();
  const secret = randomBytes(32).toString('hex');
  const spaceId = randomUUID();
  const creationId = randomUUID();
  const versionId = randomUUID();
  let api: HttpServer;
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    api = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          rooms: [{ key: 'lobby', name: 'Lobby', floorKey: 'f1', neighbors: [] }],
          links: [],
          access: { architects: [], rooms: { lobby: { visibility: 'group', users: [] } } },
        }),
      );
    });
    await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
    SpaceRoom.options = {
      secret,
      serverUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    };
    CreationRoom.options = { secret };
    SpaceRoom.visits = r.visits;
    CreationRoom.visits = r.visits;
    server = new Server({ transport: new WebSocketTransport(), greet: false });
    server.define('space', SpaceRoom).filterBy(['spaceId', 'shard']);
    server.define('creation', CreationRoom).filterBy(['creationId', 'versionId', 'mode']);
    port = await listenOnFreePort(server);
  });

  afterAll(async () => {
    await server?.gracefullyShutdown(false);
    api?.close();
  });

  /** Waits until the room has handled everything sent so far (it answers in order). */
  const handled = (room: Room) =>
    new Promise<void>((resolve) => {
      const stop = room.onMessage('voice', () => {
        stop();
        resolve();
      });
      room.send('voice');
    });

  it('records time in a room of the place, never where in it', async () => {
    const client = new Client(`http://127.0.0.1:${port}`);
    client.auth.token = signTicket({ sub: 'pat', name: 'Pat', color: '#888', spaceId }, secret);
    const room = await client.joinOrCreate('space', { spaceId });
    room.send('pose', { x: 1, y: 0, z: 2, yaw: 0, room: 'lobby', moving: false, teleport: true });
    await handled(room);
    await room.leave();
    await vi.waitFor(async () => {
      await r.visits.flush();
      expect(r.ended().length + r.started().filter((v) => v.endedAt).length).toBe(1);
    });
    const [visit] = r.started();
    expect(visit).toMatchObject({ userId: 'pat', spaceId, roomKey: 'lobby' });
    for (const where of ['x', 'y', 'z', 'yaw']) expect(visit).not.toHaveProperty(where);
  });

  it('records time in a creation, and not while it is out of sight', async () => {
    const before = r.started().length;
    const client = new Client(`http://127.0.0.1:${port}`);
    client.auth.token = signToken(
      'creation',
      { sub: 'sam', name: 'Sam', color: '#888', creationId, versionId, mode: 'solo' },
      secret,
      120,
    );
    const room = await client.create('creation', { creationId, versionId, mode: 'solo' });
    room.send('away', true);
    room.send('away', false);
    await handled(room);
    await room.leave();
    await vi.waitFor(async () => {
      await r.visits.flush();
      const mine = r.started().slice(before);
      expect(mine).toHaveLength(2);
      const ends = new Set([
        ...r.ended().map((e) => e.id),
        ...mine.filter((v) => v.endedAt).map((v) => v.id),
      ]);
      expect(mine.every((v) => ends.has(v.id))).toBe(true);
    });
    expect(r.started().slice(before)[0]).toMatchObject({ userId: 'sam', creationId, versionId });
  });
});
