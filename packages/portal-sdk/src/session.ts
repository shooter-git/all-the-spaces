import type { HostMessage, Json, Person, SessionMode } from '@allthespaces/bridge-protocol';
import type { Bridge } from './bridge.ts';

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  on(l: Listener<T>) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  emit(value: T) {
    for (const l of this.listeners) l(value);
  }
}

/**
 * Playing together. Everyone in a session sees the same shared values; messages go to everyone
 * else (or one person). One player is the host — useful for deciding things fairly (who goes
 * first, when a round starts); if they leave, hosting passes on by itself.
 *
 * In a solo session all of this still works: you're simply the only player (and the host).
 */
export class Session {
  id: string;
  mode: SessionMode;
  hostId: string | null;
  players: Person[];
  private readonly values = new Map<string, Json>();
  private readonly valueEvents = new Map<string, Emitter<{ value: Json; by: string | null }>>();
  private readonly anyValue = new Emitter<{ key: string; value: Json; by: string | null }>();
  private readonly messageEvents = new Map<string, Emitter<{ from: string; body: Json }>>();
  private readonly playerEvents = new Emitter<Person[]>();
  private readonly hostEvents = new Emitter<string | null>();

  constructor(
    private readonly bridge: Bridge,
    readonly me: Person,
    init: { id: string; mode: SessionMode; hostId: string | null; players: Person[] },
  ) {
    this.id = init.id;
    this.mode = init.mode;
    this.hostId = init.hostId;
    this.players = init.players;
    bridge.on((msg) => this.receive(msg));
  }

  get isHost() {
    return this.hostId === this.me.id || this.mode === 'solo';
  }

  private receive(msg: HostMessage) {
    if (msg.type === 'players') {
      this.players = msg.data.players;
      this.playerEvents.emit(this.players);
      if (msg.data.hostId !== this.hostId) {
        this.hostId = msg.data.hostId;
        this.hostEvents.emit(this.hostId);
      }
    } else if (msg.type === 'mp:shared') {
      this.values.set(msg.data.key, msg.data.value);
      this.valueEvents.get(msg.data.key)?.emit({ value: msg.data.value, by: msg.data.by });
      this.anyValue.emit(msg.data);
    } else if (msg.type === 'mp:message') {
      this.messageEvents.get(msg.data.kind)?.emit({ from: msg.data.from, body: msg.data.body });
    }
  }

  // ---- Shared values ------------------------------------------------------------------------

  /** A shared value (null until someone sets it). */
  get<T extends Json = Json>(key: string): T | null {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  /** All shared values whose key starts with `prefix`. */
  entries<T extends Json = Json>(prefix = ''): [string, T][] {
    return [...this.values].filter(([k]) => k.startsWith(prefix)) as [string, T][];
  }

  /** Sets a shared value for everyone (up to 32 KB each, 256 KB in total). */
  async set(key: string, value: Json): Promise<void> {
    await this.bridge.request({ type: 'mp:shared', key, value });
    this.values.set(key, value);
  }

  /** Called whenever a shared value changes (including your own changes). */
  onChange<T extends Json = Json>(key: string, listener: (value: T, by: string | null) => void) {
    let e = this.valueEvents.get(key);
    if (!e) {
      e = new Emitter();
      this.valueEvents.set(key, e);
    }
    return e.on(({ value, by }) => listener(value as T, by));
  }

  onAnyChange(listener: (key: string, value: Json, by: string | null) => void) {
    return this.anyValue.on(({ key, value, by }) => listener(key, value, by));
  }

  // ---- Messages -----------------------------------------------------------------------------

  /** Sends a message to everyone else, or to one person. Not saved; not sent back to you. */
  send(kind: string, body: Json = null, to?: string) {
    this.bridge.post({ type: 'mp:send', kind, body, ...(to ? { to } : {}) });
  }

  on<T extends Json = Json>(kind: string, listener: (body: T, from: string) => void) {
    let e = this.messageEvents.get(kind);
    if (!e) {
      e = new Emitter();
      this.messageEvents.set(kind, e);
    }
    return e.on(({ body, from }) => listener(body as T, from));
  }

  onPlayers(listener: (players: Person[]) => void) {
    return this.playerEvents.on(listener);
  }

  onHostChange(listener: (hostId: string | null) => void) {
    return this.hostEvents.on(listener);
  }

  // ---- Ready-made helpers -------------------------------------------------------------------

  /** Everyone's score, kept by each player for themselves (so changes never clash). */
  readonly scores = {
    add: (points: number) =>
      this.set(`scores.${this.me.id}`, (this.get<number>(`scores.${this.me.id}`) ?? 0) + points),
    set: (points: number) => this.set(`scores.${this.me.id}`, points),
    of: (id: string) => this.get<number>(`scores.${id}`) ?? 0,
    /** Highest first. */
    table: () =>
      this.players
        .map((p) => ({ player: p, score: this.get<number>(`scores.${p.id}`) ?? 0 }))
        .sort((a, b) => b.score - a.score),
  };

  /** Taking turns: the host sets the order; whoever's turn it is (or the host) moves it on. */
  readonly turns = {
    start: (order = this.players.map((p) => p.id)) => this.set('turns', { order, index: 0 }),
    current: () => {
      const t = this.get<{ order: string[]; index: number }>('turns');
      return t ? (t.order[t.index % t.order.length] ?? null) : null;
    },
    isMine: () => this.turns.current() === this.me.id,
    next: () => {
      const t = this.get<{ order: string[]; index: number }>('turns');
      if (!t || !(this.turns.isMine() || this.isHost)) return Promise.resolve();
      // Skip people who have left.
      const here = new Set(this.players.map((p) => p.id));
      let index = t.index + 1;
      for (let i = 0; i < t.order.length && !here.has(t.order[index % t.order.length] ?? ''); i++)
        index++;
      return this.set('turns', { order: t.order, index });
    },
  };

  /** A lobby: players say they're ready; the host starts a countdown (or starts right away). */
  readonly lobby = {
    setReady: (ready = true) => this.set(`lobby.ready.${this.me.id}`, ready),
    isReady: (id: string) => this.get<boolean>(`lobby.ready.${id}`) === true,
    allReady: () => this.players.length > 0 && this.players.every((p) => this.lobby.isReady(p.id)),
    /** Host only: start after `seconds` (0 = now). */
    start: (seconds = 3) =>
      this.isHost ? this.set('lobby.start', Date.now() + seconds * 1000) : Promise.resolve(),
    /** Called once the game starts (with how many ms ago that was, if you joined late). */
    onStart: (listener: (lateBy: number) => void) => {
      let timer: number | undefined;
      const arm = (at: number | null) => {
        window.clearTimeout(timer);
        if (at == null) return;
        timer = window.setTimeout(
          () => listener(Math.max(0, Date.now() - at)),
          Math.max(0, at - Date.now()),
        );
      };
      arm(this.get<number>('lobby.start'));
      const off = this.onChange<number>('lobby.start', arm);
      return () => {
        off();
        window.clearTimeout(timer);
      };
    },
  };

  /** Shared countdown timers, started by the host. */
  readonly timers = {
    start: (name: string, seconds: number) =>
      this.isHost
        ? this.set(`timer.${name}`, { endsAt: Date.now() + seconds * 1000 })
        : Promise.resolve(),
    /** Seconds left (0 when done or never started). */
    remaining: (name: string) => {
      const t = this.get<{ endsAt: number }>(`timer.${name}`);
      return t ? Math.max(0, (t.endsAt - Date.now()) / 1000) : 0;
    },
  };
}
