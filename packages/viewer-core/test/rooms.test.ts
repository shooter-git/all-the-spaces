import { readFileSync } from 'node:fs';
import { buildSpace } from '@ats/space-builder';
import { SpaceManifest } from '@ats/space-format';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DETAIL_SIGHT,
  detailCost,
  detailRooms,
  distanceToRoom,
  holdsLighterDetail,
  lighterCost,
  lightmapBytes,
  MAX_SIGHT,
  needsSunShadows,
  roomAt,
  roomDistances,
  roomViews,
  sightDistances,
} from '../src/rooms.ts';

let building: SpaceManifest;
beforeAll(async () => {
  const plan = JSON.parse(
    readFileSync(new URL('../../../samples/two-floor-building/plan.json', import.meta.url), 'utf8'),
  );
  building = (await buildSpace(plan)).manifest;
});

describe('rooms', () => {
  it('finds the room at a point, telling floors apart', () => {
    expect(roomAt(building, 4, 0, 3)?.key).toBe('lobby');
    expect(roomAt(building, 4, 3.3, 3)?.key).toBe('hall');
    expect(roomAt(building, 1.5, 0, 9)?.key).toBe('stairs');
    expect(roomAt(building, 1.5, 3.3, 6.5)?.key).toBe('stairs');
    expect(roomAt(building, 50, 0, 50)).toBeNull();
  });

  it('measures distance through doors, stairs and the lift', () => {
    const d = roomDistances(building, 'lobby');
    expect(d.get('lobby')).toBe(0);
    expect(d.get('cafe')).toBe(1);
    expect(d.get('hall')).toBe(1); // by lift
    expect(d.get('garden')).toBe(2);
  });

  it('sees through open passages: rooms joined by one are a single space', () => {
    // The lobby and the café are joined by an open passage; the garden is through a door.
    const d = sightDistances(building, 'lobby');
    expect(d.get('cafe')).toBe(0);
    expect(d.get('meeting')).toBe(1);
    expect(d.get('garden')).toBe(1);
    // Upstairs, the hall and the office are one open space.
    expect(sightDistances(building, 'hall').get('office')).toBe(0);
  });

  it('draws the space you’re in and what you can see from it, in less detail further away', () => {
    const views = roomViews(building, 'lobby');
    expect(views.get('lobby')).toBe('detail');
    expect(views.get('cafe')).toBe('detail'); // through the open passage
    expect(views.get('meeting')).toBe('detail'); // through a door
    // From the meeting room: the café is a door then an open passage away; the stairs, two doors.
    expect(roomViews(building, 'meeting').get('cafe')).toBe('detail');
    expect(roomViews(building, 'meeting').get('stairs')).toBe('detail');
    // Upstairs, from the quiet room: everything within three doors or stairs is drawn somehow.
    const quiet = sightDistances(building, 'quiet');
    for (const [key, view] of roomViews(building, 'quiet')) {
      const d = quiet.get(key) ?? Number.POSITIVE_INFINITY;
      expect(view).toBe(d <= DETAIL_SIGHT ? 'detail' : 'stand-in');
      expect(d).toBeLessThanOrEqual(MAX_SIGHT);
    }
  });
});

describe('what to hold in full detail', () => {
  const total = () => building.rooms.reduce((n, r) => n + detailCost(r, 'lod0'), 0);

  it('holds the whole place when it fits, wherever you are', () => {
    const all = building.rooms.map((r) => r.key).sort();
    expect(detailRooms(building, 'lobby', 'lod0', total()).sort()).toEqual(all);
    expect(detailRooms(building, 'terrace', 'lod0', total()).sort()).toEqual(all);
    // Nearest first (the order they're fetched in).
    expect(detailRooms(building, 'lobby', 'lod0', total())[0]).toBe('lobby');
  });

  it('holds the nearest rooms when the place is too big, and always the one you’re in', () => {
    const cost = (key: string) =>
      detailCost(
        building.rooms.find((r) => r.key === key) as (typeof building.rooms)[number],
        'lod0',
      );
    const some = detailRooms(building, 'lobby', 'lod0', total() / 2);
    expect(some.length).toBeGreaterThan(0);
    expect(some.length).toBeLessThan(building.rooms.length);
    expect(some.reduce((n, k) => n + cost(k), 0)).toBeLessThanOrEqual(total() / 2);
    const d = roomDistances(building, 'lobby');
    const furthestHeld = Math.max(...some.map((k) => d.get(k) ?? 0));
    for (const r of building.rooms)
      if (!some.includes(r.key)) expect(d.get(r.key) ?? 99).toBeGreaterThanOrEqual(furthestHeld);
    expect(detailRooms(building, 'garden', 'lod0', 1)).toEqual(['garden']);
  });
});

