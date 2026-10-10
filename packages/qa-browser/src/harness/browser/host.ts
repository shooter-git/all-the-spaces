/**
 * A stand-in for the app during QA: shows the creation full screen in the same sealed frame,
 * with the app's Back and Chat buttons on top, and answers the bridge like the app does — as one
 * person, alone, with saves kept in memory. It records what the creation says and does.
 */
import {
  type ConnectorFixture,
  type CreationMessage,
  fixtureAnswer,
  type HostMessage,
  type InitData,
  type Json,
  MAX_SAVE_BYTES,
  MAX_SHARED_BYTES,
  PROTOCOL_VERSION,
  readCreationMessage,
  wrap,
} from '@allthespaces/bridge-protocol';

const params = new URLSearchParams(location.search);
const frame = document.querySelector('iframe') as HTMLIFrameElement;
const started = performance.now();

const log = {
  helloAt: null as number | null,
  readyAt: null as number | null,
  saveVersion: null as number | null,
  progress: 0,
  toasts: [] as string[],
  errors: [] as string[],
  ignored: 0,
  perf: [] as { fps: number; frameMs: number; p50Ms?: number; p95Ms?: number }[],
  exitRequestedAt: null as number | null,
  exitedAt: null as number | null,
  lastPong: 0,
  longestSilence: 0,
  saves: 0,
  saveProblems: [] as string[],
  /** Every connector call, and what it was answered with. */
  connectorCalls: [] as { connector: string; op: string; result: string }[],
  /** Connector operations it used without declaring them in ats.json. */
  connectorProblems: [] as string[],
};

/** What ats.json declares and the project's qa/connectors answers (served next to this page). */
let connectors: {
  declared: { id: string; ops: string[] }[];
  fixtures: { [connector: string]: { [op: string]: ConnectorFixture } };
} = { declared: [], fixtures: {} };

const me = { id: 'qa-tester', name: 'Tester', color: '#3f5b7c' };
const send = (m: HostMessage) => frame.contentWindow?.postMessage(wrap(m), '*');
const viewport = (): InitData['viewport'] => ({
  width: innerWidth,
  height: innerHeight,
  orientation: innerWidth >= innerHeight ? 'landscape' : 'portrait',
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  dpr: devicePixelRatio,
  touch: matchMedia('(pointer: coarse)').matches,
});

const saved = new Map<string, { value: Json; schemaVersion: number; version: number }>();
const shared = new Map<string, Json>();

addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow) return;
  const msg = readCreationMessage(e.data);
  if (!msg) {
    log.ignored++;
    return;
  }
  handle(msg);
});

