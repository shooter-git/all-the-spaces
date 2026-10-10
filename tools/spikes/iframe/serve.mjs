// Spike S4: what works inside a creation's sandboxed, opaque-origin iframe?
// Serves a host page (app origin) that embeds a probe page from a separate "play" origin with the
// sandbox attributes, CSP and CORS headers the platform plans to use. The probe reports back via
// postMessage and the host renders a table (also exposed as window.__results for automation).
//
//   node tools/spikes/iframe/serve.mjs   →  http://app-spike.localhost:45300/
import { createServer } from 'node:http';

const APP_PORT = 45300;
const PLAY_PORT = 45301;
const PLAY_ORIGIN = `http://play-spike.localhost:${PLAY_PORT}`;

const host = `<!doctype html><meta charset="utf-8"><title>S4 iframe probe</title>
<style>body{font:14px system-ui;margin:16px}td,th{padding:4px 10px;text-align:left;border-bottom:1px solid #ddd}
.yes{color:#2f7a58}.no{color:#a63f4d}iframe{width:100%;height:120px;border:1px solid #ccc}</style>
<h1>Creation frame feature probe</h1>
<iframe src="${PLAY_ORIGIN}/probe.html" sandbox="allow-scripts allow-pointer-lock" allow="gamepad; autoplay; fullscreen"></iframe>
<table id="t"><tr><th>Feature</th><th>Result</th><th>Detail</th></tr></table>
<script>
window.addEventListener('message', (e) => {
  if (e.origin !== 'null' || !e.data) return;
  if (e.data.type === 'ping') { e.source.postMessage({ type: 'pong' }, '*'); return; }
  if (e.data.type !== 'probe-results') return;
  window.__results = e.data.results;
  const t = document.getElementById('t');
  for (const r of e.data.results) {
    const tr = t.insertRow();
    tr.insertCell().textContent = r.name;
    const c = tr.insertCell(); c.textContent = r.ok ? 'works' : 'blocked'; c.className = r.ok ? 'yes' : 'no';
    tr.insertCell().textContent = r.detail || '';
  }
});
</script>`;

const probe = `<!doctype html><meta charset="utf-8"><body style="font:13px system-ui">
<button id="tap">Tap to start (audio unlock test)</button>
<script type="module" src="${PLAY_ORIGIN}/probe.js"></script></body>`;

