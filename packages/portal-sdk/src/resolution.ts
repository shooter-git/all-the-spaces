/**
 * Dynamic resolution: draws the 3D scene at a lower resolution when frames take too long, and
 * back up when there's room again, so movement stays smooth on any device. Only the 3D picture
 * changes; text and controls drawn in HTML stay sharp.
 *
 * Frame times are judged a second at a time (the 90th percentile, so one hitch doesn't count).
 * Screens synchronise to their refresh rate, so a smooth frame never looks faster than ~16.7 ms
 * at 60 Hz: the scale goes back up after a few smooth seconds, and waits longer each time going
 * up turned out to be too much.
 */
export interface ResolutionOptions {
  /** The lowest scale (of the full resolution) to go down to. */
  min?: number;
  /** The frame time to keep to, in milliseconds (60 frames a second). */
  targetMs?: number;
}

export class ResolutionGovernor {
  /** The share of the full resolution to draw at now (`min`–1). */
  scale = 1;
  private readonly min: number;
  private readonly targetMs: number;
  private samples: number[] = [];
  private windowStart = -1;
  private smoothWindows = 0;
  /** Smooth seconds needed before going up again (doubles when going up didn't last). */
  private patience = 3;
  private lastRaise = Number.NEGATIVE_INFINITY;
  private settleUntil = 0;

  constructor(options: ResolutionOptions = {}) {
    this.min = options.min ?? 0.5;
    this.targetMs = options.targetMs ?? 1000 / 60;
  }

  /** Records one frame (its duration in ms); true when `scale` changed. */
  frame(ms: number, now = performance.now()): boolean {
    // A very long gap is a hidden tab or a pause, not slow drawing.
    if (ms > 250) return false;
    if (this.windowStart < 0) this.windowStart = now;
    this.samples.push(ms);
    if (now - this.windowStart < 1000 || this.samples.length < 20) return false;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
    this.samples = [];
    this.windowStart = now;
    if (now < this.settleUntil) return false;

    if (p90 > this.targetMs * 1.25 && this.scale > this.min) {
      // Too slow: draw fewer pixels. Going up again just now was too much: wait longer next time.
      if (now - this.lastRaise < 3000) {
        this.patience = Math.min(60, this.patience * 2);
        this.lastRaise = Number.NEGATIVE_INFINITY; // once per step up that didn't last
      }
      this.scale = Math.max(this.min, Number((this.scale * 0.85).toFixed(3)));
      this.smoothWindows = 0;
      this.settleUntil = now + 1000;
      return true;
    }
    if (p90 <= this.targetMs * 1.05) this.smoothWindows++;
    else this.smoothWindows = 0;
    if (this.smoothWindows >= this.patience && this.scale < 1) {
      this.scale = Math.min(1, Number((this.scale * 1.1).toFixed(3)));
      this.smoothWindows = 0;
      this.lastRaise = now;
      this.settleUntil = now + 1000;
      return true;
    }
    return false;
  }
}
