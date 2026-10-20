import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarLayer, MAX_EXTRAPOLATION, type RemotePose } from '../src/avatars.ts';

// Name tags draw on a canvas: a stand-in that counts how many are made.
let canvases = 0;
beforeEach(() => {
  canvases = 0;
  const ctx = new Proxy(
    {},
    { get: (_, k) => (k === 'measureText' ? () => ({ width: 50 }) : () => {}) },
  );
  vi.stubGlobal('document', {
    createElement: () => {
      canvases++;
      return { width: 0, height: 0, getContext: () => ctx };
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/** A steady pseudo-random sequence, so every run sees the same jitter. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

const SPEED = 1.4; // m/s, walking
const FRAME = 1000 / 60;
const walking = (at: number, x = (SPEED * at) / 1000): RemotePose => ({
  x,
  y: 0,
  z: 0,
  yaw: 0,
  moving: true,
  at,
});

/**
 * Someone walking along x, sending every 50 ms on their clock; `arrive` says when each update
 * gets here (or never). Draws at 60 frames a second and records where they're drawn.
 */
function simulate(
  arrive: (sent: number, i: number) => number | null,
  {
    until = 4000,
    pose = walking,
    timed = true,
  }: { until?: number; pose?: (at: number) => RemotePose; timed?: boolean } = {},
) {
  const layer = new AvatarLayer();
  const updates: { arrives: number; pose: RemotePose }[] = [];
  for (let i = 0, sent = 50; sent <= until; i++, sent += 50) {
    const arrives = arrive(sent, i);
    if (arrives === null) continue;
    const p = pose(sent);
    updates.push({ arrives, pose: timed ? p : { ...p, at: 0 } });
  }
  updates.sort((a, b) => a.arrives - b.arrives);
  const frames: { now: number; x: number }[] = [];
  let added = false;
  for (let now = 0; now <= until + 500; now += FRAME) {
    while (updates.length && (updates[0]?.arrives ?? Infinity) <= now) {
      const u = updates.shift() as { pose: RemotePose };
      if (!added) layer.add('bea', { name: 'Bea', color: '#c33' }, u.pose, now);
      else layer.push('bea', u.pose, now);
      added = true;
    }
    if (!added) continue;
    layer.update(FRAME / 1000, now);
    frames.push({ now, x: layer.positions()[0]?.x ?? Number.NaN });
  }
  return frames;
}

/** Speed (m/s) over each frame, between `from` and `to` ms. */
const speeds = (frames: { now: number; x: number }[], from: number, to: number) =>
  frames
    .slice(1)
    .map((f, i) => ({ now: f.now, v: ((f.x - (frames[i]?.x ?? 0)) / FRAME) * 1000 }))
    .filter((f) => f.now >= from && f.now <= to)
    .map((f) => f.v);

describe('other people walking', () => {
  // Sent every 50 ms, then the server's 20-a-second beat and the network: 40–100 ms on the way.
  const jittery = () => {
    const r = random(7);
    return (sent: number) => sent + 40 + r() * 60;
  };

  it('walk evenly however unevenly their updates arrive', () => {
    const v = speeds(simulate(jittery()), 1000, 3800);
    expect(Math.min(...v)).toBeGreaterThan(SPEED * 0.9);
    expect(Math.max(...v)).toBeLessThan(SPEED * 1.1);
  });

  it('walk evenly when updates come in bunches (every other one held back to the next)', () => {
    // As when two updates fall in one of the server's sends: gaps of 0 and 100 ms.
    const v = speeds(
      simulate((sent, i) => (i % 2 ? sent + 30 : sent + 80)),
      1000,
      3800,
    );
    expect(Math.min(...v)).toBeGreaterThan(SPEED * 0.9);
    expect(Math.max(...v)).toBeLessThan(SPEED * 1.1);
  });

  it('were uneven when drawn on arrival times (no sender time: the old way, still works)', () => {
    const frames = simulate(jittery(), { timed: false });
    const v = speeds(frames, 1000, 3800);
    expect(Math.max(...v) / Math.min(...v)).toBeGreaterThan(1.5);
    // But they still get there.
    expect(frames.at(-1)?.x).toBeCloseTo((SPEED * 4000) / 1000, 1);
  });

  it('carry on briefly when updates are late, then ease back without a jump', () => {
    // Nothing gets through for 600 ms after 2 s; then it all arrives at once.
    const frames = simulate((sent) => (sent > 2000 && sent <= 2600 ? 2600 + 60 : sent + 60));
    const lastHeard = (SPEED * 2000) / 1000;
    const stalled = frames.filter((f) => f.now > 2100 && f.now < 2660);
    // Guessed on, but never further than the cap allows.
    expect(Math.max(...stalled.map((f) => f.x))).toBeGreaterThan(lastHeard);
    expect(Math.max(...stalled.map((f) => f.x))).toBeLessThanOrEqual(
      lastHeard + (SPEED * MAX_EXTRAPOLATION) / 1000 + 1e-6,
    );
    // And back on their path without a jump: no frame moves more than a few times a walking step.
    const steps = frames.slice(1).map((f, i) => Math.abs(f.x - (frames[i]?.x ?? 0)));
    expect(Math.max(...steps)).toBeLessThan(0.1);
    // Walking evenly again once the late updates are in.
    const v = speeds(frames, 3000, 3800);
    expect(Math.min(...v)).toBeGreaterThan(SPEED * 0.9);
    expect(Math.max(...v)).toBeLessThan(SPEED * 1.1);
  });

  it('stand still where they stopped, not guessing on', () => {
    const frames = simulate((sent) => sent + 60, {
      pose: (at) => (at <= 2000 ? walking(at) : { ...walking(2000), moving: false, at }),
      until: 2050,
    });
    expect(frames.at(-1)?.x).toBeCloseTo(2.8, 5);
    expect(Math.max(...frames.map((f) => f.x))).toBeLessThanOrEqual(2.8 + 1e-6);
  });

  it('jump straight to where they quick-travelled, never sliding there', () => {
    const r = random(3);
    const frames = simulate((sent) => sent + 40 + r() * 60, {
      pose: (at) => (at < 2000 ? walking(at) : walking(at, 50 + (SPEED * (at - 2000)) / 1000)),
    });
    // Drawn either on the walk before (under 3 m) or after the jump (50 m on): nowhere between.
    expect(frames.filter((f) => f.x > 3.5 && f.x < 49.5)).toEqual([]);
    expect(frames.at(-1)?.x).toBeGreaterThan(50);
  });

  it('jump straight there without sender times too', () => {
    const frames = simulate((sent) => sent + 50, {
      timed: false,
      pose: (at) => (at < 2000 ? walking(at) : walking(at, 50)),
    });
    expect(frames.filter((f) => f.x > 3.5 && f.x < 49.5)).toEqual([]);
  });
});

describe('people coming and going', () => {
  it('keeps a figure for a while, so walking back into view needs no new name tag', () => {
    const layer = new AvatarLayer();
    layer.add('bea', { name: 'Bea', color: '#c33' }, walking(50), 0);
    expect(canvases).toBe(1);
    layer.remove('bea', 1000);
    expect(layer.count).toBe(0);
    expect(layer.keptAvatars).toBe(1);
    // Back (even under a new session, after a reconnection): the same figure, no new canvas.
    layer.add('bea-again', { name: 'Bea', color: '#c33' }, walking(50), 2000);
    expect(canvases).toBe(1);
    expect(layer.keptAvatars).toBe(0);
    expect(layer.positions()[0]?.x).toBeCloseTo(0.07);
    // Someone else needs their own.
    layer.add('cai', { name: 'Cai', color: '#33c' }, walking(50), 2000);
    expect(canvases).toBe(2);
    // Gone for good after a minute.
    layer.remove('cai', 3000);
    layer.update(0.016, 3000 + 61_000);
    expect(layer.keptAvatars).toBe(0);
    layer.dispose();
  });
});
