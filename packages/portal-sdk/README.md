# @allthespaces/portal

Everything a creation needs to live inside All the Spaces: who's here, playing together, saving,
input on every kind of device, sound, and a few 3D helpers. MIT licensed.

A creation can be anything: a game, a garden to wander, a journal, a toy, a puzzle. Nothing here
decides what it is. Use the parts you need and ignore the rest; 3D is optional.

## Where your creation runs

The app plays each creation in a **sealed frame** on its own origin. That shapes a few rules:

- **No network.** `fetch` works only for files in your own bundle (relative URLs). No APIs, no
  CDNs, no fonts or images from the internet: ship everything in the bundle. The one way out is
  a [connector](#connectors) the server has, which the app calls for you.
- **No cookies, `localStorage`, `sessionStorage` or IndexedDB.** Use `portal.save` and
  `portal.storage` instead.
- **No pop-ups, forms that submit, or navigating away.** Leave with `portal.exit()`.
- **Workers and WebAssembly** work (`blob:` workers, `wasm-unsafe-eval`). `SharedArrayBuffer` and
  threads don't.
- **The app draws one small menu button** (Back, Chat, voice…) in the top-left corner, as a
  faint pane of glass that fades while nothing happens. Keep the top-left 56 × 56 px clear
  (inside `portal.viewport.safeArea`); the rest of the screen is yours.
- **Gamepads** are read by the app and relayed to you. Use `portal.input` rather than
  `navigator.getGamepads()`.
- **Sound** needs one tap inside the frame on most browsers (`portal.audio.unlock()`).

Opened on its own (while you build it with `pnpm dev`), the SDK stands in for the app: you're the
only player, and saves stay in that browser tab.

## Start

```ts
import { connect } from '@allthespaces/portal';

const portal = await connect();              // first, always
portal.progress(0.3, 'Planting trees');      // while the app's veil is up
// … build your world …
portal.ready();                              // lifts the veil: call it once you look right
```

The app shows a soft veil (with your progress) while you load, and plays the transition in and
out. Your creation never needs its own intro fade.

| | |
|---|---|
| `portal.me` | `{ id, name, color }`: you |
| `portal.tier` | `'low' \| 'mid' \| 'high'`: go lighter on `low` (phones, older laptops) |
| `portal.reducedMotion` | The person prefers less motion: calm camera moves and animations |
| `portal.locale` | For formatting numbers and dates |
| `portal.viewport` | `{ width, height, orientation, safeArea, dpr, touch }`, kept up to date |
| `portal.onViewport(fn)` | The screen turned or resized |
| `portal.on('pause' \| 'resume', fn)` | The app is covering you (chat open, tab hidden), or you're back |
| `portal.onExit(fn)` | The person is leaving: save what's unsaved (about 1.5 s) |
| `portal.exit()` | Leave, back to the space |
| `portal.ui.toast(text)` | A short message drawn by the app |
| `portal.ui.requestFullscreen()` | Where the device allows it |
| `portal.ui.preferChatMinimized(true)` | Ask the app to keep chat small (for busy screens) |
| `portal.standalone` | Running on its own, outside the app |

## Every screen, every hand

Every creation must work **in portrait and landscape**, **on touch and on mouse and keyboard**, and
keep working when the phone turns mid-session.

```ts
portal.input.define({ move: 'stick', look: 'stick', jump: { button: 'Jump' }, use: 'button' });

portal.input.stick('move');      // { x, y } from -1 to 1 (W A S D, left gamepad stick, touch joystick)
portal.input.isDown('jump');
portal.input.gamepads();         // the pads themselves ({ index, axes, buttons }), if you read them yourself
portal.input.onPress('use', () => { … });
```

- The first stick gets W A S D and the left gamepad stick; the second gets the arrow keys and the
  right stick. Buttons get Space, E, Q, F, R, Shift in order and gamepad A, B, X, Y and the
  shoulders. Pass `keys` to choose your own.
- Keys typed into a field are left alone, and so are Enter and Space while one of your own
  buttons, links or menus has keyboard focus: they press it, as they would anywhere else.
- On touch screens the SDK draws a joystick and buttons, and moves them when the screen turns.
  `portal.input.showTouchControls(false)` hides them if your creation is all pointer (like the
  journal).
- Pointers (mouse, finger, pen with `pressure` and tilt) are ordinary DOM `PointerEvent`s. Set
  `touch-action: none` on anything you draw or drag on.
- Touch targets are at least 44 × 44 px.

## Playing together

The person chose how to come in: alone, with whoever's there, or with invited people. You don't
manage rooms or connections; `portal.session` is simply whoever is here with you.

```ts
const s = portal.session;
s.players;                         // Person[]
s.onPlayers((players) => { … });
s.isHost;                          // one player is the host; it moves on if they leave

// Shared values: everyone sees the same thing, and newcomers get it on arrival.
await s.set('lantern', true);      // any JSON, up to 32 KB each, 256 KB in total
s.get<boolean>('lantern');
s.onChange<boolean>('lantern', (value, by) => { … });
s.entries('cards.');               // every value whose key starts with 'cards.'

// Messages: quick and forgotten (positions, sounds, emotes). Not sent back to you.
s.send('pose', { x, z, yaw });     // to everyone; add a third argument to send to one person
s.on<{ x: number }>('pose', (body, from) => { … });
```

Send positions about 10 times a second and smooth them on the receiving side (see the painted
garden). Use shared values for anything a newcomer must see: whose turn it is, what's been built,
what's lit.

Ready-made helpers, built on shared values:

| | |
|---|---|
| `s.scores.add(n)`, `.set(n)`, `.of(id)`, `.table()` | Each player keeps their own score, so changes never clash |
| `s.turns.start(order?)`, `.current()`, `.isMine()`, `.next()` | Taking turns; people who left are skipped |
| `s.lobby.setReady()`, `.allReady()`, `.start(seconds)`, `.onStart(fn)` | Get ready, then the host starts a countdown |
| `s.timers.start(name, seconds)`, `.remaining(name)` | Shared countdowns, started by the host |

## Saving

```ts
const portal = await connect({
  save: {
    version: 2,
    // Data saved by older versions of your creation is upgraded when it's read.
    migrate: (old, from) => (from === 1 ? { strokes: old } : old),
  },
});

await portal.save.personal.set('page-1', page);   // just for this person, never seen by anyone else
await portal.save.shared.get('high-scores');      // for everyone in the group
await portal.save.shared.update('visits', (n) => (n ?? 0) + 1);  // read, change, save, retry on clash
await portal.storage.setItem('volume', '0.8');    // a stand-in for localStorage
```

- Values are JSON, up to 256 KB per key.
- Each person can keep up to 64 keys and 2 MB altogether in a creation, separately in `personal`
  and `shared` (a shared key counts for whoever saved it last). Changing a key that's already
  saved never counts as a new one, so use one key per thing (a page, a slot, a board) rather than
  a new key per save. Over a limit, `set` throws a `BridgeError` with `code: 'too-big'` and a
  message you can show the person.
- Up to 120 saves a minute from each signed-in device, which saving a second or so after a
  change stays well under. Faster than that, `set` throws a `BridgeError` with `code: 'denied'` for
  the rest of the minute.
- `set` refuses to overwrite a newer save: if someone else (or a newer version of your creation)
  saved the key since you read it, it throws `StaleSaveError`. Read again, or use `update`.
- When you change the shape of your data, bump `version` and handle the old shape in `migrate`.
  Never break old saves.
- Someone may still be inside an older version when a newer one goes live. If the newer one has
  saved a key in a shape the older one doesn't know, the older one can't read or overwrite it
  (`StaleSaveError`), and the app offers the person to rejoin, which opens the newer version.
- Save as you go (a second or so after a change) and again in `onExit`.

## Sound

```ts
await portal.audio.unlock('Tap to begin');         // the one tap browsers insist on
const bell = await portal.audio.load('./sounds/bell.mp3');
portal.audio.play(bell, { bus: 'sfx', volume: 0.6 });
myNode.connect(portal.audio.bus('ambience'));      // or build your own Web Audio graph
```

Connect every sound to one of the groups (`music`, `sfx`, `ambience`, `voice`, `ui`): the app
fades them when it covers you and when the person leaves, and while people in the session talk
(voice chat, which the app plays itself) `music`, `sfx` and `ambience` dip so they can be heard.
Don't connect straight to `context.destination`.

## 3D (optional)

`three` is a peer dependency. The helpers live in `@allthespaces/portal/three`:

```ts
import { createStage, FirstPersonRig, OrbitRig, gltfLoader } from '@allthespaces/portal/three';

const { renderer, camera, loop } = createStage(portal);   // fills the screen, sized for the device
const rig = new FirstPersonRig(portal, camera, { start: new Vector3(0, 0, 8) });
loop((dt) => {                                            // paused while the app pauses you
  rig.update(dt);
  renderer.render(scene, camera);
});
```

- `createStage` picks the pixel ratio, shadows and antialiasing for `portal.tier`, follows the
  screen as it turns, and widens the field of view in portrait. It also draws fewer pixels while
  frames are slow and more once they're smooth again (`stage.resolution.scale`; pass
  `{ dynamicResolution: false }` to keep it fixed). Your own renderer can do the same with
  `ResolutionGovernor` from `@allthespaces/portal/resolution`: call `frame(ms)` every frame and
  set the pixel ratio from `scale` when it returns true, before you draw (resizing the canvas
  wipes it, so doing it after drawing leaves a black frame).
