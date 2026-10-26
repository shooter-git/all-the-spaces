import { REMOVED_FROM_GROUP } from '@ats/shared/topics';
import type { SpaceViewer } from '@ats/viewer-core';
import { Client, CloseCode, getStateCallbacks, type Room } from '@colyseus/sdk';
import { api } from './api.ts';
import { deviceKind } from './device.ts';

export interface OnlinePerson {
  sessionId: string;
  id: string;
  name: string;
  color: string;
  room: string;
}

interface PlayerLike {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  room: string;
  moving: boolean;
  /** When they took this pose, on their clock (0 or missing: not said). */
  at?: number;
}

/**
 * 20 updates a second, as often as the server sends them on: sent from the frame loop, each
 * with the time it was taken, so others can draw the walk evenly however unevenly it arrives.
 */
const SEND_EVERY_MS = 50;

/** Being in a space's live presence. */
export interface Presence {
  leave: () => void;
  /** This group can talk (the server has voice chat, and the Architects allow it). */
  voice: boolean;
  /** A pass to the voice room of the room you're in (the real-time service decides). */
  voicePass: () => Promise<{ room: string; token: string } | { error: string }>;
  /** Where someone you can see is (by user id). */
  whereIs: (userId: string) => { x: number; y: number; z: number } | null;
}

/** Waits between attempts to get back in after a drop: 1 s, 2 s, 4 s … up to 30 s. */
const rejoinDelay = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);

/**
 * Joins the live presence room of a space: shows other people as avatars and sends where you are.
 * If the connection drops (a phone sleeping, a change of network), it gets back in by itself.
 */
