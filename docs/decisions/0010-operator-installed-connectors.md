# 10. Operator-installed connectors

Status: accepted, 2026-10-04. Amends [0007](0007-creation-logic-only-in-browsers.md).

## Context

[0007](0007-creation-logic-only-in-browsers.md) keeps creations sealed. They run only in
browsers, in a frame with no network, and reach the app only through the bridge. That keeps
AI-written code away from everyone's accounts and data.

Some groups already run a web service of their own, such as a club's lending app or a team's
rota, and want to use it from inside their space, as a creation. Each person who uses it has an
account there. Giving creations raw network access would undo 0007. Building each service into
the platform is not something a self-hosted project can do.

## Decision

Creations still have no network. The app makes calls for them, and only calls that four
different parties agreed to:

- **The server's owner installs a connector**: a definition file
  ([docs/connectors.md](../connectors.md)) naming the service, its OAuth client, and each
  operation. An operation has its method, path, schemas for what may be sent, the scope it needs,
  whether it reads or writes, and a cap on its answer. Only the owner can add one, and only
  outside the app.
- **A creation declares** in its `ats.json` which connectors and operations it uses, and why.
- **An Architect approves** that use for each version before it goes live. A version that
  declares connectors waits as a candidate until then. Approvals never travel with an export.
- **Each person links their own account** at the service (OAuth with PKCE). Every call is made as
  them, with their own token, which never leaves the server.

The creation sends `connector:call` over the bridge. The app forwards it to the server, which
checks, in order:

1. the person may open the creation, and the version is the live one (or an Architect's trial,
   which may only read);
2. the operation is declared and approved;
3. the connector is installed, and the person's link has the operation's scope;
4. what's sent fits the operation's schemas;
5. the person's per-minute allowance.

Only then does it call the service. The call carries a fixed, minimal set of headers, follows no
redirects, uses a connection pinned to an address checked once (no private addresses unless the
owner allows them), has a deadline, and accepts only JSON up to the cap. Only a cleaned-up error
comes back.

## Consequences

- A creation can now read and change things outside the platform, as the person playing.
  The trust is in the owner's definition and the Architect's approval, not in the creation's
  code: it can still only call what was declared and approved, with the schema's values.
- The server makes outbound requests on people's behalf. It does so only to addresses in
  definitions the owner wrote, pinned so DNS can't move them, and refuses private addresses by
  default.
- People's tokens at other services are now kept on the server, sealed with the server secret,
  so they're in backups of the database. A refresh token that never expires lasts until it's
  unlinked or revoked at the service.
- The services see calls from the server, not from people's browsers. A service must check every
  token and its scopes itself; the platform's checks are on top of the service's, never instead
  of them.
- The bridge gained messages (`connector:call`, `connector:status`, `connector:link`) and result
  codes, additively within protocol 1 ([protocol-compat.md](../protocol-compat.md)).
- What a creation shows from a service is only as fresh as its last call. Nothing is cached or
  shared between people.
- A definition may name a **link check** (`linkCheck`): one read the server makes as the person
  right after they link. It's the only call no creation asked for, and it can only be a `GET`
  read with nothing to fill in. It proves the link works, shows who they're linked as, and lets a
  service that records connected apps on first use see the link at once. An account the service
  refuses (401 or 403) is unlinked straight away.

## Security model

| Threat | What stops it |
|---|---|
| A creation calling anything it likes | No network in the frame; the server calls only declared, approved operations of installed connectors, with schema-checked values |
| A creation using someone else's account | Calls always use the signed-in person's own link; identity comes from the app's session, never from the creation |
| Path or query tricks (`..`, `/`, encoded separators) | Path parameters must match the definition's pattern, and are refused if empty, `.`, `..` or containing `/ \ ? # %`, then percent-encoded; the final address must stay under the base URL |
| Server-side request forgery, DNS rebinding | Only definition addresses; resolved once, private addresses refused unless allowed, the connection pinned to the checked address; no redirects |
| Linking someone else's account (login CSRF) | One-time `state`, stored only as a hash, 10 minutes, bound to the person who started it; PKCE (S256) |
| Open redirect after linking | Only same-origin app paths (never `//`, `\` or the API) are accepted to return to |
| Stolen tokens | Sealed at rest with a key per link; never sent to browsers; refreshed and revoked by the server only |
| Large or slow answers | Byte cap counted as it streams, a deadline, JSON only |
| Leaking service internals to a creation | Only `{status, code, message ≤ 200, details ≤ 2 KB}` passes through |
| A new version quietly using more | Approval is per version and per operation; a member can act only through the live version |
| Too many calls | 120 reads and 30 writes a minute per person and connector |
