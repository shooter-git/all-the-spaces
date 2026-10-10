/** Timings of recurring work (like sending a state patch), summarised as percentiles. */
export class Timings {
  private samples: number[] = [];

  measure<T>(work: () => T): T {
    const start = performance.now();
    try {
      return work();
    } finally {
      this.samples.push(performance.now() - start);
    }
  }

  /**
   * Summary since the last call; starts a new window. `hist` counts samples in 0.1 ms steps
   * ({ step: count }), so windows can be added up into percentiles over a longer run.
   */
  take(): {
    count: number;
    p50: number;
    p90: number;
    p99: number;
    max: number;
    hist: Record<number, number>;
  } {
    const s = this.samples.sort((a, b) => a - b);
    this.samples = [];
    const at = (q: number) => round(s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0);
    const hist: Record<number, number> = {};
    for (const ms of s) {
      const step = Math.min(1000, Math.floor(ms * 10));
      hist[step] = (hist[step] ?? 0) + 1;
    }
    return { count: s.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: at(1), hist };
  }
}

const round = (ms: number) => Math.round(ms * 1000) / 1000;

/** Share of one CPU core this process used since the last call (all its threads). */
export function cpuMeter() {
  let last = process.cpuUsage();
  let at = performance.now();
  return () => {
    const now = performance.now();
    const used = process.cpuUsage(last);
    last = process.cpuUsage();
    const share = (used.user + used.system) / 1000 / Math.max(1, now - at);
    at = now;
    return Math.round(share * 1000) / 1000;
  };
}
