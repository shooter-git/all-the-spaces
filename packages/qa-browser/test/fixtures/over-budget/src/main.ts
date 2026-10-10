// A creation that uses far more than a low-powered phone allows, for testing the checks:
// 400 separate meshes (draw calls), three 2048 px float textures (texture memory),
// 20 sounds at once (voices), one of them wired straight to the speakers.
import { connect } from '@allthespaces/portal';
import { createStage } from '@allthespaces/portal/three';
import {
  BoxGeometry,
  DataTexture,
  FloatType,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  Scene,
} from 'three';

const portal = await connect();
const { renderer, camera, loop } = createStage(portal);
const scene = new Scene();
const textures = [0, 1, 2].map((i) => {
  const t = new DataTexture(
    new Float32Array(2048 * 2048 * 4).fill(i / 3),
    2048,
    2048,
    RGBAFormat,
    FloatType,
  );
  t.needsUpdate = true;
  return t;
});
for (let i = 0; i < 400; i++) {
  const m = new Mesh(
    new BoxGeometry(0.1, 0.1, 0.1),
    new MeshBasicMaterial({ map: textures[i % 3] ?? null }),
  );
  m.position.set((i % 20) * 0.2 - 2, Math.floor(i / 20) * 0.2 - 2, -5);
  scene.add(m);
}
loop(() => renderer.render(scene, camera));

const ctx = portal.audio.context;
for (let i = 0; i < 20; i++) {
  const o = ctx.createOscillator();
  o.frequency.value = 200 + i * 20;
  const g = ctx.createGain();
  g.gain.value = 0.01;
  o.connect(g).connect(i === 0 ? ctx.destination : portal.audio.bus('sfx'));
  o.start();
}
portal.ready();
