#!/bin/zsh
# Гамбитик — double-click launcher for macOS.
# Installs dependencies and builds the web app when needed, starts the local server
# (127.0.0.1 only) in the background and opens the trainer in the default browser.
# A running server that is older than the code in this folder (GET /api/health → build) is restarted —
# but only when nobody has played or talked for a while (→ activity), never in the middle of a game.

cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# GAMBIT_API_PORT: another port (e.g. a second child with its own DATA_DIR); anything odd → 8787
PORT="${GAMBIT_API_PORT:-8787}"
[[ "$PORT" == <1024-65535> ]] || PORT=8787
URL="http://127.0.0.1:$PORT"
DATA="${DATA_DIR:-data}"
LOG="$DATA/server.log"
# an outdated server is restarted only after this long without a game / a conversation (10 minutes)
IDLE_BEFORE_RESTART_S=600

fail() {
  echo
  echo "Не получилось: $1"
  echo
  read -k 1 "?Нажми любую клавишу, чтобы закрыть окно… "
  exit 1
}

health() {
  curl -sf --max-time 2 "$URL/api/health" 2>/dev/null
}

is_up() {
  health >/dev/null
}

# the answer is Гамбитик's — not another program that happens to hold the port
is_gambit() {
  [[ "$1" == *'"ok":true'* && "$1" == *'"voice":{'* && "$1" == *'"puzzles":{'* ]]
}

port_busy() {
  nc -z -G 1 127.0.0.1 "$PORT" >/dev/null 2>&1
}

