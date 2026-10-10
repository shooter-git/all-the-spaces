# Security

## Principles

1. **Platform code is trusted; AI-written and third-party code is not.** Untrusted code only ever
   runs inside a sandboxed browser frame (creations) or a gVisor sandbox container (Architect work).
2. **Private by default.** Spaces are visible only to their group. Room visibility is enforced on the
   server: restricted rooms are never sent to someone who can't see them.
3. **Least privilege.** Data services have no internet access; containers run read-only, without
   extra Linux capabilities and without privilege escalation.

## AI assistant credentials

Architects sign in to their AI coding assistant (Claude Code or Codex) **through the assistant's own
official sign-in flow**, inside a sandbox container. The resulting credential files:

- live on a dedicated Docker volume per Architect and per assistant;
- are mounted **only** into that Architect's sandbox containers;
- are **never** mounted into, read, copied, logged, exported, backed up or transmitted by any
  platform service (server, realtime, worker, supervisor, preview, builder, QA);
- are never in backups: a backup holds only the database dump, the stored files (read through the
  storage API) and the settings files, and never reads a Docker volume. The optional off-site copy
  uploads exactly those backup folders, nothing else.

The sign-in is shared by all of an Architect's workspaces, but each workspace's conversations
with its assistant are its own: a volume per workspace over the folders where the assistant keeps
them (Claude Code's `projects`, Codex's `sessions` and `memories`, and Codex's index of them).
Every workspace is at `/workspace`, so without that, carrying on in one workspace could pick up
the conversation, or what the assistant remembered, from another.

Terminal sessions between the browser and the sandbox are relayed without being logged, stored or
inspected. The platform has no input field for assistant credentials, tokens or login codes.

These rules are enforced structurally (volume isolation, a single allow-listed service that may
start sandboxes) and by automated tests. See [compliance.md](compliance.md).

In the optional API-key mode ([self-hosting](self-hosting.md#api-key-mode-optional-off-by-default)),
the server owner's keys live in `api-keys.env`, read only by the supervisor, which puts the key for
an assistant into that assistant's sandboxes. Like a sign-in, it's visible to the assistant and to
code running in its sandbox (which can only reach allow-listed hosts); a spending-limited key keeps
the worst case small.

## Voice chat

A voice pass (LiveKit) is handed out by the real-time service, which knows where everyone is: only
for the room you're standing in and may see (or the creation session you're in, never a session on
your own), for ten minutes, for the microphone only. Moving to another room takes you out of the
old room's voice; a privacy change takes out everyone who may no longer see a room; an Architect
turning voice off ends every conversation at once. Creations never receive anyone's sound: the app
plays it, outside the creation's frame. Nothing is recorded.

## Accounts and invites

- Sign-up is only possible with a valid invite link. Invite tokens travel in the URL fragment so they
  never reach server logs; only their hash is stored.
- When the server can send email (`SMTP_URL`), everyone confirms their email address before they
  can sign in with their password: signing up (or signing in unconfirmed) sends a link that works
  for 24 hours. Email notifications go only to confirmed addresses, so nobody can point them at
  someone else's mailbox, and People shows Architects any address that isn't confirmed yet. The
  first Architect, made by the setup wizard with the setup code, counts as confirmed. Without email,
  addresses aren't confirmed and nothing is emailed.
- The one-time setup code is printed by the installer, stored only as a keyed hash, and stops
  working once setup is finished.
- Limits per address (setup code tries, invites, requests, devices) go by the address the
  installer's Caddy saw. An address a client names itself in `X-Forwarded-For` is ignored.
  [Behind another reverse proxy](self-hosting.md#behind-an-existing-reverse-proxy), Caddy takes
  the address that proxy passes on, but only from the addresses in `ATS_TRUSTED_PROXIES` (private
  networks and loopback by default), reading `X-Forwarded-For` from the right so that what a
  client wrote there itself is still ignored.
- Consequential actions are recorded in an audit log that never contains secrets or terminal content.

## Requests and notifications

- **Asking only writes a row.** A member's request is checked against what they can see (an object
  or room they can't see is answered as if it didn't exist) and the room's rule on who may ask. Each
  person can have at most 10 open requests per group, and asking is rate-limited.
- **Pictures** that come with a request are decoded and saved again as plain JPEGs (no location,
  camera or other hidden details), and only the member and the group's Architects can fetch them.
- **Documents** that come with a request (Markdown or text, up to three of 50,000 characters) are
  kept as text and only ever served back as `text/plain` with `nosniff`, so a browser never runs
  them as a page. Only the member and the group's Architects can fetch them.
- **Push notifications** go only to the browsers' own push services (Google, Mozilla, Apple,
  Microsoft) over HTTPS: a device registering any other address is refused, so the server can't be
  made to send requests inside its own network. Each device's messages are encrypted for it
  (Web Push), and signed with this server's own key pair, whose private half is sealed with the
  server secret.
- **Notification links** lead only within the app.

## Creations

Creations are written by AI coding assistants, so the platform treats them as untrusted. They only
ever run in people's browsers, never on the server, and each one is sealed off:

- **Its own address.** Creations are served from `play.<domain>`, a different origin from the app,
  at `/c/<token>/…`. The token is signed, names one person, one creation and one version, and
  expires. Every file request re-checks that the person can still open the creation (within 2 s of
  a change), so taking someone's access away or hiding the room stops it straight away.
- **No origin at all.** The frame is `<iframe sandbox="allow-scripts allow-pointer-lock">`
  (never `allow-same-origin`), and the server repeats that sandbox in the page's own security
  policy, so the page is sealed even if opened directly. Its origin is `null`: it has no cookies
  or storage, and can't reach the app's pages or API.
- **No network except operator-installed connectors, via the host.** The security policy lets it
  load only its own files (not even another creation's), plus `blob:` workers and WebAssembly. No
  other address, no form submissions, no navigating the top page, no pop-ups. `frame-ancestors`
  lets only the app embed it. The one way out is a **connector**
  ([connectors.md](connectors.md), [0010](decisions/0010-operator-installed-connectors.md)). The
  server's owner installs one, the creation declares the operations it uses, and an Architect
  approves them for each version. The app then calls the service for the creation, as the
  person playing, with their own linked account. The server checks every call: the live version
  (an Architect's trial may only read), declared and approved, the link's scope, the operation's
  schema, and a per-minute allowance. It calls only the definition's address, pinned and never
  private unless the owner allows it, with no redirects, a deadline and a size cap. Tokens are
  sealed on the server and never reach the browser. The only call no creation asks for is the
  link check: right after someone links, the one read (a `GET` with nothing to fill in) the owner
  named in the definition, as them, the same way.
- **Everything through the bridge.** Identity, multiplayer and saving go through `postMessage`
  to the app, which validates every message ([bridge protocol](../packages/bridge-protocol/README.md)):
  unknown or oversized messages are dropped, identity always comes from the app, and every save
  and shared value is checked on the server against the person's access and size limits (each
  person's saved data in a creation is capped in keys and bytes, and saving is rate-limited).
- **The app's controls stay on top.** Its menu (Back, Chat…) is drawn by the app outside the frame. The
  frame isn't allowed to go full screen itself: a creation asks the app, which puts the whole page
  full screen, controls included. If the creation stops answering the app's pings for 5 s, the app offers to leave, and leaving never
  waits more than 2 s for the creation.
- **Multiplayer rooms are generic.** One trusted session room type relays creation messages; the
  sender is stamped by the server from the person's ticket. Solo and invite sessions can't be
  joined by anyone else.

**Building a creation runs none of its code on the server.** Its dependencies are installed with
install scripts and hooks switched off, and only as published npm version ranges (no git, file,
link or URL dependencies; npm settings files are removed). It's built by the platform's own Vite
with a fixed configuration: the project's Vite, PostCSS, TypeScript and `.env` settings are
ignored, so its code and packages are only read and bundled. Each step runs in its own
short-lived container started by the supervisor, with no secrets or credentials: installing the
dependencies goes out only through the egress proxy, and building and playing it has no network at
all. The server only receives the report and the built files. (A development server without the
supervisor runs the same steps as child processes, with no secrets in their environment.) Playing
it for the checks happens in headless Chromium inside the same sealed frame as in the app, with
every request outside the creation's own files refused.

`node tools/dev/security-check.mjs` checks all of this against the dev stack with two misbehaving
fixture creations (`tools/dev/fixtures/`): one tries every way out, one freezes. The frozen-creation
check relies on the browser running the sealed frame in its own process, which Chromium does;
Safari and Firefox need checking on real devices.

## The Studio: Architects' AI assistants

An Architect's AI assistant writes and runs code, so everything it touches is treated as
untrusted and kept in containers the platform starts from fixed templates:

| Container | What it can reach | What's mounted |
|---|---|---|
| **Sandbox** (one per workspace, while awake) | Only the egress proxy | The workspace and its own conversations with the assistant; the Architect's own tools and sign-in for the assistant in use |
| **Connect** (installing and signing in) | Only the egress proxy | The Architect's own tools and sign-in; no workspace |
| **Live preview** | Nothing (no network) | The workspace, read-only |
| **Checks before publishing** | Installing: the egress proxy. Building and playing: nothing | A scratch copy of the source; no sign-ins |
| **Lighting bake** (one per room, a few at a time, while a place is built) | Nothing (no network) | The build's room inputs and the sky, read-only; one folder to write the lightmap to; no workspace or sign-ins |

- **Every one** runs as an unprivileged user, with a read-only system, no Linux capabilities, no
  privilege escalation, limits on CPU, memory and processes, and under **gVisor** in production.
- **The supervisor** is the only service with access to Docker. It accepts only a small set of
  actions, each with a one-minute ticket signed by the server for one workspace or Architect; it
  never lets a caller choose an image, mount, network or capability, and never touches containers
  it didn't create. It logs what it did and for whom — never files or terminal traffic. Still,
  it holds the Docker socket: whoever took it over would control every container on the server,
  so services sharing that server (or that Docker) with All the Spaces are only as safe as it is.
- **The egress proxy** is the only way out of a sandbox: HTTPS to allow-listed host names (the
  assistants' makers, npm, free asset libraries, GitHub's files, reference pictures and docs),
  without looking inside the connection. Sandboxes have no DNS of their own, and a name with any
  private address (private networks, loopback, link-local, NAT64 and the other special-purpose
  ranges) is refused. What it blocks is shown to the Architect (only for their own
  workspace).
- **Open internet** (a group setting, off by default): the group's workspaces may reach any public
  host name over HTTPS. Each one gets a pass, signed by the supervisor with a secret it shares only
  with the egress proxy (`EGRESS_SECRET`), as its proxy password. Private addresses stay refused,
  nothing is looked inside, and creations still never use the internet. The trade-off: a web page
  could mislead an assistant into fetching or running something it shouldn't, with access to the
  workspace and the assistant's own sign-in. That's why it's the group's choice. Claude Code's
  automatic check for the Architect's claude.ai connectors (`mcp-proxy.anthropic.com`) stays
  blocked either way (`deploy/egress/deny.txt`, which beats the allow-list and a pass): a
  workspace never gets a way into the Architect's other accounts.
- **Sign-ins** (C4 in [compliance.md](compliance.md)) stay in a volume per Architect and assistant.
  The platform never reads them — it only checks that one exists.
- **The terminal** is relayed byte for byte, never logged, stored or inspected.
- **The Studio reads only what it needs from a workspace:** a place's plan, its calibration and
  the overlay images, and writes only the plan (from the plan editor); it runs only two fixed
  commands there (`ats space overlay`, `ats space check`). Building a place reads the plan, checks
  it against the plan schema, and builds it with the platform's own builder; its lighting is baked
  in the lighting-bake containers above, which run only the builder's own `bake_room.py`.
- **Checkpoints:** when a workspace goes to sleep, once its sandbox is gone, the supervisor commits
  whatever isn't committed into the workspace's own git history, in a helper that has only the
  workspace (no network, no sign-in), without the workspace's git hooks. A place's plans and
  photos (`inputs/`) and the Architect's uploads are never committed. The history never leaves the
  workspace: publishing copies the source without it.
- **Publishing never trusts the sandbox.** The supervisor copies the workspace's source (not its
  builds or dependencies); it's checked for secrets before it's stored, then installed and built
  from scratch in the check containers above.
- **Importing a creation** exported from another server checks its source and its built files for
  secrets before anything is stored, and stops unpacking the file past 300 MB. Its built files
  weren't built or checked here, so its version is marked as not checked on this server, and the
  Studio says so.
- **Creations from repositories** ([repositories.md](repositories.md),
  [0011](decisions/0011-creations-from-repositories.md)) are fetched by the server from hosts and
  repositories the server's owner listed, one commit's archive at a time: addresses resolved once
  and public only (unless the owner allows otherwise), a deadline and a size cap, and a redirect
  followed only to an archive address the definition names. A host's read-only token goes to its
  API only, never to the archive address, a browser, a sandbox or a creation. Only regular files
  are kept (links are dropped), names and sizes are checked as for any source, and a commit holding
  anything that looks like a secret is refused before anything is stored. Its code then goes
  through the same checks as an assistant's: no install scripts, the platform's own build, played
  sealed.

**What remains:** an assistant's own programs run as the same user as the assistant, so code it
runs could read its sign-in. That's inherent in running the assistant at all, and it's why
sandboxes can only reach allow-listed hosts and install scripts are switched off. On a development
machine the sandboxes use Docker's standard runtime unless gVisor is set up. Workspaces don't yet
have a fixed disk quota.

## Reporting problems

See [SECURITY.md](../SECURITY.md).
