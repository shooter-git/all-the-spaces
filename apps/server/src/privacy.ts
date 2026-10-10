import { type Db, schema } from '@ats/db';
import { canSeeRoom, type SpaceAccess } from '@ats/shared';
import { inArray } from 'drizzle-orm';

const { roomPolicies, roomAccess, memberships, spaces } = schema;

/** Who may see each room of a space (Architects see everything; unlisted rooms are hidden). */
export async function spaceAccess(db: Db, spaceId: string): Promise<SpaceAccess> {
  return (await spaceAccessMany(db, [spaceId])).get(spaceId) ?? NOBODY;
}

const NOBODY: SpaceAccess = { architects: [], members: [], rooms: {} };

/** Who may see what, for several spaces at once (by space): three queries, however many. */
export async function spaceAccessMany(
  db: Db,
  spaceIds: string[],
): Promise<Map<string, SpaceAccess>> {
  const found = spaceIds.length
    ? await db
        .select({ id: spaces.id, groupId: spaces.groupId })
        .from(spaces)
        .where(inArray(spaces.id, spaceIds))
    : [];
  if (!found.length) return new Map();
  const ids = found.map((s) => s.id);
  const groupIds = [...new Set(found.map((s) => s.groupId))];
  const [policies, access, people] = await Promise.all([
    db.select().from(roomPolicies).where(inArray(roomPolicies.spaceId, ids)),
    db.select().from(roomAccess).where(inArray(roomAccess.spaceId, ids)),
    db
      .select({
        groupId: memberships.organizationId,
        userId: memberships.userId,
        role: memberships.role,
      })
      .from(memberships)
      .where(inArray(memberships.organizationId, groupIds)),
  ]);
  const result = new Map<string, SpaceAccess>();
  for (const space of found) {
    const rooms: SpaceAccess['rooms'] = {};
    for (const p of policies)
      if (p.spaceId === space.id) rooms[p.roomKey] = { visibility: p.visibility, users: [] };
    for (const a of access) if (a.spaceId === space.id) rooms[a.roomKey]?.users.push(a.userId);
    const group = people.filter((p) => p.groupId === space.groupId);
    result.set(space.id, {
      architects: group.filter((p) => p.role === 'architect').map((p) => p.userId),
      members: group.map((p) => p.userId),
      rooms,
    });
  }
  return result;
}

/** The rooms (of `roomKeys`) this person may see. */
export function visibleRooms(access: SpaceAccess, userId: string, roomKeys: string[]): Set<string> {
  return new Set(roomKeys.filter((k) => canSeeRoom(access, userId, k)));
}

/** Makes every room visible to the whole group (used for sample spaces). */
export async function shareAllRooms(db: Db, spaceId: string, roomKeys: string[]) {
  if (roomKeys.length === 0) return;
  await db
    .insert(roomPolicies)
    .values(roomKeys.map((roomKey) => ({ spaceId, roomKey, visibility: 'group' as const })))
    .onConflictDoNothing();
}
