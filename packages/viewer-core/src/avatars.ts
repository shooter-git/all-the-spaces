import {
  CanvasTexture,
  CapsuleGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { STRIDE } from './audio.ts';
import { disposeObject } from './streamer.ts';

export interface RemotePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  moving: boolean;
  /**
   * When the sender took this pose: ms on their own clock (since they joined). Missing or 0 from
   * clients and servers that don't send it; then the time it arrived stands in.
   */
  at?: number;
}

interface Snapshot extends RemotePose {
  /** On the sender's clock (or the arrival time, without one). */
  t: number;
  /** Arrived by jumping (quick travel, a lift): drawn there at once, not walked to. */
  jump: boolean;
}

interface Avatar {
  /** Name and colour: an avatar that left is kept for a while under this, to come back cheaply. */
  key: string;
  root: Group;
  body: Group;
  snapshots: Snapshot[];
  /** Recent (arrival − sent) for the clock offset and jitter, as [arrived, difference]. */
  delays: [number, number][];
  /** Sender time = now − lag; eased towards `targetLag`, so no jumps in time. */
  lag: number | null;
  /** Clock offset plus delay, from the recent updates (see `targetLag`). */
  wantLag: number;
  /** The sender sends their own time (otherwise arrival times stand in). */
  timed: boolean;
  /** Where the drawn position differs from where it should be, fading (after extrapolating). */
  correction: Vector3;
  /** The last frame guessed ahead of the updates. */
  extrapolated: boolean;
  /** An update arrived since the last frame. */
  fresh: boolean;
  /** The latest jump drawn (each is drawn once, at once). */
  jumped: Snapshot | null;
  phase: number;
  /** Distance walked since the last footstep. */
  walked: number;
  last: Vector3 | null;
}

/** Least delay other people are drawn behind their own time, on top of the measured jitter. */
export const BASE_DELAY = 100;
/** Most delay: beyond this, a late update is better guessed than waited for. */
const MAX_DELAY = 300;
/** Without the sender's time, how far behind arrival times people are drawn (as before). */
const ARRIVAL_DELAY = 120;
/** How long the clock offset and jitter are measured over. */
const DELAY_WINDOW = 3000;
/** Longest someone is moved on by guesswork when updates run late. */
export const MAX_EXTRAPOLATION = 180;
/** How quickly a guess that was off fades back to where they really are (seconds). */
const CORRECTION_TIME = 0.12;
/** A gap between updates longer than this means they were standing still in between. */
const STILL_GAP = 250;
/** Faster than this between updates (m/s, plus a metre) is a jump, not walking (as the server). */
const MAX_SPEED = 8;
/** Avatars of people who left view, kept to come back without a new name tag. */
const KEEP_MS = 60_000;
const KEEP_MAX = 32;

// Shared by every avatar.
const bodyGeometry = new CapsuleGeometry(0.22, 0.85, 6, 16);
const headGeometry = new SphereGeometry(0.17, 20, 14);
const eyeGeometry = new SphereGeometry(0.022, 8, 6);
const headMaterial = new MeshStandardMaterial({ color: '#efe6da', roughness: 0.7 });
const eyeMaterial = new MeshStandardMaterial({ color: '#2e2c33', roughness: 0.4 });

const scratch = new Vector3();

/**
 * Other people in the space: simple, friendly figures with a name above them.
 *
 * Each update carries the time the sender took it, so movement is drawn on their clock, not on
 * when updates happen to arrive: a little behind (`BASE_DELAY` plus how unevenly their updates
 * arrive), smoothed between updates, briefly carried on when updates run late.
 */
export class AvatarLayer {
  readonly root = new Group();
  private readonly avatars = new Map<string, Avatar>();
  /** Avatars of people who left view (by name and colour), and when. */
  private readonly kept = new Map<string, { avatar: Avatar; since: number }[]>();
  private keptCount = 0;
  private time = 0;
  /** Someone took a step here (for footstep sounds). */
  onStep?: (position: Vector3) => void;

  constructor() {
    this.root.name = 'avatars';
  }

  get count() {
    return this.avatars.size;
  }

  /** Where everyone is standing (feet). */
  positions(): Vector3[] {
    return [...this.avatars.values()].map((a) => a.root.position);
  }

  add(id: string, info: { name: string; color: string }, pose?: RemotePose, now = clock()) {
    this.remove(id, now);
    const key = `${info.color}\n${info.name}`;
    const avatar = this.takeKept(key) ?? build(key, info);
    this.root.add(avatar.root);
    this.avatars.set(id, avatar);
    if (pose) this.push(id, pose, now);
  }

