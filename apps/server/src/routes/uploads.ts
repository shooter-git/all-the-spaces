import type { UploadedFile } from '@ats/api-types';
import { schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFound, requireUser } from '../access.ts';
import { record } from '../audit.ts';
import type { AppContext } from '../context.ts';
import { openPicture } from '../pictures.ts';
import { sendError } from '../reply.ts';
import { membershipsFor } from '../session.ts';
import { getStorage } from '../storage.ts';
import { SupervisorError } from '../studio/supervisor.ts';
import { inputKey, LIMITS } from './onboarding.ts';

const { spaceInputs, workspaces } = schema;

export const MAX_UPLOAD = 25 * 1024 * 1024;

/** Pictures we clean on the way in (others, like GIF and SVG, are kept as they are). */
const PICTURE = /^(jpe?g|png|webp|heic|heif|avif|tiff?)$/;
/** A name a file in uploads/ can have (the ones this route gives). */
const UPLOADED = /^[a-z0-9][a-z0-9_-]{0,79}(\.[a-z0-9]{1,10})?$/;

/**
 * A plain, safe file name from whatever the Architect's file was called ("Kitchen Window
 * (2).HEIC" → kitchen-window-2 + .heic): lower case letters, digits and dashes only.
 */
export function uploadName(original: string): { base: string; ext: string } {
  const plain = original.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const dot = plain.lastIndexOf('.');
  const rawExt = dot > 0 ? plain.slice(dot + 1) : '';
  const ext = /^[a-z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
  const base =
    (ext ? plain.slice(0, dot) : plain)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'file';
  return { base, ext };
}

/**
 * Adding files to a workspace while the assistant works: they go into its `uploads/` folder, and
 * their paths are pasted into the terminal (never sent: the Architect adds words and presses
 * Enter, C9). Pictures lose their location and camera details on the way in; a place's pictures
 * are also kept with the place's photos and plans.
 */
export async function uploadRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  /** The workspace, if it's this Architect's own (their assistant runs in it). */
  const ownWorkspace = async (userId: string, id: string) => {
    if (!z.uuid().safeParse(id).success) return null;
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    if (!ws || ws.architectId !== userId || ws.status === 'archived') return null;
    const architect = (await membershipsFor(db, userId)).some(
      (m) => m.groupId === ws.groupId && m.role === 'architect',
    );
    return architect ? ws : null;
  };
  /** How a file is named to the assistant: Claude Code reads a file named with @; Codex takes
   * the path as it is (its @ opens a file picker). */
  const mention = (ws: { provider: string }, name: string) =>
    `${ws.provider === 'claude' ? '@' : ''}uploads/${name} `;
  const sandboxSaid = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SupervisorError)
      return sendError(reply, 502, `The sandbox service said: ${err.message}`);
    throw err;
  };

  /** What's been added (while the workspace is awake). */
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/uploads', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const ws = await ownWorkspace(me.id, req.params.id);
    if (!ws) return notFound(reply);
    if (!ctx.supervisor)
      return sendError(reply, 503, "The Studio isn't set up on this server yet.");
    reply.header('cache-control', 'private, no-store');
    try {
      return await ctx.supervisor.call<{ files: UploadedFile[] }>('workspace.uploads', {
        ws: ws.id,
      });
    } catch (err) {
      return sandboxSaid(reply, err);
    }
  });

  /** Removes an added file from the workspace (a place keeps its copy with its photos and plans). */
  app.delete<{ Params: { id: string; name: string } }>(
    '/api/workspaces/:id/uploads/:name',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const ws = await ownWorkspace(me.id, req.params.id);
      if (!ws || !UPLOADED.test(req.params.name)) return notFound(reply);
      if (!ctx.supervisor)
        return sendError(reply, 503, "The Studio isn't set up on this server yet.");
      try {
        const r = await ctx.supervisor.call<{ ok: boolean }>(
          'workspace.unupload',
          { ws: ws.id },
          { name: req.params.name },
        );
        if (!r.ok) return sendError(reply, 500, "That file couldn't be removed.");
        await record(db, {
          groupId: ws.groupId,
          actorUserId: me.id,
          action: 'workspace.upload.remove',
          target: ws.id,
        });
        return { ok: true };
      } catch (err) {
        return sandboxSaid(reply, err);
      }
    },
  );

  /** Names an added file in the terminal again (pasted, never sent: C9). */
  app.post<{ Params: { id: string; name: string } }>(
    '/api/workspaces/:id/uploads/:name/mention',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const ws = await ownWorkspace(me.id, req.params.id);
      if (!ws || !UPLOADED.test(req.params.name)) return notFound(reply);
      if (!ctx.supervisor)
        return sendError(reply, 503, "The Studio isn't set up on this server yet.");
      try {
        const r = await ctx.supervisor.call<{ ok: boolean }>(
          'sandbox.paste',
          { ws: ws.id },
          { text: mention(ws, req.params.name) },
        );
        return { typed: r.ok };
      } catch (err) {
        return sandboxSaid(reply, err);
      }
    },
  );

  await app.register(async (scope) => {
    // Any file, as the request body.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD },
      (_req, body, done) => done(null, body),
    );
    scope.put<{ Params: { id: string; name: string }; Querystring: { as?: string } }>(
      '/api/workspaces/:id/uploads/:name',
      async (req, reply) => {
        const me = await requireUser(ctx, req, reply);
        if (!me) return;
        const ws = await ownWorkspace(me.id, req.params.id);
        if (!ws) return notFound(reply);
        if (!ctx.supervisor)
          return sendError(reply, 503, "The Studio isn't set up on this server yet.");
        if (!Buffer.isBuffer(req.body) || !req.body.length)
          return sendError(reply, 400, 'That file is empty.');
        reply.header('cache-control', 'private, no-store');

        const { base, ext } = uploadName(req.params.name);
        const picture =
          PICTURE.test(ext) || String(req.headers['content-type']).startsWith('image/');
        let data: Buffer = req.body;
        let name = ext ? `${base}.${ext}` : base;
        let input: { name: string; kind: 'plan' | 'photo' } | null = null;

        if (ws.kind === 'space') {
          // A place: pictures only (a PDF's pages arrive as pictures), cleaned as at setup.
          const kind = req.query.as === 'plan' ? 'plan' : 'photo';
          try {
            const { data: jpeg, info } = await (await openPicture(req.body, 100_000_000))
              .rotate()
              .resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 86, mozjpeg: true })
              .toBuffer({ resolveWithObject: true });
            data = jpeg;
            name = `${base}.jpg`;
            // Kept with the place too (so the next time it's changed, the assistant has it).
            const existing = ws.spaceId
              ? await db.select().from(spaceInputs).where(eq(spaceInputs.spaceId, ws.spaceId))
              : [];
            if (ws.spaceId && existing.filter((i) => i.kind === kind).length < LIMITS[kind]) {
              const taken = new Set(existing.map((i) => i.name));
              let n = 1;
              while (taken.has(`${kind}-${n}`)) n++;
              input = { name: `${kind}-${n}`, kind };
              await (await getStorage(ctx)).put(
                inputKey(ws.spaceId, input.name),
                jpeg,
                'image/jpeg',
              );
              await db.insert(spaceInputs).values({
                spaceId: ws.spaceId,
                name: input.name,
                kind,
                note: base.replace(/-/g, ' ').slice(0, 200),
                width: info.width,
                height: info.height,
                bytes: jpeg.length,
              });
            }
          } catch {
            return sendError(
              reply,
              415,
              'A place takes pictures and PDFs (photos, or plans: JPEG, PNG, HEIC, PDF…).',
            );
          }
        } else if (picture) {
          // A creation: the same picture, without its hidden details (where and on what it was
          // taken). One that can't be read is kept as it is.
          try {
            const img = (await openPicture(req.body, 100_000_000))
              .rotate()
              .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
            if (ext === 'png' || ext === 'webp') data = await img.toFormat(ext).toBuffer();
            else {
              data = await img.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
              name = `${base}.jpg`;
            }
          } catch {}
        }

        try {
          const r = await ctx.supervisor.call<{ name: string; running: boolean }>(
            'workspace.upload',
            { ws: ws.id },
            { name, data: data.toString('base64') },
          );
          const path = `uploads/${r.name}`;
          const typed = r.running
            ? (
                await ctx.supervisor.call<{ ok: boolean }>(
                  'sandbox.paste',
                  { ws: ws.id },
                  { text: mention(ws, r.name) },
                )
              ).ok
            : false;
          await db
            .update(workspaces)
            .set({ lastActivityAt: new Date() })
            .where(eq(workspaces.id, ws.id));
          await record(db, {
            groupId: ws.groupId,
            actorUserId: me.id,
            action: 'workspace.upload',
            target: ws.id,
            metadata: { bytes: data.length, ...(input ? { input: input.name } : {}) },
          });
          return { path, typed, input: input?.name ?? null };
        } catch (err) {
          return sandboxSaid(reply, err);
        }
      },
    );
  });
}
