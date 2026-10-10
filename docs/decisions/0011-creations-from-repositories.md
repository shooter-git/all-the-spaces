# 11. Creations from repositories

Status: accepted, 2026-10-06. Being built: the server's side first ([repositories.md](../repositories.md))

## Context

A creation's source comes from a Studio workspace, where an Architect's assistant writes it, or
from the `creation:publish` command on the server. Some groups already have a web game or toy in
a git repository that they keep working on: it has its own players outside the platform, and new
levels or features keep arriving. They want it on an object in their space too, without copying
files across by hand every time it changes, and without the copy in the space falling behind.

A repository is someone else's code, just as an assistant's is. The platform already treats every
creation as untrusted ([0007](0007-creation-logic-only-in-browsers.md)): its source is
snapshotted, scanned for secrets, its assets' licences checked, built with the platform's own Vite
and no install scripts, and played on a phone, a tablet and a laptop before it can go live. What's
missing is a way to take that source from a repository, and to know when the repository moved on.

Three ways were weighed:

1. **A connector to the repository host.** Connectors are calls a creation makes while someone
   plays, as that person ([0010](0010-operator-installed-connectors.md)). Fetching source is an
   Architect's action on the server, made once per version, not per player. It's the wrong shape.
2. **The repository pushes builds** (its CI calls the platform with a token). Every repository
   would need a pipeline and a secret for every server it's on, and a server's owner couldn't see
   or limit what arrives.
3. **The server fetches the repository**, at one commit, and puts it through publishing as it is.

## Decision

The server fetches a repository's source at one exact commit and publishes it through the same
pipeline as any other creation. Nothing about checking, building or playing a creation changes.

- **What qualifies.** A repository (or a folder in it) whose root is a creation project:
  `ats.json`, `assets.lock.json`, `package.json` and an `index.html` the platform can build. The
  publishing checks decide the rest, with the same report an Architect already reads. A repository
  that isn't shaped like one yet can be opened in a Studio workspace instead, where the Architect's
  assistant adapts it.
- **The server's owner allows the hosts.** A definition file per host, outside the app, as for
  connectors: the host (GitHub, a Gitea or Forgejo server, GitLab), which repositories may be used
  (owners or exact names), and for private repositories the environment variable holding a
  read-only token (`ATS_SOURCE_…`). Nothing is allowed by default. The token is never sent to
  browsers, sandboxes or creations, and never shown in the app.
- **Fetching** is one archive of one commit, through the host's own API, by the server: addresses
  from the definition only, resolved once and pinned (no private addresses unless the owner allows
  them), redirects only to the host's own archive address, a deadline, and the snapshot limits
  (4,000 files, 300 MB, no links, no file names that climb out of the folder). Submodules and Git
  LFS files aren't fetched. No code from the repository runs while fetching or building.
- **A creation remembers where it came from**: the host, repository, folder, what it follows and
  the last commit it was built from. Each version records its commit, so the Studio can say
  "built from owner/repo at a1b2c3d" and show what changed between two versions.
- **What it follows** is chosen per creation: the newest release (tags), the newest commit on a
  branch, or one commit (pinned). Releases is the default, so work in progress doesn't reach the
  space.
- **Updating is a button.** The Studio shows how many commits or which release are newer than the
  live version. **Update** fetches that commit and starts a publish. The live version stays live
  while it's checked; the new one becomes a candidate to try (the default) or goes live straight
  away, as the creation's setting says. People already inside finish on the version they started,
  and going back is one click, as for every creation.
- **Noticing updates** without the button: the server checks each followed repository about once
  an hour (a conditional request, so an unchanged one costs nothing), and a host may also call a
  webhook, signed with a secret per creation, which only makes the server check sooner. Neither
  ever publishes past the creation's setting.
- **Every update is fully checked.** A small change is quick because sources are stored by
  content (unchanged files aren't uploaded again) and models and sounds already made lighter are
  reused by hash, not because checks are skipped. A version that fails leaves the live one as it
  is, and the Architects are told, with the report.
- **One source of truth.** A creation that follows a repository is changed in the repository.
  Opening it in the Studio to improve it detaches it first: from then on it's an ordinary creation,
  and the repository is left alone. The platform never writes to a repository.

## Consequences

- A creation's code can now come from outside the platform without anyone copying it in. The
  trust is unchanged: the code is checked and sealed exactly as an assistant's would be, and
  connectors it declares still need an Architect's approval for each version.
- The server makes outbound requests to repository hosts, only those in definitions the owner
  wrote, with the same protections as connector calls.
- Read-only tokens for private repositories are kept in the server's environment, like connector
  secrets. A token that can read more than the repositories the definition allows is the owner's
  choice; the platform only ever asks for the ones it allows.
- Saves outlive versions already: a new version reads what older ones saved, so a repository's
  creation must version the shape of what it saves and upgrade older shapes (`save.version` and
  `migrate` in the SDK). A game that adds levels keeps everyone's progress.
- A project that is also a standalone web app has to be buildable by the platform as it is: one
  `index.html`, no scripts written inside pages, and files loaded at run time referenced in a way
  the bundler can see (`new URL('./file', import.meta.url)`). These work the same when the app is
  served on its own, so the repository can keep one copy of its code for both.
- Hourly checks and webhooks are new background work on the server, one cheap request per
  followed repository per hour.

## Security model

| Threat | What stops it |
|---|---|
| Malicious code in a repository | Treated like any creation: no code runs while fetching or building, the bundle is checked and played sealed, with no network |
| Secrets committed to a repository | The snapshot's secret scan refuses the version before anything is stored |
| An Architect pulling any repository on the internet | Only hosts and repositories in the owner's definitions |
| A token leaking | Kept in the server's environment only, read-only, never sent to browsers, sandboxes or creations |
| Archive tricks (links, `..`, huge or numerous files) | The snapshot's rules: no links, safe names only, file count and size limits counted while unpacking |
| Server-side request forgery, DNS rebinding | Definition addresses only, resolved once and pinned, private addresses refused unless allowed, redirects only to the host's archive address |
| A forged webhook | Signed with a per-creation secret, checked in constant time; a valid one only makes the server check sooner |
| A broken or oversized push reaching everyone | Every update is fully checked; a failure leaves the live version; the default lands as a candidate |
| A new version quietly using more | Connector use is still approved per version, and a failing budget check refuses it |
