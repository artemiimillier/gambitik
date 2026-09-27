# 06. Открытые датасеты и база знаний для тренера

Всё, что не помечено «(не проверено)», проверено через `curl`/`gh api`/`npm view`/WebFetch; ключевые куски кода проверены запуском (Node v26.7.0, macOS).

---

## 0. TL;DR — главные выводы

1. **Задачи**: Lichess puzzle DB — 6 100 952 задач, CC0, один файл `lichess_db_puzzle.csv.zst` (304 МБ сжатый, ~1.13 ГБ распакованный). Это наш единственный нужный источник тактики. Детский срез 30–50 тыс. задач собирается **потоково за один проход** встроенными средствами Node 26 (`node:zlib` zstd + `node:sqlite`), без единой npm-зависимости. Прототип запущен: из первых 58 771 строк отфильтровано 15 934 задачи → SQLite 4 МБ (значит 50 тыс. ≈ 13 МБ).
2. **Дебюты**: `lichess-org/chess-openings` — CC0, 3 815 именованных позиций в 5 TSV (всего ~390 КБ). Определение дебюта = идём по ходам партии, на каждом полуходе ищем EPD в `Map`, запоминаем последнее совпадение (ловит перестановки ходов). Проверено с `chess.js@1.4.0`: построение индекса ~1 с, 0 ошибок парсинга. Русских названий в датасете нет — берём 221 название из Wikidata (CC0) + ручной словарь на ~40 семейств дебютов.
3. **Важное изменение 2026 года**: Opening Explorer API (`explorer.lichess.org` / `explorer.lichess.ovh`) **с 3 марта 2026 требует OAuth-токен** (из-за DDoS), лимит 25 запросов/мин. Без токена — HTTP 401 (проверено). `cloud-eval` и `tablebase` по-прежнему работают **без авторизации** (проверено, HTTP 200).
4. **Эндшпильная истина**: `tablebase.lichess.org/standard?fen=…` (Syzygy до 7 фигур, без токена, CORS `*`). Офлайн-запасной вариант — таблицы 3-4-5 фигур, всего **0.98 ГБ** (290 файлов), подключаются к нативному Stockfish через `SyzygyPath`.
5. **Книги в общественном достоянии** есть (Capablanca, Ed. Lasker, Em. Lasker, Staunton, Nimzowitsch-1930), но для RAG «как есть» они **непригодны**: описательная нотация (`P-K4`, `Kt-KB3`, `R - R 7`), диаграммы заменены на `[Illustration]` (FEN потерян), английский язык, взрослый стиль. Русские переводы (Горфинкель, Майзелис) — **под копирайтом** (переводчики умерли в 1966/1978). Вывод: книги — сырьё для дистилляции идей в наши карточки, а не корпус для поиска.
6. **Архитектура БЗ**: не «RAG по markdown», а **вручную курируемые структурированные concept cards** (тема → объяснение для ребёнка на русском → примерные FEN → дриллы из puzzle DB) с детерминированным доступом по ключу (theme id / ECO / класс эндшпиля). Поверх — маленький FTS5-индекс для свободных вопросов ребёнка («что такое цугцванг?»). Векторный поиск не нужен: весь текстовый корпус < 1 МБ.
7. **Grounding**: LLM **не должна «читать» позицию сама**. Свежая работа (arXiv 2608.04240, август 2026): GPT-5.4 без инструментов ошибается в 22 % атомарных утверждений шахматного комментария, открытые модели — > 40 %; с инструментами (движок) фактическая точность существенно растёт. Поэтому тренеру подаётся готовый JSON «Position Facts» (движок + детерминированные детекторы + tablebase + название дебюта), а его задача — только педагогика и язык.
8. **Лицензионные ловушки**: английский исходник тем задач `translation/source/puzzleTheme.xml` (названия + описания) — **CC0 1.0** (явное исключение в `lila/COPYING.md`, строка 82), а вот русский перевод `translation/dest/puzzleTheme/ru-RU.xml` в исключениях **не** указан → по умолчанию AGPL-3.0; тексты Lichess Practice — авторские (без открытой лицензии); `chessops` — GPL-3.0; Wikibooks/Wikipedia — CC BY-SA 4.0 (share-alike). Для локального приложения «для себя» это не мешает, но при любом распространении — важно. Рекомендация: **названия тем (термины) берём, описания пишем свои**.

---

## 1. Сводная таблица источников

| # | Источник | URL | Лицензия | Размер | Формат | Как ингестим |
|---|---|---|---|---|---|---|
| 1 | Lichess puzzles | https://database.lichess.org/lichess_db_puzzle.csv.zst | **CC0** | 304 429 328 байт (.zst), ~1.13 ГБ CSV, 6 100 952 строк; обновлён 2026-09-09/10 | CSV, 11 колонок | потоковый фильтр → `data/build/puzzles.sqlite` (30–50 тыс.) |
| 2 | Lichess chess-openings | https://github.com/lichess-org/chess-openings | **CC0-1.0** | a–e.tsv = 66+77+132+69+43 КБ; 3 815 записей; 561★; push 2026-09-20 | TSV `eco name pgn` (в `dist/` ещё `uci epd`) | build-скрипт → `openings.json` (EPD → {eco,name,nameRu,ply}) |
| 3 | Названия дебютов RU | Wikidata SPARQL (`wdt:P31/wdt:P279* wd:Q103632`) | **CC0** | 221 строка = **194 уникальных сущности** (27 строк — точные дубли из-за нескольких путей `P31/P279*`; лечится `SELECT DISTINCT`), 21 КБ CSV; поле ECO (P1437) пусто во всех строках | CSV (есть поля в кавычках с запятыми → нужен настоящий CSV-парсер или `Accept: text/tab-separated-values`) | ручное сопоставление с семействами из (2) → `kb/openings/ru-names.yaml` |
| 4 | Темы задач EN + RU | `lila/translation/source/puzzleTheme.xml`, `…/dest/puzzleTheme/ru-RU.xml` | EN-исходник `source/puzzleTheme.xml` — **CC0 1.0** (исключение в COPYING.md, стр. 82); RU `dest/puzzleTheme/ru-RU.xml` в исключениях не указан → AGPL-3.0 по умолчанию | 13.9 КБ / 20.1 КБ; 76 ключей, RU-покрытие 76/76 | Android-style XML | берём **ключи и короткие названия-термины**; EN-описания (CC0) можно свободно использовать как основу; детские русские описания пишем сами |
| 5 | Lichess cloud-eval API | `GET https://lichess.org/api/cloud-eval?fen=…&multiPv=…` | API ToS Lichess; данные CC0 | ~320–410 млн позиций | JSON | опциональный кэш-ускоритель для дебютных позиций; без токена |
| 6 | Lichess tablebase API | `GET https://tablebase.lichess.org/standard?fen=…` (+`/standard/mainline`) | сервер AGPL; таблицы Syzygy свободны | ≤7 фигур (8 — частично) | JSON | «эндшпильная истина» для тренера; без токена, CORS `*` |
| 7 | Lichess opening explorer API | `https://explorer.lichess.org/{masters,lichess,player}` | — | 7.5 млрд партий, 3 млн мастерских | JSON | **нужен OAuth-токен** (с 2026-03-03), 25 req/min; кэшировать в SQLite |
| 8 | Syzygy 3-4-5 | https://tablebase.lichess.ovh/tables/standard/ (`3-4-5-wdl/`, `3-4-5-dtz/`, `download.txt`) | свободно (факты) | **0.98 ГБ**, 290 файлов (6 фигур — 160 ГБ, 7 — 18.4 ТБ: не берём) | `.rtbw/.rtbz` | офлайн-fallback: нативный Stockfish `setoption name SyzygyPath` |
| 9 | Lichess eval DB | https://database.lichess.org/lichess_db_eval.jsonl.zst | CC0 | **22.09 ГБ** .zst, 409 710 113 позиций | JSONL | **не берём** — локальный Stockfish дешевле |
| 10 | Lichess broadcasts | https://database.lichess.org/broadcast/lichess_db_broadcast_YYYY-MM.pgn.zst | **CC BY-SA 4.0** | 1 235 275 партий; месяц 10–31 МБ | PGN.zst | по желанию: свой мини-explorer/образцовые партии |
| 11 | Capablanca, *Chess Fundamentals* (1921) | https://www.gutenberg.org/ebooks/33870 | PD US; PD EU (автор †1942) | 263 КБ txt | plain text, описательная нотация | дистилляция идей → карточки (не RAG) |
| 12 | Edward Lasker, *Chess Strategy* (1915, пер. J. Du Mont) | https://www.gutenberg.org/ebooks/5614 | PD US; **в ЕС под охраной до конца 2051** (автор †1981) | 573 КБ | txt (смешанная нотация) | только как справочник идей |
| 13 | Edward Lasker, *Chess and Checkers* (1918) | https://www.gutenberg.org/ebooks/4913 | как №12 | 375 КБ | txt | то же |
| 14 | Staunton, *The Blue Book of Chess* | https://www.gutenberg.org/ebooks/16377 | PD везде (†1874) | 680 КБ | txt | низкая ценность (устаревшая теория) |
| 15 | Em. Lasker, *Common Sense in Chess* (1896) | https://archive.org/details/commonsenseinche00laskrich | PD US и EU (†1941); IA: `NOT_IN_COPYRIGHT` | 136 КБ `_djvu.txt` (OCR) | OCR-текст | дистилляция принципов дебюта/атаки |
| 16 | Nimzowitsch, *My System* (англ. пер. Ph. Hereford, 1929/1930) | https://en.wikisource.org/wiki/Author:Aron_Nimzowitsch ; https://archive.org/details/mysystemtreatise0000aron_d6y2 | PD US (опубл. до 1931); оригинал PD EU (†1935); статус **перевода** в ЕС — не проверено | — | скан/транскрипция в процессе | стратегия (уровни 4–5), только идеи |
| 17 | Philidor, *Studies of chess* | https://www.gutenberg.org/ebooks/78804 | PD | 536 КБ | txt | историческая, не нужна |
| 18 | Wikibooks *Chess* | https://en.wikibooks.org/wiki/Chess | **CC BY-SA 4.0** | 18 глав | wikitext/HTML | справочник структуры курса; share-alike |
| 19 | Wikibooks *Chess Opening Theory* | https://en.wikibooks.org/wiki/Chess_Opening_Theory | **CC BY-SA 4.0** | **2 576 страниц** без редиректов (полный подсчёт `allpages` с User-Agent и паузой 1.2 с, 7 запросов, без 429) | wikitext, путь страницы = последовательность ходов | по требованию: 30–50 страниц под детский репертуар |
| 20 | Рус. Википедия «Словарь шахматных терминов» | https://ru.wikipedia.org/wiki/Словарь_шахматных_терминов | CC BY-SA 4.0 | ~200–300 терминов | HTML | список терминов → свой детский глоссарий (определения переписываем) |
| 21 | Lichess Practice (32 раздела) | https://lichess.org/practice ; экспорт `GET /api/study/{id}.pgn` | **нет открытой лицензии**; автор — пользователь (напр. `@arex`); ToS: «You retain your rights…» | 2–10 КБ PGN на раздел | PGN с FEN/комментариями | FEN и ходы (факты) — можно; тексты комментариев — не копируем |
| 22 | Lichess Learn (`learn.xml`, ru-RU) | `lila/translation/dest/learn/ru-RU.xml` | AGPL-3.0 | 20 КБ, 172 строки | XML | нам не нужно (ребёнок уже знает ходы) |
| 23 | PGN Mentor | https://www.pgnmentor.com/files.html | «free», © 64 Squares, явной лицензии нет; тексты партий — факты | Morphy 33 КБ zip (211 партий), Capablanca 114 КБ, Tal 440 КБ | PGN **без аннотаций** | образцовые партии → аннотируем сами (движок + LLM) |
| 24 | ChessProgramming Wiki | https://www.chessprogramming.org | CC BY-SA 3.0 | — (сейчас «temporary, read-only recovery») | MediaWiki | только справка разработчику |
| 25 | lichess-puzzler (теггер тем) | https://github.com/ornicar/lichess-puzzler | AGPL-3.0, 180★, push 2026-08-07 | — | Python | референс алгоритмов определения тем (fork/pin/…) |

