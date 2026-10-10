# 1. No GPU on the server

Status: accepted, 2026-09-29

## Context

All the Spaces is meant to run on one ordinary self-hosted server, with no paid services
([CONTRIBUTING.md](../../CONTRIBUTING.md)). The people using it already have a GPU in their phone,
tablet or computer, and phones are first-class clients. A server GPU would rule out most of the
machines people can rent or already own.

## Decision

The server never needs a GPU. 3D rendering happens on each person's own device, and spaces are
built as optimised 3D models rather than scanned captures ([architecture.md](../architecture.md)).
Everything the server does to 3D content runs on the CPU, including lighting bakes: spike S3
measured under a minute per room at 1024² on four 2014-era cores, so CPU baking was kept and the
browser-GPU baking fallback was dropped ([phase-0.md](../spikes/phase-0.md#s3--cpu-only-lighting-bake-time-per-room)).

## Consequences

- [self-hosting.md](../self-hosting.md) asks for CPUs, memory and disk, and says no GPU is needed.
- Everything has to run well on the least capable devices it targets: spaces and creations have
  budgets per device tier, the 3D view lowers its resolution when frames are slow
  (`ResolutionGovernor`), and phones keep only one 3D context alive at a time.
- Bakes take time on big places (roughly three hours for 300 rooms on four cores, by the spike's
  numbers), so place builds run in the background, one at a time, each room baked on its own.
- The checks play creations in headless Chromium with SwiftShader, so they work without a GPU
  ([development.md](../development.md)). WebGL2 stays the default; WebGPU is opt-in.
- Blender in workspaces is CPU-only too ([0008](0008-blender-in-the-workbench.md)).
