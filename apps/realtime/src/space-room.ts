import {
  canSeeRoom,
  policyTopic,
  REMOVED_FROM_GROUP,
  type RealtimeTicket,
  type SpaceAccess,
  verifyTicket,
} from '@ats/shared';
import { type Client, Protocol, Room } from '@colyseus/core';
import { StateView, schema, t } from '@colyseus/schema';
import { z } from 'zod';
import { log } from './log.ts';
import { cpuMeter, Timings } from './stats.ts';
import { RoomVisits, type VisitLog } from './visits.ts';
import { spaceVoiceRoom, type Voice } from './voice.ts';

/** A person walking around the space. Only sent to people nearby (see `updateViews`). */
export const Player = schema(
  {
    id: t.string(),
    name: t.string(),
    color: t.string(),
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    yaw: t.float32(),
    room: t.string(),
    moving: t.boolean(),
    /**
     * When they took this pose, in ms on their own clock since joining (0: their app doesn't
     * say). Viewers draw movement on this clock, so uneven delivery doesn't make uneven walking.
     */
    at: t.uint32(),
  },
  'Player',
);
export type Player = InstanceType<typeof Player>;

/**
 * Who is online and roughly where — sent to everyone (the "people" list). `room` is only filled
 * in for rooms the whole group may see; elsewhere it says `private`.
 */
export const RosterEntry = schema(
  { id: t.string(), name: t.string(), color: t.string(), room: t.string() },
  'RosterEntry',
);
export type RosterEntry = InstanceType<typeof RosterEntry>;

export const SpaceState = schema(
  { players: t.map(Player).view(), roster: t.map(RosterEntry) },
  'SpaceState',
);
export type SpaceState = InstanceType<typeof SpaceState>;

interface Graph {
  rooms: { key: string; name: string; floorKey: string; neighbors: string[] }[];
  links: { key: string; rooms: string[] }[];
  access: SpaceAccess;
  /** The group allows voice chat. */
  voice?: boolean;
}

/** What the people list shows for someone in `room`. */
export const PRIVATE_ROOM = 'private';

const Pose = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  yaw: z.number().finite(),
  room: z.string().max(64),
  moving: z.boolean(),
  /** Set when jumping (quick travel, lift) rather than walking. */
  teleport: z.boolean().optional(),
  /** When the pose was taken: ms since joining, on the sender's clock (older apps don't send it). */
  at: z.number().int().min(1).max(0xffffffff).optional(),
});

const MAX_SPEED = 8; // m/s — generous running speed; anything faster must be a declared teleport
const MAX_TELEPORTS_PER_10S = 6;
/** How far a sender's clock may run ahead of the time since they joined, as the server sees it. */
const CLOCK_SLACK_MS = 2000;

export interface SpaceRoomOptions {
  secret: string;
  serverUrl: string;
}

type Auth = RealtimeTicket;

const NOWHERE = new Set<string>();

const shardTopic = (spaceId: string) => `space-shards:${spaceId}`;
/** Someone in another shard, as shards tell each other (`s` is their session there). */
interface Shared {
  s: string;
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  room: string;
  moving: boolean;
  /** Their own time for the pose (see `Player.at`); missing from older servers. */
  at?: number;
}
type ShardMessage =
  | { t: 'people'; from: string; people: Shared[] }
  | { t: 'left'; from: string; s: string }
  | { t: 'joined'; from: string; id: string };

/**
 * Live presence for one space. Each person only receives updates about people in their own room
 * and the rooms next to it, so a large building with many visitors stays light for every device.
 *
 * A big group's space has several of these rooms (shards: one per `MEMBERS_PER_SHARD` members,
 * each person always in the same one): each sends updates only to its own people, so no single
 * update goes out to everyone.
 * Shards tell each other where their people are (through presence, 20 times a second), so
 * everyone still sees everyone nearby, whichever shard they're in.
 */

export class SpaceRoom extends Room<{ state: SpaceState }> {
  static options: SpaceRoomOptions;
  /** Voice chat, when the server has it set up. */
  static voice: Voice | null = null;
  /** Log how long each update takes every this many seconds (ATS_REALTIME_STATS); 0: never. */
  static statsEvery = 0;
  /** Where visits to rooms are recorded (none: not recorded). */
  static visits: VisitLog | null = null;
  maxClients = 200;
  state = new SpaceState();

