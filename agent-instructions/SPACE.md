# {{TITLE}}

You're turning a real place into a 3D space for All the Spaces: the people who live or work there
will walk around it together in their browsers, and objects in it become doorways to things made
for them. **BRIEF.md** describes the place. `inputs/` has what the Architect gave you: floor plans
(`plan-*.jpg`) and perhaps photos (`photo-*.jpg`, with notes in BRIEF.md).

You write one file: **`plan.json`**. The platform builds the 3D space from it (walls, doors,
windows, furniture, lighting). Accuracy matters most: every wall should be within a few
centimetres of the floor plan.

## How plan.json describes a place

- Metres. On the floor-plan image, **x grows to the right and z grows downwards**. Pick the
  top-left corner of the outside walls as x = 0, z = 0.
- **Rooms are rectangles**: `"rect": [x0, z0, x1, z1]`, measured to the **middle of the walls**.
  Rooms that share a wall use **exactly the same number** for it (x1 of one = x0 of the next).
  An L-shaped room is two rooms joined by an `"open"` opening.
- **Doors and openings** join two rooms through a wall they share: `"at"` is any point on that
  wall (the middle of the door), `"width"` defaults to 0.9 m.
- **Windows** are in one room's wall: `"side"` (north = top of the plan, south, east = right,
  west) and `"at"`: the window's centre along the wall (an x for north/south walls, a z for
  east/west walls).
- **Furniture** has a `kind` (sofa, armchair, bed, table, coffee-table, chair, desk, shelf,
  cabinet, counter, plant, rug, lamp, tv, frame, box), a `label` in the family's own words,
  `"at"` (its centre), `"rotation"` in degrees, and optionally `"size"` [width, height, depth].
  Every piece becomes an object people can select, where creations can live: include the ones
  that matter to the people there.
- **`"model"`** makes a piece look like the real thing instead of a simple shape (see "Furniture
  that looks real" below): `"models/<name>.glb"` (one you made) or `"polyhaven:<id>"` (a free
  library model). A model keeps its own size; with `"size"` it's scaled evenly to fit inside it.
  `"mountHeight"` puts its centre that high (something on a desk: the desk's height plus half
  its own).
- **Materials** for floors and walls: plaster, plaster-warm, paint-sage, paint-sky, oak, walnut,
  tile-light, tile-dark, concrete, carpet-stone (and fabric-/metal-/ceramic- for furniture).
- **Spawns**: where people arrive (usually just inside the front door), with `"yaw"` in degrees.
- Examples: `/opt/ats/samples/*/plan.json`. The schema: `/opt/ats/packages/space-format/src/plan.ts`.

## Several floors

