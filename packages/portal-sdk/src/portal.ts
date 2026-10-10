import {
  type ConnectorFixture,
  type CreationMessage,
  fixtureAnswer,
  type HostMessage,
  type InitData,
  type Json,
  type Person,
  PROTOCOL_VERSION,
  type Tier,
  type Viewport,
  wrap,
} from '@allthespaces/bridge-protocol';
// Only the version is bundled into a creation (a named import of JSON is tree-shaken).
import { version } from '../package.json' with { type: 'json' };
import { PortalAudio } from './audio.ts';
import { Bridge } from './bridge.ts';
import { PortalConnectors } from './connectors.ts';
import { PortalInput } from './input.ts';
import { PortalStorage, type SaveOptions, SaveScopeStore } from './save.ts';
import { Session } from './session.ts';

/** This SDK's version (from its package.json), sent to the host in `hello`. */
export const SDK_VERSION: string = version;

export interface ConnectOptions {
  /** The shape of your saved data, and how to upgrade older saves (see `SaveOptions`). */
  save?: SaveOptions;
  /**
   * When the page isn't inside All the Spaces (you opened it on its own while building it),
   * the SDK stands in for the app: you're the only player and saves go to this browser.
   * Default: after 1.5 s without an answer from a host.
   */
  standaloneAfterMs?: number;
  /** What the stand-in app does when you run on your own (ignored inside All the Spaces). */
  standIn?: StandInOptions;
}

/** Made-up answers for connector calls while you run on your own (see the README's Connectors). */
export type StandInConnectors =
  | { [connector: string]: { [op: string]: ConnectorFixture } }
  | ((
      connector: string,
      op: string,
      params: { [key: string]: Json } | undefined,
    ) => ConnectorFixture | undefined | Promise<ConnectorFixture | undefined>);

export interface StandInOptions {
  connectors?: StandInConnectors;
}

/**
 * Connects your creation to All the Spaces. Call it first; everything else hangs off the
 * `Portal` it returns.
 *
 * ```ts
 * const portal = await connect();
 * portal.input.define({ move: 'stick', jump: { button: 'Jump' } });
 * // … load your things, then:
 * portal.ready();
 * ```
 */
export async function connect(options: ConnectOptions = {}): Promise<Portal> {
  const bridge = new Bridge();
  const inFrame = window.parent !== window;
  const init = await new Promise<{ data: InitData; standalone: boolean }>((resolve) => {
    let done = false;
    const off = bridge.on((msg) => {
      if (msg.type === 'init' && !done) {
        done = true;
        off();
        window.clearInterval(hello);
        resolve({ data: msg.data, standalone: false });
      }
    });
    const say = () =>
      bridge.post({
        type: 'hello',
        sdkVersion: SDK_VERSION,
        saveVersion: options.save?.version ?? 1,
      });
    // Say hello until the host answers (it may still be setting up).
    const hello = window.setInterval(say, 300);
    if (inFrame) say();
    window.setTimeout(
      () => {
        if (done) return;
        done = true;
        off();
        window.clearInterval(hello);
        const host = new StandInHost(bridge, options.standIn ?? {});
        bridge.useHost(host);
        resolve({ data: host.init, standalone: true });
      },
      inFrame ? (options.standaloneAfterMs ?? 1500) : 0,
    );
  });
  return new Portal(bridge, init.data, options, init.standalone);
}

type LifecycleEvent = 'pause' | 'resume';

export class Portal {
  /** You. */
  readonly me: Person;
  readonly creation: InitData['creation'];
  /** How capable this device is: keep effects lighter on `low`. */
  readonly tier: Tier;
  /** The person prefers less motion: calm animations and camera moves. */
  readonly reducedMotion: boolean;
  readonly locale: string;
  /** Screen size, orientation and safe area (kept up to date). */
  viewport: Viewport;
  /** Who's playing with you, shared values and messages. */
  readonly session: Session;
  /** Saved data: `shared` for everyone in the group, `personal` for just you. */
  readonly save: { shared: SaveScopeStore; personal: SaveScopeStore };
  /** Keeps small values between visits (instead of localStorage, which creations can't use). */
  readonly storage: PortalStorage;
  readonly input: PortalInput;
  readonly audio = new PortalAudio();
  /** Services the server's owner installed, called as the person playing (see the README). */
  readonly connectors: PortalConnectors;
  /** True when running on its own (not inside All the Spaces), e.g. while you build it. */
  readonly standalone: boolean;
  /** Things drawn by the app around your creation. */
  readonly ui: {
    toast: (text: string) => void;
    requestFullscreen: () => void;
    preferChatMinimized: (value: boolean) => void;
  };

  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly viewportListeners = new Set<(v: Viewport) => void>();
  private readonly exitHandlers = new Set<() => void | Promise<void>>();

