import { schema } from '@ats/db';
import { asc, eq, isNull, lt, or } from 'drizzle-orm';
import { architectsOf } from '../commissions.ts';
import type { Log } from '../log.ts';
import type { Notifier } from '../notify.ts';
import { checkSource, type SourceDeps } from './service.ts';

const { creations, creationSources } = schema;

/** How often a followed repository is looked at, without anyone pressing anything. */
export const CHECK_EVERY_MS = 60 * 60_000;

/**
 * Looks at the followed repositories that are due (never looked at, or not for an hour), oldest
 * first and a few at a time, and tells the group's Architects when one has something newer than
 * what's built. It only notices: building it is Update's job (ADR 0011).
 */
export async function sourceCheckTick(
  deps: Pick<SourceDeps, 'db' | 'hosts' | 'release'>,
  notifier: Pick<Notifier, 'send'> | undefined,
  opts: { now?: Date; batch?: number } = {},
) {
  const now = opts.now ?? new Date();
  const due = await deps.db
    .select({ row: creationSources, title: creations.title, spaceId: creations.spaceId })
    .from(creationSources)
    .innerJoin(creations, eq(creations.id, creationSources.creationId))
    .where(
      or(
        isNull(creationSources.checkedAt),
        lt(creationSources.checkedAt, new Date(now.getTime() - CHECK_EVERY_MS)),
      ),
    )
    .orderBy(asc(creationSources.checkedAt))
    .limit(opts.batch ?? 20);
  for (const { row, title, spaceId } of due) {
    const after = await checkSource(deps, row);
    // Something new since the last look, and not what's built: once per new commit.
    if (
      notifier &&
      after.latestCommit &&
      after.latestCommit !== row.latestCommit &&
      after.latestCommit !== after.builtCommit
    ) {
      const what =
        after.latestLabel && after.follows === 'release' ? after.latestLabel : 'a new commit';
      await notifier.send(await architectsOf(deps.db, row.groupId), {
        kind: 'creation.source.newer',
        title: `${title}: ${what} in its repository`,
        body:
          after.behindBy && after.behindBy > 1
            ? `${after.behindBy} new commits. Update it in Creations when you're ready.`
            : "Update it in Creations when you're ready.",
        url: `/space/${spaceId}/creations`,
        groupId: row.groupId,
      });
    }
  }
  return due.length;
}

/** Runs the checks in the background: a first look a minute after starting, then every ten. */
export function startSourceChecks(
  deps: Pick<SourceDeps, 'db' | 'hosts' | 'release'>,
  notifier: Notifier | undefined,
  log: Log,
) {
  if (!deps.hosts.list().length) return () => {};
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    sourceCheckTick(deps, notifier)
      .catch((err: Error) => log.warn({ err: err.message }, 'repositories: the hourly look failed'))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, 10 * 60_000);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
