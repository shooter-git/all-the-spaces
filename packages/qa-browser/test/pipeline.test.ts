import { describe, expect, it } from 'vitest';
import { buildFailure } from '../src/pipeline.ts';

describe('a build that failed', () => {
  it('points at the error when the build broke', () => {
    const check = buildFailure({ error: 'Could not resolve "./missing.ts"' });
    expect(check.detail).toBe('Could not resolve "./missing.ts"');
    expect(check.fix).toMatch(/^Fix the error above/);
  });

  it('says to try again when it ran out of time, not to fix an error', () => {
    const check = buildFailure({ error: 'It took longer than 5 minutes.', timedOut: true });
    expect(check.detail).toBe('It took longer than 5 minutes.');
    expect(check.fix).toMatch(/^Building took too long, usually because the server was busy/);
    expect(check.fix).toMatch(/many large sounds or models/);
    expect(check.fix).not.toMatch(/vite\.config/);
  });
});
