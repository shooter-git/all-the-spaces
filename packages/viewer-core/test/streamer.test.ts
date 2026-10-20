import { readFileSync } from 'node:fs';
import { buildSpace } from '@ats/space-builder';
import type { SpaceManifest } from '@ats/space-format';
import { BoxGeometry, Group, Mesh, type Object3D } from 'three';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollisionWorld } from '../src/physics.ts';
import { detailCost, lighterCost, NEAR_DETAIL_M, roomViews } from '../src/rooms.ts';
import { RETRY_DELAYS_MS, RoomStreamer } from '../src/streamer.ts';

let building: SpaceManifest;
beforeAll(async () => {
  const plan = JSON.parse(
    readFileSync(new URL('../../../samples/two-floor-building/plan.json', import.meta.url), 'utf8'),
  );
  building = (await buildSpace(plan)).manifest;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A server that refuses everything (the room went private, or the connection is gone). */
function refusing() {
  const loadAsync = vi.fn((_url: string) => Promise.reject(new Error('403 Forbidden')));
  const streamer = new RoomStreamer(building, 'http://space.test/', new CollisionWorld(), {
    loader: { loadAsync: loadAsync as never },
  });
  const lobby = building.rooms.find((r) => r.key === 'lobby');
  if (!lobby) throw new Error('no lobby in the sample');
  const collisionTries = () =>
    loadAsync.mock.calls.filter(([url]) => url.endsWith(lobby.collision.path)).length;
  return { streamer, loadAsync, collisionTries };
}

describe('a room that fails to load', () => {
  it('is tried again after a growing wait, not straight away', async () => {
    const { streamer, collisionTries } = refusing();
    streamer.focus('lobby');
    await vi.advanceTimersByTimeAsync(0);
    expect(collisionTries()).toBe(1);
    await vi.advanceTimersByTimeAsync((RETRY_DELAYS_MS[0] ?? 0) - 10);
    expect(collisionTries()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(collisionTries()).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1] ?? 0);
    expect(collisionTries()).toBe(3);
    streamer.dispose();
  });

  it('is reported once the retries run out, then left alone until you walk back in', async () => {
    const { streamer, collisionTries } = refusing();
    const errors: string[] = [];
    streamer.onError = (key) => errors.push(key);
    streamer.focus('lobby');
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    await vi.advanceTimersByTimeAsync(total + 100);
    expect(collisionTries()).toBe(RETRY_DELAYS_MS.length + 1);
    expect(errors).toContain('lobby');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(collisionTries()).toBe(RETRY_DELAYS_MS.length + 1);

    streamer.focus('cafe');
    streamer.focus('lobby');
    await vi.advanceTimersByTimeAsync(0);
    expect(collisionTries()).toBe(RETRY_DELAYS_MS.length + 2);
    streamer.dispose();
  });

  it('stops retrying once the viewer is closed', async () => {
    const { streamer, loadAsync } = refusing();
    streamer.focus('lobby');
    await vi.advanceTimersByTimeAsync(0);
    const before = loadAsync.mock.calls.length;
    streamer.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadAsync.mock.calls.length).toBe(before);
  });
});

/** A server that has every file: each one a box (up a little, inside a group), and a cup. */
function serving(options: { detailBudget?: number } = {}) {
  const loadAsync = vi.fn(async (_url: string) => {
    const scene = new Group();
    const holder = new Group();
    holder.position.set(1, 2, 3);
    holder.add(new Mesh(new BoxGeometry(1, 1, 1)));
    const cup = new Mesh(new BoxGeometry(0.1, 0.1, 0.1));
    cup.name = 'cup';
    scene.add(holder, cup);
    return { scene, parser: { json: {}, associations: new Map() } };
  });
  const world = new CollisionWorld();
  const streamer = new RoomStreamer(building, 'http://space.test/', world, {
    loader: { loadAsync: loadAsync as never },
    ...options,
  });
  return { streamer, world, loadAsync };
}

/** Lets every fetch in flight (and the ones they start) finish. */
async function arrive() {
  for (let i = 0; i < 100; i++) await vi.advanceTimersByTimeAsync(0);
}

const part = (streamer: RoomStreamer, key: string, lod: string) =>
  streamer.root.children.find((o: Object3D) => o.name === `${key}:${lod}`);

