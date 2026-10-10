import { describe, expect, it } from 'vitest';
import { titleFrom } from '../src/lib/requests.ts';

describe('titleFrom', () => {
  it('takes the first words of plain words', () => {
    expect(titleFrom('A little garden that grows when people water it together.')).toBe(
      'A little garden that grows when people',
    );
    expect(titleFrom('Make the lamp glow.')).toBe('Make the lamp glow');
  });

  it('takes a Markdown heading without its #, and nothing from the lines after it', () => {
    expect(
      titleFrom(
        '# Block Builders: Outpost Defense\n\nA complete Three.js browser game made entirely of bricks.',
      ),
    ).toBe('Block Builders: Outpost Defense');
    expect(titleFrom('\n\n### **The Hangar**\nBuild a starfighter.')).toBe('The Hangar');
  });

  it('leaves out list markers, quotes, emphasis and link addresses', () => {
    expect(titleFrom('- **Hangar:** build your ship')).toBe('Hangar: build your ship');
    expect(titleFrom('1. A _quiet_ place to read')).toBe('A quiet place to read');
    expect(titleFrom('> Like [this game](https://example.com/game) but calmer')).toBe(
      'Like this game but calmer',
    );
    expect(titleFrom('Keep my_save_file working')).toBe('Keep my_save_file working');
  });

  it('skips lines with no words in them', () => {
    expect(titleFrom('---\n\n## \n\nA calm pond')).toBe('A calm pond');
  });

  it('falls back when there are no words at all', () => {
    expect(titleFrom('')).toBe('A request');
    expect(titleFrom('# \n---')).toBe('A request');
  });

  it('keeps long titles short', () => {
    expect(titleFrom('Supercalifragilisticexpialidocious '.repeat(3))).toHaveLength(58);
  });
});
