import type { SpaceManifest } from '@ats/space-format';
import { DataTexture, Texture } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No WebGL here: a stand-in renderer records what the viewer asks of it.
const stub = vi.hoisted(() => ({
  renderers: [] as {
    dispose: ReturnType<typeof vi.fn>;
    forceContextLoss: ReturnType<typeof vi.fn>;
  }[],
  hdr: null as ((texture: unknown) => void) | null,
  /** The drawing buffer the "browser" gives for a canvas size (browsers may give less). */
  grant: (w: number, h: number): [number, number] => [w, h],
}));

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class StubRenderer {
    domElement = {
      style: {} as Record<string, string>,
      width: 300,
      height: 150,
      addEventListener: () => {},
      removeEventListener: () => {},
      remove: vi.fn(),
    };
    gl = { drawingBufferWidth: 300, drawingBufferHeight: 150 };
    private pixelRatio = 1;
    private size = [300, 150] as [number, number];
    shadowMap = { enabled: false, type: 0 };
    info = { autoReset: true };
    dispose = vi.fn();
    forceContextLoss = vi.fn();
    constructor() {
      stub.renderers.push(this);
    }
    // Like WebGLRenderer: the canvas is the size times the pixel ratio, and resizing the canvas
    // gets it a new drawing buffer.
    setPixelRatio(ratio: number) {
      this.pixelRatio = ratio;
      this.setSize(...this.size);
    }
    getPixelRatio() {
      return this.pixelRatio;
    }
    setSize(w: number, h: number) {
      this.size = [w, h];
      this.domElement.width = Math.floor(w * this.pixelRatio);
      this.domElement.height = Math.floor(h * this.pixelRatio);
      [this.gl.drawingBufferWidth, this.gl.drawingBufferHeight] = stub.grant(
        this.domElement.width,
        this.domElement.height,
      );
    }
    getContext() {
      return this.gl;
    }
    setAnimationLoop() {}
    compileAsync() {
      return Promise.resolve();
    }
  }
  class StubPMREM {
    fromScene() {
      return { texture: new three.Texture() };
    }
    fromEquirectangular() {
      return { texture: new three.Texture() };
    }
    dispose() {}
  }
  return { ...three, WebGLRenderer: StubRenderer, PMREMGenerator: StubPMREM };
});

vi.mock('three/examples/jsm/loaders/HDRLoader.js', () => ({
  HDRLoader: class {
    setDataType() {
      return this;
    }
    load(_url: string, onLoad: (texture: unknown) => void) {
      stub.hdr = onLoad;
    }
  },
}));

const { SpaceViewer } = await import('../src/viewer.ts');

const manifest = (hdri = false) =>
  ({
    name: 'Empty',
    floors: [{ key: 'ground', name: 'Ground', elevation: 0 }],
    rooms: [],
    spawns: [],
    links: [],
    lighting: {
      sky: '#dfe8ef',
      ground: '#c8c4b1',
      sunDirection: [0.4, 1, 0.3],
      exposure: 1,
      ...(hdri ? { hdri: { path: 'sky.hdr' } } : {}),
    },
  }) as unknown as SpaceManifest;

const container = (clientWidth = 400, clientHeight = 300) =>
  ({ appendChild: () => {}, clientWidth, clientHeight }) as unknown as HTMLElement;

