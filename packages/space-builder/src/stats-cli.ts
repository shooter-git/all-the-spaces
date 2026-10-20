#!/usr/bin/env node
// Draw calls, nodes and triangles per room of a built space: `ats-space-stats out-dir`
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ChunkStats, chunkStats } from './stats.ts';

const [dir] = process.argv.slice(2);
if (!dir) {
  console.error('Usage: ats-space-stats <built-space-dir>');
  process.exit(1);
}
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
  name: string;
  rooms: { key: string; lods: Record<'lod0' | 'lod1', { path: string }> }[];
};
const read = async (path: string) =>
  chunkStats(JSON.parse(await readFile(join(dir, path), 'utf8')));
const cell = (s: ChunkStats) =>
  `${s.draws} draws, ${s.nodes} nodes, ${Math.round(s.triangles)} tris`;
const total = {
  lod0: { draws: 0, nodes: 0, triangles: 0 },
  lod1: { draws: 0, nodes: 0, triangles: 0 },
};
console.log(`${manifest.name}\nroom | lod0 | lod1`);
for (const room of manifest.rooms) {
  const lod0 = await read(room.lods.lod0.path);
  const lod1 = await read(room.lods.lod1.path);
  for (const [k, s] of [
    ['lod0', lod0],
    ['lod1', lod1],
  ] as const) {
    total[k].draws += s.draws;
    total[k].nodes += s.nodes;
    total[k].triangles += s.triangles;
  }
  console.log(`${room.key} | ${cell(lod0)} | ${cell(lod1)}`);
}
console.log(`all rooms | ${cell(total.lod0)} | ${cell(total.lod1)}`);
