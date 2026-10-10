# 6. AGPL for the platform, MIT for what creations are built with

Status: accepted, 2026-09-29

## Context

The platform is meant to be run by anyone on their own server, including as a hosted service for
others. Creations, on the other hand, belong to whoever made them: they bundle the SDK, start from
the starter, and are written by an assistant following the agent instructions. A copyleft licence
on those parts would reach into every creation.

## Decision

Two licences ([licensing.md](../licensing.md)):

- **AGPL-3.0-only** for the platform: `apps/*` and most of `packages/*` ([LICENSE](../../LICENSE)).
  It keeps improvements to hosted versions open.
- **MIT** for the Portal SDK (`@allthespaces/portal`), the bridge protocol, the `ats` CLI, the
  starter, the examples and the agent instructions, each with its own `LICENSE`. Creations built
  on them are never encumbered.

## Consequences

- Code that ends up in a creation or a workspace must come from an MIT part. When the Blender
  helpers that Architects' model scripts import turned out to be AGPL, they moved into their own
  MIT folder, while the bake and render scripts beside them stay AGPL
  (`packages/space-builder/blender/helpers/`).
- The MIT packages import nothing AGPL: the SDK depends only on the bridge protocol, and the `ats`
  CLI runs the platform's checks and space tools as separate programs.
- Packages bundled into a creation must be permissively licensed, checked at every build;
  dependencies of the platform are checked in CI (`tools/check-licenses.mjs`).
- Copyleft programs the platform uses (Garage, Blender) run unmodified as separate processes, and
  LGPL libraries (libvips, libheif) unmodified as reviewed exceptions.
- The MIT packages aren't on npm yet: they're marked private and reach creations through the
  platform itself (see [CONTRIBUTING.md](../../CONTRIBUTING.md#versioning)).
