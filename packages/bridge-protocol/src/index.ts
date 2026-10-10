/**
 * The bridge between an All the Spaces host page and a creation running inside its sandboxed,
 * opaque-origin frame. Both sides talk only through `postMessage` with these messages.
 *
 * Rules that keep creations safe and hosts honest:
 * - The host never trusts identity from a creation: who you are, who's playing and who hosts
 *   the session always come from the host.
 * - A creation has no network access of its own. Multiplayer, saving and identity all go
 *   through the host, which checks every request.
 * - Versions only grow. A host supports every protocol version ever released, so old creations
 *   keep working. The rules for changing these messages are in docs/protocol-compat.md.
 */

export const PROTOCOL_VERSION = 1;

/** Messages larger than this (as JSON) are ignored. */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Saved values larger than this (as JSON) are refused. */
export const MAX_SAVE_BYTES = 256 * 1024;
/** How many keys one person may save in a creation, in each scope (personal, shared). */
export const MAX_SAVE_KEYS = 64;
/** How much one person may save in a creation altogether, in each scope (as JSON). */
export const MAX_SAVE_TOTAL_BYTES = 2 * 1024 * 1024;
/** Shared session values larger than this (as JSON) are refused. */
export const MAX_SHARED_BYTES = 32 * 1024;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Person {
  id: string;
  name: string;
  color: string;
}

/** Solo sessions can't be joined; shared ones are open to anyone who can open the creation. */
export type SessionMode = 'solo' | 'shared' | 'invite';

export interface Viewport {
  width: number;
  height: number;
  orientation: 'portrait' | 'landscape';
  /** Space kept clear of notches and system bars, in CSS pixels. */
  safeArea: { top: number; right: number; bottom: number; left: number };
  dpr: number;
  /** A touch screen is the main input. */
  touch: boolean;
}

/** Performance tier chosen by the host (from the device and measured performance). */
export type Tier = 'low' | 'mid' | 'high';

export type SaveScope = 'shared' | 'personal';

/**
 * Why a request failed (`code` on a failed `result`). Saving uses the first three; connectors
 * (added within version 1) use the rest, and `denied` and `too-big` too:
 *
 * - `stale`: someone saved since you read it. `too-big`: over a limit. `denied`: not allowed, or
 *   too many requests at once.
 * - `not-linked`: the person hasn't linked their account at the connector's service, or the link
 *   stopped working: offer `connector:link`.
 * - `not-approved`: this version doesn't declare that operation, or no Architect approved it.
 * - `trial`: an Architect trying a version that isn't live can only read.
 * - `clash`: the service said the thing changed in the meantime (409): read it again.
 * - `rejected`: what was sent doesn't fit the operation (or the service refused it as invalid).
 * - `upstream`: the service is unreachable, busy or failing (or the app is offline): try later.
 */
export type ResultCode =
  | 'stale'
  | 'too-big'
  | 'denied'
  | 'not-linked'
  | 'not-approved'
  | 'trial'
  | 'clash'
  | 'rejected'
  | 'upstream';

/** What a connector's service said when it refused, cleaned up by the server (`details` of a failed `connector:call`). */
export interface UpstreamError {
  status: number;
  /** Its own machine-readable code, when it looks like one (`BOOK_UNAVAILABLE`). */
  code?: string;
  /** Its message, at most 200 characters. */
  message?: string;
  /** Its details, when they're JSON of at most 2 KB. */
  details?: Json;
}

/** The answer to `connector:status`. */
export interface ConnectorStatus {
  /** The server has this connector installed. */
  installed: boolean;
  /** The person has linked their account. */
  linked: boolean;
  /** Linked, but the service stopped accepting it: they need to link again. */
  broken: boolean;
  displayName: string | null;
  scopes: string[];
  /**
   * Who the service says the person is linked as, when the server's owner set the connector up
   * to ask (its link check) and the service said. Added within protocol 1: absent from older
   * hosts, so treat a missing one as null.
   */
  accountName?: string | null;
}

