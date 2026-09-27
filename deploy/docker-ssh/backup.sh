#!/usr/bin/env bash
# Nightly backup of the «Гамбитик» data volume (children's accounts, games, journals).
# SQLite files are copied consistently with VACUUM INTO inside the running container; everything else is tarred as is.
# Runs ON the server (e.g. from cron as root, nightly). Result: <dest>/gambitik-YYYY-MM-DD_HHMM.tgz (0600; a tar of
# files.tgz + sqlite.tgz), the last 30 kept. <dest> = the first argument, else GAMBIT_REMOTE_BACKUP_DIR, else
# /root/backups/gambitik (the same default pull-backups.sh uses).
set -euo pipefail
dest="${1:-${GAMBIT_REMOTE_BACKUP_DIR:-/root/backups/gambitik}}"
[[ "$dest" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "backup: the backup folder must be an absolute path of plain characters, got '$dest'" >&2; exit 2; }
mkdir -p "$dest"; chmod 700 "$dest"
stamp="$(date -u +%F_%H%M)"
out="$dest/gambitik-$stamp.tgz"
umask 077
docker exec -i gambitik sh -c '
set -e
rm -rf /tmp/bk && mkdir -p /tmp/bk
cd /data
node -e "
const {DatabaseSync}=require(\"node:sqlite\");const fs=require(\"fs\");const path=require(\"path\");
const files=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(/\.(sqlite|db)$/.test(e.name))files.push(p);}};walk(\".\");
for(const f of files){const t=path.join(\"/tmp/bk\",f);fs.mkdirSync(path.dirname(t),{recursive:true});const db=new DatabaseSync(f);db.exec(\"PRAGMA busy_timeout=5000\");db.exec(\"VACUUM INTO \x27\"+t.replace(/\x27/g,\"\x27\x27\")+\"\x27\");db.close();}
console.error(\"sqlite copies: \"+files.length);
"
' > /dev/null
work="$(mktemp -d "$dest/.work-XXXX")"
docker exec gambitik tar czf - --exclude="*.sqlite" --exclude="*.sqlite-wal" --exclude="*.sqlite-shm" --exclude="*.db" --exclude="*.db-wal" --exclude="*.db-shm" -C /data . > "$work/files.tgz"
docker exec gambitik tar czf - -C /tmp/bk . > "$work/sqlite.tgz"
docker exec gambitik rm -rf /tmp/bk
# restore: unpack files.tgz, then sqlite.tgz on top, into an empty gambitik-data volume
tar cf "$out.part" -C "$work" files.tgz sqlite.tgz
rm -rf "$work"
mv "$out.part" "$out"
ls -1t "$dest"/gambitik-*.tgz | tail -n +31 | xargs -r rm -f
echo "backup: $out $(du -h "$out" | cut -f1)"
