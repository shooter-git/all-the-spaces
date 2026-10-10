/** An Architect's workspace: its sandbox, and the few things the Studio may do in it. */
import { PROVIDERS, type Provider, packTar as pack, VENDOR_CLIS } from '@ats/shared';
import { DockerError, demux } from '../docker.ts';
import { CODEX_SQLITE_HOME, type Containers, HOME, provider, TOOLS_PATH } from './containers.ts';

/** The environment variable each assistant's maker documents for an API key. */
const API_KEY_ENV: Record<Provider, string> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
};

/**
 * Saves a checkpoint: commits everything in a workspace that isn't committed, as the Studio, in
 * its own git repository (nothing leaves the workspace). Run where nothing else is running (see
 * checkpoint), so a lock left by a git that was stopped half-way (older than a minute) goes. Its
 * git hooks don't run. The floor plans and photos a place was made from, and the Architect's
 * uploads, are never committed; nor is anything .gitignore leaves out (dependencies, builds).
 */
const CHECKPOINT = [
  'cd /workspace && [ -d .git ] || exit 0',
  'find .git -maxdepth 1 -name index.lock -mmin +1 -delete',
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }',
  "g add -A -- . ':(exclude)inputs' ':(exclude)uploads' || exit 1",
  'g diff --cached --quiet && { echo nothing; exit 0; }',
  'g -c user.name=Studio -c user.email=studio@workspace.local commit -q -m "$1" || exit 1',
  'echo saved',
].join('\n');

const gitIdentity = (name: string, email: string) => [
  `GIT_AUTHOR_NAME=${name}`,
  `GIT_AUTHOR_EMAIL=${email}`,
  `GIT_COMMITTER_NAME=${name}`,
  `GIT_COMMITTER_EMAIL=${email}`,
];

/** Workspace files the Studio may read, and write (for the plan editor). */
const READABLE =
  /^(plan\.json|trace\.json|CLAUDE\.md|AGENTS\.md|preview\/((models|rooms)\/)?[\w.-]{1,80}\.png|models\/[A-Za-z0-9][\w-]{0,79}\.(glb|py))$/;
/** The plan (the Studio's editor), and the platform's instructions (kept up to date). */
const WRITABLE = /^(plan\.json|CLAUDE\.md|AGENTS\.md|\.ats\/(CLAUDE|AGENTS)\.md\.before-update)$/;
/** A file added to `uploads/`: a plain name (made so by the server) and its extension. */
const UPLOAD_NAME = /^([a-z0-9][a-z0-9_-]{0,79})(\.[a-z0-9]{1,10})?$/;
const MAX_UPLOAD = 26 * 1024 * 1024;
/** Changed files listed at most (a workspace that makes thousands lists the first). */
const MAX_CHANGED = 2000;
/** Bytes of names read at most. */
const CHANGED_BYTES = 512 * 1024;
/**
 * The paths that differ from the workspace's first commit (made when it started) and the new
 * ones git doesn't know yet, NUL-separated: `diff`'s status and path pairs, an empty field, then
 * the new paths. Names only, never contents; `.gitignore` leaves out dependencies and builds.
 */
const CHANGED_SCRIPT = [
  'cd /workspace',
  'base=$(git rev-list --max-parents=0 HEAD | tail -n 1)',
  '{ git -c core.fsmonitor=false diff --name-status -z --no-renames "$base" -- && printf "\\0" && git -c core.fsmonitor=false ls-files -z --others --exclude-standard; }',
].join(' && ');
/** How a file differs from when the workspace started. */
type Change = 'added' | 'changed' | 'removed';
/** A path as git prints it from the workspace's top: plain text, never outside it. */
const changedPath = (p: string) =>
  p.length > 0 &&
  p.length <= 400 &&
  ![...p].some((c) => c < ' ' || c === '\u007f') &&
  !p.startsWith('/') &&
  !p.split('/').some((part) => part === '' || part === '.' || part === '..');
