/**
 * Paper boats — an example of a vehicle. Sail a folded paper boat round the pond, through the
 * buoys in order, against your own best time and everyone else's.
 *
 * It shows: simple boat handling (throttle, steering that needs speed, drift), a chase camera
 * that keeps the boat in view upright and on its side, checkpoints and lap times, a shared board
 * of best times (session values), your own best kept in personal saves, other people's boats
 * moving smoothly (messages), a 2D overlay kept clear of notches, and reduced motion.
 */
import { connect, type Person } from '@allthespaces/portal';
import { createStage } from '@allthespaces/portal/three';
import {
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';

const portal = await connect();
portal.progress(0.1, 'Folding the boats');
portal.input.define({ drive: 'stick', reset: { button: 'Back to the start' } });

const { renderer, camera, loop } = createStage(portal, { fov: 62 });
const world = new Scene();
world.background = new Color('#dde6ea');
world.fog = new Fog('#dde6ea', 30, 80);
world.add(new HemisphereLight('#f1f5f7', '#6d7f6a', 1.5));
const sun = new DirectionalLight('#fff4e2', 2);
sun.position.set(-10, 18, 8);
world.add(sun);
const mat = (color: string, roughness = 0.85) => new MeshStandardMaterial({ color, roughness });

// ---- The pond --------------------------------------------------------------------------------
const POND = 28;
const water = new Mesh(
  new CircleGeometry(POND + 1, 72),
  new MeshStandardMaterial({ color: '#7d9cab', roughness: 0.15, metalness: 0.1 }),
);
water.rotation.x = -Math.PI / 2;
world.add(water);
const shore = new Mesh(new RingGeometry(POND + 1, POND + 14, 72), mat('#b6b58c'));
shore.rotation.x = -Math.PI / 2;
shore.position.y = 0.02;
world.add(shore);
for (let i = 0; i < 40; i++) {
  const a = (i / 40) * Math.PI * 2;
  const reed = new Mesh(new ConeGeometry(0.12, 1.4 + (i % 3) * 0.4, 5), mat('#6f8a5a'));
  reed.position.set(Math.cos(a) * (POND + 1.5), 0.7, Math.sin(a) * (POND + 1.5));
  world.add(reed);
}
const pads = new InstancedMesh(new CircleGeometry(0.7, 16), mat('#7f9d68'), 18);
const dummy = new Object3D();
for (let i = 0; i < 18; i++) {
  const a = i * 2.4;
  const r = 8 + ((i * 7) % 17);
  dummy.position.set(Math.cos(a) * r, 0.03, Math.sin(a) * r);
  dummy.rotation.set(-Math.PI / 2, 0, a);
  dummy.updateMatrix();
  pads.setMatrixAt(i, dummy.matrix);
}
world.add(pads);

// The course: buoys in a loop, passed in order. The first is the start and finish.
const BUOYS = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = (i / 6) * Math.PI * 2;
  const r = i % 2 ? 15 : 21;
  return new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
});
const buoyMeshes = BUOYS.map((p, i) => {
  const buoy = new Group();
  const body = new Mesh(
    new SphereGeometry(0.45, 16, 12),
    mat(i === 0 ? '#3f5b7c' : '#c8653f', 0.6),
  );
  const pole = new Mesh(new CylinderGeometry(0.05, 0.05, 1.4), mat('#e9e4da'));
  pole.position.y = 0.7;
  buoy.add(body, pole);
  buoy.position.copy(p);
  world.add(buoy);
  return body;
});

// ---- Boats -----------------------------------------------------------------------------------
/** A folded paper boat: a hull, and a sail in the middle. */
function paperBoat(tint: string) {
  const boat = new Group();
  const hull = new BufferGeometry();
  // Two sloping sides meeting at a flat bottom, pointed at both ends.
  // biome-ignore format: a table of points reads better
  const v = [
    -1, 0.35, 0,   -0.5, 0.35, 0.42,   -0.5, 0, 0.2,     // left side, back half
    -0.5, 0.35, 0.42,   0.5, 0.35, 0.42,   0.5, 0, 0.2,
    -0.5, 0.35, 0.42,   0.5, 0, 0.2,   -0.5, 0, 0.2,
    0.5, 0.35, 0.42,   1, 0.35, 0,   0.5, 0, 0.2,
    -1, 0.35, 0,   -0.5, 0, -0.2,   -0.5, 0.35, -0.42,  // right side
    -0.5, 0.35, -0.42,   0.5, 0, -0.2,   0.5, 0.35, -0.42,
    -0.5, 0.35, -0.42,   -0.5, 0, -0.2,   0.5, 0, -0.2,
    0.5, 0.35, -0.42,   0.5, 0, -0.2,   1, 0.35, 0,
  ];
  hull.setAttribute('position', new Float32BufferAttribute(v, 3));
  hull.computeVertexNormals();
  const paper = new MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.95, side: DoubleSide });
  boat.add(new Mesh(hull, paper));
  const sail = new BufferGeometry();
  sail.setAttribute(
    'position',
    new Float32BufferAttribute([-0.5, 0.35, 0, 0.5, 0.35, 0, 0, 1.1, 0], 3),
  );
  sail.computeVertexNormals();
  boat.add(
    new Mesh(sail, new MeshStandardMaterial({ color: tint, roughness: 0.9, side: DoubleSide })),
  );
  boat.scale.setScalar(1.3);
  return boat;
}

