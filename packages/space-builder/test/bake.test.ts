import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BakeError,
  type BakeInput,
  type BakeRunner,
  bakeRoom,
  bakeSettingsFromEnv,
  blenderBaker,
  findBlender,
} from '../src/bake.ts';
import { buildSpace } from '../src/build.ts';
import { MeshBuilder } from '../src/geometry.ts';
import { MaterialLibrary, writeChunk } from '../src/gltf.ts';

describe('bake settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ats-bin-'));
  writeFileSync(join(dir, 'blender'), '#!/bin/sh\n');
  chmodSync(join(dir, 'blender'), 0o755);

  it('finds Blender on the PATH, or uses ATS_BLENDER', () => {
    expect(findBlender({ PATH: dir })).toBe(join(dir, 'blender'));
    expect(findBlender({ PATH: dir, ATS_BLENDER: '/opt/b' })).toBe('/opt/b');
    expect(bakeSettingsFromEnv({ PATH: dir, ATS_BAKE_RES: '512' })?.resolution).toBe(512);
  });

  it('is off without Blender, or with ATS_BAKE=0', () => {
    expect(bakeSettingsFromEnv({ PATH: tmpdir() })).toBeNull();
    expect(bakeSettingsFromEnv({ PATH: dir, ATS_BAKE: '0' })).toBeNull();
  });
});

/** A 4 × 3 m room with a floor, walls and ceiling. */
function room() {
  const b = new MeshBuilder();
  b.quad('floor:oak', [0, 0, 3], [4, 0, 3], [4, 0, 0], [0, 0, 0]);
  b.quad('plaster', [0, 2.5, 0], [4, 2.5, 0], [4, 2.5, 3], [0, 2.5, 3]);
  b.quad('plaster', [0, 0, 0], [4, 0, 0], [4, 2.5, 0], [0, 2.5, 0]);
  b.quad('plaster', [4, 0, 3], [0, 0, 3], [0, 2.5, 3], [4, 2.5, 3]);
  b.quad('plaster', [0, 0, 3], [0, 0, 0], [0, 2.5, 0], [0, 2.5, 3]);
  b.quad('plaster', [4, 0, 0], [4, 0, 3], [4, 2.5, 3], [4, 2.5, 0]);
  return b;
}

it('keeps lightmap UVs when writing a chunk', async () => {
  const b = room();
  for (const g of b.groups.values()) g.uv2 = new Float32Array(g.uvs.length).fill(0.5);
  const { gltf } = await writeChunk(
    [{ name: 'architecture', mesh: b }],
    [],
    new MaterialLibrary(null),
  );
  const json = JSON.parse(new TextDecoder().decode(gltf));
  for (const p of json.meshes[0].primitives) expect(p.attributes.TEXCOORD_1).toBeDefined();
});

const blender = findBlender({ PATH: process.env.PATH ?? '' });

describe.skipIf(!blender)('baking with Blender', () => {
  it('bakes a room and gives every surface its own place in the lightmap', async () => {
    const receiver = room();
    const blockers = new MeshBuilder();
    blockers.box('oak', [1.5, 0.4, 1], [2.5, 0.45, 2]); // a table top
    const baked = await bakeRoom(
      receiver,
      blockers,
      { rect: [0, 0, 4, 3], base: 0, top: 2.5, outdoor: false, doorways: [] },
      { run: blenderBaker(blender as string), resolution: 64, samples: 4 },
    );
    expect(baked.ok && baked.lightmap.intensity).toBeGreaterThan(0);
    const uvs = [...receiver.groups.values()].flatMap((g) => [...(g.uv2 ?? [])]);
    expect(uvs.length).toBe(6 * 4 * 2);
    for (const v of uvs) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of uvs) expect(v).toBeLessThanOrEqual(1);
    // Each quad gets its own patch of the lightmap: some area, no overlaps.
    const rects: [number, number, number, number][] = [];
    for (let q = 0; q < 6; q++) {
      const us = [0, 1, 2, 3].map((i) => uvs[(q * 4 + i) * 2] as number);
      const vs = [0, 1, 2, 3].map((i) => uvs[(q * 4 + i) * 2 + 1] as number);
      rects.push([Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)]);
    }
    for (const [u0, v0, u1, v1] of rects) expect((u1 - u0) * (v1 - v0)).toBeGreaterThan(0.01);
    rects.forEach((a, i) => {
      for (const b of rects.slice(i + 1)) {
        const overlap =
          Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 1e-4 &&
          Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 1e-4;
        expect(overlap).toBe(false);
      }
    });
  }, 120_000);
});

/** Stands in for Blender: a flat grey lightmap of the asked size, and one UV pair per vertex. */
function fakeBaker() {
  const baked: BakeInput[] = [];
  const run: BakeRunner = async (input) => {
    baked.push(input);
    const n = input.resolution;
    return {
      meta: { width: n, height: n, seconds: 1 },
      uv2: new Uint8Array(
        new Float32Array((input.receiver.positions.length / 3) * 2).fill(0.5).buffer,
      ),
      lightmap: new Uint8Array(new Float32Array(n * n * 4).fill(0.3).buffer),
    };
  };
  return { run, baked };
}

