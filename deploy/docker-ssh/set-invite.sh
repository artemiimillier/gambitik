#!/usr/bin/env bash
# Sets (or changes) the invite code of the public site: without it nobody can sign up (sign-in still works). The operator
# gives it to the families they invite. Run on the Mac:
#
#   deploy/docker-ssh/set-invite.sh             # asks for the code twice, nothing is shown
#   deploy/docker-ssh/set-invite.sh --generate  # makes a strong random code and prints it ONCE, after it is saved
#   deploy/docker-ssh/set-invite.sh --off       # closes sign-up (removes the code)
#
# --generate: 20 symbols of the recovery codes' unambiguous alphabet (no 0/O, 1/I/L,
# 2/Z, 5/S, 8/B), in groups of five — about 92 bits, far beyond any guessing; the server takes it in any case, with or
# without the dashes. Nowhere stored on the Mac: copy it from the terminal. Changing the code does not touch anybody's
# account — only sign-ups need it.
#
# The line GAMBIT_INVITE_CODE='<code>' replaces the old one in <GAMBIT_REMOTE_DIR>/app.env (the app's settings file,
# 0600) — single quotes, so compose takes it literally. A running container is recreated; the data stay as they are.
set -euo pipefail

# shellcheck source=config.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20)

die() { echo "set-invite: $*" >&2; exit 2; }


line=""
generated=""
case "${1:-}" in
  --off) ;;
  --generate)
    alphabet='ACDEFGHJKMNPQRTUVWXY3469'
    raw="$(LC_ALL=C tr -dc "$alphabet" </dev/urandom | head -c 20 || true)"
    [ "${#raw}" -eq 20 ] || die "could not read 20 random symbols"
    generated="${raw:0:5}-${raw:5:5}-${raw:10:5}-${raw:15:5}"
    line="GAMBIT_INVITE_CODE='$generated'"
    unset raw
    ;;
  "")
    if [ -t 0 ]; then
      IFS= read -rsp "Код приглашения: " code; echo
      IFS= read -rsp "Ещё раз: " again; echo
      [ "$code" = "$again" ] || die "the two codes differ"
    else
      IFS= read -r code || true
    fi
    [ "${#code}" -ge 10 ] && [ "${#code}" -le 100 ] || die "the code must have 10–100 characters (a short one can be guessed)"
    case "$code" in
      *"'"* | *$'\n'* | *$'\r'*) die "the code may not contain a single quote or a line break" ;;
    esac
    line="GAMBIT_INVITE_CODE='$code'"
    unset code again
    ;;
  *) die "usage: $0 [--generate | --off]" ;;
esac

# base64 on the way: the line holds quotes, and ssh hands its arguments to a remote shell
line_b64="$(printf '%s' "$line" | base64 | tr -d '\n')"

ssh "${SSH_OPTS[@]}" "$SSH_HOST" bash -s -- "$REMOTE_DIR" "$line_b64" <<'REMOTE'
set -euo pipefail
dir="$1"
line="$(printf '%s' "$2" | base64 -d)"
mkdir -p "$dir"
cd "$dir"
umask 077
touch app.env
{ grep -v '^GAMBIT_INVITE_CODE=' app.env || true; [ -z "$line" ] || printf '%s\n' "$line"; } >app.env.new
chmod 600 app.env.new
mv app.env.new app.env
if [ -f docker-compose.yml ] && [ -n "$(docker compose ps -q gambitik 2>/dev/null)" ]; then
  docker compose up -d
  echo "set-invite: saved; the container was recreated"
else
  echo "set-invite: saved; it applies on the next deploy.sh"
fi
REMOTE

if [ -n "$generated" ]; then
  echo
  echo "Новый код приглашения (показан один раз, нигде не сохранён): $generated"
  echo "Старый код больше не действует; аккаунты не затронуты."
fi
