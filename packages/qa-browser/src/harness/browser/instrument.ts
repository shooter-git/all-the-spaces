/**
 * Runs inside the creation's frame during QA, before anything else. It watches, without
 * changing behaviour: draw calls and triangles per frame, GPU memory (textures, geometry, render
 * targets), sounds playing and where they go, loudness, errors, blocked requests, memory and
 * frame times. The QA runner reads it with `window.__qa.snapshot()`.
 */

interface FrameStats {
  calls: number;
  triangles: number;
}

const OUTPUT_TAG = Symbol.for('allthespaces.audio.output');
const MAX_SAMPLES = 20_000;

const state = {
  frames: [] as FrameStats[],
  frameMs: [] as number[],
  current: { calls: 0, triangles: 0 },
  textureBytes: 0,
  textureMax: 0,
  bufferBytes: 0,
  renderbufferBytes: 0,
  drawingBufferBytes: 0,
  gpuMax: 0,
  voices: 0,
  voicesMax: 0,
  directToSpeakers: 0,
  peak: 0,
  clippedMoments: 0,
  heapMax: 0,
  errors: [] as string[],
  blocked: [] as { what: string; directive: string }[],
  contexts: 0,
};

const pushError = (text: string) => {
  if (state.errors.length < 50) state.errors.push(text.slice(0, 300));
};

// ---- Frames -----------------------------------------------------------------------------------
let last = 0;
const onFrame = (now: number) => {
  requestAnimationFrame(onFrame);
  if (state.current.calls > 0 && state.frames.length < MAX_SAMPLES)
    state.frames.push(state.current);
  state.current = { calls: 0, triangles: 0 };
  if (last && state.frameMs.length < MAX_SAMPLES) state.frameMs.push(now - last);
  last = now;
};
requestAnimationFrame(onFrame);

// ---- WebGL ------------------------------------------------------------------------------------
const TRIANGLES = 4;
const STRIP = 5;
const FAN = 6;
const trianglesOf = (mode: number, count: number, instances = 1) =>
  (mode === TRIANGLES
    ? Math.floor(count / 3)
    : mode === STRIP || mode === FAN
      ? Math.max(0, count - 2)
      : 0) * instances;
const draw = (mode: number, count: number, instances = 1) => {
  state.current.calls++;
  state.current.triangles += trianglesOf(mode, count, instances);
};

