import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

// Human-friendly one-time code printed by the installer. No ambiguous characters (0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateSetupCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

export function normalizeSetupCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 12 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}` : raw;
}

export function hashSetupCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(normalizeSetupCode(code)).digest('hex');
}

export function setupCodeMatches(input: string, storedHash: string, secret: string): boolean {
  const a = Buffer.from(hashSetupCode(input, secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
