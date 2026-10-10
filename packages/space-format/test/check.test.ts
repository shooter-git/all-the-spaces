import { describe, expect, it } from 'vitest';
import { checkPlan } from '../src/check.ts';

const base = () => ({
  name: 'Flat',
  spaceType: 'apartment',
  floors: [{ key: 'f1', name: 'Flat', elevation: 0, height: 2.6 }],
  rooms: [
    { key: 'hall', name: 'Hall', floor: 'f1', rect: [0, 0, 2, 3] },
    { key: 'living', name: 'Living room', floor: 'f1', rect: [2, 0, 7, 4] },
    { key: 'bed', name: 'Bedroom', floor: 'f1', rect: [0, 3, 2, 6] },
  ],
  openings: [
    { kind: 'door', rooms: ['hall', 'living'], at: [2, 1.5] },
    { kind: 'door', rooms: ['hall', 'bed'], at: [1, 3] },
    { kind: 'window', room: 'living', side: 'north', at: 4.5, width: 1.6 },
  ],
  furniture: [{ key: 'sofa', room: 'living', kind: 'sofa', label: 'Sofa', at: [4.5, 3.2] }],
  spawns: [{ key: 'door', room: 'hall', at: [1, 1] }],
});
const messages = (plan: unknown) => checkPlan(plan).problems.map((p) => `${p.level}: ${p.message}`);

describe('checking a plan', () => {
  it('accepts a sound plan', () => {
    expect(messages(base())).toEqual([]);
  });

  it('finds rooms nobody can reach', () => {
    const p = base();
    p.openings = p.openings.filter((o) => !('rooms' in o) || o.rooms?.[1] !== 'bed');
    expect(messages(p)).toContain("error: Bedroom can't be reached from where people start.");
  });

  it("explains doors between rooms that don't share a wall, and walls that nearly meet", () => {
    const p = base();
    p.rooms[2] = { key: 'bed', name: 'Bedroom', floor: 'f1', rect: [0, 3.03, 2, 6] };
    const m = messages(p);
    expect(m).toContain("error: The door between Hall and Bedroom: they don't share a wall.");
    expect(m).toContain('warning: Hall and Bedroom almost share a wall (z = 3 and 3.03).');
  });

  it("finds overlapping rooms, doors that don't fit, windows off the wall, and furniture outside", () => {
    const p = base();
    p.rooms[1] = { key: 'living', name: 'Living room', floor: 'f1', rect: [1.5, 0, 7, 4] };
    p.openings[2] = { kind: 'window', room: 'living', side: 'north', at: 6.8, width: 1.6 };
    p.furniture[0] = { key: 'sofa', room: 'living', kind: 'sofa', label: 'Sofa', at: [9, 3] };
    const m = messages(p);
    expect(m.some((x) => x.startsWith('error: Hall and Living room overlap'))).toBe(true);
    expect(m.some((x) => x.startsWith('error: A window in the north wall of Living room'))).toBe(
      true,
    );
    expect(m).toContain('error: Sofa is outside Living room (at 9.00 m, 3.00 m).');
  });

  it('turns schema mistakes into readable problems', () => {
    const p = base() as Record<string, unknown>;
    p.spaceType = 'castle';
    expect(messages(p)[0]).toMatch(/^error: plan.json spaceType/);
  });

  it('refuses keys that could clash or cause trouble', () => {
    const p = base();
    p.furniture.push({ key: 'sofa', room: 'living', kind: 'sofa', label: 'Sofa', at: [4, 2] });
    p.rooms[0] = { ...p.rooms[0], key: 'Hall Way' } as (typeof p.rooms)[number];
    const m = messages(p);
    expect(m).toContain('error: Two pieces of furniture share the key "sofa".');
    expect(m.some((x) => x.includes('"Hall Way" isn\'t allowed'))).toBe(true);
  });

  it('checks stairs: real floors, going up, in their stairwell, and fitting in it', async () => {
    const { readFile } = await import('node:fs/promises');
    const sample = JSON.parse(
      await readFile(
        new URL('../../../samples/two-floor-building/plan.json', import.meta.url),
        'utf8',
      ),
    );
    expect(messages(sample)).toEqual([]);
    const flight = sample.stairs[0];
    const variant = (change: object) => ({ ...sample, stairs: [{ ...flight, ...change }] });
    expect(messages(variant({ to: 'f9' }))[0]).toMatch(/between floors that don't exist/);
    expect(messages(variant({ from: flight.to, to: flight.from }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/go from .* down to/)]),
    );
    expect(messages(variant({ run: 9 }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/don't fit in it/)]),
    );
    expect(messages(variant({ run: 2 }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/very steep/)]),
    );
    const flat = {
      ...sample,
      rooms: sample.rooms.map((r: { key: string }) =>
        r.key === flight.room ? { ...r, spansTo: undefined } : r,
      ),
    };
    expect(messages(flat)).toEqual(
      expect.arrayContaining([expect.stringMatching(/isn't a stairwell between them/)]),
    );
  });
});