/** Where you start: a little way back from the start buoy, facing it. */
const START = {
  x: (BUOYS[0]?.x ?? 0) - 1.6,
  z: (BUOYS[0]?.z ?? 0) + 6,
  yaw: Math.PI / 2,
  speed: 0,
};
const me = { ...START };
const myBoat = paperBoat(portal.me.color);
world.add(myBoat);

const others = new Map<string, { boat: Group; target: { x: number; z: number; yaw: number } }>();
function syncPlayers(players: Person[]) {
  const here = new Set(players.map((p) => p.id));
  for (const [id, o] of others)
    if (!here.has(id)) {
      world.remove(o.boat);
      others.delete(id);
    }
  for (const p of players)
    if (p.id !== portal.me.id && !others.has(p.id)) {
      const boat = paperBoat(p.color);
      world.add(boat);
      others.set(p.id, { boat, target: { x: 0, z: 0, yaw: 0 } });
    }
}
syncPlayers(portal.session.players);
portal.session.onPlayers(syncPlayers);
portal.session.on<{ x: number; z: number; yaw: number }>('boat', (b, from) => {
  const o = others.get(from);
  if (o) o.target = b;
});

// A short wake behind your boat.
const WAKE = 40;
const wake = new InstancedMesh(
  new PlaneGeometry(0.35, 0.35),
  new MeshBasicMaterial({ color: '#eef3f5', transparent: true, opacity: 0.55 }),
  WAKE,
);
const wakeSpots = Array.from({ length: WAKE }, () => ({ x: 0, z: 0, age: 9 }));
let wakeNext = 0;
world.add(wake);

// ---- The race --------------------------------------------------------------------------------
let next = 0; // the buoy to pass next: the start, then round, then the start again to finish
let lapStart = 0;
let racing = false;
let best = Number((await portal.save.personal.get<number>('best')) ?? 0) || null;

const hud = document.createElement('div');
hud.className = 'hud';
document.body.append(hud);
const board = document.createElement('ol');
board.className = 'board';
board.setAttribute('aria-label', 'Best times');
document.body.append(board);
const time = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function showBoard() {
  const times = portal.session.players
    .map((p) => ({ p, ms: portal.session.get<number>(`best.${p.id}`) }))
    .filter((t): t is { p: Person; ms: number } => typeof t.ms === 'number')
    .sort((a, b) => a.ms - b.ms)
    .slice(0, 5);
  board.replaceChildren(
    ...times.map((t) => {
      const li = document.createElement('li');
      li.textContent = `${t.p.name} · ${time(t.ms)}`;
      return li;
    }),
  );
}
portal.session.onAnyChange((key) => key.startsWith('best.') && showBoard());
portal.session.onPlayers(showBoard);
showBoard();

function passBuoy(i: number) {
  chime(i === 0 ? 2 : 1);
  if (i === 0) {
    const ms = performance.now() - lapStart;
    if (racing) {
      if (!best || ms < best) {
        best = ms;
        void portal.save.personal.set('best', Math.round(ms));
        void portal.session.set(`best.${portal.me.id}`, Math.round(ms)).then(showBoard);
        portal.ui.toast(`A new best: ${time(ms)}`);
      } else portal.ui.toast(`Round in ${time(ms)}`);
    }
    racing = true;
    lapStart = performance.now();
  }
  next = (i + 1) % BUOYS.length;
}

portal.input.onPress('reset', () => {
  Object.assign(me, START);
  next = 0;
  racing = false;
});

// ---- Sound -----------------------------------------------------------------------------------
function chime(notes: number) {
  const ctx = portal.audio.context;
  if (ctx.state !== 'running') return;
  for (let i = 0; i < notes; i++) {
    const o = ctx.createOscillator();
    o.frequency.value = [784, 1046.5][i] ?? 784;
    const g = ctx.createGain();
    const t = ctx.currentTime + i * 0.12;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1);
    o.connect(g).connect(portal.audio.bus('sfx'));
    o.start(t);
    o.stop(t + 1.1);
  }
}
let lapping: GainNode | null = null;
function startWater() {
  const ctx = portal.audio.context;
  const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < d.length; i++) d[i] = b = 0.97 * b + (Math.random() * 2 - 1) * 0.08;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'lowpass';
  band.frequency.value = 900;
  lapping = ctx.createGain();
  lapping.gain.value = 0.1;
  src.connect(band).connect(lapping).connect(portal.audio.bus('ambience'));
  src.start();
}

