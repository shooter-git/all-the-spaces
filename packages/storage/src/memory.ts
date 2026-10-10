import type { Storage } from './s3.ts';

/** In-memory object store with the same interface, for tests. */
export function createMemoryStorage(): Storage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    client: undefined as never,
    bucket: 'memory',
    async check() {},
    async put(key, body) {
      objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : body);
    },
    async getBytes(key) {
      const v = objects.get(key);
      if (!v) throw new Error(`No such key: ${key}`);
      return v;
    },
    async has(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async deletePrefix(prefix) {
      let deleted = 0;
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          deleted++;
        }
      }
      return deleted;
    },
    async presignGet(key) {
      return `memory://${key}`;
    },
  };
}
