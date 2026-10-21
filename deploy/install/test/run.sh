#!/usr/bin/env bash
# End-to-end installer test: a first install that fails and is run again → setup → update → an
# update that can't download → broken updates (server, worker) with automatic rollback → backup and
# restore with ats-admin, which stops the supervisor and its sandboxes too → scheduled backups,
# clearing out old ones and the off-site copy → ats-admin update/rollback on a non-default folder →
# a second install behind an existing reverse proxy, and an update that keeps it there.
# Stored files (the object store) are checked along with data.
# The "off-site" bucket is a second bucket in the test's own Garage. Runs as a separate Compose
# project on its own ports, so it never touches anything else.
#
#   deploy/install/test/run.sh            # builds images from this checkout
#   APP_IMAGE=… WEB_IMAGE=… run.sh        # or test given images
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
WORK=$(mktemp -d)
PROJECT=ats-installtest
HTTP_PORT=${HTTP_PORT:-45480}
HTTPS_PORT=${HTTPS_PORT:-45444}
DOMAIN=app.installtest.localhost
BASE="https://$DOMAIN:$HTTPS_PORT"
# Behind a proxy (section 12): its own folder, where Caddy listens for the proxy, and addresses
# set up the way Cloudflare's certificates need (no second level of subdomain).
PWORK=$WORK/proxy
PROXY_PORT=${PROXY_PORT:-45486}
PDOMAIN=spaces.proxytest.localhost
PPLAY=spaces-play.proxytest.localhost
APP_IMAGE=${APP_IMAGE:-ats-app:installtest}
WEB_IMAGE=${WEB_IMAGE:-ats-web:installtest}
EGRESS_IMAGE=${EGRESS_IMAGE:-ats-egress:installtest}
# The workbench is large and only needed when a sandbox starts: any small local image stands in.
WORKBENCH_IMAGE=${WORKBENCH_IMAGE:-ats-egress:installtest}

