/** Sound groups: each has its own volume, and everything shares one gentle limiter. */
export type BusName = 'music' | 'sfx' | 'ambience' | 'voice' | 'ui';

/**
 * Sound for creations. Browsers only let a frame make sound after a tap inside it, so
 * `unlock()` shows a small "Tap to begin" if sound hasn't started yet. The host fades
 * everything while it pauses you (for example while chat is being typed in).
 */
export class PortalAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Music, effects and ambience go through this, so they dip while people talk. */
  private ducker: GainNode | null = null;
  private readonly buses = new Map<BusName, GainNode>();

  /** The audio context (created on first use). */
  get context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 12;
      // Lets automated checks tell the SDK's own output apart from sounds that skip the groups.
      Object.defineProperty(limiter, Symbol.for('allthespaces.audio.output'), { value: true });
      master.connect(limiter).connect(ctx.destination);
      const ducker = ctx.createGain();
      ducker.connect(master);
      this.ctx = ctx;
      this.master = master;
      this.ducker = ducker;
    }
    return this.ctx;
  }

  /** A sound group to connect your sounds to (music, sfx, ambience, voice, ui). */
  bus(name: BusName): GainNode {
    const ctx = this.context;
    let g = this.buses.get(name);
    if (!g) {
      g = ctx.createGain();
      g.gain.value = name === 'music' ? 0.6 : name === 'ambience' ? 0.5 : 1;
      // Voice and UI sounds stay clear while people talk; the rest dips.
      g.connect((name === 'voice' || name === 'ui' ? this.master : this.ducker) as GainNode);
      this.buses.set(name, g);
    }
    return g;
  }

  setVolume(name: BusName, volume: number) {
    const g = this.bus(name);
    g.gain.setTargetAtTime(Math.max(0, Math.min(1, volume)), this.context.currentTime, 0.05);
  }

  /** Loads a sound file that ships with your creation. */
  async load(url: string | URL): Promise<AudioBuffer> {
    const res = await fetch(url);
    return this.context.decodeAudioData(await res.arrayBuffer());
  }

  /** Plays a loaded sound on a group. */
  play(
    buffer: AudioBuffer,
    options: { bus?: BusName; volume?: number; loop?: boolean; rate?: number } = {},
  ) {
    const ctx = this.context;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = options.loop ?? false;
    src.playbackRate.value = options.rate ?? 1;
    const g = ctx.createGain();
    g.gain.value = options.volume ?? 1;
    src.connect(g).connect(this.bus(options.bus ?? 'sfx'));
    src.start();
    return src;
  }

  /** Starts sound, asking for a tap first if the browser needs one. */
  async unlock(label = 'Tap to begin'): Promise<void> {
    const ctx = this.context;
    if (ctx.state === 'running') return;
    await new Promise<void>((resolve) => {
      const veil = document.createElement('button');
      veil.type = 'button';
      veil.textContent = label;
      veil.style.cssText =
        'position:fixed;inset:0;z-index:2147483600;border:0;background:rgba(245,241,238,.55);' +
        'backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);' +
        'color:#2e2c33;font:500 1.1rem system-ui,sans-serif;cursor:pointer';
      veil.addEventListener('click', async () => {
        await ctx.resume();
        veil.remove();
        resolve();
      });
      document.body.append(veil);
    });
  }

  /** @internal Lowers music, effects and ambience while people talk (`level` 1 = normal). */
  duck(level: number) {
    if (!this.ducker || !this.ctx) return;
    const to = Math.max(0, Math.min(1, level));
    // Down quickly, back up gently.
    this.ducker.gain.setTargetAtTime(to, this.ctx.currentTime, to < 1 ? 0.08 : 0.4);
  }

  /** @internal Fades everything out or back in (the host pausing you). */
  fade(on: boolean) {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.12);
  }
}
