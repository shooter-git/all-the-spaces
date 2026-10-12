# Self-hosting

## What you need

- A server running **Ubuntu 22.04/24.04** or **Debian 12/13** (64-bit Intel/AMD or ARM).
- At least **4 CPUs, 16 GB memory, 80 GB disk**. For building large multi-floor spaces, 8 CPUs and
  32 GB are recommended. No GPU is needed.
- Optional: a domain name. Without one you get a free address based on your server's IP.
- For the people using it: a current browser on a computer or phone. iPhones and iPads need iOS
  or iPadOS 15.4 or later (the app is built for ES2022), and 3D needs WebGL 2.

## Install

```bash
curl -fsSL https://github.com/shooter-git/all-the-spaces/releases/latest/download/install.sh | sudo bash
```

If you have a domain, first add two DNS **A records** pointing to your server's IP: one for the
address (e.g. `spaces.example.com`) and one for `play.` in front of it (`play.spaces.example.com`).
To use another name for the second, give it with `--play-domain` (see
[Cloudflare](#cloudflare) for why you might).

Does the server already run a website with its own reverse proxy (Caddy, nginx…) on ports 80 and
443? Then install [behind it](#behind-an-existing-reverse-proxy) instead.

The installer checks the server, installs Docker and the gVisor sandbox, downloads the release,
generates private passwords, starts everything and prints a **setup code**. Open your address,
enter the code, and follow the wizard.

Besides the download servers for Docker, gVisor and the release, the installer uses two outside
services. If the server's own address is a private one (it's behind NAT, as on a home connection),
it asks `api.ipify.org` for its public IP address, on every install and update. And if you don't
give a domain, your address is `<your-ip>.sslip.io` (the IP with dashes): the public DNS service
sslip.io answers every lookup of that name with the IP inside it, so everyone's device asks
sslip.io's name servers when it opens your space. Your own domain avoids sslip.io.

What it downloads is checked: the release's files against checksums built into the installer, and
its images by their exact digest. If [cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
is installed on the server, it also checks that the images were signed by this project's release
workflow for that release, and stops if they weren't. To check the installer itself first, download
`install.sh`, `SHA256SUMS` and `SHA256SUMS.sigstore.json` from the release and run (with that
release's tag):

```bash
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/shooter-git/all-the-spaces/.github/workflows/release.yml@refs/tags/vX.Y.Z \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
sudo bash install.sh
```

Prefer not to use a terminal? Many cloud providers accept a "user data" script when creating a
server: paste
[`cloud-init.yaml`](https://github.com/shooter-git/all-the-spaces/releases/latest/download/cloud-init.yaml)
there (edit the domain). It's attached to every release.

## Behind an existing reverse proxy

Normally All the Spaces brings its own web server (Caddy), which takes ports 80 and 443 and gets
its own HTTPS certificates. If the server already runs a website behind a reverse proxy of its own
(Caddy, nginx, Traefik…), possibly with a CDN such as Cloudflare in front, install it behind that
proxy instead:

```bash
curl -fsSL https://github.com/shooter-git/all-the-spaces/releases/latest/download/install.sh |
  sudo bash -s -- --behind-proxy --domain spaces.example.com --play-domain spaces-play.example.com
```

Then All the Spaces:

- listens for your proxy on **`127.0.0.1:8480`**, over plain HTTP, and leaves ports 80 and 443
  alone. Choose another address with `--bind 127.0.0.1:9000` (the installer stops if something
  already listens there);
- gets no certificates and never redirects to HTTPS: your proxy does both. Its addresses are still
  `https://spaces.example.com` (no port), and sign-in cookies are still `Secure`;
- still publishes voice chat's **7881/tcp and 7882/udp** on every address, because the audio goes
  straight to this server, never through a proxy (the installer opens just those two in `ufw`);
- doesn't need the address to point at this server: it may point at your CDN. The installer only
  warns.

The choice is saved in `/opt/all-the-spaces/.env` (`ATS_BEHIND_PROXY=1`, `ATS_BIND`,
`ATS_TRUSTED_PROXIES`) and kept by every update, `sudo ats-admin update` included. To change the
address later, or to move an existing installation behind a proxy, run the installer with
`--update` and the option, e.g. `… | sudo bash -s -- --update --behind-proxy --bind 127.0.0.1:9000`.
To go back to All the Spaces' own web server, delete those lines and `ATS_CADDY_PUBLISH` from
`.env`, free ports 80 and 443, and run `sudo ats-admin update`.

**What your proxy has to do**, for both addresses (the app's and the one creations play on):

- pass every request on to `http://127.0.0.1:8480` with the **Host header the visitor sent**
  (All the Spaces tells the two addresses apart by it);
- say who the visitor is in `X-Forwarded-For`, and that they came over HTTPS in
  `X-Forwarded-Proto` (without that, everyone seems to come from your proxy, and shares its limits
  on sign-in attempts, invites and requests);
- pass WebSockets on (the live connection, `/rt/`, and voice chat's signalling, `/lk/`), and leave
  them open for long periods;
- accept uploads of up to **300 MB** (moving a place from another server; pictures are up to
  25 MB).

With **Caddy**, that's all its defaults. Add this to its Caddyfile and reload it (`systemctl
reload caddy`, or `caddy reload`):

```
spaces.example.com, spaces-play.example.com {
	reverse_proxy 127.0.0.1:8480
}
```

With **nginx** (certificates from certbot or similar, as for your other sites):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name spaces.example.com spaces-play.example.com;
    ssl_certificate     /etc/letsencrypt/live/spaces.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/spaces.example.com/privkey.pem;

    client_max_body_size 300m;

    location / {
        proxy_pass http://127.0.0.1:8480;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
    }
}
```

(The certificate has to cover both names. nginx's usual `$proxy_add_x_forwarded_for` works too:
All the Spaces reads the list from the right, so an address a visitor wrote there themselves is
ignored.)

### Which proxies are believed

All the Spaces' Caddy believes `X-Forwarded-For` and `X-Forwarded-Proto` only from the addresses
in `ATS_TRUSTED_PROXIES`: by default `private_ranges` (private networks and loopback). That covers
a proxy on the same server: Docker hands its connections to the container through Docker's own
network, from a private address. It reads `X-Forwarded-For` from the right, skipping trusted
addresses, and passes the first other one on as the visitor's. If your proxy is on another machine
and reaches this one over a public address, listen on an address it can reach and believe only it:
`--bind 10.0.0.5:8480 --trusted-proxies "10.0.0.2"` (or add it to the defaults:
`--trusted-proxies "private_ranges 203.0.113.10"`). Don't listen on a public address: anyone
could then reach All the Spaces around your proxy.

### Cloudflare

Cloudflare's proxy (the orange cloud) works for both addresses: the app and creations are plain
HTTPS and WebSockets. Three things to know:

- **Voice chat doesn't go through Cloudflare.** Browsers send the audio straight to this server's
  own IP address on 7881/tcp and 7882/udp, so those must be open in any firewall in front of it,
  even though the web addresses point at Cloudflare.
- **Cloudflare's free certificate covers one level of subdomain** (`*.example.com`), so
  `play.spaces.example.com` wouldn't get one. Use two names on the same level, such as
  `spaces.example.com` and `spaces-play.example.com` (`--play-domain`, as above; on an existing
  installation, change `ATS_PLAY_HOST` and `ATS_PLAY_URL` in `.env` and run
  `sudo ats-admin update`). Use the "Full (strict)" encryption mode, with a real certificate on
  your proxy.
- **Your proxy sees Cloudflare's addresses**, not the visitors'. Tell it to believe Cloudflare
  ([its address ranges](https://www.cloudflare.com/ips/)) and pass the visitor's address on. In
  Caddy's global options:

  ```
  {
  	servers {
  		trusted_proxies static 173.245.48.0/20 103.21.244.0/22 … (Cloudflare's full list)
  		client_ip_headers CF-Connecting-IP
  	}
  }
  ```

  and `header_up X-Forwarded-For {client_ip}` inside the `reverse_proxy` block. In nginx:
  `set_real_ip_from` for each range and `real_ip_header CF-Connecting-IP;` (then `$remote_addr`
  above is the visitor's).

Cloudflare's free and Pro plans also refuse uploads over 100 MB, so moving a bigger place onto this
server needs the address briefly switched to "DNS only".

### Sharing a server

All the Spaces' supervisor can use Docker (it starts the Studio's sandboxes; see
[security](security.md)), so someone who took over All the Spaces could take over every container
on the server, and with it the server: give it a server, or at least a Docker, of its own if the
other services matter.

## Everyday tasks

| Task | Command |
|---|---|
| See what's running (and disk use) | `sudo ats-admin status` |
| Get a new setup code | `sudo ats-admin setup-code` |
| See or change who owns the server in the app | `sudo ats-admin owner [EMAIL]` |
| Update | `sudo ats-admin update` |
| Undo the last update | `sudo ats-admin rollback` |
| Back up now (see [Backups](#backups)) | `sudo ats-admin backup` |
| Restore a backup | `sudo ats-admin restore /opt/all-the-spaces/backups/…` |
| Read logs | `sudo ats-admin logs server` |

**Updates are safe:** an update first downloads the new version while your space keeps running
(if that fails, nothing changes). Then it takes your space offline for a minute or two: it backs
up, starts the new version and checks that every part of it comes up healthy. If one doesn't, the
installer restores the previous version *and* its data, as they were when the update began.

Everything lives in `/opt/all-the-spaces`. Keep a copy of its `.env` file somewhere safe: it holds
the passwords that protect your data.

**Disk space looks after itself:** each part's logs are capped at 100 MB (the oldest lines make way
for new ones), and after a successful update the previous version's images are removed (the
Studio's workbench alone is about 3 GB). `ats-admin rollback` downloads them again if needed.
Backups are what grow: see [how long they're kept](#schedule-and-how-long-backups-are-kept).
`sudo ats-admin status` shows how much space Docker uses and how much is free.

## Backups

Your space is backed up automatically on the schedule chosen during setup (every night, every
week, or not at all), and before every update. You can also back up at any moment with
`sudo ats-admin backup`. Each backup is a folder in `/opt/all-the-spaces/backups` holding:

- the **database** (`database.sql.gz`): groups, people, spaces, creations and their history;
- the **stored files** (`storage.json` and `objects/`): published creations, the source kept with
  each one, their check reports and your built spaces;
- the **settings** (`.env` and `compose.yml`), and [connectors](#connectors) (`connectors/` and
  `connectors.env`) and [repository hosts](#repositories) (`sources/` and `sources.env`) if you
  have any.

Architects' assistant sign-ins and unpublished workspace files are never included.

Repeated backups are cheap: a file that hasn't changed since the last backup is shared with it
rather than copied again, so each new backup only takes space for what changed. Every folder is
still a complete backup on its own, so you can delete old ones freely.

### Schedule and how long backups are kept

Scheduled backups run a little after 3 am (server time), or when the server is next switched on if
it was off then. They're the folders ending in `-auto`, and each is removed once it's older than the
number of days you chose (the newest is always kept, even if backups stop working for a while).
Backups you make yourself (`-manual`) and those made before updates (`-before-…`) are never removed
automatically.

| Task | Command |
|---|---|
| See the backup settings | `sudo ats-admin backup-settings` |
| Change the schedule | `sudo ats-admin backup-settings schedule nightly` (or `weekly`, `off`) |
| Change how long they're kept | `sudo ats-admin backup-settings keep-days 30` |
| Remove old scheduled backups now | `sudo ats-admin prune` |
| Also remove old manual and pre-update ones | `sudo ats-admin prune --all` |
| See when the next one runs | `systemctl list-timers all-the-spaces-backup.timer` |
| See how the last one went | `journalctl -u all-the-spaces-backup` |

`prune --all` asks first, and still keeps the newest backup and the one `ats-admin rollback` would
go back to.

### Off-site copy

A backup on the same server doesn't help if the server itself is lost. During setup (or later, with
`sudo ats-admin backup-settings offsite`) you can give any S3-compatible bucket, such as Backblaze
B2, Cloudflare R2 or AWS S3. Every scheduled and manual backup is then also copied there, and
removed from there on the same schedule as on the server. Stored files are uploaded only once:
backups share them in the bucket, so each copy only sends what's new.

Use a **private** bucket with its own access key: backups hold everything in your space, including
the passwords in `.env`. Each server keeps its backups in its own folder of the bucket (by default
`all-the-spaces/` followed by your space's address). Don't point two servers at the same folder.
`sudo ats-admin backup-settings offsite off` stops copying (what's already there stays).
Connectors aren't copied off-site: keep your own copy of `connectors/` and `connectors.env`.

### Restoring

`sudo ats-admin restore /opt/all-the-spaces/backups/…` puts the database and stored files back
exactly as they were in that backup (anything added since is removed) and leaves the settings as
they are. If you chose your own S3 storage during setup, its files stay in your bucket and aren't
copied into backups: use your provider's versioning or backups for those.

To move to a new server, or recover after losing one, install All the Spaces there (you don't need
to finish setup), then:

```bash
sudo ats-admin offsite-fetch
```

It asks for the off-site bucket's details, downloads the newest backup (or the one you name, e.g.
`sudo ats-admin offsite-fetch 20260930T031512Z-auto`), checks every file, and tells you the
`restore` command to run next. If the server still has its off-site settings, it uses those.
Restoring onto a new server also adopts the old server's sign-in secret from the backup (it unlocks
the storage passwords saved in the database), so everyone signs in again afterwards.

To copy backups somewhere yourself instead, copy the whole `backups` folder with a tool that keeps
shared files shared, for example `rsync -aH /opt/all-the-spaces/backups/ other-machine:ats-backups/`.

## Notifications

People see notifications in the app, and can have them sent to their phones and computers (push
notifications need the app on HTTPS, which the installer sets up). For email notifications too,
add your email provider's SMTP details to `/opt/all-the-spaces/.env`, then
`sudo ats-admin update`:

```
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM=All the Spaces <spaces@example.com>
```

Without `SMTP_URL`, the email option simply doesn't appear.

With it, everyone confirms their email address: people joining get a link by email, and anyone who
joined before you added it gets one the next time they sign in with their password (they stay
signed in where they already are). Email notifications only go to confirmed addresses.

## Voice chat

People can talk to whoever is in the same room of a space, and to the others in a creation they
share. Voice runs on your server (LiveKit, included and set up by the installer); nothing is
recorded. The sound itself travels on two extra ports, which the installer opens if `ufw` is on:
**7881/tcp and 7882/udp**. If your provider has its own firewall (a "security group" or "cloud
firewall" in its control panel), open those two there too, or voice won't connect. Architects can
turn voice off for their group (Home → Chat).

A note on `ufw`: Docker publishes ports with firewall rules of its own, which come before ufw's.
The web ports and voice ports are reachable whether or not ufw allows them, and a ufw rule can't
close them. To restrict them, use your provider's firewall. (Behind a reverse proxy, the web port
is only on the address it listens on, `127.0.0.1` by default, so only the voice ports face out.)

## The Studio (building creations with an AI assistant)

Architects build creations with their own Claude Code or Codex, which they install and sign in to
from **Home → Your group → AI assistants**. Each Architect's assistant runs in its own sealed
container, started only when they open a workspace:

- **gVisor** isolates these containers from the server (the installer sets it up; without it,
  `install.sh --no-gvisor`, they fall back to Docker's standard isolation — fine for trying things
  out, not recommended for groups).
- They can only reach the assistant's maker, the npm registry, free asset libraries, GitHub's
  files, and reference pictures and docs, over HTTPS. To allow more hosts, add them to
  `/opt/all-the-spaces/.env` as `ATS_EGRESS_EXTRA=example.com,*.example.org`, then
  `sudo ats-admin update`. Or let one group's workspaces reach the whole internet (HTTPS, never
  this server's own network): **Studio → Settings → Let assistants use the whole internet**. It
  needs `EGRESS_SECRET`, which the installer creates (and adds when updating).
- Using them is subject to Anthropic's and OpenAI's own terms, and that's your responsibility: see
  [compliance.md](compliance.md#vendor-terms).
- Sign-ins stay in each Architect's own storage on the server. They're **not** included in
  backups: after restoring to a new server, Architects sign in again.
- A workspace stays awake while its Architect has its page open and in use. Once they step away
  it sleeps after 2 quiet hours (the assistant not at work either), or once it's been awake 4
  hours however busy the assistant is (change these in Group settings). Sleeping keeps every file,
  and opening the workspace again wakes it.

### How long building a place takes

Building a place bakes each indoor room's lighting on the CPU (no GPU needed), in its own
short-lived container. That is most of a build's time: about **8 minutes a room on 2 CPUs** at
full quality (measured on the heaviest sample room, a café with detailed furniture; a plainer room
takes about 7). Rooms bake side by side, so a server with more CPUs builds a place sooner:

| Place | Rooms to bake | 4 CPUs (2 at once) | 8 CPUs (4 at once) | One at a time |
|---|---|---|---|---|
| A one-bedroom flat | 3 | about 16 minutes | about 8 minutes | about 25 minutes |
| A small two-floor building | 7 | about 30 minutes | about 16 minutes | about 55 minutes |
| A large building | 240 | about 15 hours | about 8 hours | about 30 hours |

These are estimates from the 8-minute rooms, for the first build of a place. **A rebuild bakes
only the rooms that changed** (move a chair and only that room is baked again), so later builds
take minutes. The Studio shows how far a build has got ("Baking lighting: room 4 of 12, about 30
minutes left"). A room that takes longer than 30 minutes is stopped and uses real-time lighting
instead; the review says so.

Two settings in `/opt/all-the-spaces/.env` change this (then `sudo ats-admin update`):

- `ATS_BAKE_PARALLEL`: how many rooms bake at once, across every build. The default is your
  server's CPUs divided by `ATS_BAKE_CPUS` (2 on a 4-CPU server), which keeps every CPU busy while
  a place is built, so people using the server at the same time may notice. `ATS_BAKE_PARALLEL=1`
  leaves room for them, at the "one at a time" speed above.
- `ATS_BAKE_CPUS`: CPUs for each room's bake (default 2). Each bake also gets up to 4 GB of memory
  (the Studio's limit, `ATS_SANDBOX_MEMORY_MB`); the heaviest sample room used about 840 MB.

### Checking creations

Before a creation is published, it's built and played on a phone, a tablet and a laptop, one
build at a time, in a short-lived container. That browser has no graphics card, so it draws on
the CPU, and a 3D creation can look frozen while its shaders are made if it has too few CPUs.
`ATS_CHECK_CPUS` sets how many that step gets: 4 by default, or all of them on a server with
fewer. A check takes a few minutes, or up to half an hour on a busy server. If the browser can't finish drawing a frame for a screenshot
(given 90 seconds), the report notes "Couldn't take a screenshot" and skips the rest of them.
That's a note, not a failure. Seeing it often means the checks need more CPUs.

### API-key mode (optional, off by default)

Normally each Architect signs in to Claude Code or Codex with their own subscription. If you'd
rather pay per use with an API key from Anthropic and/or OpenAI, you can give the server your own
keys instead: create `/opt/all-the-spaces/api-keys.env` (readable only by root),

```
ATS_API_KEY_MODE=on
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

then `sudo ats-admin update`. Only the service that starts Architects' sandboxes reads this file;
it hands the key to the assistant (the environment variable its maker documents) in each sandbox,
and those assistants need no sign-in. Everything they do is billed to your key, for every Architect
in every group on this server — use a key with a spending limit. The assistant (and code it runs in
the sandbox) can see the key, just as it can see a sign-in. The file isn't included in backups:
put it back after restoring. Leave a key out to keep that assistant on sign-ins. Use it only for your own group, and never charge anyone for it: see
[compliance.md](compliance.md#vendor-terms) for what the vendors' terms say.

Disk space: the Studio's workbench image is about 3 GB, and each workspace a few hundred MB once
its packages are installed. A workspace's files live only in that workspace until they're
published; publishing keeps a copy of the source with the creation, in the server's storage.

## Connectors

Connectors let creations use another service you run (with each person's permission), through the
server: see [connectors.md](connectors.md) for what they can do and how to write one. They're off
until you add one, in two places in `/opt/all-the-spaces`:

- **`connectors/`**: one definition file per connector. The installer creates the folder (it
  belongs to root and the app's group, and files you add get that group); the server reads it at
  `/etc/ats/connectors` (`ATS_CONNECTORS_DIR`), read-only. Keep the files readable by that group
  (`chmod 640` or `644`); they hold no secrets.
- **`connectors.env`** (optional): the connectors' secrets, such as an OAuth client secret, as
  `NAME=value` lines. Only the server is given them, like `api-keys.env` is only given to the
  supervisor. Keep it readable only by root (the installer sets `chmod 600`).

Then restart the server to apply them: `cd /opt/all-the-spaces && sudo docker compose up -d
--force-recreate server` (the next `sudo ats-admin update` does it too). Both are in
backups on the server, and an update that rolls back puts them back too; `ats-admin restore`
leaves them as they are, like the other settings.

## Repositories

Creations can also come straight from a git repository and follow it as it changes: see
[repositories.md](repositories.md). That's off until you allow some, as the server's owner.

**The server's owner** is the account made with the setup code: you, if you finished setup. Only
the owner changes server-wide settings in the app; your group's other Architects see who it is.
To make another Architect the owner (if you're handing the server on, say):
`sudo ats-admin owner their@email`. `sudo ats-admin owner` alone says who it is.

**In the app**, with no file and no restart: **Your group → Server → Creations from
repositories**. Switch on **GitHub** for public repositories on github.com (no token involved),
and choose some, or any public one. It's off until you switch it on.

**With files**, for private repositories, a GitHub Enterprise server, or to keep the list on the
server, in the same two kinds of place as connectors:

- **`sources/`**: one definition file per host (GitHub, say), naming the repositories allowed
  (`*` for any public one). The server reads it at `/etc/ats/sources` (`ATS_SOURCES_DIR`),
  read-only.
- **`sources.env`** (optional): a read-only token for private repositories, as
  `ATS_SOURCE_…=value` lines. Only the server is given it (`chmod 600`). It's only ever used for
  the repositories the file names (`owner/name` or `owner/*`), never for `*` or anything allowed
  in the app.

Restart the server after changing the files, as for connectors; they're backed up the same way,
and what you chose in the app is in the database backup.

Without a token GitHub answers 60 requests an hour from your server's address: enough to look at
about 15 public repositories every hour. With more, each is looked at less often; Architects' own
**Check** and **Update** keep a share of the hour (see
[repositories.md](repositories.md#githubs-hourly-limit)).
