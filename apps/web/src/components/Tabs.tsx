import { type KeyboardEvent, useRef } from 'react';
import './tabs.css';

export interface Tab<T extends string> {
  id: T;
  label: string;
}

/**
 * A row of tabs: a line under the chosen one, or (`segmented`) small buttons for a choice inside
 * a tab. The arrow keys move between them, as screen-reader users expect. Pair it with
 * `tabPanel(idPrefix, value)` on the content.
 */
export function Tabs<T extends string>({
  label,
  idPrefix,
  tabs,
  value,
  onChange,
  segmented = false,
}: {
  label: string;
  idPrefix: string;
  tabs: Tab<T>[];
  value: T;
  onChange: (id: T) => void;
  segmented?: boolean;
}) {
  const row = useRef<HTMLDivElement>(null);
  const move = (e: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const at = tabs.findIndex((t) => t.id === value);
    const next =
      e.key === 'Home'
        ? tabs[0]
        : e.key === 'End'
          ? tabs.at(-1)
          : step
            ? tabs[(at + step + tabs.length) % tabs.length]
            : undefined;
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    row.current?.querySelector<HTMLElement>(`#${idPrefix}-tab-${next.id}`)?.focus();
  };
  return (
    <div
      ref={row}
      className={segmented ? 'ats-tabs ats-tabs--segmented' : 'ats-tabs'}
      role="tablist"
      aria-label={label}
      onKeyDown={move}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-selected={t.id === value}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          className="ats-tab"
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** What the content of tab `id` needs to say which tab it belongs to. */
export const tabPanel = (idPrefix: string, id: string) => ({
  role: 'tabpanel',
  id: `${idPrefix}-panel-${id}`,
  'aria-labelledby': `${idPrefix}-tab-${id}`,
});
