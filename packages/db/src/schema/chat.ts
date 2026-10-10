import {
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

/**
 * Chat messages. `channel` says who may read it:
 *   space:<spaceId>             everyone in the space's group
 *   room:<spaceId>:<roomKey>    everyone who may see that room
 *   dm:<userId>:<userId>        the two people (ids sorted)
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    senderId: text('sender_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('chat_messages_channel_created').on(t.channel, t.createdAt),
    index('chat_messages_group_created').on(t.groupId, t.createdAt),
  ],
);

/** People someone has blocked: they see nothing from them, and neither can message the other. */
export const chatBlocks = pgTable(
  'chat_blocks',
  {
    blockerId: text('blocker_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    blockedId: text('blocked_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })],
);

/** Channels someone has muted (no unread badges or pop-ups). */
export const chatMutes = pgTable(
  'chat_mutes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channel] })],
);

/** Messages reported to the group's Architects. */
export const chatReports = pgTable('chat_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: text('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  reporterId: text('reporter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** Kept even if the message is later deleted by retention. */
  messageId: uuid('message_id'),
  senderId: text('sender_id'),
  body: text('body').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});

/** Per-person settings. */
export const userPrefs = pgTable('user_prefs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** Do Not Disturb: no pop-ups or badges; others see it. */
  dnd: boolean('dnd').notNull().default(false),
  /** Also email notifications (when the server can send email). */
  emailNotifications: boolean('email_notifications').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Per-group settings. */
export const groupSettings = pgTable('group_settings', {
  groupId: text('group_id')
    .primaryKey()
    .references(() => groups.id, { onDelete: 'cascade' }),
  /** Chat messages older than this are deleted (null keeps them forever). */
  chatRetentionDays: integer('chat_retention_days').default(90),
  /** Voice chat in the space and in creations (when the server has it). */
  voice: boolean('voice').notNull().default(true),
});
