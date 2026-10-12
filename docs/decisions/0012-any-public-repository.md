# 12. Any public repository, as the owner's choice

Status: accepted, 2026-10-11. Amends [0011](0011-creations-from-repositories.md).

## Context

[0011](0011-creations-from-repositories.md) lets a creation come from a git repository, but only
from repositories the server's owner listed, one by one or by owner, in a definition file on the
server, read when the server starts. Each new project means a file edit and a restart, by someone
with the server's shell. Groups that want to bring in public games and toys as they find them
can't, and the owner becomes a bottleneck for something the platform doesn't need them for.

Look at what the list protects. Whatever a repository holds, its code is treated like an
assistant's: snapshotted, scanned for secrets, its assets' licences checked, built by the
platform's own Vite with no install scripts, played on three devices, and run sealed in a frame
with no network. None of that depends on the list. What the list decides is **whose** work can
land on the server. That's a real choice, but it's the owner's to make, and "anyone's public
work" is a reasonable answer to it.

Private repositories are different: reading one needs the owner's token, and a token can often
read far more than the projects meant for creations. That must never widen by accident.

And the app had no idea who the owner is. Architects run their group; the owner is whoever has
the server's shell.

## Decision

- **`*` means any public repository** on a host, in a definition file or in the app.
- **The server has an owner in the app**: the account made with the installer's one-time setup
  code (which only someone on the server can see), or whoever `ats-admin owner EMAIL` hands it to,
  on the server, since. Servers set up before this take whoever finished setup. Only the owner
  sees or changes server-wide settings in the app; a group's other Architects see who it is.
- **The owner chooses in the app** (Your group → Server), and it counts straight away, with no
  file and no restart:
  - a **built-in GitHub host** (github.com, public addresses only, never a token), **off until the
    owner switches it on**, with its own list: some repositories, or `*`;
  - repositories **added to hosts in files**.

  This is stored with the install (backed up with the database), checked with the same patterns
  as files, and recorded in every group's Activity. Tokens, the API's and archives' addresses and
  private networks stay in files: the app can't name a token, reach another address, or allow a
  private network.
- **Two ways to read a repository, and only two.** With the host's token, when the host has one
  and its **definition file** names the repository (`owner/name` or `owner/*`): as 0011. Anything
  else the owner allows (`*`, and everything added in the app, even by name) is read **as a
  public repository**:
  - no token is sent at all, so the host itself can't hand over a private repository, even if
    one turns private between two requests;
  - before every look and every fetch, the host must say the repository is public
    (`private: false`, and `visibility: public` when it says);
  - a private repository gets, word for word, the answer a missing one gets.
- **GitHub's hourly allowance.** Without a token GitHub allows 60 requests an hour from one
  address (an answer that hasn't changed counts too). The server keeps what GitHub says is left,
  for each API and way of asking: a used-up allowance is refused at once ("resets in 12 minutes")
  without asking again, and the hourly looks stop while fewer than 10 are left, keeping those for
  Architects' own Check, Update and linking. A look costs 2 to 4 requests (whether it's public,
  the release, its commit, and the comparison only when something changed), so about 15 public
  repositories are looked at hourly; with more, looks come less often instead of failing. With a
  token, unchanged answers are asked for by ETag and don't count.

## Consequences

- An owner can open the server to any public repository with one switch, or keep the list as
  narrow as before. Nothing is allowed by default: the built-in host starts off, and a file has
  to name what it allows.
- Architects can bring in someone else's public project without asking the owner each time. The
  owner can't review each one first; every version is still checked, and lands as a candidate
  unless the group chose otherwise.
- A token is used for exactly what the owner's files name. Adding a repository in the app, or
  `*` in a file, never lets the token read anything more.
- The owner is one account. If it's removed, nobody owns the server in the app until
  `ats-admin owner` names another; files keep working either way.
- Hosts are put together for each request and each background look (the files' part read at
  start, the app's part from the database), so a change is never stale.
- A public repository costs one more request per look and per fetch (asking whether it's public).
  Many followed public repositories are looked at less often than hourly without a token.

## Security model

0011's table, with what changed:

| Threat | What stops it |
|---|---|
| Malicious code in a repository | Unchanged: treated like any creation. No code runs while fetching or building, the bundle is checked and played sealed, with no network |
| Secrets committed to a repository | Unchanged: the snapshot's secret scan refuses the version before anything is stored |
| An Architect pulling any repository on the internet | Only what the owner allows: hosts and repositories in files, or chosen in the app by the server's owner (not a group's Architects). Any public repository only when the owner chooses it (`*`), and then still checked, built and played sealed like every creation, landing as a candidate unless the group chose otherwise |
| `*` reaching a private repository | No token is ever sent for it, so the host shows only public repositories; the host must say it's public before every look and fetch; a private repository is answered exactly like a missing one |
| A token reading more than the owner meant | Used only for repositories its definition file names; never for `*` or anything added in the app |
| Changing what's allowed without being the owner | Only the owner's account (set by the setup code, or on the server with `ats-admin owner`); every change checked on the server and recorded in Activity |
| A token leaking | Unchanged: kept in the server's environment only, read-only, never stored in the database, sent to browsers, sandboxes or creations, or shown in the app |
| A repository name climbing out of the API address (`x/..`) | Names made only of dots are refused, in files, the app and Architects' requests alike |
| Archive tricks (links, `..`, huge or numerous files) | Unchanged: no links, safe names only, file count and size limits counted while unpacking |
| Server-side request forgery, DNS rebinding | Unchanged: addresses from files or the built-in github.com only, resolved once and pinned, private addresses refused unless a file allows them, redirects only to the archive address |
| Running out of GitHub's allowance | Kept count of; refused without asking once used up; hourly looks leave the last 10 for Architects |
| A forged webhook | As 0011 designed it (webhooks aren't built yet): signed with a per-creation secret, checked in constant time; a valid one only makes the server check sooner |
| A broken or oversized push reaching everyone | Unchanged: every update is fully checked; a failure leaves the live version; the default lands as a candidate |
| A new version quietly using more | Unchanged: connector use is still approved per version, and a failing budget check refuses it |
