import type { AppNotification, Sent } from '@ats/api-types';
import { type Db, schema } from '@ats/db';
import type { ServerEnv } from '@ats/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import type { LiveHub } from './chat/hub.ts';
import { open, seal } from './crypto-box.ts';

const { installState, notifications, pushSubscriptions, user, userPrefs } = schema;

/** Something to tell people. */
export interface Notice {
  kind: string;
  title: string;
  body?: string;
  /** Where it leads in the app (a path). */
  url?: string;
  groupId?: string | null;
  /** What it's about (e.g. creation:<id>), so it can be cleared once that's dealt with. */
  subject?: string;
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** How notifications leave the server (replaced in tests). */
export interface NotifyTransport {
  push(target: PushTarget, payload: string, keys: PushKeys, subject: string): Promise<void>;
  mail(message: { to: string; from: string; subject: string; text: string }): Promise<void>;
}

export interface PushKeys {
  publicKey: string;
  privateKey: string;
}

/** A push service's answer meaning the subscription is gone for good. */
const gone = (err: unknown) => {
  const status = (err as { statusCode?: number }).statusCode;
  return status === 404 || status === 410;
};

/** Who the server's emails come from. */
export const mailFrom = (env: ServerEnv) =>
  env.MAIL_FROM ?? `All the Spaces <no-reply@${new URL(env.ATS_PUBLIC_URL).hostname}>`;

export function defaultTransport(env: ServerEnv): NotifyTransport {
  const mailer = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;
  return {
    async push(target, payload, keys, subject) {
      await webpush.sendNotification(target, payload, {
        vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 24 * 60 * 60,
        urgency: 'normal',
      });
    },
    async mail(message) {
      if (!mailer) return;
      await mailer.sendMail(message);
    },
  };
}

/**
 * Tells people about things that concern them: in the app (live, and kept in their list), and —
 * when they aren't in the app right now — on the devices they allowed, or by email if they asked
 * for that. Do Not Disturb holds back everything but the list.
 */
export class Notifier {
  private keys: Promise<PushKeys> | null = null;
  private readonly db: Db;
  private readonly env: ServerEnv;
  readonly hub: LiveHub;
  private readonly transport: NotifyTransport;
  private readonly log: (msg: string) => void;

  constructor(
    db: Db,
    env: ServerEnv,
    hub: LiveHub,
    transport: NotifyTransport = defaultTransport(env),
    log: (msg: string) => void = () => {},
  ) {
    this.db = db;
    this.env = env;
    this.hub = hub;
    this.transport = transport;
    this.log = log;
  }

  get canEmail() {
    return Boolean(this.env.SMTP_URL);
  }

  /** This server's push key pair (made once, the private half sealed with the server secret). */
  pushKeys(): Promise<PushKeys> {
    this.keys ??= (async () => {
      const [row] = await this.db.select({ push: installState.push }).from(installState);
      let stored = row?.push ?? null;
      if (!stored) {
        const made = webpush.generateVAPIDKeys();
        const [saved] = await this.db
          .insert(installState)
          .values({
            id: 1,
            push: {
              publicKey: made.publicKey,
              privateKeyEnc: seal(made.privateKey, this.env.BETTER_AUTH_SECRET, 'push'),
            },
          })
          .onConflictDoUpdate({
            target: installState.id,
            // Two servers starting at once: the first key pair wins.
            set: { push: sql`coalesce(${installState.push}, excluded.push)` },
          })
          .returning({ push: installState.push });
        stored = saved?.push ?? null;
      }
      if (!stored) throw new Error('No push keys');
      return {
        publicKey: stored.publicKey,
        privateKey: open(stored.privateKeyEnc, this.env.BETTER_AUTH_SECRET, 'push'),
      };
    })();
    this.keys.catch(() => {
      this.keys = null;
    });
    return this.keys;
  }

  async send(userIds: Iterable<string>, notice: Notice) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    const rows = await this.db
      .insert(notifications)
      .values(
        ids.map((userId) => ({
          userId,
          groupId: notice.groupId ?? null,
          kind: notice.kind,
          title: notice.title,
          body: notice.body ?? '',
          url: notice.url ?? null,
          subject: notice.subject ?? null,
        })),
      )
      .returning();
    for (const row of rows)
      this.hub.send([row.userId], { t: 'notification', notification: view(row) });

    // Away from the app: their devices, or email.
    const away = ids.filter((id) => !this.hub.isOnline(id));
    if (away.length === 0) return;
    const people = await this.db
      .select({
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        dnd: userPrefs.dnd,
        email_: userPrefs.emailNotifications,
      })
      .from(user)
      .leftJoin(userPrefs, eq(userPrefs.userId, user.id))
      .where(inArray(user.id, away));
    const reachable = people.filter((p) => !p.dnd);
    if (reachable.length === 0) return;
    await Promise.all([
      this.push(
        reachable.map((p) => p.id),
        notice,
      ),
      ...reachable
        // Only to an address its owner confirmed: anyone can type someone else's when joining.
        .filter((p) => p.email_ && p.emailVerified && this.canEmail)
        .map((p) =>
          this.transport
            .mail({
              to: p.email,
              from: mailFrom(this.env),
              subject: notice.title,
              text: [
                notice.body,
                notice.url && new URL(notice.url, this.env.ATS_PUBLIC_URL).toString(),
                'You get these because you asked for email notifications. Turn them off in the app, under Notifications.',
              ]
                .filter(Boolean)
                .join('\n\n'),
            })
            .catch((err: Error) => this.log(`Could not send a notification email: ${err.message}`)),
        ),
    ]);
  }

  private async push(userIds: string[], notice: Notice) {
    const subs = await this.db
      .select()
      .from(pushSubscriptions)
      .where(inArray(pushSubscriptions.userId, userIds));
    if (subs.length === 0) return;
    const keys = await this.pushKeys();
    // Only what's needed to show it: the text itself travels encrypted to the device.
    const payload = JSON.stringify({
      title: notice.title,
      body: notice.body ?? '',
      url: notice.url ?? '/',
      tag: notice.kind,
    });
    const subject = new URL(this.env.ATS_PUBLIC_URL).origin;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await this.transport.push(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            keys,
            subject,
          );
          if (s.failures)
            await this.db
              .update(pushSubscriptions)
              .set({ failures: 0 })
              .where(eq(pushSubscriptions.endpoint, s.endpoint));
        } catch (err) {
          if (gone(err) || s.failures >= 4) {
            await this.db
              .delete(pushSubscriptions)
              .where(eq(pushSubscriptions.endpoint, s.endpoint));
          } else {
            await this.db
              .update(pushSubscriptions)
              .set({ failures: s.failures + 1 })
              .where(eq(pushSubscriptions.endpoint, s.endpoint));
            this.log(`Could not push a notification: ${(err as Error).message}`);
          }
        }
      }),
    );
  }
}

/** A notification as the app shows it. */
export const view = (row: NotificationRow): Sent<AppNotification> => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  body: row.body,
  url: row.url,
  read: Boolean(row.readAt),
  createdAt: row.createdAt,
});
