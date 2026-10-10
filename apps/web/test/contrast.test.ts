import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Tests run from apps/web.
const css = readFileSync(resolve(process.cwd(), '../../packages/ui/src/tokens.css'), 'utf8');

/** The custom properties set in the first block that starts with `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/(--ats-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]?.trim()]),
  );
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const light = tokens(':root');
const themes = {
  light,
  'dark (system)': { ...light, ...tokens(':root:not([data-theme="light"])') },
  'dark (chosen)': { ...light, ...tokens(':root[data-theme="dark"]') },
};

describe('fields you type in (WCAG 1.4.11, non-text contrast)', () => {
  for (const [name, t] of Object.entries(themes)) {
    for (const paper of ['--ats-bg', '--ats-surface', '--ats-subtle']) {
      it(`${name}: the edge and the focus ring stand out 3:1 on ${paper}`, () => {
        const around = t[paper] as string;
        expect(ratio(t['--ats-field-line'] as string, around)).toBeGreaterThanOrEqual(3);
        expect(ratio(t['--ats-accent'] as string, around)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('use the field edge, and show focus with a 2 px ring rather than only a faint glow', () => {
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      return css.slice(start, css.indexOf('}', start));
    };
    expect(rule('.ats-input')).toMatch(/border: 1px solid var\(--ats-field-line\)/);
    expect(rule('.ats-input:focus')).toMatch(/outline: 2px solid var\(--ats-accent\)/);
  });
});
