# {{TITLE}}

You're building a **creation** for All the Spaces: something people open from an object in a 3D
model of their real place ({{WHERE}}), with the people they share it with. The Architect asked for
it on their behalf. **BRIEF.md** says what it should be. Read it first, and build exactly that.

When a member asked for it, BRIEF.md ends with their own words, and the pictures and documents they
added are in `request/` (`snapshot.jpg` is what they drew a box around in the space; `sketch.jpg`
is a sketch they drew; `doc-N.md` is a document they wrote, often a detailed plan). Read every
document in full and look at every picture: they show what the person has in mind. Where the Architect's brief and
the member's words differ, follow the Architect.

A creation can be anything — a game, a calm place to wander, a toy, a journal, a puzzle, a
simulation. 3D is optional. The examples below are for techniques only; don't make this look like
them.

## Hard rules

These come from how creations run. Breaking them means the creation won't publish or won't work.

1. **It runs in a sealed frame with no network.** No fetches to the internet, no CDNs, no web
   fonts, no analytics. Ship every file inside the project and load it by relative path
   (`./assets/…`, or `import` it). No cookies, `localStorage` or IndexedDB: use `portal.save` and
   `portal.storage`. The only exception: when BRIEF.md says the creation uses a service the
   server connects to (a **connector**), call it with `portal.connectors.call()`, and declare
   every operation you call in `ats.json` `connectors`, with why. Use only connectors and
   operations the brief names; never try to reach a service any other way. Give the checks
   answers in `qa/connectors/<connector>/<op>.json` (the SDK README's Connectors section).
2. **Use `@allthespaces/portal` for everything that touches the app:** `connect()` first, then
   `portal.ready()` once it looks right; players and multiplayer through `portal.session`; saving
   through `portal.save`; input through `portal.input`; sound through `portal.audio` groups.
   Its README is `vendor/allthespaces-portal/README.md` — read it before you start.
3. **Every screen, every hand.** It must work on a phone held upright *and* on its side, on a
   tablet and on a laptop, with touch *and* with mouse and keyboard, and keep working when the phone
   turns mid-session. Touch targets are at least 44 × 44 px. Keep the top-left 56 × 56 px clear:
   the app's small menu button (Back, Chat…) sits there.
4. **Assets:** only free (CC0) ones, through `ats assets search <words>` and `ats assets add <id>`
   (they're recorded in `assets.lock.json` for you). Anything you make yourself (procedural
   textures, generated sounds, drawn SVGs) is fine: list files you create by hand in
   `assets.lock.json` with `"license": "own"`.
5. **Stay within the budgets** for `budgetTier` in `ats.json` (usually `low`: a modest phone):
   around 150 draw calls and 300,000 triangles per frame, 128 MB of textures, 16 sounds at once,
   10 MB downloaded before `portal.ready()`. `ats qa` measures all of this. Never let the page
   stop answering for 5 seconds (the app offers to leave): split long work, or move it into a
   worker imported with `?worker&inline` (the SDK README says how). The checks' browser
   has no graphics card, so 3D is drawn on the CPU there and making shaders can pause it for
   seconds; that's only a warning, but make shaders a few at a time behind a loading screen.
6. **Dependencies:** published npm packages only (`pnpm add three`). Install scripts are switched
   off. The build uses the platform's own settings: `vite.config.ts`, PostCSS configs and `.env`
   files are ignored when publishing.
7. **Never publish.** The Architect publishes from the Studio when they're happy.

## How to work

1. Read `BRIEF.md`, then `vendor/allthespaces-portal/README.md`.
2. Plan briefly: what it is, how it feels on a phone and on a laptop, what's shared between
   players, what's saved.
3. Build it in `src/`. `pnpm install` once, then add what you need. The Architect sees a **live
   preview** in the Studio that rebuilds whenever you save a file — keep it working as you go.
4. Write `qa/script.json`: the steps a person would take (keys, taps, drags, waits, screenshots —
   see the starter README), so the checks exercise the real thing.
5. Run **`ats qa`**. It builds the creation the way publishing will and plays it on a phone
   (upright, then on its side), a tablet and a laptop. Fix everything it reports and run it again
   until it says **Ready**. Screenshots are in `qa-output/`: look at them.
6. Tell the Architect it's ready, in plain words: what you built, how to use it on a phone and on
   a laptop, anything you'd suggest next. They're not technical: no jargon, and never ask them
   to run a command. They see the live preview, and your model previews under **Pictures**.

**Save as you go.** The workspace is its own git repository (only here: it has no remote, so
never add one or push). Each time a change the Architect asked for works, and after each step of a
bigger job, commit it: `git add -A && git commit -m "<what changed, in plain words>"`. That's how
the Architect gets back to a version that worked. Never rewrite or throw away history (`git reset
--hard`, `rebase`, `commit --amend`, `checkout -- .`, `clean`): to undo something, change it back
and commit that. The Studio also saves a checkpoint each time the workspace goes to sleep.

**3D models of anything**: you have Blender (headless, CPU) here. Write a Blender Python script and
run `ats model build models/<name>.py`: it exports `models/<name>.glb` and draws it from four sides
into `preview/models/<name>.png` to look at (`ats model help` for the details, and
`/opt/ats/packages/space-builder/blender/helpers/ats_model.py` for helpers, MIT). Copy what the
creation uses into `public/` and load it with the SDK's loaders. Run Blender jobs one at a time
(they wait for each other; each can use a lot of memory). Free library models and textures:
`ats assets search` / `ats assets add`.

**Files the Architect adds** while you work land in `uploads/` (a picture, a sketch, a sound, a
document), and the Architect names them in their message. Look at them as they ask. To use one
in the creation, copy it into the project (e.g. `src/assets/`): `uploads/` isn't published. A
folder in `uploads/` is a .zip they added, unpacked with its own names and folders: read its
README or manifest first (the `.md`, `.json` or `.txt` files at its top), which says what each
file is and where it goes.

## Quality bar

- **Art direction:** a clear, coherent look. Considered colour, light and composition; motion that
  eases. Nothing that looks like a default template.
- **Sound:** gentle, mixed so nothing is harsh; loops that don't click; respect the groups.
- **Feel:** immediate response to input, clear feedback, nothing that stutters on a phone.
- **Loading:** `portal.progress()` while loading, then `portal.ready()`. The app draws the veil
  and transitions; don't add your own intro fade.
- **Kindness:** respect `portal.reducedMotion`. Everyone can finish, pause or leave at any time.

## Reference

- SDK: `vendor/allthespaces-portal/README.md` (and its `src/` if you need the details).
- Examples (techniques, never templates), in `/opt/ats/examples/`: `explorable-scene` (a 3D
  garden to walk together), `close-up-journal` (a private notebook with pen input and saves),
  `simulation-sandbox` (a simulation one player runs for everyone, carrying on when they leave)
  and `vehicle` (boat handling, a chase camera, lap times and a shared board of best times). Each
  has a `qa/script.json`; start a script with a tap, so keys reach the creation.
- What the checks look at: `/opt/ats/starters/creation/README.md`.

## Changing it later

People may already have saved things. When you change the shape of saved data, bump
`save.version` in `connect()` and give a `migrate` for the old shape. Never break old saves.
