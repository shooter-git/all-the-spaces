import { and, eq, exists, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { chatMessages, groupSettings } from './schema/chat.ts';
import { perfSamples } from './schema/perf.ts';
import { visits } from './schema/visits.ts';

/** How long performance samples are kept. */
export const PERF_RETENTION_DAYS = 90;

/** Deletes performance samples older than `PERF_RETENTION_DAYS`. Returns how many went. */
export async function deleteOldPerfSamples(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .delete(perfSamples)
    .where(lt(perfSamples.createdAt, new Date(now.getTime() - PERF_RETENTION_DAYS * 86_400_000)))
    .returning({ id: perfSamples.id });
  return rows.length;
}

/** How long chat is kept when an Architect hasn't chosen. */
export const DEFAULT_CHAT_RETENTION_DAYS = 90;

/** Deletes chat messages older than each group's retention. Returns how many went. */
export async function deleteExpiredChat(db: Db, now = new Date()): Promise<number> {
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000);
  // Groups that chose how long to keep chat (null keeps it forever), in one statement.
  const chosen = await db
    .delete(chatMessages)
    .where(
      sql`exists (select 1 from ${groupSettings} where ${groupSettings.groupId} = ${chatMessages.groupId}
        and ${groupSettings.chatRetentionDays} is not null
        and ${chatMessages.createdAt} < ${now.toISOString()}::timestamptz
          - make_interval(days => ${groupSettings.chatRetentionDays}))`,
    )
    .returning({ id: chatMessages.id });
  // Everyone else: the default.
  const rest = await db
    .delete(chatMessages)
    .where(
      and(
        lt(chatMessages.createdAt, before(DEFAULT_CHAT_RETENTION_DAYS)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(groupSettings)
            .where(eq(groupSettings.groupId, chatMessages.groupId)),
        ),
      ),
    )
    .returning({ id: chatMessages.id });
  return chosen.length + rest.length;
}

/** How long visits are kept: like chat, three months. */
export const VISIT_RETENTION_DAYS = 90;

/**
 * Deletes visits that began more than `VISIT_RETENTION_DAYS` ago, and any in a group that turned
 * visit records off (a batch in flight as it did). Returns how many went.
 */
export async function deleteOldVisits(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .delete(visits)
    .where(
      or(
        lt(visits.startedAt, new Date(now.getTime() - VISIT_RETENTION_DAYS * 86_400_000)),
        exists(
          db
            .select({ one: sql`1` })
            .from(groupSettings)
            .where(and(eq(groupSettings.groupId, visits.groupId), eq(groupSettings.visits, false))),
        ),
      ),
    )
    .returning({ id: visits.id });
  return rows.length;
}

/**
 * How long an open visit may go without the real-time service saying it's still going (it says
 * so every minute) before it counts as over.
 */
export const VISIT_STALE_MS = 3 * 60_000;

/**
 * Ends the visits nobody has vouched for lately (the real-time service that had them stopped or
 * restarted), when they were last seen. Returns how many.
 */
export async function endStaleVisits(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .update(visits)
    .set({ endedAt: sql`${visits.seenAt}` })
    .where(and(isNull(visits.endedAt), lt(visits.seenAt, new Date(now.getTime() - VISIT_STALE_MS))))
    .returning({ id: visits.id });
  return rows.length;
}
