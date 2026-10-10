import type { Material, Object3D, Texture } from 'three';
import { Mesh } from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

type ImageSource = Texture['source'];

interface GltfJson {
  textures?: { source?: number; extensions?: Record<string, { source?: number }> }[];
  images?: { uri?: string }[];
}

/**
 * Rooms share texture files (the same plaster or oak floor in every room). Each room file loads
 * its own copy; this swaps them for one shared image per file, so the GPU holds it once.
 * three.js uploads per image source and counts its users, so disposing a room's textures as
 * usual frees a shared image only when the last room using it goes.
 */
export class SharedTextures {
  private readonly sources = new Map<string, { source: ImageSource; rooms: number }>();

  /** Shares a freshly loaded room's images; returns the files it now uses (for `release`). */
  adopt(gltf: GLTF, chunkUrl: string): string[] {
    const json = gltf.parser.json as GltfJson;
    const uriOf = new Map<ImageSource, string>();
    for (const [object, ref] of gltf.parser.associations) {
      const index = (ref as { textures?: number }).textures;
      if (index === undefined || !(object as Texture).isTexture) continue;
      const def = json.textures?.[index];
      const image = def?.extensions?.EXT_texture_webp?.source ?? def?.source;
      const uri = image === undefined ? undefined : json.images?.[image]?.uri;
      if (uri) uriOf.set((object as Texture).source, new URL(uri, chunkUrl).href);
    }
    const used = new Set<string>();
    forEachTexture(gltf.scene, (texture) => {
      const uri = uriOf.get(texture.source);
      if (!uri) return;
      const shared = this.sources.get(uri);
      if (!shared) {
        this.sources.set(uri, { source: texture.source, rooms: 0 });
      } else if (shared.source !== texture.source) {
        const duplicate = texture.source.data as { close?: () => void } | null;
        texture.source = shared.source;
        duplicate?.close?.(); // an ImageBitmap we no longer need
      }
      used.add(uri);
    });
    for (const uri of used) {
      const entry = this.sources.get(uri);
      if (entry) entry.rooms++;
    }
    return [...used];
  }

  /** A room using these files has gone. */
  release(uris: string[]) {
    for (const uri of uris) {
      const entry = this.sources.get(uri);
      if (entry && --entry.rooms <= 0) this.sources.delete(uri);
    }
  }
}

function forEachTexture(root: Object3D, visit: (t: Texture) => void) {
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const materials: Material[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) {
      for (const value of Object.values(m)) if ((value as Texture)?.isTexture) visit(value);
    }
  });
}
