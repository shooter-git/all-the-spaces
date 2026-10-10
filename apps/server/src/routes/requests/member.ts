import type { ObjectRequests, RequestDetail, RequestEvent, Sent } from '@ats/api-types';
import { type Db, schema } from '@ats/db';
import { canSeeRoom, type SpaceAccess } from '@ats/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, requireUser } from '../../access.ts';
import { record } from '../../audit.ts';
import {
  announceCommission,
  architectsOf,
  EVENT_WORDS,
  moveCommission,
  OPEN,
  requestUrl,
  STATUS_WORDS,
} from '../../commissions.ts';
import type { AppContext } from '../../context.ts';
import { openPicture } from '../../pictures.ts';
import { spaceAccess } from '../../privacy.ts';
import { sendError } from '../../reply.ts';
import { getStorage } from '../../storage.ts';
import { NO_SUCH_REQUEST, type RequestShared } from './shared.ts';

const { commissionEvents, commissions, creations, roomPolicies, spaces, user, workspaces } = schema;

/** Pictures that can come with a request. */
const IMAGE = /^(snapshot|sketch|image-[1-3])$/;
const MAX_IMAGES = 5;
/** The largest picture a member may add, in pixels (50 megapixels: any phone's camera). */
const MAX_PICTURE_PIXELS = 50_000_000;
/** Documents that can come with a request (Markdown: a design plan, a story, the rules). */
const DOCUMENT = /^doc-[1-3]$/;
/** The longest document, in characters (a long, detailed plan). */
export const MAX_DOCUMENT_CHARS = 50_000;
/** The file names a document may have. */
const DOCUMENT_FILE = /\.(md|markdown|txt)$/i;
/** Open requests one person may have in a group at once (so nobody floods the queue). */
const MAX_OPEN = 10;

export const imageKey = (id: string, name: string) => `requests/${id}/${name}.jpg`;
export const documentKey = (id: string, name: string) => `requests/${id}/${name}.md`;

/** Who may ask for things in a room: anyone who can see it, only its owner, or only Architects. */
export async function mayAskIn(
  db: Db,
  spaceId: string,
  roomKey: string,
  userId: string,
  isArchitect: boolean,
) {
  if (isArchitect) return true;
  const [policy] = await db
    .select({ requests: roomPolicies.requests, ownerId: roomPolicies.ownerId })
    .from(roomPolicies)
    .where(and(eq(roomPolicies.spaceId, spaceId), eq(roomPolicies.roomKey, roomKey)));
  if (!policy) return false; // hidden rooms: Architects only
  if (policy.requests === 'anyone') return true;
  return policy.requests === 'owner' && policy.ownerId === userId;
}

