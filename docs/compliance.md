# AI compliance

All AI work is done by the Architect personally, using the **official, unmodified** Claude Code or
Codex command-line tools, signed in with **their own** subscription through the vendor's own sign-in.
The platform does not use AI APIs by default and never automates AI work on anyone's behalf.

## Checklist

Each item names the phases whose release must pass it.

| # | Rule | Phases |
|---|---|---|
| C1 | No member action leads to AI work or sandbox execution; a request only creates a queue item | 5, 7 |
| C2 | CLIs are installed by the Architect's own session from the official installer, version-pinned and checksum-verified; never patched or wrapped; sign-in methods untouched | 5 |
| C3 | No vendor CLI binaries in this repository or in published images | 0, 5 |
| C4 | Credential volumes attach only to that Architect's sandboxes; never to platform services; excluded from backups; defaults are written only to workspace config | 5 |
| C5 | Terminal traffic is never logged, stored or inspected | 5 |
| C6 | No UI field for assistant credentials or login codes | 5 |
| C7 | Outbound traffic from sandboxes goes through a hostname allow-list only: no TLS interception, no token handling, no inference proxy | 5 |
| C8 | Model and effort defaults use the assistant's own config files or flags; time limits are enforced by the job runner | 5 |
| C9 | Suggested prompts are never sent automatically; the Architect starts every AI turn | 5, 7 |
| C10 | No API-key mode in the default build; any such mode is separate and off by default | 9 |
| C11 | Every asset's licence is recorded; builds fail on unknown licences | 4, 6 |

## How each rule is kept (Phase 5)

