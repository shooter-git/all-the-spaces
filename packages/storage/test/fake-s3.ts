// Just enough of the S3 API, in memory, for testing backups (list, get, head, put, delete).
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Storage } from '../src/s3.ts';

interface Stored {
  body: Buffer;
  etag: string;
  contentType?: string | undefined;
}

const missing = () => Object.assign(new Error('NoSuchKey'), { $metadata: { httpStatusCode: 404 } });

async function bytes(body: unknown): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const c of body as Readable) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

export function fakeS3(bucket = 'fake'): Storage & { objects: Map<string, Stored> } {
  const objects = new Map<string, Stored>();
  const store = (key: string, body: Buffer, contentType?: string) => {
    const etag = `"${createHash('md5').update(body).digest('hex')}"`;
    objects.set(key, { body, etag, contentType });
    return etag;
  };
  const send = async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const { Key, Prefix, Body, ContentType } = cmd.input as {
      Key?: string;
      Prefix?: string;
      Body?: unknown;
      ContentType?: string;
    };
    switch (cmd.constructor.name) {
      case 'ListObjectsV2Command':
        return {
          Contents: [...objects]
            .filter(([k]) => !Prefix || k.startsWith(Prefix))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, o]) => ({ Key: k, Size: o.body.length, ETag: o.etag })),
        };
      case 'PutObjectCommand':
        return { ETag: store(Key as string, await bytes(Body), ContentType) };
      case 'GetObjectCommand': {
        const o = objects.get(Key as string);
        if (!o) throw missing();
        return { Body: Readable.from([o.body]), ETag: o.etag, ContentType: o.contentType };
      }
      case 'HeadObjectCommand':
        if (!objects.has(Key as string)) throw missing();
        return {};
      case 'DeleteObjectCommand':
        objects.delete(Key as string);
        return {};
      default:
        throw new Error(`fake S3 doesn't do ${cmd.constructor.name}`);
    }
  };
  const client = { send } as unknown as Storage['client'];
  return {
    objects,
    client,
    bucket,
    async check() {},
    async put(key, body, contentType) {
      store(key, await bytes(body), contentType);
    },
    async getBytes(key) {
      const o = objects.get(key);
      if (!o) throw missing();
      return new Uint8Array(o.body);
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
      return `fake://${key}`;
    },
  };
}
