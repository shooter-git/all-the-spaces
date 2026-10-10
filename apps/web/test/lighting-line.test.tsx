// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { bakingWords, LightingLine, lightingWords } from '../src/components/LightingLine.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const report = { baked: true, rooms: 4, bakedRooms: 4, reused: 0, reason: null };

describe("a version's lighting, in the Studio", () => {
  it('says whether it was baked, and why not when it wasn’t', () => {
    expect(lightingWords(report)).toBe('Lighting baked');
    expect(lightingWords({ ...report, reused: 3 })).toBe(
      'Lighting baked (3 of 4 rooms kept from the last build: nothing in them changed)',
    );
    expect(
      lightingWords({
        ...report,
        baked: false,
        bakedRooms: 0,
        reason: 'the bake job timed out after 30 minutes',
      }),
    ).toBe(
      'Lighting not baked: the bake job timed out after 30 minutes. Those rooms use real-time lighting.',
    );
    expect(
      lightingWords({ ...report, baked: false, bakedRooms: 3, reason: 'the bake job failed: x' }),
    ).toBe(
      'Lighting not baked in 1 of 4 rooms: the bake job failed: x. Those rooms use real-time lighting.',
    );
    // Nothing to say: no report (built before reports), or no indoor rooms.
    expect(lightingWords(null)).toBeNull();
    expect(lightingWords({ ...report, rooms: 0, bakedRooms: 0 })).toBeNull();
  });

  it('shows the line with a dot that isn’t the only sign of what it means', () => {
    const box = document.createElement('div');
    const root = createRoot(box);
    act(() =>
      root.render(
        <LightingLine
          report={{ ...report, baked: false, bakedRooms: 0, reason: 'baking is turned off' }}
        />,
      ),
    );
    expect(box.textContent).toContain('Lighting not baked: baking is turned off.');
    expect(box.querySelector('.studio-dot')?.getAttribute('aria-hidden')).toBe('true');
    act(() => root.unmount());
  });

  it('says how far a build has got with its lighting, and roughly how long is left', () => {
    const p = { rooms: 12, done: 3, minutesLeft: 30 };
    expect(bakingWords(p)).toBe('Baking lighting: room 4 of 12, about 30 minutes left');
    // Before a room has been baked there's no estimate yet.
    expect(bakingWords({ rooms: 12, done: 0, minutesLeft: null })).toBe(
      'Baking lighting: room 1 of 12',
    );
    expect(bakingWords({ ...p, minutesLeft: 1 })).toBe(
      'Baking lighting: room 4 of 12, about 1 minute left',
    );
    expect(bakingWords({ rooms: 240, done: 10, minutesLeft: 1800 })).toBe(
      'Baking lighting: room 11 of 240, about 30 hours left',
    );
    expect(bakingWords({ rooms: 12, done: 12, minutesLeft: null })).toBe(
      'Lighting baked: putting it all together',
    );
    expect(bakingWords(null)).toBeNull();
  });
});
