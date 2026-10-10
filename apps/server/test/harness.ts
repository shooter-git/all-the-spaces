// The server against a real Postgres, for the integration tests in test/integration: each test
// file makes its own app with createTestApp(), in its own scratch database, so files never share
// state and can run in parallel.
// Needs TEST_DATABASE_URL pointing at a server where it may create and drop scratch databases,
// e.g. postgres://ats:…@127.0.0.1:45132/postgres (the integration tests are skipped when unset).
import { randomBytes } from 'node:crypto';
import { createDb, runMigrations, schema } from '@ats/db';
import type { ServerEnv } from '@ats/shared';
import { packTar } from '@ats/shared';
import { createMemoryStorage } from '@ats/storage';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { expect, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createAuth } from '../src/auth.ts';
import type { ConnectorRegistry } from '../src/connectors/registry.ts';
import { publishCreation } from '../src/creations/store.ts';
import { ensureSetupCode } from '../src/install-state.ts';
import type { NotifyTransport } from '../src/notify.ts';
import type { SourceHostRegistry } from '../src/sources/registry.ts';
import { type Supervisor, SupervisorError } from '../src/studio/supervisor.ts';

export const adminUrl = process.env.TEST_DATABASE_URL;
export const ORIGIN = 'http://app.test.localhost';
export const PLAY_URL = 'http://play.test.localhost';
/** The assistant binary the fake supervisor treats as installed. */
export const INSTALLED = 'a'.repeat(64);

/** Everything the fakes record, and what they answer: tests read and change it freely. */
export interface Fakes {
  /** What the supervisor was asked to do. */
  supCalls: { act: string; claims: Record<string, unknown>; body?: Record<string, unknown> }[];
  /** Spaces whose privacy changes were announced to the real-time service. */
  announced: string[];
  /** People the real-time service was told to let go of (taken out of a group). */
  removals: { groupId: string; userId: string }[];
  /** What left the server as push notifications and emails. */
  pushed: { endpoint: string; payload: string }[];
  mailed: { to: string; subject: string; text: string }[];
  /** What a workspace archive holds when the supervisor is asked for one. */
  workspaceArchive: Buffer | null;
  /** What the supervisor says about a workspace's live preview. */
  previewStatus: { stamp: number; ok: boolean } | null;
  /** What a space workspace's plan.json holds (for onboarding tests). */
  workspacePlan: unknown;
  /** Other files in a space workspace (its models). */
  workspaceFiles: Map<string, Buffer>;
  /** What a workspace's pictures and models look like to the supervisor (path, size, seconds). */
  pictureListing: {
    pictures: { path: string; bytes: number; at: number }[];
    models: { path: string; bytes: number; at: number }[];
  };
  /** Instructions written into workspaces (CLAUDE.md, AGENTS.md), by workspace and path. */
  instructionFiles: Map<string, Buffer>;
  /** When the fake sandbox's terminal last printed (seconds), for the sleep timer. */
  assistantPrintedAt: number | null;
  /** How the supervisor's lighting bake jobs end: baked, Blender failing, or timing out. */
  bake: 'ok' | 'fail' | 'timeout';
  /** The containers the supervisor says it has. */
  containers: { Names: string[]; Labels: Record<string, string>; Created?: number }[];
}

export interface TestAppOptions {
  /**
   * A plain install, as a self-hoster might run it: no email, no voice chat, no Studio, and the
   * server's own notification transport and events (none of the fakes are connected).
   */
  plain?: boolean;
  /** How long the play origin trusts an access check (see AppContext.playAccessTtlMs). */
  playAccessTtlMs?: number;
  /**
   * Settings on top of the test defaults. By default places are built from plain colours and
   * shapes (ATS_OFFLINE) with no baked lighting (ATS_BAKE=0): tests never download assets.
   */
  env?: Partial<ServerEnv>;
  /** Blender on this machine, as the server sees it (null: none). */
  blender?: string | null;
  /** The connectors installed (default: none). */
  connectors?: ConnectorRegistry;
  /** The repository hosts installed (default: none). */
  sourceHosts?: SourceHostRegistry;
  /** Where builds are queued (default: Valkey, as in production). */
  buildQueue?: Queue;
}

