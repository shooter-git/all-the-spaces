# 8. Blender in the workbench

Status: accepted, 2026-10-02

## Context

Furniture built from a plan alone is a simple shape. To make a place, or a creation, look like the
real thing, the Architect's assistant needs to make 3D models: something it can drive with a
script, on a CPU, that writes glTF. Blender does that headless, and the platform already used it
for lighting bakes. It is GPL-licensed, so it has to stay a separate, unmodified program.

## Decision

The workbench image ([`images/workbench/Dockerfile`](../../images/workbench/Dockerfile)), which
every sandbox runs, installs Ubuntu's own `blender` package, unmodified and CPU-only. The assistant
writes a Blender script and runs `ats model build`, which checks the model and draws it from four
sides; `ats space render <room>` draws a room from its corners. Scripts import small MIT helpers
(`packages/space-builder/blender/helpers/ats_model.py`), so a model script stays the Architect's
own ([0006](0006-agpl-core-mit-sdk.md)).

## Consequences

- Its corresponding source is Ubuntu's `blender` source package, and what people make with it
  isn't covered by its licence ([licensing.md](../licensing.md)).
- The workbench image is larger, and the same image also runs previews and checks.
- Models made in a workspace are untrusted files. When a place is built, each one is read and
  rewritten as plain data (meshes, materials, re-encoded textures), with size and detail limits.
- Blender can use a lot of memory, so workspace Blender jobs run one at a time, and Blender marks
  itself first to be stopped if memory runs out, never the assistant.
- The app image has no Blender. The server bakes a place's lighting only where Blender is
  available to it (`ATS_BLENDER`, or `blender` on the `PATH`); otherwise rooms use real-time
  lighting ([development.md](../development.md#sample-spaces-and-baked-lighting)). Since
  [0009](0009-lighting-bakes-in-the-workbench.md), installed servers bake in the workbench instead.
