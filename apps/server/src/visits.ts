import { type Db, endStaleVisits, schema, VISIT_RETENTION_DAYS } from '@ats/db';
import type { VisitBatch } from '@ats/shared';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';

const { creations, groupSettings, memberships, spaces, visits } = schema;

/** When a visit ended or, still going, when it was last known to be. */
export const visitEnd = sql`greatest(coalesce(${visits.endedAt}, ${visits.seenAt}), ${visits.startedAt})`;
/** Visits within the retention period (older ones are deleted every night). */
export const recentVisits = sql`${visits.startedAt} > now() - make_interval(days => ${VISIT_RETENTION_DAYS})`;
/** Whether a group records visits: on unless its Architects turned it off (Group settings). */
const recording = sql<boolean>`coalesce(${groupSettings.visits}, true)`;

/** Whether a group records where people spend time. */
export async function recordsVisits(db: Db, groupId: string) {
  const [row] = await db
    .select({ visits: groupSettings.visits })
    .from(groupSettings)
    .where(eq(groupSettings.groupId, groupId));
  return row?.visits ?? true;
}

/**
 * Writes what the real-time service says about visits. Only visits by members of the place's
 * group count, never in a group that turned visit records off, and never trying a version of a
 * creation that isn't live (Architects testing). Sending the same batch twice changes nothing.
 * Returns how many visits began.
 */
export async function recordVisits(db: Db, batch: VisitBatch): Promise<number> {
  // Times are on the real-time service's clock: shifted onto this one.
  const shift = Date.now() - batch.now;
  const at = (ms: number) => new Date(ms + shift);
  const spaceIds = [...new Set(batch.started.flatMap((v) => ('spaceId' in v ? [v.spaceId] : [])))];
  const creationIds = [
    ...new Set(batch.started.flatMap((v) => ('creationId' in v ? [v.creationId] : []))),
  ];
  const userIds = [...new Set(batch.started.map((v) => v.userId))];
  const [placeRows, creationRows, memberRows] = await Promise.all([
    spaceIds.length
      ? db
          .select({ id: spaces.id, groupId: spaces.groupId, recording })
          .from(spaces)
          .leftJoin(groupSettings, eq(groupSettings.groupId, spaces.groupId))
          .where(inArray(spaces.id, spaceIds))
      : [],
    creationIds.length
      ? db
          .select({
            id: creations.id,
            groupId: creations.groupId,
            spaceId: creations.spaceId,
            live: creations.currentVersionId,
            recording,
          })
          .from(creations)
          .leftJoin(groupSettings, eq(groupSettings.groupId, creations.groupId))
          .where(inArray(creations.id, creationIds))
      : [],
    userIds.length
      ? db
          .select({ userId: memberships.userId, groupId: memberships.organizationId })
          .from(memberships)
          .where(inArray(memberships.userId, userIds))
      : [],
  ]);
  const places = new Map(placeRows.map((p) => [p.id, p]));
  const made = new Map(creationRows.map((c) => [c.id, c]));
  const members = new Set(memberRows.map((m) => `${m.groupId}:${m.userId}`));
  const rows = batch.started.flatMap((v) => {
    let where: {
      groupId: string;
      spaceId: string;
      roomKey: string | null;
      creationId: string | null;
    };
    if ('roomKey' in v) {
      const place = places.get(v.spaceId);
      if (!place?.recording) return [];
      where = { groupId: place.groupId, spaceId: place.id, roomKey: v.roomKey, creationId: null };
    } else {
      const creation = made.get(v.creationId);
      if (!creation?.recording || creation.live !== v.versionId) return [];
      where = { ...creation, roomKey: null, creationId: creation.id };
    }
    if (!members.has(`${where.groupId}:${v.userId}`)) return [];
    const startedAt = at(v.startedAt);
    const endedAt = v.endedAt === undefined ? null : at(Math.max(v.endedAt, v.startedAt));
    return [
      {
        id: v.id,
        userId: v.userId,
        groupId: where.groupId,
        spaceId: where.spaceId,
        roomKey: where.roomKey,
        creationId: where.creationId,
        startedAt,
        seenAt: endedAt ?? startedAt,
        endedAt,
      },
    ];
  });
  await db.transaction(async (tx) => {
    if (rows.length) await tx.insert(visits).values(rows).onConflictDoNothing();
    if (batch.ended.length) {
      const ends = sql.join(
        batch.ended.map((e) => sql`(${e.id}::uuid, ${at(e.at).toISOString()}::timestamptz)`),
        sql`, `,
      );
      await tx.execute(sql`update ${visits} set ended_at = greatest(e.at, ${visits.startedAt}),
        seen_at = greatest(e.at, ${visits.startedAt})
        from (values ${ends}) as e(id, at)
        where ${visits.id} = e.id and ${visits.endedAt} is null`);
    }
    // Still going: and any nobody has vouched for lately (their service stopped) end.
    if (batch.going) {
      for (let i = 0; i < batch.going.length; i += 5000)
        await tx
          .update(visits)
          .set({ seenAt: at(batch.now) })
          .where(and(inArray(visits.id, batch.going.slice(i, i + 5000)), isNull(visits.endedAt)));
    }
  });
  if (batch.going) await endStaleVisits(db);
  return rows.length;
}

/**
 * Each person's time in the visits `where` picks, over the retention period, counting time in
 * overlapping visits once (a creation open in a room is time in both).
 */
export async function timeByPerson(db: Db, where: SQL | undefined) {
  const rows = await db.execute<{ user_id: string; seconds: number; last_ms: number }>(sql`
    select user_id,
      sum(extract(epoch from upper(span) - lower(span)))::float8 as seconds,
      (extract(epoch from max(upper(span))) * 1000)::float8 as last_ms
    from (
      select ${visits.userId} as user_id,
        unnest(range_agg(tstzrange(${visits.startedAt}, ${visitEnd}))) as span
      from ${visits}
      where ${and(where, recentVisits)}
      group by ${visits.userId}
    ) spans
    group by user_id`);
  return new Map(
    [...rows].map((r) => [
      r.user_id,
      { seconds: Math.round(Number(r.seconds)), lastAt: new Date(Number(r.last_ms)) },
    ]),
  );
}
