import { registerSW } from 'virtual:pwa-register';
import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e as BeforeInstallPromptEvent;
  notify();
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  notify();
});

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** How (and whether) this device can install the app. */
export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  if (isStandalone()) return { mode: 'installed' as const };
  if (deferredPrompt) {
    const prompt = deferredPrompt;
    return {
      mode: 'prompt' as const,
      install: async () => {
        await prompt.prompt();
        await prompt.userChoice;
        deferredPrompt = null;
        notify();
      },
    };
  }
  if (isIos()) return { mode: 'ios-guide' as const };
  return { mode: 'unavailable' as const };
}

let updateSW: ((reload?: boolean) => Promise<void>) | undefined;
const updateListeners = new Set<() => void>();
let updateReady = false;

export function startServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  updateSW = registerSW({
    onNeedRefresh() {
      updateReady = true;
      for (const l of updateListeners) l();
    },
  });
}

/** True when a new version of the app has downloaded and is waiting. */
export function useUpdateReady() {
  const [ready, setReady] = useState(updateReady);
  useEffect(() => {
    const l = () => setReady(true);
    updateListeners.add(l);
    return () => {
      updateListeners.delete(l);
    };
  }, []);
  return { ready, apply: () => updateSW?.(true) };
}

/** Clears anything this device cached for the signed-in user (called on sign-out). */
export async function clearPrivateCaches() {
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => !k.startsWith('workbox-precache')).map((k) => caches.delete(k)),
    );
  }
  try {
    sessionStorage.clear();
  } catch {
    // Storage may be unavailable (private mode); nothing to clear then.
  }
}
