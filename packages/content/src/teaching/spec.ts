/**
 * The pools of «Учитель» (docs/TEACHING.md §5): every situation the lesson engine can speak about, what it means,
 * whose piece its placeholders take, what the board highlights and how many wordings it needs at every stage.
 * This file is the contract between the words (./lines/*.ru.ts) and the engine (@gambit/core coach/lesson/).
 * Wordings live elsewhere; `LESSON_LINES` (./index.ts) joins them; core `lesson/content.test.ts` checks the gates.
 */
import type { CueKind } from '@gambit/shared';
import type { LessonPoolSpec, LessonStage, LessonSubject } from './types.ts';

type Opt = {
  subject?: LessonSubject;
  stages?: readonly [LessonStage, LessonStage];
  maxSentences?: 1 | 2 | 3;
  banded?: boolean;
  variants?: readonly string[];
};

const pool = (id: string, role: LessonPoolSpec['role'], cue: readonly CueKind[], min: number, purpose: string, o: Opt = {}): LessonPoolSpec => ({
  id,
  role,
  cue,
  min,
  purpose,
  ...(o.subject ? { subject: o.subject } : {}),
  ...(o.stages ? { stages: o.stages } : {}),
  ...(o.maxSentences ? { maxSentences: o.maxSentences } : {}),
  ...(o.banded ? { stageMode: 'banded' as const } : {}),
  ...(o.variants ? { variants: o.variants } : {}),
});

const YOUNG: readonly [LessonStage, LessonStage] = [1, 2];
const OLD: readonly [LessonStage, LessonStage] = [3, 5];

// ───────────────────────── the move ideas (ids of core `MoveIdeaId`, kept equal by a core test) ─────────────────────────

export const LESSON_IDEA_IDS = [
  'mate', 'mateSoon', 'promotion', 'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'removeDefender', 'trappedPiece',
  'freeCapture', 'winMaterial', 'recapture', 'defendMate', 'answerCheck', 'escape', 'defend', 'block', 'threatMate', 'attack',
  'check', 'castle', 'develop', 'centerPawn', 'fightCenter', 'supportCenter', 'openLine', 'aimWeakSquare', 'prepareCastle',
  'centerControl', 'connectRooks', 'rookOpenFile', 'rookSeventh', 'passedPawn', 'trade', 'space', 'kingActivity', 'restrictKing',
  'opposition', 'improvePiece', 'quiet',
] as const;
export type LessonIdeaId = (typeof LESSON_IDEA_IDS)[number];

interface IdeaSpec {
  cue: readonly CueKind[];
  min: number;
  subject?: LessonSubject;
  what: string;
  /** sub-cases set by core's detector as `MoveIdea.variant` (docs/TEACHING.md §6) */
  variants?: readonly string[];
}

/**
 * The idea tails `v3.idea.<id>`: the WHY of an advised move after a lead with the moving piece
 * («Давай сходим {конём}» + «— оттуда он смотрит в центр.»). A wording must be true whenever core's detector of that
 * idea (and of the variants it lists in `when`) fires — the detectors: packages/core/src/coach/moveIdeas.ts.
 * Tense: «мы»-future / present («— займём центр», «— он встанет ближе к центру»), fits after any lead.
 */
export const IDEA_TAILS: Readonly<Record<LessonIdeaId, IdeaSpec>> = {
  mate: { cue: ['king'], min: 6, what: 'ход ставит мат' },
  mateSoon: { cue: ['king'], min: 6, what: 'ход ведёт к мату (m2 — в два хода, m3 — в три, backRank — по последнему ряду, король заперт своими пешками)', variants: ['m2', 'm3', 'backRank'] },
  promotion: { cue: ['path'], min: 6, subject: 'mover', what: 'пешка превращается (обычно в ферзя)' },
  fork: { cue: ['attacks'], min: 6, what: 'после хода наша фигура нападает сразу на две фигуры соперника и выигрывает одну (вилка; ступени 1–2: «двойной удар»)' },
  pin: { cue: ['line'], min: 6, subject: 'target', what: 'связка: фигуре соперника (target) нельзя уйти — за ней стоит король (king), ферзь (queen) или ладья (rook)', variants: ['king', 'queen', 'rook'] },
  skewer: { cue: ['line'], min: 5, subject: 'target', what: 'сквозной удар: дорогая фигура (target) уйдёт — заберём ту, что за ней (king — это король, queen — ферзь)', variants: ['king', 'queen'] },
  discoveredAttack: { cue: ['line'], min: 5, what: 'наша фигура отходит и открывает дорогу другой — та нападает' },
  doubleCheck: { cue: ['king'], min: 4, what: 'двойной шах: королю остаётся только уйти' },
  removeDefender: { cue: ['capture'], min: 5, subject: 'target', what: 'забираем защитника (target) — фигура за ним остаётся без защиты' },
  trappedPiece: { cue: ['piece'], min: 5, subject: 'target', what: 'фигуре соперника (target) некуда уйти — поймаем её' },
  freeCapture: { cue: ['capture'], min: 10, subject: 'target', what: 'съедаем фигуру соперника (target), которую никто не защищает' },
  winMaterial: { cue: ['capture'], min: 8, subject: 'target', what: 'выгодно бьём фигуру (target): её защищают, но после размена мы в плюсе (НЕ «без защиты»)' },
  recapture: { cue: ['capture'], min: 8, subject: 'target', what: 'забираем обратно фигуру (target), которая только что съела нашу (even — это просто размен, gain — и ещё в плюсе)', variants: ['even', 'gain'] },
  defendMate: { cue: ['threat', 'king'], min: 8, what: 'ход закрывает угрозу мата нашему королю (мата после хода нет совсем)' },
  answerCheck: { cue: ['king'], min: 8, what: 'спасаемся от шаха: capture — съедаем фигуру, которая шахует; king — уходим королём; block — закрываемся', variants: ['capture', 'king', 'block'] },
  escape: { cue: ['piece'], min: 10, subject: 'mover', what: 'уводим фигуру (mover) из-под удара в безопасное место' },
  defend: { cue: ['defend'], min: 10, subject: 'defended', what: 'ход защищает нашу фигуру под ударом (defended)' },
  block: { cue: ['line', 'defend'], min: 6, subject: 'defended', what: 'закрываем нашу фигуру (defended) от дальнобойной фигуры соперника' },
  threatMate: { cue: ['king'], min: 6, what: 'после хода мы грозим мат' },
  attack: { cue: ['capture'], min: 10, subject: 'target', what: 'нападаем на фигуру соперника (target), которую выгодно взять следующим ходом (one — одна цель; two — сразу две, но это ещё не вилка; queenDevelop — выводим фигуру и нападаем на ферзя)', variants: ['one', 'two', 'queenDevelop'] },
  check: { cue: ['king'], min: 8, what: 'шах: королю соперника придётся спасаться' },
  castle: { cue: ['king'], min: 6, what: 'рокировка (обычно говорится целой фразой v3.whole.castle)' },
  develop: { cue: ['attacks'], min: 12, subject: 'mover', what: 'конь или слон выходит из дома в игру (center — после хода он бьёт хотя бы одну клетку центра; plain — нет, «в центр» тогда не говорить)', variants: ['center', 'plain'] },
  centerPawn: { cue: ['center'], min: 10, what: 'пешка встаёт в центр' },
  fightCenter: { cue: ['center'], min: 8, what: 'пешка нападает на пешку соперника в центре' },
  supportCenter: { cue: ['center'], min: 8, what: 'pawn — пешка поддерживает нашу пешку в центре; step — готовит пешке дорогу в центр', variants: ['pawn', 'step'] },
  openLine: { cue: ['line'], min: 8, what: 'ход пешкой открывает дорогу нашему слону или ферзю (диагональ)' },
  aimWeakSquare: { cue: ['weak', 'line'], min: 8, subject: 'mover', what: 'слон или ферзь нацеливается на слабую пешку рядом с королём соперника (пешка на месте, король дома)' },
  prepareCastle: { cue: ['king'], min: 8, what: 'фигура уходит с дороги короля — скоро можно сделать рокировку' },
  centerControl: { cue: ['attacks', 'center'], min: 8, subject: 'mover', what: 'фигура после хода бьёт больше клеток центра (только вторая идея)' },
  connectRooks: { cue: ['line'], min: 6, what: 'ладьи видят друг друга — дебют почти закончен' },
  rookOpenFile: { cue: ['line'], min: 6, what: 'ладья встаёт на open — открытую вертикаль (без пешек), halfOpen — полуоткрытую (без наших пешек)', variants: ['open', 'halfOpen'] },
  rookSeventh: { cue: ['line'], min: 5, what: 'ладья врывается в лагерь соперника, к его пешкам' },
  passedPawn: { cue: ['path'], min: 8, subject: 'mover', what: 'двигаем проходную пешку к превращению (ей никто не мешает)' },
  trade: { cue: ['capture'], min: 8, subject: 'target', what: 'размен (same — одинаковые фигуры; diff — разные, но равные по цене; ahead — у нас больше материала, размены нам выгодны)', variants: ['same', 'diff', 'ahead'] },
  space: { cue: ['flank'], min: 6, what: 'пешка на фланге ферзя (a–c) продвинулась вперёд и забирает место у соперника' },
  kingActivity: { cue: ['king', 'center'], min: 8, what: 'эндшпиль, король идёт: center — к центру; forward — вперёд; pawns — к пешкам', variants: ['center', 'forward', 'pawns'] },
  restrictKing: { cue: ['king'], min: 6, what: 'у соперника один король: отнимаем у него клетки, гоним к краю' },
  opposition: { cue: ['king'], min: 4, what: 'короли друг напротив друга через клетку — чужой должен уступить', },
  improvePiece: { cue: ['attacks'], min: 8, subject: 'mover', what: 'фигура встаёт активнее: оттуда стреляет по большему числу клеток' },
  quiet: { cue: [], min: 8, what: 'честный спокойный ход без особой идеи' },
};

