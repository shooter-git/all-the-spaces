import { Document, NodeIO, type Scene } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/geometry.ts';
import {
  FULL_DETAIL,
  MaterialLibrary,
  MEDIUM_DETAIL,
  type PlacedModel,
  workspaceModel,
  writeChunk,
} from '../src/gltf.ts';
import { MODEL_LIMITS } from '../src/models.ts';
import { chunkStats } from '../src/stats.ts';

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

/** A door-like model: many small parts in turned nodes, over two materials. */
async function manyParts(parts: number) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const wood = doc.createMaterial('wood').setBaseColorFactor([0.5, 0.3, 0.1, 1]);
  const brass = doc.createMaterial('brass').setBaseColorFactor([0.8, 0.7, 0.3, 1]);
  const box = (material: typeof wood) => {
    const p: number[] = [];
    for (const x of [0, 0.05])
      for (const y of [0, 0.05]) for (const z of [0, 0.05]) p.push(x, y, z);
    const idx = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1];
    return doc.createMesh().addPrimitive(
      doc
        .createPrimitive()
        .setAttribute(
          'POSITION',
          doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer),
        )
        .setIndices(doc.createAccessor().setArray(new Uint16Array(idx)).setBuffer(buffer))
        .setMaterial(material),
    );
  };
  // One handle mesh used by several parts, as exported models often do.
  const handle = box(brass);
  const group = doc.createNode('door').setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  for (let i = 0; i < parts; i++)
    group.addChild(
      doc
        .createNode(`part-${i}`)
        .setTranslation([(i % 10) * 0.06, Math.floor(i / 10) * 0.06, 0])
        .setMesh(i % 5 === 0 ? handle : box(wood)),
    );
  doc.createScene().addChild(group);
  return io.writeBinary(doc);
}

/** A flat sheet of `n`×`n` squares (2·n² triangles). */
async function sheet(n: number) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const p: number[] = [];
  const idx: number[] = [];
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) p.push(x / n, 0, z / n);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x;
      idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  const mesh = doc.createMesh().addPrimitive(
    doc
      .createPrimitive()
      .setAttribute(
        'POSITION',
        doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer),
      )
      .setIndices(doc.createAccessor().setArray(new Uint32Array(idx)).setBuffer(buffer))
      .setMaterial(doc.createMaterial('leaf')),
  );
  doc.createScene().addChild(doc.createNode('plant').setMesh(mesh));
  return io.writeBinary(doc);
}

/** A desk: a maple top, and a steel rail along its front edge with its top at `rail`. */
async function desk(rail: number) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const block = (name: string, color: [number, number, number, number], min: V3, max: V3) => {
    const p: number[] = [];
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) p.push(x, y, z);
    const idx = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 2, 3, 7, 2, 7, 6];
    return doc.createNode(name).setMesh(
      doc.createMesh().addPrimitive(
        doc
          .createPrimitive()
          .setAttribute(
            'POSITION',
            doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer),
          )
          .setIndices(doc.createAccessor().setArray(new Uint16Array(idx)).setBuffer(buffer))
          .setMaterial(doc.createMaterial(name).setBaseColorFactor(color)),
      ),
    );
  };
  doc
    .createScene()
    .addChild(block('maple', [0.8, 0.6, 0.4, 1], [0, 0.73, 0], [1.4, 0.75, 0.7]))
    .addChild(block('steel', [0.1, 0.1, 0.1, 1], [0, 0.7, 0], [1.4, rail, 0.03]));
  return io.writeBinary(doc);
}

const placed = (
  glb: Uint8Array,
  at: { angle: number; position: V3 } = { angle: 0.5, position: [1, 0, 2] },
): PlacedModel => ({
  name: 'object:door-1',
  source: workspaceModel(glb),
  ...at,
  scale: 1,
  extras: { objectKey: 'door-1', label: 'Office door', kind: 'door' },
});

