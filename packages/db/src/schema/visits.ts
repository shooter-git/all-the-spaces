import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { groups, user } from './auth.ts';
import { creations } from './creations.ts';
import { spaces } from './spaces.ts';

/**
 * Time people spend here: one row per stay in a room of a place, or per time in a creation.
 * Coarse spans only, never positions: which room or creation, from when to when. Written by the
 * real-time service (through the server), kept 90 days (worker), and shown only to the group's
 * Architects: which rooms and creations get used, and how long each person spends here.
 */
export const visits = pgTable(
  'visits',
  {
    /** Chosen by the real-time service, so sending the same visit twice keeps one row. */
    id: uuid('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** The room of the place they were in; null for time in a creation. */
    roomKey: text('room_key'),
    /** The creation they were in; null for a room. */
    creationId: uuid('creation_id').references(() => creations.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    /** When they were last known to be there (the real-time service says so every minute). */
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
    /** Null while they're still there. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('visits_space_started').on(t.spaceId, t.startedAt),
    index('visits_group_started').on(t.groupId, t.startedAt),
    index('visits_open').on(t.seenAt).where(sql`${t.endedAt} is null`),
    check('visits_room_or_creation', sql`(${t.roomKey} is null) <> (${t.creationId} is null)`),
  ],
);