pass() { printf '  \e[32m✓\e[0m %s\n' "$*"; }
fail() { printf '  \e[31m✗ %s\e[0m\n' "$*" >&2; exit 1; }
cleanup() {
  docker rm -f "$PROJECT-test-sandbox" >/dev/null 2>&1 || true
  docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" down -v >/dev/null 2>&1 || true
  docker compose -p "$PROJECT" --project-directory "$PWORK" -f "$PWORK/compose.yml" down -v >/dev/null 2>&1 || true
  docker rmi ats-app:installtest-v1 ats-app:installtest-v2 ats-app:installtest-broken ats-app:installtest-nostart \
    ats-app:installtest-noworker >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

installer() { # installer RELEASE APP_IMAGE [args…] (installs in $IDIR, by default $WORK)
  local release=$1 app=$2; shift 2
  env ATS_TEST_NON_ROOT=true ATS_TEST_MIN_DISK_GB=5 ATS_PROJECT=$PROJECT ATS_ASSETS_DIR="$ROOT/deploy/compose" ATS_REPO=local/test \
    ATS_RELEASE="$release" ATS_APP_IMAGE="$app" ATS_WEB_IMAGE="$WEB_IMAGE" \
    ATS_EGRESS_IMAGE="$EGRESS_IMAGE" ATS_WORKBENCH_IMAGE="$WORKBENCH_IMAGE" \
    bash "$ROOT/deploy/install/install.sh" --yes --dir "${IDIR:-$WORK}" --skip-docker-install --no-gvisor "$@"
}
# A first install's ports. Updates aren't given them again: the saved ones must be kept.
PORTS=(--http-port "$HTTP_PORT" --https-port "$HTTPS_PORT")
dc() { docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" "$@"; }
get() { curl -sk --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" --resolve "play.$DOMAIN:$HTTPS_PORT:127.0.0.1" "$@"; }
psql_q() { docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" exec -T postgres psql -U ats -d ats -tAc "$1"; }
s3() { # s3 'JS' — runs in the server container with the storage client as `s3`
  docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" exec -T -w /app/apps/server server \
    node --input-type=module -e "import { createStorage } from '@ats/storage';
const e = process.env;
const s3 = createStorage({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION, bucket: e.S3_BUCKET,
  accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY });
$1"
}
object() { s3 "process.stdout.write(await s3.getBytes('$1').then((b) => new TextDecoder().decode(b), () => '<missing>'));"; }
# The off-site bucket, as `off`, and this server's folder in it, as `target` (see the s3 helper).
OFFSITE_KEY=GK$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
OFFSITE_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
off() {
  s3 "const { listOffsite } = await import('@ats/storage');
const off = createStorage({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION, bucket: 'ats-offsite',
  accessKeyId: '$OFFSITE_KEY', secretAccessKey: '$OFFSITE_SECRET' });
const target = { storage: off, prefix: 'all-the-spaces/$DOMAIN' };
$1"
}
# A one-off app container with the backups folder mounted, like ats-admin's.
cli() { dc run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$WORK/backups:/backups" server node "apps/server/src/cli/$1" "${@:2}" </dev/null 2>&1; }
admin() { env ATS_ADMIN_CONF=/nonexistent DIR="$WORK" PROJECT="$PROJECT" bash "$ROOT/deploy/install/ats-admin" "$@"; }
wait_api() {
  for _ in $(seq 60); do [[ $(get -o /dev/null -w '%{http_code}' "$BASE/api/health") == 200 ]] && return 0; sleep 2; done
  return 1
}
ok_soon() { # ok_soon URL: answers 200 within about 30 seconds
  for _ in $(seq 15); do [[ $(get -o /dev/null -w '%{http_code}' "$1") == 200 ]] && return 0; sleep 2; done
  return 1
}

if [[ -z ${SKIP_BUILD:-} ]]; then
  echo "Building images…"
  docker build -q -f "$ROOT/images/app/Dockerfile" -t "$APP_IMAGE" "$ROOT" >/dev/null
  docker build -q -f "$ROOT/images/web/Dockerfile" -t "$WEB_IMAGE" "$ROOT" >/dev/null
  docker build -q -f "$ROOT/images/egress/Dockerfile" -t "$EGRESS_IMAGE" "$ROOT" >/dev/null
fi

echo "1. A first install that fails can be run again"
mkdir "$WORK/nostart"
echo "throw new Error('first start fails');" >"$WORK/nostart/main.ts"
printf '%s\n' "FROM $APP_IMAGE" 'COPY main.ts apps/server/src/main.ts' >"$WORK/nostart/Dockerfile"
docker build -q -t ats-app:installtest-nostart "$WORK/nostart" >/dev/null
if installer v0.0.1-test ats-app:installtest-nostart --domain "$DOMAIN" --tls-internal "${PORTS[@]}" >"$WORK/nostart.log" 2>&1; then
  fail "a first install that never started was reported as working"
fi
grep -q 'run the installer again' "$WORK/nostart.log" || { cat "$WORK/nostart.log"; fail "no advice to run the installer again"; }
[[ ! -e $WORK/.installed ]] || fail "a first install that never started was marked as installed"
if installer v0.0.1-test ats-app:installtest-nostart --update >"$WORK/nostart-update.log" 2>&1; then
  fail "--update went ahead on an unfinished install"
fi
grep -q "didn't finish" "$WORK/nostart-update.log" || { cat "$WORK/nostart-update.log"; fail "--update didn't explain"; }
pass "the failed first start is reported, not marked as installed, and --update says to finish it first"

echo "2. Fresh install (finishing the one that failed)"
# Each release gets its own tag: a successful update removes the previous release's images.
docker tag "$APP_IMAGE" ats-app:installtest-v1
installer v0.0.1-test ats-app:installtest-v1 --domain "$DOMAIN" --tls-internal "${PORTS[@]}" >"$WORK/install.log" 2>&1 ||
  { cat "$WORK/install.log"; fail "install failed"; }
grep -q 'All the Spaces is already installed' "$WORK/install.log" && { cat "$WORK/install.log"; fail "the unfinished install was taken for a working one"; }
grep -q 'Finishing the earlier installation' "$WORK/install.log" || { cat "$WORK/install.log"; fail "didn't pick up the unfinished install"; }
[[ -f $WORK/.installed ]] || fail "not marked as installed"
[[ $(stat -c %a "$WORK/.env") == 600 ]] || fail "the settings file isn't private"
grep -q 'Setup code:' "$WORK/install.log" || grep -q 'setup code' "$WORK/install.log" || fail "no setup code printed"
# The first requests right after the install may retry for a while: a slow ARM runner once got
# no answer to GET / straight after the installer finished.
for path in / /api/health /manifest.webmanifest /rt/__healthcheck /sw.js /icons/icon-192.png; do
  ok_soon "$BASE$path" || fail "GET $path"
done
get -I "$BASE/" | grep -qi '^content-security-policy:' || fail "missing CSP header"
# Link previews need the picture's full address, which Caddy fills in. (The page is read whole
# first: grep -q stops at the first match, and curl writing into the closed pipe would fail.)
og="<meta property=\"og:image\" content=\"https://$DOMAIN/icons/og-image.png\""
page=$(get "$BASE/")
grep -qF "$og" <<<"$page" || fail "og:image isn't an absolute address"
page=$(get "$BASE/some/page")
grep -qF "$og" <<<"$page" || fail "og:image isn't an absolute address on other pages"
# The play origin serves creations only: never the app's API.
play=$(get -o /dev/null -w '%{http_code}' "https://play.$DOMAIN:$HTTPS_PORT/api/health")
[[ $play == 404 ]] || fail "play origin (API answered with $play there)"
for svc in supervisor egress; do
  [[ -n $(docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" ps -q --status running "$svc") ]] ||
    fail "$svc isn't running"
done
# Caddy faces the internet: it gets its hostnames and TLS settings, never the other secrets.
caddy_env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(dc ps -q caddy)")
grep -Eq '^(POSTGRES_|BETTER_AUTH_|S3_|GARAGE_|LIVEKIT_|REALTIME_|SUPERVISOR_|EGRESS_)' <<<"$caddy_env" &&
  fail "Caddy can see secrets it doesn't need"
for id in $(dc ps -q); do
  name=$(docker inspect -f '{{.Name}}' "$id")
  [[ $(docker inspect -f '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}}' "$id") == 'json-file 20m' ]] ||
    fail "$name keeps its logs forever"
  # The installer waited for every part's health check, so each needs one.
  [[ $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id") == healthy ]] ||
    fail "$name has no health check, or isn't healthy"
done
dc exec -T server touch /var/cache/ats-assets/first ||
  fail "the server can't write its asset cache (textures and models would be missing)"
pass "installed; app, API, realtime, PWA files, CSP, play origin, supervisor and egress all respond; all healthy"

# Not behind a proxy: Caddy has the web ports on every address, with HTTPS, as always.
grep -q '^ATS_BEHIND_PROXY=\|^ATS_BIND=\|^ATS_CADDY_PUBLISH=' "$WORK/.env" && fail "proxy settings in a normal install"
[[ $(docker inspect -f '{{json .Config.Cmd}}' "$(dc ps -q caddy)") == *'"/etc/caddy/Caddyfile"'* ]] || fail "Caddy isn't using the normal Caddyfile"
caddy_ports=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$(dc ps -q caddy)")
[[ $caddy_ports == "{\"443/tcp\":[{\"HostIp\":\"\",\"HostPort\":\"$HTTPS_PORT\"}],\"443/udp\":[{\"HostIp\":\"\",\"HostPort\":\"$HTTPS_PORT\"}],\"80/tcp\":[{\"HostIp\":\"\",\"HostPort\":\"$HTTP_PORT\"}]}" ]] ||
  fail "Caddy's ports aren't the web ports on every address ($caddy_ports)"
redirect=$(curl -s --resolve "$DOMAIN:$HTTP_PORT:127.0.0.1" -o /dev/null -w '%{http_code} %{redirect_url}' "http://$DOMAIN:$HTTP_PORT/")
[[ $redirect == "308 https://$DOMAIN"* ]] || fail "plain HTTP isn't sent to HTTPS ($redirect)"
[[ -d $WORK/connectors && ! -e $WORK/connectors.env ]] || fail "no empty connectors folder (or a connectors.env nobody wrote)"
[[ -d $WORK/sources && ! -e $WORK/sources.env ]] || fail "no empty sources folder (or a sources.env nobody wrote)"
pass "normal mode: Caddy has the web ports on every address and sends HTTP to HTTPS; an empty connectors folder"

echo "3. Finish setup (creates data that must survive updates)"
code=$(docker compose -p "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" exec -T server \
  node apps/server/src/cli/setup-code.ts | awk '/Setup code:/ {print $3}')
# The off-site bucket, with its own key, is set up before setup checks it can write there.
s3 "const { bootstrapGarage } = await import('@ats/storage');
await bootstrapGarage({ adminUrl: e.GARAGE_ADMIN_URL, adminToken: e.GARAGE_ADMIN_TOKEN,
  accessKeyId: '$OFFSITE_KEY', secretAccessKey: '$OFFSITE_SECRET', bucket: 'ats-offsite' });"
offsite_json="{\"endpoint\":\"http://garage:3900\",\"region\":\"garage\",\"bucket\":\"ats-offsite\",\"accessKeyId\":\"$OFFSITE_KEY\",\"secretAccessKey\":\"$OFFSITE_SECRET\"}"
wrong_key="\"endpoint\":\"http://garage:3900\",\"region\":\"garage\",\"bucket\":\"ats-offsite\",\"accessKeyId\":\"$OFFSITE_KEY\",\"secretAccessKey\":\"wrong\""
[[ $(get -o /dev/null -w '%{http_code}' -X POST "$BASE/api/setup/test-offsite" -H 'content-type: application/json' \
  -d "{$wrong_key}") == 403 ]] || fail "bucket check answered without the setup code"
[[ $(get -o /dev/null -w '%{http_code}' -X POST "$BASE/api/setup/test-offsite" -H 'content-type: application/json' \
  -d "{\"code\":\"$code\",$wrong_key}") == 400 ]] || fail "a wrong off-site key was accepted"
get -X POST "$BASE/api/setup/complete" -H 'content-type: application/json' \
  -d "{\"code\":\"$code\",\"group\":{\"name\":\"Installer Test House\"},\"architect\":{\"name\":\"Tess\",\"email\":\"tess@example.test\",\"password\":\"installer-test-password\"},\"storage\":{\"mode\":\"builtin\"},\"backup\":{\"keepDays\":3,\"offsite\":$offsite_json}}" |
  grep -q '"ok":true' || fail "setup did not complete"
psql_q "select backup::text from install_state" | grep -q "$OFFSITE_SECRET" && fail "off-site secret stored in the clear"
s3 "await s3.put('test/a.txt', 'original A', 'text/plain'); await s3.put('test/b.bin', new Uint8Array([1, 2, 3]));"
pass "setup completed, with backups copied off-site"

echo "4. Normal update"
docker tag "$APP_IMAGE" ats-app:installtest-v2
# A connector's definition and secret (only the folder and file matter here, not what's in them).
echo 'Connectors go here.' >"$WORK/connectors/README"
printf 'ATS_TEST_CONNECTOR_SECRET=only-for-the-server\n' >"$WORK/connectors.env"
chmod 644 "$WORK/connectors.env"
echo 'Repository hosts go here.' >"$WORK/sources/README"
printf 'ATS_SOURCE_TEST_TOKEN=only-for-the-server-too\n' >"$WORK/sources.env"
chmod 644 "$WORK/sources.env"
# An asset cache as servers installed before v0.2.18 have it: root's, with a file in it.
dc run --rm --no-deps -T --user 0 --cap-add CHOWN server sh -c \
  'touch /var/cache/ats-assets/old && chown -R root:root /var/cache/ats-assets' >/dev/null 2>&1 ||
  fail "couldn't make the asset cache root's"
# Without the port options (as 'ats-admin update' runs it): the saved ports are kept.
installer v0.0.2-test ats-app:installtest-v2 --update >"$WORK/update.log" 2>&1 || { cat "$WORK/update.log"; fail "update failed"; }
grep -q '^ATS_RELEASE=v0.0.2-test' "$WORK/.env" || fail "release not recorded"
grep -qx "ATS_HTTPS_PORT=$HTTPS_PORT" "$WORK/.env" || fail "the update didn't keep the saved HTTPS port"
grep -qx "ATS_HTTP_PORT=$HTTP_PORT" "$WORK/.env" || fail "the update didn't keep the saved HTTP port"
[[ $(get -o /dev/null -w '%{http_code}' "$BASE/api/health") == 200 ]] || fail "not answering on the saved port after the update"
connector_backup=$(echo "$WORK"/backups/*-before-v0.0.2-test)
[[ -f $connector_backup/connectors/README && $(stat -c %a "$connector_backup/connectors.env") == 600 ]] ||
  fail "connectors not in the update's backup, or their secrets not private there"
[[ $(stat -c %a "$WORK/connectors.env") == 600 ]] || fail "connectors.env was left readable"
[[ -f $connector_backup/sources/README && $(stat -c %a "$connector_backup/sources.env") == 600 ]] ||
  fail "repository hosts not in the update's backup, or their token not private there"
[[ $(stat -c %a "$WORK/sources.env") == 600 ]] || fail "sources.env was left readable"
# shellcheck disable=SC2016 # expanded in the server's container
[[ $(dc exec -T server sh -c 'cat "$ATS_SOURCES_DIR/README"; printenv ATS_SOURCE_TEST_TOKEN') == $'Repository hosts go here.\nonly-for-the-server-too' ]] ||
  fail "the server can't see the sources folder or sources.env"
# shellcheck disable=SC2016 # expanded in the server's container
[[ $(dc exec -T server sh -c 'cat "$ATS_CONNECTORS_DIR/README"; printenv ATS_TEST_CONNECTOR_SECRET') == $'Connectors go here.\nonly-for-the-server' ]] ||
  fail "the server can't see the connectors folder or connectors.env"
for svc in caddy realtime worker supervisor; do
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(dc ps -q "$svc")" | grep -qE '^ATS_(TEST_CONNECTOR_SECRET|SOURCE_TEST_TOKEN)=' &&
    fail "$svc can see connectors.env or sources.env"
done
dc exec -T server sh -c 'touch /var/cache/ats-assets/new && [ -O /var/cache/ats-assets/old ]' ||
  fail "the server can't write its asset cache after the update (textures and models would be missing)"
[[ $(psql_q "select name from groups") == "Installer Test House" ]] || fail "data lost during update"
[[ $(object test/a.txt) == "original A" ]] || fail "stored file lost during update"
grep -q '"test/b.bin"' "$WORK"/backups/*-before-v0.0.2-test/storage.json || fail "stored files not in the update's backup"
docker image inspect ats-app:installtest-v1 >/dev/null 2>&1 && fail "the previous version's image wasn't removed"
docker image inspect ats-app:installtest-v2 "$WEB_IMAGE" "$EGRESS_IMAGE" >/dev/null || fail "an image still in use was removed"
pass "updated to v0.0.2-test with data and stored files intact, both backed up first; old images removed"
pass "the update kept the saved ports; connectors backed up, readable by the server alone"
pass "the update gave a root-owned asset cache to the server"

echo "5. An update that can't download its images changes nothing"
if installer v0.0.3-missing ats-app:installtest-does-not-exist --update >"$WORK/missing.log" 2>&1; then
  fail "an update whose images don't exist was reported as successful"
fi
grep -q 'Nothing was changed' "$WORK/missing.log" || { cat "$WORK/missing.log"; fail "no 'nothing was changed' message"; }
grep -q '^ATS_RELEASE=v0.0.2-test' "$WORK/.env" || fail "settings changed by an update that couldn't download"
compgen -G "$WORK/backups/*-before-v0.0.3-missing" >/dev/null && fail "the space was stopped for a backup before downloading"
[[ $(get -o /dev/null -w '%{http_code}' "$BASE/api/health") == 200 ]] || fail "not running after an update that couldn't download"
pass "nothing stopped, backed up or changed when the new version couldn't be downloaded"

# A release that can only be reached through an intermediate one says so, and changes nothing.
if ATS_MIN_FROM_RELEASE=v0.0.3 installer v0.0.9-skip ats-app:installtest-v2 --update >"$WORK/skip.log" 2>&1; then
  fail "an update skipping a required release went ahead"
fi
grep -q "can't update v0.0.2-test directly. Update to v0.0.3 first" "$WORK/skip.log" || { cat "$WORK/skip.log"; fail "no 'update to v0.0.3 first'"; }
grep -q '^ATS_RELEASE=v0.0.2-test' "$WORK/.env" || fail "settings changed by a refused update"
pass "an update that would skip a required release is refused"

echo "6. Broken update rolls back automatically"
mkdir "$WORK/broken"
cat >"$WORK/broken/main.ts" <<'TS'
import { createDb } from '@ats/db';
import { createStorage } from '@ats/storage';
const e = process.env;
const db = createDb(e.DATABASE_URL);
await db.execute('create table sabotage (x int)');
await db.execute("update groups set name = 'CORRUPTED'");
const s3 = createStorage({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION, bucket: e.S3_BUCKET,
  accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY });
await s3.put('test/a.txt', 'CORRUPTED');
await s3.delete('test/b.bin');
await s3.put('test/sabotage.txt', 'from the broken release');
throw new Error('broken release');
TS
printf '%s\n' "FROM $APP_IMAGE" 'COPY main.ts apps/server/src/main.ts' >"$WORK/broken/Dockerfile"
docker build -q -t ats-app:installtest-broken "$WORK/broken" >/dev/null
# Downloading comes before the backup, with the space still running: what's done meanwhile is in
# the backup, so it survives the rollback.
during_pull="test -n \"\$(docker compose -p $PROJECT --project-directory $WORK -f $WORK/compose.yml ps -q --status running server)\" &&
  docker compose -p $PROJECT --project-directory $WORK -f $WORK/compose.yml exec -T postgres psql -U ats -d ats -qc 'create table written_while_downloading (x int)'"
if ATS_TEST_AFTER_PULL=$during_pull installer v0.0.3-broken ats-app:installtest-broken --update >"$WORK/broken.log" 2>&1; then
  fail "a broken release was reported as a successful update"
fi
grep -q 'restored to v0.0.2-test, with everything as it was at .* when the update began' "$WORK/broken.log" ||
  { cat "$WORK/broken.log"; fail "no rollback message"; }
[[ $(psql_q "select to_regclass('public.written_while_downloading')") == written_while_downloading ]] ||
  { cat "$WORK/broken.log"; fail "a change made while the update was downloading was lost in the rollback"; }
grep -q '^ATS_RELEASE=v0.0.2-test' "$WORK/.env" || fail "release not rolled back"
[[ $(psql_q "select name from groups") == "Installer Test House" ]] || fail "data not restored"
[[ -z $(psql_q "select to_regclass('public.sabotage')") ]] || fail "changes from the broken release survived"
[[ $(get -o /dev/null -w '%{http_code}' "$BASE/api/health") == 200 ]] || fail "not healthy after rollback"
# The broken release changed one file, deleted one and added one: two put back, one removed.
grep -q 'Stored files: 2 put back, [0-9]* already in place, 1 removed' "$WORK/broken.log" || { cat "$WORK/broken.log"; fail "stored files not restored"; }
[[ $(object test/a.txt) == "original A" ]] || fail "changed stored file not put back"
[[ $(object test/b.bin) != "<missing>" ]] || fail "deleted stored file not put back"
[[ $(object test/sabotage.txt) == "<missing>" ]] || fail "stored file from the broken release survived"
# Unchanged files are hard-linked from the previous backup rather than copied again.
[[ -n $(find "$WORK"/backups/*-before-v0.0.3-broken/objects -type f -links +1) ]] || fail "backup didn't reuse unchanged files"
pass "broken release detected; code, data and stored files restored, keeping what was done while it downloaded"

echo "7. An update whose worker keeps crashing rolls back too"
mkdir "$WORK/noworker"
echo "throw new Error('the worker crashes');" >"$WORK/noworker/main.ts"
printf '%s\n' "FROM $APP_IMAGE" 'COPY main.ts apps/worker/src/main.ts' >"$WORK/noworker/Dockerfile"
docker build -q -t ats-app:installtest-noworker "$WORK/noworker" >/dev/null
if installer v0.0.4-noworker ats-app:installtest-noworker --update >"$WORK/noworker.log" 2>&1; then
  fail "a release whose worker crashes was reported as a successful update"
fi
grep -q "In v0.0.4-noworker, worker didn't start properly" "$WORK/noworker.log" || { cat "$WORK/noworker.log"; fail "the crashing worker wasn't named"; }
grep -q 'restored to v0.0.2-test' "$WORK/noworker.log" || { cat "$WORK/noworker.log"; fail "no rollback message"; }
grep -q '^ATS_RELEASE=v0.0.2-test' "$WORK/.env" || fail "release not rolled back"
[[ $(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q worker)") == healthy ]] || fail "worker not healthy after rollback"
pass "a crash-looping worker (with the server fine) is caught and rolled back"

echo "8. Back up and restore with ats-admin"
admin backup >"$WORK/backup.log" 2>&1 || { cat "$WORK/backup.log"; fail "ats-admin backup failed"; }
saved=$(sed -n 's/^Backed up to //p' "$WORK/backup.log")
[[ -f $saved/database.sql.gz && -f $saved/storage.json && -f $saved/.env ]] || { cat "$WORK/backup.log"; fail "incomplete backup"; }
grep -q 'Off-site copy: done' "$WORK/backup.log" || { cat "$WORK/backup.log"; fail "manual backup not copied off-site"; }
psql_q "update groups set name = 'Changed after the backup'" >/dev/null
s3 "await s3.delete('test/a.txt'); await s3.put('test/later.txt', 'added after the backup');"
printf 'restore\n' | admin restore "$saved" >"$WORK/restore.log" 2>&1 || { cat "$WORK/restore.log"; fail "ats-admin restore failed"; }
grep -q 'Stored files: 1 put back, [0-9]* already in place, 1 removed' "$WORK/restore.log" || { cat "$WORK/restore.log"; fail "stored files not restored"; }
wait_api || fail "not healthy after restore"
[[ $(psql_q "select name from groups") == "Installer Test House" ]] || fail "database not restored"
[[ $(object test/a.txt) == "original A" ]] || fail "deleted stored file not put back"
[[ $(object test/later.txt) == "<missing>" ]] || fail "stored file added after the backup survived"
[[ $(s3 "process.stdout.write((await fetch(await s3.presignGet('test/a.txt'))).headers.get('content-type'));") == text/plain ]] ||
  fail "content type not restored"
pass "ats-admin backup and restore bring back data and stored files"

echo "9. A restore stops the supervisor and its sandboxes too"
# A stand-in sandbox, labelled the way the supervisor labels what it starts.
docker run -d --name "$PROJECT-test-sandbox" --label "io.allthespaces.instance=$PROJECT" "$APP_IMAGE" \
  node -e 'setInterval(() => {}, 1e6)' >/dev/null
supervisor_started=$(docker inspect -f '{{.State.StartedAt}}' "$(dc ps -q supervisor)")
printf 'restore\n' | admin restore "$saved" >"$WORK/restore-scope.log" 2>&1 || { cat "$WORK/restore-scope.log"; fail "ats-admin restore failed"; }
wait_api || fail "not healthy after restore"
[[ $(docker inspect -f '{{.State.Running}}' "$PROJECT-test-sandbox") == false ]] || fail "a sandbox kept running through a restore"
[[ $(docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' "$(dc ps -q supervisor)") == "true "* &&
  $(docker inspect -f '{{.State.StartedAt}}' "$(dc ps -q supervisor)") != "$supervisor_started" ]] ||
  fail "the supervisor wasn't stopped for the restore and started again"
docker rm -f "$PROJECT-test-sandbox" >/dev/null
pass "the supervisor and sandboxes are stopped during a restore; the supervisor is running again after"

echo "10. Scheduled backups, clearing out old ones, and the off-site copy"
# An old scheduled backup (kept for 3 days, it's 10 days old) holding a stored file that has been
# deleted since, copied off-site like any other; and an equally old manual one.
old=$(date -u -d '10 days ago' +%Y%m%dT%H%M%SZ)
s3 "await s3.put('test/old-only.txt', 'only in an old backup');"
mkdir "$WORK/backups/$old-auto"
cp "$saved/database.sql.gz" "$saved/.env" "$saved/compose.yml" "$WORK/backups/$old-auto/"
cli storage-backup.ts backup "/backups/$old-auto" >/dev/null || fail "couldn't make the old backup"
cli storage-backup.ts offsite "/backups/$old-auto" | grep -q 'Off-site copy: done' || fail "old backup not copied off-site"
s3 "await s3.delete('test/old-only.txt');"
cp -al "$WORK/backups/$old-auto" "$WORK/backups/$old-manual"
old_sha=$(printf 'only in an old backup' | sha256sum | cut -d' ' -f1)
old_key="all-the-spaces/$DOMAIN/objects/${old_sha:0:2}/$old_sha"
[[ $(off "process.stdout.write(String(await off.has('$old_key')))") == true ]] || fail "old stored file not off-site"

admin backup --auto >"$WORK/auto.log" 2>&1 || { cat "$WORK/auto.log"; fail "scheduled backup failed"; }
auto=$(sed -n 's/^Backed up to //p' "$WORK/auto.log")
[[ $auto == *-auto && -f $auto/storage.json ]] || { cat "$WORK/auto.log"; fail "no scheduled backup made"; }
grep -q 'Off-site copy: done' "$WORK/auto.log" || { cat "$WORK/auto.log"; fail "scheduled backup not copied off-site"; }
[[ ! -e $WORK/backups/$old-auto ]] || { cat "$WORK/auto.log"; fail "old scheduled backup not removed"; }
[[ -d $WORK/backups/$old-manual && -d $saved && -d $(cat "$WORK/.last-backup") ]] || fail "a backup that isn't scheduled was removed"
listed=$(off "process.stdout.write((await listOffsite(target)).join(' '))")
[[ $listed == *"$(basename "$auto")"* && $listed == *"$(basename "$saved")"* && $listed != *"$old-auto"* ]] ||
  fail "off-site backups not kept or removed as expected ($listed)"
[[ $(off "process.stdout.write(String(await off.has('$old_key')))") == false ]] || fail "stored file only the removed backup needed is still off-site"
shas=$(grep -o '"sha256": "[0-9a-f]*"' "$auto/storage.json" | cut -d'"' -f4 | sort -u | sed "s/.*/'&'/" | paste -sd,)
[[ $(off "let n = 0; for (const h of [$shas]) if (!(await off.has('all-the-spaces/$DOMAIN/objects/' + h.slice(0, 2) + '/' + h))) n++; process.stdout.write(String(n));") == 0 ]] ||
  fail "stored files missing off-site"
[[ -z $(find "$WORK/backups" -name '*cred*') ]] || fail "sign-in volumes ended up in a backup"
admin backup --auto | grep -q 'recent enough' || fail "a second scheduled backup the same night"
[[ $(find "$WORK/backups" -mindepth 1 -maxdepth 1 -name '*-auto' | wc -l) == 1 ]] || fail "too many scheduled backups"
admin backup-settings schedule weekly | grep -q 'Every week' || fail "couldn't change the schedule"
admin backup --auto | grep -q 'recent enough' || fail "weekly schedule not followed"
admin backup-settings schedule off >/dev/null || fail "couldn't turn scheduled backups off"
admin backup --auto | grep -q 'Scheduled backups are off' || fail "schedule 'off' not followed"
admin backup-settings schedule nightly >/dev/null
pass "scheduled backups follow the schedule, go off-site and clear out old ones (here and off-site)"

# The backup an update would roll back to is kept even when old; old manual ones go only when asked.
last_backup=$(cat "$WORK/.last-backup")
cp -al "$WORK/backups/$old-manual" "$WORK/backups/$old-before-v0.0.0-test"
echo "$WORK/backups/$old-before-v0.0.0-test" >"$WORK/.last-backup"
printf 'delete\n' | admin prune --all >"$WORK/prune.log" 2>&1 || { cat "$WORK/prune.log"; fail "prune --all failed"; }
[[ ! -e $WORK/backups/$old-manual ]] || { cat "$WORK/prune.log"; fail "old manual backup not removed when asked"; }
[[ -d $WORK/backups/$old-before-v0.0.0-test && -d $saved && -d $auto ]] || fail "prune --all removed a backup it must keep"
echo "$last_backup" >"$WORK/.last-backup"
rm -rf "$WORK/backups/$old-before-v0.0.0-test"
pass "old manual backups removed only when asked; the rollback backup is always kept"

# Losing the server's copy: bring it back from off-site and restore it.
name=$(basename "$auto")
rm -rf "$auto"
psql_q "update groups set name = 'Changed after the scheduled backup'" >/dev/null
admin offsite-fetch "$name" >"$WORK/fetch.log" 2>&1 || { cat "$WORK/fetch.log"; fail "offsite-fetch failed"; }
grep -q "Fetched $name" "$WORK/fetch.log" || { cat "$WORK/fetch.log"; fail "offsite-fetch didn't say what it fetched"; }
printf 'restore\n' | admin restore "$auto" >"$WORK/restore-offsite.log" 2>&1 || { cat "$WORK/restore-offsite.log"; fail "restore of the fetched backup failed"; }
wait_api || fail "not healthy after restoring the fetched backup"
[[ $(psql_q "select name from groups") == "Installer Test House" ]] || fail "fetched backup didn't restore the database"
[[ $(object test/a.txt) == "original A" ]] || fail "fetched backup didn't restore stored files"
pass "a backup fetched from off-site restores data and stored files"

echo "11. ats-admin update and rollback keep to this installation's folder and project"
# Installed elsewhere than /opt/all-the-spaces (in a folder with a space in its name), under its own
# project, with ats-admin's settings written the way the installer writes them. Stand-in installers
# say what they were given, one argument at a time.
elsewhere="$WORK/an install"
mkdir "$elsewhere"
cp "$WORK/.env" "$elsewhere/.env"
printf 'DIR=%q\nPROJECT=%q\nATS_REPO=%q\n' "$elsewhere" "$PROJECT" local/test >"$WORK/admin.conf"
for f in latest/download download/v0.0.2-test; do
  mkdir -p "$WORK/releases/$f"
  # shellcheck disable=SC2016 # expanded by the stand-in, not here
  printf '%s\n' 'printf "[%s]" "$@" "project=${ATS_PROJECT:-}"' >"$WORK/releases/$f/install.sh"
done
admin_conf() { env ATS_ADMIN_CONF="$WORK/admin.conf" ATS_RELEASES_URL="file://$WORK/releases" bash "$ROOT/deploy/install/ats-admin" "$@"; }
[[ $(admin_conf update) == "[--update][--dir][$elsewhere][project=$PROJECT]" ]] || fail "update: $(admin_conf update)"
[[ $(admin_conf rollback) == "[--rollback][--dir][$elsewhere][project=$PROJECT]" ]] || fail "rollback: $(admin_conf rollback)"
pass "the installer is run on the folder and project from ats-admin's settings"

echo "12. Behind an existing reverse proxy"
# The first installation has done its part; stopping it frees voice chat's ports for this one.
dc down -v >/dev/null 2>&1
IDIR=$PWORK
pdc() { docker compose -p "$PROJECT" --project-directory "$PWORK" -f "$PWORK/compose.yml" "$@"; }
# What a reverse proxy in front sends: the visitor's Host, over plain HTTP, saying it was HTTPS.
papp() { # papp HOST PATH [curl args…]
  local host=$1 path=$2; shift 2
  curl -s -H "Host: $host" -H 'X-Forwarded-Proto: https' "$@" "http://127.0.0.1:$PROXY_PORT$path"
}
installer v0.0.5-proxy ats-app:installtest-v2 --domain "$PDOMAIN" --play-domain "$PPLAY" \
  --behind-proxy --bind "127.0.0.1:$PROXY_PORT" >"$WORK/proxy-install.log" 2>&1 ||
  { cat "$WORK/proxy-install.log"; fail "install behind a proxy failed"; }
for kv in ATS_BEHIND_PROXY=1 "ATS_BIND=127.0.0.1:$PROXY_PORT" ATS_TRUSTED_PROXIES=private_ranges "ATS_APP_HOST=$PDOMAIN" \
  "ATS_PLAY_HOST=$PPLAY" "ATS_PUBLIC_URL=https://$PDOMAIN" "ATS_PLAY_URL=https://$PPLAY"; do
  grep -qx "$kv" "$PWORK/.env" || fail "$kv not saved"
done
grep -q "Open  .*https://$PDOMAIN/setup" "$WORK/proxy-install.log" || fail "setup address not https://$PDOMAIN/setup"
grep -q "reverse_proxy 127.0.0.1:$PROXY_PORT" "$WORK/proxy-install.log" || fail "no advice for the proxy in front"
proxy_ports() { docker inspect -f '{{json .HostConfig.PortBindings}}' "$(pdc ps -q caddy)"; }
[[ $(proxy_ports) == "{\"80/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"$PROXY_PORT\"}]}" ]] ||
  fail "Caddy is published on more than 127.0.0.1:$PROXY_PORT ($(proxy_ports))"
voice=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$(pdc ps -q livekit)")
[[ $voice == *'"7881/tcp"'* && $voice == *'"7882/udp"'* ]] || fail "voice chat's ports aren't published ($voice)"
for path in / /api/health /manifest.webmanifest /rt/__healthcheck /sw.js; do
  [[ $(papp "$PDOMAIN" "$path" -o /dev/null -w '%{http_code}') == 200 ]] || fail "GET $path behind the proxy"
done
headers=$(papp "$PDOMAIN" / -I)
for h in "strict-transport-security: max-age=31536000; includeSubDomains" "x-content-type-options: nosniff" \
  "content-security-policy: .*connect-src 'self' wss://$PDOMAIN; frame-src https://$PPLAY;"; do
  grep -qi "^$h" <<<"$headers" || fail "header missing behind the proxy: $h"
done
page=$(papp "$PDOMAIN" /)
grep -qF "<meta property=\"og:image\" content=\"https://$PDOMAIN/icons/og-image.png\"" <<<"$page" || fail "og:image behind the proxy"
[[ $(papp "$PPLAY" /api/health -o /dev/null -w '%{http_code}') == 404 ]] || fail "the play address answered for the API"
papp "$PPLAY" /c/x -I | grep -qi '^strict-transport-security:' || fail "no security headers on the play address"
pass "behind a proxy: plain HTTP on 127.0.0.1:$PROXY_PORT only (voice ports still open), both addresses routed, same headers"

# The visitor's address, as the proxy passes it on, is the one rate limits count (setup-code
# checks: 10 a minute per address). One the visitor wrote in X-Forwarded-For themselves, which
# nginx's \$proxy_add_x_forwarded_for passes on in front of the real one, is not.
check_code() { papp "$PDOMAIN" /api/setup/verify-code -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -H "X-Forwarded-For: $1" -d '{}'; }
for _ in $(seq 10); do [[ $(check_code 203.0.113.7) == 403 ]] || fail "setup-code check behind the proxy"; done
[[ $(check_code 203.0.113.7) == 429 ]] || fail "the visitor's address didn't reach the server"
[[ $(check_code 203.0.113.8) == 403 ]] || fail "everyone behind the proxy shares one address"
[[ $(check_code '203.0.113.8, 203.0.113.7') == 429 ]] || fail "an address the visitor wrote in X-Forwarded-For was believed"
pass "the server sees each visitor's own address, and not one they made up"

# Sign-in cookies are still Secure: the public address is https, whatever the hop in between.
pcode=$(pdc exec -T server node apps/server/src/cli/setup-code.ts | awk '/Setup code:/ {print $3}')
papp "$PDOMAIN" /api/setup/complete -X POST -H 'content-type: application/json' -H 'X-Forwarded-For: 203.0.113.9' \
  -d "{\"code\":\"$pcode\",\"group\":{\"name\":\"Proxy House\"},\"architect\":{\"name\":\"Pat\",\"email\":\"pat@example.test\",\"password\":\"proxy-test-password\"},\"storage\":{\"mode\":\"builtin\"},\"backup\":{\"keepDays\":3}}" |
  grep -q '"ok":true' || fail "setup behind the proxy did not complete"
cookie=$(papp "$PDOMAIN" /api/auth/sign-in/email -D - -o /dev/null -X POST -H 'content-type: application/json' \
  -H "Origin: https://$PDOMAIN" -d '{"email":"pat@example.test","password":"proxy-test-password"}' | grep -i '^set-cookie: __Secure-ats.session_token=' || true)
[[ $cookie == *'; Secure'* ]] || fail "no Secure sign-in cookie behind the proxy ($cookie)"
pass "set up and signed in through the proxy, with a Secure cookie"

# An update (given no options, as 'ats-admin update' runs it) keeps it behind the proxy.
installer v0.0.6-proxy ats-app:installtest-v2 --update >"$WORK/proxy-update.log" 2>&1 ||
  { cat "$WORK/proxy-update.log"; fail "update behind a proxy failed"; }
grep -q '^ATS_RELEASE=v0.0.6-proxy' "$PWORK/.env" || fail "release not recorded"
grep -qx ATS_BEHIND_PROXY=1 "$PWORK/.env" || fail "the update didn't keep it behind the proxy"
grep -qx "ATS_BIND=127.0.0.1:$PROXY_PORT" "$PWORK/.env" || fail "the update didn't keep the proxy's address"
grep -q '^ATS_HTTPS_PORT=' "$PWORK/.env" && fail "the update added web ports behind the proxy"
[[ $(proxy_ports) == "{\"80/tcp\":[{\"HostIp\":\"127.0.0.1\",\"HostPort\":\"$PROXY_PORT\"}]}" ]] ||
  fail "after the update, Caddy is published on $(proxy_ports)"
[[ $(papp "$PDOMAIN" /api/health -o /dev/null -w '%{http_code}') == 200 ]] || fail "not answering behind the proxy after the update"
pass "an update keeps it behind the proxy, on the same address"

echo "All installer checks passed."
