// @vitest-environment happy-dom
import { wrap } from '@allthespaces/bridge-protocol';
import { PerspectiveCamera } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../src/index.ts';

// No WebGL here: a stand-in renderer with a real canvas.
const made = vi.hoisted(() => ({
  renderers: [] as {
    domElement: HTMLCanvasElement;
    setSize: ReturnType<typeof vi.fn>;
    setAnimationLoop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    forceContextLoss: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class StubRenderer {
    domElement = document.createElement('canvas');
    shadowMap = { enabled: false, type: 0 };
    setPixelRatio() {}
    setSize = vi.fn();
    setAnimationLoop = vi.fn();
    dispose = vi.fn();
    forceContextLoss = vi.fn();
    constructor() {
      made.renderers.push(this);
    }
  }
  return { ...three, WebGLRenderer: StubRenderer };
});

const { createStage, FirstPersonRig, OrbitRig } = await import('../src/three.ts');

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** The app (or the stand-in) tells the creation something. */
const tell = (portal: unknown, msg: object) =>
  (portal as { bridge: { deliver: (d: unknown) => void } }).bridge.deliver(wrap(msg));

describe('a stage', () => {
  it('can be put away: loop stopped, canvas gone, listeners off, context released', async () => {
    const portal = await connect();
    const stage = createStage(portal);
    const renderer = made.renderers.at(-1);
    expect(renderer?.domElement.isConnected).toBe(true);
    stage.dispose();
    expect(renderer?.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(renderer?.dispose).toHaveBeenCalled();
    expect(renderer?.forceContextLoss).toHaveBeenCalled();
    expect(renderer?.domElement.isConnected).toBe(false);
    renderer?.setSize.mockClear();
    window.dispatchEvent(new Event('resize'));
    tell(portal, {
      type: 'viewport',
      data: { width: 400, height: 800, orientation: 'portrait', dpr: 2, touch: true },
    });
    expect(renderer?.setSize).not.toHaveBeenCalled();
  });
});

describe('camera rigs', () => {
  const drag = (target: EventTarget, from: number, to: number) => {
    target.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: from, clientY: 0, bubbles: true }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: to, clientY: 0 }),
    );
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
  };

  it('stop listening once disposed (no stray handlers from an old scene)', async () => {
    const portal = await connect();
    const canvas = document.body.appendChild(document.createElement('canvas'));
    const orbit = new OrbitRig(new PerspectiveCamera());
    const before = orbit.azimuth;
    orbit.dispose();
    drag(canvas, 0, 100);
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 500 }));
    expect(orbit.azimuth).toBe(before);
    expect(orbit.distance).toBe(5);

    const walk = new FirstPersonRig(portal, new PerspectiveCamera());
    walk.dispose();
    drag(canvas, 0, 100);
    expect(walk.yaw).toBe(0);
  });

  it('still turn while in use', async () => {
    await connect();
    const canvas = document.body.appendChild(document.createElement('canvas'));
    const orbit = new OrbitRig(new PerspectiveCamera());
    const before = orbit.azimuth;
    drag(canvas, 0, 100);
    expect(orbit.azimuth).not.toBe(before);
    orbit.dispose();
  });
});

describe('measuring smoothness', () => {
  it("doesn't keep a frame loop going while the app pauses the creation", async () => {
    const queued = new Set<number>();
    let next = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++next;
      queued.add(id);
      void cb;
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => queued.delete(id));
    const portal = await connect();
    const before = queued.size;
    expect(before).toBeGreaterThan(0);
    tell(portal, { type: 'pause' });
    expect(queued.size).toBe(before - 1);
    tell(portal, { type: 'resume' });
    expect(queued.size).toBe(before);
  });
});
