# 02 — Шахматные движки и лестница ботов (браузер / Node)

> Версии, лицензии, размеры и звёзды — по `npm view`, `gh api`, unpkg-метаданным и исходникам; поведение движка проверено запуском (Node 26.7 и Chromium). Что проверить не удалось, помечено «(не проверено)».
> Замеры скорости и турнир — на Apple M5 Max (18 ядер), Node v26.7.0.

---

## 0. TL;DR — что берём

| Задача | Решение | Почему |
|---|---|---|
| Движок ботов (в браузере) | npm **`stockfish@19.0.0`** (nmrugg / Chess.com), сборка **`stockfish-19-lite-single`** (JS 21 КБ + WASM 1.79 МБ) в Web Worker | Stockfish 19 (релиз 2026-09-05), не требует COOP/COEP, грузится мгновенно, ~1 Mnps на этом Mac, всё равно сверхчеловеческой силы |
| Слабые «человечные» боты (250–2000) | **Свой сэмплер поверх MultiPV**: `go depth N` + `MultiPV K` + softmax по потере оценки + вероятность случайного хода. Штатные `Skill Level`/`UCI_Elo` для низа **не годятся** (минимум 1320) | Сила не зависит от скорости устройства (лимит по глубине), плавная шкала, проверена турниром (см. §5) |
| Сильные уровни (≥1320) | либо тот же сэмплер (L4/L5), либо штатные `UCI_LimitStrength` + `UCI_Elo` 1320…3190 | шкала UCI_Elo в тесте вела себя ровно: +200 номинала ≈ +200 измеренного Elo |
| «Дима» (максимум) | тот же lite-движок без ограничений, `go movetime 1000` | 60:0 против UCI_Elo 2100 в тесте |
| Движок тренера (eval + лучший вариант + MultiPV, проверка зевка до ответа бота) | **Отдельный второй Worker** с тем же `stockfish-19-lite-single`, `Skill Level 20`, `MultiPV 3`, `UCI_ShowWDL true` | Замерено: depth 12 × MultiPV 3 = **0.12 с**, depth 18 × MultiPV 3 = **0.92 с** |
| Глубокий пост-анализ партий (опционально) | нативный **Stockfish 19** из Homebrew (`brew install stockfish`, GPL-3.0-only, bottled) через `child_process.spawn` на Node-сервере | многопоточность, полная сеть ~79 МБ, без ограничений браузера |
| «Человекоподобие» 2-го этапа | **Maia-3** (ONNX, ~46 МБ, через `onnxruntime-web@1.30.0`) — как это делает maiachess.com | единственная модель с рейтинг-кондиционированием 600…2600; лицензия AGPL/GPL — для локального приложения ок |
| Правила/PGN | `chess.js@1.4.0` (BSD-2-Clause) | нейтральная лицензия, в отличие от `chessops` (GPL-3.0-or-later) |

Главные выводы:

1. **Минимальный `UCI_Elo` у Stockfish 19 = 1320** (константа `Skill::LowestElo` в `src/search.h`, тег `sf_19`). Ребёнок-новичок такого бота не обыграет. Ниже 1320 штатными средствами официального Stockfish опуститься нельзя.
2. Lichess для уровней 1–3 использует **Fairy-Stockfish**, у которого `Skill Level` от **−20** до 20 и `UCI_Elo` от **500** до 2850; уровни lichess 1…8 = Skill −9, −5, −1, 3, 7, 11, 16, 20 + depth 5/5/5/5/5/8/13/22 + movetime 50…1000 мс (исходник `fishnet/src/api.rs`).
3. Chess.com все свои 100+ ботов (250…3200, «Martin» и т.д.) строит на **Komodo** с разными настройками и дебютными книгами (закрытый движок) — подтверждено help-центром chess.com.
4. Свой сэмплер поверх MultiPV даёт управляемую лестницу **от «почти случайные ходы» до ~2000** одной и той же сборкой движка — измерено турниром из ~1 800 партий (§5).

---

## 1. Ландшафт движков

| Пакет / проект | Версия | Дата | Лицензия | Что это | Потоки / требования | Вердикт |
|---|---|---|---|---|---|---|
| **`stockfish`** (npm; repo `nmrugg/stockfish.js`, ★1201, © Chess.com) | **19.0.0** | 2026-09-15 | GPL-3.0 (обвязка `index.js`, примеры — MIT) | Stockfish 19 → WASM, 5 сборок (см. §2); те же файлы — ассетами GitHub-релиза v19.0.0 | single — без заголовков; multi — нужен SharedArrayBuffer (COOP/COEP) | **Основной выбор** |
| **`@lichess-org/stockfish-web`** (★57) | **0.5.0** | 2026-09-05 | npm: AGPL-3.0-or-later (GitHub API показывает GPL-3.0; файл LICENSE в пакете — текст GPL-3) | `sf_19`, `sf_19_smallnet`, `fsf_14` (Fairy-SF 14), варианты relaxed-simd | **всегда** sharedMem + SIMD + dynamic import из воркера; NNUE качается отдельно и подаётся через `setNnueBuffer()` | README прямо говорит: «not straight-forward to load… Check out nmrugg/stockfish.js for a simpler browser Stockfish». Брать только если понадобится Fairy-SF |
| `lila-stockfish-web` | 0.0.11 | 2025-04 | AGPL-3.0-or-later | старое имя пакета выше | — | устарел |
| `fairy-stockfish-nnue.wasm` (★40) | 1.1.12 | 2026-08-26 | GPL-3.0 | Fairy-Stockfish → WASM (pychess.org) | только pthreads (есть `stockfish.worker.js`) → нужен COOP/COEP | Один из двух поддерживаемых WASM-движков с `Skill Level −20…20` и `UCI_Elo 500…2850` (второй — `fsf_14.js/.wasm` внутри `@lichess-org/stockfish-web@0.5.0`; оба требуют COOP/COEP); запасной вариант |
| `stockfish.wasm` 0.10.0 / `stockfish.js` 10.0.2 / `stockfish-nnue.wasm` (niklasf / hi-ogawa) | — | 2022-05 | GPL-3.0 | SF 10/11/14 | — | заморожены, «kept for compatibility» |
| `@lichess-org/zerofish` | 0.0.40 | 2025-10 | AGPL-3.0-or-later | lc0 (CPU, только крошечные сети) + Stockfish classical в WASM — на этом lichess строит локальных «персональных» ботов (`ui/botPlay`, `ui/lib/src/bot`) | — | интересен как источник идей (§4.2), как зависимость — сыро («See lila source code for example usage») |
| **Stockfish 19** нативный (★16 686) | sf_19 | 2026-09-05 | GPL-3.0 | официальный релиз; **WASM-бинарников в релизе нет** (только native universal), но в Makefile появились цели `ARCH=wasm32` / `wasm32-relaxed-simd` | Homebrew: `stockfish: stable 19 (bottled)`, GPL-3.0-only | опция для серверного анализа |
| `lc0` (Homebrew) | 0.32.1 | — | GPL-3.0-or-later | «тело» для сетей Maia-1 (`go nodes 1`) | нативный бинарник | только для Maia-1, нативно |
| Patricia (`Adam-Kulju/Patricia`, ★249) | 5.1 | 2026-08-26 | **MIT** | «агрессивный» движок со штатным `Skill_Level 1…20` = **500…3000 Elo** по таблице README (1→500, 2→800, 3→1000, 4→1200 …), рассчитан на игру с людьми | только нативные бинарники Linux/Windows x86-64 (Apple Silicon — сборка из исходников, не проверено); WASM нет | единственный найденный не-GPL движок со шкалой ниже 1320; ниже 500 не опускается. Кандидат для серверного (Node `spawn`) варианта ступеней 4–7, если ошибки сэмплера покажутся неестественными, а Maia-3 — слишком тяжёлой |
| **Maia-1** `CSSLab/maia-chess` (★1241) | v1.0 (2021) | — | GPL-3.0 | 9 сетей lc0 `maia-1100…1900.pb.gz` по ~1.3 МБ | нужен lc0 | человекоподобно, но узкий диапазон 1100–1900 и «сильнее своего рейтинга» |
| **Maia-2** `CSSLab/maia2` (★153) | pip `maia2` | 2026-07 | **MIT** | единая модель rapid/blitz, PyTorch | Python | README: «For new projects, see Maia-3» |
| **Maia-3** `CSSLab/maia3` (★180) | — | 2026-05 | **AGPL-3.0** (код; про веса: «see repo») | Chessformer, 5M / 23M / 79M, UCI-движок на Python (`maia3-5m`), опции `Elo/SelfElo/OppoElo/Temperature/TopP/MultiPV` | PyTorch; в браузере — ONNX (см. §7) | лучший кандидат на «человечных» ботов 2-го этапа |
| `js-chess-engine` | 2.4.6 | 2026-02 | MIT | простой JS-движок, уровни 0–4 | — | только если нужен не-GPL движок; слабее и менее управляем |
| `node-uci` | 1.3.4 | 2022-06 | MIT | UCI-обёртка для Node | — | заброшен; своя обёртка — 60 строк (§6.3) |
| `chess.js` (★4407) | 1.4.0 | 2025-06 | BSD-2-Clause | правила, SAN/PGN/FEN | — | **берём** |
| `chessops` | 0.15.1 | 2026-07 | GPL-3.0-or-later | правила от lichess | — | не нужно |