describe('incremental bakes', () => {
  const plan = () =>
    JSON.parse(
      readFileSync(
        new URL('../../../samples/two-floor-building/plan.json', import.meta.url),
        'utf8',
      ),
    );
  const kept = new Map<string, Uint8Array>();
  const cache = {
    get: async (key: string) => kept.get(key) ?? null,
    put: async (key: string, data: Uint8Array) => void kept.set(key, data),
  };
  const lod0 = (m: Awaited<ReturnType<typeof buildSpace>>['manifest'], key: string) =>
    m.rooms.find((r) => r.key === key)?.lods.lod0.sha256;

  it('bakes only the rooms whose inputs changed since an earlier build', async () => {
    const first = fakeBaker();
    const a = await buildSpace(plan(), {
      bake: { run: first.run, cache, resolution: 8, samples: 1 },
    });
    const indoor = a.manifest.rooms.filter((r) => !r.isOutdoor);
    expect(first.baked.length).toBe(indoor.length);
    expect(a.stats.lighting).toEqual({
      rooms: indoor.length,
      baked: indoor.length,
      reused: 0,
      failure: null,
    });
    for (const r of indoor) expect(r.lightmap).toBeDefined();

    // The same plan again: nothing is baked, and every room comes out byte-identical.
    const again = fakeBaker();
    const b = await buildSpace(plan(), {
      bake: { run: again.run, cache, resolution: 8, samples: 1 },
    });
    expect(again.baked.length).toBe(0);
    expect(b.stats.lighting.reused).toBe(indoor.length);
    expect(b.manifest).toEqual(a.manifest);

    // One room's furniture changes: only that room is baked again.
    const changed = plan();
    changed.furniture = changed.furniture.filter((f: { room: string }) => f.room !== 'quiet');
    const third = fakeBaker();
    const c = await buildSpace(changed, {
      bake: { run: third.run, cache, resolution: 8, samples: 1 },
    });
    expect(third.baked.length).toBe(1);
    expect(c.stats.lighting).toMatchObject({ baked: indoor.length, reused: indoor.length - 1 });
    expect(lod0(c.manifest, 'hall')).toBe(lod0(a.manifest, 'hall'));
    expect(lod0(c.manifest, 'quiet')).not.toBe(lod0(a.manifest, 'quiet'));
  });

  it('builds the place anyway when baking fails, and says why', async () => {
    const run: BakeRunner = async () => {
      throw new BakeError('The bake job took longer than 30 minutes', true);
    };
    const built = await buildSpace(plan(), { bake: { run, resolution: 8, samples: 1 } });
    expect(built.manifest.rooms.some((r) => r.lightmap)).toBe(false);
    expect(built.stats.lighting).toMatchObject({
      baked: 0,
      reused: 0,
      failure: { error: 'The bake job took longer than 30 minutes', timedOut: true },
    });
  });

  it('bakes rooms side by side, never more than it may at once, into the same place', async () => {
    const indoor = plan().rooms.filter((r: { outdoor?: boolean }) => !r.outdoor).length;
    // A slow fake Blender: some rooms take longer, so they finish out of order.
    let active = 0;
    let most = 0;
    let calls = 0;
    const slow: BakeRunner = async (input) => {
      const n = calls++;
      active++;
      most = Math.max(most, active);
      try {
        await new Promise((r) => setTimeout(r, n % 2 ? 5 : 25));
        if (n === 1) throw new BakeError('the bake job failed: RuntimeError: out of tiles');
        return {
          meta: { width: input.resolution, height: input.resolution, seconds: 60 },
          uv2: new Uint8Array(
            new Float32Array((input.receiver.positions.length / 3) * 2).fill(0.5).buffer,
          ),
          lightmap: new Uint8Array(new Float32Array(input.resolution ** 2 * 4).fill(0.3).buffer),
        };
      } finally {
        active--;
      }
    };
    const told: { rooms: number; done: number; secondsPerRoom: number | null }[] = [];
    const side = await buildSpace(plan(), {
      bake: {
        run: slow,
        resolution: 8,
        samples: 1,
        parallel: 3,
        progress: ({ rooms, done, secondsPerRoom, parallel }) => {
          expect(parallel).toBe(3);
          told.push({ rooms, done, secondsPerRoom });
        },
      },
    });
    expect(most).toBe(3);
    // The room that failed doesn't stop the others; the report names it.
    expect(side.stats.lighting).toEqual({
      rooms: indoor,
      baked: indoor - 1,
      reused: 0,
      failure: { error: 'the bake job failed: RuntimeError: out of tiles', timedOut: false },
    });
    // Told as it starts and after every room, with the time a room takes once one has been baked.
    expect(told[0]).toEqual({ rooms: indoor, done: 0, secondsPerRoom: null });
    expect(told.map((t) => t.done)).toEqual(Array.from({ length: indoor + 1 }, (_, i) => i));
    expect(told.at(-1)?.secondsPerRoom).toBe(60);

    // One at a time, the same rooms fail and the place comes out the same.
    calls = 0;
    most = 0;
    const one = await buildSpace(plan(), { bake: { run: slow, resolution: 8, samples: 1 } });
    expect(most).toBe(1);
    expect(one.manifest).toEqual(side.manifest);
    expect([...one.files.keys()].sort()).toEqual([...side.files.keys()].sort());
  });
});
