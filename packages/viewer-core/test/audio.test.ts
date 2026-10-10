import type { Room } from '@ats/space-format';
import { describe, expect, it } from 'vitest';
import { reverbTime, STEP, surfaceOf } from '../src/audio.ts';

const room = (floorMaterial: string, size: [number, number, number], objects = 0): Room =>
  ({
    key: 'r',
    floorKey: 'f',
    name: 'R',
    isOutdoor: false,
    floorMaterial,
    bounds: { min: [0, 0, 0], max: size },
    neighbors: [],
    doorways: [],
    objects: Array.from({ length: objects }, (_, i) => ({
      key: `o${i}`,
      label: '',
      kind: 'chair',
      position: [0, 0, 0],
    })),
    files: [],
    credits: [],
  }) as unknown as Room;

describe('how rooms sound', () => {
  it('matches footsteps to the floor', () => {
    expect(surfaceOf(room('oak', [1, 1, 1]))).toBe('wood');
    expect(surfaceOf(room('tile-light', [1, 1, 1]))).toBe('concrete');
    expect(surfaceOf(room('carpet-stone', [1, 1, 1]))).toBe('carpet');
    expect(surfaceOf(room('fabric-indigo', [1, 1, 1]))).toBe('carpet');
    expect(surfaceOf(null)).toBe('concrete');
  });

  it('makes steps on carpet quiet and muffled, without a heavy thud', () => {
    expect(STEP.carpet.level).toBeLessThan(STEP.wood.level / 2);
    expect(STEP.carpet.highpass).toBeGreaterThan(100); // the thud goes
    expect(STEP.carpet.lowpass).toBeLessThan(4000); // and the click
    expect(STEP.wood).toEqual({ level: 1 });
  });

  it('gives hard, bare rooms more echo than soft, furnished ones', () => {
    const bathroom = reverbTime(room('tile-light', [2.5, 2.6, 2.5]));
    const lobby = reverbTime(room('tile-light', [8, 3, 6]));
    const livingRoom = reverbTime(room('carpet-stone', [6, 2.6, 5], 12));
    expect(lobby).toBeGreaterThan(livingRoom);
    expect(bathroom).toBeGreaterThan(0.25);
    expect(livingRoom).toBeLessThan(0.7);
    for (const t of [bathroom, lobby, livingRoom]) expect(t).toBeLessThanOrEqual(1.6);
  });
});
