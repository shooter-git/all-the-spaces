import { type ButtonHTMLAttributes, createElement, type ReactNode, useId } from 'react';
import { Spinner } from './components.tsx';
import { ICONS, type IconName } from './icon-data.ts';

export type { IconName };

const camel = (k: string) => k.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

/** A line icon in the text's own colour. Decorative unless it's given a label. */
export function Icon({
  name,
  size = 18,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  label?: string;
  className?: string;
}) {
  const shapes = ICONS[name].map(([tag, attrs], i) =>
    createElement(tag, {
      key: i,
      ...Object.fromEntries(Object.entries(attrs).map(([k, v]) => [camel(k), v])),
    }),
  );
  const common = {
    className: className ? `ats-icon ${className}` : 'ats-icon',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return label ? (
    <svg {...common} role="img">
      <title>{label}</title>
      {shapes}
    </svg>
  ) : (
    <svg {...common} aria-hidden="true">
      {shapes}
    </svg>
  );
}

/**
 * A button that is just an icon: the label is what screen readers say and what shows on hover.
 * `danger` is for things that remove or delete.
 */
export function IconButton({
  icon,
  label,
  tone,
  busy,
  className,
  disabled,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName;
  label: string;
  tone?: 'danger';
  /** It's working on what was pressed: a spinner instead of the icon, and it can't be pressed. */
  busy?: boolean;
}) {
  const classes = ['ats-icon-button', tone && `ats-icon-button--${tone}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner /> : <Icon name={icon} />}
    </button>
  );
}

/** Someone's initials on their own colour (the colour their figure has in a space). */
export function Avatar({ name, color, size = 32 }: { name: string; color: string; size?: number }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '?';
  return (
    <span
      className="ats-avatar"
      style={{ background: color, width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

/** A small label beside a name: "You", "Sample", "Architect". */
export function Tag({ children, tone }: { children: ReactNode; tone?: 'accent' }) {
  return <span className={tone ? `ats-tag ats-tag--${tone}` : 'ats-tag'}>{children}</span>;
}

/** Two to four side-by-side choices, one picked (radio buttons underneath). */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; icon?: IconName }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="ats-segmented">
      <legend className="visually-hidden">{label}</legend>
      {options.map((o) => (
        <label key={o.value}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          {o.icon && <Icon name={o.icon} size={16} />}
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/** A compact list: one row per thing, hairlines between. */
export function List({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="ats-list" aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * One row: something to recognise it by (an avatar or icon), a title and one line about it,
 * then its actions (usually icon buttons). Anything below (a confirmation) spans the row.
 */
export function ListRow({
  lead,
  title,
  tag,
  meta,
  actions,
  children,
  muted,
}: {
  lead?: ReactNode;
  title: ReactNode;
  tag?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  muted?: boolean;
}) {
  return (
    <li className={muted ? 'ats-row-item ats-row-item--muted' : 'ats-row-item'}>
      {lead && <span className="ats-row-lead">{lead}</span>}
      <span className="ats-row-text">
        <span className="ats-row-title">
          {title}
          {tag}
        </span>
        {meta && <span className="ats-row-meta">{meta}</span>}
      </span>
      {actions && <span className="ats-row-actions">{actions}</span>}
      {children && <div className="ats-row-below">{children}</div>}
    </li>
  );
}

/** "Remove Sam?": what will happen, and a clear yes or no. */
export function Confirm({
  children,
  confirm,
  onConfirm,
  onCancel,
  busy,
  cancel = 'Cancel',
}: {
  children: ReactNode;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  cancel?: string;
}) {
  return (
    <div className="ats-confirm" role="alertdialog" aria-label={confirm}>
      <p>{children}</p>
      <div className="ats-confirm-actions">
        <button
          type="button"
          className={`ats-button ats-button--danger${busy ? ' ats-button--busy' : ''}`}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={onConfirm}
        >
          {busy && <Spinner />}
          {busy ? 'Working…' : confirm}
        </button>
        <button type="button" className="ats-button ats-button--ghost" onClick={onCancel}>
          {cancel}
        </button>
      </div>
    </div>
  );
}

/** Labelled facts, two columns: "Version  1.2.0". */
export function Facts({ items }: { items: [label: string, value: ReactNode][] }) {
  return (
    <dl className="ats-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