| # | How | Checked by |
|---|---|---|
| C1 | Everything in the Studio is for Architects. Members' requests (Phase 7) only create queue items; nothing a member does starts a sandbox or an assistant. | `apps/server/test` ("the Studio is for Architects only") |
| C2 | "Connect" runs the vendor's official installer (`claude.ai/install.sh`, `chatgpt.com/codex/install.sh`) at the version this release was tested with (`packages/shared/src/vendor-clis.ts`), inside the Architect's own container. The installers verify their downloads against the vendor's checksums. The installed program's SHA-256 is recorded, and it's checked again whenever the app starts it: when a sandbox starts, and just before **Start**, **Carry on** and **Sign in** start the assistant in the terminal. A changed program isn't started. Each assistant's program lives in the Architect's tools volume, which only the connect container (where the Architect installs) can write: in a sandbox it's read-only, so nothing there can change it between its check and its start. (Codex's installer keeps its program and helpers under `CODEX_HOME`, its sign-in folder, so it's run with `CODEX_HOME` pointed into the tools volume; a program found anywhere but the tools volume, such as an earlier Codex install, counts as not installed until it's installed again; an upgrade clears the checksums recorded for those, so **Assistants** asks for Codex to be installed again rather than showing it connected.) The installers run with the system's folders first on their `PATH` and the tools folder last, as one run by the Architect would. The checksum, like every command the supervisor runs in a container, is computed by programs from the read-only root filesystem with only system folders on their `PATH`, never from the Architect's writable `~/.local/bin` (where a planted `sha256sum` could report a false one); and on the containers' own `PATH` that folder comes last, so nothing planted there runs in place of a system program. Nothing is patched or wrapped; sign-in is the assistant's own. | `apps/supervisor/test/policy.test.ts` (including "runs its own commands from the read-only root", "puts the system's programs before the Architect's tools volume on PATH", "lets only the connect container write the Architect's tools"), `apps/server/test` ("starts only an assistant the Architect installed, exactly as installed") |
| C3 | No vendor program is in this repository or any image; the workbench image contains neither assistant. | Image contents; `images/workbench/Dockerfile` |
| C4 | Sign-ins live in a volume per Architect and assistant, mounted only into that Architect's own sandbox and connect containers, for that assistant — never into previews, checks, helpers or platform services. The supervisor checks whether a sign-in exists without reading it. A workspace's conversations with the assistant (Claude Code's `projects`, Codex's `sessions` and `memories`, and Codex's state databases via `CODEX_SQLITE_HOME`) are in volumes of its own, mounted over those folders of the sign-in volume in its sandbox only, and removed with it: carrying on in one workspace never picks up another's conversation. Defaults are written only to the workspace (`.claude/settings.json`, command-line flags). Backups exclude these volumes. In an awake sandbox, where the assistant runs beside the sign-in, the supervisor runs only a few fixed commands on the workspace folder (`/workspace`): listing `uploads/` and the changed files, adding a file the Architect uploads, the checks (`ats qa`) and `ats space overlay`/`ats space check`. None of them reads the sign-in, and none takes a command from a caller. Everything else the Studio reads is read in the workspace's reader, a container that has the workspace volume and nothing else (read-only, no network), kept until a minute idle: a link in the workspace can't reach a sign-in. That's both a file an Architect opens to look at (**Files**) and the files the Studio itself reads (the plan, the assistant's instructions, its pictures and models); the files it writes (the plan, the instructions) are written in a short-lived helper, as is the checkpoint it commits when the workspace goes to sleep (once the sandbox is gone; its git hooks don't run). A file shown in **Files** must be a plain file whose real path is in the workspace. The Studio's own files are opened folder by folder without following any link, by a fixed program on the read-only root filesystem (each name is looked at without following it, and what was opened must be that same file: gVisor follows a link to a folder even when asked not to), and a write replaces a link rather than writing through it. | `apps/supervisor/test/policy.test.ts` (including "shows a file only from the reader, with the workspace and nothing else", "reads and writes workspace files without following a link" , "reads and writes a workspace's files only where no sign-in is mounted" and "keeps each workspace's conversations its own, though the sign-in is shared" and "saves a checkpoint when a workspace goes to sleep, where nothing else runs"), `apps/supervisor/test/docker.integration.test.ts` |
| C5 | Terminal bytes pass straight through the server and the supervisor: never logged, stored or inspected. Only "opened" and "closed" are recorded. In the Architect's own browser, the visible screen is checked for the assistant's sign-in link (its maker's sign-in hosts only: claude.com, claude.ai, platform.claude.com, console.anthropic.com, auth.openai.com, chatgpt.com) to offer an "Open the sign-in page" button; nothing is kept or sent (`apps/web/src/lib/sign-in-link.ts`). | Code review (`routes/workspaces.ts`, `supervisor/src/server.ts`) |
| C6 | The app has no field for passwords, keys or codes: sign-in happens in the terminal, in the assistant's own flow. | Code review (`routes/Assistants.tsx`) |
| C7 | Sandboxes sit on an internal network with no route out and no DNS. Their only way out is the egress proxy: HTTPS `CONNECT` to allow-listed host names, no TLS interception, private addresses refused. A group may choose open internet: its workspaces' proxy passes (signed with a secret only the supervisor and the proxy hold) let them reach any public host name, still HTTPS `CONNECT` only, no TLS interception, private addresses refused. | `apps/egress/test`, `apps/supervisor/test/docker.integration.test.ts` |
| C8 | The model and effort chosen for a workspace (or the group's defaults) are given as the assistant's own command-line options when the Architect starts it: `--model` and `--effort` (Claude Code), `-c model=` and `-c model_reasoning_effort=` (Codex). Only names that look like model names, and effort levels that assistant has, are ever passed (`packages/shared/src/assistants.ts`). Codex also gets `-c check_for_update_on_startup=false`, and `-c analytics.enabled=false` unless the group has turned telemetry on. Each workspace's `.claude/settings.json` lets Claude Code run `pnpm`, `ats`, `git`, `node`, `ls` and `cat` without asking, and sets `DISABLE_AUTOUPDATER` (the Architect updates from **AI assistants**, to the version this release was tested with) and, unless telemetry is on, `DISABLE_TELEMETRY` and `DISABLE_ERROR_REPORTING`. The workspace's `CLAUDE.md` and `AGENTS.md` are the platform's instructions for building a creation. Nothing is written to the Architect's own configuration. Idle and session time limits are enforced by the server, which puts workspaces to sleep (the session limit once the Architect has stepped away). | `apps/server/test` ("puts a workspace to sleep", "starts the assistant with the model and effort chosen for it"), `packages/shared/test/assistants.test.ts` |
| C9 | Suggested prompts are typed into the terminal and never sent: the Architect presses Enter. Their control characters are removed first, so a prompt can't carry Enter itself. The app starts only two fixed commands (start the assistant, carry on), and the assistant's own sign-in, and never by typing them: each is started as the terminal's own program (tmux `respawn-pane`), its command line rather than keystrokes, so it can't reach a running assistant as a message even if code in the sandbox fakes what the terminal reports (a renamed process, a replaced tmux server). It's only started from a shell prompt, so a running assistant isn't replaced by mistake, and the Architect's shell comes back when it ends. The app never presses Enter in the terminal. The checks run outside the terminal. Files the Architect adds have their paths pasted the same way (a bracketed paste with every control character removed, so it can't carry Enter). | `apps/server/test` ("types suggested prompts without sending them", "adds any file to a creation’s workspace"), `apps/supervisor/test/policy.test.ts` ("types a suggested prompt as text only", "starts the assistant as the terminal's program, never by typing it"), `apps/supervisor/test/docker.integration.test.ts` |

## Code running in a sandbox

A sandbox runs the assistant and whatever code it writes, as the same user, so anything in it can
be changed by that code: its files, its processes, and its terminal session (tmux). The rules above
are kept by never trusting what a sandbox says where it matters:

- **What it can't do.** Reach a sign-in through a link (files the Studio reads are opened without
  following links, or by a helper that has only the workspace: C4). Make the platform start a
  changed assistant (its checksum is computed by system programs and checked before every start,
  and the Architect's tools volume, where it lives, is read-only in sandboxes: C2). Change what
  another of the Architect's workspaces runs (each has its own package store, not a shared one). Turn **Start**, **Carry on** or **Sign in** into a message to the assistant (they're started
  as the terminal's program, never typed: C9). Run a planted program in place of a system one, in
  the supervisor's commands or the Architect's own (system folders come first on `PATH`).
- **What it can do, and why that's accepted.** It can replace the terminal's tmux server, so it can
  show the Architect a different screen, take what they type there, or ignore scrolling. It can
  keep a workspace from going to sleep for being idle (any program can, by printing), but not past
  the group's session limit once the Architect has stepped away, which the server enforces itself:
  only the Architect, signed in to the app, can say they're still there (a sandbox never holds
  their sign-in to the app). These only let the Architect's own
  sandbox mislead or overwork itself: it already holds that Architect's sign-in, it can't reach
  anyone else's, and nothing it says is taken as the Architect's words. The terminal the Architect
  signs in through is a separate container whose home folder starts empty each time, and the only
  thing it shares with sandboxes, the tools volume, is read-only to them. Installing for yourself
  (`pip install --user`, `pnpm add -g`) isn't possible in a workspace; a project's own packages
  and virtual environments are. Both assistants were run this way: Claude Code (2.1) writes only
  a lock file there, which goes to the scratch home instead (`XDG_STATE_HOME`); Codex (0.159)
  writes only to its own `CODEX_HOME` (its sign-in and sessions; its program is installed into the
  tools volume). Started as the terminal's program, each carries its name
  while it runs (read from the terminal's processes, not from tmux, which can't see them under
  gVisor), so it isn't started over; it gets its flags as typed, and gives the shell back when it
  ends, with a line pointing to its output when it failed.

## API-key mode (Phase 9)

| # | How | Checked by |
|---|---|---|
| C10 | Off unless whoever runs the server sets `ATS_API_KEY_MODE=on` and keys in `api-keys.env`, a file only the supervisor reads (no other service, and no part of the app, sees the keys; C6 holds: there's still no field for them). The supervisor adds the key to that assistant's sandboxes as the variable its maker documents; a caller can never set or replace it. The assistant is still the vendor's own program, installed by the Architect (C2). | `apps/supervisor/test/policy.test.ts` ("gives sandboxes the server's own API key only in API-key mode") |

## Requests (Phase 7)

| # | How | Checked by |
|---|---|---|
| C1 | Asking for something only writes the request (and tells the Architects). No sandbox is started, no assistant is asked anything, and nothing is built. Only an Architect can make a workspace from a request, and making one only writes its files. | `apps/server/test` ("only writes it down and tells the Architects", "lets an Architect accept it, and start a workspace that carries it") |
| C9 | A request's words go into the workspace's `BRIEF.md` for the assistant to read when the Architect asks it to; they're never typed into the terminal or sent as a prompt. A request's status follows the Architect's builds; it never starts one. | Same tests, plus the Phase 5 checks above |

## Status

- Phase 0: C3 ✓. Spike S1 confirmed both official installers run unmodified inside a gVisor
  sandbox ([spikes](spikes/phase-0.md)).
- Phase 5: C1, C2, C4–C9 are built and tested as above. Installing Claude Code through the Studio
  was checked end to end; signing in (which needs a real subscription) is the Architect's step.
- Phase 7: C1 and C9 re-checked for requests, as above.
- Phase 9: C10 ✓ (API-key mode is separate and off by default, as above).
- Not confirmed by the vendors: neither Anthropic nor OpenAI has reviewed this setup.

## Vendor terms

Whoever runs a server is responsible for using Claude Code and Codex in line with their makers'
terms, which can change. What they said when this was last checked (2026-10-10):

- **Anthropic** ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)):
  running Claude Code in products or services, such as hosted sandboxes, needs Anthropic's
  Commercial Terms, with Claude Code installed and run as published, none of its sign-in methods
  removed, and each user signing in with their own subscription or key, billed to them. The same
  page says this doesn't prevent someone signing in to the unmodified Claude Code with their own
  subscription where a platform hosts it. The Studio is built that way (C2, C4–C6, C9). Whether the
  Commercial Terms apply to you as the person running a server is between you and Anthropic.
- **Advertised Pro and Max limits assume ordinary, individual use** (same page). An Architect
  starts every turn (C9); a turn they started keeps running after they step away, until the
  group's idle or session limit puts the workspace to sleep (C8).
- **API-key mode** (C10) bills one key for every Architect on the server. Anthropic's page allows a
  key used by the key owner's own authorized users, billed to that owner, and not resold: turn it
  on only for your own group, and never charge others for it.
- **OpenAI** ([Codex authentication](https://learn.chatgpt.com/docs/auth)) documents
  `codex login --device-auth` for signing in on a remote machine, which is how the Studio signs in.
- **Names.** Say in plain text that All the Spaces works with or runs Claude Code or Codex; don't
  use their names or logos as part of your own product's name or logo, or in a way that suggests
  their makers built or endorse it.
