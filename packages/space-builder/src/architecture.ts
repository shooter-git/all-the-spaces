import {
  type Doorway,
  type MaterialName,
  type PlanRoom,
  type PlanStructure,
  type Side,
  type SpacePlan,
  slopeAt,
  structureCopies,
} from '@ats/space-format';
import type { MeshBuilder, SurfaceKey, V3 } from './geometry.ts';

/** Each room owns the inner half of every wall around it, so rooms never share geometry. */
export const HALF_WALL = 0.075;
const SLAB = 0.12;
const CEILING = 0.04;
const PARAPET = 1.05;
const EPS = 1e-3;

interface Opening {
  side: Side;
  /** Along-wall interval (x for north/south walls, z for east/west walls). */
  u0: number;
  u1: number;
  /** Vertical interval. */
  v0: number;
  v1: number;
  kind: 'door' | 'open' | 'window';
  to?: string;
}

export class PlanIndex {
  readonly rooms = new Map<string, PlanRoom>();
  readonly floors = new Map<string, SpacePlan['floors'][number]>();
  readonly plan: SpacePlan;

  constructor(plan: SpacePlan) {
    this.plan = plan;
    for (const f of plan.floors) this.floors.set(f.key, f);
    for (const r of plan.rooms) this.rooms.set(r.key, r);
  }

  floor(key: string) {
    const f = this.floors.get(key);
    if (!f) throw new Error(`Unknown floor "${key}"`);
    return f;
  }

  room(key: string) {
    const r = this.rooms.get(key);
    if (!r) throw new Error(`Unknown room "${key}"`);
    return r;
  }

  /** Walking-surface height and ceiling height of a room (where a sloping floor starts). */
  vertical(room: PlanRoom): { base: number; top: number } {
    const f = this.floor(room.floor);
    const topFloor = room.spansTo ? this.floor(room.spansTo) : f;
    return { base: f.elevation, top: topFloor.elevation + topFloor.height };
  }

  /** The height of a room's walking surface at a point (its floor's, unless it slopes). */
  floorAt(room: PlanRoom, x: number, z: number): number {
    return this.floor(room.floor).elevation + slopeAt(room, x, z);
  }

  /** The side of `a` that touches `b`, and the overlapping interval along it. */
  sharedEdge(a: PlanRoom, b: PlanRoom): { side: Side; u0: number; u1: number } | null {
    const [ax0, az0, ax1, az1] = a.rect;
    const [bx0, bz0, bx1, bz1] = b.rect;
    const overlap = (p0: number, p1: number, q0: number, q1: number) => {
      const lo = Math.max(p0, q0);
      const hi = Math.min(p1, q1);
      return hi - lo > EPS ? ([lo, hi] as const) : null;
    };
    const ox = overlap(ax0, ax1, bx0, bx1);
    const oz = overlap(az0, az1, bz0, bz1);
    if (ox && Math.abs(az0 - bz1) < EPS) return { side: 'north', u0: ox[0], u1: ox[1] };
    if (ox && Math.abs(az1 - bz0) < EPS) return { side: 'south', u0: ox[0], u1: ox[1] };
    if (oz && Math.abs(ax1 - bx0) < EPS) return { side: 'east', u0: oz[0], u1: oz[1] };
    if (oz && Math.abs(ax0 - bx1) < EPS) return { side: 'west', u0: oz[0], u1: oz[1] };
    return null;
  }