---

## 2. Stockfish в WebAssembly: детали

### 2.1. Пять сборок `stockfish@19.0.0` (размеры — из unpkg `?meta`, байты)

| Сборка | Файлы в `node_modules/stockfish/bin/` | Размер | Потоки | Требует COOP/COEP | Сеть NNUE |
|---|---|---|---|---|---|
| full multi | `stockfish-19.js` + `.wasm` | 32 718 + **99 065 439** | да (`setoption name Threads`) | **да** | полная `nn-1a298aa575a0.nnue` (SFNNv16), зашита в wasm |
| full single | `stockfish-19-single.js` + `.wasm` | 21 315 + **99 102 793** | нет | нет | та же |
| lite multi | `stockfish-19-lite.js` + `.wasm` | 32 817 + **1 636 291** | да | **да** | `nn-61e7af4bb97d.nnue` (≈1 МиБ, автор sscg13) |
| **lite single** | `stockfish-19-lite-single.js` + `.wasm` | 21 415 + **1 787 571** | нет (`Threads max 1`) | **нет** | та же lite-сеть |
| asm.js | `stockfish-19-asm.js` | 3 147 688 | нет | нет | крайний случай, «very slow and weak» |

- Весь npm-пакет — **204.9 МБ** распакованный (в нём все 5 сборок). В веб-сборку надо копировать только 2 нужных файла.
- В пакете есть `postinstall` (создаёт симлинк `bin/stockfish.js` → full). **pnpm по умолчанию блокирует postinstall-скрипты** — это не страшно: мы всегда указываем сборку явно (`"lite-single"`), симлинк не нужен.
- README автора: «most likely, you should use the lite single-threaded engine… the lite engine is still far stronger than any human will ever be». Точная разница Elo lite vs full — не проверено.
- Stockfish 19: «secondary neural network… has been retired» — в SF19 **одна** большая сеть (маленькой «smallnet» из SF16.1–18 в официальном движке больше нет). Файл полной сети по HTTP — 78 944 870 байт; lite-сеть — 975 309 байт.
- В Web Worker файл `.js` сам является воркером: путь к wasm берётся из hash (`new Worker('/engine/sf.js#/engine/sf.wasm')`) либо по умолчанию — тот же путь с заменой `.js → .wasm` (проверено по минифицированному исходнику и запуском в браузере). В JS-файле single-сборки нет ни одного упоминания `SharedArrayBuffer`. Есть протокол прогресса загрузки (`setoption name CanOutputEngineDownloadProgress` + `MessageChannel`) — полезно только для 99-МБ сборки.

**Запуск в Node 26.7 (`node stockfish-19-lite-single.js`, stdin/stdout):**

```
id name Stockfish 19 Lite WASM
option name Threads type spin default 1 min 1 max 1
option name Hash type spin default 16 min 1 max 33554432
option name MultiPV type spin default 1 min 1 max 256
option name Skill Level type spin default 20 min 0 max 20
option name UCI_LimitStrength type check default false
option name UCI_Elo type spin default 1320 min 1320 max 3190
option name UCI_ShowWDL type check default false
option name EvalFile type string default nn-61e7af4bb97d.nnue
info string NNUE evaluation using nn-61e7af4bb97d.nnue (1MiB, (768, 1024, 32, 32, 1))
```

Скорость (M5 Max, один поток WASM, MultiPV 3, миттельшпильная позиция): **~1.0–1.24 Mnps**; depth 10 — 70 мс, depth 12 — 79–120 мс, depth 14 — 417 мс, depth 16 — 348–704 мс, **depth 18 — 676–920 мс** (разброс — разные миттельшпильные позиции). В браузере (тот же V8) порядок величин тот же — проверено в Chromium (страница без COOP/COEP, `crossOriginIsolated=false`, `SharedArrayBuffer` недоступен, classic `new Worker(...)`, `.wasm` отдаётся с `Content-Type: application/wasm`): `uciok` через ~150 мс, 1.16 Mnps, depth 14 × MultiPV 3 = 213 мс. Для Safari/JavaScriptCore — не проверено.

### 2.2. Однопоточный vs многопоточный, SharedArrayBuffer, COOP/COEP

