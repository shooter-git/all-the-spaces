import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';
import { LOOSE_SHEETS, MARK_SHEETS } from './mark-paths.ts';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * `busy`: it's working on what was pressed. It can't be pressed again, and a small spinner takes
 * the place of its icon (put the words for what's happening in its label).
 */
export function Button({
  variant = 'secondary',
  block,
  busy,
  className,
  disabled,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  block?: boolean;
  busy?: boolean;
}) {
  const classes = [
    'ats-button',
    `ats-button--${variant}`,
    block && 'ats-button--block',
    busy && 'ats-button--busy',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

/** Something is on its way: a small ring, in the colour of the text around it. */
export function Spinner() {
  return <span className="ats-spinner" aria-hidden="true" />;
}

export function Field({
  label,
  hint,
  error,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="ats-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="ats-input"
        aria-describedby={hint ? hintId : undefined}
        aria-invalid={error ? true : undefined}
        {...input}
      />
      {hint && (
        <span id={hintId} className="ats-hint">
          {hint}
        </span>
      )}
      {error && <span className="ats-error">{error}</span>}
    </div>
  );
}

/** A quiet surface. `page` cards dissolve into the page on narrow phones. */
export function Card({
  children,
  className,
  page,
}: {
  children: ReactNode;
  className?: string;
  page?: boolean;
}) {
  return (
    <section
      className={['ats-card', page && 'ats-card--page', className].filter(Boolean).join(' ')}
    >
      {children}
    </section>
  );
}

/** A content section separated from its neighbours by whitespace and a hairline. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ats-section ats-stack" style={{ gap: 12 }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Notice({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return (
    <div
      className={`ats-notice${tone ? ` ats-notice--${tone}` : ''}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

export function Steps({ total, current }: { total: number; current: number }) {
  return (
    <div className="ats-steps" aria-label={`Step ${current + 1} of ${total}`} role="img">
      {Array.from({ length: total }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative list
        <span key={i} data-done={i <= current} />
      ))}
    </div>
  );
}

export function Choice({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="ats-choice" aria-pressed={selected} onClick={onSelect}>
      {children}
    </button>
  );
}

/**
 * The All the Spaces mark (three sheets of washi, one behind another), inline so it needs no
 * network request. Drawn by tools/brand-mark.mjs.
 */
export function BrandMark({
  size = 40,
  title = 'All the Spaces',
}: {
  size?: number;
  title?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" role="img" aria-label={title}>
      {MARK_SHEETS.map((s) => (
        <path key={s.fill} d={s.d} fill={s.fill} fillOpacity={s.opacity} />
      ))}
    </svg>
  );
}

/** A few loose sheets of washi resting in a corner. Purely decorative. */
export function WashiCorner({ className }: { className?: string }) {
  return (
    <svg className={className} width="120" height="90" viewBox="0 0 120 90" aria-hidden="true">
      <path
        d={LOOSE_SHEETS[0]}
        transform="translate(96 26) rotate(12) scale(0.3)"
        fill="#DDB08F"
        fillOpacity="0.55"
      />
      <path
        d={LOOSE_SHEETS[1]}
        transform="translate(78 40) rotate(-8) scale(0.26)"
        fill="#94BBA0"
        fillOpacity="0.45"
      />
      <path
        d={LOOSE_SHEETS[2]}
        transform="translate(104 62) rotate(20) scale(0.18)"
        fill="#4A5FA6"
        fillOpacity="0.4"
      />
    </svg>
  );
}
