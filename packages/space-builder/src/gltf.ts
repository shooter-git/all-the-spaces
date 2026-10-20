import { createHash } from 'node:crypto';
import type { AssetCredit, PolyHaven, TextureSet } from '@ats/assets';
import type { MaterialName } from '@ats/space-format';
import {
  type Accessor,
  Document,
  Logger,
  type Material,
  type Mesh,
  type Node,
  NodeIO,
  type Primitive,
  Root,
  type Texture,
} from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import {
  dedup,
  dequantizePrimitive,
  getBounds,
  joinPrimitives,
  mergeDocuments,
  prune,
  quantize,
  reorder,
  simplifyPrimitive,
  transformPrimitive,
  unpartition,
  weldPrimitive,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { FLOORS, SURFACES, type TextureChoice } from './catalog.ts';
import type { MeshBuilder, SurfaceKey, V3 } from './geometry.ts';
import { hexToLinear, MATERIALS } from './materials.ts';
import { MODEL_LIMITS } from './models.ts';

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

  // As meshopt({ level: 'medium' }), but positions on a grid four times finer: a joined model
  // shares one grid the size of the whole model, and on the coarser one parts set apart by
  // `separateFlush` (half a millimetre) could land on the same plane again.
  await doc.transform(
    unpartition(),
    dedup(),
    // Keep attributes no material uses yet: the lightmap UVs (TEXCOORD_1) are used by the viewer.
    prune({ keepAttributes: true }),
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ quantizePosition: POSITION_BITS }),
  );
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
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
    // One draw per material instead of one per part (a door model can be hundreds of parts).
    const model = joinModel(doc, inner, `${placed.name}:model`, placed.scale) ?? inner;
    const prims = () => {
      const out: Primitive[] = [];
      model.traverse((n) => {
        out.push(...(n.getMesh()?.listPrimitives() ?? []));
      });
      return out;
    };
    // Library models skip checkModels: hold each to the same triangle budget a made one has.
    const triangles = prims().reduce((t, p) => t + triangleCount(p), 0);
    const ratio = Math.min(1, MODEL_LIMITS.triangles / triangles) * detail.modelTriangles;
    if (ratio < 1) {
      for (const prim of prims()) {
        weldPrimitive(prim);
        simplifyPrimitive(prim, {
          simplifier: MeshoptSimplifier,
          ratio,
          // Bringing a model down to the budget may take more than the small error lod1 allows.
          error: triangles > MODEL_LIMITS.triangles ? 0.05 : 0.004,
        });
      }
    }
    const half = placed.angle / 2;
    holder
      .setTranslation(placed.position)
      .setRotation([0, Math.sin(half), 0, Math.cos(half)])
      .setScale([placed.scale, placed.scale, placed.scale])
      .addChild(model);
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

  // Things placed flush against each other or the room (a frame on its wall, a door frame
  // against the one beside it, a rug's edge at the skirting) set half a millimetre apart.
  // A big room takes a moment: the server answers others in between.
  await separateAllFlush(
    () => roomParts(scene),
    1,
    () => new Promise((resolve) => setImmediate(resolve)),
  );

  return { doc, credits, surfaceTextures };
}

const triangleCount = (prim: Primitive) =>
  prim.getMode() === 4
    ? (prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0) / 3
    : 0;

/**
 * A model's parts as one mesh with one primitive per material (and vertex layout), in the space
 * of `root`, on a new node named `name`. Returns null, leaving the model as it is, when a part
 * is animated, skinned, morphed or carries an extension that joining would lose. `scale` is how
 * many metres one of the model's units becomes in the room.
 */
