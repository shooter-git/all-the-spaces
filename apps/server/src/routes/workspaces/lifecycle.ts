import type {
  ChangedFiles,
  CheckResult,
  FileView,
  Sent,
  WorkspaceDetail,
  WorkspaceSummary,
} from '@ats/api-types';
import { schema } from '@ats/db';
import { type Check, scanForSecrets, snapshotOf } from '@ats/qa';
import { isEffort, MODEL_NAME, type Provider, unpackTar, VENDOR_CLIS } from '@ats/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isArchitect, notFound, requireUser } from '../../access.ts';
import { record } from '../../audit.ts';
import { moveCommission, OPEN } from '../../commissions.ts';
import type { AppContext } from '../../context.ts';
import { buildQueue } from '../../creations/builds.ts';
import { downloadSourceFiles, uploadSource } from '../../creations/sources.ts';
import { manifestOf } from '../../manifests.ts';
import { sendError } from '../../reply.ts';
import { getStorage } from '../../storage.ts';
import { viewablePath, viewOf } from '../../studio/file-view.ts';
import {
  instructionsFor,
  instructionsVars,
  newWorkspaceFiles,
  refreshedWorkspaceFiles,
  refreshInstructions,
  requestForWorkspace,
} from '../../studio/files.ts';
import { assistantChoice, settingsFor, startCommand } from '../../studio/settings.ts';
import type { Supervisor } from '../../studio/supervisor.ts';
import { SupervisorError } from '../../studio/supervisor.ts';
import { assistantActiveAt, sleepsAt } from '../../studio/timeouts.ts';
import { Prov, type WorkspaceShared } from './shared.ts';

const {
  assistantConnections,
  builds,
  commissions,
  creations,
  creationVersions,
  spaces,
  spaceVersions,
  workspaces,
} = schema;

/**
 * Blocked on purpose, and not worth a notice: Claude Code looks for the connectors on the
 * Architect's own claude.ai account each time it starts (their email, documents…). A workspace
 * runs AI-written code, so it never gets a way into them.
 */
const QUIET_HOSTS = new Set(['mcp-proxy.anthropic.com']);

/** Brings the platform's instructions in a workspace up to date (CLAUDE.md and AGENTS.md). */
async function refreshInstructionFiles(
  sup: Supervisor,
  ws: { id: string; kind: 'creation' | 'space'; title: string },
) {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const raw = await sup.raw('workspace.read', { ws: ws.id }, { path: name });
    const existing = raw ? raw.toString('utf8') : null;
    const vars = instructionsVars(existing);
    const fresh = await instructionsFor(ws.kind, vars.title ?? ws.title, vars.where);
    const next = refreshInstructions(existing, fresh);
    if (!next) continue;
    const write = (path: string, text: string) =>
      sup.call(
        'workspace.write',
        { ws: ws.id },
        { path, data: Buffer.from(text).toString('base64') },
      );
    // Kept aside once: a file from before the markers may hold notes worth keeping.
    if (next.previous) await write(`.ats/${name}.before-update`, next.previous);
    await write(name, next.text);
  }
}

/** A model and effort chosen for one workspace (null: the group's default). */
const Choice = z.object({
  model: z.string().trim().regex(MODEL_NAME).nullable().optional(),
  effort: z.string().max(16).nullable().optional(),
});
const chosen = (provider: Provider, c: z.infer<typeof Choice>) => ({
  model: c.model || null,
  effort: isEffort(provider, c.effort) ? (c.effort as string) : null,
});

/** How far back a workspace's page lists the sites its sandbox was stopped from reaching. */
const BLOCKED_WINDOW_MS = 15 * 60_000;
/** How long before a workspace goes to sleep its page warns the Architect. */
const SLEEP_WARNING_MS = 10 * 60_000;

