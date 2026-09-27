# 09. Архитектура приложения, хранение данных и аналитика прогресса

> Среда замеров: macOS 26.6, Apple M5 Max (18 ядер), Node **v26.7.0**, npm 11.19.0, pnpm 11.5.2, bun 1.3.10, codex-cli 0.154.0, Google Chrome и Safari.
> Версии пакетов — по `npm view` (по состоянию на 2026-09-21); ключевые утверждения проверены локальными экспериментами (помечено **[ПРОВЕРЕНО ЛОКАЛЬНО]**). То, что проверить не удалось, помечено **НЕ ПРОВЕРЕНО**.

---

## 0. TL;DR — рекомендуемое решение

| Слой | Выбор | Почему |
|---|---|---|
| UI | **Vite 8.3.0 + React 19.3.0 + TypeScript ~6.0.3** (SPA) | Нет SSR-задач; мгновенный HMR; полный контроль над Web Worker / WASM / WebRTC; заголовки COOP/COEP настраиваются одной строкой |
| Локальный сервер | **Hono 4.13.8 + @hono/node-server 2.1.1** на Node 26 (запуск `.ts` напрямую, без сборки) | Типобезопасный RPC-клиент `hc<AppType>` без кодогенерации, zod-валидация, SSE из коробки. Альтернатива — Fastify 5.12.5 |
| Монорепо | **pnpm workspaces**: `apps/web`, `apps/server`, `packages/shared` | Общие zod-схемы и формулы метрик для браузера и сервера |
| Состояние | **Zustand 5.0.15** (игра/часы/тренер) + **TanStack Query 5.103.2** (история/прогресс с сервера) | Vanilla-store доступен вне React (воркеры движка, обработчики realtime-событий) |
| Движок «вживую» | **Stockfish 19 WASM (`stockfish@19.0.0`, lite) в Web Worker** в браузере | Проверка зевка ДО ответа бота без сетевого round-trip; ходы ботов |
| Движок «глубокий» | **Нативный Stockfish 19** (`brew install stockfish`) как дочерний процесс сервера | Пост-анализ партии с фиксированным `go nodes N` **при `Threads 1`** → воспроизводимые accuracy/ACPL (многопоточный поиск недетерминирован — см. п.5.1); не зависит от вкладки |
| БД | **`node:sqlite`** (встроен в Node 26, статус Release Candidate) + SQL-миграции руками; запасной вариант **better-sqlite3 13.0.3** | Ноль нативных зависимостей; схема маленькая; API почти идентичен better-sqlite3 |
| Файлы | `data/games/*.pgn + *.md`, `data/student/profile.md`, `data/student/progress.json` | Требование проекта: всё читается человеком, Codex и LLM |
| Политика истины | **SQLite = оперативная истина во время игры; файлы = долговечный архив, из которого БД можно пересобрать** | Crash-safe запись каждого хода + человекочитаемый архив |
| PGN | **chessops 0.15.1** (`chessops/pgn`: `%clk`, `%emt`, `%eval`, NAG, вариации) | chess.js 1.4.0 **теряет NAG** при экспорте [ПРОВЕРЕНО ЛОКАЛЬНО] |
| Рейтинг задач | **glicko2-lite 6.0.0** (MIT, TS-типы, чистая функция) | Совпал с эталонным примером Гликмана [ПРОВЕРЕНО ЛОКАЛЬНО] |
| Графики | **Recharts 3.10.1** | React 19, ~43 млн загрузок/нед, декларативно, достаточно для 5–8 графиков |
| Тесты | **Vitest 5.0.1** (unit) + **Playwright 1.63.0** (E2E, `page.clock`, fake-микрофон) | |
| Запуск | `pnpm dev` / `npm run dev` + двойной клик по **`Шахматы.command`** | |
| Упаковка позже | Не нужна для MVP. Если понадобится иконка в Dock — **Electron 44** (внутри Node 24.21, Chromium 152) проще, чем Tauri (Node-сервер пришлось бы тащить sidecar-бинарником) | |

---

## 1. Общая архитектура

```
┌────────────────────────── Браузер (Chrome, http://localhost:8787 | :5173 в dev) ──────────────────────────┐
│  React SPA                                                                                                 │
│  ├─ Доска (react-chessboard 5.12.1 / chessground 9.2.1) + chess.js 1.4.0 (правила)                         │
│  ├─ GameMachine (Zustand): idle → studentThinking → checkingMove → coachIntervention → committing → botThinking │
│  ├─ ChessClock (performance.now, пауза по причинам: coach-talk / takeback / tab-hidden)                    │
│  ├─ Web Worker: Stockfish 19 lite WASM  ← проверка зевка (до ответа бота), ход бота, eval-bar              │
│  ├─ Маскот-тренер (правый нижний угол) + WebRTC ⇄ OpenAI Realtime (аудио напрямую в OpenAI)                │
│  │     └─ tools realtime-модели исполняются в браузере: get_position, get_engine_eval, request_takeback…   │
│  └─ fetch('/api/…')  — только same-origin                                                                  │
└───────────────▲───────────────────────────────────────────────────────────────────────────────────────────┘
                │ HTTP/JSON + SSE (127.0.0.1)
┌───────────────┴──────────── Локальный Node-сервер (Hono, 127.0.0.1:8787) ─────────────────────────────────┐
│  • хранит OPENAI_API_KEY (.env), чеканит эфемерные realtime-токены  POST /v1/realtime/client_secrets       │
│  • пишет БД (node:sqlite, WAL) и файлы data/** (атомарно: tmp + rename)                                     │
│  • очередь AnalysisJob → нативный stockfish (UCI, go nodes N) → accuracy/ACPL/NAG → PGN + journal.md        │
│  • очередь LlmJob → spawn `codex exec` (подписка ChatGPT) → разбор партии, обновление profile.md            │
│  • раздаёт собранный SPA (prod) с заголовками COOP/COEP                                                     │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        │                                   │                                      │
   data/chess.db                  data/games/*.pgn|*.md                   /opt/homebrew/bin/codex, stockfish
                                  data/student/profile.md|progress.json
```

Принципы разделения:

1. **Петля реального времени целиком в браузере.** Ход ребёнка → проверка зевка WASM-движком (50–300 мс) → либо вмешательство тренера, либо commit хода → ход бота. Сервер в этой петле только *журналирует* (fire-and-forget `POST /moves`), поэтому задержка сервера/диска на игру не влияет.
2. **Аудио не идёт через наш сервер.** Браузер получает у сервера эфемерный токен (`/api/realtime/token`), затем сам шлёт SDP на `https://api.openai.com/v1/realtime/calls`. Постоянный ключ не покидает сервер. (Эндпоинты `client_secrets`/`calls` и модель `gpt-realtime-2.1` — по документации OpenAI, см. Источники.) В той же документации первым вариантом стоит API **GPT-Live (`gpt-live-1`, full-duplex, $0.05/мин)**, у которого эфемерных токенов нет: браузер отдаёт SDP-offer нашему серверу, а сервер сам делает `POST /v1/live/sessions` и возвращает SDP-answer. Аудио всё равно идёт напрямую браузер ⇄ OpenAI, но сервер оказывается в пути установления сессии. Поэтому маршрут сервера надо проектировать провайдер-нейтрально (`POST /api/voice/session`), подробности — в п.10.
3. **Всё «медленное и умное» — фоновые задачи сервера** (глубокий анализ, LLM-разбор через `codex exec`, пересчёт `progress.json`). UI получает прогресс по SSE.
4. **Факты — от движка, слова — от LLM.** В БД и в journal.md числовые оценки пишет только анализатор; LLM получает их как вход и не может менять.

---

## 2. Сравнение вариантов каркаса

### 2.1. SPA + локальный сервер vs Next.js vs Electron/Tauri

| Критерий | **Vite SPA + Hono/Fastify** | Next.js 16.3.5 | Electron 44.4.3 | Tauri 2 (cli 2.11.5) |
|---|---|---|---|---|
| Нужен ли SSR/SEO | нет — и не тащим | SSR/RSC — лишняя сложность для локального приложения одного пользователя | — | — |
| Web Worker + WASM + SharedArrayBuffer | тривиально, `server.headers` [ПРОВЕРЕНО] | возможно (`headers()` в next.config), но RSC/edge-границы мешают долгоживущим воркерам | да | да (WKWebView; многопоточный WASM в WKWebView — НЕ ПРОВЕРЕНО) |
| Долгоживущие процессы (stockfish, очередь codex) | естественно: обычный Node-процесс | плохо ложится на route handlers (жизненный цикл dev-сервера, HMR перезапускает модули) | main-процесс | только через sidecar-бинарник Node (есть официальный гайд «Node.js as a sidecar») |
| Запись файлов в `data/` | прямой `node:fs` | можно, но смешивает UI-фреймворк и файловый демон | да | через Rust-команды или sidecar |
| Микрофон/WebRTC | Chrome на `localhost` = secure context | то же | да, нужны entitlements + подпись для микрофона на macOS | WKWebView + getUserMedia: исторически проблемно, НЕ ПРОВЕРЕНО для macOS 26 |
| Время до «работает» | минимальное | среднее | + сборка/подпись | + Rust toolchain |
| Один клик для ребёнка | `.command` + Chrome `--app=` | то же | нативная иконка | нативная иконка |