export async function joinPresence(
  spaceId: string,
  viewer: SpaceViewer,
  onRoster: (people: OnlinePerson[]) => void,
  onStatus: (status: 'connected' | 'reconnecting' | 'offline') => void,
  /** Room privacy changed: reload what this person may see. */
  onSpaceChanged: () => void = () => {},
  /** They were taken out of the group. */
  onRemoved: () => void = () => {},
): Promise<Presence> {
  /** The connection now (none while getting back in). */
  let room: Room | null = null;
  /** leave() was called: stay out. */
  let left = false;
  /** Dropped, and getting back in. */
  let reconnecting = false;
  let joining = false;
  let attempt = 0;
  let retryTimer: number | undefined;
  /** People shown as avatars (cleared on a drop: they'd only stand frozen). */
  const shown = new Set<string>();
  let lastSent = '';
  /** When this connection joined: poses carry the time since (ms, never going back). */
  let joinedAt = 0;
  let lastAt = 0;
  let passWaiting: ((answer: { room: string; token: string } | { error: string }) => void) | null =
    null;

  const forget = () => {
    for (const sessionId of shown) viewer.avatars.remove(sessionId);
    shown.clear();
    onRoster([]);
  };

  /** A fresh ticket each time: the last one may have expired while the phone slept. */
  const connect = async () => {
    const { ticket, shard, voice } = await api<{
      ticket: string;
      shard?: number;
      voice?: boolean;
    }>(`/api/spaces/${spaceId}/realtime-ticket`, { method: 'POST', json: {} });
    const client = new Client(`${window.location.origin}/rt`);
    client.auth.token = ticket;
    const joined: Room = await client.joinOrCreate('space', {
      spaceId,
      shard: shard ?? 0,
      device: deviceKind(),
    });
    if (left) {
      joined.leave().catch(() => {});
      return voice === true;
    }
    // The server doesn't hold a dropped seat, so the SDK's own reconnection can't work; it would
    // only delay joining afresh.
    joined.reconnection.enabled = false;
    room = joined;
    reconnecting = false;
    attempt = 0;
    lastSent = '';
    joinedAt = performance.now();
    lastAt = 0;
    follow(joined);
    onStatus('connected');
    return voice === true;
  };

  const rejoin = () => {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    if (left || room || joining) return;
    joining = true;
    connect()
      .catch(() => {
        if (!left) retryLater();
      })
      .finally(() => {
        joining = false;
      });
  };
  const retryLater = () => {
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(rejoin, rejoinDelay(attempt++));
  };

  const follow = (r: Room) => {
    const $ = getStateCallbacks(r);
    const state = r.state as {
      players: Map<string, PlayerLike>;
      roster: Map<string, { id: string; name: string; color: string; room: string }>;
    };
    const pose = (p: PlayerLike) => ({
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      moving: p.moving,
      at: p.at ?? 0,
    });

    // Players arrive only while they're near you (the server decides who that is).
    $(state).players.onAdd((player: PlayerLike, sessionId: string) => {
      if (sessionId === r.sessionId) return;
      shown.add(sessionId);
      viewer.avatars.add(sessionId, { name: player.name, color: player.color }, pose(player));
      $(player).onChange(() => viewer.avatars.push(sessionId, pose(player)));
    });
    $(state).players.onRemove((_p: PlayerLike, sessionId: string) => {
      shown.delete(sessionId);
      viewer.avatars.remove(sessionId);
    });

    const publishRoster = () =>
      onRoster(
        [...state.roster.entries()].map(([sessionId, entry]) => ({
          sessionId,
          id: entry.id,
          name: entry.name,
          color: entry.color,
          room: entry.room,
        })),
      );
    $(state).roster.onAdd((entry: { room: string }) => {
      $(entry).onChange(publishRoster);
      publishRoster();
    });
    $(state).roster.onRemove(publishRoster);

    r.onMessage('space-changed', onSpaceChanged);
    r.onMessage('voice', (answer) => {
      passWaiting?.(answer);
      passWaiting = null;
    });
    r.onLeave((code) => {
      if (room !== r) return;
      room = null;
      forget();
      if (left) return;
      if (code === REMOVED_FROM_GROUP) return onRemoved();
      // Joined from another tab or device (the server's way of saying so), or left on purpose.
      if (code === CloseCode.CONSENTED) return onStatus('offline');
      reconnecting = true;
      onStatus('reconnecting');
      retryLater();
    });
  };

  const voice = await connect();

  // Back online, or back to this tab after the phone slept: try straight away.
  const wake = () => {
    if (document.visibilityState !== 'visible' || !reconnecting || joining) return;
    attempt = 0;
    rejoin();
  };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);
  // Time with the app out of sight (another tab, a locked phone) isn't counted as time here.
  const sight = () => room?.send('away', document.visibilityState !== 'visible');
  document.addEventListener('visibilitychange', sight);

  let lastTeleports = viewer.teleports;
  let nextSend = 0;
  const sendPose = () => {
    const now = performance.now();
    if (now < nextSend) return;
    // On the beat where frames allow; after a stall, start afresh rather than catch up.
    nextSend = now - nextSend > SEND_EVERY_MS ? now + SEND_EVERY_MS : nextSend + SEND_EVERY_MS;
    const p = viewer.pose();
    if (!p.roomKey || !room) return;
    const teleport = viewer.teleports !== lastTeleports;
    lastTeleports = viewer.teleports;
    const message = {
      x: round(p.x),
      y: round(p.y),
      z: round(p.z),
      yaw: round(p.yaw),
      room: p.roomKey,
      moving: p.moving,
      teleport,
    };
    const key = JSON.stringify(message);
    if (key === lastSent) return; // standing still: nothing to send
    lastSent = key;
    lastAt = Math.max(lastAt + 1, Math.round(now - joinedAt));
    room.send('pose', { ...message, at: lastAt });
  };
  const otherFrame = viewer.onFrame;
  const onFrame = (dt: number) => {
    otherFrame?.(dt);
    sendPose();
  };
  viewer.onFrame = onFrame;

  return {
    voice,
    voicePass: () =>
      new Promise((resolve) => {
        if (!room) return resolve({ error: 'offline' });
        passWaiting?.({ error: 'replaced' });
        passWaiting = resolve;
        room.send('voice');
        window.setTimeout(() => {
          if (passWaiting === resolve) {
            passWaiting = null;
            resolve({ error: 'timeout' });
          }
        }, 5000);
      }),
    whereIs: (userId) => {
      const players = (room?.state as { players?: Map<string, PlayerLike> } | undefined)?.players;
      for (const p of players?.values() ?? [])
        if (p.id === userId) return { x: p.x, y: p.y, z: p.z };
      return null;
    },
    leave: () => {
      left = true;
      if (viewer.onFrame === onFrame) {
        if (otherFrame) viewer.onFrame = otherFrame;
        else delete viewer.onFrame;
      }
      window.clearTimeout(retryTimer);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      document.removeEventListener('visibilitychange', sight);
      // The state may never have arrived (a quick visit, or the service was unreachable).
      for (const sessionId of shown) viewer.avatars.remove(sessionId);
      shown.clear();
      room?.leave().catch(() => {});
      room = null;
    },
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
