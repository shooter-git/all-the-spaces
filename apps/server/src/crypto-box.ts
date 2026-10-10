import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Seals small secrets (e.g. an external S3 key) at rest with a key derived from the server secret.
function key(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'all-the-spaces', purpose, 32));
}

export function seal(plain: string, secret: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret, purpose), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function open(sealed: string, secret: string, purpose: string): string {
  const raw = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key(secret, purpose), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
