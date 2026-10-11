import {
  type PlanRoom,
  type SpacePlan,
  SpacePlan as SpacePlanSchema,
  slopeAt,
  structureCopies,
} from './plan.ts';

/**
 * Checks a space plan the way a careful person would before building it: everything fits, every
 * door is in a wall two rooms share, and everyone can get everywhere. Messages are plain words,
 * with a way to fix each problem (the Architect's AI assistant reads them too).
 */
export interface PlanProblem {
  level: 'error' | 'warning';
  message: string;
  fix?: string;
}

const EPS = 0.02;
/** Walls are shared only when edges agree to the millimetre (as the builder requires). */
const WALL_EPS = 1e-3;
const SIDES = ['north', 'south', 'east', 'west'] as const;

type Side = (typeof SIDES)[number];
interface Edge {
  side: Side;
  /** The shared stretch along the wall. */
  u0: number;
  u1: number;
  /** The wall's position across (z for north/south, x for east/west). */
  at: number;
}

/**
 * The wall two rooms share (as seen from `a`), if any. Rooms on different floors share one only
 * where one of them reaches the other's floor: a stairwell, or a floor that slopes up to it.
 */
export function sharedWall(a: PlanRoom, b: PlanRoom): Edge | null {
  if (a.floor !== b.floor && !a.spansTo && !b.spansTo && !a.slope && !b.slope) return null;
  const [ax0, az0, ax1, az1] = a.rect;
  const [bx0, bz0, bx1, bz1] = b.rect;
  const overlap = (a0: number, a1: number, b0: number, b1: number) => {
    const lo = Math.max(a0, b0);
    const hi = Math.min(a1, b1);
    return hi - lo > WALL_EPS ? ([lo, hi] as const) : null;
  };
  const ox = overlap(ax0, ax1, bx0, bx1);
  const oz = overlap(az0, az1, bz0, bz1);
  if (ox && Math.abs(az0 - bz1) < WALL_EPS) return { side: 'north', u0: ox[0], u1: ox[1], at: az0 };
  if (ox && Math.abs(az1 - bz0) < WALL_EPS) return { side: 'south', u0: ox[0], u1: ox[1], at: az1 };
  if (oz && Math.abs(ax1 - bx0) < WALL_EPS) return { side: 'east', u0: oz[0], u1: oz[1], at: ax1 };
  if (oz && Math.abs(ax0 - bx1) < WALL_EPS) return { side: 'west', u0: oz[0], u1: oz[1], at: ax0 };
  return null;
}

const area = (r: PlanRoom) => (r.rect[2] - r.rect[0]) * (r.rect[3] - r.rect[1]);
const inside = (r: PlanRoom, x: number, z: number, margin = 0) =>
  x >= r.rect[0] - margin &&
  x <= r.rect[2] + margin &&
  z >= r.rect[1] - margin &&
  z <= r.rect[3] + margin;
const m = (n: number) => `${n.toFixed(2)} m`;