Многопоточные WASM-сборки используют pthreads → `SharedArrayBuffer` → страница должна быть **cross-origin isolated**:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp      # или credentialless (Chrome 96+, поддержка уже)
```

Проверка в рантайме: `self.crossOriginIsolated === true`. Побочные эффекты (web.dev): все cross-origin ресурсы в режиме no-cors (картинки, скрипты, шрифты, iframes) должны отдавать `Cross-Origin-Resource-Policy: cross-origin` или грузиться через CORS; `COOP: same-origin` ломает интеграции через cross-origin popups (OAuth-окна, платежи). `fetch()` с CORS, WebSocket и WebRTC под COEP не подпадают (по спецификации; в связке с OpenAI Realtime — не проверено, проверить при интеграции голоса).

**Рекомендация:** стартовать с **lite-single** (заголовки не нужны вообще, ноль рисков для голосового стека). Глубины 12–18 за 0.1–0.9 с более чем достаточно и боту, и тренеру. Многопоточность включать позже и только если понадобится; на локальном сервере заголовки ставятся одной строкой (§6.6). Для тяжёлого пост-анализа проще нативный Stockfish на сервере (§8).

### 2.3. `@lichess-org/stockfish-web` — почему не он

API: ES-модуль-фабрика → объект с `uci(cmd)`, `listen`, `onError`, `setNnueBuffer(buf, index)`, `getRecommendedNnue()`. Сеть NNUE качается отдельно (lichess хранит её в OPFS/IndexedDB через `bigFileStorage`), нужен общий `WebAssembly.Memory` (`sharedWasmMemory(minMem)`: 1536 МБ для smallnet, 2560 МБ для полной). В каталоге движков lichess (`ui/lib/src/ceval/engines/engines.ts`) **все** сборки `sf_19*` и `fsf_14` требуют `['sharedMem', 'simd', 'dynamicImportFromWorker']`. Для нашего приложения это лишняя сложность.

---

## 3. Штатное ослабление Stockfish: как оно устроено и где его предел

### 3.1. `Skill Level`, `UCI_LimitStrength`, `UCI_Elo` (исходники тега `sf_19`)

```cpp
// src/search.h
struct Skill {
    constexpr static int LowestElo  = 1320;
    constexpr static int HighestElo = 3190;
    Skill(int skill_level, int uci_elo) {
        if (uci_elo) {
            double e = double(uci_elo - LowestElo) / (HighestElo - LowestElo);
            level = std::clamp((((37.2473 * e - 40.8525) * e + 22.2943) * e - 0.311438), 0.0, 19.0);
        } else level = double(skill_level);
    }
    bool enabled() const { return level < 20.0; }
    bool time_to_pick(Depth depth) const { return depth == 1 + int(level); }
```

```cpp
// src/search.cpp — Skill::pick_best
double weakness = 120 - 2 * level;
int push = int(weakness * int(topScore - rootMoves[i].score)
             + delta * (rng.rand<unsigned>() % int(weakness))) / 128;   // delta = min(top - min, PawnValue)
// выбирается ход с максимальным score + push
```

Что из этого следует:

- `UCI_Elo`: **min 1320, max 3190**, default 1320. `UCI_Elo` просто пересчитывается полиномом в дробный `Skill Level` 0…19 и **имеет приоритет** над `Skill Level`. Вики: калибровка при контроле **120s+1s, привязка к CCRL 40/4** — это шкала «движок против движков», не человеческий рейтинг.
- При включённом ослаблении движок сам поднимает `MultiPV` минимум до **4** и выбирает «слабый» ход из этих кандидатов на глубине `1 + level`. То есть даже Skill 0 выбирает среди **четырёх лучших** ходов, причём разброс ограничен ценой пешки (`delta ≤ PawnValue`). Такой бот почти не «зевает фигуры» по-человечески: он играет странные, но тактически аккуратные ходы. Новичку против него тяжело.
- **Ниже 1320 официальный Stockfish не опускается.** `Skill Level` min = 0 (в Fairy-Stockfish: `Option(20, -20, 20)`).
- Сила при `Skill`/`UCI_Elo` зависит от времени на ход и железа **слабее, чем кажется, и не напрямую**: «слабый» ход всегда выбирается на итерации `depth == 1 + int(level)` (`search.cpp@sf_19`, строки 314–319, 557–559, 625–629; для `UCI_Elo` 1320→depth 1, 1500→2, 1700→3, 2100→5, 2300→6, 2600→8, 2900→12, 3190→19), а всё, что движок досчитал после этого, на выбор **не влияет** (`skill.best` уже зафиксирован). Время влияет косвенно — через таблицу перестановок: чем дольше движок думал на предыдущих ходах, тем точнее оценки на мелкой глубине (вероятное объяснение того, что в §5 `SK0` c `go depth 5` проиграл идентичному по уровню `E1320` c `movetime 100`: 28%, −168 Elo). Контрольные матчи по 60 партий тем же скриптом: `Skill Level 0 @ movetime 100` против `UCI_Elo 1320 @ movetime 100` = 56% — в пределах шума, т.е. это один и тот же уровень 0; `UCI_Elo 1320 @ depth 5` против `UCI_Elo 1320 @ movetime 100` = 42%, −53 Elo. Зависимость есть, но умеренная (десятки — полторы сотни Elo); гипотеза про Hash правдоподобна, но отдельно не проверена. Калибровка сделана для 120+1. При `movetime 100` мс шкала в тесте осталась ровной (§5), но абсолютные значения «плавают». Практический вывод: **не делить один Worker между ботом и тренером** — глубокий анализ тренера через общий Hash усилил бы «слабого» бота.

### 3.2. Как опуститься ниже 1320 — варианты

| Способ | Нижняя граница | Плюсы | Минусы |
|---|---|---|---|
| **A. Свой сэмплер по MultiPV + случайные ходы** (§4.4) | до уровня случайных ходов | один движок, любая гранулярность, сила не зависит от железа (лимит по depth), параметры прозрачны для тренера/родителя | «случайный ход» не всегда похож на человеческий зевок; нужна калибровка на ребёнке |
| B. Fairy-Stockfish `Skill Level −20…−1` / `UCI_Elo 500…` (как lichess lvl 1–3) | ~500 (заявлено) | готовая опция | в браузере только многопоточные сборки (COOP/COEP), старее база (FSF 14), та же «нечеловечность» выбора |
| B′. Patricia `Skill_Level 1…` (§1) | ~500 (по README) | MIT, шкала рассчитана на людей | только нативно (сервер), WASM нет |
| C. Ограничение `depth 1–3` / `nodes 50–500` без сэмплера | ~1000–1300 | просто | NNUE-оценка даже на depth 1 позиционно сильна; слабость не масштабируется вниз |
| D. **Maia-3** с `Elo=600…` и температурой (§7) | ~600 (лейблы maiachess.com: 600…2600) | по-настоящему человеческие ошибки | +46 МБ модель, onnxruntime-web, AGPL/GPL-код, надо страховать от «политик-галлюцинаций» в эндшпиле |
| E. Komodo-«personalities» (как chess.com) | 250 | — | закрытый движок, не вариант |

Рекомендация: **A сейчас**, **D как апгрейд** «человечности» для уровней 600–1600, когда базовое приложение заработает.

---

## 4. Как делают «именных» ботов большие площадки

### 4.1. Lichess «Play with the computer», уровни 1–8 (`lichess-org/fishnet`, `src/api.rs`, `src/queue.rs`)

| Уровень | Skill Level | depth | movetime | Движок |
|---|---|---|---|---|
| 1 | −9 | 5 | 50 мс | Fairy-Stockfish (flavor `MultiVariant` — для **всех** Work::Move, даже в стандартных шахматах; `Official` Stockfish используется только для анализа) |
| 2 | −5 | 5 | 100 мс | |
| 3 | −1 | 5 | 150 мс | |
| 4 | 3 | 5 | 200 мс | |
| 5 | 7 | 5 | 300 мс | |
| 6 | 11 | 8 | 400 мс | |
| 7 | 16 | 13 | 500 мс | |
| 8 | 20 | 22 | 1000 мс | |

Команда: `go movetime <t> depth <d>` (+ часы, если есть). Официальных оценок Elo этих уровней lichess не публикует; на форуме lichess ходят **неофициальные** оценки (например, 1≈850, 2≈950, 3≈1050, 4≈1250, 5≈1500–1700, 6≈1900, 7≈2000, 8≈2250) — считать их ориентиром, не фактом.

### 4.2. Lichess: новые локальные боты-персонажи (`lila/ui/lib/src/bot/bot.ts`, `@lichess-org/zerofish`)

Это самая близкая к нашей задаче открытая реализация (AGPL). Устройство хода бота:

1. **Дебютная книга** (polyglot, с весами; у каждого бота свой набор книг).
2. Параллельно: `zerofish.goFish(pos, {multipv, depth ≥ 10})` (Stockfish → список ходов с оценками → **cpl** каждого хода) и `goZero(pos, {net, nodes, multipv})` (lc0 с маленькой «характерной» сетью → «человеческие» кандидаты).
3. Взвешивание «фильтрами» — функциями от номера хода / ожидаемого результата / времени: `lc0bias` (насколько доверять сети), **`cplTarget` + `cplStdev`** (бот целится в заданную *среднюю потерю сантипешек*: `target = |mean + stdev·N(0,1)|`, вес хода — сигмоида от расстояния его cpl до target), `moveDecay` (геометрическое затухание по рангу: вес i-го хода = `decay^i`), плюс кастомные `aggression`, `pawnStructure`.
4. Хардкод-человечность: **если лучший кандидат — взятие только что походившей фигуры соперника, брать всегда** (и думать вдвое меньше).
5. `movetime.ts` — модель времени на ход, «намайненная» из базы lichess (янв. 2025) по контролю и рейтингу.
6. У бота есть `ratings` по контролям, картинка, звуки-реплики на события (`greeting`, `playerCheck`, `botCapture`…).

Идеи 3–6 стоит перенять (см. §6.4); сам `zerofish` — нет (сырой, без документации).

Другие открытые референсы: `Iamsdt/chess` (★26, «AI-powered chess trainer with Stockfish 18 + LLM coaching») — лицензия в репозитории не указана ⇒ код копировать нельзя, но UX/архитектуру посмотреть стоит; `Dash1971/maia-chess-android` (AGPL-3.0) — пример офлайн-интеграции Maia-3.

### 4.3. Chess.com

Help-центр: боты «all powered by Komodo»; Beginner — 15 ботов **250–850**, Intermediate — 15 ботов 1000–1400, Advanced — 20 ботов 1500–2100, Master — 10 ботов 2200–2450; «Engine» — ползунок **250–3200**; Adaptive-боты подстраивают силу по ходу партии. Сотрудник chess.com на форуме: «The bots are based on Komodo with various setting changes and custom opening books». Komodo закрыт → нам недоступно, но подтверждает подход «один движок + настройки + книги + персона».

### 4.4. Наш алгоритм «слабый, но похожий на человека»

```
ход_бота(позиция, уровень):
  1. если единственный легальный ход → сыграть
  2. (опц.) дебютная книга уровня
  3. с вероятностью pRandom → равномерно случайный легальный ход        // «зевок/бесцельный ход»
  4. иначе: go depth D, MultiPV K → кандидаты {ход_i, cp_i}
       отбросить кандидатов с потерей > maxLossCp
       выбрать по softmax: w_i = exp(-(cp_best - cp_i) / tempCp)         // «бюджет потери оценки»
  5. человеческие поправки (по желанию): всегда отбивать только что взятую фигуру;
     не сдаваться; предлагать ничью/«сдаваться» по правилам персоны; задержка хода по модели времени
```

Ручки: `depth` (тактическая зоркость), `MultiPV` (ширина выбора), `pRandom` (частота грубых ошибок), `tempCp` (насколько охотно берёт второй-третий по силе ход), `maxLossCp` (потолок ошибки в «осмысленном» ходе). Мат оценивается как ±10000 → бот, *когда считает*, мат в N видит и ставит; пропускает его только за счёт `pRandom`/малой глубины.

---

## 5. Эксперимент: калибровка лестницы (турнир)

**Условия:** `stockfish-19-lite-single` (WASM) под Node 26.7 на M5 Max; каждый бот — отдельный процесс движка (`spawn(process.execPath, [...])`); 60 партий на пару (по 30 каждым цветом), с начальной позиции, без книги, ничья после 300 полуходов; 30 пар, всего 1 800 партий. Погрешность на пару ≈ ±100 Elo (95%). Боты `E****` — штатный `UCI_LimitStrength` при `go movetime 100`; `SK0` — `Skill Level 0`, `go depth 5`; `MAX` — без ограничений, `movetime 100`; `RND` — равномерно случайные ходы. Между партиями `ucinewgame` не отправлялся (Hash переносился), книги/рандомизации дебютов для детерминированных пар не было (E-боты рандомизированы самим Skill, MAX–E2100 — нет); на выводы это не влияет. Таблица §5.2 воспроизводится пересчётом сырых результатов.

### 5.1. Конфигурации сэмплера

| id | depth | MultiPV | pRandom | tempCp | maxLossCp |
|---|---|---|---|---|---|
| P0 | 1 | 20 | 0.75 | 500 | 3000 |
| P1 | 1 | 20 | 0.55 | 400 | 2000 |
| P2 | 2 | 12 | 0.40 | 300 | 1200 |
| L1 | 3 | 10 | 0.30 | 200 | 900 |
| M1 | 3 | 8 | 0.22 | 170 | 750 |
| L2 | 4 | 8 | 0.15 | 150 | 600 |
| M2 | 4 | 6 | 0.10 | 120 | 500 |
| L3 | 5 | 6 | 0.07 | 100 | 400 |
| M3 | 5 | 5 | 0.05 | 80 | 320 |
| L4 | 6 | 5 | 0.03 | 60 | 250 |
| M4 | 7 | 4 | 0.02 | 45 | 200 |
| L5 | 8 | 4 | 0.01 | 35 | 150 |

### 5.2. Результаты (счёт первого бота)

| Пара | + = − | Очки | ΔElo |
|---|---|---|---|
| P0 – RND | 31 / 28 / 1 | 75% | +191 |
| P1 – RND | 38 / 22 / 0 | 82% | +260 |
| P2 – RND | 58 / 2 / 0 | 98% | +708 |
| P1 – P0 | 37 / 16 / 7 | 75% | +191 |
| P2 – P1 | 49 / 7 / 4 | 88% | +338 |
| L1 – P2 | 40 / 14 / 6 | 78% | +223 |
| M1 – L1 | 41 / 7 / 12 | 74% | +183 |
| L2 – M1 | 42 / 4 / 14 | 73% | +176 |
| M2 – L2 | 45 / 5 / 10 | 79% | +232 |
| L3 – M2 | 44 / 3 / 13 | 76% | +199 |
| M3 – L3 | 43 / 3 / 14 | 74% | +183 |
| L4 – M3 | 43 / 2 / 15 | 73% | +176 |
| M4 – L4 | 53 / 1 / 6 | 89% | +366 |
| L5 – M4 | 44 / 4 / 12 | 77% | +207 |
| **E1320 – L3** | 37 / 0 / 23 | 62% | **+83** |
| E1320 – L4 | 6 / 1 / 53 | 11% | −366 |
| E1320 – L5 | 1 / 0 / 59 | 2% | −708 |
| E1500 – L5 | 2 / 0 / 58 | 3% | −585 |
| E1700 – L5 | 9 / 1 / 50 | 16% | −290 |
| SK0(d5) – E1320 | 15 / 3 / 42 | 28% | −168 |
| E1500 – E1320 | 46 / 0 / 14 | 77% | +207 |
| E1700 – E1500 | 45 / 0 / 15 | 75% | +191 |
| E2100 – E1700 | 47 / 1 / 12 | 79% | +232 |
| MAX – E2100 | 60 / 0 / 0 | 100% | — |
| *через ступень:* L1 – RND | 59 / 1 / 0 | 99% | +830 |
| L2 – L1 | 56 / 2 / 2 | 95% | +512 |
| L3 – L2 | 51 / 3 / 6 | 88% | +338 |
| L4 – L3 | 54 / 4 / 2 | 93% | +458 |
| L5 – L4 | 54 / 3 / 3 | 93% | +436 |
| SK0(d5) – L4 | 1 / 1 / 58 | 3% | −636 |

### 5.3. Что это значит

- Шкала штатного `UCI_Elo` внутренне ровная даже при 100 мс на ход: шаг 200 номинала → +190…+230 измеренных.
- Привязка сэмплера к шкале UCI_Elo (через E1320/E1500/E1700): **L3 ≈ 1240, M3 ≈ 1420, L4 ≈ 1600–1690, M4 ≈ 1850–2000, L5 ≈ 2000–2100**; вниз по цепочке: M2 ≈ 1040, L2 ≈ 810, M1 ≈ 630, L1 ≈ 450, P2 ≈ 220, P1 ≈ −100, P0 ≈ −300, RND ≈ −400…−500.
- Абсолютные числа для нижних конфигов (P0…L2) получены **цепочкой** из 3–7 звеньев с погрешностью ±100 каждое ⇒ накопленная погрешность для Пети/Маши — ±250–350 Elo; прямые и цепочечные оценки расходятся (L2–L1: +512 напрямую против +359 через M1; L5–L4: +436 против +573). Порядок ботов надёжен, номиналы — нет.
- Отрицательные числа — артефакт шкалы «движок против движка»: внизу она растянута. По-человечески P0/P1 — это «почти случайно ходит, иногда берёт то, что плохо лежит, **часто не может поставить мат**» (28 ничьих из 60 против случайного игрока, средняя партия 200 полуходов). Именно такой соперник и нужен ребёнку, который только знает ходы.
- Между соседними конфигами **полной цепочки из 12** получилось **~180–230 Elo (73–79%)** — комфортный шаг «могу победить следующего, если постараюсь». Если идти «через одного» (L1→L2→L3→L4→L5), разрыв уже 340–510 Elo (88–95%) — поэтому в лестнице §6.1 именные ступени дополнены полушагами M1–M4. Скачок M4–L4 (+366) великоват — при желании вставить промежуточный конфиг (depth 6, MultiPV 4, pRandom 0.025, tempCp 50; не тестировался).
- ⚠️ Соответствие человеческому рейтингу не проверено и принципиально не проверяемо без партий людей. «Целевой Elo» в лестнице ниже — номинал для интерфейса; реальную сложность надо калибровать по результатам ребёнка (приложение и так пишет все партии — считать по каждому боту % очков за последние 10–20 партий).

---

## 6. Лестница ботов и код

### 6.1. Лестница (8 основных ступеней + полушаги)

Все ступени 1–7: движок `stockfish-19-lite-single` (npm `stockfish@19.0.0`), UCI-опции по умолчанию (`Skill Level 20`, `UCI_LimitStrength false`), `Hash 32`, `Threads 1`; команда `go depth D` при `MultiPV K`; выбор хода — сэмплером из §4.4. Лимит по глубине ⇒ расчёт занимает 1–50 мс на любом железе, а «время на раздумье» имитируется задержкой (§6.4).

| # | Имя (персона) | Целевой Elo (номинал) | Конфиг | depth | MultiPV | pRandom | tempCp | maxLossCp | Измерено (шкала UCI_Elo SF) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Петя** — «только научился» | ~250 | P1 | 1 | 20 | 0.55 | 400 | 2000 | ≈ −100 (82% против случайных ходов) |
| 2 | **Маша** | ~400 | P2 | 2 | 12 | 0.40 | 300 | 1200 | ≈ 220 |
| 3 | **Коля** | ~550 | L1 | 3 | 10 | 0.30 | 200 | 900 | ≈ 450 |
| 4 | **Оля** | ~800 | L2 | 4 | 8 | 0.15 | 150 | 600 | ≈ 810 |
| 5 | **Саша** — «средний» | ~1200 | L3 | 5 | 6 | 0.07 | 100 | 400 | ≈ 1240 (E1320 выигрывает у него 62%) |
| 6 | **Катя** | ~1600 | L4 | 6 | 5 | 0.03 | 60 | 250 | ≈ 1600–1690 |
| 7 | **Вова** | ~2000 | L5 | 8 | 4 | 0.01 | 35 | 150 | ≈ 2000–2100 |
| 8 | **Дима** — «безжалостный» | 3000+ | MAX | — | 1 | 0 | — | — | `go movetime 1000` (или по часам `wtime/btime`), 60:0 против UCI_Elo 2100 |

Полушаги для адаптивной сложности и «перехода на следующую ступень»: **Кроха** = P0 (ниже Пети), M1 (~650), M2 (~1000), M3 (~1400), M4 (~1800) — параметры в таблице §5.1. Они важны: между именными ступенями 3→4→5→6→7 разрыв в тесте 340–510 Elo (следующий бот выигрывает у предыдущего 88–95%), а с полушагом — ~200. В UI это можно подать как «Оля в хорошей форме» / «Саша после тренировки» либо как отдельных персонажей (тогда лестница = 13 ботов). Правило продвижения (предложение): ≥70% очков в последних 10 партиях с ботом → тренер предлагает следующую (полу)ступень; ≤25% → шаг назад.

Петя (P1) при `tempCp 400` берёт «висящего» ферзя лишь примерно в 15–20% случаев (оценка по формуле softmax при 20 кандидатах) — осознанная слабость, но на ребёнке стоит проверить, не выглядит ли это «поддавками».

Между «Вовой» и «Димой» при необходимости — штатные ступени: `setoption name UCI_LimitStrength value true` + `UCI_Elo 2300 / 2600 / 2900`, `go movetime 300` (Skill-выбор происходит на глубине 1+level ≤ 20, 300 мс хватает). Другая ось сложности, не требующая кода движка, — **фора материалом**: «Дима без ферзя / без ладьи / без коня» через стартовый FEN. Педагогически полезно (ребёнок учится реализовывать перевес против сильной защиты) и закрывает разрыв между Вовой (~2000) и Димой (3000+) лучше, чем `UCI_Elo 2300/2600/2900`.

**Альтернатива без своего сэмплера для ступеней ≥5** (если захочется «чистого» Stockfish): `UCI_LimitStrength true`, `UCI_Elo` = 1320 / 1500 / 1700 / 1900 / 2100 / 2300, `go movetime 100–300`. Минус — стиль менее «человечный», а сила косвенно (через заполнение Hash) зависит от времени/скорости устройства — см. уточнение в §3.1; сам «слабый» ход выбирается на глубине 1+level (1320→1, 1500→2, 1700→3, 2100→5, 2300→6, 2600→8, 2900→12, 3190→19).

Контроли 1/5/10 минут на силу бота **не влияют** (расчёт всегда миллисекунды); они влияют только на модель задержек (§6.4) и на то, включена ли «живая» проверка зевков тренером (в пуле 1 мин — выключить, разбирать после партии).

### 6.2. Установка и раздача файлов движка

```bash
npm i stockfish@19.0.0 chess.js@1.4.0
# pnpm: postinstall пакета stockfish можно не разрешать — он лишь создаёт симлинк bin/stockfish.js
mkdir -p public/engine
cp node_modules/stockfish/bin/stockfish-19-lite-single.{js,wasm} public/engine/
cp node_modules/stockfish/Copying.txt public/engine/LICENSE-stockfish.txt   # GPL: лицензия рядом с бинарником
```

npm-пакет `stockfish@19.0.0` — это **~205 МБ** (204 897 239 байт) в `node_modules` ради двух файлов на 1.8 МБ. Альтернатива без зависимости: те же файлы лежат ассетами GitHub-релиза `nmrugg/stockfish.js` **v19.0.0** (`gh api`: `stockfish-19-lite-single.js` 21 415 байт, `stockfish-19-lite-single.wasm` 1 787 571 байт — байт-в-байт те же размеры, что в npm):

```bash
mkdir -p public/engine && cd public/engine
curl -LO https://github.com/nmrugg/stockfish.js/releases/download/v19.0.0/stockfish-19-lite-single.js
curl -LO https://github.com/nmrugg/stockfish.js/releases/download/v19.0.0/stockfish-19-lite-single.wasm
# зафиксировать sha256 обоих файлов в репозитории (scripts/fetch-engine.sh), лицензию GPL-3.0 положить рядом
```

Важно: файл движка — **classic worker**, его нельзя пропускать через бандлер (Vite `?worker`/`import`): отдаём как статику из `public/` и создаём `new Worker('/engine/stockfish-19-lite-single.js')`. Сервер должен отдавать `.wasm` с `Content-Type: application/wasm` (Vite/Express делают это сами).

### 6.3. UCI-обёртка над Web Worker (TypeScript)

```ts
// src/engine/uci.ts
export interface PvLine {
  multipv: number; depth: number;
  cp: number;            // сантипешки с точки зрения стороны, чей ход; мат → ±(10000 - 10*N)
  mate?: number;         // мат в N (знак — в чью пользу)
  wdl?: [number, number, number];  // промилле win/draw/loss (UCI_ShowWDL)
  pv: string[];          // ходы в UCI-нотации (e2e4, e7e8q)
}
export interface SearchResult { bestmove: string; lines: PvLine[] }

const INFO = /^info .*?\bdepth (\d+) .*?\bmultipv (\d+) score (cp|mate) (-?\d+)(?: wdl (\d+) (\d+) (\d+))?.*? pv (.+)$/;

export function parseInfo(line: string): PvLine | null {
  if (!line.startsWith('info ') || / (upper|lower)bound /.test(line)) return null;
  const m = INFO.exec(line);
  if (!m) return null;
  const mate = m[3] === 'mate' ? +m[4] : undefined;
  const cp = mate === undefined ? +m[4] : Math.sign(mate) * (10000 - Math.abs(mate) * 10);
  return { depth: +m[1], multipv: +m[2], cp, mate,
           wdl: m[5] ? [+m[5], +m[6], +m[7]] : undefined, pv: m[8].trim().split(/\s+/) };
}

export class UciEngine {
  private w: Worker;
  private subs = new Set<(l: string) => void>();
  private chain: Promise<unknown> = Promise.resolve();   // сериализация поисков

