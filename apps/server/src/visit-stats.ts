import type { DeviceTime, PlaceVisits, VisitDevice } from '@ats/api-types';
import { type Db, schema } from '@ats/db';
import { type SQL, sql } from 'drizzle-orm';
import { recentVisits, visitEnd } from './visits.ts';

const { visits } = schema;

/** The periods there are, in days (the longest is how long visits are kept). */
export const VISIT_PERIODS = [7, 30, 90] as const;
/** Back within this long (from another tab, a locked phone) is still the same visit. */
const SAME_VISIT = "interval '5 minutes'";
/** Into another room within this long of leaving one is a move between them. */
const MOVE = "interval '1 minute'";

/** A time zone the browser named, if it's one we know; UTC otherwise. */
export function timeZoneOf(name: unknown): string {
  if (typeof name !== 'string' || !/^[A-Za-z][\w+\-/]{0,63}$/.test(name)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return name;
  } catch {
    return 'UTC';
  }
}

/** Today's date in a time zone, as YYYY-MM-DD. */
function today(timeZone: string, now: Date) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** A YYYY-MM-DD date `n` days on (or back). */
function addDays(day: string, n: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The middle of some numbers (0 for none). */
function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const secondsOf = (span: string) => `extract(epoch from upper(${span}) - lower(${span}))`;

/** Every number, rounded to whole seconds. */
const round = (n: number) => Math.round(n);

/** People, time, visits and time with others in one room or creation. */
interface PlaceTime {
  people: number;
  seconds: number;
  visits: number;
  togetherSeconds: number;
}

type Stats = Pick<PlaceVisits, 'summary' | 'trend' | 'week' | 'devices' | 'moves'> & {
  /** By room key, and by creation id. */
  rooms: Map<string, PlaceTime>;
  creations: Map<string, PlaceTime>;
  /** Everyone who spent time here, most first (names are the caller's to add). */
  people: Omit<PlaceVisits['people'][number], 'name' | 'color'>[];
};

/** Adds to one number of a list. */
const add = (list: number[], i: number, n: number) => {
  list[i] = (list[i] ?? 0) + n;
};

/**
 * What the visits to one place over the last `days` days (today included, in `timeZone`) add up
 * to: when people come, how long they stay, where they go, on what, and with whom. Coarse spans
 * are all there is: nothing here knows where in a room anyone was.
 */
export async function placeVisitStats(
  db: Db,
  spaceId: string,
  days: number,
  timeZone: string,
  now = new Date(),
): Promise<Stats> {
  const last = today(timeZone, now);
  const first = addDays(last, 1 - days);
  // This place's visits within the period (cut at its start), each a span of time.
  const v = sql`v as (
    select ${visits.userId} as user_id, ${visits.roomKey} as room_key,
      ${visits.creationId} as creation_id, ${visits.device} as device, ${visits.session} as session,
      ${visits.id} as id,
      tstzrange(greatest(${visits.startedAt}, ${first}::date::timestamp at time zone ${timeZone}),
        ${visitEnd}) as span
    from ${visits}
    where ${visits.spaceId} = ${spaceId} and ${recentVisits}
      and ${visitEnd} > ${first}::date::timestamp at time zone ${timeZone}
  )`;
  // Each person's time here, with overlaps (a creation open in a room) counted once.
  const spans = sql`spans as (
    select user_id, unnest(range_agg(span)) as span from v where not isempty(span) group by user_id
  )`;
  const rows = async <T>(query: SQL) => [...(await db.execute<T & Record<string, unknown>>(query))];

  const [hours, sittings, pieces, devices, entries, together] = await Promise.all([
    // Time in each hour of the period, per person.
    rows<{ user_id: string; day: string; dow: number; hour: number; seconds: number }>(sql`
      with ${v}, ${spans}
      select user_id, to_char(h at time zone ${timeZone}, 'YYYY-MM-DD') as day,
        extract(isodow from h at time zone ${timeZone})::int as dow,
        extract(hour from h at time zone ${timeZone})::int as hour,
        sum(extract(epoch from least(upper(span), h + interval '1 hour') - greatest(lower(span), h)))::float8 as seconds
      from spans, generate_series(date_trunc('hour', lower(span), ${timeZone}), upper(span), interval '1 hour') as h
      where least(upper(span), h + interval '1 hour') > greatest(lower(span), h)
      group by 1, 2, 3, 4`),
    // Each separate visit: time in sight, back within a few minutes being the same visit (each
    // of a person's spans starts a new one unless the last ended only just before).
    rows<{ user_id: string; seconds: number; last_ms: number }>(sql`
      with ${v}, ${spans}, marked as (
        select user_id, span,
          case when lower(span) - lag(upper(span)) over w <= ${sql.raw(SAME_VISIT)} then 0 else 1 end
            as starts
        from spans window w as (partition by user_id order by lower(span))
      ), numbered as (
        select user_id, span,
          sum(starts) over (partition by user_id order by lower(span)) as visit
        from marked
      )
      select user_id, sum(${sql.raw(secondsOf('span'))})::float8 as seconds,
        (extract(epoch from max(upper(span))) * 1000)::float8 as last_ms
      from numbered group by user_id, visit`),
    // Each person's time in each room and creation, and how often they opened each creation.
    rows<{
      user_id: string;
      room_key: string | null;
      creation_id: string | null;
      seconds: number;
      opened: number;
    }>(sql`
      with ${v}
      select user_id, room_key, creation_id, sum(${sql.raw(secondsOf('span'))})::float8 as seconds,
        count(distinct coalesce(session, id::text))::int as opened
      from v group by 1, 2, 3`),
    // Each person's time on each kind of device.
    rows<{ user_id: string; device: VisitDevice | null; seconds: number }>(sql`
      with ${v}
      select user_id, device, sum(${sql.raw(secondsOf('span'))})::float8 as seconds
      from (select user_id, device, unnest(range_agg(span)) as span
        from v where not isempty(span) group by 1, 2) d
      group by 1, 2`),
    // Each time someone came into a room, and from which room when they walked straight in.
    rows<{ user_id: string; room_key: string; came_from: string | null; times: number }>(sql`
      with ${v}, rv as (
        select user_id, room_key, span,
          lag(room_key) over w as prev_room, lag(upper(span)) over w as prev_end
        from v where room_key is not null
        window w as (partition by user_id order by lower(span))
      )
      select user_id, room_key,
        case when prev_room <> room_key and lower(span) - prev_end <= ${sql.raw(MOVE)}
          then prev_room end as came_from,
        count(*)::int as times
      from rv
      where prev_room is null or prev_room <> room_key
        or lower(span) - prev_end > ${sql.raw(SAME_VISIT)}
      group by 1, 2, 3`),
    // Time with someone else, in the same room or the same session of a creation: each person's
    // time there, less their time alone. One pass along each room's comings and goings counts who
    // is there and adds up their numbers, so when one person is there the sum says who it is.
    rows<{
      user_id: string;
      room_key: string | null;
      creation_id: string | null;
      seconds: number;
    }>(sql`
      with ${v}, merged as (
        select user_id, room_key, null::uuid as creation_id, 'r:' || room_key as shared_by,
          unnest(range_agg(span)) as span
        from v where room_key is not null and not isempty(span) group by user_id, room_key
        union all
        select user_id, null, creation_id, 's:' || session, unnest(range_agg(span))
        from v where session is not null and not isempty(span) group by user_id, creation_id, session
      ), rs as (
        select *, dense_rank() over (order by user_id) as n from merged
      ), edges as (
        select shared_by, lower(span) as t, 1 as d, n from rs
        union all
        select shared_by, upper(span), -1, -n from rs
      ), counted as (
        select shared_by, t, sum(sum(d)) over w as here, sum(sum(n)) over w as who,
          lead(t) over w as next_t
        from edges group by shared_by, t
        window w as (partition by shared_by order by t)
      ), alone as (
        select shared_by, who::bigint as n, sum(extract(epoch from next_t - t)) as seconds
        from counted where here = 1 and next_t > t group by 1, 2
      ), there as (
        select user_id, room_key, creation_id, shared_by, n, sum(${sql.raw(secondsOf('span'))}) as seconds
        from rs group by 1, 2, 3, 4, 5
      )
      select th.user_id, th.room_key, th.creation_id,
        sum(th.seconds - coalesce(a.seconds, 0))::float8 as seconds
      from there th left join alone a on a.shared_by = th.shared_by and a.n = th.n
      group by 1, 2, 3`),
  ]);

  // The period in days or, for the longest, in weeks from Monday.
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < days; i++) dayIndex.set(addDays(first, i), i);
  const weekly = days > 31;
  const trend: Stats['trend'] = [];
  const bucketOf: number[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(first, i);
    // Monday (getUTCDay 1) starts a new week.
    if (i === 0 || !weekly || new Date(`${day}T00:00:00Z`).getUTCDay() === 1)
      trend.push({ from: day, days: 0, seconds: 0, people: 0 });
    const bucket = trend.at(-1) as Stats['trend'][number];
    bucket.days++;
    bucketOf.push(trend.length - 1);
  }
  const week = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const bucketPeople = trend.map(() => new Set<string>());
  const person = new Map<
    string,
    Stats['people'][number] & { dayset: Set<string>; lengths: number[] }
  >();
  const of = (userId: string) => {
    let p = person.get(userId);
    if (!p) {
      p = {
        userId,
        seconds: 0,
        inCreations: 0,
        lastAt: new Date(0).toISOString(),
        days: 0,
        visits: 0,
        typicalSeconds: 0,
        togetherSeconds: 0,
        rooms: [],
        creations: [],
        devices: [],
        hours: new Array<number>(24).fill(0),
        dayset: new Set(),
        lengths: [],
      };
      person.set(userId, p);
    }
    return p;
  };

  for (const h of hours) {
    const i = dayIndex.get(h.day);
    if (i === undefined) continue;
    const bucket = trend[bucketOf[i] as number] as Stats['trend'][number];
    bucket.seconds += h.seconds;
    bucketPeople[bucketOf[i] as number]?.add(h.user_id);
    add(week[h.dow - 1] ?? [], h.hour, h.seconds);
    const p = of(h.user_id);
    add(p.hours, h.hour, h.seconds);
    p.dayset.add(h.day);
  }
  trend.forEach((b, i) => {
    b.seconds = round(b.seconds);
    b.people = bucketPeople[i]?.size ?? 0;
  });

  const allLengths: number[] = [];
  for (const s of sittings) {
    const p = of(s.user_id);
    p.seconds += s.seconds;
    p.visits++;
    p.lengths.push(s.seconds);
    allLengths.push(s.seconds);
    const lastAt = new Date(Number(s.last_ms)).toISOString();
    if (lastAt > p.lastAt) p.lastAt = lastAt;
  }

  const rooms: Stats['rooms'] = new Map();
  const creations: Stats['creations'] = new Map();
  const place = (map: Map<string, PlaceTime>, key: string) => {
    let r = map.get(key);
    if (!r) {
      r = { people: 0, seconds: 0, visits: 0, togetherSeconds: 0 };
      map.set(key, r);
    }
    return r;
  };
  for (const piece of pieces) {
    const p = of(piece.user_id);
    if (piece.room_key !== null) {
      const r = place(rooms, piece.room_key);
      r.people++;
      r.seconds += piece.seconds;
      p.rooms.push({ key: piece.room_key, seconds: round(piece.seconds) });
    } else if (piece.creation_id !== null) {
      const c = place(creations, piece.creation_id);
      c.people++;
      c.seconds += piece.seconds;
      c.visits += piece.opened;
      p.inCreations += piece.seconds;
      p.creations.push({ id: piece.creation_id, seconds: round(piece.seconds) });
    }
  }
  const moves = new Map<string, { from: string; to: string; times: number }>();
  for (const e of entries) {
    place(rooms, e.room_key).visits += e.times;
    if (e.came_from === null) continue;
    const key = `${e.came_from}\n${e.room_key}`;
    const move = moves.get(key) ?? { from: e.came_from, to: e.room_key, times: 0 };
    move.times += e.times;
    moves.set(key, move);
  }
  let togetherInRooms = 0;
  for (const t of together) {
    of(t.user_id).togetherSeconds += t.seconds;
    if (t.room_key !== null) {
      place(rooms, t.room_key).togetherSeconds += t.seconds;
      togetherInRooms += t.seconds;
    } else if (t.creation_id !== null) place(creations, t.creation_id).togetherSeconds += t.seconds;
  }
  const deviceTotals = new Map<VisitDevice | null, number>();
  for (const d of devices) {
    of(d.user_id).devices.push({ device: d.device, seconds: round(d.seconds) });
    deviceTotals.set(d.device, (deviceTotals.get(d.device) ?? 0) + d.seconds);
  }

  const most = <T extends { seconds: number }>(list: T[]) =>
    list.sort((a, b) => b.seconds - a.seconds);
  for (const map of [rooms, creations])
    for (const r of map.values()) {
      r.seconds = round(r.seconds);
      r.togetherSeconds = round(r.togetherSeconds);
    }
  const people = [...person.values()].map(({ dayset, lengths, ...p }) => ({
    ...p,
    seconds: round(p.seconds),
    inCreations: round(p.inCreations),
    togetherSeconds: round(p.togetherSeconds),
    days: dayset.size,
    typicalSeconds: round(median(lengths)),
    rooms: most(p.rooms),
    creations: most(p.creations),
    devices: most(p.devices),
    hours: p.hours.map(round),
  }));
  const roomSeconds = [...rooms.values()].reduce((sum, r) => sum + r.seconds, 0);
  return {
    summary: {
      seconds: people.reduce((sum, p) => sum + p.seconds, 0),
      people: people.filter((p) => p.seconds > 0).length,
      visits: allLengths.length,
      typicalSeconds: round(median(allLengths)),
      cameBack: people.filter((p) => p.days > 1).length,
      togetherSeconds: round(togetherInRooms),
      roomSeconds,
    },
    trend,
    week: week.map((row) => row.map(round)),
    devices: most(
      [...deviceTotals].map(
        ([device, seconds]): DeviceTime => ({ device, seconds: round(seconds) }),
      ),
    ),
    rooms,
    creations,
    moves: [...moves.values()].sort((a, b) => b.times - a.times).slice(0, 8),
    people: most(people),
  };
}
