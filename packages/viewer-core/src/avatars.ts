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
  type Vector3,
} from 'three';
import { STRIDE } from './audio.ts';
import { disposeObject } from './streamer.ts';

export interface RemotePose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  moving: boolean;
}

interface Snapshot extends RemotePose {
  t: number;
}

interface Avatar {
  root: Group;
  body: Group;
  snapshots: Snapshot[];
  phase: number;
  /** Distance walked since the last footstep. */
  walked: number;
  last: Vector3 | null;
}

/** How far behind real time other people are drawn, so movement can be smoothed between updates. */
const INTERPOLATION_DELAY = 120;

// Shared by every avatar.
const bodyGeometry = new CapsuleGeometry(0.22, 0.85, 6, 16);
const headGeometry = new SphereGeometry(0.17, 20, 14);
const eyeGeometry = new SphereGeometry(0.022, 8, 6);
const headMaterial = new MeshStandardMaterial({ color: '#efe6da', roughness: 0.7 });
const eyeMaterial = new MeshStandardMaterial({ color: '#2e2c33', roughness: 0.4 });

/** Other people in the space: simple, friendly figures with a name above them. */
export class AvatarLayer {
  readonly root = new Group();
  private readonly avatars = new Map<string, Avatar>();
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

  add(id: string, info: { name: string; color: string }, pose?: RemotePose) {
    this.remove(id);
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
    this.root.add(root);
    const avatar: Avatar = {
      root,
      body,
      snapshots: [],
      phase: Math.random() * Math.PI * 2,
      walked: Math.random() * STRIDE,
      last: null,
    };
    this.avatars.set(id, avatar);
    if (pose) this.push(id, pose);
  }

  /** A new position update for someone. */
  push(id: string, pose: RemotePose) {
    const a = this.avatars.get(id);
    if (!a) return;
    const now = performance.now();
    a.snapshots.push({ ...pose, t: now });
    // Keep about a second of history.
    while (a.snapshots.length > 2 && (a.snapshots[0]?.t ?? now) < now - 1000) a.snapshots.shift();
    if (a.snapshots.length === 1) {
      a.root.position.set(pose.x, pose.y, pose.z);
      a.root.rotation.y = pose.yaw;
    }
  }

  remove(id: string) {
    const a = this.avatars.get(id);
    if (!a) return;
    this.root.remove(a.root);
    // Only the per-avatar body material and label are unique; shared geometry stays.
    a.root.traverse((o) => {
      if (o instanceof Mesh && o.material !== headMaterial && o.material !== eyeMaterial)
        o.material.dispose();
      if (o instanceof Sprite) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
    this.avatars.delete(id);
  }

  update(dt: number) {
    this.time += dt;
    const renderAt = performance.now() - INTERPOLATION_DELAY;
    for (const a of this.avatars.values()) {
      const s = a.snapshots;
      if (s.length === 0) continue;
      let from = s[0] as Snapshot;
      let to = from;
      for (let i = 1; i < s.length; i++) {
        const snap = s[i] as Snapshot;
        if (snap.t >= renderAt) {
          to = snap;
          from = s[i - 1] as Snapshot;
          break;
        }
        from = snap;
        to = snap;
      }
      const span = to.t - from.t;
      const k = span > 0 ? Math.min(1, Math.max(0, (renderAt - from.t) / span)) : 1;
      a.root.position.set(
        from.x + (to.x - from.x) * k,
        from.y + (to.y - from.y) * k,
        from.z + (to.z - from.z) * k,
      );
      let dy = to.yaw - from.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      a.root.rotation.y = from.yaw + dy * k;
      // Footsteps: one every stride while walking (not when they jump somewhere).
      const moving = to.moving;
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
    for (const id of [...this.avatars.keys()]) this.remove(id);
    disposeObject(this.root);
  }
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