function handle(msg: CreationMessage) {
  const now = performance.now() - started;
  switch (msg.type) {
    case 'hello':
      log.helloAt ??= now;
      log.saveVersion = msg.saveVersion ?? null;
      send({
        type: 'init',
        data: {
          protocolVersion: PROTOCOL_VERSION,
          creation: { id: 'qa', version: 1, title: params.get('title') ?? 'Creation' },
          me,
          players: [me],
          session: { id: 'qa', mode: 'solo', hostId: me.id },
          tier: (params.get('tier') as InitData['tier']) ?? 'low',
          reducedMotion: false,
          locale: 'en-GB',
          viewport: viewport(),
        },
      });
      break;
    case 'ready':
      log.readyAt ??= now;
      log.lastPong = performance.now();
      break;
    case 'progress':
      log.progress = msg.value;
      break;
    case 'ui:toast':
      if (log.toasts.length < 20) log.toasts.push(msg.text);
      break;
    case 'error':
      if (log.errors.length < 50) log.errors.push(msg.message.slice(0, 300));
      break;
    case 'perf':
      log.perf.push(msg);
      break;
    case 'pong':
      log.lastPong = performance.now();
      break;
    case 'request-exit':
      log.exitedAt ??= now;
      break;
    case 'save:get': {
      const row = saved.get(`${msg.scope}/${msg.key}`);
      send({
        type: 'result',
        re: msg.id,
        ok: true,
        data: row
          ? { value: row.value, schemaVersion: row.schemaVersion, version: row.version }
          : { value: null, schemaVersion: null, version: null },
      });
      break;
    }
    case 'save:set': {
      log.saves++;
      const key = `${msg.scope}/${msg.key}`;
      const row = saved.get(key);
      if (JSON.stringify(msg.value).length > MAX_SAVE_BYTES) {
        log.saveProblems.push(`"${msg.key}" was too big to save`);
        send({ type: 'result', re: msg.id, ok: false, error: 'Too big', code: 'too-big' });
      } else if (
        row &&
        (msg.schemaVersion < row.schemaVersion ||
          (msg.basedOn != null && msg.basedOn !== row.version))
      ) {
        send({ type: 'result', re: msg.id, ok: false, error: 'Stale', code: 'stale' });
      } else {
        const version = (row?.version ?? 0) + 1;
        saved.set(key, { value: msg.value, schemaVersion: msg.schemaVersion, version });
        send({ type: 'result', re: msg.id, ok: true, data: { version } });
      }
      break;
    }
    case 'connector:call':
    case 'connector:status':
    case 'connector:link': {
      const declared = connectors.declared.find((c) => c.id === msg.connector);
      const op = msg.type === 'connector:call' ? msg.op : null;
      if (!declared || (op && !declared.ops.includes(op))) {
        if (log.connectorProblems.length < 20)
          log.connectorProblems.push(
            op ? `${msg.connector} ${op}` : `${msg.connector} (${msg.type.slice(10)})`,
          );
        if (op && log.connectorCalls.length < 500)
          log.connectorCalls.push({ connector: msg.connector, op, result: 'not declared' });
        send({
          type: 'result',
          re: msg.id,
          ok: false,
          error: "Not declared in ats.json's connectors.",
          code: 'not-approved',
        });
        break;
      }
      if (msg.type === 'connector:status') {
        send({
          type: 'result',
          re: msg.id,
          ok: true,
          data: {
            installed: true,
            linked: true,
            broken: false,
            displayName: msg.connector,
            scopes: [],
          },
        });
        break;
      }
      if (msg.type === 'connector:link') {
        send({ type: 'result', re: msg.id, ok: true });
        break;
      }
      const fixture = connectors.fixtures[msg.connector]?.[msg.op];
      const answer = fixture ? fixtureAnswer(fixture, msg.params) : null;
      if (log.connectorCalls.length < 500)
        log.connectorCalls.push({
          connector: msg.connector,
          op: msg.op,
          result: !fixture
            ? 'no fixture'
            : !answer
              ? 'no matching answer'
              : answer.ok
                ? String(answer.status)
                : answer.code,
        });
      send(
        !answer
          ? {
              type: 'result',
              re: msg.id,
              ok: false,
              error: `No answer for ${msg.connector} ${msg.op} in qa/connectors.`,
              code: 'upstream',
            }
          : answer.ok
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
      break;
    }
    case 'mp:shared':
      if (JSON.stringify(msg.value).length > MAX_SHARED_BYTES) {
        send({ type: 'result', re: msg.id, ok: false, error: 'Too big', code: 'too-big' });
      } else {
        shared.set(msg.key, msg.value);
        send({ type: 'result', re: msg.id, ok: true });
        send({ type: 'mp:shared', data: { key: msg.key, value: msg.value, by: me.id } });
      }
      break;
    default:
      break;
  }
}

let n = 0;
setInterval(() => {
  send({ type: 'ping', n: n++ });
  if (log.readyAt !== null && log.exitedAt === null)
    log.longestSilence = Math.max(log.longestSilence, performance.now() - log.lastPong);
}, 500);
addEventListener('resize', () => send({ type: 'viewport', data: viewport() }));

(window as unknown as { __host: unknown }).__host = {
  log,
  requestExit() {
    log.exitRequestedAt = performance.now() - started;
    send({ type: 'exit-requested' });
  },
  /** Where the app's own buttons sit (a creation shouldn't put its controls under them). */
  appButtons() {
    return [...document.querySelectorAll('.bar button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
  },
};

// The connectors' stand-in answers first, then the creation.
fetch('/connectors.json')
  .then((r) => r.json())
  .then((c) => {
    if (c && Array.isArray(c.declared)) connectors = c;
  })
  .catch(() => {})
  .finally(() => {
    frame.src = params.get('src') ?? '';
  });
