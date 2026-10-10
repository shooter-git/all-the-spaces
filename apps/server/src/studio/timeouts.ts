import { type Db, schema } from '@ats/db';
import { and, eq } from 'drizzle-orm';
import { record } from '../audit.ts';
import type { Log } from '../log.ts';
import { type StudioSettingsRow, settingsForGroups } from './settings.ts';
import type { Supervisor } from './supervisor.ts';

const { workspaces } = schema;

/**
 * How long after the Architect was last at a workspace (typing, or its page open and in use) they
 * count as away. While they're here, the time limit never cuts their work short.
 */
export const AWAY_MS = 15 * 60_000;

/**
 * When a running workspace goes to sleep as things stand, and why: once it's been quiet for the
 * group's idle time (the Architect not here, and the assistant not printing anything either: it's
 * at work), or once it's past the group's time limit and the Architect has stepped away (an
 * assistant left on its own gets no more than that). `assistantAt` is when the assistant last
 * printed, in milliseconds, if it's known.
 */
export function sleepsAt(
  ws: { startedAt: Date | null; lastActivityAt: Date | null },
  s: Pick<StudioSettingsRow, 'idleMinutes' | 'sessionHours'>,
  assistantAt: number | null = null,
) {
  const here = ws.lastActivityAt?.getTime() ?? 0;
  const quiet = Math.max(here, assistantAt ?? 0) + s.idleMinutes * 60_000;
  const limit = Math.max(
    (ws.startedAt?.getTime() ?? 0) + s.sessionHours * 3600_000,
    here + AWAY_MS,
  );
  return limit < quiet
    ? { at: limit, because: 'time-limit' as const }
    : { at: quiet, because: 'idle' as const };
}

/** When the assistant in a workspace last printed anything, in milliseconds (null: unknown). */
export async function assistantActiveAt(sup: Supervisor, ws: string) {
  const { at } = await sup
    .call<{ at: number | null }>('sandbox.activity', { ws })
    .catch(() => ({ at: null }));
  return at ? at * 1000 : null;
}

/**
 * Puts workspaces to sleep when they've been quiet for a while, or after the group's time limit
 * once the Architect has stepped away (see `sleepsAt`), and closes forgotten connect containers and
 * abandoned lighting bakes. Files always stay; opening a workspace again wakes it.
 */
export function startStudioTimers(db: Db, sup: Supervisor, log: Log, everyMs = 60_000) {
  const timer = setInterval(() => {
    studioTick(db, sup).catch((err) =>
      log.warn({ err: (err as Error).message }, 'studio timers failed'),
    );
  }, everyMs);
  return () => clearInterval(timer);
}

/**
 * A lighting bake's or a check step's container this old belongs to a build that stopped (the
 * server restarted mid-build): each room or step gets a fresh one, stopped after 30 minutes at
 * most.
 */
const ABANDONED_JOB_S = 2 * 3600;

/** One round of putting sleepy workspaces to sleep and closing forgotten connect containers. */
export async function studioTick(db: Db, sup: Supervisor) {
  {
    const running = await db.select().from(workspaces).where(eq(workspaces.status, 'running'));
    const settings = await settingsForGroups(db, [...new Set(running.map((ws) => ws.groupId))]);
    for (const ws of running) {
      const s = settings.get(ws.groupId) as StudioSettingsRow;
      let sleep = sleepsAt(ws, s);
      if (sleep.at > Date.now()) continue;
      // The Architect isn't here: is the assistant still at work (its terminal printing)? Its
      // work keeps the workspace from going idle, never past the time limit.
      if (sleep.because === 'idle') sleep = sleepsAt(ws, s, await assistantActiveAt(sup, ws.id));
      if (sleep.at > Date.now()) continue;
      await sup.call('sandbox.stop', { ws: ws.id }).catch(() => {});
      await sup.call('preview.stop', { ws: ws.id }).catch(() => {});
      const { because } = sleep;
      await db
        .update(workspaces)
        .set({ status: 'stopped', stoppedBecause: because })
        .where(and(eq(workspaces.id, ws.id), eq(workspaces.status, 'running')));
      await record(db, {
        groupId: ws.groupId,
        actorUserId: null,
        action: 'workspace.slept',
        target: ws.id,
        metadata: { because },
      });
    }
    const { containers } = await sup.call<{
      containers: { Names: string[]; Labels: Record<string, string>; Created?: number }[];
    }>('containers.list', {});
    /** Bake jobs cleared this round (one job can have a container in each of several slots). */
    const cleared = new Set<string>();
    for (const c of containers) {
      const role = c.Labels['io.allthespaces.role'];
      const abandoned = c.Created && Date.now() / 1000 - c.Created > ABANDONED_JOB_S;
      if (role === 'bake' && abandoned) {
        const [, job] = /-bake-(bake-[A-Za-z0-9-]+?)-run(?:-\d+)?$/.exec(c.Names[0] ?? '') ?? [];
        if (job && !cleared.has(job)) {
          cleared.add(job);
          await sup.call('bake.delete', { ws: job }).catch(() => {});
        }
        continue;
      }
      if (role?.startsWith('step-') && abandoned) {
        const [, job] = /-step-([A-Za-z0-9_-]+)-(?:prepare|finish)$/.exec(c.Names[0] ?? '') ?? [];
        if (job) await sup.call('job.delete', { ws: job }).catch(() => {});
        continue;
      }
      if (role !== 'connect' || !c.Created) continue;
      if (Date.now() / 1000 - c.Created < 3600) continue;
      const [, a, p] = /-connect-([A-Za-z0-9_-]+)-(claude|codex)$/.exec(c.Names[0] ?? '') ?? [];
      if (a && p) await sup.call('connect.stop', { a, p }).catch(() => {});
    }
  }
}