listener_pid() {
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

# «someapp (pid 123)» — whoever listens on the port (a process of another user stays unnamed)
port_owner() {
  local pid="$(listener_pid)"
  if [[ -z "$pid" ]]; then
    echo "неизвестная программа"
    return
  fi
  echo "$(ps -p "$pid" -o comm= 2>/dev/null | sed 's#.*/##') (pid $pid)"
}

# our own production server (node … apps/server/src/index.ts) — never a dev watcher, never another program
is_our_server() {
  local cmd="$(ps -p "$1" -o command= 2>/dev/null)"
  [[ "$cmd" == *node*apps/server/src/index.ts* && "$cmd" != *--watch* ]]
}

# the commit of this folder, read from .git exactly like the server does (apps/server/src/routes/health.ts)
git_sha() {
  local gitdir=".git" head ref sha common
  [[ -f .git ]] && gitdir="$(sed -n 's/^gitdir: *//p' .git)"
  [[ -r "$gitdir/HEAD" ]] || return 1
  head="$(<"$gitdir/HEAD")"
  if [[ "$head" == "ref: "* ]]; then
    ref="${head#ref: }"
    [[ "$ref" == refs/* && "$ref" != *..* ]] || return 1
    common="$gitdir"
    [[ -r "$gitdir/commondir" ]] && common="$gitdir/$(<"$gitdir/commondir")"
    if [[ -r "$gitdir/$ref" ]]; then
      sha="$(<"$gitdir/$ref")"
    elif [[ -r "$common/$ref" ]]; then
      sha="$(<"$common/$ref")"
    else
      sha="$(awk -v r="$ref" '$2 == r { print $1; exit }' "$gitdir/packed-refs" "$common/packed-refs" 2>/dev/null)"
    fi
  else
    sha="$head"
  fi
  [[ "$sha" =~ '^[0-9a-f]{40}' ]] || return 1
  echo "${sha[1,7]}"
}

# the web bundle is missing or older than its sources
web_outdated() {
  [[ ! -f apps/web/dist/index.html ]] && return 0
  [[ -n "$(find apps/web/src apps/web/index.html apps/web/vite.config.ts packages/*/src(N) -type f -newer apps/web/dist/index.html -print -quit 2>/dev/null)" ]]
}

# the running server ($1 = its /api/health) is older than the code here: another commit, or any server-side file
# (code, content, dependencies, .env with the keys) changed after it started
server_outdated() {
  local started sha_running sha_here marker newer
  [[ "$1" =~ '"startedAt":"([^"]+)"' ]] || return 0 # a server without build info: outdated by definition
  started="$match[1]"
  [[ "$1" =~ '"gitSha":("([0-9a-f]+)"|null)' ]] && sha_running="$match[2]"
  sha_here="$(git_sha)"
  [[ "$sha_here" != "$sha_running" ]] && return 0
  marker="$(mktemp -t gambit-started)" || return 1
  touch -d "$started" "$marker" 2>/dev/null || { rm -f "$marker"; return 1; }
  newer="$(find apps/server/src packages/*/src(N) kb package.json pnpm-lock.yaml apps/server/package.json packages/*/package.json(N) .env -newer "$marker" -type f -print -quit 2>/dev/null)"
  rm -f "$marker"
  [[ -n "$newer" ]]
}

# seconds since the last game / conversation request ($1 = /api/health); «never» when nobody used it since the start;
# fails for a server whose health has no activity info
idle_seconds() {
  [[ "$1" =~ '"idleSeconds":([0-9]+|null)' ]] || return 1
  [[ "$match[1]" == null ]] && echo never || echo "$match[1]"
}

UPDATE=0
H="$(health)"
if [[ -n "$H" ]]; then
  if ! is_gambit "$H"; then
    fail "порт $PORT занят другой программой: $(port_owner). Закрой её (или перезагрузи Mac) и открой этот файл ещё раз."
  fi
  if server_outdated "$H" || web_outdated; then
    IDLE="$(idle_seconds "$H")"
    if [[ -z "$IDLE" ]]; then
      # a server that reports no activity: it cannot tell whether somebody is playing — ask
      echo "Работает старая версия Гамбитика."
      if read -t 30 -q "?Если сейчас никто не играет, нажми «y» — перезапущу с новой версией (иначе через 30 с открою как есть): "; then
        UPDATE=1
      fi
      echo
    elif [[ "$IDLE" == never ]] || (( IDLE >= IDLE_BEFORE_RESTART_S )); then
      UPDATE=1
    else
      (( IDLE < 60 )) && WHEN="только что" || WHEN="$(( IDLE / 60 )) мин назад"
      echo "Есть новая версия Гамбитика, но он сейчас занят: партия или разговор были $WHEN."
      echo "Обновлю в следующий раз — когда он отдохнёт хотя бы 10 минут."
    fi
  fi
  if (( ! UPDATE )); then
    echo "Открываю Гамбитика: $URL"
    open "$URL"
    exit 0
  fi
elif port_busy; then
  # our own server may still be starting (a second double-click): give it a moment
  PID="$(listener_pid)"
  if [[ -n "$PID" ]] && is_our_server "$PID"; then
    for i in {1..50}; do
      is_up && break
      sleep 0.2
    done
    if is_up; then
      echo "Открываю Гамбитика: $URL"
      open "$URL"
      exit 0
    fi
  fi
  fail "порт $PORT занят другой программой: $(port_owner). Закрой её (или перезагрузи Mac) и открой этот файл ещё раз."
fi

command -v node >/dev/null 2>&1 || fail "не найден Node.js (нужна версия 26 или новее)."
command -v pnpm >/dev/null 2>&1 || fail "не найден pnpm (установить: npm install -g pnpm)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 26 ] || fail "нужен Node.js 26 или новее, а найден $(node -v)."

if (( UPDATE )); then
  PID="$(listener_pid)"
  if [[ -z "$PID" ]] || ! is_our_server "$PID"; then
    echo "Сервер запущен не этим файлом (например, режим разработчика) — не трогаю его."
    echo "Открываю Гамбитика: $URL"
    open "$URL"
    exit 0
  fi
  echo "Нашёл новую версию Гамбитика — перезапускаю сервер…"
  kill -TERM "$PID" 2>/dev/null
  for i in {1..50}; do
    port_busy || break
    sleep 0.1
  done
  port_busy && fail "старый сервер (pid $PID) не остановился. Перезагрузи Mac и открой этот файл ещё раз."
fi

if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю зависимости…"
  pnpm install --frozen-lockfile || fail "pnpm install завершился с ошибкой."
  touch node_modules/.modules.yaml
elif [[ ! -f node_modules/.modules.yaml || pnpm-lock.yaml -nt node_modules/.modules.yaml ]]; then
  # the code was updated together with its libraries
  echo "Обновились библиотеки: доустанавливаю…"
  pnpm install --frozen-lockfile || fail "pnpm install завершился с ошибкой."
  touch node_modules/.modules.yaml
fi

# build when there is no bundle yet — or when any source file is newer than it (after an update of the code)
if web_outdated; then
  echo "Собираю приложение…"
  pnpm build || fail "сборка завершилась с ошибкой."
fi

mkdir -p "$DATA"
echo "Запускаю сервер…"
GAMBIT_API_PORT="$PORT" NODE_ENV=production nohup node --env-file-if-exists=.env apps/server/src/index.ts >> "$LOG" 2>&1 &
disown

for i in {1..50}; do
  is_up && break
  sleep 0.2
done
if ! is_up; then
  # another program took the port first (e.g. a service that starts with the Mac)
  PID="$(listener_pid)"
  if port_busy && { [[ -z "$PID" ]] || ! is_our_server "$PID"; }; then
    fail "порт $PORT занят другой программой: $(port_owner). Закрой её (или перезагрузи Mac) и открой этот файл ещё раз."
  fi
  fail "сервер не ответил на $URL. Подробности в файле $LOG"
fi

echo "Открываю Гамбитика: $URL"
open "$URL"
