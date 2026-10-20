# Architecture

All the Spaces runs on a single server with Docker Compose. There is no GPU on the server: 3D
rendering happens on each person's own device, and spaces are built as optimised 3D models rather
than scanned captures.

Why the big choices are what they are is in the [decision records](decisions/README.md).

## Services

| Service | Role |
|---|---|
| `caddy` | HTTPS, serves the web app, routes `app.<domain>` and `play.<domain>` |
| `server` | Accounts (Better Auth), groups, invites, setup wizard, API, the Studio, publishing (builds queue here) |
| `realtime` | Colyseus: live presence in the space and multiplayer sessions inside creations |
| `worker` | Background jobs (BullMQ on Valkey) |
| `postgres` | All structured data |
| `valkey` | Job queues, real-time presence, pub/sub |
| `garage` | Built-in S3-compatible file storage (swappable for any S3 service) |
| `supervisor` | The only service with access to Docker: starts sandboxes, previews, check containers and lighting bakes from fixed templates |
| `egress` | The only way out of a sandbox: HTTPS to allow-listed hosts |
| `livekit` | Voice chat (LiveKit): signalling through Caddy (`/lk`), audio on its own two ports |

Started on demand by the supervisor, from the **workbench** image: an Architect's **sandbox** (one
per workspace, with their AI assistant), its **live preview**, and the short-lived containers that
**check** a creation before it's published and **bake** a place's lighting while it's built. See
[security.md](security.md#the-studio-architects-ai-assistants).

The data services sit on an internal network with no route to the internet. Only `caddy` (and
`livekit`'s audio ports) are exposed.

## Live presence at scale

Each person only receives the people in their own room and the rooms next to it (through doors
and stairwells; a lift isn't a window onto every floor). Who-sees-whom is updated as things
happen (someone changes room, privacy changes, people arrive or leave), each change looking only
at the rooms involved. A big group's space is split into several live rooms (shards, one per 30
members; the server assigns each person a shard by a stable hash, in their real-time pass): each
sends updates only to its own people, and the shards share everyone's positions through Valkey 20
times a second, so there are no boundaries. An update with nothing in it isn't sent. Measured with
`pnpm --filter @ats/realtime load-test 150 tall-building` (152 people wandering a 20-floor,
240-room building): updates take 3–4 ms at the 99th percentile, who-sees-whom 0.5 ms, under 40%
of one core.

Each app sends where its person is 20 times a second (the server's rate), from the frame loop,
with the time it was taken on its own clock (ms since joining; the server only lets it go
forward). Other people are drawn on that clock, not on when updates happen to arrive: about
100 ms behind plus however unevenly their updates have been arriving, smoothed between updates,
carried on for at most 180 ms when updates run late and eased back after; a jump (quick travel, a
lift) is drawn at once. An app that sends no time still works, drawn on arrival times as before.

## Visits

The real-time service knows who is in which room and creation session, so it records visits:
time someone spent in a room of a place (once they've stayed 10 seconds; passing through goes to
the room they came from) or in a creation, paused while their app is out of sight. Like the rest of
the service it never touches the database: it posts batches to the server's internal
`/internal/visits` every 10 seconds, with ids it chose (sending a batch again changes nothing),
and once a minute names every visit still going. A visit nobody has vouched for in three minutes
(its real-time service stopped or restarted) ends when it was last seen; a stopping service ends
its own. Visits are spans only, never positions; they're kept 90 days (worker) and summed up for
Architects (`GET /api/spaces/:id/visits`), counting overlapping time once per person.

## Voice chat

LiveKit (unmodified) carries the sound. The real-time service hands out passes, because it knows
where everyone is: a pass is for the room you're in (`space:<space>:<room>`) or your creation
session (`session:<id>`), only if you may hear it, for ten minutes. It takes you out of a voice room
when you leave the room, when privacy changes, or when the group turns voice off. In the space,
each voice comes from where that person stands (Web Audio panning, with the space's own listener);
in a creation it's simply heard. While someone talks, the space's sounds dip, and the app tells
the creation (`duck` over the bridge) so the SDK lowers its music, effects and ambience.

## Smoothness

The 3D view in the space and in creations (the SDK's `createStage`) draws fewer pixels while
frames take too long and more once they're quick again (`ResolutionGovernor`, a second at a time,
waiting longer before going up each time going up didn't last). Devices whose owners share it send
how smoothly things ran once a minute (anonymous, kept 90 days): the server uses them to start each
kind of device at a quality that has run smoothly on it (`/api/perf/advice`), and shows Architects
how their place and each creation run on phones, tablets and computers.

## The Studio

Architects build creations in **workspaces**: the creation's source (starting from a blank starter,
the SDK and instructions for the assistant), a terminal where they work with their own Claude Code
or Codex, and a live preview that rebuilds as files change. The assistant can run the same checks
publishing uses (`ats qa`) and fetch free assets (`ats assets`). When the Architect publishes, the
supervisor copies the source out, and it goes through the publishing checks below. The Architect
starts every AI turn; the app never sends a prompt ([compliance.md](compliance.md)).

## Onboarding a real place

A place is described by a **plan** (`packages/space-format/src/plan.ts`): rectangular rooms on
floors, the doors and openings between them, windows, furniture and where people arrive. The
platform turns a plan into the 3D space (walls, lighting, levels of detail, the privacy-filtered
manifest) with `@ats/space-builder`.

To add their own place, an Architect gives floor plans, photos and a description (re-encoded on
upload, private to Architects). A **space workspace** holds them with an empty plan; their AI
assistant writes `plan.json`, calibrating against the floor plan (`ats space scale`, `origin`),
checking it (`ats space check`: fits, doors on shared walls, everything reachable) and drawing it
over the drawing (`ats space overlay`). The Architect sees the overlay live in the Studio and can
drag walls into place. **Build it** turns the plan into a *candidate* version they can walk through;
**Publish** makes it live, with every room private until they share it.

A plan can have **several floors** (each with its own elevation and height), stairwells (a room on
one floor that `spansTo` the next, with a flight that `ats space check` makes sure fits and isn't
too steep), lifts (stops in a room on each floor) and **outdoor** rooms (no ceiling, sky lighting).
Each floor has its own drawing: `trace.json` holds a calibration per floor, and `ats space overlay`
draws `preview/overlay-<floor>.png` for each.

**Lighting is baked as part of every build**, with nobody asked or waiting. Each indoor room is
baked on its own with its doors closed (daylight from the sky through the windows, soft ceiling
lights, furniture casting shadows), by Blender running the space builder's `bake_room.py`. The app
image has no Blender, so on an installed server the server asks the supervisor to bake each room in
a short-lived container from the workbench image: no network, the room's input and the sky
read-only, one folder to write, the workbench's CPU and memory limits, and 30 minutes per room
([0009](decisions/0009-lighting-bakes-in-the-workbench.md)). A development server with no
supervisor bakes with Blender on its own machine, if it has one. A room that can't be baked (no
supervisor and no Blender, or the job failed or ran out of time) uses real-time lighting: the
place is still built and published, and its version records why. The Studio shows "Lighting
baked" or "Lighting not baked" with the reason under the version.

**Changing a live place** reopens a space workspace seeded with the live version's plan (stored on
each `space_versions` row). Rooms are built and lit independently, with doors closed, and every file
is content-hashed. Each room's bake is kept beside the place's files (`spaces/<id>/bakes/`, never
served, deleted with the place) under a hash of everything that goes into it: its surfaces,
furniture and doorways, its lights, the sky, the bake settings and the bake script. A rebuild bakes
only the rooms whose inputs changed and reuses the rest, so a room whose plan didn't change comes out
byte-identical (moving one desk bakes only that room again). The review compares the candidate to the live
version by room fingerprint (`apps/server/src/space-updates.ts`) and lists the creations whose
object is gone. Publishing is refused until each one has a new object or goes to the **shelf**
(`creations.object_key = null`; saved data is untouched). Every publish records where each creation
was on the version it replaces (`space_versions.placements`), so going back to a version puts
creations back. Open requests about removed objects stay open with a note. Live clients are told to
reload the manifest straight away.

There is no separate mesh fallback for rooms without photos: photos are only reference for the
assistant (colours, materials), so every room is built from the plan in the same way.

## Requests and notifications

A member asks for something from inside a space: they draw a box on screen, the viewer casts rays
through it to find the objects it caught, and they say which one they meant (or ask for a new
object in the room). Asking writes a **request** (`commissions`: what, where, their words and
pictures, a status) and tells the Architects; nothing else happens. An Architect accepts or
declines it, and can start a workspace from it: the brief, the member's words, pictures and documents (in
`request/`) go into the workspace. From then on the request follows the workspace's builds
(`builds.workspace_id`): being built, nearly ready (a candidate passed), ready to try (live).
Every step is recorded (`commission_events`) and shown to the member.

Notifications are rows per person, sent live over the same WebSocket as chat. People who aren't in
the app right now get them by Web Push (the server signs with its own VAPID key pair) or by email
(`SMTP_URL`), unless Do Not Disturb is on.

## Creations are cartridges

A creation is a static web bundle ("cartridge") stored in object storage. Each publish makes a new
immutable version; people already inside finish on the version they started. It is played in each
person's browser inside a sandboxed frame on a separate origin (`play.<domain>`), with no network
access of its own. See [security.md](security.md#creations).

- **The bridge.** Identity, multiplayer and saving go through a typed `postMessage` bridge to the
  app ([`bridge-protocol`](../packages/bridge-protocol/README.md)). Creations use the
  [Portal SDK](../packages/portal-sdk/README.md), which speaks it for them.
- **Sessions.** The server never runs AI-written code. Multiplayer uses one generic `creation`
  room in `realtime`: shared JSON values, relayed messages, a host that moves on when they leave,
  and three ways in: solo, shared (drop in with whoever's there) or invite. Rooms also count who's
  inside so the space can show "3 inside". New server-side abilities only arrive in platform
  releases.
- **Connectors.** The one way out of a creation
  ([connectors.md](connectors.md), [0010](decisions/0010-operator-installed-connectors.md)). The
  server's owner installs a definition (a service, its OAuth client, and operations with
  schemas). A creation declares the operations it uses in `ats.json`, an Architect approves them
  per version (`creation_version_connectors`), and each person links their own account
  (`connector_links`, tokens sealed). `connector:call` on the bridge goes to the server, which
  checks it and calls the service as that person.
- **From repositories.** A creation can follow a git repository instead of a workspace
  ([repositories.md](repositories.md), [0011](decisions/0011-creations-from-repositories.md)):
  `creation_sources` says which (host, repository, folder) and what it follows (releases, a
  branch, or one commit). The server fetches one commit's archive from a host the owner allows
  (definition files in `ATS_SOURCES_DIR`, and the built-in GitHub host and additions the owner
  chose in the app, `install_state.sources`; [0012](decisions/0012-any-public-repository.md)),
  with the host's token only for what its file names and otherwise as a public repository, keeps
  the folder's regular files as a source snapshot, and queues the same
  build as a Studio publish, with the commit on the build (`builds.source`) and on the version it
  makes (`creation_versions.source_commit`).
- **Saves.** `creation_data_shared` (for the group) and `creation_data_personal` (for one person)
  hold JSON with the shape version it was saved in. Every write names the version it's based on,
  and the server refuses stale writes, so two people (or two versions of a creation) never
  silently overwrite each other.
- **Publishing.** A creation's source is snapshotted (content-addressed in object storage, never
  with secrets in it) and built by the server, one build at a time on a queue: dependencies are
  installed from npm with install scripts off, the platform builds it with its own Vite and a fixed
  configuration, makes models and sounds lighter, then plays it in headless Chromium on a phone
  (upright and on its side), a tablet and a laptop, measuring it against the budgets for the
  least capable devices it targets (`@ats/qa`, and `@ats/qa-browser` for building and playing). The report and screenshots are kept with the
  build. A passing build becomes an immutable version: live straight away, or a candidate the
  Architect tries on their own devices first. Going back to an earlier version is one click, and
  takes effect for the next person who opens it.
- **Going in and out.** The app does the whole journey: the camera eases toward the object, a
  soft veil and sound rise while the creation loads behind it, then the veil lifts. The space
  pauses meanwhile; on phones and low-powered devices it releases its 3D context entirely so only
  one is ever live, and rebuilds where you stood when you come back.

## Code layout

See the table in the [README](../README.md). Node services run their TypeScript sources directly
(Node's built-in type stripping), so there is no server build step.