function joinModel(doc: Document, root: Node, name: string, scale: number): Node | null {
  const parts: { node: Node; mesh: Mesh }[] = [];
  let joinable = doc.getRoot().listAnimations().length === 0;
  root.traverse((node) => {
    if (node.getSkin() || node.getCamera() || node.listExtensions().length) joinable = false;
    const mesh = node.getMesh();
    if (!mesh) return;
    if (mesh.listExtensions().length) joinable = false;
    for (const prim of mesh.listPrimitives())
      if (prim.listTargets().length || prim.listExtensions().length) joinable = false;
    parts.push({ node, mesh });
  });
  if (!joinable || !parts.length) return null;

  // Each part in the root's space, on its own copy (a mesh can be used by several parts).
  const copies: Primitive[] = [];
  for (const { node, mesh } of parts) {
    const matrix = node.getWorldMatrix();
    for (const src of mesh.listPrimitives()) {
      if (!src.getAttribute('POSITION')) continue;
      const prim = src.clone();
      for (const semantic of prim.listSemantics())
        prim.setAttribute(semantic, (prim.getAttribute(semantic) as Accessor).clone());
      const indices = prim.getIndices();
      if (indices) prim.setIndices(indices.clone());
      dequantizePrimitive(prim);
      transformPrimitive(prim, matrix);
      copies.push(prim);
    }
  }
  // Joined, the model is stored on one grid as big as the whole model.
  const grid = gridOf(copies);
  const pieces = () => copies.map((prim) => ({ prim, grid }));
  const moved = separateFlush(pieces(), scale);
  // Once more (see separateAllFlush).
  if (moved.size) separateFlush(pieces(), scale, moved);

  const groups = new Map<string, Primitive[]>();
  for (const prim of copies) {
    const layout = prim
      .listSemantics()
      .sort()
      .map((s) => {
        const a = prim.getAttribute(s) as Accessor;
        return `${s}:${a.getElementSize()}:${a.getComponentType()}:${a.getNormalized()}`;
      });
    const key = [
      doc
        .getRoot()
        .listMaterials()
        .indexOf(prim.getMaterial() as Material),
      prim.getMode(),
      !!prim.getIndices(),
      ...layout,
    ].join('|');
    const group = groups.get(key);
    if (group) group.push(prim);
    else groups.set(key, [prim]);
  }
  const joined = doc.createMesh(name);
  for (const group of groups.values()) {
    if (group.length === 1) {
      joined.addPrimitive(group[0] as Primitive);
      continue;
    }
    joined.addPrimitive(joinPrimitives(group, { skipValidation: true }));
    for (const prim of group) disposePrimitive(prim);
  }

  // The old parts go: nothing else in the room uses them (each placement merges its own copy).
  const meshes = new Set(parts.map((p) => p.mesh));
  const nodes: Node[] = [];
  root.traverse((n) => {
    nodes.push(n);
  });
  for (const n of nodes) n.dispose();
  for (const mesh of meshes) {
    if (mesh.listParents().some((p) => !(p instanceof Root))) continue;
    for (const prim of mesh.listPrimitives()) disposePrimitive(prim);
    mesh.dispose();
  }
  return doc.createNode(name).setMesh(joined);
}

/** Faces of two parts closer than this (metres in the room) lie on one another. */
const FLUSH_M = 0.0003;
/** How far apart such faces end up (metres): too little to see, enough for the depth buffer. */
const APART_M = 0.0005;

/** Something that may lie on something else: one primitive, and where it is. */
export interface FlushPart {
  prim: Primitive;
  /**
   * Part of the room itself (walls, floors, trim). Something else lying on it moves out, so a
   * picture or a frame shows on its wall; two such surfaces settle it as two parts would.
   */
  room?: boolean;
  /** Places the part's positions in the space compared (column-major); none: they already are. */
  matrix?: ArrayLike<number>;
  /**
   * The object it's part of, in a room: parts of one object were set apart when it was put
   * together (see joinModel), so they're only compared with other things now.
   */
  owner?: object;
  /**
   * The step between the positions its mesh will be stored at (compared units). Faces further
   * apart than half a millimetre could still land on one step, so they're kept three apart.
   */
  grid?: number;
}

/** A face that moved: its plane (along `n`, before), and how far along `n` it went. */
export interface FlushMove {
  n: V3;
  d: number;
  by: number;
}

