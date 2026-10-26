// Visits: time people spend in each room of a place and in each creation.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { randomUUID } from 'node:crypto';
import type { PlaceVisits } from '@ats/api-types';
import { type Db, schema, VISIT_STALE_MS } from '@ats/db';
import type { VisitBatch } from '@ats/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSampleSpace,
  addSofaCreation,
  adminUrl,
  createTestApp,
  seedGroup,
  type TestApp,
} from '../harness.ts';

const MIN = 60_000;

describe.skipIf(!adminUrl)('visits', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let db: Db;
  let architectCookie = '';
  let memberCookie = '';
  let groupId = '';
  let spaceId = '';
  let creationId = '';
  let versionId = '';
  let pat = '';
  let sam = '';
  let outsider = '';
  const ids = Array.from({ length: 8 }, () => randomUUID());

  const me = async (cookie: string) =>
    (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().user
      .id as string;

  beforeAll(async () => {
    t = await createTestApp();
    ({ app, db } = t);
    ({ architectCookie, memberCookie, groupId } = await seedGroup(t));
    spaceId = await addSampleSpace(t, architectCookie, groupId);
    ({ creationId, versionId } = await addSofaCreation(t, groupId, spaceId));
    pat = await me(architectCookie);
    sam = await me(memberCookie);
    outsider = await me(await t.signUpOutsider(architectCookie, groupId));
  });

  afterAll(async () => {
    await t?.close();
  });

  const send = (batch: Partial<VisitBatch>, secret = t.realtimeSecret) =>
    app.inject({
      method: 'POST',
      url: '/internal/visits',
      headers: { 'x-realtime-secret': secret },
      payload: { now: Date.now(), started: [], ended: [], ...batch },
    });
  const row = async (id: string | undefined) =>
    (
      await db
        .select()
        .from(schema.visits)
        .where(eq(schema.visits.id, id as string))
    )[0];
  const totals = async (cookie: string) =>
    app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/visits`, headers: { cookie } });

  it('takes visits only from the real-time service', async () => {
    expect((await send({}, 'x'.repeat(64))).statusCode).toBe(404);
    expect((await send({ started: [{ id: 'nope' } as never] })).statusCode).toBe(400);
    expect((await send({})).statusCode).toBe(200);
  });

  it("records members' time in rooms and creations, never trying a version, never outsiders", async () => {
    const now = Date.now();
    const started: VisitBatch['started'] = [
      { id: ids[0] as string, userId: sam, spaceId, roomKey: 'living', startedAt: now - 30 * MIN },
      {
        id: ids[1] as string,
        userId: sam,
        creationId,
        versionId,
        startedAt: now - 20 * MIN,
        endedAt: now - 10 * MIN,
      },
      { id: ids[2] as string, userId: pat, spaceId, roomKey: 'bath', startedAt: now - 5 * MIN },
      { id: ids[3] as string, userId: outsider, spaceId, roomKey: 'living', startedAt: now },
      // An Architect trying a version that isn't live.
      { id: ids[4] as string, userId: pat, creationId, versionId: randomUUID(), startedAt: now },
    ];
    expect((await send({ started })).json()).toEqual({ recorded: 3 });
    // Sent again (the real-time service didn't hear back): still one of each.
    await send({ started });
    expect(await db.select().from(schema.visits)).toHaveLength(3);
    expect(await row(ids[1])).toMatchObject({ groupId, spaceId, roomKey: null, creationId });
    // Pat leaves the bathroom; Sam is still in the living room (they say so every minute).
    await send({ ended: [{ id: ids[2] as string, at: now }], going: [ids[0] as string] });
    expect((await row(ids[2]))?.endedAt?.getTime()).toBeCloseTo(now, -2);
    const living = await row(ids[0]);
    expect(living?.endedAt).toBeNull();
    expect(living?.seenAt.getTime()).toBeGreaterThan(now - 1000);
  });

  it('shows Architects time in each room and creation, and each person’s time', async () => {
    expect((await totals(memberCookie)).statusCode).toBe(404);
    const res = await totals(architectCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json() as PlaceVisits;
    expect(body.days).toBe(90);
    expect(body.recording).toBe(true);
    const room = (key: string) => body.rooms.find((r) => r.key === key);
    expect(body.rooms[0]).toMatchObject({ key: 'living', name: 'Living room', people: 1 });
    expect(room('living')?.seconds).toBeCloseTo(30 * 60, -1);
    expect(room('bath')).toMatchObject({ people: 1, seconds: 5 * 60 });
    // Every room is there, even those nobody has spent time in yet.
    expect(room('balcony')).toMatchObject({ people: 0, seconds: 0, floor: null });
    expect(body.creations).toEqual([
      {
        id: creationId,
        title: 'Sofa stories',
        people: 1,
        seconds: 600,
        visits: 1,
        togetherSeconds: 0,
      },
    ]);
    // Sam's ten minutes in the creation were also time in the living room: counted once.
    const person = (id: string) => body.people.find((p) => p.userId === id);
    expect(person(sam)?.seconds).toBeCloseTo(30 * 60, -1);
    expect(person(sam)?.inCreations).toBe(600);
    expect(person(pat)).toMatchObject({
      name: expect.any(String),
      seconds: 5 * 60,
      inCreations: 0,
    });
    expect(person(outsider)).toBeUndefined();
  });

  it('ends visits nobody vouches for (their service stopped), when they were last seen', async () => {
    const then = Date.now() - VISIT_STALE_MS - MIN;
    await send({
      started: [{ id: ids[5] as string, userId: pat, spaceId, roomKey: 'hall', startedAt: then }],
    });
    expect((await row(ids[5]))?.endedAt).toBeNull();
    // Another service's heartbeat: Sam's visit is still going, Pat's isn't.
    await send({ going: [ids[0] as string] });
    expect((await row(ids[5]))?.endedAt?.getTime()).toBeCloseTo(then, -2);
    expect((await row(ids[0]))?.endedAt).toBeNull();
  });

  it("shows each person's time in the group's places on People", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/people`,
      headers: { cookie: architectCookie },
    });
    const time = new Map(
      (res.json().people as { userId: string; secondsHere: number }[]).map((p) => [
        p.userId,
        p.secondsHere,
      ]),
    );
    expect(time.get(sam)).toBeGreaterThanOrEqual(30 * 60 - 5);
    expect(time.get(pat)).toBe(5 * 60);
  });

  it('lets Architects turn visit records off: what was recorded goes, and nothing more is', async () => {
    const url = `/api/groups/${groupId}/visit-settings`;
    const get = (cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
    const put = (cookie: string, visits: boolean) =>
      app.inject({ method: 'PUT', url, headers: { cookie }, payload: { visits } });
    expect((await get(architectCookie)).json()).toEqual({ visits: true });
    // Only Architects decide.
    expect((await get(memberCookie)).statusCode).toBe(403);
    expect((await put(memberCookie, false)).statusCode).toBe(403);
    expect(await db.select().from(schema.visits)).toHaveLength(4);

    expect((await put(architectCookie, false)).statusCode).toBe(200);
    expect((await get(architectCookie)).json()).toEqual({ visits: false });
    expect(await db.select().from(schema.visits)).toHaveLength(0);
    // Nothing more is recorded, in rooms or creations.
    const now = Date.now();
    const again: VisitBatch['started'] = [
      { id: ids[6] as string, userId: sam, spaceId, roomKey: 'living', startedAt: now },
      { id: ids[7] as string, userId: sam, creationId, versionId, startedAt: now },
    ];
    expect((await send({ started: again, going: [ids[0] as string] })).json()).toEqual({
      recorded: 0,
    });
    expect(await db.select().from(schema.visits)).toHaveLength(0);
    // The Studio page says it's off; People shows no time.
    expect((await totals(architectCookie)).json()).toMatchObject({
      recording: false,
      rooms: [],
      creations: [],
      people: [],
    });
    const people = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/people`,
      headers: { cookie: architectCookie },
    });
    expect(
      (people.json().people as { secondsHere: number }[]).every((p) => p.secondsHere === 0),
    ).toBe(true);
    // The group's activity says who turned it off.
    const activity = await app.inject({
      method: 'GET',
      url: `/api/groups/${groupId}/activity`,
      headers: { cookie: architectCookie },
    });
    expect(activity.json().entries[0]).toMatchObject({ action: 'visits.settings_changed' });

    // Turned back on, it starts again from nothing.
    expect((await put(architectCookie, true)).statusCode).toBe(200);
    expect((await send({ started: again })).json()).toEqual({ recorded: 2 });
    expect((await totals(architectCookie)).json()).toMatchObject({ recording: true });
  });
});
