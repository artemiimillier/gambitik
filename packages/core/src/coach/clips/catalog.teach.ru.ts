/**
 * «Записи» catalogue, part 1 — the teacher («Учитель») lines (docs/voice-clips/SPEC.md §3.1–§3.3, §7): heads before the
 * advised move, reason tails after it, the opponent's move / danger / treasure told WITHOUT squares (the
 * board highlights them; a square is said only by the advice's own slot), reveal and «Совет» heads, plan lines.
 *
 * Voice rules: spoken Russian for a 7–10-year-old — short, warm, concrete, lively and varied; Гамбитик speaks
 * about himself as a BOY («я заметил», «я бы сходил»), even in Giselle's voice. Placeholders: see ./catalog.ts.
 * `freq` = plays per «Учитель» game in the 96-game harvest: it sizes the pool (≥ 1 → ≥ 4 wordings,
 * ≥ 3 → ≥ 6, SPEC §7.1; catalog.test.ts checks it).
 *
 * (A placeholder is always written with the knight as the example word — `{конём}` is «ферзём» for the queen.)
 *
 * Which slot form follows a head is the twins' business (`HEAD_SLOT_FORM` in ./twins.ts): 'ins' heads read with
 * «конём на эф три» (and «конь бьёт на …» for a capture), 'nom' heads with «конь на эф три».
 */
import type { ClipCatalogLine, ClipWording } from '@gambit/shared';

const w = (...texts: string[]): ClipWording[] => texts.map((t) => ({ t }));

// ───────────────────────── heads of the advice sentence (TeachOpener) ─────────────────────────

const HEADS: readonly ClipCatalogLine[] = [
  // 'advice' — ins
  { id: 'teach.head.advice', role: 'head', freq: 4.1, wordings: w('Мой совет —', 'Попробуй так:', 'Я бы сходил так:', 'Смотри, что можно:', 'Предлагаю так:', 'Давай так:') },
  // 'arrow' — nom
  { id: 'teach.head.arrow', role: 'head', freq: 4.5, wordings: w('Смотри на зелёную стрелку:', 'Зелёная стрелка —', 'Глянь на зелёную стрелку:', 'Вот зелёная стрелка:', 'Следи за стрелкой:', 'Стрелка подсказывает:') },
  // 'good' — nom
  { id: 'teach.head.good', role: 'head', freq: 4.1, fallback: 'teach.head.arrow', wordings: w('Хороший ход —', 'Крепкий ход —', 'Отличный ход —', 'Сильный ход —', 'Вот хороший ход:', 'Есть хороший ход:') },
  // 'go' — ins (never castling, never a capture: the teacher does not pick it then)
  { id: 'teach.head.go', role: 'head', freq: 2.4, fallback: 'teach.head.advice', wordings: w('Ходи так:', 'Сходи так:', 'Сыграй так:', 'Ход такой:') },
  // 'calm' — ins
  { id: 'teach.head.calm', role: 'head', fallback: 'teach.head.advice', wordings: w('Спокойно, можно так:', 'Всё спокойно, можно так:', 'Без спешки, можно так:') },
  // the plan heads — nom
  { id: 'teach.head.plan', role: 'head', freq: 1.2, fallback: 'teach.head.arrow', wordings: w('По нашему плану —', 'Идём по плану:', 'По плану —', 'Как задумали:') },
  { id: 'teach.head.planNext', role: 'head', freq: 1.1, fallback: 'teach.head.plan', wordings: w('Дальше по плану —', 'Следующий шаг —', 'Теперь по плану —', 'Дальше как задумали:') },
  { id: 'teach.head.planStep', role: 'head', freq: 1.0, fallback: 'teach.head.plan', wordings: w('Следующий шаг плана —', 'Шаг нашего плана —', 'План говорит:', 'Наш план такой:') },
  { id: 'teach.head.replan', role: 'head', fallback: 'teach.head.plan', wordings: w('По новому плану —', 'Новый план такой:', 'Теперь новый план:') },
  // after the opponent's own sentence ('opp' opener) — ins; also Black's first move of a strategy
  { id: 'teach.head.answer', role: 'head', freq: 2.1, fallback: 'teach.head.advice', wordings: w('Отвечаем так:', 'Наш ответ —', 'А мы ответим так:', 'Ответим так:') },
  { id: 'teach.head.answer.plan', role: 'head', freq: 2.1, fallback: 'teach.head.answer', wordings: w('По плану отвечаем так:', 'А мы по плану —', 'По плану ответ такой:', 'Как задумали, отвечаем:') },
  // the blue arrow on a choice turn — nom
  { id: 'teach.head.alt', role: 'head', fallback: 'teach.head.arrow', wordings: w('Или синяя стрелка:', 'Ещё можно так:', 'А синяя стрелка —', 'Или вот так:') },
  // the treasure's reveal — nom
  { id: 'reveal.head', role: 'head', freq: 3.2, fallback: 'teach.head.arrow', wordings: w('Вот он:', 'Подарок такой:', 'Вот подарок:', 'Смотри, вот он:', 'Нашёлся подарок:', 'Держи подсказку:') },
  // «Совет» again — nom
  { id: 'repeat.head', role: 'head', freq: 3.2, fallback: 'teach.head.arrow', wordings: w('Повторяю совет:', 'Ещё раз мой совет:', 'Совет такой:', 'Вот мой вариант:', 'Я советую так:', 'Напомню:') },
];