  /** A new position update for someone. */
  push(id: string, pose: RemotePose, now = clock()) {
    const a = this.avatars.get(id);
    if (!a) return;
    const timed = (pose.at ?? 0) > 0;
    if (timed !== a.timed) {
      // Changed clocks (a newer server, or an older one): start over on the new one.
      a.timed = timed;
      a.snapshots.length = 0;
      a.delays.length = 0;
      a.lag = null;
    }
    const t = timed ? (pose.at as number) : now;
    const prev = a.snapshots.at(-1);
    if (prev && t <= prev.t) return; // out of date
    const gap = prev ? t - prev.t : 0;
    const jump =
      !prev ||
      Math.hypot(pose.x - prev.x, pose.y - prev.y, pose.z - prev.z) > (MAX_SPEED * gap) / 1000 + 1;
    // After a pause (they stood still, sending nothing), they set off just before this update.
    if (prev && !jump && gap > STILL_GAP)
      a.snapshots.push({ ...prev, moving: false, t: t - BASE_DELAY / 2, jump: false });
    a.snapshots.push({ ...pose, t, jump });
    a.fresh = true;
    // Keep about a second of history (at least two updates).
    while (a.snapshots.length > 2 && (a.snapshots[0] as Snapshot).t < t - 1000) a.snapshots.shift();
    if (timed) {
      a.delays.push([now, now - t]);
      while (a.delays.length > 1 && (a.delays[0] as [number, number])[0] < now - DELAY_WINDOW)
        a.delays.shift();
    }
    a.wantLag = targetLag(a);
    if (a.lag === null) {
      a.lag = a.wantLag;
      a.root.position.set(pose.x, pose.y, pose.z);
      a.root.rotation.y = pose.yaw;
    }
  }

  remove(id: string, now = clock()) {
    const a = this.avatars.get(id);
    if (!a) return;
    this.root.remove(a.root);
    this.avatars.delete(id);
    // Kept for a while: someone walking back into view needs no new name tag.
    const list = this.kept.get(a.key) ?? [];
    list.push({ avatar: a, since: now });
    this.kept.set(a.key, list);
    this.keptCount++;
    this.pruneKept(now);
  }

  private takeKept(key: string): Avatar | null {
    const entry = this.kept.get(key)?.pop();
    if (!entry) return null;
    this.keptCount--;
    if (this.kept.get(key)?.length === 0) this.kept.delete(key);
    const a = entry.avatar;
    a.snapshots.length = 0;
    a.delays.length = 0;
    a.lag = null;
    a.wantLag = ARRIVAL_DELAY;
    a.timed = false;
    a.correction.set(0, 0, 0);
    a.extrapolated = false;
    a.fresh = false;
    a.jumped = null;
    a.last = null;
    a.body.position.y = 0;
    a.body.rotation.z = 0;
    return a;
  }

  private pruneKept(now: number) {
    for (const [key, list] of this.kept) {
      while (
        list.length &&
        (now - (list[0] as { since: number }).since > KEEP_MS || this.keptCount > KEEP_MAX)
      ) {
        disposeAvatar((list.shift() as { avatar: Avatar }).avatar);
        this.keptCount--;
      }
      if (list.length === 0) this.kept.delete(key);
    }
  }

  /** Avatars kept for people who left view (for tests). */
  get keptAvatars() {
    return this.keptCount;
  }

  update(dt: number, now = clock()) {
    this.time += dt;
    if (this.keptCount) this.pruneKept(now);
    for (const a of this.avatars.values()) {
      const s = a.snapshots;
      if (s.length === 0 || a.lag === null) continue;
      // Ease the lag towards where it should be, at most 10% faster or slower than real time.
      const ms = dt * 1000;
      a.lag += Math.max(-0.1 * ms, Math.min(0.1 * ms, a.wantLag - a.lag));
      const renderAt = now - a.lag;
      const last = s[s.length - 1] as Snapshot;
      let moving: boolean;
      let extrapolating = false;
      if (renderAt >= last.t) {
        // Updates are late: carry on as they were going, but not for long.
        const prev = s[s.length - 2];
        const ahead = Math.min(renderAt - last.t, MAX_EXTRAPOLATION);
        const span = prev ? last.t - prev.t : 0;
        // (Only on the sender's clock: gaps between arrival times say little about speed.)
        if (a.timed && prev && last.moving && !last.jump && span > 0 && span <= STILL_GAP) {
          const k = ahead / span;
          scratch.set(
            last.x + (last.x - prev.x) * k,
            last.y + (last.y - prev.y) * k,
            last.z + (last.z - prev.z) * k,
          );
          extrapolating = ahead > 0;
        } else {
          scratch.set(last.x, last.y, last.z);
        }
        a.root.rotation.y = last.yaw;
        moving = last.moving;
      } else {
        let i = s.length - 1;
        while (i > 0 && (s[i - 1] as Snapshot).t > renderAt) i--;
        const to = s[i] as Snapshot;
        const from = (s[i - 1] ?? to) as Snapshot;
        if (to.jump || from === to) {
          // Not there yet: they're still where they were until the moment they jumped.
          scratch.set(from.x, from.y, from.z);
          a.root.rotation.y = from.yaw;
          moving = from.moving;
        } else {
          const k = Math.min(1, Math.max(0, (renderAt - from.t) / (to.t - from.t)));
          scratch.set(
            from.x + (to.x - from.x) * k,
            from.y + (to.y - from.y) * k,
            from.z + (to.z - from.z) * k,
          );
          let dy = to.yaw - from.yaw;
          dy = Math.atan2(Math.sin(dy), Math.cos(dy));
          a.root.rotation.y = from.yaw + dy * k;
          moving = to.moving;
        }
      }
      // A guess that turned out wrong fades back rather than jumping; a jump is drawn at once.
      let jump: Snapshot | null = null;
      for (let i = s.length - 1; i >= 0 && !jump; i--) {
        const snap = s[i] as Snapshot;
        if (snap.jump && snap.t <= renderAt) jump = snap;
      }
      if (jump && jump !== a.jumped) {
        a.jumped = jump;
        a.correction.set(0, 0, 0);
      } else if (a.fresh && a.extrapolated) a.correction.copy(a.root.position).sub(scratch);
      a.correction.multiplyScalar(Math.exp(-dt / CORRECTION_TIME));
      a.root.position.copy(scratch).add(a.correction);
      a.extrapolated = extrapolating;
      a.fresh = false;
      // Footsteps: one every stride while walking (not when they jump somewhere).
      if (a.last) {
        const d = Math.hypot(a.root.position.x - a.last.x, a.root.position.z - a.last.z);
        if (d > 1.5) a.walked = 0;
        else if (moving) {
          a.walked += d;
          if (a.walked >= STRIDE) {
            a.walked = 0;
            this.onStep?.(a.root.position);
          }
        }
        a.last.copy(a.root.position);
      } else {
        a.last = a.root.position.clone();
      }
      // A gentle bob while walking.
      a.phase += dt * (moving ? 9 : 0);
      const bob = moving ? Math.abs(Math.sin(a.phase)) * 0.035 : 0;
      a.body.position.y += (bob - a.body.position.y) * Math.min(1, dt * 12);
      a.body.rotation.z = moving ? Math.sin(a.phase) * 0.03 : a.body.rotation.z * 0.9;
    }
  }

