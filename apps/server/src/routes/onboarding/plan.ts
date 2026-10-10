import { createHash } from 'node:crypto';
import type { PlanProblem } from '@ats/api-types';
import { schema } from '@ats/db';
import { isEffort, MODEL_NAME } from '@ats/shared';
import { checkPlan } from '@ats/space-format';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, requireUser } from '../../access.ts';
import { record } from '../../audit.ts';
import type { AppContext } from '../../context.ts';
import { loadSources, sourcesInWorkspaces } from '../../place-sources.ts';
import { sendError } from '../../reply.ts';
import { getStorage } from '../../storage.ts';
import { spaceWorkspaceFiles } from '../../studio/files.ts';
import { settingsFor } from '../../studio/settings.ts';
import { inputKey, type OnboardingShared } from './shared.ts';

const { spaceInputs, spaceVersions, workspaces } = schema;

/** The space workspace, where the assistant writes the plan, and the plan editor's saves. */
export async function planRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { ownSpace, spaceWorkspace }: OnboardingShared,
) {
  const { db } = ctx;

  // ---- The space workspace ----------------------------------------------------------------------

  app.post<{ Params: { spaceId: string } }>(
    '/api/spaces/:spaceId/workspace',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const space = await ownSpace(me.id, req.params.spaceId);
      if (!space) return notFound(reply);
      if (!ctx.supervisor)
        return sendError(reply, 503, "The Studio isn't set up on this server yet.");
      const body = z
        .object({
          provider: z.enum(['claude', 'codex']),
          description: z.string().max(10_000).default(''),
          /** This workspace's model and effort (empty: the group's default). */
          model: z.string().trim().regex(MODEL_NAME).nullable().optional(),
          effort: z.string().max(16).nullable().optional(),
        })
        .parse(req.body);
      const inputs = await db.select().from(spaceInputs).where(eq(spaceInputs.spaceId, space.id));
      const [live] = space.currentVersionId
        ? await db.select().from(spaceVersions).where(eq(spaceVersions.id, space.currentVersionId))
        : [];
      const storage = await getStorage(ctx);
      /** Changing a live place: its own models, to start from with its plan. */
      let sources = new Map<string, Uint8Array>();
      if (live) {
        // Changing a live place: carry on with a change already under way (made since this
        // version went live, or was gone back to), or start a fresh workspace from its plan.
        const open = await db
          .select()
          .from(workspaces)
          .where(
            and(
              eq(workspaces.spaceId, space.id),
              eq(workspaces.kind, 'space'),
              ne(workspaces.status, 'archived'),
            ),
          );
        const since = space.liveSince ?? live.publishedAt ?? live.createdAt;
        const current = open.find((w) => w.createdAt > since);
        if (current) {
          if (current.architectId !== me.id)
            return sendError(reply, 409, 'Another Architect is changing this place.');
          return { id: current.id, reopened: true };
        }
        // A version from before they were kept: its models from the workspace that built it,
        // before that goes.
        sources = live.sources
          ? await loadSources(storage, space.id, live.sources)
          : await sourcesInWorkspaces(
              ctx.supervisor,
              open.map((w) => w.id),
              live.plan,
            );
        for (const w of open)
          await ctx.supervisor.call('workspace.delete', { ws: w.id }).catch(() => {});
        if (open.length)
          await db
            .update(workspaces)
            .set({ status: 'archived' })
            .where(
              inArray(
                workspaces.id,
                open.map((w) => w.id),
              ),
            );
      } else if (!inputs.some((i) => i.kind === 'plan'))
        return sendError(reply, 409, 'Add at least one floor plan first.');
      const settings = await settingsFor(db, space.groupId);
      const files = await spaceWorkspaceFiles({
        name: space.name,
        spaceType: space.spaceType,
        description: body.description,
        inputs: await Promise.all(
          inputs
            .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
            .map(async (i) => ({
              name: i.name,
              kind: i.kind,
              note: i.note,
              data: await storage.getBytes(inputKey(space.id, i.name)),
            })),
        ),
        telemetry: settings.telemetry,
        ...(live ? { current: { plan: live.plan, version: live.number } } : {}),
      });
      for (const [path, data] of sources) files.set(path, data);
      const [ws] = await db
        .insert(workspaces)
        .values({
          groupId: space.groupId,
          spaceId: space.id,
          kind: 'space',
          architectId: me.id,
          provider: body.provider,
          model: body.model || null,
          effort: isEffort(body.provider, body.effort) ? (body.effort as string) : null,
          title: space.name,
          brief: body.description || `${space.name}, from its floor plan.`,
        })
        .returning();
      if (!ws) throw new Error('Workspace not created');
      const files64: Record<string, string> = {};
      for (const [path, data] of files) files64[path] = Buffer.from(data).toString('base64');
      const r = await ctx.supervisor.call<{ ok: boolean; error?: string }>(
        'workspace.init',
        { ws: ws.id },
        { files: files64 },
      );
      if (!r.ok) {
        await db.delete(workspaces).where(eq(workspaces.id, ws.id));
        return sendError(reply, 502, `The workspace couldn't be prepared: ${r.error ?? ''}`);
      }
      await record(db, {
        groupId: space.groupId,
        actorUserId: me.id,
        action: 'workspace.created',
        target: ws.id,
        metadata: {
          kind: 'space',
          inputs: inputs.length,
        },
      });
      return { id: ws.id };
    },
  );

  /**
   * The plan, its calibration and its overlay, as the assistant left them. The Studio looks every
   * few seconds: `?ifexists=1` answers "not yet" (204) rather than 404, and an unchanged file is
   * a 304 (by its ETag), so nothing is downloaded again until the assistant redraws it.
   */
  app.get<{ Params: { id: string; '*': string }; Querystring: { ifexists?: string } }>(
    '/api/workspaces/:id/files/*',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const ws = await spaceWorkspace(me.id, req.params.id);
      const path = req.params['*'];
      if (
        !ws ||
        !ctx.supervisor ||
        !/^(plan\.json|trace\.json|preview\/[\w.-]{1,64}\.png)$/.test(path)
      )
        return notFound(reply);
      const bytes = await ctx.supervisor.raw('workspace.read', { ws: ws.id }, { path });
      if (!bytes) return req.query.ifexists === '1' ? reply.code(204).send() : notFound(reply);
      const etag = `"${createHash('sha1').update(bytes).digest('base64url')}"`;
      reply.header('etag', etag).header('cache-control', 'private, no-cache');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      return reply
        .header('content-type', path.endsWith('.png') ? 'image/png' : 'application/json')
        .send(bytes);
    },
  );

  /** The Studio's plan editor saves here: the plan is checked, written, and redrawn. */
  app.put<{ Params: { id: string } }>('/api/workspaces/:id/plan', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const ws = await spaceWorkspace(me.id, req.params.id);
    if (!ws || !ctx.supervisor) return notFound(reply);
    const { plan, problems } = checkPlan((req.body as { plan?: unknown })?.plan);
    if (!plan) return reply.code(422).send({ error: "That plan isn't valid.", problems });
    const data = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`).toString('base64');
    const r = await ctx.supervisor.call<{ ok: boolean }>(
      'workspace.write',
      { ws: ws.id },
      { path: 'plan.json', data },
    );
    if (!r.ok) return sendError(reply, 502, "The plan couldn't be saved.");
    const running = await ctx.supervisor.call<{ running: boolean }>('sandbox.status', {
      ws: ws.id,
    });
    if (running.running)
      await ctx.supervisor
        .call('sandbox.run', { ws: ws.id }, { what: 'space-overlay' })
        .catch(() => {});
    await db.update(workspaces).set({ lastActivityAt: new Date() }).where(eq(workspaces.id, ws.id));
    return { ok: true, problems: problems satisfies PlanProblem[] };
  });

  /** Redraws the overlay (after the assistant or the Architect changed the plan). */
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/overlay', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    const ws = await spaceWorkspace(me.id, req.params.id);
    if (!ws || !ctx.supervisor) return notFound(reply);
    return ctx.supervisor.call('sandbox.run', { ws: ws.id }, { what: 'space-overlay' });
  });
}