/** The ideas with an idea-first lead `v3.aim.<id>` (shape B / D of docs/TEACHING.md §2.3). */
export const AIM_IDEAS: readonly LessonIdeaId[] = [
  'develop', 'centerPawn', 'fightCenter', 'supportCenter', 'openLine', 'aimWeakSquare', 'prepareCastle', 'connectRooks',
  'attack', 'freeCapture', 'winMaterial', 'recapture', 'trade', 'escape', 'defend', 'defendMate', 'answerCheck', 'check', 'threatMate',
  'improvePiece', 'passedPawn', 'promotion', 'kingActivity', 'restrictKing', 'rookOpenFile',
];

/** The ideas with a question-and-answer form `v3.q.<id>` + `v3.helper` (shape E). */
export const QUESTION_IDEAS: readonly LessonIdeaId[] = ['develop', 'centerPawn', 'fightCenter', 'defend', 'attack', 'freeCapture', 'recapture', 'check'];

/** The ideas with an outcome line `v3.result.<id>` — said after the child followed the arrow (never praise). */
export const RESULT_IDEAS: readonly LessonIdeaId[] = [
  'develop', 'centerPawn', 'fightCenter', 'supportCenter', 'openLine', 'aimWeakSquare', 'prepareCastle', 'castle', 'connectRooks',
  'attack', 'freeCapture', 'winMaterial', 'recapture', 'trade', 'escape', 'defend', 'defendMate', 'answerCheck', 'check',
  'improvePiece', 'passedPawn', 'kingActivity', 'rookOpenFile',
];

// ───────────────────────── strategies (ids of STRATEGIES) and theme families ─────────────────────────

export const LESSON_STRATEGY_IDS = [
  'italian', 'four-knights', 'london', 'bishops-opening', 'colle', 'scotch', 'vienna', 'spanish', 'queens-gambit',
  'open-game', 'two-knights', 'french', 'scandinavian', 'sicilian', 'caro-kann',
  'orthodox', 'slav', 'dutch-stonewall', 'kings-indian',
  'classic-development', 'kings-indian-setup', 'queens-indian-setup', 'botvinnik-system', 'reversed-sicilian',
] as const;

export const LESSON_THEME_FAMILIES = ['center', 'counterCenter', 'development', 'castle', 'f7', 'fortress', 'gambit', 'openFile', 'kingsideAttack', 'queensideAttack'] as const;
export type LessonThemeFamily = (typeof LESSON_THEME_FAMILIES)[number];

const FAMILY_CUE: Readonly<Record<LessonThemeFamily, readonly CueKind[]>> = {
  center: ['center'],
  counterCenter: ['center'],
  development: [],
  castle: ['king'],
  f7: ['weak'],
  fortress: ['center'],
  gambit: ['center'],
  openFile: ['line'],
  kingsideAttack: ['flank'],
  queensideAttack: ['flank'],
};

const FAMILY_WHAT: Readonly<Record<LessonThemeFamily, string>> = {
  center: 'занимаем и держим центр пешками и фигурами',
  counterCenter: 'бьём по центру соперника сбоку и спорим за него',
  development: 'быстро выводим все фигуры и прячем короля',
  castle: 'прячем короля в крепость пораньше',
  f7: 'быстро выводим фигуры и целимся в слабую пешку рядом с королём соперника',
  fortress: 'строим крепость из пешек в центре и спокойно выводим фигуры',
  gambit: 'отдаём пешку, чтобы забрать центр и быстрее вывести фигуры',
  openFile: 'ставим ладьи на открытые линии',
  kingsideAttack: 'готовим атаку на короля соперника',
  queensideAttack: 'играем пешками и фигурами на стороне ферзя',
};

/** The goals of the library cards (`goal.<key>` of core clips PLAN_GOAL_LINES), squareless. */
export const LESSON_GOAL_KEYS = [
  'aimF7', 'holdCentre', 'centreStrike', 'bothKnights', 'pinKnight', 'bishopFirst', 'pawnFortress', 'knightJump', 'bishopAtKing',
  'fightCentre', 'openLines', 'knightHoldsCentre', 'pressKnight', 'rookCentre', 'hitCentre', 'rookFile', 'takeCentre', 'developAll',
  'castle', 'pressCentrePawn', 'chaseBishop', 'chain', 'flankCentre', 'longDiagonal', 'tradeForSpace', 'freeBishop', 'holdSquare',
  'attackKing', 'developCastle', 'queensidePawns', 'pawnStorm',
] as const;
export type LessonGoalKey = (typeof LESSON_GOAL_KEYS)[number];

const GOAL_CUE: Readonly<Record<LessonGoalKey, readonly CueKind[]>> = {
  aimF7: ['weak', 'line'], holdCentre: ['center'], centreStrike: ['center'], bothKnights: ['center'], pinKnight: ['line'],
  bishopFirst: ['piece'], pawnFortress: ['center'], knightJump: ['center'], bishopAtKing: ['line', 'king'],
  fightCentre: ['center'], openLines: ['line'], knightHoldsCentre: ['center'], pressKnight: ['line'], rookCentre: ['line', 'center'],
  hitCentre: ['center'], rookFile: ['line'], takeCentre: ['center'], developAll: [], castle: ['king'], pressCentrePawn: ['center'],
  chaseBishop: ['piece'], chain: ['center'], flankCentre: ['center'], longDiagonal: ['line'], tradeForSpace: ['capture'],
  freeBishop: ['line'], holdSquare: ['center'], attackKing: ['flank', 'king'], developCastle: ['king'], queensidePawns: ['flank'], pawnStorm: ['flank'],
};

