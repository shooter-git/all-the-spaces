import { Box3, type BufferGeometry, DoubleSide, Line3, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** Collision meshes for the rooms around the viewer, each with its own bounding-volume tree. */
export class CollisionWorld {
  private readonly rooms = new Map<string, MeshBVH>();

  add(roomKey: string, geometry: BufferGeometry) {
    this.rooms.set(roomKey, new MeshBVH(geometry));
  }

  remove(roomKey: string) {
    const bvh = this.rooms.get(roomKey);
    bvh?.geometry.dispose();
    this.rooms.delete(roomKey);
  }

  has(roomKey: string) {
    return this.rooms.has(roomKey);
  }

  get size() {
    return this.rooms.size;
  }

  values() {
    return this.rooms.values();
  }

  /** First hit of a downward/forward ray, used for tap-to-walk. */
  raycastFloor(origin: Vector3, direction: Vector3, far = 60): Vector3 | null {
    let best: Vector3 | null = null;
    let bestDist = far;
    const ray = new Ray(origin, direction);
    for (const bvh of this.rooms.values()) {
      const hit = bvh.raycastFirst(ray, DoubleSide);
      if (hit && hit.distance < bestDist && hit.face && hit.face.normal.y > 0.7) {
        best = hit.point.clone();
        bestDist = hit.distance;
      }
    }
    return best;
  }
}

export interface PlayerOptions {
  radius: number;
  height: number;
  eyeHeight: number;
  walkSpeed: number;
  runSpeed: number;
}

const DEFAULTS: PlayerOptions = {
  radius: 0.28,
  height: 1.7,
  eyeHeight: 1.6,
  walkSpeed: 1.8,
  runSpeed: 3.6,
};
const GRAVITY = -12;
const MAX_STEP = 1 / 30;
/** Further than any walkable drop: falling this far below where you last stood means no floor. */
const FALL_LIMIT = 4;
const DOWN = new Vector3(0, -1, 0);

/**
 * A capsule that walks: it slides along walls and furniture, walks up ramps and stair ramps, and
 * falls with gravity. Position is the point between the feet.
 */
export class PlayerController {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  /** Where you last stood (or arrived), to come back to if a fall never lands. */
  readonly lastGround = new Vector3();
  /** Increments whenever a fall is caught and you're put back where you last stood. */
  recoveries = 0;
  readonly options: PlayerOptions;

  private readonly segment = new Line3();
  private readonly box = new Box3();
  private readonly triPoint = new Vector3();
  private readonly capsulePoint = new Vector3();
  private readonly delta = new Vector3();
  private readonly probe = new Vector3();

  constructor(options: Partial<PlayerOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  teleport(position: Vector3 | [number, number, number], yaw?: number) {
    if (Array.isArray(position)) this.position.set(position[0], position[1] + 0.05, position[2]);
    else this.position.copy(position).setY(position.y + 0.05);
    this.velocity.set(0, 0, 0);
    this.lastGround.copy(this.position);
    if (yaw !== undefined) this.yaw = yaw;
    this.pitch = 0;
  }

  /**
   * Advances the simulation. `move` is the wished-for movement in the player's frame:
   * x = strafe right, z = forward, each in [-1, 1].
   */
  update(dt: number, move: { x: number; z: number; run: boolean }, world: CollisionWorld) {
    // Sub-step long frames so fast movement can't tunnel through thin walls.
    let remaining = Math.min(dt, 0.25);
    while (remaining > 1e-4) {
      const step = Math.min(remaining, MAX_STEP);
      this.step(step, move, world);
      remaining -= step;
    }
  }

  private step(dt: number, move: { x: number; z: number; run: boolean }, world: CollisionWorld) {
    const { walkSpeed, runSpeed } = this.options;
    const speed = move.run ? runSpeed : walkSpeed;
    const len = Math.hypot(move.x, move.z);
    const scale = len > 1 ? 1 / len : 1;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // Forward is -Z rotated by yaw; right is +X rotated by yaw.
    this.velocity.x = (-sin * move.z + cos * move.x) * speed * scale;
    this.velocity.z = (-cos * move.z - sin * move.x) * speed * scale;
    // A light press while grounded keeps contact with the floor without fighting uphill slopes.
    this.velocity.y = this.onGround ? -0.3 : this.velocity.y + GRAVITY * dt;

    const wasGrounded = this.onGround;
    this.position.addScaledVector(this.velocity, dt);
    const pushed = this.resolve(world);
    this.onGround = pushed.y > Math.abs(dt * this.velocity.y * 0.25);

    // Walking down a slope or stairs: snap back onto the ground instead of skipping off it.
    if (wasGrounded && !this.onGround && this.velocity.y <= 0) {
      const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
      const snap = horizontal * dt * 1.5 + 0.02;
      const saved = this.position.clone();
      this.position.y -= snap;
      if (this.resolve(world).y > 0) this.onGround = true;
      else this.position.copy(saved);
    }
    if (this.onGround) {
      this.velocity.y = 0;
      // A spot to come back to: floor right under your middle, not just an edge under your toes.
      this.probe.copy(this.position).setY(this.position.y + 0.1);
      if (world.raycastFloor(this.probe, DOWN, 0.3)) this.lastGround.copy(this.position);
    }

    // Safety net: a fall that doesn't land (a floor that isn't there) puts you back where you
    // last stood, instead of leaving you under the building.
    if (this.position.y < this.lastGround.y - FALL_LIMIT) {
      this.position.copy(this.lastGround);
      this.velocity.set(0, 0, 0);
      this.onGround = false;
      this.recoveries++;
    }
  }

  /** Pushes the capsule out of every nearby surface; returns how far it moved. */
  private resolve(world: CollisionWorld): Vector3 {
    const { radius, height } = this.options;
    this.segment.start.set(this.position.x, this.position.y + radius, this.position.z);
    this.segment.end.set(this.position.x, this.position.y + height - radius, this.position.z);
    const before = this.segment.start.clone();
    for (const bvh of world.values()) {
      this.box.makeEmpty().expandByPoint(this.segment.start).expandByPoint(this.segment.end);
      this.box.min.addScalar(-radius);
      this.box.max.addScalar(radius);
      bvh.shapecast({
        intersectsBounds: (b) => b.intersectsBox(this.box),
        intersectsTriangle: (tri) => {
          const distance = tri.closestPointToSegment(
            this.segment,
            this.triPoint,
            this.capsulePoint,
          );
          if (distance < radius) {
            const depth = radius - distance;
            const dir = this.capsulePoint.sub(this.triPoint).normalize();
            this.segment.start.addScaledVector(dir, depth);
            this.segment.end.addScaledVector(dir, depth);
          }
        },
      });
    }
    this.delta.subVectors(this.segment.start, before);
    const offset = Math.max(0, this.delta.length() - 1e-5);
    const moved = this.delta.clone();
    this.delta.normalize().multiplyScalar(offset);
    this.position.add(this.delta);
    return moved;
  }

  get eye(): Vector3 {
    return new Vector3(this.position.x, this.position.y + this.options.eyeHeight, this.position.z);
  }
}
