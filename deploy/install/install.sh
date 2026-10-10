#!/usr/bin/env bash
# All the Spaces installer.
#
#   curl -fsSL https://github.com/shooter-git/all-the-spaces/releases/latest/download/install.sh | sudo bash
#
# Safe to run again: a second run on an installed server offers to update, and a run after a first
# install that didn't finish picks it up again. Updates always take a backup first and roll back
# automatically if the new version does not come up healthy.
#
# Options:
#   --domain NAME        Web address for your space (e.g. spaces.example.com). Asked if omitted.
#   --play-domain NAME   Address creations are played on (default: play.<domain>).
#   --email ADDRESS      Contact for the free HTTPS certificate (Let's Encrypt). Optional.
#   --behind-proxy       This server already runs a reverse proxy (Caddy, nginx…) that handles
#                        HTTPS: listen for it on one local address instead of ports 80 and 443.
#   --bind ADDRESS:PORT  With --behind-proxy: where to listen (default 127.0.0.1:8480).
#   --trusted-proxies "RANGES"  With --behind-proxy: the addresses whose X-Forwarded-For is
#                        believed (default private_ranges: private networks and loopback).
#   --update             Update an existing installation to this release.
#   --rollback           Go back to the version (and data) from before the last update.
#   --dir PATH           Install location (default /opt/all-the-spaces).
#   --yes                Don't ask questions: use defaults and answer yes to confirmations.
#   --no-gvisor          Skip the gVisor sandbox runtime (needed later for the Studio).
#   Testing only: --skip-docker-install, --tls-internal, --http-port N, --https-port N
#
# The addresses, ports and --behind-proxy settings are saved in .env and kept by every update
# (including 'ats-admin update'). Giving one again with --update changes it.
set -Eeuo pipefail

# ---- Filled in by the release workflow ------------------------------------------------------
ATS_REPO="${ATS_REPO:-__ATS_REPO__}"
ATS_RELEASE="${ATS_RELEASE:-__ATS_RELEASE__}"
ATS_APP_IMAGE="${ATS_APP_IMAGE:-__ATS_APP_IMAGE__}"
ATS_WEB_IMAGE="${ATS_WEB_IMAGE:-__ATS_WEB_IMAGE__}"
ATS_WORKBENCH_IMAGE="${ATS_WORKBENCH_IMAGE:-__ATS_WORKBENCH_IMAGE__}"
ATS_EGRESS_IMAGE="${ATS_EGRESS_IMAGE:-__ATS_EGRESS_IMAGE__}"
ATS_COMPOSE_SHA256="${ATS_COMPOSE_SHA256:-__ATS_COMPOSE_SHA256__}"
ATS_GARAGE_SHA256="${ATS_GARAGE_SHA256:-__ATS_GARAGE_SHA256__}"
ATS_ADMIN_SHA256="${ATS_ADMIN_SHA256:-__ATS_ADMIN_SHA256__}"
# Local testing: take compose.yml and garage.toml from this directory instead of the release.
ATS_ASSETS_DIR="${ATS_ASSETS_DIR:-}"
# The oldest release this one can update from (empty: any). Set it when a release can't be reached
# in one step, say after a Postgres major upgrade that an intermediate release has to carry out.
ATS_MIN_FROM_RELEASE="${ATS_MIN_FROM_RELEASE:-}"
# ----------------------------------------------------------------------------------------------

DIR=/opt/all-the-spaces
DOMAIN=""
PLAY_DOMAIN=""
EMAIL=""
MODE=install
ASSUME_YES=false
WITH_GVISOR=true
SKIP_DOCKER_INSTALL=false
TLS_INTERNAL=false
# Empty: the saved setting (on a first install, the default).
HTTP_PORT=""
HTTPS_PORT=""
BEHIND_PROXY=false
BIND=""
TRUSTED_PROXIES=""
DEFAULT_BIND=127.0.0.1:8480
PROJECT="${ATS_PROJECT:-all-the-spaces}"
# Testing only: run without root (skips system-wide files like /usr/local/bin/ats-admin).
TEST_NON_ROOT="${ATS_TEST_NON_ROOT:-false}"
# Testing only: CI runners have far less free disk than a real server needs.
MIN_DISK_GB="${ATS_TEST_MIN_DISK_GB:-40}"

bold=$'\e[1m'; dim=$'\e[2m'; red=$'\e[31m'; green=$'\e[32m'; yellow=$'\e[33m'; reset=$'\e[0m'
[[ -t 1 ]] || { bold=; dim=; red=; green=; yellow=; reset=; }
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$bold" "$*" "$reset"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$reset" "$*"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$*"; }
die()  { printf '\n%sSorry — %s%s\n' "$red" "$*" "$reset" >&2; exit 1; }
# Set while an update has the space stopped for its backup: an unexpected failure starts it again.
RESTART_ON_ERROR=false
on_error() { # on_error LINE
  $RESTART_ON_ERROR && { dc up -d >/dev/null 2>&1 || true; }
  die "something unexpected went wrong on line $1. Nothing was deleted, and running the installer again picks up where it left off."
}
trap 'on_error $LINENO' ERR

# Questions are read from the terminal even when the script itself arrives through a pipe.
ask() { # ask "Question" default -> REPLY
  local q=$1 def=${2:-}
  if $ASSUME_YES || [[ ! -r /dev/tty ]]; then REPLY=$def; return; fi
  read -r -p "  $q${def:+ [$def]} " REPLY </dev/tty || REPLY=""
  REPLY=${REPLY:-$def}
}
confirm() { # --yes answers yes to everything, including the cautious questions
  $ASSUME_YES && return 0
  ask "$1 (y/n)" "${2:-y}"
  [[ $REPLY =~ ^[Yy] ]]
}

