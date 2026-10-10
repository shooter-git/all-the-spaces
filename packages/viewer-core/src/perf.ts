/** Rolling frame-time statistics (for the performance overlay and field telemetry). */
export class FrameStats {
  private readonly samples: number[] = [];
  private readonly size: number;

  constructor(size = 180) {
    this.size = size;
  }

  add(ms: number) {
    this.samples.push(ms);
    if (this.samples.length > this.size) this.samples.shift();
  }

  get average() {
    return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : 0;
  }

  get fps() {
    const avg = this.average;
    return avg > 0 ? 1000 / avg : 0;
  }

  percentile(p: number) {
    if (!this.samples.length) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  }
}
