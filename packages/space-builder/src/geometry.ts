import type { MaterialName } from '@ats/space-format';

/** A surface: a material name, or `floor:<name>` for floor finishes (planks rather than veneer). */
export type SurfaceKey = MaterialName | `floor:${MaterialName}`;

/** Triangle soup grouped by material, with normals and metre-scale UVs. */
export class MeshBuilder {
  readonly groups = new Map<
    SurfaceKey,
    {
      positions: number[];
      normals: number[];
      uvs: number[];
      indices: number[];
      /** Faces as quads or triangles (vertex indices), for lightmap unwrapping. */
      faces: number[][];
      /** Second UV set (lightmap), filled in after baking. */
      uv2?: Float32Array<ArrayBuffer>;
    }
  >();

  private group(material: SurfaceKey) {
    let g = this.groups.get(material);
    if (!g) {
      g = { positions: [], normals: [], uvs: [], indices: [], faces: [] };
      this.groups.set(material, g);
    }
    return g;
  }

  get triangleCount(): number {
    let n = 0;
    for (const g of this.groups.values()) n += g.indices.length / 3;
    return n;
  }

  /** Adds raw triangles (for shadow casters, which only need their shape). */
  triangles(material: SurfaceKey, positions: ArrayLike<number>, indices: ArrayLike<number>) {
    const g = this.group(material);
    const base = g.positions.length / 3;
    for (let i = 0; i < positions.length; i++) g.positions.push(positions[i] as number);
    for (let i = 0; i < positions.length / 3; i++) {
      g.normals.push(0, 1, 0);
      g.uvs.push(0, 0);
    }
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = base + (indices[i] as number);
      const b = base + (indices[i + 1] as number);
      const c = base + (indices[i + 2] as number);
      g.indices.push(a, b, c);
      g.faces.push([a, b, c]);
    }
  }

  /** Copies another builder's geometry into this one. */
  append(other: MeshBuilder) {
    for (const [key, g] of other.groups) this.triangles(key, g.positions, g.indices);
  }

  /** Adds a flat quad (corners counter-clockwise when seen from the front). */
  quad(material: SurfaceKey, a: V3, b: V3, c: V3, d: V3, uvScale = 1) {
    const g = this.group(material);
    const n = normalize(cross(sub(b, a), sub(d, a)));
    const base = g.positions.length / 3;
    // Planar UVs in metres, projected on the quad's dominant plane.
    const ax =
      Math.abs(n[0]) > Math.abs(n[1]) && Math.abs(n[0]) > Math.abs(n[2])
        ? 0
        : Math.abs(n[1]) > Math.abs(n[2])
          ? 1
          : 2;
    for (const p of [a, b, c, d]) {
      g.positions.push(p[0], p[1], p[2]);
      g.normals.push(n[0], n[1], n[2]);
      const [u, v] = ax === 0 ? [p[2], p[1]] : ax === 1 ? [p[0], p[2]] : [p[0], p[1]];
      g.uvs.push(u * uvScale, v * uvScale);
    }
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    g.faces.push([base, base + 1, base + 2, base + 3]);
  }

  /** Axis-aligned box (before `transform`), optionally rotated around Y about `pivot`. */
  box(material: SurfaceKey, min: V3, max: V3, transform?: YTransform) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const t = (p: V3): V3 => (transform ? applyY(transform, p) : p);
    const c = [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ].map((p) => t(p as V3));
    const q = (i: number, j: number, k: number, l: number) =>
      this.quad(material, c[i] as V3, c[j] as V3, c[k] as V3, c[l] as V3);
    q(4, 5, 6, 7); // +z
    q(1, 0, 3, 2); // -z
    q(5, 1, 2, 6); // +x
    q(0, 4, 7, 3); // -x
    q(3, 7, 6, 2); // +y
    q(0, 1, 5, 4); // -y
  }

  /** Vertical cylinder (or cone when radii differ), capped. */
  cylinder(
    material: SurfaceKey,
    centre: V3,
    rBottom: number,
    rTop: number,
    height: number,
    segments = 20,
    transform?: YTransform,
  ) {
    const t = (p: V3): V3 => (transform ? applyY(transform, p) : p);
    const [cx, cy, cz] = centre;
    const ring = (r: number, y: number) =>
      Array.from({ length: segments }, (_, i) => {
        const a = (i / segments) * Math.PI * 2;
        return t([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
      });
    const bottom = ring(rBottom, cy);
    const top = ring(rTop, cy + height);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.quad(material, bottom[i] as V3, top[i] as V3, top[j] as V3, bottom[j] as V3);
    }
    const tc = t([cx, cy + height, cz]);
    const bc = t([cx, cy, cz]);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.tri(material, tc, top[j] as V3, top[i] as V3);
      this.tri(material, bc, bottom[i] as V3, bottom[j] as V3);
    }
  }

  /** Low-poly sphere (for foliage, cushions). */
  sphere(
    material: SurfaceKey,
    centre: V3,
    r: number,
    rings = 8,
    segments = 14,
    transform?: YTransform,
  ) {
    const t = (p: V3): V3 => (transform ? applyY(transform, p) : p);
    const pt = (i: number, j: number): V3 => {
      const phi = (i / rings) * Math.PI;
      const th = (j / segments) * Math.PI * 2;
      return t([
        centre[0] + r * Math.sin(phi) * Math.cos(th),
        centre[1] + r * Math.cos(phi),
        centre[2] + r * Math.sin(phi) * Math.sin(th),
      ]);
    };
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segments; j++) {
        this.quad(material, pt(i, j), pt(i, j + 1), pt(i + 1, j + 1), pt(i + 1, j));
      }
    }
  }

  tri(material: SurfaceKey, a: V3, b: V3, c: V3) {
    const g = this.group(material);
    const n = normalize(cross(sub(b, a), sub(c, a)));
    const base = g.positions.length / 3;
    for (const p of [a, b, c]) {
      g.positions.push(p[0], p[1], p[2]);
      g.normals.push(n[0], n[1], n[2]);
      g.uvs.push(p[0], p[2]);
    }
    g.indices.push(base, base + 1, base + 2);
    g.faces.push([base, base + 1, base + 2]);
  }
}

export type V3 = [number, number, number];
export interface YTransform {
  /** Rotation around +Y in radians (positive turns +X towards -Z). */
  angle: number;
  /** Where the local origin ends up in the world. */
  origin: V3;
}

export function applyY({ angle, origin }: YTransform, [x, y, z]: V3): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [origin[0] + x * c + z * s, origin[1] + y, origin[2] - x * s + z * c];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
