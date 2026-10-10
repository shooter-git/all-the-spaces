/**
 * The marble table — an example of a shared simulation. A wooden table everyone gathers round:
 * tap to drop a marble, tip the table together, and sink marbles in the corner pockets.
 *
 * It shows: one player (the host) running the simulation at a fixed step while everyone else
 * sends what they do and draws what the host reports; carrying on when the host leaves; many
 * moving things drawn in one go (instancing); the orbit camera; telling a tap from a drag;
 * keyboard-only play; and collision sounds kept within the voice budget.
 */
import { connect } from '@allthespaces/portal';
import { createStage, OrbitRig } from '@allthespaces/portal/three';
import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Plane,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';

const portal = await connect();
portal.progress(0.1, 'Setting up the table');
portal.input.define({ tilt: 'stick', drop: { button: 'Drop a marble' } });

const { renderer, camera, loop } = createStage(portal);
const world = new Scene();
world.background = new Color('#e9e2d6');

// ---- The table -------------------------------------------------------------------------------
const W = 3; // half width (x), metres
const D = 2; // half depth (z)
const R = 0.12; // marble radius
const PEGS = [
  [-1.4, -0.6],
  [-0.4, 0.7],
  [0.6, -0.5],
  [1.5, 0.6],
  [0, -1.2],
] as const;
const PEG_R = 0.16;
const POCKET_R = 0.3;
/** In the corners, just inside the rails. */
const POCKETS = [
  [-W + POCKET_R, -D + POCKET_R],
  [W - POCKET_R, -D + POCKET_R],
  [-W + POCKET_R, D - POCKET_R],
  [W - POCKET_R, D - POCKET_R],
] as const;
const MAX_MARBLES = 48;

world.add(new HemisphereLight('#fbf6ee', '#8a7a64', 1.3));
const sun = new DirectionalLight('#fff3df', 2);
sun.position.set(3, 8, 4);
sun.castShadow = true;
sun.shadow.camera.left = sun.shadow.camera.bottom = -5;
sun.shadow.camera.right = sun.shadow.camera.top = 5;
world.add(sun);

const mat = (color: string, roughness = 0.8, metalness = 0) =>
  new MeshStandardMaterial({ color, roughness, metalness });
const table = new Group(); // tips as the table tilts
world.add(table);
const felt = new Mesh(new BoxGeometry(W * 2, 0.1, D * 2), mat('#5d7a6a', 0.95));
felt.position.y = -0.05;
felt.receiveShadow = true;
table.add(felt);
const wood = mat('#8a6446', 0.6);
for (const [x, z, w, d] of [
  [0, -D - 0.08, W * 2 + 0.32, 0.16],
  [0, D + 0.08, W * 2 + 0.32, 0.16],
  [-W - 0.08, 0, 0.16, D * 2],
  [W + 0.08, 0, 0.16, D * 2],
] as const) {
  const rail = new Mesh(new BoxGeometry(w, 0.22, d), wood);
  rail.position.set(x, 0.06, z);
  rail.castShadow = true;
  table.add(rail);
}
for (const [x, z] of PEGS) {
  const peg = new Mesh(new CylinderGeometry(PEG_R, PEG_R, 0.24, 24), mat('#d9cbb2', 0.5));
  peg.position.set(x, 0.12, z);
  peg.castShadow = true;
  table.add(peg);
}
for (const [x, z] of POCKETS) {
  const hole = new Mesh(new CylinderGeometry(POCKET_R, POCKET_R, 0.02, 32), mat('#1f2421', 1));
  hole.position.set(x, 0.005, z);
  table.add(hole);
}

// Every marble is one instance of a single mesh: one draw call however many there are.
const marbleMesh = new InstancedMesh(
  new SphereGeometry(R, 20, 14),
  mat('#ffffff', 0.15, 0.1),
  MAX_MARBLES,
);
marbleMesh.castShadow = true;
marbleMesh.count = 0;
table.add(marbleMesh);
const HUES = ['#3f5b7c', '#a9503f', '#d1a04a', '#4f7355', '#7d5d8c', '#c7c2b8'];

// ---- The simulation (only the host runs it) --------------------------------------------------
interface Marble {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  color: number;
}
let marbles: Marble[] = [];
let nextId = 1;
let tilt = { x: 0, z: 0 };
/** What each player is doing with the stick (the table tips by everyone's average). */
const tipping = new Map<string, { x: number; z: number; at: number }>();
const STEP = 1 / 120;
let carry = 0;

function addMarble(x: number, z: number) {
  if (Math.abs(x) > W - R || Math.abs(z) > D - R) return;
  marbles.push({ id: nextId++, x, z, vx: 0, vz: 0, color: nextId % HUES.length });
  if (marbles.length > MAX_MARBLES) marbles.shift(); // the oldest goes
}

