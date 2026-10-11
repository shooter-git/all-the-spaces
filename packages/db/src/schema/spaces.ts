import type { LightingReport } from '@ats/api-types';
import type { SpaceManifest } from '@ats/space-format';
import {
  type AnyPgColumn,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { groups, user } from './auth.ts';

export const spaces = pgTable('spaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: text('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  spaceType: text('space_type', {
    enum: ['apartment', 'condo', 'house', 'office', 'building', 'other'],
  }).notNull(),
  /** Set for spaces created from a bundled sample (so the UI can label them). */
  sample: text('sample'),
  /** When it was imported from another server's export (until changed, it can be removed). */
  importedAt: timestamp('imported_at', { withTimezone: true }),
  /** The live version. Deferrable (by hand in the migration): versions point back at it. */
  currentVersionId: uuid('current_version_id').references((): AnyPgColumn => spaceVersions.id, {
    onDelete: 'set null',
  }),
  /** When the current version became live (publishing it, or going back to it). */
  liveSince: timestamp('live_since', { withTimezone: true }),
  /**
   * A new sample is `building` until its first version is published (baking takes minutes). A
   * real place being set up in the Studio is a `draft` until the Architect publishes it.
   */
  status: text('status', { enum: ['draft', 'building', 'ready', 'failed'] })
    .notNull()
    .default('ready'),
  /** A new version being built from a plan (set up in the Studio), and why the last one failed. */
  buildState: text('build_state', { enum: ['building', 'failed'] }),
  buildError: text('build_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const spaceVersions = pgTable(
  'space_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    status: text('status', { enum: ['candidate', 'published', 'archived'] }).notNull(),
    /** The manifest is small (tens of KB); the heavy chunks live in object storage. */
    manifest: jsonb('manifest').$type<SpaceManifest>().notNull(),
    /** The plan it was built from (to change the place later, starting from this). */
    plan: jsonb('plan').$type<Record<string, unknown>>(),
    /**
     * Where each creation was while this version was live (creation id → object key, or null on
     * the unplaced shelf), so going back to it puts everything back where it was.
     */
    placements: jsonb('placements').$type<Record<string, string | null>>(),
    /** How its lighting was baked, or why it wasn't (null for versions from before this). */
    lighting: jsonb('lighting').$type<LightingReport>(),
    /**
     * The workspace files its plan's own models came from (path → SHA-256 of the file: each
     * `models/<name>.glb` it uses, and the `models/<name>.py` that made it), kept in object storage
     * so changing the place later starts with them. Null for versions from before this.
     */
    sources: jsonb('sources').$type<Record<string, string>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('space_versions_space_number').on(t.spaceId, t.number)],
);

/**
 * Who may see each room. Live: a change applies straight away, without rebuilding (each room is
 * built and lit on its own, so withholding one never affects another). Rooms with no row here
 * are hidden from everyone but Architects — new rooms start private.
 */
export const roomPolicies = pgTable(
  'room_policies',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    roomKey: text('room_key').notNull(),
    /** group: everyone in the group · limited: only the people in room_access · hidden: Architects only */
    visibility: text('visibility', { enum: ['group', 'limited', 'hidden'] }).notNull(),
    /** Whose room it is (a bedroom, an office), if anyone's. */
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
    /**
     * Who may ask for things in it (Architects always can): anyone who can see it, only its
     * owner, or nobody else.
     */
    requests: text('requests', { enum: ['anyone', 'owner', 'architects'] })
      .notNull()
      .default('anyone'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.roomKey] })],
);

/** The people who may see a `limited` room. */
export const roomAccess = pgTable(
  'room_access',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    roomKey: text('room_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.roomKey, t.userId] }),
    foreignKey({
      columns: [t.spaceId, t.roomKey],
      foreignColumns: [roomPolicies.spaceId, roomPolicies.roomKey],
    }).onDelete('cascade'),
  ],
);

/**
 * What an Architect gave to build their place from: floor plans, photos, and packs (a .zip of
 * photos with notes on them, such as a README or a manifest, kept whole). Pictures are re-encoded
 * on upload (no location or camera details); all are private to Architects, and only ever read by
 * the Architect's assistant: they never appear in the space.
 */
export const spaceInputs = pgTable(
  'space_inputs',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /**
     * e.g. plan-1, photo-3 (the file is inputs/<name>.jpg in the workspace), pack-1 (its files
     * are in inputs/<note>/).
     */
    name: text('name').notNull(),
    kind: text('kind', { enum: ['plan', 'photo', 'pack'] }).notNull(),
    /**
     * What it shows, in the Architect's words (e.g. "the kitchen, from the door"); for a pack, its
     * folder's name.
     */
    note: text('note').notNull().default(''),
    /** In pixels; for a pack, how many files it holds (and a height of 0). */
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.name] })],
);