usage() {
  cat <<'HELP'
All the Spaces installer

  --domain NAME     Web address for your space (e.g. spaces.example.com). Asked if omitted.
  --play-domain NAME  Address creations are played on (default: play.<domain>).
  --email ADDRESS   Contact for the free HTTPS certificate (Let's Encrypt). Optional.
  --behind-proxy    This server already runs a reverse proxy (Caddy, nginx…) that handles HTTPS:
                    listen for it on one local address instead of ports 80 and 443.
  --bind ADDRESS:PORT  With --behind-proxy: where to listen (default 127.0.0.1:8480).
  --trusted-proxies "RANGES"  With --behind-proxy: the addresses whose X-Forwarded-For is
                    believed (default private_ranges: private networks and loopback).
  --update          Update an existing installation to this release.
  --rollback        Go back to the version (and data) from before the last update.
  --dir PATH        Install location (default /opt/all-the-spaces).
  --yes             Don't ask questions: use defaults and answer yes to confirmations.
  --no-gvisor       Skip the gVisor sandbox runtime (needed later for the Studio).
HELP
  exit 0
}
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN=${2:?}; shift ;;
    --play-domain) PLAY_DOMAIN=${2:?}; shift ;;
    --email) EMAIL=${2:?}; shift ;;
    --behind-proxy) BEHIND_PROXY=true ;;
    --bind) BIND=${2:?}; shift ;;
    --trusted-proxies) TRUSTED_PROXIES=${2:?}; shift ;;
    --update) MODE=update ;;
    --rollback) MODE=rollback ;;
    --dir) DIR=${2:?}; shift ;;
    --yes|-y) ASSUME_YES=true ;;
    --no-gvisor) WITH_GVISOR=false ;;
    --skip-docker-install) SKIP_DOCKER_INSTALL=true ;;
    --tls-internal) TLS_INTERNAL=true ;;
    --http-port) HTTP_PORT=${2:?}; shift ;;
    --https-port) HTTPS_PORT=${2:?}; shift ;;
    -h|--help) usage ;;
    *) die "I don't recognise the option '$1'. Run with --help to see the options." ;;
  esac
  shift
done
# --bind 8480 means 127.0.0.1:8480. An IPv4 address (or an IPv6 one in brackets) and a port.
[[ $BIND =~ ^[0-9]+$ ]] && BIND=127.0.0.1:$BIND
if [[ -n $BIND && ! $BIND =~ ^(([0-9]{1,3}\.){3}[0-9]{1,3}|\[[0-9a-fA-F:]+\]):[0-9]{1,5}$ ]]; then
  die "--bind takes an address and a port, like 127.0.0.1:8480 (not '$BIND')."
fi
if [[ -n $TRUSTED_PROXIES && ! $TRUSTED_PROXIES =~ ^[0-9A-Za-z.:/_\ ]+$ ]]; then
  die "--trusted-proxies takes addresses or ranges separated by spaces, like '10.0.0.0/8 192.168.1.5' (or private_ranges)."
fi
# (An installation saved as behind a proxy is still behind one: --update --bind … is enough.)
if [[ -n $BIND || -n $TRUSTED_PROXIES ]] && ! $BEHIND_PROXY &&
  ! grep -qx 'ATS_BEHIND_PROXY=1' "$DIR/.env" 2>/dev/null; then
  die "--bind and --trusted-proxies go with --behind-proxy."
fi

unbaked() { [[ $1 == __*__ ]]; }
# Whether release A comes before release B (v0.9.0 before v0.10.0).
older_than() { # older_than A B
  [[ $1 != "$2" && $(printf '%s\n' "$1" "$2" | sort -V | head -1) == "$1" ]]
}
# Whether FILE matches a checksum the release workflow baked into this installer. Unbaked (a local
# test), there's nothing to check against.
matches() { # matches SHA256 FILE
  unbaked "$1" || echo "$1  $2" | sha256sum -c --quiet - >/dev/null 2>&1
}
# Compose lets shell variables override .env, so drop any of ours from the environment: the saved
# settings in $DIR/.env must always win (otherwise a rollback could keep running the bad version).
dc() { dc_with "$DIR/compose.yml" "$DIR/.env" "$@"; }
# An update downloads with the new release's files before they replace the running ones.
dc_with() { # dc_with COMPOSE_FILE ENV_FILE ARGS…
  local file=$1 env_file=$2 unset_args=() v; shift 2
  for v in $(compgen -e); do
    [[ $v =~ ^(ATS_|POSTGRES_|GARAGE_|S3_|BETTER_AUTH_) ]] && unset_args+=(-u "$v")
  done
  env "${unset_args[@]}" docker compose -p "$PROJECT" --project-directory "$DIR" -f "$file" --env-file "$env_file" "$@"
}

# ---- Checks -------------------------------------------------------------------------------------
check_system() {
  step "Checking this server"
  [[ $EUID -eq 0 || $TEST_NON_ROOT == true ]] || die "please run the installer as root (put 'sudo' in front of the command)."

  # shellcheck disable=SC1091
  . /etc/os-release
  case "$ID:$VERSION_ID" in
    ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ok "$PRETTY_NAME" ;;
    *) warn "$PRETTY_NAME hasn't been tested. Ubuntu 24.04 or Debian 12 are recommended."
       confirm "Continue anyway?" n || exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|aarch64) ok "$(uname -m) processor" ;;
    *) die "this server's processor ($(uname -m)) isn't supported. You need a 64-bit Intel/AMD or ARM server." ;;
  esac

  local cpus mem_gb disk_gb="" where="" path gb
  cpus=$(nproc)
  mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024 + 0.5}' /proc/meminfo)
  # Where the space keeps its data: the install folder (backups) and Docker's (images, database,
  # stored files). Either may be its own disk; the one with less room counts.
  for path in "$DIR" "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"; do
    gb=$(free_gb "$path")
    if [[ -z $disk_gb ]] || (( gb < disk_gb )); then disk_gb=$gb; where=$path; fi
  done
  if (( cpus < 2 || mem_gb < 4 )); then
    die "this server is too small ($cpus CPU, ${mem_gb} GB memory). You need at least 4 CPUs and 16 GB of memory."
  fi
  if (( cpus < 4 || mem_gb < 15 )); then
    warn "$cpus CPUs and ${mem_gb} GB memory will work for trying things out, but 4 CPUs and 16 GB are recommended."
  else
    ok "$cpus CPUs, ${mem_gb} GB memory"
  fi
  if (( disk_gb < MIN_DISK_GB )); then
    die "there's only ${disk_gb} GB of free disk space for $where. You need at least $MIN_DISK_GB GB (80 GB recommended)."
  fi
  ok "${disk_gb} GB free disk space"
}
# Free space, in GB, on the disk holding PATH (or the nearest folder above it that exists yet).
free_gb() { # free_gb PATH
  local p=$1
  while [[ ! -e $p ]]; do p=$(dirname "$p"); done
  df -BG --output=avail "$p" | tail -1 | tr -dc '0-9'
}

