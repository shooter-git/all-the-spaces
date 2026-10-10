import type { ViewerStats } from '@ats/viewer-core';

export function PerfPanel({ stats }: { stats: ViewerStats }) {
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  return (
    <div className="space-perf" aria-hidden="true">
      {[
        `${stats.fps.toFixed(0)} fps  ${stats.frameMs.toFixed(1)} ms (p95 ${stats.frameMsP95.toFixed(1)})`,
        `draw calls ${stats.drawCalls}  triangles ${stats.triangles.toLocaleString()}`,
        `rooms lod0 ${stats.rooms.lod0} · lod1 ${stats.rooms.lod1} · lod2 ${stats.rooms.lod2}`,
        `collision rooms ${stats.collisionRooms}  loading ${stats.loading}`,
        `resident ${kb(stats.residentBytes)}  geometries ${stats.geometries}`,
        `quality ${stats.quality}  pixel ratio ${stats.pixelRatio.toFixed(2)} (${Math.round(stats.resolutionScale * 100)}% of full)`,
      ].join('\n')}
    </div>
  );
}