// ───────────────────────── praise, mistakes, quiz, mini-lessons, takeaways ─────────────────────────

interface Simple {
  cue: readonly CueKind[];
  min: number;
  subject?: LessonSubject;
  what: string;
  stages?: readonly [LessonStage, LessonStage];
  banded?: boolean;
  variants?: readonly string[];
}

/**
 * Specific praise (docs/TEACHING.md §2.5) — said at once after the child's move, while the bot thinks, in the PAST
 * tense, ≤ 10 words. Routine reasons fire only for a move the child made himself (no arrow shown).
 */
const PRAISE: Readonly<Record<string, Simple>> = {
  mate: { cue: ['king'], min: 8, what: 'ребёнок поставил мат' },
  'tactic.fork': { cue: ['attacks'], min: 6, subject: 'mover', what: 'ребёнок сделал вилку (его фигура mover напала сразу на две; ply2 — начал комбинацию, вилка будет следующим ходом)', variants: ['now', 'ply2'] },
  'tactic.pin': { cue: ['line'], min: 5, subject: 'target', what: 'ребёнок связал фигуру соперника (target)' },
  'tactic.skewer': { cue: ['line'], min: 4, what: 'ребёнок нашёл сквозной удар' },
  'tactic.discovered': { cue: ['line'], min: 4, what: 'ребёнок нашёл вскрытое нападение' },
  'tactic.removeDefender': { cue: ['capture'], min: 4, what: 'ребёнок убрал защитника' },
  'tactic.trapped': { cue: ['piece'], min: 4, subject: 'target', what: 'ребёнок поймал фигуру соперника (target)' },
  'tactic.doubleCheck': { cue: ['king'], min: 4, what: 'ребёнок поставил двойной шах' },
  treasureFound: { cue: ['capture'], min: 8, what: 'ребёнок сам нашёл подарок, который Гамбитик загадал («Найдёшь сам?»)', banded: true },
  freeCapture: { cue: ['capture'], min: 8, subject: 'target', what: 'сам (без стрелки) съел фигуру (target), которую никто не защищал', banded: true },
  winMaterial: { cue: ['capture'], min: 6, subject: 'target', what: 'сам выгодно побил фигуру (target)' },
  stoppedMate: { cue: ['king'], min: 6, what: 'закрыл угрозу мата (мата не осталось совсем)' },
  answeredCheck: { cue: ['king'], min: 6, what: 'сам правильно спасся от шаха' },
  escaped: { cue: ['piece'], min: 8, subject: 'mover', what: 'сам увёл фигуру (mover) из-под удара, и она в безопасности', banded: true },
  defended: { cue: ['defend'], min: 8, subject: 'defended', what: 'сам защитил свою фигуру под ударом (defended)', banded: true },
  castled: { cue: ['king'], min: 8, what: 'сам сделал рокировку (без «теперь можно спокойно атаковать»)', banded: true },
  knightFirst: { cue: ['piece'], min: 6, what: 'сам первым из лёгких фигур вывел коня — «сначала конь, потом слон — хорошее правило»', stages: [1, 3] },
  developed: { cue: ['attacks'], min: 8, subject: 'mover', what: 'сам вывел в дебюте ещё одну лёгкую фигуру (mover), не на край', banded: true },
  centerPawn: { cue: ['center'], min: 8, what: 'сам поставил пешку в центр, она в безопасности', banded: true },
  recaptured: { cue: ['capture'], min: 6, subject: 'target', what: 'сам забрал обратно фигуру (target)' },
  connectedRooks: { cue: ['line'], min: 5, what: 'ладьи ребёнка соединились', stages: [2, 5] },
  rookOpenFile: { cue: ['line'], min: 5, what: 'ладья ребёнка встала на открытую линию', stages: [2, 5] },
  passedPush: { cue: ['path'], min: 5, what: 'ребёнок двинул проходную пешку', stages: [2, 5] },
  kingActive: { cue: ['king'], min: 5, what: 'в эндшпиле ребёнок повёл короля вперёд', stages: [2, 5] },
  tradeAhead: { cue: ['capture'], min: 5, what: 'ребёнок разменялся, когда у него больше материала', stages: [3, 5] },
  promotion: { cue: ['path'], min: 6, what: 'пешка ребёнка превратилась в ферзя' },
  'own.attack': { cue: ['capture'], min: 6, subject: 'target', what: 'свой хороший ход (не из совета): напал на фигуру соперника (target)' },
  'own.develop': { cue: ['attacks'], min: 6, subject: 'mover', what: 'свой хороший ход (не из совета): вывел фигуру (mover)' },
  'own.center': { cue: ['center'], min: 6, what: 'свой хороший ход (не из совета): занял или поддержал центр' },
  'own.defend': { cue: ['defend'], min: 6, what: 'свой хороший ход (не из совета): защитил или увёл фигуру' },
  'own.plan': { cue: [], min: 6, what: 'свой хороший ход (не из совета) по нашей теме или цели плана' },
  'own.good': { cue: [], min: 8, what: 'свой хороший ход (не из совета, «Сам»), движок одобряет, ясной идеи код не нашёл — хвалим самостоятельность мысли, не ход' },
  'habit.knightFirst': { cue: [], min: 4, what: 'привычка: ребёнок уже всегда сначала выводит коней (раз в неделю вместо обычной похвалы)' },
  'habit.castled': { cue: [], min: 4, what: 'привычка: ребёнок уже всегда вовремя делает рокировку' },
  'habit.centerPawn': { cue: [], min: 4, what: 'привычка: ребёнок уже всегда начинает с пешки в центр' },
  'habit.developed': { cue: [], min: 4, what: 'привычка: ребёнок уже всегда быстро выводит фигуры' },
};

/** A mistake explained by a concept (§2.8): what happened (no squares) — `v3.mistake.<key>`. */
const MISTAKES: Readonly<Record<string, Simple>> = {
  mate: { cue: ['threat', 'king'], min: 8, what: 'после хода соперник может поставить мат', banded: true },
  backRank: { cue: ['king'], min: 6, what: 'мат по последнему ряду: король заперт своими пешками' },
  fork: { cue: ['threat'], min: 8, subject: 'attacker', what: 'соперник может сделать вилку фигурой (attacker)', banded: true },
  pin: { cue: ['line'], min: 6, subject: 'victim', what: 'наша фигура (victim) окажется связана' },
  skewer: { cue: ['line'], min: 5, what: 'соперник может сделать сквозной удар', stages: OLD },
  discovered: { cue: ['line'], min: 5, what: 'соперник может сделать вскрытое нападение', stages: OLD },
  removeDefender: { cue: ['capture'], min: 5, what: 'соперник заберёт защитника, и другая наша фигура останется одна', stages: OLD },
  trapped: { cue: ['piece'], min: 5, subject: 'victim', what: 'нашу фигуру (victim) могут поймать: ей некуда уйти' },
  'hanging.undefended': { cue: ['hanging', 'threat'], min: 10, subject: 'victim', what: 'наша фигура (victim) осталась БЕЗ ЗАЩИТЫ — её съедят', banded: true },
  'hanging.cheaper': { cue: ['hanging', 'threat'], min: 8, subject: 'victim', what: 'на нашу фигуру (victim) напала более дешёвая фигура — даже с защитой мы теряем', banded: true },
  'hanging.outnumbered': { cue: ['hanging', 'threat'], min: 6, subject: 'victim', what: 'нападающих на нашу фигуру (victim) больше, чем защитников' },
  badTrade: { cue: ['capture'], min: 8, what: 'размен невыгодный: отдаём больше, чем забираем', banded: true },
  ignoredDanger: { cue: ['hanging', 'threat'], min: 8, subject: 'victim', what: 'Гамбитик предупреждал об угрозе фигуре (victim), а ход её не спас (без упрёка!)', banded: true },
  missedTreasure: { cue: ['capture'], min: 8, subject: 'target', what: 'был подарок: можно было взять фигуру (target) бесплатно или выгодно', banded: true },
  earlyQueen: { cue: ['piece'], min: 6, what: 'ранний ферзь: фигуры соперника будут его гонять' },
  promotion: { cue: ['path'], min: 5, what: 'пешка соперника прорывается в ферзи' },
  slower: { cue: ['move'], min: 8, subject: 'mover', what: 'без потерь, но совет (фигура mover) был заметно сильнее — «Можно и так, но ход {конём} был посильнее»', stages: OLD },
};

