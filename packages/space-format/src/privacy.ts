import type { Doorway, SpaceManifest } from './manifest.ts';

/**
 * The part of a space one person may see: only the rooms in `visible`. Everything else is left
 * out entirely — room keys, names, sizes, files, asset credits, lift stops and spawn points — and
 * doorways into hidden rooms become closed doors that say nothing about what's behind them.
 * Returns null if the person can see no rooms at all.
 */
export function viewerManifest(
  m: SpaceManifest,
  visible: ReadonlySet<string>,
): SpaceManifest | null {
  const rooms = m.rooms
    .filter((r) => visible.has(r.key))
    .map((r) => ({
      ...r,
      neighbors: r.neighbors.filter((n) => visible.has(n)),
      doorways: r.doorways.map(
        (d): Doorway =>
          d.to && visible.has(d.to)
            ? d
            : {
                position: d.position,
                width: d.width,
                height: d.height,
                normal: d.normal,
                // Always a plain closed door, whatever is really there.
                kind: 'door',
                closed: true,
              },
      ),
    }));
  if (rooms.length === 0) return null;

  const links = m.links
    .map((l) => ({ ...l, stops: l.stops.filter((s) => visible.has(s.roomKey)) }))
    .filter((l) => l.stops.length >= 2);
  let spawns = m.spawns.filter((s) => visible.has(s.roomKey));
  if (spawns.length === 0) {
    // Start in the middle of the first room they can see.
    const r = rooms[0] as (typeof rooms)[number];
    const { min, max } = r.bounds;
    spawns = [
      {
        key: 'visible',
        roomKey: r.key,
        position: [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2],
        yaw: 0,
      },
    ];
  }
  const floorKeys = new Set(rooms.map((r) => r.floorKey));
  const creditIds = new Set(rooms.flatMap((r) => r.credits));
  return {
    ...m,
    floors: m.floors.filter((f) => floorKeys.has(f.key)),
    rooms,
    links,
    spawns,
    resources: [...new Set(rooms.flatMap((r) => r.files))].sort(),
    credits: m.credits.filter((c) => creditIds.has(c.id)),
  };
}

/** Every file a viewer of this (already filtered) manifest may download. */
export function manifestFiles(m: SpaceManifest): Set<string> {
  return new Set([
    ...m.rooms.flatMap((r) => [
      r.lods.lod0.path,
      r.lods.lod1.path,
      r.lods.lod2.path,
      r.collision.path,
      ...(r.lightmap ? [r.lightmap.path] : []),
      ...r.files,
    ]),
    ...(m.lighting.hdri ? [m.lighting.hdri.path] : []),
  ]);
}