export interface GamepadState {
  index: number;
  axes: number[];
  buttons: number[];
}

// ---- Host → creation ------------------------------------------------------------------------

export interface InitData {
  protocolVersion: number;
  creation: { id: string; version: number; title: string };
  me: Person;
  players: Person[];
  session: { id: string; mode: SessionMode; hostId: string | null };
  tier: Tier;
  reducedMotion: boolean;
  locale: string;
  viewport: Viewport;
}

export type HostMessage =
  | { type: 'init'; data: InitData }
  | { type: 'pause' }
  | { type: 'resume' }
  /** The person asked to leave; the creation has a moment to save before it's closed. */
  | { type: 'exit-requested' }
  | { type: 'viewport'; data: Viewport }
  | { type: 'gamepads'; data: GamepadState[] }
  | { type: 'players'; data: { players: Person[]; hostId: string | null } }
  | { type: 'mp:message'; data: { from: string; kind: string; body: Json } }
  | { type: 'mp:shared'; data: { key: string; value: Json; by: string | null } }
  /** Reply to a request (a message the creation sent with an `id`). */
  | { type: 'result'; re: number; ok: true; data?: Json }
  | {
      type: 'result';
      re: number;
      ok: false;
      error: string;
      code?: ResultCode;
      /** More about what went wrong (a failed `connector:call`: an `UpstreamError`). */
      details?: Json;
    }
  | { type: 'ping'; n: number }
  /**
   * People are talking (voice chat, which the app plays itself): lower music, effects and
   * ambience to `level` (1 = back to normal). Added after version 1; older creations ignore it.
   */
  | { type: 'duck'; level: number };

// ---- Creation → host ------------------------------------------------------------------------

export type CreationMessage =
  /** The creation is listening; the host answers with `init`. */
  /** `saveVersion`: the shape of the data this build saves (see the SDK's `save.version`). */
  | { type: 'hello'; sdkVersion: string; saveVersion?: number }
  /** Loaded and showing: the host lifts its veil. */
  | { type: 'ready' }
  | { type: 'progress'; value: number; label?: string }
  | { type: 'request-exit' }
  | { type: 'request-fullscreen' }
  | { type: 'save:get'; id: number; scope: SaveScope; key: string }
  | {
      type: 'save:set';
      id: number;
      scope: SaveScope;
      key: string;
      value: Json;
      schemaVersion: number;
      /** The version this change was based on; the write fails as `stale` if someone saved since. */
      basedOn?: number | null;
    }
  | { type: 'mp:send'; kind: string; body: Json; to?: string }
  | { type: 'mp:shared'; id: number; key: string; value: Json }
  | { type: 'ui:toast'; text: string }
  | { type: 'ui:prefer-chat-minimized'; value: boolean }
  /** Every few seconds: average frame rate, the slowest frame, and typical / 95th-percentile frame times. */
  | {
      type: 'perf';
      fps: number;
      frameMs: number;
      p50Ms?: number;
      p95Ms?: number;
      drawCalls?: number;
    }
  | { type: 'error'; message: string }
  | { type: 'pong'; n: number }
  /**
   * Calls an operation of a connector the server's owner installed, as this person, through the
   * app (docs/connectors.md). Answered with `{ status, data }`, or a failed result whose `code`
   * says why. Added after version 1; older hosts ignore it (the SDK times out).
   */
  | {
      type: 'connector:call';
      id: number;
      connector: string;
      op: string;
      params?: { [key: string]: Json };
      body?: Json;
      /** Required for operations that change things: the same key for a retry of the same change. */
      idempotencyKey?: string;
    }
  /** Whether the person has linked their account: answered with a `ConnectorStatus`. */
  | { type: 'connector:status'; id: number; connector: string }
  /**
   * Asks the app to offer linking the person's account (the app draws its own card; the
   * creation never sees the service's pages). Answered once the card is shown.
   */
  | { type: 'connector:link'; id: number; connector: string };

