import type { NotificationSettings, Sent } from '@ats/api-types';
import { schema } from '@ats/db';
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../access.ts';
import type { AppContext } from '../../context.ts';
import { view } from '../../notify.ts';
import { sendError } from '../../reply.ts';
import type { RequestShared } from './shared.ts';

const { notifications, pushSubscriptions, userPrefs } = schema;

/**
 * The browsers' own push services. The server sends to whatever address a device registers, so
 * only these are accepted: never an address inside this server's network.
 */
const PUSH_SERVICES = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];
export const isPushService = (endpoint: string) => {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'https:' &&
      !url.port &&
      PUSH_SERVICES.some((host) => host.test(url.hostname))
    );
  } catch {
    return false;
  }
};

/** Notifications: the list, reading them, how to be told, and devices for push. */
export async function notificationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { limited }: RequestShared,
) {
  const { db } = ctx;

  // ---- Notifications --------------------------------------------------------------------------

  app.get<{ Querystring: { before?: string } }>('/api/notifications', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const before = req.query.before ? new Date(req.query.before) : null;
    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, me.id),
          before && !Number.isNaN(+before) ? lt(notifications.createdAt, before) : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(30);
    const [{ unread } = { unread: 0 }] = await db
      .select({ unread: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, me.id), isNull(notifications.readAt)));
    reply.header('cache-control', 'private, no-store');
    return { notifications: rows.map(view), unread, more: rows.length === 30 };
  });

  app.post('/api/notifications/read', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const { ids } = z.object({ ids: z.array(z.uuid()).max(100).optional() }).parse(req.body ?? {});
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, me.id),
          isNull(notifications.readAt),
          ids ? inArray(notifications.id, ids) : undefined,
        ),
      );
    return { ok: true };
  });

  /** Clears some of their own: the ones named, or all they've read. */
  app.delete('/api/notifications', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const body = z
      .union([
        z.object({ ids: z.array(z.uuid()).min(1).max(100) }).strict(),
        z.object({ read: z.literal(true) }).strict(),
      ])
      .parse(req.body ?? {});
    await db
      .delete(notifications)
      .where(
        and(
          eq(notifications.userId, me.id),
          'ids' in body ? inArray(notifications.id, body.ids) : isNotNull(notifications.readAt),
        ),
      );
    return { ok: true };
  });

  /** How this person likes to be told, and what this server can do. */
  app.get('/api/notifications/settings', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const [prefs] = await db.select().from(userPrefs).where(eq(userPrefs.userId, me.id));
    const devices = await db
      .select({ endpoint: pushSubscriptions.endpoint, device: pushSubscriptions.device })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, me.id));
    return {
      email: prefs?.emailNotifications ?? false,
      // Only to a confirmed address.
      canEmail: Boolean(ctx.notifier?.canEmail) && me.emailVerified,
      pushKey: ctx.notifier ? (await ctx.notifier.pushKeys()).publicKey : null,
      devices,
    } satisfies Sent<NotificationSettings>;
  });

  app.put('/api/notifications/settings', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const { email } = z.object({ email: z.boolean() }).parse(req.body);
    await db
      .insert(userPrefs)
      .values({ userId: me.id, emailNotifications: email })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: { emailNotifications: email, updatedAt: new Date() },
      });
    return { ok: true };
  });

  /** This device would like push notifications (its browser made the subscription). */
  app.post('/api/notifications/devices', limited, async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const body = z
      .object({
        endpoint: z.url().max(1000).startsWith('https://'),
        keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
        device: z.string().trim().max(80).default(''),
      })
      .parse(req.body);
    if (!isPushService(body.endpoint))
      return sendError(reply, 400, "This browser's push service isn't supported.");
    await db
      .insert(pushSubscriptions)
      .values({
        endpoint: body.endpoint,
        userId: me.id,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        device: body.device,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: me.id,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          device: body.device,
          failures: 0,
        },
      });
    return { ok: true };
  });

  app.delete('/api/notifications/devices', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, me.id)));
    return { ok: true };
  });
}