  /** All openings in a room's walls. */
  openings(room: PlanRoom): Opening[] {
    const out: Opening[] = [];
    for (const o of this.plan.openings) {
      if (o.kind === 'window') {
        if (o.room !== room.key) continue;
        const { base } = this.vertical(room);
        const floor = room.slope ? this.floorAt(room, ...wallPoint(room.rect, o.side, o.at)) : base;
        out.push({
          side: o.side,
          u0: o.at - o.width / 2,
          u1: o.at + o.width / 2,
          v0: floor + o.sill,
          v1: floor + o.sill + o.height,
          kind: 'window',
        });
        continue;
      }
      const [k1, k2] = o.rooms;
      if (room.key !== k1 && room.key !== k2) continue;
      const other = this.room(room.key === k1 ? k2 : k1);
      const edge = this.sharedEdge(room, other);
      if (!edge) throw new Error(`Opening between ${k1} and ${k2}: the rooms don't share a wall`);
      const along = edge.side === 'north' || edge.side === 'south' ? o.at[0] : o.at[1];
      const u0 = Math.max(edge.u0, along - o.width / 2);
      const u1 = Math.min(edge.u1, along + o.width / 2);
      const base = o.level
        ? this.floor(o.level).elevation
        : room.slope || other.slope
          ? Math.max(this.floorAt(room, ...o.at), this.floorAt(other, ...o.at))
          : Math.max(this.floor(room.floor).elevation, this.floor(other.floor).elevation);
      out.push({
        side: edge.side,
        u0,
        u1,
        v0: base,
        v1: base + o.height,
        kind: o.kind,
        to: other.key,
      });
    }
    return out;
  }

  doorways(room: PlanRoom): Doorway[] {
    const [x0, z0, x1, z1] = room.rect;
    return this.openings(room)
      .filter((o): o is Opening & { to: string } => o.kind !== 'window' && Boolean(o.to))
      .map((o) => {
        const mid = (o.u0 + o.u1) / 2;
        const { position, normal } = {
          north: { position: [mid, o.v0, z0] as V3, normal: [0, 0, -1] as V3 },
          south: { position: [mid, o.v0, z1] as V3, normal: [0, 0, 1] as V3 },
          east: { position: [x1, o.v0, mid] as V3, normal: [1, 0, 0] as V3 },
          west: { position: [x0, o.v0, mid] as V3, normal: [-1, 0, 0] as V3 },
        }[o.side];
        return {
          to: o.to,
          kind: o.kind === 'door' ? ('door' as const) : ('open' as const),
          position,
          width: o.u1 - o.u0,
          height: o.v1 - o.v0,
          normal,
        };
      });
  }
}

/**
 * A room as seen from far away (its LOD2 stand-in): its floor and walls as plain boxes in their
 * colours, with doorways and open passages cut through, so a passage looks open from a distance
 * too. The doors themselves are drawn by the viewer, whatever the distance (closed ones too, for
 * rooms someone may not see). Windows stay solid this far away.
 */
export function buildStandIn(index: PlanIndex, room: PlanRoom, mesh: MeshBuilder) {
  if (room.slope) return slopedStandIn(index, room, mesh);
  const [x0, z0, x1, z1] = room.rect;
  const { base, top } = index.vertical(room);
  const wallTop = room.outdoor ? base + (room.parapet ?? STAND_IN_PARAPET) : top;
  const doorways = index.openings(room).filter((o) => o.kind !== 'window');
  mesh.box(room.floorMaterial, [x0, base - 0.12, z0], [x1, base, z1]);
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    if (room.outdoor && touchesIndoorRoom(index, room, side)) continue;
    const along: [number, number] = side === 'north' || side === 'south' ? [x0, x1] : [z0, z1];
    const mine = doorways.filter((o) => o.side === side);
    for (const seg of wallSegments(along, [base, wallTop], mine)) {
      const [min, max] = wallBox(side, room.rect, seg, STAND_IN_WALL);
      mesh.box(room.wallMaterial, min, max);
    }
  }
}
const STAND_IN_WALL = 0.075;
const STAND_IN_PARAPET = 1.05;

/**
 * Walls with openings cut out, floor slab, ceiling, and glazing. `solid` receives the same walls
 * and slabs for collision (glazing included, so windows can't be walked through).
 */
