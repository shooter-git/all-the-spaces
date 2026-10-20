import type { ChunkRef, SpaceManifest } from '@ats/space-format';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  type Material,
  Mesh,
  type Object3D,
  type Texture,
} from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { type GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CollisionWorld } from './physics.ts';
import {
  detailRooms,
  distanceToRoom,
  holdsLighterDetail,
  type Lod,
  NEAR_DETAIL_HYSTERESIS_M,
  NEAR_DETAIL_M,
  roomDistances,
  roomViews,
  SMALL_THING_M,
} from './rooms.ts';
import { SharedTextures } from './textures.ts';

/** How long to wait before each retry of a chunk that failed to load; then it's reported. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/** Graphics memory for rooms in full detail when no budget is given (bytes). */
export const DEFAULT_DETAIL_BUDGET = 512 * 1024 * 1024;

/** Anything that can fetch a glTF file (GLTFLoader, or a stand-in in tests). */
export interface ChunkLoader {
  loadAsync(url: string): Promise<GLTF>;
}

interface Loaded {
  lod: Lod;
  object: Object3D;
  bytes: number;
  /** Shared texture files this room uses. */
  textures: string[];
  /** Its smallest things, left out when the room is far away. */
  small: Object3D[];
  /** Whether the small things are left out now. */
  trimmed: boolean;
}

/**
 * One file to fetch: a room's collision, its stand-in (lod2), its full detail, or its lighter
 * detail (lod1, for drawing it from further away).
 */
type Part = 'collision' | 'stand-in' | 'detail' | 'lighter';

export interface StreamStats {
  rooms: Record<Lod, number>;
  collisionRooms: number;
  residentBytes: number;
  loading: number;
}

/**
 * Loads a place for walking around in. Every room's collision and simple stand-in come first and
 * stay (they're small), so no room is ever a hole you can see into or fall through. Full detail is
 * held for the whole place when it fits in the device's budget, and for the rooms nearest you when
 * it doesn't. When the device holds it too, every room's lighter detail is kept beside its full
 * detail, for drawing rooms further away. Everything is fetched up front, while the place is
 * opening (see `complete`); only the rooms you could see are drawn.
 */
export class RoomStreamer {
  readonly root = new Group();
  private readonly loader: ChunkLoader;
  private readonly standIns = new Map<string, Loaded>();
  private readonly detailed = new Map<string, Loaded>();
  /** Lighter detail of the rooms held in full detail (only when the device holds both). */
  private readonly lighter = new Map<string, Loaded>();
  /** Rooms far enough from you to be drawn lighter (see `look`). */
  private readonly far = new Set<string>();
  /** Rooms whose collision has arrived (a room may have nothing solid in it). */
  private readonly solid = new Set<string>();
  /** Files being fetched, by `part:roomKey`. */
  private readonly inflight = new Set<string>();
  private current: string | null = null;
  /** Rooms to hold in full detail, nearest first (for `current`). */
  private wanted: string[] = [];
  /** Every room, nearest `current` first (the order to fetch in). */
  private nearest: string[] = [];
  private disposed = false;
  /** Chunks that failed to load: how often, and when they may be tried again. */
  private readonly failures = new Map<
    string,
    { roomKey: string; count: number; retryAt: number }
  >();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly maxConcurrent: number;
  private readonly detailLod: Lod;
  private readonly detailBudget: number;
  private readonly holdLighter: boolean;
  private readonly textures = new SharedTextures();
  private readonly manifest: SpaceManifest;
  private readonly baseUrl: string;
  private readonly world: CollisionWorld;
  /**
   * Called with every room's objects before they're added, so the viewer can set up materials,
   * compile shaders and upload textures without stalling a frame later. Added when it resolves.
   */
  prepareRoom?: (roomKey: string, lod: Lod, object: Object3D) => Promise<void> | void;
  /**
   * Called when a room's chunk still fails after every retry (gone private, the connection
   * dropped, a broken file). It's tried again when you next walk into that room.
   */
  onError?: (roomKey: string, error: unknown) => void;
  /** Called when a room's objects were added or removed (e.g. to find what's in the scene). */
  onRoomsChanged?: () => void;

