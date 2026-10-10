import type { Doorway, SpaceManifest } from '@ats/space-format';
import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { CollisionWorld } from './physics.ts';

const THICKNESS = 0.04;

/**
 * Closed doors for doorways into rooms this person may not see. The manifest says nothing about
 * what's behind them; the door simply stays shut (and solid).
 */
export function closedDoors(manifest: SpaceManifest, world: CollisionWorld): Group {
  const group = new Group();
  group.name = 'closed-doors';
  const wood = new MeshStandardMaterial({ color: '#7a5c42', roughness: 0.55 });
  const metal = new MeshStandardMaterial({ color: '#b8b2a7', roughness: 0.3, metalness: 1 });
  let n = 0;
  for (const room of manifest.rooms) {
    for (const d of room.doorways) {
      if (!d.closed) continue;
      const door = doorMesh(d, wood, metal);
      group.add(door);
      // Solid: a slightly thicker box, so nobody walks (or peeks) through.
      const box = new BoxGeometry(...size(d, 0.12)).translate(0, d.height / 2, 0);
      door.updateMatrix();
      box.applyMatrix4(door.matrix);
      world.add(`door:${n++}`, box.toNonIndexed());
    }
  }
  return group;
}

/** Box dimensions (x, y, z) for a panel filling the doorway. */
function size(d: Doorway, depth: number): [number, number, number] {
  const alongX = Math.abs(d.normal[2]) >= Math.abs(d.normal[0]);
  return alongX ? [d.width, d.height, depth] : [depth, d.height, d.width];
}

function doorMesh(d: Doorway, wood: MeshStandardMaterial, metal: MeshStandardMaterial) {
  const [px, py, pz] = d.position;
  const [nx, , nz] = d.normal;
  // Just inside this room's half of the wall, facing into the room.
  const door = new Group();
  door.position.set(px - nx * (THICKNESS / 2 + 0.01), py, pz - nz * (THICKNESS / 2 + 0.01));
  const leaf = new Mesh(new BoxGeometry(...size(d, THICKNESS)), wood);
  leaf.position.y = d.height / 2;
  leaf.castShadow = true;
  leaf.receiveShadow = true;
  door.add(leaf);
  // A handle on the room's side, near one edge.
  const along = [-nz, nx] as const;
  const handle = new Group();
  const rose = new Mesh(new CylinderGeometry(0.026, 0.026, 0.012, 20), metal);
  rose.rotation.x = Math.PI / 2;
  const knob = new Mesh(new SphereGeometry(0.028, 16, 12), metal);
  knob.position.z = 0.05;
  handle.add(rose, knob);
  handle.position.set(
    along[0] * (d.width / 2 - 0.09) - nx * (THICKNESS / 2),
    0.98,
    along[1] * (d.width / 2 - 0.09) - nz * (THICKNESS / 2),
  );
  handle.lookAt(handle.position.x - nx, handle.position.y, handle.position.z - nz);
  door.add(handle);
  door.updateMatrixWorld(true);
  return door;
}

interface Swing {
  pivot: Group;
  center: Vector3;
  floor: number;
  /** Rotation when shut; opening turns it by up to OPEN_ANGLE, one way or the other. */
  shut: number;
  normal: Vector3;
  /** Which way it swings this time: away from whoever opened it, as people push doors. */
  way: 1 | -1;
  openness: number;
  wantOpen: boolean;
  lastNear: number;
}

/** Turning by +OPEN_ANGLE swings the door's free edge toward its normal. */
const OPEN_ANGLE = (95 * Math.PI) / 180;
/** How close someone has to be for a door to open for them (metres). */
const REACH = 1.7;

/**
 * Real doors (not open passages) swing open as someone walks up to them — you or anyone else —
 * away from them, and ease shut a moment after they've gone. `onSound` hears when one starts opening or clicks
 * shut, for the door sounds.
 */
export class SwingingDoors {
  readonly root = new Group();
  private readonly doors: Swing[] = [];
  onSound?: (kind: 'open' | 'close', at: Vector3) => void;

  constructor(manifest: SpaceManifest) {
    this.root.name = 'doors';
    const wood = new MeshStandardMaterial({ color: '#7a5c42', roughness: 0.55 });
    const metal = new MeshStandardMaterial({ color: '#b8b2a7', roughness: 0.3, metalness: 1 });
    const seen = new Set<string>();
    for (const room of manifest.rooms) {
      for (const d of room.doorways) {
        if (d.kind !== 'door' || d.closed || !d.to) continue;
        // Each doorway is listed by both rooms: build its door once.
        const key = d.position.map((v) => v.toFixed(2)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        this.doors.push(this.build(d, wood, metal));
      }
    }
  }

  private build(d: Doorway, wood: MeshStandardMaterial, metal: MeshStandardMaterial): Swing {
    const [px, py, pz] = d.position;
    const [nx, , nz] = d.normal;
    const ax = -nz;
    const az = nx;
    const pivot = new Group();
    // Hinged at one side of the opening.
    pivot.position.set(px - ax * (d.width / 2), py, pz - az * (d.width / 2));
    const shut = Math.atan2(-az, ax);
    pivot.rotation.y = shut;
    const w = d.width - 0.02;
    const leaf = new Mesh(new BoxGeometry(w, d.height - 0.01, THICKNESS), wood);
    leaf.position.set(w / 2 + 0.01, (d.height - 0.01) / 2, 0);
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    pivot.add(leaf);
    for (const side of [-1, 1]) {
      const knob = new Mesh(new SphereGeometry(0.028, 16, 12), metal);
      knob.position.set(w - 0.08, 0.98, side * (THICKNESS / 2 + 0.03));
      pivot.add(knob);
    }
    this.root.add(pivot);
    return {
      pivot,
      center: new Vector3(px, py, pz),
      floor: py,
      shut,
      normal: new Vector3(nx, 0, nz),
      way: -1,
      openness: 0,
      wantOpen: false,
      lastNear: -Infinity,
    };
  }

  /** Called every frame with where everyone is (feet positions). */
  update(dt: number, people: Vector3[]) {
    const now = performance.now();
    for (const door of this.doors) {
      let nearest: Vector3 | null = null;
      let best = REACH;
      for (const p of people) {
        const d = Math.hypot(p.x - door.center.x, p.z - door.center.z);
        if (Math.abs(p.y - door.floor) < 1.3 && d < best) {
          best = d;
          nearest = p;
        }
      }
      const near = nearest !== null;
      if (near) door.lastNear = now;
      const want = near || now - door.lastNear < 1200;
      if (want && !door.wantOpen && door.openness < 0.1) {
        if (nearest && door.openness < 0.02) {
          const side =
            (nearest.x - door.center.x) * door.normal.x +
            (nearest.z - door.center.z) * door.normal.z;
          door.way = side > 0 ? -1 : 1;
        }
        this.onSound?.('open', door.center);
      }
      const wasOpen = door.openness;
      door.wantOpen = want;
      // Opens briskly, closes gently.
      const speed = want ? 3.2 : 1.8;
      door.openness += ((want ? 1 : 0) - door.openness) * Math.min(1, dt * speed);
      if (!want && door.openness < 0.02) {
        if (wasOpen >= 0.02) this.onSound?.('close', door.center);
        door.openness = 0;
      }
      door.pivot.rotation.y = door.shut + door.way * OPEN_ANGLE * easeInOut(door.openness);
    }
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
