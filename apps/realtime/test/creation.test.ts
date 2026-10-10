import { randomBytes, randomUUID } from 'node:crypto';
import { memberRemovedTopic, REMOVED_FROM_GROUP, signToken } from '@ats/shared';
import { matchMaker, Server } from '@colyseus/core';
import { Client, type Room } from '@colyseus/sdk';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CreationRoom, LIMITS } from '../src/creation-room.ts';
import { listenOnFreePort, until } from './helpers.ts';

const secret = randomBytes(32).toString('hex');
const creationId = randomUUID();
const versionId = randomUUID();
let server: Server;
let port = 0;

beforeAll(async () => {
  CreationRoom.options = { secret };
  server = new Server({
    transport: new WebSocketTransport({ maxPayload: 64 * 1024 }),
    greet: false,
  });
  server.define('creation', CreationRoom).filterBy(['creationId', 'versionId', 'mode']);
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await server?.gracefullyShutdown(false);
});

type Mode = 'solo' | 'shared' | 'invite';

function client(sub: string, mode: Mode, creation = creationId, groupId?: string) {
  const c = new Client(`http://127.0.0.1:${port}`);
  c.auth.token = signToken(
    'creation',
    { sub, name: sub, color: '#888', creationId: creation, versionId, mode, groupId },
    secret,
    120,
  );
  return c;
}

interface Session {
  room: Room;
  shared: () => Map<string, string>;
  hostId: () => string;
  players: () => number;
  messages: { from: string; kind: string; body: unknown }[];
  results: { id: number; ok: boolean; code?: string }[];
}

function watch(room: Room): Session {
  const state = () =>
    room.state as { shared?: Map<string, string>; hostId?: string; players?: Map<string, unknown> };
  const s: Session = {
    room,
    shared: () => state().shared ?? new Map(),
    hostId: () => state().hostId ?? '',
    players: () => state().players?.size ?? 0,
    messages: [],
    results: [],
  };
  room.onMessage('message', (m) => s.messages.push(m));
  room.onMessage('shared-result', (r) => s.results.push(r));
  room.onMessage('shared-by', () => {});
  return s;
}

const join = async (sub: string, mode: Mode = 'shared') =>
  watch(await client(sub, mode).joinOrCreate('creation', { creationId, versionId, mode }));

