import {
  type CreationMessage,
  type GamepadState,
  type HostMessage,
  type InitData,
  type Json,
  type Person,
  PROTOCOL_VERSION,
  type ResultCode,
  readCreationMessage,
  type Viewport,
  wrap,
} from '@allthespaces/bridge-protocol';
import { REMOVED_FROM_GROUP } from '@ats/shared/topics';
import { Icon } from '@ats/ui';
import { Client, getStateCallbacks, type Room } from '@colyseus/sdk';
import { useEffect, useRef, useState } from 'react';
import { type ApiError, api } from '../lib/api.ts';
import { type ConnectorInfo, callFailure, loadConnectors } from '../lib/connectors.ts';
import type { OpenedCreation, SessionMode } from '../lib/creations.ts';
import { ConnectorLinkCard } from './ConnectorLinkCard.tsx';
import './creation-host.css';

interface SessionPlayer {
  id: string;
  name: string;
  color: string;
}

/**
 * Runs a creation in its sealed frame and speaks for it: who you are, its live session, saving,
 * gamepads, screen size. The frame can't reach anything else. The app's own controls (back,
 * chat) sit outside the frame, so a creation can never hide them.
 */
export function CreationHost({
  opened,
  mode,
  me,
  tier,
  leaving,
  onProgress,
  onReady,
  onLeft,
  onToast,
  onPerf,
  onOutdated,
  onSession,
  onRemoved,
  duck = 1,
  offline = false,
  embedded = false,
  linkReturnTo,
}: {
  opened: OpenedCreation;
  mode: SessionMode;
  me: Person;
  tier: InitData['tier'];
  /** Set when the person asks to leave: the creation gets a moment to save. */
  leaving: boolean;
  onProgress: (value: number, label?: string) => void;
  onReady: () => void;
  /** The creation has saved and let go (or took too long): take it away. */
  onLeft: () => void;
  onToast: (text: string) => void;
  /** Every few seconds: how smoothly it's running. */
  onPerf?: (sample: { fps: number; frameMs: number; p50Ms?: number; p95Ms?: number }) => void;
  /** A newer version of the creation has saved data this one can't use: offer to rejoin. */
  onOutdated?: () => void;
  /** They were taken out of the group while playing. */
  onRemoved?: () => void;
  /** Joined the live session: how to ask it for a voice chat pass. */
  onSession?: (voicePass: () => Promise<{ token: string } | { error: string }>) => void;
  /** People are talking: the creation's music, effects and ambience dip to this (1 = normal). */
  duck?: number;
  /** No live session and no saved data (a live preview): everything stays in this page. */
  offline?: boolean;
  /** Fills its container instead of the whole screen. */
  embedded?: boolean;
  /**
   * Where linking an account at a connector's service comes back to (a path in the app that
   * brings the person back to this creation). Default: this page.
   */
  linkReturnTo?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  // A creation asked to link the person's account at a connector's service: the app's own card.
  const [linkCard, setLinkCard] = useState<ConnectorInfo | null>(null);
  // The creation can leave in several ways (it asks, the person insists, it stops responding):
  // whichever comes first counts, once.
  const left = useRef(false);
  const leaveOnce = () => {
    if (left.current) return;
    left.current = true;
    onLeft();
  };
  const callbacks = useRef({
    onProgress,
    onReady,
    onLeft: leaveOnce,
    onToast,
    onPerf,
    onOutdated,
    onSession,
    onRemoved,
    setLinkCard,
  });
  callbacks.current = {
    onProgress,
    onReady,
    onLeft: leaveOnce,
    onToast,
    onPerf,
    onOutdated,
    onSession,
    onRemoved,
    setLinkCard,
  };
  const bridge = useRef<{
    send: (m: HostMessage) => void;
    lastPong: number;
    ready: boolean;
    /** Your name or colour changed (chat settings arrived): tell the creation, same session. */
    updateMe: (me: Person) => void;
  } | null>(null);
  // Who you are is read when needed, not a reason to restart: a new object with the same person
  // (a colour that arrived later) must not leave and re-join the live session mid-play.
  const meRef = useRef(me);
  meRef.current = me;
  const myId = me.id;

  useEffect(() => {
    const target = () => frame.current?.contentWindow ?? null;
    const send = (m: HostMessage) => target()?.postMessage(wrap(m), '*');
    let greeted = false;
    const updateMe = (next: Person) => {
      // In a live session the list of players comes from the server.
      if (room) return;
      const now = players[0];
      if (now?.id === next.id && now.name === next.name && now.color === next.color) return;
      players = [next];
      if (greeted) send({ type: 'players', data: { players, hostId } });
    };
    const state = { send, lastPong: Date.now(), ready: false, updateMe };
    bridge.current = state;

    // ---- The live session (falls back to playing alone if it can't be reached) ------------
    let room: Room | null = null;
    let closed = false;
    const shared = new Map<string, Json>();
    const sharedBy = new Map<string, string>();
    let players: Person[] = [meRef.current];
    let hostId: string | null = myId;
    const pendingShared = new Map<number, number>();
    const opts = { creationId: opened.creation.id, versionId: opened.creation.versionId, mode };
    const client = offline ? null : new Client(`${window.location.origin}/rt`);
    if (client) client.auth.token = opened.ticket;
    const joining = !client
      ? Promise.reject(new Error('offline'))
      : mode === 'shared'
        ? client.joinOrCreate('creation', opts)
        : client.create('creation', opts);
    joining
      .then((r) => {
        if (closed) {
          void r.leave();
          return;
        }
        room = r;
        r.onLeave((code) => {
          if (code === REMOVED_FROM_GROUP) callbacks.current.onRemoved?.();
        });
        let passWaiting: ((a: { token: string } | { error: string }) => void) | null = null;
        r.onMessage('voice', (answer: { token: string } | { error: string }) => {
          passWaiting?.(answer);
          passWaiting = null;
        });
        callbacks.current.onSession?.(
          () =>
            new Promise((resolve) => {
              passWaiting = resolve;
              r.send('voice');
              window.setTimeout(() => {
                if (passWaiting === resolve) resolve({ error: 'timeout' });
              }, 5000);
            }),
        );
        const $ = getStateCallbacks(r);
        const s = r.state as {
          players: Map<string, SessionPlayer>;
          hostId: string;
          shared: Map<string, string>;
        };
        const publishPlayers = () => {
          players = [...s.players.values()].map((p) => ({
            id: p.id,
            name: p.name,
            color: p.color,
          }));
          hostId = s.hostId || null;
          send({ type: 'players', data: { players, hostId } });
        };
        $(s).players.onAdd(publishPlayers);
        $(s).players.onRemove(publishPlayers);
        $(s).listen('hostId', publishPlayers);
        $(s).shared.onAdd((text: string, key: string) => {
          const value = JSON.parse(text) as Json;
          shared.set(key, value);
          send({ type: 'mp:shared', data: { key, value, by: sharedBy.get(key) ?? null } });
        });
        $(s).shared.onChange((text: string, key: string) => {
          const value = JSON.parse(text) as Json;
          shared.set(key, value);
          send({ type: 'mp:shared', data: { key, value, by: sharedBy.get(key) ?? null } });
        });
        r.onMessage('shared-by', (m: { key: string; by: string }) => sharedBy.set(m.key, m.by));
        r.onMessage(
          'shared-result',
          (m: { id: number; ok: boolean; error?: string; code?: 'too-big' | 'denied' }) => {
            const re = pendingShared.get(m.id);
            pendingShared.delete(m.id);
            if (re === undefined) return;
            send(
              m.ok
                ? { type: 'result', re, ok: true }
                : {
                    type: 'result',
                    re,
                    ok: false,
                    error: m.error ?? 'Not shared.',
                    ...(m.code ? { code: m.code } : {}),
                  },
            );
          },
        );
        r.onMessage('message', (m: { from: string; kind: string; body: Json }) =>
          send({ type: 'mp:message', data: m }),
        );
      })
      .catch(() => {
        // Offline: the creation carries on, alone.
      });

    // ---- Messages from the creation ---------------------------------------------------------
    let nextShared = 1;
    // What the creation says it saves (its save.version), to notice data from a newer version.
    let saveVersion = opened.creation.saveVersion ?? null;
    // Trying a version that isn't live: it reads real saves, but what it writes stays here.
    const trialSaves = new Map<string, { value: Json; schemaVersion: number; version: number }>();
    const onMessage = (e: MessageEvent) => {
      if (e.source !== target() || e.origin !== 'null') return;
      const msg = readCreationMessage(e.data);
      if (!msg) return;
      void handle(msg);
    };
    const handle = async (msg: CreationMessage) => {
      switch (msg.type) {
        case 'hello':
          greeted = true;
          saveVersion = msg.saveVersion ?? saveVersion;
          send({ type: 'init', data: initData() });
          for (const [key, value] of shared) {
            send({ type: 'mp:shared', data: { key, value, by: sharedBy.get(key) ?? null } });
          }
          break;
        case 'progress':
          callbacks.current.onProgress(msg.value, msg.label);
          break;
        case 'ready':
          state.ready = true;
          state.lastPong = Date.now();
          callbacks.current.onReady();
          break;
        case 'request-exit':
          callbacks.current.onLeft();
          break;
        case 'request-fullscreen':
          // The app goes full screen, not the frame (which isn't allowed to): on the whole screen
          // that's the whole page, so the app's own controls stay on top of the creation.
          void (embedded ? wrapper.current : document.documentElement)
            ?.requestFullscreen?.()
            .catch(() => {});
          break;
        case 'ui:toast':
          callbacks.current.onToast(msg.text);
          break;
        case 'pong':
          state.lastPong = Date.now();
          setStuck(false);
          break;
        case 'error':
          console.warn(`[${opened.creation.title}]`, msg.message);
          break;
        case 'perf':
          callbacks.current.onPerf?.(msg);
          break;
        case 'save:get':
        case 'save:set': {
          const url = `/api/creations/${opened.creation.id}/data/${msg.scope}/${encodeURIComponent(msg.key)}`;
          const local = `${msg.scope}/${msg.key}`;
          if (offline && msg.type === 'save:get' && !trialSaves.has(local)) {
            send({
              type: 'result',
              re: msg.id,
              ok: true,
              data: { value: null, schemaVersion: null, version: null },
            });
            break;
          }
          if ((opened.trial || offline) && msg.type === 'save:set') {
            const row = trialSaves.get(local);
            const version = (row?.version ?? 0) + 1;
            trialSaves.set(local, { value: msg.value, schemaVersion: msg.schemaVersion, version });
            send({ type: 'result', re: msg.id, ok: true, data: { version } });
            break;
          }
          if ((opened.trial || offline) && trialSaves.has(local)) {
            send({
              type: 'result',
              re: msg.id,
              ok: true,
              data: trialSaves.get(local) as unknown as Json,
            });
            break;
          }
          try {
            const data =
              msg.type === 'save:get'
                ? await api<Json>(url)
                : await api<Json>(url, {
                    method: 'PUT',
                    json: {
                      value: msg.value,
                      schemaVersion: msg.schemaVersion,
                      basedOn: msg.basedOn ?? null,
                    },
                  });
            const stored = (data as { schemaVersion?: number | null } | null)?.schemaVersion;
            if (
              !opened.trial &&
              msg.type === 'save:get' &&
              saveVersion !== null &&
              stored != null &&
              stored > saveVersion
            )
              callbacks.current.onOutdated?.();
            send({ type: 'result', re: msg.id, ok: true, data });
          } catch (err) {
            const e = err as ApiError;
            if (e.code === 'outdated') callbacks.current.onOutdated?.();
            const code = e.status === 409 ? 'stale' : e.status === 413 ? 'too-big' : 'denied';
            send({ type: 'result', re: msg.id, ok: false, error: e.message, code });
          }
          break;
        }
        case 'mp:shared':
          if (room) {
            const id = nextShared++;
            pendingShared.set(id, msg.id);
            room.send('shared', { id, key: msg.key, value: msg.value });
          } else {
            // Alone: keep it here.
            shared.set(msg.key, msg.value);
            send({ type: 'result', re: msg.id, ok: true });
            send({ type: 'mp:shared', data: { key: msg.key, value: msg.value, by: myId } });
          }
          break;
        case 'mp:send':
          room?.send('send', { kind: msg.kind, body: msg.body, ...(msg.to ? { to: msg.to } : {}) });
          break;
        case 'connector:call':
        case 'connector:status':
        case 'connector:link':
          await connector(msg);
          break;
        default:
          break;
      }
    };

    // ---- Connectors: services the server's owner installed, called as this person ----------
    // Only what this version declares; the server checks everything again (approval, the
    // person's own link, the operation's schema). A trial passes its own version, so the server
    // lets it read and never write.
    let installed: { at: number; list: Promise<ConnectorInfo[]> } | null = null;
    const connector = async (msg: Extract<CreationMessage, { type: `connector:${string}` }>) => {
      const fail = (error: string, code: ResultCode, details?: Json) =>
        send({
          type: 'result',
          re: msg.id,
          ok: false,
          error,
          code,
          ...(details !== undefined ? { details } : {}),
        });
      // The Studio's live preview: nothing goes out (the creation sees it as unreachable).
      if (offline) return fail('Connected services are off in this preview.', 'upstream');
      const declared = opened.connectors?.find((c) => c.id === msg.connector);
      if (!declared || (msg.type === 'connector:call' && !declared.ops.includes(msg.op)))
        return fail(`This creation doesn't ask to use ${msg.connector}.`, 'not-approved');
      if (msg.type === 'connector:call') {
        try {
          const answer = await api<{ status: number; data: Json }>(
            `/api/creations/${opened.creation.id}/connectors/${msg.connector}/call`,
            {
              method: 'POST',
              json: {
                versionId: opened.creation.versionId,
                op: msg.op,
                ...(msg.params !== undefined ? { params: msg.params } : {}),
                ...(msg.body !== undefined ? { body: msg.body } : {}),
                ...(msg.idempotencyKey !== undefined ? { idempotencyKey: msg.idempotencyKey } : {}),
              },
            },
          );
          send({
            type: 'result',
            re: msg.id,
            ok: true,
            data: { status: answer.status, data: answer.data },
          });
        } catch (err) {
          const f = callFailure(err);
          fail(f.error, f.code, f.details);
        }
        return;
      }
      let info: ConnectorInfo | undefined;
      try {
        // Asked often (a creation checking on start, after linking): one answer per few seconds.
        if (!installed || Date.now() - installed.at > 5000)
          installed = { at: Date.now(), list: loadConnectors() };
        const list = installed.list;
        list.catch(() => {
          if (installed?.list === list) installed = null;
        });
        info = (await list).find((c) => c.id === msg.connector);
      } catch (err) {
        return fail((err as Error).message, 'upstream');
      }
      if (msg.type === 'connector:status') {
        send({
          type: 'result',
          re: msg.id,
          ok: true,
          data: {
            installed: Boolean(info),
            linked: Boolean(info?.linked && !info.broken),
            broken: Boolean(info?.broken),
            displayName: info?.displayName ?? null,
            scopes: info?.scopes ?? [],
            accountName: (info?.linked && !info.broken && info.accountName) || null,
          },
        });
        return;
      }
      if (!info) return fail(`${msg.connector} isn't set up on this server.`, 'denied');
      callbacks.current.setLinkCard(info);
      send({ type: 'result', re: msg.id, ok: true });
    };
    const initData = (): InitData => ({
      protocolVersion: PROTOCOL_VERSION,
      creation: {
        id: opened.creation.id,
        version: opened.creation.version,
        title: opened.creation.title,
      },
      me: meRef.current,
      players,
      session: { id: room?.roomId ?? 'alone', mode: room ? mode : 'solo', hostId },
      tier,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      locale: navigator.language,
      viewport: viewport(),
    });
    window.addEventListener('message', onMessage);

    // ---- Screen size, gamepads, and checking it's still responding ---------------------------
    const onResize = () => send({ type: 'viewport', data: viewport() });
    window.addEventListener('resize', onResize);
    let lastPads = '';
    let raf = 0;
    let lastPadSend = 0;
    const pollPads = (now: number) => {
      raf = requestAnimationFrame(pollPads);
      if (now - lastPadSend < 33) return;
      const pads: GamepadState[] = [];
      for (const g of navigator.getGamepads?.() ?? []) {
        if (!g) continue;
        pads.push({
          index: g.index,
          axes: g.axes.map((a) => Math.round(a * 100) / 100),
          buttons: g.buttons.map((b) => Math.round(b.value * 100) / 100),
        });
      }
      const text = JSON.stringify(pads);
      if (text !== lastPads) {
        lastPads = text;
        lastPadSend = now;
        send({ type: 'gamepads', data: pads });
      }
    };
    raf = requestAnimationFrame(pollPads);
    let n = 0;
    const pinger = window.setInterval(() => {
      send({ type: 'ping', n: n++ });
      if (state.ready && Date.now() - state.lastPong > 5000) setStuck(true);
    }, 1000);
    const onVisibility = () => {
      send({ type: document.hidden ? 'pause' : 'resume' });
      // Time with the app out of sight isn't counted as time in the creation.
      room?.send('away', document.hidden);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      closed = true;
      window.removeEventListener('message', onMessage);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(raf);
      window.clearInterval(pinger);
      void room?.leave();
      bridge.current = null;
    };
  }, [opened, mode, myId, tier, offline, embedded]);

  useEffect(() => {
    bridge.current?.updateMe(me);
  }, [me]);

  // People talking: the creation's own sound dips (creations made before this ignore it).
  useEffect(() => {
    if (bridge.current?.ready) bridge.current.send({ type: 'duck', level: duck });
  }, [duck]);

  // Leaving: let the creation save, then take it away (after 2 s at most).
  useEffect(() => {
    if (!leaving) return;
    bridge.current?.send({ type: 'exit-requested' });
    const t = window.setTimeout(() => callbacks.current.onLeft(), 2000);
    return () => window.clearTimeout(t);
  }, [leaving]);

  return (
    <div
      className={embedded ? 'creation-host creation-host--embedded' : 'creation-host'}
      ref={wrapper}
    >
      <iframe
        ref={frame}
        className="creation-frame"
        title={opened.creation.title}
        src={opened.url}
        sandbox="allow-scripts allow-pointer-lock"
        allow="autoplay"
        referrerPolicy="no-referrer"
      />
      {linkCard && (
        <ConnectorLinkCard
          connector={linkCard}
          creationTitle={opened.creation.title}
          returnTo={linkReturnTo ?? `${window.location.pathname}${window.location.search}`}
          onClose={() => setLinkCard(null)}
        />
      )}
      {stuck && (
        <div className="creation-stuck" role="alertdialog" aria-label="Not responding">
          <p>{opened.creation.title} has stopped responding.</p>
          <div className="creation-stuck-actions">
            <button
              type="button"
              className="ats-button ats-button--ghost"
              onClick={() => setStuck(false)}
            >
              <Icon name="hourglass" size={16} />
              Wait
            </button>
            <button
              type="button"
              className="ats-button ats-button--primary"
              onClick={() => callbacks.current.onLeft()}
            >
              <Icon name="back" size={16} />
              Leave
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function viewport(): Viewport {
  const css = getComputedStyle(document.documentElement);
  const px = (name: string) => Number.parseFloat(css.getPropertyValue(name)) || 0;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    orientation: window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait',
    safeArea: {
      top: px('--ats-safe-top'),
      right: px('--ats-safe-right'),
      bottom: px('--ats-safe-bottom'),
      left: px('--ats-safe-left'),
    },
    dpr: window.devicePixelRatio,
    touch: window.matchMedia('(pointer: coarse)').matches,
  };
}
