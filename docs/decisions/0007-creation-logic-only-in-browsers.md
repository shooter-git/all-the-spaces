# 7. Creation logic runs only in browsers

Status: accepted, 2026-09-29. Amended by [0010](0010-operator-installed-connectors.md)

## Context

Creations are written by AI coding assistants and can be anything: a game, a simulation, a journal.
The platform can't review that code, so it treats it as untrusted
([security.md](../security.md#creations)). The server holds everyone's accounts, private rooms and
saved data, and should run only trusted platform code.

## Decision

A creation's code runs only in the browsers of the people using it, never on the server.

- A creation is a static bundle, played in a sandboxed frame on its own origin (`play.<domain>`)
  with no network of its own ([architecture.md](../architecture.md#creations-are-cartridges)).
- Identity, multiplayer and saving go through a typed `postMessage` bridge to the app
  ([bridge protocol](../../packages/bridge-protocol/README.md)), which the
  [Portal SDK](../../packages/portal-sdk/README.md) speaks for it.
- Multiplayer uses one generic, trusted `creation` room in `realtime`: shared JSON values, relayed
  messages and a host that moves on when they leave. New server-side abilities arrive only in
  platform releases.
- Building a creation runs none of its code on the server: install scripts are off and the
  platform's own Vite builds it with a fixed configuration.

## Consequences

- A creation can't add server-side logic. Anything that needs an authority (whose turn it is,
  when a countdown starts) is left to the session's host (`s.isHost` in the SDK), which is one of
  the players' browsers.
- Nothing in a creation runs while nobody has it open.
- The bridge is a promise to every creation ever published: messages may be added, never changed
  or removed ([protocol-compat.md](../protocol-compat.md)).
- The frame's limits shape the SDK (spike S4 in [phase-0.md](../spikes/phase-0.md)): no
  `SharedArrayBuffer`, classic blob workers only, gamepads and full screen go through the app, and
  audio starts after a tap inside the frame.
- Saves and shared values are checked on the server against the person's access, size limits and
  the version they're based on, since the creation itself can't be trusted to.
