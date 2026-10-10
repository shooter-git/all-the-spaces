import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Tests run from apps/web.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const tokens = read('../../packages/ui/src/tokens.css');

/** The declarations of the first rule for `selector` in a stylesheet. */
const rule = (css: string, selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} is styled`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

describe('the design rules, in the stylesheets', () => {
  it('sheets are native dialogs without the browser border, on the bottom edge on phones', () => {
    const sheet = rule(tokens, 'dialog.ats-sheet');
    expect(sheet).toMatch(/border: 0;/);
    expect(sheet).toMatch(/margin: auto auto 0;/);
    expect(tokens).toContain('dialog.ats-sheet::backdrop');
    expect(tokens).not.toContain('.ats-sheet-backdrop');
  });

  it('no gradients on panels: the welcome tint is flat', () => {
    for (const m of tokens.matchAll(/--ats-hero:\s*([^;]+);/g))
      expect(m[1]).not.toMatch(/gradient/);
    expect(rule(read('src/components/mode-picker.css'), '.door-art')).not.toMatch(/gradient/);
  });

  it('no pills: the draft notice and the upload chips use the small radii', () => {
    expect(rule(read('src/routes/space.css'), '.space-draft')).not.toMatch(/999px/);
    const studio = read('src/routes/studio.css');
    expect(rule(studio, '.workspace-uploads li')).not.toMatch(/999px/);
    expect(rule(studio, '.workspace-uploads li > button:first-child')).not.toMatch(/999px/);
    expect(rule(studio, '.workspace-uploads .workspace-uploads-remove')).not.toMatch(/999px/);
  });
});

/** What each `@media (pointer: coarse)` block in a stylesheet says, selector by selector. */
function onTouch(css: string): Map<string, string> {
  const rules = new Map<string, string>();
  for (
    let at = css.indexOf('@media (pointer: coarse)');
    at >= 0;
    at = css.indexOf('@media (pointer: coarse)', at + 1)
  ) {
    let depth = 0;
    let end = css.indexOf('{', at);
    do {
      if (css[end] === '{') depth++;
      if (css[end] === '}') depth--;
      end++;
    } while (depth > 0 && end < css.length);
    const block = css.slice(css.indexOf('{', at) + 1, end - 1);
    for (const m of block.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const selector of (m[1] ?? '').split(',')) rules.set(selector.trim(), m[2] ?? '');
    }
  }
  return rules;
}

describe('touch targets on touch screens', () => {
  const touch = (path: string) => onTouch(read(path));
  const full = /(min-)?height: var\(--ats-touch\)/;
  it.each([
    ['../../packages/ui/src/tokens.css', '.ats-segmented label'],
    ['../../packages/ui/src/tokens.css', '.ats-back'],
    ['src/components/chat.css', '.chat-more'],
    ['src/components/chat.css', '.chat-toggle'],
    ['src/routes/privacy.css', 'select.privacy-asks'],
    ['src/routes/privacy.css', 'select.privacy-owner'],
    ['src/routes/studio.css', '.workspace-uploads .workspace-uploads-remove'],
    ['src/routes/studio.css', '.workspace-uploads li > button:first-child'],
  ])('%s: %s is at least 44 px', (path, selector) => {
    expect(touch(path).get(selector) ?? '').toMatch(full);
  });

  it('the terminal key bar (only shown on touch screens) has 44 px keys', () => {
    expect(rule(read('src/components/terminal.css'), '.terminal-keys button')).toMatch(
      /min-height: var\(--ats-touch\)/,
    );
  });
});