/** A member's side: asking, pictures, their own requests, notes and withdrawing. */
export async function memberRequestRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { limited, spaceFor, requestFor, summary }: RequestShared,
) {
  const { db } = ctx;

  // ---- Asking ---------------------------------------------------------------------------------

  app.post<{ Params: { spaceId: string } }>(
    '/api/spaces/:spaceId/requests',
    limited,
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const found = await spaceFor(me.id, req.params.spaceId);
      if (!found) return notFound(reply, 'That space does not exist.');
      const body = z
        .object({
          kind: z.enum(['new', 'improve', 'bug']),
          objectKey: z.string().max(100).nullish(),
          roomKey: z.string().max(100).nullish(),
          creationId: z.uuid().nullish(),
          title: z.string().trim().min(1).max(80),
          prompt: z.string().trim().min(1).max(10_000),
        })
        .parse(req.body);
      const { space, manifest, isArchitect } = found;
      const access = await spaceAccess(db, space.id);
      const sees = (roomKey: string) => isArchitect || canSeeRoom(access, me.id, roomKey);
      const roomOfObject = (key: string) =>
        manifest.rooms.find((r) => r.objects.some((o) => o.key === key));

      let roomKey: string;
      let objectKey: string | null = null;
      let objectLabel: string | null = null;
      let creationId: string | null = null;
      if (body.kind === 'new') {
        if (body.objectKey) {
          const room = roomOfObject(body.objectKey);
          if (!room || !sees(room.key)) return notFound(reply, 'No such object.');
          const [taken] = await db
            .select({ title: creations.title, live: creations.currentVersionId })
            .from(creations)
            .where(and(eq(creations.spaceId, space.id), eq(creations.objectKey, body.objectKey)));
          if (taken)
            return sendError(
              reply,
              409,
              taken.live
                ? `It already holds ${taken.title}. Suggest a change to that instead.`
                : 'Something is already being built for it.',
            );
          roomKey = room.key;
          objectKey = body.objectKey;
          objectLabel = room.objects.find((o) => o.key === objectKey)?.label ?? null;
        } else {
          // A new object: say which room it's for.
          const room = manifest.rooms.find((r) => r.key === body.roomKey);
          if (!room || !sees(room.key)) return notFound(reply, 'No such room.');
          roomKey = room.key;
        }
      } else {
        const [c] = body.creationId
          ? await db
              .select()
              .from(creations)
              .where(and(eq(creations.id, body.creationId), eq(creations.spaceId, space.id)))
          : [];
        const room = c?.objectKey ? roomOfObject(c.objectKey) : undefined;
        if (!c?.currentVersionId || !room || !sees(room.key))
          return notFound(reply, 'That creation does not exist.');
        roomKey = room.key;
        objectKey = c.objectKey;
        objectLabel = room.objects.find((o) => o.key === objectKey)?.label ?? null;
        creationId = c.id;
      }
      // Anyone who can see something can report a problem with it; asking for something new
      // or a change follows the room's rule.
      if (body.kind !== 'bug' && !(await mayAskIn(db, space.id, roomKey, me.id, isArchitect)))
        return sendError(reply, 403, 'Requests in this room are up to its owner.');

      const [{ open } = { open: 0 }] = await db
        .select({ open: sql<number>`count(*)::int` })
        .from(commissions)
        .where(
          and(
            eq(commissions.groupId, space.groupId),
            eq(commissions.requesterId, me.id),
            inArray(commissions.status, OPEN),
          ),
        );
      if (open >= MAX_OPEN)
        return sendError(
          reply,
          429,
          `You have ${open} requests waiting. Once some of them are done you can ask for more.`,
        );

      // The request, the first entry in its timeline and the audit entry are written together.
      const c = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(commissions)
          .values({
            groupId: space.groupId,
            spaceId: space.id,
            kind: body.kind,
            objectKey,
            roomKey,
            objectLabel,
            creationId,
            requesterId: me.id,
            title: body.title,
            prompt: body.prompt,
          })
          .returning();
        if (!row) throw new Error('Request not created');
        await tx
          .insert(commissionEvents)
          .values({ commissionId: row.id, actorId: me.id, status: 'submitted' });
        await record(tx, {
          groupId: space.groupId,
          actorUserId: me.id,
          action: 'request.created',
          target: row.id,
        });
        return row;
      });
      await announceCommission(db, ctx.notifier, c);
      return { id: c.id };
    },
  );

  // Pictures: what they drew a box around, a sketch, or photos. Re-saved without hidden details.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      /^image\//,
      { parseAs: 'buffer', bodyLimit: 12 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.put<{ Params: { id: string; name: string } }>(
      '/api/requests/:id/images/:name',
      async (req, reply) => {
        const me = await requireUser(ctx, req, reply);
        if (!me) return;
        const found = await requestFor(me.id, req.params.id);
        if (!found?.mine || !IMAGE.test(req.params.name)) return notFound(reply, NO_SUCH_REQUEST);
        const { c } = found;
        if (c.status !== 'submitted')
          return sendError(reply, 409, 'Pictures can only be added before it’s accepted.');
        if (!c.images.includes(req.params.name) && c.images.length >= MAX_IMAGES)
          return sendError(reply, 409, `Up to ${MAX_IMAGES} pictures.`);
        let jpeg: Buffer;
        try {
          jpeg = await (await openPicture(req.body as Buffer, MAX_PICTURE_PIXELS))
            .rotate()
            .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 84, mozjpeg: true })
            .toBuffer();
        } catch {
          return sendError(reply, 415, "That doesn't look like a picture.");
        }
        await (await getStorage(ctx)).put(imageKey(c.id, req.params.name), jpeg, 'image/jpeg');
        const images = [...new Set([...c.images, req.params.name])];
        await db.update(commissions).set({ images }).where(eq(commissions.id, c.id));
        return { images };
      },
    );
  });

  app.get<{ Params: { id: string; name: string } }>(
    '/api/requests/:id/images/:name',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const found = await requestFor(me.id, req.params.id);
      if (!found?.c.images.includes(req.params.name)) return notFound(reply, NO_SUCH_REQUEST);
      const bytes = await (await getStorage(ctx)).getBytes(imageKey(found.c.id, req.params.name));
      return reply
        .header('content-type', 'image/jpeg')
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(bytes));
    },
  );

  // Documents: Markdown they wrote for it (a design plan too long for the box), kept as text.
  app.put<{ Params: { id: string; name: string } }>(
    '/api/requests/:id/documents/:name',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const found = await requestFor(me.id, req.params.id);
      if (!found?.mine || !DOCUMENT.test(req.params.name)) return notFound(reply, NO_SUCH_REQUEST);
      const { c } = found;
      if (c.status !== 'submitted')
        return sendError(reply, 409, 'Documents can only be added before it’s accepted.');
      const body = z.object({ file: z.string().max(200), text: z.string() }).safeParse(req.body);
      if (!body.success)
        return sendError(reply, 415, 'That doesn’t look like a Markdown or text file.');
      if (body.data.text.length > MAX_DOCUMENT_CHARS)
        return sendError(
          reply,
          413,
          `A document can be up to ${MAX_DOCUMENT_CHARS.toLocaleString('en')} characters.`,
        );
      // Its own name, without any folders or invisible characters.
      const file = (body.data.file.split(/[\\/]/).pop() ?? '')
        .replace(/[\p{C}"]/gu, '')
        .trim()
        .slice(0, 120);
      const text = body.data.text.replace(/^\uFEFF/, '');
      if (!DOCUMENT_FILE.test(file) || !text.trim() || text.includes('\0'))
        return sendError(reply, 415, 'That doesn’t look like a Markdown or text file.');
      await (await getStorage(ctx)).put(
        documentKey(c.id, req.params.name),
        Buffer.from(text, 'utf8'),
        'text/markdown; charset=utf-8',
      );
      const documents = [
        ...c.documents.filter((d) => d.name !== req.params.name),
        { name: req.params.name, file },
      ].sort((a, b) => a.name.localeCompare(b.name));
      await db.update(commissions).set({ documents }).where(eq(commissions.id, c.id));
      return { documents };
    },
  );

  app.get<{ Params: { id: string; name: string } }>(
    '/api/requests/:id/documents/:name',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const found = await requestFor(me.id, req.params.id);
      const doc = found?.c.documents.find((d) => d.name === req.params.name);
      if (!found || !doc) return notFound(reply, NO_SUCH_REQUEST);
      const bytes = await (await getStorage(ctx)).getBytes(documentKey(found.c.id, doc.name));
      // Shown as plain text, never as a page.
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.file)}`)
        .header('cache-control', 'private, no-store')
        .send(Buffer.from(bytes));
    },
  );

  // ---- Following them -------------------------------------------------------------------------

  /** My requests, newest first. */
  app.get('/api/requests', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const rows = await db
      .select({ c: commissions, spaceName: spaces.name })
      .from(commissions)
      .innerJoin(spaces, eq(spaces.id, commissions.spaceId))
      .where(eq(commissions.requesterId, me.id))
      .orderBy(desc(commissions.updatedAt))
      .limit(200);
    reply.header('cache-control', 'private, no-store');
    return {
      requests: rows.map((r) => summary(r.c, { spaceName: r.spaceName, forArchitect: false })),
    };
  });

  /** One request, with its timeline. */
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const found = await requestFor(me.id, req.params.id);
    if (!found) return notFound(reply, NO_SUCH_REQUEST);
    const { c, isArchitect, mine } = found;
    const [space] = await db
      .select({ name: spaces.name })
      .from(spaces)
      .where(eq(spaces.id, c.spaceId));
    const [requester] = c.requesterId
      ? await db.select({ name: user.name }).from(user).where(eq(user.id, c.requesterId))
      : [];
    const events = await db
      .select({ e: commissionEvents, actorName: user.name })
      .from(commissionEvents)
      .leftJoin(user, eq(user.id, commissionEvents.actorId))
      .where(eq(commissionEvents.commissionId, c.id))
      .orderBy(asc(commissionEvents.createdAt));
    const [ws] = c.workspaceId
      ? await db
          .select({
            id: workspaces.id,
            status: workspaces.status,
            architectId: workspaces.architectId,
          })
          .from(workspaces)
          .where(eq(workspaces.id, c.workspaceId))
      : [];
    reply.header('cache-control', 'private, no-store');
    return {
      request: {
        ...summary(c, {
          spaceName: space?.name,
          requesterName: requester?.name,
          forArchitect: isArchitect,
        }),
        prompt: c.prompt,
        brief: isArchitect ? c.brief : undefined,
        mine,
        canWithdraw: mine && ['submitted', 'accepted'].includes(c.status),
        workspace:
          isArchitect && ws && ws.status !== 'archived'
            ? { id: ws.id, mine: ws.architectId === me.id }
            : null,
      } satisfies Sent<RequestDetail>,
      events: events.map(({ e, actorName }) => ({
        id: e.id,
        status: e.status,
        statusWords: e.status ? (EVENT_WORDS[e.status] ?? STATUS_WORDS[e.status]) : null,
        note: e.note,
        by: e.actorId === c.requesterId ? (mine ? 'You' : actorName) : (actorName ?? null),
        byArchitect: Boolean(e.actorId && e.actorId !== c.requesterId),
        at: e.createdAt,
      })) satisfies Sent<RequestEvent>[],
    };
  });

  app.post<{ Params: { id: string } }>('/api/requests/:id/withdraw', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const found = await requestFor(me.id, req.params.id);
    if (!found?.mine) return notFound(reply, NO_SUCH_REQUEST);
    if (!['submitted', 'accepted'].includes(found.c.status))
      return sendError(
        reply,
        409,
        'It’s already being built. Add a note for the Architect instead.',
      );
    await moveCommission(db, ctx.notifier, found.c, 'withdrawn', { actorId: me.id });
    return { ok: true };
  });

  /** A note on a request: more detail from the member, or a word from an Architect. */
  app.post<{ Params: { id: string } }>('/api/requests/:id/notes', limited, async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const found = await requestFor(me.id, req.params.id);
    if (!found) return notFound(reply, NO_SUCH_REQUEST);
    const { note } = z.object({ note: z.string().trim().min(1).max(2000) }).parse(req.body);
    const { c } = found;
    if (!OPEN.includes(c.status)) return sendError(reply, 409, 'This request is closed.');
    await db.insert(commissionEvents).values({ commissionId: c.id, actorId: me.id, note });
    await db.update(commissions).set({ updatedAt: new Date() }).where(eq(commissions.id, c.id));
    if (found.mine) {
      const to = (await architectsOf(db, c.groupId)).filter((id) => id !== me.id);
      await ctx.notifier?.send(to, {
        kind: 'request.note',
        title: `More about: ${c.title}`,
        body: note.slice(0, 200),
        url: requestUrl(c, true),
        groupId: c.groupId,
      });
    } else if (c.requesterId) {
      await ctx.notifier?.send([c.requesterId], {
        kind: 'request.note',
        title: `A note about: ${c.title}`,
        body: note.slice(0, 200),
        url: requestUrl(c, false),
        groupId: c.groupId,
      });
    }
    return { ok: true };
  });

  /**
   * What's been asked for on the objects this person can see: requested, or being built. Only
   * the state (and whether it's theirs) — not who asked or what they said.
   */
  app.get<{ Params: { spaceId: string } }>(
    '/api/spaces/:spaceId/requests/objects',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const found = await spaceFor(me.id, req.params.spaceId);
      if (!found) return notFound(reply, 'That space does not exist.');
      const access: SpaceAccess = await spaceAccess(db, found.space.id);
      const rows = await db
        .select({
          objectKey: commissions.objectKey,
          roomKey: commissions.roomKey,
          status: commissions.status,
          requesterId: commissions.requesterId,
          kind: commissions.kind,
        })
        .from(commissions)
        .where(and(eq(commissions.spaceId, found.space.id), inArray(commissions.status, OPEN)));
      const objects = new Map<string, { state: 'requested' | 'building'; mine: boolean }>();
      const here = new Set(found.manifest.rooms.flatMap((r) => r.objects.map((o) => o.key)));
      for (const r of rows) {
        if (r.kind !== 'new' || !r.objectKey || !here.has(r.objectKey)) continue;
        if (!found.isArchitect && !canSeeRoom(access, me.id, r.roomKey)) continue;
        const state = ['submitted', 'accepted'].includes(r.status) ? 'requested' : 'building';
        const prev = objects.get(r.objectKey);
        objects.set(r.objectKey, {
          state: prev?.state === 'building' ? 'building' : state,
          mine: Boolean(prev?.mine) || r.requesterId === me.id,
        });
      }
      reply.header('cache-control', 'private, no-store');
      return { objects: Object.fromEntries(objects) satisfies ObjectRequests };
    },
  );
}