// ───────────────────────── the reason tails (one idea of moveIdeas.ts, on «ты») ─────────────────────────

/**
 * `reason.<MoveIdeaId>`: the «почему» after the move. A line that names a piece is `byPiece` — the piece is the one the
 * idea is about (the attacked / captured / saved / developed piece, see `ideaPieceOf` in ./twins.ts); its plain
 * wordings name no piece and are the L3 fallback. Every reason falls back to the neutral `reason.good`.
 */
const REASONS: readonly ClipCatalogLine[] = [
  { id: 'reason.good', role: 'tail', wordings: w('— это крепкий ход.', '— хороший ход.', '— так надёжнее.') },
  { id: 'reason.quiet', role: 'tail', fallback: 'reason.good', wordings: w('— спокойный крепкий ход.', '— крепко и спокойно.') },
  { id: 'reason.mate', role: 'tail', fallback: 'reason.good', wordings: w('— и это мат!', '— мат!', '— ставишь мат!') },
  { id: 'reason.mateSoon', role: 'tail', fallback: 'reason.good', wordings: w('— это дорога к мату!', '— ведёшь к мату!', '— и скоро мат!') },
  { id: 'reason.fork', role: 'tail', fallback: 'reason.good', wordings: w('— это вилка!', '— вилка: нападаешь сразу на двоих!', '— сразу на две фигуры!', '— одним ходом на двоих!') },
  { id: 'reason.pin', role: 'tail', fallback: 'reason.good', wordings: w('— это связка!', '— связываешь фигуру соперника!', '— фигура соперника не может уйти!') },
  { id: 'reason.skewer', role: 'tail', fallback: 'reason.good', wordings: w('— это сквозной удар!', '— удар насквозь!') },
  { id: 'reason.discoveredAttack', role: 'tail', fallback: 'reason.good', wordings: w('— это вскрытое нападение!', '— открываешь нападение!') },
  { id: 'reason.doubleCheck', role: 'tail', fallback: 'reason.good', wordings: w('— это двойной шах!', '— двойной шах!') },
  { id: 'reason.removeDefender', role: 'tail', fallback: 'reason.good', wordings: w('— забираешь защитника!', '— убираешь защитника!') },
  {
    id: 'reason.trappedPiece',
    role: 'tail',
    byPiece: true,
    fallback: 'reason.good',
    wordings: w('— ловишь {коня}: {ему} некуда уйти!', '— {конь} соперника в ловушке!', '— фигура соперника в ловушке!'),
  },
  {
    id: 'reason.freeCapture',
    role: 'tail',
    byPiece: true,
    freq: 2.0,
    fallback: 'reason.good',
    wordings: w('— забираешь {коня} бесплатно!', '— {конь} соперника без защиты!', '— {p:бесплатный|бесплатная} {конь}!', '— это бесплатное взятие!', '— забираешь подарок!'),
  },
  {
    id: 'reason.winMaterial',
    role: 'tail',
    byPiece: true,
    fallback: 'reason.good',
    wordings: w('— выгодно бьёшь {коня}!', '— забираешь {коня}, и ты в плюсе!', '— это выгодный размен!'),
  },
  {
    id: 'reason.recapture',
    role: 'tail',
    byPiece: true,
    freq: 1.0,
    fallback: 'reason.good',
    wordings: w('— забираешь {коня} в ответ.', '— отыгрываешь {коня}.', '— забираешь в ответ.', '— и размен!'),
  },
  { id: 'reason.defendMate', role: 'tail', fallback: 'reason.good', wordings: w('— закрываешь угрозу мата.', '— и мата больше нет!', '— спасаешь короля от мата!') },
  { id: 'reason.answerCheck', role: 'tail', fallback: 'reason.good', wordings: w('— спасаешься от шаха.', '— уходишь от шаха.', '— и шаха больше нет.') },
  {
    id: 'reason.escape',
    role: 'tail',
    byPiece: true,
    freq: 1.5,
    fallback: 'reason.good',
    wordings: w('— уводишь {коня} из-под боя.', '— {конь} убегает от удара!', '— спасаешь {коня}!', '— уходишь из-под боя.', '— и опасность позади!'),
  },
  {
    id: 'reason.defend',
    role: 'tail',
    byPiece: true,
    freq: 1.2,
    fallback: 'reason.good',
    wordings: w('— защищаешь {коня}.', '— {конь} теперь под защитой.', '— прикрываешь {коня}.', '— ставишь защиту!', '— и всё под защитой.'),
  },
  { id: 'reason.block', role: 'tail', byPiece: true, fallback: 'reason.good', wordings: w('— закрываешь {коня} от удара.', '— закрываешься от удара.') },
  { id: 'reason.threatMate', role: 'tail', fallback: 'reason.good', wordings: w('— и грозишь матом!', '— теперь угроза мата!') },
  {
    id: 'reason.attack',
    role: 'tail',
    byPiece: true,
    freq: 2.5,
    fallback: 'reason.good',
    wordings: w('— нападаешь на {коня}!', '— и нападаешь на {коня}!', '— {конь} соперника под ударом!', '— атакуешь {коня}!', '— и сразу в атаку!', '— это нападение!'),
  },
  { id: 'reason.check', role: 'tail', fallback: 'reason.good', wordings: w('— и это шах!', '— шах королю!', '— ставишь шах!') },
  { id: 'reason.castle', role: 'tail', freq: 1.0, fallback: 'reason.good', wordings: w('— король прячется в домик.', '— король в безопасности!', '— прячешь короля!', '— король в домике, ладья в игре!') },
  {
    id: 'reason.develop',
    role: 'tail',
    byPiece: ['n', 'b'],
    freq: 3.0,
    fallback: 'reason.good',
    wordings: w('— выводишь {коня} в игру.', '— {конь} выходит в бой!', '— будишь {коня}!', '— {конь} просыпается!', '— ещё одна фигура в игре!', '— выводишь фигуру в игру.'),
  },
  { id: 'reason.centerPawn', role: 'tail', freq: 1.5, fallback: 'reason.good', wordings: w('— ставишь пешку в центр.', '— пешка встаёт в центр!', '— занимаешь центр!', '— центр наш!') },
  { id: 'reason.fightCenter', role: 'tail', freq: 1.0, fallback: 'reason.good', wordings: w('— нападаешь на пешку в центре.', '— бьёмся за центр!', '— споришь за центр!', '— и центр под ударом!') },
  { id: 'reason.supportCenter', role: 'tail', freq: 1.0, fallback: 'reason.good', wordings: w('— поддерживаешь пешку в центре.', '— укрепляешь центр.', '— готовишь пешке дорогу в центр.', '— центр становится крепче!') },
  { id: 'reason.openLine', role: 'tail', fallback: 'reason.good', wordings: w('— открываешь дорогу фигурам.', '— освобождаешь дорогу слону.', '— фигурам становится просторно!') },
  { id: 'reason.aimWeakSquare', role: 'tail', fallback: 'reason.good', wordings: w('— целишься в слабую клетку у короля!', '— целишься в слабое место!') },
  { id: 'reason.prepareCastle', role: 'tail', fallback: 'reason.good', wordings: w('— готовишь рокировку.', '— освобождаешь место для рокировки.') },
  { id: 'reason.centerControl', role: 'tail', fallback: 'reason.good', wordings: w('— смотришь в центр.', '— фигура смотрит в центр.') },
  { id: 'reason.connectRooks', role: 'tail', fallback: 'reason.good', wordings: w('— соединяешь ладьи.', '— ладьи видят друг друга!') },
  { id: 'reason.rookOpenFile', role: 'tail', fallback: 'reason.good', wordings: w('— ставишь ладью на открытую линию.', '— ладья выходит на простор!') },
  { id: 'reason.rookSeventh', role: 'tail', fallback: 'reason.good', wordings: w('— врываешься ладьёй на седьмую горизонталь!', '— ладья врывается в лагерь соперника!') },
  { id: 'reason.passedPawn', role: 'tail', fallback: 'reason.good', wordings: w('— двигаешь проходную пешку!', '— проходная бежит вперёд!') },
  // (a pawn trade too: no «фигурами» — the explainer says «меняешься пешками» / «меняешь коня на слона»)
  { id: 'reason.trade', role: 'tail', fallback: 'reason.good', wordings: w('— это размен.', '— и меняемся!', '— размен, и всё проще.') },
  { id: 'reason.space', role: 'tail', fallback: 'reason.good', wordings: w('— забираешь себе место.', '— отвоёвываешь место!') },
  { id: 'reason.kingActivity', role: 'tail', fallback: 'reason.good', wordings: w('— король идёт в бой.', '— король помогает!') },
  { id: 'reason.restrictKing', role: 'tail', fallback: 'reason.good', wordings: w('— загоняешь короля к краю.', '— королю соперника всё теснее!') },
  { id: 'reason.opposition', role: 'tail', fallback: 'reason.good', wordings: w('— встаёшь в оппозицию.', '— король против короля!') },
  {
    id: 'reason.improvePiece',
    role: 'tail',
    byPiece: ['n', 'b', 'r', 'q'],
    fallback: 'reason.good',
    wordings: w('— {конь} встаёт активнее.', '— ставишь {коня} поудобнее.', '— фигура встаёт активнее.'),
  },
  // a promotion says what the pawn becomes (the move's own tail, instead of a reason)
  { id: 'move.promo', role: 'tail', byPiece: ['q', 'r', 'b', 'n'], fallback: 'reason.good', wordings: w('— и станет {конём}!', '— и превратится в {коня}!', '— и превращение!') },
  // a plan move whose reason is the plan itself (the card's step, a goal naming the move)
  { id: 'teach.tail.plan', role: 'tail', freq: 1.0, fallback: 'reason.good', wordings: w('— это по нашему плану.', '— так и задумано!', '— всё по плану!', '— это наш план.') },
  // the choice turn: «Или синяя стрелка: … — выбирай!»
  { id: 'teach.tail.choose', role: 'tail', byGender: true, wordings: w('— выбирай!', '— решай {g:сам|сама}!', '— что выберешь?', '— тебе решать!') },
  // a take-back reminder: what the played move loses
  { id: 'takeback.tail.lost', role: 'tail', byPiece: true, wordings: w('— а так соперник заберёт {коня}!', '— а сейчас {твой} {конь} под ударом!', '— а сейчас что-то теряется!') },
];