/** A fresh app and everything to drive it with (see createTestApp). */
export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

export const cookieFrom = (headers: Record<string, unknown>) =>
  ([] as string[])
    .concat((headers['set-cookie'] as string | string[] | undefined) ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');

export const setupBody = (code: string, email = 'pat@example.test') => ({
  code,
  group: { name: 'Test House', kind: 'family' },
  architect: { name: 'Pat', email, password: 'correct-horse-battery' },
  storage: { mode: 'builtin' },
  backup: { schedule: 'nightly', keepDays: 14 },
});

function createFakes(): Fakes {
  return {
    supCalls: [],
    announced: [],
    removals: [],
    pushed: [],
    mailed: [],
    workspaceArchive: null,
    previewStatus: null,
    workspacePlan: null,
    workspaceFiles: new Map(),
    pictureListing: { pictures: [], models: [] },
    instructionFiles: new Map(),
    assistantPrintedAt: null,
    bake: 'ok',
    containers: [],
  };
}

/** What a bake job writes for a room's input: a flat lightmap, and a UV pair per vertex. */
function fakeBake(input: string | undefined) {
  const room = JSON.parse(Buffer.from(input ?? '', 'base64').toString('utf8')) as {
    receiver: { positions: number[] };
    resolution: number;
  };
  const n = room.resolution;
  const floats = (count: number, v: number) =>
    new Uint8Array(new Float32Array(count).fill(v).buffer);
  return packTar(
    new Map([
      ['meta.json', new TextEncoder().encode(JSON.stringify({ width: n, height: n, seconds: 1 }))],
      ['uv2.f32', floats((room.receiver.positions.length / 3) * 2, 0.5)],
      ['lightmap.f32', floats(n * n * 4, 0.3)],
    ]),
  );
}

/** A stand-in for the supervisor that records what it's asked to do. */
function fakeSupervisor(fake: Fakes): Supervisor {
  return {
    async call(act, claims, body) {
      fake.supCalls.push({ act, claims, ...(body ? { body } : {}) });
      if (act === 'sandbox.start' || act === 'sandbox.launch' || act === 'connect.launch')
        return (claims.sha === INSTALLED ? { ok: true } : { ok: false, error: 'changed' }) as never;
      if (act === 'sandbox.status') return { running: true } as never;
      if (act === 'sandbox.activity') return { at: fake.assistantPrintedAt } as never;
      if (act === 'egress.blocked') return { blocked: [] } as never;
      if (act === 'preview.status') return { status: fake.previewStatus } as never;
      if (act === 'containers.list') return { containers: fake.containers } as never;
      if (act === 'workspace.upload') return { name: body?.name, running: true } as never;
      if (act === 'workspace.pictures') return fake.pictureListing as never;
      if (act === 'workspace.write' && /\.md(\.before-update)?$/.test(String(body?.path)))
        fake.instructionFiles.set(
          `${claims.ws}/${body?.path}`,
          Buffer.from(String(body?.data), 'base64'),
        );
      if (act === 'job.wait') return { done: true, code: 0, result: {}, error: '' } as never;
      if (act === 'bake.slots') return { parallel: 2, cpus: 2 } as never;
      if (act === 'bake.wait')
        return (
          fake.bake === 'fail'
            ? {
                done: true,
                code: 1,
                timedOut: false,
                outOfMemory: false,
                minutes: 30,
                error:
                  'Blender 4.0.2\nTraceback (most recent call last):\nTypeError: something broke\nError: script failed, exiting.\nBlender quit',
              }
            : fake.bake === 'timeout'
              ? {
                  done: true,
                  code: 124,
                  timedOut: true,
                  outOfMemory: false,
                  minutes: 30,
                  error: '',
                }
              : { done: true, code: 0, timedOut: false, outOfMemory: false, minutes: 30, error: '' }
        ) as never;
      if (act === 'workspace.changes')
        return {
          files: [
            { path: 'src/main.ts', change: 'changed' },
            { path: 'src/scenes/level.ts', change: 'added' },
          ],
          more: false,
        } as never;
      if (act === 'workspace.uploads')
        return { files: [{ name: 'level-1.json', bytes: 27, at: 1_790_000_000 }] } as never;
      if (act === 'sandbox.check')
        return {
          ok: true,
          report: {
            ok: false,
            checks: [{ status: 'fail', title: 'The screen is blank', fix: 'Draw something' }],
          },
        } as never;
      return { ok: true } as never;
    },
    async raw(act, claims, body) {
      fake.supCalls.push({ act, claims, ...(body ? { body } : {}) });
      if (act === 'workspace.read' && body?.path === 'plan.json' && fake.workspacePlan !== null)
        return Buffer.from(JSON.stringify(fake.workspacePlan));
      if (act === 'workspace.read' && fake.instructionFiles.has(`${claims.ws}/${body?.path}`))
        return fake.instructionFiles.get(`${claims.ws}/${body?.path}`) ?? null;
      if (act === 'workspace.read' && fake.workspaceFiles.has(String(body?.path)))
        return fake.workspaceFiles.get(String(body?.path)) ?? null;
      if (act === 'preview.file') return Buffer.from(`preview of ${body?.path}`);
      if (act === 'workspace.view') {
        if (body?.path === 'huge.png') throw new SupervisorError('Supervisor: 413', 413);
        return fake.workspaceFiles.get(String(body?.path)) ?? null;
      }
      if (act === 'bake.files') {
        const room = fake.supCalls.findLast(
          (c) => c.act === 'bake.room' && c.body?.slot === body?.slot,
        );
        return fakeBake(room?.body?.input as string | undefined);
      }
      return act === 'workspace.archive' ? fake.workspaceArchive : null;
    },
    terminalUrl: () => 'ws://127.0.0.1:1/unused',
  };
}

/**
 * A fresh install in its own scratch database: migrated, not set up yet (`setupCode` opens the
 * wizard). By default it sends email and has voice chat and the Studio, all through fakes that
 * record what they're asked (`fake`); `close()` drops the database.
 */
export async function createTestApp(options: TestAppOptions = {}) {
  if (!adminUrl) throw new Error('TEST_DATABASE_URL is not set');
  const dbName = `ats_test_${randomBytes(4).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const db = createDb(url.toString());
  let app: FastifyInstance | undefined;
  const close = async () => {
    await app?.close();
    await db.close();
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.end();
  };
  try {
    await runMigrations(db);
    const secret = randomBytes(32).toString('hex');
    const realtimeSecret = randomBytes(32).toString('hex');
    const storage = createMemoryStorage();
    const fake = createFakes();
    const supervisor = fakeSupervisor(fake);
    const notifyTransport: NotifyTransport = {
      async push(target, payload) {
        fake.pushed.push({ endpoint: target.endpoint, payload });
      },
      async mail(message) {
        fake.mailed.push(message);
      },
    };
    const base = {
      NODE_ENV: 'test',
      ATS_PUBLIC_URL: ORIGIN,
      ATS_PLAY_URL: PLAY_URL,
      BETTER_AUTH_SECRET: secret,
      REALTIME_SECRET: realtimeSecret,
      ATS_OFFLINE: '1',
      ATS_BAKE: '0',
      ...options.env,
    };
    const blender = options.blender !== undefined ? { blender: options.blender } : {};
    const playAccess = {
      ...(options.playAccessTtlMs !== undefined
        ? { playAccessTtlMs: options.playAccessTtlMs }
        : {}),
      ...(options.connectors ? { connectors: options.connectors } : {}),
      ...(options.sourceHosts ? { sourceHosts: options.sourceHosts } : {}),
      ...(options.buildQueue ? { buildQueue: options.buildQueue } : {}),
    };
    app = options.plain
      ? await buildApp({
          env: base as ServerEnv,
          db,
          auth: createAuth({ db, secret, publicUrl: ORIGIN }),
          storage,
          ...playAccess,
          ...blender,
        })
      : await buildApp({
          env: {
            ...base,
            // Never used: notifications leave through the fake transport below.
            SMTP_URL: 'smtp://127.0.0.1:9',
            // Voice chat is set up (the passes themselves come from the real-time service).
            LIVEKIT_API_KEY: 'LKtest',
          } as ServerEnv,
          db,
          auth: createAuth({
            db,
            secret,
            publicUrl: ORIGIN,
            sendMail: (message) => notifyTransport.mail({ ...message, from: 'test@example.test' }),
          }),
          storage,
          supervisor,
          notifyTransport,
          events: {
            policyChanged: async (id) => {
              fake.announced.push(id);
            },
            memberRemoved: async (groupId, userId) => {
              fake.removals.push({ groupId, userId });
            },
            playing: async () => ({}),
            close: async () => {},
          },
          ...playAccess,
          ...blender,
        });
    const setupCode = (await ensureSetupCode(db, secret)) as string;
    const inject = (app as FastifyInstance).inject.bind(app);

    /** Signs up with the email form (and an invite, if given); doesn't open the email. */
    const signUpOnly = (email: string, invite?: string) =>
      inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          ...(invite ? { 'x-ats-invite': invite } : {}),
        },
        payload: JSON.stringify({ name: 'Visitor', email, password: 'another-long-password' }),
      });
    /** The link in the newest email confirming this address (a path on the app's origin). */
    const confirmLink = (email: string) => {
      const text = fake.mailed.findLast(
        (m) => m.to === email && /Confirm your email/.test(m.subject),
      )?.text;
      const link = /https?:\/\/\S+\/api\/auth\/verify-email\?\S+/.exec(text ?? '')?.[0];
      if (!link) return null;
      const url = new URL(link);
      return url.pathname + url.search;
    };
    /** Signs up with an invite and opens the confirmation link from the email, as a person does. */
    const signUp = async (email: string, invite?: string) => {
      const res = await signUpOnly(email, invite);
      const link = res.statusCode === 200 ? confirmLink(email) : null;
      if (!link) return res;
      const confirmed = await inject({ method: 'GET', url: link });
      return { statusCode: res.statusCode, json: () => res.json(), headers: confirmed.headers };
    };
    /** Makes every insert into a table fail until the returned function is called. */
    const failInsertsInto = async (table: string) => {
      await db.execute(
        sql.raw(`create or replace function ats_test_fail() returns trigger language plpgsql as
          $$ begin raise exception 'test: inserts into % fail', tg_table_name; end $$;
          create trigger ats_test_fail before insert on ${table}
          for each row execute function ats_test_fail();`),
      );
      return () => db.execute(sql.raw(`drop trigger ats_test_fail on ${table}`));
    };
    /** A signed-in person who is not a member of the group (signed up with a link, then taken out). */
    let outsiderCookie = '';
    const signUpOutsider = async (architectCookie: string, groupId: string) => {
      if (outsiderCookie) return outsiderCookie;
      const inv = await inject({
        method: 'POST',
        url: `/api/groups/${groupId}/invite-links`,
        headers: { cookie: architectCookie },
        payload: {},
      });
      const res = await signUp('outsider@example.test', new URL(inv.json().url).hash.slice(1));
      outsiderCookie = cookieFrom(res.headers);
      // Signing up with the link put them in the group; this one stays outside it.
      const outsider = (
        await inject({ method: 'GET', url: '/api/me', headers: { cookie: outsiderCookie } })
      ).json().user.id as string;
      await db.delete(schema.memberships).where(eq(schema.memberships.userId, outsider));
      return outsiderCookie;
    };

    return {
      app: app as FastifyInstance,
      db,
      storage,
      /** The install's BETTER_AUTH_SECRET (also what setup codes are sealed with). */
      secret,
      realtimeSecret,
      /** The setup code of this fresh install. */
      setupCode,
      supervisor,
      /** Everything the fakes recorded, and what they answer: tests read and change it freely. */
      fake,
      signUpOnly,
      confirmLink,
      signUp,
      failInsertsInto,
      signUpOutsider,
      /** Closes the app and drops its database. */
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

/** A group as the first tests leave it. */
export interface Group {
  groupId: string;
  /** Pat, who set the server up. */
  architectCookie: string;
  /** Sam, who joined with a single-use invite link (named "Visitor"). */
  memberCookie: string;
}

/**
 * Sets the install up and brings a member in, exactly as the setup and invite tests do: Pat
 * (pat@example.test) is the Architect of "Test House"; Sam (sam@example.test) joins with a
 * single-use link and confirms their email.
 */
export async function seedGroup(t: TestApp): Promise<Group> {
  const setup = await t.app.inject({
    method: 'POST',
    url: '/api/setup/complete',
    payload: setupBody(t.setupCode),
  });
  expect(setup.statusCode).toBe(200);
  const groupId = setup.json().groupId as string;
  const architectCookie = cookieFrom(setup.headers);
  const link = await t.app.inject({
    method: 'POST',
    url: `/api/groups/${groupId}/invite-links`,
    headers: { cookie: architectCookie },
    payload: { maxUses: 1 },
  });
  expect(link.statusCode).toBe(200);
  const token = new URL(link.json().url).hash.slice(1);
  const joined = await t.signUp('sam@example.test', token);
  expect(joined.statusCode).toBe(200);
  const memberCookie = cookieFrom(joined.headers);
  const accept = await t.app.inject({
    method: 'POST',
    url: '/api/invites/accept',
    headers: { cookie: memberCookie },
    payload: { token },
  });
  expect(accept.statusCode).toBe(200);
  return { groupId, architectCookie, memberCookie };
}

/** Adds the studio-apartment sample to the group and waits until it's built; its id. */
export async function addSampleSpace(t: TestApp, architectCookie: string, groupId: string) {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/groups/${groupId}/sample-spaces`,
    headers: { cookie: architectCookie },
    payload: { sample: 'studio-apartment' },
  });
  expect(res.statusCode).toBe(200);
  const spaceId = res.json().spaceId as string;
  const status = async () =>
    (
      await t.app.inject({
        method: 'GET',
        url: '/api/spaces',
        headers: { cookie: architectCookie },
      })
    )
      .json()
      .spaces.find((s: { id: string }) => s.id === spaceId)?.status;
  await vi.waitFor(async () => expect(await status()).not.toBe('building'), {
    timeout: 20_000,
    interval: 100,
  });
  expect(await status()).toBe('ready');
  return spaceId;
}