---

## 2. Lichess puzzle database — подробно

### 2.1. Факты (проверено)

- Страница: https://database.lichess.org/#puzzles — «6,100,952 chess puzzles, rated, and tagged», «last updated on 2026-09-10».
- `curl -sI`: `content-length: 304429328`, `last-modified: Wed, 09 Sep 2026 17:40:14 GMT`, `accept-ranges: bytes` (поддерживает Range — удобно для прототипов).
- Лицензия всей БД: *«Database exports are released under the Creative Commons CC0 license. Use them for research, commercial purpose, publication, anything you like.»*
- Заголовок CSV (в 2026 колонок **11**, добавилась `DailyDate`):

```
PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate
00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1797,76,95,10183,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#48,,
```

Семантика (из официального описания):

- `FEN` — позиция **до хода соперника**. Первый ход в `Moves` делает соперник; ребёнок играет ходы с индексами 1, 3, 5… Ходы в UCI → в SAN переводим `chess.js`.
- Все ходы решающего — «единственные»; исключение — мат в 1: засчитываем **любой** матующий ход.
- `Popularity` от −100 до 100; `NbPlays` — число решений; `RatingDeviation` — надёжность рейтинга (меньше = лучше).
- `OpeningTags` заполнены только для задач до 20-го хода; значения совпадают с именами из `chess-openings` (через `_`).
- `DailyDate` — Unix ms, если задача была «задачей дня».
- В полях нет кавычек/запятых внутри значений (проверено на 58 771 строке: ровно 11 полей в каждой, 0 символов `"`), значит хватает `line.split(',')`.
- Файл отсортирован по `PuzzleId` (ID случайные) → **любой префикс файла — примерно случайная выборка**. Для прототипа достаточно `curl -r 0-2999999` (3 МБ → 58 771 задача).
- Оценка распакованного размера: 185 байт/строка × 6.1 млн ≈ **1.13 ГБ**.
- Зеркало на Hugging Face `Lichess/chess-puzzles` (CC0): 3 parquet-шарда, 876 МБ, 6 100 960 строк; годится для прототипов через DuckDB (`read_parquet('hf://…')` с pushdown фильтров) без скачивания всего файла. Для сборки .zst (304 МБ, без зависимостей) остаётся лучше. Эндпоинт `datasets-server.huggingface.co/filter` отвечал «the dataset index is loading» (не проверено).

### 2.2. Статистика по выборке 58 771 задач (первые 3 МБ файла)

Рейтинг (шаг 200): 400–599: 2 189 · 600–799: 3 635 · 800–999: 7 570 · 1000–1199: 8 528 · 1200–1399: 7 286 · 1400–1599: 6 772 · 1600–1799: 6 309 · 1800–1999: 5 465 · 2000+: ~11 000.

Задач с рейтингом < 1000, Popularity ≥ 85, NbPlays ≥ 300: 5 695 в выборке → **~590 тыс. в полной БД**. Дефицита лёгких качественных задач нет.

Частоты тем в выборке (топ): short 29 617 · endgame 29 541 · middlegame 26 385 · crushing 22 485 · mate 18 881 · advantage 16 794 · long 15 190 · mateIn1 8 772 · mateIn2 7 915 · fork 7 495 · kingsideAttack 5 118 · sacrifice 4 404 · advancedPawn 3 607 · pin 3 562 · defensiveMove 3 531 · rookEndgame 3 222 · discoveredAttack 3 027 · opening 2 845 · quietMove 2 440 · deflection 2 439 · hangingPiece 2 128 · pawnEndgame 2 124 · attraction 2 064 · backRankMate 2 000 · mateIn3 1 867 · exposedKing 1 736 · promotion 1 388 · skewer 1 247 · discoveredCheck 1 083 · … · smotheredMate 256 · doubleCheck 320 · zugzwang 645 · trappedPiece 641 · enPassant 87 · castling 22 · underPromotion 12. Всего в выборке встретилось 73 различных темы.

### 2.3. Рецепт детского среза (30–50 тыс.)

Фильтры качества: `Popularity ≥ 85`, `NbPlays ≥ 300`, `RatingDeviation ≤ 90`, `Rating ≤ 1800` (старт; верхняя граница поднимается по мере роста ребёнка — просто пересобрать), длина `Moves ≤ 8` полуходов (≤ 4 хода ребёнка), хотя бы одна «учебная» тема.

Стратификация: лимит N задач на корзину (тема × 100-пунктовая полоса рейтинга). На выборке 58 771 с N=400 получилось 15 934 задачи. На полной БД: ~44 темы × 14 полос = ~616 корзин; **N ≈ 80 даёт 35–49 тыс. задач** (оценка; на полном файле не проверено). На срезе 58 771 строк N=80 даёт 10 977 задач (2.9 МБ), так что на полном файле сборка упрётся в потолок корзин (~44 темы × ~15 полос × 80 ≈ 50 тыс. слотов; уникальных задач меньше, т.к. одна задача закрывает несколько тем). Лимит «N на корзину» в скрипте ниже мягкий: в `puzzle_theme` вставляются **все** kid-темы взятой задачи, даже если их корзины уже полны, поэтому популярные корзины (fork, mateIn2) его превысят и итог будет ближе к верхней оценке.

Примечание о рейтингах: puzzle-рейтинг Lichess (Glicko-2) заметно выше игрового; начинающий ребёнок обычно решает в диапазоне 400–900.

### 2.4. Скрипт ингеста (запускался, работает на Node 26 без зависимостей)

```js
// scripts/kb/build-puzzles.mjs  —  node scripts/kb/build-puzzles.mjs data/raw/lichess/lichess_db_puzzle.csv.zst
import { createReadStream } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';      // встроенный zstd (есть в Node 26)
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';            // встроенный SQLite

const KID_THEMES = new Set(['mateIn1','mateIn2','mateIn3','fork','pin','skewer','hangingPiece',
  'discoveredAttack','discoveredCheck','doubleCheck','backRankMate','smotheredMate','trappedPiece',
  'deflection','attraction','capturingDefender','promotion','underPromotion','advancedPawn',
  'pawnEndgame','rookEndgame','queenEndgame','knightEndgame','bishopEndgame','opening','attackingF2F7',
  'intermezzo','zugzwang','sacrifice','defensiveMove','quietMove','xRayAttack','clearance','interference',
  'exposedKing','kingsideAttack','enPassant','castling','arabianMate','anastasiaMate','bodenMate',
  'hookMate','dovetailMate','doubleBishopMate']);
const PER_BUCKET = 80, MAX_RATING = 1800;

const db = new DatabaseSync('data/build/puzzles.sqlite');
db.exec(`
CREATE TABLE IF NOT EXISTS puzzle(
  id TEXT PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL,
  rating INT, rd INT, popularity INT, plays INT,
  themes TEXT, game_url TEXT, opening_tags TEXT);
CREATE TABLE IF NOT EXISTS puzzle_theme(
  theme TEXT NOT NULL, rating INT NOT NULL, puzzle_id TEXT NOT NULL,
  PRIMARY KEY(theme, rating, puzzle_id)) WITHOUT ROWID;   -- выборка «тема + окно рейтинга» по индексу