export function buildArchitecture(
  index: PlanIndex,
  room: PlanRoom,
  visual: MeshBuilder,
  solid: MeshBuilder,
  options: { glazing: boolean; trim?: boolean },
) {
  if (room.slope) return slopedArchitecture(index, room, visual, solid, options);
  const [x0, z0, x1, z1] = room.rect;
  const { base, top } = index.vertical(room);
  const wallTop = room.outdoor ? base + (room.parapet ?? PARAPET) : top;
  const openings = index.openings(room);
  const wallMat = room.wallMaterial;

  // Floor slab (top surface at the walking height).
  visual.box(`floor:${room.floorMaterial}`, [x0, base - SLAB, z0], [x1, base, z1]);
  solid.box('concrete', [x0, base - SLAB, z0], [x1, base, z1]);
  if (!room.outdoor) visual.box('plaster', [x0, top, z0], [x1, top + CEILING, z1]);

  for (const side of ['north', 'south', 'east', 'west'] as const) {
    // Outdoor spaces only get a parapet where no building wall is already standing.
    if (room.outdoor && touchesIndoorRoom(index, room, side)) continue;
    const along: [number, number] = side === 'north' || side === 'south' ? [x0, x1] : [z0, z1];
    const mine = openings.filter((o) => o.side === side);
    for (const seg of wallSegments(along, [base, wallTop], mine)) {
      const [min, max] = wallBox(side, room.rect, seg);
      visual.box(wallMat, min, max);
      solid.box('concrete', min, max);
      // Skirting board along the bottom of indoor walls.
      if (options.trim && !room.outdoor && Math.abs(seg.v0 - base) < EPS) {
        visual.box('trim', ...onFace(side, room.rect, seg.u0, seg.u1, base, base + 0.09, 0.014));
      }
    }
    if (options.trim && !room.outdoor) {
      for (const o of mine) {
        if (o.kind === 'window') {
          // Frame around the opening and a sill below it.
          const f = 0.055;
          visual.box('trim', ...onFace(side, room.rect, o.u0 - f, o.u0, o.v0, o.v1, 0.02));
          visual.box('trim', ...onFace(side, room.rect, o.u1, o.u1 + f, o.v0, o.v1, 0.02));
          visual.box('trim', ...onFace(side, room.rect, o.u0 - f, o.u1 + f, o.v1, o.v1 + f, 0.02));
          visual.box(
            'trim',
            ...onFace(side, room.rect, o.u0 - 0.08, o.u1 + 0.08, o.v0 - 0.03, o.v0, 0.07),
          );
        } else if (o.kind === 'door') {
          // Door casing.
          const c = 0.07;
          visual.box('trim', ...onFace(side, room.rect, o.u0 - c, o.u0, o.v0, o.v1, 0.018));
          visual.box('trim', ...onFace(side, room.rect, o.u1, o.u1 + c, o.v0, o.v1, 0.018));
          visual.box('trim', ...onFace(side, room.rect, o.u0 - c, o.u1 + c, o.v1, o.v1 + c, 0.018));
        }
      }
    }
    for (const o of mine) {
      if (o.kind !== 'window') continue;
      // A thin pane in the middle of the wall's half-thickness.
      const [min, max] = wallBox(
        side,
        room.rect,
        { u0: o.u0, u1: o.u1, v0: o.v0, v1: o.v1 },
        0.004,
      );
      if (options.glazing) visual.box('glass', min, max);
      solid.box('concrete', min, max);
    }
  }
}

/**
 * A room whose floor slopes: the same slab, walls, ceiling and openings as a level one, each
 * following the floor (walls and ceiling keep their height above it). No trim: a ramp, a sloping
 * deck or a street doesn't have skirting boards.
 */
