import { type Db, schema } from '@ats/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Notice, Notifier } from './notify.ts';

const { builds, commissionEvents, commissions, creationVersions, memberships, spaces } = schema;

type Commission = typeof commissions.$inferSelect;
type CommissionStatus = schema.CommissionStatus;

/** Still being looked after (not yet finished, declined or withdrawn). */
export const OPEN: CommissionStatus[] = [
  'submitted',
  'accepted',
  'in_progress',
  'qa_failed',
  'ready',
];

/** In plain words, for members and Architects alike. */
export const STATUS_WORDS: Record<CommissionStatus, string> = {
  submitted: 'Sent to the Architects',
  accepted: 'Accepted',
  in_progress: 'Being built',
  qa_failed: 'Being built',
  ready: 'Nearly ready',
  published: 'Ready to try',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

/** In a request's timeline (a build that didn't pass isn't news, just more work). */
export const EVENT_WORDS: Partial<Record<CommissionStatus, string>> = {
  qa_failed: 'Still being worked on',
};

export async function architectsOf(db: Db, groupId: string) {
  const rows = await db
    .select({ id: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.organizationId, groupId), eq(memberships.role, 'architect')));
  return rows.map((r) => r.id);
}

/** Where a request leads: members to their own list, Architects to the Studio queue. */
export const requestUrl = (c: Commission, forArchitect: boolean) =>
  forArchitect ? `/space/${c.spaceId}/requests/${c.id}` : `/requests/${c.id}`;

/**
 * Moves a request on, records it in its timeline, and tells whoever it concerns: the member
 * when an Architect acts on it, the Architects when the member does.
 */
export async function moveCommission(
  db: Db,
  notifier: Notifier | undefined,
  c: Commission,
  status: CommissionStatus,
  opts: { actorId?: string | null; note?: string | null; set?: Partial<Commission> } = {},
) {
  const closed = !OPEN.includes(status);
  // The new status and its timeline entry are written together; people are told once both are.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(commissions)
      .set({
        ...opts.set,
        status,
        updatedAt: new Date(),
        closedAt: closed ? new Date() : null,
      })
      .where(eq(commissions.id, c.id))
      .returning();
    await tx.insert(commissionEvents).values({
      commissionId: c.id,
      actorId: opts.actorId ?? null,
      status,
      note: opts.note ?? null,
    });
    return row;
  });
  const next = updated ?? c;
  if (!notifier) return next;
  const toMember = MEMBER_NOTICES[status]?.(next, opts.note ?? null);
  if (toMember && next.requesterId && next.requesterId !== opts.actorId) {
    await notifier.send([next.requesterId], {
      ...toMember,
      groupId: next.groupId,
      url: toMember.url ?? requestUrl(next, false),
    });
  }
  if (status === 'withdrawn' && c.status !== 'submitted') {
    const architects = (await architectsOf(db, next.groupId)).filter((id) => id !== opts.actorId);
    await notifier.send(architects, {
      kind: 'request.withdrawn',
      title: `Withdrawn: ${next.title}`,
      body: 'The person who asked for it no longer needs it.',
      url: requestUrl(next, true),
      groupId: next.groupId,
    });
  }
  return next;
}

const MEMBER_NOTICES: Partial<
  Record<CommissionStatus, (c: Commission, note: string | null) => Omit<Notice, 'groupId'>>
> = {
  accepted: (c, note) => ({
    kind: 'request.accepted',
    title: `Accepted: ${c.title}`,
    body: note ?? 'An Architect will build it. You can follow it in My requests.',
  }),
  in_progress: (c, note) => ({
    kind: 'request.started',
    title: `Being built: ${c.title}`,
    body: note ?? 'An Architect has started building it.',
  }),
  declined: (c, note) => ({
    kind: 'request.declined',
    title: `Not this time: ${c.title}`,
    body: note ?? 'An Architect decided not to build it.',
  }),
  published: (c) => ({
    kind: 'request.published',
    title: `Ready to try: ${c.title}`,
    body:
      c.kind === 'new'
        ? c.objectLabel
          ? `Go to the ${c.objectLabel.toLowerCase()} to try it.`
          : 'Go and try it.'
        : 'The new version is live.',
    url: `/space/${c.spaceId}${c.objectKey ? `?object=${encodeURIComponent(c.objectKey)}` : ''}`,
  }),
};

