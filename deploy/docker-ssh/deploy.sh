#!/usr/bin/env bash
# Deploys the COMMITTED HEAD of this checkout to your server as the one container «gambitik» (README.md here).
# Run on the Mac, from any folder of the checkout:
#
#   deploy/docker-ssh/deploy.sh
#
# Steps: git archive HEAD → scp to <ssh host>:<GAMBIT_REMOTE_DIR>/src-<sha>.tar.gz (and docker-compose.yml as committed in
# HEAD) → on the server: unpack to src-<sha>, pull the Node base image, `docker build -t gambitik:<sha>`,
# GAMBIT_IMAGE_TAG=<sha> in <GAMBIT_REMOTE_DIR>/.env, `docker compose up -d`, wait for the container's health check and
# ask /api/health which commit it runs; on failure the previous tag is started again.
# Keeps the images (and sources) of the last 2 deploys. Idempotent: the same commit again rebuilds from cache and
# changes nothing (unless the Node base image got an update — then it is rebuilt on it). The site signs its children in
# itself (accounts); the invite code lives in app.env (set-invite.sh) and is never written here. Creates the external
# data volume gambitik-data when it is missing, never removes it.
#
# Settings (deploy.env next to this script, see deploy.env.example; the environment wins): GAMBIT_SSH_HOST (ssh alias,
# required), GAMBIT_HOST (public name, required; written to the server's .env only when missing there), GAMBIT_REMOTE_DIR
# (default /docker/gambitik), GAMBIT_TZ (default UTC; written to .env only when missing there), GAMBIT_NODE_IMAGE
# (default node:26-bookworm-slim, pulled on every deploy; node:26-slim when that tag does not exist).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$here/config.sh"
gambit_require GAMBIT_HOST
PUBLIC_HOST="$GAMBIT_HOST"
TZ_NAME="$GAMBIT_TZ"
NODE_IMAGE="${GAMBIT_NODE_IMAGE:-node:26-bookworm-slim}"
KEEP=2

repo="$(git -C "$here" rev-parse --show-toplevel)"
cd "$repo"

# the values travel to the server inside an ssh command line: plain characters only
if ! [[ "$PUBLIC_HOST" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$ ]]; then
  echo "deploy: GAMBIT_HOST must be a lowercase host name, got '$PUBLIC_HOST'" >&2
  exit 2
fi
if ! [[ "$TZ_NAME" =~ ^[A-Za-z][A-Za-z0-9_+/-]*$ ]]; then
  echo "deploy: GAMBIT_TZ must be a time zone name like UTC or Europe/Berlin, got '$TZ_NAME'" >&2
  exit 2
fi
if ! [[ "$NODE_IMAGE" =~ ^[a-z0-9][a-z0-9./:_-]*$ ]]; then
  echo "deploy: GAMBIT_NODE_IMAGE must be an image reference, got '$NODE_IMAGE'" >&2
  exit 2
fi
# never wait for a password prompt: the ssh alias must work with its key
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)

full_sha="$(git rev-parse HEAD)"
sha="$(git rev-parse --short=12 HEAD)"
# the compose file carries the password middleware and the mounts: it goes to the server exactly as committed, and a
# local edit of it stops the deploy instead of being silently skipped (or silently shipped)
compose_rel="$(git -C "$here" rev-parse --show-prefix)docker-compose.yml"
if ! git cat-file -e "HEAD:$compose_rel" 2>/dev/null; then
  echo "deploy: $compose_rel is not in the commit $sha — commit it first" >&2
  exit 2
fi
if ! git diff --quiet HEAD -- "$compose_rel"; then
  echo "deploy: $compose_rel has uncommitted changes — commit them (or git stash) first: the server gets the committed file" >&2
  exit 2
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "deploy: note — uncommitted changes are NOT deployed (only the commit $sha)" >&2
fi

