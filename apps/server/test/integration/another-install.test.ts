// Another install: no email, behind one proxy (a plain install, none of the fakes connected).
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, schema } from '@ats/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetSetupCode } from '../../src/install-state.ts';
import { adminUrl, createTestApp, ORIGIN, type TestApp } from '../harness.ts';

describe.skipIf(!adminUrl)('another install: no email, behind one proxy', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let db: Db;
  let setupCode: string;
  let secret: string;

  beforeAll(async () => {
    t = await createTestApp({ plain: true });
    ({ app, db, setupCode, secret } = t);
  });

  afterAll(async () => {
    await t?.close();
  });

  it('makes one Architect and one group, however many people submit the wizard', async () => {
    const complete = (name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/setup/complete',
        payload: {
          code: setupCode,
          group: { name: `${name}'s house`, kind: 'family' },
          architect: { name, email: `${name}@example.test`, password: 'correct-horse-battery' },
          storage: { mode: 'builtin' },
          backup: { schedule: 'nightly', keepDays: 14 },
        },
      });
    const answers = await Promise.all(['ana', 'ben', 'cy'].map(complete));
    expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(await db.select().from(schema.groups)).toHaveLength(1);
    expect(await db.select().from(schema.user)).toHaveLength(1);
    expect(await db.select().from(schema.memberships)).toHaveLength(1);
  });

  it('without email, signing up signs you straight in and into the group', async () => {
    const [architect] = await db.select().from(schema.user);
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: architect?.email, password: 'correct-horse-battery' }),
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = signIn.headers['set-cookie'] as string | string[];
    const cookies = ([] as string[])
      .concat(cookie)
      .map((c) => c.split(';')[0])
      .join('; ');
    const [group] = await db.select().from(schema.groups);
    const inv = await app.inject({
      method: 'POST',
      url: `/api/groups/${group?.id}/invite-links`,
      headers: { cookie: cookies },
      payload: { maxUses: 1 },
    });
    const invite = new URL(inv.json().url).hash.slice(1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-ats-invite': invite },
      payload: JSON.stringify({
        name: 'Dee',
        email: 'dee@example.test',
        password: 'a-long-password',
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toEqual(expect.any(String));
    const dee = ([] as string[])
      .concat(res.headers['set-cookie'] as string | string[])
      .map((c) => c.split(';')[0])
      .join('; ');
    // The app still accepts the invite after signing up: they're in already, so that's fine.
    const accept = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: dee },
      payload: { token: invite },
    });
    expect(accept.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: dee } });
    expect(me.json().groups).toEqual([
      expect.objectContaining({ groupId: group?.id, role: 'member' }),
    ]);
    await db.delete(schema.user).where(eq(schema.user.email, 'dee@example.test'));
  });

  it("takes a client's address from the one proxy in front, not from what the client says", async () => {
    // Each request claims a different address of its own; the proxy (Caddy) adds the real one
    // last. Per-address limits (setup: 10 a minute) must go by the real one.
    const tries = [];
    for (let i = 1; i <= 11; i++)
      tries.push(
        await app.inject({
          method: 'POST',
          url: '/api/setup/verify-code',
          headers: { 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` },
          payload: { code: 'AAAA-BBBB-CCCC' },
        }),
      );
    expect(tries.slice(0, 10).every((r) => r.statusCode !== 429)).toBe(true);
    expect(tries[10]?.statusCode).toBe(429);
  });

  it("gives the claim back when setup can't finish, so the wizard can be submitted again", async () => {
    // A fresh install whose first try fails after the claim (the email is already taken).
    await db.update(schema.installState).set({ setupCompletedAt: null });
    setupCode = await resetSetupCode(db, secret);
    const [taken] = await db.select().from(schema.user);
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/complete',
      payload: {
        code: setupCode,
        group: { name: 'Again', kind: 'family' },
        architect: { name: 'Again', email: taken?.email, password: 'correct-horse-battery' },
        storage: { mode: 'builtin' },
        backup: { schedule: 'nightly', keepDays: 14 },
      },
    });
    expect(res.statusCode).toBe(400);
    const [state] = await db.select().from(schema.installState);
    expect(state?.setupCompletedAt).toBeNull();
  });
});
