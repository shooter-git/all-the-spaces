import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * CC0 assets from Poly Haven (https://polyhaven.com), downloaded once and cached on disk.
 * Every file is checked against Poly Haven's published MD5, and every asset carries a licence
 * record so builds can list exactly what they contain.
 */

export interface AssetCredit {
  source: 'polyhaven';
  id: string;
  name: string;
  license: 'CC0-1.0';
  url: string;
  authors: string[];
}

export interface TextureSet {
  credit: AssetCredit;
  /** Real-world size of one tile, in metres (width, height). */
  size: [number, number];
  diffuse: Uint8Array;
  normal: Uint8Array;
  /** Ambient occlusion (R), roughness (G), metalness (B). */
  arm: Uint8Array;
}

export interface ModelFiles {
  credit: AssetCredit;
  /** Path to the downloaded .gltf; its buffers and textures sit next to it. */
  gltfPath: string;
  /** Real-world dimensions in metres (x, y, z). */
  dimensions: [number, number, number];
}

interface FileRef {
  url: string;
  size: number;
  md5: string;
  include?: Record<string, FileRef>;
}

const API = 'https://api.polyhaven.com';
const USER_AGENT = 'AllTheSpaces/0.1 (+https://github.com/shooter-git/all-the-spaces)';

export class PolyHaven {
  readonly cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  private async json<T>(path: string): Promise<T> {
    const file = join(this.cacheDir, 'api', `${path.replace(/[^a-z0-9]+/gi, '_')}.json`);
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      const res = await fetch(`${API}${path}`, { headers: { 'user-agent': USER_AGENT } });
      if (!res.ok) throw new Error(`Poly Haven ${path}: HTTP ${res.status}`);
      const body = await res.text();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
      return JSON.parse(body) as T;
    }
  }

  /** Downloads (or reads from cache) one file, verifying its MD5. */
  private async file(ref: FileRef, localPath: string): Promise<Uint8Array> {
    const path = join(this.cacheDir, localPath);
    try {
      const cached = new Uint8Array(await readFile(path));
      if (md5(cached) === ref.md5) return cached;
    } catch {
      // not cached yet
    }
    const res = await fetch(ref.url, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${ref.url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (md5(bytes) !== ref.md5) throw new Error(`Checksum mismatch for ${ref.url}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return bytes;
  }

  private async credit(id: string): Promise<AssetCredit & { dimensions?: number[] | undefined }> {
    const info = await this.json<{
      name: string;
      authors: Record<string, string>;
      dimensions?: number[];
    }>(`/info/${id}`);
    return {
      source: 'polyhaven',
      id,
      name: info.name,
      license: 'CC0-1.0',
      url: `https://polyhaven.com/a/${id}`,
      authors: Object.keys(info.authors ?? {}),
      dimensions: info.dimensions,
    };
  }

  async texture(id: string, res: '1k' | '2k' = '1k'): Promise<TextureSet> {
    const files = await this.json<Record<string, Record<string, Record<string, FileRef>>>>(
      `/files/${id}`,
    );
    const pick = (map: string) => {
      const ref = files[map]?.[res]?.jpg;
      if (!ref) throw new Error(`Texture ${id} has no ${map} map at ${res}`);
      return this.file(ref, `textures/${id}/${res}/${map}.jpg`);
    };
    const { dimensions, ...credit } = await this.credit(id);
    const [w = 2000, h = 2000] = dimensions ?? [];
    return {
      credit,
      size: [w / 1000, h / 1000],
      diffuse: await pick('Diffuse'),
      normal: await pick('nor_gl'),
      arm: await pick('arm'),
    };
  }

  async model(id: string, res: '1k' | '2k' = '1k'): Promise<ModelFiles> {
    const files = await this.json<{ gltf: Record<string, { gltf: FileRef }> }>(`/files/${id}`);
    const ref = files.gltf?.[res]?.gltf;
    if (!ref) throw new Error(`Model ${id} has no glTF at ${res}`);
    const dir = `models/${id}/${res}`;
    await this.file(ref, `${dir}/${id}.gltf`);
    for (const [relative, inc] of Object.entries(ref.include ?? {}))
      await this.file(inc, `${dir}/${relative}`);
    const { dimensions, ...credit } = await this.credit(id);
    const [x = 1000, y = 1000, z = 1000] = dimensions ?? [];
    return {
      credit,
      gltfPath: join(this.cacheDir, dir, `${id}.gltf`),
      dimensions: [x / 1000, y / 1000, z / 1000],
    };
  }

  async hdri(
    id: string,
    res: '1k' | '2k' = '1k',
  ): Promise<{ credit: AssetCredit; hdr: Uint8Array; path: string }> {
    const files = await this.json<{ hdri: Record<string, { hdr: FileRef }> }>(`/files/${id}`);
    const ref = files.hdri?.[res]?.hdr;
    if (!ref) throw new Error(`HDRI ${id} has no .hdr at ${res}`);
    const { dimensions: _d, ...credit } = await this.credit(id);
    const hdr = await this.file(ref, `hdris/${id}/${res}.hdr`);
    return { credit, hdr, path: join(this.cacheDir, `hdris/${id}/${res}.hdr`) };
  }
}

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('hex');
