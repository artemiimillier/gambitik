#!/usr/bin/env bash
# The families' own invite codes (docs/ACCOUNTS.md) — run on the Mac:
#
#   deploy/docker-ssh/invite.sh new 'Семья Ивановых' [3]   # a new code (printed once), optionally for 3 sign-ups
#   deploy/docker-ssh/invite.sh list                        # every code: open or not, how many accounts came with it
#   deploy/docker-ssh/invite.sh off 'Семья Ивановых'        # nobody signs up with it any more (the accounts stay)
#   deploy/docker-ssh/invite.sh on  'Семья Ивановых'
#
# The shared code of app.env is set / closed by set-invite.sh. No restart needed.
set -euo pipefail
# shellcheck source=config.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"
cmd="${1:-}"
case "$cmd" in
  new | off | on) [ -n "${2:-}" ] || { echo "usage: $0 new|off|on 'метка' [сколько раз]" >&2; exit 2; } ;;
  list) ;;
  *) echo "usage: $0 new 'метка' [сколько раз] | list | off 'метка' | on 'метка'" >&2; exit 2 ;;
esac
args=("invite-$cmd")
[ -n "${2:-}" ] && args+=("$2")
[ -n "${3:-}" ] && args+=("$3")
# each argument travels base64-encoded: labels may hold spaces and quotes
enc=()
for a in "${args[@]}"; do enc+=("$(printf '%s' "$a" | base64 | tr -d '\n')"); done
ssh -o BatchMode=yes -o ConnectTimeout=20 "$SSH_HOST" bash -s -- "${enc[@]}" <<'REMOTE'
set -euo pipefail
dec=()
for a in "$@"; do dec+=("$(printf '%s' "$a" | base64 -d)"); done
docker exec gambitik node apps/server/src/accounts/admin.ts "${dec[@]}"
REMOTE