function slopedArchitecture(
  index: PlanIndex,
  room: PlanRoom,
  visual: MeshBuilder,
  solid: MeshBuilder,
  options: { glazing: boolean },
) {
  const [x0, z0, x1, z1] = room.rect;
  const { base, top } = index.vertical(room);
  const height = room.outdoor ? (room.parapet ?? PARAPET) : top - base;
  const lift = (x: number, z: number) => index.floorAt(room, x, z);
  const both = (
    key: SurfaceKey,
    a: [number, number],
    b: [number, number],
    lo: number,
    hi: number,
  ) => {
    alongFloor(visual, key, a, b, lo, hi, lift);
    alongFloor(solid, 'concrete', a, b, lo, hi, lift);
  };
  both(`floor:${room.floorMaterial}`, [x0, z0], [x1, z1], -SLAB, 0);
  if (!room.outdoor)
    alongFloor(visual, 'plaster', [x0, z0], [x1, z1], height, height + CEILING, lift);
  const openings = index.openings(room);
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    if (room.outdoor && touchesIndoorRoom(index, room, side)) continue;
    const along: [number, number] = side === 'north' || side === 'south' ? [x0, x1] : [z0, z1];
    // Openings measured from the floor where they are, so they cut the wall that follows it.
    const mine = openings
      .filter((o) => o.side === side)
      .map((o) => {
        const floor = lift(...wallPoint(room.rect, side, (o.u0 + o.u1) / 2));
        return { ...o, v0: o.v0 - floor, v1: o.v1 - floor };
      });
    for (const seg of wallSegments(along, [0, height], mine)) {
      const [min, max] = wallBox(side, room.rect, seg);
      both(room.wallMaterial, [min[0], min[2]], [max[0], max[2]], seg.v0, seg.v1);
    }
    for (const o of mine) {
      if (o.kind !== 'window') continue;
      const [min, max] = wallBox(side, room.rect, { u0: o.u0, u1: o.u1, v0: 0, v1: 0 }, 0.004);
      if (options.glazing)
        alongFloor(visual, 'glass', [min[0], min[2]], [max[0], max[2]], o.v0, o.v1, lift);
      alongFloor(solid, 'concrete', [min[0], min[2]], [max[0], max[2]], o.v0, o.v1, lift);
    }
  }
}

/** A sloping room's stand-in: its floor and walls, following the slope, doorways open. */
function slopedStandIn(index: PlanIndex, room: PlanRoom, mesh: MeshBuilder) {
  const [x0, z0, x1, z1] = room.rect;
  const { base, top } = index.vertical(room);
  const height = room.outdoor ? (room.parapet ?? STAND_IN_PARAPET) : top - base;
  const lift = (x: number, z: number) => index.floorAt(room, x, z);
  alongFloor(mesh, room.floorMaterial, [x0, z0], [x1, z1], -0.12, 0, lift);
  const doorways = index.openings(room).filter((o) => o.kind !== 'window');
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    if (room.outdoor && touchesIndoorRoom(index, room, side)) continue;
    const along: [number, number] = side === 'north' || side === 'south' ? [x0, x1] : [z0, z1];
    const mine = doorways
      .filter((o) => o.side === side)
      .map((o) => {
        const floor = lift(...wallPoint(room.rect, side, (o.u0 + o.u1) / 2));
        return { ...o, v0: o.v0 - floor, v1: o.v1 - floor };
      });
    for (const seg of wallSegments(along, [0, height], mine)) {
      const [min, max] = wallBox(side, room.rect, seg, STAND_IN_WALL);
      alongFloor(mesh, room.wallMaterial, [min[0], min[2]], [max[0], max[2]], seg.v0, seg.v1, lift);
    }
  }
}

/**
 * A box over the footprint [x0, z0]–[x1, z1] whose bottom and top are `lo` and `hi` metres above
 * a sloping floor (`lift` gives its height at a point). Its faces stay flat: the floor is a plane.
 */
function alongFloor(
  mesh: MeshBuilder,
  material: SurfaceKey,
  [x0, z0]: [number, number],
  [x1, z1]: [number, number],
  lo: number,
  hi: number,
  lift: (x: number, z: number) => number,
) {
  const at = (x: number, z: number, h: number): V3 => [x, lift(x, z) + h, z];
  const c = [
    at(x0, z0, lo),
    at(x1, z0, lo),
    at(x1, z0, hi),
    at(x0, z0, hi),
    at(x0, z1, lo),
    at(x1, z1, lo),
    at(x1, z1, hi),
    at(x0, z1, hi),
  ];
  const q = (i: number, j: number, k: number, l: number) =>
    mesh.quad(material, c[i] as V3, c[j] as V3, c[k] as V3, c[l] as V3);
  // The same faces, in the same order, as MeshBuilder.box.
  q(4, 5, 6, 7);
  q(1, 0, 3, 2);
  q(5, 1, 2, 6);
  q(0, 4, 7, 3);
  q(3, 7, 6, 2);
  q(0, 1, 5, 4);
}

