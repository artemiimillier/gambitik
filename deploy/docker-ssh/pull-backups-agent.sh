#!/usr/bin/env bash
# macOS only: installs (or removes) a LaunchAgent that runs pull-backups.sh every morning at 09:00 (a run missed while
# the Mac slept happens when it wakes up). The agent's label is GAMBIT_PULL_BACKUPS_LABEL from deploy.env
# (default org.gambitik.pull-backups); its log goes to ~/Library/Logs/<label>.log.
#
#   deploy/docker-ssh/pull-backups-agent.sh install
#   deploy/docker-ssh/pull-backups-agent.sh uninstall
#   deploy/docker-ssh/pull-backups-agent.sh status
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
. "$here/config.sh"

label="$GAMBIT_PULL_BACKUPS_LABEL"
[[ "$label" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo "pull-backups-agent: GAMBIT_PULL_BACKUPS_LABEL must look like org.example.name, got '$label'" >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo "pull-backups-agent: macOS only — elsewhere run pull-backups.sh from cron" >&2; exit 2; }
plist="$HOME/Library/LaunchAgents/$label.plist"
log="$HOME/Library/Logs/$label.log"
domain="gui/$(id -u)"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

case "${1:-}" in
  install)
    mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
    cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml "$label")</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$(xml "$here/pull-backups.sh")</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$(xml "$log")</string>
  <key>StandardErrorPath</key><string>$(xml "$log")</string>
</dict>
</plist>
PLIST
    launchctl bootout "$domain/$label" 2>/dev/null || true
    launchctl bootstrap "$domain" "$plist"
    echo "pull-backups-agent: installed $plist (log: $log)"
    ;;
  uninstall)
    launchctl bootout "$domain/$label" 2>/dev/null || true
    rm -f "$plist"
    echo "pull-backups-agent: removed $label"
    ;;
  status)
    launchctl print "$domain/$label" 2>/dev/null | sed -n '1,12p' || echo "pull-backups-agent: $label is not loaded"
    ;;
  *) echo "usage: $0 install | uninstall | status" >&2; exit 2 ;;
esac