/** Every message on the wire carries this envelope. */
export interface Envelope<M> {
  ats: 'bridge';
  v: number;
  msg: M;
}

export function wrap<M>(msg: M): Envelope<M> {
  return { ats: 'bridge', v: PROTOCOL_VERSION, msg };
}

const KEY = /^[\w.:-]{1,128}$/;
/** A connector's id on the server (its definition file is `<id>.json`). */
export const CONNECTOR_ID = /^[a-z0-9-]{2,32}$/;
/** An operation's name in a connector definition. */
export const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** An idempotency key for a connector call that changes something. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,80}$/;
const TYPES = new Set([
  'hello',
  'ready',
  'progress',
  'request-exit',
  'request-fullscreen',
  'save:get',
  'save:set',
  'mp:send',
  'mp:shared',
  'ui:toast',
  'ui:prefer-chat-minimized',
  'perf',
  'error',
  'pong',
  'connector:call',
  'connector:status',
  'connector:link',
]);

/**
 * Checks a message from a creation (the host calls this on everything the frame sends).
 * Returns the message if it's well-formed and within limits, otherwise null.
 */
export function readCreationMessage(data: unknown): CreationMessage | null {
  if (!data || typeof data !== 'object') return null;
  const env = data as Partial<Envelope<unknown>>;
  if (env.ats !== 'bridge' || typeof env.v !== 'number' || env.v < 1) return null;
  const msg = env.msg as Record<string, unknown> | undefined;
  if (!msg || typeof msg.type !== 'string' || !TYPES.has(msg.type)) return null;
  let size: number;
  try {
    size = JSON.stringify(msg).length;
  } catch {
    return null;
  }
  if (size > MAX_MESSAGE_BYTES) return null;
  const isId = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
  const isKey = (x: unknown) => typeof x === 'string' && KEY.test(x);
  const isScope = (x: unknown) => x === 'shared' || x === 'personal';
  const isConnector = (x: unknown) => typeof x === 'string' && CONNECTOR_ID.test(x);
  switch (msg.type) {
    case 'hello':
      return typeof msg.sdkVersion === 'string' &&
        msg.sdkVersion.length < 32 &&
        (msg.saveVersion === undefined ||
          (isId(msg.saveVersion) && (msg.saveVersion as number) <= 1_000_000))
        ? (msg as CreationMessage)
        : null;
    case 'progress':
      return typeof msg.value === 'number' ? (msg as CreationMessage) : null;
    case 'save:get':
      return isId(msg.id) && isScope(msg.scope) && isKey(msg.key) ? (msg as CreationMessage) : null;
    case 'save:set':
      return isId(msg.id) &&
        isScope(msg.scope) &&
        isKey(msg.key) &&
        Number.isInteger(msg.schemaVersion) &&
        'value' in msg
        ? (msg as CreationMessage)
        : null;
    case 'mp:send':
      return isKey(msg.kind) && (msg.to === undefined || typeof msg.to === 'string')
        ? (msg as CreationMessage)
        : null;
    case 'mp:shared':
      return isId(msg.id) && isKey(msg.key) && 'value' in msg ? (msg as CreationMessage) : null;
    case 'ui:toast':
      return typeof msg.text === 'string' && msg.text.length <= 200
        ? (msg as CreationMessage)
        : null;
    case 'ui:prefer-chat-minimized':
      return typeof msg.value === 'boolean' ? (msg as CreationMessage) : null;
    case 'perf':
      return typeof msg.fps === 'number' &&
        typeof msg.frameMs === 'number' &&
        (msg.p50Ms === undefined || typeof msg.p50Ms === 'number') &&
        (msg.p95Ms === undefined || typeof msg.p95Ms === 'number')
        ? (msg as CreationMessage)
        : null;
    case 'error':
      return typeof msg.message === 'string' ? (msg as CreationMessage) : null;
    case 'pong':
      return isId(msg.n) ? (msg as CreationMessage) : null;
    case 'connector:call':
      return isId(msg.id) &&
        isConnector(msg.connector) &&
        typeof msg.op === 'string' &&
        OPERATION_NAME.test(msg.op) &&
        (msg.params === undefined ||
          (msg.params !== null && typeof msg.params === 'object' && !Array.isArray(msg.params))) &&
        (msg.idempotencyKey === undefined ||
          (typeof msg.idempotencyKey === 'string' && IDEMPOTENCY_KEY.test(msg.idempotencyKey)))
        ? (msg as CreationMessage)
        : null;
    case 'connector:status':
    case 'connector:link':
      return isId(msg.id) && isConnector(msg.connector) ? (msg as CreationMessage) : null;
    default:
      return msg as CreationMessage;
  }
}

