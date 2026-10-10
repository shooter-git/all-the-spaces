import { type Db, schema } from '@ats/db';
import { canSeeRoom } from '@ats/shared';
import { SpaceManifest } from '@ats/space-format';
import { and, eq, inArray, or } from 'drizzle-orm';
import { spaceAccess } from '../privacy.ts';

const { spaces, spaceVersions, memberships, chatBlocks } = schema;

/**
 * Chat channels, and who may read and post in each:
 *   space:<spaceId>            everyone in the space's group
 *   room:<spaceId>:<roomKey>   everyone who may see that room (the same rule as the 3D space)
 *   dm:<userId>:<userId>       the two people, ids sorted, if they share a group
 */
export type Channel =
  | { kind: 'space'; spaceId: string }
  | { kind: 'room'; spaceId: string; roomKey: string }
  | { kind: 'dm'; a: string; b: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function parseChannel(id: string): Channel | null {
  const [kind, x, y, extra] = id.split(':');
  if (extra !== undefined || !x) return null;
  if (kind === 'space' && UUID.test(x) && y === undefined) return { kind, spaceId: x };
  if (kind === 'room' && UUID.test(x) && y && KEY.test(y)) return { kind, spaceId: x, roomKey: y };
  if (kind === 'dm' && y && KEY.test(x) && KEY.test(y) && x < y) return { kind, a: x, b: y };
  return null;
}

export const dmChannel = (a: string, b: string) => (a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`);

export interface ChannelAccess {
  groupId: string;
  /** Everyone who may read the channel. */
  readers: () => Promise<string[]>;
}

async function groupMembers(db: Db, groupId: string) {
  return (
    await db
      .select({ id: memberships.userId })
      .from(memberships)
      .where(eq(memberships.organizationId, groupId))
  ).map((m) => m.id);
}

/**
 * Whether this person may read and post in a channel. Null for "no" — the same answer whether
 * the channel doesn't exist or isn't theirs.
 */
export async function channelAccess(
  db: Db,
  userId: string,
  channelId: string,
): Promise<ChannelAccess | null> {
  const channel = parseChannel(channelId);
  if (!channel) return null;

  if (channel.kind === 'dm') {
    if (userId !== channel.a && userId !== channel.b) return null;
    const rows = await db
      .select({ userId: memberships.userId, groupId: memberships.organizationId })
      .from(memberships)
      .where(inArray(memberships.userId, [channel.a, channel.b]));
    const groupsOf = (id: string) =>
      new Set(rows.filter((r) => r.userId === id).map((r) => r.groupId));
    const other = groupsOf(channel.b);
    const shared = [...groupsOf(channel.a)].find((g) => other.has(g));
    if (!shared) return null;
    return { groupId: shared, readers: async () => [channel.a, channel.b] };
  }

  const [row] = await db
    .select({ groupId: spaces.groupId, manifest: spaceVersions.manifest })
    .from(spaces)
    .innerJoin(spaceVersions, eq(spaceVersions.id, spaces.currentVersionId))
    .where(eq(spaces.id, channel.spaceId));
  if (!row) return null;
  const members = await groupMembers(db, row.groupId);
  if (!members.includes(userId)) return null;
  if (channel.kind === 'space') return { groupId: row.groupId, readers: async () => members };

  // A room: only if it exists and this person may see it.
  const manifest = SpaceManifest.parse(row.manifest);
  if (!manifest.rooms.some((r) => r.key === channel.roomKey)) return null;
  const access = await spaceAccess(db, channel.spaceId);
  if (!canSeeRoom(access, userId, channel.roomKey)) return null;
  return {
    groupId: row.groupId,
    readers: async () => {
      // Re-read at delivery time, so a privacy change applies to the very next message.
      const now = await spaceAccess(db, channel.spaceId);
      return members.filter((m) => canSeeRoom(now, m, channel.roomKey));
    },
  };
}

/** Pairs where one has blocked the other, among these people and `userId`. */
export async function blockedBetween(db: Db, userId: string, others: string[]) {
  if (others.length === 0) return { blockedByMe: new Set<string>(), blockingMe: new Set<string>() };
  const rows = await db
    .select()
    .from(chatBlocks)
    .where(
      or(
        and(eq(chatBlocks.blockerId, userId), inArray(chatBlocks.blockedId, others)),
        and(eq(chatBlocks.blockedId, userId), inArray(chatBlocks.blockerId, others)),
      ),
    );
  return {
    blockedByMe: new Set(rows.filter((r) => r.blockerId === userId).map((r) => r.blockedId)),
    blockingMe: new Set(rows.filter((r) => r.blockedId === userId).map((r) => r.blockerId)),
  };
}
