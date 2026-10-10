import { MAX_SAVE_BYTES, MAX_SAVE_KEYS, MAX_SAVE_TOTAL_BYTES } from '@allthespaces/bridge-protocol';
import type { CreationInfo, OpenedCreation } from '@ats/api-types';
import { schema } from '@ats/db';
import {
  avatarColor,
  canSeeRoom,
  isBundlePath,
  playHeaders,
  signToken,
  typeOf,
  verifyToken,
} from '@ats/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, requireUser } from '../access.ts';
import type { AppContext } from '../context.ts';
import { type CreationAccess, creationAccess } from '../creations/access.ts';
import { bundleKey } from '../creations/store.ts';
import { noEvents } from '../events.ts';
import { manifestOf } from '../manifests.ts';
import { spaceAccess } from '../privacy.ts';
import { membershipsFor } from '../session.ts';
import { getStorage } from '../storage.ts';
import { voiceFor } from '../voice.ts';

const {
  creations,
  creationVersions,
  creationDataShared,
  creationDataPersonal,
  spaces,
  spaceVersions,
} = schema;

const Mode = z.enum(['solo', 'shared', 'invite']);
const KEY = /^[\w.:-]{1,128}$/;

/** Play URLs stay the same for hours, so browsers can cache a creation's files. */
const PLAY_BUCKET_S = 6 * 3600;
const PLAY_TTL_S = 24 * 3600;

interface PlayToken {
  /** User */
  u: string;
  /** Creation */
  c: string;
  /** Version */
  v: string;
}

const NO_SUCH_CREATION = 'That creation does not exist.';

