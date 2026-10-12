# Decisions

Why the big choices are what they are. [architecture.md](../architecture.md) says how things work;
these say why, and what follows from it. Each record is short: the context, the decision and its
consequences.

| # | Decision | Since |
|---|---|---|
| [0001](0001-no-server-gpu.md) | No GPU on the server | 2026-09-29 |
| [0002](0002-builds-run-in-server.md) | Builds run in `server`, not `worker` | 2026-09-30 |
| [0003](0003-type-stripping-no-build-step.md) | Node runs TypeScript directly: no build step for services | 2026-09-29 |
| [0004](0004-shard-per-30-members.md) | One live presence shard per 30 members | 2026-10-01 |
| [0005](0005-gvisor-by-default.md) | gVisor for sandboxes by default | 2026-09-29 |
| [0006](0006-agpl-core-mit-sdk.md) | AGPL for the platform, MIT for what creations are built with | 2026-09-29 |
| [0007](0007-creation-logic-only-in-browsers.md) | Creation logic runs only in browsers | 2026-09-29 |
| [0008](0008-blender-in-the-workbench.md) | Blender in the workbench | 2026-10-02 |
| [0009](0009-lighting-bakes-in-the-workbench.md) | Lighting bakes run in the workbench | 2026-10-04 |
| [0010](0010-operator-installed-connectors.md) | Operator-installed connectors (amends 0007) | 2026-10-04 |
| [0011](0011-creations-from-repositories.md) | Creations from repositories (being built) | 2026-10-06 |
| [0012](0012-any-public-repository.md) | Any public repository, as the owner's choice (amends 0011) | 2026-10-11 |

The early experiments behind some of these are in [spikes/phase-0.md](../spikes/phase-0.md), kept
as they were written.

## Adding or changing one

Add a new record for a new decision, numbered after the last, with `Status: accepted` and the
date. Don't rewrite history: when a decision is replaced, write a new record and change the old
one's status to `superseded by NNNN`.
