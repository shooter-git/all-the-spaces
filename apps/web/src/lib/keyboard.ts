import { useEffect, useState } from 'react';

/** What an on-screen keyboard leaves of the screen, in CSS pixels. */
export interface VisibleArea {
  /** How much of the bottom of the page it covers. */
  inset: number;
  /** How tall the part you can see is. */
  height: number;
  /** How far the browser scrolled the page to show a field (iOS does this). */
  top: number;
}

/**
 * Where the keyboard is, from the visual viewport. On Android the page itself shrinks instead
 * (interactive-widget=resizes-content in index.html), so the inset there stays 0. A pinch zoom
 * also moves the visual viewport, but that's not a keyboard: ignored.
 */
export function visibleArea(
  vv: Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'> | null | undefined,
  layoutHeight: number,
): VisibleArea | null {
  if (!vv || Math.abs((vv.scale || 1) - 1) > 0.01) return null;
  return {
    inset: Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop)),
    height: Math.round(vv.height),
    top: Math.max(0, Math.round(vv.offsetTop)),
  };
}

const same = (a: VisibleArea | null, b: VisibleArea | null) =>
  a === b ||
  (a !== null && b !== null && a.inset === b.inset && a.height === b.height && a.top === b.top);

/** The visible area, kept up to date as the keyboard comes and goes. */
export function useVisibleArea(): VisibleArea | null {
  const [area, setArea] = useState(() => visibleArea(window.visualViewport, window.innerHeight));
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () =>
      setArea((now) => {
        const next = visibleArea(vv, window.innerHeight);
        return same(now, next) ? now : next;
      });
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return area;
}