/** Workspaces: making one, opening, stopping, typing, checking, publishing and deleting it. */
export async function lifecycleRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { unavailable, touch, failure, workspaceAction }: WorkspaceShared,
) {
  const { db, env } = ctx;

  // ---- Workspaces ---------------------------------------------------------------------------

  const spaceFor = async (userId: string, spaceId: string) => {
    if (!z.uuid().safeParse(spaceId).success) return null;
    const [row] = await db
      .select({ space: spaces, version: spaceVersions })
      .from(spaces)
      .innerJoin(spaceVersions, eq(spaceVersions.id, spaces.currentVersionId))
      .where(eq(spaces.id, spaceId));
    return row && (await isArchitect(db, userId, row.space.groupId)) ? row : null;
  };
  const objectLabel = (manifest: ReturnType<typeof manifestOf>, key: string | null) => {
    if (!key) return null;
    for (const r of manifest.rooms) {
      const o = r.objects.find((x) => x.key === key);
      if (o) return `${o.label.toLowerCase()} in the ${r.name.toLowerCase()}`;
    }
    return null;
  };

  app.get<{ Params: { spaceId: string } }>(
    '/api/spaces/:spaceId/workspaces',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const space = await spaceFor(me.id, req.params.spaceId);
      if (!space) return notFound(reply);
      const manifest = manifestOf(space.version);
      const rows = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.spaceId, space.space.id))
        .orderBy(desc(workspaces.createdAt));
      reply.header('cache-control', 'private, no-store');
      return {
        available: Boolean(ctx.supervisor),
        space: { id: space.space.id, name: space.space.name, groupId: space.space.groupId },
        workspaces: rows
          .filter((w) => w.status !== 'archived')
          .map((w) => ({
            id: w.id,
            title: w.title,
            provider: w.provider,
            status: w.status,
            mine: w.architectId === me.id,
            kind: w.kind,
            where: w.kind === 'space' ? null : objectLabel(manifest, w.objectKey),
            objectKey: w.objectKey,
            creationId: w.creationId,
            lastActivityAt: w.lastActivityAt,
            createdAt: w.createdAt,
          })) satisfies Sent<WorkspaceSummary>[],
        objects: manifest.rooms.flatMap((r) =>
          r.objects.map((o) => ({ key: o.key, label: o.label, room: r.name })),
        ),
      };
    },
  );

  app.post<{ Params: { spaceId: string } }>(
    '/api/spaces/:spaceId/workspaces',
    async (req, reply) => {
      const me = await requireUser(ctx, req, reply);
      if (!me) return;
      const space = await spaceFor(me.id, req.params.spaceId);
      if (!space) return notFound(reply);
      if (!ctx.supervisor) return unavailable(reply);
      const body = z
        .object({
          title: z.string().trim().min(1).max(80),
          brief: z.string().trim().min(1).max(10_000),
          objectKey: z.string().max(100).nullable().optional(),
          provider: Prov,
          /** Improve an existing creation (its live version's source). */
          creationId: z.uuid().optional(),
          /** Build what a member asked for (their words and pictures go in the workspace). */
          requestId: z.uuid().optional(),
        })
        .merge(Choice)
        .parse(req.body);
      const manifest = manifestOf(space.version);
      let objectKey = body.objectKey ?? null;
      let creationId = body.creationId;
      let request: typeof commissions.$inferSelect | null = null;
      if (body.requestId) {
        const [r] = await db
          .select()
          .from(commissions)
          .where(and(eq(commissions.id, body.requestId), eq(commissions.spaceId, space.space.id)));
        if (!r || !OPEN.includes(r.status)) return sendError(reply, 409, 'That request is closed.');
        const [existing] = r.workspaceId
          ? await db.select().from(workspaces).where(eq(workspaces.id, r.workspaceId))
          : [];
        if (existing && existing.status !== 'archived')
          return reply
            .code(409)
            .send({ error: 'It already has a workspace.', workspaceId: existing.id });
        request = r;
        if (r.kind === 'new') objectKey = objectLabel(manifest, r.objectKey) ? r.objectKey : null;
        else if (r.creationId) creationId = r.creationId;
        else return sendError(reply, 409, 'The creation it was about is gone.');
      }
      let basedOn: typeof creationVersions.$inferSelect | null = null;
      if (creationId) {
        const [c] = await db
          .select({ creation: creations, version: creationVersions })
          .from(creations)
          .innerJoin(creationVersions, eq(creationVersions.id, creations.currentVersionId))
          .where(and(eq(creations.id, creationId), eq(creations.spaceId, space.space.id)));
        if (!c?.version.sourceHash)
          return sendError(reply, 409, "That creation's source isn't available to improve.");
        basedOn = c.version;
        // On the shelf (its object is gone): it stays unplaced until an Architect places it.
        objectKey = objectLabel(manifest, c.creation.objectKey) ? c.creation.objectKey : null;
      }
      if (objectKey && !objectLabel(manifest, objectKey))
        return sendError(reply, 400, 'No such object.');
      const settings = await settingsFor(db, space.space.groupId);
      const where = objectLabel(manifest, objectKey) ?? 'not placed yet';
      const [ws] = await db
        .insert(workspaces)
        .values({
          groupId: space.space.groupId,
          spaceId: space.space.id,
          creationId: creationId ?? null,
          basedOnVersionId: basedOn?.id ?? null,
          objectKey,
          architectId: me.id,
          provider: body.provider,
          ...chosen(body.provider, body),
          title: body.title,
          brief: body.brief,
        })
        .returning();
      if (!ws) throw new Error('Workspace not created');
      try {
        const storage = await getStorage(ctx);
        const asked = request ? await requestForWorkspace(db, storage, request) : undefined;
        const files = basedOn?.sourceHash
          ? await refreshedWorkspaceFiles(
              await downloadSourceFiles(storage, space.space.groupId, basedOn.sourceHash),
              {
                title: body.title,
                brief: body.brief,
                where,
                telemetry: settings.telemetry,
                ...(asked ? { request: asked } : {}),
              },
            )
          : await newWorkspaceFiles({
              title: body.title,
              brief: body.brief,
              where,
              telemetry: settings.telemetry,
              ...(asked ? { request: asked } : {}),
            });
        const files64: Record<string, string> = {};
        for (const [path, data] of files) files64[path] = Buffer.from(data).toString('base64');
        const r = await ctx.supervisor.call<{ ok: boolean; error?: string }>(
          'workspace.init',
          { ws: ws.id },
          { files: files64 },
        );
        if (!r.ok) throw new SupervisorError(r.error ?? 'init failed', 500);
      } catch (err) {
        await db.delete(workspaces).where(eq(workspaces.id, ws.id));
        return failure(reply, err);
      }
      await record(db, {
        groupId: ws.groupId,
        actorUserId: me.id,
        action: 'workspace.created',
        target: ws.id,
        metadata: {
          provider: ws.provider,
          improving: creationId ?? null,
          request: request?.id ?? null,
        },
      });
      if (request)
        await moveCommission(db, ctx.notifier, request, 'in_progress', {
          actorId: me.id,
          set: { workspaceId: ws.id },
        });
      return { id: ws.id };
    },
  );

  workspaceAction('GET', '', async (ws, _me, sup) => {
    // A first publish creates the creation: remember it.
    let creationId = ws.creationId;
    let lastBuild: typeof builds.$inferSelect | null = null;
    if (ws.lastBuildId) {
      [lastBuild = null] = await db.select().from(builds).where(eq(builds.id, ws.lastBuildId));
      if (!creationId && lastBuild?.creationId) {
        creationId = lastBuild.creationId;
        await db.update(workspaces).set({ creationId }).where(eq(workspaces.id, ws.id));
      }
    }
    const sandbox = await sup.call<{ running: boolean }>('sandbox.status', { ws: ws.id });
    const blocked = sandbox.running
      ? (
          await sup.call<{ blocked: { at: string; host: string }[] }>(
            'egress.blocked',
            { ws: ws.id },
            { since: Date.now() - BLOCKED_WINDOW_MS },
          )
        ).blocked
      : [];
    const settings = await settingsFor(db, ws.groupId);
    // When it goes to sleep, for a warning shortly before: the assistant's work is only asked
    // about when it's close (it's a command run in the sandbox, and this is asked every few seconds).
    let sleep = sandbox.running && ws.status === 'running' ? sleepsAt(ws, settings) : null;
    if (sleep?.because === 'idle' && sleep.at - Date.now() < SLEEP_WARNING_MS)
      sleep = sleepsAt(ws, settings, await assistantActiveAt(sup, ws.id));
    const [request] = await db
      .select({ id: commissions.id, title: commissions.title, status: commissions.status })
      .from(commissions)
      .where(eq(commissions.workspaceId, ws.id));
    return {
      id: ws.id,
      title: ws.title,
      kind: ws.kind,
      request: request ?? null,
      brief: ws.brief,
      provider: ws.provider,
      assistant: VENDOR_CLIS[ws.provider].name,
      /** Chosen for this workspace (null: the group's default), and what it runs with now. */
      choice: { model: ws.model, effort: ws.effort },
      runsWith: assistantChoice(ws, settings),
      status: sandbox.running ? 'running' : ws.status === 'running' ? 'stopped' : ws.status,
      stoppedBecause: ws.stoppedBecause,
      creationId,
      spaceId: ws.spaceId,
      objectKey: ws.objectKey,
      startedAt: ws.startedAt,
      limits: { idleMinutes: settings.idleMinutes, sessionHours: settings.sessionHours },
      sleepsAt: sleep && new Date(sleep.at).toISOString(),
      lastBuild: lastBuild && {
        id: lastBuild.id,
        status: lastBuild.status,
        step: lastBuild.step,
        qa: lastBuild.qa,
        error: lastBuild.error,
        versionId: lastBuild.versionId,
      },
      blockedHosts: [...new Set(blocked.map((b) => b.host))].filter((h) => !QUIET_HOSTS.has(h)),
    } satisfies Sent<WorkspaceDetail>;
  });

  /**
   * What the assistant has made, changed or removed since the workspace started: names only,
   * never what's in them (an awake workspace; an asleep one lists nothing).
   */
  workspaceAction('GET', '/files', (ws, _me, sup) =>
    sup.call<ChangedFiles>('workspace.changes', { ws: ws.id }),
  );

  /**
   * One file's contents, for the Architect to look at: its text, or a picture. Read by a helper
   * that has only the workspace (never the assistant's sign-in, C4); nothing is kept.
   */
  workspaceAction('GET', '/files/view', async (ws, _me, sup, req, reply) => {
    const path = String((req.query as { path?: unknown }).path ?? '');
    if (!viewablePath(path)) return notFound(reply);
    let bytes: Buffer | null;
    try {
      bytes = await sup.raw('workspace.view', { ws: ws.id }, { path });
    } catch (err) {
      if (err instanceof SupervisorError && err.status === 413)
        return sendError(reply, 413, 'This file is too big to show here.');
      throw err;
    }
    if (!bytes) return sendError(reply, 404, "This file isn't in the workspace any more.");
    const view = viewOf(path, bytes);
    if (view === 'too-long')
      return sendError(reply, 413, 'This file is too long to show here (over 1 MB of text).');
    if (view === 'not-shown')
      return sendError(reply, 415, "This file isn't text or a picture, so it can't be shown here.");
    return view satisfies Sent<FileView>;
  });

  /** The checksum of the Architect's assistant as they installed it (C2), if they have. */
  const installedSha = async (userId: string, provider: Provider) => {
    const [conn] = await db
      .select()
      .from(assistantConnections)
      .where(
        and(eq(assistantConnections.userId, userId), eq(assistantConnections.provider, provider)),
      );
    return conn?.binarySha256 ?? null;
  };
  const connectFirst = (ws: { provider: Provider }, reply: FastifyReply) =>
    reply
      .code(409)
      .send({ error: `Connect ${VENDOR_CLIS[ws.provider].name} first.`, code: 'connect' });
  /** The assistant's program changed since it was installed, so it wasn't started (C2). */
  const changedSince = async (
    ws: { groupId: string; provider: Provider },
    me: { id: string },
    reply: FastifyReply,
  ) => {
    await record(db, {
      groupId: ws.groupId,
      actorUserId: me.id,
      action: 'assistant.changed',
      target: ws.provider,
    });
    return reply.code(409).send({
      error: `${VENDOR_CLIS[ws.provider].name} has changed since you installed it, so it wasn't started. Reinstall it from Assistants.`,
      code: 'changed',
    });
  };

  /** Wakes the workspace: its sandbox (with the Architect's assistant) and the live preview. */
  workspaceAction('POST', '/open', async (ws, me, sup, _req, reply) => {
    const sha = await installedSha(me.id, ws.provider);
    if (!sha) return connectFirst(ws, reply);
    const settings = await settingsFor(db, ws.groupId);
    const r = await sup.call<{ ok: boolean; error?: string }>('sandbox.start', {
      ws: ws.id,
      a: me.id,
      p: ws.provider,
      sha,
      env: settings.telemetry ? {} : { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' },
      // The whole public web (HTTPS) when the group allows it; otherwise the allow-list.
      net: settings.openInternet ? 'open' : 'limited',
    });
    if (!r.ok && r.error === 'changed') return changedSince(ws, me, reply);
    // The platform's instructions as they are now (new tools, new guidance): notes the assistant
    // or the Architect keep outside them stay. A workspace that can't be updated still opens.
    if (r.ok)
      await refreshInstructionFiles(sup, ws).catch((err) =>
        app.log.warn({ err, ws: ws.id }, "Couldn't bring the workspace's instructions up to date"),
      );
    // A creation's live preview; a place's preview is its plan overlay, drawn by `ats space`.
    if (ws.kind === 'creation') await sup.call('preview.start', { ws: ws.id });
    const now = new Date();
    await db
      .update(workspaces)
      .set({ status: 'running', startedAt: now, lastActivityAt: now, stoppedBecause: null })
      .where(eq(workspaces.id, ws.id));
    await record(db, {
      groupId: ws.groupId,
      actorUserId: me.id,
      action: 'workspace.opened',
      target: ws.id,
    });
    return { ok: true };
  });

  /**
   * The Architect is here: their workspace's page is open and in use (its page says so every
   * minute), or they asked it to stay awake. Keeps it from going to sleep under them.
   */
  workspaceAction('POST', '/here', async (ws) => {
    if (ws.status === 'running') await touch(ws.id);
    return { ok: true };
  });

  workspaceAction('POST', '/stop', async (ws, me, sup) => {
    await sup.call('sandbox.stop', { ws: ws.id });
    await sup.call('preview.stop', { ws: ws.id });
    await db
      .update(workspaces)
      .set({ status: 'stopped', stoppedBecause: 'you' })
      .where(eq(workspaces.id, ws.id));
    await record(db, {
      groupId: ws.groupId,
      actorUserId: me.id,
      action: 'workspace.stopped',
      target: ws.id,
    });
    return { ok: true };
  });

  /**
   * Types into the workspace's terminal. Starting the assistant or carrying on is typed and run,
   * only when the terminal is at a shell prompt; a suggested prompt is only ever typed, never
   * sent — the Architect presses Enter (C9).
   */
  /** Changes this workspace's model or effort (from the next time the assistant starts). */
  workspaceAction('POST', '/assistant', async (ws, me, _sup, req) => {
    const body = Choice.parse(req.body ?? {});
    const next = chosen(ws.provider, body);
    await db.update(workspaces).set(next).where(eq(workspaces.id, ws.id));
    await record(db, {
      groupId: ws.groupId,
      actorUserId: me.id,
      action: 'workspace.assistant',
      target: ws.id,
      metadata: next,
    });
    return {
      ok: true,
      runsWith: assistantChoice({ ...ws, ...next }, await settingsFor(db, ws.groupId)),
    };
  });

  workspaceAction('POST', '/type', async (ws, me, sup, req, reply) => {
    const body = z
      .object({
        what: z.enum(['start', 'resume', 'prompt']),
        text: z.string().max(4000).optional(),
      })
      .parse(req.body);
    const settings = await settingsFor(db, ws.groupId);
    const command = startCommand(ws, settings, body.what === 'resume' ? 'resume' : 'start');
    // A prompt is only typed: the Architect sends it. The assistant is started as the
    // terminal's program, never typed, so it can't reach a running assistant as a message (C9),
    // and only as installed (C2): the supervisor checks its program first.
    let r: { ok: boolean; error?: string };
    if (body.what === 'prompt')
      r = await sup.call('sandbox.type', { ws: ws.id }, { text: body.text ?? '' });
    else {
      const sha = await installedSha(me.id, ws.provider);
      if (!sha) return connectFirst(ws, reply);
      r = await sup.call('sandbox.launch', { ws: ws.id, p: ws.provider, sha }, { command });
    }
    await touch(ws.id);
    if (!r.ok && r.error === 'changed') return changedSince(ws, me, reply);
    if (!r.ok)
      return reply.code(409).send({
        error: `${VENDOR_CLIS[ws.provider].name} is already running in the terminal.`,
        code: 'busy',
      });
    return { ok: true };
  });

  /**
   * Runs the checks in the workspace (what `ats qa` does) and returns what they found. Run
   * directly, not typed into the terminal: typing there could reach the assistant as a message.
   */
  workspaceAction('POST', '/check', async (ws, _me, sup, _req, reply) => {
    await touch(ws.id);
    if (ws.kind === 'space') {
      const r = await sup.call<{ code: number; output: string }>(
        'sandbox.run',
        { ws: ws.id },
        { what: 'space-check' },
      );
      const problems = r.output
        .split(/\n(?=FIX |note )/)
        .map((block) => block.trim())
        .filter((b) => b.startsWith('FIX ') || b.startsWith('note '))
        .map((b) => {
          const [first = '', fix] = b.split(/\n\s*→ /);
          return {
            status: first.startsWith('FIX') ? ('fail' as const) : ('warn' as const),
            title: first.replace(/^(FIX|note)\s+/, ''),
            where: null,
            fix: fix ?? null,
          };
        });
      return { ok: r.code === 0, problems, passed: 0 } satisfies CheckResult;
    }
    const r = await sup.call<{
      ok: boolean;
      report?: {
        ok: boolean;
        checks: Pick<Check, 'status' | 'title' | 'detail' | 'fix' | 'where'>[];
      };
      error?: string;
    }>('sandbox.check', { ws: ws.id });
    if (!r.ok || !r.report)
      return reply
        .code(422)
        .send({ error: "The checks couldn't run.", log: r.error?.slice(-2000) });
    return {
      ok: r.report.ok,
      problems: r.report.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => ({
          status: c.status as Exclude<Check['status'], 'pass'>,
          title: c.title,
          where: c.where ?? null,
          fix: c.fix ?? null,
        })),
      passed: r.report.checks.filter((c) => c.status === 'pass').length,
    } satisfies CheckResult;
  });

  /**
   * Publishes (or keeps as a candidate) what's in the workspace now. The source is taken from
   * the workspace by the supervisor, checked for secrets before it's stored, and built cleanly by
   * the platform — nothing the sandbox built is trusted.
   */
  workspaceAction('POST', '/publish', async (ws, me, sup, req, reply) => {
    const body = z.object({ live: z.boolean().default(false) }).parse(req.body ?? {});
    if (ws.kind !== 'creation')
      return sendError(
        reply,
        409,
        'A place is built and reviewed, then published from its review.',
      );
    const settings = await settingsFor(db, ws.groupId);
    const tar = await sup.raw('workspace.archive', { ws: ws.id });
    if (!tar) return sendError(reply, 409, "The workspace couldn't be read.");
    const { snapshot, contents } = snapshotOf(unpackTar(tar));
    const secrets = scanForSecrets(contents);
    if (secrets.length)
      return reply.code(422).send({
        error: 'The workspace contains things that look like secrets, so nothing was stored.',
        secrets: secrets.slice(0, 10),
      });
    await uploadSource(await getStorage(ctx), ws.groupId, snapshot, contents);
    const [build] = await db
      .insert(builds)
      .values({
        groupId: ws.groupId,
        spaceId: ws.spaceId,
        creationId: ws.creationId,
        objectKey: ws.objectKey,
        workspaceId: ws.id,
        publish: body.live && !settings.requireDeviceTest,
        sourceHash: snapshot.hash,
        requestedBy: me.id,
      })
      .returning();
    if (!build) throw new Error('Build not created');
    ctx.buildQueue ??= buildQueue(env.VALKEY_URL);
    await ctx.buildQueue.add(
      'build',
      { buildId: build.id },
      { jobId: build.id, removeOnComplete: 200, removeOnFail: 200 },
    );
    await db.update(workspaces).set({ lastBuildId: build.id }).where(eq(workspaces.id, ws.id));
    // A creation changed in the Studio no longer follows a repository (ADR 0011): one source of
    // truth, so a later Update can't undo what was published here.
    if (ws.creationId)
      await db
        .delete(schema.creationSources)
        .where(eq(schema.creationSources.creationId, ws.creationId));
    await record(db, {
      groupId: ws.groupId,
      actorUserId: me.id,
      action: 'workspace.published',
      target: ws.id,
      metadata: {
        build: build.id,
        live: build.publish,
      },
    });
    return { buildId: build.id, live: build.publish };
  });

  workspaceAction('DELETE', '', async (ws, me, sup) => {
    await sup.call('workspace.delete', { ws: ws.id });
    await db.update(workspaces).set({ status: 'archived' }).where(eq(workspaces.id, ws.id));
    await record(db, {
      groupId: ws.groupId,
      actorUserId: me.id,
      action: 'workspace.deleted',
      target: ws.id,
    });
    return { ok: true };
  });
}
