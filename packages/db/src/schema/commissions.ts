import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { groups, user } from './auth.ts';
import { creations } from './creations.ts';
import { spaces } from './spaces.ts';
import { workspaces } from './studio.ts';

export const COMMISSION_STATUSES = [
  'submitted',
  'accepted',
  'in_progress',
  'qa_failed',
  'ready',
  'published',
  'declined',
  'withdrawn',
] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

/**
 * A member's request: something new for an object (or a new object), a change to a creation, or
 * something wrong with one. Asking only writes this row: nothing is built until an Architect
 * opens a workspace for it and starts their assistant themselves (docs/compliance.md, C1).
 */
export const commissions = pgTable(
  'commissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** new: something new for an object · improve: change a creation · bug: something's wrong. */
    kind: text('kind', { enum: ['new', 'improve', 'bug'] }).notNull(),
    /** The object it's for. Null for a new object ("put a telescope by the window"). */
    objectKey: text('object_key'),
    /** The room it was asked in (and the object's room, when there is one). */
    roomKey: text('room_key').notNull(),
    /** What the object was called when it was asked for (objects can be renamed or removed). */
    objectLabel: text('object_label'),
    /** The creation to change (improve / bug), or the one built for it. */
    creationId: uuid('creation_id').references(() => creations.id, { onDelete: 'set null' }),
    requesterId: text('requester_id').references(() => user.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** In the member's own words. */
    prompt: text('prompt').notNull(),
    /** Pictures that came with it: `snapshot` (what they drew a box around), `sketch`, `image-N`. */
    images: jsonb('images').$type<string[]>().notNull().default([]),
    /** Documents that came with it (Markdown): `doc-N`, and the file's own name. */
    documents: jsonb('documents').$type<{ name: string; file: string }[]>().notNull().default([]),
    status: text('status', { enum: COMMISSION_STATUSES }).notNull().default('submitted'),
    /** Set by Architects. */
    priority: text('priority', { enum: ['low', 'normal', 'high'] })
      .notNull()
      .default('normal'),
    effort: text('effort', { enum: ['small', 'medium', 'large'] }),
    /** The Architect's version of the brief (null: the member's words as they are). */
    brief: text('brief'),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    index('commissions_group').on(t.groupId, t.status),
    index('commissions_requester').on(t.requesterId, t.createdAt),
    index('commissions_space_object').on(t.spaceId, t.objectKey),
    index('commissions_workspace').on(t.workspaceId),
  ],
);

/** What happened to a request, in order: every status change, and notes either side added. */
export const commissionEvents = pgTable(
  'commission_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    commissionId: uuid('commission_id')
      .notNull()
      .references(() => commissions.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    /** The status it moved to (null for a note on its own). */
    status: text('status', { enum: COMMISSION_STATUSES }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('commission_events_commission').on(t.commissionId, t.createdAt)],
);

/** Something to tell one person (shown in the app; pushed to their devices or emailed). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    groupId: text('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    /** e.g. request.accepted, request.new */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Where it leads in the app (a path, e.g. /requests/…). */
    url: text('url'),
    /** What it's about (e.g. creation:<id>), so it can be cleared once that's dealt with. */
    subject: text('subject'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('notifications_user').on(t.userId, t.createdAt),
    index('notifications_user_unread').on(t.userId, t.readAt),
    index('notifications_subject').on(t.subject),
  ],
);

/** A device (browser) that asked for push notifications. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    /** e.g. "Phone · Android · Chrome", so people can tell their devices apart. */
    device: text('device').notNull().default(''),
    failures: integer('failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('push_subscriptions_user').on(t.userId)],
);