- `FirstPersonRig`: walk with the first stick; drag (or click to capture the mouse) to look.
- `OrbitRig(camera, target, distance)`: drag to circle, pinch or scroll to zoom.
- Switching scenes or rigs: `stage.dispose()` stops the loop, removes the canvas and lets go of
  the WebGL context; a rig's `dispose()` stops it listening to the pointer.
- `gltfLoader()` loads glTF with meshopt compression.

## Connectors

A **connector** is a service the server's owner set up (for example the book club's lending app),
which your creation can use **as the person playing**, through the app. You never see their
password or token: they link their own account at the service, and the app makes each call for
you, after an Architect approved what your version uses
([docs/connectors.md](../../docs/connectors.md)).

Declare everything you call in `ats.json`. A version that declares connectors waits for an
Architect's approval before it goes live, and calling anything you didn't declare fails:

```json
{
  "title": "Lending desk",
  "connectors": [
    {
      "id": "lanternfield-library",
      "ops": ["listShelves", "getMyLoans", "borrowBook"],
      "why": "Shows the club's shelves and your loans, and lets you borrow a book."
    }
  ]
}
```

```ts
import { ConnectorError } from '@allthespaces/portal';

const LIBRARY = 'lanternfield-library';
const { linked } = await portal.connectors.status(LIBRARY);   // { installed, linked, broken, displayName, scopes, accountName? }
if (!linked) await portal.connectors.link(LIBRARY);           // the app shows its own "Link your account" card

const { data } = await portal.connectors.call<{ shelves: string[] }>(LIBRARY, 'listShelves', {
  params: { page: 1 },                                        // path :params, the rest in the query
});

// Changes need an idempotency key: one per change the person makes, the same one for a retry.
const key = portal.connectors.newKey();
try {
  await portal.connectors.call(LIBRARY, 'borrowBook', {
    params: { bookId: '42' },
    body: { weeks: 2 },
    idempotencyKey: key,
  });
} catch (err) {
  if (!(err instanceof ConnectorError)) throw err;
  if (err.code === 'not-linked') await portal.connectors.link(LIBRARY);
  else if (err.code === 'clash') { /* changed meanwhile: read it again */ }
  else portal.ui.toast(err.message);                          // err.upstream: what the service said
}
```

