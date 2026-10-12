import { createHash } from 'node:crypto';
import type { AssetCredit, PolyHaven, TextureSet } from '@ats/assets';
import type { MaterialName } from '@ats/space-format';
import {
  Document,
  Logger,
  type Material,
  type Node,
  NodeIO,
  type Texture,
} from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import {
  dedup,
  getBounds,
  mergeDocuments,
  meshopt,
  prune,
  simplifyPrimitive,
  unpartition,
  weldPrimitive,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { FLOORS, SURFACES, type TextureChoice } from './catalog.ts';
import type { MeshBuilder, SurfaceKey, V3 } from './geometry.ts';
import { hexToLinear, MATERIALS } from './materials.ts';

export interface GlbNode {
  name: string;
  mesh: MeshBuilder;
  extras?: Record<string, unknown>;
}

/** Where a model comes from: a free (CC0) library model, or one made for this place. */
export type ModelSource = () => Promise<{ doc: Document; credit?: AssetCredit }>;

/** A Poly Haven model (downloaded once and cached). */
export const polyHavenModel =
  (assets: PolyHaven, id: string): ModelSource =>
  async () => {
    const files = await assets.model(id);
    return { doc: await io.read(files.gltfPath), credit: files.credit };
  };

/** A model placed in the room. */
export interface PlacedModel {
  name: string;
  source: ModelSource;
  /** Rotation around +Y in radians, applied after the model's own front-facing correction. */
  angle: number;
  /** Where the centre of the model's footprint (at its base) goes. */
  position: V3;
  scale: number;
  extras?: Record<string, unknown>;
}

/** How much detail a room chunk carries. */
export interface Detail {
  /** Largest texture size (pixels) for walls, floors and other surfaces. */
  surfaceTexture: number;
  /** Largest texture size for furniture models (a 2 m sofa at 512 px is 4 mm per pixel). */
  modelTexture: number;
  /** Keep roughly this share of each furniture model's triangles (1 = all). */
  modelTriangles: number;
}

/** The room you're in. */
export const FULL_DETAIL: Detail = { surfaceTexture: 1024, modelTexture: 512, modelTriangles: 1 };
/** Rooms next to you (and every room on low-power devices). */
export const MEDIUM_DETAIL: Detail = {
  surfaceTexture: 512,
  modelTexture: 256,
  modelTriangles: 0.35,
};

/** Output of one room chunk: a small .gltf plus the content-addressed files it points to. */
export interface ChunkFiles {
  gltf: Uint8Array;
  resources: Map<string, Uint8Array>;
  /** Ids of the credited assets this chunk uses. */
  credits: string[];
}

export const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * JPEG/PNG → WebP (typically 3–5× smaller). Normal maps keep more quality because compression
 * artefacts in them show up as bumpy lighting. Cached so shared textures convert once per build.
 */
const webpCache = new Map<string, Promise<Uint8Array>>();
function toWebp(
  bytes: Uint8Array,
  kind: 'color' | 'normal' | 'data',
  maxSize: number,
): Promise<Uint8Array> {
  const key = `${sha(bytes)}:${kind}:${maxSize}`;
  let p = webpCache.get(key);
  if (!p) {
    const quality = kind === 'normal' ? 90 : kind === 'data' ? 85 : 80;
    p = sharp(bytes)
      .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer()
      .then((b) => new Uint8Array(b));
    webpCache.set(key, p);
  }
  return p;
}

/**
 * Real surfaces from CC0 textures (with a flat-colour fallback when assets are unavailable).
 * Loads each texture set once per build and records its credit.
 */
export class MaterialLibrary {
  readonly credits = new Map<string, AssetCredit>();
  private readonly textures = new Map<string, Promise<TextureSet | null>>();
  private readonly assets: PolyHaven | null;

  constructor(assets: PolyHaven | null) {
    this.assets = assets;
  }

  choice(key: SurfaceKey): TextureChoice | null {
    if (key.startsWith('floor:'))
      return FLOORS[key.slice(6) as MaterialName] ?? SURFACES[key.slice(6) as MaterialName] ?? null;
    return SURFACES[key as MaterialName] ?? null;
  }

  async set(key: SurfaceKey): Promise<TextureSet | null> {
    const choice = this.assets ? this.choice(key) : null;
    if (!choice || !this.assets) return null;
    let p = this.textures.get(choice.texture);
    if (!p) {
      const assets = this.assets;
      p = assets.texture(choice.texture).then(
        (t) => {
          this.credits.set(t.credit.id, t.credit);
          return t;
        },
        (err) => {
          console.warn(
            `Texture ${choice.texture} unavailable, using a flat colour:`,
            (err as Error).message,
          );
          return null;
        },
      );
      this.textures.set(choice.texture, p);
    }
    return p;
  }

  /** Records a model's credit. */
  credit(c: AssetCredit) {
    this.credits.set(c.id, c);
  }
}

/** Builds one room chunk from procedural meshes and placed models. */
export async function writeChunk(
  nodes: GlbNode[],
  models: PlacedModel[],
  library: MaterialLibrary,
  options: { materials?: boolean; detail?: Detail } = {},
): Promise<ChunkFiles> {
  const detail = options.detail ?? FULL_DETAIL;
  const { doc, credits, surfaceTextures } = await composeRoom(nodes, models, library, options);

  // Compress every texture to WebP and content-address it, so every room shares the same files.
  const textureList = doc.getRoot().listTextures();
  if (textureList.length) {
    doc.createExtension(EXTTextureWebP).setRequired(true);
    for (const t of textureList) {
      const image = t.getImage();
      if (!image) continue;
      const slots = doc
        .getGraph()
        .listParentEdges(t)
        .map((e) => e.getName());
      const kind = slots.includes('normalTexture')
        ? 'normal'
        : slots.includes('baseColorTexture')
          ? 'color'
          : 'data';
      const maxSize = surfaceTextures.has(t) ? detail.surfaceTexture : detail.modelTexture;
      const webp = await toWebp(image, kind, maxSize);
      t.setImage(webp)
        .setMimeType('image/webp')
        .setURI(`${sha(webp)}.webp`);
    }
  }

  await doc.transform(
    unpartition(),
    dedup(),
    // Keep attributes no material uses yet: the lightmap UVs (TEXCOORD_1) are used by the viewer.
    prune({ keepAttributes: true }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  for (const b of doc.getRoot().listBuffers()) b.setURI('geometry.bin');

  const { json, resources } = await io.writeJSON(doc);
  const out = new Map<string, Uint8Array>();
  for (const [uri, bytes] of Object.entries(resources)) {
    const name = uri === 'geometry.bin' ? `${sha(bytes)}.bin` : uri;
    out.set(name, bytes);
    for (const b of json.buffers ?? []) if (b.uri === uri) b.uri = name;
  }
  return {
    gltf: new TextEncoder().encode(JSON.stringify(json)),
    resources: out,
    credits: [...credits].sort(),
  };
}

/**
 * One room as a single plain .glb (textures as they are, no compression), for rendering it in
 * Blender to compare with photos of the real room.
 */
export async function writePreview(
  nodes: GlbNode[],
  models: PlacedModel[],
  library: MaterialLibrary,
): Promise<Uint8Array> {
  const { doc } = await composeRoom(nodes, models, library, {});
  for (const t of doc.getRoot().listTextures()) t.setURI('');
  await doc.transform(unpartition(), dedup());
  return io.writeBinary(doc);
}

/** A room's surfaces and models in one glTF document. */
async function composeRoom(
  nodes: GlbNode[],
  models: PlacedModel[],
  library: MaterialLibrary,
  options: { materials?: boolean; detail?: Detail },
) {
  const withMaterials = options.materials ?? true;
  const detail = options.detail ?? FULL_DETAIL;
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const doc = new Document().setLogger(new Logger(Logger.Verbosity.ERROR));
  const buffer = doc.createBuffer();
  const scene = doc.createScene('room');
  const materials = new Map<SurfaceKey, Material>();
  const textures = new Map<string, Texture>();
  const credits = new Set<string>();

  const texture = (bytes: Uint8Array, name: string) => {
    const hash = sha(bytes);
    let t = textures.get(hash);
    if (!t) {
      t = doc.createTexture(name).setImage(bytes).setMimeType('image/jpeg').setURI(`${hash}.jpg`);
      textures.set(hash, t);
    }
    return t;
  };

  const material = async (key: SurfaceKey) => {
    let m = materials.get(key);
    if (m) return m;
    const base = key.startsWith('floor:') ? key.slice(6) : key;
    const def = MATERIALS[base as MaterialName];
    const set = await library.set(key);
    const choice = library.choice(key);
    if (set) credits.add(set.credit.id);
    m = doc.createMaterial(key);
    if (set && choice?.ownColor) {
      // Our colour; relief and roughness from the photographed surface.
      m.setBaseColorFactor([...hexToLinear(def.color), 1])
        .setNormalTexture(texture(set.normal, `${set.credit.id}-normal`))
        .setMetallicRoughnessTexture(texture(set.arm, `${set.credit.id}-arm`))
        .setRoughnessFactor(1)
        .setMetallicFactor(0);
    } else if (set) {
      const tint = choice?.tint ? hexToLinear(choice.tint) : [1, 1, 1];
      m.setBaseColorFactor([tint[0] ?? 1, tint[1] ?? 1, tint[2] ?? 1, 1])
        .setBaseColorTexture(texture(set.diffuse, `${set.credit.id}-diffuse`))
        .setNormalTexture(texture(set.normal, `${set.credit.id}-normal`))
        .setMetallicRoughnessTexture(texture(set.arm, `${set.credit.id}-arm`))
        .setOcclusionTexture(texture(set.arm, `${set.credit.id}-arm`))
        .setRoughnessFactor(1)
        .setMetallicFactor(1);
    } else {
      m.setBaseColorFactor([...hexToLinear(def.color), def.opacity ?? 1])
        .setRoughnessFactor(def.roughness)
        .setMetallicFactor(def.metalness ?? 0);
    }
    if (def.opacity !== undefined) m.setAlphaMode('BLEND');
    materials.set(key, m);
    return m;
  };

  for (const n of nodes) {
    if (n.mesh.groups.size === 0) continue;
    const mesh = doc.createMesh(n.name);
    for (const [key, g] of n.mesh.groups) {
      const vertexCount = g.positions.length / 3;
      const prim = doc
        .createPrimitive()
        .setAttribute(
          'POSITION',
          doc
            .createAccessor()
            .setType('VEC3')
            .setArray(new Float32Array(g.positions))
            .setBuffer(buffer),
        )
        .setIndices(
          doc
            .createAccessor()
            .setType('SCALAR')
            .setArray(vertexCount > 65535 ? new Uint32Array(g.indices) : new Uint16Array(g.indices))
            .setBuffer(buffer),
        );
      if (withMaterials) {
        // UVs are in metres; scale them so each texture tile covers its real-world size.
        const set = await library.set(key);
        const [sw, sh] = set?.size ?? [1, 1];
        const uvs = new Float32Array(g.uvs.length);
        for (let i = 0; i < uvs.length; i += 2) {
          uvs[i] = (g.uvs[i] ?? 0) / sw;
          uvs[i + 1] = (g.uvs[i + 1] ?? 0) / sh;
        }
        prim
          .setAttribute(
            'NORMAL',
            doc
              .createAccessor()
              .setType('VEC3')
              .setArray(new Float32Array(g.normals))
              .setBuffer(buffer),
          )
          .setAttribute(
            'TEXCOORD_0',
            doc.createAccessor().setType('VEC2').setArray(uvs).setBuffer(buffer),
          )
          .setMaterial(await material(key));
        if (g.uv2) {
          prim.setAttribute(
            'TEXCOORD_1',
            doc.createAccessor().setType('VEC2').setArray(g.uv2).setBuffer(buffer),
          );
        }
      }
      mesh.addPrimitive(prim);
    }
    const node = doc.createNode(n.name).setMesh(mesh);
    if (n.extras) node.setExtras(n.extras);
    scene.addChild(node);
  }

  // Textures so far are surfaces (walls, floors…); anything added below belongs to a model.
  const surfaceTextures = new Set(doc.getRoot().listTextures());
  const surfaceMaterials = new Set(doc.getRoot().listMaterials());
  for (const placed of models) {
    const { doc: source, credit } = await placed.source();
    if (credit) {
      library.credit(credit);
      credits.add(credit.id);
    }
    const sourceScene = source.getRoot().listScenes()[0];
    if (!sourceScene) continue;
    const bounds = getBounds(sourceScene);
    mergeDocuments(doc, source);
    const merged = doc.getRoot().listScenes().at(-1) as ReturnType<typeof doc.createScene>;
    const holder = doc.createNode(placed.name);
    if (placed.extras) holder.setExtras(placed.extras);
    // Centre the footprint on the origin and stand the model on the floor, then place it.
    const inner = doc
      .createNode(`${placed.name}:model`)
      .setTranslation([
        -(bounds.min[0] + bounds.max[0]) / 2,
        -bounds.min[1],
        -(bounds.min[2] + bounds.max[2]) / 2,
      ]);
    for (const child of merged.listChildren()) inner.addChild(child as Node);
    merged.dispose();
    if (detail.modelTriangles < 1) {
      inner.traverse((n) => {
        for (const prim of n.getMesh()?.listPrimitives() ?? []) {
          weldPrimitive(prim);
          simplifyPrimitive(prim, {
            simplifier: MeshoptSimplifier,
            ratio: detail.modelTriangles,
            error: 0.004,
          });
        }
      });
    }
    const half = placed.angle / 2;
    holder
      .setTranslation(placed.position)
      .setRotation([0, Math.sin(half), 0, Math.cos(half)])
      .setScale([placed.scale, placed.scale, placed.scale])
      .addChild(inner);
    scene.addChild(holder);
  }

  // Model glass often ships as an opaque, fully metallic sheet (renders black): make it clear.
  // Our own glass (windows) already is, as MATERIALS says.
  for (const m of doc.getRoot().listMaterials()) {
    if (surfaceMaterials.has(m)) continue;
    if (m.getAlphaMode() === 'BLEND' && /glass/i.test(m.getName())) {
      const [r = 1, g = 1, b = 1] = m.getBaseColorFactor();
      m.setBaseColorFactor([r, g, b, 0.12]).setMetallicFactor(0).setRoughnessFactor(0.05);
    }
  }

  return { doc, credits, surfaceTextures };
}

/**
 * A placed model's triangles in space coordinates, for casting shadows in the lighting bake.
 * See-through parts (glass) are left out.
 */
export async function modelTriangles(
  placed: PlacedModel,
): Promise<{ positions: number[]; indices: number[] }> {
  const { doc: source } = await placed.source();
  const scene = source.getRoot().listScenes()[0];
  const positions: number[] = [];
  const indices: number[] = [];
  if (!scene) return { positions, indices };
  const bounds = getBounds(scene);
  const [cx, cz] = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  const cos = Math.cos(placed.angle);
  const sin = Math.sin(placed.angle);
  const [px, py, pz] = placed.position;
  const s = placed.scale;
  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos || prim.getMode() !== 4 || prim.getMaterial()?.getAlphaMode() === 'BLEND') continue;
      const base = positions.length / 3;
      const v: number[] = [];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const [x = 0, y = 0, z = 0] = v;
        // Model space → centred on its footprint, standing on the floor → scaled, turned, placed.
        const wx = (m[0] * x + m[4] * y + m[8] * z + m[12] - cx) * s;
        const wy = (m[1] * x + m[5] * y + m[9] * z + m[13] - bounds.min[1]) * s;
        const wz = (m[2] * x + m[6] * y + m[10] * z + m[14] - cz) * s;
        positions.push(px + wx * cos + wz * sin, py + wy, pz - wx * sin + wz * cos);
      }
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      for (let i = 0; i < count; i++) indices.push(base + (idx ? idx.getScalar(i) : i));
    }
  });
  return { positions, indices };
}

/** Real-world size (metres) of a model before scaling. */
export async function modelSize(source: ModelSource): Promise<V3> {
  const { doc } = await source();
  const s = doc.getRoot().listScenes()[0];
  if (!s) throw new Error('The model has nothing in it.');
  const b = getBounds(s);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

/** A model made for this place (already checked and cleaned: see models.ts). */
export const workspaceModel =
  (glb: Uint8Array): ModelSource =>
  async () => ({ doc: await io.readBinary(glb) });
