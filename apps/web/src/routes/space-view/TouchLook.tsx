import type { SpaceViewer } from '@ats/viewer-core';
import { useRef } from 'react';
import { useTouchesLost } from '../../lib/turns.ts';

/** Drag anywhere to look around; a quick tap walks to that spot. */
export function TouchLook({
  viewer,
  onTap,
}: {
  viewer: React.RefObject<SpaceViewer | null>;
  /** A quick tap: return true if it was handled (e.g. it opened something). */
  onTap: (x: number, y: number) => boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const start = useRef<{
    id: number;
    x: number;
    y: number;
    t: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  // A finger whose end never came (the phone turned under it, the app was switched away from):
  // let it go, or the view would never look around again.
  const letGo = () => {
    const s = start.current;
    start.current = null;
    if (s && layer.current?.hasPointerCapture?.(s.id)) layer.current.releasePointerCapture(s.id);
  };
  useTouchesLost(letGo);
  return (
    <div
      ref={layer}
      className="space-look"
      onPointerDown={(e) => {
        const s = start.current;
        // One finger looks at a time; a finger the browser has already forgotten doesn't count.
        if (s && e.currentTarget.hasPointerCapture?.(s.id)) return;
        start.current = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          t: performance.now(),
          lastX: e.clientX,
          lastY: e.clientY,
        };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Already gone (lifted before this ran): its pointerup still comes here.
        }
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        viewer.current?.input.addLook((e.clientX - s.lastX) * 0.005, (e.clientY - s.lastY) * 0.005);
        s.lastX = e.clientX;
        s.lastY = e.clientY;
      }}
      onPointerUp={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        start.current = null;
        const moved = Math.hypot(e.clientX - s.x, e.clientY - s.y);
        if (moved < 10 && performance.now() - s.t < 300 && !onTap(e.clientX, e.clientY))
          viewer.current?.tapToWalk(e.clientX, e.clientY);
      }}
      onPointerCancel={(e) => {
        if (start.current?.id === e.pointerId) start.current = null;
      }}
    />
  );
}
