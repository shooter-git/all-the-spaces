import { describe, expect, it } from 'vitest';
import { cleanLine, logLine, PROGRESS_LINE_MAX, readProgress, stepLine } from '../src/index.ts';

describe('what the checks say as they go', () => {
  it('reads back its own marked lines, and nothing else', () => {
    expect(readProgress(logLine('Laptop: ready in 1.2 s'))).toEqual({
      log: 'Laptop: ready in 1.2 s',
    });
    expect(readProgress(stepLine('play'))).toEqual({ step: 'play' });
    expect(readProgress('{"ok":true}')).toBeNull();
    expect(readProgress('::other thing')).toBeNull();
  });

  it('shows a line without terminal codes, control characters or a password in an address', () => {
    expect(cleanLine('\x1b[32m✓\x1b[39m built in \x1b[1m3.1s\x1b[22m')).toBe('✓ built in 3.1s');
    expect(cleanLine('\x1b]8;;https://x.test\x07link\x1b]8;;\x07\tdone\r')).toBe('link  done');
    expect(cleanLine('GET https://ann:hunter2@registry.test/three')).toBe(
      'GET https://registry.test/three',
    );
    const long = cleanLine('x'.repeat(1000));
    expect(long).toHaveLength(PROGRESS_LINE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});
