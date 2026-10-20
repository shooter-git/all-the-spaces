import { randomUUID } from 'node:crypto';
import { VISIT_HEARTBEAT_MS, type VisitBatch, type VisitPlace, type VisitStart } from '@ats/shared';
import { log } from './log.ts';

/** How often waiting visits are sent. */
const SEND_EVERY_MS = 10_000;
/** Most visits (started, and ended) in one request: more go in the next. */
const BATCH = 500;
/** Most visits kept waiting while the server can't be reached; the oldest go first. */
const MAX_WAITING = 20_000;

/**
 * Visits on their way to the server: time someone spent in a room of a place, or in a creation.
 * Rooms say when a visit starts and ends; this sends them in batches every few seconds, and once a
 * minute says which are still going, so any a stopped service left open can be ended when they
 * were last seen. One per process; nothing here touches the database (the server writes them).
 */
export class VisitLog {
  /** Started, not sent yet. */
  private readonly starting = new Map<string, VisitStart>();
  /** Sent, and ended since: not sent yet. */
  private readonly ending = new Map<string, number>();
  /** Sent and still going. */
  private readonly going = new Set<string>();
  private lastHeartbeat = Number.NEGATIVE_INFINITY;
  private sending: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private lastWarning = Number.NEGATIVE_INFINITY;
  private readonly send: (batch: VisitBatch) => Promise<void>;
  private readonly now: () => number;

  constructor(send: (batch: VisitBatch) => Promise<void>, now: () => number = Date.now) {
    this.send = send;
    this.now = now;
  }

  /** Sends what's waiting every few seconds (until `stop`). */
  begin(every = SEND_EVERY_MS) {
    this.timer = setInterval(() => void this.flush(), every);
    this.timer.unref();
    return this;
  }

  start(place: VisitPlace, at = this.now()): string {
    const id = randomUUID();
    this.starting.set(id, { ...place, id, startedAt: at });
    if (this.starting.size + this.ending.size > MAX_WAITING) {
      const [oldest] = this.starting.keys();
      if (oldest) this.starting.delete(oldest);
    }
    return id;
  }

  end(id: string, at = this.now()) {
    const waiting = this.starting.get(id);
    if (waiting) {
      if (waiting.endedAt === undefined) waiting.endedAt = Math.max(at, waiting.startedAt);
    } else if (this.going.delete(id)) this.ending.set(id, at);
  }

  /** Sends everything waiting (and, once a minute, which visits are still going). */
  flush(): Promise<void> {
    this.sending ??= this.sendWaiting().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  /** Ends every visit still going and sends them: the service is stopping. */
  async stop() {
    clearInterval(this.timer);
    const now = this.now();
    for (const id of [...this.going]) this.end(id, now);
    for (const v of this.starting.values()) this.end(v.id, now);
    while (this.sending) await this.sending;
    await this.flush();
  }

  private async sendWaiting() {
    let heartbeat = this.now() - this.lastHeartbeat >= VISIT_HEARTBEAT_MS;
    while (heartbeat || this.starting.size || this.ending.size) {
      const now = this.now();
      const started = [...this.starting.values()].slice(0, BATCH);
      const ended = [...this.ending].slice(0, BATCH).map(([id, at]) => ({ id, at }));
      // Counted as sent straight away, so a visit ending while this is on its way ends properly.
      for (const v of started) {
        this.starting.delete(v.id);
        if (v.endedAt === undefined) this.going.add(v.id);
      }
      for (const e of ended) this.ending.delete(e.id);
      try {
        await this.send({ now, started, ended, ...(heartbeat ? { going: [...this.going] } : {}) });
        if (heartbeat) this.lastHeartbeat = now;
        heartbeat = false;
      } catch (err) {
        // Kept for the next try, with anything that ended meanwhile.
        for (const v of started) {
          const endedAt = this.going.delete(v.id) ? undefined : this.ending.get(v.id);
          if (endedAt !== undefined) {
            v.endedAt = endedAt;
            this.ending.delete(v.id);
          }
          this.starting.set(v.id, v);
        }
        for (const e of ended) this.ending.set(e.id, e.at);
        if (now - this.lastWarning > 60_000) {
          this.lastWarning = now;
          log.warn({ err, waiting: this.starting.size + this.ending.size }, 'visits not sent yet');
        }
        return;
      }
    }
  }
}

/** Sends batches to the server's internal endpoint. A batch it refuses isn't tried again. */
export const postVisits =
  (serverUrl: string, secret: string) =>
  async (batch: VisitBatch): Promise<void> => {
    const res = await fetch(`${serverUrl}/internal/visits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-realtime-secret': secret },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 500) throw new Error(`The server answered ${res.status}`);
    if (!res.ok) log.warn({ status: res.status }, 'the server refused some visits');
  };

/** How long someone stays in a room before it counts as a visit there. */
export const SETTLE_MS = 10_000;

interface Stay {
  userId: string;
  room: string;
  /** The visit under way (none while the app is out of sight). */
  visit: string | null;
  /** A room they've walked into, and when, until they've stayed long enough. */
  next: { room: string; at: number } | null;
}

/**
 * Visits to the rooms of one place as people move about. A room counts once someone has stayed
 * `SETTLE_MS`: walking through a hallway doesn't, and its few seconds go to the room they came
 * from. Time with the app out of sight (another tab, a locked phone) isn't counted.
 */
export class RoomVisits {
  /** By session. */
  private readonly stays = new Map<string, Stay>();
  private readonly visits: VisitLog;
  private readonly spaceId: string;

  constructor(visits: VisitLog, spaceId: string) {
    this.visits = visits;
    this.spaceId = spaceId;
  }

  /** Someone (`key`: their session) is in `room` now. */
  moved(key: string, userId: string, room: string, at: number) {
    const stay = this.stays.get(key);
    if (!stay) {
      this.stays.set(key, { userId, room, visit: this.begin(userId, room, at), next: null });
    } else if (!stay.visit) {
      stay.room = room;
    } else if (room === stay.room) {
      stay.next = null;
    } else if (stay.next?.room !== room) {
      stay.next = { room, at };
    }
  }

  /** Rooms people have stayed in long enough become visits (called every second or so). */
  tick(now: number) {
    for (const stay of this.stays.values()) {
      if (!stay.visit || !stay.next || now - stay.next.at < SETTLE_MS) continue;
      this.visits.end(stay.visit, stay.next.at);
      stay.room = stay.next.room;
      stay.visit = this.begin(stay.userId, stay.room, stay.next.at);
      stay.next = null;
    }
  }

  /** Their app went out of sight (`away`), or came back. */
  away(key: string, away: boolean, at: number) {
    const stay = this.stays.get(key);
    if (!stay || away === !stay.visit) return;
    if (away && stay.visit) {
      this.visits.end(stay.visit, at);
      stay.visit = null;
      // Back where they are now.
      if (stay.next) stay.room = stay.next.room;
      stay.next = null;
    } else {
      stay.visit = this.begin(stay.userId, stay.room, at);
    }
  }

  left(key: string, at: number) {
    const stay = this.stays.get(key);
    if (stay?.visit) this.visits.end(stay.visit, at);
    this.stays.delete(key);
  }

  private begin(userId: string, roomKey: string, at: number) {
    return this.visits.start({ userId, spaceId: this.spaceId, roomKey }, at);
  }
}