export async function creationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env } = ctx;
  const play = new URL(env.ATS_PLAY_URL);
  const appOrigin = new URL(env.ATS_PUBLIC_URL).origin;

  // Access checks for file requests come in bursts; keep answers for a couple of seconds.
  const accessTtlMs = ctx.playAccessTtlMs ?? 2000;
  const accessCache = new Map<string, { at: number; access: Promise<CreationAccess | null> }>();
  const accessOf = (userId: string, creationId: string) => {
    const key = `${userId}:${creationId}`;
    const hit = accessCache.get(key);
    if (hit && Date.now() - hit.at < accessTtlMs) return hit.access;
    const access = creationAccess(db, userId, creationId);
    if (accessCache.size > 5000) accessCache.clear();
    accessCache.set(key, { at: Date.now(), access });
    return access;
  };

  // ---- What's in a space --------------------------------------------------------------------

  /** Creations in the rooms this person may see (Architects also see the unplaced shelf). */
  app.get<{ Params: { spaceId: string } }>('/api/spaces/:spaceId/creations', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    if (!z.uuid().safeParse(req.params.spaceId).success) return notFound(reply, NO_SUCH_CREATION);
    const [space] = await db
      .select({ groupId: spaces.groupId, version: spaceVersions })
      .from(spaces)
      .leftJoin(spaceVersions, eq(spaceVersions.id, spaces.currentVersionId))
      .where(eq(spaces.id, req.params.spaceId));
    const role = (await membershipsFor(db, me.id)).find((m) => m.groupId === space?.groupId)?.role;
    if (!space || !role) return notFound(reply, 'That space does not exist.');
    // A place not published yet has no creations in it (only Architects know it's there).
    if (!space.version)
      return role === 'architect'
        ? { creations: [] }
        : notFound(reply, 'That space does not exist.');
    const manifest = manifestOf(space.version);
    const access = await spaceAccess(db, req.params.spaceId);
    const roomOf = new Map(
      manifest.rooms.flatMap((r) => r.objects.map((o) => [o.key, r.key] as const)),
    );
    const rows = await db
      .select({ creation: creations, version: creationVersions })
      .from(creations)
      .innerJoin(creationVersions, eq(creationVersions.id, creations.currentVersionId))
      .where(eq(creations.spaceId, req.params.spaceId));
    const list = rows.flatMap(({ creation, version }) => {
      const roomKey = creation.objectKey ? roomOf.get(creation.objectKey) : undefined;
      const visible =
        role === 'architect' || (roomKey !== undefined && canSeeRoom(access, me.id, roomKey));
      if (!visible) return [];
      return [
        {
          id: creation.id,
          title: creation.title,
          description: creation.description,
          objectKey: roomKey ? creation.objectKey : null,
          roomKey: roomKey ?? null,
          defaultMode: creation.defaultMode,
          version: version.number,
        },
      ];
    });
    const playing = await (ctx.events ?? noEvents).playing(list.map((c) => c.id));
    return {
      creations: list.map((c) => ({ ...c, playing: playing[c.id] ?? 0 })) satisfies CreationInfo[],
    };
  });

  // ---- Opening a creation -------------------------------------------------------------------

  app.post<{ Params: { creationId: string } }>(
    '/api/creations/:creationId/open',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      if (!z.uuid().safeParse(req.params.creationId).success)
        return notFound(reply, NO_SUCH_CREATION);
      const { mode, sessionId, versionId } = z
        .object({
          mode: Mode.optional(),
          sessionId: z.string().max(64).optional(),
          /** Architects can open any version to try it (a candidate, or an earlier one). */
          versionId: z.uuid().optional(),
        })
        .parse(req.body ?? {});
      const found = await creationAccess(db, me.id, req.params.creationId);
      if (!found) return notFound(reply, NO_SUCH_CREATION);
      const { creation } = found;
      let version = found.version;
      if (versionId && versionId !== version?.id) {
        if (!found.isArchitect) return notFound(reply, NO_SUCH_CREATION);
        const [chosen] = await db
          .select()
          .from(creationVersions)
          .where(
            and(eq(creationVersions.id, versionId), eq(creationVersions.creationId, creation.id)),
          );
        version = chosen ?? null;
      }
      if (!version) return notFound(reply, NO_SUCH_CREATION);
      // Trying a version that isn't live: nothing it saves is kept, so it can't disturb real data.
      const trial = version.id !== creation.currentVersionId;
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = Math.ceil(now / PLAY_BUCKET_S) * PLAY_BUCKET_S + PLAY_TTL_S;
      const token = signToken<PlayToken>(
        'play',
        { u: me.id, c: creation.id, v: version.id },
        env.BETTER_AUTH_SECRET,
        expiresAt - now,
      );
      const voice = await voiceFor(db, env, creation.groupId);
      const sessionMode = trial ? 'solo' : (mode ?? creation.defaultMode);
      const ticket = signToken(
        'creation',
        {
          sub: me.id,
          name: me.name,
          color: avatarColor(me.id),
          creationId: creation.id,
          versionId: version.id,
          groupId: creation.groupId,
          mode: sessionMode,
          voice: voice.allowed,
          ...(sessionId ? { sessionId } : {}),
        },
        env.REALTIME_SECRET,
        120,
      );
      return {
        creation: {
          id: creation.id,
          title: creation.title,
          version: version.number,
          versionId: version.id,
          protocolVersion: version.protocolVersion,
          defaultMode: creation.defaultMode,
          saveVersion: version.saveVersion,
        },
        trial,
        url: `${play.origin}/c/${token}/${version.entry}`,
        playOrigin: play.origin,
        ticket,
        /** Voice chat for this session (not on your own). */
        voice: voice.available && sessionMode !== 'solo',
        ...(version.details?.connectors?.length ? { connectors: version.details.connectors } : {}),
      } satisfies OpenedCreation;
    },
  );

  // ---- Saved data ---------------------------------------------------------------------------

  const SaveParams = z.object({
    creationId: z.uuid(),
    scope: z.enum(['shared', 'personal']),
    key: z.string().regex(KEY),
  });

  app.get<{ Params: { creationId: string; scope: string; key: string } }>(
    '/api/creations/:creationId/data/:scope/:key',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const p = SaveParams.safeParse(req.params);
      if (!p.success || !(await creationAccess(db, me.id, p.data.creationId))) {
        return notFound(reply, NO_SUCH_CREATION);
      }
      const { creationId, scope, key } = p.data;
      const [row] =
        scope === 'shared'
          ? await db
              .select()
              .from(creationDataShared)
              .where(
                and(eq(creationDataShared.creationId, creationId), eq(creationDataShared.key, key)),
              )
          : await db
              .select()
              .from(creationDataPersonal)
              .where(
                and(
                  eq(creationDataPersonal.creationId, creationId),
                  eq(creationDataPersonal.userId, me.id),
                  eq(creationDataPersonal.key, key),
                ),
              );
      reply.header('cache-control', 'private, no-store');
      return row
        ? { value: row.value, schemaVersion: row.schemaVersion, version: row.version }
        : { value: null, schemaVersion: null, version: null };
    },
  );

  app.put<{ Params: { creationId: string; scope: string; key: string } }>(
    '/api/creations/:creationId/data/:scope/:key',
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          // Per signed-in session, not per address: a household plays from one address.
          keyGenerator: (req) =>
            /(?:^|;\s*)(?:__Secure-)?ats\.session_token=([^;]+)/.exec(
              req.headers.cookie ?? '',
            )?.[1] ?? req.ip,
          errorResponseBuilder: () => ({
            statusCode: 429,
            message: "That's a lot of saving at once. Wait a moment and it will work again.",
          }),
        },
      },
    },
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const p = SaveParams.safeParse(req.params);
      if (!p.success || !(await creationAccess(db, me.id, p.data.creationId))) {
        return notFound(reply, NO_SUCH_CREATION);
      }
      const { creationId, scope, key } = p.data;
      const body = z
        .object({
          value: z.unknown(),
          schemaVersion: z.number().int().min(0).max(1_000_000),
          basedOn: z.number().int().nullable().optional(),
        })
        .parse(req.body);
      const json = JSON.stringify(body.value ?? null);
      if (json.length > MAX_SAVE_BYTES) {
        return reply
          .code(413)
          .send({ error: 'That is too much to save at once.', code: 'too-big' });
      }
      const stale = () =>
        reply.code(409).send({
          error: 'Someone else saved this in the meantime. Reload to carry on.',
          code: 'stale',
        });
      const table = scope === 'shared' ? creationDataShared : creationDataPersonal;
      const where =
        scope === 'shared'
          ? and(eq(creationDataShared.creationId, creationId), eq(creationDataShared.key, key))
          : and(
              eq(creationDataPersonal.creationId, creationId),
              eq(creationDataPersonal.userId, me.id),
              eq(creationDataPersonal.key, key),
            );
      const [current] = await db
        .select({ version: table.version, schemaVersion: table.schemaVersion })
        .from(table)
        .where(where);

      // What this person already keeps in this creation, in this scope, apart from this key (a
      // shared key counts for whoever saved it last). Keeps one member from filling the server.
      const mine =
        scope === 'shared'
          ? and(
              eq(creationDataShared.creationId, creationId),
              eq(creationDataShared.updatedBy, me.id),
              sql`${creationDataShared.key} <> ${key}`,
            )
          : and(
              eq(creationDataPersonal.creationId, creationId),
              eq(creationDataPersonal.userId, me.id),
              sql`${creationDataPersonal.key} <> ${key}`,
            );
      const [usage] = await db
        .select({
          keys: sql<number>`count(*)::int`,
          bytes: sql<number>`coalesce(sum(octet_length(${table.value}::text)), 0)::bigint`,
        })
        .from(table)
        .where(mine);
      if (!current && (usage?.keys ?? 0) >= MAX_SAVE_KEYS)
        return reply.code(413).send({
          error: `This creation already keeps as many separate things for you as it can (${MAX_SAVE_KEYS}).`,
          code: 'too-big',
        });
      if (Number(usage?.bytes ?? 0) + Buffer.byteLength(json) > MAX_SAVE_TOTAL_BYTES)
        return reply.code(413).send({
          error: 'This creation already keeps as much for you as it can.',
          code: 'too-big',
        });
      if (current) {
        // An older build of the creation must not overwrite data a newer build has migrated:
        // the person is on an old version and should rejoin (which opens the new one).
        if (body.schemaVersion < current.schemaVersion)
          return reply.code(409).send({
            error: 'A newer version of this creation has saved this. Rejoin to carry on.',
            code: 'outdated',
          });
        if (body.basedOn != null && body.basedOn !== current.version) return stale();
        const updated = await db
          .update(table)
          .set({
            value: body.value ?? null,
            schemaVersion: body.schemaVersion,
            version: sql`${table.version} + 1`,
            updatedAt: new Date(),
            ...(scope === 'shared' ? { updatedBy: me.id } : {}),
          })
          .where(and(where, eq(table.version, current.version)))
          .returning({ version: table.version });
        if (updated.length === 0) return stale();
        return { version: updated[0]?.version };
      }
      const values = {
        creationId,
        key,
        value: body.value ?? null,
        schemaVersion: body.schemaVersion,
        version: 1,
      };
      const inserted =
        scope === 'shared'
          ? await db
              .insert(creationDataShared)
              .values({ ...values, updatedBy: me.id })
              .onConflictDoNothing()
              .returning({ version: creationDataShared.version })
          : await db
              .insert(creationDataPersonal)
              .values({ ...values, userId: me.id })
              .onConflictDoNothing()
              .returning({ version: creationDataPersonal.version });
      if (inserted.length === 0) return stale();
      return { version: 1 };
    },
  );

  // ---- The play origin: creations' own files ------------------------------------------------

  app.get<{ Params: { token: string; '*': string } }>('/c/:token/*', async (req, reply) => {
    // Only ever served on the play origin, never next to the app's cookies.
    if (req.headers.host !== play.host) return reply.code(404).send();
    const token = verifyToken<PlayToken>('play', req.params.token, env.BETTER_AUTH_SECRET);
    const path = req.params['*'];
    const type = typeOf(path);
    if (!token || !isBundlePath(path) || !type) return reply.code(404).send();
    const found = await accessOf(token.u, token.c);
    if (!found) return reply.code(404).send();
    // Any published version of this creation (sessions finish on the version they started), and
    // candidates for Architects trying them.
    const [version] =
      found.version?.id === token.v
        ? [found.version]
        : await db
            .select()
            .from(creationVersions)
            .where(and(eq(creationVersions.id, token.v), eq(creationVersions.creationId, token.c)));
    if (!version?.files.some((f) => f.path === path)) return reply.code(404).send();
    if (version.status === 'candidate' && !found.isArchitect) return reply.code(404).send();

    const base = `${play.origin}/c/${req.params.token}/`;
    reply
      .headers(playHeaders(type, base, appOrigin))
      .header('cache-control', 'private, max-age=86400, immutable');
    const bytes = await (await getStorage(ctx)).getBytes(bundleKey(token.c, version.bundle, path));
    return reply.send(Buffer.from(bytes));
  });
}
