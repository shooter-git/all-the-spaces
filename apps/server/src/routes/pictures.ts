import { createHash } from 'node:crypto';
import type { AssistantPicture } from '@ats/api-types';
import { schema } from '@ats/db';
import { checkPlan, type SpacePlan } from '@ats/space-format';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFound, requireUser } from '../access.ts';
import type { AppContext } from '../context.ts';
import { sendError } from '../reply.ts';
import { membershipsFor } from '../session.ts';
import { SupervisorError } from '../studio/supervisor.ts';

const { spaceVersions, workspaces } = schema;

/** A picture the assistant made: a model's four views, or a room drawn from a corner. */
const PICTURE = /^preview\/(models|rooms)\/[\w.-]{1,80}\.png$/;

interface Listing {
  pictures: { path: string; bytes: number; at: number }[];
  models: { path: string; bytes: number; at: number }[];
}

/** The same plan, however its keys were ordered or which defaults were written out. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/**
 * What the Architect sees of the assistant's work without reading the terminal: the pictures it
 * made (models from four sides, rooms from their corners), newest first; and, for a place,
 * whether its plan or models have changed since the last build (so the Studio can say "build it
 * to see").
 */
export async function pictureRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  const ownWorkspace = async (userId: string, id: string) => {
    if (!z.uuid().safeParse(id).success) return null;
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    if (!ws || ws.architectId !== userId || ws.status === 'archived') return null;
    const architect = (await membershipsFor(db, userId)).some(
      (m) => m.groupId === ws.groupId && m.role === 'architect',
    );
    return architect ? ws : null;
  };
  const sandboxSaid = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SupervisorError)
      return sendError(reply, 502, `The sandbox service said: ${err.message}`);
    throw err;
  };

  app.get<{ Params: { id: string } }>('/api/workspaces/:id/pictures', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const ws = await ownWorkspace(me.id, req.params.id);
    if (!ws) return notFound(reply);
    if (!ctx.supervisor)
      return sendError(reply, 503, "The Studio isn't set up on this server yet.");
    reply.header('cache-control', 'private, no-store');
    try {
      const listing = await ctx.supervisor.call<Listing>('workspace.pictures', { ws: ws.id });
      const pictures = listing.pictures
        .filter((p) => PICTURE.test(p.path))
        .sort((a, b) => b.at - a.at)
        .map((p) => ({
          path: p.path,
          kind: p.path.startsWith('preview/rooms/') ? ('room' as const) : ('model' as const),
          name: (p.path.split('/').pop() ?? '').replace(/\.png$/, ''),
          at: Math.round(p.at * 1000),
        })) satisfies AssistantPicture[];
      let build: { last: number | null; changed: boolean } | null = null;
      if (ws.kind === 'space' && ws.spaceId) {
        const [last] = await db
          .select()
          .from(spaceVersions)
          .where(eq(spaceVersions.spaceId, ws.spaceId))
          .orderBy(desc(spaceVersions.number))
          .limit(1);
        const bytes = await ctx.supervisor.raw(
          'workspace.read',
          { ws: ws.id },
          { path: 'plan.json' },
        );
        let raw: unknown = null;
        try {
          raw = JSON.parse(bytes?.toString('utf8') ?? 'null');
        } catch {}
        const { plan } = checkPlan(raw);
        const used = new Set(
          ((plan as SpacePlan | null)?.furniture ?? []).flatMap((f) => (f.model ? [f.model] : [])),
        );
        const builtAt = last?.createdAt.getTime() ?? 0;
        const planChanged = !last || canonical(plan ?? raw) !== canonical(last.plan);
        const modelChanged = listing.models.some((m) => used.has(m.path) && m.at * 1000 > builtAt);
        build = {
          last: last?.number ?? null,
          // Something to build: a plan with rooms that differs from the last build.
          changed: Boolean(plan?.rooms.length) && (planChanged || modelChanged),
        };
      }
      return { pictures, build };
    } catch (err) {
      return sandboxSaid(reply, err);
    }
  });

  app.get<{ Params: { id: string; '*': string } }>(
    '/api/workspaces/:id/pictures/*',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const ws = await ownWorkspace(me.id, req.params.id);
      const path = req.params['*'];
      if (!ws || !ctx.supervisor || !PICTURE.test(path)) return notFound(reply);
      try {
        const bytes = await ctx.supervisor.raw('workspace.read', { ws: ws.id }, { path });
        if (!bytes) return notFound(reply);
        const etag = `"${createHash('sha1').update(bytes).digest('base64url')}"`;
        reply.header('etag', etag).header('cache-control', 'private, no-cache');
        if (req.headers['if-none-match'] === etag) return reply.code(304).send();
        return reply.header('content-type', 'image/png').send(bytes);
      } catch (err) {
        return sandboxSaid(reply, err);
      }
    },
  );
}