type Proto = Record<string, unknown>;
function wrap(proto: Proto, name: string, before: (args: unknown[], self: unknown) => void) {
  const original = proto[name];
  if (typeof original !== 'function') return;
  proto[name] = function (this: unknown, ...args: unknown[]) {
    try {
      before(args, this);
    } catch {}
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
}

// Bytes per pixel for the texture and render buffer formats three.js and others use.
const BPP: Record<number, number> = {
  33321: 1,
  33323: 2,
  32849: 4,
  32856: 4,
  35907: 4,
  35905: 4,
  33325: 2,
  33327: 4,
  34842: 8,
  34843: 8,
  33326: 4,
  33328: 8,
  34836: 16,
  34837: 16,
  35898: 4,
  35901: 4,
  33189: 2,
  33190: 4,
  36012: 4,
  35056: 4,
  36013: 8,
  36168: 1,
  6409: 1,
  6410: 2,
  6407: 4,
  6408: 4,
  6402: 4,
  34041: 4,
  36194: 2,
  32854: 2,
  32855: 2,
};
const bppOf = (internalFormat: number, type?: number) => {
  if (internalFormat === 0x1908 || internalFormat === 0x1907) {
    if (type === 0x1406) return 16; // FLOAT
    if (type === 0x140b || type === 0x8d61) return 8; // HALF_FLOAT
  }
  return BPP[internalFormat] ?? 4;
};

const textures = new WeakMap<object, Map<string, number>>();
const buffers = new WeakMap<object, number>();
const renderbuffers = new WeakMap<object, number>();
const boundTexture = new WeakMap<object, Map<string, object | null>>();
const activeUnit = new WeakMap<object, number>();
const boundBuffer = new WeakMap<object, Map<number, object | null>>();
const boundRenderbuffer = new WeakMap<object, object | null>();

const CUBE = 0x8513;
const targetOf = (target: number) => (target >= 0x8515 && target <= 0x851a ? CUBE : target);
const textureFor = (gl: object, target: number) =>
  boundTexture.get(gl)?.get(`${activeUnit.get(gl) ?? 0}:${targetOf(target)}`) ?? null;

const setLevel = (tex: object | null, key: string, bytes: number) => {
  if (!tex) return;
  let levels = textures.get(tex);
  if (!levels) {
    levels = new Map();
    textures.set(tex, levels);
  }
  state.textureBytes += bytes - (levels.get(key) ?? 0);
  levels.set(key, bytes);
  state.textureMax = Math.max(state.textureMax, state.textureBytes);
  trackGpu();
};
const trackGpu = () => {
  state.gpuMax = Math.max(
    state.gpuMax,
    state.textureBytes + state.bufferBytes + state.renderbufferBytes + state.drawingBufferBytes,
  );
};

const sizeOfSource = (src: unknown): [number, number] => {
  const s = src as {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  if (s?.videoWidth) return [s.videoWidth, s.videoHeight ?? 0];
  if (s?.naturalWidth) return [s.naturalWidth, s.naturalHeight ?? 0];
  return [s?.width ?? 0, s?.height ?? 0];
};

for (const ctor of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
  if (!ctor) continue;
  const p = ctor.prototype as unknown as Proto;
  wrap(p, 'drawArrays', ([mode, , count]) => draw(mode as number, count as number));
  wrap(p, 'drawElements', ([mode, count]) => draw(mode as number, count as number));
  wrap(p, 'drawArraysInstanced', ([mode, , count, n]) =>
    draw(mode as number, count as number, n as number),
  );
  wrap(p, 'drawElementsInstanced', ([mode, count, , , n]) =>
    draw(mode as number, count as number, n as number),
  );
  wrap(p, 'drawRangeElements', ([mode, , , count]) => draw(mode as number, count as number));
  wrap(p, 'activeTexture', ([unit], gl) => activeUnit.set(gl as object, (unit as number) - 0x84c0));
  wrap(p, 'bindTexture', ([target, tex], gl) => {
    let m = boundTexture.get(gl as object);
    if (!m) {
      m = new Map();
      boundTexture.set(gl as object, m);
    }
    m.set(`${activeUnit.get(gl as object) ?? 0}:${target}`, (tex as object) ?? null);
  });
  wrap(p, 'texImage2D', (a, gl) => {
    const [target, level, internalFormat] = a as number[];
    let w: number;
    let h: number;
    let type: number | undefined;
    if (a.length >= 8) {
      w = a[3] as number;
      h = a[4] as number;
      type = a[7] as number;
    } else {
      [w, h] = sizeOfSource(a[5]);
      type = a[4] as number;
    }
    setLevel(
      textureFor(gl as object, target as number),
      `${target}:${level}`,
      w * h * bppOf(internalFormat as number, type),
    );
  });
  wrap(p, 'texImage3D', (a, gl) => {
    const [target, level, internalFormat, w, h, d, , , type] = a as number[];
    setLevel(
      textureFor(gl as object, target as number),
      `${target}:${level}`,
      (w as number) * (h as number) * (d as number) * bppOf(internalFormat as number, type),
    );
  });
  wrap(p, 'texStorage2D', (a, gl) => {
    const [target, levels, internalFormat, w, h] = a as number[];
    let bytes = 0;
    for (let l = 0; l < (levels as number); l++)
      bytes +=
        Math.max(1, (w as number) >> l) *
        Math.max(1, (h as number) >> l) *
        bppOf(internalFormat as number);
    setLevel(
      textureFor(gl as object, target as number),
      'storage',
      target === CUBE ? bytes * 6 : bytes,
    );
  });
  wrap(p, 'texStorage3D', (a, gl) => {
    const [target, levels, internalFormat, w, h, d] = a as number[];
    let bytes = 0;
    for (let l = 0; l < (levels as number); l++)
      bytes +=
        Math.max(1, (w as number) >> l) *
        Math.max(1, (h as number) >> l) *
        (d as number) *
        bppOf(internalFormat as number);
    setLevel(textureFor(gl as object, target as number), 'storage', bytes);
  });
  wrap(p, 'compressedTexImage2D', (a, gl) => {
    const [target, level] = a as number[];
    const data = a[6] as ArrayBufferView | number;
    setLevel(
      textureFor(gl as object, target as number),
      `${target}:${level}`,
      typeof data === 'number' ? data : (data?.byteLength ?? 0),
    );
  });
  wrap(p, 'copyTexImage2D', (a, gl) => {
    const [target, level, internalFormat, , , w, h] = a as number[];
    setLevel(
      textureFor(gl as object, target as number),
      `${target}:${level}`,
      (w as number) * (h as number) * bppOf(internalFormat as number),
    );
  });
  wrap(p, 'generateMipmap', ([target], gl) => {
    const tex = textureFor(gl as object, target as number);
    const levels = tex && textures.get(tex);
    const base = levels ? [...levels.entries()].filter(([k]) => k.endsWith(':0')) : [];
    for (const [k, v] of base) setLevel(tex, `${k}:mips`, Math.round(v / 3));
  });
  wrap(p, 'deleteTexture', ([tex]) => {
    const levels = tex ? textures.get(tex as object) : undefined;
    if (!levels) return;
    for (const v of levels.values()) state.textureBytes -= v;
    textures.delete(tex as object);
  });
  wrap(p, 'bindBuffer', ([target, buf], gl) => {
    let m = boundBuffer.get(gl as object);
    if (!m) {
      m = new Map();
      boundBuffer.set(gl as object, m);
    }
    m.set(target as number, (buf as object) ?? null);
  });
  wrap(p, 'bufferData', ([target, data], gl) => {
    const buf = boundBuffer.get(gl as object)?.get(target as number);
    if (!buf) return;
    const bytes = typeof data === 'number' ? data : ((data as ArrayBufferView)?.byteLength ?? 0);
    state.bufferBytes += bytes - (buffers.get(buf) ?? 0);
    buffers.set(buf, bytes);
    trackGpu();
  });
  wrap(p, 'deleteBuffer', ([buf]) => {
    if (!buf) return;
    state.bufferBytes -= buffers.get(buf as object) ?? 0;
    buffers.delete(buf as object);
  });
  wrap(p, 'bindRenderbuffer', ([, rb], gl) =>
    boundRenderbuffer.set(gl as object, (rb as object) ?? null),
  );
  const storage = (gl: object, internalFormat: number, w: number, h: number, samples = 1) => {
    const rb = boundRenderbuffer.get(gl);
    if (!rb) return;
    const bytes = w * h * bppOf(internalFormat) * Math.max(1, samples);
    state.renderbufferBytes += bytes - (renderbuffers.get(rb) ?? 0);
    renderbuffers.set(rb, bytes);
    trackGpu();
  };
  wrap(p, 'renderbufferStorage', ([, f, w, h], gl) =>
    storage(gl as object, f as number, w as number, h as number),
  );
  wrap(p, 'renderbufferStorageMultisample', ([, s, f, w, h], gl) =>
    storage(gl as object, f as number, w as number, h as number, s as number),
  );
  // Instancing and multi-draw extensions (WebGL 1 instancing; BatchedMesh uses multi-draw).
  const getExtension = p.getExtension as (this: unknown, name: string) => unknown;
  p.getExtension = function (this: unknown, name: string) {
    const ext = getExtension.call(this, name) as Proto | null;
    if (ext && !(ext as { __qa?: boolean }).__qa) {
      (ext as { __qa?: boolean }).__qa = true;
      if (name === 'ANGLE_instanced_arrays') {
        wrap(ext, 'drawArraysInstancedANGLE', ([m, , c, n]) =>
          draw(m as number, c as number, n as number),
        );
        wrap(ext, 'drawElementsInstancedANGLE', ([m, c, , , n]) =>
          draw(m as number, c as number, n as number),
        );
      }
      if (name === 'WEBGL_multi_draw') {
        const sum = (list: unknown, offset: unknown, n: unknown) => {
          let t = 0;
          const l = list as ArrayLike<number>;
          for (let i = 0; i < (n as number); i++) t += l[(offset as number) + i] ?? 0;
          return t;
        };
        wrap(ext, 'multiDrawArraysWEBGL', ([m, , , counts, co, n]) =>
          draw(m as number, sum(counts, co, n)),
        );
        wrap(ext, 'multiDrawElementsWEBGL', ([m, counts, co, , , , n]) =>
          draw(m as number, sum(counts, co, n)),
        );
      }
    }
    return ext;
  };
}

// The canvas's own drawing buffers (front and back, plus multisampling and depth).
const getContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement,
  kind: string,
  options?: unknown,
) {
  const ctx = (getContext as (this: HTMLCanvasElement, k: string, o?: unknown) => unknown).call(
    this,
    kind,
    options,
  );
  if (ctx && /webgl/.test(kind)) {
    state.contexts++;
    const gl = ctx as WebGLRenderingContext;
    const measure = () => {
      const attrs = gl.getContextAttributes();
      const samples = attrs?.antialias ? 4 : 1;
      state.drawingBufferBytes =
        gl.drawingBufferWidth * gl.drawingBufferHeight * (4 * 2 + 4 * samples);
      trackGpu();
    };
    measure();
    new ResizeObserver(measure).observe(this);
  }
  return ctx;
} as typeof HTMLCanvasElement.prototype.getContext;

// ---- Sound ------------------------------------------------------------------------------------
const meters = new WeakMap<BaseAudioContext, AnalyserNode>();
const connect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => unknown;
const meterFor = (ctx: BaseAudioContext) => {
  let m = meters.get(ctx);
  if (!m) {
    m = ctx.createAnalyser();
    m.fftSize = 2048;
    connect.call(m, ctx.destination);
    meters.set(ctx, m);
    const buf = new Float32Array(m.fftSize);
    const meter = m;
    setInterval(() => {
      meter.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      state.peak = Math.max(state.peak, peak);
      if (peak >= 0.999) state.clippedMoments++;
    }, 100);
  }
  return m;
};
AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
  const dest = args[0];
  if (dest instanceof AudioDestinationNode) {
    if (!(this as unknown as Record<symbol, unknown>)[OUTPUT_TAG]) state.directToSpeakers++;
    args[0] = meterFor(this.context);
  }
  return connect.apply(this, args);
} as typeof AudioNode.prototype.connect;
// Buffer sources have their own start(); oscillators and constant sources use the shared one.
for (const proto of [AudioScheduledSourceNode.prototype, AudioBufferSourceNode.prototype]) {
  if (!Object.hasOwn(proto, 'start')) continue;
  const start = proto.start as (this: AudioScheduledSourceNode, ...a: unknown[]) => void;
  proto.start = function (this: AudioScheduledSourceNode, ...args: unknown[]) {
    state.voices++;
    state.voicesMax = Math.max(state.voicesMax, state.voices);
    this.addEventListener('ended', () => state.voices--, { once: true });
    return start.apply(this, args);
  };
}