  private neighbours = new Map<string, Set<string>>();
  private access: SpaceAccess = { architects: [], rooms: {} };
  private spaceId = '';
  private shard = 0;
  private readonly onPolicyChange = () => {
    this.refreshAccess().catch((err) => log.warn({ err }, 'could not refresh room access'));
  };
  private readonly lastPose = new Map<string, { x: number; y: number; z: number; at: number }>();
  private readonly teleports = new Map<string, number[]>();
  /** When each client joined (for checking the times they send). */
  private readonly joinedAt = new Map<string, number>();
  /** Players each client currently receives. */
  private readonly visible = new Map<string, Set<string>>();
  /** The voice room each client was given a pass for. */
  private readonly voiceRooms = new Map<string, string>();
  private readonly voiceAsks = new Map<string, number[]>();
  private voiceAllowed = true;
  /** Who is in each room (session ids), so a view only looks at the rooms next to it. */
  private readonly whereabouts = new Map<string, Set<string>>();
  /** People in other shards: when each was last heard of. */
  private readonly remote = new Map<string, number>();
  /** This shard's people who moved since the last time other shards were told. */
  private readonly moved = new Set<string>();
  private readonly onShard = (message: ShardMessage) => this.fromShard(message);
  private readonly patchTimings = new Timings();
  private readonly viewTimings = new Timings();
  /** Time each of this shard's people spends in each room. */
  private roomVisits: RoomVisits | null = null;

  async onCreate(options: { spaceId: string; shard?: number }) {
    this.setPatchRate(50); // 20 updates a second
    this.autoDispose = true;
    this.spaceId = options.spaceId;
    this.shard = options.shard ?? 0;
    await this.loadGraph(options.spaceId);
    // Room privacy changes apply straight away: re-read who may see what.
    await this.presence.subscribe(policyTopic(options.spaceId), this.onPolicyChange);
    this.onMessage('pose', (client, message) => this.handlePose(client, message));
    this.onMessage('voice', (client) => {
      this.voicePass(client).catch((err) => log.warn({ err }, 'voice pass failed'));
    });
    // Their app went out of sight (another tab, a locked phone), or came back.
    this.onMessage('away', (client, away) => {
      this.roomVisits?.away(client.sessionId, away === true, Date.now());
    });
    if (SpaceRoom.visits) {
      const visits = new RoomVisits(SpaceRoom.visits, options.spaceId);
      this.roomVisits = visits;
      this.clock.setInterval(() => visits.tick(Date.now()), 1000);
    }
    // No periodic pass over who sees whom: everything that changes it (moving room, privacy,
    // people arriving and leaving, here or in another shard) updates views as it happens.
    await this.presence.subscribe(shardTopic(options.spaceId), this.onShard);
    this.clock.setInterval(() => this.tellShards(), 50);
    this.clock.setInterval(() => this.tellShards(true), 2000);
    this.clock.setInterval(() => this.forgetQuiet(), 1000);
    // ATS_REALTIME_STATS=<seconds> logs how long each update takes (used by the load test).
    const every = SpaceRoom.statsEvery;
    if (every > 0) {
      const cpu = cpuMeter();
      this.clock.setInterval(() => {
        log.info(
          {
            stats: 'space',
            spaceId: options.spaceId,
            room: this.roomId,
            clients: this.clients.length,
            patchMs: this.patchTimings.take(),
            viewsMs: this.viewTimings.take(),
            cpu: cpu(),
          },
          'stats',
        );
      }, every * 1000);
    }
  }

  /** Sends everyone what changed (20 times a second); timed for the stats. */
  override broadcastPatch() {
    return this.patchTimings.measure(() => super.broadcastPatch());
  }

  onDispose() {
    this.presence.unsubscribe(policyTopic(this.spaceId), this.onPolicyChange);
    this.presence.unsubscribe(shardTopic(this.spaceId), this.onShard);
  }

  // ---- Shards: telling each other where everyone is ------------------------------------------

  private publish(message: ShardMessage) {
    void this.presence.publish(shardTopic(this.spaceId), message);
  }

  /** Tells other shards who here moved (or, every couple of seconds, where everyone is). */
  private tellShards(all = false) {
    const people: Shared[] = [];
    for (const client of this.clients) {
      const s = client.sessionId;
      if (!all && !this.moved.has(s)) continue;
      const p = this.state.players.get(s);
      if (!p?.room) continue; // not placed yet
      people.push({
        s,
        id: p.id,
        name: p.name,
        color: p.color,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        room: p.room,
        moving: p.moving,
        at: p.at,
      });
    }
    this.moved.clear();
    if (people.length) this.publish({ t: 'people', from: this.roomId, people });
  }