/** Checks a message from the host (the creation's SDK calls this). */
export function readHostMessage(data: unknown): HostMessage | null {
  if (!data || typeof data !== 'object') return null;
  const env = data as Partial<Envelope<unknown>>;
  if (env.ats !== 'bridge' || typeof env.v !== 'number') return null;
  const msg = env.msg as { type?: unknown } | undefined;
  return msg && typeof msg.type === 'string' ? (msg as HostMessage) : null;
}

/** Size of a value as JSON, for checking limits. */
export const jsonSize = (value: unknown) => JSON.stringify(value ?? null).length;

// ---- Stand-in answers for connectors ----------------------------------------------------------

/**
 * A made-up answer from a connector's service, for checking and developing a creation without
 * the real service: `qa/connectors/<connector>/<op>.json` in a project (the checks' host plays
 * these), or `connect({ standIn })` in the SDK. Either one answer, or a list tried in order: the
 * first whose `match.params` all equal the call's params (one without `match` matches anything).
 */
export interface ConnectorFixtureAnswer {
  /** Only for calls whose params include all of these (any call when left out). */
  match?: { params?: { [key: string]: Json } };
  /** The service's HTTP status (default 200). */
  status?: number;
  /** Its JSON answer (for a refusal: `{ code, message, details }` as the service sends them). */
  body?: Json;
}

export type ConnectorFixture = ConnectorFixtureAnswer | ConnectorFixtureAnswer[];

/** The bridge code a service's HTTP status means (as the app's server maps it). */
export function codeForStatus(status: number): ResultCode {
  if (status === 401) return 'not-linked';
  if (status === 403) return 'denied';
  if (status === 409) return 'clash';
  if (status >= 400 && status < 500 && status !== 429) return 'rejected';
  return 'upstream';
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a fixture answers for a call with these params: `{ ok: true, status, data }`, a failure
 * shaped as the app sends it, or null when nothing in it matches.
 */
export function fixtureAnswer(
  fixture: ConnectorFixture,
  params: { [key: string]: Json } | undefined,
):
  | { ok: true; status: number; data: Json }
  | { ok: false; code: ResultCode; error: string; details: Json }
  | null {
  const entries = Array.isArray(fixture) ? fixture : [fixture];
  const hit = entries.find((e) => {
    const want = e.match?.params;
    return !want || Object.entries(want).every(([k, v]) => sameJson(params?.[k], v));
  });
  if (!hit) return null;
  const status = hit.status ?? 200;
  const body = hit.body ?? null;
  if (status >= 200 && status < 300) return { ok: true, status, data: body };
  const b: { [key: string]: Json } =
    body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const details: { [key: string]: Json } = { status };
  if (typeof b.code === 'string' && /^[A-Z_]{1,40}$/.test(b.code)) details.code = b.code;
  if (typeof b.message === 'string') details.message = b.message.slice(0, 200);
  if (b.details !== undefined) details.details = b.details;
  return {
    ok: false,
    code: codeForStatus(status),
    error: typeof b.message === 'string' ? b.message.slice(0, 200) : `The service said ${status}.`,
    details,
  };
}