# ---- Docker and gVisor --------------------------------------------------------------------------
install_docker() {
  step "Installing Docker"
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    ok "Docker is already installed ($(docker --version | cut -d, -f1))"
    return
  fi
  $SKIP_DOCKER_INSTALL && die "Docker isn't installed (and --skip-docker-install was given)."
  # shellcheck disable=SC1091
  . /etc/os-release
  # Docker without Compose v2: add just the plugin. Docker's own packages (docker-ce) would clash
  # with a distribution's docker.io.
  if command -v docker >/dev/null; then
    install_compose_plugin
    return
  fi
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl >/dev/null
  # Docker's own signed apt repository (https://docs.docker.com/engine/install/). A new release
  # (say Ubuntu 26.04 when it's just out) can be there before Docker publishes packages for it.
  if ! curl -fsSI "https://download.docker.com/linux/$ID/dists/$VERSION_CODENAME/Release" >/dev/null 2>&1; then
    [[ $ID == ubuntu ]] || die "Docker doesn't offer packages for $PRETTY_NAME yet. Install Docker with Compose v2 yourself (https://docs.docker.com/engine/install/), then run the installer again."
    warn "Docker doesn't offer packages for $PRETTY_NAME yet, so Ubuntu's own are used."
    apt-get install -y -qq docker.io docker-compose-v2 >/dev/null
  else
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
      >/etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  fi
  systemctl enable --now docker >/dev/null
  ok "Docker installed"
}

# Compose v2 for a Docker that's already here, from wherever that Docker came from.
install_compose_plugin() {
  local pkg
  if dpkg-query -W -f '${Status}' docker-ce 2>/dev/null | grep -q 'ok installed'; then
    pkg=docker-compose-plugin # Docker's repository, already set up for docker-ce
  elif [[ $ID == ubuntu ]] && dpkg-query -W -f '${Status}' docker.io 2>/dev/null | grep -q 'ok installed'; then
    pkg=docker-compose-v2 # Ubuntu's own, matching its docker.io
  else
    die "Docker is installed, but without Compose v2 (the 'docker compose' command), and I can't tell which package adds it here. Install it (https://docs.docker.com/compose/install/linux/), check that 'docker compose version' works, then run the installer again."
  fi
  if ! { apt-get update -qq && apt-get install -y -qq "$pkg" && docker compose version; } >/dev/null 2>&1; then
    die "Docker is installed, but adding Compose v2 to it (the $pkg package) didn't work. Install it with 'sudo apt-get install $pkg', check that 'docker compose version' works, then run the installer again."
  fi
  ok "Added Compose v2 to the Docker already installed ($pkg)"
}

install_gvisor() {
  $WITH_GVISOR || return 0
  step "Installing the gVisor sandbox (keeps AI-written code isolated later on)"
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q runsc; then
    ok "gVisor is already set up"
    return
  fi
  if $SKIP_DOCKER_INSTALL; then
    warn "Skipping gVisor (testing mode). The Studio will need it later."
    return
  fi
  # gVisor's signed apt repository (https://gvisor.dev/docs/user_guide/install/).
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    >/etc/apt/sources.list.d/gvisor.list
  apt-get update -qq
  apt-get install -y -qq runsc >/dev/null
  runsc install >/dev/null
  # Registering a runtime needs Docker to reload its settings. Running containers keep running.
  systemctl reload docker 2>/dev/null || systemctl restart docker
  ok "gVisor installed"
}