  private fromShard(message: ShardMessage) {
    if (message.from === this.roomId) return;
    if (message.t === 'left') return this.forget(message.s);
    if (message.t === 'joined') {
      // One live avatar per person, across shards too.
      for (const c of this.clients) if ((c.auth as Auth)?.sub === message.id) c.leave(4000);
      return;
    }
    const now = Date.now();
    for (const p of message.people) {
      this.remote.set(p.s, now);
      let player = this.state.players.get(p.s);
      const arrived = !player;
      const moved = player?.room !== p.room;
      if (!player) {
        player = new Player().assign({ id: p.id, name: p.name, color: p.color, room: '' });
        this.state.players.set(p.s, player);
        this.state.roster.set(
          p.s,
          new RosterEntry().assign({ id: p.id, name: p.name, color: p.color, room: '' }),
        );
      }
      if (player.x !== p.x) player.x = p.x;
      if (player.y !== p.y) player.y = p.y;
      if (player.z !== p.z) player.z = p.z;
      if (player.yaw !== p.yaw) player.yaw = p.yaw;
      if (player.moving !== p.moving) player.moving = p.moving;
      if (p.at !== undefined && player.at !== p.at) player.at = p.at;
      if (arrived || moved) {
        this.place(p.s, player.room, p.room);
        player.room = p.room;
        const entry = this.state.roster.get(p.s);
        if (entry) entry.room = this.rosterRoom(p.room);
        const subject = player;
        this.viewTimings.measure(() => this.refreshSubject(p.s, subject));
      }
    }
  }

  /** Someone from another shard who left (or hasn't been heard of for a while). */
  private forget(sessionId: string) {
    if (!this.remote.delete(sessionId)) return;
    this.place(sessionId, this.state.players.get(sessionId)?.room ?? '', '');
    this.state.players.delete(sessionId);
    this.state.roster.delete(sessionId);
    for (const seen of this.visible.values()) seen.delete(sessionId);
  }

  private forgetQuiet() {
    const now = Date.now();
    for (const [s, at] of this.remote) if (now - at > 5000) this.forget(s);
  }

  private async refreshAccess() {
    await this.loadGraph(this.spaceId);
    // Out of voice rooms nobody may hear any more (voice turned off, or the room made private).
    for (const client of this.clients) {
      const room = this.state.players.get(client.sessionId)?.room ?? '';
      if (!this.voiceAllowed || !canSeeRoom(this.access, (client.auth as Auth).sub, room))
        this.leaveVoice(client);
    }
    this.state.roster.forEach((entry, sessionId) => {
      entry.room = this.rosterRoom(this.state.players.get(sessionId)?.room ?? '');
    });
    this.updateViews();
    // Viewers reload what they may see (rooms may have appeared or gone).
    this.broadcast('space-changed', {});
    // Someone taken out of the group leaves the space straight away.
    const members = this.access.members;
    if (members)
      for (const client of [...this.clients])
        if (!members.includes((client.auth as Auth).sub)) client.leave(REMOVED_FROM_GROUP);
  }

  /** The room shown in the people list: only rooms the whole group may see are named. */
  private rosterRoom(room: string) {
    if (!room) return '';
    return this.access.rooms[room]?.visibility === 'group' ? room : PRIVATE_ROOM;
  }

  static async onAuth(token: string, options: { spaceId?: string; shard?: number }): Promise<Auth> {
    const ticket = verifyTicket(token ?? '', SpaceRoom.options.secret);
    if (
      !ticket ||
      ticket.spaceId !== options.spaceId ||
      (ticket.shard ?? 0) !== (options.shard ?? 0)
    )
      throw new Error('Not allowed in this space');
    return ticket;
  }

