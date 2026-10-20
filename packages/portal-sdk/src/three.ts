/**
 * @allthespaces/portal/three — optional helpers for creations made with three.js. Nothing
 * here is required; a creation can use any rendering it likes (or none).
 */
import {
  AgXToneMapping,
  Euler,
  PCFShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Portal } from './portal.ts';
import { ResolutionGovernor } from './resolution.ts';

/**
 * Loading (compiling shaders, decoding sound, building the first scene) makes frames slow for a
 * while on any device. Dynamic resolution judges frames only from this long after the creation
 * says it's ready (or the stage is made, if later), so it doesn't start a visit blurry and spend
 * a minute or more climbing back.
 */
const SETTLE_AFTER_READY_MS = 5000;
/** For a creation that never calls `ready()`: frames are judged from this long after the stage. */
const SETTLE_WITHOUT_READY_MS = 20000;

export interface Stage {
  renderer: WebGLRenderer;
  camera: PerspectiveCamera;
  /** Runs `frame` every animation frame (seconds since the last), paused while the app pauses you. */
  loop: (frame: (dt: number) => void) => void;
  /** Dynamic resolution (its `scale` is the share of full resolution drawn now). */
  resolution: ResolutionGovernor;
  /** Stops the loop, removes the canvas and its listeners, and lets go of the WebGL context. */
  dispose: () => void;
}

/**
 * A renderer that fills the screen, sized for this device (lighter on low-powered ones), and
 * follows the screen as it turns or resizes. With `dynamicResolution` (on unless turned off) it
 * draws fewer pixels while frames are slow, so it keeps moving smoothly.
 */
export function createStage(
  portal: Portal,
  options: {
    fov?: number;
    shadows?: boolean;
    antialias?: boolean;
    dynamicResolution?: boolean;
  } = {},
): Stage {
  const resolution = new ResolutionGovernor({ min: portal.tier === 'low' ? 0.5 : 0.6 });
  const low = portal.tier === 'low';
  const renderer = new WebGLRenderer({
    antialias: options.antialias ?? !low,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = AgXToneMapping;
  renderer.shadowMap.enabled = (options.shadows ?? true) && !low;
  renderer.shadowMap.type = PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none';
  document.body.style.margin = '0';
  document.body.append(canvas);
  const camera = new PerspectiveCamera(options.fov ?? 60, 1, 0.05, 500);
  const resize = () => {
    const w = innerWidth;
    const h = innerHeight;
    const full = Math.min(devicePixelRatio, low ? 1 : portal.tier === 'mid' ? 1.5 : 2);
    renderer.setPixelRatio(full * resolution.scale);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep roughly the same view in portrait by widening the field of view.
    camera.fov = w < h ? Math.min(90, (options.fov ?? 60) * 1.3) : (options.fov ?? 60);
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  const offViewport = portal.onViewport(resize);
  resize();

  const made = performance.now();
  /** Whether frames count for dynamic resolution yet: not while the creation is still loading. */
  const settled = (now: number) =>
    (portal.readyAt !== null && now >= Math.max(portal.readyAt, made) + SETTLE_AFTER_READY_MS) ||
    now >= made + SETTLE_WITHOUT_READY_MS;

  let paused = false;
  const offPause = portal.on('pause', () => {
    paused = true;
  });
  const offResume = portal.on('resume', () => {
    paused = false;
  });
  const loop: Stage['loop'] = (frame) => {
    let last = performance.now();
    renderer.setAnimationLoop((now) => {
      const ms = now - last;
      const dt = Math.min(0.1, ms / 1000);
      last = now;
      if (paused) return;
      // Resize before drawing: resizing the canvas wipes it, so after `frame` it would leave a
      // black frame on screen until the next one.
      if (options.dynamicResolution !== false && settled(now) && resolution.frame(ms, now))
        resize();
      frame(dt);
    });
  };
  const dispose = () => {
    renderer.setAnimationLoop(null);
    removeEventListener('resize', resize);
    offViewport();
    offPause();
    offResume();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
  return { renderer, camera, loop, resolution, dispose };
}

/** A glTF loader ready for compressed (meshopt) models. */
export function gltfLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}

/**
 * Walk around at eye height: the first stick you defined moves you (keyboard, gamepad or the
 * on-screen joystick); drag, or click to capture the mouse, to look around.
 */
export class FirstPersonRig {
  readonly position: Vector3;
  yaw = 0;
  pitch = 0;
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private dragging: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private readonly listening = new AbortController();

  constructor(
    private readonly portal: Portal,
    private readonly camera: PerspectiveCamera,
    private readonly options: {
      stick?: string;
      speed?: number;
      eyeHeight?: number;
      start?: Vector3;
    } = {},
  ) {
    this.position = options.start?.clone() ?? new Vector3();
    const canvas = document.querySelector('canvas') ?? document.body;
    const { signal } = this.listening;
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        const el = e.target as HTMLElement;
        if (el.closest('.ats-touch-stick, .ats-touch-button')) return;
        if (e.pointerType === 'mouse' && !portal.viewport.touch) {
          void (canvas as HTMLElement).requestPointerLock?.();
          return;
        }
        this.dragging = e.pointerId;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      },
      { signal },
    );
    addEventListener(
      'pointermove',
      (e) => {
        if (document.pointerLockElement) {
          this.turn(e.movementX * 0.0025, e.movementY * 0.0025);
        } else if (this.dragging === e.pointerId) {
          this.turn((e.clientX - this.lastX) * 0.005, (e.clientY - this.lastY) * 0.005);
          this.lastX = e.clientX;
          this.lastY = e.clientY;
        }
      },
      { signal },
    );
    const end = (e: PointerEvent) => {
      if (this.dragging === e.pointerId) this.dragging = null;
    };
    addEventListener('pointerup', end, { signal });
    addEventListener('pointercancel', end, { signal });
  }

  /** Stops listening to the pointer (when you replace the rig, or leave the scene). */
  dispose() {
    this.listening.abort();
    this.dragging = null;
  }

  private turn(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch - dy));
  }

  update(dt: number) {
    const move = this.portal.input.stick(this.options.stick ?? 'move');
    const speed = (this.options.speed ?? 2.2) * dt;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.position.x += (move.x * cos - move.y * sin) * speed;
    this.position.z += (-move.x * sin - move.y * cos) * speed;
    this.camera.position.set(
      this.position.x,
      this.position.y + (this.options.eyeHeight ?? 1.6),
      this.position.z,
    );
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
  }
}

