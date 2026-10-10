import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';

/** Free (CC0) models, textures and skies from Poly Haven (https://polyhaven.com). */
const API = 'https://api.polyhaven.com';
const USER_AGENT = 'AllTheSpaces-ats/0.1 (+https://github.com/shooter-git/all-the-spaces)';

export type AssetType = 'models' | 'textures' | 'hdris';

export interface Found {
  id: string;
  name: string;
  type: AssetType;
  categories: string[];
  authors: string[];
}

interface FileRef {
  url: string;
  md5: string;
  size: number;
  include?: Record<string, FileRef>;
}

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${API}${path}`, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Poly Haven: ${res.status} for ${path}`);
  return (await res.json()) as T;
};

export async function search(words: string, type?: AssetType, limit = 12): Promise<Found[]> {
  const types: AssetType[] = type ? [type] : ['models', 'textures', 'hdris'];
  const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
  const found: (Found & { score: number })[] = [];
  for (const t of types) {
    const all = await get<
      Record<
        string,
        {
          name: string;
          categories?: string[];
          tags?: string[];
          authors?: Record<string, string>;
          download_count?: number;
        }
      >
    >(`/assets?t=${t}`);
    for (const [id, a] of Object.entries(all)) {
      const hay = [id, a.name, ...(a.categories ?? []), ...(a.tags ?? [])].join(' ').toLowerCase();
      const hits = terms.filter((w) => hay.includes(w)).length;
      if (hits === 0 && terms.length) continue;
      found.push({
        id,
        name: a.name,
        type: t,
        categories: a.categories ?? [],
        authors: Object.keys(a.authors ?? {}),
        score: hits * 1e9 + (a.download_count ?? 0),
      });
    }
  }
  return found
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...f }) => f);
}

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');

async function download(ref: FileRef, to: string) {
  const res = await fetch(ref.url, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${ref.url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (md5(bytes) !== ref.md5) throw new Error(`Download didn't match its checksum: ${ref.url}`);
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, bytes);
  return bytes.byteLength;
}

/**
 * Downloads an asset into `public/assets/` (a model as one `<id>.glb`; textures and skies as
 * files in `<id>/`) and returns the files written (relative to the
 * project) with their credit, for assets.lock.json. `modelsDir` puts models elsewhere (a place
 * keeps them in `models/`).
 */
export async function add(
  projectDir: string,
  id: string,
  resolution = '1k',
  modelsDir = 'public/assets',
) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`Not a Poly Haven asset id: ${id}`);
  const info = await get<{ name: string; type: number; authors?: Record<string, string> }>(
    `/info/${id}`,
  );
  const files = await get<Record<string, Record<string, Record<string, FileRef>>>>(`/files/${id}`);
  const base = `public/assets/${id}`;
  const written: string[] = [];
  const save = async (ref: FileRef, rel: string) => {
    await download(ref, join(projectDir, base, rel));
    written.push(`${base}/${rel}`);
    for (const [path, inc] of Object.entries(ref.include ?? {})) await save(inc, path);
  };
  const pick = (map: Record<string, Record<string, FileRef>> | undefined, format: string) =>
    map?.[resolution]?.[format] ?? map?.['1k']?.[format] ?? map?.['2k']?.[format];
  const type: AssetType = info.type === 0 ? 'hdris' : info.type === 1 ? 'textures' : 'models';
  if (type === 'models') {
    const ref = pick(files.gltf, 'gltf');
    if (!ref) throw new Error(`${id} has no glTF download`);
    // Packed into one .glb: one file to load, and publishing compresses it.
    const tmp = await mkdtemp(join(tmpdir(), 'ats-asset-'));
    try {
      const fetchAll = async (r: FileRef, rel: string) => {
        await download(r, join(tmp, rel));
        for (const [path, inc] of Object.entries(r.include ?? {})) await fetchAll(inc, path);
      };
      await fetchAll(ref, `${id}.gltf`);
      const io = new NodeIO();
      const glb = await io.writeBinary(await io.read(join(tmp, `${id}.gltf`)));
      await mkdir(join(projectDir, modelsDir), { recursive: true });
      await writeFile(join(projectDir, modelsDir, `${id}.glb`), glb);
      written.push(`${modelsDir}/${id}.glb`);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } else if (type === 'hdris') {
    const ref = pick(files.hdri, 'hdr');
    if (!ref) throw new Error(`${id} has no HDR download`);
    await save(ref, `${id}.hdr`);
  } else {
    for (const map of ['Diffuse', 'nor_gl', 'arm', 'Rough', 'AO']) {
      const ref = pick(files[map], 'jpg');
      if (ref) await save(ref, `${id}_${map.toLowerCase()}.jpg`);
    }
    if (!written.length) throw new Error(`${id} has no texture downloads`);
  }
  return {
    type,
    files: written,
    credit: {
      license: 'CC0-1.0',
      source: `https://polyhaven.com/a/${id}`,
      title: info.name,
      author: Object.keys(info.authors ?? {}).join(', ') || 'Poly Haven',
    },
  };
}
