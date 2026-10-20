import { createHash } from 'node:crypto';
import type { PolyHaven } from '@ats/assets';
import {
  type ChunkRef,
  FORMAT_VERSION,
  type PlanFurniture,
  type PlanRoom,
  type Room,
  type SpaceManifest,
  SpacePlan,
  slopeAt,
  validateManifest,
} from '@ats/space-format';
import {
  buildArchitecture,
  buildStairs,
  buildStandIn,
  buildStructure,
  PlanIndex,
} from './architecture.ts';
import { BakeError, type BakeRunner, type BakeSettings, bakeRoom, ceilingLights } from './bake.ts';
import { DEFAULT_HDRI, modelFor } from './catalog.ts';
import { buildFurniture, furnitureSize, furnitureTransform, isObstacle } from './furniture.ts';
import { MeshBuilder, type V3 } from './geometry.ts';
import {
  type ChunkFiles,
  FULL_DETAIL,
  type GlbNode,
  MaterialLibrary,
  MEDIUM_DETAIL,
  type ModelSource,
  modelSize,
  modelTriangles,
  type PlacedModel,
  polyHavenModel,
  workspaceModel,
  writeChunk,
  writePreview,
} from './gltf.ts';
import type { CleanModel } from './models.ts';
import { roomSounds } from './sounds.ts';

export interface BuiltSpace {
  manifest: SpaceManifest;
  /** Content-addressed files, keyed by the path used in the manifest. */
  files: Map<string, Uint8Array>;
  stats: {
    rooms: number;
    triangles: { lod0: number; lod2: number };
    bytes: number;
    models: number;
    bakeSeconds: number;
    lighting: LightingStats;
  };
}

/** How the indoor rooms' lighting came out (outdoor rooms use the real-time sun and sky). */
export interface LightingStats {
  /** Indoor rooms. */
  rooms: number;
  /** Indoor rooms with baked lighting: baked in this build, or reused from an earlier one. */
  baked: number;
  /** Of those, kept from an earlier build because nothing that goes into them changed. */
  reused: number;
  /** Why the first room that couldn't be baked wasn't (null when none failed, or none tried). */
  failure: { error: string; timedOut: boolean } | null;
}

export interface BuildOptions {
  /**
   * CC0 textures, photoscanned furniture and an HDR sky. Without it the space is built from
   * plain colours and simple shapes (used in tests and when offline).
   */
  assets?: PolyHaven | null;
  /**
   * Bake each room's lighting with Blender (CPU), here or wherever `run` sends it. Without it
   * rooms use real-time lighting only.
   */
  bake?: Omit<BakeSettings, 'hdriPath'> | null;
  /**
   * Models made for this place (`models/<name>.glb`), already checked and cleaned (checkModels).
   * A piece whose model is missing here keeps its simple shape.
   */
  models?: Map<string, CleanModel>;
}

