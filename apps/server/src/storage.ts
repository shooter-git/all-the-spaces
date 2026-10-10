import { schema } from '@ats/db';
import { createStorage, type Storage } from '@ats/storage';
import { eq } from 'drizzle-orm';
import type { AppContext } from './context.ts';
import { open } from './crypto-box.ts';

let cached: Storage | null = null;

/** The object store chosen in setup: the built-in Garage or the Architect's own S3 bucket. */
export async function getStorage(
  ctx: Pick<AppContext, 'db' | 'env' | 'storage'>,
): Promise<Storage> {
  if (ctx.storage) return ctx.storage;
  if (cached) return cached;
  const [state] = await ctx.db
    .select()
    .from(schema.installState)
    .where(eq(schema.installState.id, 1));
  const ext = state?.storageMode === 'external' ? state.externalStorage : null;
  cached = ext
    ? createStorage({
        endpoint: ext.endpoint,
        region: ext.region,
        bucket: ext.bucket,
        accessKeyId: ext.accessKeyId,
        secretAccessKey: open(ext.secretAccessKeyEnc, ctx.env.BETTER_AUTH_SECRET, 'storage'),
      })
    : createStorage({
        endpoint: ctx.env.S3_ENDPOINT,
        region: ctx.env.S3_REGION,
        bucket: ctx.env.S3_BUCKET,
        accessKeyId: ctx.env.S3_ACCESS_KEY_ID,
        secretAccessKey: ctx.env.S3_SECRET_ACCESS_KEY,
      });
  return cached;
}

/** Forget the cached client (after setup changes the storage choice). */
export function resetStorage() {
  cached = null;
}
