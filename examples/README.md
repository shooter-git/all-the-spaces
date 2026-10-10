# Examples

Complete creations to learn from. They're references for whoever builds a creation (often an AI
coding assistant working for the Architect), **not templates**: members never pick from them, and
a new creation shouldn't look like them. Take the techniques, not the ideas.

| Example | What it shows |
|---|---|
| [`explorable-scene`](explorable-scene/src/main.ts): *The painted garden* | A 3D place to walk around together: the stage and first-person rig, keyboard/gamepad/touch actions, seeing each other move (messages), something everyone shares (the lantern), layered ambient sound, loading progress |
| [`simulation-sandbox`](simulation-sandbox/src/main.ts): *The marble table* | A simulation everyone shares: one player (the host) runs it at a fixed step while the others send what they do and draw what it reports; carrying on when the host leaves; many moving things in one draw call (instancing); the orbit camera; telling a tap from a drag; playing by keyboard alone; collision sounds within the voice budget |
| [`vehicle`](vehicle/src/main.ts): *Paper boats* | Something to drive: boat handling, a chase camera for upright and sideways screens, checkpoints and lap times, a shared board of best times, your own best in personal saves, a 2D overlay clear of notches, reduced motion |
| [`close-up-journal`](close-up-journal/src/main.ts): *A journal* | A private, close-up 2D creation: pen input with pressure, personal saves with a data version and `migrate`, saving as you go and on the way out, a layout that rearranges for phones on their side, sound that follows the pen |

Each builds like the [starter](../starters/creation/README.md) (`pnpm build`), and has a
`qa/script.json` showing how to walk the checks through it. In the dev stack,
`node tools/dev/publish-examples.mjs` checks them all and places them in the newest studio
apartment sample (the garden on the painting over the sofa, the journal on the desk, the marble
table on the dining table, the paper boats in the bath).
