#!/usr/bin/env bash
# Copies the server's nightly backups of the children's data (backup.sh → GAMBIT_REMOTE_BACKUP_DIR on the server) to
# this machine, so they survive the loss of the whole server. Meant to run every morning (e.g. a macOS LaunchAgent
# labelled GAMBIT_PULL_BACKUPS_LABEL, or cron), or by hand. Keeps 90 days here.
#
# Settings (deploy.env next to this script, see deploy.env.example; the environment wins): GAMBIT_SSH_HOST (required),
# GAMBIT_REMOTE_BACKUP_DIR (default /root/backups/gambitik), GAMBIT_BACKUP_DIR (the local copy; default
# ~/Library/Application Support/Gambitik/server-backups).
set -euo pipefail
# shellcheck source=config.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config.sh"
DEST="${GAMBIT_BACKUP_DIR:-$HOME/Library/Application Support/Gambitik/server-backups}"
mkdir -p "$DEST"
chmod 700 "$DEST"
rsync -a -e "ssh -o BatchMode=yes -o ConnectTimeout=20" "$SSH_HOST:$GAMBIT_REMOTE_BACKUP_DIR/" "$DEST/"
find "$DEST" -name 'gambitik-*.tgz' -mtime +90 -delete
echo "$(date '+%F %T') pulled: $(ls "$DEST" | wc -l | tr -d ' ') backup(s), latest $(ls -t "$DEST" | head -1)"
