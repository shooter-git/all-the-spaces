import type { SpaceViewer } from '@ats/viewer-core';
import { useRef } from 'react';
import { useTouchesLost } from '../../lib/turns.ts';

/** Thumb joystick for walking on touch screens. */
export function Joystick({ viewer }: { viewer: React.RefObject<SpaceViewer | null> }) {
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const active = useRef<number | null>(null);

  const update = (e: React.PointerEvent) => {
    const el = base.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = e.clientX - (r.left + radius);
    let dy = e.clientY - (r.top + radius);
    const len = Math.hypot(dx, dy);
    if (len > radius) {
      dx = (dx / len) * radius;
      dy = (dy / len) * radius;
    }
    if (knob.current) knob.current.style.transform = `translate(${dx}px, ${dy}px)`;
    viewer.current?.input.setJoystick(dx / radius, -dy / radius);
  };
  const end = () => {
    const id = active.current;
    active.current = null;
    if (id !== null && base.current?.hasPointerCapture?.(id))
      base.current.releasePointerCapture(id);
    if (knob.current) knob.current.style.transform = '';
    viewer.current?.input.setJoystick(0, 0);
  };
  // A thumb whose end never came (the phone turned under it, the app was switched away from):
  // stop walking, rather than walk on forever.
  useTouchesLost(() => {
    if (active.current !== null) end();
  });

  return (
    <div
      ref={base}
      className="space-joystick"
      role="application"
      aria-label="Walk: drag to move"
      onPointerDown={(e) => {
        active.current = e.pointerId;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Already gone (lifted before this ran): its pointerup still comes here.
        }
        update(e);
      }}
      onPointerMove={(e) => active.current === e.pointerId && update(e)}
      onPointerUp={(e) => active.current === e.pointerId && end()}
      onPointerCancel={(e) => active.current === e.pointerId && end()}
    >
      <div ref={knob} className="space-joystick-knob" />
    </div>
  );
}
