import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRLightsPunctual } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildSpace, checkModels, cleanModel, MODEL_LIMITS } from '../src/index.ts';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** A box model (metres), optionally with extra things a cleaned model mustn't keep. */
async function boxModel(
  size: [number, number, number] = [0.1, 0.18, 0.08],
  extra: { animation?: boolean; light?: boolean; texture?: Uint8Array; boxes?: number } = {},
) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const [w, h, d] = size;
  const p: number[] = [];
  const idx: number[] = [];
  const boxes = extra.boxes ?? 1;
  for (let b = 0; b < boxes; b++) {
    const o = p.length / 3;
    for (const x of [0, w]) for (const y of [0, h]) for (const z of [0, d]) p.push(x, y, z);
    for (const f of [
      [0, 1, 3, 0, 3, 2],
      [4, 6, 7, 4, 7, 5],
      [0, 4, 5, 0, 5, 1],
      [2, 3, 7, 2, 7, 6],
      [0, 2, 6, 0, 6, 4],
      [1, 5, 7, 1, 7, 3],
    ])
      idx.push(...f.map((i) => i + o));
  }
  const material = doc.createMaterial('suit').setBaseColorFactor([0.9, 0.9, 0.85, 1]);
  if (extra.texture)
    material.setBaseColorTexture(
      doc.createTexture('print').setImage(extra.texture).setMimeType('image/png'),
    );
  const prim = doc
    .createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buffer),
    )
    .setIndices(
      doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buffer),
    )
    .setMaterial(material);
  const node = doc
    .createNode('figure')
    .setMesh(doc.createMesh('figure').addPrimitive(prim))
    .setExtras({ secret: 'kept nowhere' });
  doc.createScene('scene').addChild(node);
  if (extra.animation) {
    const times = doc
      .createAccessor()
      .setArray(new Float32Array([0, 1]))
      .setBuffer(buffer);
    const values = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 0, 1, 0]))
      .setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(times).setOutput(values);
    doc
      .createAnimation('spin')
      .addSampler(sampler)
      .addChannel(
        doc
          .createAnimationChannel()
          .setTargetNode(node)
          .setTargetPath('translation')
          .setSampler(sampler),
      );
  }
  if (extra.light) {
    const lights = doc.createExtension(KHRLightsPunctual);
    node.setExtension('KHR_lights_punctual', lights.createLight().setType('point'));
  }
  return io.writeBinary(doc);
}

describe('cleaning a model', () => {
  it('keeps only what is shown: no animation, lights or extra data', async () => {
    const clean = await cleanModel(await boxModel(undefined, { animation: true, light: true }));
    expect(clean.triangles).toBe(12);
    expect(clean.size.map((n) => Number(n.toFixed(3)))).toEqual([0.1, 0.18, 0.08]);
    const doc = await io.readBinary(clean.glb);
    expect(doc.getRoot().listAnimations()).toHaveLength(0);
    expect(
      doc
        .getRoot()
        .listExtensionsUsed()
        .map((e) => e.extensionName),
    ).toEqual([]);
    expect(
      doc
        .getRoot()
        .listNodes()
        .map((n) => n.getExtras()),
    ).toEqual([{}]);
  });

  it('decodes and re-encodes every texture', async () => {
    // A pattern (a single-colour texture would simply become that colour).
    const pixels = Buffer.alloc(8 * 8 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) % 256;
    const png = await sharp(pixels, { raw: { width: 8, height: 8, channels: 3 } })
      .png()
      .toBuffer();
    const clean = await cleanModel(await boxModel(undefined, { texture: new Uint8Array(png) }));
    expect(clean.textures).toBe(1);
    const broken = await boxModel(undefined, { texture: new Uint8Array([1, 2, 3, 4]) });
    await expect(cleanModel(broken)).rejects.toThrow(/texture .* can't be read/);
  });

  it('refuses what it can’t use, plainly', async () => {
    await expect(cleanModel(new TextEncoder().encode('not a model'))).rejects.toThrow(/\.glb/);
    // Metres, not centimetres or millimetres.
    await expect(cleanModel(await boxModel([10, 180, 8]))).rejects.toThrow(/in metres/);
    await expect(cleanModel(await boxModel([0.001, 0.002, 0.001]))).rejects.toThrow(/mm across/);
    const heavy = Math.ceil(MODEL_LIMITS.triangles / 12) + 1;
    await expect(cleanModel(await boxModel(undefined, { boxes: heavy }))).rejects.toThrow(
      /triangles: keep a model under/,
    );
  });

  it('refuses a model that points to files outside itself', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer().setURI('https://example.com/data.bin');
    const prim = doc.createPrimitive().setAttribute(
      'POSITION',
      doc
        .createAccessor()
        .setType('VEC3')
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
        .setBuffer(buffer),
    );
    doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
    const { json } = await io.writeJSON(doc);
    // A .glb whose buffer is somewhere else.
    const text = new TextEncoder().encode(
      JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4, ' '),
    );
    const glb = new Uint8Array(20 + text.length);
    const view = new DataView(glb.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, glb.length, true);
    view.setUint32(12, text.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    glb.set(text, 20);
    await expect(cleanModel(glb)).rejects.toThrow(/separate files/);
  });
});

