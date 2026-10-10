import { SpaceManifest } from '@ats/space-format';

/** Published versions never change, so their parsed manifests can be kept. */
const manifests = new Map<string, SpaceManifest>();

export function manifestOf(version: { id: string; manifest: unknown }): SpaceManifest {
  let m = manifests.get(version.id);
  if (!m) {
    m = SpaceManifest.parse(version.manifest);
    if (manifests.size > 200) manifests.clear();
    manifests.set(version.id, m);
  }
  return m;
}