  constructor(url = '/engine/stockfish-19-lite-single.js') {
    this.w = new Worker(url);                            // НЕ { type: 'module' }
    this.w.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') for (const s of this.subs) s(e.data);
    };
  }
  send(cmd: string) { this.w.postMessage(cmd); }

  private until(done: (l: string) => boolean, each?: (l: string) => void) {
    return new Promise<void>((resolve) => {
      const sub = (l: string) => { each?.(l); if (done(l)) { this.subs.delete(sub); resolve(); } };
      this.subs.add(sub);
    });
  }

  async init(options: Record<string, string | number | boolean> = {}) {
    let p = this.until((l) => l === 'uciok'); this.send('uci'); await p;
    for (const [k, v] of Object.entries(options)) this.send(`setoption name ${k} value ${v}`);
    p = this.until((l) => l === 'readyok'); this.send('isready'); await p;
  }

  /** position: 'startpos moves e2e4 e7e5' | 'fen <FEN> moves ...' ; go: 'depth 12' | 'movetime 500' | 'depth 12 searchmoves g1f3' */
  search(position: string, go: string, multipv = 1,
         onUpdate?: (lines: PvLine[]) => void): Promise<SearchResult> {
    const run = async (): Promise<SearchResult> => {
      const lines = new Map<number, PvLine>();
      let bestmove = '';
      let critical = '';   // SF19: на нелегальный ход/FEN WASM-сборка НЕ падает, а пишет CRITICAL ERROR и считает ДРУГУЮ позицию
      const done = this.until(
        (l) => (l.startsWith('bestmove') ? ((bestmove = l.split(' ')[1]), true) : false),
        (l) => {
          if (l.includes('CRITICAL ERROR')) { critical = l; return; }
          const p = parseInfo(l); if (p) { lines.set(p.multipv, p); onUpdate?.([...lines.values()]); }
        },
      );
      this.send(`setoption name MultiPV value ${multipv}`);
      this.send(`position ${position}`);
      this.send(`go ${go}`);
      await done;
      if (critical || bestmove === '(none)') throw new Error(critical || 'engine returned no move');
      return { bestmove, lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv) };
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
  stop() { this.send('stop'); }          // прервать текущий поиск: bestmove придёт сразу
  newGame() { this.send('ucinewgame'); }
  dispose() { this.send('quit'); this.w.terminate(); }
}
```

Замечания:
- Передавать позицию как `startpos moves …` (а не голый FEN), чтобы движок видел повторения позиций.
- Оценка всегда **с точки зрения стороны, чей ход** → для UI/тренера приводить к «за белых»: `cpWhite = turn === 'w' ? cp : -cp`.
- Два экземпляра: `botEngine` и `coachEngine` — разные Worker'ы (у каждого свой Hash и свои опции; тренер может думать, пока ребёнок думает).

### 6.4. Ход бота

```ts
// src/bots/ladder.ts
import type { Chess } from 'chess.js';
import { UciEngine, PvLine } from '../engine/uci';

export type BotLevel =
  | { id: string; name: string; elo: number; kind: 'sampler';
      depth: number; multipv: number; pRandom: number; tempCp: number; maxLossCp: number }
  | { id: string; name: string; elo: number; kind: 'max'; movetimeMs: number };

export const LADDER: BotLevel[] = [
  { id: 'petya', name: 'Петя', elo: 250,  kind: 'sampler', depth: 1, multipv: 20, pRandom: 0.55, tempCp: 400, maxLossCp: 2000 },
  { id: 'masha', name: 'Маша', elo: 400,  kind: 'sampler', depth: 2, multipv: 12, pRandom: 0.40, tempCp: 300, maxLossCp: 1200 },
  { id: 'kolya', name: 'Коля', elo: 550,  kind: 'sampler', depth: 3, multipv: 10, pRandom: 0.30, tempCp: 200, maxLossCp: 900 },
  { id: 'olya',  name: 'Оля',  elo: 800,  kind: 'sampler', depth: 4, multipv: 8,  pRandom: 0.15, tempCp: 150, maxLossCp: 600 },
  { id: 'sasha', name: 'Саша', elo: 1200, kind: 'sampler', depth: 5, multipv: 6,  pRandom: 0.07, tempCp: 100, maxLossCp: 400 },
  { id: 'katya', name: 'Катя', elo: 1600, kind: 'sampler', depth: 6, multipv: 5,  pRandom: 0.03, tempCp: 60,  maxLossCp: 250 },
  { id: 'vova',  name: 'Вова', elo: 2000, kind: 'sampler', depth: 8, multipv: 4,  pRandom: 0.01, tempCp: 35,  maxLossCp: 150 },
  { id: 'dima',  name: 'Дима', elo: 3000, kind: 'max', movetimeMs: 1000 },
];

const toUci = (m: { from: string; to: string; promotion?: string }) => m.from + m.to + (m.promotion ?? '');

function softmaxPick(lines: PvLine[], tempCp: number, maxLossCp: number): PvLine {
  const top = Math.max(...lines.map((l) => l.cp));
  const pool = lines.filter((l) => top - l.cp <= maxLossCp);
  const w = pool.map((l) => Math.exp(-(top - l.cp) / tempCp));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) if ((r -= w[i]) <= 0) return pool[i];
  return pool[0];
}

