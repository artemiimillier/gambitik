#!/usr/bin/env bash
# Copies the phrases recorded on this Mac to the server: ONLY what the overlay publishes — index.json, the manifests
# (<voice>/manifest.<hash>.json) and the takes (<voice>/<xx>/c<13 hex>.mp3), the three shapes the server serves
# (apps/server/src/voiceGen/overlay.ts). Never the ledger (the money), the masters, the unit store, the reviews,
# state.json or the locks. The container sees them at once (read-only mount, no restart). Run on the Mac:
#
#   deploy/docker-ssh/sync-voice.sh             # copy
#   deploy/docker-ssh/sync-voice.sh --dry-run   # only list what would be copied
#
# The takes and manifests go first, index.json last: the server never sees an index that names a missing manifest.
# Nothing is deleted on the server (an old take is harmless — only what the current index names is played).
# Settings (deploy.env next to this script, see deploy.env.example; the environment wins): GAMBIT_SSH_HOST (required),
# GAMBIT_REMOTE_DIR (default /docker/gambitik), VOICE_OVERLAY_DIR (default ~/Library/Application Support/Gambitik/voice-overlay).
set -euo pipefail

# shellcheck source=config.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"
SRC="${VOICE_OVERLAY_DIR:-$HOME/Library/Application Support/Gambitik/voice-overlay}"
SSH_CMD="ssh -o BatchMode=yes -o ConnectTimeout=20"

die() { echo "sync-voice: $*" >&2; exit 2; }

dry=()
case "${1:-}" in
  "") ;;
  --dry-run) dry=(-n -v) ;;
  *) die "usage: $0 [--dry-run]" ;;
esac
[ -f "$SRC/index.json" ] || die "no index.json in '$SRC' — nothing published there yet"

list="$(mktemp "${TMPDIR:-/tmp}/gambitik-voice.XXXXXX")"
index="$(mktemp "${TMPDIR:-/tmp}/gambitik-voice-index.XXXXXX")"
trap 'rm -f "$list" "$index"' EXIT
# The index FIRST, as it is now: a recording may publish while this copies (otherwise the index could name a manifest
# written after the file list was made). The takes are written before the manifest that names them, so the list made after the
# snapshot holds every take of the manifest the snapshot names; that manifest must be in it too.
cp "$SRC/index.json" "$index"
manifest="$(python3 -c 'import json,sys; i=json.load(open(sys.argv[1])); print(i["voices"][i["default"]])' "$index" 2>/dev/null || true)"
[[ "$manifest" =~ ^[A-Za-z0-9_-]{1,40}/manifest\.[0-9a-f]{6,64}\.json$ ]] || die "index.json names no manifest"
# regular files only (a symlink is never followed), then the server's own path rules
(cd "$SRC" && find . -type f | sed 's|^\./||' |
  grep -E '^[A-Za-z0-9_-]{1,40}/(manifest\.[0-9a-f]{6,64}\.json|[0-9a-f]{2}/c[0-9a-f]{13}\.mp3)$' || true) >"$list"
grep -qx "$manifest" "$list" || die "the manifest $manifest of index.json is gone already (a newer one was published) — run again"
takes="$(grep -c '\.mp3$' "$list" || true)"
manifests="$(grep -c '\.json$' "$list" || true)"
echo "sync-voice: $takes takes, $manifests manifest(s) + index.json ($manifest) from '$SRC' → $SSH_HOST:$REMOTE_DIR/overlay"

$SSH_CMD "$SSH_HOST" "command -v rsync >/dev/null || { echo 'rsync is missing on the server: apt-get install -y rsync' >&2; exit 3; }; mkdir -p '$REMOTE_DIR/overlay' && chmod 755 '$REMOTE_DIR/overlay'"

# world-readable on arrival: the tools write 0600 / 0700 on the Mac, the container reads as another user (node)
rsync_common=(-t -p --chmod=go+rX -e "$SSH_CMD" ${dry[@]+"${dry[@]}"})
rsync "${rsync_common[@]}" --files-from="$list" "$SRC/" "$SSH_HOST:$REMOTE_DIR/overlay/"
# the snapshot, never the live file: it names a manifest that is on the server now
rsync "${rsync_common[@]}" "$index" "$SSH_HOST:$REMOTE_DIR/overlay/index.json"

if [ "${#dry[@]}" -eq 0 ]; then
  $SSH_CMD "$SSH_HOST" "chmod -R a+rX '$REMOTE_DIR/overlay'; docker exec gambitik node -e \"fetch('http://127.0.0.1:8787/api/health').then((r) => r.json()).then((h) => console.log('sync-voice: server clipGen', JSON.stringify(h.clipGen)))\" 2>/dev/null || echo 'sync-voice: copied (the container is not running)'"
fi
