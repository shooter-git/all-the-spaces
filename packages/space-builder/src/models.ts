import type { SpacePlan } from '@ats/space-format';
import { type Document, Logger, NodeIO, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, getBounds, prune } from '@gltf-transform/functions';
import sharp from 'sharp';
import type { V3 } from './geometry.ts';

/**
 * Models an assistant makes (in Blender, or any way it likes) are untrusted files. Before one is
 * used it's read as plain data and written out again: only meshes, materials and textures are
 * kept (no animation, cameras, lights, rigs or extra data), every texture is decoded and
 * re-encoded, and it has to fit the limits below so a room still loads quickly on a phone.
 */
export const MODEL_LIMITS = {
  /** Per model: plenty for a detailed figure or a sofa (a phone draws a few hundred thousand). */
  triangles: 60_000,
  /** Per room, all its models together. */
  roomTriangles: 400_000,
  materials: 16,
  /** Largest texture side kept (rooms use 512 px up close, 256 px further away). */
  textureSize: 2048,
  bytes: 24 * 1024 * 1024,
  /** Metres: the biggest side, at most and at least. */
  largest: 20,
  smallest: 0.005,
};

export class ModelError extends Error {}

export interface CleanModel {
  /** The cleaned model, as a .glb. */
  glb: Uint8Array;
  triangles: number;
  materials: number;
  textures: number;
  /** Width, height and depth in metres (x, y, z). */
  size: V3;
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Extensions a model may need to be read: materials and texture placement, nothing that runs. */
const KEEP = (name: string) =>
  name.startsWith('KHR_materials_') ||
  name === 'KHR_texture_transform' ||
  name === 'KHR_mesh_quantization' ||
  name === 'EXT_texture_webp';

/** The JSON part of a .glb, without reading anything it points to. */
function glbJson(bytes: Uint8Array): {
  buffers?: { uri?: string }[];
  images?: { uri?: string }[];
  extensionsRequired?: string[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    throw new ModelError('is not a .glb file (export it as "glTF Binary").');
  if (view.getUint32(4, true) !== 2) throw new ModelError('is not glTF 2.0.');
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.byteLength)
    throw new ModelError('is not a readable .glb file.');
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  } catch {
    throw new ModelError('is not a readable .glb file.');
  }
}

/** Reads, checks and cleans a model. Throws ModelError with a plain reason. */
export async function cleanModel(bytes: Uint8Array): Promise<CleanModel> {
  if (bytes.byteLength > MODEL_LIMITS.bytes)
    throw new ModelError(
      `is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB: keep a model under ${MODEL_LIMITS.bytes / 1024 / 1024} MB.`,
    );
  const json = glbJson(bytes);
  // Everything has to be inside the one file: nothing is fetched from anywhere else.
  if ((json.buffers ?? []).some((b) => b.uri !== undefined))
    throw new ModelError('keeps its data in separate files: export it as a single .glb.');
  if ((json.images ?? []).some((i) => i.uri !== undefined))
    throw new ModelError('links to texture files: export it as a single .glb with them inside.');
  for (const ext of json.extensionsRequired ?? [])
    if (!KEEP(ext))
      throw new ModelError(
        /draco|meshopt/i.test(ext)
          ? `is compressed (${ext}): export it without compression (it's compressed for you).`
          : `needs ${ext}, which isn't supported.`,
      );

  let doc: Document;
  try {
    doc = await io.readBinary(bytes);
  } catch (err) {
    throw new ModelError(`couldn't be read: ${(err as Error).message.slice(0, 200)}`);
  }
  doc.setLogger(new Logger(Logger.Verbosity.SILENT));
  const root = doc.getRoot();

  // Only what's shown.
  for (const ext of root.listExtensionsUsed()) if (!KEEP(ext.extensionName)) ext.dispose();
  for (const a of root.listAnimations()) a.dispose();
  for (const s of root.listSkins()) s.dispose();
  for (const c of root.listCameras()) c.dispose();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  if (!scene) throw new ModelError('has nothing in it.');
  for (const s of root.listScenes()) if (s !== scene) s.dispose();
  root.setDefaultScene(scene);
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const t of prim.listTargets()) t.dispose();
      // Triangles only (points and lines aren't furniture).
      if (prim.getMode() !== 4 || !prim.getAttribute('POSITION')) prim.dispose();
    }
  }
  for (const p of [
    root,
    ...root.listScenes(),
    ...root.listNodes(),
    ...root.listMeshes(),
    ...root.listMaterials(),
    ...root.listTextures(),
    ...root.listAccessors(),
  ])
    p.setExtras({});

  // Every texture decoded and written again (a picture that can't be decoded isn't kept).
  for (const t of root.listTextures()) await cleanTexture(t);

  await doc.transform(prune(), dedup());

  // Count what's drawn (a mesh used twice is drawn twice), and check every position is a number.
  let triangles = 0;
  const v: number[] = [];
  scene.traverse((node) => {
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        if (!v.every(Number.isFinite)) throw new ModelError('has positions that are not numbers.');
      }
      triangles += (prim.getIndices()?.getCount() ?? pos.getCount()) / 3;
    }
  });
  triangles = Math.round(triangles);
  if (!triangles) throw new ModelError('has no surfaces to show.');
  if (triangles > MODEL_LIMITS.triangles)
    throw new ModelError(
      `has ${triangles.toLocaleString('en')} triangles: keep a model under ${MODEL_LIMITS.triangles.toLocaleString('en')} (fewer segments, or decimate it).`,
    );
  const materials = root.listMaterials().length;
  if (materials > MODEL_LIMITS.materials)
    throw new ModelError(
      `has ${materials} materials: keep a model to ${MODEL_LIMITS.materials} or fewer (each is drawn separately).`,
    );
  const bounds = getBounds(scene);
  const size: V3 = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const largest = Math.max(...size);
  if (!Number.isFinite(largest) || largest > MODEL_LIMITS.largest)
    throw new ModelError(
      `is ${largest.toFixed(1)} m across: models are in metres, and at most ${MODEL_LIMITS.largest} m.`,
    );
  if (largest < MODEL_LIMITS.smallest)
    throw new ModelError(
      `is only ${(largest * 1000).toFixed(1)} mm across: models are in metres (a 10 cm figure is 0.1).`,
    );
  return {
    glb: await io.writeBinary(doc),
    triangles,
    materials,
    textures: root.listTextures().length,
    size,
  };
}

