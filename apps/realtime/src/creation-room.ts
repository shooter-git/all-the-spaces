import {
  type CreationTicket,
  creationPlayersKey,
  memberRemovedTopic,
  REMOVED_FROM_GROUP,
  type VisitDevice,
  verifyToken,
} from '@ats/shared';
import { type Client, Room } from '@colyseus/core';
import { schema, t } from '@colyseus/schema';
import { z } from 'zod';
import { log } from './log.ts';
import { deviceOf, type VisitLog } from './visits.ts';
import { sessionVoiceRoom, type Voice } from './voice.ts';

/**
 * One live session of a creation: who's playing, who hosts, shared values and messages between
 * players. Generic — every creation uses the same room; the creation decides what the values
 * and messages mean. Creation code never runs here: this only relays and stores, within limits.
 */

export const SessionPlayer = schema(
  { id: t.string(), name: t.string(), color: t.string(), joinedAt: t.number() },
  'SessionPlayer',
);
export type SessionPlayer = InstanceType<typeof SessionPlayer>;

export const SessionState = schema(
  {
    players: t.map(SessionPlayer),
    hostId: t.string(),
    /** Shared values, as JSON text (the creation's own data). */
    shared: t.map('string'),
  },
  'SessionState',
);
export type SessionState = InstanceType<typeof SessionState>;

export const LIMITS = {
  /** One shared value, as JSON. */
  valueBytes: 32 * 1024,
  /** All shared values together. */
  totalBytes: 256 * 1024,
  keys: 256,
  /** Messages each player may send per second. */
  messagesPerSecond: 60,
  messageBytes: 16 * 1024,
  players: 16,
};

const KEY = /^[\w.:-]{1,128}$/;
const SharedMessage = z.object({
  id: z.number().int().min(0),
  key: z.string().regex(KEY),
  value: z.unknown(),
});
const SendMessage = z.object({
  kind: z.string().regex(KEY),
  body: z.unknown(),
  to: z.string().max(64).optional(),
});
const InviteMessage = z.object({ people: z.array(z.string().max(64)).max(64) });

export interface CreationRoomOptions {
  secret: string;
}

interface JoinOptions {
  creationId: string;
  versionId: string;
  mode: CreationTicket['mode'];
}

/** Keeps a count of players per shared session, for "Join others (n)". */
const countsKey = creationPlayersKey;

export class CreationRoom extends Room<{ state: SessionState }> {
  static options: CreationRoomOptions;
  /** Voice chat, when the server has it set up. */
  static voice: Voice | null = null;
  /** Where time in creations is recorded (none: not recorded). */
  static visits: VisitLog | null = null;
  state = new SessionState();
  maxClients = LIMITS.players;

  private creationId = '';
  private versionId = '';
  /** The creation's group, from the first ticket (every ticket for a creation names the same). */
  private groupId = '';
  private mode: CreationTicket['mode'] = 'shared';
  private owner = '';
  private readonly invited = new Set<string>();
  private readonly sent = new Map<string, number[]>();
  private totalBytes = 0;
  /** Each player's visit under way (null while their app is out of sight). */
  private readonly visitOf = new Map<string, string | null>();
  /** The kind of device each player is on, as their app said when it joined. */
  private readonly devices = new Map<string, VisitDevice>();

  /** Checks the ticket against the client's options, before a room is picked (see `onJoin`). */
  static async onAuth(token: string, options: JoinOptions): Promise<CreationTicket> {
    const ticket = verifyToken<CreationTicket>(
      'creation',
      token ?? '',
      CreationRoom.options.secret,
    );
    if (
      !ticket ||
      ticket.creationId !== options.creationId ||
      ticket.versionId !== options.versionId ||
      ticket.mode !== options.mode
    ) {
      throw new Error('Not allowed in this session');
    }
    return ticket;
  }

  onCreate(options: JoinOptions) {
    this.creationId = options.creationId;
    this.versionId = options.versionId;
    this.mode = options.mode;
    this.autoDispose = true;
    this.setPatchRate(50);
    if (this.mode !== 'shared') void this.setPrivate(true); // never matched to strangers
    // Someone taken out of the group leaves straight away, and can't be invited back in.
    void this.presence.subscribe(memberRemovedTopic, this.onRemoved);
    this.onMessage('shared', (client, message) => this.setShared(client, message));
    this.onMessage('send', (client, message) => this.relay(client, message));
    // Voice for this session: only the people in it get a pass (solo sessions have no one to
    // talk to), and only if their group allows voice.
    this.onMessage('voice', (client) => {
      const me = client.auth as CreationTicket;
      const voice = CreationRoom.voice;
      if (!voice || me.voice === false || this.mode === 'solo')
        return client.send('voice', { error: 'off' });
      voice
        .pass(sessionVoiceRoom(this.roomId), { id: me.sub, name: me.name })
        .then((token) => client.send('voice', { token }))
        .catch((err) => log.warn({ err }, 'voice pass failed'));
    });
    // Their app went out of sight (another tab, a locked phone), or came back.
    this.onMessage('away', (client, away) => {
      const visit = this.visitOf.get(client.sessionId);
      if (visit === undefined || (away === true) === (visit === null)) return;
      if (visit) CreationRoom.visits?.end(visit);
      this.visitOf.set(client.sessionId, away === true ? null : this.startVisit(client));
    });
    this.onMessage('invite', (client, message) => {
      const parsed = InviteMessage.safeParse(message);
      if (parsed.success && (client.auth as CreationTicket).sub === this.owner) {
        for (const id of parsed.data.people) this.invited.add(id);
      }
    });
  }