/** The rule to a mistake (`v3.rule.<key>`, first time per game) and its question form (`v3.rule.ask.<key>`, stages 3–5, second time). */
const RULES: Readonly<Record<string, { min: number; what: string }>> = {
  mate: { min: 8, what: 'сначала смотри, что задумал соперник, — нет ли у него мата' },
  backRank: { min: 5, what: 'дай королю форточку — сдвинь одну пешку перед ним' },
  fork: { min: 6, what: 'проверяй, куда может прыгнуть конь соперника и на что он нападёт' },
  pin: { min: 5, what: 'не ставь фигуру на одну линию со своим королём или ферзём' },
  tactic: { min: 5, what: 'смотри на линии: что откроется, если фигура уйдёт' },
  hanging: { min: 10, what: 'перед ходом проверяй: всё ли защищено, кого можно съесть' },
  badTrade: { min: 6, what: 'считай: что отдаю и что получаю' },
  ignoredDanger: { min: 8, what: 'сначала спасаем того, кого атакуют' },
  missedTreasure: { min: 8, what: 'перед ходом ищи: что можно съесть бесплатно' },
  earlyQueen: { min: 6, what: 'сначала кони и слоны, ферзь — потом' },
  promotion: { min: 5, what: 'чужую проходную пешку надо останавливать заранее' },
};

/** The quiz (§2.4): questions. */
const QUIZ_QUESTIONS: Readonly<Record<string, Simple>> = {
  oppIdea: { cue: [], min: 10, what: '«Как думаешь, что задумал соперник?» — после его хода с ясной идеей (стрелка его хода и так видна)' },
  whichPiece: { cue: [], min: 10, what: '«Какой фигурой сейчас лучше пойти?»' },
  canCapture: { cue: ['capture'], min: 8, subject: 'target', what: '«Выгодно ли съесть {коня}?» (НЕ «можно ли» — съесть можно всегда)' },
  checkEscape: { cue: ['king'], min: 8, what: '«Шах! Как будем спасаться?»' },
  danger: { cue: [], min: 8, what: '«Что соперник может съесть?» (подсветку угрозы не показываем, пока открыт вопрос)' },
  why: { cue: ['lastMove'], min: 8, stages: OLD, what: '«Зачем мы так сходили?» — про прошлый ход ребёнка по совету' },
};

/**
 * Answer buttons: ≤ 3 words, ≤ 18 characters, no end mark. `v3.quiz.cat.*` — the 5 fixed categories of «Что задумал
 * соперник?» at stages 1–2 (third person, about the opponent); `v3.quiz.opt.*` — goals at stages 3–5 (infinitive).
 */
const QUIZ_CATEGORIES: Readonly<Record<string, string>> = {
  attack: '«Нападает»',
  capture: '«Хочет съесть»',
  develop: '«Выводит фигуру»',
  center: '«Занимает центр»',
  castle: '«Прячет короля»',
};
const QUIZ_GOAL_OPTIONS: Readonly<Record<string, string>> = {
  attack: 'напасть на фигуру',
  capture: 'съесть фигуру',
  mate: 'поставить мат',
  check: 'поставить шах',
  fork: 'напасть на две сразу',
  develop: 'вывести фигуру',
  center: 'занять центр',
  castle: 'спрятать короля',
  defend: 'защитить фигуру',
  escape: 'увести фигуру',
  trade: 'разменяться',
  queenOut: 'вывести ферзя',
  aimWeak: 'к слабой пешке',
  openLine: 'открыть дорогу',
  promote: 'пешку в ферзи',
  kingForward: 'король вперёд',
};

interface MiniSpec {
  stages: readonly [LessonStage, LessonStage];
  cue: readonly CueKind[];
  slot: 'opening' | 'tactic' | 'endgame';
  l1: string;
  l2: string;
  l3: string;
}