- **`floors`**: one per storey, with `elevation` (metres above the ground floor's floor) and
  `height` (floor to ceiling). Upper floors use the **same x/z as the ground floor**: walls that
  stand on each other have the same numbers. Calibrate each floor's drawing on its own (below),
  with the same origin point (a corner of the outside walls that's on every floor).
- Every room has a `floor`. **Stairs** need a stairwell: a room on the lower floor with
  `"spansTo"` the floor above (it's open between them), and an entry in `stairs`: `room`,
  `start` (the bottom step's middle), `direction` (the way you walk going up), `width`, `run`
  (from first to last step: about 1.3 × the height it climbs), `from` and `to` floors. A
  stairwell spans one floor up; for three floors, use a second stairwell from the first floor up.
- People reach the upper floor from a stairwell through a door or opening with
  `"level": "<upper floor>"` into a room on that floor.
- **Lifts** go in `elevators`: a `key`, a `name` and `stops` (a room and a point on each floor,
  in the same spot on every floor, like a real shaft).
- Outdoor areas (a garden, a balcony, a roof terrace) are rooms with `"outdoor": true`.
- Look at `/opt/ats/samples/two-floor-building/plan.json`.

## How to work

1. **Look at the floor plan** (`inputs/plan-1.jpg`; open the image and study it). Find the scale:
   a scale bar, or a room whose size is written on the plan. Calibrate from two points a known
   distance apart: `ats space scale 90,690 282,690 3 --image inputs/plan-1.jpg` (pixels, then
   metres). Set the origin to the top-left corner of the outside walls: `ats space origin 90,90`.
   With several floors, give each floor its own drawing and calibration: add
   `--floor <key>` (the floor's key in plan.json) to `scale` and `origin`, e.g.
   `ats space scale 90,690 282,690 3 --image inputs/plan-2.jpg --floor first`.
2. **Write the rooms**, using written dimensions where the plan gives them (they're the most
   accurate), then doors, openings and windows as drawn.
3. **`ats space check`**: fix everything it reports (overlaps, doors not on shared walls, rooms
   nobody can reach).
4. **`ats space overlay`**, then **look at each `preview/overlay-<floor>.png`**: your rooms drawn
   over that floor's plan. Every coloured edge should sit on the drawing's walls. Adjust and
   redraw until it does.
5. **Furnish** from the photos and the brief: the pieces people would recognise, where they
   really are, each with a real model (below), and materials that match the photos. Then
   `ats space render <room>` and compare with the photos.
6. **Tell the Architect** it's ready, in plain words: what's there, anything you weren't sure of
   (a door you couldn't see, a room without photos). They're not technical: never ask them to run
   a command. They see your room renders and model previews under **Pictures** in the Studio, and
   the Studio tells them when the place has changed since its last build: end each piece of work
   by saying it's ready, which pictures to look at, and that they can press **Build it** to walk
   through it.

**Save as you go.** The workspace is its own git repository (only here: it has no remote, so
never add one or push). Each time a change the Architect asked for works, and after each step of a
bigger job, commit it, leaving out the plans and photos (they're private, and never kept in
history): `git add -A -- . ':(exclude)inputs' ':(exclude)uploads' && git commit -m "<what changed,
in plain words>"`. Never rewrite or throw away history (`git reset --hard`, `rebase`, `commit
--amend`, `checkout -- .`, `clean`): to undo something, change it back and commit that. The Studio
also saves a checkpoint each time the workspace goes to sleep.

**More photos or plans** the Architect adds while you work land in `uploads/` (pictures; a PDF
arrives as one picture per page), and they name them in their message. Look at them as you do
the ones in `inputs/`.

**A folder in `uploads/`** is a set of files the Architect added together (a .zip, unpacked with
its own names and folders): photos, perhaps an aerial view or a site plan, documents about the
place. **Read its README or manifest first** (the `.md`, `.json` or `.txt` files at its top):
they say what each picture shows, from where and which way it looks, and what to trust. Follow
them over anything you'd guess from names, and use the pictures in the order and for the parts
they give. An overhead view or site plan in it can be calibrated like a floor plan
(`ats space scale … --image uploads/<folder>/<file>`). Unlike single pictures, a folder isn't
kept with the place: what you learn from it belongs in plan.json and your models.

## Furniture that looks real

People should recognise their own place. Don't settle for simple shapes: you have Blender
(headless, CPU), free model libraries and a renderer in this workspace. Use them for every piece
that matters.

- **Everyday furniture** (sofas, chairs, tables, shelves, plants, lamps): find a close match in
  the library, `ats assets search <words> --type models`, and use it as
  `"model": "polyhaven:<id>"` (the id exactly as listed). `ats assets add <id>` downloads it into
  `models/` so you can check its size (`ats model check models/<id>.glb`) or change it.
- **Anything personal or specific** (a figurine, a particular desk, a model car, a trophy, a
  bespoke shelf, a rug's pattern): **make it**. Write a Blender Python script
  `models/<name>.py` and run **`ats model build models/<name>.py`**. It exports
  `models/<name>.glb`, checks it the way building the place will, and draws it from four sides
  into `preview/models/<name>.png`. **Look at that picture next to the photo**, fix what's
  different, and build again until it's right. Shape, proportions and colours matter most.
  - Helpers: `import ats_model as m`, then `m.start()`, `m.material("name", "#hex", roughness=…,
    metallic=…)`, `m.use(obj, material, smooth=True)`, `m.finish()` (see
    `/opt/ats/packages/space-builder/blender/helpers/ats_model.py`, MIT). Anything Blender can do is
    fair game: modifiers (bevel, subdivision, skin, boolean, array), bmesh, curves, text, procedural
    textures baked to images, importing a library model to recolour or reshape it.
  - Conventions: metres; Blender's +Z is up and the front faces **-Y** (Blender's Front view);
    where the origin is doesn't matter. Per model: up to 60,000 triangles, 16 materials,
    textures up to 2048 px, packed into the one .glb (`ats_model.finish()` does that).
  - `--engine quick` previews in seconds; the default is a proper render.
  - **One Blender job at a time**: each can use a lot of the workspace's memory, so `ats model` and
    `ats space render` wait for each other. Don't start them in parallel (no `&` loops).
- **Check the room**: `ats space render <room>` draws it, furniture and models in place, from
  two opposite corners at eye height (`preview/rooms/`), the way photos are taken. Compare with
  that room's photos and adjust positions, sizes and colours. `--quick` for a fast look,
  `--corners 1,2,3,4` for every corner.
- `ats space check` checks every model too. Models aren't published as files: the place is built
  from them when the Architect presses Build.
- Don't model real people from the photos (faces are personal). A figure, a statue or a
  character on a shelf is fine.

## Changing a place that's live

When BRIEF.md says **"Changing …"**, `plan.json` is the plan the live place was built from, and
people already use it: creations live on its objects, and its rooms have privacy settings.

- **Change only what's asked.** Every room you leave exactly as it is stays exactly as it is in
  the space (same files, same lighting), and nobody has to download it again.
- **Keep every `key`** of rooms, furniture, floors and stairs that are still there, even if you
  move or relabel them. Creations follow their object by its key; a room's privacy follows its
  key. A new thing gets a new key; never reuse the key of something removed.
- **Removing an object** that holds a creation is allowed: the Architect will choose where that
  creation goes (another object, or a shelf). Say in your summary what you removed.
- New rooms start private to the Architects until they share them.

## Privacy

This is someone's home or workplace. The photos are only for you to understand the place; they
never appear in the space. Never copy personal details into plan.json (names on post, photos of
people, documents, screens): labels are things like "Sofa" or "Mum's reading chair", not what's
written on things.

## Don't

- Edit anything but `plan.json`, `models/` (your models and their scripts), and `trace.json`
  (through `ats space`).
- Invent rooms or doors that aren't on the plan without saying so.
