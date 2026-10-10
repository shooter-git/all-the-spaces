/** The terminal session (tmux) in a sandbox or connect container. */
import { type Containers, provider } from './containers.ts';

/** A value as one shell word, whatever it holds. */
const shellQuote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

/** Brings the Architect's shell back if the pane's own program ever ends (see launch). */
const SHELL_AGAIN = 'respawn-pane -k -t main "exec /bin/bash -l"';

/**
 * What the pane runs to start a program: a shell, named as the program (so it's seen as running
 * while it runs, and Start isn't run over it: see RUNNING), that runs it with the container's PATH,
 * then becomes the Architect's login shell. The pane's own program never ends, so the shell
 * doesn't depend on tmux noticing that one did (it sometimes misses Claude Code's exit, and the
 * pane would be stuck). A failure gets a line saying so; Ctrl+C or a normal exit, none. The
 * shell's own Ctrl+C handler isn't inherited, so Ctrl+C reaches the program as ever, and the
 * shell carries on after it.
 */
const program = (name: string, command: string, path: string | undefined) =>
  `exec -a ${shellQuote(name)} /bin/bash -c ${shellQuote(
    [
      'trap : INT',
      ...(path ? [`export PATH=${shellQuote(path)}`] : []),
      command,
      's=$?; if [ "$s" -ne 0 ] && [ "$s" -ne 130 ]; then echo "It stopped with an error (see above)."; fi',
      'exec -a bash /bin/bash -l',
    ].join('\n'),
  )}`;

/** What a terminal at a plain shell prompt is running. */
const SHELLS = ['bash', 'sh', 'zsh'];

/**
 * Prints what the terminal is running: the pane's own program, or (at the Architect's shell) the
 * program that shell is running, by their names in /proc. Not tmux's #{pane_current_command}:
 * tmux asks the terminal for its foreground process, which gVisor doesn't answer, and then goes
 * by the command the pane was last started with (`exec -a 'claude' …`, which it reads as "a"),
 * so after the first Start every one was refused as busy.
 */
const RUNNING = [
  'p=$(tmux display-message -p -t main "#{pane_pid}") || exit 1',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
  'name() { n=$(tr "\\0" "\\n" < "/proc/$1/cmdline" | head -n 1); n=${n##*/}; echo "${n#-}"; }',
  'n=$(name "$p")',
  'case " bash sh zsh " in *" $n "*) c=$(pgrep -P "$p" | head -n 1); [ -n "$c" ] && n=$(name "$c");; esac',
  'echo "$n"',
].join('\n');

/** Lines of history a screen joining a session gets first. */
const HISTORY_LINES = 400;

/** Text with every control character (C0, DEL, C1) removed: nothing that ends a line or escapes. */
function plainText(text: string) {
  return [...text].filter((c) => c >= ' ' && (c < '\u007f' || c > '\u009f')).join('');
}

/** A terminal's columns or rows, as a whole number from 1 to `most`. */
const size = (n: number, most: number) => Math.max(1, Math.min(most, Math.round(n) || 1));

/** Mouse wheel turns at most one scroll sends a program. */
const MAX_WHEELS = 200;

