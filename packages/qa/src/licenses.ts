import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetsLock } from './project.ts';

/** File types that are assets (made by someone, with a licence) rather than code. */
export const ASSET_EXTENSIONS = new Set([
  'glb',
  'gltf',
  'bin',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'avif',
  'gif',
  'svg',
  'ktx2',
  'hdr',
  'exr',
  'mp3',
  'ogg',
  'opus',
  'wav',
  'm4a',
  'flac',
  'mp4',
  'webm',
  'woff',
  'woff2',
  'ttf',
  'otf',
]);

/** Licences an asset may have. `own`: made for this creation (by the Architect or their assistant). */
export const ASSET_LICENSES = new Set([
  'own',
  'CC0-1.0',
  'OFL-1.1',
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Unlicense',
]);

/** Licences a dependency bundled into a creation may have. */
export const DEPENDENCY_LICENSES = new Set([
  'MIT',
  'ISC',
  '0BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Zlib',
]);

export interface LicenceProblem {
  path: string;
  problem: string;
}

const extOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';

/** Every asset in the source is listed in assets.lock.json with a licence we can publish. */
export function checkAssets(paths: string[], lock: AssetsLock): LicenceProblem[] {
  const problems: LicenceProblem[] = [];
  const listed = new Map(lock.assets.map((a) => [a.path.replace(/^\.\//, ''), a]));
  for (const path of paths) {
    if (!ASSET_EXTENSIONS.has(extOf(path))) continue;
    // Icons and the page's own images that ship with the starter are code-like; still listed.
    const entry = listed.get(path);
    if (!entry) {
      problems.push({ path, problem: 'is not listed in assets.lock.json' });
    } else if (!ASSET_LICENSES.has(entry.license)) {
      problems.push({ path, problem: `has a licence that can't be published (${entry.license})` });
    } else if (entry.license !== 'own' && !entry.source) {
      problems.push({ path, problem: "doesn't say where it came from (source)" });
    }
  }
  return problems;
}

export interface Dependency {
  name: string;
  version: string;
  license: string;
}

/** Reads the licence of every installed package (pnpm layout). */
export async function installedDependencies(projectDir: string): Promise<Dependency[]> {
  const store = join(projectDir, 'node_modules', '.pnpm');
  const found: Dependency[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(store);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const modules = join(store, entry, 'node_modules');
    let names: string[] = [];
    try {
      names = await readdir(modules);
    } catch {
      continue;
    }
    for (const n of names) {
      const dirs = n.startsWith('@')
        ? (await readdir(join(modules, n)).catch(() => [])).map((m) => join(n, m))
        : [n];
      for (const d of dirs) {
        try {
          const pkg = JSON.parse(await readFile(join(modules, d, 'package.json'), 'utf8'));
          // Each store folder holds one package plus links to its dependencies; only count it once.
          if (!entry.startsWith(`${String(pkg.name).replace('/', '+')}@`)) continue;
          found.push({ name: pkg.name, version: pkg.version, license: licenceOf(pkg) });
        } catch {}
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function licenceOf(pkg: { license?: unknown; licenses?: unknown }): string {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && 'type' in pkg.license)
    return String((pkg.license as { type: unknown }).type);
  if (Array.isArray(pkg.licenses))
    return pkg.licenses.map((l: { type?: string }) => l.type ?? '?').join(' OR ');
  return 'UNKNOWN';
}

export function checkDependencies(deps: Dependency[]): LicenceProblem[] {
  return deps
    .filter((d) => {
      const options = d.license.replace(/[()]/g, '').split(/\s+OR\s+/);
      return !options.some((o) => DEPENDENCY_LICENSES.has(o.trim()));
    })
    .map((d) => ({
      path: `${d.name}@${d.version}`,
      problem: `has a licence that can't be bundled into a creation (${d.license})`,
    }));
}
