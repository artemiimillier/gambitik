# 01. Шахматная доска (UI) и библиотека правил

Версии, звёзды, лицензии и даты релизов — по `npm view`, `gh api repos/...` и страницам GitHub. Размеры бандлов и работоспособность кода проверены запуском (Node 26, React 19.3.0, TypeScript 7.0.2 и 6.0.3, esbuild, Vite, Chromium).

---

## 1. Короткий вывод (TL;DR)

| Роль | Рекомендация | npm-пакет и версия | Лицензия |
|---|---|---|---|
| **Доска — основной выбор** | react-chessboard v5 | `react-chessboard@5.12.1` | MIT |
| **Правила / FEN / PGN — основной выбор** | chess.js | `chess.js@1.4.0` | BSD-2-Clause |
| Доска — запасной вариант | Chessground (lichess) + свой React-враппер на ~25 строк | `@lichess-org/chessground@10.2.0` | GPL-3.0-or-later |
| Правила — запасной / дополнение для PGN с вариантами | chessops | `chessops@0.15.1` | GPL-3.0-or-later |

Стек React 19 + TypeScript + Vite оставляем: именно под него существует самая живая MIT-доска (react-chessboard требует `react ^19`), а Vue/Svelte-альтернативы — это либо заброшенные обёртки над Chessground (GPL), либо проекты с единицами звёзд. Оснований менять стек нет.

Почему именно эта пара:

1. **Стрелки и подсветка клеток — это просто props** (`arrows`, `squareStyles`, `squareRenderer`). Состояние «тренер показывает подсказку» живёт в React-состоянии и декларативно отображается на доске — идеально ложится на сценарий «тренер объясняет лучший ход».
2. **Возврат хода** = `game.undo()` + `setFen(game.fen())`; доска сама анимирует фигуру назад. `Move.before` / `Move.after` в chess.js дают FEN до и после хода — удобно для проверки зевка движком ДО ответа бота.
3. **MIT + BSD** — никаких ограничений, если приложение когда-нибудь станет продуктом или будет выложено в сеть. С Chessground (GPL-3.0) этот путь закрывается или требует открытия всего фронтенда.
4. Оба пакета активно поддерживаются (релиз react-chessboard — 2026-08-16; коммит в chess.js — 2026-08-11), оба с родными TypeScript-типами.
5. Кастомные фигуры — это React-компоненты (`pieces: Record<string, () => JSX>`), то есть детский набор фигур делается из любых SVG без CSS-спрайтов.

Цена выбора: в react-chessboard v5 **нет встроенных premove и диалога превращения** — их убрали из ядра при переписывании v4 → v5 и перенесли в официальные примеры (Premoves, PiecePromotion). Для тренера против ботов premove почти не нужен, а диалог превращения — ~40 строк своего кода (что даже лучше: его можно сделать «детским»).

---

## 2. Сравнение UI-библиотек доски

### 2.1. Метаданные

| Библиотека | npm-пакет @ версия | Звёзды GitHub | Последний релиз | Последний push | Лицензия | Загрузок/нед. (npm) | Статус |
|---|---|---:|---|---|---|---:|---|
| **Chessground** (lichess) | `@lichess-org/chessground@10.2.0` | 1370 | 2026-09-16 | 2026-09-16 | GPL-3.0-or-later | 4 194 (+7 266 у старого имени) | Активен, боевой код lichess.org |
| **react-chessboard** | `react-chessboard@5.12.1` | 544 | 2026-08-16 | 2026-08-16 | MIT | 28 740 | Активен, 2 открытых issue |
| **cm-chessboard** | `cm-chessboard@8.14.0` | 304 | 2026-09-01 | 2026-09-01 | MIT (код) | 3 469 | Активен, 0 открытых issue |
| **gchessboard** | `gchessboard@1.4.0` | 23 | 2026-02-15 | 2026-06-28 | MIT | 32 | Жив, но нишевый |
| chessboard.js | `@chrisoakman/chessboardjs@1.0.0` | 2131 | 2019-06-11 | 2024-04-17 | MIT | — | Заморожен, требует jQuery; автор ушёл в chessboard2 |
| chessboard2 | `@chrisoakman/chessboard2@0.5.0` | 112 | 2023-05-29 | 2024-02-17 | ISC | — | Версия 0.x, стагнирует |
| chessboardjsx | `chessboardjsx@2.4.7` | 270 | 2021-03-31 | 2022-10-10 | MIT | 490 | README начинается с «UNMAINTAINED» |
| chessboard-element | `chessboard-element@1.2.0` | 123 | 2021-09-22 | 2025-08-22 | MIT (npm) | — | Фактически заморожен |
| kokopu-react | `kokopu-react@3.4.3` | 7 | 2026-08-20 | 2026-09-11 | LGPL-3.0-or-later | 135 | Жив, один автор, нишевый |
| react-chessboard-ui | `react-chessboard-ui@3.0.2` | НЕ ПРОВЕРЕНО | 2026-07-12 | НЕ ПРОВЕРЕНО | MIT | НЕ ПРОВЕРЕНО | Малоизвестный |

Важно про Chessground: **npm-пакет переименован**. Старый `chessground` (последняя версия 9.2.1) помечен в npm как deprecated («Package no longer supported»). Актуальный пакет — `@lichess-org/chessground` (создан 2025-05-29, ветка 10.x с января 2026). Любая обёртка, которая зависит от `chessground@8.x/9.x`, тянет устаревший код.

