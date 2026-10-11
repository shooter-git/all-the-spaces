# {{TITLE}}

You're turning a real place into a 3D space for All the Spaces: the people who live or work there
will walk around it together in their browsers, and objects in it become doorways to things made
for them. **BRIEF.md** describes the place. `inputs/` has what the Architect gave you: floor plans
(`plan-*.jpg`), perhaps photos (`photo-*.jpg`, with notes in BRIEF.md), and perhaps a folder of
photos with notes on them (a README, a manifest): with no floor plan, you build it **from the
outside in** (below).

You write one file: **`plan.json`**. The platform builds the 3D space from it (walls, doors,
windows, furniture, lighting). Accuracy matters most: every wall should be within a few
centimetres of the floor plan, or, from photos, the place should match every one of them.

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
  Outside: asphalt, grass, brick, stone, concrete, glass; metal-green and metal-white (painted
  steel), mesh and mesh-green (metal mesh you can see through).
- **A floor that slopes** (a ramp, a sloping deck, a street on a hill): `"slope": {"toward":
  "north", "rise": 3}` climbs 3 m from the floor's elevation, evenly, to the room's north edge.
  Walls, ceiling, doors, furniture and people follow it. Where it meets another room, the floors
  must be level at the opening (`ats space check` says if not). Keep the space above a ramp open.
- **Outdoor edges**: an outdoor room has a 1.05 m low wall; `"parapet": 0` for none (open ground,
  a street, a pavement), or the real height (a car park's deck edge, a balcony's solid front).
- **`structure`**: the building's own fabric, as boxes people see and bump into but can't pick out:
  `{"room": "deck-1", "label": "column", "at": [5, 8], "size": [0.5, 2.9, 0.5]}` (width along x,
  height, depth along z; standing on the floor, or `"elevation"` above it), with `"material"`,
  `"rotation"`, and `"repeat": {"count": 7, "step": [8, 0]}` for a row. Columns, beams, spandrel
  panels, screens and their posts, fins, canopies.
- **`site`**: where the place is on Earth, `{"lat": …, "lng": …, "bearing": …}`: the plan's origin
  and the compass bearing its north (-z, the top of the drawing) faces. Set it with
  `ats space site`; photos taken from known spots are then matched against the model.
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
- Look at `/opt/ats/samples/two-floor-building/plan.json`, and `/opt/ats/samples/sloping-site/`
  for open decks, a ramp, a sloping street and structure.

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

## Working from the outside in

With no floor plan, only photos of the outside (a folder in `inputs/` with a README or manifest,
perhaps a view from above), build the place from the outside in:

1. **Read the folder's README and manifest first.** They say what each picture shows, where it
   was taken from and which way it looks, what to trust, and facts about the place (how many
   floors, how high, what it's made of, where the entrances are). Follow them over guesses.
2. **The footprint, from above.** Rooms are rectangles on the plan's axes, so turn the aerial view
   (or site plan) until the building's main walls run straight across and down:
   `ats space straighten inputs/<folder>/<aerial>.jpg 18` (degrees clockwise; negative the other
   way) writes `preview/plan-<aerial>.png` and says the bearing that gives. Calibrate on that copy
   (turned 0° if it's already straight, so the Architect sees it in the plan editor) as you would
   a floor plan: `ats space scale` with its scale bar or a length you know (a parking bay is about
   2.5 m wide, a traffic lane 3 to 3.5 m), and `ats space origin` at the building's top-left corner.
3. **Put it on the map**: `ats space site LAT,LNG --at PX,PY --bearing B`, where PX,PY is a pixel
   of the calibrated image whose latitude and longitude you know (the centre of a map screenshot
   is where its link or the manifest says; a corner the README gives), or `--plan X,Z` a point in
   metres.
4. **Floors** from the photos taken straight on: count them, and take heights from the README or
   by proportion (a door is about 2.1 m; a storey is about 2.7 m in a house, 3.5 to 4 m in an
   office, 3 m in a car park). On a slope, floors keep their elevations and the ground around is
   outdoor rooms (`"parapet": 0`) that `slope`, so each entrance meets the floor it opens onto.
5. **The shell**: rooms on each floor covering the footprint, walls of the material the photos
   show. Open-sided levels (car parks, galleries, loggias) are outdoor rooms with a `parapet` of
   their real height. Then the openings on every face where the photos show them: entrances,
   windows, open bays.
6. **Structure**: the columns, beams, spandrels, screens and posts that give the building its
   look, with `structure` (and `repeat` for rows).
7. **Match every photo**: `ats space match inputs/<folder>/manifest.json` draws the model from where
   each photo was taken, beside it and laid over it (`preview/match/`; the Architect sees them
   under **Pictures**). Look at every one. Where edges show twice, something's off: the model (a
   floor too high, a face too long, an opening in the wrong place), or the site (everything
   shifted the same way: nudge its latitude, longitude or bearing), or the photo's lens
   (everything too big or too small). When the manifest lacks something (a field of view, a camera
   height) or has it wrong, write `match.json` in the workspace (the same format, your values, with paths from the workspace) and
   match with that. Fix, and match again until they agree. `--quick` for a fast look, `--only 3,7`
   for some.
8. **Inside**, which the photos don't show: what's usual for this kind of building (a car park:
   bays 2.5 by 5 m, aisles 6 to 7 m, a ramp between levels; an office: stairs, lifts and toilets
   in a core), kept simple and consistent with every opening the photos show. Tell the Architect
   plainly which parts are guesses, so they can correct them or add a floor plan.

A manifest the tools read is a list (at its top, or as `images`, `photos` or `shots`) of photos,
each with its `file` (or `filename`), where it was taken (`lat` and `lng`, or `at`: [x, z] in the
plan), `heading` (degrees: 0 north, 90 east), and optionally `pitch` (degrees up), `fov` (the
horizontal field of view in degrees; `vfov` for the vertical one) and `cameraHeight` (metres
above the ground: 2.5 for street views). Anything else in it is notes for you.

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
they give, working from the outside in (above) when it's photos of the outside. The place keeps
it: whoever changes the place next finds it in `inputs/<folder>/`.

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

- Edit anything but `plan.json`, `models/` (your models and their scripts), `match.json`, and
  `trace.json` (through `ats space`).
- Invent rooms or doors that aren't on the plan without saying so.
