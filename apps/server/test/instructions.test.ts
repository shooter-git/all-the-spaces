import { describe, expect, it } from 'vitest';
import {
  INSTRUCTIONS_END,
  INSTRUCTIONS_START,
  instructionsFor,
  instructionsVars,
  refreshInstructions,
} from '../src/studio/files.ts';

describe("keeping a workspace's instructions up to date", () => {
  it('replaces only the platform’s part: notes outside it stay', async () => {
    const fresh = await instructionsFor('space', 'Harbour Design Studio');
    expect(fresh.startsWith(INSTRUCTIONS_START)).toBe(true);
    expect(fresh).toContain('# Harbour Design Studio');
    expect(fresh).toContain('ats model build');
    const old = `${INSTRUCTIONS_START}\n# Harbour Design Studio\n\nOld advice.\n${INSTRUCTIONS_END}\n\n## My notes\n\nThe study desk faces the window.\n`;
    const next = refreshInstructions(old, fresh);
    expect(next?.previous).toBeNull();
    expect(next?.text).toContain('ats model build');
    expect(next?.text).not.toContain('Old advice.');
    expect(next?.text).toContain('## My notes\n\nThe study desk faces the window.\n');
    // Nothing to do when it's already current.
    expect(refreshInstructions(next?.text ?? '', fresh)).toBeNull();
  });

  it('replaces a file from before the markers whole, keeping the old one aside', async () => {
    const before = '# Reading room\n\nYou are turning a real place into a 3D space…\n';
    expect(instructionsVars(before).title).toBe('Reading room');
    const fresh = await instructionsFor('space', 'Reading room');
    expect(refreshInstructions(before, fresh)).toEqual({ text: fresh, previous: before });
    expect(refreshInstructions(null, fresh)).toEqual({ text: fresh, previous: null });
  });

  it("asks the assistant to commit its work as it goes, never a place's plans and photos", async () => {
    const creation = await instructionsFor('creation', 'Boat race', 'the coffee table');
    expect(creation).toContain('git add -A && git commit -m');
    const space = await instructionsFor('space', 'Reading room');
    expect(space).toContain("git add -A -- . ':(exclude)inputs' ':(exclude)uploads' && git commit");
    for (const text of [creation, space]) {
      expect(text).toContain('never add one or push');
      expect(text).toContain('Never rewrite or throw away history');
    }
  });

  it('keeps where a creation lives', async () => {
    const fresh = await instructionsFor('creation', 'Boat race', 'the coffee table');
    expect(instructionsVars(fresh)).toEqual({ title: 'Boat race', where: 'the coffee table' });
  });
});
