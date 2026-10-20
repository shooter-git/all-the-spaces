/** What a built room costs to draw, read from its chunk's glTF JSON. */
export interface ChunkStats {
  /** Primitives drawn: a mesh used by several nodes counts once per node. */
  draws: number;
  nodes: number;
  triangles: number;
}

interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; children?: number[] }[];
  meshes?: {
    primitives: { mode?: number; indices?: number; attributes: Record<string, number> }[];
  }[];
  accessors?: { count: number }[];
}

export function chunkStats(json: GltfJson): ChunkStats {
  const out: ChunkStats = { draws: 0, nodes: 0, triangles: 0 };
  const visit = (i: number) => {
    const node = json.nodes?.[i];
    if (!node) return;
    out.nodes++;
    for (const prim of json.meshes?.[node.mesh ?? -1]?.primitives ?? []) {
      out.draws++;
      if ((prim.mode ?? 4) !== 4) continue;
      const count = json.accessors?.[prim.indices ?? prim.attributes.POSITION ?? -1]?.count ?? 0;
      out.triangles += count / 3;
    }
    for (const c of node.children ?? []) visit(c);
  };
  for (const n of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(n);
  return out;
}
