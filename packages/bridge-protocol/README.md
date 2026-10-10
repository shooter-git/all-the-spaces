# @allthespaces/bridge-protocol

The messages between an All the Spaces host page and a creation running in its sealed frame. MIT
licensed.

Creations use [`@allthespaces/portal`](../portal-sdk/README.md), which speaks this protocol for
them; you only need this package to write a host, or to check messages.

- Every message is wrapped as `{ ats: 'bridge', v, msg }` and sent with `postMessage`.
- `readCreationMessage` and `readHostMessage` validate incoming messages and return `null` for
  anything malformed, oversized (over 64 KB) or unknown. Never act on a message they reject.
- Identity always comes from the host. A creation can't say who it is or who sent something.
- Versions only grow: a host supports every protocol version ever released, so old creations keep
  working.

## Connectors

A creation has no network, but it can ask the host to call a **connector**: a service the
server's owner installed ([docs/connectors.md](../../docs/connectors.md)), as the person playing.
Added within protocol 1 (SDK 0.2.0):

| Creation → host | Answer (`result`) |
|---|---|
| `{ type: 'connector:call', id, connector, op, params?, body?, idempotencyKey? }` | `{ status, data }`: the service's HTTP status and JSON answer |
| `{ type: 'connector:status', id, connector }` | `ConnectorStatus`: `{ installed, linked, broken, displayName, scopes, accountName? }` (`accountName`: who the service says they're linked as, when known) |
| `{ type: 'connector:link', id, connector }` | Nothing, once the host shows its own card offering to link |

- `connector` is the connector's id (`a-z`, `0-9`, `-`, 2 to 32), `op` an operation name, `params`
  a JSON object, `idempotencyKey` 8 to 80 of `A-Z a-z 0-9 _ -` (needed for writes).
- A failed `result` carries a `code` (`ResultCode`): `not-linked`, `not-approved`, `denied`,
  `trial`, `clash`, `rejected`, `upstream` or `too-big`. A failed call that reached the service has
  `details`, an `UpstreamError` (`{ status, code?, message?, details? }`).
- `ConnectorFixture` and `fixtureAnswer` let a stand-in host (the checks, the SDK on its own)
  answer calls from made-up answers.
- The host must check everything again: the creation can only ask.