**Вывод:** MVP и, вероятно, финал — **Vite SPA + маленький Node-сервер**. Архитектура из п.1 переносится в Electron почти без изменений (сервер становится частью main-процесса, SPA грузится с `http://127.0.0.1:8787`), поэтому решение об упаковке можно отложить без долга. Нюанс на будущее: Electron 44.4.3 несёт Node **24.21.0**; в линейке 24.x `node:sqlite` получил статус Release Candidate в **v24.15.0** (тот же PR #61262, что и 25.7.0), т.е. в Electron 44 он тоже RC. Версия встроенного SQLite и мелкие API (например, `createTagStore` — с 24.9) могут отличаться от Node 26 — это аргумент держать тонкий адаптер БД (п.6.1). Tauri не рекомендую: наш сервер — Node (codex, stockfish, fs), его пришлось бы паковать sidecar-ом с суффиксом `-$TARGET_TRIPLE`, выигрыш в размере бандла для домашнего приложения не важен.

### 2.2. Серверный фреймворк

| | **Hono 4.13.8** (+ @hono/node-server 2.1.1) | Fastify 5.12.5 | Express 5.2.1 |
|---|---|---|---|
| Типизированный клиент для фронта | **да, `hc<AppType>` без кодогенерации** [ПРОВЕРЕНО ЛОКАЛЬНО] | нет (OpenAPI-кодоген или общие типы вручную) | нет |
| Валидация | `@hono/zod-validator 0.9.1` + zod 4.6.5 (400 на плохой JSON [ПРОВЕРЕНО]) | `fastify-type-provider-zod 7.0.0` / JSON Schema | вручную |
| SSE | `streamSSE` из `hono/streaming` [ПРОВЕРЕНО] | `@fastify/sse 0.6.0` (pre-1.0) или `reply.raw` | вручную |
| WebSocket (если понадобится) | `@hono/node-ws 1.3.1` | `@fastify/websocket 11.3.1` | `ws 8.21.3` |
| Статика | `@hono/node-server/serve-static` | `@fastify/static 10.1.4` | `express.static` |
| Логи | простой middleware (+ pino 10.3.1 при желании) | pino встроен | morgan |
| Зрелость именно на Node | адаптер поверх Web-standard API | Node-first, самая зрелая экосистема плагинов | легаси-стандарт |

**Рекомендация: Hono.** Для однопользовательского localhost-сервера производительность не критерий; критерий — скорость разработки и отсутствие рассинхрона типов между `apps/web` и `apps/server`. Весь стек (Hono + zod-validator + SSE + `hc` + запуск `.ts` напрямую на Node 26.7) проверен локальным smoke-тестом. Если по ходу дела понадобится богатая плагин-экосистема — Fastify 5 равноценная замена, маршруты из п.10 переносятся 1:1.

### 2.3. TypeScript и запуск сервера без сборки

* В Node 26 **type stripping стабилен** (Stability 2; стабилен с v25.2.0/v24.12.0; в v26.0.0 флаг `--experimental-transform-types` удалён). `node apps/server/src/index.ts` работает без `tsx` [ПРОВЕРЕНО ЛОКАЛЬНО], есть `--watch` и `--env-file-if-exists`.
* Ограничения strip-режима, на которые я реально наткнулся: **нельзя `enum`, `namespace`, parameter properties** (`constructor(private x: number)` → `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` [ПРОВЕРЕНО]); импорты — с расширением `.ts`; типы — через `import type`; `tsconfig.json` (paths) игнорируется. Лечится флагами `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, `allowImportingTsExtensions: true` — ровно они стоят в официальном шаблоне `create-vite@9.2.1 react-ts`.
* Workspace-пакет `@chess/shared` с `"exports": {".": "./src/index.ts"}` импортируется сервером напрямую: pnpm-симлинк разрешается в реальный путь вне `node_modules`, stripping срабатывает [ПРОВЕРЕНО ЛОКАЛЬНО].
* **Версия TypeScript:** `latest` = **7.0.2** — нативный порт (набор платформенных бинарников `@typescript/typescript-darwin-arm64` …). 7.0.2 опубликован **2026-07-08** (RC 7.0.1-rc — 2026-06-18); поле `time.modified` пакета обновляется ночными сборками `7.1.0-dev` и за дату релиза не годится. `typescript-eslint 8.70.0` всё ещё требует `typescript <6.1.0` (нам не важно — линтер у нас oxlint), а официальный шаблон `create-vite@9.2.1` закрепляет `typescript ~6.0.2` + **oxlint**. Рекомендация консервативная: **`typescript@~6.0.3` (последний 6.x, 2026-04-16) + `oxlint@1.83.0`** — как в шаблоне Vite; TS 7.0.2 можно попробовать сразу при создании каркаса (`tsc -b` — единственное место, где он нам нужен), и если typecheck проходит — оставить его.

---

## 3. Структура монорепозитория

```
Chess/
├─ package.json                  # scripts: dev / build / start / test / e2e / analyze / rebuild-index
├─ pnpm-workspace.yaml           # packages: apps/*, packages/*
├─ .env                          # OPENAI_API_KEY=…   (в .gitignore!)
├─ .env.example
├─ Шахматы.command               # двойной клик → запуск (п.13)
├─ tsconfig.base.json            # strict, erasableSyntaxOnly, verbatimModuleSyntax
├─ docs/research/…               # исследования
├─ apps/
│  ├─ web/                       # Vite + React SPA
│  │  ├─ index.html
│  │  ├─ vite.config.ts          # COOP/COEP + proxy /api → :8787
│  │  ├─ public/engine/          # stockfish-19-lite(.js|.wasm), lite-single — копируются postinstall-скриптом из node_modules/stockfish
│  │  └─ src/
│  │     ├─ main.tsx, App.tsx, routes/ (Play, Puzzles, Lessons, History, Progress, Parent)
│  │     ├─ game/                # gameMachine.ts (Zustand), clock.ts, takeback.ts, bots.ts
│  │     ├─ engine/              # stockfishWorker.ts (UCI-обёртка), blunderCheck.ts
│  │     ├─ coach/               # realtimeClient.ts (WebRTC), tools.ts, Mascot.tsx
│  │     ├─ board/               # Board.tsx (обёртка над react-chessboard), стрелки/подсветка
│  │     ├─ progress/            # графики Recharts
│  │     ├─ api/client.ts        # hc<AppType>('/')
│  │     └─ test/                # vitest setup
│  └─ server/
│     └─ src/
│        ├─ index.ts             # serve({ hostname: '127.0.0.1', port: 8787 })
│        ├─ app.ts               # сборка Hono-приложения, export type AppType
│        ├─ security.ts          # Host/Origin allowlist
│        ├─ routes/              # games.ts, moves.ts, puzzles.ts, progress.ts, student.ts, realtime.ts, llm.ts, events.ts
│        ├─ db/                  # db.ts (адаптер node:sqlite), migrate.ts, migrations/001_init.sql, repo/*.ts
│        ├─ files/               # pgnWriter.ts, journalWriter.ts, profileWriter.ts, progressWriter.ts, atomicWrite.ts
│        ├─ analysis/            # uciEngine.ts (нативный stockfish), analyzeGame.ts, queue.ts
│        ├─ llm/                 # codexExec.ts, prompts/*.md, schemas/*.json, queue.ts
│        └─ openings/            # eco.json (собран из lichess-org/chess-openings, CC0)
├─ packages/
│  └─ shared/src/                # zod-схемы API, типы, metrics.ts (winPercent, accuracy, ACPL, judgments), glicko.ts, slug.ts
├─ content/                      # учебный план (в git вместе с кодом)
│  ├─ curriculum.yaml            # треки, уроки, пререквизиты
│  └─ lessons/tactics/fork-01.md …
├─ e2e/                          # Playwright-тесты
│  └─ play-vs-petya.spec.ts
└─ data/                         # ЛИЧНЫЕ ДАННЫЕ — вне git кода (собственный git-репозиторий, п.6.6)
   ├─ chess.db (+ -wal, -shm)
   ├─ games/2026/09/2026-09-21_1742_vs-petya.pgn
   ├─ games/2026/09/2026-09-21_1742_vs-petya.md
   ├─ puzzles/2026-09-21.md      # дневной журнал задач
   ├─ sessions/2026-09-21.md     # сводка дня (для родителя)
   ├─ student/profile.md         # «живой» профиль, который читает ИИ
   ├─ student/coach-brief.md     # выжимка ≤ ~1500 знаков для instructions realtime-сессии
   ├─ student/progress.json      # машинно-читаемые метрики (генерируется)
   ├─ reports/2026-W38.md        # недельный отчёт
   └─ backups/chess-2026-09-21.db
```

Замечание по именам: в исходных требованиях предложен плоский `data/games/YYYY-MM-DD_HHMM_vs-petya.pgn`. Я сохраняю **ровно такой basename**, но раскладываю по `YYYY/MM/` — при 3–5 партиях в день через год в одной папке будет 1500+ пар файлов, что неудобно и в Finder, и для `codex` (листинг каталога съедает контекст). Коллизии (две партии в одну минуту) решаются суффиксом `_2`. Имя бота в slug — латиницей (`petya`), чтобы не ловить проблемы нормализации Unicode (NFD) в именах файлов macOS.

---

## 4. Состояние на клиенте

| Что | Где | Комментарий |
|---|---|---|
| Позиция/история/статус партии | Zustand-store `useGame` + экземпляр `Chess` (chess.js) **вне** React-состояния | В store лежат сериализуемые снимки (FEN, SAN-список, lastMove); сам объект `Chess` — в замыкании модуля |
| Автомат партии | явные состояния в store (`phase`) + чистые функции-переходы | XState 5.33.2 — опционально; для 7–8 состояний хватит reducer-а, он проще тестируется Vitest |
| Часы | класс `ChessClock` (п.9) + store-подписка на «тик» для рендера | Логика времени не живёт в React |
| Тренер (realtime) | store `useCoach`: `connection`, `speaking`, `listening`, `lastTranscript` | `speaking=true` ⇒ `clock.pause('coach-talk')` |
| Данные сервера (история, прогресс, уроки) | TanStack Query поверх `hc`-клиента | кэш, инвалидация после `game.finished` по SSE |
| Настройки UI | Zustand `persist` → `localStorage` | громкость, тема доски |

Jotai 3.0.0 / Redux не дают преимуществ; критичный плюс Zustand — `store.getState()`/`subscribe()` вне компонентов (обработчик `onmessage` воркера, обработчик событий data-channel realtime).

Автомат хода ученика (ключ к «подожди, возьми назад»):

```
studentThinking ──drop/click──▶ checkingMove            (часы ученика ещё идут; ход показан «призраком»)
checkingMove ──winDrop < порог──▶ committing ──▶ botThinking ──▶ studentThinking
checkingMove ──winDrop ≥ порог И лимит вмешательств не исчерпан──▶ coachIntervention
coachIntervention:  clock.pause('takeback'); тренер говорит; POST /takebacks
    ├─ «беру назад» ──▶ studentThinking (позиция откатывается, clock.resume)
    └─ «оставляю»   ──▶ committing
```

Порог и лимит зависят от бота/уровня (у Пети — вмешиваться при потере ≥ 20 п.п. Win%, максимум N раз за партию; в блице 1 мин — только при зевке ферзя/мата, иначе тренер молчит и разбирает после партии).

---

## 5. Где работают движки и COOP/COEP

### 5.1. Рекомендация: гибрид

| Задача | Где | Конфигурация |
|---|---|---|
| Проверка хода ученика до ответа бота | **браузер, Web Worker, `stockfish-19-lite`** | `go depth 12–14` или `movetime 150–300`; `MultiPV 2`, чтобы знать лучший ход и «насколько хуже» |
| Ход бота (Петя/Саша/Дима) | браузер, второй воркер или тот же | сила/ошибки — тема отдельного исследования; архитектурно бот = стратегия поверх UCI |
| Eval-bar, подсказки | браузер | |
| **Пост-анализ партии (метрики)** | **сервер, нативный Stockfish 19** | **`Threads 1`**, `Hash 256`, `ucinewgame` перед каждой партией, **`go nodes 400000`** на позицию. Фиксированные ноды дают воспроизводимость **только в один поток** — Lazy SMP недетерминирован (проверено: при `Threads 4` три запуска одной позиции дали разные оценки/PV/число нод, при `Threads 1` — идентичные). Скорость добираем не потоками, а **пулом из 4–8 однопоточных процессов** (на M5 Max 18 ядер). Чтобы результат не зависел от содержимого хеш-таблицы: либо «одна партия = один процесс, позиции строго по порядку», либо `ucinewgame`/`Clear Hash` перед каждой позицией. Оценку брать из последней строки `info` **без** `upperbound/lowerbound` (при остановке по нодам последняя строка часто неточная граница) |
| Проверка решений задач | не нужен движок (решение есть в базе) | |

Почему не «всё на сервере»: проверка зевка — в критическом пути UX, её результат нужен и realtime-модели (tool-ответ формируется в браузере, где живёт data-channel). Почему не «всё в браузере»: метрики прогресса должны считаться одинаково и независимо от вкладки; нативный бинарник быстрее WASM и использует полную сеть NNUE, а 94-МБ «большой» WASM в браузер тянуть незачем.

Факты про пакет `stockfish@19.0.0` (nmrugg/stockfish.js, GPL-3.0, обновлён 2026-09-15, «Stockfish.js is currently updated to Stockfish 19»): 5 сборок — большая многопоточная (≈94 МБ, требует cross-origin isolation), большая однопоточная, **lite многопоточная (≈1.6 МБ)**, **lite однопоточная**, asm.js. Автор пакета сам рекомендует lite-single для большинства проектов. Нативный: `brew info stockfish` → `stable 19 (bottled)`, ставится через `brew install stockfish`. Запасной путь без brew — запускать WASM-сборку в Node (проверено): `node node_modules/stockfish/bin/stockfish-19-lite.js` на Node 26.7 принимает UCI по stdin/stdout (`id name Stockfish 19 Lite WASM Multithreaded`), ≈1,1–1,2 Mnps в один поток и ≈4,7 Mnps при `Threads 4`; 300k нод ≈ 0,25–0,3 с на позицию. Это lite-сеть (слабее полной), но для метрик ребёнка более чем достаточно — т.е. MVP может обойтись вообще без brew. UCI-лимиты этой сборки: `Threads` 1…32, `Hash` 1…33554432, `Skill Level` 0…20, `UCI_Elo` **1320…3190** (нижняя граница 1320 — совпадает с `search.h` официального Stockfish; «Петя» слабее 1320 через `UCI_Elo` не делается — нужны `Skill Level` + инъекция ошибок, это тема исследования про ботов).

Важно для pnpm 11: у пакета `stockfish` есть собственный `postinstall` (делает симлинк `bin/stockfish.js` → большая сборка). pnpm 11 его блокирует и **`pnpm install` завершается с кодом 1** (`ERR_PNPM_IGNORED_BUILDS`), пока в `pnpm-workspace.yaml` нет явного решения — см. п.13 [ПРОВЕРЕНО ЛОКАЛЬНО].

Скорость нативного анализа на M5 Max (60 ходов × 400k нод) — ожидаемо секунды–десятки секунд, НЕ ПРОВЕРЕНО (нативный stockfish не установлен); по WASM-замеру выше 120 позиций × 400k нод в один поток ≈ 40–45 с, пулом из 6 процессов ≈ 8 с.

### 5.2. COOP/COEP: нужны только для многопоточного WASM

Для `SharedArrayBuffer` страница должна быть cross-origin isolated:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`COEP: credentialless` **не поддерживается Safari** (и команда Safari не планирует) — используем `require-corp`.

**Dev (Vite 8.3.0)** — [ПРОВЕРЕНО ЛОКАЛЬНО]: заголовки приходят и на HTML, и на JS; в Chromium 152 `self.crossOriginIsolated === true`, `typeof SharedArrayBuffer === 'function'`:

```ts
// apps/web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, strictPort: true,
    headers: crossOriginIsolation,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } }, // SSE проксируется как обычный HTTP
  },
  preview: { headers: crossOriginIsolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['stockfish'] },   // движок грузим как статический ассет из /engine, не бандлим
});
```

**Prod (Hono раздаёт `apps/web/dist`)** — [ПРОВЕРЕНО ЛОКАЛЬНО], заголовок доходит до клиента:

```ts
app.use('*', async (c, next) => {
  await next();
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Embedder-Policy', 'require-corp');
});
// import { fileURLToPath } from 'node:url';
// ВНИМАНИЕ (сниппет прогнан на Node 26.7): serveStatic в @hono/node-server 2.1.1 делает join(root, path) ОТНОСИТЕЛЬНО process.cwd().
// `pnpm start` и Шахматы.command запускают сервер из корня репо, поэтому '../web/dist' указывал бы мимо. Берём абсолютный путь:
const DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));   // apps/server/src → apps/web/dist
app.use('/*', serveStatic({ root: DIST }));
app.get('*', serveStatic({ root: DIST, path: 'index.html' }));            // SPA-fallback для клиентских маршрутов (/history, /progress …)
```

Последствия `require-corp`, о которых надо помнить:

* **CORS-запросы разрешены**: `fetch('https://api.openai.com/…')` из изолированной страницы возвращает обычный CORS-ответ (получен `401 cors`, т.е. запрос не заблокирован) [ПРОВЕРЕНО ЛОКАЛЬНО]. SDP-обмен с `/v1/realtime/calls` — тоже CORS-fetch; сам WebRTC-медиапоток COEP не регулируется. Полный realtime-звонок под COEP — НЕ ПРОВЕРЕНО (нужен ключ).
* **Блокируются no-cors ресурсы с чужих origin без `Cross-Origin-Resource-Policy`**: картинки/шрифты/Lottie/Rive с CDN, Google Fonts. Правило проекта: **все ассеты self-hosted** (это и так нужно для офлайна).
* `COOP: same-origin` рвёт связь с `window.opener` — нам не важно (нет OAuth-попапов).

Страховка: выбирать сборку в рантайме —

```ts
const flavor = self.crossOriginIsolated && navigator.hardwareConcurrency >= 4
  ? 'stockfish-19-lite' : 'stockfish-19-lite-single';
