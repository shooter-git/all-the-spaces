import { isBundlePath, playHeaders, signToken, typeOf, verifyToken } from '@ats/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.ts';
import type { WorkspaceShared } from './shared.ts';

/** How long a preview address works. */
const PREVIEW_TTL_S = 6 * 3600;
/** Preview files kept in memory, in all, before the cache starts again. */
const PREVIEW_CACHE_BYTES = 64 * 1024 * 1024;

/** A creation workspace's live preview: its address, and its files (with a small cache). */
export async function previewRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { play, appOrigin, ownWorkspace, workspaceAction }: WorkspaceShared,
) {
  const { env } = ctx;

  /** The live preview: where the latest build is, on the sealed play origin. */
  workspaceAction('GET', '/preview', async (ws, me, sup) => {
    const { status } = await sup.call<{
      status: { stamp?: number; ok?: boolean; error?: string; building?: boolean } | null;
    }>('preview.status', { ws: ws.id });
    if (!status) return { state: 'off' };
    if (!status.stamp) return { state: 'building' };
    if (!status.ok) return { state: 'error', stamp: status.stamp, error: status.error };
    const token = signToken(
      'preview',
      { u: me.id, w: ws.id, s: status.stamp },
      env.BETTER_AUTH_SECRET,
      PREVIEW_TTL_S,
    );
    return {
      state: 'ready',
      stamp: status.stamp,
      url: `${play.origin}/preview/${token}/index.html`,
    };
  });

  // ---- The live preview, on the play origin ------------------------------------------------

  const cache = new Map<string, Buffer>();
  let cached = 0;
  app.get<{ Params: { token: string; '*': string } }>('/preview/:token/*', async (req, reply) => {
    if (req.headers.host !== play.host || !ctx.supervisor) return reply.code(404).send();
    const t = verifyToken<{ u: string; w: string; s: number }>(
      'preview',
      req.params.token,
      env.BETTER_AUTH_SECRET,
    );
    const path = req.params['*'];
    const type = typeOf(path);
    if (!t || !isBundlePath(path) || !type) return reply.code(404).send();
    // Checked every time, cached or not: a pass lasts hours, and the Architect may have stopped
    // being one, or archived the workspace, since it was issued.
    if (!(await ownWorkspace(t.u, t.w))) return reply.code(404).send();
    const key = `${t.w}/${t.s}/${path}`;
    let bytes = cache.get(key);
    if (!bytes) {
      bytes =
        (await ctx.supervisor.raw('preview.file', { ws: t.w }, { stamp: t.s, path })) ?? undefined;
      if (!bytes) return reply.code(404).send();
      if (cached > PREVIEW_CACHE_BYTES) {
        cache.clear();
        cached = 0;
      }
      cache.set(key, bytes);
      cached += bytes.length;
    }
    return reply
      .headers(playHeaders(type, `${play.origin}/preview/${req.params.token}/`, appOrigin))
      .header('cache-control', 'private, max-age=3600')
      .send(bytes);
  });
}