export function checkPlan(input: unknown): { plan: SpacePlan | null; problems: PlanProblem[] } {
  const problems: PlanProblem[] = [];
  const error = (message: string, fix?: string) =>
    problems.push({ level: 'error', message, ...(fix ? { fix } : {}) });
  const warn = (message: string, fix?: string) =>
    problems.push({ level: 'warning', message, ...(fix ? { fix } : {}) });

  const parsed = SpacePlanSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20))
      error(`plan.json ${issue.path.join('.') || '(top)'}: ${issue.message}`);
    return { plan: null, problems };
  }
  const plan = parsed.data;
  const floors = new Map(plan.floors.map((f) => [f.key, f]));
  const rooms = new Map<string, PlanRoom>();

  // ---- Keys ---------------------------------------------------------------------------------
  const unique = (what: string, plural: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(k))
        error(
          `The ${what} key "${k}" isn't allowed.`,
          'Use lower-case letters, digits and dashes (like "kitchen" or "dining-chair-1").',
        );
      if (seen.has(k)) error(`Two ${plural} share the key "${k}".`, 'Give each one its own key.');
      seen.add(k);
    }
  };
  unique(
    'floor',
    'floors',
    plan.floors.map((f) => f.key),
  );
  unique(
    'room',
    'rooms',
    plan.rooms.map((r) => r.key),
  );
  unique(
    'furniture',
    'pieces of furniture',
    plan.furniture.map((f) => f.key),
  );
  unique(
    'starting point',
    'starting points',
    plan.spawns.map((s) => s.key),
  );

  // ---- Floors and rooms ----------------------------------------------------------------------
  for (const f of plan.floors)
    if (f.height < 2 || f.height > 6)
      warn(
        `${f.name} is ${m(f.height)} from floor to ceiling.`,
        'Most ceilings are between 2.3 and 3.2 m.',
      );
  for (const r of plan.rooms) {
    rooms.set(r.key, r);
    const [x0, z0, x1, z1] = r.rect;
    if (!floors.has(r.floor)) error(`${r.name} is on a floor that doesn't exist ("${r.floor}").`);
    if (x1 - x0 < 0.6 || z1 - z0 < 0.6)
      error(
        `${r.name} is only ${m(x1 - x0)} × ${m(z1 - z0)}.`,
        "A room's rect is [x0, z0, x1, z1] in metres, with x1 > x0 and z1 > z0.",
      );
    else if (area(r) > (r.outdoor ? 4000 : 400))
      warn(
        `${r.name} is ${Math.round(area(r))} m², which is very large.`,
        'Check the scale (metres per pixel).',
      );
    if (r.spansTo && !floors.has(r.spansTo))
      error(`${r.name} continues up to a floor that doesn't exist ("${r.spansTo}").`);
    if (r.slope) {
      if (r.spansTo)
        error(
          `${r.name} slopes and is a stairwell.`,
          'A sloping floor is its own ramp: leave out "spansTo" (and any stairs in it).',
        );
      const run = r.slope.toward === 'east' || r.slope.toward === 'west' ? x1 - x0 : z1 - z0;
      if (run > 0 && r.slope.rise / run > 0.2)
        warn(
          `${r.name} climbs ${m(r.slope.rise)} over ${m(run)}, steeper than most ramps.`,
          'Car ramps rarely climb more than 1 in 6, ramps for people 1 in 12. Check the rise, or lengthen the room.',
        );
    }
    if (r.parapet !== undefined && !r.outdoor)
      warn(
        `${r.name} has a parapet but isn't outdoors.`,
        'Only outdoor rooms have a low wall at their edge; indoor rooms have full walls.',
      );
  }
  const list = [...rooms.values()];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i] as PlanRoom;
      const b = list[j] as PlanRoom;
      if (a.floor !== b.floor) continue;
      const ox = Math.min(a.rect[2], b.rect[2]) - Math.max(a.rect[0], b.rect[0]);
      const oz = Math.min(a.rect[3], b.rect[3]) - Math.max(a.rect[1], b.rect[1]);
      if (ox > EPS && oz > EPS)
        error(
          `${a.name} and ${b.name} overlap by ${m(ox)} × ${m(oz)}.`,
          "Rooms meet along a wall: one room's edge should be exactly the other's (for example x1 of one = x0 of the next).",
        );
    }

  // Edges that almost meet (within 5 cm) are nearly always meant to be one wall.
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i] as PlanRoom;
      const b = list[j] as PlanRoom;
      if (a.floor !== b.floor || sharedWall(a, b)) continue;
      const pairs: [number, number, string][] = [
        [a.rect[0], b.rect[2], 'x'],
        [a.rect[2], b.rect[0], 'x'],
        [a.rect[1], b.rect[3], 'z'],
        [a.rect[3], b.rect[1], 'z'],
      ];
      for (const [p, q, axis] of pairs) {
        const gap = Math.abs(p - q);
        const spans =
          axis === 'x'
            ? Math.min(a.rect[3], b.rect[3]) - Math.max(a.rect[1], b.rect[1]) > EPS
            : Math.min(a.rect[2], b.rect[2]) - Math.max(a.rect[0], b.rect[0]) > EPS;
        if (gap > WALL_EPS && gap < 0.05 && spans)
          warn(
            `${a.name} and ${b.name} almost share a wall (${axis} = ${p} and ${q}).`,
            "Use exactly the same number on both sides, or doors between them won't fit.",
          );
      }
    }

  // ---- Openings --------------------------------------------------------------------------------
  const links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!links.has(a)) links.set(a, new Set());
    if (!links.has(b)) links.set(b, new Set());
    links.get(a)?.add(b);
    links.get(b)?.add(a);
  };
  for (const o of plan.openings) {
    if (o.kind === 'window') {
      const r = rooms.get(o.room);
      if (!r) {
        error(`A window is in a room that doesn't exist ("${o.room}").`);
        continue;
      }
      const [x0, z0, x1, z1] = r.rect;
      const [lo, hi] = o.side === 'north' || o.side === 'south' ? [x0, x1] : [z0, z1];
      if (o.at - o.width / 2 < lo - EPS || o.at + o.width / 2 > hi + EPS)
        error(
          `A window in the ${o.side} wall of ${r.name} (at ${m(o.at)}, ${m(o.width)} wide) doesn't fit in the wall (${m(lo)} to ${m(hi)}).`,
          `For north and south walls "at" is an x position; for east and west walls, a z position.`,
        );
      const neighbour = list.find((other) => {
        const wall = other !== r ? sharedWall(r, other) : null;
        return (
          wall?.side === o.side && o.at + o.width / 2 > wall.u0 && o.at - o.width / 2 < wall.u1
        );
      });
      if (neighbour)
        warn(
          `A window in ${r.name} faces ${neighbour.name}.`,
          'Windows usually go in outside walls; between rooms, use an opening.',
        );
      continue;
    }
    const [k1, k2] = o.rooms;
    const a = rooms.get(k1);
    const b = rooms.get(k2);
    if (!a || !b) {
      error(
        `A ${o.kind === 'door' ? 'door' : 'opening'} joins a room that doesn't exist ("${!a ? k1 : k2}").`,
      );
      continue;
    }
    const wall = sharedWall(a, b);
    if (!wall) {
      error(
        `The ${o.kind === 'door' ? 'door' : 'opening'} between ${a.name} and ${b.name}: they don't share a wall.`,
        "Two rooms share a wall when an edge of one lies exactly on an edge of the other, overlapping by at least the door's width.",
      );
      continue;
    }
    const along = wall.side === 'north' || wall.side === 'south' ? o.at[0] : o.at[1];
    const across = wall.side === 'north' || wall.side === 'south' ? o.at[1] : o.at[0];
    if (Math.abs(across - wall.at) > 0.1)
      warn(
        `The ${o.kind === 'door' ? 'door' : 'opening'} between ${a.name} and ${b.name} is placed ${m(Math.abs(across - wall.at))} away from their shared wall.`,
        `"at" should be a point on the wall (here ${wall.side === 'north' || wall.side === 'south' ? 'z' : 'x'} = ${m(wall.at)}).`,
      );
    if (along - o.width / 2 < wall.u0 - EPS || along + o.width / 2 > wall.u1 + EPS)
      error(
        `The ${o.kind === 'door' ? 'door' : 'opening'} between ${a.name} and ${b.name} (${m(o.width)} wide) doesn't fit in their shared wall (${m(wall.u0)} to ${m(wall.u1)}).`,
        'Move it along the wall, or make it narrower.',
      );
    if (o.kind === 'door' && o.width < 0.6)
      warn(`The door between ${a.name} and ${b.name} is only ${m(o.width)} wide.`);
    // Where a sloping floor meets another, they must be at the same height at the opening.
    if ((a.slope || b.slope) && !o.level) {
      const height = (r: PlanRoom) =>
        (floors.get(r.floor)?.elevation ?? 0) + slopeAt(r, o.at[0], o.at[1]);
      const [ha, hb] = [height(a), height(b)];
      if (Math.abs(ha - hb) > 0.05)
        error(
          `The floors don't meet at the ${o.kind === 'door' ? 'door' : 'opening'} between ${a.name} and ${b.name}: ${a.name} is at ${m(ha)} there, ${b.name} at ${m(hb)}.`,
          "Move the opening to where they're level, or change a floor's elevation or a slope's rise so they meet.",
        );
    }
    link(k1, k2);
  }
  for (const s of plan.stairs) {
    const r = rooms.get(s.room);
    if (!r) {
      error(`Stairs are in a room that doesn't exist ("${s.room}").`);
      continue;
    }
    const from = floors.get(s.from);
    const to = floors.get(s.to);
    if (!from || !to) {
      error(
        `The stairs in ${r.name} go between floors that don't exist ("${s.from}" to "${s.to}").`,
        'Use the keys of two floors in "floors".',
      );
      continue;
    }
    if (to.elevation <= from.elevation)
      error(
        `The stairs in ${r.name} go from ${from.name} down to ${to.name}.`,
        '"from" is the lower floor and "to" the upper one; "direction" is the way you walk going up.',
      );
    if (r.slope)
      error(
        `${r.name} holds stairs but its floor slopes.`,
        'Put stairs in a level stairwell; a sloping floor is a ramp of its own.',
      );
    // Stairs join the floors of their stairwell: a room on the lower floor that spans up to the
    // upper one (so it's open between them).
    if (r.floor !== s.from || r.spansTo !== s.to)
      error(
        `${r.name} holds stairs from ${from.name} to ${to.name}, but it isn't a stairwell between them.`,
        `Give ${r.name} "floor": "${s.from}" and "spansTo": "${s.to}".`,
      );
    // The flight fits in the room: both edges at the bottom step and at the top.
    const d = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[s.direction];
    const lateral = s.direction === 'north' || s.direction === 'south' ? [1, 0] : [0, 1];
    const corners = [0, s.run].flatMap((along) =>
      [-s.width / 2, s.width / 2].map(
        (side) =>
          [
            s.start[0] + (d?.[0] ?? 0) * along + (lateral[0] ?? 0) * side,
            s.start[1] + (d?.[1] ?? 0) * along + (lateral[1] ?? 0) * side,
          ] as const,
      ),
    );
    if (corners.some(([x, z]) => !inside(r, x, z, 0.02)))
      error(
        `The stairs in ${r.name} don't fit in it (${m(s.width)} wide, ${m(s.run)} long, going ${s.direction}).`,
        'Move "start" (the bottom step) or shorten the run so the whole flight is inside the room.',
      );
    const rise = to.elevation - from.elevation;
    if (rise > 0 && rise / s.run > 0.9)
      warn(
        `The stairs in ${r.name} are very steep (${m(rise)} up over ${m(s.run)}).`,
        `A comfortable flight runs about ${m(rise / 0.7)} for that height.`,
      );
  }
  for (const e of plan.elevators) {
    const stops = e.stops.map((s) => s.room);
    for (const r of stops)
      if (!rooms.has(r)) error(`${e.name} stops at a room that doesn't exist ("${r}").`);
    for (let i = 1; i < stops.length; i++) link(stops[0] as string, stops[i] as string);
  }

  // A sloping floor needs head room under whatever is above it.
  for (const r of list) {
    if (!r.slope) continue;
    const base = floors.get(r.floor)?.elevation ?? 0;
    for (const q of list) {
      const above = floors.get(q.floor)?.elevation ?? 0;
      if (q === r || above <= base) continue;
      const ox0 = Math.max(r.rect[0], q.rect[0]);
      const oz0 = Math.max(r.rect[1], q.rect[1]);
      const ox1 = Math.min(r.rect[2], q.rect[2]);
      const oz1 = Math.min(r.rect[3], q.rect[3]);
      if (ox1 - ox0 <= EPS || oz1 - oz0 <= EPS) continue;
      const highest = Math.max(
        ...[
          [ox0, oz0],
          [ox1, oz0],
          [ox0, oz1],
          [ox1, oz1],
        ].map(([x, z]) => base + slopeAt(r, x as number, z as number)),
      );
      if (highest + 2 > above - 0.12)
        warn(
          `${r.name} rises to ${m(highest)} under ${q.name} (whose floor is at ${m(above)}): not enough head room.`,
          'Leave the space above a ramp open, or check its rise and the floor elevations.',
        );
    }
  }

  // ---- The building's structure ------------------------------------------------------------------
  let copies = 0;
  for (const s of plan.structure ?? []) {
    const r = rooms.get(s.room);
    const what = s.label ?? 'A piece of structure';
    if (!r) {
      error(`${what} is in a room that doesn't exist ("${s.room}").`);
      continue;
    }
    const reach = Math.max(s.size[0], s.size[2]) / 2 + 0.05;
    const outside = structureCopies(s).find(([x, z]) => !inside(r, x, z, reach));
    if (outside)
      error(
        `${what} in ${r.name} is outside it (at ${m(outside[0])}, ${m(outside[1])}).`,
        `Its "at" is the centre of its footprint (the first copy, with "repeat"); ${r.name} is [${r.rect.join(', ')}].`,
      );
    copies += s.repeat?.count ?? 1;
  }
  if (copies > 3000)
    warn(
      `The structure has ${copies} pieces, which will be slow to load.`,
      'Keep to the ones people would notice (columns, beams, panels on the outside).',
    );

  // ---- Furniture and where people start --------------------------------------------------------
  for (const f of plan.furniture) {
    const r = rooms.get(f.room);
    if (!r) {
      error(`${f.label} is in a room that doesn't exist ("${f.room}").`);
      continue;
    }
    if (!inside(r, f.at[0], f.at[1], 0.05))
      error(
        `${f.label} is outside ${r.name} (at ${m(f.at[0])}, ${m(f.at[1])}).`,
        `Its "at" is its centre on the floor; ${r.name} is [${r.rect.join(', ')}].`,
      );
  }
  for (const s of plan.spawns) {
    const r = rooms.get(s.room);
    if (!r) error(`The starting point "${s.key}" is in a room that doesn't exist ("${s.room}").`);
    else if (!inside(r, s.at[0], s.at[1]))
      error(`The starting point "${s.key}" is outside ${r.name}.`);
    else {
      const blocked = plan.furniture.find((f) => {
        if (f.room !== r.key || f.kind === 'rug' || f.kind === 'frame') return false;
        const [sw = 0.8, , sd = 0.8] = f.size ?? [];
        const turned = Math.abs(Math.round(f.rotation / 90)) % 2 === 1;
        const [w, d] = turned ? [sd, sw] : [sw, sd];
        return (
          Math.abs(f.at[0] - s.at[0]) < w / 2 + 0.25 && Math.abs(f.at[1] - s.at[1]) < d / 2 + 0.25
        );
      });
      if (blocked)
        warn(
          `People start right next to (or inside) the ${blocked.label.toLowerCase()} in ${r.name}.`,
          'Move the starting point to a clear spot.',
        );
    }
  }

  // ---- Everyone can get everywhere ---------------------------------------------------------------
  const start = plan.spawns[0]?.room;
  if (start && rooms.has(start)) {
    // Stairwells that span floors join those floors' rooms that open onto them.
    const reached = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const k = queue.shift() as string;
      for (const n of links.get(k) ?? []) {
        if (!reached.has(n)) {
          reached.add(n);
          queue.push(n);
        }
      }
    }
    const unreached = list.filter((r) => !reached.has(r.key));
    if (unreached.length)
      error(
        `${unreached.map((r) => r.name).join(', ')} can't be reached from where people start.`,
        'Add a door or opening between each of them and a room people can already reach.',
      );
  }
  return { plan, problems };
}
