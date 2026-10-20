import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import './creation-menu.css';

/** How long the button stays clear after anything happens, before it fades back. */
const AWAKE_MS = 4000;

/**
 * The app's controls over a creation, and over a space as you walk around it: one small glass
 * button in the top-left corner, which opens a menu (Back, Chat, voice…). It fades to a faint mark
 * while nothing happens, so the view has the whole screen, and wakes when something needs the
 * person (a message, someone talking).
 *
 * Items are plain buttons with the class `creation-menu-item`; tapping one closes the menu,
 * unless it's inside an element marked `data-keep-open` (the microphone, say).
 */
export function CreationMenu({
  label,
  attention = false,
  aside,
  children,
}: {
  /** What the button is called, e.g. "Menu". */
  label: string;
  /** Something new is waiting (a message, someone talking): a dot on the button, and it wakes. */
  attention?: boolean;
  /** Beside the button, and never faded: the microphone while voice chat is on. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), AWAKE_MS);
  }, []);
  useEffect(() => {
    wake();
    return () => clearTimeout(timer.current);
  }, [wake]);
  useEffect(() => {
    if (attention) wake();
  }, [attention, wake]);

  const close = useCallback(
    (refocus: boolean) => {
      setOpen(false);
      wake();
      if (refocus) button.current?.focus();
    },
    [wake],
  );

  // Closes on Escape, on a tap anywhere else in the app, and when the creation takes the focus
  // (a tap inside its frame never reaches the app, but the app's window loses the focus).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    const onBlur = () => close(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close]);

  return (
    <div ref={root} className="creation-menu" data-open={open} data-idle={idle && !open}>
      <div className="creation-menu-bar">
        <button
          ref={button}
          type="button"
          className="creation-menu-button"
          aria-label={attention ? `${label}: something new` : label}
          aria-expanded={open}
          aria-controls={id}
          onPointerEnter={wake}
          onFocus={wake}
          onClick={() => (open ? close(false) : setOpen(true))}
        >
          <span className="creation-menu-glass">
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path d="M3.5 6.2h12.8M3.5 10.1h8.6M3.5 14h10.6" />
            </svg>
            {attention && <span className="creation-menu-dot" />}
          </span>
        </button>
        {aside}
      </div>
      {open && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the items are buttons (Enter and Space click them); this only closes the menu after one is used
        <nav
          id={id}
          className="creation-menu-panel"
          aria-label={label}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest('button') && !target.closest('[data-keep-open]')) close(false);
          }}
        >
          {children}
        </nav>
      )}
    </div>
  );
}
