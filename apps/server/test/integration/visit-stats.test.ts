// Where people spend time, over a period: visits, time together, moves, devices, hours.
// Runs against a real Postgres (see ../harness.ts); skipped without TEST_DATABASE_URL.
import { randomUUID } from 'node:crypto';
import type { PlaceVisits } from '@ats/api-types';
import { schema } from '@ats/db';
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
const DAY = 24 * 60 * MIN;

describe.skipIf(!adminUrl)('where people spend time, over a period', () => {
  let t: TestApp;
  let app: FastifyInstance;
  let architectCookie = '';
  let spaceId = '';
  let creationId = '';
  let pat = '';
  let sam = '';
  // Yesterday (UTC) at midnight: every visit is at a set time of an earlier day.
  const yesterday = Math.floor(Date.now() / DAY) * DAY - DAY;
  const at = (daysBefore: number, hour: number, minute = 0) =>
    yesterday - (daysBefore - 1) * DAY + hour * 60 * MIN + minute * MIN;

  const me = async (cookie: string) =>
    (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().user
      .id as string;
  const stats = async (query: string) =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/spaces/${spaceId}/visits?${query}`,
        headers: { cookie: architectCookie },
      })
    ).json() as PlaceVisits;

  beforeAll(async () => {
    t = await createTestApp();
    app = t.app;
    const seeded = await seedGroup(t);
    architectCookie = seeded.architectCookie;
    spaceId = await addSampleSpace(t, architectCookie, seeded.groupId);
    const sofa = await addSofaCreation(t, seeded.groupId, spaceId);
    creationId = sofa.creationId;
    pat = await me(architectCookie);
    sam = await me(seeded.memberCookie);
    const room = (userId: string, roomKey: string, from: number, to: number, device: string) => ({
      id: randomUUID(),
      userId,
      device,
      spaceId,
      roomKey,
      startedAt: from,
      endedAt: to,
    });
    const play = (userId: string, session: string, from: number, to: number, device: string) => ({
      id: randomUUID(),
      userId,
      device,
      creationId,
      versionId: sofa.versionId,
      session,
      startedAt: from,
      endedAt: to,
    });
    const started = [
      // Yesterday: Sam on a phone, in the living room and then straight into the entry, with
      // the sofa's creation open for a while; Pat joins them in both, from a computer.
      room(sam, 'living', at(1, 10), at(1, 10, 30), 'phone'),
      room(sam, 'hall', at(1, 10, 30), at(1, 10, 40), 'phone'),
      play(sam, 'session-1', at(1, 10, 5), at(1, 10, 15), 'phone'),
      play(pat, 'session-1', at(1, 10, 5), at(1, 10, 10), 'computer'),
      room(pat, 'living', at(1, 10, 10), at(1, 10, 20), 'computer'),
      // Sam comes back in the afternoon.
      room(sam, 'living', at(1, 14), at(1, 14, 20), 'phone'),
      // Two days before, on a computer; and three weeks ago.
      room(sam, 'bath', at(3, 9), at(3, 9, 10), 'computer'),
      room(sam, 'bath', at(21, 9), at(21, 9, 10), 'computer'),
    ] as VisitBatch['started'];
    const res = await app.inject({
      method: 'POST',
      url: '/internal/visits',
      headers: { 'x-realtime-secret': t.realtimeSecret },
      payload: { now: Date.now(), started, ended: [] },
    });
    expect(res.json()).toEqual({ recorded: started.length });
  });

  afterAll(async () => {
    await t?.close();
  });

  it('keeps the kind of device, and the session of a creation', async () => {
    const rows = await t.db
      .select()
      .from(schema.visits)
      .where(eq(schema.visits.creationId, creationId));
    expect(rows.map((r) => [r.device, r.session]).sort()).toEqual([
      ['computer', 'session-1'],
      ['phone', 'session-1'],
    ]);
  });

  it('adds up visits, people, and time spent together', async () => {
    const week = await stats('days=7&tz=UTC');
    expect(week).toMatchObject({ days: 7, kept: 90, recording: true, timeZone: 'UTC' });
    // Sam: 40 min (the creation was open in the room), 20 min and 10 min; Pat: 15 min.
    expect(week.summary).toEqual({
      seconds: 85 * 60,
      people: 2,
      visits: 4,
      typicalSeconds: ((15 + 20) / 2) * 60,
      cameBack: 1,
      togetherSeconds: 2 * 10 * 60,
      roomSeconds: 80 * 60,
    });
    const room = (key: string) => week.rooms.find((r) => r.key === key);
    expect(room('living')).toMatchObject({
      name: 'Living room',
      people: 2,
      seconds: 60 * 60,
      visits: 3,
      togetherSeconds: 20 * 60,
    });
    expect(room('hall')).toMatchObject({ people: 1, seconds: 10 * 60, visits: 1 });
    expect(room('balcony')).toMatchObject({ people: 0, seconds: 0, visits: 0 });
    expect(week.creations).toEqual([
      {
        id: creationId,
        title: 'Sofa stories',
        people: 2,
        seconds: 15 * 60,
        visits: 2,
        togetherSeconds: 2 * 5 * 60,
      },
    ]);
    expect(week.moves).toEqual([{ from: 'living', to: 'hall', times: 1 }]);
    expect(week.devices).toEqual([
      { device: 'phone', seconds: 60 * 60 },
      { device: 'computer', seconds: 25 * 60 },
    ]);
  });

  it("shows each person's rooms, creations, devices and hours", async () => {
    const week = await stats('days=7&tz=UTC');
    const person = (id: string) => week.people.find((p) => p.userId === id);
    expect(week.people.map((p) => p.userId)).toEqual([sam, pat]);
    expect(person(sam)).toMatchObject({
      seconds: 70 * 60,
      inCreations: 10 * 60,
      days: 2,
      visits: 3,
      typicalSeconds: 20 * 60,
      togetherSeconds: 15 * 60,
      creations: [{ id: creationId, seconds: 10 * 60 }],
      devices: [
        { device: 'phone', seconds: 60 * 60 },
        { device: 'computer', seconds: 10 * 60 },
      ],
    });
    expect(person(sam)?.rooms[0]).toEqual({ key: 'living', seconds: 50 * 60 });
    expect(new Map(person(sam)?.rooms.map((r) => [r.key, r.seconds]))).toEqual(
      new Map([
        ['living', 50 * 60],
        ['hall', 10 * 60],
        ['bath', 10 * 60],
      ]),
    );
    // (Times are shifted onto the server's clock: a few milliseconds.)
    expect(Date.parse(person(sam)?.lastAt ?? '')).toBeCloseTo(at(1, 14, 20), -2);
    const hours = person(sam)?.hours ?? [];
    expect([hours[9], hours[10], hours[14]]).toEqual([600, 2400, 1200]);
    expect(person(pat)).toMatchObject({ seconds: 15 * 60, visits: 1, days: 1 });
  });

  it('goes day by day, and by weekday and hour, in the time zone asked for', async () => {
    const utc = await stats('days=7&tz=UTC');
    expect(utc.trend).toHaveLength(7);
    expect(utc.trend.every((d) => d.days === 1)).toBe(true);
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect(utc.trend.find((d) => d.from === day(at(1, 0)))).toMatchObject({
      seconds: 75 * 60,
      people: 2,
    });
    expect(utc.trend.find((d) => d.from === day(at(3, 0)))).toMatchObject({
      seconds: 10 * 60,
      people: 1,
    });
    const weekday = (new Date(at(1, 0)).getUTCDay() + 6) % 7;
    expect(utc.week[weekday]?.[10]).toBe(55 * 60);
    // Tokyo is nine hours ahead (and never changes its clocks).
    const tokyo = await stats('days=7&tz=Asia/Tokyo');
    expect(tokyo.timeZone).toBe('Asia/Tokyo');
    expect(tokyo.week[weekday]?.[19]).toBe(55 * 60);
    expect(tokyo.people.find((p) => p.userId === sam)?.hours[23]).toBe(20 * 60);
    // A zone nobody has heard of is UTC.
    expect((await stats('days=7&tz=Mars/Olympus')).timeZone).toBe('UTC');
  });

  it('looks back as far as asked: three weeks ago counts in 30 days, in weeks for 90', async () => {
    expect((await stats('days=30&tz=UTC')).summary).toMatchObject({
      seconds: 95 * 60,
      visits: 5,
    });
    const all = await stats('days=90&tz=UTC');
    expect(all.trend.length).toBeGreaterThanOrEqual(13);
    expect(all.trend.reduce((n, w) => n + w.days, 0)).toBe(90);
    expect(all.trend.slice(1).every((w) => new Date(`${w.from}T00:00:00Z`).getUTCDay() === 1)).toBe(
      true,
    );
    expect(all.trend.reduce((n, w) => n + w.seconds, 0)).toBe(95 * 60);
    // Asking for something else is the longest period.
    expect((await stats('days=12')).days).toBe(90);
  });
});
