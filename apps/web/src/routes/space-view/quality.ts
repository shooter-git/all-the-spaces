import type { Quality } from '@ats/viewer-core';
import { cachedAdvice } from '../../lib/perf.ts';

export const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

export function pickQuality(): Quality {
  const forced = new URLSearchParams(window.location.search).get('quality');
  if (forced === 'low' || forced === 'mid' || forced === 'high') return forced;
  // What has run smoothly on this kind of device here (from people who share it).
  const advised = cachedAdvice();
  if (advised) return advised;
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  // Phones start at mid unless they say they're small: iPhones don't say (Safari reports few
  // cores and no memory), and dynamic resolution keeps any device smooth from there.
  if (isTouch()) return cores <= 2 || memory <= 2 ? 'low' : 'mid';
  return cores >= 8 && memory >= 8 ? 'high' : 'mid';
}