const plan = (model: string, extra: object = {}) => ({
  name: 'Office',
  spaceType: 'office',
  floors: [{ key: 'f1', name: 'Ground', elevation: 0 }],
  rooms: [{ key: 'study', name: 'Study', floor: 'f1', rect: [0, 0, 4, 3] }],
  furniture: [
    { key: 'desk', room: 'study', kind: 'desk', label: 'Desk', at: [2, 1] },
    {
      key: 'astronaut',
      room: 'study',
      kind: 'box',
      label: 'Astronaut figure',
      at: [1, 1],
      model,
      ...extra,
    },
  ],
  spawns: [{ key: 's', room: 'study', at: [2, 2] }],
});

describe('a place with models', () => {
  it('checks every model the plan uses, and names what to fix', async () => {
    const files = new Map([['models/astronaut.glb', await boxModel()]]);
    const ok = await checkModels(
      // biome-ignore lint/suspicious/noExplicitAny: a plan as written
      (await import('@ats/space-format')).SpacePlan.parse(plan('models/astronaut.glb')) as any,
      files,
    );
    expect(ok.problems).toEqual([]);
    expect(ok.models.get('models/astronaut.glb')?.triangles).toBe(12);
    const missing = await checkModels(
      // biome-ignore lint/suspicious/noExplicitAny: a plan as written
      (await import('@ats/space-format')).SpacePlan.parse(plan('models/r2d2.glb')) as any,
      files,
    );
    expect(missing.problems.map((p) => p.message)).toEqual([
      "models/r2d2.glb isn't in the workspace.",
    ]);
  });

  it('builds it into the room at its own size, where people can select it', async () => {
    const files = new Map([['models/astronaut.glb', await boxModel()]]);
    const { SpacePlan } = await import('@ats/space-format');
    const parsed = SpacePlan.parse(plan('models/astronaut.glb', { mountHeight: 0.8 }));
    const { models } = await checkModels(parsed, files);
    const built = await buildSpace(parsed, { models });
    expect(built.stats.models).toBe(1);
    const room = built.manifest.rooms[0];
    const figure = room?.objects.find((o) => o.key === 'astronaut');
    // Mounted with its centre 0.8 m up (on a desk): its base is 0.8 − 0.18 / 2 above the floor.
    expect(figure?.position[1]).toBeCloseTo(0.8 - 0.09, 5);
    const lod0 = JSON.parse(
      new TextDecoder().decode(built.files.get(room?.lods.lod0.path as string) as Uint8Array),
    );
    const node = lod0.nodes.find((n: { name: string }) => n.name === 'object:astronaut');
    expect(node.extras).toMatchObject({ objectKey: 'astronaut', label: 'Astronaut figure' });
    expect(node.scale).toBeUndefined(); // its own size
  });

  it('scales a model evenly into the size the plan gives it', async () => {
    const files = new Map([['models/astronaut.glb', await boxModel()]]);
    const { SpacePlan } = await import('@ats/space-format');
    const parsed = SpacePlan.parse(plan('models/astronaut.glb', { size: [0.05, 0.36, 0.05] }));
    const { models } = await checkModels(parsed, files);
    const built = await buildSpace(parsed, { models });
    const room = built.manifest.rooms[0];
    const lod0 = JSON.parse(
      new TextDecoder().decode(built.files.get(room?.lods.lod0.path as string) as Uint8Array),
    );
    const node = lod0.nodes.find((n: { name: string }) => n.name === 'object:astronaut');
    expect(node.scale[0]).toBeCloseTo(0.5, 5); // the narrowest fit: 0.05 / 0.1
  });

  it('keeps the simple shape for a model it doesn’t have', async () => {
    const { SpacePlan } = await import('@ats/space-format');
    const built = await buildSpace(SpacePlan.parse(plan('models/missing.glb')), {
      models: new Map(),
    });
    expect(built.stats.models).toBe(0);
    expect(built.manifest.rooms[0]?.objects.map((o) => o.key)).toContain('astronaut');
  });
});

describe('a room preview', () => {
  it('is one .glb, seen from the corners, never from inside the furniture', async () => {
    const { previewRoom } = await import('../src/index.ts');
    const room = await previewRoom(
      {
        ...plan('models/missing.glb'),
        furniture: [
          // A wardrobe filling the first corner.
          {
            key: 'wardrobe',
            room: 'study',
            kind: 'cabinet',
            label: 'Wardrobe',
            at: [0.4, 0.4],
            size: [0.8, 2, 0.8],
          },
        ],
      },
      'study',
    );
    expect(new TextDecoder().decode(room.glb.subarray(0, 4))).toBe('glTF');
    const [first, second] = room.cameras;
    // The free corner stays a corner; the taken one steps in until it's clear of the wardrobe.
    expect(second?.position[0]).toBeCloseTo(4 - 0.35, 5);
    const d = Math.hypot((first?.position[0] ?? 0) - 0.4, (first?.position[2] ?? 0) - 0.4);
    expect(d).toBeGreaterThan(Math.hypot(0.8, 0.8) / 2 + 0.3);
    expect(room.cameras.every((c) => c.position[1] === 1.6)).toBe(true);
  });
});
