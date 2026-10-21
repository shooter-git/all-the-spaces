import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { deflateSync } from 'node:zlib';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  CompressedTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RGBA_ASTC_4x4_Format,
  Texture,
} from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { MaterialLibrary, workspaceModel, writeChunk } from '../../space-builder/src/gltf.ts';
import { SharedTextures } from '../src/textures.ts';

/** A tiny PNG (RGBA, 8 bits a channel), so the test needs no image library. */
function png(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const v of b) c = (crcTable[(c ^ v) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(4 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', head),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const colour = (x: number, y: number) => [x * 4, y * 4, 128, 255];
const normal = (x: number) => [128 + Math.round(40 * Math.sin(x / 4)), 128, 240, 255];

/** A model whose one material has a colour map and a normal map. */
async function texturedModel() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const accessor = (type: 'VEC2' | 'VEC3', array: Float32Array<ArrayBuffer>) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const material = doc
    .createMaterial('tile')
    .setBaseColorTexture(
      doc
        .createTexture('c')
        .setImage(png(64, 64, colour))
        .setMimeType('image/png'),
    )
    .setNormalTexture(
      doc
        .createTexture('n')
        .setImage(png(64, 64, normal))
        .setMimeType('image/png'),
    );
  const mesh = doc.createMesh().addPrimitive(
    doc
      .createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
      .setAttribute('NORMAL', accessor('VEC3', new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])))
      .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array([0, 0, 1, 0, 0, 1])))
      .setMaterial(material),
  );
  doc.createScene().addChild(doc.createNode('tile').setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

/** three.js's own Basis transcoder (the one the app serves), run here without a worker. */
async function transcoder() {
  const dir = dirname(
    createRequire(import.meta.url).resolve('three/examples/jsm/libs/basis/basis_transcoder.js'),
  );
  const make = runInNewContext(`${readFileSync(join(dir, 'basis_transcoder.js'), 'utf8')}; BASIS`, {
    WebAssembly,
    console,
    performance,
  }) as (o: { wasmBinary: Uint8Array }) => Promise<BasisModule>;
  const basis = await make({ wasmBinary: readFileSync(join(dir, 'basis_transcoder.wasm')) });
  basis.initializeBasis();
  return basis;
}
interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (
    bytes: Uint8Array,
  ) => {
    isValid(): boolean;
    getWidth(): number;
    getHeight(): number;
    getLevels(): number;
    isUASTC(): boolean;
    startTranscoding(): boolean;
    getImageTranscodedSizeInBytes(level: number, layer: number, face: number, f: number): number;
    transcodeImage(
      dst: Uint8Array,
      l: number,
      a: number,
      f: number,
      fmt: number,
      g: number,
      c: number,
      i: number,
    ): number;
    close(): void;
    delete(): void;
  };
}
const RGBA32 = 13;

describe('textures in a built room', () => {
  it('are KTX2 files the graphics card reads compressed, with mipmaps, that read back right', async () => {
    const model = await texturedModel();
    const { gltf, resources } = await writeChunk(
      [],
      [
        {
          name: 'object:tile',
          source: workspaceModel(model),
          angle: 0,
          position: [0, 0, 0],
          scale: 1,
        },
      ],
      new MaterialLibrary(null),
    );
    const json = JSON.parse(new TextDecoder().decode(gltf));
    expect(json.extensionsRequired).toContain('KHR_texture_basisu');
    expect(json.images).toHaveLength(2);
    for (const image of json.images) {
      expect(image.mimeType).toBe('image/ktx2');
      expect(image.uri).toMatch(/^[0-9a-f]{64}\.ktx2$/);
    }
    for (const t of json.textures)
      expect(t.extensions.KHR_texture_basisu.source).toBeTypeOf('number');

    const basis = await transcoder();
    const material = json.materials[0];
    const fileOf = (texture: number) => {
      const uri = json.images[json.textures[texture].extensions.KHR_texture_basisu.source].uri;
      return resources.get(uri) as Uint8Array;
    };
    for (const [texture, pixel, uastc] of [
      [material.pbrMetallicRoughness.baseColorTexture.index, colour, false],
      [material.normalTexture.index, normal, true],
    ] as const) {
      const file = new basis.KTX2File(fileOf(texture));
      expect(file.isValid()).toBeTruthy();
      expect([file.getWidth(), file.getHeight(), file.getLevels()]).toEqual([64, 64, 7]);
      // Normal maps keep the finer UASTC; colour is the smaller ETC1S.
      expect(Boolean(file.isUASTC())).toBe(uastc);
      expect(file.startTranscoding()).toBeTruthy();
      const out = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
      expect(file.transcodeImage(out, 0, 0, 0, RGBA32, 0, -1, -1)).toBeTruthy();
      file.close();
      file.delete();
      let error = 0;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++)
          for (let c = 0; c < 3; c++)
            error += Math.abs((out[(y * 64 + x) * 4 + c] ?? 0) - (pixel(x, y)[c] ?? 0));
      expect(error / (64 * 64 * 3)).toBeLessThan(6);
    }
    // Starting the encoders (WebAssembly in worker threads) takes seconds on a busy machine.
  }, 30_000);
});

/** A loaded room as GLTFLoader gives it: one mesh, its colour map read from `file`. */
function loadedRoom(
  file: string,
  extension: 'KHR_texture_basisu' | 'EXT_texture_webp',
  map: Texture,
) {
  const scene = new Group();
  scene.add(new Mesh(new PlaneGeometry(), new MeshStandardMaterial({ map })));
  const json = {
    textures: [{ extensions: { [extension]: { source: 0 } } }],
    images: [{ uri: file }],
  };
  return {
    scene,
    parser: { json, associations: new Map([[map, { textures: 0 }]]) },
  } as unknown as GLTF;
}

describe('rooms sharing a texture file', () => {
  it('hold one copy of a KTX2 texture, its compressed pixels included', () => {
    const shared = new SharedTextures();
    const mipmaps = () => [{ data: new Uint8Array(16), width: 4, height: 4 }];
    const a = new CompressedTexture(mipmaps(), 4, 4, RGBA_ASTC_4x4_Format);
    const b = new CompressedTexture(mipmaps(), 4, 4, RGBA_ASTC_4x4_Format);
    shared.adopt(loadedRoom('plaster.ktx2', 'KHR_texture_basisu', a), 'http://x/chunks/a.gltf');
    const used = shared.adopt(
      loadedRoom('plaster.ktx2', 'KHR_texture_basisu', b),
      'http://x/chunks/b.gltf',
    );
    expect(used).toEqual(['http://x/chunks/plaster.ktx2']);
    expect(b.source).toBe(a.source);
    expect(b.mipmaps).toBe(a.mipmaps);
  });

  it('still share WebP textures, in places built before KTX2', () => {
    const shared = new SharedTextures();
    const a = new Texture({ width: 4, height: 4 });
    const b = new Texture({ width: 4, height: 4 });
    shared.adopt(loadedRoom('plaster.webp', 'EXT_texture_webp', a), 'http://x/chunks/a.gltf');
    const used = shared.adopt(
      loadedRoom('plaster.webp', 'EXT_texture_webp', b),
      'http://x/chunks/b.gltf',
    );
    expect(used).toEqual(['http://x/chunks/plaster.webp']);
    expect(b.source).toBe(a.source);
  });
});
