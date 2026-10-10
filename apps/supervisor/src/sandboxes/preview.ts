/** The live preview of a workspace. */
import { type Containers, HOME } from './containers.ts';

export function createPreview(ctx: Containers) {
  const { volumes, ensureVolume, hardened, run, remove, status, exec, previewName } = ctx;

  return {
    /** The live preview: rebuilds from the workspace (read-only), with no network and no sign-ins. */
    async startPreview(ws: string) {
      await ensureVolume(volumes.workspace(ws), 'workspace');
      await run(
        previewName(ws),
        {
          Cmd: ['node', '/opt/ats/packages/qa-browser/src/cli.ts', 'watch', '/workspace', '/out'],
          HostConfig: hardened({
            NetworkMode: 'none',
            Tmpfs: {
              '/tmp': 'rw,noexec,nosuid,nodev,size=1g',
              '/out': 'rw,noexec,nosuid,nodev,uid=2000,gid=2000,size=512m',
              [HOME]: 'rw,noexec,nosuid,nodev,uid=2000,gid=2000,size=64m',
            },
            Mounts: [
              {
                Type: 'volume',
                Source: volumes.workspace(ws),
                Target: '/workspace',
                ReadOnly: true,
              },
            ],
          }),
        },
        'preview',
      );
    },
    stopPreview: (ws: string) => remove(previewName(ws)),
    async previewStatus(ws: string) {
      const s = await status(previewName(ws));
      if (!s.running) return null;
      const r = await exec(previewName(ws), ['cat', '/out/status.json']);
      if (r.code !== 0) return { stamp: 0, building: true };
      return JSON.parse(r.stdout.toString()) as Record<string, unknown>;
    },
    async previewFile(ws: string, stamp: number, path: string) {
      if (!Number.isInteger(stamp) || stamp < 1) throw new Error('Bad stamp');
      if (
        !/^[\w.@/ +-]{1,300}$/.test(path) ||
        path.split('/').some((s) => s === '..' || s === '.' || s === '')
      )
        throw new Error('Bad path');
      const r = await exec(previewName(ws), ['cat', `/out/b${stamp}/${path}`], {
        limit: 64 * 1024 * 1024,
      });
      return r.code === 0 ? r.stdout : null;
    },
  };
}