// ───────────────────────── the plan GOALS of the strategies, as tails, without squares ─────────────────────────

/**
 * `goal.<key>`: the goals of the strategy library (`planGoalsRu` of @gambit/content) as reason tails of a plan move.
 * Squares are left out (they are said only by the advice's slot); several library goals share one line. The library
 * text → line map is `PLAN_GOAL_LINES` (./catalog.ru.ts), checked against the real library in catalog.test.ts.
 */
const GOALS: readonly ClipCatalogLine[] = [
  { id: 'goal.aimF7', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— целимся слоном в слабую точку!', '— слон смотрит на слабую точку!') },
  { id: 'goal.holdCentre', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— крепко держим центр!', '— держим центр пешками.', '— центр наш, держим его!') },
  { id: 'goal.centreStrike', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— готовим удар пешкой в центре!', '— готовим пешку в центр!') },
  { id: 'goal.bothKnights', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— выводим обоих коней к центру.', '— оба коня в бой!') },
  { id: 'goal.pinKnight', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— связываем коня соперника слоном!', '— слон держит коня соперника!') },
  { id: 'goal.bishopFirst', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— выводим слона раньше пешек!', '— слон выходит первым!') },
  { id: 'goal.pawnFortress', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— строим крепость из пешек!', '— пешки встают крепостью!') },
  { id: 'goal.knightJump', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— прыгаем конём в центр!', '— конь скачет в центр!') },
  { id: 'goal.bishopAtKing', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— слон смотрит на короля соперника!', '— целимся слоном в короля!') },
  { id: 'goal.fightCentre', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— сразу бьёмся за центр!', '— сразу спорим за центр!') },
  { id: 'goal.openLines', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— выводим фигуры на открытые линии.', '— фигуры выходят на простор!') },
  { id: 'goal.knightHoldsCentre', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— конь крепко держит центр.', '— держим центр конём!') },
  { id: 'goal.pressKnight', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— давим слоном на коня соперника!', '— слон давит на защитника центра!') },
  { id: 'goal.rookCentre', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— ставим ладью в помощь центру.', '— ладья помогает центру!') },
  { id: 'goal.hitCentre', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— бьём пешкой по центру соперника!', '— бьём по центру!') },
  { id: 'goal.rookFile', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— давим ладьёй по линии цэ!', '— ладья давит по открытой линии!') },
  { id: 'goal.takeCentre', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— занимаем центр пешкой!', '— пешка встаёт в центр!') },
  { id: 'goal.developAll', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— быстро выводим все фигуры!', '— все фигуры в игру!') },
  { id: 'goal.castle', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— прячем короля рокировкой.', '— король уходит в домик!') },
  { id: 'goal.pressCentrePawn', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— давим на пешку в центре!', '— нападаем на пешку в центре!') },
  { id: 'goal.chaseBishop', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— прогоняем слона соперника пешками!', '— гоним слона соперника!') },
  { id: 'goal.chain', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— бьём по цепочке пешек сбоку!', '— ломаем цепочку пешек!') },
  { id: 'goal.flankCentre', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— спорим за центр сбоку!', '— бьёмся за центр с краю!') },
  { id: 'goal.longDiagonal', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— ставим слона на длинную диагональ!', '— слон смотрит по длинной диагонали!') },
  { id: 'goal.tradeForSpace', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— меняем фигуры, чтобы стало просторнее.', '— разменяемся, и станет свободнее!') },
  { id: 'goal.freeBishop', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— освобождаем слона ударом в центре!', '— выпускаем слона на свободу!') },
  { id: 'goal.holdSquare', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— держим важную клетку в центре!', '— эта клетка в центре наша!') },
  { id: 'goal.attackKing', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— идём в атаку на короля!', '— готовим атаку на короля!') },
  { id: 'goal.developCastle', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— выводим фигуры и прячем короля.', '— фигуры в игру, король в домик!') },
  { id: 'goal.queensidePawns', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— двигаем пешки ферзевого фланга вперёд.', '— пешки на ферзевом фланге идут вперёд!') },
  { id: 'goal.pawnStorm', role: 'tail', fallback: 'teach.tail.plan', wordings: w('— готовим пешку к рывку вперёд!', '— пешка готовится к рывку!') },
];

// ───────────────────────── the opponent's move — piece only, never a square ─────────────────────────

/**
 * `opp.*`: «Соперник вывел коня.» — ≈ 5 per game in the harvest; the square is on the board. At most half of a pool
 * opens with «Соперник» (heard ≈ 5 times a game, the same opener would sound programmed — catalog.test.ts).
 */
const OPPONENT: readonly ClipCatalogLine[] = [
  { id: 'opp.earlyQueen', role: 'whole', wordings: w('Соперник рано вывел ферзя.', 'Ого, ферзь соперника уже вышел!', 'Ферзь соперника вышел слишком рано.', 'Рановато он вывел ферзя!') },
  {
    id: 'opp.took',
    role: 'whole',
    byPiece: true,
    freq: 1.2,
    wordings: w('Соперник забрал {твоего} {коня}.', 'Ой, {твоего} {коня} забрали!', 'Он съел {твоего} {коня}.', 'Хоп — и {твой} {конь} {p:ушёл|ушла} с доски.', 'Соперник сделал взятие.', 'Ой, у тебя что-то забрали!'),
  },
  { id: 'opp.castled', role: 'whole', wordings: w('Соперник сделал рокировку.', 'Он спрятал короля в домик.', 'Король соперника спрятался — это рокировка.', 'Соперник рокировался.') },
  {
    id: 'opp.attack',
    role: 'whole',
    byPiece: true,
    freq: 1.2,
    wordings: w('Соперник напал на {твоего} {коня}!', 'Ой, на {твоего} {коня} напали!', 'Он нацелился на {твоего} {коня}.', '{Твой} {конь} под ударом!', 'Соперник пошёл в атаку!', 'Берегись, он нападает!'),
  },
  { id: 'opp.mateThreat', role: 'whole', wordings: w('Соперник грозит матом!', 'Ой-ой, он грозит матом!', 'Он хочет поставить мат!', 'Осторожно: соперник целится в короля!') },
  { id: 'opp.check', role: 'whole', wordings: w('Соперник объявил шах.', 'Шах от соперника!', 'Ой, нашему королю шах!', 'Нам шах!') },
  {
    id: 'opp.developed',
    role: 'whole',
    byPiece: ['n', 'b'],
    freq: 1.2,
    wordings: w('Соперник вывел {коня}.', 'Ага, {конь} соперника вышел в игру!', '{Конь} соперника проснулся.', 'Он разбудил {коня}.', 'Ещё одна фигура соперника в игре.'),
  },
  { id: 'opp.pawn', role: 'whole', freq: 1.0, wordings: w('Соперник пошёл пешкой.', 'Пешка шагнула вперёд.', 'Он двинул пешку.', 'Ага, пешка соперника пошла!') },
  {
    id: 'opp.moved',
    role: 'whole',
    byPiece: ['n', 'b', 'r', 'q', 'k'],
    wordings: w('Соперник пошёл {конём}.', 'Он сходил {конём}.', 'Ага, {конь} соперника {p:переехал|переехала}.', 'Соперник сделал ход.'),
  },
];

// ───────────────────────── dangers — piece only ─────────────────────────

/** «Осторожно» ≈ 6 per game: the biggest pools. The red square is on the board. */
const DANGERS: readonly ClipCatalogLine[] = [
  { id: 'danger.check', role: 'whole', wordings: w('Шах! Сначала спасаем короля.', 'Нам шах! Спасаем короля.', 'Шах! Королю надо спасаться.', 'Шах! Сначала король.') },
  {
    id: 'danger.mate',
    role: 'whole',
    freq: 0.8,
    wordings: w('Осторожно: соперник грозит матом!', 'Внимание: соперник грозит матом!', 'Стоп! Соперник хочет поставить мат!', 'Берегись: угроза мата!', 'Ой-ой, угроза мата! Защищаем короля.'),
  },
  {
    id: 'danger.hanging',
    role: 'whole',
    byPiece: true,
    freq: 5.0,
    wordings: w(
      'Осторожно: {твой} {конь} под боем!',
      '{Твой} {конь} под боем!',
      'Ой-ой, {твой} {конь} в опасности!',
      'Смотри: {твоего} {коня} могут забрать!',
      'Внимание: {твой} {конь} без защиты!',
      'Берегись: на {твоего} {коня} напали!',
      'Осторожно: у тебя кое-что под боем!',
      'Осторожно, тут опасно!',
    ),
  },
  { id: 'danger.threat', role: 'whole', freq: 1.0, wordings: w('Осторожно: соперник что-то задумал!', 'Хм, соперник что-то готовит!', 'Внимание: у соперника есть идея!', 'Соперник хитрит — посмотри внимательно!') },
  { id: 'danger.fork', role: 'whole', fallback: 'danger.threat', wordings: w('Осторожно: соперник готовит вилку!', 'Берегись: пахнет вилкой!', 'Внимание: соперник задумал вилку!', 'Ой, соперник хочет сделать вилку!') },
];

// ───────────────────────── treasures — piece only; the move is found by the child ─────────────────────────

/** «Смотри, тут подарок» ≈ 6.5 per game (weak bots leave many gifts). The move is said only by the reveal. */
const TREASURES: readonly ClipCatalogLine[] = [
  { id: 'treasure.gift', role: 'whole', freq: 1.0, wordings: w('Смотри, тут подарок!', 'Ого, на доске подарок!', 'Вижу подарок!', 'Кажется, соперник что-то забыл защитить!') },
  { id: 'treasure.mate1', role: 'whole', freq: 1.0, fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: есть мат в один ход!', 'Ого, тут мат в один ход!', 'Подарок: можно сразу поставить мат!', 'Вижу мат в один ход!') },
  { id: 'treasure.mate2', role: 'whole', fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: есть мат в два хода!', 'Ого, тут мат в два хода!', 'Вижу мат в два хода!') },
  { id: 'treasure.mate3', role: 'whole', fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: есть мат в три хода!', 'Тут прячется мат в три хода!', 'Вижу мат в три хода!') },
  {
    id: 'treasure.free',
    role: 'whole',
    byPiece: true,
    freq: 3.5,
    fallback: 'treasure.gift',
    wordings: w(
      'Смотри, тут подарок: {конь} соперника без защиты!',
      'Ого, {конь} соперника стоит без защиты!',
      'Смотри: {коня} соперника можно забрать бесплатно!',
      'Подарок: {конь} соперника никем не {p:защищён|защищена}!',
      'Вижу подарок: {конь} соперника без охраны!',
      'Смотри, у соперника фигура без защиты!',
    ),
  },
  {
    id: 'treasure.win',
    role: 'whole',
    byPiece: true,
    freq: 1.0,
    fallback: 'treasure.gift',
    wordings: w('Смотри, тут подарок: {коня} соперника можно выгодно забрать!', 'Ого, {коня} соперника можно выгодно забрать!', 'Можно выгодно забрать {коня} соперника!', 'Смотри, тут есть выгодное взятие!'),
  },
  { id: 'treasure.fork', role: 'whole', fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: есть вилка!', 'Ого, тут можно сделать вилку!', 'Вижу вилку!') },
  { id: 'treasure.pin', role: 'whole', fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: есть связка!', 'Ого, тут можно связать фигуру!', 'Вижу связку!') },
  { id: 'treasure.skewer', role: 'whole', fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: есть сквозной удар!', 'Вижу сквозной удар!') },
  { id: 'treasure.discovered', role: 'whole', fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: есть вскрытое нападение!', 'Вижу вскрытое нападение!') },
  { id: 'treasure.doubleCheck', role: 'whole', fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: есть двойной шах!', 'Вижу двойной шах!') },
  { id: 'treasure.removeDefender', role: 'whole', fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: можно убрать защитника!', 'Вижу, как убрать защитника!') },
  { id: 'treasure.trapped', role: 'whole', fallback: 'treasure.gift', wordings: w('Смотри, тут подарок: можно поймать фигуру соперника!', 'Ого, фигуру соперника можно поймать!') },
  // the question after the treasure (6.2 per game)
  {
    id: 'ask.find',
    role: 'whole',
    byGender: true,
    freq: 6.2,
    wordings: w('Найдёшь ход {g:сам|сама}?', 'Сможешь найти {g:сам|сама}?', 'Попробуй найти {g:сам|сама}!', 'Где же он? Поищи!', 'Найдёшь, какой ход?', 'Поищешь?', 'Ну-ка, найди его!', 'Какой ход? Ищи!'),
  },
  // after «Совет» with one move / a choice
  { id: 'ask.decide', role: 'whole', byGender: true, freq: 1.5, wordings: w('Решай {g:сам|сама}!', 'Выбирай!', 'Тебе решать!', 'Ход за тобой!') },
];

// ───────────────────────── the rest of a teacher turn ─────────────────────────

const TURN: readonly ClipCatalogLine[] = [
  // the reveal without a move to show (no engine line)
  { id: 'reveal.none', role: 'whole', wordings: w('Посмотри ещё раз на фигуры соперника без защиты.', 'Поищи фигуру соперника без защиты!') },
  { id: 'teach.hurry', role: 'whole', wordings: w('Поторопись!', 'Поспеши!', 'Давай побыстрее!', 'Живее, живее!') },
  { id: 'teach.rules', role: 'whole', wordings: w('Точно проверить ходы сейчас не могу.', 'Сейчас я не могу точно проверить ходы.') },
  { id: 'teach.noAdvice', role: 'whole', wordings: w('Сначала проверь, что хочет соперник, потом — шахи, взятия и угрозы.', 'Что хочет соперник? Потом — шахи, взятия, угрозы.') },
  { id: 'teach.calm.noAdvice', role: 'whole', wordings: w('Всё спокойно — подумай, какая фигура стоит хуже всех.', 'Спокойная позиция. Какая фигура стоит хуже всех?') },
  // the glued reaction: an own good move (the only one still said, TEACH_EXTRA_ORDER 'ownGood')
  {
    id: 'react.ownGood',
    role: 'whole',
    byGender: true,
    wordings: w('Ты {g:выбрал|выбрала} свой ход — и он тоже хороший!', 'Свой ход — и тоже хороший!', 'Твой ход тоже хороший — молодец!', 'Отличный ход, и ты {g:нашёл|нашла} его {g:сам|сама}!'),
  },
  { id: 'react.leftBook', role: 'whole', byGender: true, fallback: 'react.ownGood', wordings: w('Ты {g:свернул|свернула} со знакомой дороги — ничего, ход хороший!', 'Новая дорога — тоже хорошо!') },
  // the opponent left the strategy's road
  {
    id: 'teach.deviation.same',
    role: 'whole',
    wordings: w('Соперник свернул с нашей дороги, но план тот же.', 'Соперник пошёл по-своему, а план у нас прежний!', 'Соперник свернул с дороги — ничего, план тот же!'),
  },
  { id: 'teach.deviation', role: 'whole', fallback: 'teach.deviation.same', wordings: w('Соперник свернул с нашей дороги!', 'Соперник пошёл другой дорогой!', 'Ого, соперник свернул с нашей дороги!') },
  {
    id: 'teach.deviation.rules',
    role: 'whole',
    fallback: 'teach.deviation',
    wordings: w('Соперник свернул с дороги — играем по правилам!', 'Соперник пошёл по-своему — играем по правилам: центр, фигуры, рокировка!'),
  },
  // plans of the position (§5.1 middlegame / endgame, the opening by the principles)
  { id: 'plan.principles', role: 'whole', wordings: w('План простой: пешку в центр, фигуры в игру, потом рокировка.', 'Наш план: центр, фигуры, рокировка!') },
  { id: 'plan.castleSoon', role: 'whole', wordings: w('Король ещё в центре — спрячь его рокировкой.', 'Пора прятать короля: сделай рокировку!', 'Королю неуютно в центре — рокируйся!') },
  { id: 'plan.tradeWhenAhead', role: 'whole', wordings: w('У тебя больше фигур: меняйся фигурами — так легче выиграть.', 'Ты впереди — меняй фигуры, и победа ближе!') },
  { id: 'plan.mateTechnique', role: 'whole', wordings: w('Загоняем короля к краю — твой король помогает!', 'Прижимаем короля соперника к краю доски!') },
  { id: 'plan.kingToCenter', role: 'whole', wordings: w('В эндшпиле король — боец: веди его к центру.', 'Король, вперёд — к центру доски!') },
  { id: 'plan.pushPassed', role: 'whole', wordings: w('Проходная пешка — веди её к превращению!', 'Проходная пешка бежит в ферзи!') },
  {
    id: 'plan.improve',
    role: 'whole',
    byPiece: ['n', 'b', 'r', 'q'],
    wordings: w('{Твой} {конь} почти не ходит — найди {ему} место получше.', '{Конь} стоит без дела — найди {ему} место получше!', 'Одна фигура скучает — найди ей место получше.'),
  },
  // a new topic of the turn: the card's idea in one sentence (the others are not recorded: the bridge / nothing)
  { id: 'topic.opening-center', role: 'whole', wordings: w('Пешка в центре даёт место фигурам и открывает им дорогу.') },
  { id: 'topic.opening-development', role: 'whole', wordings: w('Каждым ходом — новая фигура в игру!') },
  { id: 'topic.opening-king-safety', role: 'whole', wordings: w('Рокировка прячет короля в домик и будит ладью.') },
  { id: 'topic.opening-early-queen', role: 'whole', wordings: w('Ферзь самый дорогой — рано выводить его опасно.') },
  { id: 'topic.hanging-piece', role: 'whole', wordings: w('Фигура без защиты — лёгкая добыча. Проверяй защиту!') },
  { id: 'topic.free-capture', role: 'whole', wordings: w('Если фигура соперника без защиты — её можно забрать бесплатно.') },
  { id: 'topic.bad-trade', role: 'whole', wordings: w('Меняйся с умом: отдавай дешёвое, забирай дорогое.') },
  { id: 'topic.fork', role: 'whole', wordings: w('Вилка — это нападение сразу на две фигуры.') },
  { id: 'topic.pin', role: 'whole', wordings: w('Связка: фигура не может уйти, за ней стоит фигура подороже.') },
  { id: 'topic.skewer', role: 'whole', wordings: w('Сквозной удар: дорогая фигура уходит, и мы забираем ту, что за ней.') },
  { id: 'topic.mate-in-1', role: 'whole', wordings: w('Мат — это шах, от которого королю некуда спрятаться.') },
  { id: 'topic.scholars-mate', role: 'whole', wordings: w('Детский мат: ферзь и слон вместе бьют в слабую точку.') },
  { id: 'topic.back-rank-mate', role: 'whole', wordings: w('Королю нужна форточка, иначе мат на последней линии.') },
  { id: 'topic.promotion', role: 'whole', wordings: w('Пешка, которая дошла до конца доски, становится ферзём!') },
];

export const TEACH_CATALOG: readonly ClipCatalogLine[] = [...HEADS, ...REASONS, ...GOALS, ...OPPONENT, ...DANGERS, ...TREASURES, ...TURN];
