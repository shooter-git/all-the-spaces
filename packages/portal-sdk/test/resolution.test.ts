import { describe, expect, it } from 'vitest';
import { ResolutionGovernor } from '../src/resolution.ts';

/** Feeds `seconds` of frames taking `ms` each; returns the time reached. */
function run(g: ResolutionGovernor, ms: number, seconds: number, from = 0) {
  let t = from;
  while (t < from + seconds * 1000) {
    t += ms;
    g.frame(ms, t);
  }
  return t;
}

describe('dynamic resolution', () => {
  it('stays at full resolution while frames are smooth', () => {
    const g = new ResolutionGovernor();
    run(g, 16.7, 10);
    expect(g.scale).toBe(1);
  });

  it('draws fewer pixels when frames are slow, down to the minimum', () => {
    const g = new ResolutionGovernor({ min: 0.5 });
    let t = run(g, 30, 3);
    expect(g.scale).toBeLessThan(1);
    t = run(g, 30, 30, t);
    expect(g.scale).toBe(0.5);
  });

  it('goes back up after smooth seconds, and waits longer if that was too much', () => {
    const g = new ResolutionGovernor();
    // Each change is judged on the next full second, so allow one second between phases.
    let t = run(g, 30, 4);
    t = run(g, 16.7, 1.1, t);
    const low = g.scale;
    t = run(g, 16.7, 8, t); // smooth: back up
    expect(g.scale).toBeGreaterThan(low);
    t = run(g, 30, 2, t); // that was too much: down, and more patience
    t = run(g, 16.7, 1.1, t);
    const after = g.scale;
    t = run(g, 16.7, 4, t);
    expect(g.scale).toBe(after); // not yet
    run(g, 16.7, 6, t);
    expect(g.scale).toBeGreaterThan(after);
  });

  it('ignores a long gap (a hidden tab), and a single hitch', () => {
    const g = new ResolutionGovernor();
    let t = 0;
    for (let i = 0; i < 300; i++) {
      t += i === 100 ? 2000 : i === 150 ? 60 : 16.7;
      g.frame(i === 100 ? 2000 : i === 150 ? 60 : 16.7, t);
    }
    expect(g.scale).toBe(1);
  });
});
