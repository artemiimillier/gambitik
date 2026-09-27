# Deploy kit: Docker + Traefik on any VPS over ssh

Runs «Гамбитик» as a public site with accounts (`GAMBIT_ACCOUNTS=1`, see `docs/ACCOUNTS.md`): every child signs in with
a nickname and a password, sign-up needs an invite code, every child's data lives in its own folder. Works on any Linux
VPS with Docker and a Traefik reverse proxy already running there (for example a Hostinger Docker VPS, which ships one).
All scripts run on **your machine** (macOS or Linux) and talk to the server over ssh; only `backup.sh` runs on the server.

## Requirements

- A VPS with Docker (Compose v2) and Traefik using the docker provider (`exposedbydefault=false`), an https entrypoint
  (default name `websecure`) and an ACME cert resolver (default name `letsencrypt`). Other names: set
  `GAMBIT_TRAEFIK_ENTRYPOINT` / `GAMBIT_TRAEFIK_CERTRESOLVER` in the server's `.env` (see `docker-compose.yml`).
  Traefik must be able to reach the container's address on port 8787 (host network, or a shared docker network).
- A DNS name pointing at the server.
- An ssh alias in `~/.ssh/config` that logs in with a key (the scripts use `BatchMode=yes` and never wait for a
  password), as root or as a user that may run `docker`.
- `git`, `ssh`, `scp`, `rsync` locally; `rsync` on the server for `sync-voice.sh`.

## Configure

```bash
cp deploy/docker-ssh/deploy.env.example deploy/docker-ssh/deploy.env   # git-ignored
$EDITOR deploy/docker-ssh/deploy.env
```

| Setting | Required | Default | Meaning |
|---|---|---|---|
| `GAMBIT_SSH_HOST` | yes | — | ssh alias of the server |
| `GAMBIT_HOST` | yes (deploy) | — | public host name; the server trusts only this `Host` / https `Origin` |
| `GAMBIT_REMOTE_DIR` | no | `/docker/gambitik` | compose project folder on the server |
| `GAMBIT_REMOTE_BACKUP_DIR` | no | `/root/backups/gambitik` | where `backup.sh` keeps nightly archives |
| `GAMBIT_TZ` | no | `UTC` | the families' clock (game file names, journal dates) |
| `GAMBIT_BACKUP_DIR` | no | `~/Library/Application Support/Gambitik/server-backups` | local copy of the backups |
| `GAMBIT_PULL_BACKUPS_LABEL` | no | `org.gambitik.pull-backups` | macOS LaunchAgent label for `pull-backups-agent.sh` |
| `GAMBIT_NODE_IMAGE` | no | `node:26-bookworm-slim` | base image of the build |

A variable set in the environment wins over the file; `GAMBIT_DEPLOY_ENV=/path/to/file` uses another file (for a
second server). Only plain `KEY=value` lines are read, nothing is executed. A script stops with a clear message when a
required value is missing.

## What runs where

