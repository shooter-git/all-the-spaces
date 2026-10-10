# 5. gVisor for sandboxes by default

Status: accepted, 2026-09-29

## Context

An Architect's AI assistant writes and runs code, and installs packages, in their workspace. That
code is untrusted ([security.md](../security.md#principles)). Docker's standard runtime runs a
container's programs straight on the server's kernel; gVisor (`runsc`) answers their system calls
with a kernel of its own, so they never reach the server's directly. Spike S1 confirmed that the
official Claude Code and Codex installers run unmodified inside it, with network access and nothing
written to the host ([phase-0.md](../spikes/phase-0.md#s1--official-ai-clis-inside-gvisor)).

## Decision

In production, every container the supervisor starts (sandbox, connect, live preview and the
publishing checks) runs under gVisor. The runtime is `ATS_SANDBOX_RUNTIME`, `runsc` unless set
otherwise ([`apps/supervisor/src/main.ts`](../../apps/supervisor/src/main.ts),
[`deploy/compose/compose.yml`](../../deploy/compose/compose.yml)). The installer installs gVisor
from its signed apt repository and registers it with Docker
([`deploy/install/install.sh`](../../deploy/install/install.sh)).

## Consequences

- `install.sh --no-gvisor` skips it, and the containers fall back to Docker's standard runtime
  (`runc`): fine for trying things out, not recommended for groups
  ([self-hosting.md](../self-hosting.md#the-studio-building-creations-with-an-ai-assistant)). The
  installer test (`deploy/install/test/run.sh`) installs this way.
- Development machines use `runc`: registering `runsc` changes the Docker daemon's configuration,
  which is never done automatically ([development.md](../development.md#the-studio)).
- File changes made outside a container aren't seen by inotify under gVisor, so the live preview
  mounts the workspace as a volume and Vite polls for changes (spike S2).
- Sandbox homes must not live in `/tmp`, where Codex refuses to set itself up (spike S1).
