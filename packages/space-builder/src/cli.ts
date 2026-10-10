#!/usr/bin/env node
// Builds a space from a plan file: `ats-space-build plan.json out-dir`
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PolyHaven } from '@ats/assets';
import { bakeSettingsFromEnv } from './bake.ts';
import { buildSpace } from './build.ts';

const [planPath, outDir] = process.argv.slice(2);
if (!planPath || !outDir) {
  console.error('Usage: ats-space-build <plan.json> <out-dir>');
  process.exit(1);
}
// Set ATS_OFFLINE=1 to build with plain colours and simple shapes (no downloads).
const assets = process.env.ATS_OFFLINE
  ? null
  : new PolyHaven(process.env.ATS_ASSET_CACHE ?? '.data/asset-cache');
// Bakes lighting when Blender is available (ATS_BLENDER, or on the PATH; ATS_BAKE=0 to skip).
const bake = bakeSettingsFromEnv();
const built = await buildSpace(JSON.parse(await readFile(planPath, 'utf8')), { assets, bake });
for (const [path, bytes] of built.files) {
  await mkdir(dirname(join(outDir, path)), { recursive: true });
  await writeFile(join(outDir, path), bytes);
}
await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(built.manifest, null, 2)}\n`);
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `${built.manifest.name}: ${built.stats.rooms} rooms, ${built.stats.models} models, ${built.files.size} files, ` +
    `${kb(built.stats.bytes)} total; ${built.manifest.credits.length} credited CC0 assets; ` +
    `lighting baked in ${built.stats.lighting.baked} of ${built.stats.lighting.rooms} indoor rooms ` +
    `(${built.stats.bakeSeconds.toFixed(0)} s)`,
);
