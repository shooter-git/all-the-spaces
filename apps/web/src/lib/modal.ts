import { useEffect, useRef } from 'react';

/**
 * For a <dialog> that's on the page only while it's open: shows it as a modal (the rest of the
 * page can't be reached, Escape closes it and fires its onClose), and when it goes, puts focus
 * back where it was. Give the dialog the returned ref.
 */
export function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (before?.isConnected) before.focus();
    };
  }, []);
  return ref;
}