```

Для уровня «ребёнок → разряд» однопоточного lite хватает с огромным запасом; многопоточность — оптимизация, а не требование. То есть **COOP/COEP включаем (дёшево, проверено), но функционально от них не зависим.**

---

## 6. Хранение: БД + файлы

### 6.1. Варианты БД

| | **`node:sqlite`** (Node 26.7) | better-sqlite3 13.0.3 | Drizzle ORM | Только файлы (JSON/MD/PGN) |
|---|---|---|---|---|
| Статус | **Stability 1.2 — Release Candidate** (RC с v25.7.0; добавлен в 22.5.0; без флага с 22.13/23.4). В Node 26 ещё **не Stable**. Предупреждений при запуске нет [ПРОВЕРЕНО] | стабильный, MIT, `engines: node >=22`, prebuilt под Node 26/arm64 ставится за <1 с [ПРОВЕРЕНО] | stable **0.45.3** (вышел 2026-09-21 10:06 UTC; в момент исследования был 0.45.2) умеет better-sqlite3/libsql/bun-sqlite; драйвер **`drizzle-orm/node-sqlite` есть только в ветке 1.0 (`@rc` = 1.0.0-rc.4, тег `rc5` = 1.0.0-rc.5-5935859)** — в exports 0.45.3 его по-прежнему нет [ПРОВЕРЕНО по exports] | — |
| Нативная сборка | нет | да (prebuild; в pnpm 11 нужен `allowBuilds: { better-sqlite3: true }` в `pnpm-workspace.yaml`, иначе `ERR_PNPM_IGNORED_BUILDS`) | — | нет |
| SQLite внутри | 3.53.4; FTS5, JSON (`->>`), STRICT работают [ПРОВЕРЕНО] | 3.53.4 [ПРОВЕРЕНО] | — | — |
| API | `DatabaseSync`, `prepare().run/get/all/iterate`, `createTagStore()` (SQL-шаблоны с кэшем), `backup()`, сессии/changeset | почти идентичный + `db.transaction(fn)` | типобезопасный query builder, миграции drizzle-kit 0.31.11 (на момент исследования 0.31.10) | — |
| Аналитические запросы | SQL | SQL | SQL/TS | писать агрегации руками |
| Риск | API может слегка измениться до Stable | ABI-пересборка при смене Node/Electron | привязка к RC-ветке ради node:sqlite | рассинхрон, нет транзакций |

**Рекомендация:** `node:sqlite` + написанные руками SQL-миграции + тонкий адаптер `db.ts` (20 строк: `open`, `tx(fn)`, `prepare`) + zod-парсинг строк на границе репозитория. Схема — ~15 таблиц, ORM здесь экономит мало, а stable-Drizzle заставил бы взять нативный better-sqlite3. Если `node:sqlite` где-то подведёт — замена на better-sqlite3 13.0.3 занимает минуты благодаря адаптеру. Drizzle имеет смысл пересмотреть после GA 1.0 (issue про неподдержку `node:sqlite` в drizzle-kit #5471 закрыт; фактическая работа kit@rc — НЕ ПРОВЕРЕНО). Kysely 0.29.6 — альтернатива; официального диалекта под `node:sqlite` в ядре нет, но есть сторонние: `kysely-node-sqlite 1.1.0` (2025-07), `@pikku/kysely-node-sqlite 0.12.8` (2026-09), `kysely-generic-sqlite 2.0.1` (2026-07) (найден через `npm search`), в работе НЕ ПРОВЕРЕНЫ.

Настройки соединения: `PRAGMA journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=3000`. Один процесс-писатель (сервер) — конкуренции нет; `codex`/родитель читают **файлы**, а не БД.

### 6.2. Кто источник истины

| Данные | Истина | Производное |
|---|---|---|
| Ходы, часы, взятия назад, реплики во время партии | **SQLite** (пишется по ходу, crash-safe) | `.pgn` и `.md` рендерятся при завершении партии и повторно после анализа/LLM-разбора |
| Оценки движка, accuracy, ACPL, NAG | SQLite (пишет анализатор) | `[%eval]`, `$N` в PGN; таблица «Ключевые моменты» в `.md` |
| Попытки задач, рейтинги Glicko-2 | SQLite | `progress.json`, `puzzles/ДАТА.md` |
| **`profile.md`** | **файл** (его правят LLM и родитель) | сервер обновляет только авто-блок между маркерами |
| Заметки родителя в журнале партии | **файл** (блок `<!-- parent:begin/end -->` никогда не перезаписывается) | — |
| Учебный план | `content/*.yaml|md` в git | таблица `lessons` (импорт при старте) |

Обратимость: `pnpm rebuild-index` читает все `data/games/**/*.pgn` (в них есть `GameId`, `%clk`, `%emt`, `%eval`, NAG, вариации-«взятия назад») и восстанавливает `games/moves/takebacks`. Т.е. потеря `chess.db` не теряет историю партий; потеря файлов не теряет ничего, кроме ручных заметок.

Запись файлов — **атомарно**: `writeFile(tmp)` → `rename(tmp, final)` в том же каталоге (или пакет `write-file-atomic 8.0.0`). Это важно, потому что `codex exec` и родитель могут читать файл в момент записи.

### 6.3. Формат PGN (пример)

Генерация — `chessops/pgn` (`makePgn`, `makeComment({ text, clock, emt, evaluation, shapes })`); round-trip `%eval/%clk/NAG` через `parsePgn`/`parseComment` [ПРОВЕРЕНО ЛОКАЛЬНО]. chess.js 1.4.0 при `loadPgn → pgn()` сохраняет комментарии, но **выбрасывает NAG (`$1`, `?!`)** и не имеет API для них [ПРОВЕРЕНО ЛОКАЛЬНО]; он **теряет и вариации (RAV)** — т.е. наши «взятия назад» через chess.js не пережили бы round-trip вообще — поэтому chess.js остаётся движком правил в UI, а запись PGN — за chessops (GPL-3.0; для локального некоммерческого приложения, которое и так использует GPL-Stockfish, это приемлемо; при желании MIT-чистоты — свой сериализатор на ~80 строк).

Команды в комментариях: `[%clk h:mm:ss]` — время на часах после хода, `[%emt h:mm:ss]` — время, потраченное на ход (оба из «enhanced PGN»), `[%eval 0.31,18]` — оценка в пешках с точки зрения белых и глубина (формат Lichess; `#-3` для мата), `[%cal …]/[%csl …]` — стрелки/подсветка. NAG: `$1` !, `$2` ?, `$3` !!, `$4` ??, `$5` !?, `$6` ?!.

**Попытка, взятая назад, кодируется стандартной вариацией (RAV)** — любой PGN-просмотрщик (Lichess study, ChessBase) покажет её корректно:

```pgn
[Event "Тренировка: партия с ботом"]
[Site "Chess Trainer (local)"]
[Date "2026.09.21"]
[Round "3"]
[White "Миша"]
[Black "Петя (бот)"]
[Result "1-0"]
[UTCDate "2026.09.21"]
[UTCTime "14:42:10"]
[TimeControl "300+0"]
[WhiteType "human"]
[BlackType "program"]
[ECO "C50"]
[Opening "Italian Game: Giuoco Pianissimo"]
[Termination "checkmate"]
[Annotator "Stockfish 19 (nodes 400000) + coach"]
[GameId "01K5M3Q8ZJ4T7W2N9X6RB1VDCE"]
[BotId "petya"]
[StudentColor "white"]
[StudentAccuracy "78.4"]
[StudentACPL "41"]
[Takebacks "1/1"]

1. e4 { [%eval 0.31,22] [%clk 0:04:58] [%emt 0:00:02] } 1... e5 { [%eval 0.28,22] [%clk 0:04:59] [%emt 0:00:01] }
2. Nf3 { [%eval 0.30,22] [%clk 0:04:55] [%emt 0:00:03] } 2... Nc6 { [%eval 0.32,22] [%clk 0:04:57] [%emt 0:00:02] }
3. Bc4 { [%eval 0.25,22] [%clk 0:04:50] [%emt 0:00:05] } 3... Nf6 { [%eval 0.35,22] [%clk 0:04:55] [%emt 0:00:02] }
4. d3 { Спокойно и надёжно. [%eval 0.20,22] [%clk 0:04:31] [%emt 0:00:19] }
( 4. Ng5 $6 { ВЗЯТО НАЗАД. Тренер: «Подожди! Посмотри, что защищает пешку f7 и успеешь ли ты рокировать». Ученик: «Хотел напасть на f7». [%eval -0.15,14] [%csl Rf7] } )
4... Bc5 { [%eval 0.22,22] [%clk 0:04:52] [%emt 0:00:03] }
5. Bg5 $2 { Слон выходит слишком рано: после h6 придётся отступать. Лучше 5. c3 или 5. O-O. [%eval -0.35,22] [%clk 0:04:20] [%emt 0:00:11] [%cal Gc2c3,Ge1g1] }
{ … } 1-0
```

### 6.4. Журнал партии (`.md`) — пример

Двухэтапная генерация: **(1) детерминированный шаблон** из БД сразу по окончании партии (файл есть всегда, даже без интернета и LLM); **(2) LLM-обогащение** через `codex exec` — только внутри блока `ai:begin/end`. YAML front-matter — для машин (парсится пакетом `yaml 2.9.1`; `gray-matter 4.0.3` не обновлялся с 2023 г. — не обязателен).

```markdown
---
schema: game-journal/1
game_id: 01K5M3Q8ZJ4T7W2N9X6RB1VDCE
date: 2026-09-21T17:42:10+03:00
student: misha
bot: petya
student_color: white
time_control: 300+0
result: 1-0
student_outcome: win
termination: checkmate
opening: { eco: C50, name: "Italian Game: Giuoco Pianissimo" }
plies: 58
metrics:
  accuracy: 78.4
  acpl: 41
  inaccuracies: 3
  mistakes: 2
  blunders: 1
  takebacks: { offered: 1, used: 1 }
  hints_used: 0
  time_used_s: 214
  avg_move_s: 7.4
  longest_think: { ply: 27, seconds: 38 }
  time_trouble_plies: 0
analysis: { engine: "Stockfish 19 native", limit: "nodes 400000" }
pgn: ./2026-09-21_1742_vs-petya.pgn
---

# Партия с Петей — 21 сентября 2026, 17:42 · победа белыми (мат на 29-м ходу)

## Итог в двух строках
Точность **78%** (средняя за неделю — 71%). Один зевок (19. Qd2??), один раз тренер остановил и Миша нашёл ход лучше.

## Ключевые моменты
| Ход | Сыграно | Оценка до → после | Лучшее | Тема | Что произошло |
|---|---|---|---|---|---|
| 4 | ~~Ng5~~ → d3 | +0.3 → −0.2 (попытка) | d3 / c3 | преждевременная атака | Тренер остановил, взял назад, сыграл d3 |
| 5 | Bg5?  | +0.2 → −0.4 | c3 | развитие | Слон вышел рано |
| 19 | Qd2?? | +2.1 → −1.8 | Qe2 | незащищённая фигура | Потерял коня на f3 (Петя не заметил) |
| 27 | Rxf7! | +3.0 → +6.5 | Rxf7 | жертва, вскрытие короля | Думал 38 секунд и нашёл сам |

## Мысли Миши (расшифровка голоса)
- (ход 4) «Хотел напасть на f7» → после подсказки: «А, там король уходит на рокировку».
- (ход 27) «Если я возьму ладьёй, он возьмёт королём, а потом шах ферзём».

## Что говорил тренер
- (ход 4) «Подожди! Посмотри, что защищает пешку f7…»
- (после партии) «Ты сам нашёл жертву ладьи — это уровень сильного игрока!»

<!-- ai:begin (перезаписывается LLM-задачей game-journal; вручную не править) -->
## Разбор тренера
…3–6 абзацев: что получилось, главная ошибка и почему, правило на будущее…

## Домашнее задание
1. 10 задач на тему «незащищённые фигуры» (hangingPiece), целевой рейтинг 900–1000.
2. Урок `openings/italian-02`.
<!-- ai:end -->

<!-- parent:begin (этот блок программа никогда не трогает) -->
## Заметки родителя
<!-- parent:end -->
```

