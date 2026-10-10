import { schema } from '@ats/db';
import { PROVIDERS, type Provider } from '@ats/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isArchitect, notFound, requireUser } from '../../access.ts';
import type { AppContext } from '../../context.ts';
import { sendError } from '../../reply.ts';
import type { Supervisor } from '../../studio/supervisor.ts';
import { SupervisorError } from '../../studio/supervisor.ts';

const { workspaces } = schema;

export const Prov = z.enum(PROVIDERS as [Provider, ...Provider[]]);

/**
 * What the Studio's routes share, made once per app by `workspaceRoutes`: the play origin, the
 * checks on a workspace and the replies when the sandbox service is missing or fails.
 */
export function workspaceShared(app: FastifyInstance, ctx: AppContext) {
  const { db, env } = ctx;
  const play = new URL(env.ATS_PLAY_URL);
  const appOrigin = new URL(env.ATS_PUBLIC_URL).origin;
  const unavailable = (reply: FastifyReply) =>
    sendError(reply, 503, "The Studio isn't set up on this server yet.");

  /** A workspace this person may use (it's theirs: their assistant runs in it). */
  const ownWorkspace = async (userId: string, id: string) => {
    if (!z.uuid().safeParse(id).success) return null;
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    if (!ws || ws.architectId !== userId || ws.status === 'archived') return null;
    return (await isArchitect(db, userId, ws.groupId)) ? ws : null;
  };
  const touch = (id: string) =>
    db.update(workspaces).set({ lastActivityAt: new Date() }).where(eq(workspaces.id, id));

  const failure = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SupervisorError)
      return sendError(reply, 502, `The sandbox service said: ${err.message}`);
    throw err;
  };

  const workspaceAction = (
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    run: (
      ws: typeof workspaces.$inferSelect,
      me: { id: string },
      sup: Supervisor,
      req: { body: unknown; query: unknown },
      reply: FastifyReply,
    ) => Promise<unknown>,
  ) =>
    app.route<{ Params: { id: string } }>({
      method,
      url: `/api/workspaces/:id${path}`,
      handler: async (req, reply) => {
        const me = await requireUser(ctx, req, reply);
        if (!me) return;
        const ws = await ownWorkspace(me.id, req.params.id);
        if (!ws) return notFound(reply);
        if (!ctx.supervisor) return unavailable(reply);
        reply.header('cache-control', 'private, no-store');
        try {
          return await run(ws, me, ctx.supervisor, req, reply);
        } catch (err) {
          return failure(reply, err);
        }
      },
    });

  return { play, appOrigin, unavailable, ownWorkspace, touch, failure, workspaceAction };
}

export type WorkspaceShared = ReturnType<typeof workspaceShared>;
