import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed tickets that let a browser join a real-time room. The API server issues them
 * after checking membership; the real-time service verifies them without touching the database.
 */
export interface RealtimeTicket {
  /** User id */
  sub: string;
  name: string;
  color: string;
  spaceId: string;
  /**
   * Which of the space's live rooms (shards) to join: big groups are spread over several so no
   * single update goes to everyone. Absent means 0 (small groups have one).
   */
  shard?: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

/** Group members per shard of a space's live presence. */
export const MEMBERS_PER_SHARD = 30;

/** Which shard someone joins: the same one every time, spread evenly. */
export function shardFor(userId: string, members: number): number {
  const shards = Math.max(1, Math.ceil(members / MEMBERS_PER_SHARD));
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) h = Math.imul(h ^ userId.charCodeAt(i), 16777619);
  return (h >>> 0) % shards;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/**
 * Signs a short-lived token for one purpose. Each purpose gets its own key (derived from the
 * secret), so a token made for one thing can never be used for another.
 */
export function signToken<T extends object>(
  purpose: TokenPurpose,
  payload: T,
  secret: string,
  ttlSeconds: number,
): string {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  return `${body}.${hmac(purpose, secret, body).toString('base64url')}`;
}

export function verifyToken<T extends object>(
  purpose: TokenPurpose,
  token: string,
  secret: string,
): (T & { exp: number }) | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  // Compared as the exact text issued: decoding first would also accept other spellings of the
  // same signature (base64url's last character carries spare bits).
  const expected = Buffer.from(hmac(purpose, secret, body).toString('base64url'));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & {
      exp: number;
    };
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export type TokenPurpose = 'space' | 'creation' | 'play' | 'supervisor' | 'preview';

function hmac(purpose: TokenPurpose, secret: string, body: string) {
  const key = createHmac('sha256', secret).update(`ats-token:${purpose}`).digest();
  return createHmac('sha256', key).update(body).digest();
}

/** A ticket to join a space's live presence room. */
export function signTicket(
  payload: Omit<RealtimeTicket, 'exp'>,
  secret: string,
  ttlSeconds = 60,
): string {
  return signToken('space', payload, secret, ttlSeconds);
}

export function verifyTicket(ticket: string, secret: string): RealtimeTicket | null {
  return verifyToken<RealtimeTicket>('space', ticket, secret);
}

/** A ticket to join a creation's live session. */
export interface CreationTicket {
  sub: string;
  name: string;
  color: string;
  creationId: string;
  versionId: string;
  /** The creation's group (someone taken out of it leaves its sessions). */
  groupId?: string;
  /** Join this exact session, or (when absent) start or join one in this mode. */
  sessionId?: string;
  mode: 'solo' | 'shared' | 'invite';
  /** False when the group has turned voice chat off. */
  voice?: boolean;
  exp: number;
}

/** A calm, distinct colour per person (stable for the same user id). */
export const AVATAR_COLORS = [
  '#3F5B7C',
  '#7D8A68',
  '#9A6B53',
  '#6B6A8F',
  '#4F7A7A',
  '#8C7A5B',
  '#7A5C6E',
  '#5C6F8C',
];
export function avatarColor(userId: string): string {
  let h = 0;
  for (const c of userId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] as string;
}