async function cleanTexture(t: Texture) {
  const image = t.getImage();
  if (!image) return t.dispose();
  try {
    const max = MODEL_LIMITS.textureSize;
    const png = await sharp(image, { limitInputPixels: 8192 * 8192, failOn: 'error' })
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    t.setImage(new Uint8Array(png)).setMimeType('image/png').setURI('');
  } catch {
    throw new ModelError(`has a texture ("${t.getName() || 'unnamed'}") that can't be read.`);
  }
}

export interface ModelProblem {
  message: string;
  /** The model's path, when it's about one model. */
  model?: string;
}

/**
 * Checks every workspace model a plan uses: that it's there, can be read and fits the limits,
 * and that no room's models add up to too much. `files` holds the models' bytes by path.
 * Returns the cleaned models (by path) and any problems.
 */
export async function checkModels(
  plan: SpacePlan,
  files: Map<string, Uint8Array>,
): Promise<{ models: Map<string, CleanModel>; problems: ModelProblem[] }> {
  const models = new Map<string, CleanModel>();
  const problems: ModelProblem[] = [];
  const used = new Set(
    plan.furniture.flatMap((f) => (f.model?.startsWith('models/') ? [f.model] : [])),
  );
  for (const path of [...used].sort()) {
    const bytes = files.get(path);
    if (!bytes) {
      problems.push({ model: path, message: `${path} isn't in the workspace.` });
      continue;
    }
    try {
      models.set(path, await cleanModel(bytes));
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
      problems.push({ model: path, message: `${path} ${err.message}` });
    }
  }
  for (const room of plan.rooms) {
    let total = 0;
    for (const f of plan.furniture)
      if (f.room === room.key && f.model) total += models.get(f.model)?.triangles ?? 0;
    if (total > MODEL_LIMITS.roomTriangles)
      problems.push({
        message: `${room.name}: its models add up to ${total.toLocaleString('en')} triangles; keep a room under ${MODEL_LIMITS.roomTriangles.toLocaleString('en')} (simpler models, or fewer).`,
      });
  }
  return { models, problems };
}

/** The workspace models a plan uses (paths), for reading them from the workspace. */
export function modelPaths(plan: SpacePlan): string[] {
  return [
    ...new Set(plan.furniture.flatMap((f) => (f.model?.startsWith('models/') ? [f.model] : []))),
  ].sort();
}
