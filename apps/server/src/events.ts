import { creationPlayersKey as countsKey, memberRemovedTopic, policyTopic } from '@ats/shared';
import { Redis } from 'ioredis';

/** Tells the other services when something they cache changes. */
export interface SpaceEvents {
  /** Room privacy changed: the real-time service re-reads who may see what. */
  policyChanged(spaceId: string): Promise<void>;
  /** Someone was taken out of a group: the real-time service lets go of them. */
  memberRemoved(groupId: string, userId: string): Promise<void>;
  /** How many people are in each creation's shared sessions right now. */
  playing(creationIds: string[]): Promise<Record<string, number>>;
  close(): Promise<void>;
}

export const noEvents: SpaceEvents = {
  policyChanged: async () => {},
  memberRemoved: async () => {},
  playing: async () => ({}),
  close: async () => {},
};

/** Publishes events on Valkey. A failed publish is logged, never fatal. */
export function valkeyEvents(url: string, log: (msg: string) => void): SpaceEvents {
  const redis = new Redis(url, { maxRetriesPerRequest: 2 });
  redis.on('error', (err) => log(`Valkey: ${err.message}`));
  return {
    async policyChanged(spaceId) {
      await redis
        .publish(policyTopic(spaceId), JSON.stringify({ spaceId }))
        .catch((err: Error) => log(`Could not announce a privacy change: ${err.message}`));
    },
    async memberRemoved(groupId, userId) {
      await redis
        .publish(memberRemovedTopic, JSON.stringify({ groupId, userId }))
        .catch((err: Error) => log(`Could not announce a removal: ${err.message}`));
    },
    async playing(creationIds) {
      const out: Record<string, number> = {};
      await Promise.all(
        creationIds.map(async (id) => {
          // The real-time service keeps one count per live shared session.
          const counts = await redis.hvals(countsKey(id)).catch(() => []);
          out[id] = counts.reduce((n, c) => n + (Number(c) || 0), 0);
        }),
      );
      return out;
    },
    async close() {
      redis.disconnect();
    },
  };
}