/** How a room is drawn now: in full detail (lighter, from afar), as its stand-in, or not at all. */
function drawn(streamer: RoomStreamer, key: string) {
  if (part(streamer, key, 'lod0')?.visible || part(streamer, key, 'lod1')?.visible) return 'detail';
  if (part(streamer, key, 'lod2')?.visible) return 'stand-in';
  return null;
}

const wholePlace = () => building.rooms.reduce((n, r) => n + detailCost(r, 'lod0'), 0);
const bothWays = () =>
  building.rooms.reduce((n, r) => n + detailCost(r, 'lod0') + lighterCost(r), 0);

describe('opening a place', () => {
  it('loads all of it before it’s ready: every floor, stand-in and room in full detail', async () => {
    const { streamer, world } = serving();
    streamer.focus('lobby');
    expect(streamer.complete).toBe(false);
    expect(streamer.progress()).toBe(0);
    await arrive();
    expect(streamer.complete).toBe(true);
    expect(streamer.progress()).toBe(1);
    const rooms = building.rooms.length;
    expect(streamer.stats()).toMatchObject({
      // Lighter detail too, for rooms further away: this place fits both ways.
      rooms: { lod0: rooms, lod1: rooms, lod2: rooms },
      collisionRooms: rooms,
      loading: 0,
    });
    for (const r of building.rooms) expect(world.has(r.key)).toBe(true);
    streamer.dispose();
  });

  it('fetches nothing more as you walk around, and keeps every floor', async () => {
    const { streamer, world, loadAsync } = serving();
    streamer.focus('lobby');
    await arrive();
    const fetched = loadAsync.mock.calls.length;
    for (const key of ['cafe', 'stairs', 'hall', 'quiet', 'terrace']) {
      streamer.focus(key);
      await arrive();
      expect(streamer.complete).toBe(true);
    }
    expect(loadAsync.mock.calls.length).toBe(fetched);
    for (const r of building.rooms) expect(world.has(r.key)).toBe(true);
    streamer.dispose();
  });

  it('draws only what you could see from where you are', async () => {
    const { streamer } = serving();
    streamer.focus('lobby');
    await arrive();
    for (const here of ['lobby', 'quiet', 'terrace']) {
      streamer.focus(here);
      const views = roomViews(building, here);
      for (const r of building.rooms) expect(drawn(streamer, r.key)).toBe(views.get(r.key) ?? null);
    }
    streamer.dispose();
  });
});

describe('a place too big to hold whole', () => {
  it('opens with the rooms nearest you in full detail, and every room as a stand-in', async () => {
    const { streamer, world } = serving({ detailBudget: wholePlace() / 2 });
    streamer.focus('lobby');
    await arrive();
    expect(streamer.complete).toBe(true);
    const { rooms } = streamer.stats();
    expect(rooms.lod0).toBeGreaterThan(0);
    expect(rooms.lod0).toBeLessThan(building.rooms.length);
    expect(rooms.lod2).toBe(building.rooms.length);
    for (const r of building.rooms) expect(world.has(r.key)).toBe(true);
    expect(drawn(streamer, 'lobby')).toBe('detail');
    streamer.dispose();
  });

  it('brings full detail along as you walk, and a room you can see is never missing', async () => {
    const { streamer } = serving({ detailBudget: wholePlace() / 2 });
    streamer.focus('lobby');
    await arrive();
    streamer.focus('terrace');
    // Before its full detail arrives, a room you can see shows its stand-in.
    for (const [key] of roomViews(building, 'terrace')) expect(drawn(streamer, key)).not.toBeNull();
    await arrive();
    expect(streamer.complete).toBe(true);
    expect(drawn(streamer, 'terrace')).toBe('detail');
    streamer.dispose();
  });
});

