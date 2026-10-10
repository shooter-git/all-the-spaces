/**
 * The painted garden — an example of an explorable scene. Walk around a small garden with other
 * people, see each other, and light a stone lantern that stays lit for everyone.
 *
 * It shows: the stage and first-person rig, touch/keyboard/gamepad actions, seeing each other
 * (messages), shared state (the lantern), sound groups, loading progress and portrait/landscape.
 */
import { connect, type Person } from '@allthespaces/portal';
import { createStage, FirstPersonRig } from '@allthespaces/portal/three';
import {
  BoxGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';

const portal = await connect();
portal.progress(0.1, 'Setting out the garden');
portal.input.define({ move: 'stick', use: { button: 'Light' } });

const { renderer, camera, loop } = createStage(portal);
const scene = new Group();
const world = new Scene();
world.add(scene);
world.background = new Color('#dfe7ee');
world.fog = new Fog('#dfe7ee', 18, 60);

// ---- Light: a soft afternoon -----------------------------------------------------------------
world.add(new HemisphereLight('#eef3f8', '#9a8e76', 1.4));
const sun = new DirectionalLight('#fff1dc', 2.2);
sun.position.set(8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -16;
sun.shadow.camera.right = 16;
sun.shadow.camera.top = 16;
sun.shadow.camera.bottom = -16;
world.add(sun);

const mat = (color: string, roughness = 0.9) => new MeshStandardMaterial({ color, roughness });

// ---- The garden ------------------------------------------------------------------------------
const ground = new Mesh(new CircleGeometry(30, 64), mat('#b9c29a'));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const path = new Mesh(new PlaneGeometry(1.6, 16), mat('#d8cdb8'));
path.rotation.x = -Math.PI / 2;
path.position.set(0, 0.01, 2);
path.receiveShadow = true;
scene.add(path);

const pond = new Mesh(
  new CircleGeometry(3.2, 48),
  new MeshStandardMaterial({ color: '#8fa9b8', roughness: 0.08, metalness: 0.2 }),
);
pond.rotation.x = -Math.PI / 2;
pond.position.set(5.5, 0.02, -2);
scene.add(pond);

// A small open pavilion.
const pavilion = new Group();
const wood = mat('#7a5c42', 0.7);
for (const [x, z] of [
  [-1.6, -1.6],
  [1.6, -1.6],
  [-1.6, 1.6],
  [1.6, 1.6],
] as const) {
  const post = new Mesh(new CylinderGeometry(0.09, 0.1, 2.6, 12), wood);
  post.position.set(x, 1.3, z);
  post.castShadow = true;
  pavilion.add(post);
}
const roof = new Mesh(new ConeGeometry(3.1, 1.2, 4), mat('#3f5b7c', 0.8));
roof.position.y = 3.1;
roof.rotation.y = Math.PI / 4;
roof.castShadow = true;
pavilion.add(roof);
const deck = new Mesh(new BoxGeometry(3.8, 0.15, 3.8), mat('#a58b6c', 0.8));
deck.position.y = 0.07;
deck.receiveShadow = true;
pavilion.add(deck);
pavilion.position.set(-4, 0, -6);
scene.add(pavilion);

// Trees: soft round crowns, a little different each.
const trunkGeo = new CylinderGeometry(0.12, 0.18, 2, 8);
const crownGeo = new SphereGeometry(1.2, 16, 12);
for (let i = 0; i < 14; i++) {
  const a = (i / 14) * Math.PI * 2 + (i % 3) * 0.2;
  const r = 12 + (i % 4) * 2.5;
  const tree = new Group();
  const trunk = new Mesh(trunkGeo, mat('#6b5440'));
  trunk.position.y = 1;
  const crown = new Mesh(crownGeo, mat(i % 3 === 0 ? '#d9a3ae' : '#8ea27a'));
  crown.position.y = 2.6;
  crown.scale.setScalar(0.8 + (i % 5) * 0.12);
  trunk.castShadow = crown.castShadow = true;
  tree.add(trunk, crown);
  tree.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
  scene.add(tree);
}

// The stone lantern, lit for everyone when anyone lights it.
const lanternSpot = new Vector3(1.8, 0, -3);
const lantern = new Group();
const stone = mat('#b5aea3', 0.95);
const base = new Mesh(new CylinderGeometry(0.35, 0.45, 0.7, 8), stone);
base.position.y = 0.35;
const box = new Mesh(new BoxGeometry(0.5, 0.45, 0.5), stone);
box.position.y = 0.95;
const cap = new Mesh(new ConeGeometry(0.5, 0.35, 6), stone);
cap.position.y = 1.35;
const glowMat = new MeshStandardMaterial({
  color: '#fff0c8',
  emissive: '#ffb45c',
  emissiveIntensity: 0,
});
const glow = new Mesh(new BoxGeometry(0.3, 0.25, 0.52), glowMat);
glow.position.y = 0.95;
const flame = new PointLight('#ffb45c', 0, 7, 1.6);
flame.position.y = 1;
for (const m of [base, box, cap]) m.castShadow = true;
lantern.add(base, box, cap, glow, flame);
lantern.position.copy(lanternSpot);
scene.add(lantern);

// Petals drifting down.
const petals = new InstancedMesh(
  new PlaneGeometry(0.06, 0.09),
  // Unlit, so petals stay soft pink whichever way they turn.
  new MeshBasicMaterial({ color: '#e9c6cc', side: DoubleSide }),
  160,
);
const petalState = Array.from({ length: 160 }, () => ({
  p: new Vector3((Math.random() - 0.5) * 30, Math.random() * 8, (Math.random() - 0.5) * 30),
  spin: Math.random() * 6,
}));
scene.add(petals);
const dummy = new Object3D();

portal.progress(0.6, 'Opening the gate');

// ---- Other people ----------------------------------------------------------------------------
const figures = new Map<string, { root: Group; target: Vector3; yaw: number }>();
function figure(p: Person) {
  const root = new Group();
  const body = new Mesh(new CapsuleGeometry(0.25, 0.9, 6, 12), mat(p.color, 0.8));
  body.position.y = 0.8;
  const head = new Mesh(new SphereGeometry(0.17, 16, 12), mat('#efe6da', 0.7));
  head.position.y = 1.55;
  body.castShadow = head.castShadow = true;
  root.add(body, head);
  scene.add(root);
  return { root, target: new Vector3(), yaw: 0 };
}
function syncPlayers(players: Person[]) {
  const here = new Set(players.map((p) => p.id));
  for (const [id, f] of figures) {
    if (!here.has(id)) {
      scene.remove(f.root);
      figures.delete(id);
    }
  }
  for (const p of players)
    if (p.id !== portal.me.id && !figures.has(p.id)) figures.set(p.id, figure(p));
}
syncPlayers(portal.session.players);
portal.session.onPlayers(syncPlayers);
portal.session.on<{ x: number; z: number; yaw: number }>('pose', (pose, from) => {
  const f = figures.get(from);
  if (!f) return;
  f.target.set(pose.x, 0, pose.z);
  f.yaw = pose.yaw;
});

// ---- The lantern -----------------------------------------------------------------------------
let lit = portal.session.get<boolean>('lantern') === true;
portal.session.onChange<boolean>('lantern', (value) => {
  lit = value === true;
  chime();
});
portal.input.onPress('use', () => {
  if (rig.position.distanceTo(lanternSpot) < 2.2) void portal.session.set('lantern', !lit);
  else portal.ui.toast('Walk up to the stone lantern to light it');
});

// ---- Sound: a breeze, the pond, and a small chime --------------------------------------------
function noiseLoop(seconds: number) {
  const ctx = portal.audio.context;
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < d.length; i++) {
    b = 0.98 * b + (Math.random() * 2 - 1) * 0.1;
    d[i] = b;
  }
  return buf;
}
function startAmbience() {
  const ctx = portal.audio.context;
  const wind = ctx.createBufferSource();
  wind.buffer = noiseLoop(4);
  wind.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 600;
  const g = ctx.createGain();
  g.gain.value = 0.35;
  wind.connect(band).connect(g).connect(portal.audio.bus('ambience'));
  wind.start();
  const water = ctx.createBufferSource();
  water.buffer = noiseLoop(3);
  water.loop = true;
  const hi = ctx.createBiquadFilter();
  hi.type = 'highpass';
  hi.frequency.value = 2500;
  const wg = ctx.createGain();
  wg.gain.value = 0.12;
  water.connect(hi).connect(wg).connect(portal.audio.bus('ambience'));
  water.start();
}
function chime() {
  if (portal.audio.context.state !== 'running') return;
  const ctx = portal.audio.context;
  for (const [i, f] of [659.25, 987.77].entries()) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const g = ctx.createGain();
    const t = ctx.currentTime + i * 0.1;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    o.connect(g).connect(portal.audio.bus('sfx'));
    o.start(t);
    o.stop(t + 1.5);
  }
}

