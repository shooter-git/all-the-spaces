import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPlan } from '../src/check.ts';
import {
  earthPoint,
  planDirection,
  planPoint,
  SpacePlan,
  slopeAt,
  structureCopies,
} from '../src/plan.ts';

const sample = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../samples/${name}/plan.json`, import.meta.url), 'utf8'));
const messages = (plan: unknown) => checkPlan(plan).problems.map((p) => `${p.level}: ${p.message}`);

describe('places built from the outside in', () => {
  it('leaves plans without the new parts exactly as they were', () => {
    for (const name of ['studio-apartment', 'two-floor-building']) {
      const plan = SpacePlan.parse(sample(name));
      expect('site' in plan || 'structure' in plan).toBe(false);
      expect(plan.rooms.some((r) => 'slope' in r || 'parapet' in r)).toBe(false);
    }
  });

  it('accepts the sloping sample: open decks, a ramp, a sloping street and structure', () => {
    expect(messages(sample('sloping-site'))).toEqual([]);
  });

  it('measures a sloping floor', () => {
    const ramp = { rect: [40, 4, 48, 20] as [number, number, number, number] };
    const up = { ...ramp, slope: { toward: 'north' as const, rise: 3 } };
    expect(slopeAt(ramp, 44, 10)).toBe(0);
    expect(slopeAt(up, 44, 20)).toBe(0);
    expect(slopeAt(up, 44, 4)).toBe(3);
    expect(slopeAt(up, 44, 12)).toBeCloseTo(1.5);
    // Outside the room, it doesn't keep climbing.
    expect(slopeAt(up, 44, -10)).toBe(3);
    expect(slopeAt({ ...ramp, slope: { toward: 'east', rise: 2 } }, 46, 0)).toBeCloseTo(1.5);
  });

  it("finds floors that don't meet at a ramp, stairs on a slope and no head room", () => {
    const p = sample('sloping-site');
    const ramp = p.rooms.find((r: { key: string }) => r.key === 'ramp');
    ramp.slope.rise = 2.5;
    expect(messages(p)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^error: The floors don't meet at the opening between Ramp and Landing: Ramp is at 2.50 m there, Landing at 3.00 m/,
        ),
      ]),
    );
    ramp.slope.rise = 3;
    p.stairs = [
      {
        room: 'ramp',
        start: [44, 18],
        direction: 'north',
        width: 1,
        run: 4,
        from: 'lower',
        to: 'upper',
      },
    ];
    expect(messages(p)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^error: Ramp holds stairs but its floor slopes/),
      ]),
    );
    p.stairs = [];
    // A room on the floor above, over the ramp.
    p.rooms.push({ key: 'office', name: 'Office', floor: 'upper', rect: [40, 8, 48, 12] });
    p.openings.push({ kind: 'open', rooms: ['office', 'upper-deck'], at: [40, 10], width: 2 });
    expect(messages(p)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^warning: Ramp rises to .* under Office/)]),
    );
  });

  it('keeps structure inside its room, and warns about a parapet indoors', () => {
    const p = sample('sloping-site');
    p.structure.push({
      room: 'lower-deck',
      label: 'Column',
      at: [5, 8],
      size: [0.5, 2.9, 0.5],
      repeat: { count: 9, step: [5, 0] },
    });
    p.structure.push({ room: 'attic', at: [1, 1], size: [1, 1, 1] });
    p.rooms[0].outdoor = false;
    const m = messages(p);
    expect(m).toContain('error: Column in Lower deck is outside it (at 45.00 m, 8.00 m).');
    expect(m).toContain('error: A piece of structure is in a room that doesn\'t exist ("attic").');
    expect(m).toContain("warning: Lower deck has a parapet but isn't outdoors.");
  });

  it('lays out rows of structure', () => {
    expect(
      structureCopies({
        room: 'r',
        at: [1, 2],
        size: [1, 1, 1],
        elevation: 0,
        rotation: 0,
        material: 'concrete',
        repeat: { count: 3, step: [2, -1] },
      }),
    ).toEqual([
      [1, 2],
      [3, 1],
      [5, 0],
    ]);
  });

  it('puts places on Earth and back, whichever way the plan faces', () => {
    for (const bearing of [0, 20, -35, 90, 200]) {
      const site = { lat: 30.27, lng: -97.75, bearing };
      for (const [x, z] of [
        [0, 0],
        [84, 0],
        [-12.5, 40],
      ] as const) {
        const [lat, lng] = earthPoint(site, x, z);
        const [bx, bz] = planPoint(site, lat, lng);
        expect(bx).toBeCloseTo(x, 6);
        expect(bz).toBeCloseTo(z, 6);
      }
    }
    // North-up: a point 100 m north is 100 m towards -z; east is +x.
    const north = { lat: 0, lng: 0, bearing: 0 };
    const [nx, nz] = planPoint(north, 100 / 111_195, 0);
    expect(nx).toBeCloseTo(0, 1);
    expect(nz).toBeCloseTo(-100, 0);
    const [ex] = planPoint(north, 0, 100 / 111_195);
    expect(ex).toBeCloseTo(100, 0);
    // The plan's top faces east: north on Earth is towards -x.
    const east = { lat: 0, lng: 0, bearing: 90 };
    const [px, pz] = planPoint(east, 100 / 111_195, 0);
    expect(px).toBeCloseTo(-100, 0);
    expect(pz).toBeCloseTo(0, 1);
    // Looking along the plan's north is looking at its bearing.
    const [dx, dz] = planDirection({ bearing: 20 }, 20);
    expect(dx).toBeCloseTo(0);
    expect(dz).toBeCloseTo(-1);
  });
});
