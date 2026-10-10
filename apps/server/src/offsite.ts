// The off-site copy of backups: settings from setup (or `ats-admin backup-settings offsite`), with
// the secret sealed at rest like the Architect's own storage bucket's.
import type { schema } from '@ats/db';
import { createStorage, type OffsiteTarget } from '@ats/storage';
import { z } from 'zod';
import { open, seal } from './crypto-box.ts';

type OffsiteSettings = NonNullable<typeof schema.installState.$inferSelect.backup>['offsite'];

export const offsiteInput = z.object({
  endpoint: z.url(),
  region: z.string().trim().min(1),
  bucket: z.string().trim().min(1),
  /** Defaults to one folder per server, named after its address. */
  prefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._\-/]*$/)
    .optional(),
  accessKeyId: z.string().trim().min(1),
  secretAccessKey: z.string().min(1),
});
export type OffsiteInput = z.infer<typeof offsiteInput>;

const SEAL_PURPOSE = 'backups';

export function defaultOffsitePrefix(publicUrl: string): string {
  return `all-the-spaces/${new URL(publicUrl).hostname}`;
}

function target(o: Omit<OffsiteInput, 'prefix'> & { prefix: string }): OffsiteTarget {
  return {
    storage: createStorage({
      endpoint: o.endpoint,
      region: o.region,
      bucket: o.bucket,
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
      minimalChecksums: true,
    }),
    prefix: o.prefix,
  };
}

/** Checks that these details can write to the bucket and delete from it (for tidying up). */
export async function checkOffsite(input: OffsiteInput): Promise<void> {
  const { storage } = target({ ...input, prefix: '' });
  const key = `${input.prefix || 'all-the-spaces'}/.write-check`.replace(/^\/+/, '');
  await storage.put(key, 'All the Spaces checks it can write here.', 'text/plain');
  await storage.delete(key);
}

export function sealOffsite(
  input: OffsiteInput,
  secret: string,
  publicUrl: string,
): NonNullable<OffsiteSettings> {
  return {
    endpoint: input.endpoint,
    region: input.region,
    bucket: input.bucket,
    prefix: input.prefix || defaultOffsitePrefix(publicUrl),
    accessKeyId: input.accessKeyId,
    secretAccessKeyEnc: seal(input.secretAccessKey, secret, SEAL_PURPOSE),
  };
}

/** For details typed in rather than saved (fetching backups onto a new server). */
export function offsiteTargetFrom(input: OffsiteInput, publicUrl: string): OffsiteTarget {
  return target({ ...input, prefix: input.prefix || defaultOffsitePrefix(publicUrl) });
}

export function offsiteTarget(settings: OffsiteSettings, secret: string): OffsiteTarget | null {
  if (!settings) return null;
  return target({
    ...settings,
    secretAccessKey: open(settings.secretAccessKeyEnc, secret, SEAL_PURPOSE),
  });
}
