import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { groups, user } from './auth.ts';
import { builds, creations, creationVersions } from './creations.ts';
import { spaces } from './spaces.ts';

/**
 * An Architect's AI assistant: which version they installed and the program's fingerprint (to
 * notice if it changes). Never any sign-in material: that stays in the Architect's own volume.
 */
export const assistantConnections = pgTable(
  'assistant_connections',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['claude', 'codex'] }).notNull(),
    version: text('version'),
    binarySha256: text('binary_sha256'),
    signedIn: boolean('signed_in').notNull().default(false),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.provider] })],
);

/** Where an Architect builds one creation with their assistant. */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** Set once it's published (or from the start, when improving an existing creation). */
    creationId: uuid('creation_id').references(() => creations.id, { onDelete: 'set null' }),
    basedOnVersionId: uuid('based_on_version_id').references(() => creationVersions.id, {
      onDelete: 'set null',
    }),
    objectKey: text('object_key'),
    /** A creation, or a real place being built from its floor plan (then `spaceId` is that space). */
    kind: text('kind', { enum: ['creation', 'space'] })
      .notNull()
      .default('creation'),
    architectId: text('architect_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['claude', 'codex'] }).notNull(),
    /** The model and effort chosen for this workspace (empty: the group's default). */
    model: text('model'),
    effort: text('effort'),
    title: text('title').notNull(),
    brief: text('brief').notNull(),
    status: text('status', { enum: ['ready', 'running', 'stopped', 'archived'] })
      .notNull()
      .default('ready'),
    /** Why it last stopped (idle, time limit, the Architect). */
    stoppedBecause: text('stopped_because'),
    /** Deferrable (by hand in the migration), as is builds.workspace_id. */
    lastBuildId: uuid('last_build_id').references((): AnyPgColumn => builds.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** When the Architect was last here: typing, or its page open and in use (not the assistant). */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('workspaces_space').on(t.spaceId), index('workspaces_status').on(t.status)],
);

/** How a group's Studio behaves. */
export const studioSettings = pgTable('studio_settings', {
  groupId: text('group_id')
    .primaryKey()
    .references(() => groups.id, { onDelete: 'cascade' }),
  claudeModel: text('claude_model'),
  codexModel: text('codex_model'),
  codexEffort: text('codex_effort'),
  claudeEffort: text('claude_effort'),
  /**
   * A workspace quiet for this long (its Architect not there, and its assistant not at work) is
   * put to sleep (its files stay).
   */
  idleMinutes: integer('idle_minutes').notNull().default(120),
  /**
   * A workspace is put to sleep after this long once its Architect has stepped away, however busy
   * its assistant (opening it wakes it).
   */
  sessionHours: integer('session_hours').notNull().default(4),
  /** Let the assistants send their makers usage statistics and error reports. */
  telemetry: boolean('telemetry').notNull().default(false),
  /** A creation must be tried on a real device before it can go live. */
  requireDeviceTest: boolean('require_device_test').notNull().default(false),
  /** Delete a place's floor plans and photos once it's published (they're no longer needed). */
  deleteInputsAfterPublish: boolean('delete_inputs_after_publish').notNull().default(false),
  /**
   * Workspaces may reach any public website over HTTPS, not only the assistants' makers, npm and
   * the free libraries. Never this server's own network.
   */
  openInternet: boolean('open_internet').notNull().default(false),
});