`);
const insP = db.prepare('INSERT OR IGNORE INTO puzzle VALUES (?,?,?,?,?,?,?,?,?,?)');
const insT = db.prepare('INSERT OR IGNORE INTO puzzle_theme VALUES (?,?,?)');
const bucket = new Map();
const rl = createInterface({ input: createReadStream(process.argv[2]).pipe(createZstdDecompress()), crlfDelay: Infinity });

let n = 0, kept = 0;
db.exec('BEGIN');
for await (const line of rl) {
  if (n++ === 0) continue;                                  // заголовок
  const [id, fen, moves, rating, rd, pop, plays, themes, url, otags] = line.split(',');
  const R = +rating;
  if (R > MAX_RATING || +rd > 90 || +pop < 85 || +plays < 300) continue;
  if (moves.split(' ').length > 8) continue;
  const th = themes.split(' ').filter(t => KID_THEMES.has(t));
  if (!th.length) continue;
  let take = false;
  for (const t of th) { const k = `${t}:${Math.floor(R / 100)}`; const c = bucket.get(k) ?? 0;
    if (c < PER_BUCKET) { bucket.set(k, c + 1); take = true; } }
  if (!take) continue;
  insP.run(id, fen, moves, R, +rd, +pop, +plays, themes, url, otags);
  for (const t of th) insT.run(t, R, id);
  kept++;
}
db.exec('COMMIT');
console.log({ scanned: n - 1, kept });
```

Результат тестового прогона (на перепакованной выборке, N=400): `{ total: 58772, kept: 15934 }`, файл SQLite 4.0 МБ (4 059 136 байт), без предупреждений Experimental в Node 26.7; по темам: mateIn2 2 958 · fork 2 852 · mateIn1 2 358 · pin 1 339 · discoveredAttack 1 268 · deflection 991 · rookEndgame 940 · mateIn3 845.

Нюанс: на **обрезанном** .zst (кусок через Range) `createZstdDecompress()` в потоковом режиме отдаёт распакованные чанки и только в конце бросает `Z_BUF_ERROR` (обрезка до 1 МБ → 2.75 МБ данных, затем ошибка); CLI `zstd -dc` отдаёт всё, что успел, без исключения. То есть `for await (const line of rl)` упадёт исключением в конце → на полном файле проблемы нет, а при докачке/обрыве нужен `try/catch` + проверка размера. Для прототипов: `curl -r … | zstd -dc 2>/dev/null > sample.csv`.

Запрос «дай задачу» для тренера:

```sql
SELECT p.* FROM puzzle_theme t JOIN puzzle p ON p.id = t.puzzle_id
WHERE t.theme = :theme AND t.rating BETWEEN :elo - 100 AND :elo + 100
  AND p.id NOT IN (SELECT puzzle_id FROM attempt WHERE child_id = :child)
ORDER BY random() LIMIT 1;
```

Альтернатива онлайн: `GET /api/puzzle/daily`, `/api/puzzle/{id}`, `/api/puzzle/next`, `/api/puzzle/batch/{angle}` (есть в спецификации API v2.0.174; `daily` проверен, 200). Нам не нужно: офлайн-БД надёжнее и без лимитов.

### 2.5. Таксономия тем с русскими названиями

Источник: `translation/source/puzzleTheme.xml` (EN) и `translation/dest/puzzleTheme/ru-RU.xml` (RU) из `lichess-org/lila` (переводы приходят из Crowdin-проекта Lichess; в репозитории — 76 ключей-названий + 76 описаний, русское покрытие 100 %). Из 76 ключей 4 служебные (`mix`, `playerGames`, `puzzleDownloadInformation`, `promotePawnToQueenRookOrMinor`) → 72 темы с названиями + тема `enPassant`, у которой в этом файле есть только описание (`enPassantAdjacentCaptureDescription`), а название лежит в другом файле переводов → итого **73 темы**, что точно совпадает с числом различных тем в CSV-выборке (сверено скриптом: в CSV нет ни одной темы вне этого списка).

| Ключ | EN | RU (Lichess) | Уровень курса* |
|---|---|---|---|
| mateIn1 | Mate in 1 | Мат в 1 ход | 1 |
| hangingPiece | Hanging piece | Незащищённая фигура | 1 |
| oneMove | One-move puzzle | Одноходовая задача | 1 |
| backRankMate | Back rank mate | Мат на последней горизонтали | 1–2 |
| fork | Fork | Вилка | 1–2 |
| mateIn2 | Mate in 2 | Мат в два хода | 2 |
| pin | Pin | Связка | 2 |
| skewer | Skewer | Линейный удар | 2 |
| discoveredAttack | Discovered attack | Вскрытое нападение | 2 |
| discoveredCheck | Discovered check | Вскрытый шах | 2 |
| doubleCheck | Double check | Двойной шах | 2 |
| promotion | Promotion | Превращение | 2 |
| capturingDefender | Capture the defender | Уничтожение защитника | 2–3 |
| attackingF2F7 | Attacking f2 or f7 | Атака f2 или f7 | 2–3 |
| opening | Opening | Дебют | 2–3 |
| castling | Castling | Рокировка | 2 |
| enPassant | En passant | Взятие на проходе (название не из `puzzleTheme.xml`, общеупотребимый термин) | 2 |
| deflection | Deflection | Отвлечение | 3 |
| attraction | Attraction | Завлечение | 3 |
| trappedPiece | Trapped piece | Ловля фигуры | 3 |
| intermezzo | Intermezzo | Промежуточный ход | 3 |
| smotheredMate | Smothered mate | Спёртый мат | 3 |
| exposedKing | Exposed king | Открытый король | 3 |
| kingsideAttack / queensideAttack | Kingside / Queenside attack | Атака на королевском / ферзевом фланге | 3–4 |
| advancedPawn | Advanced pawn | Продвинутая пешка | 3 |
| pawnEndgame | Pawn endgame | Пешечный эндшпиль | 3 |
| rookEndgame | Rook endgame | Ладейный эндшпиль | 3–4 |
| mateIn3 | Mate in 3 | Мат в 3 хода | 3–4 |
| sacrifice | Sacrifice | Жертва | 4 |
| clearance | Clearance | Освобождение линии или поля | 4 |
| interference | Interference | Перекрытие | 4 |
| xRayAttack | X-Ray attack | Рентген | 4 |
| quietMove | Quiet move | Тихий ход | 4 |
| defensiveMove | Defensive move | Защитный ход | 4 |
| zugzwang | Zugzwang | Цугцванг | 4 |
| underPromotion | Underpromotion | Слабое превращение | 4 |
| bishopEndgame / knightEndgame / queenEndgame / queenRookEndgame | … endgame | Слоновый / Коневой / Ферзевый / Ферзево-ладейный эндшпиль | 4 |
| mateIn4, mateIn5 | Mate in 4 / 5+ | Мат в 4 хода / в 5 или более | 5 |
| collinearMove | Collinear move | Коллинеарный ход | 5 |
| Именные маты: anastasiaMate, arabianMate, bodenMate, doubleBishopMate, dovetailMate, swallowstailMate, hookMate, epauletteMate, operaMate, pillsburysMate, morphysMate, cornerMate, triangleMate, vukovicMate, killBoxMate, balestraMate, blindSwineMate | | Мат Анастасии, Арабский мат, Мат Бодена, Мат двумя слонами, «Ласточкин хвост», Хук-мат, Эполетный мат, Оперный мат, Мат Пиллсбери, Мат Морфи, Угловой мат, Треугольный мат, Мат Вуковича, «Смертельная коробка», Мат Балестра, Мат двумя ладьями по предпоследней горизонтали | 3–4 (коллекция «матовые картинки») |
| Мета-теги (не темы обучения): short, long, veryLong, crushing, advantage, equality, mate, middlegame, endgame, master, masterVsMaster, superGM | | Двухходовая / Трёхходовая / Многоходовая задача, Разгром, Преимущество, Уравнение, Мат, Миттельшпиль, Эндшпиль, Партии мастеров… | используются как фильтры |

\* «Уровень курса» — проектное распределение тем на 5 ступеней (не из Lichess) (1 ≈ puzzle-рейтинг 400–800, 2 ≈ 800–1100, 3 ≈ 1100–1400, 4 ≈ 1400–1700, 5 ≈ 1700+).

Лицензионная оговорка: английский исходник `translation/source/puzzleTheme.xml` целиком (названия **и описания**) — **CC0 1.0**, это явная строка в таблице исключений `lila/COPYING.md` («translation/source/puzzleTheme.xml | the lila authors and contributors | CC0 1.0»); на него же ссылается database.lichess.org как на «list of themes, their names and descriptions». Русский файл `dest/puzzleTheme/ru-RU.xml` в исключениях не назван → формально остаётся под AGPL-3.0 (лицензия Crowdin-переводов отдельно нигде не оговорена — не проверено). Сами термины («вилка», «связка», «спёртый мат») — общеупотребимая шахматная лексика, копирайтом не охраняются. **Русские описания** тем из `ru-RU.xml` — часть AGPL-проекта; к тому же они взрослые («…от 200 до 600 сантипешек»). Для ребёнка пишем свои 1–2 предложения на тему.

---

## 3. Дебюты: `lichess-org/chess-openings`

### 3.1. Факты

- `gh api repos/lichess-org/chess-openings`: license **CC0-1.0**, 561★, последний push 2026-09-20 (живой).
- Исходники: `a.tsv`…`e.tsv` (по томам ECO), колонки `eco`, `name`, `pgn`. Всего 3 815 строк данных (818+773+1251+615+363 с заголовками).
- `make` (нужен `pip3 install chess`) генерирует `dist/` с дополнительными колонками `uci` и `epd`. Готовый `dist` есть как артефакт GitHub Actions (`chess-openings`, 238 КБ, 2026-09-20) — но артефакты требуют авторизации и протухают; нам проще посчитать EPD самим (см. ниже).
- README: рекомендуемый способ классификации — идти по партии и искать именованную позицию по EPD; одна и та же позиция-имя может иметь несколько записей (перестановки).