function step(dt: number) {
  // Tip towards everyone's average, gently.
  const now = performance.now();
  let tx = 0;
  let tz = 0;
  let n = 0;
  for (const [id, t] of tipping) {
    if (now - t.at > 600) tipping.delete(id);
    else {
      tx += t.x;
      tz += t.z;
      n++;
    }
  }
  const aim = n ? { x: (tx / n) * 0.14, z: (tz / n) * 0.14 } : { x: 0, z: 0 };
  tilt = { x: tilt.x + (aim.x - tilt.x) * dt * 4, z: tilt.z + (aim.z - tilt.z) * dt * 4 };

  for (const m of marbles) {
    m.vx += 9.8 * Math.sin(tilt.x) * dt;
    m.vz += 9.8 * Math.sin(tilt.z) * dt;
    const drag = 1 - 0.35 * dt; // rolling resistance
    m.vx *= drag;
    m.vz *= drag;
    m.x += m.vx * dt;
    m.z += m.vz * dt;
    // The rails.
    if (Math.abs(m.x) > W - R) {
      m.x = Math.sign(m.x) * (W - R);
      knock(Math.abs(m.vx));
      m.vx *= -0.6;
    }
    if (Math.abs(m.z) > D - R) {
      m.z = Math.sign(m.z) * (D - R);
      knock(Math.abs(m.vz));
      m.vz *= -0.6;
    }
    for (const [px, pz] of PEGS) bounce(m, px, pz, PEG_R, true);
  }
  // Marbles against each other (few enough to check every pair).
  for (let i = 0; i < marbles.length; i++)
    for (let j = i + 1; j < marbles.length; j++)
      collide(marbles[i] as Marble, marbles[j] as Marble);
  // Into a pocket: gone, and counted.
  const before = marbles.length;
  marbles = marbles.filter(
    (m) => !POCKETS.some(([x, z]) => Math.hypot(m.x - x, m.z - z) < POCKET_R),
  );
  if (marbles.length < before) {
    void portal.session.set(
      'sunk',
      (portal.session.get<number>('sunk') ?? 0) + before - marbles.length,
    );
    plop();
  }
}

/** A marble against something that doesn't move (a peg). */
function bounce(m: Marble, x: number, z: number, r: number, sound: boolean) {
  const dx = m.x - x;
  const dz = m.z - z;
  const dist = Math.hypot(dx, dz);
  if (dist >= r + R || dist === 0) return;
  const nx = dx / dist;
  const nz = dz / dist;
  m.x = x + nx * (r + R);
  m.z = z + nz * (r + R);
  const v = m.vx * nx + m.vz * nz;
  if (v < 0) {
    m.vx -= 1.7 * v * nx;
    m.vz -= 1.7 * v * nz;
    if (sound) knock(-v);
  }
}

function collide(a: Marble, b: Marble) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dist = Math.hypot(dx, dz);
  if (dist >= 2 * R || dist === 0) return;
  const nx = dx / dist;
  const nz = dz / dist;
  const push = (2 * R - dist) / 2;
  a.x -= nx * push;
  a.z -= nz * push;
  b.x += nx * push;
  b.z += nz * push;
  const v = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (v >= 0) return; // already parting
  const j = -0.92 * v; // equal masses: swap most of the speed along the line between them
  a.vx -= j * nx;
  a.vz -= j * nz;
  b.vx += j * nx;
  b.vz += j * nz;
  click(-v);
}

// ---- Sharing it ------------------------------------------------------------------------------
// The host sends where everything is 15 times a second; everyone else draws that, smoothed.
type Snapshot = { tilt: [number, number]; m: number[] };
const shown = new Map<number, { x: number; z: number; color: number }>();
let shownTilt = { x: 0, z: 0 };
let latest: Snapshot | null = null;
const round = (v: number) => Math.round(v * 1000) / 1000;
function snapshot(): Snapshot {
  return {
    tilt: [round(tilt.x), round(tilt.z)],
    m: marbles.flatMap((m) => [m.id, round(m.x), round(m.z), m.color]),
  };
}
portal.session.on<Snapshot>('state', (s) => {
  if (!portal.session.isHost) latest = s;
});
portal.session.on<{ x: number; z: number }>('drop', (p) => {
  if (portal.session.isHost) addMarble(p.x, p.z);
});
portal.session.on<{ x: number; z: number }>('tip', (t, from) => {
  if (portal.session.isHost) tipping.set(from, { ...t, at: performance.now() });
});
// Becoming the host (the last one left): carry on from what was last reported.
portal.session.onHostChange(() => {
  if (!portal.session.isHost || !latest) return;
  marbles = [];
  for (let i = 0; i < latest.m.length; i += 4) {
    const [id, x, z, color] = latest.m.slice(i, i + 4) as [number, number, number, number];
    marbles.push({ id, x, z, vx: 0, vz: 0, color });
    nextId = Math.max(nextId, id + 1);
  }
  tilt = { x: latest.tilt[0], z: latest.tilt[1] };
});