tarball="$(mktemp "${TMPDIR:-/tmp}/gambitik-src-$sha.XXXXXX")"
compose_file="$(mktemp "${TMPDIR:-/tmp}/gambitik-compose-$sha.XXXXXX")"
trap 'rm -f "$tarball" "$compose_file"' EXIT
git show "HEAD:$compose_rel" >"$compose_file"
# the mode a checkout gives it (mktemp makes 0600)
chmod 644 "$compose_file"
# docs, e2e and the Mac launchers are not needed to build or run the server (.dockerignore drops them too)
git archive --format=tar.gz HEAD -- . ':(exclude)docs' ':(exclude)e2e' ':(exclude)*.command' >"$tarball"
echo "deploy: $sha → $SSH_HOST:$REMOTE_DIR ($(du -h "$tarball" | cut -f1 | tr -d ' ') of sources)"

ssh "${SSH_OPTS[@]}" "$SSH_HOST" "mkdir -p '$REMOTE_DIR' && chmod 750 '$REMOTE_DIR'"
scp "${SSH_OPTS[@]}" -q "$tarball" "$SSH_HOST:$REMOTE_DIR/src-$sha.tar.gz"
scp "${SSH_OPTS[@]}" -q "$compose_file" "$SSH_HOST:$REMOTE_DIR/docker-compose.yml"

# the server side: one bash, arguments by position, nothing interpolated into the script text
ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s -- "$REMOTE_DIR" "$sha" "$full_sha" "$PUBLIC_HOST" "$NODE_IMAGE" "$KEEP" "$TZ_NAME" <<'REMOTE'
set -euo pipefail
dir="$1" sha="$2" full_sha="$3" public_host="$4" node_image="$5" keep="$6" tz_name="$7"
cd "$dir"
umask 027

# .env: compose variables only. Lines are replaced by name; every other line (the password) is kept byte for byte.
touch .env
chmod 600 .env
env_get() { sed -n "s/^$1=//p" .env | tail -n 1; }
env_set() {
  awk -v name="$1" -v value="$2" '
    BEGIN { done = 0 }
    index($0, name "=") == 1 { if (!done) print name "=" value; done = 1; next }
    { print }
    END { if (!done) print name "=" value }
  ' .env >.env.new
  chmod 600 .env.new
  mv .env.new .env
}

# the public site signs its children in itself (GAMBIT_ACCOUNTS in the compose file): no shared password is needed;
# without an invite code (app.env, set-invite.sh) sign-up is simply closed
touch app.env
chmod 600 app.env
if ! grep -q '^GAMBIT_INVITE_CODE=' app.env; then
  echo "deploy: note — no GAMBIT_INVITE_CODE in $dir/app.env: sign-up is closed until you run deploy/docker-ssh/set-invite.sh" >&2
fi
[ -n "$(env_get GAMBIT_HOST)" ] || env_set GAMBIT_HOST "$public_host"
[ -n "$(env_get GAMBIT_TZ)" ] || env_set GAMBIT_TZ "$tz_name"
mkdir -p overlay
chmod 755 overlay

# the sources of this commit (a half-unpacked folder from an interrupted run is replaced)
src="src-$sha"
if [ ! -f "$src/.unpacked" ]; then
  rm -rf "$src" "$src.tmp"
  mkdir "$src.tmp"
  tar -xzf "$src.tar.gz" -C "$src.tmp"
  touch "$src.tmp/.unpacked"
  mv "$src.tmp" "$src"
fi

# the base image, pulled on EVERY deploy: a copy kept from the first one would never get Node's patch releases or
# Debian's security fixes (openssl, …), and `docker build` prefers the local copy. The local copy is used only when the
# registry cannot be reached; node:26-slim (the default Debian of Node 26) only when the bookworm tag is neither
# pullable nor here.
if ! docker pull -q "$node_image" >/dev/null 2>&1; then
  if docker image inspect "$node_image" >/dev/null 2>&1; then
    echo "deploy: could not pull $node_image — building on the local copy"
  else
    echo "deploy: $node_image is not available — using node:26-slim"
    node_image="node:26-slim"
    docker pull -q "$node_image" >/dev/null 2>&1 || echo "deploy: could not pull $node_image — building on the local copy"
  fi
fi
echo "deploy: building gambitik:$sha on $node_image"
docker build -t "gambitik:$sha" --build-arg NODE_IMAGE="$node_image" --build-arg GAMBIT_BUILD_SHA="$full_sha" "$src"