/** history — ходы партии в UCI; возвращает ход бота в UCI */
export async function pickBotMove(engine: UciEngine, game: Chess, history: string[], lvl: BotLevel): Promise<string> {
  const legal = game.moves({ verbose: true });
  if (legal.length === 1) return toUci(legal[0]);
  const pos = 'startpos' + (history.length ? ' moves ' + history.join(' ') : '');

  if (lvl.kind === 'max') return (await engine.search(pos, `movetime ${lvl.movetimeMs}`)).bestmove;

  // «человеческая» поправка из ботов lichess: отбить только что взятую фигуру почти всегда
  // (реализовать при желании: если последний ход соперника — взятие и есть ответное взятие на том же поле)

  if (Math.random() < lvl.pRandom) return toUci(legal[Math.floor(Math.random() * legal.length)]);
  const r = await engine.search(pos, `depth ${lvl.depth}`, lvl.multipv);
  return r.lines.length ? softmaxPick(r.lines, lvl.tempCp, lvl.maxLossCp).pv[0] : r.bestmove;
}
```

Задержка хода (чтобы бот не отвечал мгновенно и «жил» в контроле времени) — простая модель, позже можно заменить на таблицы lichess (`movetime.ts`):

```ts
// initialSec: 60 | 300 | 600
export function thinkDelayMs(initialSec: number, ply: number, remainingMs: number, isRecapture: boolean) {
  const base = initialSec * 1000 / 45;                 // ~1.3 c (1 мин), ~6.7 c (5 мин), ~13 c (10 мин)
  const opening = ply < 12 ? 0.35 : 1;                 // дебют быстрее
  const jitter = 0.4 + Math.random() * 1.2;
  const t = base * opening * jitter * (isRecapture ? 0.4 : 1);
  return Math.max(250, Math.min(t, remainingMs / 12)); // никогда не тратить >1/12 остатка
}
```

### 6.5. Движок тренера: eval + лучший вариант + MultiPV и «стоп, подумай ещё» ДО ответа бота

Поток:

1. Ход ребёнка ожидается → тренер в фоне считает позицию: `coach.search(pos, 'depth 14', 3)` (≈0.4 с). Результат `pre` = топ-3 варианта с оценками и WDL.
2. Ребёнок сделал ход `played`. **Бот ещё не ходит.**
3. Оценка сыгранного хода **на той же глубине из той же позиции**: если `played` есть среди `pre.lines` — она уже известна (0 мс); иначе `go depth <d> searchmoves <played>` (работает в lite-сборке, 0–30 мс в зависимости от заполнения Hash).
4. Потеря в «шансах на победу» по формуле lichess (`scalachess/eval.scala`, `lila/modules/tree/Advice.scala`):
   `wc(cp) = 2 / (1 + exp(−0.00368208·cp)) − 1 ∈ [−1, 1]`; `Δ = wc(best) − wc(played)`; **Δ ≥ 0.10 — неточность, ≥ 0.20 — ошибка, ≥ 0.30 — зевок**. Это серверная шкала (`Advice.scala`); клиентский `povDiff` в lila делит разницу на 2, и пороги 0.1/0.2/0.3 к нему не относятся.
5. Если сработал порог уровня → заморозить часы бота, голос: «Подожди! Верни ход и подумай ещё» → take-back (`game.undo()`), в журнал пишется попытка. Иначе → `pickBotMove(...)`.

```ts
// src/coach/judge.ts
import { UciEngine, SearchResult } from '../engine/uci';

