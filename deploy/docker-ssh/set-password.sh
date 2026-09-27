#!/usr/bin/env bash
# OPTIONAL, not needed with accounts (GAMBIT_ACCOUNTS=1, the default of docker-compose.yml): stores a shared Traefik
# basic-auth login for an instance WITHOUT accounts. The shipped compose file does not use it; to put it in front of
# every path, add a basicauth middleware reading ${GAMBIT_BASIC_AUTH} to the router's labels. Run on your machine:
#
#   deploy/docker-ssh/set-password.sh <user>                        # asks for the password twice, nothing is shown
#   printf '%s\n' "$PASSWORD" | deploy/docker-ssh/set-password.sh <user>   # or one line on stdin
#
# Only a hash leaves the Mac (apr1, made here by openssl): the line GAMBIT_BASIC_AUTH='<user>:<hash>' replaces the old
# one in <GAMBIT_REMOTE_DIR>/.env — single quotes, so compose does not expand the `$` of the hash. A running container is
# recreated (Traefik reads the label from it); the data volume and everything else stay as they are.
set -euo pipefail

# shellcheck source=config.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)

die() { echo "set-password: $*" >&2; exit 2; }

user="${1:-}"
[[ "$user" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "usage: $0 <user>  (lowercase latin letters, digits, - or _)"
command -v openssl >/dev/null || die "openssl is not installed"

# IFS= on every read: the password is hashed exactly as typed — the browser sends leading / trailing spaces too
if [ -t 0 ]; then
  IFS= read -rsp "Пароль для «$user»: " password; echo
  IFS= read -rsp "Ещё раз: " again; echo
  [ "$password" = "$again" ] || die "the two passwords differ"
else
  IFS= read -r password || true
fi
[ "${#password}" -ge 10 ] || die "the password must have at least 10 characters"

hash="$(printf '%s\n' "$password" | openssl passwd -apr1 -stdin)"
unset password again
[[ "$hash" =~ ^\$apr1\$[./0-9A-Za-z]{1,8}\$[./0-9A-Za-z]{22}$ ]] || die "openssl gave an unexpected hash"

# base64 on the way: the line holds `$` and quotes, and ssh hands its arguments to a remote shell
line_b64="$(printf "GAMBIT_BASIC_AUTH='%s:%s'" "$user" "$hash" | base64 | tr -d '\n')"

ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s -- "$REMOTE_DIR" "$line_b64" <<'REMOTE'
set -euo pipefail
dir="$1"
line="$(printf '%s' "$2" | base64 -d)"
mkdir -p "$dir"
cd "$dir"
umask 077
touch .env
{ grep -v '^GAMBIT_BASIC_AUTH=' .env || true; printf '%s\n' "$line"; } >.env.new
chmod 600 .env.new
mv .env.new .env
if [ -f docker-compose.yml ] && [ -n "$(docker compose ps -q gambitik 2>/dev/null)" ]; then
  docker compose up -d
  echo "set-password: saved; the container was recreated with the new login"
else
  echo "set-password: saved; it applies on the next deploy.sh"
fi
REMOTE
