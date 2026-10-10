import { useEffect } from 'react';

/**
 * Where Enter belongs to whatever has focus: pressing a button, following a link, typing, choosing,
 * or a dialog or other widget with keys of its own. The chat shortcut leaves those alone.
 */
const OWN_ENTER = 'button, a, [role], dialog, input, textarea, select, [contenteditable]';

/**
 * Keyboards in a space: Enter opens the chat, Escape closes it. Enter only counts on the space
 * itself, and not while `paused` (a layer such as asking for something, which uses Enter itself).
 */
export function useChatShortcut({
  chatOpen,
  paused,
  open,
  close,
}: {
  chatOpen: boolean;
  paused: boolean;
  open: () => void;
  close: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && chatOpen) {
        close();
        return;
      }
      if (e.key !== 'Enter' || chatOpen || paused || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(OWN_ENTER)) return;
      e.preventDefault();
      open();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [chatOpen, paused, open, close]);
}