  private async loadGraph(spaceId: string) {
    const res = await fetch(`${SpaceRoom.options.serverUrl}/internal/spaces/${spaceId}/graph`, {
      headers: { 'x-realtime-secret': SpaceRoom.options.secret },
    });
    if (!res.ok) throw new Error(`Could not load space ${spaceId}`);
    const graph = (await res.json()) as Graph;
    const map = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (!map.has(a)) map.set(a, new Set([a]));
      map.get(a)?.add(b);
    };
    for (const r of graph.rooms) {
      link(r.key, r.key);
      for (const n of r.neighbors) {
        link(r.key, n);
        link(n, r.key);
      }
    }
    // Lift stops aren't neighbours: a lift is closed, and the ride is instant. (Seeing every lift
    // lobby from every other made a tall building's lobbies see each other's crowds.) Someone
    // arriving by lift is shown straight away, because a room change updates views at once.
    this.neighbours = map;
    this.access = graph.access;
    this.voiceAllowed = graph.voice !== false;
  }

  onJoin(client: Client) {
    const auth = client.auth as Auth;
    // `onAuth` only saw the client's own options: joining by room id could name another space.
    if (auth.spaceId !== this.spaceId || (auth.shard ?? 0) !== this.shard)
      throw new Error('Not allowed in this space');
    client.view = new StateView();
    // An update with nothing in it (no one this person can see moved) isn't worth sending: in a
    // big building most people are alone or in twos, and every send is a system call.
    const raw = client.raw.bind(client);
    client.raw = (data, options, cb) => {
      if (data.length === 1 && data[0] === Protocol.ROOM_STATE_PATCH) return cb?.();
      raw(data, options, cb);
    };
    this.visible.set(client.sessionId, new Set());
    this.joinedAt.set(client.sessionId, Date.now());
    // One live avatar per person: joining from a second tab replaces the first.
    for (const other of this.clients) {
      if (other !== client && (other.auth as Auth)?.sub === auth.sub) other.leave(4000);
    }
    this.publish({ t: 'joined', from: this.roomId, id: auth.sub });
    const player = new Player().assign({
      id: auth.sub,
      name: auth.name,
      color: auth.color,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      room: '',
      moving: false,
      at: 0,
    });
    this.state.players.set(client.sessionId, player);
    this.state.roster.set(
      client.sessionId,
      new RosterEntry().assign({ id: auth.sub, name: auth.name, color: auth.color, room: '' }),
    );
  }

  onLeave(client: Client) {
    this.roomVisits?.left(client.sessionId, Date.now());
    this.leaveVoice(client);
    this.place(client.sessionId, this.state.players.get(client.sessionId)?.room ?? '', '');
    this.state.players.delete(client.sessionId);
    this.state.roster.delete(client.sessionId);
    this.visible.delete(client.sessionId);
    for (const seen of this.visible.values()) seen.delete(client.sessionId);
    this.moved.delete(client.sessionId);
    this.publish({ t: 'left', from: this.roomId, s: client.sessionId });
    this.lastPose.delete(client.sessionId);
    this.teleports.delete(client.sessionId);
    this.joinedAt.delete(client.sessionId);
  }

  private handlePose(client: Client, message: unknown) {
    const parsed = Pose.safeParse(message);
    if (!parsed.success) return;
    const pose = parsed.data;
    if (!this.neighbours.has(pose.room)) return; // unknown room
    // Nobody can be somewhere they may not see (their client doesn't even know it exists).
    if (!canSeeRoom(this.access, (client.auth as Auth).sub, pose.room)) return;
    const now = Date.now();
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    // Their clock only goes forward, and not faster than the server's.
    if (
      pose.at !== undefined &&
      (pose.at <= player.at ||
        pose.at > now - (this.joinedAt.get(client.sessionId) ?? now) + CLOCK_SLACK_MS)
    )
      return;
    const last = this.lastPose.get(client.sessionId);
    if (last && !pose.teleport) {
      const dt = Math.max(0.05, (now - last.at) / 1000);
      const dist = Math.hypot(pose.x - last.x, pose.y - last.y, pose.z - last.z);
      if (dist > MAX_SPEED * dt + 1) return; // too fast to be walking
    }
    if (pose.teleport) {
      const recent = (this.teleports.get(client.sessionId) ?? []).filter((t) => now - t < 10_000);
      if (recent.length >= MAX_TELEPORTS_PER_10S) return;
      recent.push(now);
      this.teleports.set(client.sessionId, recent);
    }
    this.lastPose.set(client.sessionId, { x: pose.x, y: pose.y, z: pose.z, at: now });
    this.moved.add(client.sessionId);
    // Only touch what changed: every changed field is encoded for every nearby person.
    if (player.x !== pose.x) player.x = pose.x;
    if (player.y !== pose.y) player.y = pose.y;
    if (player.z !== pose.z) player.z = pose.z;
    if (player.yaw !== pose.yaw) player.yaw = pose.yaw;
    if (player.moving !== pose.moving) player.moving = pose.moving;
    if (pose.at !== undefined) player.at = pose.at;
    if (player.room !== pose.room) {
      this.roomVisits?.moved(client.sessionId, player.id, pose.room, now);
      // Voice follows you: out of the old room's (ask again for the new one).
      this.leaveVoice(client);
      this.place(client.sessionId, player.room, pose.room);
      player.room = pose.room;
      const entry = this.state.roster.get(client.sessionId);
      if (entry) entry.room = this.rosterRoom(pose.room);
      // Only what this move changes: who they see now, and who sees them.
      this.viewTimings.measure(() => {
        this.refreshViewer(client);
        this.refreshSubject(client.sessionId, player);
      });
    }
  }

  /** Interest management: each client sees only the people in nearby rooms. */
  private updateViews() {
    this.viewTimings.measure(() => this.refreshViews());
  }

  private refreshViews() {
    for (const client of this.clients) this.refreshViewer(client);
  }

  /** Whether `client` should see `other` (in `sessionId`), and making it so. */
  private settle(client: Client, sessionId: string, other: Player, near: Set<string>) {
    const seen = this.visible.get(client.sessionId);
    if (!seen || !client.view) return;
    const should =
      sessionId !== client.sessionId &&
      near.has(other.room) &&
      canSeeRoom(this.access, (client.auth as Auth).sub, other.room);
    if (should && !seen.has(sessionId)) {
      client.view.add(other);
      seen.add(sessionId);
    } else if (!should && seen.has(sessionId)) {
      client.view.remove(other);
      seen.delete(sessionId);
    }
  }

  /** Everyone one client should see. */
  private refreshViewer(client: Client) {
    const me = this.state.players.get(client.sessionId);
    const seen = this.visible.get(client.sessionId);
    if (!me || !seen) return;
    const near = this.neighbours.get(me.room) ?? NOWHERE;
    // Who to look at: everyone in the rooms next to this person, and whoever they see now.
    const candidates = new Set(seen);
    for (const room of near)
      for (const s of this.whereabouts.get(room) ?? NOWHERE) candidates.add(s);
    for (const sessionId of candidates) {
      const other = this.state.players.get(sessionId);
      if (other) this.settle(client, sessionId, other, near);
      else seen.delete(sessionId);
    }
  }

  // ---- Voice ----------------------------------------------------------------------------------

  /** A pass to the voice room of the room this person is in, if they may hear it. */
  private async voicePass(client: Client) {
    const voice = SpaceRoom.voice;
    const auth = client.auth as Auth;
    const room = this.state.players.get(client.sessionId)?.room ?? '';
    if (!voice || !this.voiceAllowed) return client.send('voice', { error: 'off' });
    if (!room || !canSeeRoom(this.access, auth.sub, room))
      return client.send('voice', { error: 'room' });
    const now = Date.now();
    const asks = (this.voiceAsks.get(client.sessionId) ?? []).filter((t) => now - t < 60_000);
    if (asks.length >= 20) return client.send('voice', { error: 'busy' });
    this.voiceAsks.set(client.sessionId, [...asks, now]);
    const voiceRoom = spaceVoiceRoom(this.spaceId, room);
    if (this.voiceRooms.get(client.sessionId) !== voiceRoom) this.leaveVoice(client);
    this.voiceRooms.set(client.sessionId, voiceRoom);
    const token = await voice.pass(voiceRoom, { id: auth.sub, name: auth.name });
    client.send('voice', { room, token });
  }

  private leaveVoice(client: Client) {
    const voiceRoom = this.voiceRooms.get(client.sessionId);
    if (!voiceRoom) return;
    this.voiceRooms.delete(client.sessionId);
    SpaceRoom.voice?.remove(voiceRoom, (client.auth as Auth).sub);
  }

  /** Keeps `whereabouts` up to date as someone moves from one room to another ('' = nowhere). */
  private place(sessionId: string, from: string, to: string) {
    if (from === to) return;
    if (from) {
      const here = this.whereabouts.get(from);
      here?.delete(sessionId);
      if (here?.size === 0) this.whereabouts.delete(from);
    }
    if (to) {
      const there = this.whereabouts.get(to) ?? new Set<string>();
      there.add(sessionId);
      this.whereabouts.set(to, there);
    }
  }

  /** Everyone who should see one person (after they moved room). */
  private refreshSubject(sessionId: string, subject: Player) {
    for (const client of this.clients) {
      const me = this.state.players.get(client.sessionId);
      if (me) this.settle(client, sessionId, subject, this.neighbours.get(me.room) ?? NOWHERE);
    }
  }
}
