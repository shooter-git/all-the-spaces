import { useEffect, useRef } from 'react';

/*
 * Turning a phone between upright and sideways. Browsers don't always tidy up after a turn:
 * iPhones (most of all as an installed app) can leave the page scrolled, or the screen offset
 * from the page by the status bar's height, and report the new size late, so the controls are
 * drawn in one place while taps land in another. A finger that was on the screen as it turned may
 * also never get its end (no pointerup, no pointercancel).
 */

/** Calls `cb` when the screen turns, or the page's width changes some other way (a window). */
export function onTurn(cb: () => void): () => void {
  let width = window.innerWidth;
  // Only the width: an on-screen keyboard changes the height, and that's not a turn.
  const resized = () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    cb();
  };
  const turned = () => {
    width = window.innerWidth;
    cb();
  };
  const orientation = typeof screen !== 'undefined' ? screen.orientation : undefined;
  window.addEventListener('orientationchange', turned);
  orientation?.addEventListener?.('change', turned);
  window.addEventListener('resize', resized);
  window.visualViewport?.addEventListener('resize', resized);
  return () => {
    window.removeEventListener('orientationchange', turned);
    orientation?.removeEventListener?.('change', turned);
    window.removeEventListener('resize', resized);
    window.visualViewport?.removeEventListener('resize', resized);
  };
}

/**
 * Calls `cb` when touches in progress may have been lost without an end: the screen turned, or
 * the page lost focus or was hidden (a call, the app switcher, a notification pulled down).
 */
export function useTouchesLost(cb: () => void) {
  const latest = useRef(cb);
  latest.current = cb;
  useEffect(() => {
    const lost = () => latest.current();
    const hidden = () => {
      if (document.visibilityState === 'hidden') lost();
    };
    const stop = onTurn(lost);
    window.addEventListener('blur', lost);
    window.addEventListener('pagehide', lost);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      stop();
      window.removeEventListener('blur', lost);
      window.removeEventListener('pagehide', lost);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
}

const typing = () => {
  const el = document.activeElement;
  return (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  );
};

/** The page is scrolled, or the part of it on screen has moved off its top-left corner. */
function offset() {
  const vv = window.visualViewport;
  // A pinch zoom moves what's shown on purpose; leave that alone.
  if (vv && Math.abs(vv.scale - 1) > 0.01) return false;
  return Boolean(
    window.scrollX ||
      window.scrollY ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      (vv && (Math.round(vv.offsetTop) || Math.round(vv.offsetLeft))),
  );
}

/** Puts the page back at its top-left corner, unless a field is taking typing (its keyboard may
 *  have moved the page on purpose, to show the field). */
export function settlePage() {
  if (typing() || !offset()) return;
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

/**
 * For a page that fills the screen and never scrolls (a space): holds the page still, and puts it
 * back at the top whenever it moves, most of all after a turn, when the browser can report the
 * new size (and move the page) several times as the turn finishes.
 */
export function useStillPage() {
  useEffect(() => {
    const page = document.documentElement;
    page.classList.add('ats-still-page');
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let frame = 0;
    const later = (ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        settlePage();
      }, ms);
      timers.add(t);
    };
    const turned = () => {
      settlePage();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(settlePage);
      for (const ms of [100, 300, 700, 1500]) later(ms);
    };
    // Anything moving the page itself (pop-ups scroll inside their own boxes, never the page).
    let pending = false;
    const moved = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        settlePage();
      });
    };
    const stop = onTurn(turned);
    window.addEventListener('scroll', moved, { passive: true });
    window.visualViewport?.addEventListener('scroll', moved);
    settlePage();
    return () => {
      stop();
      window.removeEventListener('scroll', moved);
      window.visualViewport?.removeEventListener('scroll', moved);
      cancelAnimationFrame(frame);
      for (const t of timers) clearTimeout(t);
      page.classList.remove('ats-still-page');
    };
  }, []);
}