// ---- Doing things: tap to drop, the stick (or keys) to tip -----------------------------------
const rig = new OrbitRig(camera, new Vector3(0, 0, 0), 6.5, { min: 3.5, max: 10 });
rig.elevation = 0.9;
const raycaster = new Raycaster();
const surface = new Plane(new Vector3(0, 1, 0), 0);
let down: { x: number; y: number; at: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, at: performance.now() };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  // A tap (not a drag to look around) drops a marble where it lands on the table.
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
  if (performance.now() - down.at > 400) return;
  const ndc = new Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.ray.intersectPlane(surface, new Vector3());
  if (hit) drop(hit.x, hit.z);
});
// Without a pointer: drop one somewhere along the back of the table.
portal.input.onPress('drop', () => drop((Math.random() - 0.5) * (W * 1.6), -D + 0.4));
function drop(x: number, z: number) {
  if (Math.abs(x) > W || Math.abs(z) > D) return;
  if (portal.session.isHost) addMarble(x, z);
  else portal.session.send('drop', { x: round(x), z: round(z) });
}

// ---- Sound: clicks and knocks, never more than a few at once ---------------------------------
let voices = 0;
function tone(freq: number, gain: number, seconds: number, type: OscillatorType = 'sine') {
  const ctx = portal.audio.context;
  if (ctx.state !== 'running' || voices >= 6) return; // within the low tier's 16 voices
  voices++;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  o.connect(g).connect(portal.audio.bus('sfx'));
  o.start(t);
  o.stop(t + seconds);
  o.onended = () => voices--;
}
const click = (speed: number) =>
  speed > 0.3 && tone(2400 + Math.random() * 600, Math.min(0.12, speed * 0.05), 0.05);
const knock = (speed: number) =>
  speed > 0.4 && tone(180, Math.min(0.2, speed * 0.06), 0.12, 'triangle');
const plop = () => tone(320, 0.15, 0.25);

// ---- Each frame ------------------------------------------------------------------------------
const dummy = new Object3D();
const colors = HUES.map((h) => new Color(h));
let time = 0;
let sent = 0;
let tipSent = 0;
portal.progress(0.8, 'Polishing the marbles');

loop((dt) => {
  time += dt;
  // Tipping: the host knows its own; others tell the host (10 times a second while tipping).
  const s = portal.input.stick('tilt');
  if (portal.session.isHost) {
    if (s.x || s.y) tipping.set(portal.me.id, { x: s.x, z: -s.y, at: performance.now() });
  } else if ((s.x || s.y) && time - tipSent > 0.1) {
    tipSent = time;
    portal.session.send('tip', { x: round(s.x), z: round(-s.y) });
  }

  if (portal.session.isHost) {
    // A fixed step, however fast the screen draws: the same table on every device.
    carry = Math.min(carry + dt, 0.1);
    while (carry >= STEP) {
      step(STEP);
      carry -= STEP;
    }
    shown.clear();
    for (const m of marbles) shown.set(m.id, { x: m.x, z: m.z, color: m.color });
    shownTilt = tilt;
    if (time - sent > 1 / 15 && portal.session.players.length > 1) {
      sent = time;
      portal.session.send('state', snapshot());
    }
  } else if (latest) {
    // Ease towards the last report, so 15 updates a second still look smooth.
    const k = Math.min(1, dt * 14);
    const ids = new Set<number>();
    for (let i = 0; i < latest.m.length; i += 4) {
      const [id, x, z, color] = latest.m.slice(i, i + 4) as [number, number, number, number];
      ids.add(id);
      const was = shown.get(id);
      shown.set(
        id,
        was ? { x: was.x + (x - was.x) * k, z: was.z + (z - was.z) * k, color } : { x, z, color },
      );
    }
    for (const id of shown.keys()) if (!ids.has(id)) shown.delete(id);
    shownTilt = {
      x: shownTilt.x + (latest.tilt[0] - shownTilt.x) * k,
      z: shownTilt.z + (latest.tilt[1] - shownTilt.z) * k,
    };
  }

  table.rotation.set(shownTilt.z, 0, -shownTilt.x);
  let i = 0;
  for (const m of shown.values()) {
    dummy.position.set(m.x, R, m.z);
    dummy.updateMatrix();
    marbleMesh.setMatrixAt(i, dummy.matrix);
    marbleMesh.setColorAt(i, colors[m.color] as Color);
    i++;
  }
  marbleMesh.count = i;
  marbleMesh.instanceMatrix.needsUpdate = true;
  if (marbleMesh.instanceColor) marbleMesh.instanceColor.needsUpdate = true;

  // Without reduced motion, the camera drifts slowly round the table when no one is looking around.
  if (!portal.reducedMotion) rig.azimuth += dt * 0.02;
  rig.update();
  renderer.render(world, camera);
});

// A few marbles to start with, so the table isn't bare.
if (portal.session.isHost && marbles.length === 0)
  for (let k = 0; k < 6; k++) addMarble(-2 + k * 0.8, -1.4 + (k % 2) * 0.3);
portal.progress(1);
portal.ready();
void portal.audio.unlock('Tap to hear the marbles');
