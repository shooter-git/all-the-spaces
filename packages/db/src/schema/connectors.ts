import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { creationVersions } from './creations.ts';

/**
 * Operator-installed connectors (docs/connectors.md). The definitions themselves are files the
 * server's owner keeps; these are what people and Architects did with them.
 */

/**
 * One person's account at a connector's service, linked by them (OAuth with PKCE). The tokens
 * are sealed with the server secret (crypto-box, purpose `connector-token:<id>`) and never leave
 * the server. `brokenAt`: the service stopped accepting them; the person links again.
 * `checkedAt`/`accountName`: the connector's link check (its `linkCheck` read) worked right after
 * linking, and who the service said the account is (plain text, at most 60 characters).
 */
export const connectorLinks = pgTable(
  'connector_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id').notNull(),
    /** What the service granted (may be fewer than were asked for). */
    scopes: text('scopes').array().notNull(),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    brokenAt: timestamp('broken_at', { withTimezone: true }),
    accountName: text('account_name'),
    checkedAt: timestamp('checked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('connector_links_user_connector').on(t.userId, t.connectorId)],
);

/**
 * A link someone started and hasn't finished (they're at the service, saying yes). Only a hash of
 * the `state` is kept, the PKCE verifier is sealed, and each one works once, for ten minutes.
 */
export const connectorLinkAttempts = pgTable(
  'connector_link_attempts',
  {
    stateHash: text('state_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id').notNull(),
    verifierEnc: text('verifier_enc').notNull(),
    /** Where in the app they go back to (a path on the app's own origin). */
    returnTo: text('return_to').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('connector_link_attempts_expires').on(t.expiresAt)],
);

/**
 * An Architect allowed a version of a creation to use these operations of a connector (what the
 * version declares in its ats.json). Approvals belong to one version on this server: they're
 * never exported or imported.
 */
export const creationVersionConnectors = pgTable(
  'creation_version_connectors',
  {
    versionId: uuid('version_id')
      .notNull()
      .references(() => creationVersions.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id').notNull(),
    ops: text('ops').array().notNull(),
    /** Null: the server's owner, from the command line. */
    approvedBy: text('approved_by').references(() => user.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.versionId, t.connectorId] })],
);