### 6.5. `profile.md`, `coach-brief.md`, `progress.json`

**`data/student/profile.md`** — главный «контекст ученика» для LLM и родителя. Правила: ≤ ~150 строк; авто-блок с цифрами обновляет сервер; смысловые разделы переписывает LLM-задача `profile-update` после каждой сессии (на входе: старый профиль + новые журналы + `progress.json`; на выходе: JSON по схеме, сервер сам собирает markdown — LLM не получает права записи); каждое утверждение о слабости должно ссылаться на партии-доказательства.

```markdown
---
schema: student-profile/1
student: misha
updated: 2026-09-21T18:05:00+03:00
updated_by: codex-exec (profile-update #142)
---
# Профиль ученика: Миша

## Кто это
9 лет, играет с 2025 г., правила знает уверенно. Цель семьи: системный рост до разрядов и дальше. Язык — русский.
Любит атаковать, быстро расстраивается после зевков — хвалить за процесс мышления, а не за результат.

<!-- auto:begin (генерируется из progress.json) -->
## Цифры (на 21.09.2026)
- Рейтинг задач (Glicko-2): **1043 ± 62** (месяц назад 948)
- Точность в партиях, среднее за 10 игр: **72.6%** · ACPL 58 · зевков на партию 1.4
- Против ботов: Петя 14–2–1, Саша 3–9–0, Дима 0–2–0
- Серия занятий: 6 дней подряд (рекорд 11) · за неделю 3 ч 10 мин
- Сильные темы: mateIn1 1310, fork 1120 · Слабые: hangingPiece 870, pin 905, endgame 890
<!-- auto:end -->

## Сильные стороны
- Видит двухходовые матовые атаки (партии 2026-09-18_1610, 2026-09-21_1742).

## Главные проблемы сейчас (максимум 3)
1. **Не проверяет, что защищает фигуру после своего хода** — 9 из 14 зевков за 2 недели (2026-09-19_1105 ход 17; 2026-09-21_1742 ход 19).
2. Ранние выходы ферзя/слона до завершения развития.
3. В цейтноте (< 30 с) перестаёт считать — 4 поражения по времени в блице 1 мин.

## Текущий фокус плана
Трек «Тактика»: урок `tactics/hanging-02` (в процессе). Трек «Эндшпиль»: `endgames/kp-vs-k-01` пройден 19.09.

## Как с ним разговаривать
Короткие фразы, вопросы вместо ответов («Что атакует его слон?»), не больше одной мысли за раз, юмор приветствуется.

<!-- parent:begin -->
## Заметки родителя
- По будням не больше 40 минут.
<!-- parent:end -->
```

**`coach-brief.md`** — автоматически сжатая версия (имя, возраст, 3 проблемы, текущий урок, тон; ≤ ~1500 знаков) — подставляется в `instructions` realtime-сессии при выдаче токена, чтобы не раздувать аудио-контекст.

**`data/student/progress.json`** (генерируется сервером после каждой партии/серии задач; версия схемы обязательна):

```json
{
  "schema": "progress/1",
  "student": "misha",
  "generatedAt": "2026-09-21T15:05:00Z",
  "ratings": {
    "puzzle:all":          { "rating": 1043, "rd": 62,  "vol": 0.0598, "n": 412 },
    "puzzle:fork":         { "rating": 1120, "rd": 88,  "vol": 0.0600, "n": 57 },
    "puzzle:hangingPiece": { "rating": 870,  "rd": 95,  "vol": 0.0601, "n": 41 },
    "game:all":            { "rating": 905,  "rd": 110, "vol": 0.0600, "n": 31 }
  },
  "games": {
    "total": 31,
    "last10": { "accuracy": 72.6, "acpl": 58, "blundersPerGame": 1.4, "mistakesPerGame": 2.1, "takebacksUsedPerGame": 0.8 },
    "byBot": { "petya": { "w": 14, "l": 2, "d": 1 }, "sasha": { "w": 3, "l": 9, "d": 0 }, "dima": { "w": 0, "l": 2, "d": 0 } },
    "byTimeControl": { "60+0": { "n": 9, "timeouts": 4 }, "300+0": { "n": 15, "timeouts": 0 }, "600+0": { "n": 7, "timeouts": 0 } },
    "errorsByPhase": { "opening": { "blunder": 2 }, "middlegame": { "blunder": 9, "mistake": 14 }, "endgame": { "blunder": 3 } },
    "accuracyTrend": [ { "week": "2026-W36", "accuracy": 66.1 }, { "week": "2026-W37", "accuracy": 70.3 }, { "week": "2026-W38", "accuracy": 72.6 } ]
  },
  "openings": [
    { "color": "white", "eco": "C50", "name": "Italian Game", "n": 11, "winPct": 73, "accuracy": 74.0 },
    { "color": "black", "eco": "B01", "name": "Scandinavian Defense", "n": 6, "winPct": 33, "accuracy": 65.2 }
  ],
  "time": { "avgMoveS": 7.4, "share_under_3s": 0.41, "timeTroublePliesPerGame": 2.3, "blunderRate_fastMoves": 0.11, "blunderRate_slowMoves": 0.04 },
  "activity": { "streakDays": 6, "bestStreakDays": 11, "minutesLast7d": 190, "daysActiveLast30": 22 },
  "curriculum": { "tactics": { "passed": 7, "total": 40, "current": "tactics/hanging-02" }, "endgames": { "passed": 2, "total": 25 } },
  "focus": ["hangingPiece", "pin", "time-management-bullet"]
}
```

### 6.6. Резервные копии и история

* `data/` — отдельный git-репозиторий; после каждой сессии сервер делает `git add -A && git commit -m "session 2026-09-21"` (через `node:child_process`, без зависимости `simple-git`). Получаем бесплатную историю изменений `profile.md` — видно, как менялось мнение ИИ об ученике. `chess.db*` — в `.gitignore` репозитория data (он восстановим из PGN + отдельный бэкап).
* Раз в день: `import { backup } from 'node:sqlite'; await backup(db, 'data/backups/chess-YYYY-MM-DD.db')` — онлайн-бэкап без остановки (API `backup()` добавлен в v23.8/v22.16; вызов проверен на Node 26.7 с WAL-базой: промис вернул число страниц, копия открывается и читается). Хранить 14 последних.
* Рекомендовать родителю добавить `data/` в Time Machine/iCloud — вне кода.

---

## 7. Схема БД (SQL)

Полный DDL ниже прогнан на `node:sqlite` (SQLite 3.53.4): таблицы STRICT, CHECK-и, `json_valid`, внешние ключи, представления — создаются и отвечают на запросы [ПРОВЕРЕНО ЛОКАЛЬНО]. Миграции: файлы `NNN_name.sql`, версия в `PRAGMA user_version`.

```sql
-- apps/server/src/db/migrations/001_init.sql
PRAGMA foreign_keys = ON;

CREATE TABLE students (
  id            TEXT PRIMARY KEY,               -- 'misha'
  display_name  TEXT NOT NULL,
  birth_year    INTEGER,
  locale        TEXT NOT NULL DEFAULT 'ru',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE bots (
  id            TEXT PRIMARY KEY,               -- 'petya' | 'sasha' | 'dima' | …
  display_name  TEXT NOT NULL,                  -- 'Петя'
  persona_md    TEXT NOT NULL DEFAULT '',
  approx_elo    INTEGER NOT NULL,
  engine_json   TEXT NOT NULL CHECK (json_valid(engine_json)),  -- {"flavor":"lite-single","skill":0,"depth":1,"blunderRate":0.25}
  sort_order    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE sessions (                          -- «занятие» = непрерывный визит
  id            TEXT PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES students(id),
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  active_ms     INTEGER NOT NULL DEFAULT 0,
  summary_path  TEXT
) STRICT;

CREATE TABLE games (
  id              TEXT PRIMARY KEY,             -- ULID
  student_id      TEXT NOT NULL REFERENCES students(id),
  bot_id          TEXT NOT NULL REFERENCES bots(id),
  session_id      TEXT REFERENCES sessions(id),
  slug            TEXT NOT NULL UNIQUE,         -- '2026-09-21_1742_vs-petya'
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  student_color   TEXT NOT NULL CHECK (student_color IN ('white','black')),
  tc_base_s       INTEGER NOT NULL,             -- 60 | 300 | 600
  tc_inc_s        INTEGER NOT NULL DEFAULT 0,
  start_fen       TEXT,                         -- NULL = стандартная позиция (иначе — тренировочная)
  status          TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','paused','finished','abandoned')),
  result          TEXT CHECK (result IN ('1-0','0-1','1/2-1/2','*')),
  termination     TEXT CHECK (termination IN ('checkmate','resign','timeout','stalemate','repetition','fifty-move','insufficient','agreement','abandoned')),
  student_outcome TEXT CHECK (student_outcome IN ('win','loss','draw')),
  ply_count       INTEGER NOT NULL DEFAULT 0,
  eco             TEXT,
  opening_name    TEXT,
  final_fen       TEXT,
  -- пост-анализ (нативный Stockfish, фиксированные ноды)
  analysis_status TEXT NOT NULL DEFAULT 'none' CHECK (analysis_status IN ('none','queued','running','done','failed')),
  analysis_engine TEXT,                         -- 'Stockfish 19 native'
  analysis_limit  TEXT,                         -- 'nodes 400000'
  accuracy_student REAL, accuracy_bot REAL,
  acpl_student     REAL, acpl_bot     REAL,
  inaccuracies INTEGER, mistakes INTEGER, blunders INTEGER,      -- только ученик
  takebacks_offered INTEGER NOT NULL DEFAULT 0,
  takebacks_used    INTEGER NOT NULL DEFAULT 0,
  hints_used        INTEGER NOT NULL DEFAULT 0,
  student_time_ms   INTEGER, avg_move_ms INTEGER, time_trouble_plies INTEGER,
  pgn_path        TEXT, journal_path TEXT
) STRICT;
CREATE INDEX games_student_time ON games(student_id, started_at);
CREATE INDEX games_bot ON games(bot_id);

CREATE TABLE moves (
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply           INTEGER NOT NULL,               -- 1..N
  color         TEXT NOT NULL CHECK (color IN ('w','b')),
  is_student    INTEGER NOT NULL CHECK (is_student IN (0,1)),
  san           TEXT NOT NULL,
  uci           TEXT NOT NULL,
  fen_before    TEXT NOT NULL,
  fen_after     TEXT NOT NULL,
  clock_ms      INTEGER,                        -- часы сходившего ПОСЛЕ хода  (→ %clk)
  move_ms       INTEGER,                        -- чистое время обдумывания     (→ %emt)
  paused_ms     INTEGER NOT NULL DEFAULT 0,     -- сколько часы стояли (тренер говорил)
  -- быстрая «живая» оценка из браузера (WASM), с точки зрения белых
  live_cp INTEGER, live_mate INTEGER, live_depth INTEGER,
  -- пост-анализ позиции ПОСЛЕ хода, с точки зрения белых
  cp INTEGER, mate INTEGER, depth INTEGER,
  best_uci TEXT, best_san TEXT, pv TEXT,
  win_before REAL, win_after REAL,              -- с точки зрения сходившего, 0..100
  cp_loss INTEGER, accuracy REAL,
  judgment TEXT CHECK (judgment IN ('best','good','inaccuracy','mistake','blunder','brilliant','forced','book')),
  nag INTEGER,                                  -- 1..6
  phase TEXT CHECK (phase IN ('opening','middlegame','endgame')),
  motifs TEXT CHECK (motifs IS NULL OR json_valid(motifs)),  -- ["hanging-piece","missed-fork"]
  coach_comment TEXT,
  PRIMARY KEY (game_id, ply)
) STRICT, WITHOUT ROWID;

CREATE TABLE takebacks (                         -- каждое «подожди, подумай ещё»
  id            INTEGER PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply           INTEGER NOT NULL,
  fen_before    TEXT NOT NULL,
  tried_uci     TEXT NOT NULL, tried_san TEXT NOT NULL,
  cp_before INTEGER, cp_after INTEGER, win_drop REAL,
  motif         TEXT,                           -- 'hangs-queen' …
  coach_said    TEXT,
  accepted      INTEGER NOT NULL DEFAULT 0,     -- ребёнок согласился взять назад
  retry_uci     TEXT, retry_san TEXT, retry_win_drop REAL,   -- что сыграл после размышления
  think_ms      INTEGER,
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX takebacks_game ON takebacks(game_id, ply);

CREATE TABLE utterances (                        -- мысли ребёнка и речь тренера (транскрипты realtime)
  id            INTEGER PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES students(id),
  game_id       TEXT REFERENCES games(id) ON DELETE CASCADE,
  puzzle_attempt_id INTEGER,
  ply           INTEGER,
  role          TEXT NOT NULL CHECK (role IN ('child','coach','parent','system')),
  source        TEXT NOT NULL CHECK (source IN ('voice','typed','generated')),
  text          TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;
CREATE INDEX utterances_game ON utterances(game_id, ply);

CREATE TABLE puzzles (                           -- подмножество Lichess puzzle DB (CC0)
  id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'lichess',
  fen TEXT NOT NULL, moves_uci TEXT NOT NULL,
  rating INTEGER NOT NULL, rd INTEGER NOT NULL,
  popularity INTEGER, nb_plays INTEGER, opening_tags TEXT
) STRICT;
CREATE TABLE puzzle_themes (
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  theme TEXT NOT NULL, PRIMARY KEY (theme, puzzle_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX puzzles_rating ON puzzles(rating);

CREATE TABLE puzzle_attempts (
  id INTEGER PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  puzzle_id  TEXT NOT NULL REFERENCES puzzles(id),
  session_id TEXT REFERENCES sessions(id),
  started_at TEXT NOT NULL, time_ms INTEGER NOT NULL,
  solved INTEGER NOT NULL CHECK (solved IN (0,1)),
  first_try INTEGER NOT NULL CHECK (first_try IN (0,1)),
  wrong_moves INTEGER NOT NULL DEFAULT 0, hints_used INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL,                          -- очко для Glicko: 1 / 0.5 / 0
  rating_before REAL, rating_after REAL
) STRICT;
CREATE INDEX attempts_student_time ON puzzle_attempts(student_id, started_at);

CREATE TABLE ratings (                           -- состояние Glicko-2 по «шкалам»
  student_id TEXT NOT NULL REFERENCES students(id),
  scope      TEXT NOT NULL,                     -- 'puzzle:all' | 'puzzle:fork' | 'game:all' | 'game:300+0'
  rating REAL NOT NULL DEFAULT 1500, rd REAL NOT NULL DEFAULT 350, vol REAL NOT NULL DEFAULT 0.06,
  n INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (student_id, scope)
) STRICT, WITHOUT ROWID;
CREATE TABLE rating_history (
  id INTEGER PRIMARY KEY, student_id TEXT NOT NULL, scope TEXT NOT NULL,
  rating REAL NOT NULL, rd REAL NOT NULL, vol REAL NOT NULL,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('puzzle','game')), ref_id TEXT NOT NULL, at TEXT NOT NULL
) STRICT;
CREATE INDEX rating_history_scope ON rating_history(student_id, scope, at);

CREATE TABLE lessons (                           -- импорт из content/curriculum.yaml при старте
  id TEXT PRIMARY KEY,                           -- 'tactics/fork-01'
  track TEXT NOT NULL CHECK (track IN ('tactics','endgames','openings','strategy','checkmates')),
  level INTEGER NOT NULL, sort_order INTEGER NOT NULL,
  title TEXT NOT NULL, md_path TEXT NOT NULL,
  prerequisites TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(prerequisites)),
  puzzle_theme TEXT
) STRICT;
CREATE TABLE lesson_progress (
  student_id TEXT NOT NULL REFERENCES students(id),
  lesson_id  TEXT NOT NULL REFERENCES lessons(id),
  status TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked','available','in-progress','passed','mastered')),
  mastery REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT, passed_at TEXT, last_review_at TEXT, next_review_at TEXT,   -- интервальное повторение
  PRIMARY KEY (student_id, lesson_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE llm_jobs (                          -- аудит всех LLM-вызовов
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('game-journal','profile-update','lesson-plan','weekly-report','adhoc')),
  provider TEXT NOT NULL CHECK (provider IN ('codex-exec','openai-api')),
  model TEXT, ref_type TEXT, ref_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  prompt_path TEXT, output_path TEXT, error TEXT,
  queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, duration_ms INTEGER
) STRICT;

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value))) STRICT, WITHOUT ROWID;

-- Представления для дашборда ---------------------------------------------
CREATE VIEW v_daily_activity AS
  SELECT student_id, day, SUM(games) games, SUM(puzzles) puzzles, SUM(ms) active_ms FROM (
    SELECT student_id, substr(started_at,1,10) day, 1 games, 0 puzzles, COALESCE(student_time_ms,0) ms FROM games WHERE status='finished'
    UNION ALL
    SELECT student_id, substr(started_at,1,10), 0, 1, time_ms FROM puzzle_attempts
  ) GROUP BY student_id, day;

CREATE VIEW v_opening_stats AS
  SELECT student_id, student_color, eco, opening_name, COUNT(*) n,
         AVG(student_outcome='win')*100 win_pct, AVG(accuracy_student) avg_accuracy
  FROM games WHERE status='finished' AND eco IS NOT NULL
  GROUP BY student_id, student_color, eco, opening_name;

CREATE VIEW v_theme_stats AS
  SELECT a.student_id, t.theme, COUNT(*) n, AVG(a.solved)*100 solved_pct, AVG(a.time_ms) avg_ms
  FROM puzzle_attempts a JOIN puzzle_themes t ON t.puzzle_id=a.puzzle_id
  GROUP BY a.student_id, t.theme;

CREATE VIEW v_phase_errors AS
  SELECT g.student_id, m.phase, m.judgment, COUNT(*) n
  FROM moves m JOIN games g ON g.id=m.game_id
  WHERE m.is_student=1 AND m.judgment IN ('inaccuracy','mistake','blunder')
  GROUP BY g.student_id, m.phase, m.judgment;

PRAGMA user_version = 1;
```