  constructor(
    private readonly bridge: Bridge,
    init: InitData,
    options: ConnectOptions,
    standalone: boolean,
  ) {
    this.me = init.me;
    this.creation = init.creation;
    this.tier = init.tier;
    this.reducedMotion = init.reducedMotion;
    this.locale = init.locale;
    this.viewport = init.viewport;
    this.standalone = standalone;
    this.session = new Session(bridge, init.me, { ...init.session, players: init.players });
    this.save = {
      shared: new SaveScopeStore(bridge, 'shared', options.save ?? {}),
      personal: new SaveScopeStore(bridge, 'personal', options.save ?? {}),
    };
    this.storage = new PortalStorage(this.save.personal);
    this.input = new PortalInput(bridge, init.viewport.touch);
    this.connectors = new PortalConnectors(bridge);
    this.ui = {
      toast: (text) => bridge.post({ type: 'ui:toast', text: text.slice(0, 200) }),
      requestFullscreen: () => bridge.post({ type: 'request-fullscreen' }),
      preferChatMinimized: (value) => bridge.post({ type: 'ui:prefer-chat-minimized', value }),
    };

    bridge.on((msg) => this.receive(msg));
    this.reportErrors();
    this.samplePerformance();
  }

  private receive(msg: HostMessage) {
    if (msg.type === 'pause' || msg.type === 'resume') {
      this.audio.fade(msg.type === 'resume');
      for (const l of this.listeners.get(msg.type) ?? []) l();
    } else if (msg.type === 'viewport') {
      this.viewport = msg.data;
      for (const l of this.viewportListeners) l(msg.data);
    } else if (msg.type === 'exit-requested') {
      void this.leave();
    } else if (msg.type === 'duck') {
      this.audio.duck(msg.level);
    }
  }

  /** Tell the app you've loaded and are ready to be seen (it lifts its veil). */
  ready() {
    this.bridge.post({ type: 'ready' });
  }

  /** Loading progress while the app's veil is up (0–1, with an optional word or two). */
  progress(value: number, label?: string) {
    this.bridge.post({
      type: 'progress',
      value: Math.max(0, Math.min(1, value)),
      ...(label ? { label: label.slice(0, 60) } : {}),
    });
  }

  /** Leave the creation (back to the space). Your `onExit` handlers run first. */
  exit() {
    void this.leave();
  }

  /** Runs when the person leaves: save anything unsaved (you have about 1.5 seconds). */
  onExit(handler: () => void | Promise<void>) {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** `pause`: the app is covering you (chat open, tab hidden); `resume`: you're back. */
  on(event: LifecycleEvent, listener: () => void) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Called when the screen size or orientation changes. */
  onViewport(listener: (viewport: Viewport) => void) {
    this.viewportListeners.add(listener);
    return () => this.viewportListeners.delete(listener);
  }

  private leaving = false;
  private async leave() {
    if (this.leaving) return;
    this.leaving = true;
    const handlers = [...this.exitHandlers].map((h) => Promise.resolve().then(h));
    await Promise.race([Promise.allSettled(handlers), new Promise((r) => setTimeout(r, 1500))]);
    this.bridge.post({ type: 'request-exit' });
  }

  private reportErrors() {
    const send = (message: string) =>
      this.bridge.post({ type: 'error', message: message.slice(0, 500) });
    window.addEventListener('error', (e) => send(e.message || 'Error'));
    window.addEventListener('unhandledrejection', (e) =>
      send(String(e.reason?.message ?? e.reason)),
    );
  }

  /**
   * Tells the app how smoothly you're running (it may suggest a lighter setting). Stops while the
   * app pauses you, so a paused creation doesn't keep a frame loop going.
   */
  private samplePerformance() {
    let last = performance.now();
    let prev = last;
    const frames: number[] = [];
    let pending = 0;
    this.on('pause', () => {
      cancelAnimationFrame(pending);
      pending = 0;
    });
    this.on('resume', () => {
      if (pending) return;
      // The time away isn't a slow frame.
      last = prev = performance.now();
      frames.length = 0;
      pending = requestAnimationFrame(tick);
    });
    const tick = (now: number) => {
      frames.push(now - prev);
      prev = now;
      if (now - last >= 5000) {
        const sorted = [...frames].sort((a, b) => a - b);
        const at = (q: number) =>
          sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
        this.bridge.post({
          type: 'perf',
          fps: (frames.length * 1000) / (now - last),
          frameMs: sorted.at(-1) ?? 0,
          p50Ms: at(0.5),
          p95Ms: at(0.95),
        });
        frames.length = 0;
        last = now;
      }
      pending = requestAnimationFrame(tick);
    };
    pending = requestAnimationFrame(tick);
  }
}

/**
 * Stands in for the app when a creation runs on its own: you're the only player, shared
 * values stay in this tab, and saves go to this browser's storage.
 */
class StandInHost {
  readonly init: InitData;
  private readonly memory = new Map<
    string,
    { value: Json; schemaVersion: number; version: number }
  >();