describe('rooms once they’re here', () => {
  it('are placed once, not worked out again every frame', async () => {
    const { streamer } = serving();
    streamer.focus('lobby');
    await arrive();
    for (const room of streamer.root.children) {
      room.traverse((o) => {
        expect(o.matrixAutoUpdate).toBe(false);
        expect(o.matrixWorldAutoUpdate).toBe(false);
      });
      const box = room.children[0]?.children[0];
      expect(box?.matrixWorld.elements.slice(12, 15)).toEqual([1, 2, 3]);
    }
    streamer.dispose();
  });

  it('say when they come and go', async () => {
    const { streamer } = serving({ detailBudget: wholePlace() / 2 });
    const changed = vi.fn();
    streamer.onRoomsChanged = changed;
    streamer.focus('lobby');
    await arrive();
    const loaded = changed.mock.calls.length;
    expect(loaded).toBe(streamer.root.children.length);
    streamer.focus('terrace'); // some full detail goes, other comes
    await arrive();
    expect(changed.mock.calls.length).toBeGreaterThan(loaded);
    streamer.dispose();
  });
});

describe('rooms far from you', () => {
  /** A point well away from a room, on its floor. */
  const awayFrom = (key: string): [number, number, number] => {
    const r = building.rooms.find((room) => room.key === key);
    if (!r) throw new Error(`no ${key}`);
    return [r.bounds.max[0] + NEAR_DETAIL_M + 5, r.bounds.min[1] + 1.6, r.bounds.min[2]];
  };
  const inside = (key: string): [number, number, number] => {
    const r = building.rooms.find((room) => room.key === key);
    if (!r) throw new Error(`no ${key}`);
    return [(r.bounds.min[0] + r.bounds.max[0]) / 2, r.bounds.min[1] + 1.6, r.bounds.min[2] + 0.5];
  };
  const cup = (streamer: RoomStreamer, key: string, lod: string) =>
    part(streamer, key, lod)?.getObjectByName('cup');

  it('are drawn lighter, without their smallest things, and in full when you come back', async () => {
    const { streamer, loadAsync } = serving();
    streamer.focus('lobby');
    await arrive();
    const fetched = loadAsync.mock.calls.length;
    streamer.look(...awayFrom('lobby'));
    expect(part(streamer, 'lobby', 'lod0')?.visible).toBe(false);
    expect(part(streamer, 'lobby', 'lod1')?.visible).toBe(true);
    expect(cup(streamer, 'lobby', 'lod1')?.visible).toBe(false);
    // Never a hole: what you could see is still drawn.
    for (const [key] of roomViews(building, 'lobby')) expect(drawn(streamer, key)).not.toBeNull();

    streamer.look(...inside('lobby'));
    expect(part(streamer, 'lobby', 'lod0')?.visible).toBe(true);
    expect(part(streamer, 'lobby', 'lod1')?.visible).toBe(false);
    expect(cup(streamer, 'lobby', 'lod0')?.visible).toBe(true);
    // Nothing loads as you walk.
    expect(loadAsync.mock.calls.length).toBe(fetched);
    streamer.dispose();
  });

  it('don’t flicker at the edge', async () => {
    const { streamer } = serving();
    streamer.focus('lobby');
    await arrive();
    const r = building.rooms.find((room) => room.key === 'lobby');
    if (!r) throw new Error('no lobby');
    const at = (d: number) =>
      streamer.look(r.bounds.max[0] + d, r.bounds.min[1] + 1, r.bounds.min[2]);
    at(NEAR_DETAIL_M + 2);
    expect(part(streamer, 'lobby', 'lod1')?.visible).toBe(true);
    at(NEAR_DETAIL_M + 0.5); // a little closer: still lighter
    expect(part(streamer, 'lobby', 'lod1')?.visible).toBe(true);
    at(NEAR_DETAIL_M - 0.5);
    expect(part(streamer, 'lobby', 'lod0')?.visible).toBe(true);
    at(NEAR_DETAIL_M + 0.5); // a little further: still in full
    expect(part(streamer, 'lobby', 'lod0')?.visible).toBe(true);
    streamer.dispose();
  });

  it('only leave out small things where the device can’t hold lighter detail too', async () => {
    const { streamer } = serving({ detailBudget: Math.floor((wholePlace() + bothWays()) / 2) });
    streamer.focus('lobby');
    await arrive();
    expect(streamer.complete).toBe(true);
    expect(streamer.stats().rooms.lod1).toBe(0);
    streamer.look(...awayFrom('lobby'));
    expect(part(streamer, 'lobby', 'lod0')?.visible).toBe(true);
    expect(cup(streamer, 'lobby', 'lod0')?.visible).toBe(false);
    streamer.dispose();
  });
});
