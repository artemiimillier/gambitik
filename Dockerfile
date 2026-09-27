# «Гамбитик» as ONE container: the Hono server (Node 26 runs its TypeScript sources directly) serving the API and the
# built SPA. Made for the public instance behind Traefik (accounts on) — deploy/docker-ssh/README.md. Nothing generative
# and nothing paid runs in here: no API keys, GAMBIT_RUNTIME_AI=0, recording new phrases off (no Higgsfield, no
# ffmpeg / whisper); the phrases recorded on the Mac are mounted read-only at /overlay and only served.
#
#   docker build -t gambitik:<sha> --build-arg GAMBIT_BUILD_SHA=<full sha> .
#
# NODE_IMAGE: the closest official Node 26 image; deploy.sh falls back to node:26-slim when the bookworm tag is missing.
ARG NODE_IMAGE=node:26-bookworm-slim

# ───────────── pnpm (Node ≥ 25 no longer ships corepack, so it comes from npm, pinned like packageManager) ─────────────
FROM ${NODE_IMAGE} AS pnpm
ENV CI=true
RUN npm install --global --no-fund --no-audit pnpm@11.5.2 && pnpm --version
WORKDIR /app
# every workspace manifest (the frozen lockfile covers all of them), so the install layers stay cached until one changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/content/package.json packages/content/
COPY packages/core/package.json packages/core/
COPY packages/openings/package.json packages/openings/
COPY packages/shared/package.json packages/shared/
COPY tools/package.json tools/

# ───────────── build: the web app (copies the Stockfish engine into public/engine, then vite build) ─────────────
FROM pnpm AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && test -f apps/web/dist/index.html && test -f apps/web/dist/engine/stockfish-19-lite-single.wasm

# ───────────── deps: the server's runtime dependencies only (hono, zod, chess.js, …; no vite, no stockfish npm) ─────────────
FROM pnpm AS deps
RUN pnpm install --frozen-lockfile --prod --filter '@gambit/server...'

# ───────────── assemble: exactly the files the server reads at run time ─────────────
FROM ${NODE_IMAGE} AS assemble
WORKDIR /src
COPY package.json ./
COPY apps/server/package.json apps/server/
COPY apps/server/src apps/server/src
# workspace packages, consumed as TypeScript source (their node_modules come from `deps`)
COPY packages packages
# voiceGen/bridge.ts imports tools/voice-clips/* (the overlay rules, ledger and manifest readers) and those import
# tools/lib/cli.ts; the tools' unit store and ledger in tools/voice-clips are read by the clip library
COPY tools/package.json tools/
COPY tools/lib tools/lib
COPY tools/voice-clips tools/voice-clips
# the starter puzzles (config.starterPuzzlesPath) and the static voice library the overlay is merged with
COPY kb kb
COPY apps/web/public/voice apps/web/public/voice
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=deps /app /deps
# pnpm's node_modules are relative symlinks (apps/server/node_modules/hono → ../../../node_modules/.pnpm/…): copied as
# they are, into the same layout. The test files are not needed at run time.
RUN set -eu; \
    cd /deps; \
    find . -name node_modules -type d -prune | while read -r dir; do mkdir -p "/src/${dir%/node_modules}"; cp -a "$dir" "/src/$dir"; done; \
    cd /src; \
    find . -path ./node_modules -prune -o -name '*.test.ts' -type f -exec rm -f {} +; \
    test -f apps/server/node_modules/hono/package.json; \
    test -f apps/web/dist/index.html

# ───────────── runtime ─────────────
FROM ${NODE_IMAGE} AS runtime
# the commit the image was built from: GET /api/health → build.gitSha (a container has no .git)
ARG GAMBIT_BUILD_SHA=
LABEL org.opencontainers.image.title="gambitik" \
      org.opencontainers.image.description="Гамбитик — kids chess trainer (family instance)" \
      org.opencontainers.image.revision="${GAMBIT_BUILD_SHA}"
# the settings of the family instance; the compose file adds GAMBIT_PUBLIC_HOSTS and TZ (the family's clock). Empty keys
# on purpose: nothing paid. UV_THREADPOOL_SIZE: the password checks of the public site (scrypt) share Node's worker pool
# with every file read and write — a bigger pool keeps a burst of sign-ins from slowing the children's saves.
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=16 \
    GAMBIT_BIND_HOST=0.0.0.0 \
    GAMBIT_API_PORT=8787 \
    DATA_DIR=/data \
    VOICE_OVERLAY_DIR=/overlay \
    GAMBIT_CLIP_GEN=0 \
    HIGGSFIELD_BIN=off \
    GAMBIT_RUNTIME_AI=0 \
    LLM_PROVIDER=template \
    VOICE_PREFERRED=clips \
    CODEX_BIN=off \
    OPENAI_API_KEY= \
    OPENROUTER_API_KEY= \
    GAMBIT_BUILD_SHA=${GAMBIT_BUILD_SHA}
WORKDIR /app
# owned by root and read-only for the server; only /data (a named volume, initialised from this folder's owner) is its own
COPY --from=assemble /src/ /app/
RUN mkdir -p /data /overlay && chown node:node /data && chmod 700 /data
USER node
EXPOSE 8787
# node, not curl (the slim image has none); 127.0.0.1:<port> is always an allowed Host
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.GAMBIT_API_PORT || 8787) + '/api/health', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# no --env-file: every setting comes from the image and the compose file
CMD ["node", "apps/server/src/index.ts"]
