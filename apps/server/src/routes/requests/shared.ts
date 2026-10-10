import type { RequestSummary, Sent } from '@ats/api-types';
import { schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { isArchitect } from '../../access.ts';
import { OPEN, STATUS_WORDS } from '../../commissions.ts';
import type { AppContext } from '../../context.ts';
import { manifestOf } from '../../manifests.ts';
import { membershipsFor } from '../../session.ts';

const { commissions, spaces, spaceVersions } = schema;

type Commission = typeof commissions.$inferSelect;

export const NO_SUCH_REQUEST = 'That request does not exist.';

/** What the request routes share, made once per app by `requestRoutes`. */
export function requestShared(ctx: AppContext) {
  const { db } = ctx;
  const limited = { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } };

  /** The space (live version) and this person's place in its group. */
  const spaceFor = async (userId: string, spaceId: string) => {
    if (!z.uuid().safeParse(spaceId).success) return null;
    const [row] = await db
      .select({ space: spaces, version: spaceVersions })
      .from(spaces)
      .innerJoin(spaceVersions, eq(spaceVersions.id, spaces.currentVersionId))
      .where(eq(spaces.id, spaceId));
    if (row?.space.status !== 'ready') return null;
    const role = (await membershipsFor(db, userId)).find(
      (m) => m.groupId === row.space.groupId,
    )?.role;
    if (!role) return null;
    return { ...row, isArchitect: role === 'architect', manifest: manifestOf(row.version) };
  };

  /** A request this person may see: their own, or any in a group they're an Architect of. */
  const requestFor = async (userId: string, id: string) => {
    if (!z.uuid().safeParse(id).success) return null;
    const [c] = await db.select().from(commissions).where(eq(commissions.id, id));
    if (!c) return null;
    const architect = await isArchitect(db, userId, c.groupId);
    if (!architect && c.requesterId !== userId) return null;
    return { c, isArchitect: architect, mine: c.requesterId === userId };
  };

  const summary = (
    c: Commission,
    extra: {
      spaceName?: string | null | undefined;
      requesterName?: string | null | undefined;
      forArchitect: boolean;
    },
  ): Sent<RequestSummary> => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    status: c.status,
    statusWords: STATUS_WORDS[c.status],
    open: OPEN.includes(c.status),
    groupId: c.groupId,
    spaceId: c.spaceId,
    spaceName: extra.spaceName ?? null,
    objectLabel: c.objectLabel,
    objectKey: c.objectKey,
    roomKey: c.roomKey,
    creationId: c.creationId,
    images: c.images,
    documents: c.documents,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    ...(extra.forArchitect
      ? {
          priority: c.priority,
          effort: c.effort,
          requesterName: extra.requesterName ?? null,
          workspaceId: c.workspaceId,
        }
      : {}),
  });

  return { limited, spaceFor, requestFor, summary };
}

export type RequestShared = ReturnType<typeof requestShared>;