На npm есть и совсем новые MIT-доски 2026 года: `@mirasen/chessboard@1.5.0` + `@mirasen/react-chessboard@1.2.0` (peer `chess.js ^1.4.0`, 4 звезды, репозиторий создан 2026-03), `@plywise/chessboard-react@0.3.0`, `@powchess/chessboard@2.0.1` (Svelte 5). У всех десятки–сотни загрузок в неделю — на выбор не влияют.

### 2.2. Обёртки над Chessground для фреймворков

| Обёртка | Версия / дата | Звёзды | Лицензия | Вердикт |
|---|---|---:|---|---|
| `@react-chess/chessground` | 1.3.4 / 2022-09-20 | 34 | GPL-3.0 | Заброшена: peer `react ≤18`, жёстко `chessground@8.3.5` |
| `react-chessground` (ruilisi) | 1.5.0 / 2020-06-12 | 133 | GPL-3.0 | Заброшена, 67 открытых issue |
| `next-chessground` (victorocna) | 1.5.2 / 2026-07-23 | 16 | GPL-3.0 | **Жива** (push 2026-09-06, ~187 загрузок/нед., peer `react ^17 \|\| ^18 \|\| ^19`, `chess.js ^1.4.0`, встроенный модал превращения), но сидит на deprecated-пакете `chessground ^7.12.0` (ветка 2020 года) — не брать. |
| `@mdwebb/react-chess` | 2.0.4 / 2026-05-18 | 2 | заявлен MIT, но зависит от GPL-пакета `chessground ^8.3.7` | Лицензионно противоречив, старый Chessground — не брать |
| `vue3-chessboard` | 1.3.3 / 2024-03-02 | 85 | GPL-3.0 | Стагнирует |
| `vue-chessboard` (vitogit) | push 2022-12 | 172 | GPL-3.0 | Заброшена |
| `svelte-chessground` (gtim) | 2.0.3 / 2023-12 | 28 | GPL-3.0 | Стагнирует |
| `svelte5-chessground` | 1.1.1 / 2025-11-09 | 6 | GPL-3.0-or-later | Жива, но крошечная |
| `svelte-chess` | 0.11.1 / 2023-08-13 | НЕ ПРОВЕРЕНО | GPL-3.0 | Стагнирует |
| `ngx-chessground` (Angular) | push 2026-09-13 | 15 | GPL-3.0 | Жива, не наш стек |

Вывод: **готовой живой React-обёртки над актуальным `@lichess-org/chessground` 10.x нет**. Единственная поддерживаемая React-обёртка (`next-chessground`) тянет deprecated `chessground@7.x`; остальные заброшены. Если брать Chessground, обёртку нужно писать самим (это 25 строк, см. раздел 7).

### 2.3. Функциональность

Обозначения: «да» — встроено; «пример» — нет в ядре, но есть официальный пример; «сам» — нужно писать самому.

| Возможность | react-chessboard 5.12.1 | Chessground 10.2.0 | cm-chessboard 8.14.0 | gchessboard 1.4.0 | chessboard.js 1.0.0 |
|---|---|---|---|---|---|
| Drag & drop | да (`@dnd-kit/core`) | да (свой движок) | да | да | да |
| Click-to-move | пример (`onSquareClick`, сторис ClickOrDragToMove) | да (`selectable`) | да | да | сам |
| Точки легальных ходов | пример (через `squareStyles`) | да (`movable.dests` + `showDests`) | сам (маркеры) | сам | сам |
| Touch / планшет | да (TouchSensor; баг «тап = drag» исправлен в 5.2.2, сенсор ужесточён в 5.12.1) | да (эталон: мобильная веб-версия lichess.org; нативное приложение — на Dart-порте) | да | да | частично |
| Стрелки программно | да, prop `arrows: {startSquare,endSquare,color}[]` | да, `setAutoShapes([{orig,dest,brush}])` | да, расширение Arrows | да, свойство `arrows` | нет |
| Стрелки рисует пользователь | да (`allowDrawingArrows`, `onArrowsChange`, цвета по Shift/Ctrl/Alt/Meta) | да (`drawable.enabled`, `onChange`) | да (RightClickAnnotator) | НЕ ПРОВЕРЕНО | нет |
| Подсветка клеток | да, `squareStyles: Record<square, CSSProperties>` + `squareRenderer` для произвольного JSX внутри клетки | да: `highlight.custom: Map<Key, cssClass>`, круги, `lastMove`, `check`, подписи (`label`) и `customSvg` на фигурах | да, расширение Markers | через slots / CSS parts | сам (CSS) |
| Premoves | пример (сторис Premoves); из ядра убраны в v5 | да (`premovable`, `playPremove()`) | сам | нет | нет |
| UI превращения пешки | пример (сторис PiecePromotion); из ядра убран в v5 | нет (lichess рисует свой) | да, расширение PromotionDialog | нет | нет |
| Анимация ходов | да (`animationDurationInMs`, `showAnimations`) | да (`animation.duration`), плюс `explode()` | да | да | да |
| Свои фигуры | да — React-компоненты (`pieces`) | да — через CSS (background-image на `piece.role.color`) | да — SVG-спрайт | да — CSS/слоты | да — картинки |
| Темы доски | inline-стили (`darkSquareStyle`, `lightSquareStyle`, `boardStyle`) | CSS-файлы (`chessground.brown.css` и свои) | CSS | CSS custom properties | CSS |
| Доступность (a11y) | НЕ ПРОВЕРЕНО | слабая | да, расширение Accessibility | да (клавиатура, скринридер) | нет |
| Интеграция с React | нативная, декларативная, `ChessboardProvider` + `useChessboardContext` | императивное API, нужен враппер через `useRef`/`useEffect` | императивное API, нужен враппер | web component (через `@lit/react`) | jQuery, плохо |
| TypeScript-типы | да, в пакете | да, в пакете (написан на TS) | **нет** `.d.ts` в пакете | да | нет (`@types` — НЕ ПРОВЕРЕНО) |
| Зависимости | `@dnd-kit/core`, `@dnd-kit/modifiers`; peer `react ^19`, `react-dom ^19` | нет (но `engines`: node ≥ 24, pnpm ≥ 12 — на pnpm 11.5.2 ставится без ошибок, проверено) | нет | по коду — нет, но в `dependencies` npm-пакета ошибочно указан `vite-plugin-bundlesize ^0.2.0` (ставится вместе с пакетом) | jQuery ≥ 3.4.1 |
| Нестандартные доски | да (`chessboardRows/Columns`) | нет (8×8) | нет | нет | нет |

