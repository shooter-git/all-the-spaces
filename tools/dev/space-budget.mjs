// Checks a space against the main-space performance budgets (docs: plan §6).
//   pnpm --filter @ats/web build   (once, for the app shell size)
//   node tools/dev/space-budget.mjs <spaceId> [<spaceId>...]
//
// Signs in as the dev Architect, measures download sizes from the manifest, then loads the space
// in headless Chromium on a simulated 25 Mbps / 40 ms connection with an empty cache and measures
// the time until you can move, draw calls, triangles and texture memory. Rendering is software
// (SwiftShader), so frame rates here mean nothing; everything measured is independent of the GPU.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const MB = 1024 * 1024;
const KB = 1024;
const LINK = { downMbps: 25, latencyMs: 40 };
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const base = env.ATS_PUBLIC_URL;
const spaceIds = process.argv.slice(2);
if (spaceIds.length === 0) {
  console.error('Usage: node tools/dev/space-budget.mjs <spaceId> [...]');
  process.exit(1);
}

const results = [];
const check = (name, value, limit, unit, fmt = (v) => v.toFixed(1)) =>
  results.push({ name, ok: value <= limit, text: `${fmt(value)} ${unit} (limit ${fmt(limit)})` });

// --- App shell: the production build's JS + CSS + HTML, compressed as served -----------------
const dist = 'apps/web/dist';
try {
  let shell = 0;
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|css|html)$/.test(f) && !/^(sw|workbox)/.test(f))
        shell += gzipSync(readFileSync(p)).length;
    }
  };
  walk(dist);
  check('App shell (compressed)', shell / MB, 1.5, 'MB', (v) => v.toFixed(2));
} catch {
  console.log('(no production build: run `pnpm --filter @ats/web build` to check the app shell)');
}

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});

