# A new creation

A blank canvas. Everything about the creation is yours to decide: what it is, how it looks, how it
sounds. [`@allthespaces/portal`](../../packages/portal-sdk/README.md) connects it to the app (who's
here, playing together, saving, input, sound).

```bash
pnpm dev     # open it on its own while you build: you're the only player
pnpm build   # the bundle in dist/ is what gets published
```

| File | What it's for |
|---|---|
| `src/main.ts` | Where the creation starts: `connect()`, build, then `portal.ready()` |
| `index.html`, `src/style.css` | The page |
| `public/` | Files shipped as they are (models, sounds, images) |
| `ats.json` | Its title, how people come in (`solo`, `shared` or `invite`) and its budget tier |
| `assets.lock.json` | Every file you didn't make yourself: where it came from and its licence |
| `qa/script.json` | Optional: what a person might do, played on every screen size during the checks |
| `qa/connectors/<connector>/<op>.json` | Only if it uses connectors: made-up answers the checks give its calls |
| `vite.config.ts` | For `pnpm dev` only. Publishing builds with the platform's own fixed settings |

## The checks

Every publish is checked first, and the report says what to fix:

- no secrets in the source; every outside asset listed with a publishable licence; dependencies
  are published npm packages (by version) under permissive licences;
- a clean build by the platform (your `vite.config.ts`, PostCSS config and `.env` are ignored:
  import files by relative path, and put files that ship as they are in `public/`);
- models (`.glb`) are compressed and their textures kept to a sensible size; very loud sounds are
  turned down;
- it's played as a phone upright and on its side (turned mid-session), a tablet and a laptop —
  following `qa/script.json` if there is one, or trying everything at random: it must start and
  call `portal.ready()`, show something, raise no errors, reach nothing outside itself, keep
  responding, fit the screen with controls at least 44 px, and let go within 2 s when someone
  leaves;
- if it uses connectors (services the server's owner set up, listed in `ats.json` `connectors`),
  its calls are answered from `qa/connectors/<connector>/<op>.json` and listed in the report; a
  call to an operation `ats.json` doesn't declare fails the checks;
- it stays within the budgets for its `budgetTier` (draw calls, triangles, texture and graphics
  memory, sounds at once, script memory, 10 MB before it's ready and 60 MB in all), and every
  sound goes through `portal.audio` groups.

`qa/script.json` steps: `{ "wait": 1 }`, `{ "press": "KeyE" }`, `{ "hold": "KeyW", "seconds": 2 }`,
`{ "tap": [0.5, 0.6] }`, `{ "drag": [[0.3, 0.5], [0.7, 0.5]], "seconds": 0.5 }`,
`{ "type": "hello" }`, `{ "screenshot": "name" }`. Positions are fractions of the screen.

## Before it's ready

- It works in **portrait and landscape**, on a **phone** (touch) and on a **laptop** (mouse and
  keyboard), and survives the screen turning mid-session.
- Nothing is fetched from the internet; everything ships in the bundle. The only way out is a
  connector the server has, declared in `ats.json`, through `portal.connectors`.
- Every outside file (model, texture, sound, font) is CC0 or compatibly licensed and listed in
  `assets.lock.json`.
- It loads in under 10 MB before it calls `portal.ready()`, and runs smoothly on `tier: 'low'`.
- Saved data changes shape only with a new `save.version` and a `migrate` for the old shape.
- Sounds go through `portal.audio` groups, and it asks for a tap before playing sound.
