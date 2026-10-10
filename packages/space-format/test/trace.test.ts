import { describe, expect, it } from 'vitest';
import { traceFor } from '../src/index.ts';

const one = { image: 'inputs/plan-1.jpg', metresPerPixel: 0.01, origin: [120, 80] };

describe('trace.json', () => {
  it("finds each floor's calibration", () => {
    const raw = { floors: { f1: one, f2: { ...one, image: 'inputs/plan-2.jpg' } } };
    expect(traceFor(raw, 'f2', 'f1')).toEqual({ ...one, image: 'inputs/plan-2.jpg', floor: 'f2' });
    expect(traceFor(raw, 'roof', 'f1')).toBeNull();
  });

  it('reads the older single calibration as the first floor, or the floor it names', () => {
    expect(traceFor(one, 'f1', 'f1')).toEqual(one);
    expect(traceFor(one, 'f2', 'f1')).toBeNull();
    expect(traceFor({ ...one, floor: 'f2' }, 'f2', 'f1')).toMatchObject({ floor: 'f2' });
  });

  it('ignores a file that is not a calibration', () => {
    expect(traceFor(null, 'f1', 'f1')).toBeNull();
    expect(traceFor({ ...one, metresPerPixel: -1 }, 'f1', 'f1')).toBeNull();
    expect(traceFor({ floors: { f1: { image: '' } } }, 'f1', 'f1')).toBeNull();
  });
});