// ---- Errors, blocked requests, memory ---------------------------------------------------------
addEventListener(
  'error',
  (e) => {
    const el = e.target as HTMLElement & { src?: string; href?: string };
    if (el && el !== (window as unknown) && (el.src || el.href))
      pushError(`Couldn't load ${el.src || el.href}`);
    else pushError(e.message || 'Error');
  },
  true,
);
addEventListener('unhandledrejection', (e) =>
  pushError(`Unhandled: ${String((e.reason as Error)?.message ?? e.reason)}`),
);
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  pushError(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  consoleError.apply(console, args);
};
document.addEventListener('securitypolicyviolation', (e) => {
  if (state.blocked.length < 50)
    state.blocked.push({
      what: e.blockedURI || e.violatedDirective,
      directive: e.effectiveDirective,
    });
});
setInterval(() => {
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  if (heap) state.heapMax = Math.max(state.heapMax, heap.usedJSHeapSize);
}, 250);

// ---- For the runner ---------------------------------------------------------------------------
const pct = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

const outside = (r: DOMRect) =>
  r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1 || r.top < -1;

/** Inside an element that scrolls (and has more than it shows), which is itself on screen. */
const scrolledInto = (el: Element) => {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    const scrollsY =
      ['auto', 'scroll'].includes(s.overflowY) && p.scrollHeight > p.clientHeight + 1;
    const scrollsX = ['auto', 'scroll'].includes(s.overflowX) && p.scrollWidth > p.clientWidth + 1;
    if (scrollsY || scrollsX) return !outside(p.getBoundingClientRect());
  }
  return false;
};

