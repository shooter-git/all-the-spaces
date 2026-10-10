import { readFileSync } from 'node:fs';
import { manifestFiles, type SpaceManifest, viewerManifest } from '@ats/space-format';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSpace } from '../src/index.ts';

let building: SpaceManifest;
beforeAll(async () => {
  const plan = JSON.parse(
    readFileSync(new URL('../../../samples/two-floor-building/plan.json', import.meta.url), 'utf8'),
  );
  building = (await buildSpace(plan)).manifest;
});

const all = () => new Set(building.rooms.map((r) => r.key));

describe('what one person may see of a space', () => {
  it('leaves out hidden rooms completely', () => {
    const hidden = ['quiet', 'office'];
    const visible = new Set([...all()].filter((k) => !hidden.includes(k)));
    const seen = viewerManifest(building, visible);
    expect(seen).not.toBeNull();
    const json = JSON.stringify(seen);
    for (const key of hidden) {
      const room = building.rooms.find((r) => r.key === key);
      if (!room) throw new Error(key);
      // No key, name or file of a hidden room appears anywhere (keys are matched as JSON strings).
      expect(json).not.toContain(`"${key}"`);
      expect(json).not.toContain(room.name);
      const sharedWithVisible = new Set(
        building.rooms.filter((r) => visible.has(r.key)).flatMap((r) => r.files),
      );
      for (const path of [room.lods.lod0.path, room.lods.lod1.path, room.collision.path])
        expect(json).not.toContain(path);
      for (const f of room.files) if (!sharedWithVisible.has(f)) expect(json).not.toContain(f);
    }
  });

  it('turns doorways into hidden rooms into closed doors', () => {
    const visible = new Set([...all()].filter((k) => k !== 'office'));
    const seen = viewerManifest(building, visible) as SpaceManifest;
    const hall = seen.rooms.find((r) => r.key === 'hall');
    const original = building.rooms.find((r) => r.key === 'hall');
    expect(hall?.doorways.length).toBe(original?.doorways.length);
    const closed = hall?.doorways.filter((d) => d.closed) ?? [];
    expect(closed.length).toBe(original?.doorways.filter((d) => d.to === 'office').length);
    for (const d of closed) expect(d.to).toBeUndefined();
    expect(hall?.neighbors).not.toContain('office');
  });

  it('drops lifts that no longer connect two visible rooms, and moves the start point', () => {
    const visible = new Set(['hall', 'quiet', 'terrace', 'office']); // upstairs only
    const seen = viewerManifest(building, visible) as SpaceManifest;
    expect(seen.links).toEqual([]);
    expect(seen.spawns.every((s) => visible.has(s.roomKey))).toBe(true);
    expect(seen.floors.map((f) => f.key)).toEqual(['f2']);
  });

  it('lists exactly the files of the visible rooms', () => {
    const visible = new Set(['lobby']);
    const seen = viewerManifest(building, visible) as SpaceManifest;
    const lobby = building.rooms.find((r) => r.key === 'lobby');
    const files = manifestFiles(seen);
    expect(files.has(lobby?.lods.lod0.path ?? '')).toBe(true);
    const cafe = building.rooms.find((r) => r.key === 'cafe');
    expect(files.has(cafe?.lods.lod0.path ?? '')).toBe(false);
  });

  it('shows nothing to someone who may see no rooms', () => {
    expect(viewerManifest(building, new Set())).toBeNull();
  });
});
