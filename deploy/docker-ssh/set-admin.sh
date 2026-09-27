#!/usr/bin/env bash
# Names the accounts (nicknames, comma-separated) that may open the operator's dashboard https://<site>/admin. Run on the Mac:
#
#   deploy/docker-ssh/set-admin.sh 'МойНик'          # one or more nicknames: 'Ник1,Ник2'
#   deploy/docker-ssh/set-admin.sh --off             # nobody
#
# The line GAMBIT_ADMIN_LOGINS='…' replaces the old one in <GAMBIT_REMOTE_DIR>/app.env; a running container is recreated
# (the data stay; who is on the site right now is forgotten — it is kept in memory only).
set -euo pipefail

# shellcheck source=config.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)

die() { echo "set-admin: $*" >&2; exit 2; }


case "${1:-}" in
  "") die "usage: $0 'Ник[,Ник2]' | --off" ;;
  --off) line="" ;;
  *)
    logins="$1"
    [ "${#logins}" -le 300 ] || die "too long"
    case "$logins" in
      *"'"* | *$'\n'* | *$'\r'*) die "a nickname may not contain a single quote or a line break" ;;
    esac
    line="GAMBIT_ADMIN_LOGINS='$logins'"
    ;;
esac

line_b64="$(printf '%s' "$line" | base64 | tr -d '\n')"

ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s -- "$REMOTE_DIR" "$line_b64" <<'REMOTE'
set -euo pipefail
dir="$1"
line="$(printf '%s' "$2" | base64 -d)"
mkdir -p "$dir"
cd "$dir"
umask 077
touch app.env
{ grep -v '^GAMBIT_ADMIN_LOGINS=' app.env || true; [ -z "$line" ] || printf '%s\n' "$line"; } >app.env.new
chmod 600 app.env.new
mv app.env.new app.env
if [ -f docker-compose.yml ] && [ -n "$(docker compose ps -q gambitik 2>/dev/null)" ]; then
  docker compose up -d
  echo "set-admin: saved; the container was recreated"
else
  echo "set-admin: saved; it applies on the next deploy.sh"
fi
REMOTE
