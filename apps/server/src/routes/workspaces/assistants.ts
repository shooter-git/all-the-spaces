import type { Assistant } from '@ats/api-types';
import { schema } from '@ats/db';
import { PROVIDERS, type Provider, VENDOR_CLIS } from '@ats/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { architectGroups, notFound, requireUser } from '../../access.ts';
import { record } from '../../audit.ts';
import type { AppContext } from '../../context.ts';
import { sendError } from '../../reply.ts';
import type { Supervisor } from '../../studio/supervisor.ts';
import { Prov, type WorkspaceShared } from './shared.ts';

const { assistantConnections } = schema;

/** Connecting an Architect's own AI assistant: installing it, signing in, checking, signing out. */
export async function assistantRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { unavailable, failure }: WorkspaceShared,
) {
  const { db } = ctx;

  // ---- Assistants ---------------------------------------------------------------------------

  app.get('/api/studio/assistants', async (req, reply) => {
    const me = await requireUser(ctx, req, reply);
    if (!me) return;
    if (!(await architectGroups(db, me.id)).length) return notFound(reply);
    const rows = await db
      .select()
      .from(assistantConnections)
      .where(eq(assistantConnections.userId, me.id));
    // API-key mode (set up by whoever runs the server): those assistants need no sign-in.
    const keys: Partial<Record<Provider, boolean>> =
      (await ctx.supervisor
        ?.call<Partial<Record<Provider, boolean>>>('api-keys', {})
        .catch(() => ({}))) ?? {};
    return {
      available: Boolean(ctx.supervisor),
      assistants: PROVIDERS.map((p) => {
        const row = rows.find((r) => r.provider === p);
        return {
          provider: p,
          name: VENDOR_CLIS[p].name,
          vendor: VENDOR_CLIS[p].vendor,
          version: VENDOR_CLIS[p].version,
          installed: Boolean(row?.binarySha256),
          installedVersion: row?.version ?? null,
          signedIn: (row?.signedIn ?? false) || Boolean(keys[p]),
          apiKey: Boolean(keys[p]),
        } satisfies Assistant;
      }),
    };
  });

  const assistantAction = (
    path: string,
    run: (
      sup: Supervisor,
      me: { id: string },
      p: Provider,
      reply: FastifyReply,
    ) => Promise<unknown>,
  ) =>
    app.post<{ Params: { provider: string } }>(
      `/api/studio/assistants/:provider/${path}`,
      async (req, reply) => {
        const me = await requireUser(ctx, req, reply);
        if (!me) return;
        const p = Prov.safeParse(req.params.provider);
        if (!p.success || !(await architectGroups(db, me.id)).length) return notFound(reply);
        if (!ctx.supervisor) return unavailable(reply);
        try {
          return await run(ctx.supervisor, me, p.data, reply);
        } catch (err) {
          return failure(reply, err);
        }
      },
    );

  /** Opens the Architect's own connect container, where the installer and sign-in run. */
  assistantAction('open', async (sup, me, p) => {
    await sup.call('connect.start', { a: me.id, p });
    return { ok: true };
  });

  /** Runs the vendor's official installer at the version this release was tested with. */
  assistantAction('install', async (sup, me, p) => {
    const r = await sup.call<{ ok: boolean; log: string; sha: string | null; version: string }>(
      'connect.install',
      { a: me.id, p },
    );
    if (r.ok && r.sha) {
      await db
        .insert(assistantConnections)
        .values({
          userId: me.id,
          provider: p,
          version: VENDOR_CLIS[p].version,
          binarySha256: r.sha,
          installedAt: new Date(),
          checkedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [assistantConnections.userId, assistantConnections.provider],
          set: {
            version: VENDOR_CLIS[p].version,
            binarySha256: r.sha,
            installedAt: new Date(),
            checkedAt: new Date(),
          },
        });
      await record(db, {
        groupId: null,
        actorUserId: me.id,
        action: 'assistant.installed',
        target: p,
        metadata: {
          version: VENDOR_CLIS[p].version,
          sha256: r.sha,
        },
      });
    }
    return { ok: r.ok, version: r.version, log: r.log };
  });

  /** Starts the assistant's own sign-in flow in the terminal (the Architect completes it there). */
  assistantAction('sign-in', async (sup, me, p, reply) => {
    // Only the assistant as installed (C2): its program is checked again just before it starts,
    // since code in any of the Architect's sandboxes can write where it lives.
    const [row] = await db
      .select()
      .from(assistantConnections)
      .where(and(eq(assistantConnections.userId, me.id), eq(assistantConnections.provider, p)));
    if (!row?.binarySha256) return sendError(reply, 409, `Install ${VENDOR_CLIS[p].name} first.`);
    const r = await sup.call<{ ok: boolean; error?: string }>(
      'connect.launch',
      { a: me.id, p, sha: row.binarySha256 },
      { command: VENDOR_CLIS[p].signIn },
    );
    if (!r.ok && r.error === 'changed') {
      await record(db, {
        groupId: null,
        actorUserId: me.id,
        action: 'assistant.changed',
        target: p,
      });
      return sendError(
        reply,
        409,
        `${VENDOR_CLIS[p].name} has changed since you installed it, so it wasn't started. Reinstall it.`,
      );
    }
    if (!r.ok)
      return sendError(
        reply,
        409,
        `${VENDOR_CLIS[p].name} is already running in the terminal: finish signing in there, or press Ctrl+C twice and try again.`,
      );
    return { ok: true };
  });

  /** Whether it's installed and signed in (the sign-in itself is never read). */
  assistantAction('check', async (sup, me, p) => {
    const s = await sup.call<{ installed: boolean; sha: string | null; signedIn: boolean }>(
      'connect.status',
      { a: me.id, p },
    );
    const [row] = await db
      .select()
      .from(assistantConnections)
      .where(and(eq(assistantConnections.userId, me.id), eq(assistantConnections.provider, p)));
    if (row) {
      await db
        .update(assistantConnections)
        .set({ signedIn: s.signedIn, checkedAt: new Date() })
        .where(and(eq(assistantConnections.userId, me.id), eq(assistantConnections.provider, p)));
      if (s.signedIn && !row.signedIn)
        await record(db, {
          groupId: null,
          actorUserId: me.id,
          action: 'assistant.signed-in',
          target: p,
        });
    }
    return { installed: s.installed && s.sha === row?.binarySha256, signedIn: s.signedIn };
  });

  assistantAction('close', async (sup, me, p) => {
    await sup.call('connect.stop', { a: me.id, p });
    return { ok: true };
  });

  /** Signs the Architect out (deletes their sign-in); the installed program stays. */
  assistantAction('forget', async (sup, me, p) => {
    await sup.call('connect.forget', { a: me.id, p });
    await db
      .update(assistantConnections)
      .set({ signedIn: false })
      .where(and(eq(assistantConnections.userId, me.id), eq(assistantConnections.provider, p)));
    await record(db, {
      groupId: null,
      actorUserId: me.id,
      action: 'assistant.signed-out',
      target: p,
    });
    return { ok: true };
  });
}
