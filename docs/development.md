# Development

Requirements: Node 22.18+ (24 recommended; the apps run TypeScript directly, which older Node
versions only do with a flag), pnpm 10, Docker with Compose.

```bash
pnpm install
pnpm dev:setup      # creates .env with random secrets (never committed)
pnpm dev:up         # Postgres, Valkey, Garage, Mailpit and Caddy in Docker
pnpm dev            # web, server, realtime, worker and supervisor with live reload
```

`pnpm dev` runs the apps only. The creation starter and the examples have their own `pnpm dev`
(plain Vite, on Vite's usual ports): run it in their folder when you want one on its own.

Open http://app.ats.localhost:45080 — `*.localhost` always points to your own machine and counts as a
secure context, so no certificates are needed. The first start prints a setup code in the server
log (`pnpm --filter @ats/server setup-code` prints a new one).

## Staying out of the way

The dev stack is its own Compose project (`ats-dev`) and binds only to `127.0.0.1` on ports in the
**45000–45999** range. `pnpm dev:check-ports` runs first and stops with a suggestion if a port is
taken; it never touches other containers. Change any port in `.env`.

The dev Caddy shares the host's network (`network_mode: host`) so it can reach `pnpm dev`'s apps
there, and stays on loopback with `default_bind 127.0.0.1` in `deploy/compose/dev/Caddyfile`. Host
networking works like this on Linux; Docker Desktop (macOS, Windows) doesn't offer it by default,
and without it the dev routing can't reach your machine's ports.

## On your phone (Tailscale)

If this machine and your phone are both on your [Tailscale](https://tailscale.com) network, the
phone can use the dev app over real HTTPS, with nothing to install on it (install as an app, push
notifications and the service worker all work):

```bash
pnpm dev:tailnet on     # then restart `pnpm dev`
```

It prints the address, `https://<this machine>.<tailnet>.ts.net:45481`; use it on this computer too
while it's on (sign-ins belong to one address). Creations are served from `:45482`, their own
origin. Tailscale Serve terminates HTTPS with a trusted certificate and hands each port to its own
loopback-only Caddy listener (`ATS_PORT_TAILNET_APP` / `ATS_PORT_TAILNET_PLAY`). Only devices on
your tailnet can reach it (the phone needs the Tailscale app connected); your Wi-Fi can't.

`pnpm dev:tailnet off` (then restart `pnpm dev`) removes exactly those two Serve entries and puts
the localhost address back; `pnpm dev:tailnet status` shows where things stand. Other Tailscale
Serve entries on the machine are never touched. If a port is taken, set `ATS_TAILNET_APP_HTTPS` /
`ATS_TAILNET_PLAY_HTTPS` in `.env`.

## Useful commands

| Command | What it does |
|---|---|
| `pnpm lint` / `pnpm format` | Biome checks / fixes |
| `pnpm typecheck` | TypeScript across the monorepo |
| `pnpm test` | Unit tests (set `TEST_DATABASE_URL` to also run integration tests) |
| `pnpm --filter @ats/web test:axe` | Accessibility (axe) of the built web app's main pages on phones, and touch in a space (Chromium and WebKit; `WEB_TOUCH_ENGINES=chromium` without WebKit's system libraries); build it first |
| `pnpm brand:build` | Regenerate icons, splash screens and social images from `brand/` |
| `deploy/install/test/run.sh` | Full installer test: install, update, broken update → rollback |
| `pnpm --filter @ats/db db:generate` | New database migration after changing the schema |

## Database migrations

The server applies new migrations when it starts. Before the first release they may be squashed into
one `0000_init` (see [CONTRIBUTING.md](../CONTRIBUTING.md#database-migrations)), which an existing
development database can't apply: its tables are already there. Either start afresh (`pnpm dev:down`,
remove the `ats-dev_postgres` volume, `pnpm dev:up`), or keep your data and record the new migration
as applied, once, with the dev stack running:

```bash
cd packages/db
node --input-type=module -e "
import { readMigrationFiles } from 'drizzle-orm/migrator';
const [m] = readMigrationFiles({ migrationsFolder: './migrations' });
console.log(\`insert into drizzle.__drizzle_migrations (hash, created_at) values ('\${m.hash}', \${m.folderMillis});\`);
" | docker compose -p ats-dev exec -T postgres psql -U ats -d ats
```

The server only compares the newest recorded migration with the files, so this is enough when your
database already had every migration up to the squash.

## Sample spaces and baked lighting

Sample spaces are built in the background when an Architect adds one. They use CC0 textures,
furniture and an HDR sky from Poly Haven, cached in `.data/asset-cache` (`ATS_OFFLINE=1` builds plain
versions without downloading anything).

Every place the server builds (samples, and places built in the Studio) has each indoor room's
lighting baked on the CPU: daylight through the windows and soft ceiling lights bouncing around the
room, with furniture casting soft shadows. Each room is baked on its own with its doors closed, so
no room's lighting gives away anything about another. Where it's baked:

- **With the supervisor** (the dev stack's, or any installed server), in short-lived containers
  from the workbench image, one per room, several rooms at a time: `ATS_BAKE_CPUS` each (2) and the
  workbench's memory limit (`ATS_SANDBOX_MEMORY_MB`), at most `ATS_BAKE_PARALLEL` at once across
  every build (the host's CPUs / `ATS_BAKE_CPUS`), and 30 minutes per room. Rebuild the workbench
  image (`images/workbench/Dockerfile`) after changing `bake_room.py`: the job runs the image's
  copy.
- **Without one** (no `ATS_SUPERVISOR_URL`, as with plain `pnpm dev` on a laptop), with
  [Blender](https://www.blender.org/) on this machine (on the `PATH`, or set `ATS_BLENDER`).
- **Neither**: rooms use real-time lighting, and the Studio says "Lighting not baked" and why.

A room whose bake inputs haven't changed since an earlier build of the same place isn't baked again.

| Variable | Default | What it does |
|---|---|---|
| `ATS_BLENDER` | `blender` on the `PATH` | Blender to bake with when there's no supervisor (3.4 or newer) |
| `ATS_BAKE` | on | `0` turns baking off |
| `ATS_BAKE_RES` | `1024` | Lightmap size per room (`512` is plenty while developing) |
| `ATS_BAKE_SAMPLES` | `128` | Quality; `64` is about twice as fast |
| `ATS_BAKE_CPUS` | `2` | CPUs for each room's bake (the supervisor's setting) |
| `ATS_BAKE_PARALLEL` | host CPUs / `ATS_BAKE_CPUS` | Rooms baked at once, across every build (the supervisor's setting) |
| `ATS_CHECK_CPUS` | `4` (or the host's CPUs if fewer) | CPUs for building and playing a creation in its checks (the supervisor's setting) |

`node packages/space-builder/src/cli.ts samples/studio-apartment/plan.json out/` builds a space
to disk with the same settings.

## Performance checks

Two tools check the performance budgets. Both print `pass`/`FAIL` per budget.

```bash
pnpm --filter @ats/realtime load-test 50
pnpm --filter @ats/realtime load-test 150 tall-building
```

Starts its own copy of the real-time service (a free port and a separate Valkey database, so it
never meets the dev service) and walks simulated people around a sample building, 30 of them in
the lobby and the rest wandering from room to room. It checks how long each state update and each
who-sees-whom update takes (99th percentile over the whole run, for each live room), CPU use,
download per person and how quickly someone arriving by lift appears upstairs. People are spread
over shards as the server would. Timings are elapsed time, so a busy machine inflates them; the
tool prints how much other programs kept it waiting (`LOAD_SERVICE_CPUS=6-7` and
`taskset -c 0-5` keep the service and the simulated people apart).

`samples/tall-building` is 20 floors and 240 rooms, for this test only (its lighting would take
about 30 hours to bake in the workbench: about 7 minutes a room on 2 CPUs);
`node tools/dev/make-tall-building.mjs` regenerates it.

```bash
pnpm --filter @ats/realtime voice-check 12
```

Twelve test people stand in one room of the newest studio apartment, get voice passes from the
real-time service and join voice in headless Chromium with fake microphones. Checks everyone hears
everyone, talking is noticed (what ducking runs on), walking out of the room takes you out of its
voice, and a pass is only ever for your own room. Needs `pnpm dev` (with LiveKit).

```bash
node tools/dev/a11y-check.mjs [spaceId] [--only <path>] [--json out.json]
```

Every screen against WCAG 2.2 AA (axe), as the dev Architect and member, light and dark, laptop and
phone, with the space's panels and dialogs open; plus what axe can't see: every control reachable
by Tab with a visible focus ring that nothing covers, and pages that fit 320 px without scrolling
sideways.

```bash
pnpm --filter @ats/web build
node tools/dev/space-budget.mjs <spaceId> [<spaceId>...]
```

Checks a space in the dev stack: download sizes per room and detail level, the download needed
before you can move, and, in headless Chromium on a simulated 25 Mbps connection, time until you
can move, draw calls, triangles and GPU memory at the Low and Mid quality levels.

## Creations

Creations are built like any Vite project (see the [starter](../starters/creation/README.md)).
Architects publish them from the Studio, where their AI assistant builds them (see
[The Studio](#the-studio)). They can also be published from the command line, and every publish
goes through the same checks either way.

```bash
node packages/qa-browser/src/cli.ts check <project> [<report-folder>]
```

Checks a creation on your machine without publishing it: secrets, licences, a clean build, then
headless Chromium plays it as a phone (upright and on its side), a tablet and a laptop. It prints
each check and writes `report.html` (default: `<project>/qa-output/`). `--seconds 4` plays for
less time; `--viewports desktop` checks one screen.

```bash
pnpm --filter @ats/server creation:publish <project> --space <id> --object <key> [--candidate]
```

Snapshots the project (refused if it contains anything that looks like a secret), queues a build
on the server and follows it. If the checks pass it goes live, or with `--candidate` it waits on
the space's **Creations** page (Home → Creations) to be tried and made live. A creation already on
that object gets a new version. Object keys are in the space's manifest
(`rooms[].objects[].key`). `--unchecked <built-folder> --title "…"` skips the checks: only for test
fixtures that misbehave on purpose.

```bash
node tools/dev/publish-examples.mjs [--candidate]
```

Checks and publishes the [examples](../examples/README.md) into the newest studio apartment
sample: walk up to the painting over the sofa, the desk, the dining table or the bath, and click
(or press E, or tap).

```bash
node tools/dev/security-check.mjs
node tools/dev/versions-check.mjs
```

The security check publishes two misbehaving fixture creations onto the bookshelf and the bed
(`tools/dev/fixtures/`) and checks, in headless Chromium, that a creation can't escape its frame
and that a frozen one can't lock up the app. The versions check publishes two versions of a small
creation onto the dining table while someone is inside the first: version 2 must upgrade version
1's saves, version 1 must not overwrite them, and the app must offer to rejoin. Both print
`pass`/`FAIL` per check.

`QA_BROWSER=1 pnpm --filter @ats/qa-browser test` also runs the checks' own browser tests (the starter
passes, an over-budget fixture fails for the right reasons); they take a couple of minutes.

Playing needs the play address as well as the app, so both `app.ats.localhost` and
`play.ats.localhost` must reach the dev stack (they do by default).

## The Studio

The Studio runs Architects' AI assistants in containers started by the supervisor (part of
`pnpm dev`, on the host, using your Docker). It needs two images and the egress proxy:

```bash
docker build -f images/workbench/Dockerfile -t ats-workbench:dev .
pnpm dev:up        # includes the egress proxy and the sealed `sandbox` network
```

Rebuild the workbench image after changing `packages/qa`, `packages/qa-browser`,
`packages/ats-cli`, `packages/space-builder`, the SDK or the starter. It includes Blender (Ubuntu's package), so the
assistant can model (`ats model build`), and draw a room (`ats space render`), on the CPU. Then **Home → Your group → AI assistants**: connect an assistant (this runs the vendor's
official installer in your own container; signing in needs your own subscription), start a
workspace, and publish.

Everything the supervisor creates is labelled `io.allthespaces.instance=ats-dev` and named
`ats-dev-…`; it never touches anything else. On a development machine sandboxes use Docker's
standard runtime (`ATS_SANDBOX_RUNTIME=runc`): gVisor needs a Docker daemon change, which is never
made automatically.

```bash
SUPERVISOR_DOCKER_TESTS=1 pnpm --filter @ats/supervisor test
```

Runs the supervisor against your Docker: a sealed sandbox, a terminal, archiving, a live preview
and a connect container, all cleaned up afterwards.

## Onboarding a real place

`tools/dev/onboarding-kit/` checks how accurately an assistant turns a floor plan into a space.
`truth.json` is a two-bedroom flat as it really is; `make-kit.mjs` draws `plan.jpg` from it (an
estate-agent-style plan, with written room sizes and a scale bar) and `description.md` is what an
Architect might say about it.

1. **Home → Add your own place**: add `plan.jpg`, paste `description.md`, and start building with
   your assistant (it needs your own subscription).
2. When it's done, compare its plan with the truth:

```bash
node tools/dev/onboarding-kit/compare.mjs <plan.json>
```

It lines the plans up, then checks every wall is within 10 cm, every door is there, and the plan
passes `ats space check`. (Download `plan.json` from the workspace with **Move walls**, or copy it
out of the workspace volume.)

`building/` is the same for a three-floor building: two stairwells, a lift, a roof terrace and
furniture on every floor. Add its three `plan-*.jpg` (saying which floor each is) and
`building/description.md`; then:

```bash
node tools/dev/onboarding-kit/compare.mjs building <plan.json>
```

Floors are matched by height, so the assistant may name them differently. `make-kit.mjs building`
redraws the plans from `building/truth.json`.

### Changing a live place

Publish the building, add a creation on the studio desk, then **Studio → Change this place…** and
ask for the desk to go. The review should list only the studio as changed, and Publish waits until
the desk's creation has a new object or goes on the shelf. **Versions → Go back to this** puts it
back on the desk.

## Requests and notifications

Sign in as the dev member in one browser and the dev Architect in another. In a space, the member
presses **Ask for something**; the Architect sees it under **Home → Requests to build**.

- **Emails** (for anyone who turned on email notifications) land in Mailpit:
  `http://127.0.0.1:45126`. So do the links new accounts confirm their email with: Mailpit counts
  as email, so the dev app asks for confirmation. Dev accounts made before that existed can be
  confirmed in one go, with the dev stack running:

  ```bash
  docker compose -p ats-dev exec -T postgres psql -U ats -d ats \
    -c "update \"user\" set email_verified = true where email like '%@example.test'"
  ```
- **Push notifications** need the app's service worker, which only runs in a production build
  (`pnpm --filter @ats/web build && pnpm --filter @ats/web preview`), not in `pnpm dev`, where the
  settings show them as unavailable.

## When a change doesn't show up

- **Server or realtime still running old code:** `pnpm format` rewriting files can confuse Node's
  file watcher. `touch apps/server/src/main.ts apps/realtime/src/main.ts` restarts them.
- **The web app still running old code** (an error mentioning something you've fixed): Vite can
  hold on to a stale transform. Touch the file, or restart `pnpm dev`.
- **Headless 3D checks:** the tools above launch Chromium with SwiftShader
  (`--use-angle=swiftshader`) so they work without a GPU.