/** One part's faces in one plane: how far along the normal, how much area, where in the plane. */
interface FlushFace {
  part: number;
  d: number;
  area: number;
  /** Shaded flat: every corner's normal is the plane's (not smoothed into the faces around it). */
  flat: boolean;
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}

/** Faces facing one way (within about half a degree), with two directions along their plane. */
interface FlushDirection {
  n: V3;
  u: V3;
  v: V3;
  faces: Map<number, FlushFace>;
}

/**
 * Parts whose faces lie on one another (a desk's frame flush with its top, a label on its
 * plate, splashes of paint on a poster, a door frame against the wall, a rug's edge at the
 * skirting) flicker as you look around, neither in front of the other. Lays them in layers half
 * a millimetre apart, moving each face that has to move (every point of the part in that plane,
 * so nothing opens up): the room's own surfaces stay and whatever lies on them comes out; among
 * the rest the larger stays and the smaller goes the way it already was, or on top when they're
 * exactly flush (as a label sits on its plate). Parts of one plain material are left alone
 * (they look the same whichever is in front), but not when one is shaded flat and the other
 * smooth (a pot's top under its flat rim): that flickers just the same. Returns the parts that moved.
 * `scale` is how many metres one unit of the compared space is.
 */
export function separateFlush(
  parts: FlushPart[],
  scale: number,
  /** What moved last time (by part): nothing goes back the way it came. */
  before?: Map<number, FlushMove[]>,
): Map<number, FlushMove[]> {
  const flush = FLUSH_M / scale;
  const apart = APART_M / scale;
  const touch = 0.000001 / scale;
  // Directions found so far, by a coarse key; faces join the one they're within half a degree of.
  const directions = new Map<number, FlushDirection[]>();
  const direction = (x: number, y: number, z: number): FlushDirection => {
    const key =
      ((Math.round(x * 20) + 20) * 41 + Math.round(y * 20) + 20) * 41 + Math.round(z * 20) + 20;
    let near = directions.get(key);
    if (!near) {
      near = [];
      directions.set(key, near);
    }
    for (const d of near) if (d.n[0] * x + d.n[1] * y + d.n[2] * z > 0.99996) return d;
    const n: V3 = [x, y, z];
    const away: V3 = Math.abs(x) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = normalize(cross(n, away));
    const dir = { n, u, v: cross(n, u), faces: new Map<number, FlushFace>() };
    near.push(dir);
    return dir;
  };
  parts.forEach(({ prim, matrix }, part) => {
    const at = flushPositions(prim, matrix);
    if (!at) return;
    const normals = flushNormals(prim, matrix);
    const idx = prim.getIndices()?.getArray();
    const count = idx ? idx.length : at.length / 3;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = 3 * (idx ? (idx[i] ?? 0) : i);
      const ib = 3 * (idx ? (idx[i + 1] ?? 0) : i + 1);
      const ic = 3 * (idx ? (idx[i + 2] ?? 0) : i + 2);
      const ax = at[ia] ?? 0;
      const ay = at[ia + 1] ?? 0;
      const az = at[ia + 2] ?? 0;
      const ux = (at[ib] ?? 0) - ax;
      const uy = (at[ib + 1] ?? 0) - ay;
      const uz = (at[ib + 2] ?? 0) - az;
      const vx = (at[ic] ?? 0) - ax;
      const vy = (at[ic + 1] ?? 0) - ay;
      const vz = (at[ic + 2] ?? 0) - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-12) continue;
      const dir = direction(nx / len, ny / len, nz / len);
      const d = dir.n[0] * ax + dir.n[1] * ay + dir.n[2] * az;
      const id = part * 1e9 + Math.round(d / touch);
      let face = dir.faces.get(id);
      if (!face) {
        face = {
          part,
          d,
          area: 0,
          flat: true,
          minU: Infinity,
          minV: Infinity,
          maxU: -Infinity,
          maxV: -Infinity,
        };
        dir.faces.set(id, face);
      }
      face.area += len / 2;
      if (normals && face.flat)
        for (const k of [ia, ib, ic])
          if (
            (normals[k] ?? 0) * dir.n[0] +
              (normals[k + 1] ?? 0) * dir.n[1] +
              (normals[k + 2] ?? 0) * dir.n[2] <
            0.999
          )
            face.flat = false;
      for (const k of [ia, ib, ic]) {
        const x = at[k] ?? 0;
        const y = at[k + 1] ?? 0;
        const z = at[k + 2] ?? 0;
        const pu = dir.u[0] * x + dir.u[1] * y + dir.u[2] * z;
        const pv = dir.v[0] * x + dir.v[1] * y + dir.v[2] * z;
        if (pu < face.minU) face.minU = pu;
        if (pu > face.maxU) face.maxU = pu;
        if (pv < face.minV) face.minV = pv;
        if (pv > face.maxV) face.maxV = pv;
      }
    }
  });

  // Faces in one plane (each within `flush` of the next) are laid in layers: the room's own
  // surfaces first, then the larger before the smaller, each on top of what it overlaps where
  // that was laid (or under it, if it was already a little under), half a millimetre apart.
  const moves = new Map<string, FlushMove & { part: number }>();
  const overlap = (p: FlushFace, q: FlushFace) =>
    Math.min(p.maxU, q.maxU) - Math.max(p.minU, q.minU) > apart &&
    Math.min(p.maxV, q.maxV) - Math.max(p.minV, q.minV) > apart;
  const grid = (f: FlushFace) => parts[f.part]?.grid ?? 0;
  /** How close two faces may be before they're flush, and how far apart they're set. */
  const within = (p: FlushFace, q: FlushFace) => Math.max(flush, 2 * grid(p), 2 * grid(q));
  const away = (p: FlushFace, q: FlushFace) => Math.max(apart, 3 * grid(p), 3 * grid(q));
  const room = (f: FlushFace) => Boolean(parts[f.part]?.room);
  const owner = (f: FlushFace) => parts[f.part]?.owner;
  /**
   * Whether a face lies on one laid already (where it was laid), close enough to flicker. In a
   * room, one object's own parts were laid when it was put together (see joinModel).
   */
  /**
   * Two faces of one plain material look the same whichever is in front, unless one is shaded
   * flat and the other smooth, over enough of it to see (a square centimetre).
   */
  const visible = 0.0001 / (scale * scale);
  const alike = (p: FlushFace, q: FlushFace) => {
    const material = parts[p.part]?.prim.getMaterial();
    return (
      (p.flat === q.flat || Math.min(p.area, q.area) < visible) &&
      material === parts[q.part]?.prim.getMaterial() &&
      !material?.getBaseColorTexture() &&
      !material?.getNormalTexture() &&
      !material?.getEmissiveTexture()
    );
  };
  const fights = (face: FlushFace, l: { face: FlushFace; d: number }) =>
    face.part !== l.face.part &&
    !alike(face, l.face) &&
    (!owner(face) || owner(face) !== owner(l.face) || (room(face) && room(l.face))) &&
    Math.abs(face.d - l.d) < within(face, l.face) &&
    overlap(face, l.face);
  /** Whether moving a face `by` along `n` would take it back the way it came last time. */
  const back = (face: FlushFace, n: V3, by: number) =>
    (before?.get(face.part) ?? []).some((m) => {
      const same = dot(m.n, n);
      if (Math.abs(same) < 0.99) return false;
      const now = same > 0 ? m.d + m.by : -(m.d + m.by);
      return Math.abs(face.d - now) < within(face, face) && same * m.by * by < 0;
    });
  for (const near of directions.values()) {
    for (const { n, faces } of near) {
      const list = [...faces.values()].sort((p, q) => p.d - q.d);
      let first = 0;
      for (let i = 1; i <= list.length; i++) {
        const next = list[i];
        const last = list[i - 1] as FlushFace;
        if (next && next.d - last.d < within(next, last)) continue;
        const plane = list.slice(first, i);
        first = i;
        if (plane.length < 2) continue;
        // The room's own surfaces first, then what moved last time (it stays put if it can),
        // then the larger before the smaller.
        const moved = (f: FlushFace) => Boolean(before?.has(f.part));
        plane.sort(
          (p, q) =>
            Number(room(q)) - Number(room(p)) ||
            Number(moved(q)) - Number(moved(p)) ||
            q.area - p.area,
        );
        const laid: { face: FlushFace; d: number }[] = [];
        for (const face of plane) {
          const under = laid.filter((l) => fights(face, l));
          let d = face.d;
          if (under.length) {
            // Something on the room comes out of it; otherwise it goes the way it already was.
            const below =
              !(!room(face) && under.some((l) => room(l.face))) &&
              face.d < Math.min(...under.map((l) => l.d)) - touch;
            d = below
              ? Math.min(face.d, ...under.map((l) => l.d - away(face, l.face)))
              : Math.max(face.d, ...under.map((l) => l.d + away(face, l.face)));
            if (back(face, n, d - face.d)) d = face.d;
          }
          laid.push({ face, d });
          if (Math.abs(d - face.d) > touch)
            moves.set(`${face.part}|${n.join(',')}|${Math.round(face.d / touch)}`, {
              part: face.part,
              n,
              d: face.d,
              by: d - face.d,
            });
        }
      }
    }
  }

  // Every point of a part in a moving face's plane goes with it (the edges of the faces around
  // it too, so the part stays closed).
  const byPart = new Map<number, FlushMove[]>();
  for (const m of moves.values()) byPart.set(m.part, [...(byPart.get(m.part) ?? []), m]);
  const onPlane = flush / 6;
  const v: number[] = [];
  for (const [index, faces] of byPart) {
    const part = parts[index] as FlushPart;
    let pos = part.prim.getAttribute('POSITION');
    if (!pos) continue;
    if (pos.listParents().filter((p) => p !== part.prim && !(p instanceof Root)).length) {
      pos = pos.clone();
      part.prim.setAttribute('POSITION', pos);
    }
    const m = part.matrix;
    const k = (i: number) => m?.[i] ?? 0;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      const [x = 0, y = 0, z = 0] = v;
      const p: V3 = m
        ? [
            k(0) * x + k(4) * y + k(8) * z + k(12),
            k(1) * x + k(5) * y + k(9) * z + k(13),
            k(2) * x + k(6) * y + k(10) * z + k(14),
          ]
        : [x, y, z];
      const shift: V3 = [0, 0, 0];
      let moved = false;
      for (const f of faces) {
        if (Math.abs(dot(f.n, p) - f.d) > onPlane) continue;
        shift[0] += f.n[0] * f.by;
        shift[1] += f.n[1] * f.by;
        shift[2] += f.n[2] * f.by;
        moved = true;
      }
      if (!moved) continue;
      // Into the part's own space (rooms turn and scale what they place, but never shear it).
      const local = m ? unrotate(m, shift) : shift;
      pos.setElement(i, [x + local[0], y + local[1], z + local[2]]);
    }
  }
  return byPart;
}