const raw = (cp: number) => 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
const wc = (cp: number) => raw(Math.max(-1000, Math.min(1000, cp)));
const wcLine = (l: { cp: number; mate?: number }) =>            // как в lichess ui/lib/src/ceval/winningChances.ts
  l.mate !== undefined ? raw(Math.sign(l.mate) * (21 - Math.min(10, Math.abs(l.mate))) * 100) : wc(l.cp);

export type Verdict = 'ok' | 'inaccuracy' | 'mistake' | 'blunder';

export async function judgeMove(coach: UciEngine, posBefore: string, played: string, pre: SearchResult) {
  const best = pre.lines[0];
  let mine = pre.lines.find((l) => l.pv[0] === played);
  if (!mine) mine = (await coach.search(posBefore, `depth ${best.depth} searchmoves ${played}`, 1)).lines[0];
  const delta = wcLine(best) - wcLine(mine);
  const verdict: Verdict = delta >= 0.3 ? 'blunder' : delta >= 0.2 ? 'mistake' : delta >= 0.1 ? 'inaccuracy' : 'ok';
  return {
    verdict, delta,
    bestMove: best.pv[0], bestLine: best.pv.slice(0, 6), bestCp: best.cp, bestMate: best.mate,
    playedCp: mine.cp, playedMate: mine.mate, refutation: mine.pv.slice(1, 5),   // чем наказывается ход ребёнка
    alternatives: pre.lines.slice(0, 3).map((l) => ({ move: l.pv[0], cp: l.cp, wdl: l.wdl })),
  };
}
```

Рекомендуемая политика «стопа» (чтобы не задёргать ребёнка):
- порог зависит от уровня: для Пети–Коли останавливать только на `blunder` (Δ ≥ 0.30) **и** только если до хода позиция не была уже проиграна (`wc(best) > −0.6`); с Оли — на `mistake`;
- не более 3 остановок за партию, не чаще одной на 5 ходов; вторую попытку в той же позиции не блокировать (только объяснить после);
- в контроле 1 минута «живой» стоп выключен — разбор после партии;
- в LLM тренера уходит **только этот JSON** (SAN-варианты строит `chess.js`), модель ничего не считает сама — она объясняет: `bestLine` = «что лучше», `refutation` = «почему твой ход плох».

Опции `coachEngine.init({ Hash: 128, UCI_ShowWDL: true })`; MultiPV задаётся на поиск. Для пост-анализа партии: пройти все позиции `depth 16–18, MultiPV 2` ≈ 0.7–0.9 с на позицию → партия в 40 ходов ≈ 1 минута в одном воркере (или 3–4 воркера параллельно, ядер хватает).

Бесплатные API lichess как необязательное уточнение «истины» для тренера (ключ не нужен, нужна сеть, есть rate-limit ⇒ только поверх локального движка, с кэшем на диске): `https://tablebase.lichess.ovh/standard?fen=…` — 7-фигурные таблицы Syzygy (категория win/draw/loss, DTZ/DTM по каждому ходу) — для учебного блока «эндшпили», где lite-сеть на малой глубине может ошибаться; `https://lichess.org/api/cloud-eval?fen=…&multiPv=3` — кэш глубоких оценок (для позиции после 1.e4 — depth 60) — для дебютных позиций.