Примечания: `started_at` хранится в UTC ISO-8601; «день» для серий нужно считать в **локальной** зоне (в `v_daily_activity` для простоты UTC-подстрока; в коде серий использовать `Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' })` или хранить отдельную колонку `local_day`). Объём: ~5 партий/день × 365 × ~80 полуходов ≈ 150 тыс. строк `moves` в год — для SQLite ничто.

---

## 8. Метрики прогресса

### 8.1. Win%, точность хода, точность партии, ACPL

Беру **формулы Lichess** (открытые, общеизвестные, сравнимые с тем, что ребёнок увидит на lichess.org):

```ts
// packages/shared/src/metrics.ts  (чистые функции; используются и сервером, и браузером)
const clampCp = (cp: number) => Math.max(-1000, Math.min(1000, cp));        // lila: Cp.CEILING = 1000
export const mateToCp = (mate: number) => (mate > 0 ? 1000 : -1000);        // scalachess: мат → потолок с знаком

/** Win% с точки зрения стороны, для которой дан cp. Константа из lila PR #11148. */
export const winPercent = (cp: number) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clampCp(cp))) - 1);

/** Точность хода по падению Win% (до → после, с точки зрения сходившего). */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (winBefore - winAfter)) - 3.166924740191411;
  return Math.max(0, Math.min(100, raw + 1));                                 // +1 — «бонус неопределённости» (AccuracyPercent.scala)
}

/** ACPL: средняя потеря в сантипешках; оценки обрезаются ±1000, потеря не меньше 0. */
export const acpl = (losses: number[]) => losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
```

Точность **партии** у Lichess — не среднее арифметическое: `(взвешенное по волатильности среднее + гармоническое среднее) / 2`, где окно `windowSize = clamp(plies/10, 2, 8)`, вес окна = stdev Win% в окне, зажатый в `[0.5, 12]`. Реализовать так же (≈40 строк) и покрыть тестом на 2–3 эталонные партии, сверив с lichess.org (допуск ±1–2%, т.к. глубина анализа другая).

Оценки ходов (judgment): у Lichess пороги по падению «winning chances» на шкале **[-1; 1]**: `≥0.1` неточность, `≥0.2` ошибка, `≥0.3` зевок (т.е. 5/10/15 процентных пунктов Win%); плюс правила для потерянного/упущенного мата. Для ребёнка пороги лучше сделать **настраиваемыми по уровню** (на старте ловим только «зевки фигуры», иначе тренер будет перебивать каждый ход) — хранить в `settings`.

Протокол анализа: для партии из N полуходов считаем N+1 позицию одним и тем же лимитом (`Threads 1`, `go nodes 400000` — в один поток, иначе результат не воспроизводим, см. п.5.1); `eval_before(i)` = оценка позиции i (она же «оценка лучшего хода»), `eval_after(i)` = −оценка позиции i+1 с точки зрения соперника. Так потеря считается относительно лучшего хода, найденного тем же поиском. Дебютные «книжные» ходы (первые ≤ 8–10 полуходов, пока позиция есть в ECO-таблице) помечаются `book` и в ACPL не входят.

Фаза партии: `opening` — пока позиция в ECO-базе или ply ≤ 16; `endgame` — когда сумма не-пешечного материала обеих сторон ≤ 13 (в «пешках»: Q9 R5 B3 N3) или нет ферзей и ≤ 2 лёгких/тяжёлых фигур у стороны; иначе `middlegame`. (Эвристика собственная; у Lichess свой `Divider` — точное совпадение не требуется.)

### 8.2. Рейтинг задач по темам — Glicko-2

| Пакет | Версия | Лицензия | Обновлён | Типы | Загрузок/нед | Вердикт |
|---|---|---|---|---|---|---|
| **glicko2-lite** (kenany) | **6.0.0** | MIT | 2026-05-26 (репо: push 2026-09-21) | встроены (`.d.cts/.d.mts`), ESM+CJS, `engines: node 22 \|\| 24 \|\| >=26` | ~560 | **Рекомендую**: одна чистая функция, состояние храним сами в `ratings` |
| glicko2 (mmai/glicko2js) | 1.2.2 | MIT | 2026-08-21 | нет встроенных | ~12 900 | ОК, но stateful-класс «турнира» (`makePlayer`, `updateRatings`) — лишнее для нас |
| glicko2.ts | 1.3.2 | GPL-3.0 | 2022-01 | да | ~500 | заброшен |
| go-glicko | 1.1.0 | MIT | 2021 | да | — | заброшен |

Проверка эталоном из статьи Гликмана (игрок 1500/200/0.06 против 1400/30 W, 1550/100 L, 1700/300 L → ожидается 1464.06 / 151.52 / 0.05999): `glicko2-lite` дал **1464.0507 / 151.5165 / 0.059996** [ПРОВЕРЕНО ЛОКАЛЬНО].

```ts
import { glicko2 } from 'glicko2-lite';
// Каждая попытка = «партия» ученика против задачи (так же считает Lichess: «each attempt … a Glicko2 rated game between the player and the puzzle»).
export function ratePuzzleAttempt(s: { rating: number; rd: number; vol: number }, puzzle: { rating: number; rd: number }, score: 0 | 0.5 | 1) {
  return glicko2(s.rating, s.rd, s.vol, [[puzzle.rating, puzzle.rd, score]], { tau: 0.5 });
}
```

Правила: обновляем **две-три шкалы за попытку** — `puzzle:all` и `puzzle:<основная тема>` (темы Lichess: `fork`, `pin`, `hangingPiece`, `mateIn2`, `endgame`, …; «служебные» темы вроде `short`, `middlegame`, `advantage` в отдельные шкалы не заводим). Очко: 1 — с первой попытки без подсказки; 0.5 — решил с одной ошибкой/подсказкой (педагогически мягче, чем 0 у Lichess); 0 — иначе. Рейтинг самих задач **не меняем** (берём из CSV Lichess: `Rating`, `RatingDeviation`). Подбор следующей задачи: рейтинг задачи ∈ `[r − 100; r + 50]` по шкале темы, доля успеха целится в ~75–80% (для мотивации ребёнка). RD растёт при простое: раз в день для неактивных шкал вызывать `glicko2(r, rd, vol, [])` — пустой период увеличивает RD (проверено: `glicko2(1500, 200, 0.06, [], {tau:0.5})` → `{ rating: 1500, rd: 200.27, vol: 0.06 }`, т.е. пустой массив поддерживается и RD растёт по формуле Гликмана `sqrt(φ² + σ²)`; рост медленный — ≈0,27 за период при RD 200, — поэтому «период» = день, а не попытка).

Источник задач: Lichess puzzle DB — CSV `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,…`, **CC0**, 6 100 952 задач (файл от 2026-09-10; последнее поле — `DailyDate`). Две ловушки формата (из Notes на database.lichess.org): (1) **`FEN` — позиция ДО хода соперника**: ученику показываем позицию после применения первого хода из `Moves`, решение начинается со второго хода; (2) все ходы решения — «единственные», **кроме мата в 1 ход: засчитывать любой матующий ход** (проверять через chess.js `isCheckmate()`, а не сравнением с базой). Импортировать подмножество (например, рейтинг 400–2200, Popularity ≥ 80, ~100–200 тыс.) скриптом `pnpm import-puzzles`. `game:*`-рейтинг ученика против ботов можно вести той же функцией, приняв `approx_elo` бота за рейтинг с RD≈50 — как ориентир, не как «настоящий Эло».

### 8.3. Остальные метрики

