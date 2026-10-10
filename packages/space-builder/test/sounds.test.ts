import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSpace } from '../src/index.ts';

const sample = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../samples/${name}/plan.json`, import.meta.url), 'utf8'));

describe('everyday sounds', () => {
  it('keeps homes quiet, even with a desk', async () => {
    const { manifest } = await buildSpace(sample('studio-apartment'));
    expect(manifest.rooms.flatMap((r) => r.sounds)).toEqual([]);
  });

  it('gives workplaces typing, clicks and chairs, and cafés their cups', async () => {
    const { manifest } = await buildSpace(sample('two-floor-building'));
    const kinds = (key: string) =>
      new Set(manifest.rooms.find((r) => r.key === key)?.sounds.map((s) => s.kind));
    expect(kinds('office')).toEqual(new Set(['typing', 'mouse', 'chair']));
    expect(kinds('cafe')).toEqual(new Set(['cups']));
    expect(kinds('lobby').size).toBe(0);
  });

  it('tells doors from open passages', async () => {
    const { manifest } = await buildSpace(sample('studio-apartment'));
    const living = manifest.rooms.find((r) => r.key === 'living');
    expect(living?.doorways.find((d) => d.to === 'hall')?.kind).toBe('door');
    expect(living?.doorways.find((d) => d.to === 'balcony')?.kind).toBe('open');
  });
});
