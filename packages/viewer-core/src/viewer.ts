import type { Tier } from '@allthespaces/bridge-protocol';
import { ResolutionGovernor } from '@allthespaces/portal/resolution';
import type { Link, Room, SpaceManifest } from '@ats/space-format';
import {
  AgXToneMapping,
  CircleGeometry,
  Color,
  type DataTexture,
  DataUtils,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Euler,
  Fog,
  HalfFloatType,
  HemisphereLight,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { type AudioOut, SpaceAudio } from './audio.ts';
import { AvatarLayer } from './avatars.ts';
import { closedDoors, SwingingDoors } from './doors.ts';
import { InputState } from './input.ts';
import { RoomObjects } from './objects.ts';
import { FrameStats } from './perf.ts';
import { CollisionWorld, PlayerController } from './physics.ts';
import { needsSunShadows, roomAt } from './rooms.ts';
import { disposeObject, RoomStreamer, type StreamStats } from './streamer.ts';
import { sharpen } from './textures.ts';

/** The device's quality tier: the protocol's tiers, which creations get too. */
export type Quality = Tier;

/**
 * Graphics memory each tier spends on rooms in full detail (bytes, roughly). A place that fits is
 * loaded whole while it opens; a bigger one keeps the rooms nearest you in full detail.
 */
const DETAIL_BUDGETS: Record<Quality, number> = {
  low: 256 * 1024 * 1024,
  mid: 512 * 1024 * 1024,
  high: 1024 * 1024 * 1024,
};

export interface ViewerOptions {
  manifest: SpaceManifest;
  /** Base URL that chunk paths in the manifest are relative to. */
  baseUrl: string;
  quality?: Quality;
  /** Draw fewer pixels while frames are slow (default on). */
  dynamicResolution?: boolean;
  /** Use touch controls (no pointer lock). */
  touch?: boolean;
  /**
   * The app's sound output. Without it the space is silent. The app decides when sound may
   * start (after a tap) and owns the volume.
   */
  audio?: AudioOut;
  /** Where the space's recordings are served (a folder URL ending in `/`). */
  soundsUrl?: string;
  spawnKey?: string;
  /** Start exactly here instead (e.g. coming back from a creation), if that room exists. */
  start?: { position: [number, number, number]; yaw: number; roomKey: string };
}

export interface ViewerStats extends StreamStats {
  fps: number;
  frameMs: number;
  frameMsP50: number;
  frameMsP95: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  pixelRatio: number;
  /** Share of full resolution drawn now (dynamic resolution). */
  resolutionScale: number;
  /** The quality this device started at. */
  quality: Quality;
  /** Ambient occlusion: on, given up for now (frames were slow), or not on this tier at all. */
  ambientOcclusion: 'on' | 'off' | 'none';
  /** Whether the sun casts shadows as you walk (not in places whose light is all baked). */
  sunShadows: boolean;
}

export interface TravelTarget {
  roomKey: string;
  roomName: string;
  floorKey: string;
  floorName: string;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  roomKey: string | null;
  moving: boolean;
}

/** The shared space: renders the rooms around you and lets you walk through them. */
export class SpaceViewer {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(70, 1, 0.05, 200);
  readonly renderer: WebGLRenderer;
  readonly input = new InputState();
  readonly player = new PlayerController();
  readonly world = new CollisionWorld();
  readonly streamer: RoomStreamer;
  readonly manifest: SpaceManifest;
  /** Other people in the space. */
  readonly avatars = new AvatarLayer();
  /** Increments whenever you jump somewhere (quick travel, lift) instead of walking. */
  teleports = 0;
  /** The space's sound: ambience, footsteps, doors, everyday sounds and echo. */
  readonly audio: SpaceAudio;
  private readonly doors: SwingingDoors;
  private readonly objects: RoomObjects;
  private readonly lastPos = new Vector3();
  private readonly approachTarget = new Vector3();
  /** Rotates like a camera, so `lookAt` gives the orientation that faces the target. */
  private readonly lookHelper = new PerspectiveCamera();
  private approachAmount = 0;
  private approachGoal = 0;
  private approachFrom = 0;
  private approachElapsed = 0;
  private approachSeconds = 0.8;
  private approachDone: (() => void) | null = null;
  private lastTeleports = -1;

  /** Fired when you walk into another room (or out of all of them). */
  onRoomChange?: (room: Room | null) => void;
  /** Fired once the place has loaded (see `RoomStreamer.complete`) and you can move. */
  onReady?: () => void;
  /** Fired as the place loads, with how much has arrived (0 to 1, in hundredths). */
  onProgress?: (fraction: number) => void;
  /**
   * Fired when part of the place couldn't be loaded even after retrying, while it's opening.
   * Afterwards every floor is already there; full detail that fails (in a place too big to hold
   * whole) leaves the room's stand-in and is tried again when you walk into it.
   */
  onError?: (error: unknown) => void;
  /** Fired when you stand at (or leave) a lift stop. */
  onLift?: (link: Link | null, stopIndex: number) => void;
  /** Called every frame after the camera moves (e.g. to update other people's avatars). */
  onFrame?: (dt: number) => void;

  private readonly frames = new FrameStats();
  /** Draws fewer pixels while frames are slow (the HUD is HTML, so it stays sharp). */
  private readonly resolution: ResolutionGovernor | null;
  private readonly fullPixelRatio: number;
  /** The most the browser has managed to draw at (see `fitDrawingBuffer`). */
  private pixelRatioCap = Number.POSITIVE_INFINITY;
  private readonly resizeObserver: ResizeObserver;
  private readonly container: HTMLElement;
  private room: Room | null = null;
  private ready = false;
  private lastProgress = -1;
  private paused = false;
  private disposed = false;
  private last = performance.now();
  private lastFocus = 0;
  private walkTarget: Vector3 | null = null;
  private walkStarted = 0;
  private lift: { link: Link; stop: number } | null = null;
  /** After a jump, hold still until the destination's floor has loaded (or you'd fall through). */
  private landing: string | null = null;
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly quality: Quality;
  private readonly sun = new DirectionalLight('#fff4e6', 1.6);
  private readonly sunDirection = new Vector3(0.4, 1, 0.3).normalize();
  private hemisphere!: HemisphereLight;
  private composer: EffectComposer | null = null;
  private gtao: GTAOPass | null = null;
  private readonly baseUrl: string;
  /** Each room's lighting image, shared by its full and lighter detail. */
  private readonly lightmaps = new Map<string, Promise<Texture>>();
  /** How sharply textures seen at a glance (a floor ahead of you) are drawn. */
  private readonly anisotropy: number;

  constructor(container: HTMLElement, options: ViewerOptions) {
    this.container = container;
    this.manifest = options.manifest;
    const quality = options.quality ?? 'mid';
    this.quality = quality;
    this.baseUrl = options.baseUrl;
    // Smooth edges at every quality: multisampling is cheap on phones' graphics chips, and
    // jagged edges are what make a scene look broken. The high tier multisamples where it draws the
    // scene (see `setupPostprocessing`) and only copies the result to the canvas, so its canvas
    // doesn't need it: on a big screen that saves up to hundreds of megabytes of graphics memory.
    this.renderer = new WebGLRenderer({
      antialias: quality !== 'high',
      powerPreference: 'high-performance',
    });
    this.fullPixelRatio = Math.min(window.devicePixelRatio, quality === 'low' ? 1.5 : 2);
    this.renderer.setPixelRatio(this.fullPixelRatio);
    // When frames are slow, ambient occlusion goes before any pixels do (it draws everything a
    // second time), and pixels go only while fewer of them make frames faster: a frame held up by
    // the processor (too many things to draw) only gets blurrier with fewer pixels.
    this.resolution =
      options.dynamicResolution === false
        ? null
        : new ResolutionGovernor({
            min: quality === 'low' ? 0.55 : 0.6,
            detectCpuBound: true,
            shed: () => this.setAmbientOcclusion(false),
            restore: () => this.setAmbientOcclusion(true),
          });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = AgXToneMapping;
    this.renderer.toneMappingExposure = this.manifest.lighting.exposure;
    this.renderer.info.autoReset = false;
    // Soft sun shadows on mid and high tiers, in places that have any light that isn't baked.
    this.renderer.shadowMap.enabled = quality !== 'low' && needsSunShadows(this.manifest);
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.domElement.style.display = 'block';
    // Always fills its container, however many pixels are drawn (dynamic resolution).
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);
    this.anisotropy = Math.min(
      this.renderer.capabilities.getMaxAnisotropy(),
      quality === 'low' ? 4 : 8,
    );
    // Nothing in the scene itself moves it; rooms are placed once (see `freeze`). Only what moves
    // (the sun, doors, people) works out where it is each frame.
    this.scene.matrixAutoUpdate = false;

    this.setupLighting();
    this.setupPostprocessing();
    this.scene.add(closedDoors(this.manifest, this.world));
    this.audio = new SpaceAudio(this.manifest, options.soundsUrl ?? '', options.audio ?? null);
    this.doors = new SwingingDoors(this.manifest);
    this.doors.onSound = (kind, at) => this.audio.door(kind, at);
    this.scene.add(this.doors.root);
    this.avatars.onStep = (p) =>
      this.audio.remoteStep(p, roomAt(this.manifest, p.x, p.y + 0.1, p.z));
    this.streamer = new RoomStreamer(this.manifest, options.baseUrl, this.world, {
      maxDetail: quality === 'low' ? 'lod1' : 'lod0',
      detailBudget: DETAIL_BUDGETS[quality],
    });
    this.streamer.onError = (_key, error) => {
      if (!this.ready) this.onError?.(error);
    };
    this.objects = new RoomObjects(
      this.streamer.root,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    this.streamer.prepareRoom = async (key, _lod, object) => {
      // A room with baked lighting already has its furniture's shadows (the sun's too): its
      // furniture doesn't also cast them in real time, which would draw it all a second time.
      const baked = Boolean(this.manifest.rooms.find((r) => r.key === key)?.lightmap);
      this.prepareMaterials(object, !baked);
      sharpen(object, this.anisotropy);
      this.objects.prepare(object);
      await this.applyLightmap(key, object);
      // Compile the room's shaders and upload its textures now, while the place is opening, so
      // walking into it later doesn't stall a frame.
      await this.renderer.compileAsync(object, this.camera, this.scene).catch(() => {});
      object.traverse((o) => {
        if (!(o instanceof Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          for (const value of Object.values(m))
            if ((value as Texture)?.isTexture) this.renderer.initTexture(value as Texture);
      });
    };
    // What's in the rooms changes only as rooms come and go.
    this.streamer.onRoomsChanged = () => this.objects.collect();
    this.scene.add(this.streamer.root);
    this.scene.add(this.avatars.root);

    this.input.attach(this.renderer.domElement, { pointerLock: !options.touch });

    const resume =
      options.start && this.manifest.rooms.some((r) => r.key === options.start?.roomKey)
        ? {
            position: options.start.position,
            yaw: options.start.yaw,
            roomKey: options.start.roomKey,
          }
        : null;
    const planned =
      this.manifest.spawns.find((s) => s.key === options.spawnKey) ?? this.manifest.spawns[0];
    const spawn = resume ?? (planned && { ...planned, yaw: radians(planned.yaw) });
    if (spawn) {
      this.player.teleport(spawn.position, spawn.yaw);
      this.setRoom(this.manifest.rooms.find((r) => r.key === spawn.roomKey) ?? null);
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private setupLighting() {
    const { sky, ground, sunDirection, hdri } = this.manifest.lighting;
    this.scene.background = new Color(sky);
    // Indoors, light bouncing off floors and walls fills in ceilings; a warm "ground" colour stands
    // in for that bounce until baked lighting arrives.
    this.hemisphere = new HemisphereLight(sky, hdri ? '#efe6d8' : ground, hdri ? 1.05 : 1.6);
    this.scene.add(this.hemisphere);
    this.sunDirection.set(...sunDirection).normalize();
    this.sun.intensity = hdri ? 2.4 : 1.6;
    this.scene.add(this.sun, this.sun.target);
    if (this.renderer.shadowMap.enabled) {
      this.sun.castShadow = true;
      const size = this.quality === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(size, size);
      const cam = this.sun.shadow.camera;
      cam.left = -11;
      cam.right = 11;
      cam.top = 11;
      cam.bottom = -11;
      cam.near = 1;
      cam.far = 80;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.025;
      this.sun.shadow.radius = 4;
    }

    if (hdri) {
      // A real sky: lights the rooms, shows through the windows, and sets where the sun is.
      new HDRLoader()
        .setDataType(HalfFloatType)
        .load(new URL(hdri.path, this.baseUrl).toString(), (texture) => {
          // Arrived after the viewer was closed: nothing to light any more.
          if (this.disposed) {
            texture.dispose();
            return;
          }
          texture.mapping = EquirectangularReflectionMapping;
          this.scene.background = texture;
          this.scene.backgroundIntensity = 0.9;
          const pmrem = new PMREMGenerator(this.renderer);
          this.scene.environment?.dispose();
          this.scene.environment = pmrem.fromEquirectangular(texture).texture;
          this.scene.environmentIntensity = 0.55;
          pmrem.dispose();
          const dir = brightestDirection(texture);
          if (dir) this.sunDirection.copy(dir);
        });
    } else {
      const pmrem = new PMREMGenerator(this.renderer);
      const studio = new RoomEnvironment();
      this.scene.environment = pmrem.fromScene(studio, 0.04).texture;
      this.scene.environmentIntensity = 0.35;
      studio.dispose();
      pmrem.dispose();
      // Simple surroundings so windows and balconies look out onto ground and a hazy horizon.
      this.scene.fog = new Fog(sky, 35, 160);
      const lowest = Math.min(...this.manifest.floors.map((f) => f.elevation));
      const land = new Mesh(
        new CircleGeometry(220, 48),
        new MeshLambertMaterial({ color: '#c8c4b1' }),
      );
      land.rotation.x = -Math.PI / 2;
      land.position.y = lowest - 0.14;
      land.name = 'surroundings';
      this.scene.add(land);
    }
  }

  /**
   * Ambient occlusion (soft contact shadows in corners and under furniture) on the high tier only:
   * it draws the whole scene again each frame, which phones can't spare, and baked lighting
   * already shades rooms' corners.
   */
  private setupPostprocessing() {
    if (this.quality !== 'high') return;
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const gtao = new GTAOPass(this.scene, this.camera, 1, 1);
    // At half resolution: soft shading doesn't need every pixel, and it costs a quarter as much.
    const setSize = gtao.setSize.bind(gtao);
    gtao.setSize = (width: number, height: number) =>
      setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.85;
    gtao.updateGtaoMaterial({
      radius: 0.35,
      distanceExponent: 1.5,
      thickness: 1,
      scale: 1,
      samples: this.quality === 'high' ? 16 : 8,
    });
    gtao.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2,
      normalPhi: 3,
      radius: 6,
      rings: 2,
      samples: 16,
    });
    composer.addPass(gtao);
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.gtao = gtao;
  }

  /**
   * Rooms with baked lighting: walls, floors and ceilings show exactly the baked light (sky and
   * ceiling lights bouncing around, soft shadows under furniture) instead of real-time lights.
   */
  private async applyLightmap(roomKey: string, object: Object3D) {
    const baked = this.manifest.rooms.find((r) => r.key === roomKey)?.lightmap;
    const architecture = object.getObjectByName('architecture');
    if (!baked || !architecture) return;
    let loading = this.lightmaps.get(roomKey);
    if (!loading) {
      loading = new TextureLoader()
        .loadAsync(new URL(baked.path, this.baseUrl).toString())
        .then((t) => {
          t.flipY = false;
          t.colorSpace = SRGBColorSpace;
          t.channel = 1; // the second UV set, made for the lightmap
          return t;
        });
      this.lightmaps.set(roomKey, loading);
    }
    let texture: Texture;
    try {
      texture = await loading;
    } catch {
      this.lightmaps.delete(roomKey); // tried again with the room's next file
      return; // keep real-time lighting
    }
    architecture.traverse((o) => {
      if (!(o instanceof Mesh) || !o.geometry.getAttribute('uv1')) return;
      const old = o.material as MeshStandardMaterial;
      if (old.transparent) return; // glass stays as it is
      o.material = new MeshBasicMaterial({
        map: old.map,
        color: old.color,
        lightMap: texture,
        lightMapIntensity: baked.intensity * LIGHTMAP_GAIN,
        side: old.side,
      });
      old.dispose();
      o.receiveShadow = false;
    });
  }

  /** Turns ambient occlusion on or off (when frames are slow); true if that changed anything. */
  private setAmbientOcclusion(on: boolean): boolean {
    if (!this.gtao || this.gtao.enabled === on) return false;
    this.gtao.enabled = on;
    return true;
  }

  private prepareMaterials(object: Object3D, castsShadows = true) {
    object.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      const materials: Material[] = Array.isArray(o.material) ? o.material : [o.material];
      const transparent = materials.some((m) => m.transparent);
      o.castShadow = castsShadows && !transparent;
      o.receiveShadow = true;
      for (const m of materials) {
        // Real glass (transmission) is expensive and renders black in some setups; a light
        // transparent sheet looks the same at room scale.
        if (m instanceof MeshPhysicalMaterial && m.transmission > 0) {
          m.transmission = 0;
          m.transparent = true;
          m.opacity = Math.min(m.opacity, 0.18);
        }
        if (m instanceof MeshStandardMaterial && m.transparent) {
          m.depthWrite = false; // glass: don't hide what's behind it
        }
      }
    });
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.fitDrawingBuffer(w, h);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    // Portrait screens get a taller view so you still see the room, not just a slice of it.
    this.camera.fov = w < h ? 78 : 65;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Browsers may give the canvas fewer pixels than asked for: Chrome halves them when graphics
   * memory runs short (a big screen, a room's textures arriving, a resolution change all at once)
   * and caps them on very large screens. three.js keeps drawing at the size it asked for, so only
   * the lower-left part of the picture would fill the screen, as if zoomed in, making everything
   * look bigger and you smaller. Draw at what the browser gave instead, and don't ask for more again.
   */
  private fitDrawingBuffer(w: number, h: number) {
    const gl = this.renderer.getContext();
    const canvas = this.renderer.domElement;
    // A few tries: the smaller canvas gets a new drawing buffer, which could come up short again.
    for (let i = 0; i < 4; i++) {
      const { drawingBufferWidth: bw, drawingBufferHeight: bh } = gl;
      if (bw <= 0 || bh <= 0) return; // the context is lost; it starts over when it's back
      if (bw >= canvas.width && bh >= canvas.height) return;
      this.pixelRatioCap = Math.min(bw / w, bh / h);
      this.renderer.setPixelRatio(this.pixelRatioCap);
    }
  }

  /** Draws this share of the full resolution (never more than the browser has managed). */
  private setResolutionScale(scale: number) {
    this.renderer.setPixelRatio(Math.min(this.fullPixelRatio * scale, this.pixelRatioCap));
    this.resize();
  }

  private setRoom(room: Room | null) {
    if (room?.key === this.room?.key) return;
    this.room = room;
    if (room) this.streamer.focus(room.key);
    this.onRoomChange?.(room);
  }

  private frame() {
    const now = performance.now();
    const dtMs = now - this.last;
    this.last = now;
    if (this.paused) return;
    this.frames.add(dtMs);
    if (this.resolution?.frame(dtMs)) this.setResolutionScale(this.resolution.scale);
    const dt = dtMs / 1000;

    // Wait for the whole place (or as much as this device holds), so nothing loads as you walk.
    if (!this.ready && this.room) {
      const progress = Math.floor(this.streamer.progress() * 100) / 100;
      if (progress !== this.lastProgress) {
        this.lastProgress = progress;
        this.onProgress?.(progress);
      }
      if (this.streamer.complete) {
        this.ready = true;
        this.onReady?.();
      }
    }

    const look = this.input.takeLook();
    this.player.yaw -= look.x;
    this.player.pitch = Math.max(-1.35, Math.min(1.35, this.player.pitch - look.y));

    if (this.landing && this.world.has(this.landing)) this.landing = null;
    if (this.ready && !this.landing && !this.approaching) {
      const move = this.autoWalk() ?? {
        x: this.input.move.x,
        z: this.input.move.z,
        run: this.input.run,
      };
      const caught = this.player.recoveries;
      this.player.update(dt, move, this.world);
      if (this.player.recoveries !== caught) {
        this.walkTarget = null;
        this.teleports++;
      }
    }

    this.camera.position.copy(this.player.eye);
    this.euler.set(this.player.pitch, this.player.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
    this.applyApproach(dtMs);

    const p = this.player.position;
    const here = roomAt(this.manifest, p.x, p.y + 0.1, p.z);
    if (here && here.key !== this.room?.key) this.setRoom(here);
    if (now - this.lastFocus > 1000 && this.room) {
      this.lastFocus = now;
      this.streamer.focus(this.room.key);
    }
    this.checkLift();
    // Rooms far from you are drawn lighter (open-plan places see every room at once).
    this.streamer.look(this.camera.position.x, this.camera.position.y, this.camera.position.z);

    this.avatars.update(dt);
    this.doors.update(dt, [p, ...this.avatars.positions()]);
    this.objects.update(dt);
    // Sound follows your ears: position, facing, and footsteps as you walk.
    const moved = Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z);
    this.lastPos.copy(p);
    const jumped = this.teleports !== this.lastTeleports;
    this.lastTeleports = this.teleports;
    this.audio.update(
      p,
      { x: -Math.sin(this.player.yaw), z: -Math.cos(this.player.yaw) },
      moved,
      jumped,
      this.room,
    );
    // The sun's shadow area follows you, so shadows stay sharp wherever you walk.
    this.sun.target.position.copy(this.player.position);
    this.sun.position.copy(this.player.position).addScaledVector(this.sunDirection, 30);
    this.onFrame?.(dt);
    // Count draw calls across every pass of a frame (the effect passes would reset them).
    this.renderer.info.reset();
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  // ---- Tap to walk -------------------------------------------------------------------------

  /** Walks to the floor point under a screen position (touch devices). Returns false if none. */
  tapToWalk(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const origin = this.camera.position.clone();
    const dir = new Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(origin).normalize();
    const hit = this.world.raycastFloor(origin, dir);
    if (!hit) return false;
    this.walkTarget = hit;
    this.walkStarted = performance.now();
    return true;
  }

  private autoWalk(): { x: number; z: number; run: boolean } | null {
    if (!this.walkTarget) return null;
    const p = this.player.position;
    const dx = this.walkTarget.x - p.x;
    const dz = this.walkTarget.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (this.input.hasManualInput || dist < 0.25 || performance.now() - this.walkStarted > 12_000) {
      this.walkTarget = null;
      return null;
    }
    // Turn smoothly towards the target and walk forward.
    const targetYaw = Math.atan2(-dx, -dz);
    let diff = targetYaw - this.player.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.player.yaw += diff * Math.min(1, 0.15);
    return { x: 0, z: Math.abs(diff) < 1.2 ? Math.min(1, dist) : 0, run: false };
  }

  // ---- Quick travel and lifts --------------------------------------------------------------

  /** Every room you can jump to, grouped by floor (for the quick-travel menu). */
  travelTargets(): TravelTarget[] {
    const floors = new Map(this.manifest.floors.map((f) => [f.key, f]));
    return [...this.manifest.rooms]
      .sort((a, b) => (floors.get(a.floorKey)?.index ?? 0) - (floors.get(b.floorKey)?.index ?? 0))
      .map((r) => ({
        roomKey: r.key,
        roomName: r.name,
        floorKey: r.floorKey,
        floorName: floors.get(r.floorKey)?.name ?? '',
      }));
  }

  /** Jumps to a room: just inside its first doorway, facing in (or its centre). */
  travelTo(roomKey: string) {
    const room = this.manifest.rooms.find((r) => r.key === roomKey);
    if (!room) return;
    const door = room.doorways.find((d) => !d.closed);
    if (door) {
      const [nx, , nz] = door.normal;
      this.player.teleport(
        [door.position[0] - nx * 0.9, door.position[1], door.position[2] - nz * 0.9],
        Math.atan2(nx, nz),
      );
    } else {
      const { min, max } = room.bounds;
      this.player.teleport([(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2]);
    }
    this.walkTarget = null;
    this.teleports++;
    this.landing = room.key;
    this.setRoom(room);
  }

  /** Jumps to an exact spot (used by quick travel, lifts, "go to person" and tests). */
  teleport(position: [number, number, number], yaw?: number) {
    this.player.teleport(position, yaw);
    this.walkTarget = null;
    this.teleports++;
    const room = roomAt(this.manifest, position[0], position[1] + 0.1, position[2]);
    this.landing = room?.key ?? null;
    if (room) this.setRoom(room);
  }

  /** Rides a lift to another stop. */
  rideLift(link: Link, stopIndex: number) {
    const stop = link.stops[stopIndex];
    if (!stop) return;
    this.player.teleport(stop.position, radians(stop.yaw));
    this.walkTarget = null;
    this.teleports++;
    this.landing = stop.roomKey;
    this.setRoom(this.manifest.rooms.find((r) => r.key === stop.roomKey) ?? null);
  }

  private checkLift() {
    const p = this.player.position;
    let found: { link: Link; stop: number } | null = null;
    for (const link of this.manifest.links) {
      link.stops.forEach((s, i) => {
        if (
          Math.hypot(s.position[0] - p.x, s.position[2] - p.z) < 1.1 &&
          Math.abs(s.position[1] - p.y) < 1
        ) {
          found = { link, stop: i };
        }
      });
    }
    const f = found as { link: Link; stop: number } | null;
    if (f?.link.key !== this.lift?.link.key || f?.stop !== this.lift?.stop) {
      this.lift = f;
      this.onLift?.(f?.link ?? null, f?.stop ?? -1);
    }
  }

  // ---- State -------------------------------------------------------------------------------

  /** True once the starting room has loaded and you can move. */
  get isReady() {
    return this.ready;
  }

  /** The room you're standing in. */
  get currentRoom(): Room | null {
    return this.room;
  }

  pose(): Pose {
    const p = this.player.position;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: this.player.yaw,
      roomKey: this.room?.key ?? null,
      moving: Math.hypot(this.player.velocity.x, this.player.velocity.z) > 0.1,
    };
  }

  stats(): ViewerStats {
    const info = this.renderer.info;
    return {
      ...this.streamer.stats(),
      fps: this.frames.fps,
      frameMs: this.frames.average,
      frameMsP50: this.frames.percentile(50),
      frameMsP95: this.frames.percentile(95),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      pixelRatio: this.renderer.getPixelRatio(),
      resolutionScale: this.resolution?.scale ?? 1,
      quality: this.quality,
      ambientOcclusion: !this.gtao ? 'none' : this.gtao.enabled ? 'on' : 'off',
      sunShadows: this.renderer.shadowMap.enabled,
    };
  }

  /**
   * Eases the view a little way towards a point and turns to face it — stepping up to an object
   * before going into what it holds. Resolves when done. `retreat` eases back again.
   */
  approach(target: [number, number, number], seconds = 0.8): Promise<void> {
    this.approachTarget.set(...target);
    return this.animateApproach(1, seconds);
  }

  retreat(seconds = 0.8): Promise<void> {
    return this.animateApproach(0, seconds);
  }

  /** True while stepping up to (or back from) an object; walking waits. */
  get approaching() {
    return this.approachAmount > 0 || this.approachGoal > 0;
  }

  private animateApproach(goal: number, seconds: number): Promise<void> {
    this.approachDone?.();
    this.approachDone = null;
    // Already there (e.g. stepping back when you never stepped up): nothing to wait for.
    if (this.approachAmount === goal) {
      this.approachGoal = goal;
      return Promise.resolve();
    }
    this.approachFrom = this.approachAmount;
    this.approachGoal = goal;
    this.approachElapsed = 0;
    this.approachSeconds = Math.max(0.01, seconds);
    return new Promise((resolve) => {
      this.approachDone = resolve;
    });
  }

  private applyApproach(dtMs: number) {
    if (this.approachAmount === this.approachGoal && this.approachAmount === 0) return;
    if (this.approachAmount !== this.approachGoal) {
      this.approachElapsed += dtMs / 1000;
      const k = Math.min(1, this.approachElapsed / this.approachSeconds);
      const eased = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      this.approachAmount = this.approachFrom + (this.approachGoal - this.approachFrom) * eased;
      if (k >= 1) {
        this.approachAmount = this.approachGoal;
        this.approachDone?.();
        this.approachDone = null;
      }
    }
    const a = this.approachAmount;
    if (a <= 0) return;
    // Move up to 40% of the way (never closer than 0.8 m), turning to look at it.
    const eye = this.camera.position;
    const to = this.approachTarget;
    const distance = eye.distanceTo(to);
    const step = Math.max(0, Math.min(distance * 0.4, distance - 0.8)) * a;
    const look = this.lookHelper.position.copy(eye);
    this.lookHelper.lookAt(to);
    eye.lerp(to, distance > 0 ? step / distance : 0);
    this.camera.quaternion.slerp(this.lookHelper.quaternion, a);
    look.set(0, 0, 0);
  }

  /** Objects that hold creations shimmer gently, so people can tell. */
  setHighlighted(keys: Iterable<string>) {
    this.objects.setHighlighted(keys);
  }

  /** The object under a point on screen (e.g. a click or tap), within reach. */
  pickObject(clientX: number, clientY: number): string | null {
    return this.objects.pick(
      this.camera,
      clientX,
      clientY,
      this.renderer.domElement.getBoundingClientRect(),
    );
  }

  /** The object in the middle of the view (what you're looking at), within reach. */
  lookingAt(): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    return this.objects.pick(this.camera, r.left + r.width / 2, r.top + r.height / 2, r);
  }

  /** Where a point in the space is on screen (client pixels), or null if it's behind you. */
  toScreen(point: [number, number, number]): { x: number; y: number } | null {
    const p = new Vector3(...point).project(this.camera);
    if (p.z > 1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  /** The objects inside a box drawn on screen (client pixels), most covered first. */
  objectsInBox(box: { left: number; top: number; width: number; height: number }): string[] {
    return this.objects.inBox(this.camera, box, this.renderer.domElement.getBoundingClientRect());
  }

  /**
   * A picture of what's on screen (or of a box on it, in client pixels, with a little room around
   * it), as a JPEG. Draws a fresh frame and copies it straight away, before the browser clears it.
   */
  snapshot(
    box?: { left: number; top: number; width: number; height: number },
    maxSize = 1280,
  ): Promise<Blob | null> {
    const canvas = this.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    let [x, y, w, h] = box
      ? [box.left - rect.left, box.top - rect.top, box.width, box.height]
      : [0, 0, rect.width, rect.height];
    if (box) {
      const pad = Math.max(w, h) * 0.2;
      x = Math.max(0, x - pad);
      y = Math.max(0, y - pad);
      w = Math.min(rect.width - x, w + pad * 2);
      h = Math.min(rect.height - y, h + pad * 2);
    }
    const k = Math.min(1, maxSize / Math.max(w * scale, h * scale));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(w * scale * k));
    out.height = Math.max(1, Math.round(h * scale * k));
    if (this.composer) this.composer.render(0);
    else this.renderer.render(this.scene, this.camera);
    out
      .getContext('2d')
      ?.drawImage(canvas, x * scale, y * scale, w * scale, h * scale, 0, 0, out.width, out.height);
    return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.86));
  }

  /** Where an object is (the middle of it), if its room is loaded. */
  objectCenter(key: string): [number, number, number] | null {
    return this.objects.center(key);
  }

  /** Stops rendering entirely (e.g. while a creation is open). */
  pause() {
    this.paused = true;
    this.audio.pause();
  }

  resume() {
    this.paused = false;
    this.last = performance.now();
    this.audio.resume();
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.input.detach();
    this.streamer.dispose();
    this.avatars.dispose();
    this.audio.dispose();
    const land = this.scene.getObjectByName('surroundings');
    if (land) disposeObject(land);
    this.scene.environment?.dispose();
    if (this.scene.background && 'dispose' in this.scene.background)
      this.scene.background.dispose();
    this.gtao?.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    // Let go of the WebGL context now rather than whenever it's collected: browsers allow only a
    // few at once, and phones make a new viewer each time someone comes back from a creation.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

/** Places give facing directions (spawns, lift stops) in degrees; the player turns in radians. */
export const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Blender bakes the light arriving at each surface; three.js divides a basic material's lightmap
 * by π, so π gives the brightness Blender would render. Scaled down so baked walls match the
 * real-time light on furniture and people (which aren't baked).
 */
const LIGHTMAP_GAIN = Math.PI * 0.5;

/** Direction of the brightest point of an equirectangular sky (the sun), or null if unclear. */
function brightestDirection(texture: DataTexture): Vector3 | null {
  const { data, width, height } = texture.image as {
    data: Uint16Array | Float32Array;
    width: number;
    height: number;
  };
  if (!data || !width || !height) return null;
  const half = data instanceof Uint16Array;
  const value = (i: number) => (half ? DataUtils.fromHalfFloat(data[i] ?? 0) : (data[i] ?? 0));
  let best = -1;
  let bestX = 0;
  let bestY = 0;
  // Only the upper half of the image (above the horizon), sampled sparsely.
  for (let y = 0; y < height / 2; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const lum = value(i) * 0.2126 + value(i + 1) * 0.7152 + value(i + 2) * 0.0722;
      if (lum > best) {
        best = lum;
        bestX = x;
        bestY = y;
      }
    }
  }
  if (best <= 0) return null;
  // Row 0 is straight up; longitude follows three.js's equirectangular mapping.
  const lat = (0.5 - bestY / height) * Math.PI;
  const lon = (bestX / width - 0.5) * 2 * Math.PI;
  const dir = new Vector3(
    Math.cos(lat) * Math.cos(lon),
    Math.sin(lat),
    Math.cos(lat) * Math.sin(lon),
  );
  // Keep the sun comfortably above the horizon so it reaches through windows.
  if (dir.y < 0.25) dir.y = 0.25;
  return dir.normalize();
}
