import type { Room, SpaceManifest } from '@ats/space-format';

/**
 * The sound of the space: a quiet room tone, wind and birds outside (muffled through walls and
 * windows), footsteps that match the floor — yours and other people's, placed where they are —
 * doors swinging, the everyday sounds of a room (typing and clicks at desks in workplaces,
 * chairs, cups at a café counter), and each room's own echo, worked out from its size and
 * surfaces.
 *
 * It plays into an output the app provides (the app owns the volume, the mute switch and when
 * sound may start), so nothing here ever plays before a tap.
 */

export type Surface = 'wood' | 'concrete' | 'carpet' | 'grass';

/** Where the space's sound goes: the app's audio context and a node to connect to. */
export interface AudioOut {
  context: AudioContext;
  output: AudioNode;
}

type Vec = { x: number; y: number; z: number };
type SoundKind = Room['sounds'][number]['kind'];

/** Distance between footsteps, in metres. */
export const STRIDE = 0.68;

/** Recorded sounds (CC0, Kenney): name → number of takes, under the sounds folder. */
const RECORDINGS: Record<string, number> = {
  'footsteps/wood': 5,
  'footsteps/concrete': 5,
  'footsteps/carpet': 5,
  'footsteps/grass': 5,
  'things/door-open': 2,
  'things/door-close': 4,
  'things/creak': 3,
  'things/mouse-click': 1,
};

/**
 * How each floor sounds underfoot. The recordings are all levelled alike, but a step on carpet is
 * much quieter than on wood, and muffled: no heavy thud (the lows go) and no click (the highs go).
 */
export const STEP: Record<Surface, { level: number; highpass?: number; lowpass?: number }> = {
  wood: { level: 1 },
  concrete: { level: 1 },
  grass: { level: 1 },
  carpet: { level: 0.35, highpass: 180, lowpass: 2200 },
};

/** Which footsteps a floor makes. */
export function surfaceOf(room: Pick<Room, 'floorMaterial' | 'isOutdoor'> | null): Surface {
  const m = room?.floorMaterial ?? '';
  if (m.startsWith('carpet') || m.startsWith('fabric')) return 'carpet';
  if (m === 'oak' || m === 'walnut') return 'wood';
  if (m === 'grass') return 'grass';
  return 'concrete'; // tile, stone, concrete
}

/** How much sound each surface soaks up (Sabine absorption coefficients, mid frequencies). */
const ABSORPTION: Record<Surface, number> = { wood: 0.1, concrete: 0.02, carpet: 0.3, grass: 0.6 };

/** Reverberation time (RT60, seconds) of a room from its size and surfaces (Sabine's formula). */
export function reverbTime(room: Room): number {
  if (room.isOutdoor) return 0.15;
  const [x0, y0, z0] = room.bounds.min;
  const [x1, y1, z1] = room.bounds.max;
  const w = x1 - x0;
  const d = z1 - z0;
  const h = Math.min(y1 - y0, 4);
  const volume = w * d * h;
  const floor = w * d;
  const walls = 2 * (w + d) * h;
  // Walls and ceiling are painted plaster; furniture and people add about half a square metre each.
  const absorption =
    floor * ABSORPTION[surfaceOf(room)] +
    floor * 0.05 +
    walls * 0.04 +
    room.objects.length * 0.5 +
    1;
  return Math.min(1.6, Math.max(0.25, (0.161 * volume) / absorption));
}

/** How often each everyday sound happens (seconds between, min–max). */
const EVERY: Record<SoundKind, [number, number]> = {
  typing: [7, 26],
  mouse: [4, 16],
  chair: [25, 80],
  cups: [9, 32],
};

