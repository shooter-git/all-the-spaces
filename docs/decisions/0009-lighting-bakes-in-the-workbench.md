# 9. Lighting bakes run in the workbench

Status: accepted, 2026-10-04

## Context

Builds run in the server ([0002](0002-builds-run-in-server.md)), and a place's lighting is baked by
Blender running the space builder's `bake_room.py`. Blender is in the workbench image only
([0008](0008-blender-in-the-workbench.md)); the app image has none. So on an installed server
every place was published with real-time lighting only, and nothing said so: the builder quietly
skipped the bake when it found no Blender.

Three ways out were weighed:

1. **Bake in the workbench, as a supervisor job**, the way creations are already checked.
2. **Install Blender in the app image.** Simple, but it adds about 1 GB and a GPL program to the
   image that serves the API, needs a higher memory limit for the server, and runs Blender (on
   geometry from Architects' models) inside the process that holds the database and storage
   credentials.
3. **Accept unbaked lighting** for places the server builds, and say so. Every real place would
   look flatter than the samples on a developer's machine.

## Decision

Option 1. While the server builds a place it asks the supervisor for a bake job
([`apps/server/src/lighting.ts`](../../apps/server/src/lighting.ts)): the sky goes in once, then
each indoor room's bake input. For each room the supervisor starts a container from a
fixed template ([`apps/supervisor/src/sandboxes/bake.ts`](../../apps/supervisor/src/sandboxes/bake.ts)):
the workbench image's Blender running the image's `bake_room.py`, no network, the input volume
read-only, one output volume to write, sealed and limited like every other container (its own
`ATS_BAKE_CPUS`, the workbench's `ATS_SANDBOX_MEMORY_MB`, gVisor in production), and stopped
from inside after 30 minutes. The server waits for it in short calls, reads back the lightmap and
its UVs, and encodes them exactly as a local bake would. Same script, same resolution and samples
(`ATS_BAKE_RES`, `ATS_BAKE_SAMPLES`), same outputs. Several rooms bake at once (see Throughput,
below).

The time limit is per room. The heaviest sample room (the two-floor building's café, 380,000
furniture triangles) took 8 minutes at the default 1024 pixels and 128 samples on 2 CPUs, peaking at
840 MB; a tall-building room took 7 minutes and 600 MB (both measured on a busy 8-core machine). 30
minutes leaves about four times that; the workbench's default 4 GB leaves about five times the
memory.

Without a supervisor (a development server), the server bakes with Blender on its own machine if
it has one, as before. Each room's bake is kept under a hash of everything that goes into it, so a
rebuild bakes only the rooms that changed.

A bake that can't happen doesn't stop the build: the room uses real-time lighting, the place is
built and published, and the version records why ("no supervisor and no Blender", "the bake job
failed: …", "timed out after 30 minutes"). The Studio shows "Lighting baked" or "Lighting not
baked" with that reason.

## Consequences

- The server stays free of GPL binaries and of Blender's memory use; the supervisor gains one more
  fixed template, checked by its policy test like the others.
- First builds of big places are slow even so (Throughput, below); rebuilds bake only the rooms
  that changed.
- The job runs the workbench image's copy of `bake_room.py`, from the same release as the server.
  A developer who changes it rebuilds the workbench image to see the change through the supervisor.
- The workbench's Blender is Ubuntu's (4.0), a developer's may be older, so `bake_room.py` runs on
  3.4 and later. Bakes of the same room on both look alike but aren't byte-identical; the kept bakes
  are only ever reused for the same place on the same server.
- A server that stops mid-build leaves its bake job behind; the Studio's timers clear any bake
  container older than two hours, with its volumes (a live job's container is never older than
  about 31 minutes).
- A room's bake input can be tens of megabytes (detailed furniture, as triangles); it travels to
  the supervisor in the request body, within its existing size limit.

## Throughput (2026-10-04)

At first rooms baked one at a time, with the workbench's 2 CPUs: about 8 minutes a room at full
settings, so the first build of a three-room flat took about 25 minutes and the 240-room
tall-building sample (for load tests only) about 30 hours. Three ways to speed this up were weighed:
baking rooms in parallel (they are independent), giving bakes more CPUs than sandboxes, and lowering
samples or resolution for big places. The last changes how places look, so it was ruled out: bake
quality stays exactly as it is (same script, resolution and samples).

Decision: the first two.

- **Rooms bake in parallel.** A build's job bakes its rooms in numbered slots, each with its own
  container and output volume (one input volume holds the sky and each slot's room). The server
  keeps as many rooms baking as the supervisor has places for (`bake.slots`). The space builder
  still puts rooms together and writes their chunks one at a time; only the bakes overlap, with
  at most twice as many rooms in memory as are baking. A room's chunks don't depend on any other
  room's, so the order bakes finish in doesn't change the place.
- **The supervisor holds every build to a cap**, `ATS_BAKE_PARALLEL`, by default
  max(1, floor(host CPUs / `ATS_BAKE_CPUS`)), counting Docker's CPUs rather than its own
  container's. A room asked for beyond the cap is told the supervisor is busy, and the server asks
  again 15 seconds later; bakes are started one at a time, so two requests can't both take the last
  place. A big place can't start a container per room.
- **Bakes have their own CPU limit**, `ATS_BAKE_CPUS` (2 by default, as before), separate from
  sandboxes' `ATS_SANDBOX_CPUS`.
- The per-room time limit stays at 30 minutes. A room that fails or times out costs only that room.
- The Studio shows progress while a build bakes ("Baking lighting: room 4 of 12, about 30 minutes
  left"), estimated from the time each room's bake records, the rooms left, and how many bake at
  once.
- A build that stops mid-way stops starting rooms, lets starts already under way finish, then
  removes every container and volume of its job, in every slot. The Studio's timers clear a job
  left behind by a server that stopped (once per job, however many slots it used).

Measured on the development machine (8 CPUs, so 4 rooms at once, with other projects running), at
`ATS_BAKE_RES=256` and `ATS_BAKE_SAMPLES=16` to keep the runs short, first builds with no kept
bakes, through the real supervisor and Docker:

| Sample | Rooms baked | One at a time | In parallel |
|---|---|---|---|
| studio-apartment | 3 | 58 s | 36 s |
| two-floor-building | 7 | 145 s | 66 s |

At these settings a room's Blender run takes only 6 to 9 seconds, so starting containers and moving
inputs is a large share of the time. At full settings, where each room takes minutes, the gain
approaches the number of rooms baking at once (see the estimates in
[self-hosting.md](../self-hosting.md#how-long-building-a-place-takes)). Each room's own bake took a
little longer side by side (Blender's time over all rooms rose from 48 to 61 seconds for the
two-floor building), because the rooms share the machine.

Consequences:

- By default bakes can use every CPU while a place builds, so other work on the server slows down
  meanwhile. `ATS_BAKE_PARALLEL=1` trades speed for that.
- Memory: up to `ATS_BAKE_PARALLEL` × `ATS_SANDBOX_MEMORY_MB` (4 GB each) while bakes run; the
  heaviest sample room used 840 MB. On the minimum 4-CPU, 16 GB server that's two bakes.