# the child's data: an external volume (compose never removes it, not even with `down -v`), created once here
docker volume inspect gambitik-data >/dev/null 2>&1 || docker volume create gambitik-data >/dev/null

previous="$(env_get GAMBIT_IMAGE_TAG)"
env_set GAMBIT_IMAGE_TAG "$sha"
if ! docker compose up -d --remove-orphans; then
  # compose may already have removed the old container (a failure while starting the new one): start the previous tag
  # again, or the site stays down until someone runs `docker compose up -d` by hand
  if [ -n "$previous" ]; then
    env_set GAMBIT_IMAGE_TAG "$previous"
    echo "deploy: docker compose up failed — starting the previous gambitik:$previous again" >&2
    docker compose up -d --remove-orphans || echo "deploy: the previous gambitik:$previous did not start either" >&2
  else
    echo "deploy: docker compose up failed (no previous deploy to go back to)" >&2
  fi
  exit 1
fi

# healthy = the image's HEALTHCHECK passed; then the running code must say it is this commit
healthy=0
for _ in $(seq 1 45); do
  state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' gambitik 2>/dev/null || true)"
  if [ "$state" = "healthy" ]; then healthy=1; break; fi
  if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then break; fi
  sleep 2
done
report=""
if [ "$healthy" = 1 ]; then
  report="$(docker exec gambitik node -e "
    const base = 'http://127.0.0.1:' + (process.env.GAMBIT_API_PORT || 8787);
    fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json())
      .then((h) => {
        const ok = h.ok === true && h.build?.gitSha === process.argv[1].slice(0, 7) && h.ai?.runtime === false && h.clipGen?.state === 'off';
        // the public site: accounts on, and a child's API closed without a session
        return Promise.all([
          fetch(base + '/api/auth/me').then((r) => r.json()),
          fetch(base + '/api/student').then((r) => r.status),
        ]).then(([me, student]) => {
          const accounts = me?.accounts === true && student === 401;
          console.log(JSON.stringify({ ok: ok && accounts, gitSha: h.build?.gitSha, runtimeAi: h.ai?.runtime, clipGen: h.clipGen, puzzles: h.puzzles?.count, accounts: me?.accounts, registration: me?.registration, studentWithoutSession: student }));
          process.exit(ok && accounts ? 0 : 1);
        });
      }).catch((e) => { console.log(String(e)); process.exit(1); });
  " "$full_sha")" || healthy=0
fi
if [ "$healthy" != 1 ]; then
  echo "deploy: gambitik:$sha is NOT healthy ${report:+($report)} — last log lines:" >&2
  docker logs --tail 40 gambitik >&2 || true
  if [ -n "$previous" ] && [ "$previous" != "$sha" ] && docker image inspect "gambitik:$previous" >/dev/null 2>&1; then
    echo "deploy: starting the previous gambitik:$previous again" >&2
    env_set GAMBIT_IMAGE_TAG "$previous"
    docker compose up -d --remove-orphans
  fi
  exit 1
fi
echo "deploy: healthy — $report"

# keep the last $keep deploys (deploys.log, oldest first, this one last): their images, sources and tarballs
touch deploys.log
{ grep -vx "$sha" deploys.log || true; echo "$sha"; } | tail -n "$keep" >deploys.log.new
mv deploys.log.new deploys.log
is_kept() { grep -qx "$1" deploys.log; }
for tag in $(docker image ls gambitik --format '{{.Tag}}'); do
  is_kept "$tag" || docker image rm "gambitik:$tag" >/dev/null || true
done
for path in src-*; do
  [ -e "$path" ] || continue
  tag="${path#src-}"; tag="${tag%.tar.gz}"; tag="${tag%.tmp}"
  is_kept "$tag" || rm -rf "$path"
done
# dangling layers of our own earlier builds only (other projects' images are never touched)
docker image prune -f --filter "label=org.opencontainers.image.title=gambitik" >/dev/null || true
echo "deploy: kept $(tr '\n' ' ' <deploys.log)"
REMOTE

echo "deploy: done — https://$PUBLIC_HOST (sign-in with accounts)"