/** Tells the group's Architects about a new request. */
export async function announceCommission(db: Db, notifier: Notifier | undefined, c: Commission) {
  if (!notifier) return;
  const [space] = await db
    .select({ name: spaces.name })
    .from(spaces)
    .where(eq(spaces.id, c.spaceId));
  const architects = (await architectsOf(db, c.groupId)).filter((id) => id !== c.requesterId);
  const what =
    c.kind === 'bug'
      ? 'Problem reported'
      : c.kind === 'improve'
        ? 'Change asked for'
        : 'New request';
  await notifier.send(architects, {
    kind: 'request.new',
    title: `${what}: ${c.title}`,
    body: `${space?.name ?? 'A space'}${c.objectLabel ? ` · ${c.objectLabel}` : ''}`,
    url: requestUrl(c, true),
    groupId: c.groupId,
  });
}

/**
 * Where a request goes once what was built for it is live: ready to try — unless it asked for a
 * new object, which people can only reach once an Architect has put it in the space (until then
 * it's on the unplaced shelf, for Architects only).
 */
const whenLive = (c: Commission) =>
  c.kind === 'new' && !c.objectKey
    ? ({
        status: 'ready',
        note: 'Built. It appears once an Architect gives it a place in the space.',
      } as const)
    : ({ status: 'published', note: null } as const);

/** The open request a workspace was started for, if any. */
async function commissionOfWorkspace(db: Db, workspaceId: string | null) {
  if (!workspaceId) return null;
  const [c] = await db
    .select()
    .from(commissions)
    .where(and(eq(commissions.workspaceId, workspaceId), inArray(commissions.status, OPEN)));
  return c ?? null;
}

/**
 * A build from a request's workspace finished: the request follows it. Didn't pass its checks:
 * still being built (the Architect's assistant fixes it). Passed: nearly ready (an Architect
 * tries it before it goes live). Went live: ready to try.
 */
export async function afterBuild(db: Db, notifier: Notifier | undefined, buildId: string) {
  const [build] = await db.select().from(builds).where(eq(builds.id, buildId));
  if (!build) return;
  const c = await commissionOfWorkspace(db, build.workspaceId);
  if (!c) return;
  const set = build.creationId ? { creationId: build.creationId } : {};
  if (build.status === 'failed' && c.status !== 'qa_failed')
    await moveCommission(db, notifier, c, 'qa_failed', { set });
  else if (build.status === 'passed' && c.status !== 'ready')
    await moveCommission(db, notifier, c, 'ready', { set });
  else if (build.status === 'published') {
    const { status, note } = whenLive(c);
    await moveCommission(db, notifier, c, status, { set, note });
  }
}

/**
 * A creation built for a new object was given its place in the space: the request it was built
 * for is done, and the person who asked can go to it.
 */
export async function afterPlaced(
  db: Db,
  notifier: Notifier | undefined,
  creationId: string,
  objectKey: string,
  objectLabel: string | null,
) {
  const rows = await db
    .select()
    .from(commissions)
    .where(and(eq(commissions.creationId, creationId), eq(commissions.status, 'ready')));
  for (const c of rows) {
    if (c.kind !== 'new' || c.objectKey) continue;
    await moveCommission(db, notifier, c, 'published', { set: { objectKey, objectLabel } });
  }
}

/** A version went live (from the Studio): the request it was built for is done. */
export async function afterLive(db: Db, notifier: Notifier | undefined, versionId: string) {
  const [row] = await db
    .select({ workspaceId: builds.workspaceId, creationId: builds.creationId })
    .from(creationVersions)
    .innerJoin(builds, eq(builds.id, creationVersions.buildId))
    .where(eq(creationVersions.id, versionId));
  const c = await commissionOfWorkspace(db, row?.workspaceId ?? null);
  if (!c) return;
  const { status, note } = whenLive(c);
  await moveCommission(db, notifier, c, status, {
    note,
    set: row?.creationId ? { creationId: row.creationId } : {},
  });
}
