# Shared settings of the deploy kit — sourced by every script here (not run on its own).
#
# The target lives in deploy.env next to this file (git-ignored; copy deploy.env.example and fill it in), or in the
# file named by GAMBIT_DEPLOY_ENV. A variable already set in the environment wins over the file, so a one-off
#   GAMBIT_SSH_HOST=other-box deploy/docker-ssh/deploy.sh
# works too. Only plain KEY=value lines are read (optionally quoted); nothing in the file is executed.

GAMBIT_KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

gambit_load_config() {
  local file="${GAMBIT_DEPLOY_ENV:-$GAMBIT_KIT_DIR/deploy.env}"
  if [ ! -f "$file" ]; then
    echo "deploy kit: no config file '$file' — copy deploy/docker-ssh/deploy.env.example to deploy/docker-ssh/deploy.env and fill it in" >&2
    exit 2
  fi
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if ! [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      echo "deploy kit: $file: cannot read the line '$line' (expected KEY=value)" >&2
      exit 2
    fi
    key="${BASH_REMATCH[2]}"
    value="${BASH_REMATCH[3]}"
    # strip one pair of surrounding quotes
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    # the environment wins over the file
    if [ -z "${!key+x}" ]; then
      printf -v "$key" '%s' "$value"
      export "${key?}"
    fi
  done <"$file"

  # defaults that point at nobody's server in particular
  : "${GAMBIT_REMOTE_DIR:=/docker/gambitik}"
  : "${GAMBIT_REMOTE_BACKUP_DIR:=/root/backups/gambitik}"
  : "${GAMBIT_TZ:=UTC}"
  : "${GAMBIT_PULL_BACKUPS_LABEL:=org.gambitik.pull-backups}"
  export GAMBIT_REMOTE_DIR GAMBIT_REMOTE_BACKUP_DIR GAMBIT_TZ GAMBIT_PULL_BACKUPS_LABEL
}

# gambit_require NAME… — stop with a clear message when a required setting is empty
gambit_require() {
  local name missing=()
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "deploy kit: ${missing[*]} not set — add it to ${GAMBIT_DEPLOY_ENV:-$GAMBIT_KIT_DIR/deploy.env} (see deploy.env.example)" >&2
    exit 2
  fi
}

# the values travel to the server inside an ssh command line: plain characters only
gambit_check_path() {
  local name="$1"
  [[ "${!name}" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "deploy kit: $name must be an absolute path of plain characters, got '${!name}'" >&2; exit 2; }
}

gambit_load_config
gambit_require GAMBIT_SSH_HOST
gambit_check_path GAMBIT_REMOTE_DIR
gambit_check_path GAMBIT_REMOTE_BACKUP_DIR
SSH_HOST="$GAMBIT_SSH_HOST"
REMOTE_DIR="$GAMBIT_REMOTE_DIR"
