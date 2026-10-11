<p align="center"><img src="brand/logo.svg" alt="All the Spaces" width="360"></p>

**All the Spaces** turns a real place — a home, an office, a whole building — into a shared 3D
space that your people can walk around together in the browser, on a laptop or a phone. Any object
in it can become a doorway to a *creation*: a game, a simulation, a quiet scene to explore, a
puzzle, a journal — anything someone can imagine. Creations are built by the space's **Architect**
with an AI coding assistant and then stay there for everyone.

It's free, open source, and runs on your own server.

![Two people in a 3D living room in the browser; a phone beside it shows the space's chat](docs/images/a-space-together.jpg)

> **Status:** early (0.x). Expect rough edges, and breaking changes between releases until v1.0.

## What it looks like

**Any object can be a doorway.** Point at something and it says what it opens. Its door tells you
what's inside; go in together with whoever else is there, or on your own.

![Pointing at a coffee table shows "Click to open Sky islands"; its door card; inside the game](docs/images/objects-are-doorways.jpg)

**Creations can be anything.** A platformer, mini golf, a campsite to wander at night. The
Architect builds each one with their AI assistant and free (CC0) models and skies, and every
version is checked on phones, tablets and laptops before it goes live.

![Three creations: a platformer above the clouds, a mini golf course with a windmill, and a campfire by a lake at night](docs/images/creations.jpg)

**Places of any size**, from a studio flat to a building with several floors, built by the
Architect's assistant from a floor plan and a few photos.

![Rooms of a two-floor building: an open office, a terrace and a lobby](docs/images/places.jpg)

**The Studio, for Architects.** Members ask for things; the Architect builds them with their own AI
coding assistant in a sealed workspace, with a live preview at phone and laptop sizes.

![A Studio workspace with its terminal and a live preview, and the queue of members' requests](docs/images/studio.jpg)

<sub>The pictures show an invented household on a development server; the creations were made for
them.</sub>

## Install on a server

You need a Linux server (Ubuntu 22.04/24.04 or Debian 12/13) with at least 4 CPUs, 16 GB of memory
and 80 GB of disk. Then run one command:

```bash
curl -fsSL https://github.com/shooter-git/all-the-spaces/releases/latest/download/install.sh | sudo bash
```

The installer sets everything up, asks for your web address (or gives you a free one), and prints a
setup code. Open the address in your browser, enter the code, and a short wizard does the rest.
See [docs/self-hosting.md](docs/self-hosting.md) for details, updates and backups.

## What's inside

| Part | What it does |
|---|---|
| `apps/web` | The app people use: the shared space, creations, the Architect's Studio, the setup wizard |
| `apps/server` | Accounts, groups, invites and the API |
| `apps/realtime` | Live presence and multiplayer |
| `apps/worker` | Background jobs |
| `apps/supervisor`, `apps/egress` | Architects' sandboxes: the one service allowed to start containers, and the only way out of them |
| `images/workbench` | The sandbox, preview and checking image (no AI assistant inside) |
| `packages/qa`, `packages/qa-browser` | The checks every creation passes before it's published (the browser half runs in the workbench) |
| `packages/ats-cli` | The `ats` command inside a workspace (MIT) |
| `agent-instructions` | What an Architect's AI assistant reads in every workspace (MIT) |
| `packages/portal-sdk` | [`@allthespaces/portal`](packages/portal-sdk/README.md): what a creation uses to live inside the app (MIT) |
| `packages/*` | Shared code: database, storage, the 3D viewer, space building, design system, configuration |
| `starters/creation` | A [blank canvas](starters/creation/README.md) for a new creation (MIT) |
| `examples/` | [Complete creations](examples/README.md) to learn from, never templates (MIT) |
| `deploy/` | Docker Compose files, the installer and `ats-admin` |

Read [docs/architecture.md](docs/architecture.md) for how it fits together and
[docs/security.md](docs/security.md) for how AI-written code and your data are kept safe.

## Develop

See [docs/development.md](docs/development.md). In short: `pnpm install`, `pnpm dev:setup`,
`pnpm dev:up`, `pnpm dev`, then open http://app.ats.localhost:45080.

## Licence

The platform is licensed under the [GNU AGPL v3](LICENSE). The SDK that creations are built with,
its starters and examples are MIT-licensed so creations are never encumbered — see
[docs/licensing.md](docs/licensing.md).

All the Spaces is an independent project. It can work with AI coding assistants such as Claude Code
or Codex that you sign in to with your own subscription; it is not affiliated with their makers.
