import type { AudioOut } from '@ats/viewer-core';
import { useSyncExternalStore } from 'react';

/**
 * The app's one sound system. The space's ambience plays into it, and so do chat alerts and the
 * soft transitions in and out of creations — which is why it lives here rather than in the 3D
 * view: it keeps working while the space is unloaded (on phones, while you're in a creation).
 *
 * Browsers only allow sound after a tap or key press; until then everything stays silent.
 */

export interface SoundPrefs {
  on: boolean;
  volume: number;
}

const KEY = 'ats.sound';

function readPrefs(): SoundPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved && typeof saved.on === 'boolean' && typeof saved.volume === 'number') return saved;
  } catch {}
  return { on: true, volume: 0.8 };
}

class AppSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private prefs = readPrefs();
  private lastChime = -10;
  /** People are talking (voice chat): the space's own sounds dip. */
  private ducked = false;
  private readonly listeners = new Set<() => void>();

  /** Where the space plays its sound (creates the audio system on first use). */
  out(): AudioOut {
    const ctx = this.ensure();
    return { context: ctx, output: this.master };
  }

  getPrefs = () => this.prefs;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setPrefs(prefs: SoundPrefs) {
    this.prefs = prefs;
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {}
    this.apply();
    for (const l of this.listeners) l();
  }

  private ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // A gentle limiter so nothing ever gets harsh.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 8;
    this.master.connect(limiter).connect(ctx.destination);
    this.apply();
    // Sound may start at the first tap or key press (and again after the tab is backgrounded).
    const wake = () => {
      if (ctx.state !== 'running') void ctx.resume();
    };
    for (const e of ['pointerdown', 'keydown', 'touchend'] as const) {
      window.addEventListener(e, wake, { capture: true });
    }
    return ctx;
  }

  private apply() {
    if (!this.ctx) return;
    const level = (this.prefs.on ? this.prefs.volume : 0) * (this.ducked ? 0.35 : 1);
    this.master.gain.setTargetAtTime(level, this.ctx.currentTime, this.ducked ? 0.08 : 0.4);
  }

  /** Lowers the space's own sounds while people talk (and brings them back after). */
  duck(on: boolean) {
    if (on === this.ducked) return;
    this.ducked = on;
    this.apply();
  }

  /** The audio system (voice chat plays through it too, outside the space's own sounds). */
  context(): AudioContext {
    return this.ensure();
  }

  private get live() {
    const ctx = this.ctx;
    return ctx && ctx.state === 'running' && this.prefs.on ? ctx : null;
  }

  /**
   * A soft chime for a new chat message: two rising notes, or three for a message to you alone.
   * At most one every few seconds, so a busy conversation never becomes a string of pings.
   */
  chime(kind: 'message' | 'direct' = 'message') {
    const ctx = this.live;
    if (!ctx || ctx.currentTime - this.lastChime < 2.5) return;
    this.lastChime = ctx.currentTime;
    const notes = kind === 'direct' ? [784, 1046.5, 1318.5] : [880, 1318.5];
    for (const [i, f] of notes.entries()) this.bell(ctx, f, ctx.currentTime + i * 0.12, 0.06, 0.6);
  }

  /** Stepping into a creation: a warm chord swells in with a soft rising breath. */
  enter() {
    const ctx = this.live;
    if (!ctx) return;
    // D major 9, spread wide and soft.
    this.pad(ctx, [146.83, 220, 329.63, 369.99, 440], {
      attack: 0.9,
      hold: 0.6,
      release: 1.8,
      open: [500, 2600],
    });
    this.breath(ctx, [380, 2200], 1.5);
  }

  /** The creation appears: one quiet bell, like a door gently opening onto somewhere new. */
  reveal() {
    const ctx = this.live;
    if (!ctx) return;
    this.bell(ctx, 1174.66, ctx.currentTime, 0.035, 2.2);
    this.bell(ctx, 1760, ctx.currentTime + 0.02, 0.018, 1.6);
  }

  /** Coming back to the space: the chord settles downwards as the room fades back in. */
  leave() {
    const ctx = this.live;
    if (!ctx) return;
    // G major 9, falling softly.
    this.pad(ctx, [98, 196, 293.66, 369.99, 440], {
      attack: 0.5,
      hold: 0.4,
      release: 1.9,
      open: [2200, 450],
    });
    this.breath(ctx, [2000, 420], 1.3);
  }

  private bell(ctx: AudioContext, freq: number, t: number, level: number, decay: number) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  private pad(
    ctx: AudioContext,
    freqs: number[],
    shape: { attack: number; hold: number; release: number; open: [number, number] },
  ) {
    const t = ctx.currentTime;
    const end = t + shape.attack + shape.hold + shape.release;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    filter.frequency.setValueAtTime(shape.open[0], t);
    filter.frequency.exponentialRampToValueAtTime(shape.open[1], t + shape.attack + shape.hold);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + shape.attack);
    g.gain.setValueAtTime(0.05, t + shape.attack + shape.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    filter.connect(g).connect(this.master);
    for (const f of freqs) {
      // Two slightly detuned voices per note give a gentle, living shimmer.
      for (const cents of [-5, 5]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        o.detune.value = cents;
        const v = ctx.createGain();
        v.gain.value = 1 / (freqs.length * 2);
        o.connect(v).connect(filter);
        o.start(t);
        o.stop(end + 0.05);
      }
    }
  }

  /** Filtered air sweeping between two pitches: the sense of moving through. */
  private breath(ctx: AudioContext, sweep: [number, number], seconds: number) {
    const t = ctx.currentTime;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.9;
    band.frequency.setValueAtTime(sweep[0], t);
    band.frequency.exponentialRampToValueAtTime(sweep[1], t + seconds);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.022, t + seconds * 0.45);
    g.gain.linearRampToValueAtTime(0, t + seconds);
    src.connect(band).connect(g).connect(this.master);
    src.start(t);
  }
}

export const sound = new AppSound();

/** The current sound settings, kept in sync across the app. */
export function useSoundPrefs(): SoundPrefs {
  return useSyncExternalStore(sound.subscribe, sound.getPrefs);
}
