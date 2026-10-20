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

describe('dynamic resolution when the processor holds frames up', () => {
  /** Feeds frames whose time depends on the scale: `fixed` ms of processor work plus pixels. */
  function runScaled(
    g: ResolutionGovernor,
    cost: (scale: number) => number,
    seconds: number,
    from = 0,
  ) {
    let t = from;
    while (t < from + seconds * 1000) {
      const ms = cost(g.scale);
      t += ms;
      g.frame(ms, t);
    }
    return t;
  }

  it('puts the pixels back when fewer of them made frames no faster', () => {
    const g = new ResolutionGovernor({ min: 0.6, detectCpuBound: true });
    // 37 ms a frame however few pixels are drawn (a 12-core laptop at 27 fps).
    const scales: number[] = [];
    let t = 0;
    while (t < 8000) {
      t += 37;
      if (g.frame(37, t)) scales.push(g.scale);
    }
    expect(scales).toEqual([0.85, 1]);
    expect(g.scale).toBe(1);
  });

  it('tries fewer pixels again later, and waits longer each time', () => {
    const g = new ResolutionGovernor({ min: 0.6, detectCpuBound: true });
    const steps: number[] = [];
    let t = 0;
    while (t < 60_000) {
      t += 37;
      if (g.frame(37, t) && g.scale < 1) steps.push(Math.round(t / 1000));
    }
    // Once at the start, after about 10 s, then 20 s after that (and then not before 40 s more).
    expect(steps.length).toBe(3);
    expect((steps[2] ?? 0) - (steps[1] ?? 0)).toBeGreaterThan((steps[1] ?? 0) - (steps[0] ?? 0));
  });

  it('keeps going down while fewer pixels do help', () => {
    const g = new ResolutionGovernor({ min: 0.5, detectCpuBound: true });
    runScaled(g, (s) => 8 + 30 * s * s, 30);
    expect(g.scale).toBeLessThan(0.85);
  });

  it('is off unless asked for (creations keep the old behaviour)', () => {
    const g = new ResolutionGovernor({ min: 0.6 });
    run(g, 37, 30);
    expect(g.scale).toBe(0.6);
  });
});

describe('giving up something cheaper before pixels', () => {
  it('sheds first, then pixels; brings pixels back first, then what it shed', () => {
    let effect = true;
    const g = new ResolutionGovernor({
      min: 0.6,
      shed: () => {
        if (!effect) return false;
        effect = false;
        return true;
      },
      restore: () => {
        if (effect) return false;
        effect = true;
        return true;
      },
    });
    let t = 0;
    while (g.scale === 1 && t < 10_000) {
      t += 30;
      g.frame(30, t);
    }
    // The effect went first: by the time pixels went, it was already off.
    expect(effect).toBe(false);
    expect(g.scale).toBeLessThan(1);
    const shedAt = t;
    t = run(g, 16.7, 60, t);
    expect(g.scale).toBe(1);
    expect(effect).toBe(true);
    expect(t).toBeGreaterThan(shedAt);
  });

  it('gives up the effect even at the lowest scale, and only sheds what it can', () => {
    let shed = 0;
    const g = new ResolutionGovernor({
      min: 0.6,
      shed: () => {
        shed++;
        return shed === 1;
      },
    });
    run(g, 40, 30);
    expect(g.scale).toBe(0.6);
  });
});