### 2.4. Размер бандла (измерено локально: esbuild `--bundle --minify`, затем `gzip -9`)

| Пакет | min | gzip | Примечание |
|---|---:|---:|---|
| `react-chessboard` (вместе с dnd-kit, без react) | 87.5 KB | **26.5 KB** | |
| `@lichess-org/chessground` | 33.0 KB | **12.1 KB** | + CSS с фигурами (cburnett в base64) |
| `cm-chessboard` + Markers + Arrows + PromotionDialog | 50.7 KB | 12.1 KB | + SVG-спрайт фигур отдельным файлом |
| `gchessboard` | 56.3 KB | 13.9 KB | |
| `chess.js` | 36.6 KB | **12.6 KB** | |
| `chessops` (chess + fen + san + pgn + compat) | 31.8 KB | 10.5 KB | tree-shakeable по подмодулям |

Для локального приложения на Mac разница 12 vs 26 KB несущественна — размер не является фактором выбора.

Единицы в таблице — KiB (байты / 1024). Повторный замер (esbuild 0.28.2): react-chessboard 88 406 Б / 26 757 Б gzip; `@lichess-org/chessground` 33 024 / 12 154; chess.js 37 115 / 12 915; chessops (именованные импорты) 32 459 / 10 928 — расхождение с таблицей ≤ 2 %. Цифра chessops верна только при именованных импортах: с `export *` из тех же пяти подмодулей выходит 51,9 kB / 15,3 kB gzip. Реальный production-бандл шаблона Vite + React 19.3 + react-chessboard + chess.js + эскиз 7.1 — 330 kB / 102 kB gzip.

---

## 3. Сравнение библиотек правил