/** The most of one file the Studio shows (a picture can be large; text is cut far shorter). */
const VIEW_BYTES = 8 * 1024 * 1024;
/**
 * Prints one workspace file ($1, from the workspace's top) if it's a plain file inside it and no
 * bigger than VIEW_BYTES: exits 4 when it isn't one, 5 (printing its size) when it's too big.
 */
const VIEW_SCRIPT = [
  'cd /workspace || exit 4',
  '[ -f "$1" ] && [ ! -L "$1" ] || exit 4',
  'real=$(realpath -e -- "$1") || exit 4',
  'case "$real" in /workspace/*) ;; *) exit 4;; esac',
  'size=$(stat -c %s -- "$real") || exit 4',
  `[ "$size" -le ${VIEW_BYTES} ] || { printf %s "$size"; exit 5; }`,
  'exec cat -- "$real"',
].join('\n');
/**
 * Reads (`read`) or writes (`write`, from stdin) one file under /workspace without following a
 * link anywhere on the way: each folder is opened from the one before it, refusing links, so
 * nothing can be swapped in between a check and the read. It runs in the workspace's reader (or
 * a helper, to write), where no sign-in is mounted for a link to point at; refusing links as well
 * keeps it to the workspace there too (docs/compliance.md, C4). O_NOFOLLOW alone isn't enough:
 * gVisor (production's runtime) follows a link to a folder opened with O_DIRECTORY | O_NOFOLLOW,
 * where Linux refuses it. So each name is looked at first (lstat, which never follows), and what
 * was opened must be that same file: a link, or anything swapped in between, is refused. A write
 * lands under a new name, then is renamed over the old, which replaces a link rather than writing
 * through it. Exits 4 for anything that isn't a plain file there, 5 for more than the limit.
 *
 * Run as /usr/bin/python3 (the root filesystem is read-only, so the assistant can't replace it)
 * with -I, so nothing from the workspace (its working folder) or the environment is imported.
 */
const NO_FOLLOW_IO = `
import os, stat, sys
mode, path, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
parts = path.split('/')
nf = os.O_NOFOLLOW | os.O_CLOEXEC
def opened(name, flags, d, kind):
    seen = os.lstat(name, dir_fd=d)
    if not kind(seen.st_mode):
        sys.exit(4)
    f = os.open(name, flags | nf, dir_fd=d)
    got = os.fstat(f)
    if (got.st_dev, got.st_ino) != (seen.st_dev, seen.st_ino):
        sys.exit(4)
    return f, got
try:
    d = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    for part in parts[:-1]:
        if mode == 'write':
            try:
                os.mkdir(part, 0o755, dir_fd=d)
            except FileExistsError:
                pass
        n, _ = opened(part, os.O_RDONLY | os.O_DIRECTORY, d, stat.S_ISDIR)
        os.close(d)
        d = n
    name = parts[-1]
    if mode == 'read':
        f, info = opened(name, os.O_RDONLY | os.O_NONBLOCK, d, stat.S_ISREG)
        if info.st_size > limit:
            sys.exit(5)
        with os.fdopen(f, 'rb') as r:
            data = r.read(limit + 1)
        if len(data) > limit:
            sys.exit(5)
        sys.stdout.buffer.write(data)
    else:
        data = sys.stdin.buffer.read(limit + 1)
        if len(data) > limit:
            sys.exit(5)
        tmp = '.' + name + '.ats-new'
        try:
            os.unlink(tmp, dir_fd=d)
        except FileNotFoundError:
            pass
        f = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nf, 0o644, dir_fd=d)
        try:
            with os.fdopen(f, 'wb') as w:
                w.write(data)
            os.rename(tmp, name, src_dir_fd=d, dst_dir_fd=d)
        except OSError:
            os.unlink(tmp, dir_fd=d)
            raise
except OSError:
    sys.exit(4)
`;
/** Runs NO_FOLLOW_IO: the path and limit are arguments, never part of the program. */
const noFollow = (mode: 'read' | 'write', path: string, limit: number) => [
  '/usr/bin/python3',
  '-I',
  '-c',
  NO_FOLLOW_IO,
  mode,
  path,
  String(limit),
];
/** The most the Studio reads of a workspace file this way, and writes. */
const READ_LIMIT = 32 * 1024 * 1024;
const WRITE_LIMIT = 2 * 1024 * 1024;
/** The only commands the Studio can run in a workspace. */
const FIXED: Record<string, string> = {
  'space-overlay': 'ats space overlay',
  'space-check': 'ats space check',
};

