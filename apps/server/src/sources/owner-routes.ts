import type { Sent, ServerSourceHost, ServerSources } from '@ats/api-types';
import { schema } from '@ats/db';
import {
  BUILT_IN_GITHUB,
  SOURCE_PATTERN,
  type StudioSources,
  studioSourcesOf,
  uniquePatterns,
} from '@ats/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { record } from '../audit.ts';
import type { AppContext } from '../context.ts';
import { requireServerOwner } from '../owner.ts';
import { sendError } from '../reply.ts';
import { BUILT_IN_GITHUB_DEF, NO_SOURCE_HOSTS, studioSources } from './registry.ts';

const { groups, installState } = schema;

const MAX_PATTERNS = 100;

const Change = z.strictObject({
  hosts: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(32),
        on: z.boolean().optional(),
        repositories: z.array(z.string().max(210)).max(500),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * Where creations may come from, as the server's owner sees and changes it in the Studio (ADR
 * 0012): the built-in GitHub host (off until switched on) and repositories added to the hosts
 * in files. Only the owner, never a token, and nothing a file alone decides (tokens, addresses,
 * private networks). A change counts straight away.
 */
export async function sourceOwnerRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const files = () => (ctx.sourceHosts ?? NO_SOURCE_HOSTS).list().filter((h) => h.from === 'file');

  const builtIn = () => ctx.sourceHosts?.builtIn ?? BUILT_IN_GITHUB_DEF;

  const view = (studio: StudioSources): Sent<ServerSources> => ({
    hosts: [
      {
        id: BUILT_IN_GITHUB,
        displayName: builtIn().displayName,
        from: 'built-in',
        on: studio.github.on,
        address: new URL(builtIn().apiUrl).host,
        fileRepositories: [],
        token: false,
        repositories: studio.github.repositories,
      },
      ...files().map(
        (h): Sent<ServerSourceHost> => ({
          id: h.def.id,
          displayName: h.def.displayName,
          from: 'file',
          on: true,
          address: new URL(h.def.apiUrl).host,
          fileRepositories: h.def.repositories,
          token: Boolean(h.token),
          repositories: studio.added[h.def.id] ?? [],
        }),
      ),
    ],
  });

  app.get('/api/server/sources', async (req, reply) => {
    const me = await requireServerOwner(ctx, req, reply);
    if (!me) return;
    reply.header('cache-control', 'private, no-store');
    return view(await studioSources(db));
  });

  /** `{ hosts: [{ id, on?, repositories }] }`: only the hosts given change. */
  app.put('/api/server/sources', async (req, reply) => {
    const me = await requireServerOwner(ctx, req, reply);
    if (!me) return;
    const parsed = Change.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'Some details are missing or invalid.');
    const changes = parsed.data.hosts;
    if (new Set(changes.map((c) => c.id)).size !== changes.length)
      return sendError(reply, 400, 'Each host once, please.');
    const fileIds = new Set(files().map((h) => h.def.id));
    const lists = new Map<string, string[]>();
    for (const c of changes) {
      if (c.id !== BUILT_IN_GITHUB && !fileIds.has(c.id))
        return sendError(reply, 400, `This server has no repository host called "${c.id}".`);
      if (c.id !== BUILT_IN_GITHUB && c.on === false)
        return sendError(
          reply,
          400,
          'A host set up in a file is switched off by removing its file on the server.',
        );
      const list = c.repositories.map((p) => p.trim()).filter(Boolean);
      const wrong = list.find((p) => !SOURCE_PATTERN.test(p));
      if (wrong)
        return sendError(
          reply,
          400,
          `“${wrong.slice(0, 60)}” isn't a repository. Write owner/name, owner/* for all of an owner's, or * for any public one.`,
        );
      const unique = uniquePatterns(list);
      if (unique.length > MAX_PATTERNS)
        return sendError(reply, 400, `At most ${MAX_PATTERNS} for each host.`);
      lists.set(c.id, unique);
    }

    const saved = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ sources: installState.sources })
        .from(installState)
        .where(eq(installState.id, 1))
        .for('update');
      const next = studioSourcesOf(row?.sources);
      for (const c of changes) {
        const list = lists.get(c.id) ?? [];
        if (c.id === BUILT_IN_GITHUB)
          next.github = { on: c.on ?? next.github.on, repositories: list };
        else if (list.length) next.added[c.id] = list;
        else delete next.added[c.id];
      }
      await tx
        .update(installState)
        .set({ sources: next, updatedAt: new Date() })
        .where(eq(installState.id, 1));
      // Every group's Architects see it in Activity: it changes what they can do.
      const everyGroup = await tx.select({ id: groups.id }).from(groups);
      for (const g of everyGroup)
        await record(tx, {
          groupId: g.id,
          actorUserId: me.id,
          action: 'server.sources_changed',
          metadata: {
            hosts: changes.map((c) => ({
              id: c.id,
              ...(c.id === BUILT_IN_GITHUB ? { on: next.github.on } : {}),
              repositories: lists.get(c.id) ?? [],
            })),
          },
        });
      return next;
    });
    req.log.info(
      { hosts: changes.map((c) => c.id) },
      'repositories: the owner changed what creations may come from',
    );
    return view(saved);
  });
}
