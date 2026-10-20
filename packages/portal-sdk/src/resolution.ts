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
  /**
   * Put the scale back when going down didn't make frames faster, and stay there for a while
   * (longer each time). Frames held up by the processor (too many things to draw, physics,
   * scripts) don't get faster with fewer pixels, so going down would only blur the picture.
   */
  detectCpuBound?: boolean;
  /**
   * Something cheaper to give up before pixels (an effect, say): called when frames are too slow,
   * before the scale goes down. Return true when it gave something up; the scale then stays.
   */
  shed?: () => boolean;
  /**
   * Brings back what `shed` gave up, once the scale is back at 1 and frames have been smooth for a
   * while. Return true when it brought something back.
   */
  restore?: () => boolean;
}

/** A step down that made frames less than this much faster (7%) didn't help. */
const NO_FASTER = 0.93;

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
  private readonly detectCpuBound: boolean;
  private readonly shed: (() => boolean) | undefined;
  private readonly restore: (() => boolean) | undefined;
  /** The last step down, judged on the next second: the scale before it and how slow it was. */
  private probe: { scale: number; p90: number } | null = null;
  /** Fewer pixels didn't help: don't go below `floor` until `floorUntil`. */
  private floor = 0;
  private floorUntil = Number.NEGATIVE_INFINITY;
  private floorWait = 10_000;

  constructor(options: ResolutionOptions = {}) {
    this.min = options.min ?? 0.5;
    this.targetMs = options.targetMs ?? 1000 / 60;
    this.detectCpuBound = options.detectCpuBound ?? false;
    this.shed = options.shed;
    this.restore = options.restore;
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

    // The last step down didn't make frames faster: it's not the pixels. Put them back.
    const probe = this.probe;
    this.probe = null;
    if (probe && p90 > probe.p90 * NO_FASTER) {
      this.scale = probe.scale;
      this.floor = probe.scale;
      this.floorUntil = now + this.floorWait;
      this.floorWait = Math.min(120_000, this.floorWait * 2);
      this.smoothWindows = 0;
      this.settleUntil = now + 1000;
      return true;
    }
    const floor = now < this.floorUntil ? Math.max(this.min, this.floor) : this.min;

    if (p90 > this.targetMs * 1.25) {
      // Too slow: give up something cheaper first, then draw fewer pixels.
      const shed = this.shed?.() ?? false;
      if (shed || this.scale > floor) {
        // Going up again just now was too much: wait longer next time.
        if (now - this.lastRaise < 3000) {
          this.patience = Math.min(60, this.patience * 2);
          this.lastRaise = Number.NEGATIVE_INFINITY; // once per step up that didn't last
        }
        if (!shed) {
          if (this.detectCpuBound) this.probe = { scale: this.scale, p90 };
          this.scale = Math.max(floor, Number((this.scale * 0.85).toFixed(3)));
        }
        this.smoothWindows = 0;
        this.settleUntil = now + 1000;
        return !shed;
      }
    }
    if (p90 <= this.targetMs * 1.05) this.smoothWindows++;
    else this.smoothWindows = 0;
    if (this.smoothWindows >= this.patience) {
      if (this.scale < 1) {
        this.scale = Math.min(1, Number((this.scale * 1.1).toFixed(3)));
        this.smoothWindows = 0;
        this.lastRaise = now;
        this.settleUntil = now + 1000;
        return true;
      }
      if (this.restore?.()) {
        this.smoothWindows = 0;
        this.lastRaise = now;
        this.settleUntil = now + 1000;
      }
    }
    return false;
  }
}