for (const spaceId of spaceIds) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
    headers: { origin: base },
    data: { email: env.DEV_ARCHITECT_EMAIL, password: env.DEV_ARCHITECT_PASSWORD },
  });
  if (!signIn.ok()) throw new Error(`sign-in failed: ${signIn.status()}`);
  const api = `${base}/api/spaces/${spaceId}/`;
  const manifest = await (await context.request.get(`${api}manifest`)).json();
  console.log(`\n${manifest.name}`);

  // --- Static: what each room costs to download -------------------------------------------
  const sizeCache = new Map();
  const size = async (path) => {
    if (!sizeCache.has(path)) {
      const res = await context.request.get(api + path);
      sizeCache.set(path, (await res.body()).length);
    }
    return sizeCache.get(path);
  };
  /** A chunk plus the textures and buffers it references. */
  const chunkFiles = async (ref) => {
    const gltf = await (await context.request.get(api + ref.path)).json();
    const uris = [...(gltf.buffers ?? []), ...(gltf.images ?? [])]
      .map((x) => x.uri)
      .filter(Boolean);
    return [ref.path, ...uris.map((u) => ref.path.replace(/[^/]+$/, u))];
  };
  const bytesOf = async (files) => {
    let n = 0;
    for (const f of new Set(files)) n += await size(f);
    return n;
  };
  const worst = { lod0: 0, lod1: 0, lod2: 0 };
  const roomFiles = new Map();
  for (const r of manifest.rooms) {
    const lightmap = r.lightmap ? [r.lightmap.path] : [];
    const files = {
      lod0: [...(await chunkFiles(r.lods.lod0)), ...lightmap],
      lod1: [...(await chunkFiles(r.lods.lod1)), ...lightmap],
      lod2: await chunkFiles(r.lods.lod2),
      collision: [r.collision.path],
    };
    roomFiles.set(r.key, files);
    for (const lod of ['lod0', 'lod1', 'lod2'])
      worst[lod] = Math.max(worst[lod], await bytesOf(files[lod]));
  }
  check('  Largest room, full detail (with its textures)', worst.lod0 / MB, 8, 'MB');
  check('  Largest room, medium detail (with its textures)', worst.lod1 / MB, 2, 'MB');
  check('  Largest room, distant stand-in', worst.lod2 / KB, 300, 'KB', (v) => v.toFixed(0));
  const spawn = manifest.spawns[0];
  const first = roomFiles.get(spawn.roomKey);
  const spawnRoom = manifest.rooms.find((r) => r.key === spawn.roomKey);
  // The first load: your room at medium detail, the rooms around it as stand-ins.
  const firstFiles = [
    ...first.lod1,
    ...first.collision,
    ...spawnRoom.neighbors.flatMap((n) => roomFiles.get(n)?.lod2 ?? []),
    ...(manifest.lighting.hdri ? [manifest.lighting.hdri.path] : []),
  ];
  check('  Download before you can move', (await bytesOf(firstFiles)) / MB, 5, 'MB');

  // --- Runtime: load it on a 25 Mbps connection -------------------------------------------
  for (const quality of ['low', 'mid']) {
    // Best of two loads: the first frame compiles shaders in software here, which is slow and
    // varies with whatever else the machine is doing (a real GPU does this in a blink).
    let ready = Number.POSITIVE_INFINITY;
    let page;
    for (let attempt = 0; attempt < 2; attempt++) {
      await page?.close();
      page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: LINK.latencyMs,
        downloadThroughput: (LINK.downMbps * 1e6) / 8,
        uploadThroughput: (5 * 1e6) / 8,
      });
      await page.goto(`${base}/space/${spaceId}?quality=${quality}`);
      await page.waitForFunction(() => window.__atsViewer?.isReady, null, {
        timeout: 120_000,
        polling: 50,
      });
      // From asking for the space to being able to move (the app itself comes from the cache or
      // the service worker after the first visit; its size is checked separately above).
      const seconds = await page.evaluate((id) => {
        const start = performance
          .getEntriesByType('resource')
          .find((e) => e.name.endsWith(`/api/spaces/${id}/manifest`))?.startTime;
        if (start === undefined) throw new Error('space manifest request not found');
        return (performance.now() - start) / 1000;
      }, spaceId);
      ready = Math.min(ready, seconds);
    }
    // Let full detail stream in, then look around from the spawn point.
    await page.waitForTimeout(15_000);
    const seen = await page.evaluate(async () => {
      const v = window.__atsViewer;
      const wait = () => new Promise((r) => setTimeout(r, 1500));
      let draws = 0;
      let tris = 0;
      for (let i = 0; i < 8; i++) {
        v.player.yaw = (i / 8) * Math.PI * 2;
        await wait();
        const s = v.stats();
        draws = Math.max(draws, s.drawCalls);
        tris = Math.max(tris, s.triangles);
      }
      // Texture memory: every image on the GPU at full size with mipmaps. Textures that share
      // an image (rooms using the same file) share one upload.
      const images = new Map();
      v.scene.traverse((o) => {
        for (const m of [o.material ?? []].flat()) {
          for (const t of Object.values(m)) {
            if (!t?.isTexture) continue;
            const img = t.source.data;
            const w = img?.width ?? 0;
            const h = img?.height ?? 0;
            const bpp = t.type === 1016 /* HalfFloat */ ? 8 : 4;
            images.set(t.source, w * h * bpp * (t.generateMipmaps ? 1.33 : 1));
          }
        }
      });
      const texBytes = [...images.values()].reduce((a, b) => a + b, 0);
      const s = v.stats();
      return { draws, tris, texBytes, residentBytes: s.residentBytes };
    });
    const tier = quality === 'low' ? 'Low' : 'Mid';
    const loadLimit = manifest.rooms.length > 6 ? 10 : 8;
    check(`  [${tier}] Asking for the space → you can move`, ready, loadLimit, 's');
    check(
      `  [${tier}] Draw calls (worst direction)`,
      seen.draws,
      quality === 'low' ? 200 : 400,
      '',
      (v) => v.toFixed(0),
    );
    check(
      `  [${tier}] GPU memory: textures + geometry`,
      (seen.texBytes + seen.residentBytes) / MB,
      quality === 'low' ? 200 : 400,
      'MB',
      (v) => v.toFixed(0),
    );
    results.push({
      name: `  [${tier}] Triangles on screen (worst direction)`,
      ok: true,
      text: `${(seen.tris / 1000).toFixed(0)}k`,
    });
    await page.close();
  }
  for (const r of results.splice(0)) console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}: ${r.text}`);
  await context.close();
}
await browser.close();
