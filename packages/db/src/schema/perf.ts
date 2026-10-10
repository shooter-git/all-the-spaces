import type { Tier } from '@ats/api-types';
import { customType, index, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { groups } from './auth.ts';
import { creationVersions } from './creations.ts';
import { spaces } from './spaces.ts';

/**
 * A quality tier. Rows store the words first used ('low', 'medium', 'high'); everything else says
 * 'mid' for the middle one, as the protocol does, so this is the one place the two meet.
 */
const tierColumn = customType<{ data: Tier; driverData: string }>({
  dataType: () => 'text',
  toDriver: (t) => (t === 'mid' ? 'medium' : t),
  fromDriver: (v) => (v === 'medium' ? 'mid' : v) as Tier,
});

/**
 * How smoothly things run on people's devices, shared only by those who turn it on (per device).
 * Anonymous (no user), kept 90 days, never leaves the server. Used to pick each kind of device's
 * starting quality, and to show Architects how a place or a creation runs.
 */
export const perfSamples = pgTable(
  'perf_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    creationVersionId: uuid('creation_version_id').references(() => creationVersions.id, {
      onDelete: 'cascade',
    }),
    /** What was running: the space itself, or a creation. */
    kind: text('kind', { enum: ['space', 'creation'] }).notNull(),
    /** The quality it ran at. */
    tier: tierColumn('tier').notNull(),
    /** A coarse kind of device ("phone-ios-6c", "laptop-other-8c"), never anything identifying. */
    device: text('device').notNull(),
    fps: real('fps').notNull(),
    p50Ms: real('p50_ms').notNull(),
    p95Ms: real('p95_ms').notNull(),
    /** Share of full resolution drawn (dynamic resolution). */
    scale: real('scale').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('perf_samples_device_idx').on(t.device, t.tier, t.createdAt),
    index('perf_samples_space_idx').on(t.spaceId, t.createdAt),
  ],
);