| Метрика | Как считать | Зачем |
|---|---|---|
| Зевки/ошибки/неточности на партию | `COUNT` по `moves.judgment` где `is_student=1`; тренд по неделям | главный KPI для ребёнка на этом уровне |
| **Эффективность «подумай ещё»** | `takebacks`: доля случаев, где `retry_win_drop < порог`; тренд `takebacks_offered` на партию ↓ | показывает, учится ли он проверять ход сам |
| Ошибки по фазам и мотивам | `v_phase_errors`, `moves.motifs` | выбор следующего урока |
| Время | `avg(move_ms)`, доля ходов < 3 с, `blunderRate` для быстрых (< 3 с) vs медленных ходов, `time_trouble_plies` (часы < 10% базы), поражения по времени по контролям | «играет слишком быстро» — типичная детская проблема |
| Дебюты | ECO/название по последней позиции партии, найденной в таблице lichess-org/chess-openings (CC0, TSV → `eco.json` по EPD при сборке); `v_opening_stats` | репертуар, прогресс в дебютных принципах |
| Серии (streak) | по `v_daily_activity` в локальной зоне: текущая серия = число подряд идущих дней до сегодня/вчера; «заморозка» 1 день в неделю — на усмотрение | мотивация |
| Объём | минут/неделю, партий, задач | для родителя |
| Учебный план | `lesson_progress.status/mastery`, `next_review_at` | интервальное повторение |

### 8.4. Библиотека графиков

| | **Recharts 3.10.1** | chart.js 4.5.1 + react-chartjs-2 5.3.1 | ECharts 6.1.0 | uPlot 1.6.32 | @nivo/line 0.99.0 |
|---|---|---|---|---|---|
| React 19 | да (peer `^19`) | да | через обёртку | без обёртки | НЕ ПРОВЕРЕНО |
| Загрузок/нед | ~43.0 млн | ~9.0 млн | ~3.7 млн | ~0.4 млн | ~0.7 млн |
| Последний релиз | 2026-09-09 | 2025-10 | 2026-05 | 2025-03 | 2025-05 |
| Стиль API | декларативные компоненты (SVG) | императивный canvas | императивный, огромный | минималистичный canvas | декларативный |

**Recharts**: у нас 5–8 простых графиков (линия рейтинга с полосой ±RD через `Area`, столбцы «ошибок на партию», радар по темам `RadarChart`, календарь активности проще сверстать CSS-гридом). Объёмы данных крошечные, производительность canvas не нужна. График оценки партии (eval-graph по ходам) — тоже `AreaChart` с кликом по точке → переход к позиции.

---

## 9. Шахматные часы

Требования: 1/5/10 минут, опциональный инкремент, **пауза, пока говорит тренер** и во время диалога «взять назад», отсутствие дрейфа, корректная работа в фоне вкладки.

Правила реализации:

1. **Никогда не вычитать «тик» из остатка.** Остаток = `remainingAtTurnStart − (performance.now() − turnStartedAt)`. `performance.now()` монотонен (не прыгает при NTP/переводе часов, в отличие от `Date.now()`).
2. Тик (`requestAnimationFrame` или `setInterval(100)`) нужен **только для перерисовки**. В фоновых вкладках Chrome зажимает таймеры до 1 раза/с (а при intensive throttling — до 1/мин) — при подходе из п.1 это не влияет на корректность.
3. Падение флажка — **один `setTimeout(msToFlag())`**, перевзводится после каждого press/pause/resume; плюс проверка при `visibilitychange` и при каждом ходе.
4. **Пауза с подсчётом причин** (`Set<string>`): `coach-talk`, `takeback-dialog`, `tab-hidden`(по желанию), `parent`. Часы идут только когда множество пусто — тренер может начать говорить во время диалога взятия назад, и ничего не сломается.
5. Время хода (`%emt`) = сумма «идущих» сегментов, без пауз. Часы ученика **продолжают идти во время `checkingMove`** (это 50–300 мс), останавливаются только при реальном вмешательстве.
6. Часы бота: списывать «время на раздумье» = фактическое время движка + искусственная человекоподобная задержка (иначе бот ходит мгновенно и ребёнок привыкает играть блиц).
7. Блиц 1 мин: вмешательства тренера по умолчанию выключены (или ≤ 1 за партию), иначе партия теряет смысл как тренировка цейтнота.
8. После каждого хода снимок `{w, b, active}` уходит на сервер в составе `POST /moves` → при перезагрузке страницы партия восстанавливается **на паузе** с сохранёнными часами.

Эскиз (протестирован на Node 26 с подменой источника времени; обратите внимание — без parameter properties, иначе Node strip-режим падает) [ПРОВЕРЕНО ЛОКАЛЬНО]:

```ts
// apps/web/src/game/clock.ts
export type Side = 'w' | 'b';

export class ChessClock {
  private remainingMs: Record<Side, number>;
  private active: Side | null = null;
  private startedAt: number | null = null;   // монотонная отметка начала текущего «идущего» сегмента
  private spentThisMove = 0;                 // сумма сегментов текущего хода (паузы исключены)
  private pausedBy = new Set<string>();
  private incMs: number;
  private now: () => number;
  flagged: Side | null = null;

  constructor(baseMs: number, incMs = 0, now: () => number = () => performance.now()) {
    this.remainingMs = { w: baseMs, b: baseMs }; this.incMs = incMs; this.now = now;
  }
  private segment(): number { return this.startedAt === null ? 0 : this.now() - this.startedAt; }

  remaining(side: Side): number {
    return side === this.active ? Math.max(0, this.remainingMs[side] - this.segment()) : this.remainingMs[side];
  }
  start(side: Side) { this.active = side; this.spentThisMove = 0; this.startedAt = this.pausedBy.size ? null : this.now(); }

  /** Вызывать при COMMIT хода (после проверки зевка / диалога взятия назад). */
  press(): { spentMs: number; clockMs: number; flagged: boolean } {
    const side = this.active!; const seg = this.segment();
    const spentMs = this.spentThisMove + seg; const left = this.remainingMs[side] - seg;
    if (left <= 0) { this.remainingMs[side] = 0; this.flagged = side; this.active = null; this.startedAt = null; return { spentMs, clockMs: 0, flagged: true }; }
    this.remainingMs[side] = left + this.incMs;
    this.start(side === 'w' ? 'b' : 'w');
    return { spentMs, clockMs: this.remainingMs[side], flagged: false };
  }
  pause(reason: string) {
    if (this.pausedBy.size === 0 && this.active && this.startedAt !== null) {
      const seg = this.segment(); this.remainingMs[this.active] = Math.max(0, this.remainingMs[this.active] - seg);
      this.spentThisMove += seg; this.startedAt = null;
    }
    this.pausedBy.add(reason);
  }
  resume(reason: string) { this.pausedBy.delete(reason); if (this.pausedBy.size === 0 && this.active) this.startedAt = this.now(); }
  msToFlag(): number | null { return this.active && this.startedAt !== null ? this.remaining(this.active) : null; }
  snapshot() { return { w: this.remaining('w'), b: this.remaining('b'), active: this.active, pausedBy: [...this.pausedBy], flagged: this.flagged }; }
}
```

Связка с тренером: события realtime data-channel о начале/конце воспроизведения ответа (`output_audio_buffer.started` / `output_audio_buffer.stopped` / `output_audio_buffer.cleared` — имена по API reference Realtime server events; события приходят только в WebRTC/SIP-соединениях, что нам и нужно; `cleared` приходит при перебивании — его тоже трактовать как «замолчал») → `clock.pause('coach-talk')` / `resume`. Для GPT-Live (см. п.10) набор событий другой — слой `coach/` должен отдавать наружу абстрактные `speaking-started/stopped`. Страховка: авто-`resume` по таймауту 30 с, чтобы зависшее событие не остановило часы навсегда.

---

## 10. API локального сервера

Общее: префикс `/api`, JSON, zod-валидация, типы экспортируются как `AppType` → фронт вызывает через `hc<AppType>('/')` (проверено: с относительной базой `$get/$post` работают — уходит `fetch('/api/…')`, — но `$url()` и `$ws()` бросают `Invalid URL`; если они понадобятся — `hc<AppType>(window.location.origin)`). Идентификаторы партий — ULID (`ulid 3.0.2`). Все «медленные» операции — асинхронные задания + события SSE.

| Метод и путь | Назначение |
|---|---|
| `GET /api/health` | версия, наличие `stockfish`/`codex`, статус OPENAI_API_KEY (без значения) |
| `GET /api/bootstrap` | всё для старта UI: ученик, боты, настройки, незавершённая партия, `coach-brief` |
| **Партии** | |
| `POST /api/games` | `{ botId, tcBaseS, tcIncS, studentColor, startFen? }` → `{ id, slug }` |
| `GET /api/games?limit&before&botId&outcome` | лента истории |
| `GET /api/games/:id` | метаданные + ходы + takebacks + utterances |
| `POST /api/games/:id/moves` | `{ ply, san, uci, fenBefore, fenAfter, clockMs, moveMs, pausedMs, live:{cp,mate,depth}?, clocks:{w,b} }` — идемпотентно по `(game_id, ply)` |
| `POST /api/games/:id/takebacks` | `{ ply, fenBefore, triedUci, triedSan, cpBefore, cpAfter, winDrop, motif?, coachSaid? }` → `{ id }` |
| `PATCH /api/games/:id/takebacks/:tbId` | `{ accepted, retryUci?, retrySan?, retryWinDrop?, thinkMs? }` |
| `POST /api/games/:id/utterances` | `{ ply?, role, source, text }` — транскрипты ребёнка/тренера (батчами) |
| `POST /api/games/:id/pause` / `resume` | фиксация состояния часов для восстановления |
| `POST /api/games/:id/finish` | `{ result, termination, finalFen, clocks }` → рендер PGN+MD (этап 1), постановка `analysis` и `game-journal` в очереди |
| `POST /api/games/:id/analyze` | перезапуск анализа `{ nodes? }` |
| `GET /api/games/:id/pgn` · `GET /api/games/:id/journal` | отдать файлы (`text/plain`, `text/markdown`) |
| `PUT /api/games/:id/journal/parent-notes` | записать блок `parent:begin/end` |
| **Задачи** | |
| `GET /api/puzzles/next?theme?&lessonId?` | подбор по рейтингу шкалы |
| `POST /api/puzzles/:id/attempts` | `{ solved, firstTry, wrongMoves, hintsUsed, timeMs }` → `{ ratingBefore, ratingAfter, themeRatings }` |
| `GET /api/puzzles/attempts?day` | журнал дня |
| **Учебный план** | |
| `GET /api/curriculum` | треки, уроки, статусы |
| `GET /api/lessons/:id` | markdown урока + привязанные задачи/позиции |
| `POST /api/lessons/:id/progress` | `{ status, mastery }` |
| **Ученик и прогресс** | |
| `GET /api/student/profile` · `PUT /api/student/profile/parent-notes` | `profile.md` (сырой md + распарсенный front-matter) |
| `GET /api/student/coach-brief` | сжатый контекст для realtime |
| `GET /api/progress` | содержимое `progress.json` (пересчитать, если устарел) |
| `GET /api/progress/series?metric=accuracy|acpl|blunders|rating&scope&from&to&bucket=game|day|week` | ряды для графиков |
| `GET /api/progress/openings` · `/themes` · `/time` · `/activity` | срезы из представлений |
| **Тренер / LLM** | |
| `POST /api/realtime/token` | сервер → `POST https://api.openai.com/v1/realtime/client_secrets` (`session.type="realtime"`, модель, голос, `instructions` = системный промпт + `coach-brief.md`) → отдаёт браузеру только `value` эфемерного ключа (`ek_…`) и срок жизни (`expires_after.seconds` 10…7200, по умолчанию 600 — подтверждено по API reference) |
| `POST /api/voice/session` | провайдер-нейтральная обёртка: для Realtime API возвращает `{ kind:'ephemeral', value, expiresAt }`; для GPT-Live принимает `{ sdp }` от браузера, сервер сам вызывает `POST https://api.openai.com/v1/live/sessions` (`session` + `transport: { type:'webrtc', sdp }`) и возвращает SDP-answer |
| `POST /api/llm/jobs` | `{ kind, refId }` — поставить задачу (`game-journal`, `profile-update`, `weekly-report`, …) |
| `GET /api/llm/jobs/:id` | статус/результат |
| **События** | |
| `GET /api/events` (SSE) | `analysis.progress {gameId, done, total}`, `analysis.done`, `llm.job.done`, `files.updated {path}`, `progress.updated` |
| **Сервис** | |
| `POST /api/admin/rebuild-index` · `POST /api/admin/backup` · `POST /api/admin/export` | обслуживание (только с localhost, см. п.11) |
| `GET /*` | статика SPA (prod) + COOP/COEP |