// ---- Each frame ------------------------------------------------------------------------------
const MAX = 7; // metres a second
const chase = new Vector3();
let clock = 0;
let sent = 0;
portal.progress(0.8, 'Setting out the buoys');

loop((dt) => {
  clock += dt;
  // Handling: the stick's up/down is the throttle; steering only bites with some speed.
  const s = portal.input.stick('drive');
  me.speed += (s.y * MAX - me.speed) * Math.min(1, dt * (s.y ? 1.2 : 0.6));
  me.yaw -= s.x * dt * 1.8 * Math.min(1, Math.abs(me.speed) / 2) * Math.sign(me.speed || 1);
  me.x += Math.cos(me.yaw) * me.speed * dt;
  me.z -= Math.sin(me.yaw) * me.speed * dt;
  // The bank, and the buoys, are soft walls.
  const r = Math.hypot(me.x, me.z);
  if (r > POND - 0.8) {
    me.x *= (POND - 0.8) / r;
    me.z *= (POND - 0.8) / r;
    me.speed *= 0.6;
  }
  for (const b of BUOYS) {
    const d = Math.hypot(me.x - b.x, me.z - b.z);
    if (d < 1 && d > 0) {
      me.x = b.x + ((me.x - b.x) / d) * 1;
      me.z = b.z + ((me.z - b.z) / d) * 1;
      me.speed *= 0.5;
    }
  }
  const target = BUOYS[next] as Vector3;
  if (Math.hypot(me.x - target.x, me.z - target.z) < 3) passBuoy(next);
  buoyMeshes.forEach((m, i) => {
    m.scale.setScalar(
      i === next ? 1.25 + Math.sin(clock * 4) * (portal.reducedMotion ? 0 : 0.08) : 1,
    );
  });

  const bob = portal.reducedMotion ? 0 : Math.sin(clock * 2.2) * 0.03;
  myBoat.position.set(me.x, bob, me.z);
  myBoat.rotation.set(bob * 0.6, me.yaw, -s.x * Math.min(1, Math.abs(me.speed) / MAX) * 0.15);
  for (const o of others.values()) {
    const k = Math.min(1, dt * 8);
    o.boat.position.x += (o.target.x - o.boat.position.x) * k;
    o.boat.position.z += (o.target.z - o.boat.position.z) * k;
    o.boat.rotation.y +=
      Math.atan2(
        Math.sin(o.target.yaw - o.boat.rotation.y),
        Math.cos(o.target.yaw - o.boat.rotation.y),
      ) * k;
  }
  if (clock - sent > 0.1 && portal.session.players.length > 1) {
    sent = clock;
    const round = (v: number) => Math.round(v * 100) / 100;
    portal.session.send('boat', { x: round(me.x), z: round(me.z), yaw: round(me.yaw) });
  }

  // The wake: a puff every few centimetres, fading.
  if (Math.abs(me.speed) > 0.6 && clock * 20 > wakeNext) {
    wakeNext = clock * 20 + 1;
    const w = wakeSpots[Math.floor(clock * 20) % WAKE];
    if (w)
      Object.assign(w, {
        x: me.x - Math.cos(me.yaw) * 0.9,
        z: me.z + Math.sin(me.yaw) * 0.9,
        age: 0,
      });
  }
  wakeSpots.forEach((w, i) => {
    w.age += dt;
    dummy.position.set(w.x, 0.04, w.z);
    dummy.rotation.set(-Math.PI / 2, 0, 0);
    dummy.scale.setScalar(w.age < 2 ? 1 + w.age : 0.0001);
    dummy.updateMatrix();
    wake.setMatrixAt(i, dummy.matrix);
  });
  wake.instanceMatrix.needsUpdate = true;
  if (lapping) lapping.gain.value = 0.06 + Math.min(0.12, Math.abs(me.speed) * 0.02);

  // The chase camera: behind and above, further back when the screen is upright.
  const upright = innerHeight > innerWidth;
  const back = upright ? 7.5 : 5.5;
  chase.set(me.x - Math.cos(me.yaw) * back, upright ? 4.2 : 3, me.z + Math.sin(me.yaw) * back);
  camera.position.lerp(chase, Math.min(1, dt * (portal.reducedMotion ? 8 : 3)));
  camera.lookAt(me.x + Math.cos(me.yaw) * 2, 0.5, me.z - Math.sin(me.yaw) * 2);

  hud.textContent = racing
    ? `${time(performance.now() - lapStart)} · buoy ${next === 0 ? 'home' : `${next} of ${BUOYS.length - 1}`}${best ? ` · your best ${time(best)}` : ''}`
    : `Sail through the blue buoy to start${best ? ` · your best ${time(best)}` : ''}`;
  renderer.render(world, camera);
});

portal.progress(1);
portal.ready();
void portal.audio.unlock('Tap to hear the water').then(startWater);