/** Mini-lessons in three depth levels (§2.6): l1 = what, l2 = why/how, l3 = an exception or a trap. */
export const MINI_TOPICS: Readonly<Record<string, MiniSpec>> = {
  castle: { stages: [1, 5], cue: ['king'], slot: 'opening', l1: 'рокировка прячет короля в домик и выводит ладью', l2: 'почему король в центре в опасности, когда откроются линии', l3: 'рокировать нельзя под шахом и через битое поле; не двигай пешки перед королём' },
  development: { stages: [1, 5], cue: ['piece'], slot: 'opening', l1: 'каждым ходом — новая фигура в игру', l2: 'пока одна фигура гуляет, остальные спят — не ходи одной фигурой дважды', l3: 'кони обычно раньше слонов, ладьи выходят после рокировки' },
  center: { stages: [1, 3], cue: ['center'], slot: 'opening', l1: 'центр — четыре клетки посередине, главные дороги доски', l2: 'из центра фигуры стреляют дальше и быстро бегут на любой фланг', l3: 'центр держат не только пешки, но и фигуры, которые на него смотрят' },
  earlyQueen: { stages: [1, 4], cue: ['piece'], slot: 'opening', l1: 'ферзь — самая сильная фигура, её берегут', l2: 'рано выведенного ферзя гоняют кони и слоны, и соперник развивается с темпом', l3: 'гони чужого ферзя, выводя свои фигуры' },
  thinking: { stages: [1, 5], cue: [], slot: 'opening', l1: 'перед ходом: что хочет соперник?', l2: 'мой ход безопасен? кого могут съесть?', l3: 'шахи, взятия, угрозы — проверь всё по порядку' },
  hanging: { stages: [1, 3], cue: ['hanging'], slot: 'tactic', l1: 'фигура без защиты висит — её съедят бесплатно', l2: 'проверь, кто её защищает и кто нападает', l3: 'даже защищённую фигуру съедят, если нападает кто-то дешевле' },
  freeCapture: { stages: [1, 2], cue: ['capture'], slot: 'tactic', l1: 'бесплатное взятие — подарок', l2: 'сначала проверь, не съедят ли в ответ', l3: 'бывает, что подарок — ловушка: посмотри, что откроется' },
  checkEscape: { stages: [1, 2], cue: ['king'], slot: 'tactic', l1: 'от шаха три спасения: уйти, закрыться, съесть', l2: 'выбирай спасение, после которого фигуры целы', l3: 'иногда можно спастись и одновременно напасть' },
  mateInOne: { stages: [1, 2], cue: ['king'], slot: 'tactic', l1: 'мат — шах, от которого нет спасения', l2: 'проверь все три спасения — если ни одного, это мат', l3: 'ищи мат, когда король соперника заперт своими фигурами' },
  scholarsMate: { stages: [1, 3], cue: ['weak', 'threat'], slot: 'tactic', l1: 'детский мат: ферзь и слон целятся в слабую пешку у короля', l2: 'закрой слабую пешку конём или пешкой и гони ферзя', l3: 'когда ферзь соперника вышел рано — нападай на него своими фигурами' },
  backRank: { stages: [2, 5], cue: ['king'], slot: 'tactic', l1: 'мат по последнему ряду: король заперт своими пешками', l2: 'сделай королю форточку — сдвинь одну пешку', l3: 'смотри, кто охраняет последний ряд, и не уводи эту фигуру' },
  fork: { stages: [2, 5], cue: ['attacks'], slot: 'tactic', l1: 'вилка — одна фигура нападает сразу на две', l2: 'конь любит вилки — проверяй, куда он может прыгнуть', l3: 'вилка с шахом — самая сильная: королю надо уходить' },
  pin: { stages: [3, 5], cue: ['line'], slot: 'tactic', l1: 'связка: фигура не может уйти — за ней кто-то дороже', l2: 'на связанную фигуру нападай ещё раз', l3: 'связку можно разорвать: закрыться или уйти королём' },
  skewer: { stages: [3, 5], cue: ['line'], slot: 'tactic', l1: 'сквозной удар — связка наоборот: дорогая фигура впереди', l2: 'дорогая уходит — и мы забираем ту, что за ней', l3: 'короля и ферзя на одной линии не ставь' },
  discovered: { stages: [3, 5], cue: ['line'], slot: 'tactic', l1: 'вскрытое нападение: передняя фигура отходит — задняя нападает', l2: 'передняя фигура при этом может напасть сама — два удара сразу', l3: 'вскрытый шах — самый опасный' },
  removeDefender: { stages: [3, 5], cue: ['capture'], slot: 'tactic', l1: 'убери защитника — и фигура останется одна', l2: 'сначала посчитай, кто кого защищает', l3: 'защитника можно не только съесть, но и отвлечь' },
  trapped: { stages: [3, 5], cue: ['piece'], slot: 'tactic', l1: 'ловля фигуры: сначала закрой ей все выходы', l2: 'фигуре у края доски трудно убежать', l3: 'не заводи свою фигуру туда, откуда нет выхода' },
  pieceValues: { stages: [1, 2], cue: [], slot: 'tactic', l1: 'сколько стоят фигуры: пешка — одна, конь и слон — по три, ладья — пять, ферзь — девять', l2: 'меняйся, только если получаешь не меньше', l3: 'две лёгкие фигуры обычно лучше ладьи' },
  tradeWhenAhead: { stages: [3, 5], cue: ['capture'], slot: 'endgame', l1: 'когда фигур больше — меняйся фигурами', l2: 'чем меньше фигур, тем легче выиграть', l3: 'меняй фигуры, а не пешки' },
  openFile: { stages: [3, 5], cue: ['line'], slot: 'endgame', l1: 'открытая линия — дорога для ладьи', l2: 'ладья на открытой линии давит до самого конца', l3: 'две ладьи на одной линии — ещё сильнее' },
  connectRooks: { stages: [3, 5], cue: ['line'], slot: 'opening', l1: 'ладьи увидели друг друга — дебют закончен', l2: 'связанные ладьи защищают друг друга', l3: 'теперь ищи для ладей открытые линии' },
  kingActive: { stages: [2, 5], cue: ['king', 'center'], slot: 'endgame', l1: 'когда фигур мало, король — боец', l2: 'веди короля к центру и к пешкам', l3: 'король помогает своей пешке пройти в ферзи' },
  passedPawn: { stages: [3, 5], cue: ['path'], slot: 'endgame', l1: 'проходная — пешка, которой никто не мешает', l2: 'веди её в ферзи, а король пусть помогает', l3: 'чужую проходную останавливай фигурой прямо перед ней' },
  mateTechnique: { stages: [2, 5], cue: ['king'], slot: 'endgame', l1: 'у соперника один король — загоняем его к краю', l2: 'отнимай у короля клетки, как в коробочке', l3: 'ставь мат своим королём вместе с ферзём или ладьёй' },
  stalemate: { stages: [2, 5], cue: ['king'], slot: 'endgame', l1: 'пат — ничья: у соперника нет ходов, но нет и шаха', l2: 'оставляй королю соперника хоть один ход', l3: 'перед каждым ходом проверяй: есть ли у него ход' },
};

/** The one takeaway of a game (§2.9): `v3.takeaway.<key>`. */
const TAKEAWAYS: Readonly<Record<string, { min: number; what: string; stages?: readonly [LessonStage, LessonStage] }>> = {
  'mistake.mate': { min: 8, what: 'мат решил партию — правило: сначала смотри, что задумал соперник («В следующий раз…»)' },
  'mistake.backRank': { min: 6, what: 'мат по последнему ряду — форточка для короля' },
  'mistake.fork': { min: 8, what: 'вилка соперника — проверяй, куда может прыгнуть конь' },
  'mistake.pin': { min: 6, what: 'связка — не ставь фигуры на одну линию с королём' },
  'mistake.hanging': { min: 10, what: 'фигуры без защиты — перед ходом проверяй, всё ли защищено' },
  'mistake.badTrade': { min: 6, what: 'невыгодные размены — считай, что отдаёшь и что получаешь' },
  'mistake.ignoredDanger': { min: 8, what: 'угроза — сначала спасаем того, кого атакуют' },
  'mistake.missedTreasure': { min: 8, what: 'подарки — перед ходом ищи, что можно съесть' },
  'mistake.earlyQueen': { min: 6, what: 'ранний ферзь — сначала кони и слоны' },
  'mistake.tactic': { min: 6, what: 'тактика соперника (сквозной удар, вскрытое, убрал защитника, ловля) — смотри на линии' },
  ...Object.fromEntries(LESSON_THEME_FAMILIES.map((f) => [`theme.${f}`, { min: 6, what: `тема сработала — ${FAMILY_WHAT[f]} (только факт, без «поэтому выиграли»)` }])),
  'found.mate': { min: 6, what: 'ребёнок сам поставил или нашёл мат' },
  'found.tactic': { min: 8, what: 'ребёнок нашёл тактику (вилку, связку…) или подарок' },
  'quiz.oppIdea': { min: 6, what: 'ребёнок хорошо угадывал, что задумал соперник' },
  'quiz.whichPiece': { min: 4, what: 'ребёнок хорошо выбирал, какой фигурой ходить' },
  'quiz.canCapture': { min: 4, what: 'ребёнок хорошо считал, выгодно ли съесть' },
  'quiz.checkEscape': { min: 4, what: 'ребёнок хорошо спасался от шахов' },
  'quiz.danger': { min: 4, what: 'ребёнок хорошо видел, что под ударом' },
  'quiz.why': { min: 4, what: 'ребёнок понимал, зачем делаются ходы', stages: OLD },
  'stage.1': { min: 6, stages: [1, 1], what: 'общий вывод ступени 1: зоркий глаз — что под ударом, что можно съесть' },
  'stage.2': { min: 6, stages: [2, 2], what: 'общий вывод ступени 2: центр, фигуры в игру, король в домик' },
  'stage.3': { min: 6, stages: [3, 3], what: 'общий вывод ступени 3: ищи двойные удары — вилки и связки' },
  'stage.4': { min: 6, stages: [4, 4], what: 'общий вывод ступени 4: убирай защитника, смотри на открытые линии' },
  'stage.5': { min: 6, stages: [5, 5], what: 'общий вывод ступени 5: считай на три хода и строй план' },
};