**GPT-Live (`gpt-live-1`)** — голосовой API OpenAI, в документации WebRTC стоит первой вкладкой перед Realtime API. Full-duplex («can listen while speaking»), биллинг **по времени: $0.05/мин** (+ отдельно backend-модель), function calling есть, structured outputs — нет; лимиты в одновременных сессиях (Tier 1 — 25, Free — не поддерживается; нужен «project API key with access to GPT-Live»). Отличия от Realtime API: (а) **эфемерных токенов нет** — браузер шлёт SDP-offer на наш сервер, сервер делает `POST /v1/live/sessions` с `{ session, transport: { type: "webrtc", sdp } }` (Node SDK: `client.live.create(...)`, пример в доке требует Node ≥22.6 и биндится на 127.0.0.1) и возвращает answer; создание WebRTC-сессии биллит 15 с авансом; ждать `session.started` в data-channel; (б) «мозг» вынесен в **delegation**: `responses` (OpenAI-hosted модель, в примере `gpt-5.6-terra`) или **`client`** — приложение само исполняет делегированную задачу любым агентом. Client delegation — место, куда можно подключить шахматный «мозг» на нашем сервере (движок + при желании Codex по подписке), оставив голосу только разговор; тогда tools исполняются на сервере, и серверу нужен доступ к текущей позиции (она приходит через `POST /moves`) и собственный быстрый движок (WASM-в-Node, п.5.1). Для сравнения: gpt-realtime-2.1 по сторонним замерам ≈ $0.06–0.11/мин, gpt-realtime-2.1-mini дешевле. Качество русского языка, детский голос, задержка delegation — НЕ ПРОВЕРЕНО; выбор модели — в исследовании про голос.

### 10.1. Эскиз: `codex exec` как LLM-бэкенд по подписке

Флаги проверены по `codex exec --help` установленного codex-cli 0.154.0: `-m`, `-s read-only|workspace-write|danger-full-access`, `-C`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--output-schema <FILE>`, `--json`, `-o/--output-last-message <FILE>`, prompt из stdin при `-`. По документации: sandbox по умолчанию read-only; прогресс — в stderr, финальное сообщение — в stdout; авторизация ChatGPT лежит в `~/.codex/auth.json`. Реальный запуск из сервера в этом исследовании **не выполнялся** (чтобы не тратить лимиты подписки) — НЕ ПРОВЕРЕНО.

**Альтернатива: официальный `@openai/codex-sdk` 0.155.1** (Apache-2.0, Node ≥18, зависит от `@openai/codex` 0.155.1 — т.е. несёт собственный бинарник CLI, независимо от brew-версии 0.154.0). SDK «spawns the CLI and exchanges JSONL events over stdin/stdout», даёт `codex.startThread({ workingDirectory, skipGitRepoCheck })`, `thread.run(prompt, { outputSchema })`, `runStreamed()` (события для SSE-прогресса), `resumeThread(id)` и параметр `env` для полного контроля окружения потомка. Авторизация та же (`CODEX_HOME`/ChatGPT-логин). Для нас это замена ~30 строк ручного `spawn` типизированным API (цена — платформенный пакет `@openai/codex@0.155.1-darwin-arm64`, ≈317 МБ распакованным); JSON Schema для `outputSchema` получаем из zod 4 встроенным `z.toJSONSchema()` (пакет `zod-to-json-schema` из README SDK не нужен). Ручной `spawn` ниже остаётся рабочим fallback-ом без зависимостей. Оговорка из документации Codex: для автоматизации OpenAI рекомендует API-ключи («API keys are the right default for automation»), а запуск под ChatGPT-аккаунтом называет продвинутым сценарием; `auth.json` — секрет уровня пароля. Для домашнего локального приложения это допустимо, но лимиты подписки общие с остальным интерактивным использованием Codex.

```ts
// apps/server/src/llm/codexExec.ts
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function codexExec<T>(opts: { prompt: string; schemaPath: string; cwd: string; model?: string; timeoutMs?: number }): Promise<T> {
  const out = join(tmpdir(), `codex-${randomUUID()}.json`);
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '-s', 'read-only',                       // LLM читает data/, но НЕ пишет: файлы собирает сервер из JSON-ответа
    '-C', opts.cwd, '--output-schema', opts.schemaPath, '-o', out];
  if (opts.model) args.push('-m', opts.model);
  args.push('-');                            // prompt через stdin (длинные журналы не лезут в argv)

  // ВАЖНО: вычистить API-ключи из окружения потомка, иначе Codex может уйти в API-биллинг вместо подписки (поведение НЕ ПРОВЕРЕНО — перестраховка)
  const { OPENAI_API_KEY, CODEX_API_KEY, ...env } = process.env;

  const child = spawn('/opt/homebrew/bin/codex', args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
  child.stdin.end(opts.prompt);
  const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 240_000);
  const code: number = await new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
  clearTimeout(timer);
  if (code !== 0) throw new Error(`codex exec exited ${code}: ${stderr}`);
  try { return JSON.parse(await readFile(out, 'utf8')) as T; } finally { await rm(out, { force: true }); }
}
```

Очередь LLM-задач — с **concurrency = 1**, ретраем ×2 и деградацией: если `codex` недоступен/лимит исчерпан, журнал остаётся в детерминированном виде (этап 1), задача помечается `failed` и повторяется позже; опциональный fallback на `openai@7.20.0` (API-биллинг) — выключен по умолчанию. Каждый вызов логируется в `llm_jobs` (+ prompt сохраняется в `data/.llm/ИД.prompt.md` для отладки).

Почему read-only + structured output, а не «пусть Codex сам правит profile.md»: (а) LLM не может испортить файлы/заметки родителя; (б) ответ валидируется zod-схемой; (в) запись атомарна и попадает в git-историю `data/` одним коммитом.

---

## 11. Безопасность локального сервера

Сервер держит ключ OpenAI и умеет запускать `codex` — даже на localhost это нужно закрыть:

1. `serve({ hostname: '127.0.0.1' })` — не слушать `0.0.0.0`.
2. **Allowlist заголовка `Host`** (`localhost:8787`, `127.0.0.1:8787`, в dev — `localhost:5173`) → защита от DNS-rebinding. **Проверка `Origin`** на всех не-GET запросах → защита от CSRF с посторонних сайтов. CORS не включать вообще (всё same-origin через Vite-proxy).
3. `.env` и `data/` — в `.gitignore` репозитория кода. Ключ никогда не отдаётся в браузер; эфемерный токен — короткоживущий.
4. В `spawn` — только фиксированные бинарники и массив аргументов (никакого `shell: true`), пользовательский текст идёт через stdin.
5. Доступ с iPad по LAN — отдельная задача: `getUserMedia` и `SharedArrayBuffer` требуют secure context, т.е. HTTPS (mkcert) — в MVP не делать.
6. Раздел «Родитель» — за простым PIN (хранить хэш в `settings`), чтобы ребёнок не правил настройки вмешательств.

---

## 12. Тестирование

| Уровень | Инструмент | Что тестируем |
|---|---|---|
| Unit | **Vitest 5.0.1** (`engines: node ^22.12 \|\| ^24 \|\| >=26`, peer vite ^8) | `metrics.ts` (эталоны Lichess), `ChessClock` (инъекция `now`), `gameMachine` (переходы, лимиты вмешательств), `pgnWriter` (round-trip через `parsePgn`), `journalWriter` (snapshot-тесты md; сохранность блока `parent`), `glicko.ts` (эталон Гликмана), репозитории на `new DatabaseSync(':memory:')` |
| Компоненты | Vitest + `@testing-library/react 16.3.3` + `happy-dom 20.14.5` (или browser mode: `@vitest/browser-playwright 5.0.1`) | панель часов, диалог взятия назад, графики (смоук) |
| API | Vitest + `app.request()` (Hono позволяет дергать роуты без сети) | валидация, идемпотентность `POST /moves`, `finish` → файлы во временном `DATA_DIR` |
| E2E | **Playwright 1.63.0** | полный сценарий «партия с Петей» |

Как E2E-тестировать шахматный UI:

* **Адресация клеток.** `react-chessboard 5.12.1` рендерит `data-square="e2"`, `data-piece`, и `id="<boardId>-square-e4"` [ПРОВЕРЕНО по dist]. Делать ходы **кликами** «клетка → клетка» (`page.locator('[data-square="e2"]').click()`), а не drag-and-drop (dnd-kit требует реалистичных pointer-событий → хрупко). Для chessground клеток в DOM нет (фигуры позиционируются transform-ами) — пришлось бы кликать по координатам: `box.x + file*size/8`.
* **Детерминизм.** Флаг `?e2e=1` / `VITE_E2E=1`: (а) движок заменяется **скриптованным фейком** (воркер с тем же UCI-интерфейсом, отвечает по таблице FEN→bestmove/eval), (б) realtime-клиент заменяется заглушкой, эмитящей события «тренер начал/закончил говорить», (в) бот ходит без задержки. Настоящий WASM-движок тестируется отдельным небольшим смоук-тестом (`bestmove` на мат в 1).
* **Хук состояния.** В e2e-режиме выставлять `window.__chess = { fen(), phase(), clock() }` и проверять `await expect.poll(() => page.evaluate(() => window.__chess.fen())).toBe(...)` — надёжнее, чем разбирать DOM доски.
* **Часы.** `page.clock.install()` → `page.clock.fastForward('01:00')` → ожидать «время вышло». Playwright Clock переопределяет `Date`, `setTimeout/Interval`, `requestAnimationFrame` и **`performance`** (по документации) — поэтому логика часов должна жить в главном потоке (в Web Worker подмена не действует — НЕ ПРОВЕРЕНО).
* **Микрофон.** `use: { permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } }`. Реальный звонок в OpenAI в CI/E2E не делаем.
* **Проверка персистентности.** Сервер поднимается Playwright-ом (`webServer`) с `DATA_DIR=$(mktemp -d)`; после партии тест читает созданные `.pgn`/`.md` и проверяет: теги, `%clk` убывает, вариация-взятие-назад присутствует, front-matter парсится.
* Сценарии-минимум: (1) выигрыш у Пети матом; (2) зевок → вмешательство → взятие назад → часы стояли; (3) отказ от взятия назад; (4) падение флажка в 1-мин; (5) перезагрузка страницы посреди партии → восстановление на паузе; (6) страница прогресса рисует графики из сид-данных.

---

## 13. Запуск одной командой

Корневой `package.json` (scripts):

```jsonc
{
  "private": true, "type": "module",
  "packageManager": "pnpm@11.5.2",
  "engines": { "node": ">=26" },
  "scripts": {
    "dev":   "concurrently -k -n web,api -c cyan,green \"pnpm --filter @chess/web dev\" \"pnpm --filter @chess/server dev\"",
    "build": "pnpm --filter @chess/web build",
    "start": "pnpm build && node --env-file-if-exists=.env apps/server/src/index.ts",
    "test":  "vitest run",
    "e2e":   "playwright test",
    "typecheck": "tsc -b",
    "lint":  "oxlint",
    "rebuild-index":  "node --env-file-if-exists=.env apps/server/src/cli/rebuildIndex.ts",
    "import-puzzles": "node apps/server/src/cli/importPuzzles.ts"
  }
}
// apps/server/package.json → "dev": "node --watch --env-file-if-exists=../../.env src/index.ts"
```

* **dev**: два процесса (Vite :5173 с proxy `/api` → :8787; сервер с `node --watch`). `npm run dev` в корне работает так же, как `pnpm dev` (скрипт один и тот же) — при условии, что зависимости ставились pnpm.
* **prod/ежедневное использование**: один процесс Node раздаёт и API, и собранный SPA с `http://localhost:8787` — один origin, никаких proxy.
* pnpm 11: `onlyBuiltDependencies` удалён, вместо него карта **`allowBuilds`** в `pnpm-workspace.yaml`. **Пакет `stockfish@19.0.0` имеет `postinstall`** (симлинк `bin/stockfish.js` → большая сборка, нам не нужен). На pnpm 11.5.2 `pnpm add stockfish` / `pnpm install --frozen-lockfile` печатает `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: stockfish` и **выходит с кодом 1** (сломает лаунчер и CI), а pnpm сам дописывает в `pnpm-workspace.yaml` заглушку `allowBuilds: { stockfish: set this to true or false }`. Решение (проверено: exit 0): 

  ```yaml
  # pnpm-workspace.yaml
  packages: ['apps/*', 'packages/*']
  allowBuilds:
    stockfish: false          # скрипт не нужен: файлы движка копируем сами в apps/web/public/engine
    # better-sqlite3: true    # только если перейдём на него
  ```

  Остальной стек из п.14 (hono, zod, chessops, chess.js, glicko2-lite, react, react-chessboard, zustand, recharts, vite, vitest, @playwright/test, oxlint, typescript 6.0.3, concurrently) ставится на pnpm 11.5.2 без build-скриптов и peer-предупреждений [ПРОВЕРЕНО ЛОКАЛЬНО].

Лаунчер для ребёнка — `Шахматы.command` в корне (`chmod +x`; файл, созданный локально, не получает quarantine-атрибут, Gatekeeper не мешает):

```bash
#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:$PATH"
PORT=8787
if ! lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  [ -d node_modules ] || pnpm install --frozen-lockfile
  [ -d apps/web/dist ] || pnpm build
  nohup node --env-file-if-exists=.env apps/server/src/index.ts >> data/server.log 2>&1 &
  for i in {1..50}; do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.2; done
fi
# окно «как приложение», без адресной строки; разрешение на микрофон для localhost Chrome запомнит
open -na "Google Chrome" --args --app="http://localhost:$PORT" --autoplay-policy=no-user-gesture-required
```