/** Circle around something: drag to orbit, pinch or scroll to zoom. */
export class OrbitRig {
  azimuth = 0.6;
  elevation = 0.5;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private readonly listening = new AbortController();

  constructor(
    private readonly camera: PerspectiveCamera,
    readonly target = new Vector3(),
    public distance = 5,
    private readonly limits: { min?: number; max?: number } = {},
  ) {
    const canvas = document.querySelector('canvas') ?? document.body;
    const { signal } = this.listening;
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      },
      { signal },
    );
    addEventListener(
      'pointermove',
      (e) => {
        const p = this.pointers.get(e.pointerId);
        if (!p) return;
        if (this.pointers.size === 1) {
          this.azimuth -= (e.clientX - p.x) * 0.006;
          this.elevation = Math.max(
            -1.2,
            Math.min(1.4, this.elevation + (e.clientY - p.y) * 0.006),
          );
        }
        p.x = e.clientX;
        p.y = e.clientY;
        if (this.pointers.size === 2) {
          const [a, b] = [...this.pointers.values()] as [
            { x: number; y: number },
            { x: number; y: number },
          ];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (this.pinch) this.zoom(this.pinch / d);
          this.pinch = d;
        }
      },
      { signal },
    );
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.pinch = 0;
    };
    addEventListener('pointerup', end, { signal });
    addEventListener('pointercancel', end, { signal });
    addEventListener('wheel', (e) => this.zoom(Math.exp(e.deltaY * 0.001)), {
      passive: true,
      signal,
    });
  }

  /** Stops listening to the pointer and the wheel (when you replace the rig, or leave the scene). */
  dispose() {
    this.listening.abort();
    this.pointers.clear();
  }

  private zoom(factor: number) {
    this.distance = Math.max(
      this.limits.min ?? 0.5,
      Math.min(this.limits.max ?? 50, this.distance * factor),
    );
  }

  update() {
    const c = Math.cos(this.elevation);
    this.camera.position.set(
      this.target.x + Math.sin(this.azimuth) * c * this.distance,
      this.target.y + Math.sin(this.elevation) * this.distance,
      this.target.z + Math.cos(this.azimuth) * c * this.distance,
    );
    this.camera.lookAt(this.target);
  }
}