/** A part's positions where they're compared (x, y, z after each other), or null if it has none. */
function flushPositions(prim: Primitive, matrix?: ArrayLike<number>): Float32Array | null {
  const pos = prim.getAttribute('POSITION');
  if (!pos || prim.getMode() !== 4 || !prim.getMaterial()) return null;
  const out = new Float32Array(pos.getCount() * 3);
  const e: number[] = [];
  const m = (k: number) => matrix?.[k] ?? 0;
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, e);
    const [x = 0, y = 0, z = 0] = e;
    if (!matrix) out.set([x, y, z], i * 3);
    else {
      out[i * 3] = m(0) * x + m(4) * y + m(8) * z + m(12);
      out[i * 3 + 1] = m(1) * x + m(5) * y + m(9) * z + m(13);
      out[i * 3 + 2] = m(2) * x + m(6) * y + m(10) * z + m(14);
    }
  }
  return out;
}

/** A part's normals turned where they're compared (unit length), or null if it has none. */
function flushNormals(prim: Primitive, matrix?: ArrayLike<number>): Float32Array | null {
  const normal = prim.getAttribute('NORMAL');
  if (!normal) return null;
  const out = new Float32Array(normal.getCount() * 3);
  const e: number[] = [];
  const m = (k: number) => matrix?.[k] ?? 0;
  for (let i = 0; i < normal.getCount(); i++) {
    normal.getElement(i, e);
    let [x = 0, y = 0, z = 0] = e;
    if (matrix)
      [x, y, z] = [
        m(0) * x + m(4) * y + m(8) * z,
        m(1) * x + m(5) * y + m(9) * z,
        m(2) * x + m(6) * y + m(10) * z,
      ];
    const l = Math.hypot(x, y, z) || 1;
    out.set([x / l, y / l, z / l], i * 3);
  }
  return out;
}