  constructor(
    private readonly bridge: Bridge,
    private readonly options: StandInOptions,
  ) {
    const me = { id: 'you', name: 'You', color: '#3F5B7C' };
    this.init = {
      protocolVersion: PROTOCOL_VERSION,
      creation: { id: 'standalone', version: 0, title: document.title || 'Creation' },
      me,
      players: [me],
      session: { id: 'standalone', mode: 'solo', hostId: me.id },
      tier: 'high',
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      locale: navigator.language,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        orientation: innerWidth >= innerHeight ? 'landscape' : 'portrait',
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
        dpr: devicePixelRatio,
        touch: matchMedia('(pointer: coarse)').matches,
      },
    };
    addEventListener('resize', () => {
      this.send({
        type: 'viewport',
        data: {
          ...this.init.viewport,
          width: innerWidth,
          height: innerHeight,
          orientation: innerWidth >= innerHeight ? 'landscape' : 'portrait',
        },
      });
    });
  }

  private send(msg: HostMessage) {
    queueMicrotask(() => this.bridge.deliver(wrap(msg)));
  }

  private stored(key: string) {
    if (this.memory.has(key)) return this.memory.get(key);
    try {
      const raw = localStorage.getItem(`ats-standalone:${key}`);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  private store(key: string, entry: { value: Json; schemaVersion: number; version: number }) {
    this.memory.set(key, entry);
    try {
      localStorage.setItem(`ats-standalone:${key}`, JSON.stringify(entry));
    } catch {}
  }

  private async fixture(connector: string, op: string, params?: { [key: string]: Json }) {
    const given = this.options.connectors;
    if (!given) return undefined;
    if (typeof given === 'function') return given(connector, op, params);
    return given[connector]?.[op];
  }

  private hasConnector(connector: string) {
    const given = this.options.connectors;
    return typeof given === 'function' || Boolean(given?.[connector]);
  }

  private async connectorCall(msg: Extract<CreationMessage, { type: 'connector:call' }>) {
    const fixture = await this.fixture(msg.connector, msg.op, msg.params);
    const answer = fixture ? fixtureAnswer(fixture, msg.params) : null;
    if (!answer) {
      console.info(
        `[standalone] No stand-in answer for ${msg.connector} ${msg.op}: give one in connect({ standIn: { connectors } }).`,
      );
      this.send({
        type: 'result',
        re: msg.id,
        ok: false,
        error: `No stand-in answer for ${msg.connector} ${msg.op}.`,
        code: 'upstream',
      });
      return;
    }
    this.send(
      answer.ok
        ? {
            type: 'result',
            re: msg.id,
            ok: true,
            data: { status: answer.status, data: answer.data },
          }
        : {
            type: 'result',
            re: msg.id,
            ok: false,
            error: answer.error,
            code: answer.code,
            details: answer.details,
          },
    );
  }

  postMessage(data: unknown) {
    const msg = (data as { msg: CreationMessage }).msg;
    switch (msg.type) {
      case 'connector:call':
        void this.connectorCall(msg);
        break;
      case 'connector:status': {
        const known = this.hasConnector(msg.connector);
        this.send({
          type: 'result',
          re: msg.id,
          ok: true,
          data: {
            installed: known,
            linked: known,
            broken: false,
            displayName: known ? msg.connector : null,
            scopes: [],
          },
        });
        break;
      }
      case 'connector:link':
        console.info(`[standalone] The creation asked to link ${msg.connector}.`);
        this.send({ type: 'result', re: msg.id, ok: true });
        break;
      case 'save:get': {
        const s = this.stored(`${msg.scope}:${msg.key}`);
        this.send({
          type: 'result',
          re: msg.id,
          ok: true,
          data: s ?? { value: null, schemaVersion: null, version: null },
        });
        break;
      }
      case 'save:set': {
        const key = `${msg.scope}:${msg.key}`;
        const version = (this.stored(key)?.version ?? 0) + 1;
        this.store(key, { value: msg.value, schemaVersion: msg.schemaVersion, version });
        this.send({ type: 'result', re: msg.id, ok: true, data: { version } });
        break;
      }
      case 'mp:shared':
        this.send({ type: 'result', re: msg.id, ok: true });
        this.send({ type: 'mp:shared', data: { key: msg.key, value: msg.value, by: 'you' } });
        break;
      case 'ui:toast':
        console.info(`[toast] ${msg.text}`);
        break;
      case 'request-exit':
        console.info('[standalone] The creation asked to leave.');
        break;
      case 'error':
        console.warn('[standalone] error:', msg.message);
        break;
      default:
        break;
    }
  }
}