describe('drawing for where you are', () => {
  it('measures how far you are from a room (nothing inside it)', () => {
    const lobby = building.rooms.find((r) => r.key === 'lobby');
    if (!lobby) throw new Error('no lobby');
    const { min, max } = lobby.bounds;
    expect(distanceToRoom(lobby, (min[0] + max[0]) / 2, min[1] + 1, (min[2] + max[2]) / 2)).toBe(0);
    expect(distanceToRoom(lobby, max[0] + 3, min[1] + 1, max[2] + 4)).toBeCloseTo(5);
    expect(distanceToRoom(lobby, max[0], max[1] + 2, max[2])).toBeCloseTo(2);
  });

  it('holds lighter detail too only when the whole place fits both ways', () => {
    const both = building.rooms.reduce((n, r) => n + detailCost(r, 'lod0') + lighterCost(r), 0);
    expect(holdsLighterDetail(building, 'lod0', both)).toBe(true);
    expect(holdsLighterDetail(building, 'lod0', both - 1)).toBe(false);
    // Devices that draw lighter detail everywhere already.
    expect(holdsLighterDetail(building, 'lod1', both * 10)).toBe(false);
  });

  it('draws the sun’s shadows unless every room is indoors and baked', () => {
    const baked = { path: 'l.webp', bytes: 1, sha256: '', intensity: 1 };
    const rooms = (list: Partial<SpaceManifest['rooms'][number]>[]) =>
      ({ ...building, rooms: list }) as SpaceManifest;
    expect(needsSunShadows(rooms([{ lightmap: baked }, { lightmap: baked }]))).toBe(false);
    expect(needsSunShadows(rooms([{ lightmap: baked }, {}]))).toBe(true);
    expect(needsSunShadows(rooms([{ lightmap: baked, isOutdoor: true }]))).toBe(true);
  });
});

/** A room of the sample, lit with a lightmap of this size (or one that doesn't say). */
function lit(size?: number) {
  const room = structuredClone(building.rooms[0] as SpaceManifest['rooms'][number]);
  room.lightmap = {
    path: 'chunks/lightmap.webp',
    bytes: 1000,
    sha256: '0'.repeat(64),
    intensity: 2,
    ...(size ? { size } : {}),
  };
  return room;
}

describe('lightmap memory', () => {
  it('counts each room at the size its lightmap was baked', () => {
    const mipmapped = (n: number) => Math.round(n * n * 4 * (4 / 3));
    expect(lightmapBytes(lit(512))).toBe(mipmapped(512));
    expect(lightmapBytes(lit(2048))).toBe(mipmapped(2048));
    expect(detailCost(lit(2048), 'lod0') - detailCost(lit(512), 'lod0')).toBe(
      mipmapped(2048) - mipmapped(512),
    );
    expect(lightmapBytes({ ...lit(512), lightmap: undefined })).toBe(0);
  });

  it('counts a KTX2 lightmap at a byte a pixel: it stays compressed on the graphics card', () => {
    const room = lit(2048);
    if (room.lightmap) room.lightmap.path = 'chunks/lightmap.ktx2';
    expect(lightmapBytes(room)).toBe(Math.round(2048 * 2048 * (4 / 3)));
  });

  it('reads places built before lightmaps said their size, which are all 1024 px', () => {
    const old = structuredClone(building);
    old.rooms = [lit()];
    const parsed = SpaceManifest.parse(JSON.parse(JSON.stringify(old)));
    const room = parsed.rooms[0] as SpaceManifest['rooms'][number];
    expect(room.lightmap?.size).toBeUndefined();
    expect(lightmapBytes(room)).toBe(Math.round(1024 * 1024 * 4 * (4 / 3)));
  });
});