| What | Where |
|---|---|
| Container `gambitik` (image `gambitik:<commit>`) | Node 26 + the server: API and the built site on port 8787 inside the container; no port is published |
| Traefik (already on the server) | terminates https (Let's Encrypt), routes `GAMBIT_HOST` to the container |
| `GAMBIT_REMOTE_DIR` | `docker-compose.yml`, `.env` (image tag, host name, time zone), `app.env` (the app's settings: invite code, admins), `overlay/`, sources of the last two deploys `src-<commit>/`, `deploys.log` |
| Children's data | external docker volume `gambitik-data` (`/data` in the container): `accounts.db` and `users/<id>/` per child |
| Recorded phrases | `GAMBIT_REMOTE_DIR/overlay/` → `/overlay` in the container, read-only |

The image has no keys and no paid features: `GAMBIT_RUNTIME_AI=0` (no generative AI), the voice plays pre-recorded
phrases only, phrase recording is off (`GAMBIT_CLIP_GEN=0`, `HIGGSFIELD_BIN=off`). With accounts on, the server turns
off everything paid or generative whatever `app.env` says. The server's data are its own; nothing is synced with a
local install.

## First deploy

```bash
deploy/docker-ssh/set-invite.sh --generate   # invite code for the families (printed once); without a flag: type your own
deploy/docker-ssh/deploy.sh                  # build and start the committed HEAD
deploy/docker-ssh/sync-voice.sh              # optional: copy locally recorded phrases
deploy/docker-ssh/set-admin.sh 'MyNick'      # optional: accounts that may open https://<host>/admin
```

Without an invite code the site works, but sign-up is closed. Per-family codes: `deploy/docker-ssh/invite.sh new
'Family label' [uses]`, `list`, `off 'label'`, `on 'label'`.

## Update

1. Commit your changes — **only the commit is deployed**, uncommitted work is not.
2. `deploy/docker-ssh/deploy.sh`

`docker-compose.yml` also goes to the server exactly as committed; uncommitted edits to it stop the deploy.

The script packs the commit (`git archive`, without `docs/`, `e2e/` and the desktop launchers), copies it to
`GAMBIT_REMOTE_DIR/src-<commit>.tar.gz`, unpacks it, pulls a fresh Node base image (security fixes of Node and Debian;
the local copy is used when the registry is unreachable), builds `gambitik:<commit>`, writes `GAMBIT_IMAGE_TAG` to
`.env` (and `GAMBIT_HOST` / `GAMBIT_TZ` when missing there), runs `docker compose up -d` and waits for the health check:
the container must answer `/api/health` with this very commit, runtime AI off and accounts on. Otherwise the previous
version is started again. Images and sources of the last two deploys are kept. Running it again for the same commit is
harmless.

Manual rollback (on the server; the previous commit is in `deploys.log`):

```bash
cd /docker/gambitik
sed -i 's/^GAMBIT_IMAGE_TAG=.*/GAMBIT_IMAGE_TAG=<previous commit>/' .env && docker compose up -d
```

Time zone later: change `GAMBIT_TZ=` in the server's `.env`, then `docker compose up -d`. Check:
`docker exec gambitik node -e 'console.log(new Date().toString())'`.

## Recorded voice

`sync-voice.sh` copies from the local overlay (`VOICE_OVERLAY_DIR`, default
`~/Library/Application Support/Gambitik/voice-overlay`) **only what is published**: `index.json`, the manifests and the
takes. Never the spending ledger, masters, unit store, reviews, state or locks. Takes and manifests go first,
`index.json` last; nothing is deleted on the server. The container sees new phrases at once. `--dry-run` lists what
would be copied.

## Accounts: help for a family

On the server:

```bash
docker exec gambitik node apps/server/src/accounts/admin.ts list
docker exec gambitik node apps/server/src/accounts/admin.ts reset-password <nick>   # new password + recovery code, shown once
docker exec gambitik node apps/server/src/accounts/admin.ts delete <nick>           # then: docker restart gambitik
```

## Backups

The volume `gambitik-data` is external (`external: true`): compose never creates or removes it — not on update, not
on `docker compose down -v`. Only `docker volume rm gambitik-data` (or a prune while no container uses it) deletes it.

**Nightly backup on the server** — copy `backup.sh` to the server and run it from cron as root, for example:

```bash
scp deploy/docker-ssh/backup.sh my-vps:/root/gambitik-backup.sh
ssh my-vps 'chmod 700 /root/gambitik-backup.sh && echo "30 3 * * * root /root/gambitik-backup.sh >>/var/log/gambitik-backup.log 2>&1" >/etc/cron.d/gambitik-backup'
```

It copies every SQLite file consistently (`VACUUM INTO` inside the running container, no downtime) plus all other files
into `GAMBIT_REMOTE_BACKUP_DIR/gambitik-<date>_<time>.tgz` (0600) and keeps the last 30. Another folder can be given as
its first argument.

**Off-server copy** — backups on the same server do not survive losing the server:

```bash
deploy/docker-ssh/pull-backups.sh                  # rsync the archives here, keep 90 days
deploy/docker-ssh/pull-backups-agent.sh install    # macOS: run it every morning (LaunchAgent GAMBIT_PULL_BACKUPS_LABEL)
```

On Linux, run `pull-backups.sh` from your own cron instead.

**Restore** a `backup.sh` archive into the volume (on the server; tar as root keeps the files' owner):

```bash
cd /docker/gambitik && tag=$(sed -n 's/^GAMBIT_IMAGE_TAG=//p' .env)
mkdir -p /tmp/restore && tar -xf /root/backups/gambitik/gambitik-<date>_<time>.tgz -C /tmp/restore
docker compose stop gambitik
docker run --rm -u 0 --entrypoint sh -v gambitik-data:/data -v /tmp/restore:/backup:ro "gambitik:$tag" -c \
  'rm -rf /data/* && tar -xzf /backup/files.tgz -C /data && tar -xzf /backup/sqlite.tgz -C /data'
docker compose start gambitik && rm -rf /tmp/restore
```

## Troubleshooting

```bash
cd /docker/gambitik
docker compose ps                     # state and health
docker logs --tail 100 gambitik       # server log
docker exec gambitik node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>r.json()).then(h=>console.log(h))"
```

- A request with another `Host`, or from another site's page, is refused by the server itself (403).
- `http://` → `https://` redirection is a Traefik setting (entrypoint `web`), not part of this project.
- The app's own non-secret settings go to `GAMBIT_REMOTE_DIR/app.env` (e.g. `VOICE_PREFERRED=clips`), then
  `docker compose up -d`. Do not put API keys there: generative AI is off on the public site by design.
- `set-password.sh` is optional and only for an instance **without** accounts (a shared Traefik basic-auth login); the
  shipped compose file does not use it.