- `call` resolves with `{ status, data }` (the service's status and JSON answer, at most what the
  operation allows, under 60 KB). It rejects with a `ConnectorError` whose `code` is:
  - `not-linked`: they haven't linked their account, or it needs linking again; offer `link()`.
  - `clash`: the service says it changed in the meantime (409); read it again.
  - `rejected`: what you sent doesn't fit the operation, or the service refused it (other 4xx).
  - `denied`: not allowed (403, a scope their link lacks, or too many calls: 120 reads and 30
    changes a minute).
  - `upstream`: the service is unreachable, slow or failing, or the app is offline (the Studio's
    live preview); try again later.
  - `too-big`: the answer is bigger than the operation allows.
  - `not-approved`: not declared in `ats.json`, or not approved for this version.
  - `trial`: an Architect trying a version that isn't live can read but not change anything.

  `err.upstream` is the service's own `{ status, code?, message?, details? }` when it got that far.
- `status()` may include `accountName`: who the service says they're linked as ("Ada"), when the
  connector asks it right after linking. It's plain text of at most 60 characters, or null (and
  absent from older apps).
- `link()` shows the app's card. If they go ahead, the whole app goes to the service and comes
  back to the space, by your object; they open your creation again. Check `status()` when you
  start, and don't ask again and again.
- Only the live version can call for members. An Architect trying another version can read, with
  their own link, before approving it.
- Every request to the app gives up after 20 seconds (`upstream`).

**While you build it** (`pnpm dev`, on its own), there's no server to call: give made-up answers
to `connect()`. Load them only while developing, so they aren't published:

```ts
const portal = await connect({
  standIn: {
    connectors: import.meta.env.DEV
      ? async (connector, op) =>
          (await import(`../qa/connectors/${connector}/${op}.json`)).default
      : undefined,
  },
});
```

`standIn.connectors` can also be an object, `{ [connector]: { [op]: answer } }`. **The checks**
(`ats qa`, and before publishing) answer from the same files, `qa/connectors/<connector>/<op>.json`,
list every call in the report, and fail a call to anything `ats.json` doesn't declare. An answer
is `{ "status": 200, "body": { … } }` (status defaults to 200), or a list tried in order, the
first whose `match.params` all equal the call's:

```json
[
  { "match": { "params": { "bookId": "409" } }, "status": 409,
    "body": { "code": "ALREADY_ON_LOAN", "message": "Someone in the club has it until Friday." } },
  { "status": 200, "body": { "due": "in two weeks" } }
]
```

## Checks

Every creation is checked before it's published: a clean build, then it's played on phones, a
tablet and a laptop and measured against the budgets. See the
[starter's README](../../starters/creation/README.md#the-checks) for what's checked.

## Examples

`examples/` in the All the Spaces repository has complete creations to learn from:
`explorable-scene` (a garden to walk together), `simulation-sandbox` (a marble table everyone
shares), `vehicle` (paper boats to race) and `close-up-journal` (a private notebook). They're
references, not templates.