| | chess.js 1.4.0 | chessops 0.15.1 | kokopu 4.13.4 |
|---|---|---|---|
| Звёзды GitHub | 4407 | 171 | НЕ ПРОВЕРЕНО |
| Загрузок/нед. | 122 904 | 14 761 | НЕ ПРОВЕРЕНО |
| Последний релиз | 2025-06-14 (в master невыпущенные коммиты, в т.ч. «Add isCheck() to the Move API (#583)» от 2026-08-11) | 2026-07-12 | 2026-07-18 |
| Лицензия | **BSD-2-Clause** | **GPL-3.0-or-later** | LGPL-3.0-or-later |
| TypeScript | написан на TS | написан на TS | да |
| Легальные ходы, шах/мат/пат/ничьи | да | да | да |
| `undo()` | **да, встроен** (`undo(): Move \| null`) | нет — позиции клонируются (`pos.clone()`), историю ведёте сами | через дерево партии |
| SAN / LAN / UCI | SAN, LAN | SAN, UCI | SAN, UCI |
| FEN | да, `validateFen` | да | да |
| PGN: заголовки, комментарии | да (`setHeader`, `setComment`, `getComments`) | да | да |
| PGN: **варианты (RAV)** | **нет — молча отбрасываются** (проверено: `1. e4 (1. d4 d5) e5` → остаётся только главная линия) | **да**, полное дерево партии (`parsePgn` → `makePgn` сохраняет варианты и NAG) | да |
| PGN: NAG (`$1`, `!`, `?`) | в 1.4.0 отбрасываются; поддержка добавлена в master 2025-10-10, **не выпущена** | да | да |
| Шахматные варианты (960, crazyhouse…) | нет | да | 960 и часть вариантов |
| Помощник для Chessground | сам (см. `dests()` в разделе 7) | да, `chessgroundDests(pos)` из `chessops/compat` | нет |
| `Move.before` / `Move.after` (FEN до/после) | **да** | сам | сам |
| Кто использует | де-факто стандарт, все примеры react-chessboard | lichess.org | сайты автора |

Вывод: **chess.js** — основной. Он проще, у него есть `undo()` и `move.before`, BSD-лицензия и вся экосистема примеров. Единственная серьёзная слабость — PGN без вариантов и (в релизе 1.4.0) без NAG.

Следствие для журнала партий. Сценарий «ребёнок сделал слабый ход → тренер попросил вернуть → ребёнок сыграл иначе» в PGN естественно записывается как вариант: `12. Qh5?! { тренер: ранний ферзь } ( 12. Nf3 )`. chess.js так не умеет: после `undo()` отменённый ход и его комментарий исчезают из PGN (проверено). Решение без GPL:

- вести **собственный журнал событий** (JSON/markdown): `{ply, fenBefore, attemptedSan, verdict, engineBest, coachText, childThought, tookBack: true}` — это всё равно нужно для отслеживания прогресса;
- PGN главной линии генерировать через `chess.js` (`game.pgn()`), а «попытки» писать в комментарии `{...}` к итоговому ходу и в markdown-журнал;
- если позже понадобится настоящий PGN с вариантами — собрать его самим (формат простой) или подключить `chessops/pgn` только на стороне Node-скрипта экспорта (для приватного использования GPL не мешает, см. раздел 4);
- **вариант без GPL:** для чтения/записи PGN с вариантами и NAG есть разрешительные библиотеки — `@mliebelt/pgn-parser@1.4.19` (Apache-2.0, ~2,3k загрузок/нед., свои TS-типы; проверено запуском: `2. Qh5?! {…} (2. Nf3 $1 Nc6)` разбирается в `variations` + `nag: ["$6"]`), `cm-pgn@5.0.0` / `cm-chess@4.0.0` (MIT, shaack, «chess.js с вариантами») и `@jackstenglein/chess@2.2.21` (MIT, надстройка над `chess.js ^1.4.0` с деревом вариантов; 3 звезды, один автор). То есть ради вариантов тянуть GPL-пакет `chessops` не обязательно.

---

## 4. Лицензии: что означает GPL-3.0 для этого проекта

Факты:

- Chessground, chessops и все обёртки над Chessground — **GPL-3.0(-or-later)**.
- README Chessground прямо заявляет, что при использовании на сайте объединённая работа распространяется только под GPL и исходный код нужно открыть пользователям сайта (JS доставляется в браузер пользователя, а это и есть передача копии программы).
- GNU GPL FAQ: GPL **не требует** публиковать модифицированные версии, которыми вы пользуетесь приватно; обязательства возникают только при распространении копий другим лицам. Использование внутри одной организации распространением не считается.

| Сценарий | Chessground / chessops (GPL-3.0) | react-chessboard / chess.js (MIT / BSD) |
|---|---|---|
| Локальное приложение на домашнем Mac, пользуется только семья | **Можно без всяких обязательств**: копии никому не передаются | Можно |
| Открыть с iPad в домашней сети (тот же хозяин) | Можно, распространения нет | Можно |
| Выложить в интернет для других людей (даже бесплатно) | Весь фронтенд, слинкованный с Chessground, должен быть под GPL-3.0, исходники доступны пользователям | Без ограничений, достаточно сохранить тексты лицензий |
| Продавать / раздавать как продукт (Electron, Tauri, App Store) | Только как GPL-продукт с исходниками; с закрытым кодом несовместимо; App Store с GPL — проблемная зона | Без ограничений |
| Приватный GitHub-репозиторий | Можно | Можно |
| Публичный репозиторий | Нужно лицензировать как GPL-3.0 | Любая лицензия |

Практический вывод: пока приложение семейное и GPL ничем не мешает. Но затраты на переход «доска A → доска B» после того, как вокруг доски построены тренер, подсказки, стрелки и журнал, — заметные. Выбор MIT/BSD сейчас **ничего не стоит** и сохраняет все пути (публичный сайт, продукт, закрытый код). Поэтому GPL-вариант — только запасной.

Отдельная ловушка — **лицензии графики фигур**, они не совпадают с лицензией кода:

- cm-chessboard: код MIT, но набор `staunty` — CC BY-NC-SA 4.0 (некоммерческий), `standard` — CC BY-SA 3.0.
- Наборы lichess (файл `COPYING.md` в репозитории lila): `cburnett`, `merida`, `mono` — GPLv2+; большая группа (`staunty`, `california`, `maestro`, `fresca`, `cardinal`, `gioco`, `tatiana`, `dubrovny`, `anarcandy`, `cooke` и др.) — CC BY-NC-SA 4.0; более свободные: `rhosgfx` — CC0, `kiwen-suwi`, `firi`, `totoy`, `papercut` — CC BY 4.0, `fantasy`, `spatial`, `celtic` — MIT, `chessnut` — Apache-2.0. «Детский» набор `horsey` — CC BY-NC-SA 4.0 (некоммерческий); `letter`, `pixel`, `pirouetti` — AGPLv3+.
- Фигуры по умолчанию в react-chessboard (`defaultPieces`) — это набор **Cburnett** с Wikimedia Commons (комментарий в начале `src/pieces.tsx` ссылается на `commons.wikimedia.org/wiki/Category:SVG_chess_pieces`, «By en:User:Cburnett … CC BY-SA 3.0»). На Wikimedia эти файлы выложены под мультилицензией **GFDL / CC BY-SA 3.0 / BSD-3-Clause / GPL** — получатель выбирает любую, то есть для будущего продукта их можно использовать на условиях BSD (достаточно атрибуции). В самом npm-пакете и его LICENSE атрибуции нет — при публикации добавить её самим.
- Какие из наборов выглядят «по-детски» — НЕ ПРОВЕРЕНО визуально. Для семейного использования подойдёт любой; для будущего продукта безопаснее CC0/CC BY/MIT-наборы или собственные SVG.

---

## 5. Разбор кандидатов

### 5.1. react-chessboard 5.12.1 — основной выбор

Плюсы:
- MIT, нативный React 19, декларативный API: один prop `options` (тип `ChessboardOptions`).
- Всё нужное тренеру — управляемые props: `position`, `arrows`, `squareStyles`, `squareRenderer`, `allowDragging`, `canDragPiece`, `boardOrientation`.
- `squareRenderer` позволяет положить в клетку любой JSX: значок «??», звёздочку за хороший ход, пульсирующую рамку, мини-аватар тренера.
- Кастомные фигуры — React-компоненты, можно анимировать (CSS/Framer Motion).
- Адаптивная доска (ширина задаётся контейнером), произвольные размеры доски (полезно для мини-упражнений 4×4, 5×5 в учебном плане).
- В документации есть готовые примеры ровно под наши задачи: ClickOrDragToMove, PlayVsRandom, AnalysisBoard (Stockfish WASM в Web Worker), MiniPuzzles, Premoves, PiecePromotion.
- Экосистема: `@react-chess-tools/*` (MIT; game / puzzle / bot 2.1.0, clock / stockfish 2.0.2, все от 2026-09-17; у `react-chess-stockfish` в npm-метаданных нет поля `license`) построена на `react-chessboard ^5.12.1` + `chess.js ^1.4.0` и содержит часы, пазлы, Stockfish и ботов. Проект молодой (12 звёзд, ~100 загрузок/нед.) — брать как источник идей и кода, а не как зависимость.

Минусы и риски:
- Фактически один мейнтейнер (Clariity: 166 коммитов, следующий контрибьютор — 11). Смягчение: MIT и небольшой код — при необходимости форкается.
- v5 — переписывание с нуля с ломающими изменениями (props переименованы, premove и promotion убраны из ядра). Примеры из интернета для v4 (`customArrows`, `customSquareStyles`, `boardWidth`, `onPromotionPieceSelect`) **не работают** — ориентироваться только на документацию v5.
- Требует React ≥ 19 и Node ≥ 20.11 — для нового проекта не проблема.
- Touch: история багов была (issues #134, #140, #206), все закрыты; последняя правка TouchSensor — в 5.12.1. Реальное поведение на iPad — НЕ ПРОВЕРЕНО на устройстве. Для детских рук полезна опция `dragActivationDistance` (по умолчанию `1` px; в эскизе не использована): увеличить до 5–10 px, чтобы неточный тап не превращался в drag и click-to-move работал надёжно (источник: `docs/D_OptionsApi.mdx`). Есть также `allowAutoScroll`, `clearArrowsOnClick`, `onPieceDragCancel`.
- Перерисовка через React: на каждое изменение `options` рендерится дерево из 64 клеток. Для одной доски это незаметно; объект `options` и обработчики стоит мемоизировать.

### 5.2. Chessground 10.2.0 — запасной вариант

Плюсы:
- Самая отполированная доска: на ней работает сайт lichess.org, включая мобильную веб-версию (нативное мобильное приложение `lichess-org/mobile` написано на Flutter и использует отдельный Dart-порт `lichess-org/flutter-chessground`; прежнее приложение `lichobile` на TS-Chessground архивировано). Аргумент «эталонный touch» относится к мобильному вебу. Лучшее ощущение drag/touch, встроенные premoves, точки легальных ходов, подсветка последнего хода и шаха, «взрывы» клеток.
- Богатейшие аннотации: стрелки, круги, подписи (`label.text`), произвольный SVG (`customSvg`), полупрозрачные фигуры-призраки (`piece`), слой `below` под фигурами. Для тренера это максимум выразительности из коробки.
- 12 KB gzip, без зависимостей, строгие TS-типы (`Key`, `Dests`, `DrawShape`).
- Очень активна: релиз 10.2.0 вышел 2026-09-16; основной автор — ornicar (1358 коммитов), создатель lichess.

Минусы:
- **GPL-3.0-or-later** (см. раздел 4).
- Императивное API: состояние доски живёт внутри Chessground, его нужно синхронизировать с React вручную (`api.set(config)`), включая `movable.dests` после каждого хода.
- Нет UI превращения пешки.
- Фигуры и темы — через CSS; для своего набора нужно писать CSS-правила для 12 комбинаций `piece.<role>.<color>`.
- Готовых живых React-обёрток нет (раздел 2.2).

Когда переключаться: если на реальном планшете drag в react-chessboard окажется неудобным для ребёнка или понадобятся premoves/подписи на стрелках «как на lichess», а распространять приложение точно не планируется.

### 5.3. cm-chessboard 8.14.0

Добротная MIT-доска на чистом ES6/SVG, очень активная (релизы каждые пару недель, 0 открытых issue), с расширениями Markers, Arrows, PromotionDialog, Accessibility, RightClickAnnotator. Это лучший MIT-вариант **вне React**. Но: нет TypeScript-типов в пакете, императивное API (нужен враппер), premoves нет, встроенные наборы фигур под CC BY-NC-SA / CC BY-SA. Для React + TS проекта проигрывает react-chessboard по эргономике. Имеет смысл как «третий» вариант, если захочется уйти от React, оставаясь в MIT.

### 5.4. gchessboard 1.4.0

Web component с упором на доступность (клавиатура, скринридер), стрелки есть, темы через CSS custom properties. Но 23 звезды, 32 загрузки в неделю, один автор, нет premove, нет диалога превращения. Риск заброшенности слишком высок для основы проекта.

### 5.5. chessboard.js / chessboard2 / chessboardjsx / chessboard-element

- `chessboard.js` 1.0.0 (2019) — требует jQuery, без стрелок, без click-to-move, без типов. Автор в README (дек. 2022) пишет, что переключился на chessboard2.
- `chessboard2` 0.5.0 (2023-05) — так и не вышел из 0.x, последний push 2024-02.
- `chessboardjsx` — README открывается словом «UNMAINTAINED»; react-chessboard исторически и есть его преемник.
- `chessboard-element` — релиз 2021 года.

Все четыре **не рассматривать**.

### 5.6. kokopu-react

LGPL-3.0, жив (релиз 2026-08-20), сильная сторона — отображение партий с вариантами и диаграмм. Но 7 звёзд, один автор, LGPL сложнее MIT при бандлинге. Не рекомендую как основу.

---

## 6. Рекомендуемая установка

```bash
pnpm create vite@latest chess-trainer --template react-ts   # create-vite 9.2.1 → vite 8.3.0, react 19.3.0, typescript 6.0.3 (шаблон фиксирует "typescript": "~6.0.2")
cd chess-trainer
pnpm add react-chessboard@5.12.1 chess.js@1.4.0
```

Примечание: `latest` TypeScript на npm — 7.0.2, но шаблон `react-ts` из `create-vite@9.2.1` закрепляет `typescript ~6.0.2`, поэтому свежий проект получит 6.0.3 (pnpm сообщает «7.0.2 is available»). Эскизы раздела 7 проходят строгую проверку типов на обеих версиях (6.0.3 и 7.0.2); переходить на TS 7 вручную не обязательно.

Запасной вариант (GPL):

```bash
pnpm add @lichess-org/chessground@10.2.0 chess.js@1.4.0
# опционально: pnpm add chessops@0.15.1
```

Не устанавливать: `chessground` (deprecated-имя), `react-chessground`, `@react-chess/chessground`, `chessboardjsx`.

---

## 7. Эскизы интеграции

Все три блока кода ниже проходят `tsc --strict` (TypeScript 7.0.2 и 6.0.3) с реальными пакетами; рендер react-chessboard со стрелкой и подсветкой проверен через `react-dom/server` (64 клетки, 32 фигуры, SVG-стрелка и стиль клетки присутствуют в разметке). Логика chess.js (`move`, `undo`, `move.before`, комментарии, PGN) проверена запуском в Node 26. Эскиз 7.1 собран в проекте из шаблона `create-vite@9.2.1` (`tsc -b && vite build` без ошибок) и прогнан в Chromium с заглушкой движка: ход d2–d4 → «вердикт: плохо» → стрелка g1→f3 (для хода коня рисуется Г-образной), красная подсветка d2/d4, пешка анимированно возвращается на d2; затем Nf3 принят → стрелка и подсветка сняты → бот отвечает e7–e5. Click-to-move и точки легальных ходов работают.

### 7.1. Основной вариант: react-chessboard + chess.js

Показано: доска, drag и click-to-move, точки легальных ходов, **стрелка подсказки, подсветка клеток, возврат хода** по вердикту движка ДО ответа бота.

```tsx
// TrainerBoard.tsx
import { useMemo, useRef, useState } from 'react';
import { Chess, type Square, type Move } from 'chess.js';
import {
  Chessboard,
  type Arrow,
  type ChessboardOptions,
  type PieceDropHandlerArgs,
  type SquareHandlerArgs,
} from 'react-chessboard';

type Verdict =
  | { ok: true }
  | { ok: false; best: { from: Square; to: Square }; reason: string };

// Проверка хода движком (Stockfish в Web Worker) и ход бота — реализуются отдельно
declare function judgeMove(fenBefore: string, move: Move): Promise<Verdict>;
declare function botReply(fen: string): Promise<{ from: Square; to: Square; promotion?: 'q' | 'r' | 'b' | 'n' }>;

export function TrainerBoard() {
  // Chess хранится в ref: это мутабельный объект, а в state кладём только FEN
  const gameRef = useRef(new Chess());
  const game = gameRef.current;

  const [fen, setFen] = useState(game.fen());
  const [from, setFrom] = useState<Square | null>(null);          // выбранная клетка (click-to-move)
  const [arrows, setArrows] = useState<Arrow[]>([]);              // стрелки тренера
  const [hint, setHint] = useState<Record<string, React.CSSProperties>>({}); // подсветка тренера
  const [locked, setLocked] = useState(false);                    // пока думает движок/бот

  // точки легальных ходов для выбранной фигуры
  const moveDots = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (!from) return styles;
    styles[from] = { background: 'rgba(255, 213, 79, 0.55)' };
    for (const m of game.moves({ square: from, verbose: true })) {
      styles[m.to] = {
        background: m.isCapture()
          ? 'radial-gradient(circle, transparent 60%, rgba(0,0,0,.18) 61%)'
          : 'radial-gradient(circle, rgba(0,0,0,.18) 24%, transparent 25%)',
      };
    }
    return styles;
  }, [from, fen]);

  async function afterChildMove(move: Move) {
    setFrom(null);
    setFen(game.fen());
    setLocked(true);

    const verdict = await judgeMove(move.before, move);   // ДО ответа бота

    if (!verdict.ok) {
      // тренер голосом: «Подожди, верни ход и подумай ещё»
      game.undo();                                        // возврат хода
      setFen(game.fen());                                 // доска анимирует фигуру назад
      setArrows([{ startSquare: verdict.best.from, endSquare: verdict.best.to, color: '#2e9e4f' }]);
      setHint({
        [move.from]: { boxShadow: 'inset 0 0 0 4px #e5484d' },
        [move.to]: { background: 'rgba(229, 72, 77, 0.45)' },
      });
      setLocked(false);
      return;
    }

    setArrows([]);
    setHint({});
    const reply = await botReply(game.fen());
    game.move(reply);
    setFen(game.fen());
    setLocked(false);
  }

  function tryMove(src: Square, dst: Square): boolean {
    try {
      // chess.js 1.x бросает исключение на нелегальный ход
      const move = game.move({ from: src, to: dst, promotion: 'q' }); // TODO: свой диалог превращения
      void afterChildMove(move);
      return true;
    } catch {
      return false; // фигура вернётся на место
    }
  }

  function onPieceDrop({ sourceSquare, targetSquare }: PieceDropHandlerArgs) {
    if (!targetSquare) return false;                      // бросили за пределы доски
    return tryMove(sourceSquare as Square, targetSquare as Square);
  }

  function onSquareClick({ square, piece }: SquareHandlerArgs) {
    if (locked) return;
    if (from && tryMove(from, square as Square)) return;
    setFrom(piece && piece.pieceType[0] === game.turn() ? (square as Square) : null);
  }

  const options: ChessboardOptions = {
    id: 'trainer',
    position: fen,
    boardOrientation: 'white',
    allowDragging: !locked,
    canDragPiece: ({ piece }) => piece.pieceType[0] === 'w', // pieceType: 'wP', 'bK', ...
    onPieceDrop,
    onSquareClick,
    arrows,                                   // стрелки тренера
    allowDrawingArrows: true,                 // ребёнок может рисовать свои (правая кнопка)
    clearArrowsOnPositionChange: false,
    squareStyles: { ...moveDots, ...hint },   // подсветка клеток
    animationDurationInMs: 250,
    darkSquareStyle: { backgroundColor: '#7fa650' },
    lightSquareStyle: { backgroundColor: '#f1f6e3' },
    // pieces: kidPieces,                     // Record<'wK'|'bQ'|..., () => JSX> — детский набор фигур
  };

  return (
    <div style={{ width: 'min(90vmin, 640px)' }}>
      <Chessboard options={options} />
    </div>
  );
}
```

Замечания к эскизу:

- Диалог превращения: определить превращение можно по `piece.pieceType[1] === 'P'` и последней горизонтали в `onPieceDrop`; вместо немедленного `game.move` сохранить `{from, to}` в state, показать оверлей с четырьмя фигурами, после выбора вызвать `game.move({from, to, promotion})`. Официальный пример — сторис `PiecePromotion` в репозитории react-chessboard.
- Журнал: сразу после `game.move(...)` сохранять `{san: move.san, fenBefore: move.before, fenAfter: move.after, verdict}`; при `undo()` запись не удалять, а помечать `tookBack: true`.
- Часы 1/5/10 минут — отдельный компонент, доска о них не знает; на время разбора ошибки тренером часы ребёнка ставить на паузу.
- `premove` против бота не нужен: бот отвечает, когда мы сами решим.
- Эскиз упрощён в двух местах, которые нужно закрыть в боевом коде: 1) если `judgeMove`/`botReply` отклонит промис (упал воркер движка, таймаут), `locked` навсегда останется `true` — обернуть в `try/finally`; 2) `useRef(new Chess())` создаёт новый объект `Chess` на каждый рендер (результат отбрасывается, но это лишняя работа) — лучше `useState(() => new Chess())[0]` или ленивую инициализацию ref. Также перед `botReply` нужно проверять `game.isGameOver()`.

### 7.2. Запасной вариант: Chessground + chess.js (GPL-3.0)

```tsx
// CgBoard.tsx — минимальный React-враппер
import { useEffect, useRef } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Config } from '@lichess-org/chessground/config';
import type { DrawShape } from '@lichess-org/chessground/draw';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';

export function CgBoard({ config, shapes }: { config: Config; shapes: DrawShape[] }) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);

  useEffect(() => {
    api.current = Chessground(el.current!, config);
    return () => api.current?.destroy();
  }, []);

  useEffect(() => { api.current?.set(config); }, [config]);
  useEffect(() => { api.current?.setAutoShapes(shapes); }, [shapes]);

  return <div ref={el} style={{ width: 'min(90vmin, 640px)', aspectRatio: '1' }} />;
}
```

```ts
// Связка с chess.js: легальные ходы, стрелка, подсветка, возврат хода
import { Chessground } from '@lichess-org/chessground';
import type { Key } from '@lichess-org/chessground/types';
import { Chess, SQUARES } from 'chess.js';

const game = new Chess();

function dests(): Map<Key, Key[]> {
  const map = new Map<Key, Key[]>();
  for (const s of SQUARES) {
    const ms = game.moves({ square: s, verbose: true });
    if (ms.length) map.set(s, ms.map(m => m.to));
  }
  return map;
}

const cg = Chessground(document.getElementById('board')!, {
  fen: game.fen(),
  movable: {
    free: false, color: 'white', dests: dests(), showDests: true,
    events: {
      after: (orig, dest) => {
        game.move({ from: orig, to: dest, promotion: 'q' });
        sync();
      },
    },
  },
  premovable: { enabled: true },
  drawable: { enabled: true },
  animation: { enabled: true, duration: 250 },
});

function sync() {
  cg.set({
    fen: game.fen(),
    turnColor: game.turn() === 'w' ? 'white' : 'black',
    check: game.inCheck(),
    movable: { color: 'white', dests: dests() },
  });
}

// подсказка тренера: стрелка + круг
cg.setAutoShapes([
  { orig: 'g1', dest: 'f3', brush: 'green' },
  { orig: 'e4', brush: 'red' },
]);
// подсветка клетки своим CSS-классом
cg.set({ highlight: { custom: new Map<Key, string>([['e4', 'coach-blunder']]) } });

// возврат хода
export function takeBack() {
  game.undo();
  sync();
  cg.set({ lastMove: undefined });
}
```

С chessops вместо самописной `dests()` используется `chessgroundDests(pos)` из `chessops/compat` (проверено: для начальной позиции возвращает Map из 10 ключей).

---

## 8. Риски и как их снизить

1. **Один мейнтейнер у react-chessboard.** Изолировать доску за собственным компонентом `<TrainerBoard>` с узким интерфейсом (`fen`, `arrows`, `highlights`, `onMove`, `locked`). Тогда замена на Chessground — это переписывание одного файла.
2. **Ломающие мажорные версии** (v4 → v5 была полным переписыванием). Зафиксировать точную версию `5.12.1` в `package.json`, обновлять осознанно.
3. **Touch на планшете не проверен на устройстве.** До того как строить UI вокруг доски, сделать получасовой тест на реальном iPad: drag, тап-тап, случайные касания ладонью.
4. **PGN без вариантов в chess.js.** Сразу закладывать собственный журнал событий как источник истины; PGN — производный экспорт.
5. **Релизы chess.js редкие** (последний — июнь 2025, NAG-поддержка лежит в master невыпущенной). Библиотека зрелая, критических проблем нет; при необходимости NAG можно писать самим при экспорте.
6. **Лицензии графики фигур** отличаются от лицензий кода — при выборе детского набора проверять лицензию конкретного набора.

---

## 9. Открытые вопросы

- Реальное поведение touch/drag react-chessboard и Chessground на iPad/планшете: проверялись только типы, SSR-рендер, мышиные события в десктопном Chromium и история issues; тач-сенсор dnd-kit не тестировался. Это главный остаточный риск выбора — 30-минутный тест на устройстве до начала вёрстки вокруг доски.
- Доступность (a11y, клавиатура, скринридер) у react-chessboard.
- Официальные сторис `Premoves` и `PiecePromotion` не запускались (проверено только их наличие в `docs/stories/advanced-examples/`); оценка «диалог превращения ≈ 40 строк» не замерялась.
- Визуальная «детскость» конкретных наборов фигур lichess.
- Звёзды и активность репозитория `react-chessboard-ui`; звёзды `kokopu` и `svelte-chess`.
- Производительность react-chessboard при нескольких досках на одной странице (например, сетка пазлов).
- Наличие `@types` для chessboard.js.
- Трактовка GPL для веб-приложений приведена по README Chessground и GNU FAQ; это не юридическая консультация.

---

## Источники

Источники (по состоянию на 2026-09-21):

- https://github.com/lichess-org/chessground — README (возможности, заявление о GPL, имя пакета, список обёрток)
- https://github.com/Clariity/react-chessboard — README
- https://github.com/Clariity/react-chessboard/blob/main/docs/G_UpgradeToV5.mdx — руководство по переходу v4 → v5 (React 19, удалённые premove/promotion)
- https://github.com/Clariity/react-chessboard/blob/main/docs/C_AdvancedExamples.mdx — список продвинутых примеров
- https://github.com/Clariity/react-chessboard/blob/main/docs/stories/basic-examples/ClickOrDragToMove.stories.tsx — эталонный пример click + drag
- https://github.com/Clariity/react-chessboard/issues/206 — баг «тап = drag» на мобильных, исправлен в 5.2.2
- https://github.com/Clariity/react-chessboard/releases — заметки к релизам 5.10–5.12.1
- https://react-chessboard.vercel.app/ — сайт документации (Storybook; содержимое через WebFetch не извлеклось, документация читалась из репозитория)
- https://github.com/shaack/cm-chessboard — README (расширения, лицензии графики)
- https://github.com/mganjoo/gchessboard — README
- https://github.com/oakmac/chessboardjs — README (зависимость от jQuery, статус проекта)
- https://github.com/willb335/chessboardjsx — README («UNMAINTAINED»)
- https://github.com/dancamma/react-chess-tools — README (пакеты game / puzzle / clock / stockfish / bot)
- https://github.com/Clariity/react-chessboard/blob/main/docs/D_OptionsApi.mdx — опции v5 (`dragActivationDistance` и др.)
- https://github.com/Clariity/react-chessboard/blob/main/src/pieces.tsx — происхождение `defaultPieces` (Cburnett)
- https://commons.wikimedia.org/wiki/File:Chess_plt45.svg — мультилицензия фигур Cburnett
- https://github.com/lichess-org/lila/blob/master/COPYING.md — лицензии наборов фигур lichess
- https://www.gnu.org/licenses/gpl-faq.html — GPL FAQ (приватное использование, внутреннее использование, сеть vs AGPL)
- GitHub API (`gh api repos/<owner>/<repo>`): lichess-org/chessground, Clariity/react-chessboard, jhlywa/chess.js, niklasf/chessops, shaack/cm-chessboard, mganjoo/gchessboard, willb335/chessboardjsx, oakmac/chessboardjs, oakmac/chessboard2, qwerty084/vue3-chessboard, vitogit/vue-chessboard, ruilisi/react-chessground, react-chess/chessground, matt-d-webb/react-chess, gtim/svelte-chessground, Janldeboer/svelte5-chessground, agelas/svelte-chessground-ui, topce/ngx-chessground, justinfagnani/chessboard-element, yo35/kokopu-react, dancamma/react-chess-tools, victorocna/next-chessground, lichess-org/mobile, lichess-org/flutter-chessground, lichess-org/lichobile
- npm registry (`npm view <pkg>`): версии, лицензии, даты релизов, зависимости, dist-tags, статус deprecated для всех перечисленных пакетов
- https://api.npmjs.org/downloads/point/last-week/<pkg> — недельные загрузки (неделя 14–20.09.2026)
- `npm pack create-vite` → `template-react-ts/package.json` — версия TypeScript в шаблоне
- `@mliebelt/pgn-parser`, `cm-pgn`, `cm-chess`, `@jackstenglein/chess` — `npm view`, `gh api`, запуск парсера на RAV + NAG + комментариях
- Локально установленные пакеты: файлы типов `react-chessboard/dist/*.d.ts`, `@lichess-org/chessground/dist/{config,api,draw,types}.d.ts`, `chess.js/dist/types/chess.d.ts`, `gchessboard/dist/index.d.ts`