/** The chunk (its glTF JSON, and read back), and the node holding the placed object. */
async function chunk(glb: Uint8Array, detail = FULL_DETAIL, model = placed(glb)) {
  const { gltf, resources } = await writeChunk([], [model], new MaterialLibrary(null), { detail });
  const json = JSON.parse(new TextDecoder().decode(gltf));
  const holder = json.nodes.find((n: { name?: string }) => n.name === 'object:door-1');
  await MeshoptDecoder.ready;
  const doc = await io.readJSON({
    json,
    resources: Object.fromEntries(resources) as Record<string, Uint8Array<ArrayBuffer>>,
  });
  return { json, holder, doc };
}

describe('a placed model', () => {
  it('is drawn as one mesh with one primitive per material, its object kept', async () => {
    const { json, holder } = await chunk(await manyParts(40));
    expect(holder.extras).toEqual({ objectKey: 'door-1', label: 'Office door', kind: 'door' });
    // One child, holding the whole model; nothing below it.
    expect(holder.children).toHaveLength(1);
    const model = json.nodes[holder.children[0]];
    expect(model.children ?? []).toHaveLength(0);
    const prims = json.meshes[model.mesh].primitives;
    expect(prims).toHaveLength(2);
    expect(new Set(prims.map((p: { material: number }) => p.material)).size).toBe(2);
    // Every part's triangles are still there (the shared handle once per use).
    expect(chunkStats(json)).toEqual({ draws: 2, nodes: 2, triangles: 40 * 6 });
  });

  it('keeps its parts where they were', async () => {
    const glb = await manyParts(40);
    const { doc } = await chunk(glb, FULL_DETAIL, placed(glb, { angle: 0, position: [0, 0, 0] }));
    // Centred on its holder and standing on the floor. The parts are turned a quarter-turn, so
    // their 10 columns run along z.
    const { min, max } = getBounds(doc.getRoot().listScenes()[0] as Scene);
    expect(max[0] - min[0]).toBeCloseTo(0.05, 3);
    expect(max[1] - min[1]).toBeCloseTo(0.23, 3);
    expect(max[2] - min[2]).toBeCloseTo(0.59, 3);
    expect(min[1]).toBeCloseTo(0, 3);
    expect(min[0] + max[0]).toBeCloseTo(0, 3);
    expect(min[2] + max[2]).toBeCloseTo(0, 3);
  });

  /** How far the rail's top ends up above the desktop (metres; below is negative). */
  async function railAbove(rail: number) {
    const glb = await desk(rail);
    const { doc } = await chunk(glb, FULL_DETAIL, placed(glb, { angle: 0, position: [0, 0, 0] }));
    const top = new Map<string, number>();
    for (const node of doc.getRoot().listNodes()) {
      const m = node.getWorldMatrix();
      for (const prim of node.getMesh()?.listPrimitives() ?? []) {
        const pos = prim.getAttribute('POSITION');
        const name = prim.getMaterial()?.getName() ?? '';
        const v: number[] = [];
        for (let i = 0; i < (pos?.getCount() ?? 0); i++) {
          pos?.getElement(i, v);
          const y = m[1] * (v[0] ?? 0) + m[5] * (v[1] ?? 0) + m[9] * (v[2] ?? 0) + m[13];
          top.set(name, Math.max(top.get(name) ?? -Infinity, y));
        }
      }
    }
    return (top.get('steel') ?? 0) - (top.get('maple') ?? 0);
  }

  it('moves a smaller part flush with a larger one out of it, so they stop flickering', async () => {
    expect(await railAbove(0.75)).toBeCloseTo(0.0005, 4);
  });

  it('moves a smaller part just under a larger one further under it', async () => {
    expect(await railAbove(0.74999)).toBeCloseTo(-0.0005, 4);
  });

  it('is held to the triangle budget, and simplified further for rooms next door', async () => {
    const glb = await sheet(200); // 80,000 triangles
    const full = chunkStats((await chunk(glb)).json).triangles;
    expect(full).toBeLessThanOrEqual(MODEL_LIMITS.triangles);
    expect(full).toBeGreaterThan(MODEL_LIMITS.triangles / 4);
    const medium = chunkStats((await chunk(glb, MEDIUM_DETAIL)).json).triangles;
    expect(medium).toBeLessThan(full);
  });
});
