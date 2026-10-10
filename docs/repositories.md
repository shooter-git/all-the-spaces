# Creations from repositories

A creation can come straight from a git repository: a game, toy or tool someone keeps working on
in a repository of its own, which may also run on its own somewhere else. The creation **follows**
the repository: when there's a new release (or a new commit on a branch), Architects see it and
press **Update**, and the new version goes through the same checks as any creation's before it
can go live. Why it works this way is in [ADR 0011](decisions/0011-creations-from-repositories.md).

Nothing is allowed by default. Without a repository host, creations come only from the Studio.

## What a repository needs

The repository (or a folder in it) must be a creation project, the same as a Studio workspace:

- `ats.json` (its title, how people join, its budget tier),
- `assets.lock.json` (every picture, model, sound and font, with its licence),
- `package.json`, and an `index.html` the platform builds with its own Vite.

The publishing checks decide the rest, and their report says what to change. A web app that also
runs on its own can usually keep one copy of its code for both: no scripts written inside the
page, and files it loads while running referenced so the bundler sees them
(`new URL('./file', import.meta.url)`). Saves go through the SDK (`portal.save`), not
`localStorage`, which a creation's frame doesn't have.

Submodules and Git LFS files aren't fetched. Nothing in the repository runs while it's fetched or
built: install scripts are off, and the platform builds it with a fixed configuration.

## Allowing a repository host

A host is one JSON file, `<id>.json`, in the folder `ATS_SOURCES_DIR` names. On a server set up
with the installer, that's `sources/` in the install folder, which the server sees, read-only, as
`/etc/ats/sources`. The server reads the folder when it starts: a file that isn't valid is skipped
(the log says why), and the others still load. Restart the server after adding or changing one.

```json
{
  "id": "github",
  "displayName": "GitHub",
  "kind": "github",
  "tokenEnv": "ATS_SOURCE_GITHUB_TOKEN",
  "repositories": ["lanternfield-club/*", "someone/marble-run"]
}
```

| Field | What it is |
|---|---|
| `id` | The file's name without `.json` (a-z, 0-9 and `-`) |
| `displayName` | What Architects see |
| `kind` | `github` (github.com, or GitHub Enterprise with its own `apiUrl`) |
| `repositories` | The only repositories creations may come from: `owner/name`, or `owner/*` for all of an owner's |
| `tokenEnv` | Optional: the environment variable holding a **read-only** token, for private repositories. It must start with `ATS_SOURCE_` |
| `apiUrl` | Optional: the API's address (default `https://api.github.com`) |
| `archiveHosts` | Optional: where archives may be fetched from (default `codeload.github.com`) |
| `allowPrivateAddress` | Optional: allow a host on a private network (a company's own GitHub Enterprise). Off by default |
| `maxArchiveMb` | Optional: the largest archive fetched (default 150, at most 300) |

For private repositories, make a **fine-grained personal access token** (or a GitHub App's
installation token) that can only **read contents** of the repositories you list, and put it in
`sources.env` in the install folder (readable only by root, like `connectors.env`):

```
ATS_SOURCE_GITHUB_TOKEN=github_pat_…
```

Without a token, only public repositories can be read. The token is never sent to browsers,
sandboxes or creations, and never shown in the app; it goes to the API only, never to the address
an archive is fetched from.

## What Architects do

- **Make a creation from a repository**: an object in the place, a repository this server allows,
  the folder its creation is in, and what it follows. It's fetched at that commit, checked and
  built like any creation, and lands as a candidate (or live, if they chose that).
- **Link a creation made in the Studio** to a repository instead: from then on, it's changed there.
- **What it follows**: the newest **release** (the default, so work in progress doesn't reach the
  space), the newest commit on a **branch**, or one **commit**.
- **Check** shows the newest commit and how many commits the creation is behind. **Update** builds
  it: a candidate to try first (the default), or straight to live, unless the group asks for every
  version to be tried on a device first. Any commit can be built, to go back to an older one.
- **Unlink**: the creation stays as it is, and is changed in the Studio again. Improving it in the
  Studio unlinks it too (Architects are asked first), so it's never changed in two places.

The server also looks at every followed repository about once an hour, and tells the group's
Architects (a notification) when there's a new release or commit that isn't built yet. It never
builds anything by itself: Update does.

People already inside a creation finish on the version they started; saves carry over, as they do
for every new version, so a repository's creation must version the shape of what it saves.

## The API

The Studio's **Creations** page does all of this (see the [Architect's guide](architect-guide.md)).
The same is there for Architects (signed in) as plain requests:

| | |
|---|---|
| `GET /api/sources` | The hosts this server allows |
| `POST /api/spaces/:spaceId/creations/from-repository` | `{ objectKey, host, repository, path?, follows?, ref?, updateMode? }`: a new creation, built from the repository |
| `GET /api/creations/:id/source` | What a creation follows, and what the repository had when last looked at |
| `PUT /api/creations/:id/source` | `{ host, repository, path?, follows?, ref?, updateMode? }`: link it (or change what it follows) |
| `POST /api/creations/:id/source/check` | Look at the repository now |
| `POST /api/creations/:id/source/update` | `{ commit? }`: build the newest (or that commit) |
| `DELETE /api/creations/:id/source` | Unlink it |

## Safety

The server fetches only from hosts and repositories in your definitions, at addresses resolved
once and checked to be public (unless you allow otherwise), with a deadline and a size cap, and
follows a redirect only to an archive address the definition names. The files are then checked as
any creation's source is: names, sizes, and anything that looks like a secret (a version holding
one is refused and nothing is stored). See [security.md](security.md).
