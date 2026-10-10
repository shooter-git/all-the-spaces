import { createHash } from 'node:crypto';
import { modelPaths } from '@ats/space-builder';
import type { SpacePlan } from '@ats/space-format';
import type { Storage } from '@ats/storage';
import { chunkKey } from './spaces.ts';
import type { Supervisor } from './studio/supervisor.ts';

/**
 * A place's own models: each `models/<name>.glb` its plan uses, and the `models/<name>.py` script
 * that made it. Building merges every model into its room, so without these a place couldn't be
 * changed anywhere but in the workspace that made it. They're kept with each version (in object
 * storage, under the place, by fingerprint): a workspace for changing the place starts with them,
 * and an exported place carries them.
 */
export const SOURCE_PATH = /^models\/[A-Za-z0-9][\w-]{0,79}\.(glb|py)$/;
export const SOURCE_SHA = /^[0-9a-f]{64}$/;
/** A model's script; anything bigger isn't one. */
const MAX_SCRIPT = 1024 * 1024;

/** Where a source file is kept. Not a chunk: the viewer never loads it. */
export const sourceKey = (spaceId: string, sha: string) => chunkKey(spaceId, `sources/${sha}`);

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The script that made a model: `models/chair.glb` → `models/chair.py`. */
const scriptOf = (model: string) => model.replace(/\.glb$/, '.py');

/**
 * The files to keep for a plan's models, read from a workspace: each model it uses (`models`,
 * already read and checked) and each one's script, where there is one.
 */
export async function sourcesFrom(
  supervisor: Supervisor,
  ws: string,
  models: Map<string, Uint8Array>,
): Promise<Map<string, Uint8Array>> {
  const files = new Map(models);
  for (const path of models.keys()) {
    const script = scriptOf(path);
    // A model needn't have a script (one from the library, or made some other way).
    const bytes = await supervisor
      .raw('workspace.read', { ws }, { path: script })
      .catch(() => null);
    if (bytes && bytes.length <= MAX_SCRIPT) files.set(script, new Uint8Array(bytes));
  }
  return files;
}

/** Keeps a version's source files; returns what to record with it (path → fingerprint). */
export async function storeSources(
  storage: Storage,
  spaceId: string,
  files: Map<string, Uint8Array>,
): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const sha = sha256(bytes);
    // Content-addressed: a model that didn't change between versions is kept once.
    await storage.put(sourceKey(spaceId, sha), bytes);
    sources[path] = sha;
  }
  return sources;
}

/** A version's source files, by path. */
export async function loadSources(
  storage: Storage,
  spaceId: string,
  sources: Record<string, string> | null,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const [path, sha] of Object.entries(sources ?? {}))
    if (SOURCE_PATH.test(path) && SOURCE_SHA.test(sha))
      files.set(path, await storage.getBytes(sourceKey(spaceId, sha)));
  return files;
}

/**
 * For a version from before sources were kept: its models, from the place's workspaces that still
 * have them (the one that built it, usually). Whatever can't be found is left out.
 */
export async function sourcesInWorkspaces(
  supervisor: Supervisor | undefined,
  workspaceIds: string[],
  plan: unknown,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const plain = plan as Partial<SpacePlan> | null;
  if (!supervisor || !workspaceIds.length || !Array.isArray(plain?.furniture)) return files;
  for (const path of modelPaths(plain as SpacePlan)) {
    for (const ws of workspaceIds) {
      const bytes = await supervisor.raw('workspace.read', { ws }, { path }).catch(() => null);
      if (!bytes) continue;
      for (const [p, b] of await sourcesFrom(supervisor, ws, new Map([[path, bytes]])))
        files.set(p, b);
      break;
    }
  }
  return files;
}