// ---- Walking ---------------------------------------------------------------------------------
const rig = new FirstPersonRig(portal, camera, { start: new Vector3(0, 0, 8) });
let sent = 0;
let time = 0;
loop((dt) => {
  time += dt;
  rig.update(dt);
  // Stay inside the garden.
  const r = Math.hypot(rig.position.x, rig.position.z);
  if (r > 26) rig.position.multiplyScalar(26 / r);

  for (const f of figures.values()) {
    f.root.position.lerp(f.target, Math.min(1, dt * 8));
    f.root.rotation.y += (f.yaw - f.root.rotation.y) * Math.min(1, dt * 8);
  }
  // Tell the others where you are, ten times a second.
  if (time - sent > 0.1 && portal.session.players.length > 1) {
    sent = time;
    portal.session.send('pose', { x: rig.position.x, z: rig.position.z, yaw: rig.yaw });
  }

  const target = lit ? 2.4 : 0;
  flame.intensity += (target - flame.intensity) * Math.min(1, dt * 3);
  glowMat.emissiveIntensity = flame.intensity * 0.8 * (1 + Math.sin(time * 9) * 0.04);

  petalState.forEach((s, i) => {
    s.p.y -= dt * 0.35;
    s.p.x += Math.sin(time * 0.7 + i) * dt * 0.15;
    if (s.p.y < 0) s.p.y = 8;
    s.spin += dt;
    dummy.position.copy(s.p);
    dummy.rotation.set(s.spin, s.spin * 0.7, 0);
    dummy.updateMatrix();
    petals.setMatrixAt(i, dummy.matrix);
  });
  petals.instanceMatrix.needsUpdate = true;
  renderer.render(world, camera);
});

portal.progress(1);
portal.ready();
// Sound needs one tap inside the creation (browsers insist).
void portal.audio.unlock('Tap to hear the garden').then(startAmbience);
