// Manual check: node scripts/fetch.smoke.ts  (downloads a few assets into ../../.data/asset-cache)
import { fileURLToPath } from 'node:url';
import { PolyHaven } from '../src/index.ts';

const ph = new PolyHaven(fileURLToPath(new URL('../../../.data/asset-cache', import.meta.url)));
const t = await ph.texture('herringbone_parquet');
console.log(
  'texture',
  t.credit.name,
  t.size,
  t.diffuse.byteLength,
  t.normal.byteLength,
  t.arm.byteLength,
);
const m = await ph.model('sofa_02');
console.log('model', m.credit.name, m.dimensions, m.gltfPath);
const h = await ph.hdri('autumn_park');
console.log('hdri', h.credit.name, h.hdr.byteLength);
