// Writes samples/tall-building/plan.json: a 20-floor block of flats (about 240 rooms) for load
// and streaming tests. It isn't offered as a sample in the app (baking its lighting takes hours).
//   node tools/dev/make-tall-building.mjs
//
// Every floor, 24 × 14 m:
//   z 0–5   stairs (alternating between two spots, so each flight lands beside the next), the
//           lift lobby, and a studio flat
//   z 5–7   the corridor
//   z 7–14  four flats, each a living room and a bedroom
import { writeFileSync } from 'node:fs';

const FLOORS = 20;
const plan = {
  name: 'Tall building',
  spaceType: 'building',
  floors: [],
  rooms: [],
  openings: [],
  stairs: [],
  elevators: [{ key: 'lift', name: 'Lift', stops: [] }],
  furniture: [],
  spawns: [{ key: 'entrance', room: 'lobby', at: [9, 3.6], yaw: 0 }],
};
const STAIR_SPOTS = [
  [0, 0, 3, 5],
  [3, 0, 6, 5],
];

for (let f = 0; f < FLOORS; f++) {
  const key = `f${f}`;
  const ground = f === 0;
  const name = ground ? 'Ground floor' : `Floor ${f}`;
  plan.floors.push({ key, name, elevation: f * 3.3, height: 3.0 });
  const k = (room) => (ground ? room : `${room}-${f}`);

  // The stairs up from this floor (none from the top).
  if (f < FLOORS - 1) {
    const rect = STAIR_SPOTS[f % 2];
    const stairs = `stairs-${f}`;
    plan.rooms.push({
      key: stairs,
      name: `Stairs to floor ${f + 1}`,
      floor: key,
      spansTo: `f${f + 1}`,
      rect,
      floorMaterial: 'concrete',
      wallMaterial: 'plaster',
    });
    plan.stairs.push({
      room: stairs,
      start: [rect[0] + 1.5, 4.6],
      direction: 'north',
      width: 1.0,
      run: 4.2,
      from: key,
      to: `f${f + 1}`,
    });
    // Its doors: onto this floor's corridor, and onto the next floor's.
    plan.openings.push({ kind: 'door', rooms: [stairs, k('corridor')], at: [rect[0] + 1.5, 5] });
    plan.openings.push({
      kind: 'door',
      rooms: [stairs, `corridor-${f + 1}`],
      at: [rect[0] + 0.6, 5],
      level: `f${f + 1}`,
    });
  }
  // Where the stairs from below arrive takes the other spot; on the ground floor it's a cupboard.
  if (ground)
    plan.rooms.push({
      key: 'store',
      name: 'Store',
      floor: key,
      rect: STAIR_SPOTS[1],
      floorMaterial: 'concrete',
      wallMaterial: 'plaster',
    });
  if (ground) plan.openings.push({ kind: 'door', rooms: ['store', 'corridor'], at: [4.5, 5] });

  plan.rooms.push({
    key: ground ? 'lobby' : `lift-${f}`,
    name: ground ? 'Lobby' : `Lift lobby, floor ${f}`,
    floor: key,
    rect: [6, 0, 12, 5],
    floorMaterial: 'tile-light',
    wallMaterial: 'plaster',
  });
  plan.elevators[0].stops.push({ room: ground ? 'lobby' : `lift-${f}`, at: [11.2, 1], yaw: 0 });
  plan.openings.push({
    kind: 'open',
    rooms: [ground ? 'lobby' : `lift-${f}`, k('corridor')],
    at: [9, 5],
    width: 2.4,
  });
  plan.rooms.push({
    key: ground ? 'cafe' : `studio-${f}`,
    name: ground ? 'Café' : `Studio flat ${f}0`,
    floor: key,
    rect: [12, 0, 24, 5],
    floorMaterial: 'oak',
    wallMaterial: 'plaster-warm',
  });
  plan.openings.push({
    kind: ground ? 'open' : 'door',
    rooms: [ground ? 'cafe' : `studio-${f}`, k('corridor')],
    at: [18, 5],
    ...(ground ? { width: 2.4 } : {}),
  });
  plan.openings.push({
    kind: 'window',
    room: ground ? 'cafe' : `studio-${f}`,
    side: 'north',
    at: 18,
    width: 3,
  });
  if (!ground)
    plan.furniture.push({
      key: `studio-${f}-sofa`,
      room: `studio-${f}`,
      kind: 'sofa',
      label: 'Sofa',
      at: [18, 1],
      rotation: 0,
    });
  plan.rooms.push({
    key: k('corridor'),
    name: ground ? 'Corridor' : `Corridor, floor ${f}`,
    floor: key,
    rect: [0, 5, 24, 7],
    floorMaterial: 'carpet-stone',
    wallMaterial: 'plaster',
  });

  for (let n = 0; n < 4; n++) {
    const x = n * 6;
    const flat = `${f}${n + 1}`;
    const living = `living-${flat}`;
    const bedroom = `bedroom-${flat}`;
    plan.rooms.push({
      key: living,
      name: `Flat ${flat}, living room`,
      floor: key,
      rect: [x, 7, x + 6, 11],
      floorMaterial: 'oak',
      wallMaterial: 'plaster-warm',
    });
    plan.rooms.push({
      key: bedroom,
      name: `Flat ${flat}, bedroom`,
      floor: key,
      rect: [x, 11, x + 6, 14],
      floorMaterial: 'carpet-stone',
      wallMaterial: 'plaster',
    });
    plan.openings.push({ kind: 'door', rooms: [living, k('corridor')], at: [x + 3, 7] });
    plan.openings.push({ kind: 'door', rooms: [living, bedroom], at: [x + 1.2, 11] });
    plan.openings.push({ kind: 'window', room: bedroom, side: 'south', at: x + 3, width: 1.6 });
    plan.furniture.push({
      key: `bed-${flat}`,
      room: bedroom,
      kind: 'bed',
      label: 'Bed',
      at: [x + 3.6, 12.6],
    });
  }
}

writeFileSync(
  new URL('../../samples/tall-building/plan.json', import.meta.url),
  `${JSON.stringify(plan, null, 2)}\n`,
);
console.log(
  `${plan.floors.length} floors, ${plan.rooms.length} rooms, ${plan.furniture.length} objects`,
);