  constructor(
    manifest: SpaceManifest,
    baseUrl: string,
    world: CollisionWorld,
    options: {
      maxConcurrent?: number;
      maxDetail?: Lod;
      /** Graphics memory to spend on rooms in full detail (bytes, roughly). */
      detailBudget?: number;
      loader?: ChunkLoader;
      /** For rooms whose textures are KTX2 (WebP ones load without it). */
      ktx2?: KTX2Loader;
    } = {},
  ) {
    const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    if (options.ktx2) gltf.setKTX2Loader(options.ktx2);
    this.loader = options.loader ?? gltf;
    this.detailLod = options.maxDetail ?? 'lod0';
    this.detailBudget = options.detailBudget ?? DEFAULT_DETAIL_BUDGET;
    this.manifest = manifest;
    this.baseUrl = baseUrl;
    this.world = world;
    this.maxConcurrent = options.maxConcurrent ?? 6;
    this.holdLighter = holdsLighterDetail(manifest, this.detailLod, this.detailBudget);
    this.root.name = 'space';
  }

  /** Call whenever the viewer's room changes (and periodically; it's cheap). */
  focus(roomKey: string) {
    if (roomKey !== this.current) {
      // Walking into a room gives what had given up there a fresh start.
      for (const [id, f] of this.failures) {
        if (f.roomKey === roomKey && f.retryAt === Number.POSITIVE_INFINITY)
          this.failures.delete(id);
      }
      this.current = roomKey;
      this.wanted = detailRooms(this.manifest, roomKey, this.detailLod, this.detailBudget);
      const dist = roomDistances(this.manifest, roomKey);
      const far = Number.POSITIVE_INFINITY;
      this.nearest = [...this.manifest.rooms]
        .sort((a, b) => (dist.get(a.key) ?? far) - (dist.get(b.key) ?? far))
        .map((r) => r.key);
      this.show();
    }
    this.pump();
  }

  /**
   * True once everything the place needs right now is here: every room's collision and stand-in,
   * and full detail for every room that's held in it. Until then the place isn't ready to enter.
   */
  get complete() {
    return (
      this.current !== null &&
      this.manifest.rooms.every((r) => this.solid.has(r.key) && this.standIns.has(r.key)) &&
      this.wanted.every(
        (key) => this.detailed.has(key) && (!this.holdLighter || this.lighter.has(key)),
      )
    );
  }

  /** How much of `complete` has arrived, from 0 to 1 (by file size). */
  progress(): number {
    let total = 0;
    let done = 0;
    for (const r of this.manifest.rooms) {
      total += r.collision.bytes + r.lods.lod2.bytes;
      if (this.solid.has(r.key)) done += r.collision.bytes;
      if (this.standIns.has(r.key)) done += r.lods.lod2.bytes;
    }
    const rooms = new Map(this.manifest.rooms.map((r) => [r.key, r]));
    for (const key of this.wanted) {
      const bytes = rooms.get(key)?.lods[this.detailLod].bytes ?? 0;
      total += bytes;
      if (this.detailed.has(key)) done += bytes;
      if (!this.holdLighter) continue;
      const lighter = rooms.get(key)?.lods.lod1.bytes ?? 0;
      total += lighter;
      if (this.lighter.has(key)) done += lighter;
    }
    return total > 0 ? done / total : 1;
  }

  stats(): StreamStats {
    const rooms = { lod0: 0, lod1: 0, lod2: 0 };
    let residentBytes = 0;
    for (const l of [
      ...this.standIns.values(),
      ...this.detailed.values(),
      ...this.lighter.values(),
    ]) {
      rooms[l.lod]++;
      residentBytes += l.bytes;
    }
    return {
      rooms,
      collisionRooms: this.solid.size,
      residentBytes,
      loading: this.inflight.size,
    };
  }

  private url(ref: ChunkRef) {
    return new URL(ref.path, this.baseUrl).toString();
  }

  /**
   * Call as you move (every frame is fine; it only redraws when a room changes): rooms in full
   * detail that are far from you are drawn lighter, without their smallest things.
   */
  look(x: number, y: number, z: number) {
    let changed = false;
    for (const r of this.manifest.rooms) {
      const d = distanceToRoom(r, x, y, z);
      if (this.far.has(r.key)) {
        if (d >= NEAR_DETAIL_M) continue;
        this.far.delete(r.key);
      } else {
        if (d <= NEAR_DETAIL_M + NEAR_DETAIL_HYSTERESIS_M) continue;
        this.far.add(r.key);
      }
      changed = true;
    }
    if (changed) this.show();
  }

