import { readFileSync } from 'node:fs';
import { buildSpace } from '@ats/space-builder';
import type { SpaceManifest } from '@ats/space-format';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DETAIL_SIGHT,
  detailCost,
  detailRooms,
  MAX_SIGHT,
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
