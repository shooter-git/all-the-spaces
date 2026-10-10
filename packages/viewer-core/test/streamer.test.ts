import { readFileSync } from 'node:fs';
import { buildSpace } from '@ats/space-builder';
import type { SpaceManifest } from '@ats/space-format';
import { BoxGeometry, Group, Mesh, type Object3D } from 'three';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollisionWorld } from '../src/physics.ts';
import { detailCost, roomViews } from '../src/rooms.ts';
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

/** A server that has every file: each one a small box. */
function serving(options: { detailBudget?: number } = {}) {
  const loadAsync = vi.fn(async (_url: string) => {
    const scene = new Group();
    scene.add(new Mesh(new BoxGeometry(1, 1, 1)));
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

/** How a room is drawn now: in full detail, as its stand-in, or not at all. */
function drawn(streamer: RoomStreamer, key: string) {
  const part = (lod: string) =>
    streamer.root.children.find((o: Object3D) => o.name === `${key}:${lod}`);
  if (part('lod0')?.visible) return 'detail';
  if (part('lod2')?.visible) return 'stand-in';
  return null;
}

const wholePlace = () => building.rooms.reduce((n, r) => n + detailCost(r, 'lod0'), 0);

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
      rooms: { lod0: rooms, lod1: 0, lod2: rooms },
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