/** Environment names a caller may set in a sandbox (values are plain settings, never secrets). */
const SETTABLE_ENV = new Set([
  'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING',
  'ATS_MODEL',
  'ATS_EFFORT',
]);

export function createWorkspace(ctx: Containers) {
  const {
    docker,
    cfg,
    volumes,
    ensureVolume,
    hardened,
    proxyEnvFor,
    proxyEnv,
    egressHosts,
    openProxy,
    run,
    remove,
    status,
    exec,
    withHelper,
    withReader,
    putAwayReader,
    sandboxName,
    previewName,
    binaryHash,
    personal,
    conversations,
  } = ctx;

  /**
   * Commits a workspace's work (CHECKPOINT), in a helper that has the workspace and nothing else
   * (C4): only once its sandbox is gone, so nothing is half-way through a change. One at a time
   * for each workspace: a sleep asked for twice doesn't commit twice at once.
   */
  const checkpoints = new Map<string, Promise<string>>();
  function checkpoint(ws: string, message: string) {
    const next = (checkpoints.get(ws) ?? Promise.resolve(''))
      .catch(() => '')
      .then(() =>
        withHelper(ws, true, async (helper) => {
          const r = await exec(helper, ['sh', '-c', CHECKPOINT, 'sh', message]);
          return r.code === 0 ? r.stdout.toString().trim() || 'saved' : 'failed';
        }),
      )
      .catch(() => 'failed');
    checkpoints.set(ws, next);
    void next.finally(() => {
      if (checkpoints.get(ws) === next) checkpoints.delete(ws);
    });
    return next;
  }

  return {
    /** An Architect's workspace with their AI assistant. */
    async startSandbox(o: {
      ws: string;
      architect: string;
      provider: string;
      sha?: string | null;
      env?: Record<string, string>;
      /** `open`: the whole internet (HTTPS), when the group allows it; otherwise the allow-list. */
      net?: string;
    }) {
      const p = provider(o.provider);
      await ensureVolume(volumes.workspace(o.ws), 'workspace');
      await ensureVolume(volumes.tools(o.architect), 'tools');
      await ensureVolume(volumes.credentials(o.architect, p), `credentials-${p}`);
      await ensureVolume(volumes.cache(o.ws), 'cache');
      for (const m of conversations(o.ws, p)) await ensureVolume(m.Source, 'conversation');
      const env = Object.entries(o.env ?? {})
        .filter(([k, v]) => SETTABLE_ENV.has(k) && /^[\w.:-]{0,64}$/.test(v))
        .map(([k, v]) => `${k}=${v}`);
      const container = sandboxName(o.ws);
      await run(
        container,
        {
          Hostname: 'workspace',
          WorkingDir: '/workspace',
          Env: [
            ...(o.net === 'open' && cfg.egressSecret
              ? proxyEnvFor(openProxy(o.ws, cfg.egressSecret))
              : proxyEnv),
            TOOLS_PATH,
            // The tools volume (~/.local) is read-only here: what used to be written there goes
            // to the workspace's own cache volume (packages) or its scratch home (the assistant's
            // lock files).
            `XDG_STATE_HOME=${HOME}/.state`,
            `npm_config_store_dir=${HOME}/.cache/pnpm-store`,
            `ATS_WORKSPACE=${o.ws}`,
            `ATS_PROVIDER=${p}`,
            ...(p === 'codex' ? [CODEX_SQLITE_HOME] : []),
            // The assistant's own commits (its checkpoints, as its instructions ask) say whose
            // they are; the Studio's say "Studio".
            ...gitIdentity(VENDOR_CLIS[p].name, `${p}@workspace.local`),
            ...env,
            // API-key mode: from this service's own settings, never from a caller.
            ...(cfg.apiKeys?.[p] ? [`${API_KEY_ENV[p]}=${cfg.apiKeys[p]}`] : []),
          ],
          // First start: make the workspace a git repository (so the assistant can track changes),
          // and install its dependencies (install scripts off) so the live preview can build. Also
          // when they came from another store (the shared one in the tools volume, before it was
          // read-only here): pnpm then relinks them to this workspace's own, without stopping to
          // ask (a setting it takes on the command line, not from the environment).
          Cmd: [
            'sh',
            '-c',
            'cd /workspace && (git rev-parse 2>/dev/null || (git init -q && git add -A && GIT_AUTHOR_NAME=Architect GIT_AUTHOR_EMAIL=architect@workspace.local GIT_COMMITTER_NAME=Architect GIT_COMMITTER_EMAIL=architect@workspace.local git commit -qm "Start")); (if [ ! -d node_modules ] || ! grep -qs "^storeDir: $npm_config_store_dir" node_modules/.modules.yaml; then pnpm install --config.confirm-modules-purge=false --reporter=silent >/tmp/first-install.log 2>&1 </dev/null; fi &); exec sleep infinity',
          ],
          HostConfig: hardened({
            NetworkMode: cfg.sandboxNetwork,
            // No DNS: every name is resolved by the egress proxy, which checks the allow-list.
            Dns: ['127.0.0.1'],
            ExtraHosts: await egressHosts(),
            Mounts: [
              { Type: 'volume', Source: volumes.workspace(o.ws), Target: '/workspace' },
              { Type: 'volume', Source: volumes.cache(o.ws), Target: `${HOME}/.cache` },
              ...personal(o.architect, p),
              ...conversations(o.ws, p),
            ],
          }),
        },
        'sandbox',
      );
      // A conversation volume is the sandbox user's only if the image has its folder (an image
      // older than this supervisor doesn't): one made without it stays root's, so it goes again.
      const chats = conversations(o.ws, p);
      const writable = await exec(container, [
        'sh',
        '-c',
        'for d; do [ -w "$d" ] || exit 1; done',
        'sh',
        ...chats.map((m) => m.Target),
      ]);
      if (writable.code !== 0) {
        await remove(container);
        for (const m of chats) await docker.json('DELETE', `/volumes/${m.Source}`).catch(() => {});
        throw new Error('The workbench image is older than the supervisor: update it');
      }
      // The assistant must be exactly what the Architect installed (C2).
      if (o.sha) {
        const now = await binaryHash(container, p);
        if (now !== o.sha) {
          await remove(container);
          return { ok: false as const, error: 'changed' };
        }
      }
      return { ok: true as const };
    },
    /**
     * Puts a workspace to sleep (its files stay), then saves a checkpoint of whatever its
     * assistant didn't commit. That's never a reason not to sleep: what it did is returned.
     */
    async stopSandbox(ws: string) {
      await remove(sandboxName(ws));
      const saved = await checkpoint(ws, 'Checkpoint: saved when the workspace went to sleep');
      return { checkpoint: saved };
    },
    sandboxStatus: (ws: string) => status(sandboxName(ws)),

    /**
     * When the workspace's terminal last printed anything (seconds since 1970), or null: tmux
     * notes the time of a window's last output. Only that time is read, never what was printed.
     * An assistant at work prints (its progress, its tools); one waiting at its prompt doesn't.
     */
    async sandboxActivity(ws: string) {
      const container = sandboxName(ws);
      if (!(await status(container)).running) return { at: null };
      const r = await exec(container, [
        'tmux',
        'display-message',
        '-p',
        '-t',
        'main',
        '#{window_activity}',
      ]).catch(() => null);
      const at = Number(r?.stdout.toString().trim());
      return { at: r?.code === 0 && Number.isFinite(at) && at > 0 ? at : null };
    },

    /** Writes a new workspace's files (only into an empty workspace). */
    async initWorkspace(ws: string, files: Map<string, Uint8Array>) {
      return withHelper(ws, true, async (helper) => {
        const empty = await exec(helper, ['sh', '-c', '[ -z "$(ls -A /workspace)" ]']);
        if (empty.code !== 0) return { ok: false as const, error: 'not-empty' };
        const r = await exec(helper, ['tar', '-x', '-C', '/workspace', '-f', '-'], {
          stdin: pack(files),
        });
        return r.code === 0
          ? { ok: true as const }
          : { ok: false as const, error: r.stderr.toString().slice(0, 500) };
      });
    },

    /**
     * The workspace's source (without dependencies, builds, git history or uploads), as a tar
     * archive.
     */
    async archiveWorkspace(ws: string) {
      return withHelper(ws, false, async (helper) => {
        const r = await exec(
          helper,
          [
            'tar',
            '-C',
            '/workspace',
            '--exclude=./node_modules',
            '--exclude=./dist',
            '--exclude=./.git',
            '--exclude=./qa-output',
            // Files the Architect added are for the assistant to look at, not part of the source.
            '--exclude=./uploads',
            '-cf',
            '-',
            '.',
          ],
          { limit: 400 * 1024 * 1024 },
        );
        if (r.code !== 0) throw new Error(r.stderr.toString().slice(0, 500));
        return r.stdout;
      });
    },

    async deleteWorkspace(ws: string) {
      await remove(sandboxName(ws));
      await remove(previewName(ws));
      await putAwayReader(ws);
      const chats = PROVIDERS.flatMap((p) => conversations(ws, p).map((m) => m.Source));
      for (const volume of [volumes.workspace(ws), volumes.cache(ws), ...chats])
        try {
          await docker.json('DELETE', `/volumes/${volume}`);
        } catch (err) {
          if (!(err instanceof DockerError) || err.status !== 404) throw err;
        }
    },

    /**
     * The assistant's pictures (model previews and room renders) and its models, with when each
     * was last written (seconds): for the Studio to show, and to tell when a place has changed
     * since it was built. Works asleep too (the reader reads the volume either way).
     */
    async listPictures(ws: string) {
      const list = (container: string) =>
        exec(
          container,
          [
            'find',
            '/workspace/preview/models',
            '/workspace/preview/rooms',
            '/workspace/models',
            '-maxdepth',
            '1',
            '-type',
            'f',
            '(',
            '-name',
            '*.png',
            '-o',
            '-name',
            '*.glb',
            ')',
            '-printf',
            '%p\t%s\t%T@\n',
          ],
          { limit: 512 * 1024 },
        );
      const r = await withReader(ws, list);
      const files = r.stdout
        .toString()
        .split('\n')
        .map((line) => line.split('\t'))
        .filter(([p]) => p?.startsWith('/workspace/'))
        .map(([p, bytes, at]) => ({
          path: (p as string).slice('/workspace/'.length),
          bytes: Number(bytes),
          at: Number(at),
        }))
        .filter((f) => READABLE.test(f.path));
      return {
        pictures: files.filter((f) => f.path.endsWith('.png')).slice(0, 500),
        models: files.filter((f) => f.path.endsWith('.glb')).slice(0, 500),
      };
    },

    /** What's in an awake workspace's `uploads/` folder (plain names only), oldest first. */
    async listUploads(ws: string) {
      const container = sandboxName(ws);
      if (!(await status(container)).running) return { files: [] };
      const r = await exec(
        container,
        ['find', '/workspace/uploads', '-maxdepth', '1', '-type', 'f', '-printf', '%f\t%s\t%T@\n'],
        { limit: 256 * 1024 },
      );
      if (r.code !== 0) return { files: [] }; // nothing added yet
      const files = r.stdout
        .toString()
        .split('\n')
        .map((line) => line.split('\t'))
        .filter(([name]) => name && UPLOAD_NAME.test(name))
        .map(([name, bytes, at]) => ({
          name: name as string,
          bytes: Number(bytes),
          at: Number(at),
        }))
        .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
        .slice(-200)
        .map((f) => ({ ...f, at: Math.round(f.at) }));
      return { files };
    },

    /**
     * What the assistant has made, changed or removed in an awake workspace since it started
     * (names only), in path order. Empty for a workspace that isn't a git repository.
     */
    async changedFiles(
      ws: string,
    ): Promise<{ files: { path: string; change: Change }[]; more: boolean }> {
      const container = sandboxName(ws);
      if (!(await status(container)).running) return { files: [], more: false };
      const r = await exec(container, [
        'sh',
        '-c',
        `{ ${CHANGED_SCRIPT}; } | head -c ${CHANGED_BYTES}`,
      ]);
      const out = r.stdout.toString('utf8');
      const fields = out.split('\0');
      // Cut short: the last name may be part of one.
      const cut = Buffer.byteLength(out) >= CHANGED_BYTES;
      if (cut) fields.pop();
      const files = new Map<string, Change>();
      let i = 0;
      for (; i + 1 < fields.length && fields[i] !== ''; i += 2) {
        const [code, path] = [fields[i] as string, fields[i + 1] as string];
        if (changedPath(path))
          files.set(path, code === 'A' ? 'added' : code === 'D' ? 'removed' : 'changed');
      }
      for (const path of fields.slice(i + 1)) if (changedPath(path)) files.set(path, 'added');
      const list = [...files]
        .map(([path, change]) => ({ path, change }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { files: list.slice(0, MAX_CHANGED), more: cut || list.length > MAX_CHANGED };
    },

    /**
     * One workspace file's contents, for the Architect to look at (null when there's no such
     * file). Read only in the workspace's reader, which has the workspace and nothing else, never
     * the sandbox: the sandbox also has the assistant's sign-in, which a link in the workspace
     * could point at, and no credential may reach platform code (docs/compliance.md, C4). Never
     * git's own files.
     */
    async viewFile(ws: string, path: string) {
      if (!changedPath(path) || path === '.git' || path.startsWith('.git/')) return null;
      const r = await withReader(ws, (reader) =>
        exec(reader, ['sh', '-c', VIEW_SCRIPT, 'sh', path], { limit: VIEW_BYTES + 1024 }),
      );
      if (r.code === 5)
        throw Object.assign(new Error(`Too big: ${r.stdout.toString().trim()} bytes`), {
          status: 413,
        });
      return r.code === 0 ? r.stdout : null;
    },

    /** Removes one file from a workspace's `uploads/` folder (nothing else can go this way). */
    async removeUpload(ws: string, name: string) {
      if (!UPLOAD_NAME.test(name)) throw new Error('Not allowed');
      // The name goes in as an argument, never into the script.
      const remove = (container: string) =>
        exec(container, ['sh', '-c', 'rm -f -- "/workspace/uploads/$1"', 'sh', name]);
      const running = (await status(sandboxName(ws))).running;
      const r = running ? await remove(sandboxName(ws)) : await withHelper(ws, true, remove);
      return { ok: r.code === 0 };
    },

    /**
     * Adds a file the Architect gave to the workspace's `uploads/` folder, under a free name (an
     * existing file is never replaced), and returns the name it got.
     */
    async upload(ws: string, name: string, data: Buffer) {
      const m = UPLOAD_NAME.exec(name);
      if (!m || data.length > MAX_UPLOAD) throw new Error('Not allowed');
      const [, base, ext] = m;
      // The name goes in as arguments, never into the script.
      const script =
        'mkdir -p /workspace/uploads && cd /workspace/uploads && n="$1$2" && i=2 && ' +
        'while [ -e "$n" ]; do n="$1-$i$2"; i=$((i+1)); done && ' +
        'cat > ".$n.part" && mv ".$n.part" "$n" && printf %s "$n"';
      const write = (container: string) =>
        exec(container, ['sh', '-c', script, 'sh', base as string, ext as string], { stdin: data });
      const running = (await status(sandboxName(ws))).running;
      const r = running ? await write(sandboxName(ws)) : await withHelper(ws, true, write);
      if (r.code !== 0) throw new Error('Could not add the file (is the workspace full?)');
      return { name: r.stdout.toString(), running };
    },

    /**
     * Reads one of a few named files from a workspace (awake or asleep): the plan being built, its
     * previews, and the models it uses (and their scripts). Nothing else in a workspace can be read
     * this way, and none of these through a link: in the workspace's reader, never its sandbox,
     * which has the Architect's sign-in (C4).
     */
    async readFile(ws: string, path: string) {
      if (!READABLE.test(path)) throw new Error('Not readable');
      const r = await withReader(ws, (reader) =>
        exec(reader, noFollow('read', path, READ_LIMIT), { limit: READ_LIMIT + 1024 }),
      );
      return r.code === 0 ? r.stdout : null;
    },

    /**
     * Writes the plan (the Studio's plan editor) or the platform's instructions; nothing else can
     * be written this way, and never through a link. In a helper, never the sandbox (C4): it's
     * seldom (a save, a start), so a second for a helper is no matter.
     */
    async writeFile(ws: string, path: string, data: Buffer) {
      if (!WRITABLE.test(path) || data.length > WRITE_LIMIT) throw new Error('Not writable');
      const r = await withHelper(ws, true, (helper) =>
        exec(helper, noFollow('write', path, WRITE_LIMIT), { stdin: data }),
      );
      return { ok: r.code === 0 };
    },

    /** One of a few fixed commands in an awake workspace (never anything the caller writes). */
    async runFixed(ws: string, what: string) {
      const command = FIXED[what];
      if (!command) throw new Error('Unknown command');
      const r = await exec(sandboxName(ws), ['sh', '-c', `cd /workspace && ${command} 2>&1`], {
        limit: 1024 * 1024,
      });
      return { code: r.code, output: r.stdout.toString().slice(-8000) };
    },

    /** Runs the checks in a workspace (as `ats qa` would) and returns the report's summary. */
    async check(ws: string) {
      const container = sandboxName(ws);
      const r = await exec(
        container,
        [
          'sh',
          '-c',
          'cd /workspace && ats qa >/tmp/last-check.log 2>&1; cat qa-output/report.json',
        ],
        {
          limit: 16 * 1024 * 1024,
        },
      );
      try {
        return {
          ok: true as const,
          report: JSON.parse(r.stdout.toString()) as Record<string, unknown>,
        };
      } catch {
        const log = await exec(container, ['tail', '-n', '30', '/tmp/last-check.log']);
        return { ok: false as const, error: log.stdout.toString() };
      }
    },

    /** Recently blocked hosts for one workspace, from the egress proxy's log (host names only). */
    async blocked(egressContainer: string, since: number, ws?: string) {
      let ip: string | null = null;
      if (ws) {
        try {
          const c = await docker.json<{
            State: { StartedAt: string };
            NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
          }>('GET', `/containers/${sandboxName(ws)}/json`);
          ip = c.NetworkSettings.Networks[cfg.sandboxNetwork]?.IPAddress ?? null;
          // Addresses are reused: only count what happened since this sandbox started.
          since = Math.max(since, Date.parse(c.State.StartedAt) || 0);
        } catch {
          return [];
        }
        if (!ip) return [];
      }
      const res = await docker.raw(
        'GET',
        `/containers/${egressContainer}/logs?stdout=1&since=${Math.floor(since / 1000)}&tail=500`,
      );
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      const { stdout } = await demux(
        (async function* () {
          yield Buffer.concat(chunks);
        })(),
      );
      const entries: { at: string; from: string; host: string; why: string }[] = [];
      for (const line of stdout.toString().split('\n')) {
        try {
          const e = JSON.parse(line);
          const mine = !ip || e.from === ip || e.from === `::ffff:${ip}`;
          if (e.allowed === false && e.host && mine && Date.parse(e.at) >= since)
            entries.push({ at: e.at, from: e.from, host: e.host, why: e.why });
        } catch {}
      }
      return entries;
    },
  };
}
