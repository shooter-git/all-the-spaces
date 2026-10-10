import { Icon, IconButton } from '@ats/ui';
import { useEffect, useRef, useState } from 'react';

type Point = { x: number; y: number; p: number };
type Stroke = { color: string; width: number; points: Point[] };

const INKS = [
  { name: 'Ink', color: '#2e2c33' },
  { name: 'Indigo', color: '#3b5b92' },
  { name: 'Red', color: '#b5433a' },
  { name: 'Green', color: '#5f7a4f' },
];

/**
 * A sheet of paper to sketch an idea on, with a finger, a pen (pressure counts) or a mouse.
 * Hands back a picture, or nothing if cancelled.
 */
export function SketchPad({ onDone }: { onDone: (picture: Blob | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [ink, setInk] = useState(INKS[0]?.color ?? '#2e2c33');
  const drawing = useRef<{ id: number; stroke: Stroke } | null>(null);

  // Fit the canvas to its box (sharp on high-density screens), redrawing on resize.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const fitCanvas = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      el.width = Math.round(r.width * dpr);
      el.height = Math.round(r.height * dpr);
      paint(el, strokes, drawing.current?.stroke);
    };
    fitCanvas();
    const ro = new ResizeObserver(fitCanvas);
    ro.observe(el);
    return () => ro.disconnect();
  }, [strokes]);

  const point = (e: {
    clientX: number;
    clientY: number;
    pointerType: string;
    pressure: number;
  }): Point => {
    const r = (canvas.current as HTMLCanvasElement).getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
      p: e.pointerType === 'pen' ? Math.max(0.15, e.pressure) : 0.5,
    };
  };

  const finish = () => {
    const el = canvas.current;
    if (!el || strokes.length === 0) return onDone(null);
    // A white page (the picture is saved as a JPEG).
    const out = document.createElement('canvas');
    out.width = el.width;
    out.height = el.height;
    const ctx = out.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(el, 0, 0);
    out.toBlob((b) => onDone(b), 'image/png');
  };

  return (
    <div className="sketch" role="dialog" aria-label="Draw a sketch">
      <div className="sketch-bar">
        <div className="sketch-inks">
          {INKS.map((i) => (
            <button
              key={i.color}
              type="button"
              aria-pressed={ink === i.color}
              aria-label={i.name}
              className="sketch-ink"
              style={{ background: i.color }}
              onClick={() => setInk(i.color)}
            />
          ))}
        </div>
        <span className="sketch-tools">
          <IconButton
            icon="undo"
            label="Undo the last line"
            disabled={!strokes.length}
            onClick={() => setStrokes(strokes.slice(0, -1))}
          />
          <IconButton
            icon="eraser"
            label="Clear the page"
            disabled={!strokes.length}
            onClick={() => setStrokes([])}
          />
        </span>
      </div>
      <canvas
        ref={canvas}
        className="sketch-paper"
        aria-label="Paper: draw here"
        onPointerDown={(e) => {
          if (drawing.current) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = {
            id: e.pointerId,
            stroke: { color: ink, width: 4, points: [point(e)] },
          };
        }}
        onPointerMove={(e) => {
          const d = drawing.current;
          if (d?.id !== e.pointerId || !canvas.current) return;
          // Every point the pen passed through, not just one per frame.
          const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
          for (const c of events.length ? events : [e.nativeEvent]) d.stroke.points.push(point(c));
          paint(canvas.current, strokes, d.stroke);
        }}
        onPointerUp={(e) => {
          const d = drawing.current;
          if (d?.id !== e.pointerId) return;
          drawing.current = null;
          setStrokes([...strokes, d.stroke]);
        }}
        onPointerCancel={() => {
          drawing.current = null;
          if (canvas.current) paint(canvas.current, strokes);
        }}
      />
      <div className="sketch-bar">
        <button type="button" className="ats-button ats-button--ghost" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="button" className="ats-button ats-button--primary" onClick={finish}>
          <Icon name="check" size={16} />
          {strokes.length ? 'Use this sketch' : 'Done'}
        </button>
      </div>
    </div>
  );
}

function paint(el: HTMLCanvasElement, strokes: Stroke[], extra?: Stroke) {
  const ctx = el.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, el.width, el.height);
  const scale = Math.min(el.width, el.height) / 400;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of extra ? [...strokes, extra] : strokes) {
    ctx.strokeStyle = s.color;
    const pts = s.points;
    if (pts.length === 1) {
      const p = pts[0] as Point;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(p.x * el.width, p.y * el.height, s.width * scale * p.p, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as Point;
      const b = pts[i] as Point;
      ctx.lineWidth = s.width * scale * 2 * ((a.p + b.p) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x * el.width, a.y * el.height);
      ctx.lineTo(b.x * el.width, b.y * el.height);
      ctx.stroke();
    }
  }
}
