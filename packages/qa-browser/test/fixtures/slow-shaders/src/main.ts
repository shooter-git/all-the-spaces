// A creation that draws with WebGL and stops answering for 7 seconds once, the way a 3D game can
// while its shaders are made on a browser with no graphics card, for testing the freeze check.
import { connect } from '@allthespaces/portal';

const portal = await connect();
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position: fixed; inset: 0; width: 100%; height: 100%';
document.body.append(canvas);
canvas.width = innerWidth;
canvas.height = innerHeight;
const gl = canvas.getContext('webgl2');
if (gl) {
  // Sky over grass, so the screen isn't one flat colour.
  gl.clearColor(0.4, 0.6, 0.9, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, canvas.width, Math.round(canvas.height / 3));
  gl.clearColor(0.35, 0.7, 0.35, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
portal.ready();
setTimeout(() => {
  const until = performance.now() + 7000;
  while (performance.now() < until);
}, 2000);