const labelOf = (el: Element) =>
  (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.tagName.toLowerCase())
    .trim()
    .slice(0, 40);

(window as unknown as { __qa: unknown }).__qa = {
  /** Starts a fresh measurement (after loading, so start-up spikes don't count as steady state). */
  reset() {
    state.frames = [];
    state.frameMs = [];
  },
  snapshot() {
    return {
      drawCalls: {
        p95: pct(
          state.frames.map((f) => f.calls),
          0.95,
        ),
        max: Math.max(0, ...state.frames.map((f) => f.calls)),
      },
      triangles: {
        p95: pct(
          state.frames.map((f) => f.triangles),
          0.95,
        ),
        max: Math.max(0, ...state.frames.map((f) => f.triangles)),
      },
      frameMs: { p50: pct(state.frameMs, 0.5), p95: pct(state.frameMs, 0.95) },
      frames: state.frameMs.length,
      textureBytes: state.textureMax,
      gpuBytes: state.gpuMax,
      voices: state.voicesMax,
      directToSpeakers: state.directToSpeakers,
      peak: state.peak,
      clippedMoments: state.clippedMoments,
      heapBytes: state.heapMax,
      errors: [...state.errors],
      blocked: [...state.blocked],
      contexts: state.contexts,
    };
  },
  /** How the page fits the screen: overflow, tiny touch targets, things cut off or under the app's buttons. */
  layout(touch: boolean, appButtons: { x: number; y: number; w: number; h: number }[]) {
    const root = document.scrollingElement ?? document.documentElement;
    const style = getComputedStyle(document.body);
    const scrolls = (axis: 'x' | 'y') =>
      !['hidden', 'clip'].includes(axis === 'x' ? style.overflowX : style.overflowY);
    const out = {
      overflowX: root.scrollWidth > innerWidth + 1 && scrolls('x'),
      overflowY: root.scrollHeight > innerHeight + 1 && scrolls('y'),
      small: [] as { label: string; w: number; h: number }[],
      cutOff: [] as string[],
      underApp: [] as string[],
    };
    const interactive = document.querySelectorAll(
      'button, a[href], input, select, textarea, [role="button"], [role="slider"], [role="checkbox"], [tabindex]:not([tabindex="-1"])',
    );
    for (const el of interactive) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (
        r.width === 0 ||
        r.height === 0 ||
        s.visibility === 'hidden' ||
        s.display === 'none' ||
        Number(s.opacity) === 0
      )
        continue;
      if (el.closest('.ats-touch')) continue; // the SDK's own controls
      if (touch && (r.width < 43.5 || r.height < 43.5) && out.small.length < 20)
        out.small.push({ label: labelOf(el), w: Math.round(r.width), h: Math.round(r.height) });
      if (
        outside(r) &&
        // A control in a list that scrolls is reached by scrolling the list, if the list itself
        // is on screen (a long list of levels or pages).
        !scrolledInto(el) &&
        out.cutOff.length < 20
      )
        out.cutOff.push(labelOf(el));
      if (
        appButtons.some(
          (b) => r.left < b.x + b.w && r.right > b.x && r.top < b.y + b.h && r.bottom > b.y,
        ) &&
        out.underApp.length < 20
      )
        out.underApp.push(labelOf(el));
    }
    return out;
  },
};