beforeEach(() => {
  stub.renderers.length = 0;
  stub.hdr = null;
  stub.grant = (w, h) => [w, h];
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
      setTimeout,
      clearTimeout,
    }),
  );
  vi.stubGlobal('document', Object.assign(new EventTarget(), { pointerLockElement: null }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('closing the viewer', () => {
  it('gives its WebGL context back straight away', () => {
    const viewer = new SpaceViewer(container(), {
      manifest: manifest(),
      baseUrl: 'http://x/',
      touch: true,
    });
    const renderer = stub.renderers[0];
    viewer.dispose();
    expect(renderer?.dispose).toHaveBeenCalled();
    expect(renderer?.forceContextLoss).toHaveBeenCalledOnce();
  });

  it('frees the studio lighting it was lit from', () => {
    const freed = vi.spyOn(RoomEnvironment.prototype, 'dispose');
    const viewer = new SpaceViewer(container(), {
      manifest: manifest(),
      baseUrl: 'http://x/',
      touch: true,
    });
    expect(freed).toHaveBeenCalledOnce();
    viewer.dispose();
  });

  it('frees a sky that arrives after it closed, instead of showing it', () => {
    const viewer = new SpaceViewer(container(), {
      manifest: manifest(true),
      baseUrl: 'http://x/',
      touch: true,
    });
    viewer.dispose();
    const sky = new DataTexture(new Float32Array(4 * 4 * 4), 4, 1);
    const freed = vi.spyOn(sky, 'dispose');
    stub.hdr?.(sky);
    expect(freed).toHaveBeenCalledOnce();
    expect(viewer.scene.background).not.toBe(sky);
    expect(viewer.scene.environment).not.toBeInstanceOf(Texture);
  });
});

describe('drawing at the size the browser gives', () => {
  // What the viewer draws into, from the canvas through every effect pass.
  const sizes = (viewer: InstanceType<typeof SpaceViewer>) => {
    const v = viewer as unknown as {
      composer: { renderTarget1: { width: number; height: number } } | null;
      gtao: { width: number; height: number } | null;
    };
    const canvas = viewer.renderer.domElement;
    const gl = viewer.renderer.getContext();
    return {
      canvas: [canvas.width, canvas.height],
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      effects: [v.composer?.renderTarget1.width, v.composer?.renderTarget1.height],
      ambientOcclusion: [v.gtao?.width, v.gtao?.height],
    };
  };
  const open = () =>
    new SpaceViewer(container(2560, 1440), {
      manifest: manifest(),
      baseUrl: 'http://x/',
      quality: 'high',
    });

  it('draws everything at the full size when the browser gives it', () => {
    const viewer = open();
    expect(sizes(viewer)).toEqual({
      canvas: [2560, 1440],
      drawingBuffer: [2560, 1440],
      effects: [2560, 1440],
      ambientOcclusion: [2560, 1440],
    });
    viewer.dispose();
  });

  it('draws at the smaller size when the browser gives the canvas fewer pixels', () => {
    // Chrome halves the drawing buffer when graphics memory runs short. Drawing at the size asked
    // for would fill the screen with only the lower-left quarter of the picture (zoomed in 2x).
    stub.grant = (w, h) => [Math.min(w, 1280), Math.min(h, 720)];
    const viewer = open();
    expect(viewer.renderer.getPixelRatio()).toBe(0.5);
    expect(sizes(viewer)).toEqual({
      canvas: [1280, 720],
      drawingBuffer: [1280, 720],
      effects: [1280, 720],
      ambientOcclusion: [1280, 720],
    });
    expect(viewer.camera.aspect).toBeCloseTo(2560 / 1440);
    viewer.dispose();
  });

  it('notices when a resolution change mid-walk comes up short, and asks no higher again', () => {
    const viewer = open();
    const projection = viewer.camera.projectionMatrix.clone();
    const setScale = (scale: number) =>
      (viewer as unknown as { setResolutionScale(s: number): void }).setResolutionScale(scale);
    // Frames got slow (a heavy room): dynamic resolution draws fewer pixels, but graphics memory
    // is short and the new drawing buffer comes out smaller still.
    stub.grant = (w, h) => [Math.min(w, 1088), Math.min(h, 612)];
    setScale(0.85);
    expect(sizes(viewer)).toEqual({
      canvas: [1088, 612],
      drawingBuffer: [1088, 612],
      effects: [1088, 612],
      ambientOcclusion: [1088, 612],
    });
    // What's on screen is unchanged: only sharpness changes.
    expect(viewer.camera.projectionMatrix.equals(projection)).toBe(true);
    // Smooth again: going back up stops at what the browser could give.
    stub.grant = (w, h) => [w, h];
    setScale(1);
    expect(sizes(viewer).canvas).toEqual([1088, 612]);
    expect(viewer.camera.projectionMatrix.equals(projection)).toBe(true);
    viewer.dispose();
  });
});