  /** Draws the rooms you could see from where you are, each in full detail or as its stand-in. */
  private show() {
    const views = this.current ? roomViews(this.manifest, this.current) : new Map();
    for (const r of this.manifest.rooms) {
      const view = views.get(r.key);
      const detail = this.detailed.get(r.key);
      const lighter = this.lighter.get(r.key);
      const standIn = this.standIns.get(r.key);
      const far = this.far.has(r.key);
      // Whichever is here, so a room you can see is never missing.
      const full = Boolean(detail && (view === 'detail' || (view === 'stand-in' && !standIn)));
      const light = full && far && lighter !== undefined;
      if (detail) {
        detail.object.visible = full && !light;
        trim(detail, far);
      }
      if (lighter) {
        lighter.object.visible = light;
        trim(lighter, far);
      }
      if (standIn) standIn.object.visible = view !== undefined && !full;
    }
  }

  private pump() {
    if (!this.current || this.disposed) return;
    const rooms = new Map(this.manifest.rooms.map((r) => [r.key, r]));
    const wanted = new Set(this.wanted);

    // Full detail that's no longer held (only when the place doesn't fit): its stand-in shows.
    for (const [key, l] of this.detailed) if (!wanted.has(key)) this.unload(this.detailed, key, l);
    for (const [key, l] of this.lighter) if (!wanted.has(key)) this.unload(this.lighter, key, l);

    // What to fetch, most needed first: every room's collision, then full detail nearest first,
    // then every stand-in.
    const jobs: [Part, string][] = [
      ...this.nearest
        .filter((k) => !this.solid.has(k))
        .map((k): [Part, string] => ['collision', k]),
      ...this.wanted.filter((k) => !this.detailed.has(k)).map((k): [Part, string] => ['detail', k]),
      ...this.nearest
        .filter((k) => !this.standIns.has(k))
        .map((k): [Part, string] => ['stand-in', k]),
      ...(this.holdLighter ? this.wanted : [])
        .filter((k) => !this.lighter.has(k))
        .map((k): [Part, string] => ['lighter', k]),
    ];
    for (const [part, key] of jobs) {
      if (this.inflight.size >= this.maxConcurrent) break;
      const id = `${part}:${key}`;
      const room = rooms.get(key);
      if (!room || this.inflight.has(id) || this.waiting(id)) continue;
      if (part === 'collision') this.loadCollision(key, room.collision);
      else if (part === 'detail')
        this.loadVisual(part, key, this.detailLod, room.lods[this.detailLod]);
      else if (part === 'lighter') this.loadVisual(part, key, 'lod1', room.lods.lod1);
      else this.loadVisual(part, key, 'lod2', room.lods.lod2);
    }
  }

  /** A failed chunk that's waiting for its next try (or has given up). */
  private waiting(id: string) {
    const f = this.failures.get(id);
    return Boolean(f && Date.now() < f.retryAt);
  }