  dispose() {
    for (const a of this.avatars.values()) disposeAvatar(a);
    this.avatars.clear();
    for (const list of this.kept.values()) for (const { avatar } of list) disposeAvatar(avatar);
    this.kept.clear();
    this.keptCount = 0;
    disposeObject(this.root);
  }
}

const clock = () => performance.now();

/**
 * How far behind now to draw someone: the sender's clock offset (the quickest any recent update
 * came; that's the network with nothing in the way) plus room for how late updates tend to come
 * on top of that.
 */
function targetLag(a: Avatar) {
  if (!a.timed || a.delays.length === 0) return ARRIVAL_DELAY;
  const d = a.delays.map(([, x]) => x).sort((p, q) => p - q);
  const offset = d[0] as number;
  // Nearly the latest: one very late update shouldn't hold everyone back for long.
  const jitter = (d[Math.floor((d.length - 1) * 0.95)] as number) - offset;
  return offset + Math.min(MAX_DELAY, BASE_DELAY + jitter);
}

/** A new figure: a body in their colour, a head with eyes, and their name above. */
function build(key: string, info: { name: string; color: string }): Avatar {
  const root = new Group();
  const body = new Group();
  const torso = new Mesh(
    bodyGeometry,
    new MeshStandardMaterial({ color: info.color, roughness: 0.75 }),
  );
  torso.position.y = 0.22 + 0.425 + 0.02;
  const head = new Mesh(headGeometry, headMaterial);
  head.position.y = 1.5;
  // Two small eyes so you can tell which way someone is facing (forward is -Z).
  for (const side of [-1, 1]) {
    const eye = new Mesh(eyeGeometry, eyeMaterial);
    eye.position.set(side * 0.06, 1.53, -0.155);
    body.add(eye);
  }
  body.add(torso, head);
  const label = nameLabel(info.name);
  label.position.y = 1.92;
  root.add(body, label);
  return {
    key,
    root,
    body,
    snapshots: [],
    delays: [],
    lag: null,
    wantLag: ARRIVAL_DELAY,
    timed: false,
    correction: new Vector3(),
    extrapolated: false,
    fresh: false,
    jumped: null,
    phase: Math.random() * Math.PI * 2,
    walked: Math.random() * STRIDE,
    last: null,
  };
}

/** Only the per-avatar body material and label are unique; shared geometry stays. */
function disposeAvatar(a: Avatar) {
  a.root.removeFromParent();
  a.root.traverse((o) => {
    if (o instanceof Mesh && o.material !== headMaterial && o.material !== eyeMaterial)
      o.material.dispose();
    if (o instanceof Sprite) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}

/** A readable name tag that always faces the camera. */
function nameLabel(name: string): Sprite {
  const scale = 2;
  const font = `600 ${28 * scale}px "Inter Variable", system-ui, sans-serif`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.font = font;
  const text = name.length > 24 ? `${name.slice(0, 23)}…` : name;
  const padX = 18 * scale;
  const w = Math.ceil(ctx.measureText(text).width + padX * 2);
  const h = 52 * scale;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = 'rgba(251, 249, 247, 0.9)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 14 * scale);
  ctx.fill();
  ctx.fillStyle = '#2e2c33';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, h / 2 + 2 * scale);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, depthWrite: false, transparent: true }),
  );
  const height = 0.2;
  sprite.scale.set((w / h) * height, height, 1);
  sprite.renderOrder = 10;
  return sprite;
}