const probeJs = `
const results = [];
const add = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: String(detail) });
const tryIt = async (name, fn) => { try { const d = await fn(); add(name, true, d ?? ''); } catch (e) { add(name, false, e?.name + ': ' + (e?.message ?? e)); } };

add('Opaque origin (origin is "null")', self.origin === 'null', self.origin);
await tryIt('ES module script + dynamic import', async () => (await import('${PLAY_ORIGIN}/mod.js')).value);
await tryIt('Worker from blob: URL', () => new Promise((res, rej) => {
  const w = new Worker(URL.createObjectURL(new Blob(['postMessage(42)'], { type: 'text/javascript' })));
  w.onmessage = (e) => res('message ' + e.data); w.onerror = (e) => rej(new Error(e.message || 'worker error'));
}));
await tryIt('Module worker from blob: URL', () => new Promise((res, rej) => {
  const w = new Worker(URL.createObjectURL(new Blob(['postMessage("m")'], { type: 'text/javascript' })), { type: 'module' });
  w.onmessage = (e) => res('message ' + e.data); w.onerror = (e) => rej(new Error(e.message || 'worker error'));
}));
await tryIt('Worker from same-server URL (expected to fail)', () => new Promise((res, rej) => {
  const w = new Worker('${PLAY_ORIGIN}/worker.js');
  w.onmessage = (e) => res('message ' + e.data); w.onerror = () => rej(new Error('blocked'));
  setTimeout(() => rej(new Error('timeout')), 2000);
}));
await tryIt('WebAssembly compile + run', async () => {
  const bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
  const { instance } = await WebAssembly.instantiate(bytes); return '2+3=' + instance.exports.add(2, 3);
});
await tryIt('WebGL2', () => { const gl = document.createElement('canvas').getContext('webgl2'); if (!gl) throw new Error('no context'); return gl.getParameter(gl.VERSION); });
await tryIt('WebGPU adapter', async () => { if (!navigator.gpu) throw new Error('navigator.gpu missing'); const a = await navigator.gpu.requestAdapter(); if (!a) throw new Error('no adapter'); return 'ok'; });
await tryIt('OffscreenCanvas', () => { const c = new OffscreenCanvas(4, 4); if (!c.getContext('2d')) throw new Error('no 2d'); return 'ok'; });
await tryIt('fetch own asset (same play origin)', async () => (await (await fetch('${PLAY_ORIGIN}/data.json')).json()).hello);
await tryIt('fetch the app API (must be blocked)', async () => { await fetch('http://app-spike.localhost:${APP_PORT}/'); return 'NOT BLOCKED'; });
await tryIt('localStorage (expected blocked)', () => { localStorage.setItem('x', '1'); return 'NOT BLOCKED'; });
await tryIt('IndexedDB (expected blocked)', () => new Promise((res, rej) => { const r = indexedDB.open('x'); r.onsuccess = () => res('NOT BLOCKED'); r.onerror = () => rej(r.error); }));
await tryIt('document.cookie (expected blocked)', () => { document.cookie = 'a=1'; return 'NOT BLOCKED: ' + document.cookie; });
add('SharedArrayBuffer / crossOriginIsolated', self.crossOriginIsolated, 'crossOriginIsolated=' + self.crossOriginIsolated);
add('Pointer lock API present', 'requestPointerLock' in Element.prototype);
await tryIt('Gamepad API', () => { const g = navigator.getGamepads(); return 'slots=' + g.length; });
await tryIt('Fullscreen API (host should fullscreen its wrapper instead)', () => { if (!document.fullscreenEnabled) throw new Error('fullscreenEnabled=false'); return 'enabled'; });
const ac = new AudioContext();
add('AudioContext starts running without a tap', ac.state === 'running', 'state=' + ac.state);
await tryIt('postMessage round trip with host', () => new Promise((res, rej) => {
  window.addEventListener('message', (e) => e.data?.type === 'pong' && res('reply from ' + e.origin), { once: true });
  setTimeout(() => rej(new Error('no reply')), 3000);
  parent.postMessage({ type: 'ping' }, '*');
}));
parent.postMessage({ type: 'probe-results', results }, '*');
document.getElementById('tap').onclick = async () => { await ac.resume(); document.getElementById('tap').textContent = 'audio: ' + ac.state; };
`;

const playHeaders = {
  'access-control-allow-origin': '*',
  'content-security-policy':
    "sandbox allow-scripts allow-pointer-lock; default-src 'none'; script-src " +
    PLAY_ORIGIN +
    " blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src " +
    PLAY_ORIGIN +
    '; img-src ' +
    PLAY_ORIGIN +
    " blob: data:; style-src 'unsafe-inline'",
};
const files = {
  '/probe.html': ['text/html', probe],
  '/probe.js': ['text/javascript', probeJs],
  '/mod.js': ['text/javascript', 'export const value = "loaded";'],
  '/worker.js': ['text/javascript', 'postMessage("url-worker")'],
  '/data.json': ['application/json', '{"hello":"from play origin"}'],
};

createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(host)).listen(
  APP_PORT,
  '127.0.0.1',
);
createServer((req, res) => {
  const f = files[req.url?.split('?')[0] ?? ''];
  if (!f) return res.writeHead(404, playHeaders).end();
  res.writeHead(200, { ...playHeaders, 'content-type': f[0] }).end(f[1]);
}).listen(PLAY_PORT, '127.0.0.1');
console.log(`S4 probe: http://app-spike.localhost:${APP_PORT}/`);
