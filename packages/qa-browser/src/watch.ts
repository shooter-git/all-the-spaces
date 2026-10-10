import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanBuild, listFiles } from './build.ts';

const SKIP = new Set(['node_modules', 'dist', '.git', '.vite', 'qa-output', '.cache']);

/** A fingerprint of the project's files (paths, sizes and change times). */
async function fingerprint(dir: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (d: string, depth: number) => {
    if (depth > 12) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(join(d, e.name), depth + 1);
      } else if (e.isFile()) {
        const s = await stat(join(d, e.name)).catch(() => null);
        if (s) parts.push(`${join(d, e.name)}:${s.size}:${s.mtimeMs}`);
      }
    }
  };
  await walk(dir, 0);
  // An install finishing (pnpm writes this last) is a change too.
  const installed = await stat(join(dir, 'node_modules/.modules.yaml')).catch(() => null);
  if (installed) parts.push(`installed:${installed.mtimeMs}`);
  return parts.sort().join('\n');
}

/**
 * The live preview: rebuilds the creation whenever its files change, with the same fixed
 * settings as publishing. Polls (file-change notifications don't cross sandbox boundaries).
 * Each build goes to `<out>/b<n>/`; `<out>/status.json` says which one is current.
 */
export async function watch(projectDir: string, outDir: string, intervalMs = 700) {
  let last = '';
  let n = 0;
  for (;;) {
    const now = await fingerprint(projectDir);
    if (now !== last) {
      // Wait for a burst of edits to settle.
      await new Promise((r) => setTimeout(r, 300));
      const settled = await fingerprint(projectDir);
      if (settled !== now) continue;
      last = settled;
      n++;
      const target = join(outDir, `b${n}`);
      const started = Date.now();
      let status: Record<string, unknown>;
      try {
        await cleanBuild(projectDir, target);
        status = {
          stamp: n,
          ok: true,
          ms: Date.now() - started,
          at: new Date().toISOString(),
          files: await listFiles(target),
        };
      } catch (err) {
        status = {
          stamp: n,
          ok: false,
          error: String((err as Error).message).slice(0, 4000),
          at: new Date().toISOString(),
        };
      }
      await writeFile(join(outDir, 'status.json'), JSON.stringify(status));
      // Keep the previous build a little longer: someone may still be loading it.
      await rm(join(outDir, `b${n - 2}`), { recursive: true, force: true });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