### 3.2. Определение дебюта по ходам (запускалось)

```js
// scripts/kb/build-openings.mjs + runtime detect
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';                       // chess.js@1.4.0, BSD-2-Clause
const epd = fen => fen.split(' ').slice(0, 4).join(' ');  // доска + очередь + рокировки + e.p.

const book = new Map();
for (const f of ['a','b','c','d','e'])
  for (const line of readFileSync(`data/raw/chess-openings/${f}.tsv`, 'utf8').split('\n').slice(1)) {
    if (!line) continue;
    const [eco, name, pgn] = line.split('\t');
    const g = new Chess(); g.loadPgn(pgn);
    book.set(epd(g.fen()), { eco, name, ply: g.history().length });
  }

export function detectOpening(sanMoves) {
  const g = new Chess(); let last = null;
  for (const san of sanMoves.slice(0, 40)) {             // дальше 20-го хода имён практически нет
    g.move(san);
    const hit = book.get(epd(g.fen()));
    if (hit) last = hit;                                 // самое глубокое совпадение
  }
  return last;
}
```

Результат прогона: `{ entries: 3815, unique: 3815, bad: 0, ms: 950 }` (повторный прогон: те же 3815/3815/0 за 1 745 мс — время заметно плавает, ещё один довод строить индекс на build-этапе);

- `e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4` → `C54 Italian Game: Classical Variation, Center Attack`
- `Nf3 d5 d4 Nf6 c4 e6 Nc3` (перестановка ходов) → `D37 Queen's Gambit Declined: Three Knights Variation` — транспозиции ловятся.
- `… Najdorf` → `B90 Sicilian Defense: Najdorf Variation`.

Индекс строим один раз на build-этапе и сохраняем `data/build/openings.json` (EPD → запись), чтобы не тратить 1 с при старте. Важно: EPD в книге и в рантайме считать **одной и той же библиотекой** (обработка поля en passant у библиотек различается; `chess.js` пишет e.p.-поле только при реально возможном взятии, как python-chess в `dist/`).

Готовые npm-альтернативы (не обязательны): `@chess-openings/eco.json@2.2.2` (MIT, обновлён 2026-07), `chess-openings@0.1.1` (WTFPL). `chessops@0.15.1` — отличная библиотека Lichess, но **GPL-3.0-or-later**; для закрытого/неопределённого лицензирования приложения безопаснее `chess.js` (BSD-2; последний релиз 2025-06-14 — стабильна, обновляется редко). Скоупа `@lichess-org/chessops` на npm нет (404). Довод «избегать chessops из-за GPL» имеет смысл, только если и UI-доска не GPL: при выборе `@lichess-org/chessground` (GPL-3.0-or-later, см. `01-board-ui.md`) фронтенд и так окажется под GPL при распространении. Для локального приложения без распространения GPL/AGPL обязательств не накладывают.

Зеркало `Lichess/chess-openings` на Hugging Face содержит готовые колонки `uci` и `epd`, но отстаёт от GitHub (3 704 строки против 3 815, lastModified 2026-05-20; 226 МБ из-за встроенных картинок) → не использовать, EPD считать самим.

### 3.3. Русские названия дебютов

В датасете Lichess имена только английские (Lichess их не переводит). Источники RU:

1. **Wikidata (CC0)** — запрос ниже вернул 221 строку = **194 уникальных дебюта** с русской меткой (27 строк — точные дубли из-за нескольких путей `P31/P279*`, нужен `SELECT DISTINCT`) (Итальянская партия, Сицилианская защита, Защита Каро — Канн, Вариант Найдорфа, Атака Фегателло, Ферзевый гамбит…). Свойство ECO (P1437) в выдаче **пусто во всех строках** → сопоставление только по английскому имени, вручную. Английские метки Wikidata не совпадают с именами Lichess (`Sicilian Defence, Najdorf Variation` против `Sicilian Defense: Najdorf Variation`; встречаются опечатки вроде «Sveshnikov Variiant») и содержат запятые → CSV с кавычками, `split(',')` не годится.
2. **Ручной словарь семейств** (до двоеточия в имени Lichess: `Italian Game`, `Sicilian Defense`, …). Для детского тренера реально нужны ~40 семейств + 20–30 вариантов с «детскими» именами (Детский мат, Атака Фегателло/«жареная печень», Гамбит Эванса, Ловушка Легаля…). Остальное тренер произносит как «редкий дебют, по-английски он называется …».

Формат: `kb/openings/ru-names.yaml` — `{"Italian Game": "Итальянская партия", "Italian Game: Evans Gambit": "Гамбит Эванса", …}`; поиск: точное имя → семейство → fallback EN.

---

## 4. API Lichess в 2026 году: explorer / cloud-eval / tablebase

Источник истины: OpenAPI-спецификация `lichess-org/api` (версия **2.0.174**), плюс живые запросы.

| API | Endpoint | Авторизация (2026) | Лимиты | Живой тест |
|---|---|---|---|---|
| Cloud eval | `GET https://lichess.org/api/cloud-eval?fen=<X-FEN>&multiPv=1..5&variant=` | `security: []` — **не нужна** | общие правила: «only make one request at a time», при 429 ждать минуту | 200; стартовая позиция: depth 75, 2 PV (e2e4 +19, d2d4 +15); 404 — если позиции нет в кэше |
| Tablebase | `GET https://tablebase.lichess.org/standard?fen=<FEN, можно с _>&dtc=`; `GET …/standard/mainline?fen=` | `security: []` — **не нужна** | явно не документированы; ответ кэшируемый (`cache-control: max-age=1209600`), CORS `*` | 200 на обоих хостах (`.org` и `.ovh`); поля `category` (win / loss / draw / cursed-win / blessed-loss …), `dtz`, `precise_dtz`, `dtm`, `dtc`, по каждому ходу `san/uci/category`; частичные 8-фигурные таблицы (Op1) — по README `lila-tablebase` |
| Opening explorer | `GET https://explorer.lichess.org/masters?play=e2e4,e7e5&moves=12&topGames=15&since=&until=`; `/lichess?variant=&speeds=&ratings=&fen=&play=`; `/player`; `/masters/pgn/{gameId}` | `security: - OAuth2: []` — **нужен токен** | **25 запросов/мин** на пользователя; глубина до 50 полуходов | **401 Authorization Required** без токена (и `.org`, и `.ovh`) |

Что произошло с explorer: пост Thibault Duplessis от **3 марта 2026** «The opening explorer now requires authentication»: несколько недель DDoS с миллионов резидентных IP; каждый запрос читает терабайтный датасет; решение — запретить анонимные запросы и перенести rate-limit на уровень аккаунтов Lichess. Цитата: *«you can send 25 requests per minute»*; максимальная глубина остаётся 50 полуходов. Остаётся бесплатным. Подтверждение в issue `lichess-org/api#619` (комментарий ornicar 2026-03-03: OAuth-запросы работают). Работа запроса **с токеном** не проверена (нужен аккаунт Lichess), но подтверждена двумя первичными источниками.

Что это значит для нас:

- Токен — personal access token **без scopes** (`https://lichess.org/account/oauth/token`), создаётся вручную (родителем/оператором установки); хранится в `.env` на локальном сервере, в браузер не отдаётся. Заголовок: `Authorization: Bearer <token>`.
- Explorer нужен только для фичи «как здесь играют мастера / люди твоего уровня» — это nice-to-have. Ответы кэшировать в SQLite по ключу EPD (дебютные позиции повторяются) — тогда 25 req/min хватит с огромным запасом.
- Если заводить аккаунт Lichess не хочется: собрать мини-explorer офлайн из Lichess broadcasts (CC BY-SA 4.0) или PGN Mentor — несколько сот тысяч мастерских партий, дерево до 12–15 хода.
- `cloud-eval` — не замена локальному Stockfish (404 на большинстве миттельшпильных позиций), а ускоритель в дебюте. Blunder-check **обязан** работать локально, иначе take-back будет зависеть от сети.
- `tablebase` — главный источник истины в эндшпиле ≤ 7 фигур: тренер может честно сказать «здесь ничья при правильной игре» или «выигрывает только Крf6». `mainline` даёт идеальную линию для демонстрации.

### 4.1. Офлайн Syzygy

`https://tablebase.lichess.ovh/tables/standard/` содержит каталоги `3-4-5-wdl/`, `3-4-5-dtz/`, `6-*`, `7/`, файл `download.txt` (полный список URL) и `bytes.tsv`. Посчитано по `bytes.tsv`: 3-4-5 фигур — 290 файлов, **0.98 ГБ** (983 957 920 байт = 0.92 ГиБ); 6 фигур — 730 файлов, 160 ГБ; 7 — 2 002 файла, 18.4 ТБ. Берём только 3-4-5: покрывает все «детские» эндшпили (К+п против К, Л+п против Л, Ф против п на 7-й…). Использование: нативный Stockfish (`brew install stockfish`) → `setoption name SyzygyPath value data/raw/syzygy/3-4-5`. WASM-сборки Stockfish в браузере Syzygy не поддерживают (не проверено; см. отчёт по движкам).

---

## 5. Книги: реальный статус общественного достояния

Правило США на 2026 год: всё, **опубликованное до 1 января 1931**, — public domain (подтверждено формулировкой Wikisource на странице автора Nimzowitsch). ЕС и Россия: жизнь автора + 70 лет (для перевода — отдельно жизнь **переводчика** + 70).