### 6.6. COOP/COEP (только если позже включать многопоточные сборки)

```ts
// vite.config.ts
export default defineConfig({
  server:  { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
// Express/Fastify в проде — те же два заголовка на HTML и на файлы воркера.
// В рантайме: const url = self.crossOriginIsolated ? '/engine/stockfish-19-lite.js' : '/engine/stockfish-19-lite-single.js';
// затем engine.init({ Threads: Math.min(4, navigator.hardwareConcurrency - 2), Hash: 128 })
```

(Проверено на `vite@8.3.0`.)

---

## 7. Maia / Maia-2 / Maia-3 — человекоподобные сети

| | Maia-1 | Maia-2 | **Maia-3** |
|---|---|---|---|
| Репозиторий | `CSSLab/maia-chess` ★1241 | `CSSLab/maia2` ★153 | `CSSLab/maia3` ★180 |
| Статья | KDD 2020 | NeurIPS 2024 | «Chessformer», arXiv 2605.19091 (README упоминают и ICLR 2026, и ICML '26) |
| Лицензия кода | GPL-3.0 | **MIT** | **AGPL-3.0** |
| Веса | 9 файлов `maia-1100…1900.pb.gz` (~1.3 МБ каждый) в релизе v1.0 | скачиваются `model.from_pretrained(type="rapid"|"blitz")` | Hugging Face `UofTCSSLab/Maia3-5M` (`maia3-5m.pt`, 20.97 МБ), `-23M`, `-79M`; лицензия весов на карточке: «see repo» |
| Диапазон силы | 1100–1900 (по сети на сотню) | рейтинг-кондиционирование (бины; точные границы не проверены) | `SelfElo`/`OppoElo` — непрерывные, UCI-спин 0…5000; maiachess.com предлагает ботов **600, 800, 1000…2000, 2200, 2400, 2600** |
| Как запускать | `lc0 --weights=maia-1100.pb.gz`, **`go nodes 1`** (поиск отключён) | Python / PyTorch | Python UCI-движок `maia3-5m` (`pip install .`), `Temperature`, `TopP`, `MultiPV` |
| В браузере | через lc0-WASM (у lichess — zerofish; готового npm-пакета lc0 нет) | раньше maiachess.com гонял ONNX Maia-2 | **да**: `maia-platform-frontend` (GPL-3.0, ★65) держит `public/maia3/maia3_simplified.onnx` (**45.7 МБ**) и считает его в воркере через `onnxruntime-web` (wasm-бэкенд), кэшируя модель в IndexedDB |
| Нюансы | «модели сильнее рейтинга, на котором обучены»; детерминированы → нужны книги | — | value-голова даёт WDL «как у людей», это **не** движковая оценка; для max-силы не предназначена |

Интерфейс ONNX-модели Maia-3 (из `public/maia-worker.js`): входы `tokens [B,64,12] float32`, `elo_self [B]`, `elo_oppo [B]`; выходы `logits_move` (4352 хода) и `logits_value` (3 = L/D/W). Препроцессинг/маски ходов — `src/lib/engine/tensor.ts` + `all_moves_maia3*.json`. Какой именно размер модели экспортирован в `maia3_simplified.onnx` — не проверено; 45.7 МБ (45 683 686 байт) ≈ 23 M параметров в fp16 либо ~11 M в fp32, т.е. вероятно **не** 5M-модель. Фронтенд зависит от `onnxruntime-web ^1.23.0`, список ботов — `maia_kdd_600…2600`.

**Как встроить (этап 2):** воркер `maia-worker` + `onnxruntime-web@1.30.0` (MIT); для ступеней 3–6 ход = сэмпл из политики Maia-3 при `elo_self = целевой Elo` с температурой ~1.0, **со страховкой Stockfish**: если выбранный ход теряет больше `maxLossCp` ступени — пересэмплировать (ограничивает «дикие» ходы сети в эндшпилях). Ступени 1–2 (ниже 600) остаются на сэмплере — данных lichess там мало и Maia там не валидирована. На Node-сервере альтернатива — `onnxruntime-node@1.30.0`.

Лицензионно: код maia3 — AGPL-3.0, фронтенд — GPL-3.0. Для локального семейного приложения это ничего не требует; при публикации приложения, включающего их код/модель, придётся открывать исходники под совместимой лицензией (AGPL ещё и при сетевом доступе).

---

## 8. Альтернатива: нативный Stockfish через Homebrew + Node

`brew info stockfish` → **stable 19 (bottled)**, GPL-3.0-only (`brew install stockfish` → `/opt/homebrew/bin/stockfish`). Официальные бинарники SF19 — «universal» (сами выбирают набор инструкций).

```ts
// server/nativeEngine.ts — тот же UCI-протокол, транспорт = stdin/stdout
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function spawnStockfish(bin = '/opt/homebrew/bin/stockfish') {
  const p = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = readline.createInterface({ input: p.stdout });
  const send = (cmd: string) => p.stdin.write(cmd + '\n');
  return { send, onLine: (cb: (l: string) => void) => rl.on('line', cb), kill: () => p.kill() };
}
// init: uci → setoption name Threads value 8 → setoption name Hash value 1024 → isready
// дальше тот же parseInfo/очередь, что в §6.3 (вынести транспорт в интерфейс {send, onLine})
```

В Node можно и без Homebrew: `const engine = await require('stockfish')('lite-single')` (без колбэка фабрика возвращает **Promise**; с колбэком — `require('stockfish')('lite-single', (err, engine) => …)`) → `engine.listener = line => …`, `engine.sendCommand(cmd)` (обвязка `index.js` пакета, MIT; `sendCommand` появляется только после резолва промиса), либо `spawn(process.execPath, ['…/stockfish-19-lite-single.js'])` — так запускался турнир §5.

| | WASM в браузере (lite-single) | Нативный SF19 на Node-сервере |
|---|---|---|
| Установка | `npm i`, 1.8 МБ статики | `brew install stockfish` (внешняя зависимость) |
| Скорость | ~1 Mnps, 1 поток | многопоточный, полная сеть; ожидаемо в разы–десятки раз быстрее (не проверено) |
| Задержка | 0 (в том же табе) | + HTTP/WebSocket до localhost (мс) |
| Офлайн/перенос на планшет | работает где угодно | только на этом Mac |
| Применение | боты + «живой» тренер | пакетный глубокий разбор партий, генерация задач из ошибок ребёнка |

Рекомендация: интерфейс `EngineTransport` с двумя реализациями; по умолчанию WASM, нативный — опциональный ускоритель для ночного/пост-анализа.

---

## 9. Лицензии: что означает GPL-3.0 для этого проекта

- **Stockfish, stockfish.js (npm `stockfish`), Fairy-Stockfish, lc0, Maia-1, maia-platform-frontend — GPL-3.0**; `@lichess-org/stockfish-web`, zerofish, **Maia-3 — AGPL-3.0**; Maia-2 — MIT; `onnxruntime-web` — MIT; `chess.js` — BSD-2; `react-chessboard@5.12.1` — MIT (peer: React 19); `chessground@9.2.1` / `@lichess-org/chessground@10.2.0` и `chessops` — **GPL-3.0-or-later**.
- **Личное/семейное использование без распространения — никаких обязательств.** GPL FAQ: можно модифицировать и использовать приватно, не публикуя; обязанности возникают только при распространении («convey»).
- Если приложение когда-нибудь **публикуется** (сайт, репозиторий, сборка для других): раздача `stockfish-19-*.js/.wasm` пользователям — это распространение GPL-бинарника → нужно приложить текст лицензии и дать исходники **ровно этой сборки** (достаточно ссылки на `nmrugg/stockfish.js` тега v19.0.0 + официальный Stockfish `sf_19`; если пересобирали с патчами — опубликовать патчи). README Stockfish формулирует это так же.
- Остальной код приложения общается с движком **текстовым UCI-протоколом через postMessage / stdin-stdout** отдельного воркера/процесса. GPL FAQ относит pipes/sockets/аргументы командной строки к механизмам общения «отдельных программ» (mere aggregation) — на этом основании проприетарные GUI и сам chess.com используют Stockfish. Поэтому собственный код приложения не обязан становиться GPL, **пока** движок остаётся отдельным файлом-воркером и не линкуется/не бандлится в общий модуль. (Это не юридическая консультация.)
- Напротив, **импорт GPL-библиотек в свой бандл** (`chessground`, `chessops`, код из `lila`/`maia-platform-frontend`) делает весь фронтенд производной работой → при публикации он должен быть под GPL/AGPL. Чтобы сохранить свободу выбора лицензии: `chess.js` + `react-chessboard` (или своя доска) и собственная реализация идей из §4.2, без копирования кода lichess.
- AGPL (Maia-3, stockfish-web): то же, плюс обязанность давать исходники пользователям, взаимодействующим **по сети**. Для localhost-приложения неактуально.
- Сети NNUE Stockfish обучены на данных Lc0 (ODbL) — для пользователя движка ограничений не создаёт.

---

## 10. Риски и открытые вопросы

1. **Человеческая калибровка низа лестницы не проверена** — турнир «движок против движка» даёт только относительный порядок. Нужна обратная связь от реальных партий ребёнка + адаптивные полушаги.
2. Равномерно-случайные ходы (pRandom) выглядят менее «по-человечески», чем ошибки Maia: бот может бесцельно двигать короля или отдавать ферзя «в никуда». Для Пети/Маши это приемлемо (и даже полезно: ребёнок учится замечать подставки), выше — лучше Maia-3 или «умный зевок» (случайный ход только среди ходов, не теряющих больше X на depth 1).
3. Боты-сэмплеры без книги в дебюте достаточно разнообразны за счёт случайности; «Дима» детерминирован → добавить небольшую книгу или `MultiPV 3` + выбор среди ходов в пределах 15 cp на первых 8 ходах.
4. Safari/WebKit: скорость WASM и работа воркера не проверялись (проверен только Chromium). Поведение COEP/COOP совместно с OpenAI Realtime (WebRTC) не проверялось — для lite-single неактуально, заголовки не ставятся.
5. `stockfish@19.0.0` — свежий релиз (2026-09-15); если всплывут баги — запасной вариант `stockfish@18.0.8` (2026-06-15) с тем же API файлов (`stockfish-18-lite-single.*`; lite-wasm там крупнее — **7.3 МБ** (7 295 411 байт) против 1.8 МБ в v19, по unpkg `?meta`).
6. Сила lite-сети против полной (в Elo) не измерена, скорость нативного SF19 на M5 Max тоже; для обучения ребёнка несущественно, для «истины» в сложных эндшпилях тренеру стоит доверять depth ≥ 18, нативному движку или tablebase-API (§6.5).
7. Stockfish 19 ввёл **строгую валидацию**: на некорректный FEN/команду движок пишет `info string CRITICAL ERROR`. В release notes сказано, что после этого процесс **завершается** — это верно для нативного бинарника. ⚠️ **WASM-сборка `stockfish-19-lite-single` из npm процесс НЕ завершает** (проверено под Node 26.7): на `position startpos moves e2e5` она печатает `info string CRITICAL ERROR: Command `` failed. Reason: Illegal move: e2e5`, продолжает отвечать на `isready`, а следующий `go` молча считает **не ту позицию** (в тесте — стартовую, вернула `bestmove e2e3`); на FEN без королей — `bestmove (none)`. Поэтому «авто-перезапуск по смерти воркера» не сработает: обёртка обязана (а) ловить строку `CRITICAL ERROR` и отклонять результат поиска (сделано в §6.3), (б) проверять легальность `bestmove` через `chess.js` перед применением, (в) иметь watchdog-таймаут на `bestmove`. Все позиции/ходы подавать только из `chess.js`.
8. Не проверены по первоисточнику: цитата сотрудника chess.com на форуме и неофициальные оценки Elo уровней lichess (§4.1, §4.3); сборка Patricia под macOS arm64; лицензия весов Maia-3 («see repo»).
9. Юридическая трактовка GPL («mere aggregation» для UCI через postMessage, §9) — общепринятая практика и соответствует GPL FAQ, но это не юридическое заключение.

---

## Источники

По состоянию на 2026-09-21 (браузерный fetch, `gh api`, `npm view`, unpkg, HTTP HEAD):

- npm: `npm view stockfish | stockfish.js | stockfish.wasm | stockfish-nnue.wasm | @lichess-org/stockfish-web | lila-stockfish-web | fairy-stockfish-nnue.wasm | @lichess-org/zerofish | zerofish | onnxruntime-web | onnxruntime-node | chess.js | chessops | chessground | @lichess-org/chessground | react-chessboard | js-chess-engine | node-uci | vite`
- https://unpkg.com/stockfish@19.0.0/?meta (список и размеры файлов), `/package.json`, `/index.js`, `/scripts/postinstall.js`, `/scripts/cli.js`; https://unpkg.com/stockfish@18.0.8/?meta
- https://github.com/nmrugg/stockfish.js (README, `examples/README.md`, `examples/loadEngine.js`, `examples/index.html`, `examples/server.js`, releases v19.0.0 / v18.0.0)
- https://github.com/lichess-org/stockfish-web (README), https://unpkg.com/@lichess-org/stockfish-web@0.5.0/ (`?meta`, `package.json`, `stockfishWeb.d.ts`, LICENSE)
- https://github.com/official-stockfish/Stockfish — релиз `sf_19` (текст и ассеты), `src/engine.cpp`, `src/search.h`, `src/search.cpp`, `src/evaluate.h`, `src/Makefile`, `README.md` (тег `sf_19`)
- https://github.com/official-stockfish/Stockfish/wiki — `UCI-Protocol-and-Stockfish-Commands`, `Stockfish-FAQ` (клон `Stockfish.wiki.git`)
- https://tests.stockfishchess.org/api/nn/nn-1a298aa575a0.nnue и `nn-61e7af4bb97d.nnue`, data.stockfishchess.org (HEAD, размеры)
- https://github.com/lichess-org/fishnet — `src/api.rs`, `src/stockfish.rs`, `src/queue.rs`, `.gitmodules`
- https://github.com/fairy-stockfish/Fairy-Stockfish — `src/ucioption.cpp`, `src/search.cpp`; https://github.com/fairy-stockfish/fairy-stockfish.wasm (README), https://unpkg.com/fairy-stockfish-nnue.wasm@1.1.12/?meta
- https://github.com/lichess-org/lila — `ui/lib/src/bot/bot.ts`, `types.ts`, `filters.ts`, `movetime.ts`, `lichessBook.ts`; `ui/lib/src/ceval/engines/stockfishWebEngine.ts`, `engines.ts`, `ui/lib/src/ceval/winningChances.ts`; `ui/lib/package.json`; `modules/tree/src/main/Advice.scala`
- https://github.com/lichess-org/scalachess — `core/src/main/scala/eval.scala`
- https://github.com/lichess-org/zerofish (README)
- https://tablebase.lichess.ovh/standard ; https://lichess.org/api/cloud-eval
- https://github.com/Adam-Kulju/Patricia (README, релиз 5.1); https://github.com/Iamsdt/chess ; https://github.com/Dash1971/maia-chess-android
- https://github.com/CSSLab/maia-chess (README, release v1.0), https://github.com/CSSLab/maia2 (README), https://github.com/CSSLab/maia3 (README, `maia3/uci.py`, LICENSE)
- https://github.com/CSSLab/maia-platform-frontend — `package.json`, дерево файлов, `public/maia-worker.js`, `src/lib/engine/maia.ts`, `src/lib/engine/tensor.ts`, `src/components/Common/PlaySetupModal.tsx`, `src/contexts/MaiaEngineContext.tsx`
- https://huggingface.co/UofTCSSLab/Maia3-5M (карточка, API-метаданные, список файлов); https://arxiv.org/abs/2605.19091 ; PyPI `maia2`
- https://support.chess.com/en/articles/8614091-how-can-i-play-against-the-chess-com-bots
- https://www.chess.com/forum/view/community/chess-com-bots-what-engine-is-it-based-on
- https://www.chess.com/terms/komodo-chess-engine
- https://lichess.org/forum/general-chess-discussion/what-elo-are-the-various-stockfish-levels (неофициальные оценки)
- https://web.dev/articles/cross-origin-isolation-guide
- https://www.gnu.org/licenses/gpl-faq.html
- Homebrew: `brew info stockfish`, `brew info lc0`
- Собственные измерения: запуск `stockfish-19-lite-single` (unpkg, sha256 js `d3344124…`, wasm `57ac2d72…`) под Node 26.7 и в Chromium; турнир 1 800 партий и два контрольных матча по 60 партий (§3.1, §5)
