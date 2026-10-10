# Protocol and SDK compatibility

A creation is built once and kept: the version an Architect published keeps running, unchanged, for
as long as the space has it. So every host (the app, and the checks' browser) must keep working
with every creation ever published. These are the rules that make that true.

## The versions

| Version | Where it lives | What it means |
|---|---|---|
| Protocol version | `PROTOCOL_VERSION` in `@allthespaces/bridge-protocol`; `v` in every message's envelope | The shape and meaning of the messages between host and creation |
| SDK version | `@allthespaces/portal`'s `package.json` (`SDK_VERSION`, sent in `hello`) | The library a creation was built with |
| Save version | The creation's own `save.version` (sent in `hello` as `saveVersion`) | The shape of the data the creation saves, upgraded by the creation itself |

Each published version of a creation records all three (`creation_versions`: `sdk_version`,
`protocol_version`, `save_version`). Creations are always built against the server's own copy of
the SDK, so a server's creations never have a newer protocol than the server itself, except one
imported from a newer server (see below).

## Changing the protocol

**Additive changes keep the version.** Within a protocol version you may:

- add a new message type, in either direction;
- add an optional field to an existing message;
- loosen a limit or accept more values than before.

Both sides already ignore what they don't know: the host drops message types it doesn't recognise
(`readCreationMessage`), and the SDK ignores host messages it has no handler for. That's how `duck`
(lower the sound while people talk) was added after version 1 without breaking older creations.

**Never, within a version or across them:**

- remove or rename a message type or a field;
- make an optional field required, or change a field's type, units or meaning;
- tighten checks on anything an existing creation sends (a host that started refusing a valid
  version 1 `save:set` would break every creation that saves).

The limits on saving are part of version 1, as the
[SDK README](../packages/portal-sdk/README.md#saving) states them: 256 KB a value; 64 keys and
2 MB altogether per person, creation and scope; 120 saves a minute from each signed-in device.
They may be loosened, never tightened.

## When the version goes up

Only when a change can't be additive: an existing message has to mean something different. Then:

1. Raise `PROTOCOL_VERSION`. Messages carry the sender's version in their envelope (`v`).
2. The host keeps handling older messages the old way, choosing by the envelope's `v` (or the
   version recorded for the creation). Support for a version is never removed.
3. Freeze the new version, as version 1 is: a transcript of every message type it sends, and a
   small creation built with it (see below).
4. Note the change and the version here.

## A creation newer than its host

A creation exported from a newer server and imported into an older one can carry a higher protocol
version than the host knows. Today the host accepts its messages (any `v` of 1 or more), handles
the types it knows and ignores the rest. Because changes within a version are additive, that
works as far as the older host's features go. Once a version 2 exists, importing such a creation
should say that the server needs updating first.

## What keeps this honest

- `packages/bridge-protocol/test/fixtures/v1-creation-messages.json`: every message a version 1
  creation (SDK 0.1.0) sends, frozen. The host's checks must accept every one of them
  (`packages/bridge-protocol/test/compat.test.ts`). Messages added within version 1 later get a
  frozen file of their own: `v1-connector-messages.json` (SDK 0.2.0).
- `packages/qa-browser/test/fixtures/creation-v1/`: a small creation built with SDK 0.1.0, its
  source and its built files. The built files are never rebuilt: they must keep playing in the
  checks' browser host without a failure (`QA_BROWSER=1 pnpm --filter @ats/qa-browser test`, run
  in CI), and the source must keep passing the source checks (`packages/qa/test/compat.test.ts`).

Never edit a frozen fixture to make a test pass: a failure there means published creations would
break.

## Version history

| Protocol | SDK | What changed |
|---|---|---|
| 1 | 0.1.0 | First version. Later additions within it: `duck` (host to creation). |
| 1 | 0.2.0 | Connectors, added within version 1: `connector:call`, `connector:status` and `connector:link` (creation to host); result codes `not-linked`, `not-approved`, `trial`, `clash`, `rejected` and `upstream`; an optional `details` on a failed `result`. The SDK gives up on a request after 20 s (`upstream`), so an older host that ignores these messages doesn't leave it waiting. |
