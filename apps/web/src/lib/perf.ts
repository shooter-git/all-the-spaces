/**
 * Sharing how smoothly things run on this device (off unless chosen, per device). Samples are
 * anonymous, stay on the group's server and help pick each kind of device's starting quality.
 */

import type { PerfSample, Tier } from '@ats/api-types';
import { api } from './api.ts';

export type { PerfSample, Tier } from '@ats/api-types';

/** A coarse kind of device: phone, tablet or laptop; its system; a bucket of processor cores. */
export function deviceClass(): string {
  const ua = navigator.userAgent;
  const ipad = ua.includes('Mac') && navigator.maxTouchPoints > 1;
  const os =
    /iPhone|iPad|iPod/.test(ua) || ipad
      ? 'ios'
      : /Android/.test(ua)
        ? 'android'
        : /Mac/.test(ua)
          ? 'mac'
          : /Win/.test(ua)
            ? 'windows'
            : /Linux|CrOS/.test(ua)
              ? 'linux'
              : 'other';
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const short = Math.min(window.screen.width, window.screen.height);
  const form = touch ? (short >= 600 ? 'tablet' : 'phone') : 'laptop';
  const cores = navigator.hardwareConcurrency || 4;
  const bucket = [12, 8, 6, 4, 2].find((n) => cores >= n) ?? 2;
  return `${form}-${os}-${bucket}c`;
}

const SHARE = 'ats.sharePerformance';
const ADVICE = 'ats.tierAdvice';

export function sharing(): boolean {
  try {
    return localStorage.getItem(SHARE) === '1';
  } catch {
    return false;
  }
}
export function setSharing(on: boolean) {
  try {
    if (on) localStorage.setItem(SHARE, '1');
    else localStorage.removeItem(SHARE);
  } catch {
    // Storage blocked: it just won't be remembered.
  }
}

/** Sends a sample, if this device shares them. Never fails loudly. */
export function sendSample(sample: PerfSample) {
  if (!sharing() || document.hidden || !(sample.fps > 0)) return;
  void api('/api/perf', { json: { ...sample, device: deviceClass() } }).catch(() => {});
}

/** The starting quality the server last advised for this kind of device (kept a week). */
export function cachedAdvice(): Tier | null {
  try {
    const a = JSON.parse(localStorage.getItem(ADVICE) ?? 'null') as {
      device: string;
      tier: Tier | null;
      at: number;
    } | null;
    if (!a || a.device !== deviceClass() || Date.now() - a.at > 7 * 86_400_000) return null;
    return a.tier;
  } catch {
    return null;
  }
}
/** Asks the server again (for next time: the view isn't rebuilt mid-visit). */
export async function refreshAdvice() {
  const device = deviceClass();
  const r = await api<{ tier: Tier | null }>(
    `/api/perf/advice?device=${encodeURIComponent(device)}`,
  ).catch(() => null);
  if (!r) return;
  try {
    localStorage.setItem(ADVICE, JSON.stringify({ device, tier: r.tier, at: Date.now() }));
  } catch {
    // Not remembered; asked again next time.
  }
}
