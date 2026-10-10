/**
 * Valkey pub/sub channels shared by the API server (publishes) and the real-time service
 * (subscribes). Messages are JSON.
 */
export const policyTopic = (spaceId: string) => `space-policy:${spaceId}`;

/** Someone was taken out of a group: `{ groupId, userId }`. They leave its live sessions. */
export const memberRemovedTopic = 'group-member-removed';
/** The close code a live room uses when it lets go of someone taken out of the group. */
export const REMOVED_FROM_GROUP = 4403;

/** Valkey hash: live shared sessions of a creation → how many people are in each. */
export const creationPlayersKey = (creationId: string) => `creation-players:${creationId}`;

/**
 * Who may see each room of a space, as the real-time service needs it. Rooms not listed are
 * hidden from everyone but Architects.
 */
export interface SpaceAccess {
  /** User ids of the group's Architects (they see every room). */
  architects: string[];
  /** Everyone in the group (someone just removed is taken out of the space). */
  members?: string[];
  rooms: Record<string, { visibility: 'group' | 'limited' | 'hidden'; users: string[] }>;
}

/** Whether a person may see a room. */
export function canSeeRoom(access: SpaceAccess, userId: string, roomKey: string): boolean {
  // Nobody outside the group sees any of its rooms, "whole group" ones included.
  if (access.members && !access.members.includes(userId)) return false;
  if (access.architects.includes(userId)) return true;
  const policy = access.rooms[roomKey];
  if (!policy) return false;
  return (
    policy.visibility === 'group' ||
    (policy.visibility === 'limited' && policy.users.includes(userId))
  );
}