# ---- Address ------------------------------------------------------------------------------------
public_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')
  # A private address means we're behind NAT; ask a public echo service instead.
  if [[ -z $ip || $ip =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
    ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  fi
  printf '%s' "$ip"
}

choose_domain() {
  step "Choosing your space's web address"
  local ip
  ip=$(public_ip)
  if [[ -z $DOMAIN ]]; then
    local target=${ip:-"this server's IP address"}
    say "  If you own a domain name, point it at this server (an 'A record' to $target)"
    say "  and type it here, for example ${bold}spaces.example.com${reset}."
    say "  Or just press Enter to use a free address based on this server's IP."
    ask "Web address:" ""
    DOMAIN=$REPLY
  fi
  if [[ -z $DOMAIN ]]; then
    [[ -n $ip ]] || die "I couldn't work out this server's public IP address. Run again with --domain your.domain."
    DOMAIN="${ip//./-}.sslip.io"
    PLAY_DOMAIN=$(bare_host "${PLAY_DOMAIN:-play.$DOMAIN}")
    ok "Using $DOMAIN (free, no setup needed)"
  else
    DOMAIN=$(bare_host "$DOMAIN")
    PLAY_DOMAIN=$(bare_host "${PLAY_DOMAIN:-play.$DOMAIN}")
    local resolved
    resolved=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
    if $TLS_INTERNAL; then
      ok "Using $DOMAIN"
    elif $BEHIND_PROXY; then
      # The proxy in front may itself be behind a CDN (Cloudflare's proxied DNS, say), so the
      # address needn't point straight here.
      if [[ -z $resolved ]]; then
        warn "$DOMAIN doesn't point anywhere yet. Point it (and $PLAY_DOMAIN) at your reverse proxy."
      elif [[ -n $ip && $resolved != "$ip" ]]; then
        warn "$DOMAIN points to $resolved, not this server ($ip). That's fine if it's a CDN in front of your reverse proxy."
      else
        ok "$DOMAIN points to this server"
      fi
    elif [[ -z $resolved ]]; then
      warn "$DOMAIN doesn't point anywhere yet. Add an A record for it (and for $PLAY_DOMAIN) pointing to $ip."
      confirm "Continue anyway? HTTPS will start working once the address points here." y || exit 1
    elif [[ -n $ip && $resolved != "$ip" ]]; then
      warn "$DOMAIN points to $resolved, but this server is $ip."
      confirm "Continue anyway?" n || exit 1
    else
      ok "$DOMAIN points to this server"
    fi
  fi
  # Behind a proxy, that proxy gets the certificates.
  if [[ -z $EMAIL ]] && ! $TLS_INTERNAL && ! $BEHIND_PROXY; then
    ask "Email for HTTPS certificate notices (optional, press Enter to skip):" ""
    EMAIL=$REPLY
  fi
}
# A host name, typed with or without https:// and a path.
bare_host() { local h=${1#http*://}; printf '%s' "${h%%/*}"; }

# Behind another reverse proxy: saved in .env, or chosen now with --behind-proxy.
behind_proxy() { $BEHIND_PROXY || [[ $(get_env ATS_BEHIND_PROXY || true) == 1 ]]; }
# A public address: https, with this server's HTTPS port when it isn't 443 (behind a proxy, the
# proxy's, which is taken to be 443).
public_url() { # public_url HOST
  local port=${HTTPS_PORT:-$(get_env ATS_HTTPS_PORT || true)}
  if behind_proxy || [[ ${port:-443} == 443 ]]; then port=""; else port=":$port"; fi
  printf 'https://%s%s' "$1" "$port"
}

# Behind a proxy, a first install's address to listen on must be free.
check_bind() {
  behind_proxy || return 0
  local bind=${BIND:-$DEFAULT_BIND} port local_addr
  port=${bind##*:}
  # Taken: that address and port, or the port on every address.
  while read -r _ _ _ local_addr _; do
    case $local_addr in
      "$bind"|"0.0.0.0:$port"|"*:$port"|"[::]:$port")
        die "something on this server already listens on $local_addr. Choose another address with --bind, like --bind 127.0.0.1:8481." ;;
    esac
  done < <(ss -Hltn 2>/dev/null || true)
  case ${bind%:*} in
    127.*|'[::1]') ;;
    *) warn "$bind isn't a loopback address: whoever can reach it there gets plain HTTP to your space, around your proxy." ;;
  esac
}

# ---- Files --------------------------------------------------------------------------------------
fetch_assets() {
  step "Downloading All the Spaces ${ATS_RELEASE}"
  mkdir -p "$DIR"
  chmod 0750 "$DIR"
  if [[ -n $ATS_ASSETS_DIR ]]; then
    cp "$ATS_ASSETS_DIR/compose.yml" "$DIR/compose.yml.new"
    cp "$ATS_ASSETS_DIR/garage.toml" "$DIR/garage.toml.new"
  else
    unbaked "$ATS_REPO" && die "this copy of the installer isn't from a release. Download it from the project's GitHub Releases page."
    local base="https://github.com/$ATS_REPO/releases/download/$ATS_RELEASE"
    curl -fsSL "$base/compose.yml" -o "$DIR/compose.yml.new"
    curl -fsSL "$base/garage.toml" -o "$DIR/garage.toml.new"
    if ! matches "$ATS_COMPOSE_SHA256" "$DIR/compose.yml.new" || ! matches "$ATS_GARAGE_SHA256" "$DIR/garage.toml.new"; then
      rm -f "$DIR/compose.yml.new" "$DIR/garage.toml.new"
      die "the downloaded files didn't match this release's checksums. Nothing was changed."
    fi
  fi
  ok "Release files ready"
}
# The release files fetch_assets prepared (and checked) take the place of the current ones.
use_new_files() {
  mv "$DIR/compose.yml.new" "$DIR/compose.yml"
  mv "$DIR/garage.toml.new" "$DIR/garage.toml"
}

rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-40}"; }
randhex() { head -c "${1:-32}" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Writes $DIR/.env, or the file in ENV_FILE (an update prepares the new settings beside the old).
write_env() {
  local env=${ENV_FILE:-$DIR/.env}
  local global="" tls=""
  [[ -n $EMAIL ]] && global="email $EMAIL"
  $TLS_INTERNAL && { global="local_certs"; tls="tls internal"; }
  if [[ ! -f $env ]]; then
    # Private from the start; the subshell keeps the umask from reaching other files written later.
    ( umask 077; cat >"$env" ) <<EOF
# All the Spaces — generated by the installer. Keep this file private; back it up somewhere safe.
ATS_APP_HOST=$DOMAIN
ATS_PLAY_HOST=$PLAY_DOMAIN
ATS_PUBLIC_URL=$(public_url "$DOMAIN")
ATS_PLAY_URL=$(public_url "$PLAY_DOMAIN")
ATS_CADDY_GLOBAL=$global
ATS_TLS_DIRECTIVE=$tls
POSTGRES_PASSWORD=$(rand 40)
BETTER_AUTH_SECRET=$(rand 48)
REALTIME_SECRET=$(rand 48)
GARAGE_RPC_SECRET=$(randhex 32)
GARAGE_ADMIN_TOKEN=$(rand 40)
S3_ACCESS_KEY_ID=GK$(randhex 12)
S3_SECRET_ACCESS_KEY=$(randhex 32)
S3_BUCKET=ats
S3_REGION=garage
EOF
    ok "Created private settings with fresh passwords"
  fi
  # Secrets introduced by newer releases are added to existing installs (never replaced).
  ensure_env REALTIME_SECRET "$(rand 48)"
  ensure_env SUPERVISOR_SECRET "$(rand 48)"
  ensure_env EGRESS_SECRET "$(rand 48)"
  # Voice chat (LiveKit): its key, and where browsers send audio (this server's public address,
  # or found by asking a STUN server if it couldn't be worked out here).
  ensure_env LIVEKIT_API_KEY "LK$(randhex 12)"
  ensure_env LIVEKIT_API_SECRET "$(rand 48)"
  local voice_ip
  voice_ip=$(public_ip)
  if [[ -n $voice_ip ]]; then
    set_env ATS_VOICE_IP "$voice_ip"
    set_env ATS_VOICE_FIND_IP false
  else
    set_env ATS_VOICE_FIND_IP true
  fi
  # Image references are updated on every run (they change with each release).
  set_env ATS_APP_IMAGE "$ATS_APP_IMAGE"
  set_env ATS_WEB_IMAGE "$ATS_WEB_IMAGE"
  set_env ATS_WORKBENCH_IMAGE "$ATS_WORKBENCH_IMAGE"
  set_env ATS_EGRESS_IMAGE "$ATS_EGRESS_IMAGE"
  # The supervisor reaches Docker through the docker group; sandboxes run under gVisor.
  set_env DOCKER_GID "$(getent group docker | cut -d: -f3)"
  set_env ATS_INSTANCE "$PROJECT"
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q runsc; then
    set_env ATS_SANDBOX_RUNTIME runsc
  else
    set_env ATS_SANDBOX_RUNTIME runc
  fi
  set_env ATS_RELEASE "$ATS_RELEASE"
  write_listen_env
}

# Where Caddy listens. Chosen on the first install and kept by updates (an update given one of
# these options again changes it).
write_listen_env() {
  if $BEHIND_PROXY && [[ $(get_env ATS_BEHIND_PROXY || true) != 1 ]]; then
    # Moving an installation behind a proxy: its public addresses lose any port of their own.
    set_env ATS_BEHIND_PROXY 1
    set_env ATS_PUBLIC_URL "$(public_url "$(get_env ATS_APP_HOST)")"
    set_env ATS_PLAY_URL "$(public_url "$(get_env ATS_PLAY_HOST)")"
  fi
  if behind_proxy; then
    [[ -z $BIND ]] || set_env ATS_BIND "$BIND"
    ensure_env ATS_BIND "$DEFAULT_BIND"
    [[ -z $TRUSTED_PROXIES ]] || set_env ATS_TRUSTED_PROXIES "$TRUSTED_PROXIES"
    ensure_env ATS_TRUSTED_PROXIES private_ranges
    # What compose.yml publishes instead of ports 80 and 443: plain HTTP on that one address.
    set_env ATS_CADDY_PUBLISH "$(get_env ATS_BIND):80"
  else
    [[ -z $HTTP_PORT ]] || set_env ATS_HTTP_PORT "$HTTP_PORT"
    [[ -z $HTTPS_PORT ]] || set_env ATS_HTTPS_PORT "$HTTPS_PORT"
    ensure_env ATS_HTTP_PORT 80
    ensure_env ATS_HTTPS_PORT 443
  fi
}

set_env() { # set_env KEY VALUE (in $DIR/.env, or ENV_FILE)
  local env=${ENV_FILE:-$DIR/.env} new
  if grep -q "^$1=" "$env"; then
    # Taken literally, whatever the value holds (sed would read | and & in it as its own syntax).
    # Written back in place, so the file keeps its permissions.
    new=$(K=$1 V=$2 awk 'index($0, ENVIRON["K"] "=") == 1 { print ENVIRON["K"] "=" ENVIRON["V"]; next } { print }' "$env")
    printf '%s\n' "$new" >"$env"
  else
    printf '%s=%s\n' "$1" "$2" >>"$env"
  fi
}
get_env() { grep "^$1=" "${ENV_FILE:-$DIR/.env}" 2>/dev/null | cut -d= -f2-; }
ensure_env() {
  local env=${ENV_FILE:-$DIR/.env}
  grep -q "^$1=" "$env" || printf '%s=%s\n' "$1" "$2" >>"$env"
}

open_firewall() {
  [[ $TEST_NON_ROOT == true ]] && return 0
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    # Voice chat's audio comes straight here, even behind a proxy.
    ufw allow 7881/tcp >/dev/null; ufw allow 7882/udp >/dev/null
    if behind_proxy; then
      ok "Opened voice chat's ports 7881–7882 in the firewall (your reverse proxy has the web ports)"
    else
      local http https
      http=$(get_env ATS_HTTP_PORT) https=$(get_env ATS_HTTPS_PORT)
      ufw allow "$http/tcp" >/dev/null; ufw allow "$https/tcp" >/dev/null; ufw allow "$https/udp" >/dev/null
      ok "Opened ports $http, $https and voice chat's 7881–7882 in the firewall"
    fi
  fi
  # Voice chat receives a lot of small UDP packets: a bigger receive buffer avoids dropouts.
  if [[ -d /etc/sysctl.d ]]; then
    printf 'net.core.rmem_max=5000000\nnet.core.rmem_default=5000000\n' >/etc/sysctl.d/90-all-the-spaces.conf
    sysctl -q -p /etc/sysctl.d/90-all-the-spaces.conf 2>/dev/null || true
  fi
}

# Connectors (docs/connectors.md) and repository hosts (docs/repositories.md): definitions in
# connectors/ and sources/, which the server reads (mounted read-only), and their secrets in
# connectors.env and sources.env, which only Compose reads. None is needed: an empty folder means
# none. The folders belong to root and the app containers' group (the image's node user, 1000),
# and files added to them get that group too; the .env files stay root's.
APP_GID=1000
prepare_connectors() {
  local kind
  for kind in connectors sources; do
    if [[ ! -d $DIR/$kind ]]; then
      mkdir -p "$DIR/$kind"
      # Testing without root, the test's user keeps it (readable by everyone, since it can't hand
      # it to that group).
      if chgrp "$APP_GID" "$DIR/$kind" 2>/dev/null; then
        chmod 2750 "$DIR/$kind"
      else
        chmod 0755 "$DIR/$kind"
      fi
    fi
    if [[ -f $DIR/$kind.env ]]; then chmod 600 "$DIR/$kind.env"; fi
  done
}

# ---- Running ------------------------------------------------------------------------------------
# Waits until every service is running, and healthy where it has a health check. Gives up early on
# one that keeps crashing (down three checks in a row, or restarted three times) or has been found
# unhealthy. Sets NOT_READY to the services that weren't: only the failing ones when it gives up
# early (the rest may simply not have finished starting), otherwise the troubled ones first.
# Nothing in here may trip the ERR trap: containers come and go while it looks (dc up recreates
# them), so a failed or garbled look is just "not ready yet".
wait_healthy() { # wait_healthy SECONDS
  local deadline=$((SECONDS + ${1:-240})) services failing down waiting id oneoff svc state restarts health
  local -A first_restarts=() down_checks=()
  services=$(dc config --services 2>/dev/null) || { NOT_READY=""; return 1; }
  while :; do
    failing="" down="" waiting=""
    local seen=" "
    while read -r id oneoff svc state restarts health; do
      [[ -n $id && -n $svc && $oneoff != True && $restarts =~ ^[0-9]+$ ]] || continue
      seen+="$svc "
      [[ -n ${first_restarts[$id]:-} ]] || first_restarts[$id]=$restarts
      if [[ $state == restarting || $state == exited || $state == dead ]]; then
        down_checks[$id]=$(( ${down_checks[$id]:-0} + 1 ))
      else
        down_checks[$id]=0
      fi
      if [[ $health == unhealthy ]] || (( restarts - ${first_restarts[$id]} >= 3 || ${down_checks[$id]} >= 3 )); then
        failing+=" $svc"
      elif (( ${down_checks[$id]} > 0 )); then
        down+=" $svc"
      elif [[ $state != running || ( -n $health && $health != healthy ) ]]; then
        waiting+=" $svc"
      fi
    # A container removed between ps and inspect makes inspect fail: the subshell inherits the ERR
    # trap (set -E), which would print a false "something unexpected went wrong".
    done < <(trap - ERR; dc ps -aq 2>/dev/null | xargs -r docker inspect -f \
      '{{.Id}} {{index .Config.Labels "com.docker.compose.oneoff"}} {{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true)
    for svc in $services; do [[ $seen == *" $svc "* ]] || waiting+=" $svc"; done
    if [[ -n $failing ]]; then
      NOT_READY=${failing# }
      return 1
    fi
    NOT_READY=$down$waiting
    NOT_READY=${NOT_READY# }
    [[ -z $NOT_READY ]] && return 0
    (( SECONDS < deadline )) || return 1
    sleep 3
  done
}

# Starts everything and waits for it all to be healthy (see wait_healthy).
start_all() { # start_all SECONDS
  if dc up -d --remove-orphans; then
    wait_healthy "$1"
  else
    wait_healthy 0 || true # only to name what isn't ready
    return 1
  fi
}

# Every image the current settings use, the workbench included.
release_images() {
  { dc config --images 2>/dev/null; get_env ATS_WORKBENCH_IMAGE; } | sort -u
}
# After a successful update: the images only the previous version used. Each update brings new
# ones (the workbench alone is about 3 GB), so keeping them would slowly fill the disk. An image
# still in use (say, by a running sandbox) stays; going back to that version downloads them again.
remove_old_images() { # remove_old_images "OLD IMAGE LIST"
  local img n=0
  while read -r img; do
    [[ -n $img ]] || continue
    docker rmi "$img" >/dev/null 2>&1 && n=$((n + 1))
  done < <(comm -23 <(printf '%s\n' "$1" | sort -u) <(release_images))
  (( n == 0 )) || ok "Removed $n image(s) only the previous version used"
}

# The Studio's workbench (sandboxes, previews, checks) isn't a service: the supervisor starts it
# when needed, so it's fetched here. Not fatal: the Studio says so if it's still missing.
pull_workbench() {
  local img; img=$(get_env ATS_WORKBENCH_IMAGE)
  docker image inspect "$img" >/dev/null 2>&1 && return 0
  docker pull -q "$img" >/dev/null 2>&1 ||
    warn "The Studio's workbench couldn't be downloaded yet. Run the installer with --update later to try again."
}

# Downloads everything a release needs (with its compose.yml.new and settings) while whatever is
# running carries on. Pull failures are tolerated so locally built test images work; anything still
# missing afterwards stops here, before anything has changed.
pull_release() { # pull_release ENV_FILE
  dc_with "$DIR/compose.yml.new" "$1" pull --quiet --ignore-pull-failures || true
  local img missing=""
  for img in $(dc_with "$DIR/compose.yml.new" "$1" config --images); do
    docker image inspect "$img" >/dev/null 2>&1 || missing+=" $img"
  done
  [[ -z $missing ]] || die "some of ${ATS_RELEASE}'s files couldn't be downloaded (${missing# }). Nothing was changed; try again in a while."
  verify_signatures "$1"
  ENV_FILE=$1 pull_workbench
  # Testing only: something to do while the space is still running, just before the update's backup.
  if [[ -n ${ATS_TEST_AFTER_PULL:-} ]]; then bash -c "$ATS_TEST_AFTER_PULL"; fi
}

# When cosign is installed: our four images were signed by this project's release workflow, for
# this release (keyless, with GitHub Actions' identity). Without it, pulling by digest still
# guarantees they're exactly the images this installer names.
verify_signatures() { # verify_signatures ENV_FILE
  command -v cosign >/dev/null || return 0
  local key img n=0
  for key in ATS_APP_IMAGE ATS_WEB_IMAGE ATS_EGRESS_IMAGE ATS_WORKBENCH_IMAGE; do
    img=$(ENV_FILE=$1 get_env "$key")
    [[ $img == *@sha256:* ]] || continue # built locally (testing): nothing was signed
    cosign verify --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      --certificate-identity "https://github.com/$ATS_REPO/.github/workflows/release.yml@refs/tags/$ATS_RELEASE" \
      "$img" >/dev/null 2>&1 ||
      die "$img isn't signed by this project's release workflow for $ATS_RELEASE, so it wasn't used. Nothing was changed."
    n=$((n + 1))
  done
  (( n == 0 )) || ok "Signatures checked with cosign"
}

# Names the services that didn't start and where to look.
not_ready_advice() {
  local first=${NOT_READY%% *}
  printf '%s' "${NOT_READY:-something} didn't start properly. See what happened with: sudo ats-admin logs ${first:-server}"
}

start_stack() {
  step "Starting your space (the first start takes a few minutes)"
  pull_release "$DIR/.env"
  use_new_files
  if ! start_all 300; then
    die "$(not_ready_advice)
  Once that's sorted (or if it was a passing network problem), run the installer again: it picks up where it left off."
  fi
  # Only now is this a working installation: until then, running the installer again finishes the
  # first install instead of offering an update (which needs a running stack to back up).
  printf '%s %s\n' "$ATS_RELEASE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$DIR/.installed"
  ok "Everything is running"
}

# Stored files (creations, their sources, reports, built spaces) are copied by a one-off app
# container: it's the only thing that can reach the built-in storage. Each distinct file is kept
# once per backup, hard-linked from the previous backup when unchanged, so backups stay cheap.
storage_files() { # storage_files backup|restore DIR
  local mount arg
  if [[ $1 == backup ]]; then
    mount="$(dirname "$2"):/backups"; arg=/backups/$(basename "$2")
  else
    mount="$2:/restore:ro"; arg=/restore
  fi
  dc run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$mount" server \
    node apps/server/src/cli/storage-backup.ts "$1" "$arg" 2>&1 |
    sed -E '/^ *Container .* Creat(ing|ed) *$/d; s/^/    /'
}

# A backup holds the database, the stored files and the settings; never Docker volumes such as
# Architects' sign-ins. Sets $BACKUP. A backup that fails part-way is removed.
backup() { # backup LABEL
  BACKUP="$DIR/backups/$(date -u +%Y%m%dT%H%M%SZ)-$1"
  if mkdir -p "$BACKUP" &&
    dc exec -T postgres pg_dump -U ats -d ats --clean --if-exists | gzip >"$BACKUP/database.sql.gz" &&
    storage_files backup "$BACKUP" &&
    cp "$DIR/.env" "$DIR/compose.yml" "$DIR/garage.toml" "$BACKUP/" &&
    copy_connectors "$DIR" "$BACKUP"; then
    return 0
  fi
  rm -rf "$BACKUP"
  return 1
}
# Connectors' and repository hosts' definitions and secrets, where there are any, with their
# owners and permissions.
copy_connectors() { # copy_connectors FROM_DIR TO_DIR
  local kind
  for kind in connectors sources; do
    if [[ -d $1/$kind ]]; then rm -rf "${2:?}/$kind" && cp -a "$1/$kind" "$2/" || return 1; fi
    if [[ -f $1/$kind.env ]]; then cp -p "$1/$kind.env" "$2/" && chmod 600 "$2/$kind.env" || return 1; fi
  done
}

# Everything that works with the data: the app's services, the supervisor, and the sandboxes,
# previews and build steps it started (labelled with this installation's name).
stop_data_users() {
  dc stop server realtime worker supervisor >/dev/null 2>&1 || true
  local ids
  ids=$(docker ps -q --filter "label=io.allthespaces.instance=$(get_env ATS_INSTANCE || echo "$PROJECT")" || true)
  # shellcheck disable=SC2086 # one ID per word
  [[ -z $ids ]] || docker stop $ids >/dev/null 2>&1 || true
}

restore_database() { # restore_database BACKUP_DIR
  # Recreate the database from scratch so nothing a bad version added (new tables, columns) survives.
  stop_data_users
  dc exec -T postgres psql -q -U ats -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE IF EXISTS ats WITH (FORCE)' -c 'CREATE DATABASE ats OWNER ats' >/dev/null
  gunzip -c "$1/database.sql.gz" | dc exec -T postgres psql -q -U ats -d ats -v ON_ERROR_STOP=1 >/dev/null
}

install_admin_helper() {
  [[ $TEST_NON_ROOT == true ]] && return 0
  local here="" tmp
  # The copy beside this installer, when it was run from a file rather than piped into bash.
  if [[ -f ${BASH_SOURCE[0]:-} ]]; then here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/ats-admin; fi
  tmp=$(mktemp)
  if [[ -n $ATS_ASSETS_DIR && -f $ATS_ASSETS_DIR/ats-admin ]]; then
    cp "$ATS_ASSETS_DIR/ats-admin" "$tmp"
  elif [[ -n $here && -f $here ]]; then
    cp "$here" "$tmp"
  elif ! unbaked "$ATS_REPO"; then
    curl -fsSL "https://github.com/$ATS_REPO/releases/download/$ATS_RELEASE/ats-admin" -o "$tmp"
  fi
  if [[ -s $tmp ]]; then
    matches "$ATS_ADMIN_SHA256" "$tmp" ||
      { rm -f "$tmp"; die "ats-admin didn't match this release's checksum, so it wasn't installed."; }
    install -m 0755 "$tmp" /usr/local/bin/ats-admin
  fi
  rm -f "$tmp"
  # Sourced by ats-admin: quoted, so a folder with spaces in its name works.
  printf 'DIR=%q\nPROJECT=%q\nATS_REPO=%q\n' "$DIR" "$PROJECT" "$ATS_REPO" >/etc/all-the-spaces.conf
  install_backup_timer
}

# Scheduled backups: a timer runs 'ats-admin backup --auto' every night, which follows the schedule
# chosen in setup (nightly, weekly or off; changeable any time) and removes scheduled backups older
# than chosen. It runs on the server itself because only it can reach the database and disk.
install_backup_timer() {
  if [[ ! -d /run/systemd/system ]]; then
    warn "This server doesn't use systemd, so scheduled backups aren't set up. Run 'ats-admin backup --auto' from cron every night instead."
    return 0
  fi
  cat >/etc/systemd/system/all-the-spaces-backup.service <<'UNIT'
[Unit]
Description=All the Spaces scheduled backup
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
# Docker looks for its settings in the home folder, which services otherwise lack.
Environment=HOME=/root
ExecStart=/usr/local/bin/ats-admin backup --auto
Nice=10
IOSchedulingClass=idle
UNIT
  cat >/etc/systemd/system/all-the-spaces-backup.timer <<'UNIT'
[Unit]
Description=All the Spaces scheduled backup

[Timer]
OnCalendar=*-*-* 03:15
RandomizedDelaySec=45min
# Catches up after the server was off at that time.
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now all-the-spaces-backup.timer >/dev/null 2>&1 ||
    warn "Scheduled backups couldn't be switched on. Try: sudo systemctl enable --now all-the-spaces-backup.timer"
}

# One backup, update or restore at a time: ats-admin's scheduled backups wait for updates.
lock_backups() {
  exec 9>"$DIR/.backup.lock"
  flock -w 1800 9 || die "a backup or restore is still running. Try again in a few minutes."
}

print_setup_code() {
  local code
  code=$(dc exec -T server node apps/server/src/cli/setup-code.ts 2>/dev/null | awk '/Setup code:/ {print $3}')
  say ""
  say "  ${bold}Your space is ready to set up.${reset}"
  say ""
  say "  1. Open  ${bold}$(get_env ATS_PUBLIC_URL)/setup${reset}"
  if [[ -n $code ]]; then
    say "  2. Enter this setup code:  ${bold}$code${reset}"
  else
    say "  2. Get your setup code with:  ${bold}sudo ats-admin setup-code${reset}"
  fi
  say ""
  say "  ${dim}Lost the code? Run 'sudo ats-admin setup-code' for a new one.${reset}"
}

# Behind a proxy: what to add to it. (nginx's is in docs/self-hosting.md.)
print_proxy_advice() {
  behind_proxy || return 0
  local bind app play
  bind=$(get_env ATS_BIND) app=$(get_env ATS_APP_HOST) play=$(get_env ATS_PLAY_HOST)
  say ""
  say "  ${bold}Your reverse proxy passes both addresses on to http://$bind${reset}, keeping the"
  say "  Host header (with Caddy, add this to its Caddyfile and reload it):"
  say ""
  say "    $app, $play {"
  say "        reverse_proxy $bind"
  say "    }"
  say ""
  say "  Voice chat also needs ports 7881/tcp and 7882/udp open to this server directly."
  say "  ${dim}nginx, Cloudflare and more: 'Behind an existing reverse proxy' in docs/self-hosting.md.${reset}"
}

# ---- Modes --------------------------------------------------------------------------------------
# Installed means the first start finished. Installations from before the marker existed count
# when their server is up and healthy.
installed() {
  [[ -f $DIR/.installed ]] && return 0
  [[ -f $DIR/compose.yml ]] || return 1
  [[ $(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q server 2>/dev/null)" 2>/dev/null) == healthy ]] || return 1
  printf '%s (found running)\n' "$(get_env ATS_RELEASE)" >"$DIR/.installed"
}

# A first install that didn't finish keeps its settings (and passwords, which the database may
# already use); a new --domain replaces the saved address.
resume_install() {
  local saved; saved=$(get_env ATS_APP_HOST)
  step "Finishing the earlier installation, which didn't start properly"
  [[ -z $DOMAIN ]] || DOMAIN=$(bare_host "$DOMAIN")
  if [[ -n $DOMAIN && $DOMAIN != "$saved" ]] || [[ -n $PLAY_DOMAIN ]]; then
    DOMAIN=${DOMAIN:-$saved}
    PLAY_DOMAIN=$(bare_host "${PLAY_DOMAIN:-play.$DOMAIN}")
    set_env ATS_APP_HOST "$DOMAIN"
    set_env ATS_PLAY_HOST "$PLAY_DOMAIN"
    set_env ATS_PUBLIC_URL "$(public_url "$DOMAIN")"
    set_env ATS_PLAY_URL "$(public_url "$PLAY_DOMAIN")"
    ok "Changed the web address from $saved to $DOMAIN (creations on $PLAY_DOMAIN)"
  else
    DOMAIN=$saved
    ok "Using the settings from before ($DOMAIN)"
  fi
}

do_install() {
  check_system
  install_docker
  install_gvisor
  if installed; then
    say ""
    say "  All the Spaces is already installed here ($(get_env ATS_RELEASE))."
    if confirm "Update it to ${ATS_RELEASE}?" y; then do_update; fi
    exit 0
  fi
  unbaked "$ATS_APP_IMAGE" && die "this installer doesn't know which version to install. Download it from the project's GitHub Releases page."
  if [[ -f $DIR/.env ]]; then resume_install; else choose_domain; check_bind; fi
  fetch_assets
  write_env
  prepare_connectors
  open_firewall
  install_admin_helper
  start_stack
  print_setup_code
  print_proxy_advice
}

do_update() {
  if ! installed; then
    [[ -f $DIR/.env ]] && die "the first installation here didn't finish. Run the installer again without --update to finish it."
    die "there's nothing to update in $DIR yet. Run the installer without --update first."
  fi
  local from old_images; from=$(get_env ATS_RELEASE)
  if [[ -n $ATS_MIN_FROM_RELEASE ]] && older_than "$from" "$ATS_MIN_FROM_RELEASE"; then
    die "$ATS_RELEASE can't update $from directly. Update to $ATS_MIN_FROM_RELEASE first:
  curl -fsSL https://github.com/$ATS_REPO/releases/download/$ATS_MIN_FROM_RELEASE/install.sh | sudo bash -s -- --update --dir $DIR
  then run this installer again. Nothing was changed."
  fi
  old_images=$(release_images)
  lock_backups
  step "Updating from $from to $ATS_RELEASE"
  # Moving behind a proxy, or to another address there: that address must be free.
  if { $BEHIND_PROXY && [[ $(get_env ATS_BEHIND_PROXY || true) != 1 ]]; } ||
    [[ -n $BIND && $BIND != "$(get_env ATS_BIND || true)" ]]; then
    check_bind
  fi
  # First the slow part that's most likely to fail, downloading, while your space keeps running.
  # The new settings are prepared beside the current ones; nothing running changes yet.
  fetch_assets
  cp -p "$DIR/.env" "$DIR/.env.new"
  ENV_FILE=$DIR/.env.new write_env
  pull_release "$DIR/.env.new"
  ok "Downloaded"
  prepare_connectors
  install_admin_helper

  # The backup needs room: about as much as the newest one took (unchanged stored files are shared
  # with it, so that's generous), and at least 2 GB. Checked before anything stops.
  local newest="" need=2 size
  if [[ -d $DIR/backups ]]; then # not before the first update
    newest=$(find "$DIR/backups" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
  fi
  if [[ -n $newest ]]; then
    size=$(du -s -BG "$newest" 2>/dev/null | cut -f1 | tr -dc '0-9' || true)
    if (( ${size:-0} > need )); then need=$size; fi
  fi
  if (( $(free_gb "$DIR/backups") < need )); then
    die "there's only $(free_gb "$DIR/backups") GB of free disk space for the backup taken before updating, which needs about $need GB. Nothing was changed."
  fi

  # Then the backup, with the parts that change data stopped: it holds exactly what the update
  # starts from, and the database and stored files match each other.
  step "Backing up (your space is offline until the update is done)"
  local at; at=$(date +'%H:%M %Z')
  RESTART_ON_ERROR=true
  dc stop server realtime worker >/dev/null 2>&1
  if ! backup "before-$ATS_RELEASE"; then
    dc up -d >/dev/null 2>&1 || true
    die "I couldn't make a backup first, so nothing was changed. Is there enough free disk space?"
  fi
  local saved=$BACKUP
  ok "Backed up to $saved"
  printf '%s\n' "$saved" >"$DIR/.last-backup"

  step "Starting $ATS_RELEASE"
  mv "$DIR/.env.new" "$DIR/.env"
  use_new_files
  RESTART_ON_ERROR=false
  if start_all 300; then
    ok "Updated to $ATS_RELEASE"
    remove_old_images "$old_images"
    if $BEHIND_PROXY || [[ -n $BIND ]]; then print_proxy_advice; fi
  else
    warn "In $ATS_RELEASE, ${NOT_READY:-something} didn't start properly. Putting everything back as it was…"
    rollback_to "$saved"
    die "the update to $ATS_RELEASE didn't work, so your space was restored to $from, with everything as it was at $at when the update began. Anything done with $ATS_RELEASE in the meantime was undone."
  fi
}

rollback_to() { # rollback_to BACKUP_DIR
  # Stopped first: a failing server keeps restarting, and Docker recreates a bind-mounted folder
  # it finds missing (as root), so it could take the connectors folder while it's being replaced.
  stop_data_users
  cp "$1/compose.yml" "$DIR/compose.yml"
  cp "$1/.env" "$DIR/.env"
  # Backups from before garage.toml (or connectors) were kept in them leave the current ones.
  if [[ -f $1/garage.toml ]]; then cp "$1/garage.toml" "$DIR/garage.toml"; fi
  copy_connectors "$1" "$DIR"
  # Its images were removed after the update that replaced it: 'up' fetches the services' again.
  pull_workbench
  restore_database "$1"
  # Stored files the bad version added or changed are put back as they were, too.
  local files=true
  storage_files restore "$1" || files=false
  if ! start_all 300; then
    die "the rollback also had trouble starting ($(not_ready_advice)). Your backup is safe in $1."
  fi
  $files || die "the previous version is running again, but its stored files couldn't all be put back. Your backup is safe in $1; try: sudo ats-admin restore $1"
  ok "Restored the version from $(basename "$1")"
}

do_rollback() {
  local last
  last=$(cat "$DIR/.last-backup" 2>/dev/null || true)
  [[ -n $last && -d $last ]] || die "there's no earlier version to go back to."
  step "Going back to the version saved in $(basename "$last")"
  confirm "This also restores the data from that moment. Anything changed since then will be lost. Continue?" n || exit 1
  lock_backups
  rollback_to "$last"
}

say "${bold}All the Spaces installer${reset} ${dim}${ATS_RELEASE}${reset}"
case $MODE in
  install) do_install ;;
  update) check_system; do_update ;;
  rollback) do_rollback ;;
esac
