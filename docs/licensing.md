# Licensing

| Part | Licence | Why |
|---|---|---|
| Platform (`apps/*`, most `packages/*`) | AGPL-3.0-only | Keeps improvements to hosted versions open |
| Portal SDK, bridge protocol, `ats` CLI, starters, examples, agent instructions | MIT | Creations built on them are never encumbered |
| Blender helpers Architects' model scripts import (`packages/space-builder/blender/helpers/ats_model.py`) | MIT (own `LICENSE`) | A model script that imports them is the Architect's own; the bake and render scripts beside them stay AGPL |
| Fonts (Inter, Zen Kaku Gothic New) | SIL OFL 1.1 | Bundled unmodified |
| libvips (via sharp) and libheif (via libheif-js), on the server | LGPL-3.0 | Unmodified libraries in their own packages, replaceable as the LGPL requires; reviewed exceptions in `tools/check-licenses.mjs` |
| PDF.js (reading PDF floor plans, in the browser) | Apache-2.0 | Loaded only when someone picks a PDF |
| Icons (`packages/ui/src/icon-data.ts`) | ISC (Lucide), some MIT (Feather) | The few we use are copied in, with the notice in `packages/ui/src/LICENSE-lucide.txt` |
| Noto Nastaliq Urdu, LXGW WenKai TC, Yuji Syuku, Nanum Brush Script, Tiro Devanagari Sanskrit, Noto Serif Hebrew, Noto Serif Tamil, GFS Didot, EB Garamond | SIL OFL 1.1 | Only as outlines of the sayings on creation doors, drawn at build time (`tools/door-phrases.mjs`); the fonts themselves aren't shipped |
| Assets used in samples and creations | CC0 or compatible | Recorded per asset in a licence manifest; a creation can't be published with an asset missing from its `assets.lock.json` or under another licence |
| Packages bundled into a creation | Permissive (MIT, ISC, BSD, Apache-2.0…) | Checked at every build |
| Sound recordings in the space (`apps/web/public/audio`) | CC0 (Kenney) | Credited in `apps/web/public/audio/CREDITS.md` |

The MIT packages (`@allthespaces/portal`, `@allthespaces/bridge-protocol` and
`@allthespaces/ats-cli`) aren't published to npm yet: they're marked private and reach creations and
workspaces through the platform itself. Publishing them on npm is planned for later; until then,
their compatibility promises are in [protocol-compat.md](protocol-compat.md).

Third-party services used unmodified as separate processes include Garage (AGPL-3.0), Postgres,
Valkey (BSD), Caddy (Apache-2.0) and Blender (GPL-2.0-or-later). Blender runs only in the workbench
image, as a separate program: in workspaces for modelling, and in short-lived containers that bake
a place's lighting while it's built. The app image that serves the platform has no Blender. (A
development server without the supervisor can bake with a Blender the developer installed.) The
workbench image installs Ubuntu's own `blender` package unmodified; its corresponding source is
Ubuntu's `blender` source package (`apt-get source blender`, or
https://launchpad.net/ubuntu/+source/blender). Models, textures, renders and lightmaps made with
Blender are not covered by its licence; they belong to whoever made them.
Dependency licences are checked in CI (`tools/check-licenses.mjs`). One reviewed exception: libvips,
the image library inside `sharp`, is LGPL-3.0; it's used unmodified and dynamically linked, which
the LGPL allows in AGPL software.