  private failed(id: string, roomKey: string, error: unknown) {
    if (this.disposed) return;
    const count = (this.failures.get(id)?.count ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[count - 1];
    if (delay === undefined) {
      console.warn(`Gave up loading ${id}`, error);
      this.failures.set(id, { roomKey, count, retryAt: Number.POSITIVE_INFINITY });
      this.onError?.(roomKey, error);
      return;
    }
    this.failures.set(id, { roomKey, count, retryAt: Date.now() + delay });
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.pump();
    }, delay);
    this.retryTimers.add(timer);
  }

  private async loadVisual(
    part: 'stand-in' | 'detail' | 'lighter',
    key: string,
    lod: Lod,
    ref: ChunkRef,
  ) {
    const id = `${part}:${key}`;
    const into =
      part === 'detail' ? this.detailed : part === 'lighter' ? this.lighter : this.standIns;
    this.inflight.add(id);
    try {
      const url = this.url(ref);
      const gltf: GLTF = await this.loader.loadAsync(url);
      gltf.scene.name = `${key}:${lod}`;
      gltf.scene.userData.roomKey = key;
      const textures = this.textures.adopt(gltf, url);
      const wanted = () => !this.disposed && (part === 'stand-in' || this.wanted.includes(key));
      if (wanted()) await this.prepareRoom?.(key, lod, gltf.scene);
      if (!wanted()) {
        disposeObject(gltf.scene);
        this.textures.release(textures);
        if (!this.disposed) this.onRoomsChanged?.();
        return;
      }
      freeze(gltf.scene);
      const small = part === 'stand-in' ? [] : smallThings(gltf.scene);
      this.root.add(gltf.scene);
      into.set(key, {
        lod,
        object: gltf.scene,
        bytes: ref.bytes,
        textures,
        small,
        trimmed: false,
      });
      this.failures.delete(id);
      this.show();
      this.onRoomsChanged?.();
    } catch (err) {
      this.failed(id, key, err);
    } finally {
      this.inflight.delete(id);
      this.pump();
    }
  }

  private async loadCollision(key: string, ref: ChunkRef) {
    const id = `collision:${key}`;
    this.inflight.add(id);
    try {
      const gltf = await this.loader.loadAsync(this.url(ref));
      const geometries: BufferGeometry[] = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (o instanceof Mesh) {
          // Positions arrive quantised (small integers + a node scale). Copy them out as plain
          // floats before moving them into world space, or the transform would clamp them.
          const src = o.geometry as BufferGeometry;
          const pos = src.getAttribute('position');
          const floats = new Float32Array(pos.count * 3);
          for (let i = 0; i < pos.count; i++) {
            floats[i * 3] = pos.getX(i);
            floats[i * 3 + 1] = pos.getY(i);
            floats[i * 3 + 2] = pos.getZ(i);
          }
          const g = new BufferGeometry().setAttribute('position', new BufferAttribute(floats, 3));
          if (src.index) g.setIndex(src.index.clone());
          g.applyMatrix4(o.matrixWorld);
          geometries.push(g.index ? g.toNonIndexed() : g);
        }
      });
      const merged = geometries.length ? mergeGeometries(geometries, false) : null;
      for (const g of geometries) g.dispose();
      disposeObject(gltf.scene);
      if (this.disposed) {
        merged?.dispose();
        return;
      }
      if (merged) this.world.add(key, merged);
      this.solid.add(key);
      this.failures.delete(id);
    } catch (err) {
      this.failed(id, key, err);
    } finally {
      this.inflight.delete(id);
      this.pump();
    }
  }

  private unload(from: Map<string, Loaded>, key: string, l: Loaded) {
    this.root.remove(l.object);
    disposeObject(l.object);
    this.textures.release(l.textures);
    if (from.get(key) === l) from.delete(key);
    this.show();
    if (!this.disposed) this.onRoomsChanged?.();
  }

  dispose() {
    this.disposed = true;
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    for (const [key, l] of this.standIns) this.unload(this.standIns, key, l);
    for (const [key, l] of this.detailed) this.unload(this.detailed, key, l);
    for (const [key, l] of this.lighter) this.unload(this.lighter, key, l);
    for (const key of this.solid) this.world.remove(key);
    this.solid.clear();
  }
}

/**
 * Rooms don't move: work out where everything in one is once, and never again. Otherwise every
 * node's position is recomputed every frame (over ten thousand in a big place).
 */
export function freeze(root: Object3D) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.matrixWorldAutoUpdate = false;
  });
}

/** The things in a room small enough to leave out from afar (a cup, a pen, a light switch). */
function smallThings(root: Object3D): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((o) => {
    if (!(o instanceof Mesh) || (o as { isInstancedMesh?: boolean }).isInstancedMesh) return;
    if (o.userData.halo) return;
    const geometry = o.geometry as BufferGeometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const radius = (geometry.boundingSphere?.radius ?? 0) * o.matrixWorld.getMaxScaleOnAxis();
    if (radius < SMALL_THING_M) out.push(o);
  });
  return out;
}

/** Leaves a room's small things out (far away) or puts them back. */
function trim(l: Loaded, far: boolean) {
  if (l.trimmed === far) return;
  l.trimmed = far;
  for (const o of l.small) o.visible = !far;
}

/** Frees GPU memory held by an object tree. */
export function disposeObject(root: Object3D) {
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    o.geometry.dispose();
    const materials: Material[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) {
      for (const value of Object.values(m))
        if ((value as Texture)?.isTexture) (value as Texture).dispose();
      m.dispose();
    }
  });
}
