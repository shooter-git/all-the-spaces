import type { DeclaredConnector, DeviceTest, VersionQa } from '@ats/api-types';
import {
  type AnyPgColumn,
  boolean,
  index,
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
import { spaces } from './spaces.ts';
import { workspaces } from './studio.ts';

/** What the web app reads too (one definition, in @ats/api-types). */
export type { DeclaredConnector, DeviceTest, VersionQa };

/**
 * A creation: anything built for an object in a space (a game, a journal, a simulation…).
 * `objectKey` is the object it lives in; null means it's waiting on the unplaced shelf.
 */
export const creations = pgTable(
  'creations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    objectKey: text('object_key'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** How people usually join: alone, together, or by invitation. */
    defaultMode: text('default_mode', { enum: ['solo', 'shared', 'invite'] })
      .notNull()
      .default('shared'),
    /** The live version. Deferrable (by hand in the migration): versions point back at it. */
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => creationVersions.id,
      { onDelete: 'set null' },
    ),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('creations_space').on(t.spaceId)],
);

/** An immutable, published build of a creation. */
export const creationVersions = pgTable(
  'creation_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creationId: uuid('creation_id')
      .notNull()
      .references(() => creations.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    /** Content hash of the whole bundle; its files live under creations/<id>/<bundle>/. */
    bundle: text('bundle').notNull(),
    entry: text('entry').notNull().default('index.html'),
    files: jsonb('files').$type<{ path: string; bytes: number; type: string }[]>().notNull(),
    bytes: integer('bytes').notNull(),
    sdkVersion: text('sdk_version').notNull(),
    protocolVersion: integer('protocol_version').notNull(),
    /**
     * `candidate`: built and checked, not yet live (only Architects can try it).
     * `published`: has been live (the creation's current version is the live one).
     */
    status: text('status', { enum: ['candidate', 'published'] })
      .notNull()
      .default('published'),
    /** The checks it passed: a short summary (the full report is kept with its build). */
    qa: jsonb('qa').$type<VersionQa>(),
    /** The build that made it. Deferrable (by hand in the migration), as is builds.version_id. */
    buildId: uuid('build_id').references((): AnyPgColumn => builds.id, { onDelete: 'set null' }),
    /** The source it was built from (a snapshot hash). */
    sourceHash: text('source_hash'),
    /** The shape of the data it saves (the SDK's save.version). */
    saveVersion: integer('save_version'),
    /** Everything it uses that someone else made, with licences. */
    credits: jsonb('credits')
      .$type<
        {
          path: string;
          license: string;
          source?: string | undefined;
          title?: string | undefined;
          author?: string | undefined;
        }[]
      >()
      .notNull()
      .default([]),
    /**
     * Its title, description and how people join, from its ats.json (applied when it goes live),
     * and the connectors it uses (approved per version: creation_version_connectors).
     */
    details: jsonb('details').$type<{
      title: string;
      description?: string;
      defaultMode?: 'solo' | 'shared' | 'invite';
      connectors?: DeclaredConnector[];
    }>(),
    /** How it ran on the Architect's own devices ("Try on this device"). */
    deviceTests: jsonb('device_tests').$type<DeviceTest[]>().notNull().default([]),
    /** The repository commit it was built from (creations that follow one: creation_sources). */
    sourceCommit: text('source_commit'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('creation_versions_number').on(t.creationId, t.number)],
);

/**
 * A build of a creation from a source snapshot: checked, and published or kept as a candidate.
 * Its report (and screenshots) are stored under reports/<id>/.
 */
export const builds = pgTable(
  'builds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** Null for a new creation (created when the build succeeds). */
    creationId: uuid('creation_id').references(() => creations.id, { onDelete: 'cascade' }),
    objectKey: text('object_key'),
    /**
     * The Studio workspace it was published from (none for creations published otherwise).
     * Deferrable (by hand in the migration), as is workspaces.last_build_id.
     */
    workspaceId: uuid('workspace_id').references((): AnyPgColumn => workspaces.id, {
      onDelete: 'set null',
    }),
    /** Make it live straight away if it passes; otherwise keep it as a candidate. */
    publish: boolean('publish').notNull().default(false),
    /**
     * Approve the connectors it declares as it's published (the server's owner, publishing from
     * the command line). Otherwise a version that uses connectors waits as a candidate until an
     * Architect approves them.
     */
    approveConnectors: boolean('approve_connectors').notNull().default(false),
    status: text('status', {
      enum: ['queued', 'running', 'passed', 'published', 'failed', 'error'],
    })
      .notNull()
      .default('queued'),
    step: text('step'),
    sourceHash: text('source_hash').notNull(),
    title: text('title'),
    qa: jsonb('qa').$type<VersionQa>(),
    error: text('error'),
    /**
     * The version it made. Deferrable (by hand in the migration), as is
     * creation_versions.build_id.
     */
    versionId: uuid('version_id').references((): AnyPgColumn => creationVersions.id, {
      onDelete: 'set null',
    }),
    requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
    /**
     * Built from a repository (ADR 0011): where from, and the commit. When it passes, the creation
     * follows that repository from then on (creation_sources).
     */
    source: jsonb('source').$type<BuildSource>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('builds_space').on(t.spaceId, t.createdAt), index('builds_status').on(t.status)],
);

/** Where a creation's source comes from, when it follows a repository (ADR 0011). */
export interface SourceSettings {
  /** The repository host's definition (ATS_SOURCES_DIR). */
  host: string;
  /** `owner/name`. */
  repository: string;
  /** The creation's folder in it ('' for the whole repository). */
  path: string;
  /** The newest release, the newest commit on a branch, or one commit. */
  follows: 'release' | 'branch' | 'commit';
  /** The branch, or the commit (null for releases). */
  ref: string | null;
  /** A new version becomes a candidate to try first, or goes live straight away. */
  updateMode: 'candidate' | 'live';
}

export interface BuildSource extends SourceSettings {
  commit: string;
  /** The release's tag, or the commit's first line. */
  label: string;
}

/**
 * A creation that follows a repository: where, what it follows, the commit its newest version
 * came from, and what the repository had when it was last looked at.
 */
export const creationSources = pgTable('creation_sources', {
  creationId: uuid('creation_id')
    .primaryKey()
    .references(() => creations.id, { onDelete: 'cascade' }),
  groupId: text('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  host: text('host').notNull(),
  repository: text('repository').notNull(),
  path: text('path').notNull().default(''),
  follows: text('follows', { enum: ['release', 'branch', 'commit'] }).notNull(),
  ref: text('ref'),
  updateMode: text('update_mode', { enum: ['candidate', 'live'] })
    .notNull()
    .default('candidate'),
  /** The commit the newest version was built from. */
  builtCommit: text('built_commit'),
  /** What it follows had this commit when it was last looked at. */
  latestCommit: text('latest_commit'),
  latestLabel: text('latest_label'),
  /** Commits between the built one and the latest (null when unknown). */
  behindBy: integer('behind_by'),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  /** Why the last look failed (in plain words), if it did. */
  checkError: text('check_error'),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Saved data everyone in a creation shares. `version` goes up with every write, so a write based
 * on an older version is refused instead of silently overwriting someone else's change.
 */
export const creationDataShared = pgTable(
  'creation_data_shared',
  {
    creationId: uuid('creation_id')
      .notNull()
      .references(() => creations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.creationId, t.key] })],
);

/** Saved data private to one person (a journal, their progress). Nobody else can read it. */
export const creationDataPersonal = pgTable(
  'creation_data_personal',
  {
    creationId: uuid('creation_id')
      .notNull()
      .references(() => creations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.creationId, t.userId, t.key] })],
);