/**
 * Publishes "Sofa stories" on the sample's sofa, as the creation tests do first: a sample with a
 * creation in it, and an object that already holds one.
 */
export async function addSofaCreation(t: TestApp, groupId: string, spaceId: string) {
  return publishCreation(t.db, t.storage, {
    groupId,
    spaceId,
    objectKey: 'sofa',
    title: 'Sofa stories',
    files: new Map([
      [
        'index.html',
        new TextEncoder().encode('<!doctype html><script type="module" src="./main.js"></script>'),
      ],
      ['main.js', new TextEncoder().encode('console.log("hello from a creation")')],
    ]),
    sdkVersion: '0.1.0',
    protocolVersion: 1,
  });
}

/** A tiny model (a 20 cm pyramid) as a .glb, the kind an assistant makes for a place. */
export function pyramidGlb(): Buffer {
  const corners = [
    [0, 0, 0],
    [0.2, 0, 0],
    [0, 0, 0.2],
    [0.1, 0.2, 0.1],
  ];
  const faces = [
    [0, 2, 1],
    [0, 1, 3],
    [1, 2, 3],
    [2, 0, 3],
  ];
  const bin = Buffer.from(new Float32Array(faces.flat().flatMap((i) => corners[i] ?? [])).buffer);
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 12,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [0.2, 0.2, 0.2],
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: bin.length }],
      buffers: [{ byteLength: bin.length }],
    }),
  );
  const pad = (b: Buffer, fill: number) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const chunk = (data: Buffer, type: number) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  const body = Buffer.concat([chunk(pad(json, 0x20), 0x4e4f534a), chunk(pad(bin, 0), 0x004e4942)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}