/**
 * `separateFlush`, and once more for what landed on something that moved the other way (a face
 * of a part moved in one direction can carry its edges onto another): never back the way it
 * came, so nothing goes back and forth. `between` runs between the two (to let other work in).
 */
async function separateAllFlush(
  parts: () => FlushPart[],
  scale: number,
  between: () => Promise<void> = async () => {},
) {
  const moved = separateFlush(parts(), scale);
  if (!moved.size) return;
  await between();
  separateFlush(parts(), scale, moved);
}

/**
 * Every part of a room (its surfaces, furniture and models), for `separateFlush`: each primitive
 * where it is in the room. A mesh several nodes share is left out (moving it would move them all).
 */
export function roomParts(scene: { listChildren(): Node[] }): FlushPart[] {
  const out: FlushPart[] = [];
  for (const top of scene.listChildren()) {
    const room = top.getName() === 'architecture';
    top.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh || mesh.listParents().filter((p) => !(p instanceof Root)).length > 1) return;
      const matrix = node.getWorldMatrix();
      const grid = gridOf(mesh.listPrimitives()) * Math.hypot(matrix[0], matrix[1], matrix[2]);
      for (const prim of mesh.listPrimitives()) out.push({ prim, room, owner: top, matrix, grid });
    });
  }
  return out;
}

