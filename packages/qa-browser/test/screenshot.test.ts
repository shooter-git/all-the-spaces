import type { Check } from '@ats/qa';
import { errors } from 'playwright';
import { describe, expect, it } from 'vitest';
import { screenshot } from '../src/harness/run.ts';

/** A page whose screenshots time out this many times before one is taken. */
function page(timeouts: number, fail?: Error) {
  const asked: number[] = [];
  return {
    asked,
    screenshot: async ({ timeout }: { timeout?: number }) => {
      asked.push(timeout ?? 0);
      if (fail) throw fail;
      if (asked.length <= timeouts) throw new errors.TimeoutError('Timeout exceeded');
      return Buffer.from('png');
    },
  };
}

describe('a screenshot the browser is slow to draw', () => {
  it('is tried again with longer to wait', async () => {
    const p = page(1);
    const checks: Check[] = [];
    expect(await screenshot(p, 'x.png', 'Laptop, start', checks, [10, 20])).not.toBeNull();
    expect(p.asked).toEqual([10, 20]);
    expect(checks).toEqual([]);
  });

  it('is a note, not a failure, and the later ones are skipped', async () => {
    const checks: Check[] = [];
    expect(await screenshot(page(9), 'x.png', 'Laptop, start', checks, [10, 20])).toBeNull();
    expect(checks).toMatchObject([
      {
        id: 'stalled',
        status: 'warn',
        where: 'Laptop, start',
        title: "Couldn't take a screenshot",
      },
    ]);
    const later = page(0);
    expect(await screenshot(later, 'y.png', 'Tablet, start', checks, [10, 20])).toBeNull();
    expect(later.asked).toEqual([]);
    expect(checks).toHaveLength(1);
  });

  it('still fails for anything other than waiting', async () => {
    const p = page(0, new Error('Target page, context or browser has been closed'));
    await expect(screenshot(p, 'x.png', 'Laptop, start', [], [10, 20])).rejects.toThrow(/closed/);
    expect(p.asked).toEqual([10]);
  });
});
