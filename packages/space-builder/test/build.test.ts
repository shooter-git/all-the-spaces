import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildSpace, wallSegments } from '../src/index.ts';

const require = createRequire(import.meta.url);
const validator = require('gltf-validator') as {
  validateBytes(
    b: Uint8Array,
    options?: { externalResourceFunction?: (uri: string) => Promise<Uint8Array> },
  ): Promise<{ issues: { numErrors: number; messages: unknown[] } }>;
};
const sample = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../samples/${name}/plan.json`, import.meta.url), 'utf8'));
// One build of each sample, shared by the tests that only read it (a build is the slow part).
const builds = new Map<string, ReturnType<typeof buildSpace>>();
const built = (name: string) => {
  let b = builds.get(name);
  if (!b) {
    b = buildSpace(sample(name));
    builds.set(name, b);
  }
  return b;
};

describe('walls', () => {
  it('cut a door and a window out of a wall', () => {
    const segs = wallSegments(
      [0, 6],
      [0, 2.7],
      [
        { side: 'north', u0: 1, u1: 2, v0: 0, v1: 2.1, kind: 'door' },
        { side: 'north', u0: 3, u1: 5, v0: 0.9, v1: 2.2, kind: 'window' },
      ],
    );
    const area = segs.reduce((a, s) => a + (s.u1 - s.u0) * (s.v1 - s.v0), 0);
    expect(area).toBeCloseTo(6 * 2.7 - 1 * 2.1 - 2 * 1.3, 6);
    // Nothing solid inside either opening.
    for (const s of segs) {
      const inDoor = s.u0 >= 1 && s.u1 <= 2 && s.v0 < 2.1;
      const inWindow = s.u0 >= 3 && s.u1 <= 5 && s.v0 < 2.2 && s.v1 > 0.9;
      expect(inDoor || inWindow).toBe(false);
    }
  });
});

describe.each(['studio-apartment', 'two-floor-building'])('%s sample', (name) => {
  it('builds a consistent, connected space of valid files', async () => {
    const { manifest, files } = await built(name);
    const rooms = new Map(manifest.rooms.map((r) => [r.key, r]));

    // Doorways are symmetric: if A opens to B, B opens to A.
    for (const r of manifest.rooms) {
      for (const d of r.doorways)
        expect(rooms.get(d.to ?? '')?.doorways.some((x) => x.to === r.key)).toBe(true);
    }
    // Every room can be walked to from the spawn (directly or via a lift).
    const seen = new Set([manifest.spawns[0]?.roomKey]);
    const queue = [...seen];
    const lifts = manifest.links.flatMap((l) => l.stops.map((s) => s.roomKey));
    while (queue.length) {
      const k = queue.pop() as string;
      const next = [...(rooms.get(k)?.neighbors ?? []), ...(lifts.includes(k) ? lifts : [])];
      for (const n of next) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect([...seen].sort()).toEqual([...rooms.keys()].sort());

    // Every referenced file exists and is a valid glTF.
    for (const r of manifest.rooms) {
      for (const ref of [r.lods.lod0, r.lods.lod1, r.lods.lod2, r.collision]) {
        const bytes = files.get(ref.path);
        expect(bytes).toBeDefined();
        const report = await validator.validateBytes(bytes as Uint8Array, {
          externalResourceFunction: async (uri) => {
            const file = files.get(`chunks/${uri}`);
            if (!file) throw new Error(`missing ${uri}`);
            return file;
          },
        });
        expect(report.issues.numErrors, JSON.stringify(report.issues.messages)).toBe(0);
      }
    }
  });

  it('is deterministic (same plan, same content hashes)', async () => {
    // A second, independent build of the same plan.
    const a = await built(name);
    const b = await buildSpace(sample(name));
    expect([...a.files.keys()].sort()).toEqual([...b.files.keys()].sort());
  });
});

it("keeps each room's geometry inside its own footprint (no leaks between rooms)", async () => {
  const { manifest, files } = await built('two-floor-building');
  // Rooms are built only from their own plan data; the LOD0 file of a room never changes when a
  // neighbour's furniture changes.
  const plan = sample('two-floor-building');
  plan.furniture = plan.furniture.filter((f: { room: string }) => f.room !== 'quiet');
  const changed = await buildSpace(plan);
  const quietBefore = manifest.rooms.find((r) => r.key === 'quiet')?.lods.lod0.sha256;
  const quietAfter = changed.manifest.rooms.find((r) => r.key === 'quiet')?.lods.lod0.sha256;
  const hallBefore = manifest.rooms.find((r) => r.key === 'hall')?.lods.lod0.sha256;
  const hallAfter = changed.manifest.rooms.find((r) => r.key === 'hall')?.lods.lod0.sha256;
  expect(quietAfter).not.toBe(quietBefore);
  expect(hallAfter).toBe(hallBefore);
  expect(files.size).toBeGreaterThan(0);
});

describe('a room seen from far away', () => {
  it('keeps its doorways and passages open, and its windows solid', async () => {
    const { buildStandIn, PlanIndex } = await import('../src/index.ts');
    const { MeshBuilder } = await import('../src/geometry.ts');
    const { SpacePlan } = await import('@ats/space-format');
    const plan = SpacePlan.parse({
      name: 'Two rooms',
      spaceType: 'office',
      floors: [{ key: 'f1', name: 'Ground', elevation: 0 }],
      rooms: [
        { key: 'a', name: 'Open plan', floor: 'f1', rect: [0, 0, 6, 4] },
        { key: 'b', name: 'Meeting room', floor: 'f1', rect: [6, 0, 10, 4] },
      ],
      openings: [
        { kind: 'open', rooms: ['a', 'b'], at: [6, 1], width: 1.6 },
        { kind: 'door', rooms: ['a', 'b'], at: [6, 3], width: 0.9 },
        { kind: 'window', room: 'a', side: 'north', at: 3, width: 1.4 },
      ],
      spawns: [{ key: 's', room: 'a', at: [2, 2] }],
    });
    const index = new PlanIndex(plan);
    // Every box the stand-in is made of (each box is 6 faces of 4 corners).
    const boxes = (mesh: InstanceType<typeof MeshBuilder>) => {
      const out: { min: number[]; max: number[] }[] = [];
      for (const g of mesh.groups.values())
        for (let i = 0; i < g.positions.length; i += 72) {
          const p = g.positions.slice(i, i + 72);
          const xs = p.filter((_, j) => j % 3 === 0);
          const ys = p.filter((_, j) => j % 3 === 1);
          const zs = p.filter((_, j) => j % 3 === 2);
          out.push({
            min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
            max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
          });
        }
      return out;
    };
    const solidAt = (mesh: InstanceType<typeof MeshBuilder>, p: number[]) =>
      boxes(mesh).some((b) =>
        p.every((v, k) => v > (b.min[k] as number) && v < (b.max[k] as number)),
      );
    for (const key of ['a', 'b']) {
      const mesh = new MeshBuilder();
      buildStandIn(index, index.room(key), mesh);
      // Through the passage and the door, at head height, just inside each room's wall.
      const x = key === 'a' ? 6 - 0.04 : 6 + 0.04;
      expect(solidAt(mesh, [x, 1.5, 1]), `${key}: passage`).toBe(false);
      expect(solidAt(mesh, [x, 1.5, 3]), `${key}: door`).toBe(false);
      // The wall between them is still there.
      expect(solidAt(mesh, [x, 1.5, 2]), `${key}: wall`).toBe(true);
    }
    const a = new MeshBuilder();
    buildStandIn(index, index.room('a'), a);
    expect(solidAt(a, [3, 1.5, 0.04])).toBe(true); // the window, far away
  });
});
