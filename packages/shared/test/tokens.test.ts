import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../src/tickets.ts';

const secret = 'x'.repeat(40);

describe('signed tokens', () => {
  it('round-trip for their own purpose', () => {
    const t = signToken('play', { u: 'user', v: 'version' }, secret, 60);
    expect(verifyToken<{ u: string }>('play', t, secret)?.u).toBe('user');
  });

  it('never work for another purpose, another secret, or after expiry', () => {
    const t = signToken('space', { sub: 'user', spaceId: 's' }, secret, 60);
    expect(verifyToken('creation', t, secret)).toBeNull();
    expect(verifyToken('space', t, 'y'.repeat(40))).toBeNull();
    const expired = signToken('space', { sub: 'user' }, secret, -1);
    expect(verifyToken('space', expired, secret)).toBeNull();
    const [body, sig] = t.split('.');
    const tampered = `${Buffer.from(JSON.stringify({ sub: 'admin', exp: 9e9 })).toString('base64url')}.${sig}`;
    expect(body).toBeTruthy();
    expect(verifyToken('space', tampered, secret)).toBeNull();
  });

  it('have exactly one spelling: other encodings of the same signature are refused', () => {
    // A 32-byte signature is 43 base64url characters, the last carrying only 4 bits: flipping its
    // lowest bit decodes to the same bytes, which a lenient check would still accept.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (let n = 0; n < 20; n++) {
      const t = signToken('play', { u: 'user', n }, secret, 60);
      const last = B64.indexOf(t.at(-1) as string);
      const respelled = `${t.slice(0, -1)}${B64[last ^ 1]}`;
      expect(Buffer.from(respelled.split('.')[1] as string, 'base64url')).toEqual(
        Buffer.from(t.split('.')[1] as string, 'base64url'),
      );
      expect(verifyToken('play', respelled, secret)).toBeNull();
    }
  });
});