/** «Помнишь, в прошлый раз…» — the next game recalls the last takeaway (§2.9). */
const RECALL_KEYS = Object.keys(TAKEAWAYS).filter((k) => k.startsWith('mistake.') || k.startsWith('theme.'));

const SELF_KINDS: Readonly<Record<string, { cue: readonly CueKind[]; what: string }>> = {
  develop: { cue: [], what: 'найди сам: какая фигура ещё спит дома — разбуди её' },
  center: { cue: ['center'], what: 'найди сам: центр ещё не наш — чем его занять' },
  attack: { cue: [], what: 'найди сам: можно напасть на фигуру соперника — чем' },
  defend: { cue: [], what: 'найди сам: кому-то из наших нужна помощь — помоги' },
  castle: { cue: ['king'], what: 'найди сам: королю пора в домик — как' },
  improve: { cue: [], what: 'найди сам: какая наша фигура стоит хуже всех — найди ей место лучше' },
  plan: { cue: [], what: 'найди сам: вспомни нашу тему — какой ход её продолжит' },
  endgame: { cue: ['king'], what: 'найди сам: фигур мало — чем поможет король' },
  generic: { cue: [], what: 'найди сам: подумай, что хочет соперник и что можем мы' },
};

// ───────────────────────── the pool list ─────────────────────────

