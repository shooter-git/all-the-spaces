import { type Db, schema } from '@ats/db';
import { canSeeRoom } from '@ats/shared';
import { and, eq } from 'drizzle-orm';
import { manifestOf } from '../manifests.ts';
import { spaceAccess } from '../privacy.ts';

const { creations, creationVersions, spaces, spaceVersions, memberships } = schema;

export interface CreationAccess {
  creation: typeof creations.$inferSelect;
  /** The live version (null while it only has candidates, which only Architects can see). */
  version: typeof creationVersions.$inferSelect | null;
  /** The room its object is in (null when it's on the unplaced shelf). */
  roomKey: string | null;
  isArchitect: boolean;
}

/**
 * A creation this person may open: they're in its group and may see the room its object is in.
 * Unplaced creations (whose object is gone) and creations that aren't live yet are for Architects
 * only. Null otherwise — the same answer whether it doesn't exist or isn't theirs.
 */
export async function creationAccess(
  db: Db,
  userId: string,
  creationId: string,
): Promise<CreationAccess | null> {
  const [row] = await db
    .select({ creation: creations, version: creationVersions, space: spaceVersions })
    .from(creations)
    .leftJoin(creationVersions, eq(creationVersions.id, creations.currentVersionId))
    .innerJoin(spaces, eq(spaces.id, creations.spaceId))
    .innerJoin(spaceVersions, eq(spaceVersions.id, spaces.currentVersionId))
    .where(eq(creations.id, creationId));
  if (!row) return null;
  const [membership] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(eq(memberships.organizationId, row.creation.groupId), eq(memberships.userId, userId)),
    );
  if (!membership) return null;
  const isArchitect = membership.role === 'architect';
  if (!row.version && !isArchitect) return null;
  const manifest = manifestOf(row.space);
  const room = row.creation.objectKey
    ? manifest.rooms.find((r) => r.objects.some((o) => o.key === row.creation.objectKey))
    : undefined;
  if (!room) {
    return isArchitect
      ? { creation: row.creation, version: row.version, roomKey: null, isArchitect }
      : null;
  }
  if (!isArchitect && !canSeeRoom(await spaceAccess(db, row.creation.spaceId), userId, room.key)) {
    return null;
  }
  return { creation: row.creation, version: row.version, roomKey: room.key, isArchitect };
}

export type VersionAccess =
  | {
      denied: false;
      access: CreationAccess;
      version: typeof creationVersions.$inferSelect;
      /** Not the live version: an Architect trying it. */
      trial: boolean;
    }
  | { denied: true; access: CreationAccess };

/**
 * A version of a creation this person may act through right now: the live one, or (for the
 * group's Architects only) any version of it, as a trial. Null when they can't open the creation
 * at all; `denied` when they can, but not through that version (someone still inside an older
 * version keeps its files, but it can't act for them any more).
 */
export async function versionAccess(
  db: Db,
  userId: string,
  creationId: string,
  versionId: string,
): Promise<VersionAccess | null> {
  const access = await creationAccess(db, userId, creationId);
  if (!access) return null;
  if (access.version && access.version.id === versionId)
    return { denied: false, access, version: access.version, trial: false };
  if (!access.isArchitect) return { denied: true, access };
  const [version] = await db
    .select()
    .from(creationVersions)
    .where(and(eq(creationVersions.id, versionId), eq(creationVersions.creationId, creationId)));
  return version ? { denied: false, access, version, trial: true } : { denied: true, access };
}