  onJoin(client: Client, options?: { device?: unknown }) {
    const me = client.auth as CreationTicket;
    // The options checked in `onAuth` are the client's own: joining by room id could name any
    // room, so the ticket must also match the session actually being joined.
    if (
      me.creationId !== this.creationId ||
      me.versionId !== this.versionId ||
      me.mode !== this.mode ||
      (me.sessionId !== undefined && me.sessionId !== this.roomId)
    ) {
      throw new Error('Not allowed in this session');
    }
    // Solo sessions are unjoinable; invite sessions only take the people invited.
    if (this.state.players.size > 0) {
      if (this.mode === 'solo' || (this.mode === 'invite' && !this.invited.has(me.sub))) {
        throw new Error('This session is private');
      }
    } else {
      this.owner = me.sub;
    }
    if (me.groupId) this.groupId ||= me.groupId;
    if ([...this.state.players.values()].some((p) => p.id === me.sub)) {
      // The same person from a second tab: the older one steps out.
      for (const other of this.clients) {
        if (other !== client && (other.auth as CreationTicket).sub === me.sub) other.leave(4000);
      }
    }
    this.state.players.set(
      client.sessionId,
      new SessionPlayer().assign({
        id: me.sub,
        name: me.name,
        color: me.color,
        joinedAt: Date.now(),
      }),
    );
    if (!this.state.hostId) this.state.hostId = me.sub;
    this.publishCount();
    const device = deviceOf(options);
    if (device) this.devices.set(client.sessionId, device);
    if (CreationRoom.visits) this.visitOf.set(client.sessionId, this.startVisit(client));
  }

  private startVisit(client: Client) {
    const me = client.auth as CreationTicket;
    return (
      CreationRoom.visits?.start({
        userId: me.sub,
        device: this.devices.get(client.sessionId),
        creationId: this.creationId,
        versionId: this.versionId,
        session: this.roomId,
      }) ?? null
    );
  }

  onLeave(client: Client) {
    CreationRoom.voice?.remove(sessionVoiceRoom(this.roomId), (client.auth as CreationTicket).sub);
    const me = client.auth as CreationTicket | undefined;
    this.state.players.delete(client.sessionId);
    this.sent.delete(client.sessionId);
    const visit = this.visitOf.get(client.sessionId);
    if (visit) CreationRoom.visits?.end(visit);
    this.visitOf.delete(client.sessionId);
    this.devices.delete(client.sessionId);
    if (
      me &&
      this.state.hostId === me.sub &&
      ![...this.state.players.values()].some((p) => p.id === me.sub)
    ) {
      // Hosting passes straight to whoever has been here longest.
      const next = [...this.state.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.state.hostId = next?.id ?? '';
    }
    this.publishCount();
  }

  private readonly onRemoved = (message: { groupId?: string; userId?: string }) => {
    if (!this.groupId || message.groupId !== this.groupId || !message.userId) return;
    this.invited.delete(message.userId);
    for (const client of [...this.clients])
      if ((client.auth as CreationTicket).sub === message.userId) client.leave(REMOVED_FROM_GROUP);
  };

  async onDispose() {
    this.presence.unsubscribe(memberRemovedTopic, this.onRemoved);
    if (this.mode === 'shared') {
      await this.presence.hdel(countsKey(this.creationId), this.roomId);
    }
  }

  private publishCount() {
    if (this.mode !== 'shared') return;
    const n = this.state.players.size;
    if (n === 0) void this.presence.hdel(countsKey(this.creationId), this.roomId);
    else void this.presence.hset(countsKey(this.creationId), this.roomId, String(n));
  }

  private allowed(client: Client) {
    const now = Date.now();
    const times = (this.sent.get(client.sessionId) ?? []).filter((t) => now - t < 1000);
    if (times.length >= LIMITS.messagesPerSecond) return false;
    times.push(now);
    this.sent.set(client.sessionId, times);
    return true;
  }

  private setShared(client: Client, message: unknown) {
    const parsed = SharedMessage.safeParse(message);
    if (!parsed.success) return;
    const { id, key, value } = parsed.data;
    const reply = (ok: boolean, error?: string, code?: string) =>
      client.send('shared-result', { id, ok, ...(error ? { error, code } : {}) });
    if (!this.allowed(client)) return reply(false, 'Too many changes at once.', 'denied');
    const text = JSON.stringify(value ?? null);
    const previous = this.state.shared.get(key);
    const total = this.totalBytes - (previous?.length ?? 0) + text.length;
    if (text.length > LIMITS.valueBytes || total > LIMITS.totalBytes) {
      return reply(false, 'That is too much to share.', 'too-big');
    }
    if (previous === undefined && this.state.shared.size >= LIMITS.keys) {
      return reply(false, 'Too many shared values.', 'too-big');
    }
    this.totalBytes = total;
    this.state.shared.set(key, text);
    // Who changed it, so creations can tell their own changes from others'.
    this.broadcast('shared-by', { key, by: (client.auth as CreationTicket).sub });
    reply(true);
  }

  private relay(client: Client, message: unknown) {
    const parsed = SendMessage.safeParse(message);
    if (!parsed.success || !this.allowed(client)) return;
    const body = parsed.data.body ?? null;
    if (JSON.stringify(body).length > LIMITS.messageBytes) return;
    const out = { from: (client.auth as CreationTicket).sub, kind: parsed.data.kind, body };
    const to = parsed.data.to;
    for (const other of this.clients) {
      if (other === client) continue;
      if (to && (other.auth as CreationTicket).sub !== to) continue;
      other.send('message', out);
    }
  }
}
