// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVisibleArea, visibleArea } from '../src/lib/keyboard.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.unstubAllGlobals());

describe('the on-screen keyboard', () => {
  it('on Android, shrinks the page itself, so fixed panels sit above it', () => {
    // Tests run from apps/web.
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/)?.[1] ?? '';
    expect(viewport).toContain('interactive-widget=resizes-content');
  });

  it('elsewhere, is measured from the visual viewport', () => {
    // An iPhone 13 in portrait: 844 px tall, a 336 px keyboard.
    expect(visibleArea({ height: 508, offsetTop: 0, scale: 1 }, 844)).toEqual({
      inset: 336,
      height: 508,
      top: 0,
    });
    // Safari scrolled the page 120 px to show the field.
    expect(visibleArea({ height: 508, offsetTop: 120, scale: 1 }, 844)).toEqual({
      inset: 216,
      height: 508,
      top: 120,
    });
    // Android with resizes-content: the page shrank with it, nothing is covered.
    expect(visibleArea({ height: 508, offsetTop: 0, scale: 1 }, 508)?.inset).toBe(0);
    // A pinch zoom isn't a keyboard.
    expect(visibleArea({ height: 422, offsetTop: 200, scale: 2 }, 844)).toBeNull();
  });

  it('is followed as it comes and goes', () => {
    const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', vv);
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    const seen: (number | undefined)[] = [];
    function Probe() {
      seen.push(useVisibleArea()?.inset);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    expect(seen.at(-1)).toBe(0);
    act(() => {
      vv.height = 508;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(seen.at(-1)).toBe(336);
    act(() => {
      vv.height = 844;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(seen.at(-1)).toBe(0);
    act(() => root.unmount());
  });
});