const pools: LessonPoolSpec[] = [
  // the advice — five shapes (§2.3)
  pool('v3.lead.advice', 'lead', ['move'], 12, 'форма A: начало совета с фигурой-ходоком: «Давай сходим {конём}». Слова «лучше всего / сильнее всего» книга берёт только когда совет = ход движка с запасом', { subject: 'mover' }),
  pool('v3.lead.subject', 'lead', ['move'], 10, 'форма C: фигура — подлежащее: «{Конь} просится в бой», «{Твой} {конь} скучает дома»', { subject: 'mover' }),
  pool('v3.lead.plan', 'lead', ['move'], 8, 'начало совета, когда ход — шаг линии нашей темы: «По нашему плану идёт {конь}»', { subject: 'mover' }),
  pool('v3.lead.capture', 'lead', ['move'], 8, 'начало совета, когда ход — взятие: «Бьём {конём}» (хвост скажет, кого)', { subject: 'mover' }),
  pool('v3.lead.rescue', 'lead', ['move'], 8, 'начало совета после опасности, ход спасает: «Спасаемся: ходим {конём}»', { subject: 'mover' }),
  pool('v3.lead.answer', 'lead', ['move'], 8, 'начало совета после фразы о ходе соперника: «Отвечаем {конём}»', { subject: 'mover' }),
  pool('v3.lead.reveal', 'lead', ['move'], 8, 'показ подарка или хода «Сам», если ребёнок не нашёл: «Вот он: ход {конём}»', { subject: 'mover' }),
  pool('v3.lead.why', 'lead', ['move'], 8, 'кнопка «Почему так?» и пояснение к вопросу «Зачем?»: «Ход {конём} хорош»', { subject: 'mover' }),
  pool('v3.lead.repeat', 'lead', ['move'], 8, 'кнопка «Совет» / «Повтори»: «Напомню: мой совет — ход {конём}»', { subject: 'mover' }),
  ...Object.entries(IDEA_TAILS).map(([id, t]) =>
    pool(`v3.idea.${id}`, 'tail', t.cue, t.min, `хвост совета — идея хода: ${t.what}`, { ...(t.subject ? { subject: t.subject } : {}), banded: t.min >= 8, ...(t.variants ? { variants: t.variants } : {}) }),
  ),
  pool('v3.idea.none', 'tail', ['move'], 8, 'хвост совета, когда код не нашёл ясной идеи, а движок ход одобряет: «— я проверил, так сильнее.»'),
  ...AIM_IDEAS.map((id) =>
    pool(`v3.aim.${id}`, 'lead', IDEA_TAILS[id].cue, 6, `форма B/D: начало «сначала зачем» без фигуры: ${IDEA_TAILS[id].what}. Должно читаться и как целая фраза (с точкой), и перед хвостом v3.go.*`, IDEA_TAILS[id].variants ? { variants: IDEA_TAILS[id].variants } : {}),
  ),
  pool('v3.go.move', 'tail', ['move'], 12, 'форма B: хвост после «зачем» — какой фигурой: «— значит, ходим {конём}.»', { subject: 'mover' }),
  pool('v3.go.capture', 'tail', ['move'], 8, 'форма B для взятия: «— бьём {конём}!» (без «её/его»)', { subject: 'mover' }),
  pool('v3.helper', 'whole', ['move'], 12, 'форма D/E: помощник — фигура-ходок: «Поможет {пешка}.», «Это работа для {пешки:gen}.», «{Пешка}!»', { subject: 'mover' }),
  ...QUESTION_IDEAS.map((id) =>
    pool(`v3.q.${id}`, 'whole', IDEA_TAILS[id].cue, 6, `форма E: вопрос, на который сразу отвечает v3.helper: ${IDEA_TAILS[id].what}`, IDEA_TAILS[id].subject && IDEA_TAILS[id].subject !== 'mover' ? { subject: IDEA_TAILS[id].subject } : {}),
  ),
  pool('v3.whole.castle', 'whole', ['king'], 10, 'совет-рокировка (короткая) целой фразой', { banded: true }),
  pool('v3.whole.castleLong', 'whole', ['king'], 5, 'совет — длинная рокировка целой фразой'),

  // «Сам», the outcome of a followed arrow, the quiet nod
  ...Object.entries(SELF_KINDS).map(([k, s]) => pool(`v3.self.${k}`, 'whole', s.cue, 6, `момент «Сам» (стрелка скрыта): ${s.what}; 1–2 коротких предложения`, { stages: [2, 5], maxSentences: 2 })),
  ...RESULT_IDEAS.map((id) =>
    pool(`v3.result.${id}`, 'whole', IDEA_TAILS[id].cue, 6, `итог хода ребёнка ПО СТРЕЛКЕ (не похвала, без «ты»): ${IDEA_TAILS[id].what}`, IDEA_TAILS[id].subject ? { subject: IDEA_TAILS[id].subject } : {}),
  ),
  pool('v3.bark.quiet', 'whole', [], 8, 'короткий звук-«ага» спокойного хода (1–2 слова: «Ага!», «Так-так.»); облачка нет'),

  // the theme of the game
  ...LESSON_STRATEGY_IDS.map((id) => pool(`v3.theme.${id}`, 'whole', [], 4, `объявление темы «${id}» на ступенях 3–5: имя дебюта + идея, одной фразой, без хода`, { stages: OLD })),
  ...LESSON_STRATEGY_IDS.map((id) => pool(`v3.theme.named.${id}`, 'whole', [], 3, `имя дебюта «${id}» как награда/подтверждение: ребёнок и соперник сыграли его линию («Смотри-ка, у нас получилась…»)`)),
  ...LESSON_THEME_FAMILIES.map((f) => pool(`v3.theme.family.${f}`, 'whole', FAMILY_CUE[f], 6, `объявление темы по семье (ступени 1–2 и белые до ответа соперника): ${FAMILY_WHAT[f]}`, { banded: true })),
  ...LESSON_THEME_FAMILIES.map((f) => pool(`v3.theme.remind.${f}`, 'whole', FAMILY_CUE[f], 6, `напоминание темы семьи «${f}» (в дебюте или пока цель открыта): ${FAMILY_WHAT[f]}`)),
  pool('v3.theme.left', 'whole', [], 8, 'соперник свернул с дороги нашей темы — «ничего, план тот же» (ступени 3–5)', { stages: OLD }),
  ...LESSON_THEME_FAMILIES.map((f) => pool(`v3.why.${f}`, 'whole', FAMILY_CUE[f], 8, `вторая фраза совета, ход по теме «${f}»: ${FAMILY_WHAT[f]} — зачем это нашему плану`)),
  ...LESSON_THEME_FAMILIES.map((f) => pool(`v3.themeTail.${f}`, 'tail', FAMILY_CUE[f], 6, `хвост совета вместо хвоста идеи, ход по теме «${f}» (блиц): ${FAMILY_WHAT[f]}`)),
  ...LESSON_GOAL_KEYS.map((g) => pool(`v3.goal.${g}`, 'whole', GOAL_CUE[g], 5, `цель плана «${g}» — вторая фраза совета, когда ход её выполняет`)),
  ...LESSON_GOAL_KEYS.map((g) => pool(`v3.goalDone.${g}`, 'whole', GOAL_CUE[g], 4, `похвала: цель плана «${g}» выполнена ходом ребёнка (сам)`)),
  pool('v3.phase.middlegame', 'whole', [], 6, 'глава партии: дебют закончился, фигуры вышли — теперь ищем, кого атаковать (раз за партию)'),
  pool('v3.phase.endgame', 'whole', [], 6, 'глава партии: фигур мало — король становится бойцом, проходные пешки бегут (раз за партию)'),
  ...RECALL_KEYS.map((k) => pool(`v3.recall.${k}`, 'whole', [], 4, `в начале следующей партии: «Помнишь, в прошлый раз…» — вспоминаем вывод «${k}» и обещаем проверить`)),

  // the opponent's move (without squares; the board shows it)
  pool('v3.opp.develop', 'whole', ['piece'], 10, 'соперник вывел фигуру (oppPiece)', { subject: 'oppPiece' }),
  pool('v3.opp.centerPawn', 'whole', ['center'], 8, 'соперник поставил пешку в центр'),
  pool('v3.opp.capture', 'whole', [], 8, 'соперник съел нашу фигуру (victim)', { subject: 'victim' }),
  pool('v3.opp.recapture', 'whole', [], 6, 'соперник забрал обратно — размен'),
  pool('v3.opp.attack', 'whole', ['threat'], 10, 'соперник напал на нашу фигуру (victim)', { subject: 'victim' }),
  pool('v3.opp.check', 'whole', ['king'], 8, 'соперник объявил шах'),
  pool('v3.opp.castle', 'whole', ['king'], 8, 'соперник сделал рокировку'),
  pool('v3.opp.earlyQueen', 'whole', ['piece'], 8, 'соперник рано вывел ферзя (можно гонять его своими фигурами)'),
  pool('v3.opp.threatMate', 'whole', ['threat'], 8, 'соперник грозит матом'),
  pool('v3.opp.aimWeak', 'whole', ['weak'], 6, 'соперник целится в слабую пешку рядом с нашим королём'),
  pool('v3.opp.trade', 'whole', [], 6, 'соперник предлагает размен'),
  pool('v3.opp.quiet', 'whole', [], 8, 'кнопка «Что задумал соперник?», а угрозы нет (поиск закончен): описываем только ход — «Соперник сделал тихий ход» (не обещать, что опасности нет)'),

  // danger
  pool('v3.danger.check', 'whole', ['king'], 8, 'нам шах — сначала спасаем короля'),
  pool('v3.danger.mate', 'whole', ['threat'], 8, 'соперник грозит матом — сначала защищаемся'),
  pool('v3.danger.hanging.undefended', 'whole', ['hanging', 'threat'], 10, 'наша фигура (victim) под ударом и БЕЗ ЗАЩИТЫ', { subject: 'victim' }),
  pool('v3.danger.hanging.attacked', 'whole', ['hanging', 'threat'], 8, 'на нашу фигуру (victim) напали, защита не спасает (не говорить «без защиты»)', { subject: 'victim' }),
  pool('v3.danger.fork', 'whole', ['threat'], 6, 'соперник готовит вилку'),
  pool('v3.danger.threat', 'whole', ['threat'], 6, 'соперник что-то задумал (угроза без простого названия)'),
  pool('v3.danger.letGo.check', 'whole', [], 6, 'фигуру можно не спасать: сначала шах — соперник будет спасать короля', { banded: true }),
  pool('v3.danger.letGo.stronger', 'whole', [], 6, 'фигуру можно не спасать: есть ход сильнее (дальше идёт совет с его идеей)', { banded: true }),
  pool('v3.danger.lastStand', 'tail', [], 8, 'хвост совета, когда мат уже не остановить (совет его не отбивает — любой ход его пропускает): честно «сыграем до конца»; никогда «спасаемся / надёжно / безопасно / есть ход сильнее»'),

  // treasure: find it yourself
  pool('v3.treasure.mate', 'whole', [], 8, 'подарок: можно поставить мат'),
  pool('v3.treasure.free', 'whole', ['hanging'], 10, 'подарок: фигура соперника (target) стоит БЕЗ ЗАЩИТЫ', { subject: 'target' }),
  pool('v3.treasure.win', 'whole', ['piece'], 6, 'подарок: фигуру соперника (target) выгодно взять (её защищают, но мы в плюсе)', { subject: 'target' }),
  pool('v3.treasure.fork', 'whole', [], 6, 'подарок: есть вилка (ступени 1–2: «двойной удар»)'),
  pool('v3.treasure.tactic', 'whole', [], 6, 'подарок: есть сильный удар (связка, сквозной, вскрытое, ловля фигуры)'),
  pool('v3.treasure.hunt', 'whole', [], 6, 'ступени 3–5: «Где-то тут подарок…» — без подсветки, ребёнок ищет сам', { stages: OLD }),
  pool('v3.treasure.ask', 'whole', [], 10, 'вопрос после подарка: «Найдёшь {g:сам|сама}?»'),

  // praise
  ...Object.entries(PRAISE).map(([k, p]) =>
    pool(`v3.praise.${k}`, 'whole', p.cue, p.min, `похвала за дело, прошедшее время, ≤ 10 слов: ${p.what}`, {
      ...(p.subject ? { subject: p.subject } : {}),
      ...(p.stages ? { stages: p.stages } : {}),
      ...(p.banded ? { banded: true } : {}),
      ...(p.variants ? { variants: p.variants } : {}),
    }),
  ),

  // mistakes, rules, take-back
  ...Object.entries(MISTAKES).map(([k, m]) =>
    pool(`v3.mistake.${k}`, 'whole', m.cue, m.min, `что случилось (без клеток, без упрёка): ${m.what}`, {
      ...(m.subject ? { subject: m.subject } : {}),
      ...(m.stages ? { stages: m.stages } : {}),
      ...(m.banded ? { banded: true } : {}),
    }),
  ),
  ...Object.entries(RULES).map(([k, r]) => pool(`v3.rule.${k}`, 'whole', [], r.min, `правило (первый раз за партию): ${r.what}`, { banded: r.min >= 8 })),
  ...Object.entries(RULES).map(([k, r]) => pool(`v3.rule.ask.${k}`, 'whole', [], 4, `правило вопросом (второй раз за партию, ступени 3–5): ${r.what}`, { stages: OLD })),
  pool('v3.takeback.stop', 'whole', [], 10, 'начало предложения вернуть ход: «Стоп-стоп!»'),
  pool('v3.takeback.ask', 'whole', [], 10, '«Вернём ход и подумаем?» — после фразы-ошибки'),
  pool('v3.takeback.askThink', 'whole', [], 6, 'ступени 3–5: «Стоп! Что теперь может съесть соперник?» (без объяснения до возврата)', { stages: OLD }),
  pool('v3.takeback.yes', 'whole', [], 10, 'ребёнок вернул ход: одобрить решение подумать (не «молодец»)'),
  pool('v3.takeback.no', 'whole', [], 10, 'ребёнок оставил ход: спокойно, без упрёка, играем дальше'),
  pool('v3.takeback.again', 'whole', [], 6, 'после возврата ребёнок сделал другой ход, который тоже теряет'),

  // quiz
  ...Object.entries(QUIZ_QUESTIONS).map(([k, q]) =>
    pool(`v3.quiz.q.${k}`, 'whole', q.cue, q.min, `вопрос с 3 кнопками: ${q.what}`, { ...(q.subject ? { subject: q.subject } : {}), ...(q.stages ? { stages: q.stages } : {}) }),
  ),
  ...Object.entries(QUIZ_CATEGORIES).map(([k, what]) => pool(`v3.quiz.cat.${k}`, 'whole', [], 2, `кнопка «Что задумал соперник?» (ступени 1–2), про соперника в 3-м лице: ${what}`, { stages: YOUNG })),
  ...Object.entries(QUIZ_GOAL_OPTIONS).map(([k, what]) => pool(`v3.quiz.opt.${k}`, 'whole', [], 2, `кнопка-цель (ступени 3–5), инфинитив: ${what}`, { stages: OLD })),
  pool('v3.quiz.opt.capYes', 'whole', [], 2, 'кнопка «Да, бесплатно»'),
  pool('v3.quiz.opt.capTrade', 'whole', [], 2, 'кнопка «Будет размен»'),
  pool('v3.quiz.opt.capLose', 'whole', [], 2, 'кнопка «Нет, потеряем»'),
  pool('v3.quiz.opt.escKing', 'whole', [], 2, 'кнопка «Уйти королём»'),
  pool('v3.quiz.opt.escBlock', 'whole', [], 2, 'кнопка «Закрыться»'),
  pool('v3.quiz.opt.escCapture', 'whole', [], 2, 'кнопка «Съесть его» (фигуру, которая шахует)'),
  pool('v3.quiz.right', 'whole', [], 12, 'ответ верный — коротко и радостно (без «молодец»), дальше пояснение'),
  pool('v3.quiz.wrong', 'whole', [], 10, 'ответ неверный — мягко (без «неправильно», «ошибка», «нет!»), дальше пояснение'),
  pool('v3.quiz.explain.capYes', 'whole', ['capture'], 6, 'пояснение: фигуру (target) можно съесть бесплатно — её никто не защищает', { subject: 'target' }),
  pool('v3.quiz.explain.capTrade', 'whole', ['capture'], 6, 'пояснение: фигуру (target) защищают — будет размен', { subject: 'target' }),
  pool('v3.quiz.explain.capLose', 'whole', ['capture', 'threat'], 6, 'пояснение: фигуру (target) защищают, и мы потеряем больше', { subject: 'target' }),
  pool('v3.quiz.explain.escKing', 'whole', ['king'], 5, 'пояснение: лучше всего уйти королём (не объяснять, почему другие хуже, если они возможны)'),
  pool('v3.quiz.explain.escBlock', 'whole', ['king'], 5, 'пояснение: лучше всего закрыться'),
  pool('v3.quiz.explain.escCapture', 'whole', ['king', 'capture'], 5, 'пояснение: лучше всего съесть фигуру, которая шахует'),
  pool('v3.quiz.explain.danger', 'whole', ['hanging', 'threat'], 6, 'пояснение: под ударом наша фигура (victim)', { subject: 'victim' }),

  // mini-lessons: three levels, 2–3 short sentences
  ...Object.entries(MINI_TOPICS).flatMap(([k, m]) =>
    (['l1', 'l2', 'l3'] as const).map((lvl) =>
      pool(`v3.mini.${k}.${lvl}`, 'whole', m.cue, 3, `мини-урок «${k}», уровень ${lvl} (${lvl === 'l1' ? 'что это' : lvl === 'l2' ? 'зачем и как' : 'исключение или ловушка'}): ${m[lvl]}`, {
        stages: m.stages,
        maxSentences: 3,
        banded: m.stages[0] <= 2 && m.stages[1] >= 3,
      }),
    ),
  ),

  // the end of the game
  pool('v3.end.win', 'whole', [], 10, 'начало итога: победа (радость, без «молодец»)'),
  pool('v3.end.loss', 'whole', [], 10, 'начало итога: поражение (сначала чувства и поддержка)'),
  pool('v3.end.draw', 'whole', [], 8, 'начало итога: ничья'),
  pool('v3.end.unfinished', 'whole', [], 6, 'начало итога: партия не доиграна'),
  ...Object.entries(TAKEAWAYS).map(([k, t]) =>
    pool(`v3.takeaway.${k}`, 'whole', [], t.min, `один главный вывод партии: ${t.what}`, { ...(t.stages ? { stages: t.stages } : {}), maxSentences: 2, banded: !t.stages && t.min >= 8 }),
  ),

  // other moments
  pool('v3.hurry', 'whole', [], 8, 'у ребёнка мало времени (одно «Поторопись!»; часы, минуты и секунды не называть)'),
];

