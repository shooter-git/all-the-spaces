// One-time setup, invite-only sign-up and roles, and the first sample space.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { type Db, schema } from '@ats/db';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  adminUrl,
  cookieFrom,
  createTestApp,
  type Fakes,
  ORIGIN,
  setupBody,
  type TestApp,
} from '../harness.ts';

describe.skipIf(!adminUrl)('server flows', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let db: Db;
  let mailed: Fakes['mailed'];
  let setupCode: string;

  beforeAll(async () => {
    t = await createTestApp();
    ({ app, db, setupCode } = t);
    ({ mailed } = t.fake);
  });

  afterAll(async () => {
    await t?.close();
  });

  let architectCookie = '';
  let groupId = '';
  const signUpOutsider = () => t.signUpOutsider(architectCookie, groupId);

  it('keeps the references that form cycles deferrable (added by hand to the migration)', async () => {
    const rows = await db.execute<{ conname: string }>(
      sql`select conname from pg_constraint where contype = 'f' and condeferrable and condeferred`,
    );
    expect(rows.map((r) => r.conname).sort()).toEqual([
      'builds_version_id_creation_versions_id_fk',
      'builds_workspace_id_workspaces_id_fk',
      'creation_versions_build_id_builds_id_fk',
      'creations_current_version_id_creation_versions_id_fk',
      'spaces_current_version_id_space_versions_id_fk',
      'workspaces_last_build_id_builds_id_fk',
    ]);
  });

  it('rejects a wrong setup code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/complete',
      payload: setupBody('AAAA-BBBB-CCCC'),
    });
    expect(res.statusCode).toBe(403);
  });

  const bucket = (endpoint: string) => ({
    mode: 'external',
    endpoint,
    region: 'auto',
    bucket: 'b',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
  });

  it('only tries buckets for whoever holds the setup code', async () => {
    for (const url of ['/api/setup/test-storage', '/api/setup/test-offsite']) {
      const anon = await app.inject({
        method: 'POST',
        url,
        payload: bucket('http://garage:3903'),
      });
      expect(anon.statusCode).toBe(403);
      const wrong = await app.inject({
        method: 'POST',
        url,
        payload: { code: 'AAAA-BBBB-CCCC', ...bucket('http://garage:3903') },
      });
      expect(wrong.statusCode).toBe(403);
    }
  });

  it("refuses buckets on the server's own network, and keeps what went wrong to itself", async () => {
    const internal = await app.inject({
      method: 'POST',
      url: '/api/setup/test-storage',
      payload: { code: setupCode, ...bucket('http://169.254.169.254') },
    });
    expect(internal.statusCode).toBe(400);
    expect(internal.json().error).toMatch(/own network/);
    const unreachable = await app.inject({
      method: 'POST',
      url: '/api/setup/test-offsite',
      payload: { code: setupCode, ...bucket('http://nowhere.invalid') },
    });
    expect(unreachable.statusCode).toBe(400);
    expect(unreachable.json().error).toBe(
      "Couldn't save backups in that bucket. Check the address and keys.",
    );
  });

  it('refuses an off-site backup bucket it cannot write to', async () => {
    const offsite = {
      endpoint: 'http://nowhere.invalid',
      region: 'auto',
      bucket: 'nowhere',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/complete',
      payload: { ...setupBody(setupCode), backup: { schedule: 'nightly', keepDays: 14, offsite } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Couldn't save backups/);
    const [state] = await db.select().from(schema.installState);
    expect(state?.setupCompletedAt).toBeNull();
  });

  it('completes setup once and signs the Architect in', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/complete',
      payload: setupBody(setupCode),
    });
    expect(res.statusCode).toBe(200);
    groupId = res.json().groupId;
    architectCookie = cookieFrom(res.headers);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: architectCookie },
    });
    expect(me.json().groups).toEqual([expect.objectContaining({ groupId, role: 'architect' })]);
  });

  it("installs as a standalone app with the group's name (the status bar stays)", async () => {
    const res = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    const manifest = res.json();
    expect(manifest).toMatchObject({ name: 'Test House', display: 'standalone' });
    // Full screen everywhere would hide the status bar on Home and Account too; a space asks
    // for it by itself.
    expect(manifest.display_override ?? []).not.toContain('fullscreen');
  });

  it('refuses to run setup a second time', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/complete',
      payload: setupBody(setupCode, 'someone@example.test'),
    });
    expect(res.statusCode).toBe(409);
  });

  it('closes the bucket checks once setup is finished', async () => {
    for (const url of ['/api/setup/test-storage', '/api/setup/test-offsite']) {
      const res = await app.inject({
        method: 'POST',
        url,
        payload: { code: setupCode, ...bucket('http://garage:3903') },
      });
      expect(res.statusCode).toBe(409);
    }
  });

  const signUpOnly = (email: string, invite?: string) => t.signUpOnly(email, invite);
  const confirmLink = (email: string) => t.confirmLink(email);
  const signUp = (email: string, invite?: string) => t.signUp(email, invite);

  it('does not allow signing up without an invite', async () => {
    const res = await signUp('stranger@example.test');
    expect(res.statusCode).toBe(403);
  });

  let token = '';
  it('lets an Architect create an invite link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/invite-links`,
      headers: { cookie: architectCookie },
      payload: { maxUses: 1 },
    });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().url);
    expect(url.pathname).toBe('/join');
    token = url.hash.slice(1); // the token travels in the fragment, never to the server's logs
    expect(token.length).toBeGreaterThan(20);
  });

  let memberCookie = '';
  it('lets an invited person sign up and join as a member', async () => {
    const res = await signUp('sam@example.test', token);
    expect(res.statusCode).toBe(200);
    memberCookie = cookieFrom(res.headers);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      headers: { cookie: memberCookie },
      payload: { token },
    });
    expect(accept.statusCode).toBe(200);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: memberCookie },
    });
    expect(me.json().groups).toEqual([expect.objectContaining({ groupId, role: 'member' })]);
  });

  it('does not let a single-use link be used twice', async () => {
    const res = await signUp('third@example.test', token);
    expect(res.statusCode).toBe(403);
  });

  it('does not let members manage invites', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/invite-links`,
      headers: { cookie: memberCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("keeps Better Auth's own group endpoints closed: changes go through the app's rules", async () => {
    const auth = (path: string, payload: object = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/auth${path}`,
        headers: { cookie: architectCookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    const sam = (
      await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: memberCookie } })
    ).json().user.id as string;
    const [membership] = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, sam));
    const tries: [string, object][] = [
      [
        '/organization/remove-member',
        { memberIdOrEmail: 'sam@example.test', organizationId: groupId },
      ],
      ['/organization/remove-member/', { memberIdOrEmail: sam, organizationId: groupId }],
      [
        '/organization/update-member-role',
        { memberId: membership?.id, role: 'architect', organizationId: groupId },
      ],
      ['/organization/leave', { organizationId: groupId }],
      ['/organization/delete', { organizationId: groupId }],
      ['/organization/invite-member', { email: 'x@example.test', role: 'architect' }],
    ];
    for (const [path, payload] of tries) {
      expect((await auth(path, payload)).statusCode, path).toBe(404);
    }
    const listed = await app.inject({
      method: 'GET',
      url: '/api/auth/organization/list-members',
      headers: { cookie: architectCookie, origin: ORIGIN },
    });
    expect(listed.statusCode).toBe(404);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: memberCookie },
    });
    expect(me.json().groups).toEqual([expect.objectContaining({ groupId, role: 'member' })]);
  });

  it('records consequential actions in the audit log', async () => {
    const rows = await db.execute('select action from audit_log order by created_at');
    expect(rows.map((r) => (r as { action: string }).action)).toEqual([
      'setup.completed',
      'invite.created',
      'member.joined',
    ]);
  });

  it('signs nobody in until they confirm their email, when the server sends email', async () => {
    const inv = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/invite-links`,
      headers: { cookie: architectCookie },
      payload: {},
    });
    const invite = new URL(inv.json().url).hash.slice(1);
    const res = await signUpOnly('quinn@example.test', invite);
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeNull();
    expect(cookieFrom(res.headers)).not.toMatch(/session_token/);
    const first = confirmLink('quinn@example.test');
    expect(first).toMatch(/^\/api\/auth\/verify-email\?token=/);

    // Already in the group (an Architect sees the address isn't confirmed), but can't sign in.
    const quinn = () =>
      app
        .inject({
          method: 'GET',
          url: `/api/groups/${groupId}/people`,
          headers: { cookie: architectCookie },
        })
        .then((r) =>
          r.json().people.find((p: { email: string }) => p.email === 'quinn@example.test'),
        );
    expect(await quinn()).toMatchObject({ role: 'member', emailConfirmed: false });
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'quinn@example.test', password: 'another-long-password' }),
    });
    expect(signIn.statusCode).toBe(403);
    expect(signIn.json().code).toBe('EMAIL_NOT_VERIFIED');
    // Trying sends a fresh link.
    expect(mailed.filter((m) => m.to === 'quinn@example.test')).toHaveLength(2);

    // The link confirms the address and signs them in.
    const confirmed = await app.inject({
      method: 'GET',
      url: confirmLink('quinn@example.test') as string,
    });
    expect(confirmed.statusCode).toBe(302);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookieFrom(confirmed.headers) },
    });
    expect(me.json().groups).toEqual([expect.objectContaining({ groupId, role: 'member' })]);
    expect(await quinn()).toMatchObject({ emailConfirmed: true });
    // Nobody gets a link for the setup wizard's Architect: they're confirmed already.
    expect(mailed.some((m) => m.to === 'pat@example.test')).toBe(false);
    await db.delete(schema.user).where(eq(schema.user.email, 'quinn@example.test'));
  });

  let spaceId = '';
  let chunkUrl = '';
  it('lets an Architect add a sample space, and members walk into it', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/sample-spaces`,
      headers: { cookie: memberCookie },
      payload: { sample: 'studio-apartment' },
    });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/sample-spaces`,
      headers: { cookie: architectCookie },
      payload: { sample: 'studio-apartment' },
    });
    expect(res.statusCode).toBe(200);
    spaceId = res.json().spaceId;

    // It builds in the background: listed as building, then ready (a fast machine may have
    // finished it already by the time it's first looked at).
    const status = async () =>
      (await app.inject({ method: 'GET', url: '/api/spaces', headers: { cookie: memberCookie } }))
        .json()
        .spaces.find((s: { id: string }) => s.id === spaceId)?.status;
    expect(['building', 'ready']).toContain(await status());
    await vi.waitFor(async () => expect(await status()).not.toBe('building'), {
      timeout: 20_000,
      interval: 100,
    });
    expect(await status()).toBe('ready');

    const manifest = await app.inject({
      method: 'GET',
      url: `/api/spaces/${spaceId}/manifest`,
      headers: { cookie: memberCookie },
    });
    expect(manifest.statusCode).toBe(200);
    const room = manifest.json().rooms[0];
    chunkUrl = `/api/spaces/${spaceId}/${room.lods.lod0.path}`;
    const chunk = await app.inject({
      method: 'GET',
      url: chunkUrl,
      headers: { cookie: memberCookie },
    });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.headers['cache-control']).toContain('immutable');
    expect(JSON.parse(chunk.payload).asset.version).toBe('2.0');
    const again = await app.inject({
      method: 'GET',
      url: chunkUrl,
      headers: { cookie: memberCookie, 'if-none-match': chunk.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
  });

  it('hides spaces from people outside the group', async () => {
    const anon = await app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/manifest` });
    expect(anon.statusCode).toBe(401);
    // Signed in but not in the group: same answer as for a space that doesn't exist.
    const outsider = await signUpOutsider();
    for (const url of [`/api/spaces/${spaceId}/manifest`, chunkUrl]) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie: outsider } });
      expect(res.statusCode).toBe(404);
    }
  });

  it('only serves files that belong to the current version', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/spaces/${spaceId}/chunks/${'0'.repeat(64)}.glb`,
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
