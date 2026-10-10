import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Plain S3 API only — works with the built-in Garage, AWS S3, Cloudflare R2, or any compatible store.
export interface S3Config {
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  /** Only send the checksums an operation requires: for S3-compatible services that reject the
   *  SDK's newer default ones (used for off-site backups, which may go anywhere). */
  minimalChecksums?: boolean;
}

export function createStorage(cfg: S3Config) {
  const client = new S3Client({
    ...(cfg.endpoint !== undefined ? { endpoint: cfg.endpoint } : {}),
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle ?? Boolean(cfg.endpoint),
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    ...(cfg.minimalChecksums
      ? { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }
      : {}),
  });
  const Bucket = cfg.bucket;

  return {
    client,
    bucket: Bucket,
    async check(): Promise<void> {
      await client.send(new HeadBucketCommand({ Bucket }));
    },
    async put(Key: string, Body: Uint8Array | string, ContentType?: string): Promise<void> {
      await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }));
    },
    async getBytes(Key: string): Promise<Uint8Array> {
      const res = await client.send(new GetObjectCommand({ Bucket, Key }));
      if (!res.Body) throw new Error(`Empty object: ${Key}`);
      return res.Body.transformToByteArray();
    },
    /** Whether an object exists (for skipping uploads of content that's already stored). */
    async has(Key: string): Promise<boolean> {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key }));
        return true;
      } catch (err) {
        if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
          return false;
        throw err;
      }
    },
    async delete(Key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket, Key }));
    },
    /** Deletes every object whose key starts with `Prefix` (which should end with `/`). */
    async deletePrefix(Prefix: string): Promise<number> {
      let deleted = 0;
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token }),
        );
        const keys = (res.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length) {
          await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys } }));
          deleted += keys.length;
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return deleted;
    },
    presignGet(Key: string, expiresIn = 300): Promise<string> {
      return getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn });
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;