/** The point on a room's wall at `u` along it (x for north and south walls, z for east and west). */
function wallPoint(rect: PlanRoom['rect'], side: Side, u: number): [number, number] {
  const [x0, z0, x1, z1] = rect;
  return {
    north: [u, z0] as [number, number],
    south: [u, z1] as [number, number],
    east: [x1, u] as [number, number],
    west: [x0, u] as [number, number],
  }[side];
}

/**
 * The building's own structure in a room (columns, beams, panels, screens): boxes standing on its
 * floor, solid to walk into, part of the room's architecture (so nothing is picked out through
 * them, and they take its baked light).
 */
export function buildStructure(
  index: PlanIndex,
  room: PlanRoom,
  s: PlanStructure,
  visual: MeshBuilder,
  solid: MeshBuilder,
) {
  const [w, h, d] = s.size;
  const angle = (s.rotation * Math.PI) / 180;
  for (const [x, z] of structureCopies(s)) {
    const transform = { angle, origin: [x, index.floorAt(room, x, z) + s.elevation, z] as V3 };
    visual.box(s.material, [-w / 2, 0, -d / 2], [w / 2, h, d / 2], transform);
    solid.box('concrete', [-w / 2, 0, -d / 2], [w / 2, h, d / 2], transform);
  }
}

function touchesIndoorRoom(index: PlanIndex, room: PlanRoom, side: Side): boolean {
  for (const other of index.rooms.values()) {
    if (other === room || other.outdoor) continue;
    const e = index.sharedEdge(room, other);
    if (e && e.side === side) return true;
  }
  return false;
}

interface Segment {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** Splits a wall into solid rectangles around its openings. */
export function wallSegments(
  along: [number, number],
  vertical: [number, number],
  openings: Opening[],
): Segment[] {
  const cuts = new Set<number>([along[0], along[1]]);
  for (const o of openings) {
    cuts.add(Math.min(Math.max(o.u0, along[0]), along[1]));
    cuts.add(Math.min(Math.max(o.u1, along[0]), along[1]));
  }
  const xs = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const u0 = xs[i] as number;
    const u1 = xs[i + 1] as number;
    if (u1 - u0 < EPS) continue;
    // Vertical holes covering this whole interval.
    const holes = openings
      .filter((o) => o.u0 <= u0 + EPS && o.u1 >= u1 - EPS)
      .map((o) => [Math.max(o.v0, vertical[0]), Math.min(o.v1, vertical[1])] as const)
      .filter(([a, b]) => b - a > EPS)
      .sort((a, b) => a[0] - b[0]);
    let v = vertical[0];
    for (const [h0, h1] of holes) {
      if (h0 - v > EPS) out.push({ u0, u1, v0: v, v1: h0 });
      v = Math.max(v, h1);
    }
    if (vertical[1] - v > EPS) out.push({ u0, u1, v0: v, v1: vertical[1] });
  }
  return out;
}

function wallBox(side: Side, rect: PlanRoom['rect'], s: Segment, thickness = HALF_WALL): [V3, V3] {
  const [x0, z0, x1, z1] = rect;
  const inset = side === 'north' || side === 'west' ? 0 : -thickness;
  switch (side) {
    case 'north':
      return [
        [s.u0, s.v0, z0 + inset],
        [s.u1, s.v1, z0 + inset + thickness],
      ];
    case 'south':
      return [
        [s.u0, s.v0, z1 + inset],
        [s.u1, s.v1, z1 + inset + thickness],
      ];
    case 'east':
      return [
        [x1 + inset, s.v0, s.u0],
        [x1 + inset + thickness, s.v1, s.u1],
      ];
    case 'west':
      return [
        [x0 + inset, s.v0, s.u0],
        [x0 + inset + thickness, s.v1, s.u1],
      ];
  }
}

