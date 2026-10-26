import type { VisitDevice } from '@ats/api-types';

/**
 * The kind of device this is, for where people spend time: a headset, a phone, a tablet or a
 * computer. Nothing more precise is ever sent.
 */
export function deviceKind(): VisitDevice {
  if (/OculusBrowser|Quest|Pico|Wolvic/i.test(navigator.userAgent)) return 'headset';
  if (!window.matchMedia?.('(pointer: coarse)').matches) return 'computer';
  return Math.min(window.screen.width, window.screen.height) >= 600 ? 'tablet' : 'phone';
}