export function createTerminal(ctx: Containers) {
  const { docker, exec, binaryHash } = ctx;

  /**
   * The session's pane: in tmux's scroll mode or not, and whether the program in it takes the
   * mouse (Claude Code does: it draws on the alternate screen and scrolls its own conversation,
   * which is never in tmux's history), with the encoding it asked for and the pane's size.
   */
  async function pane(container: string) {
    const r = await exec(container, [
      'tmux',
      'display-message',
      '-p',
      '-t',
      'main',
      '#{pane_in_mode} #{mouse_any_flag} #{mouse_sgr_flag} #{pane_width} #{pane_height}',
    ]);
    const [inMode, mouse, sgr, width, height] = r.stdout.toString().trim().split(' ');
    return {
      inMode: inMode === '1',
      mouse: r.code === 0 && mouse === '1',
      sgr: sgr === '1',
      col: Math.max(1, Math.min(200, Math.ceil(Number(width) / 2) || 1)),
      row: Math.max(1, Math.min(200, Math.ceil(Number(height) / 2) || 1)),
    };
  }

  /**
   * Scrolls the program in the pane the way a mouse wheel over its middle would: tmux passes a
   * wheel to a program that takes the mouse, and a finger can't make one (positive is up).
   */
  async function wheel(container: string, p: Awaited<ReturnType<typeof pane>>, lines: number) {
    const button = lines > 0 ? 64 : 65;
    const report = p.sgr
      ? `\x1b[<${button};${p.col};${p.row}M`
      : `\x1b[M${String.fromCharCode(32 + button, 32 + p.col, 32 + p.row)}`;
    const bytes = Buffer.from(report.repeat(Math.min(MAX_WHEELS, Math.abs(lines))), 'latin1');
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
    await exec(container, ['tmux', 'send-keys', '-t', 'main', '-H', ...hex]);
  }

  /**
   * A terminal goes to its live screen (so what comes next reaches the program): out of tmux's
   * scroll mode. After a swipe (`scrolled`), a program that scrolls itself is sent to its bottom
   * with Ctrl+End, Claude Code's key for it (it merges a burst of wheel turns, so those can't).
   */
  async function toLive(container: string, scrolled = false) {
    try {
      const p = await pane(container);
      if (p.inMode) await exec(container, ['tmux', 'send-keys', '-X', '-t', 'main', 'cancel']);
      else if (scrolled && p.mouse)
        await exec(container, ['tmux', 'send-keys', '-t', 'main', 'C-End']);
    } catch {}
  }

  return {
    /** Starts (or reattaches to) the terminal session in a sandbox or connect container. */
    async terminal(container: string, cols: number, rows: number, cwd: string) {
      // Each terminal is one tmux client on the shared session. Docker doesn't end an exec when
      // its connection closes, so the client notes its process id, to be hung up on close. The
      // session (and the assistant in it) carries on.
      //
      // A screen that joins a session already under way first gets its last few hundred lines
      // (tmux only redraws what fits, and on a phone that can be a few rows: the start of a long
      // sign-in link would never arrive). Straight from tmux to the browser, like everything else
      // in the terminal: nothing is kept or read on the way (C5).
      const tag = Math.random().toString(36).slice(2, 10);
      const e = await docker.json<{ Id: string }>('POST', `/containers/${container}/exec`, {
        // tmux from the read-only root (see exec in containers.ts); the shell inside it keeps
        // the container's PATH, so the Architect's assistant (in ~/.local/bin) still starts.
        Cmd: [
          '/usr/bin/sh',
          '-c',
          [
            `echo $$ > /tmp/ats-term-${tag}`,
            // Under gVisor (runsc) Docker's ConsoleSize never reaches the terminal, which starts
            // 0×0, and tmux draws 0×0 as 80×24 in any window. Sized here, before tmux reads it.
            // (Resizes later on do arrive, through Docker: see resize.)
            `stty cols "$2" rows "$3" 2>/dev/null`,
            `/usr/bin/tmux has-session -t main 2>/dev/null && { /usr/bin/tmux capture-pane -p -e -J -S -${HISTORY_LINES} -t main; printf '\\033[0m\\r\\n'; }`,
            `exec /usr/bin/tmux new-session -A -s main -c "$1"`,
          ].join('; '),
          'sh',
          cwd,
          String(size(cols, 1000)),
          String(size(rows, 500)),
        ],
        Env: ['TERM=xterm-256color', 'COLORTERM=truecolor'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        ConsoleSize: [rows, cols],
      });
      const stream = await docker.hijack(`/exec/${e.Id}/start`, {
        Detach: false,
        Tty: true,
        ConsoleSize: [rows, cols],
      });
      const resize = (c: number, r: number) =>
        docker
          .json('POST', `/exec/${e.Id}/resize?h=${size(r, 500)}&w=${size(c, 1000)}`)
          .catch(() => {});
      const close = () =>
        exec(container, [
          'sh',
          '-c',
          `kill -HUP "$(cat /tmp/ats-term-${tag})" 2>/dev/null; rm -f /tmp/ats-term-${tag}`,
        ]).catch(() => {});
      return { stream, resize, close, tag };
    },

    /**
     * Scrolls the terminal session's history (touch screens can't send tmux a scroll wheel):
     * positive is back in time. tmux leaves its scroll mode by itself back at the bottom. A
     * program that takes the mouse gets the wheel instead, as tmux's own wheel binding does: its
     * screen isn't in tmux's history, which holds only what came before it started.
     */
    async scroll(container: string, lines: number) {
      const n = Math.max(1, Math.min(500, Math.round(Math.abs(lines))));
      const p = await pane(container).catch(() => null);
      if (p && !p.inMode && p.mouse)
        await wheel(container, p, Math.sign(lines) * n).catch(() => {});
      else if (lines > 0)
        await exec(container, [
          'tmux',
          'copy-mode',
          '-e',
          '-t',
          'main',
          ';',
          'send-keys',
          '-X',
          '-t',
          'main',
          '-N',
          String(n),
          'scroll-up',
        ]).catch(() => {});
      else if (lines < 0)
        await exec(container, [
          'tmux',
          'if-shell',
          '-F',
          '-t',
          'main',
          '#{pane_in_mode}',
          `send-keys -X -t main -N ${n} scroll-down`,
        ]).catch(() => {});
    },

    /** Back to the live screen after a swipe (what comes next reaches the assistant, and shows). */
    live: (container: string) => toLive(container, true),

    /** Hangs up terminal clients in a container that no longer have a connection. */
    async reap(container: string, keep: string[]) {
      const tags = keep.filter((t) => /^[a-z0-9]{1,16}$/.test(t)).join(' ');
      await exec(container, [
        'sh',
        '-c',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
        'for f in /tmp/ats-term-*; do [ -e "$f" ] || continue; t=${f#/tmp/ats-term-}; case " $0 " in *" $t "*) ;; *) kill -HUP "$(cat "$f")" 2>/dev/null; rm -f "$f";; esac; done',
        tags,
      ]).catch(() => {});
    },

    /**
     * Types text into a terminal session, never with Enter: the app never sends the assistant a
     * message (C9), so a suggested prompt waits for the Architect to send it. Control characters
     * are dropped, as when pasting, so the text itself can't carry Enter (or anything else that
     * isn't text).
     */
    async type(container: string, text: string) {
      const clean = plainText(text);
      await toLive(container);
      if (clean) await exec(container, ['tmux', 'send-keys', '-t', 'main', '-l', clean]);
      return { ok: true as const };
    },

    /**
     * Starts the assistant (or its sign-in) in the terminal as the terminal's own
     * program, given as its command line: never typed, so it can't reach a running assistant as
     * a message (C9), whatever the session answers. Code in a sandbox can rename a process or
     * replace the tmux server, so "is it at a shell prompt?" can't be trusted; it's asked only so
     * a running assistant isn't replaced by mistake. When the program ends, however it ends, the
     * Architect's shell comes back.
     *
     * The assistant's program is checked against the checksum recorded when it was installed,
     * just before it starts (C2): it lives in the Architect's tools volume, which their connect
     * container can write (an install, or the assistant run there to sign in), so a sandbox
     * start's check isn't enough for a start later on, or for signing in. In a sandbox the volume
     * is read-only, so nothing there can change it between the check and the start.
     *
     * It runs with the container's own PATH (from Docker, not from the sandbox), as the shell
     * has: tmux gives a program started for a client that client's PATH (even over -e), and ours
     * has only system folders (see exec in containers.ts), without the assistant in ~/.local/bin.
     * While it runs, the pane's own process carries the program's name (see program and RUNNING).
     */
    async launch(container: string, command: string, installed: { provider: string; sha: string }) {
      const pane = await exec(container, ['sh', '-c', RUNNING]);
      const running = pane.stdout.toString().trim();
      if (pane.code !== 0 || !SHELLS.includes(running))
        return { ok: false as const, error: 'busy', running };
      if ((await binaryHash(container, provider(installed.provider))) !== installed.sha)
        return { ok: false as const, error: 'changed' };
      const config = await docker.json<{ Config?: { Env?: string[] } }>(
        'GET',
        `/containers/${container}/json`,
      );
      const path = config.Config?.Env?.find((v) => v.startsWith('PATH='))?.slice('PATH='.length);
      const clean = plainText(command);
      const r = await exec(container, [
        'tmux',
        // Should the pane's own program end after all, the Architect's shell takes its place.
        'set-option',
        '-w',
        '-t',
        'main',
        'remain-on-exit',
        'on',
        ';',
        'set-hook',
        '-w',
        '-t',
        'main',
        'pane-died',
        SHELL_AGAIN,
        ';',
        'respawn-pane',
        '-k',
        '-t',
        'main',
        '-c',
        '#{pane_current_path}',
        program(clean.split(' ')[0] ?? 'program', clean, path),
      ]);
      return r.code === 0 ? { ok: true as const } : { ok: false as const, error: 'failed' };
    },

    /**
     * Pastes text into the terminal the way a terminal paste does (bracketed, so the assistant
     * takes it as pasted text and opens no menus). Never with Enter: the Architect sends it (C9).
     */
    async paste(container: string, text: string) {
      // Nothing that could end a line or escape the paste.
      const clean = plainText(text);
      if (!clean) return { ok: true as const };
      await toLive(container);
      const load = await exec(container, ['tmux', 'load-buffer', '-b', 'ats-paste', '-'], {
        stdin: Buffer.from(clean),
      });
      if (load.code !== 0) return { ok: false as const };
      const r = await exec(container, [
        'tmux',
        'paste-buffer',
        '-p',
        '-d',
        '-b',
        'ats-paste',
        '-t',
        'main',
      ]);
      return { ok: r.code === 0 };
    },
  };
}