| Книга | Автор (годы) | Год | США | ЕС / РФ (оригинал) | Где лежит | Примечание |
|---|---|---|---|---|---|---|
| Chess Fundamentals | J. R. Capablanca (1888–1942) | 1921 | PD | PD с 2013 | Gutenberg #33870, 263 КБ (проверено 200) | лучший по структуре первоисточник: простые маты, пешечные окончания, принципы |
| Common Sense in Chess | Emanuel Lasker (1868–1941) | 1896 | PD | PD с 2012 | archive.org `commonsenseinche00laskrich`, OCR 136 КБ (`NOT_IN_COPYRIGHT`); на Gutenberg **нет** | 12 лекций: принципы дебюта, атака, защита, эндшпиль |
| Chess Strategy | Edward Lasker (1885–1981), пер. J. Du Mont | 1915 | PD | **охраняется до конца 2051** | Gutenberg #5614, 573 КБ | в ЕС/РФ распространять текст нельзя; идеи — можно |
| Chess and Checkers: the Way to Mastership | Edward Lasker | 1918 | PD | охраняется до 2051 | Gutenberg #4913, 375 КБ | то же |
| The Blue Book of Chess | H. Staunton (1810–1874) | XIX в. | PD | PD | Gutenberg #16377, 680 КБ | устаревшая дебютная теория; ценность низкая |
| Chess Generalship, vol. I | F. K. Young (1857–1931) | 1910 | PD | PD с 2002 | Gutenberg #55278, 282 КБ | псевдовоенная терминология, для детей бесполезна |
| My System (англ. пер. Philip Hereford = A. H. W. George) | A. Nimzowitsch (1886–1935) | UK 1929 / US 1930 | PD (до 1931) | оригинал PD с 2006; **перевод — не проверено** (год смерти переводчика не найден) | Wikisource (транскрипция в процессе), archive.org (сканы 1930) | стратегия для уровней 4–5 |
| Studies of chess | Philidor | XVIII в. | PD | PD | Gutenberg #78804 | историческая |

Русские переводы:

- Капабланка, «Основы шахматной игры» (Пг., 1924; 6-е изд. 1928) — перевод **Д. М. (Даниила Михайловича) Горфинкеля (1889–1966)** → перевод охраняется в РФ **минимум до конца 2036 г., а вероятнее до конца 2040 г.**: ст. 1281 п. 5 ГК РФ добавляет 4 года авторам, работавшим во время Великой Отечественной войны (Горфинкель жил и работал в 1941–1945 гг., так что надбавка, скорее всего, применима; документально для него не проверено; источник — ст. 1281 ГК РФ, consultant.ru). Скан 1924 г. есть в НЭБ (rusneb.ru), но свободной лицензии это не даёт.
- Нимцович, «Моя система» — классический русский перевод И. Л. Майзелиса (28.12.1894 – 23.12.1978, по en.wikipedia) → охраняется до конца 2048 (с учётом +4 лет по ст. 1281 п. 5 — вероятно до конца 2052; применимость к нему документально не проверена).
- Капабланка, «Учебник шахматной игры» (A Primer of Chess, 1935) — в США под охраной до 2031, русский перевод тоже.
- Свободных русских текстов сопоставимого качества не найдено. На ru.wikibooks шахматного учебника нет (API вернул 0 страниц с префиксом «Шахмат»). Формально свободный русский учебник существует — **Э. С. Шифферс (1850–1904), «Самоучитель шахматной игры»** (автор умер в 1904 → PD в РФ; скан 4-го изд. на archive.org `20200716_shiffers_chess` с меткой Public Domain Mark; издание 1926 г. в НЭБ переработано В. И. Ненароковым, †1953 — его правка может ещё охраняться). Практическая ценность низкая: дореформенная орфография, только скан (чистого текста нет), устаревшая теория, взрослый стиль. На вывод раздела не влияет.

**Практические проблемы PD-текстов** (проверено на скачанных файлах):

1. Описательная нотация: Capablanca — `1 R - R 7, K - Kt 1; 2 K - Kt 2` (в `pg33870.txt`); Ed. Lasker — смесь `P-K4` / `Kt-KB3` и ранней алгебраической `Ktf6`, `e2-e4`. LLM такие записи «переводит» с ошибками; нужен детерминированный конвертер + проверка легальности, а для него нужна исходная позиция…
2. …которой нет: диаграммы в txt заменены на `[Illustration]` (в `pg33870.txt` 151 такой маркер). FEN придётся восстанавливать вручную (у Капабланки ~150 диаграмм; для наших целей нужно 30–40 ключевых — и все они есть как стандартные учебные позиции, проверяемые tablebase).
3. Язык и стиль — взрослый английский 1920-х.

**Вывод**: PD-книги используем как *источник структуры и идей* при написании карточек (с полем `provenance` в карточке: «идея: Capablanca 1921, гл. I §3»), но **не** загружаем сырой текст в контекст тренера и не строим по нему RAG.

---

## 6. Прочие текстовые источники

- **Wikibooks Chess** (CC BY-SA 4.0): 18 глав — Introduction, Arranging The Board, Playing The Game, Notating The Game, Tactics, Tactics Exercises, Checkmates, Strategy, Basic Openings, Sample chess game, The Endgame/KQ vs K, Variants, Tournaments, Famous Games, Puzzles, Computer Chess, Optional homework, Tempo. Годится как чек-лист полноты курса.
- **Wikibooks Chess Opening Theory** (CC BY-SA 4.0): URL страницы = последовательность ходов (`/1._e4/1...e5/2._Nf3/2...Nc6/3._Bc4`), 2 576 страниц без редиректов. Страница «Итальянская партия»: ~2 000 слов, 3 диаграммы, «Theory table», объяснение идей («White develops the bishop to a good square…»). Это лучший открытый источник *словесных идей дебютов*. Ингест: точечно, 30–50 страниц детского репертуара через `action=parse&prop=wikitext`, с паузами. **Внимание**: API Wikimedia отвечает HTTP 429 после ~10 быстрых запросов без `User-Agent`; с осмысленным `User-Agent` и паузой ~1 с (плюс кэш) 429 не возникает. Share-alike: производные тексты (наши пересказы близко к тексту) тоже CC BY-SA → храним отдельно в `kb/sources/wikibooks/` с атрибуцией.
- **Русская Википедия «Словарь шахматных терминов»** (CC BY-SA 4.0): ~200–300 терминов с краткими определениями (Аванпост, Вилка, Зевок, Цугцванг…). Используем как *список терминов*; определения для ребёнка пишем заново.
- **Lichess Practice**: 32 раздела (Piece Checkmates I/II, Checkmate Patterns I–IV, Knight & Bishop mate, The Pin, The Skewer, The Fork, Discovered Attacks, Double Check, Overloaded Pieces, Zwischenzug, X-Ray, Zugzwang, Interference, Greek Gift, Deflection, Attraction, Underpromotion, Desperado, Counter Check, Undermining, Clearance, Key Squares, Opposition, 7th-rank rook pawn, Basic/Intermediate/Practical Rook Endings). Экспорт работает без токена: `GET https://lichess.org/api/study/BJy6fEDf.pgn` → 200, 2.8 КБ, 6 глав с `[FEN]`, `[Annotator "https://lichess.org/@/arex"]`. Лицензии на тексты нет; ToS Lichess: пользователь сохраняет права на свой контент. Позиции (FEN) и ходы — факты, их можно использовать как упражнения «доиграй против движка»; текстовые комментарии не копируем. Отличная *структура* для нашего раздела «техника».
- **Lichess Learn** (`learn.xml`, 172 строки, ru-RU есть) — про ходы фигур; ребёнок это уже знает. AGPL.
- **ChessProgramming Wiki** — CC BY-SA 3.0; сайт сейчас в режиме «temporary, read-only recovery». Для БЗ тренера не нужен; полезен разработчику (SEE, определение связок, оценочные признаки).
- **lichess-puzzler** (AGPL-3.0) — `tagger/cook.py` содержит эталонные эвристики определения тем (fork, pin, skewer, deflection, hangingPiece…). Полезен как референс для наших детекторов «фактов позиции»; код не копировать дословно, если приложение не AGPL.

### 6.1. Коллекции партий

