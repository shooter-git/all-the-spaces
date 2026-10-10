import { BrandMark, LOOSE_SHEETS } from '@ats/ui';
import './passage.css';

export type PassagePhase = 'off' | 'in' | 'held' | 'out';

/**
 * The soft veil between the space and a creation (and back): warm paper, the mark
 * breathing gently, a few sheets of washi drifting, the creation's name and how far it has loaded. The
 * app draws it — never the creation — so every way in and out feels the same.
 */
export function Passage({
  phase,
  title,
  subtitle,
  progress,
}: {
  phase: PassagePhase;
  title: string;
  subtitle?: string;
  /** 0–1 while loading; hidden when unknown. */
  progress?: number | null;
}) {
  if (phase === 'off') return null;
  return (
    <div className="passage" data-phase={phase} role="status" aria-live="polite">
      <svg
        className="passage-sheets"
        viewBox="0 0 400 300"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        {SHEETS.map((p) => (
          <g
            key={p.id}
            className="passage-sheet"
            style={{ animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s` }}
          >
            <path
              d={LOOSE_SHEETS[p.shape]}
              transform={`translate(${p.x} ${p.y}) rotate(${p.r}) scale(${p.s})`}
              fill={p.fill}
              fillOpacity={p.o}
            />
          </g>
        ))}
      </svg>
      <div className="passage-center">
        <div className="passage-mark">
          <BrandMark size={56} />
        </div>
        <p className="passage-title">{title}</p>
        {subtitle && <p className="passage-subtitle">{subtitle}</p>}
        <div className="passage-progress" aria-hidden={progress == null}>
          {progress != null && (
            <span style={{ transform: `scaleX(${Math.max(0.04, Math.min(1, progress))})` }} />
          )}
        </div>
      </div>
    </div>
  );
}

/** A few sheets of washi about the veil (fixed, so it looks the same each time). */
const SHEETS = [
  { id: 1, shape: 0, x: 62, y: 58, r: -8, s: 0.62, fill: '#DDB08F', o: 0.32, delay: 0, dur: 14 },
  { id: 2, shape: 1, x: 338, y: 64, r: 10, s: 0.48, fill: '#94BBA0', o: 0.26, delay: 1.5, dur: 17 },
  {
    id: 3,
    shape: 2,
    x: 318,
    y: 232,
    r: -14,
    s: 0.7,
    fill: '#DDB08F',
    o: 0.28,
    delay: 0.8,
    dur: 16,
  },
  { id: 4, shape: 3, x: 84, y: 236, r: 6, s: 0.42, fill: '#4A5FA6', o: 0.16, delay: 2.4, dur: 19 },
  { id: 5, shape: 1, x: 214, y: 22, r: 18, s: 0.3, fill: '#94BBA0', o: 0.22, delay: 3.2, dur: 21 },
];
