/** Where an Architect installs their AI assistant and signs in to it. */
import { VENDOR_CLIS } from '@ats/shared';
import { DockerError } from '../docker.ts';
import { type Containers, HOME, provider, TOOLS_PATH } from './containers.ts';

export function createConnect(ctx: Containers) {
  const {
    docker,
    cfg,
    volumes,
    ensureVolume,
    hardened,
    proxyEnv,
    egressHosts,
    run,
    remove,
    status,
    exec,
    connectName,
    binaryHash,
    personal,
  } = ctx;

  return {
    /** Where an Architect installs and signs in to their AI assistant. */
    async startConnect(architect: string, prov: string) {
      const p = provider(prov);
      await ensureVolume(volumes.tools(architect), 'tools');
      await ensureVolume(volumes.credentials(architect, p), `credentials-${p}`);
      await run(
        connectName(architect, p),
        {
          Hostname: 'connect',
          WorkingDir: HOME,
          Env: [...proxyEnv, TOOLS_PATH, `ATS_PROVIDER=${p}`],
          Cmd: ['sleep', 'infinity'],
          HostConfig: hardened({
            NetworkMode: cfg.sandboxNetwork,
            Dns: ['127.0.0.1'],
            ExtraHosts: await egressHosts(),
            Mounts: personal(architect, p, 'install'),
          }),
        },
        'connect',
      );
    },
    stopConnect: (architect: string, p: string) => remove(connectName(architect, provider(p))),
    /** Runs the vendor's official installer, at the pinned version. */
    async install(architect: string, prov: string) {
      const p = provider(prov);
      const cli = VENDOR_CLIS[p];
      // The installer sees ~/.local/bin on its PATH, after the system's folders, as an installer
      // run by the Architect themselves would (Claude Code's says so when it isn't there). Only
      // this container can write that folder (it's read-only in workspaces), and the checksum
      // below still uses system programs alone.
      const r = await exec(
        connectName(architect, p),
        [
          'sh',
          '-c',
          `export PATH="$PATH:$HOME/.local/bin"; ${cli.installCommand(cli.version)} 2>&1`,
        ],
        {
          limit: 8 * 1024 * 1024,
        },
      );
      const log = r.stdout.toString().split('\n').slice(-40).join('\n');
      const sha = await binaryHash(connectName(architect, p), p);
      const v = await exec(connectName(architect, p), [
        'sh',
        '-c',
        `"$HOME/${cli.binary}" --version 2>/dev/null | head -1`,
      ]);
      return { ok: r.code === 0 && Boolean(sha), log, sha, version: v.stdout.toString().trim() };
    },
    /** Whether the assistant is installed and signed in (the sign-in file is never read). */
    /** Which assistants use this server's own API key (API-key mode). */
    apiKeys() {
      return { claude: Boolean(cfg.apiKeys?.claude), codex: Boolean(cfg.apiKeys?.codex) };
    },
    async connectStatus(architect: string, prov: string) {
      const p = provider(prov);
      const container = connectName(architect, p);
      if (!(await status(container)).running) await this.startConnect(architect, p);
      const sha = await binaryHash(container, p);
      const apiKey = Boolean(cfg.apiKeys?.[p]);
      const signedIn =
        apiKey ||
        (await exec(container, ['test', '-s', `${HOME}/${VENDOR_CLIS[p].signedInFile}`])).code ===
          0;
      return { installed: Boolean(sha), sha, signedIn, apiKey };
    },
    /** Removes an Architect's sign-in for one assistant (their installed tools stay). */
    async forget(architect: string, prov: string) {
      const p = provider(prov);
      await remove(connectName(architect, p));
      try {
        await docker.json('DELETE', `/volumes/${volumes.credentials(architect, p)}`);
      } catch (err) {
        if (!(err instanceof DockerError) || err.status !== 404) throw err;
      }
    },
  };
}