/** A thin box standing proud of a wall's inner face (trim, frames, sills). */
function onFace(
  side: Side,
  rect: PlanRoom['rect'],
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  depth: number,
): [V3, V3] {
  const [x0, z0, x1, z1] = rect;
  switch (side) {
    case 'north': {
      const f = z0 + HALF_WALL;
      return [
        [u0, v0, f],
        [u1, v1, f + depth],
      ];
    }
    case 'south': {
      const f = z1 - HALF_WALL;
      return [
        [u0, v0, f - depth],
        [u1, v1, f],
      ];
    }
    case 'east': {
      const f = x1 - HALF_WALL;
      return [
        [f - depth, v0, u0],
        [f, v1, u1],
      ];
    }
    case 'west': {
      const f = x0 + HALF_WALL;
      return [
        [f, v0, u0],
        [f + depth, v1, u1],
      ];
    }
  }
}

const DIRECTIONS: Record<Side, { d: [number, number]; lateral: [number, number] }> = {
  north: { d: [0, -1], lateral: [1, 0] },
  south: { d: [0, 1], lateral: [1, 0] },
  east: { d: [1, 0], lateral: [0, 1] },
  west: { d: [-1, 0], lateral: [0, 1] },
};

/**
 * Straight stairs: visible steps, a smooth invisible ramp for walking, and a landing at the top
 * that reaches the wall ahead (so upper-floor doorways can be walked to).
 */
export function buildStairs(
  index: PlanIndex,
  stairs: SpacePlan['stairs'][number],
  visual: MeshBuilder,
  solid: MeshBuilder,
  material: MaterialName,
) {
  const room = index.room(stairs.room);
  const from = index.floor(stairs.from).elevation;
  const to = index.floor(stairs.to).elevation;
  const rise = to - from;
  const steps = Math.max(3, Math.round(rise / 0.175));
  const { d, lateral } = DIRECTIONS[stairs.direction];
  const half = stairs.width / 2;
  const p = (along: number, side: number, y: number): V3 => [
    stairs.start[0] + d[0] * along + lateral[0] * side,
    y,
    stairs.start[1] + d[1] * along + lateral[1] * side,
  ];
  const boxBetween = (a: V3, b: V3): [V3, V3] => [
    [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  ];

  for (let i = 0; i < steps; i++) {
    const [min, max] = boxBetween(
      p((i * stairs.run) / steps, -half, from),
      p(((i + 1) * stairs.run) / steps, half, from + ((i + 1) * rise) / steps),
    );
    visual.box(material, min, max);
  }
  // Walking ramp from the bottom edge to the top edge.
  solid.quad(
    'concrete',
    p(0, half, from),
    p(0, -half, from),
    p(stairs.run, -half, to),
    p(stairs.run, half, to),
  );
  solid.quad(
    'concrete',
    p(0, -half, from),
    p(0, half, from),
    p(stairs.run, half, to),
    p(stairs.run, -half, to),
  );

  // Landing from the top step to the wall ahead, across the whole room.
  const [x0, z0, x1, z1] = room.rect;
  const endAlong = stairs.run;
  const endPoint = p(endAlong, 0, to);
  let min: V3;
  let max: V3;
  switch (stairs.direction) {
    case 'north':
      [min, max] = [
        [x0, to - SLAB, z0],
        [x1, to, endPoint[2]],
      ];
      break;
    case 'south':
      [min, max] = [
        [x0, to - SLAB, endPoint[2]],
        [x1, to, z1],
      ];
      break;
    case 'east':
      [min, max] = [
        [endPoint[0], to - SLAB, z0],
        [x1, to, z1],
      ];
      break;
    case 'west':
      [min, max] = [
        [x0, to - SLAB, z0],
        [endPoint[0], to, z1],
      ];
      break;
  }
  visual.box(`floor:${room.floorMaterial}`, min, max);
  solid.box('concrete', min, max);
}
