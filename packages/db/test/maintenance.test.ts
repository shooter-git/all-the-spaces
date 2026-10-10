// Clean-up jobs against a real Postgres: needs TEST_DATABASE_URL pointing at a server where it may
// create and drop a scratch database (skipped when unset).
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  type Db,
  DEFAULT_CHAT_RETENTION_DAYS,
  deleteExpiredChat,
  deleteOldPerfSamples,
  PERF_RETENTION_DAYS,
  runMigrations,
  schema,
} from '../src/index.ts';

const adminUrl = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!adminUrl)('clean-up', () => {
  const dbName = `ats_test_db_${randomBytes(4).toString('hex')}`;
  let admin: postgres.Sql;
  let db: Db;
  const now = new Date('2026-10-04T03:30:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * DAY);

  beforeAll(async () => {
    admin = postgres(adminUrl as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${dbName}`;
    db = createDb(url.toString());
    await runMigrations(db);
    await db.insert(schema.user).values({ id: 'u1', name: 'Pat', email: 'pat@example.test' });
    await db.insert(schema.groups).values(
      ['keeps-7', 'forever', 'default'].map((id) => ({
        id,
        name: id,
        slug: id,
        createdAt: now,
      })),
    );
    await db.insert(schema.groupSettings).values([
      { groupId: 'keeps-7', chatRetentionDays: 7 },
      { groupId: 'forever', chatRetentionDays: null },
    ]);
  });

  afterAll(async () => {
    await db?.close();
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end();
  });

  const say = (groupId: string, body: string, at: Date) =>
    db
      .insert(schema.chatMessages)
      .values({ groupId, channel: `space:${groupId}`, senderId: 'u1', body, createdAt: at });
  const left = async () =>
    (await db.select({ body: schema.chatMessages.body }).from(schema.chatMessages))
      .map((m) => m.body)
      .sort();

  it("deletes chat older than each group keeps it, the default where a group hasn't chosen", async () => {
    await say('keeps-7', 'a week and a day', ago(8));
    await say('keeps-7', 'six days', ago(6));
    await say('forever', 'years ago', ago(2000));
    await say('default', 'past the default', ago(DEFAULT_CHAT_RETENTION_DAYS + 1));
    await say('default', 'within the default', ago(DEFAULT_CHAT_RETENTION_DAYS - 1));
    expect(await deleteExpiredChat(db, now)).toBe(2);
    expect(await left()).toEqual(['six days', 'within the default', 'years ago']);
    // Nothing more to do the next time.
    expect(await deleteExpiredChat(db, now)).toBe(0);
  });

  it('deletes performance samples once they are older than the retention period', async () => {
    const sample = (createdAt: Date) => ({
      groupId: 'default',
      kind: 'space' as const,
      tier: 'mid' as const,
      device: 'phone-ios-6c',
      fps: 60,
      p50Ms: 16,
      p95Ms: 20,
      scale: 1,
      createdAt,
    });
    await db
      .insert(schema.perfSamples)
      .values([sample(ago(PERF_RETENTION_DAYS + 1)), sample(ago(PERF_RETENTION_DAYS - 1))]);
    expect(await deleteOldPerfSamples(db, now)).toBe(1);
    expect(await db.select().from(schema.perfSamples)).toHaveLength(1);
  });
});