/** What every room is put together with: the plan's architecture, furniture and models. */
function roomBuilder(plan: SpacePlan, options: BuildOptions) {
  const assets = options.assets ?? null;
  const index = new PlanIndex(plan);
  const library = new MaterialLibrary(assets);
  const stats = {
    rooms: plan.rooms.length,
    triangles: { lod0: 0, lod2: 0 },
    bytes: 0,
    models: 0,
    bakeSeconds: 0,
    lighting: {
      rooms: plan.rooms.filter((r) => !r.outdoor).length,
      baked: 0,
      reused: 0,
      failure: null,
    } as LightingStats,
  };
  const sizes = new Map<string, Promise<V3 | null>>();
  /** A model by its reference (`polyhaven:<id>`, `models/<name>.glb`, or a catalogue id). */
  const sources = new Map<string, ModelSource | null>();
  const sourceOf = (ref: string): ModelSource | null => {
    if (!sources.has(ref)) {
      const local = ref.startsWith('models/') ? options.models?.get(ref) : null;
      sources.set(
        ref,
        local
          ? workspaceModel(local.glb)
          : ref.startsWith('models/') || !assets
            ? null
            : polyHavenModel(assets, ref.replace(/^polyhaven:/, '')),
      );
    }
    return sources.get(ref) ?? null;
  };
  const sizeOf = (ref: string) => {
    let p = sizes.get(ref);
    if (!p) {
      const source = sourceOf(ref);
      p = source
        ? modelSize(source).catch((err) => {
            console.warn(`Model ${ref} unavailable, using a simple shape:`, (err as Error).message);
            return null;
          })
        : Promise.resolve(null);
      sizes.set(ref, p);
    }
    return p;
  };

  /** One room's surfaces, furniture and models (and what casts shadows in its bake). */
  const assemble = async (room: PlanRoom) => {
    const { base } = index.vertical(room);
    const arch = new MeshBuilder();
    const collision = new MeshBuilder();
    const objects: Room['objects'] = [];
    const placed: { item: PlanFurniture; position: V3 }[] = [];
    buildArchitecture(index, room, arch, collision, { glazing: true, trim: true });
    for (const s of plan.stairs.filter((st) => st.room === room.key))
      buildStairs(index, s, arch, collision, 'oak');
    for (const s of plan.structure ?? [])
      if (s.room === room.key) buildStructure(index, room, s, arch, collision);
    const nodes: GlbNode[] = [{ name: 'architecture', mesh: arch }];
    const models: PlacedModel[] = [];
    /** The furniture's shapes, for casting shadows in the lighting bake. */
    const blockers = new MeshBuilder();

    for (const item of plan.furniture.filter((f) => f.room === room.key)) {
      const extras = { objectKey: item.key, label: item.label, kind: item.kind };
      // Where it stands (on a sloping floor, the floor's height there).
      const floor = room.slope ? index.floorAt(room, item.at[0], item.at[1]) : base;
      // A model chosen for this piece: its own size, scaled evenly into `size` if one is given.
      const chosen = item.model ? sourceOf(item.model) : null;
      const own = item.model && chosen ? await sizeOf(item.model) : null;
      if (item.model && chosen && own) {
        const scale = item.size
          ? Math.min(
              item.size[0] / Math.max(own[0], 1e-6),
              item.size[1] / Math.max(own[1], 1e-6),
              item.size[2] / Math.max(own[2], 1e-6),
            )
          : 1;
        const [mw, mh, md] = [own[0] * scale, own[1] * scale, own[2] * scale];
        const y = item.mountHeight !== undefined ? floor + item.mountHeight - mh / 2 : floor;
        const angle = (item.rotation * Math.PI) / 180;
        const origin: V3 = [item.at[0], y, item.at[1]];
        objects.push({ key: item.key, label: item.label, kind: item.kind, position: origin });
        placed.push({ item, position: origin });
        const model: PlacedModel = {
          name: `object:${item.key}`,
          source: chosen,
          angle,
          position: origin,
          scale,
          extras,
        };
        models.push(model);
        stats.models++;
        if (options.bake) {
          const shape = await modelTriangles(model);
          blockers.triangles('concrete', shape.positions, shape.indices);
        }
        if (isObstacle(item))
          collision.box('concrete', [-mw / 2, 0, -md / 2], [mw / 2, mh, md / 2], { angle, origin });
        continue;
      }
      if (item.model)
        console.warn(`Model ${item.model} for ${item.label} unavailable, using a simple shape.`);

      const [w, h, d] = furnitureSize(item);
      const transform = furnitureTransform(item, floor);
      objects.push({
        key: item.key,
        label: item.label,
        kind: item.kind,
        position: transform.origin,
      });
      placed.push({ item, position: transform.origin });
      const choice = modelFor(item.kind, h);
      const raw = choice ? await sizeOf(choice.model) : null;
      // In the item's frame: a model turned a quarter-turn swaps its width and depth.
      const quarter = choice ? Math.abs(Math.round(choice.yaw / 90)) % 2 === 1 : false;
      const real: V3 | null = raw && quarter ? [raw[2], raw[1], raw[0]] : raw;
      let footprint: V3 = [w, h, d];
      // Keep real-world scale, shrinking only if the model is clearly bigger than planned.
      // Plants and pictures are scaled to the planned size (they vary a lot). If a model would
      // have to shrink a lot to fit, it's the wrong kind of object: keep the simple shape.
      const scale = !real
        ? 0
        : item.kind === 'plant'
          ? h / real[1]
          : item.kind === 'frame'
            ? w / real[0]
            : Math.min(1, (w * 1.2) / real[0], (d * 1.2) / real[2], (h * 1.3) / real[1]);
      if (choice && real && scale >= 0.75 && assets) {
        const [rw, rh, rd] = real;
        const placed: PlacedModel = {
          name: `object:${item.key}`,
          source: sourceOf(choice.model) as ModelSource,
          angle: transform.angle + (choice.yaw * Math.PI) / 180,
          position: transform.origin,
          scale,
          extras,
        };
        models.push(placed);
        stats.models++;
        footprint = [rw * scale, rh * scale, rd * scale];
        if (options.bake) {
          const shape = await modelTriangles(placed);
          blockers.triangles('concrete', shape.positions, shape.indices);
        }
      } else {
        const mesh = new MeshBuilder();
        buildFurniture(mesh, item, floor, true);
        nodes.push({ name: `object:${item.key}`, mesh, extras });
        blockers.append(mesh);
      }
      if (isObstacle(item)) {
        const [fw, fh, fd] = footprint;
        collision.box('concrete', [-fw / 2, 0, -fd / 2], [fw / 2, fh, fd / 2], transform);
      }
    }

    return { arch, collision, objects, placed, nodes, models, blockers };
  };
  return { assets, index, library, stats, assemble, sizeOf };
}