| Источник | Аннотации | Лицензия | Применение |
|---|---|---|---|
| PGN Mentor (players/*.zip) | **нет** (проверено: Morphy.pgn — 211 партий, 0 комментариев) | «free», без явной лицензии; запись ходов — факт | 30–50 образцовых партий (Морфи, Капабланка, Таль…) → аннотируем сами |
| Lichess broadcasts | нет (иногда часы/оценки) | CC BY-SA 4.0 | современные партии, мини-explorer |
| Lichess studies export (`/api/study/{id}.pgn`, `/api/study/by/{user}/export.pgn`) | да, авторские | права у авторов | только собственные студии ребёнка/родителя/тренера |
| Lichess Elite Database (database.nikonoel.fr) | нет | партии 2500+ из CC0-дампов Lichess; явной лицензии на сборку нет, последнее обновление — ноябрь 2025 | офлайн-замена explorer, но не лучше broadcasts |
| Wikibooks «Famous Games», Wikipedia (Opera Game, Immortal Game…) | краткие | CC BY-SA 4.0 | идеи для аннотаций |
| Gutenberg (Capablanca — 14 партий, Ed. Lasker) | да, PD US | см. §5 | описательная нотация → конвертировать вручную |

Рекомендация: **«Золотая коллекция» из 30–50 партий**, аннотации генерируем конвейером «Stockfish → факты по ходам → LLM пишет детский комментарий → человек читает», сохраняем в `kb/model-games/*.pgn` (комментарии в `{}` на русском). Первая партия — Морфи против герцога и графа (Париж, 1858; есть в Morphy.pgn, ECO C41).

---

## 7. Детский глоссарий на русском

Готового открытого детского глоссария нет. План: `kb/glossary/ru.yaml`, ~150 терминов, три слоя:

1. Термины-темы (72 шт.) — ключи Lichess + русское название (§2.5).
2. Общая лексика (список из рус. Википедии): дебют, миттельшпиль, эндшпиль, темп, развитие, центр, открытая линия, форпост, проходная пешка, оппозиция, цугцванг, зевок, размен, качество, инициатива, гамбит, фианкетто…
3. «Детские» синонимы и произносительные подсказки для голосовой модели.

```yaml
- id: fork
  term: вилка
  aliases: [двойной удар, вилочка]
  kid: "Одна фигура нападает сразу на две. Обе убежать не успеют!"
  say: "вИлка"                 # ударение для TTS/realtime-модели
  piece_names: {N: конь, B: слон, R: ладья, Q: ферзь, K: король, P: пешка}
  lichess_theme: fork
  see: [knight-fork, royal-fork]
```

Отдельно нужен файл произношения нотации: «Кf3» → «конь эф три», «O-O» → «короткая рокировка», «exd5» → «е бьёт дэ пять» — иначе голосовая модель будет читать SAN как попало. Это детерминированная функция `sanToSpeechRu(san)`, не LLM.

---

## 8. Архитектура базы знаний

### 8.1. RAG по markdown vs. concept cards

| Критерий | RAG (чанки + эмбеддинги) по книгам/вики | Курируемые concept cards (структурированные) |
|---|---|---|
| Ключ поиска | текст запроса → похожие чанки | **детерминированный**: `theme`, `ECO/семейство`, `класс эндшпиля`, `тип ошибки` — всё это выдаёт код, не LLM |
| Соответствие позиции | слабое: эмбеддинги не «видят» доску, FEN в тексте нет | карточка привязана к темам задач и детекторам фактов |
| Качество для ребёнка | взрослый английский 1920-х, описательная нотация | русский, 1–3 коротких предложения, метафоры, заранее вычитано родителем |
| Проверяемость | чанки не проверить движком | каждый FEN/решение в карточке **валидируется Stockfish в CI** |
| Лицензии | смешение PD / CC BY-SA / AGPL в одном индексе | у каждой карточки `provenance` + `license` |
| Задержка в голосе | embed + поиск + длинный контекст (сотни мс, много токенов) | чтение файла по id (< 1 мс), 150–400 токенов |
| Объём | десятки МБ | ~120–150 карточек × 1–2 КБ ≈ 0.3 МБ — индекс тем помещается в system prompt |
| Стоимость создания | низкая | средняя: черновики пакетно генерирует LLM, человек вычитывает |
| Риск галлюцинаций | высокий (чанк «про похожее») | низкий |

**Решение**: concept cards — основа. RAG в классическом виде не нужен. Для свободных вопросов («а что такое оппозиция?») — SQLite **FTS5** (встроен в `node:sqlite`) по полям `term/aliases/kid` глоссария и карточек + таблица алиасов с падежными формами («вилку», «вилкой»). Если позже захочется семантики — `sqlite-vec@0.1.9` (MIT/Apache) поверх тех же карточек, но при < 1 МБ текста это излишне.

Проверено запуском (Node 26.7.0, встроенный SQLite 3.53.4, FTS5 доступен в `node:sqlite` без флагов): токенизатор `unicode61` приводит кириллицу к нижнему регистру (`вилка` находит «Вилка»), но **стемминга нет** (`ВИЛКУ` → 0 совпадений) и **`ё` ≠ `е`** (`спертый` не находит «Спёртый мат»). Значит, обязательны: (а) нормализация `ё→е` и в индексе, и в запросе (распознавание речи почти всегда отдаёт «е»); (б) префиксные запросы по усечённой основе (`вилк*`, `цугцванг*` — работают) и/или таблица алиасов с падежами; (в) в идеале realtime-модель сама приводит термин к именительному падежу перед вызовом `lookup_term`, а при ~150 терминах список id можно отдать модели прямо в описании инструмента (enum) — тогда FTS5 остаётся лишь страховкой.

### 8.2. Формат карточки

```markdown
---
id: tactics/fork/knight-fork
title: Коневая вилка
level: 2                      # ступень курса 1..5
prerequisites: [tactics/hanging-piece, basics/piece-values]
lichess_themes: [fork]
detector: fork                # какой детектор «фактов позиции» вызывает эту карточку
drill:                        # запрос к puzzles.sqlite
  themes: [fork]
  rating: [700, 1200]
  extra_sql: "moves LIKE '% %' AND themes NOT LIKE '%veryLong%'"
examples:                     # каждое поле проверяется в CI: FEN легален, best == bestmove Stockfish
  - fen: "r1bqkb1r/pppp1ppp/2n5/4p2n/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1"
    best: "Nxe5"
    idea: "Конь бьёт пешку и открывает нападение ферзя на коня h5"
provenance: ["собственный текст", "идея примера: Capablanca 1921, ch. I"]
license: own
reviewed_by: parent           # карточка не попадает к тренеру, пока не вычитана
---
## Коротко (говорит тренер)
Конь прыгает так, что нападает сразу на две фигуры. Обе спасти нельзя!

## Как искать
1. Найди короля и ферзя соперника. 2. Есть ли поле, с которого конь бьёт обоих? 3. Это поле защищено?

## Частая ошибка
Вилка есть, но поле под боем пешки — сначала проверь, не съедят ли коня.

## Фразы тренера
- hint1: "Посмотри на своего коня. Куда он может прыгнуть с шахом?"
- hint2: "С какого поля конь нападает и на короля, и на ладью?"
- praise: "Вот это вилка! Две фигуры на одной вилке."
```

Примечание: пример FEN выше — иллюстрация формата, **не проверен движком**, и тематически он карточке не подходит: `Nxe5` с раскрытием ферзя на коня h5 — это **вскрытое нападение**, а не коневая вилка; `cloud-eval` на эту позицию отвечает 404. При наполнении БЗ этот пример заменить. Именно поэтому нужен `validate-cards.mjs` (chess.js: легальность; Stockfish: `best` совпадает с bestmove на depth ≥ 18 или даёт ≥ X win%).

### 8.3. Почему LLM нельзя «читать» позицию самой

- **arXiv 2608.04240** (Hebbar, Sheng, Oh, Viswanath; 4 авг 2026) «Hallucinations on the Board»: комментарий раскладывается на атомарные утверждения и проверяется инструментами; *GPT-5.4 без инструментов — 22.0 % неверных утверждений, небольшие открытые модели — > 40 %*; tool-augmentation существенно повышает фактическую корректность и оценку качества хода, но покрытие экспертных идей остаётся ограниченным.
- **Kim et al., NAACL 2025** (arXiv 2410.20811) «Concept-guided Chess Commentary»: движок даёт решение, извлечённые *концепты* с приоритетами направляют LLM, LLM отвечает только за язык; чтобы модель не выдумывала фигуры и ходы, ей перечисляют реальные атаки/угрозы. Это ровно наша схема «facts JSON + concept card».
- **Kaggle Game Arena / LLM Chess leaderboard / эксперимент M. Acher с GPT-5**: универсальные LLM до сих пор делают нелегальные ходы в текстовых шахматах, играют на уровне любителя. Вывод: ни выбор хода, ни проверку зевка, ни утверждения «здесь висит слон» доверять LLM нельзя.
- Для ребёнка цена ошибки выше, чем для взрослого: он не может распознать уверенную неправду и заучит её.

### 8.4. «Position Facts» — контракт между кодом и тренером

Всё, что тренер говорит о доске, должно присутствовать в этом JSON (собирается локальным сервером за 100–300 мс **до** ответа бота):

```jsonc
{
  "fen": "...", "sideToMove": "black", "moveNumber": 9,
  "opening": {"eco": "C50", "name": "Italian Game", "nameRu": "Итальянская партия", "stillInBook": true},
  "childMove": {"san": "Nxe4", "sayRu": "конь бьёт е четыре"},
  "engine": {
    "depth": 18,
    "before": {"cp": 35, "winPct": 53}, "after": {"cp": -310, "winPct": 24},
    "verdict": "blunder",                 // по падению winPct; пороги — в отчёте по движку
    "best": [{"san": "d6", "cp": 30, "pvSan": ["d6", "c3", "Bg4"]}, {"san": "O-O", "cp": 22}],
    "refutation": {"pvSan": ["Bxf7+", "Kxf7", "Qd5+"], "sayRu": ["слон бьёт эф семь шах", "…"]}
  },
  "facts": {                              // детерминированные детекторы (attackers/defenders, SEE, лучи)
    "hanging": [{"square": "e4", "piece": "n", "attackers": ["Bd5"], "defenders": []}],
    "tactics": [{"type": "fork", "by": "Qd5", "targets": ["Kf7", "Ne4"]}],   // → карточка tactics/fork
    "material": {"white": 38, "black": 38, "diff": 0},
    "development": {"white": 4, "black": 3}, "kingSafety": {"black": "uncastled"},
    "checks": [], "captures": ["Nxe4"], "threatsAgainstChild": ["Bxf7+"]
  },
  "tablebase": null,                      // ≤7 фигур: {"category": "draw", "dtz": 0, "best": "Kf6"}
  "concepts": ["tactics/fork/queen-fork", "opening/principles/dont-grab-pawns"],  // id карточек
  "policy": {"askTakeBack": true, "revealBestMove": false, "hintLevel": 1}
}
```

Правила для LLM (system prompt тренера): (1) о доске говори только то, что есть в `facts/engine/tablebase`; (2) ходы произноси из полей `sayRu`; (3) педагогика — из карточек `concepts`; (4) если фактов нет — задай наводящий вопрос, а не утверждай. Критичные реплики («подожди, верни ход и подумай ещё») — шаблонные, с подстановкой; LLM добавляет только тёплую обёртку.

Инструменты realtime-модели (function calling): `get_position_facts()`, `get_concept(id)`, `lookup_term(text)`, `next_puzzle(theme, rating)`, `explain_line(pvSan[])` — все возвращают проверенные кодом данные.

### 8.5. Конвейер наполнения БЗ (через подписку ChatGPT, без API-биллинга)

Проверено локально: `codex-cli 0.154.0`, команда `codex exec` поддерживает `--output-schema <FILE>`, `-o/--output-last-message <FILE>`, `--json`, `--ephemeral`, `--skip-git-repo-check`, `-m <MODEL>`. Значит, черновики карточек можно генерировать пакетно из-под подписки:

```bash
codex exec --skip-git-repo-check --ephemeral --output-schema kb/_schema/card.schema.json \
  -o /tmp/card.json "Напиши карточку темы 'skewer' для ребёнка 8 лет по шаблону. Факты: $(cat facts/skewer.json)"
```

Требования к команде: (1) схема для `--output-schema` должна быть **strict** — `additionalProperties: false` и все поля в `required` (требование strict structured outputs OpenAI; отказ на нестрогой схеме здесь не воспроизводился); `card.schema.json` проектировать сразу так (необязательные поля — через `["string","null"]`); (2) добавить `--sandbox read-only` и передавать промпт через stdin (`… -` в конце), а не через `$(cat …)` в аргументе — безопаснее для кавычек и длинных фактов; (3) флаги `--output-schema`, `-o`, `--json`, `--ephemeral`, `--skip-git-repo-check`, `-m`, `-s/--sandbox` — по `codex exec --help` (codex-cli 0.154.0).

Затем: `validate-cards.mjs` (FEN/ходы через chess.js + Stockfish) → человек вычитывает → `reviewed_by: parent`. Лимиты подписки и допустимость такого использования — не проверено здесь (это тема отчёта про LLM-бэкенд).

---

## 9. Предлагаемая раскладка на диске

```
Chess/
├─ kb/                                  # В GIT. Курируемая БЗ — «мозг» тренера
│  ├─ README.md  LICENSES.md            # таблица: что откуда, под какой лицензией
│  ├─ _schema/card.schema.json  glossary.schema.json
│  ├─ taxonomy/
│  │  ├─ themes.yaml                    # theme id → ru-имя, уровень, lichess_themes, prerequisites
│  │  └─ curriculum.yaml                # 5 ступеней × модули (тактика/эндшпиль/дебют/стратегия) + критерии перехода
│  ├─ concepts/
│  │  ├─ tactics/{hanging-piece,fork,pin,skewer,discovered-attack,double-check,deflection,…}.md
│  │  ├─ checkmates/{back-rank,smothered,anastasia,arabian,boden,…}.md
│  │  ├─ endgames/{kq-vs-k,kr-vs-k,two-rooks,square-rule,opposition,key-squares,lucena,philidor,…}.md
│  │  ├─ opening-principles/{center,development,castle-early,dont-move-twice,queen-early,…}.md
│  │  ├─ strategy/{open-file,outpost,passed-pawn,bad-bishop,weak-squares,pawn-structure,…}.md
│  │  └─ thinking/{blunder-check,checks-captures-threats,candidate-moves,time-management}.md
│  ├─ openings/
│  │  ├─ ru-names.yaml                  # EN (Lichess) → RU
│  │  └─ repertoire/{italian-game,scotch,london,caro-kann,…}.md   # идеи, типовые планы, ловушки
│  ├─ glossary/ru.yaml                  # ~150 терминов, алиасы, ударения
│  ├─ speech/san-to-ru.yaml             # как произносить нотацию
│  ├─ coach/{persona.md,phrases.ru.yaml,takeback-policy.yaml}
│  ├─ model-games/*.pgn                 # 30–50 партий с НАШИМИ русскими комментариями
│  └─ sources/                          # выжимки из первоисточников с provenance
│     ├─ capablanca-1921/notes.md       # PD
│     ├─ lasker-common-sense/notes.md   # PD
│     └─ wikibooks/…                    # CC BY-SA 4.0 — держим отдельно (share-alike)
├─ data/                                # НЕ в git (.gitignore); всё воспроизводимо скриптами
│  ├─ raw/
│  │  ├─ lichess/lichess_db_puzzle.csv.zst            (304 МБ)
│  │  ├─ chess-openings/{a,b,c,d,e}.tsv
│  │  ├─ lila-i18n/puzzleTheme.{en,ru}.xml
│  │  ├─ wikidata/openings_ru.csv
│  │  ├─ gutenberg/pg{33870,5614,4913}.txt  archive/commonsense_djvu.txt
│  │  ├─ pgn/masters/{Morphy,Capablanca,Tal,…}.pgn
│  │  └─ syzygy/3-4-5/*.rtbw *.rtbz                   (0.98 ГБ, опционально)
│  ├─ build/
│  │  ├─ puzzles.sqlite                 # puzzle, puzzle_theme (+ attempt — в БД прогресса)
│  │  ├─ openings.json                  # EPD → {eco,name,nameRu,ply}
│  │  └─ kb.sqlite                      # FTS5: карточки + глоссарий; кэш explorer/tablebase/cloud-eval
│  └─ SOURCES.lock.json                 # url, sha256, bytes, last-modified, license, fetched_at
├─ journal/                             # партии ребёнка (PGN) + md-дневники — отдельная тема
└─ scripts/kb/
   ├─ fetch.sh                          # команды из §10
   ├─ build-puzzles.mjs  build-openings.mjs  build-kb-index.mjs
   └─ validate-cards.mjs                # chess.js + Stockfish: FEN/best/ссылки на темы/prerequisites
```

Принципы: `kb/` — человекочитаемый, версионируемый, ревьюится родителем в diff; `data/` — воспроизводимый кэш; в рантайме тренер читает только `data/build/*` и `kb/**` (собранные в `kb.sqlite`).

---

## 10. Команды загрузки (URL проверены; крупные файлы не скачивались)

```bash
cd <repo> && mkdir -p data/raw/{lichess,chess-openings,lila-i18n,wikidata,gutenberg,archive,pgn/masters,syzygy/3-4-5} data/build

# 1. Puzzles — 304 429 328 байт, CC0 (HEAD 200, accept-ranges: bytes)
curl -L --fail -C - -o data/raw/lichess/lichess_db_puzzle.csv.zst https://database.lichess.org/lichess_db_puzzle.csv.zst
#    быстрый прототип без полной загрузки (3 МБ ≈ 58 тыс. задач; проверено):
curl -s -r 0-2999999 https://database.lichess.org/lichess_db_puzzle.csv.zst | zstd -dc 2>/dev/null | sed '$d' > data/raw/lichess/puzzle_sample.csv

# 2. Openings — CC0 (все 200; 66/77/132/69/43 КБ)
for f in a b c d e; do curl -sL --fail -o data/raw/chess-openings/$f.tsv https://raw.githubusercontent.com/lichess-org/chess-openings/master/$f.tsv; done

# 3. Темы задач EN/RU (200; 13.9 / 20.1 КБ) — EN-исходник CC0, RU-перевод AGPL по умолчанию, см. оговорку в §2.5
curl -sL -o data/raw/lila-i18n/puzzleTheme.en.xml https://raw.githubusercontent.com/lichess-org/lila/master/translation/source/puzzleTheme.xml
curl -sL -o data/raw/lila-i18n/puzzleTheme.ru.xml https://raw.githubusercontent.com/lichess-org/lila/master/translation/dest/puzzleTheme/ru-RU.xml

# 4. Русские названия дебютов из Wikidata — CC0 (200; с DISTINCT — 194 строки)
curl -s -G https://query.wikidata.org/sparql -H 'Accept: text/csv' -H 'User-Agent: chess-trainer/0.1 (local)' \
  --data-urlencode 'query=SELECT DISTINCT ?item ?en ?ru ?eco WHERE { ?item wdt:P31/wdt:P279* wd:Q103632 . ?item rdfs:label ?en FILTER(LANG(?en)="en") . ?item rdfs:label ?ru FILTER(LANG(?ru)="ru") . OPTIONAL { ?item wdt:P1437 ?eco } }' \
  -o data/raw/wikidata/openings_ru.csv

# 5. PD-книги (все 200): Capablanca 263 КБ, Ed. Lasker 573 КБ и 375 КБ, Em. Lasker OCR 136 КБ
curl -sL -o data/raw/gutenberg/pg33870.txt https://www.gutenberg.org/cache/epub/33870/pg33870.txt
curl -sL -o data/raw/gutenberg/pg5614.txt  https://www.gutenberg.org/cache/epub/5614/pg5614.txt
curl -sL -o data/raw/gutenberg/pg4913.txt  https://www.gutenberg.org/cache/epub/4913/pg4913.txt
curl -sL -o data/raw/archive/commonsense_djvu.txt https://archive.org/download/commonsenseinche00laskrich/commonsenseinche00laskrich_djvu.txt

# 6. Образцовые партии (200; Morphy 33 КБ, Capablanca 114 КБ, Tal 440 КБ)
for p in Morphy Capablanca Tal; do curl -sL -o /tmp/$p.zip https://www.pgnmentor.com/players/$p.zip && unzip -o -q /tmp/$p.zip -d data/raw/pgn/masters/; done

# 7. Lichess Practice — позиции как упражнения (200; без токена). ID разделов — со страницы /practice
curl -sL -o data/raw/pgn/practice-piece-checkmates-1.pgn https://lichess.org/api/study/BJy6fEDf.pgn

# 8. (опц.) Syzygy 3-4-5, 0.98 ГБ, 290 файлов — список URL в download.txt (200)
curl -s https://tablebase.lichess.ovh/tables/standard/download.txt | grep '/3-4-5-' \
  | xargs -n1 -P4 -I{} curl -sL --fail -O --output-dir data/raw/syzygy/3-4-5 {}

# 9. (опц.) Партии трансляций, CC BY-SA 4.0 (200; август 2026 = 31 010 232 байт)
curl -L -o data/raw/pgn/lichess_db_broadcast_2026-08.pgn.zst https://database.lichess.org/broadcast/lichess_db_broadcast_2026-08.pgn.zst

# Живые API (без токена)
curl -s 'https://tablebase.lichess.org/standard?fen=4k3/6KP/8/8/8/8/7p/8_w_-_-_0_1' | jq '.category,.dtz,.moves[0].san'
curl -s 'https://lichess.org/api/cloud-eval?fen=rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR%20w%20KQkq%20-%200%201&multiPv=2' | jq '.depth,.pvs[0]'
# Explorer — только с токеном (без него 401):
curl -s -H "Authorization: Bearer $LICHESS_TOKEN" 'https://explorer.lichess.org/masters?play=e2e4,e7e5,g1f3&moves=5&topGames=0'
```

Сборка: `node scripts/kb/build-puzzles.mjs data/raw/lichess/lichess_db_puzzle.csv.zst` → `node scripts/kb/build-openings.mjs` → `node scripts/kb/build-kb-index.mjs`.

---

## 11. Риски и открытые вопросы

Риски:

- **AGPL-переводы Lichess**: при распространении приложения включение `ru-RU.xml` тянет AGPL (русский `dest/`-файл в исключениях COPYING.md не указан). Английский `source/puzzleTheme.xml` — CC0, его можно включать и перерабатывать свободно. Митигировать: из русского файла брать только термины, описания писать свои (можно отталкиваясь от CC0-английских).
- **Explorer за токеном**: фича зависит от аккаунта Lichess оператора и лимита 25 req/min; политика может ужесточиться. Кэш + офлайн-fallback.
- **Wikimedia 429**: массовый парсинг Wikibooks без UA/пауз блокируется.
- **Качество карточек**: LLM-черновики без движковой валидации и родительской вычитки → ребёнок заучит ошибку. `validate-cards.mjs` и поле `reviewed_by` — обязательны.
- **Русские переводы классики не свободны** (Горфинкель †1966, Майзелис †1978) — не класть в репозиторий.
- **Ed. Lasker в ЕС/РФ под охраной до 2051** несмотря на наличие на Gutenberg (Gutenberg = только право США).
- **Рейтинги задач Lichess ≠ детская шкала**: нужен собственный адаптивный рейтинг ребёнка (Glicko/Elo по решениям), стартовать с 600–800.
- `createZstdDecompress` бросает `Z_BUF_ERROR` в конце обрезанного потока — при докачке `try/catch` и проверка размера/sha.

Открытые вопросы:

- Сколько задач реально даст фильтр на полном файле при N=80 (оценка 35–49 тыс., не измерено).
- Год смерти переводчика «My System» (A. H. W. George) → статус английского перевода в ЕС.
- Применимость +4 лет (ст. 1281 п. 5 ГК РФ) лично к Горфинкелю и Майзелису; статус правки Ненарокова в издании Шифферса 1926 г.
- Лицензионный статус Crowdin-переводов Lichess как таковых (кроме факта, что `dest/`-файлы не названы в исключениях COPYING.md).
- Работа explorer **с токеном** (нужен аккаунт Lichess).
- Лимиты tablebase/cloud-eval в цифрах (в спецификации их нет).
- Отсутствие аннотаций во всех файлах PGN Mentor (проверен только Morphy.pgn); нотация в текстах Ed. Lasker.
- Фильтр-эндпоинт datasets-server Hugging Face (индекс «loading»).
- Поддержка Syzygy в выбранной сборке Stockfish (native vs WASM) — в отчёте по движкам.
- Допустимо ли по условиям подписки пакетно генерировать контент через `codex exec` и каковы лимиты; фактический запуск `codex exec --output-schema` (не проверено).
- Нужен ли вообще explorer для ребёнка на первых ступенях (вероятно, нет до ступени 3).

---

## Источники

По состоянию на 2026-09-21:

- https://database.lichess.org/ — puzzles, evals, broadcasts, лицензия CC0 / CC BY-SA 4.0 (+ HEAD-запросы к `lichess_db_puzzle.csv.zst`, `lichess_db_eval.jsonl.zst`, `broadcast/lichess_db_broadcast_2026-08.pgn.zst`; Range-выборки первых 3 МБ / 300 КБ)
- https://github.com/lichess-org/chess-openings , https://raw.githubusercontent.com/lichess-org/chess-openings/master/README.md , `a.tsv`…`e.tsv`; `gh api repos/lichess-org/chess-openings` (+ `/actions/artifacts`)
- https://raw.githubusercontent.com/lichess-org/lila/master/translation/source/puzzleTheme.xml
- https://raw.githubusercontent.com/lichess-org/lila/master/translation/dest/puzzleTheme/ru-RU.xml
- https://raw.githubusercontent.com/lichess-org/lila/master/translation/dest/learn/ru-RU.xml
- https://raw.githubusercontent.com/lichess-org/lila/master/COPYING.md и README.md (AGPL-3.0, список исключений); `gh api repos/lichess-org/lila`
- https://raw.githubusercontent.com/lichess-org/api/master/doc/specs/lichess-api.yaml (v2.0.174) + `tags/openingexplorer/masters.yaml`, `lichess.yaml`, `tags/tablebase/standard.yaml`, `tags/analysis/api-cloud-eval.yaml`
- https://lichess.org/@/thibault/blog/the-opening-explorer-now-requires-authentication/FSWh9Zg3 (3 Mar 2026)
- https://github.com/lichess-org/api/issues/619 , https://github.com/lichess-org/lila/issues/19610
- https://explorer.lichess.org/masters , https://explorer.lichess.ovh/lichess (401) ; https://lichess.org/api/cloud-eval (200) ; https://tablebase.lichess.org/standard , https://tablebase.lichess.ovh/standard/mainline (200) ; https://lichess.org/api/puzzle/daily (200)
- https://github.com/lichess-org/lila-tablebase ; `gh api` для `lila-openingexplorer`, `ornicar/lichess-puzzler`, `niklasf/chessops`, `hayatbiralem/eco.json`
- https://tablebase.lichess.ovh/tables/standard/ (`bytes.tsv`, `download.txt`, `3-4-5-wdl/`, `3-4-5-dtz/`)
- https://lichess.org/practice ; https://lichess.org/api/study/BJy6fEDf.pgn ; https://lichess.org/terms-of-service
- https://www.gutenberg.org/ebooks/search/?query=chess ; https://www.gutenberg.org/cache/epub/33870/pg33870.txt ; …/5614/pg5614.txt ; HEAD для 4913, 16377, 55278, 78804 ; https://gutendex.com/books/?search=chess
- https://archive.org/metadata/commonsenseinche00laskrich ; https://archive.org/advancedsearch.php (My System) ; https://archive.org/download/commonsenseinche00laskrich/commonsenseinche00laskrich_djvu.txt (HEAD)
- https://en.wikisource.org/wiki/Author:Aron_Nimzowitsch
- https://en.wikibooks.org/wiki/Chess ; https://en.wikibooks.org/wiki/Chess_Opening_Theory/1._e4/1...e5/2._Nf3/2...Nc6/3._Bc4 ; API `en.wikibooks.org/w/api.php` (allpages, siteinfo rightsinfo) ; `ru.wikibooks.org/w/api.php`
- https://ru.wikipedia.org/wiki/Словарь_шахматных_терминов
- https://query.wikidata.org/sparql (дебюты с русскими метками)
- https://www.chessprogramming.org/Main_Page
- https://www.pgnmentor.com/files.html ; https://www.pgnmentor.com/players/Morphy.zip (скачан, 33 КБ)
- https://arxiv.org/abs/2608.04240 ; https://arxiv.org/abs/2410.20811
- https://raw.githubusercontent.com/lichess-org/lila/master/COPYING.md (исключение `translation/source/puzzleTheme.xml` → CC0 1.0, строка 82)
- consultant.ru — ст. 1281 ГК РФ (срок действия исключительного права, п. 5: +4 года для участников ВОВ)
- en.wikipedia (статья об И. Л. Майзелисе); E. Winter / Wikipedia о псевдониме Philip Hereford = A. H. W. George
- https://archive.org/details/20200716_shiffers_chess (Шифферс, Public Domain Mark); НЭБ (изд. 1926 под ред. Ненарокова)
- https://huggingface.co/datasets/Lichess/chess-puzzles ; https://huggingface.co/datasets/Lichess/chess-openings ; datasets-server.huggingface.co/filter
- https://database.nikonoel.fr (Lichess Elite Database)
- По поисковой выдаче (сами страницы не открывались): blog.mathieuacher.com/GPT5-IllegalChessBench, chess.com о Kaggle Game Arena, maxim-saplin.github.io/llm_chess, rusneb.ru (Капабланка 1924), lavkapisateley.spb.ru / fantlab.ru (Горфинкель 1889–1966)
- Локально: `npm view` (chess.js 1.4.0 BSD-2-Clause; chessops 0.15.1 GPL-3.0-or-later; better-sqlite3 13.0.3; csv-parse 7.0.2; @chess-openings/eco.json 2.2.2 MIT; sqlite-vec 0.1.9 MIT OR Apache; chess-openings 0.1.1 WTFPL; `@lichess-org/chessops` — 404), `node -v` v26.7.0 (`node:zlib` zstd и `node:sqlite` доступны), `codex --version` 0.154.0, `codex exec --help`