describe('creation sessions', () => {
  it('lets go of someone taken out of the group, at once, and only them', async () => {
    const own = randomUUID();
    const enter = async (sub: string) =>
      watch(
        await client(sub, 'shared', own, 'group-a').joinOrCreate('creation', {
          creationId: own,
          versionId,
          mode: 'shared',
        }),
      );
    const stays = await enter('stays');
    const goes = await enter('goes');
    // Someone else from the group: news about them, sent next, shows the news before it was heard.
    const marker = await enter('marker');
    await until(() => stays.players() === 3);
    let code = 0;
    goes.room.onLeave((c) => {
      code = c;
    });
    let markerCode = 0;
    marker.room.onLeave((c) => {
      markerCode = c;
    });
    // Another group's news changes nothing here.
    await matchMaker.presence.publish(memberRemovedTopic, { groupId: 'group-b', userId: 'goes' });
    await matchMaker.presence.publish(memberRemovedTopic, { groupId: 'group-a', userId: 'marker' });
    await until(() => markerCode === REMOVED_FROM_GROUP && stays.players() === 2);
    expect(stays.players()).toBe(2);
    expect(code).toBe(0);
    await matchMaker.presence.publish(memberRemovedTopic, { groupId: 'group-a', userId: 'goes' });
    await until(() => code === REMOVED_FROM_GROUP && stays.players() === 1);
    await stays.room.leave();
  });

  it('keeps four players in step (a change reaches everyone within 250 ms)', async () => {
    const people = await Promise.all(['a', 'b', 'c', 'd'].map((p) => join(p)));
    await until(() => people.every((p) => p.players() === 4));
    expect(new Set(people.map((p) => p.room.roomId)).size).toBe(1);
    const start = Date.now();
    people[2]?.room.send('shared', { id: 1, key: 'board', value: { cells: [1, 0, 2] } });
    await until(() => people.every((p) => p.shared().get('board') === '{"cells":[1,0,2]}'));
    expect(Date.now() - start).toBeLessThan(250);
    for (const p of people) await p.room.leave();
  });

  it('hands hosting over as soon as the host leaves', async () => {
    const host = await join('host');
    const second = await join('second');
    const third = await join('third');
    await until(() => third.hostId() === 'host' && third.players() === 3);
    await host.room.leave();
    const took = await until(() => third.hostId() === 'second');
    expect(took).toBeLessThan(2000);
    // Shared values survive the handover.
    second.room.send('shared', { id: 1, key: 'score', value: 3 });
    await until(() => third.shared().get('score') === '3');
    await second.room.leave();
    await third.room.leave();
  });

  it('never lets anyone into a solo session', async () => {
    const alone = watch(
      await client('alone', 'solo').create('creation', { creationId, versionId, mode: 'solo' }),
    );
    await until(() => alone.players() === 1);
    // Not matched to strangers...
    const other = await join('stranger', 'solo');
    expect(other.room.roomId).not.toBe(alone.room.roomId);
    // ...and not joinable directly either.
    await expect(
      client('intruder', 'solo').joinById(alone.room.roomId, {
        creationId,
        versionId,
        mode: 'solo',
      }),
    ).rejects.toThrow();
    await other.room.leave();
    await alone.room.leave();
  });

  it('lets only invited people into an invite session', async () => {
    const owner = watch(
      await client('owner', 'invite').create('creation', { creationId, versionId, mode: 'invite' }),
    );
    owner.room.send('invite', { people: ['friend'] });
    const opts = { creationId, versionId, mode: 'invite' };
    // In as soon as the invitation has arrived (turned away until then).
    const friend = watch(
      await vi.waitFor(() => client('friend', 'invite').joinById(owner.room.roomId, opts), {
        timeout: 2000,
        interval: 20,
      }),
    );
    await until(() => owner.players() === 2);
    await expect(
      client('gatecrasher', 'invite').joinById(owner.room.roomId, opts),
    ).rejects.toThrow();
    await friend.room.leave();
    await owner.room.leave();
  });

  it('refuses tickets for another creation', async () => {
    await expect(
      client('x', 'shared', randomUUID()).joinOrCreate('creation', {
        creationId,
        versionId,
        mode: 'shared',
      }),
    ).rejects.toThrow();
  });

  it("refuses a ticket for another creation's session, even joined by id with matching options", async () => {
    const other = randomUUID();
    const theirs = await join('theirs');
    const opts = { creationId: other, versionId, mode: 'shared' as const };
    // A valid ticket for creation A, A's ids as options, and creation B's room id.
    await expect(
      client('snoop', 'shared', other).joinById(theirs.room.roomId, opts),
    ).rejects.toThrow();
    // Another version, or another mode, of the same creation is another session too.
    const otherVersion = new Client(`http://127.0.0.1:${port}`);
    otherVersion.auth.token = signToken(
      'creation',
      {
        sub: 'snoop',
        name: 'snoop',
        color: '#888',
        creationId,
        versionId: randomUUID(),
        mode: 'shared',
      },
      secret,
      120,
    );
    await expect(
      otherVersion.joinById(theirs.room.roomId, {
        creationId,
        versionId: randomUUID(),
        mode: 'shared',
      }),
    ).rejects.toThrow();
    await expect(
      client('snoop', 'invite').joinById(theirs.room.roomId, {
        creationId,
        versionId,
        mode: 'invite',
      }),
    ).rejects.toThrow();
    expect(theirs.players()).toBe(1);
    await theirs.room.leave();
  });

  it('holds a ticket for one exact session to that session', async () => {
    const first = await join('first-session');
    const ticket = (sessionId: string) => {
      const c = new Client(`http://127.0.0.1:${port}`);
      c.auth.token = signToken(
        'creation',
        {
          sub: 'named',
          name: 'named',
          color: '#888',
          creationId,
          versionId,
          mode: 'shared',
          sessionId,
        },
        secret,
        120,
      );
      return c;
    };
    const opts = { creationId, versionId, mode: 'shared' };
    await expect(ticket('elsewhere1').joinById(first.room.roomId, opts)).rejects.toThrow();
    const named = watch(await ticket(first.room.roomId).joinById(first.room.roomId, opts));
    await until(() => first.players() === 2);
    await named.room.leave();
    await first.room.leave();
  });

  it('keeps shared values and messages within limits, and never echoes your own messages', async () => {
    const a = await join('limits-a');
    const b = await join('limits-b');
    await until(() => a.players() === 2);
    a.room.send('shared', { id: 7, key: 'big', value: 'x'.repeat(LIMITS.valueBytes + 1) });
    await until(() => a.results.some((r) => r.id === 7));
    expect(a.results.find((r) => r.id === 7)).toMatchObject({ ok: false, code: 'too-big' });
    a.room.send('send', { kind: 'wave', body: { hand: 'left' } });
    a.room.send('send', { kind: 'secret', body: 1, to: 'nobody' });
    await until(() => b.messages.length > 0);
    // A change sent after them: once both have heard of it, they've had anything sent before it.
    a.room.send('shared', { id: 8, key: 'after', value: 1 });
    await until(() => a.results.some((r) => r.id === 8) && b.shared().get('after') === '1');
    expect(b.messages).toEqual([{ from: 'limits-a', kind: 'wave', body: { hand: 'left' } }]);
    expect(a.messages).toEqual([]);
    await a.room.leave();
    await b.room.leave();
  });
});
