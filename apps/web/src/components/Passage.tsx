import { BrandMark, LOOSE_SHEETS } from '@ats/ui';
import './passage.css';

export type PassagePhase = 'off' | 'in' | 'held' | 'out';

/**
 * The soft veil between the space and a creation (and back): warm paper, the mark
 * breathing gently, a few sheets of washi floating, the creation's name and how far it has loaded. The
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
      <div className="passage-sheets">
        {SHEETS.map((p) => (
          <svg
            key={p.id}
            className="passage-sheet"
            viewBox="-50 -50 100 100"
            aria-hidden="true"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: `${p.size}vmin`,
              height: `${p.size}vmin`,
              margin: `${-p.size / 2}vmin`,
              // Side to side, up and down, and turning, each at its own pace, so the sheet never
              // quite stops. Negative delays: already on their way when the veil comes in.
              animationDuration: seconds([p.dur, p.dur * 0.71, p.dur * 1.37]),
              animationDelay: seconds([1, 1.9, 2.7].map((k) => -p.dur * p.at * k)),
            }}
          >
            <path
              d={LOOSE_SHEETS[p.shape]}
              transform={`rotate(${p.r})`}
              fill={p.fill}
              fillOpacity={p.o}
            />
          </svg>
        ))}
      </div>
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

/**
 * A few sheets of washi about the veil (fixed, so it looks the same each time). Each is placed by
 * its centre as a share of the screen (`x`, `y` in %) and sized by its shorter side (`size` in
 * vmin), so they stay about the edges of a phone held upright as well as a wide screen. `at` is
 * how far into its float a sheet already is when the veil comes in.
 */
const SHEETS = [
  { id: 1, shape: 0, x: 15, y: 19, r: -8, size: 25, fill: '#DDB08F', o: 0.32, dur: 6.5, at: 0.1 },
  { id: 2, shape: 1, x: 85, y: 21, r: 10, size: 19, fill: '#94BBA0', o: 0.26, dur: 7.5, at: 0.55 },
  { id: 3, shape: 2, x: 80, y: 77, r: -14, size: 28, fill: '#DDB08F', o: 0.28, dur: 7, at: 0.3 },
  { id: 4, shape: 3, x: 21, y: 79, r: 6, size: 17, fill: '#4A5FA6', o: 0.16, dur: 8, at: 0.8 },
  { id: 5, shape: 1, x: 54, y: 7, r: 18, size: 12, fill: '#94BBA0', o: 0.22, dur: 6, at: 0.45 },
];

const seconds = (values: number[]) => values.map((s) => `${s.toFixed(2)}s`).join(', ');
