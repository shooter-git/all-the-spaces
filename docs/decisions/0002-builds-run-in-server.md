# 2. Builds run in `server`, not `worker`

Status: accepted, 2026-09-30

## Context

The Phase 0 architecture planned a `worker` for background jobs and separate `builder` and
`qa-runner` containers for building and checking creations. When publishing arrived (Phase 4) and
the Studio after it (Phase 5), the untrusted steps went into short-lived check containers that the
supervisor starts from the workbench image ([security.md](../security.md#the-studio-architects-ai-assistants)).
What was left for the build job itself is orchestration: fetch the source snapshot, ask the
supervisor to check it, store the report and the version, and tell people.

## Decision

Builds are queued and run by the `server` process.

- Creations: a BullMQ queue (`creation-builds`) with its consumer in the server, one build at a
  time, which survives a restart
  ([`apps/server/src/creations/builds.ts`](../../apps/server/src/creations/builds.ts)).
- Places: an in-process queue in the server, one build at a time, because each uses every core
  while baking ([`apps/server/src/spaces.ts`](../../apps/server/src/spaces.ts)).

The build job needs what the server already holds: the supervisor's address and shared secret, the
storage client, and the notifier that reaches people live over the server's own WebSocket (a
request follows its builds). The worker is configured with only the database and Valkey
([`packages/shared/src/env.ts`](../../packages/shared/src/env.ts)).

## Consequences

- The `worker` stays small: a heartbeat and the daily clean-up of old chat and performance samples.
- In production the server image carries no browser: playing a creation for the checks happens in
  the workbench. In development, with no supervisor, the server runs the checks itself, loading
  `@ats/qa-browser` (a dev dependency) only when it does.
- Building a place runs `@ats/space-builder` inside the server process, so a big place takes CPU
  from the same process that serves the API. (Its lighting bakes, the heavy part, run in the
  workbench since [0009](0009-lighting-bakes-in-the-workbench.md).)
- A creation build that was running when the server stopped is picked up again by the queue; a
  place build is recorded in the database and shows as interrupted.
- Moving builds to the worker later would mean giving it the supervisor, storage and notification
  settings, and a way to reach the live hub.