/** Turns a plan into a streamable space: per-room chunks, shared resources and a manifest. */
export async function buildSpace(input: unknown, options: BuildOptions = {}): Promise<BuiltSpace> {
  const plan = SpacePlan.parse(input);
  const { assets, index, library, stats, assemble } = roomBuilder(plan, options);
  const files = new Map<string, Uint8Array>();
  const resources = new Set<string>();

  const put = (name: string, bytes: Uint8Array) => {
    const path = `chunks/${name}`;
    if (!files.has(path)) stats.bytes += bytes.byteLength;
    files.set(path, bytes);
    return path;
  };
  /** Stores a chunk and its files, noting which files and credits the room uses. */
  const storeChunk = (
    chunk: ChunkFiles,
    used: { files: Set<string>; credits: Set<string> },
  ): ChunkRef => {
    let bytes = chunk.gltf.byteLength;
    for (const c of chunk.credits) used.credits.add(c);
    for (const [name, data] of chunk.resources) {
      const path = put(name, data);
      resources.add(path);
      used.files.add(path);
      if (name.endsWith('.bin')) bytes += data.byteLength; // textures are shared, counted once elsewhere
    }
    const sha256 = createHash('sha256').update(chunk.gltf).digest('hex');
    return { path: put(`${sha256}.gltf`, chunk.gltf), bytes, sha256 };
  };
  // The sky: lights the rooms and shows through the windows.
  let hdri: ChunkRef | undefined;
  let hdriPath: string | null = null;
  if (assets) {
    try {
      const sky = await assets.hdri(DEFAULT_HDRI);
      library.credit(sky.credit);
      const sha256 = createHash('sha256').update(sky.hdr).digest('hex');
      const path = put(`${sha256}.hdr`, sky.hdr);
      resources.add(path);
      hdri = { path, bytes: sky.hdr.byteLength, sha256 };
      hdriPath = sky.path;
    } catch (err) {
      console.warn('Sky unavailable, using a plain background:', (err as Error).message);
    }
  }

  const bake = options.bake ? { ...options.bake, hdriPath } : null;
  const parallel = Math.max(1, Math.floor(bake?.parallel ?? 1));
  let stopped = false;
  const runBake = bake ? limited(bake.run, parallel, () => stopped) : null;
  const baking = { rooms: bake ? stats.lighting.rooms : 0, done: 0, seconds: [] as number[] };
  const tell = () =>
    bake?.progress?.({
      rooms: baking.rooms,
      done: baking.done,
      secondsPerRoom: baking.seconds.length
        ? baking.seconds.reduce((a, b) => a + b, 0) / baking.seconds.length
        : null,
      parallel,
    });
  if (baking.rooms) tell();

  /** One room's meshes, before its lighting is baked. */
  const makeRoom = async (room: PlanRoom) => {
    const used = { files: new Set<string>(), credits: new Set<string>() };
    const made = await assemble(room);
    // LOD2: a distant stand-in, with its doorways and passages open.
    const lod2 = new MeshBuilder();
    buildStandIn(index, room, lod2);
    stats.triangles.lod0 += made.nodes.reduce((n, g) => n + g.mesh.triangleCount, 0);
    stats.triangles.lod2 += lod2.triangleCount;
    return { ...made, used, lod2, doorways: index.doorways(room) };
  };
  type Made = Awaited<ReturnType<typeof makeRoom>>;

  /** Bakes one indoor room's lighting (writing its lightmap UVs into its architecture). */
  const bakeOne = async (i: number, room: PlanRoom, made: Made) => {
    if (!bake || !runBake) return undefined;
    const { base, top } = index.vertical(room);
    const baked = await bakeRoom(
      made.arch,
      made.blockers,
      {
        rect: room.rect,
        base,
        top,
        outdoor: room.outdoor,
        doorways: made.doorways,
        ...(room.slope ? { lift: (x: number, z: number) => slopeAt(room, x, z) } : {}),
      },
      { ...bake, run: runBake },
    );
    let lightmap: Room['lightmap'];
    if (baked.ok) {
      const { image, intensity, size, seconds, reused } = baked.lightmap;
      const sha256 = createHash('sha256').update(image).digest('hex');
      const path = put(`${sha256}.webp`, image);
      resources.add(path);
      lightmap = { path, bytes: image.byteLength, sha256, intensity, size };
      stats.bakeSeconds += seconds;
      stats.lighting.baked++;
      if (reused) stats.lighting.reused++;
      else baking.seconds.push(seconds);
    } else {
      console.warn(
        `Lighting bake failed for ${room.name}; it uses real-time lighting:`,
        baked.error,
      );
      failures[i] = { error: baked.error, timedOut: baked.timedOut };
    }
    baking.done++;
    tell();
    return lightmap;
  };

  /** One room's chunks, written once its lighting is baked. */
  const writeRoom = async (room: PlanRoom, made: Made, lightmap: Room['lightmap']) => {
    const { nodes, models, lod2, collision, used, doorways, objects, placed } = made;
    const { base, top } = index.vertical(room);
    const [x0, z0, x1, z1] = room.rect;
    // A sloping floor: its middle, and how high it climbs.
    const mid = room.slope ? index.floorAt(room, (x0 + x1) / 2, (z0 + z1) / 2) : base;
    const rise = room.slope?.rise ?? 0;
    const lod0 = storeChunk(
      await writeChunk(nodes, models, library, { detail: FULL_DETAIL }),
      used,
    );
    const lod1 = storeChunk(
      await writeChunk(nodes, models, library, { detail: MEDIUM_DETAIL }),
      used,
    );
    const lod2Ref = storeChunk(
      await writeChunk([{ name: 'proxy', mesh: lod2 }], [], new MaterialLibrary(null)),
      used,
    );
    const collisionRef = storeChunk(
      await writeChunk([{ name: 'collision', mesh: collision }], [], new MaterialLibrary(null), {
        materials: false,
      }),
      used,
    );
    return {
      key: room.key,
      floorKey: room.floor,
      name: room.name,
      isOutdoor: room.outdoor,
      floorMaterial: room.floorMaterial,
      bounds: { min: [x0, base, z0], max: [x1, room.slope ? top + rise : top, z1] },
      neighbors: [...new Set(doorways.flatMap((d) => (d.to ? [d.to] : [])))].sort(),
      doorways,
      lods: {
        lod0,
        lod1,
        lod2: lod2Ref,
      },
      collision: collisionRef,
      labelPosition: [(x0 + x1) / 2, mid + Math.min(2.3, top - base - 0.2), (z0 + z1) / 2],
      ...(lightmap ? { lightmap } : {}),
      objects,
      sounds: roomSounds(plan, room, placed),
      files: [...used.files].sort(),
      credits: [...used.credits].sort(),
    } satisfies Room;
  };

  // Rooms are put together and written one at a time, in turn (they share the caches and the file
  // list); only their bakes overlap, `parallel` at once, with at most twice that many rooms in
  // hand. A room's chunks don't depend on any other room's, so the order they finish in doesn't
  // change them.
  const rooms: Room[] = new Array(plan.rooms.length);
  /** Why each room that couldn't be baked wasn't (the report gives the first, in plan order). */
  const failures: LightingStats['failure'][] = [];
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>) => {
    const next = turn.then(fn);
    turn = next.catch(() => {});
    return next;
  };
  const inHand = new Set<Promise<void>>();
  try {
    for (const [i, room] of plan.rooms.entries()) {
      const made = await inTurn(() => makeRoom(room));
      // Outdoors, the real-time sun and sky already look right (and shadows move with the sun).
      const task = (async () => {
        const lightmap = room.outdoor ? undefined : await bakeOne(i, room, made);
        rooms[i] = await inTurn(() => writeRoom(room, made, lightmap));
      })();
      inHand.add(task);
      // A room that fails stays in hand, so the wait below sees it.
      task.then(
        () => inHand.delete(task),
        () => {},
      );
      while (inHand.size >= parallel * 2) await Promise.race(inHand);
    }
    await Promise.all(inHand);
  } catch (err) {
    // Whatever hasn't started baking won't.
    stopped = true;
    throw err;
  }
  stats.lighting.failure = failures.find(Boolean) ?? null;

  const at = (roomKey: string, xz: [number, number]): V3 => [
    xz[0],
    index.floorAt(index.room(roomKey), xz[0], xz[1]),
    xz[1],
  ];
  const manifest: SpaceManifest = {
    format: FORMAT_VERSION,
    name: plan.name,
    spaceType: plan.spaceType,
    floors: plan.floors.map((f, i) => ({
      key: f.key,
      name: f.name,
      index: i,
      elevation: f.elevation,
    })),
    rooms,
    links: plan.elevators.map((e) => ({
      key: e.key,
      kind: 'elevator' as const,
      name: e.name,
      stops: e.stops.map((s) => ({
        floorKey: index.room(s.room).floor,
        roomKey: s.room,
        position: at(s.room, s.at),
        yaw: s.yaw,
      })),
    })),
    spawns: plan.spawns.map((s) => ({
      key: s.key,
      roomKey: s.room,
      position: at(s.room, s.at),
      yaw: s.yaw,
    })),
    lighting: {
      sky: '#dfe8f1',
      ground: '#c2b6a4',
      sunDirection: [0.4, 1, 0.3],
      exposure: 1,
      ...(hdri ? { hdri } : {}),
    },
    resources: [...resources].sort(),
    credits: [...library.credits.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const problems = validateManifest(manifest);
  if (problems.length)
    throw new Error(`The built space is inconsistent:\n  ${problems.join('\n  ')}`);
  return { manifest, files, stats };
}

/**
 * One room, with its furniture and models, as a single .glb plus what's needed to render it the
 * way photos of the real room are taken (from the corners, at eye height, with its lights on).
 */
export async function previewRoom(input: unknown, roomKey: string, options: BuildOptions = {}) {
  const plan = SpacePlan.parse(input);
  const room = plan.rooms.find((r) => r.key === roomKey);
  if (!room)
    throw new Error(
      `There's no room "${roomKey}" in plan.json. Rooms: ${plan.rooms.map((r) => r.key).join(', ')}`,
    );
  const b = roomBuilder(plan, { ...options, bake: null });
  const { nodes, models, placed } = await b.assemble(room);
  const { top } = b.index.vertical(room);
  const [x0, z0, x1, z1] = room.rect;
  const glb = await writePreview(nodes, models, b.library);

  // Where the furniture stands (as circles on the floor), so no camera stands in or against it.
  const footprints: { x: number; z: number; r: number }[] = [];
  for (const { item, position } of placed) {
    let [w, h, d] = furnitureSize(item);
    const own = item.model ? await b.sizeOf(item.model) : null;
    if (own) {
      const k = item.size
        ? Math.min(item.size[0] / own[0], item.size[1] / own[1], item.size[2] / own[2])
        : 1;
      [w, h, d] = [own[0] * k, own[1] * k, own[2] * k];
    }
    if (h < 0.3 || item.kind === 'rug' || item.kind === 'frame') continue;
    footprints.push({ x: position[0], z: position[2], r: Math.hypot(w, d) / 2 });
  }
  const clear = (x: number, z: number) =>
    footprints.every((f) => Math.hypot(x - f.x, z - f.z) > f.r + 0.3);
  // From the corners, just inside the room, looking across it; a corner that's taken by
  // furniture steps in towards the middle until the view is clear.
  const floorAt = (x: number, z: number) => b.index.floorAt(room, x, z);
  const inset = Math.min(0.35, (x1 - x0) / 4, (z1 - z0) / 4);
  const [cx, cz] = [(x0 + x1) / 2, (z0 + z1) / 2];
  const corner = (name: string, x: number, z: number) => {
    let [px, pz] = [x, z];
    for (let t = 0; t <= 0.7 && !clear(px, pz); t += 0.03) {
      px = x + (cx - x) * t;
      pz = z + (cz - z) * t;
    }
    // Looking towards the opposite corner (through the middle), at the height of a table top.
    const [tx, tz] = [2 * cx - px, 2 * cz - pz];
    const target: V3 = [tx, floorAt(tx, tz) + 1.0, tz];
    return { name, position: [px, floorAt(px, pz) + 1.6, pz] as V3, target, lens: 16 };
  };
  const cameras = [
    corner('corner-1', x0 + inset, z0 + inset),
    corner('corner-2', x1 - inset, z1 - inset),
    corner('corner-3', x1 - inset, z0 + inset),
    corner('corner-4', x0 + inset, z1 - inset),
  ];
  return {
    glb,
    name: room.name,
    cameras,
    lights: room.outdoor
      ? []
      : ceilingLights(x0, z0, x1, z1, top, room.slope ? (x, z) => slopeAt(room, x, z) : undefined),
    models: b.stats.models,
  };
}

/**
 * The whole place as a single .glb (every room with its structure, furniture and models), to draw
 * from outside: from where photos of the real building were taken (`ats space match`).
 */
export async function previewSite(input: unknown, options: BuildOptions = {}) {
  const plan = SpacePlan.parse(input);
  const b = roomBuilder(plan, { ...options, bake: null });
  const nodes: GlbNode[] = [];
  const models: PlacedModel[] = [];
  for (const room of plan.rooms) {
    const made = await b.assemble(room);
    nodes.push(...made.nodes);
    models.push(...made.models);
  }
  return { glb: await writePreview(nodes, models, b.library), plan, index: b.index };
}

/** `run`, at most `n` at once: the rest wait their turn, first come, first served. */
function limited(run: BakeRunner, n: number, stopped: () => boolean): BakeRunner {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (input) => {
    if (active < n) active++;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      if (stopped()) throw new BakeError('the build stopped');
      return await run(input);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