/** Bits each position is stored with (see writeChunk). */
const POSITION_BITS = 16;

/** The step between stored positions of a mesh made of these primitives (its own units). */
function gridOf(prims: Primitive[]): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const prim of prims) {
    const pos = prim.getAttribute('POSITION');
    if (!pos?.getCount()) continue;
    const lo = pos.getMin([]);
    const hi = pos.getMax([]);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] as number, lo[k] ?? 0);
      max[k] = Math.max(max[k] as number, hi[k] ?? 0);
    }
  }
  const size = Math.max(0, ...max.map((v, k) => v - (min[k] as number)));
  return Number.isFinite(size) ? size / (2 ** POSITION_BITS - 1) : 0;
}

/** A move in the room as a move in a node's own space: its turn undone, then its scale. */
function unrotate(m: ArrayLike<number>, v: V3): V3 {
  const col = (k: number): V3 => [m[k] ?? 0, m[k + 1] ?? 0, m[k + 2] ?? 0];
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const axis = col(k * 4);
    const s2 = dot(axis, axis) || 1;
    out[k] = dot(axis, v) / s2;
  }
  return out;
}

const dot = (p: ArrayLike<number>, q: ArrayLike<number>) =>
  (p[0] ?? 0) * (q[0] ?? 0) + (p[1] ?? 0) * (q[1] ?? 0) + (p[2] ?? 0) * (q[2] ?? 0);
const cross = (p: V3, q: V3): V3 => [
  p[1] * q[2] - p[2] * q[1],
  p[2] * q[0] - p[0] * q[2],
  p[0] * q[1] - p[1] * q[0],
];
const normalize = (p: V3): V3 => {
  const l = Math.hypot(...p) || 1;
  return [p[0] / l, p[1] / l, p[2] / l];
};

/** A primitive and whichever of its accessors nothing else uses. */
function disposePrimitive(prim: Primitive) {
  const accessors = [...prim.listAttributes(), prim.getIndices()];
  prim.dispose();
  for (const a of accessors) if (a?.listParents().every((p) => p instanceof Root)) a.dispose();
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