export const LESSON_POOLS: readonly LessonPoolSpec[] = pools;

const BY_ID = new Map(pools.map((p) => [p.id, p] as const));
export function lessonPoolSpec(id: string): LessonPoolSpec | undefined {
  return BY_ID.get(id);
}

/** Which family file owns a pool (the writers' split; teaching.test / content.test check it). */
export function lessonFamilyOf(id: string): string {
  if (/^v3\.(lead|whole|aim|go|helper|q|idea\.none)\b/.test(id)) return 'advice';
  if (/^v3\.idea\./.test(id)) {
    const idea = id.split('.')[2] as LessonIdeaId;
    const tactics: readonly string[] = ['mate', 'mateSoon', 'promotion', 'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'removeDefender', 'trappedPiece', 'freeCapture', 'winMaterial', 'recapture', 'defendMate', 'answerCheck', 'escape', 'defend', 'block', 'threatMate', 'attack', 'check'];
    return tactics.includes(idea) ? 'ideasTactics' : 'ideasPlay';
  }
  if (/^v3\.(self|result|bark)\./.test(id)) return 'moments';
  if (/^v3\.theme\./.test(id) || /^v3\.phase\./.test(id) || /^v3\.recall\./.test(id)) return 'theme';
  if (/^v3\.(why|themeTail)\./.test(id)) return 'plan';
  if (/^v3\.(goal|goalDone)\./.test(id)) return 'goals';
  if (/^v3\.(opp|danger|treasure)\./.test(id) || id === 'v3.hurry') return 'opponent';
  if (/^v3\.praise\./.test(id)) return 'praise';
  if (/^v3\.(mistake|rule|takeback)\./.test(id)) return 'mistakes';
  if (/^v3\.quiz\./.test(id)) return 'quiz';
  if (/^v3\.mini\./.test(id)) return 'lessons';
  if (/^v3\.(end|takeaway)\./.test(id)) return 'endings';
  return 'unknown';
}