export class SpaceAudio {
  private readonly ctx: AudioContext | null;
  /** The space itself; faded out while you're away (in a creation). */
  private env!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private roomTone!: GainNode;
  private outside!: GainNode;
  private outsideFilter!: BiquadFilterNode;
  /** Sounds from the next room, heard through the wall or doorway. */
  private nextDoor!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private readonly recordings = new Map<string, AudioBuffer[]>();
  private readonly lastTake = new Map<string, number>();
  private room: Room | null = null;
  private walked = 0;
  private birdTimer: number | undefined;
  /** When each everyday sound next happens (audio clock), by room and index. */
  private readonly due = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly manifest: SpaceManifest,
    /** Where the recordings are served (a folder URL ending in `/`). */
    private readonly soundsUrl: string,
    out: AudioOut | null,
  ) {
    this.ctx = out?.context ?? null;
    if (!out) return;
    const ctx = out.context;
    this.env = ctx.createGain();
    this.env.connect(out.output);

    this.reverb = ctx.createConvolver();
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0;
    this.reverb.connect(this.reverbSend).connect(this.env);

    this.nextDoor = ctx.createBiquadFilter();
    this.nextDoor.type = 'lowpass';
    this.nextDoor.frequency.value = 1100;
    const nextDoorLevel = ctx.createGain();
    nextDoorLevel.gain.value = 0.35;
    this.nextDoor.connect(nextDoorLevel).connect(this.env);

    this.noise = whiteNoise(ctx, 0.5);

    // Room tone: very quiet, low air-handling rumble.
    const tone = ctx.createBufferSource();
    tone.buffer = brownNoise(ctx, 4);
    tone.loop = true;
    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = 'lowpass';
    toneFilter.frequency.value = 220;
    this.roomTone = ctx.createGain();
    this.roomTone.gain.value = 0;
    tone.connect(toneFilter).connect(this.roomTone).connect(this.env);
    tone.start();

    // Outside: wind in the trees, and birds. Indoors it's muffled, as if through glass.
    this.outsideFilter = ctx.createBiquadFilter();
    this.outsideFilter.type = 'lowpass';
    this.outside = ctx.createGain();
    this.outside.gain.value = 0;
    this.outsideFilter.connect(this.outside).connect(this.env);
    this.wind(ctx);
    this.scheduleBirds();

    void this.loadRecordings();
  }

  /** Fades the space out (e.g. while a creation is open); `resume` brings it back. */
  pause() {
    if (this.ctx) this.env.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  resume() {
    if (this.ctx) this.env.gain.setTargetAtTime(1, this.ctx.currentTime, 0.3);
  }

  /**
   * Called every frame with where you are, the direction you're facing, how far you walked
   * (metres, on the ground) and whether you jumped somewhere (quick travel, a lift) instead.
   */
  update(
    position: Vec,
    forward: { x: number; z: number },
    moved: number,
    jumped: boolean,
    room: Room | null,
  ) {
    if (room !== this.room) this.enterRoom(room);
    const ctx = this.ctx;
    if (ctx?.state !== 'running') return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(position.x, t, 0.02);
      l.positionY.setTargetAtTime(position.y + 1.6, t, 0.02);
      l.positionZ.setTargetAtTime(position.z, t, 0.02);
      l.forwardX.setTargetAtTime(forward.x, t, 0.02);
      l.forwardY.setTargetAtTime(0, t, 0.02);
      l.forwardZ.setTargetAtTime(forward.z, t, 0.02);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(position.x, position.y + 1.6, position.z);
      l.setOrientation(forward.x, 0, forward.z, 0, 1, 0);
    }
    // Your own footsteps (not while standing, not for jumps between places).
    if (jumped) {
      this.walked = 0;
    } else if (moved > 0) {
      this.walked += moved;
      if (this.walked >= STRIDE) {
        this.walked %= STRIDE;
        this.step(room, null, 0.5);
      }
    }
    this.everydaySounds(t);
  }

  /** Someone else's footstep, heard from where they are. */
  remoteStep(position: Vec, room: Room | null) {
    this.step(room, position, 0.55);
  }

  /** A footstep on a room's floor, sounding like that floor. */
  private step(room: Room | null, at: Vec | null, level: number) {
    const surface = surfaceOf(room);
    const tone = STEP[surface];
    this.play(`footsteps/${surface}`, at, level * tone.level, 0.07, 0, false, tone);
  }

  /** A door swinging open, or clicking shut. */
  door(kind: 'open' | 'close', position: Vec) {
    const at = { x: position.x, y: position.y + 1.1, z: position.z };
    this.play(`things/door-${kind}`, at, kind === 'open' ? 0.4 : 0.32, 0.05);
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.birdTimer);
    if (this.ctx) {
      this.env.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      const env = this.env;
      window.setTimeout(() => env.disconnect(), 300);
    }
  }

  // ---- Internals ----------------------------------------------------------------------------

  private enterRoom(room: Room | null) {
    const first = this.room === null;
    this.room = room;
    const ctx = this.ctx;
    if (!ctx || !room) return;
    const t = ctx.currentTime;
    const tc = first ? 0.01 : 0.6;
    const outdoor = room.isOutdoor;
    // Next to an open doorway onto a balcony or garden, the outside is clearly audible.
    const opensOutside = room.doorways.some(
      (d) => !d.closed && this.manifest.rooms.find((r) => r.key === d.to)?.isOutdoor,
    );
    this.roomTone.gain.setTargetAtTime(outdoor ? 0 : 0.035, t, tc);
    this.outside.gain.setTargetAtTime(outdoor ? 1 : opensOutside ? 0.45 : 0.18, t, tc);
    this.outsideFilter.frequency.setTargetAtTime(
      outdoor ? 16000 : opensOutside ? 2400 : 700,
      t,
      tc,
    );
    // This room's echo: fade out, swap, fade back in (avoids a click).
    const rt = reverbTime(room);
    this.reverbSend.gain.setTargetAtTime(0, t, 0.03);
    window.setTimeout(
      () => {
        if (this.disposed || !this.ctx) return;
        this.reverb.buffer = impulseResponse(this.ctx, rt);
        this.reverbSend.gain.setTargetAtTime(
          outdoor ? 0.05 : 0.22 + rt * 0.12,
          this.ctx.currentTime,
          0.1,
        );
      },
      first ? 0 : 120,
    );
  }

  private async loadRecordings() {
    const ctx = this.ctx;
    if (!ctx) return;
    await Promise.all(
      Object.entries(RECORDINGS).map(async ([name, takes]) => {
        const buffers = await Promise.all(
          Array.from({ length: takes }, async (_, i) => {
            try {
              const res = await fetch(new URL(`${name}_${i}.mp3`, this.soundsUrl));
              if (!res.ok) return null;
              return await ctx.decodeAudioData(await res.arrayBuffer());
            } catch {
              return null;
            }
          }),
        );
        this.recordings.set(
          name,
          buffers.filter((b): b is AudioBuffer => b !== null),
        );
      }),
    );
  }

  /** Where a sound at `at` goes: placed in 3D, and muffled if it's in the next room. */
  private destination(at: Vec | null, fromNextRoom = false): AudioNode[] {
    const ctx = this.ctx as AudioContext;
    if (!at) return [this.env, this.reverb];
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 1.5;
    p.rolloffFactor = 1.2;
    p.maxDistance = 30;
    p.positionX.value = at.x;
    p.positionY.value = at.y + 0.05;
    p.positionZ.value = at.z;
    if (fromNextRoom) {
      p.connect(this.nextDoor);
    } else {
      p.connect(this.env);
      p.connect(this.reverb);
    }
    return [p];
  }

  /** Plays a recording (a different take each time, slightly varied), optionally at a place. */
  private play(
    name: string,
    at: Vec | null,
    level: number,
    vary: number,
    when = 0,
    fromNextRoom = false,
    tone: { highpass?: number; lowpass?: number } = {},
  ) {
    const ctx = this.ctx;
    const takes = this.recordings.get(name);
    if (ctx?.state !== 'running' || !takes?.length) return;
    let i = Math.floor(Math.random() * takes.length);
    if (takes.length > 1 && i === this.lastTake.get(name)) i = (i + 1) % takes.length;
    this.lastTake.set(name, i);
    const src = ctx.createBufferSource();
    src.buffer = takes[i] as AudioBuffer;
    src.playbackRate.value = 1 - vary + Math.random() * vary * 2;
    const gain = ctx.createGain();
    gain.gain.value = level * (0.8 + Math.random() * 0.2);
    // Shaped first where the floor calls for it (carpet: softer, no thud).
    let out: AudioNode = src;
    for (const [type, frequency] of [
      ['highpass', tone.highpass],
      ['lowpass', tone.lowpass],
    ] as const) {
      if (!frequency) continue;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      out.connect(filter);
      out = filter;
    }
    out.connect(gain);
    for (const d of this.destination(at, fromNextRoom)) gain.connect(d);
    src.start(when || ctx.currentTime);
  }

  /** Typing, clicks, chairs and cups in this room and (muffled) the rooms next to it. */
  private everydaySounds(now: number) {
    const here = this.room;
    if (!here) return;
    const nearby = new Set([
      here.key,
      ...here.doorways.flatMap((d) => (!d.closed && d.to ? [d.to] : [])),
    ]);
    for (const room of this.manifest.rooms) {
      if (!nearby.has(room.key)) continue;
      room.sounds.forEach((s, i) => {
        const key = `${room.key}:${i}`;
        const [lo, hi] = EVERY[s.kind];
        const due = this.due.get(key);
        if (due === undefined) {
          // Start at a random point, so desks don't all start typing together.
          this.due.set(key, now + Math.random() * hi);
          return;
        }
        if (due > now) return;
        const at = { x: s.position[0], y: s.position[1], z: s.position[2] };
        const lasts = this.happen(s.kind, at, now, room.key !== here.key);
        this.due.set(key, now + lasts + lo + Math.random() * (hi - lo));
      });
    }
  }

  /** Plays one everyday sound; returns how long it lasts (seconds). */
  private happen(kind: SoundKind, at: Vec, now: number, nextRoom: boolean): number {
    const ctx = this.ctx as AudioContext;
    if (kind === 'mouse') {
      const clicks = Math.random() < 0.2 ? 2 : 1;
      for (let c = 0; c < clicks; c++) {
        this.play('things/mouse-click', at, 0.22, 0.04, now + c * 0.12, nextRoom);
      }
      return 0.3;
    }
    if (kind === 'chair') {
      if (Math.random() < 0.6) this.play('things/creak', at, 0.3, 0.1, now, nextRoom);
      else this.roll(ctx, at, now, nextRoom);
      return 1.2;
    }
    if (kind === 'cups') {
      const clinks = 1 + Math.floor(Math.random() * 3);
      for (let c = 0; c < clinks; c++) {
        this.clink(ctx, at, now + c * (0.18 + Math.random() * 0.3), nextRoom);
      }
      return 1.5;
    }
    // Typing: a burst of keys with a natural rhythm, pauses between words and phrases.
    const keys = 12 + Math.floor(Math.random() * 45);
    const [dest] = this.destination(at, nextRoom);
    let t = now;
    for (let k = 0; k < keys; k++) {
      const space = Math.random() < 0.17;
      this.keystroke(ctx, dest as AudioNode, t, space);
      t += space ? 0.18 + Math.random() * 0.12 : 0.08 + Math.random() * 0.12;
      if (Math.random() < 0.05) t += 0.4 + Math.random() * 0.8; // thinking
    }
    return t - now;
  }

  /** One key press: a short plastic click on top of a soft thock (the space bar is deeper). */
  private keystroke(ctx: AudioContext, dest: AudioNode, t: number, space: boolean) {
    const click = ctx.createBufferSource();
    click.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = space ? 1800 : 3200 + Math.random() * 1500;
    band.Q.value = 1.2;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, t);
    cg.gain.exponentialRampToValueAtTime(space ? 0.05 : 0.07, t + 0.001);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    click.connect(band).connect(cg).connect(dest);
    click.start(t, Math.random() * 0.4, 0.02);

    const thock = ctx.createBufferSource();
    thock.buffer = this.noise;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = space ? 260 : 420;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(space ? 0.16 : 0.1, t + 0.003);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + (space ? 0.05 : 0.03));
    thock.connect(low).connect(tg).connect(dest);
    thock.start(t, Math.random() * 0.4, 0.06);
  }

  /** An office chair rolling a little on its castors. */
  private roll(ctx: AudioContext, at: Vec, t: number, nextRoom: boolean) {
    const [dest] = this.destination(at, nextRoom);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 180 + Math.random() * 120;
    band.Q.value = 0.8;
    const g = ctx.createGain();
    const len = 0.4 + Math.random() * 0.6;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
    g.gain.setValueAtTime(0.12, t + len - 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src
      .connect(band)
      .connect(g)
      .connect(dest as AudioNode);
    src.start(t);
    src.stop(t + len + 0.05);
  }

  /** A spoon against a ceramic cup: a few bright, quickly fading partials. */
  private clink(ctx: AudioContext, at: Vec, t: number, nextRoom: boolean) {
    const [dest] = this.destination(at, nextRoom);
    const base = 2300 + Math.random() * 700;
    for (const [ratio, level, decay] of [
      [1, 0.05, 0.35],
      [2.32, 0.03, 0.22],
      [4.25, 0.015, 0.12],
    ] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = base * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      o.connect(g).connect(dest as AudioNode);
      o.start(t);
      o.stop(t + decay + 0.02);
    }
  }

  private wind(ctx: AudioContext) {
    const src = ctx.createBufferSource();
    src.buffer = pinkNoise(ctx, 6);
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 500;
    band.Q.value = 0.6;
    const gust = ctx.createGain();
    gust.gain.value = 0.05;
    // Slow gusts: the level and pitch of the wind drift.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const depth = ctx.createGain();
    depth.gain.value = 0.03;
    lfo.connect(depth).connect(gust.gain);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.043;
    const depth2 = ctx.createGain();
    depth2.gain.value = 180;
    lfo2.connect(depth2).connect(band.frequency);
    src.connect(band).connect(gust).connect(this.outsideFilter);
    src.start();
    lfo.start();
    lfo2.start();
  }

  /** Birds somewhere outside, singing now and then. */
  private scheduleBirds() {
    const next = 1500 + Math.random() * 6000;
    this.birdTimer = window.setTimeout(() => {
      if (this.ctx?.state === 'running' && !this.disposed) this.bird(this.ctx);
      if (!this.disposed) this.scheduleBirds();
    }, next);
  }

  private bird(ctx: AudioContext) {
    const outdoors = this.manifest.rooms.filter((r) => r.isOutdoor);
    const anchor = outdoors[Math.floor(Math.random() * outdoors.length)] ?? this.room;
    if (!anchor) return;
    const { min, max } = anchor.bounds;
    const angle = Math.random() * Math.PI * 2;
    const far = 8 + Math.random() * 20;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.refDistance = 4;
    panner.rolloffFactor = 1;
    panner.positionX.value = (min[0] + max[0]) / 2 + Math.cos(angle) * far;
    panner.positionY.value = min[1] + 4 + Math.random() * 6;
    panner.positionZ.value = (min[2] + max[2]) / 2 + Math.sin(angle) * far;
    panner.connect(this.outsideFilter);
    // A short phrase: a few quick, sliding notes, a bit different every time.
    const base = 2600 + Math.random() * 1800;
    const notes = 2 + Math.floor(Math.random() * 5);
    let t = ctx.currentTime + 0.05;
    for (let n = 0; n < notes; n++) {
      const len = 0.05 + Math.random() * 0.09;
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f0 = base * (0.85 + Math.random() * 0.4);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * (Math.random() < 0.5 ? 1.35 : 0.72), t + len);
      // A fast flutter makes it sound like a syrinx rather than a whistle.
      const flutter = ctx.createOscillator();
      flutter.frequency.value = 40 + Math.random() * 40;
      const fdepth = ctx.createGain();
      fdepth.gain.value = f0 * 0.04;
      flutter.connect(fdepth).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0005, t + len);
      o.connect(g).connect(panner);
      o.start(t);
      flutter.start(t);
      o.stop(t + len + 0.02);
      flutter.stop(t + len + 0.02);
      t += len + 0.03 + Math.random() * 0.12;
    }
  }
}

function whiteNoise(ctx: BaseAudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function brownNoise(ctx: BaseAudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}

function pinkNoise(ctx: BaseAudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return buffer;
}

/**
 * A room's echo: decaying noise whose length is the room's reverberation time, darker as it
 * fades (air and soft surfaces soak up high frequencies first), slightly different per ear.
 */
export function impulseResponse(ctx: BaseAudioContext, rt60: number) {
  const length = Math.ceil(ctx.sampleRate * rt60);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let low = 0;
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate;
      const decay = Math.exp((-6.9 * t) / rt60);
      // Blend towards a low-passed signal over time.
      const white = Math.random() * 2 - 1;
      const k = Math.min(0.97, 0.3 + t / rt60);
      low = low * k + white * (1 - k);
      data[i] = (white * (1 - t / rt60) + low * (t / rt60) * 2) * decay * 0.5;
    }
  }
  return buffer;
}
