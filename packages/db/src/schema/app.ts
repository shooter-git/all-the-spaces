import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { groups, user } from './auth.ts';

// Singleton row (id = 1) describing this installation.
export const installState = pgTable(
  'install_state',
  {
    id: integer('id').primaryKey().default(1),
    setupCodeHash: text('setup_code_hash'),
    setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
    publicUrl: text('public_url'),
    storageMode: text('storage_mode', { enum: ['builtin', 'external'] })
      .default('builtin')
      .notNull(),
    /** External S3 settings; the secret is encrypted with the server secret (see crypto-box). */
    externalStorage: jsonb('external_storage').$type<ExternalStorageSettings>(),
    backup: jsonb('backup').$type<BackupSettings>().default({ schedule: 'nightly', keepDays: 14 }),
    /** This server's key pair for push notifications (made on first use; private key sealed). */
    push: jsonb('push').$type<{ publicKey: string; privateKeyEnc: string }>(),
    /**
     * The server's owner: the account made with the installer's setup code, or whoever
     * `ats-admin owner` handed it to. Only they change server-wide settings in the app.
     */
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    /**
     * Where creations may come from, as the owner chose in the Studio (ADR 0012): the built-in
     * GitHub host and repositories added to hosts defined in files. Never a token.
     */
    sources: jsonb('sources').$type<StudioSourceSettings>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check('install_state_singleton', sql`${t.id} = 1`)],
);

/** The owner's choices about repositories (checked again with @ats/shared's StudioSources). */
export interface StudioSourceSettings {
  /** The built-in GitHub host: github.com, public repositories only, never a token. */
  github: { on: boolean; repositories: string[] };
  /** Repositories added to hosts defined in files, by host id: public ones only. */
  added: Record<string, string[]>;
}

export interface ExternalStorageSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKeyEnc: string;
}

export interface BackupSettings {
  schedule: 'nightly' | 'weekly' | 'off';
  keepDays: number;
  /** Optional off-site copy to any S3-compatible bucket; the secret is sealed like
   *  externalStorage's (crypto-box, purpose 'backups'). */
  offsite?: OffsiteBackupSettings | undefined;
}

export interface OffsiteBackupSettings {
  endpoint: string;
  region: string;
  bucket: string;
  /** Folder in the bucket for this server's backups. */
  prefix: string;
  accessKeyId: string;
  secretAccessKeyEnc: string;
}

// Append-only record of consequential actions. Never stores terminal content or secrets.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id'),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    target: text('target'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('audit_log_group').on(t.groupId, t.createdAt)],
);

// Shareable invite links (no email needed). Anyone with the link can join the group until it
// expires or runs out of uses.
export const inviteLinks = pgTable('invite_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  groupId: text('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['architect', 'member'] })
    .default('member')
    .notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  label: text('label'),
  maxUses: integer('max_uses'),
  uses: integer('uses').default(0).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