(Поведение `--autoplay-policy` для приветствия маскота голосом без клика — НЕ ПРОВЕРЕНО; запасной вариант — большая кнопка «Привет!» на первом экране, которая и даёт user gesture для аудио/микрофона.) Позже лаунчер можно завернуть в Automator/Platypus-приложение с иконкой или перейти на Electron.

---

## 14. Рекомендуемые пакеты и версии (по `npm view` на 2026-09-21)

**Runtime (web)**

| Пакет | Версия | Лицензия | Примечание |
|---|---|---|---|
| react / react-dom | 19.3.0 | MIT | |
| zustand | 5.0.15 | MIT | |
| @tanstack/react-query | 5.103.2 | MIT | |
| react-router | 8.4.0 | MIT | или wouter 3.11.0 для 6 экранов |
| chess.js | 1.4.0 | BSD-2-Clause | правила в UI; **NAG не экспортирует** |
| chessops | 0.15.1 | GPL-3.0-or-later | PGN (`%clk/%emt/%eval`, NAG, вариации), FEN/EPD |
| react-chessboard | 5.12.1 | MIT | peer React ^19; `data-square` для E2E. Альтернатива: chessground 9.2.1 (GPL-3.0) |
| stockfish | 19.0.0 | GPL-3.0 | WASM: lite / lite-single → `public/engine/` (пакет ~205 МБ распакованный — брать только 4 файла) |
| recharts | 3.10.1 | MIT | |
| hono | 4.13.8 | MIT | на фронте — только `hono/client` |
| zod | 4.6.5 | MIT | общие схемы в `packages/shared` |
| tailwindcss + @tailwindcss/vite | 4.3.3 | MIT | опционально |
| motion | 13.4.0 | MIT | анимации UI; маскот (Rive `@rive-app/react-canvas 4.34.3` / `lottie-react 3.1.2`) — тема другого исследования |

**Runtime (server)**

| Пакет | Версия | Лицензия | Примечание |
|---|---|---|---|
| hono | 4.13.8 | MIT | |
| @hono/node-server | 2.1.1 | MIT | `serve`, `serve-static` |
| @hono/zod-validator | 0.9.1 | MIT | |
| zod | 4.6.5 | MIT | |
| `node:sqlite` | встроен (Node 26.7, SQLite 3.53.4) | — | RC (1.2). Запасной: better-sqlite3 13.0.3 (MIT) |
| chessops | 0.15.1 | GPL-3.0-or-later | PGN-писатель, проверка ходов при rebuild-index |
| glicko2-lite | 6.0.0 | MIT | |
| ulid | 3.0.2 | MIT | id партий |
| yaml | 2.9.1 | ISC | front-matter, curriculum.yaml |
| openai | 7.20.0 | Apache-2.0 | опционально (fallback LLM); для `/client_secrets` достаточно `fetch` |
| pino | 10.3.1 | MIT | опционально |

**Dev**

| Пакет | Версия | Примечание |
|---|---|---|
| vite | 8.3.0 | |
| @vitejs/plugin-react | 6.1.1 | peer vite ^8 |
| typescript | **~6.0.3** | `latest` = 7.0.2 (вышел 2026-07-08; typescript-eslint его ещё не поддерживает, но нам он не нужен; шаблон Vite держит ~6.0.2) |
| oxlint | 1.83.0 | линтер из шаблона Vite |
| prettier | 3.9.8 | формат (или Biome 2.5.14 «всё в одном») |
| vitest | 5.0.1 | |
| @playwright/test | 1.63.0 | |
| @testing-library/react | 16.3.3 | |
| happy-dom | 20.14.5 | |
| concurrently | 10.0.5 | |
| @types/node / @types/react / @types/react-dom | 26.6.2 / 19.3.0 / 19.3.0 | |

Не нужны: `tsx` (Node 26 исполняет `.ts` сам), `dotenv` (`--env-file-if-exists`), `nodemon` (`node --watch`), `cors`, ORM.

Лицензионная заметка: Stockfish (GPL-3.0), chessops/chessground (GPL-3.0) делают приложение в целом GPL-3.0 **при распространении**. Для домашнего использования это ни на что не влияет; если проект когда-нибудь будет публиковаться — публиковать под GPL-3.0 или заменить chessops на свой PGN-сериализатор + `@mliebelt/pgn-parser 1.4.19` (Apache-2.0), а движок вынести в отдельный процесс.

---

## 15. Риски и открытые вопросы

| # | Пункт | Статус / смягчение |
|---|---|---|
| 1 | `node:sqlite` — Release Candidate, не Stable | тонкий адаптер `db.ts`; fallback better-sqlite3 13.0.3 проверен на Node 26 |
| 2 | Реальный запуск `codex exec` / Codex SDK из сервера под ChatGPT-подпиской: лимиты при автоматизации, поведение при наличии `OPENAI_API_KEY`/`CODEX_API_KEY` в env (по документации `CODEX_API_KEY` переключает на API-ключ; OpenAI рекомендует для автоматизации API-ключи, ChatGPT-auth называет «advanced») | НЕ ПРОВЕРЕНО (флаги — проверены по `--help`); очередь с concurrency 1, ключи из env потомка вычищать, деградация до детерминированного журнала |
| 3 | Полный realtime/GPT-Live звонок под `COEP: require-corp`; качество русского и детского голоса | CORS-fetch к api.openai.com проверен; сам звонок — НЕ ПРОВЕРЕНО. Если что-то сломается — COEP можно выключить и остаться на lite-single без потери функций |
| 4 | События realtime для «тренер говорит/замолчал» | `output_audio_buffer.started/stopped/cleared` (WebRTC/SIP only); страховочный таймаут авто-resume часов оставить |
| 5 | Скорость нативного Stockfish 19 на M5 Max при `nodes 400000`; расхождение оценок нативной (полная сеть) и WASM-lite сборки | нативный — НЕ ПРОВЕРЕНО; WASM lite в Node 26.7 — ≈1,1 Mnps/поток. Для метрик выбрать ОДНУ сборку и записывать её в `analysis_engine`. Воспроизводимость — только `Threads 1` |
| 6 | Совпадение нашей game accuracy с цифрами lichess.org на эталонных партиях | формулы сверены с исходниками lila; эталонный тест на реальных партиях — НЕ ПРОВЕРЕНО |
| 7 | Playwright `page.clock` внутри Web Worker | НЕ ПРОВЕРЕНО → часы держим в main thread |
| 8 | drizzle-kit@rc + node:sqlite; сторонние Kysely-диалекты для node:sqlite | НЕ ПРОВЕРЕНО — ORM не рекомендую на старте |
| 9 | TypeScript 7.0.2 (релиз 2026-07-08) | по умолчанию ~6.0.3 как в шаблоне Vite; 7.0.2 можно опробовать на `tsc -b` сразу |
| 12 | Голосовой API: GPT-Live (`gpt-live-1`) без эфемерных токенов (SDP-обмен через наш сервер) | маршрут `POST /api/voice/session` провайдер-нейтральный; слой `coach/` прячет различия событий; выбор модели — в исследовании про голос |
| 13 | `pnpm install` падает (exit 1) из-за `postinstall` пакета `stockfish` на pnpm 11 | `allowBuilds: { stockfish: false }` в `pnpm-workspace.yaml` (п.13) |
| 10 | Chrome `--autoplay-policy` для голосового приветствия без клика | НЕ ПРОВЕРЕНО → кнопка «Привет!» |
| 11 | Транскрипты голоса ребёнка — чувствительные данные | всё хранится локально в `data/`; не коммитить в публичные репозитории; в OpenAI уходит только то, что идёт в realtime/LLM-вызовы |

---

## 16. Порядок реализации (предложение)

1. Каркас монорепо + `pnpm dev` + health-роут + COOP/COEP + пустая доска.
2. Партия с ботом в браузере (WASM-движок), `ChessClock`, журналирование ходов в SQLite, `finish` → PGN + детерминированный MD.
3. Проверка зевка + автомат взятия назад (пока с текстовым тренером).
4. Нативный анализ → accuracy/ACPL/NAG → обновлённые PGN/MD, `progress.json`, страница «Прогресс».
5. Realtime-тренер (токен, tools, паузы часов, транскрипты → `utterances`).
6. `codex exec`: `game-journal`, `profile-update`, `coach-brief`.
7. Задачи + Glicko-2 по темам; учебный план.
8. `.command`-лаунчер, бэкапы, git-история `data/`, E2E-набор.

---

## Источники

Документация и страницы (по состоянию на 2026-09-21):

* Node.js — SQLite: https://nodejs.org/api/sqlite.html и https://nodejs.org/docs/latest-v26.x/api/sqlite.html (Stability 1.2 Release candidate; история версий)
* Node.js — TypeScript (type stripping): https://nodejs.org/docs/latest-v26.x/api/typescript.html
* Vite — Server Options (v8.3.0): https://vite.dev/config/server-options
* Drizzle ORM — Node SQLite: https://orm.drizzle.team/docs/connect-node-sqlite
* Drizzle issue «drizzle-kit does not support node:sqlite»: https://github.com/drizzle-team/drizzle-orm/issues/5471
* Drizzle PR «Add drizzle-orm/node-sqlite»: https://github.com/drizzle-team/drizzle-orm/pull/4346 (из выдачи поиска)
* OpenAI — Realtime WebRTC guide: https://developers.openai.com/api/docs/guides/voice-webrtc
* OpenAI/Codex — Non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode (редирект с https://developers.openai.com/codex/noninteractive)
* Lichess — Accuracy: https://lichess.org/page/accuracy
* lila `AccuracyPercent.scala`: https://raw.githubusercontent.com/lichess-org/lila/master/modules/analyse/src/main/AccuracyPercent.scala
* lila `Advice.scala`: https://raw.githubusercontent.com/lichess-org/lila/master/modules/tree/src/main/Advice.scala
* lila `winningChances.ts`: https://github.com/lichess-org/lila/blob/master/ui/lib/src/ceval/winningChances.ts
* scalachess `eval.scala`: https://github.com/lichess-org/scalachess/blob/master/core/src/main/scala/eval.scala
* Lichess open database (puzzles, CC0): https://database.lichess.org/
* lichess-org/chess-openings (CC0): https://github.com/lichess-org/chess-openings
* Enhanced PGN (`%clk`, `%emt`, `%egt`, `%mct`): https://www.enpassant.dk/chess/palview/enhancedpgn.htm
* Playwright — Clock: https://playwright.dev/docs/clock
* Electron v44.4.3 release (Node 24.21.0, Chromium 152): https://releases.electronjs.org/release/v44.4.3
* Tauri 2 — Embedding External Binaries (sidecar): https://v2.tauri.app/develop/sidecar/
* COOP/COEP и `credentialless` (поиск): https://web.dev/articles/coop-coep , https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy , https://developer.chrome.com/blog/coep-credentialless-origin-trial
* pnpm 11 `allowBuilds` (поиск): https://pnpm.io/blog/releases/11.0 , https://pnpm.io/cli/approve-builds , https://github.com/pnpm/pnpm/issues/12749
* Node.js 24 — SQLite (статус RC с v24.15.0): https://nodejs.org/docs/latest-v24.x/api/sqlite.json ; релизы Node: https://nodejs.org/dist/index.json
* Electron releases: https://releases.electronjs.org/releases.json
* Stockfish `engine.cpp` и `search.h` (UCI-опции, `LowestElo = 1320`, `HighestElo = 3190`): https://raw.githubusercontent.com/official-stockfish/Stockfish/master/src/engine.cpp
* OpenAI — Realtime server events: https://developers.openai.com/api/reference/resources/realtime/server-events
* OpenAI — GPT-Live: https://developers.openai.com/api/docs/guides/live , https://developers.openai.com/api/docs/guides/live-migration , https://developers.openai.com/api/docs/guides/voice-agents , https://developers.openai.com/api/docs/models/gpt-live-1 , https://developers.openai.com/api/docs/pricing
* `@openai/codex-sdk`: https://www.npmjs.com/package/@openai/codex-sdk
* GitHub API (`gh api repos/…`): kenany/glicko2-lite, mmai/glicko2js, Clariity/react-chessboard, nmrugg/stockfish.js, WiseLibs/better-sqlite3, niklasf/chessops, jhlywa/chess.js
* npm registry (`npm view …`, README пакета `stockfish`, `api.npmjs.org/downloads`) — все версии/лицензии/даты из таблиц выше
* Локальные инструменты: `codex exec --help` (codex-cli 0.154.0), `brew info stockfish`, шаблон `create-vite@9.2.1/template-react-ts`

Локальные эксперименты: `sqlite-test/` (node:sqlite, better-sqlite3, chessops PGN round-trip, chess.js NAG, glicko2-lite эталон), `schema/` (DDL из п.7), `vite-coi/` (COOP/COEP в Vite 8 + проверка `crossOriginIsolated` и CORS-fetch к api.openai.com в Chromium 152), `hono-test/` (Hono + zod + SSE + RPC на Node 26 без сборки), `ws/` (pnpm workspace + нативный TS), `clock/` (ChessClock).
