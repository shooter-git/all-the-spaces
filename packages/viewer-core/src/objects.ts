import {
  BackSide,
  Box3,
  Color,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  Raycaster,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';

/** How far away you can reach an object from (metres). */
const REACH = 4.5;
/** The colour of the glow on objects that hold creations. */
const GLOW = new Color('#4da3ff');
/** How far the halo reaches out from an object's surface (metres): about two inches. */
const HALO_WIDTH = 0.05;

/** A material's rim glow: how strong it is right now (0 when the object no longer shimmers). */
type Rim = { value: number };

/**
 * Light gathered at an object's edges (where its surface turns away from you), so the object
 * itself glows at its outline rather than being tinted all over.
 */
function addRim(material: MeshStandardMaterial, rim: Rim) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.shimmerRim = rim;
    shader.uniforms.shimmerColor = { value: GLOW };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float shimmerRim;\nuniform vec3 shimmerColor;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float shimmerFacing = saturate(dot(normal, normalize(vViewPosition)));
        totalEmissiveRadiance += shimmerColor * shimmerRim * pow(1.0 - shimmerFacing, 3.0);`,
      );
  };
  material.customProgramCacheKey = () => 'shimmer-rim';
}

/** What every halo layer shares: how strong it is and how far it reaches right now. */
type HaloUniforms = { haloStrength: { value: number }; haloWidth: { value: number } };

/** Layers in each halo: enough that their steps blur into one smooth fade. */
const HALO_LAYERS = 6;

/**
 * A soft glow around a mesh, a few inches deep: the mesh again in nested layers, each pushed a
 * little further outwards from its middle, drawn from behind and faint on its own. Where they
 * overlap (close to the object) the glow is strongest, and it thins out layer by layer, so it
 * reads as light around the object rather than an outline. Pushing from the middle (rather than
 * along each face) moves every copy of a corner together, so boxes get an unbroken glow too.
 */
function haloFor(mesh: Mesh, uniforms: HaloUniforms): Mesh[] {
  const geometry = mesh.geometry;
  geometry.computeBoundingSphere();
  const center = geometry.boundingSphere?.center.clone() ?? new Vector3();
  return Array.from({ length: HALO_LAYERS }, (_, i) => {
    const material = new ShaderMaterial({
      uniforms: {
        ...uniforms,
        haloColor: { value: GLOW },
        haloCenter: { value: center },
        haloReach: { value: (i + 1) / HALO_LAYERS },
      },
      vertexShader: `
        uniform float haloWidth;
        uniform float haloReach;
        uniform vec3 haloCenter;
        varying float vFacing;
        void main() {
          vec3 away = position - haloCenter;
          vec3 dir = normalize(length(away) > 1e-5 ? mat3(modelViewMatrix) * away : normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          mv.xyz += dir * haloWidth * haloReach;
          vFacing = abs(dot(dir, normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 haloColor;
        uniform float haloStrength;
        varying float vFacing;
        void main() {
          // Each layer's own rim fades out too, so its edge doesn't show as a line.
          gl_FragColor = vec4(haloColor, haloStrength * smoothstep(0.0, 0.35, vFacing));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: BackSide,
      transparent: true,
      depthWrite: false,
    });
    const halo = new Mesh(geometry, material);
    halo.name = 'halo';
    halo.userData.halo = true;
    halo.castShadow = false;
    halo.receiveShadow = false;
    // Outer layers first, so the inner ones lay over them.
    halo.renderOrder = 1 + HALO_LAYERS - i;
    // Not something you can point at: the object itself is.
    halo.raycast = () => {};
    return halo;
  });
}

/**
 * The things in rooms: finding which object is under a point on screen, and a glow on the ones
 * that hold creations (so people can tell there's something inside).
 */
export class RoomObjects {
  private highlighted = new Set<string>();
  /** Shimmering materials in loaded rooms (collected afresh now and then, as rooms come and go). */
  private shimmering: MeshStandardMaterial[] = [];
  private readonly halo: HaloUniforms = {
    haloStrength: { value: 0 },
    haloWidth: { value: HALO_WIDTH },
  };
  private sinceCollect = 0;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private time = 0;

  constructor(
    private readonly root: Object3D,
    private readonly reducedMotion: boolean,
  ) {
    this.raycaster.far = REACH;
  }

  /** Which objects glow (the ones holding creations). */
  setHighlighted(keys: Iterable<string>) {
    for (const m of this.shimmering) {
      m.emissive.copy(m.userData.shimmerBase as Color);
      (m.userData.rim as Rim).value = 0;
    }
    this.highlighted = new Set(keys);
    const halos: Mesh[] = [];
    this.root.traverse((o) => {
      if (o.userData.halo) halos.push(o as Mesh);
      for (const m of materialsOf(o)) if (m.userData.shimmer) m.userData.shimmer = false;
    });
    for (const h of halos) {
      h.removeFromParent();
      (h.material as Material).dispose();
    }
    this.prepare(this.root);
    this.collect();
  }

  private collect() {
    const found = new Set<MeshStandardMaterial>();
    this.root.traverse((o) => {
      for (const m of materialsOf(o)) if (m.userData.shimmer) found.add(m);
    });
    this.shimmering = [...found];
    this.sinceCollect = 0;
  }

  /** Called for each room as it arrives. */
  prepare(room: Object3D) {
    if (this.highlighted.size === 0) return;
    room.traverse((o) => {
      const key = objectKey(o);
      if (!key || !this.highlighted.has(key)) return;
      const meshes: Mesh[] = [];
      o.traverse((m) => {
        if (m instanceof Mesh && !m.userData.halo) meshes.push(m);
      });
      for (const m of meshes) {
        // Its own copy of each material, so identical objects elsewhere don't shimmer too.
        const materials = (Array.isArray(m.material) ? m.material : [m.material]).map(
          (mat: Material) => {
            if (!(mat instanceof MeshStandardMaterial) || mat.userData.shimmer) return mat;
            const own = mat.userData.shimmerBase ? mat : mat.clone();
            own.userData.shimmer = true;
            own.userData.shimmerBase ??= own.emissive.clone();
            if (!own.userData.rim) {
              own.userData.rim = { value: 0 } satisfies Rim;
              addRim(own, own.userData.rim as Rim);
            }
            this.shimmering.push(own);
            return own;
          },
        );
        m.material = Array.isArray(m.material) ? materials : (materials[0] as Material);
        if (!m.children.some((c) => c.userData.halo)) m.add(...haloFor(m, this.halo));
      }
    });
  }

  update(dt: number) {
    this.time += dt;
    // A slow breath of blue light (steady if the person prefers less motion): a halo just
    // outside the object, a glow along its edges and a faint tint over the rest of it.
    const wave = this.reducedMotion ? 0.7 : 0.5 + 0.5 * Math.sin(this.time * 1.8);
    const k = 0.02 + 0.02 * wave;
    // Kept faint: the halo's layers add up where they overlap, so each one is barely there, and
    // the object itself must still read as itself (not as a blue blob).
    const rim = 0.2 + 0.2 * wave;
    this.halo.haloStrength.value = 0.05 + 0.03 * wave;
    this.halo.haloWidth.value = HALO_WIDTH * (0.9 + 0.2 * wave);
    for (const m of this.shimmering) {
      m.emissive.copy(m.userData.shimmerBase as Color).lerp(GLOW, k);
      (m.userData.rim as Rim).value = rim;
    }
    // Rooms come and go: drop materials of rooms that have been unloaded.
    this.sinceCollect += dt;
    if (this.sinceCollect > 2) this.collect();
  }

  /** The object under a point on screen (within reach), if any. */
  pick(camera: PerspectiveCamera, x: number, y: number, rect: DOMRect): string | null {
    this.ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, camera);
    for (const hit of this.raycaster.intersectObject(this.root, true)) {
      if (!shown(hit.object)) continue;
      const key = keyOf(hit.object);
      if (key) return key;
      // Walls and floors block what's behind them.
      if (isArchitecture(hit.object)) return null;
    }
    return null;
  }

  /**
   * The objects inside a box on screen (someone drew it around something), most covered first:
   * rays through a grid of points in the box, each stopping at the first thing it hits. Further
   * than arm's reach, since you can point at things across the room.
   */
  inBox(
    camera: PerspectiveCamera,
    box: { left: number; top: number; width: number; height: number },
    rect: DOMRect,
  ): string[] {
    const hits = new Map<string, number>();
    const n = 9;
    const far = this.raycaster.far;
    this.raycaster.far = 40;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = box.left + (box.width * (i + 0.5)) / n;
        const y = box.top + (box.height * (j + 0.5)) / n;
        this.ndc.set(
          ((x - rect.left) / rect.width) * 2 - 1,
          -((y - rect.top) / rect.height) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.ndc, camera);
        for (const hit of this.raycaster.intersectObject(this.root, true)) {
          if (!shown(hit.object)) continue;
          const key = keyOf(hit.object);
          if (key) {
            hits.set(key, (hits.get(key) ?? 0) + 1);
            break;
          }
          if (isArchitecture(hit.object)) break;
        }
      }
    }
    this.raycaster.far = far;
    return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  }

  /** The middle of an object that's loaded, if it is. */
  center(key: string): [number, number, number] | null {
    let found: Object3D | null = null;
    this.root.traverse((o) => {
      if (!found && objectKey(o) === key) found = o;
    });
    if (!found) return null;
    const c = new Box3().setFromObject(found).getCenter(new Vector3());
    return [c.x, c.y, c.z];
  }
}

function materialsOf(o: Object3D): MeshStandardMaterial[] {
  if (!(o instanceof Mesh)) return [];
  const list: Material[] = Array.isArray(o.material) ? o.material : [o.material];
  return list.filter((m): m is MeshStandardMaterial => m instanceof MeshStandardMaterial);
}

/** The object a node is (its key travels in the glTF extras; loaders tidy up node names). */
const objectKey = (o: Object3D): string | null =>
  typeof o.userData?.objectKey === 'string' ? o.userData.objectKey : null;

function keyOf(o: Object3D | null): string | null {
  for (let n = o; n; n = n.parent) {
    const key = objectKey(n);
    if (key) return key;
  }
  return null;
}

/** Drawn right now: rooms out of sight stay loaded, but hidden (and can't be pointed at). */
function shown(o: Object3D) {
  for (let n: Object3D | null = o; n; n = n.parent) if (!n.visible) return false;
  return true;
}

function isArchitecture(o: Object3D | null) {
  for (let n = o; n; n = n.parent) if (n.name === 'architecture') return true;
  return false;
}
