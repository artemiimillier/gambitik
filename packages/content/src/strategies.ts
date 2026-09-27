/**
 * The strategy library of «Учитель» (a new strategy every game, so that the child does not play the same
 * thing over and over). Every game the teacher leads the child with ONE named strategy — «В этот раз разыграем Итальянскую
 * партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е четыре.» — and explains the moves by it.
 *
 * Truth stays with the engine and the code:
 *  - every `mainLineSan` is legal and canonical from the initial position (`strategies.test.ts`, chess.js) and every
 *    child move of it is within 50 cp of the best move at depth ≥ 12 of the real Stockfish 19 lite WASM
 *    (`strategies.engine.test.ts`, skipped when the engine file is missing);
 *  - `lineSan` is exactly the child's moves of `mainLineSan`; `middlegameSan` are only TAGS («this move serves the plan»)
 *    — a move is advised only when the engine accepts it in the game, the tag changes the words, not the choice;
 *  - the smart strategist (server, POST /coach/strategy) may only CHOOSE one of these ids — `getStrategiesFor` gives the
 *    candidates, `pickStrategyDeterministic` is the free fallback.
 *
 * Child-facing strings (`titleRu`, `titleAccRu`, `ideaRu`, `stepsRu`, `middlegameRu`, `planGoalsRu`) are Russian without
 * Latin letters and without clock words; `ideaRu` is short enough for a ≤ 20-word intro.
 *
 * Variety for Black too (the French and the Dutch among them): Black gets several cards against
 * every first move — against 1.e4 (open game, two knights, French, Scandinavian, Sicilian, Caro-Kann), against 1.d4
 * (orthodox, Slav, Dutch Stonewall, King's Indian) and SYSTEMS against anything else (classic development, King's
 * Indian and Queen's Indian set-ups, Botvinnik, reversed Sicilian). A system's first move is not sound against every
 * first move (1.c4 d5, 1.g4 Nf6, 1.Nf3 e5 lose more than the tolerance), so a system lists the first moves it answers (`answersUci`) — each of them
 * engine-verified too. The Dutch 1…f5 is sound only against 1.d4 (≤ 40 cp; against 1.Nf3 / 1.c4 / 1.b3 it is 40–95 cp
 * worse at depth 12–14), so it is not a system.
 */
import type { Color, StrategyCard } from '@gambit/shared';

/** Theme tags of a strategy — `@gambit/core` maps them to move ideas («по нашему плану» for a move with that idea). */
export const STRATEGY_THEMES = ['center', 'development', 'castle', 'f7', 'fortress', 'gambit', 'openFile', 'kingsideAttack', 'queensideAttack', 'counterCenter'] as const;
export type StrategyTheme = (typeof STRATEGY_THEMES)[number];

/** A library card: the shared `StrategyCard` plus what the teacher and the tests need. */
export interface StrategyEntry extends StrategyCard {
  /** the title in the accusative for «В этот раз разыграем …» («Итальянскую партию») */
  titleAccRu: string;
  /** the full main line from the initial position, both sides (English SAN, code only); `lineSan` = the child's moves of it */
  mainLineSan: string[];
  /** child moves that serve the middlegame plan (English SAN tags; the engine still decides whether they are good) */
  middlegameSan: string[];
  themes: StrategyTheme[];
  /**
   * 2–4 GOALS of the plan in kid words, as «мы» verb phrases («бьём по цепочке пешек ударом цэ пять»): what the teacher
   * keeps talking about once the opponent has left the main line — the strategy goes on, only the moves change.
   */
  planGoalsRu: string[];
  /**
   * Black systems (`against: 'other'`) only: the opponent's first moves (UCI) this system answers — its first move is
   * engine-verified after each of them. Absent = any first move.
   */
  answersUci?: string[];
}

/** The White first moves other than 1.e4 / 1.d4 (UCI) — what the Black systems must answer. */
export const OTHER_FIRST_MOVES_UCI: readonly string[] = [
  'g1f3',
  'c2c4',
  'b2b3',
  'f2f4',
  'd2d3',
  'g2g3',
  'e2e3',
  'b1c3',
  'c2c3',
  'a2a3',
  'h2h3',
  'b2b4',
  'a2a4',
  'h2h4',
  'f2f3',
  'g2g4',
  'b1a3',
  'g1h3',
];

const except = (...excluded: string[]): string[] => OTHER_FIRST_MOVES_UCI.filter((uci) => !excluded.includes(uci));

export const STRATEGIES: StrategyEntry[] = [
  // ─────────────── White ───────────────
  {
    id: 'italian',
    titleRu: 'Итальянская партия',
    titleAccRu: 'Итальянскую партию',
    ideaRu: 'быстро выводим фигуры и целимся в слабую точку',
    side: 'w',
    against: 'any',
    mainLineSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1', 'a6', 'Bb3', 'Ba7', 'Nbd2', 'h6', 'Nf1'],
    lineSan: ['e4', 'Nf3', 'Bc4', 'c3', 'd3', 'O-O', 'Re1', 'Bb3', 'Nbd2', 'Nf1'],
    stepsRu: [
      'пешка на е четыре занимает центр',
      'конь на эф три нападает на пешку е пять',
      'слон на цэ четыре целится в слабую точку эф семь',
      'пешки цэ три и дэ три держат центр',
      'рокировка прячет короля в домик',
    ],
    middlegameRu: ['ладья встаёт на е один и помогает центру', 'конь идёт длинным путём на королевский фланг', 'потом готовим удар пешкой дэ четыре'],
    middlegameSan: ['Re1', 'Bb3', 'Nbd2', 'Nf1', 'Ng3', 'h3', 'd4', 'a4'],
    minStage: 1,
    themes: ['center', 'development', 'f7', 'castle'],
    planGoalsRu: ['целимся слоном в слабую точку эф семь', 'держим центр пешками цэ три и дэ три', 'готовим удар пешкой дэ четыре'],
  },
  {
    id: 'four-knights',
    titleRu: 'Партия четырёх коней',
    titleAccRu: 'Партию четырёх коней',
    ideaRu: 'оба коня в бой, потом слоны и рокировка',
    side: 'w',
    against: 'any',
    mainLineSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6', 'Bb5', 'Bb4', 'O-O', 'O-O', 'd3', 'd6', 'Bg5', 'Bxc3', 'bxc3', 'Qe7', 'Re1'],
    lineSan: ['e4', 'Nf3', 'Nc3', 'Bb5', 'O-O', 'd3', 'Bg5', 'bxc3', 'Re1'],
    stepsRu: ['пешка на е четыре занимает центр', 'конь на эф три и конь на цэ три', 'слон на бэ пять смотрит на коня соперника', 'рокировка', 'пешка дэ три и слон на же пять'],
    middlegameRu: ['ладья встаёт на е один', 'готовим пешку дэ четыре в центр', 'слон на же пять связывает коня'],
    middlegameSan: ['Bg5', 'Re1', 'd4', 'h3', 'Qd2', 'Bc4'],
    minStage: 1,
    themes: ['development', 'center', 'castle'],
    planGoalsRu: ['выводим обоих коней к центру', 'связываем коня соперника слоном на же пять', 'готовим пешку дэ четыре в центр'],
  },
  {
    id: 'london',
    titleRu: 'Лондонская система',
    titleAccRu: 'Лондонскую систему',
    ideaRu: 'сначала выводим слона, потом строим крепость из пешек',
    side: 'w',
    against: 'any',
    mainLineSan: ['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3', 'Bd6', 'Bg3', 'O-O', 'Bd3', 'c5', 'c3', 'Nc6', 'Nbd2', 'b6', 'O-O'],
    lineSan: ['d4', 'Bf4', 'e3', 'Nf3', 'Bg3', 'Bd3', 'c3', 'Nbd2', 'O-O'],
    stepsRu: ['пешка на дэ четыре занимает центр', 'слон на эф четыре выходит раньше пешки е три', 'пешки е три и цэ три строят крепость', 'конь на эф три и слон на дэ три', 'рокировка'],
    middlegameRu: ['конь прыгает на е пять', 'ферзь встаёт рядом с королём', 'потом пешка е четыре открывает игру'],
    middlegameSan: ['Ne5', 'Qe2', 'Qc2', 'e4', 'h3', 'Re1'],
    minStage: 1,
    themes: ['fortress', 'development', 'center', 'castle'],
    planGoalsRu: ['выводим слона на эф четыре раньше пешки е три', 'строим крепость из пешек в центре', 'прыгаем конём на е пять'],
  },
  {
    id: 'bishops-opening',
    titleRu: 'Дебют слона',
    titleAccRu: 'Дебют слона',
    ideaRu: 'слон выходит первым и сразу смотрит на эф семь',
    side: 'w',
    against: 'any',
    mainLineSan: ['e4', 'e5', 'Bc4', 'Nf6', 'd3', 'Nc6', 'Nf3', 'Be7', 'O-O', 'O-O', 'Re1', 'd6', 'c3', 'Na5', 'Bb5'],
    lineSan: ['e4', 'Bc4', 'd3', 'Nf3', 'O-O', 'Re1', 'c3', 'Bb5'],
    stepsRu: ['пешка на е четыре занимает центр', 'слон на цэ четыре целится в эф семь', 'пешка дэ три защищает центр', 'конь на эф три и рокировка'],
    middlegameRu: ['ладья встаёт на е один', 'пешка цэ три готовит дэ четыре', 'слон уходит от нападения и остаётся живым'],
    middlegameSan: ['Re1', 'c3', 'Bb3', 'Nbd2', 'h3', 'd4'],
    minStage: 1,
    themes: ['f7', 'development', 'center', 'castle'],
    planGoalsRu: ['целимся слоном в слабую точку эф семь', 'держим центр пешками дэ три и цэ три', 'готовим удар пешкой дэ четыре'],
  },
  {
    id: 'colle',
    titleRu: 'Система Колле',
    titleAccRu: 'Систему Колле',
    ideaRu: 'строим крепость из пешек и готовим удар в центре',
    side: 'w',
    against: 'any',
    mainLineSan: ['d4', 'd5', 'Nf3', 'Nf6', 'e3', 'e6', 'Bd3', 'c5', 'c3', 'Nc6', 'Nbd2', 'Bd6', 'O-O', 'O-O', 'dxc5', 'Bxc5', 'e4'],
    lineSan: ['d4', 'Nf3', 'e3', 'Bd3', 'c3', 'Nbd2', 'O-O', 'dxc5', 'e4'],
    stepsRu: ['пешка на дэ четыре занимает центр', 'конь на эф три', 'пешка е три открывает слона', 'слон на дэ три смотрит на короля соперника', 'пешка цэ три, конь на дэ два и рокировка'],
    middlegameRu: ['пешка е четыре бьёт по центру', 'ферзь встаёт на е два', 'ладья встаёт на е один'],
    middlegameSan: ['e4', 'Qe2', 'Re1', 'Qc2', 'h3', 'Ne5'],
    minStage: 1,
    themes: ['fortress', 'center', 'development', 'castle'],
    planGoalsRu: ['строим крепость пешками дэ четыре, е три и цэ три', 'ставим слона на дэ три смотреть на короля', 'готовим удар пешкой е четыре'],
  },
  {
    id: 'scotch',
    titleRu: 'Шотландская партия',
    titleAccRu: 'Шотландскую партию',
    ideaRu: 'сразу бьёмся за центр пешкой дэ четыре',
    side: 'w',
    against: 'any',
    mainLineSan: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4', 'Nf6', 'Nc3', 'Bb4', 'Nxc6', 'bxc6', 'Bd3', 'd5', 'exd5', 'cxd5', 'O-O', 'O-O', 'Bg5', 'c6'],
    lineSan: ['e4', 'Nf3', 'd4', 'Nxd4', 'Nc3', 'Nxc6', 'Bd3', 'exd5', 'O-O', 'Bg5'],
    stepsRu: ['пешка на е четыре', 'конь на эф три', 'пешка дэ четыре бьётся за центр', 'конь забирает пешку в центре', 'второй конь, слон и рокировка'],
    middlegameRu: ['слон на же пять связывает коня', 'ферзь встаёт на эф три', 'ладьи выходят на открытые линии'],
    middlegameSan: ['Bg5', 'Qf3', 'Re1', 'Rb1', 'h3', 'Ne2'],
    minStage: 2,
    themes: ['center', 'development', 'openFile', 'castle'],
    planGoalsRu: ['сразу бьёмся за центр пешкой дэ четыре', 'выводим фигуры на открытые линии', 'связываем коня соперника слоном на же пять'],
  },
  {
    id: 'vienna',
    titleRu: 'Венская партия',
    titleAccRu: 'Венскую партию',
    ideaRu: 'конь выходит раньше слона и крепко держит центр',
    side: 'w',
    against: 'any',
    mainLineSan: ['e4', 'e5', 'Nc3', 'Nf6', 'Bc4', 'Nc6', 'd3', 'Bb4', 'Nf3', 'd6', 'O-O', 'Bxc3', 'bxc3', 'O-O', 'Re1', 'h6', 'h3'],
    lineSan: ['e4', 'Nc3', 'Bc4', 'd3', 'Nf3', 'O-O', 'bxc3', 'Re1', 'h3'],
    stepsRu: ['пешка на е четыре', 'конь на цэ три держит центр', 'слон на цэ четыре целится в эф семь', 'пешка дэ три, конь на эф три и рокировка'],
    middlegameRu: ['ладья встаёт на е один', 'пешка аш три не пускает фигуры соперника', 'потом готовим пешку дэ четыре'],
    middlegameSan: ['Re1', 'h3', 'Bb3', 'd4', 'a4', 'Nh4'],
    minStage: 2,
    themes: ['center', 'development', 'f7', 'castle'],
    planGoalsRu: ['держим центр конём на цэ три', 'целимся слоном в слабую точку эф семь', 'готовим пешку дэ четыре'],
  },
  {
    id: 'spanish',
    titleRu: 'Испанская партия',
    titleAccRu: 'Испанскую партию',
    ideaRu: 'слон давит на коня, который защищает центр',
    side: 'w',
    against: 'any',
    mainLineSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3'],
    lineSan: ['e4', 'Nf3', 'Bb5', 'Ba4', 'O-O', 'Re1', 'Bb3', 'c3', 'h3'],
    stepsRu: ['пешка на е четыре занимает центр', 'конь на эф три нападает на пешку е пять', 'слон на бэ пять давит на коня', 'рокировка и ладья на е один', 'пешка цэ три готовит пешку дэ четыре'],
    middlegameRu: ['пешка дэ четыре бьёт по центру', 'конь идёт длинным путём на королевский фланг', 'слон на бэ три смотрит на эф семь'],
    middlegameSan: ['d4', 'Nbd2', 'Nf1', 'Ng3', 'Bc2', 'a4'],
    minStage: 2,
    themes: ['center', 'development', 'castle', 'f7'],
    planGoalsRu: ['давим слоном на коня, который защищает центр', 'ставим ладью на е один в помощь центру', 'готовим удар пешкой дэ четыре'],
  },
  {
    id: 'queens-gambit',
    titleRu: 'Ферзевый гамбит',
    titleAccRu: 'Ферзевый гамбит',
    ideaRu: 'предлагаем пешку, чтобы забрать центр себе',
    side: 'w',
    against: 'any',
    mainLineSan: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O', 'Nf3', 'Nbd7', 'Rc1', 'c6', 'Bd3', 'dxc4', 'Bxc4', 'Nd5'],
    lineSan: ['d4', 'c4', 'Nc3', 'Bg5', 'e3', 'Nf3', 'Rc1', 'Bd3', 'Bxc4'],
    stepsRu: ['пешка на дэ четыре', 'пешка цэ четыре предлагает размен', 'конь на цэ три и слон на же пять', 'пешка е три и конь на эф три', 'ладья встаёт на линию цэ'],
    middlegameRu: ['ладья давит по линии цэ', 'рокировка и пешка е четыре в центр', 'меняем лишние фигуры'],
    middlegameSan: ['Rc1', 'O-O', 'Qc2', 'e4', 'Bxe7', 'Ne5'],
    minStage: 3,
    themes: ['gambit', 'center', 'openFile', 'development'],
    planGoalsRu: ['бьём пешкой цэ четыре по центру соперника', 'давим ладьёй по линии цэ', 'занимаем центр пешкой е четыре'],
  },

  // ─────────────── Black: against 1.e4 ───────────────
  {
    id: 'open-game',
    titleRu: 'Открытая игра',
    titleAccRu: 'Открытую игру',
    ideaRu: 'отвечаем пешкой в центр и выводим все фигуры',
    side: 'b',
    against: 'e4',
    mainLineSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1', 'a6', 'Bb3', 'Ba7'],
    lineSan: ['e5', 'Nc6', 'Bc5', 'Nf6', 'd6', 'O-O', 'a6', 'Ba7'],
    stepsRu: ['пешка на е пять занимает центр', 'конь на цэ шесть защищает её', 'слон на цэ пять и конь на эф шесть', 'пешка дэ шесть и рокировка'],
    middlegameRu: ['слон отходит в безопасное место', 'ладья встаёт на е восемь', 'держим пешку е пять'],
    middlegameSan: ['Ba7', 'Re8', 'Be6', 'h6', 'Ne7'],
    minStage: 1,
    themes: ['center', 'development', 'castle'],
    planGoalsRu: ['держим центр пешкой е пять', 'быстро выводим все фигуры', 'прячем короля рокировкой'],
  },
  {
    id: 'two-knights',
    titleRu: 'Защита двух коней',
    titleAccRu: 'Защиту двух коней',
    ideaRu: 'второй конь сразу нападает на пешку е четыре',
    side: 'b',
    against: 'e4',
    mainLineSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'Be7', 'O-O', 'O-O', 'Re1', 'd6', 'c3', 'Na5', 'Bb5', 'a6', 'Ba4', 'b5', 'Bc2'],
    lineSan: ['e5', 'Nc6', 'Nf6', 'Be7', 'O-O', 'd6', 'Na5', 'a6', 'b5'],
    stepsRu: ['пешка на е пять', 'конь на цэ шесть', 'второй конь на эф шесть нападает на пешку е четыре', 'слон на е семь и рокировка'],
    middlegameRu: ['конь прогоняет белого слона', 'пешки ферзевого фланга идут вперёд', 'держим пешку е пять'],
    middlegameSan: ['Na5', 'a6', 'b5', 'c5', 'Re8', 'h6'],
    minStage: 1,
    themes: ['development', 'center', 'castle', 'queensideAttack'],
    planGoalsRu: ['нападаем конями на пешку е четыре', 'прогоняем слона соперника пешками', 'прячем короля рокировкой'],
  },
  {
    id: 'french',
    titleRu: 'Французская защита',
    titleAccRu: 'Французскую защиту',
    ideaRu: 'строим цепочку пешек и бьём по ней сбоку',
    side: 'b',
    against: 'e4',
    mainLineSan: ['e4', 'e6', 'd4', 'd5', 'e5', 'c5', 'c3', 'Nc6', 'Nf3', 'Qb6', 'Be2', 'cxd4', 'cxd4', 'Nge7', 'Nc3', 'Nf5'],
    lineSan: ['e6', 'd5', 'c5', 'Nc6', 'Qb6', 'cxd4', 'Nge7', 'Nf5'],
    stepsRu: ['пешка е шесть готовит пешку дэ пять', 'пешка дэ пять спорит за центр', 'пешка цэ пять бьёт по цепочке пешек', 'конь и ферзь давят на пешку дэ четыре', 'второй конь идёт на эф пять'],
    middlegameRu: ['конь на эф пять давит на центр', 'слон встаёт на е семь, король уходит в домик', 'пешка эф шесть ломает цепочку пешек'],
    middlegameSan: ['Nf5', 'Be7', 'Bd7', 'O-O', 'f6', 'Rc8'],
    minStage: 1,
    themes: ['counterCenter', 'center', 'development', 'castle'],
    planGoalsRu: ['бьём по цепочке пешек ударом цэ пять', 'давим конём и ферзём на пешку дэ четыре', 'ломаем цепочку ударом эф шесть'],
  },
  {
    id: 'scandinavian',
    titleRu: 'Скандинавская защита',
    titleAccRu: 'Скандинавскую защиту',
    ideaRu: 'сразу бьём по центру и быстро выводим фигуры',
    side: 'b',
    against: 'e4',
    mainLineSan: ['e4', 'd5', 'exd5', 'Nf6', 'd4', 'Nxd5', 'Nf3', 'Bg4', 'Be2', 'e6', 'O-O', 'Be7', 'c4', 'Nb6', 'Nc3', 'O-O', 'Be3', 'Nc6'],
    lineSan: ['d5', 'Nf6', 'Nxd5', 'Bg4', 'e6', 'Be7', 'Nb6', 'O-O', 'Nc6'],
    stepsRu: ['пешка дэ пять бьёт по центру', 'конь на эф шесть', 'слон на же четыре связывает коня', 'пешка е шесть, слон на е семь и рокировка'],
    middlegameRu: ['кони давят на центральную пешку', 'слон меняется на коня', 'ладья встаёт на линию дэ'],
    middlegameSan: ['Nc6', 'Bf6', 'Bxf3', 'Rd8', 'Qd7'],
    minStage: 1,
    themes: ['counterCenter', 'development', 'castle'],
    planGoalsRu: ['сразу бьём по центру пешкой дэ пять', 'связываем коня соперника слоном на же четыре', 'давим конями на пешку в центре'],
  },
  {
    id: 'sicilian',
    titleRu: 'Сицилианская защита',
    titleAccRu: 'Сицилианскую защиту',
    ideaRu: 'спорим за центр сбоку, а слон-дракон стреляет по диагонали',
    side: 'b',
    against: 'e4',
    mainLineSan: ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'g6', 'Nc3', 'Bg7', 'Be3', 'Nf6', 'Bc4', 'O-O', 'Bb3', 'd6', 'f3', 'Bd7'],
    lineSan: ['c5', 'Nc6', 'cxd4', 'g6', 'Bg7', 'Nf6', 'O-O', 'd6', 'Bd7'],
    stepsRu: ['пешка цэ пять спорит за центр сбоку', 'конь на цэ шесть', 'меняем пешку на центральную пешку соперника', 'пешка же шесть и слон на же семь — это дракон', 'конь на эф шесть и рокировка'],
    middlegameRu: ['слон-дракон смотрит по длинной диагонали', 'ладья встаёт на линию цэ', 'конь прыгает в центр на е пять'],
    middlegameSan: ['Rc8', 'Ne5', 'Nc4', 'Qa5', 'a5', 'Re8'],
    minStage: 2,
    themes: ['counterCenter', 'development', 'castle', 'queensideAttack'],
    planGoalsRu: ['спорим за центр пешкой цэ пять сбоку', 'ставим слона-дракона на длинную диагональ', 'давим ладьёй по линии цэ'],
  },
  {
    id: 'caro-kann',
    titleRu: 'Защита Каро-Канн',
    titleAccRu: 'Защиту Каро-Канн',
    ideaRu: 'строим крепкий центр, а слон выходит на свободу',
    side: 'b',
    against: 'e4',
    mainLineSan: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5', 'Ng3', 'Bg6', 'Nf3', 'Nd7', 'Bd3', 'Bxd3', 'Qxd3', 'e6', 'O-O', 'Ngf6', 'Re1', 'Be7'],
    lineSan: ['c6', 'd5', 'dxe4', 'Bf5', 'Bg6', 'Nd7', 'Bxd3', 'e6', 'Ngf6', 'Be7'],
    stepsRu: ['пешка цэ шесть готовит пешку дэ пять', 'пешка дэ пять в центр', 'слон выходит на эф пять раньше пешки е шесть', 'пешка е шесть и конь на эф шесть', 'слон на е семь и рокировка'],
    middlegameRu: ['рокировка, и позиция крепкая', 'пешка цэ пять бьёт по центру', 'ферзь встаёт на цэ семь'],
    middlegameSan: ['O-O', 'c5', 'Qc7', 'Rd8', 'Qb6'],
    minStage: 2,
    themes: ['fortress', 'development', 'center', 'castle'],
    planGoalsRu: ['выводим слона раньше пешки е шесть', 'держим центр крепкими пешками цэ шесть и дэ пять', 'готовим удар пешкой цэ пять'],
  },

  // ─────────────── Black: against 1.d4 ───────────────
  {
    id: 'orthodox',
    titleRu: 'Ортодоксальная защита',
    titleAccRu: 'Ортодоксальную защиту',
    ideaRu: 'крепко держим пешку в центре и спокойно развиваемся',
    side: 'b',
    against: 'd4',
    mainLineSan: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e3', 'O-O', 'Nf3', 'Nbd7', 'Rc1', 'c6', 'Bd3', 'dxc4', 'Bxc4', 'Nd5', 'Bxe7', 'Qxe7'],
    lineSan: ['d5', 'e6', 'Nf6', 'Be7', 'O-O', 'Nbd7', 'c6', 'dxc4', 'Nd5', 'Qxe7'],
    stepsRu: ['пешка на дэ пять', 'пешка е шесть поддерживает её', 'конь на эф шесть и слон на е семь', 'рокировка', 'конь на дэ семь и пешка цэ шесть'],
    middlegameRu: ['меняем фигуры, чтобы стало просторнее', 'пешка е пять освобождает слона', 'ладья встаёт на линию дэ'],
    middlegameSan: ['Nxc3', 'e5', 'Rd8', 'b6', 'Bb7'],
    minStage: 1,
    themes: ['fortress', 'center', 'development', 'castle'],
    planGoalsRu: ['крепко держим пешку дэ пять', 'меняем фигуры, чтобы стало просторнее', 'освобождаем слона ударом е пять'],
  },
  {
    id: 'slav',
    titleRu: 'Славянская защита',
    titleAccRu: 'Славянскую защиту',
    ideaRu: 'пешка цэ шесть держит центр, слон выходит заранее',
    side: 'b',
    against: 'd4',
    mainLineSan: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'dxc4', 'a4', 'Bf5', 'e3', 'e6', 'Bxc4', 'Bb4', 'O-O', 'O-O', 'Qe2', 'Nbd7'],
    lineSan: ['d5', 'c6', 'Nf6', 'dxc4', 'Bf5', 'e6', 'Bb4', 'O-O', 'Nbd7'],
    stepsRu: ['пешка на дэ пять', 'пешка цэ шесть поддерживает её', 'конь на эф шесть', 'слон выходит на эф пять', 'пешка е шесть и рокировка'],
    middlegameRu: ['конь на дэ семь готовит пешку е пять', 'слон на же шесть прячется от нападения', 'ферзь встаёт на цэ семь'],
    middlegameSan: ['Nbd7', 'Bg6', 'Qc7', 'e5', 'Qe7'],
    minStage: 1,
    themes: ['fortress', 'center', 'development', 'castle'],
    planGoalsRu: ['держим центр пешками цэ шесть и дэ пять', 'выводим слона на эф пять раньше пешки е шесть', 'прячем короля рокировкой'],
  },
  {
    id: 'dutch-stonewall',
    titleRu: 'Голландская защита',
    titleAccRu: 'Голландскую защиту',
    ideaRu: 'строим каменную стену из пешек и идём на короля',
    side: 'b',
    against: 'd4',
    mainLineSan: ['d4', 'f5', 'Nf3', 'Nf6', 'g3', 'e6', 'Bg2', 'd5', 'O-O', 'Bd6', 'c4', 'c6', 'b3', 'Qe7', 'Bb2', 'O-O'],
    lineSan: ['f5', 'Nf6', 'e6', 'd5', 'Bd6', 'c6', 'Qe7', 'O-O'],
    stepsRu: ['пешка эф пять держит клетку е четыре', 'конь на эф шесть', 'пешки е шесть, дэ пять и цэ шесть строят стену', 'слон на дэ шесть смотрит на королевский фланг', 'ферзь на е семь и рокировка'],
    middlegameRu: ['конь прыгает на е четыре', 'ферзь идёт на аш пять к королю соперника', 'пешка же пять начинает атаку'],
    middlegameSan: ['Ne4', 'Nbd7', 'Qe8', 'Qh5', 'g5', 'Rf6'],
    minStage: 1,
    themes: ['fortress', 'kingsideAttack', 'development', 'castle'],
    planGoalsRu: ['держим клетку е четыре стеной из пешек', 'прыгаем конём на е четыре', 'ведём ферзя и ладью в атаку на короля'],
  },
  {
    id: 'kings-indian',
    titleRu: 'Староиндийская защита',
    titleAccRu: 'Староиндийскую защиту',
    ideaRu: 'прячем короля за слоном и ломаем центр пешкой',
    side: 'b',
    against: 'd4',
    mainLineSan: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O', 'Be2', 'e5', 'O-O', 'Nc6', 'd5', 'Ne7'],
    lineSan: ['Nf6', 'g6', 'Bg7', 'd6', 'O-O', 'e5', 'Nc6', 'Ne7'],
    stepsRu: ['конь на эф шесть', 'пешка же шесть и слон на же семь', 'пешка дэ шесть и рокировка', 'пешка е пять бьёт по центру', 'конь уходит на е семь к королю'],
    middlegameRu: ['конь освобождает дорогу пешке эф', 'пешка эф пять идёт в атаку на короля', 'фигуры помогают атаке на королевском фланге'],
    middlegameSan: ['Nd7', 'Ne8', 'f5', 'f4', 'g5', 'Ng6'],
    minStage: 2,
    themes: ['counterCenter', 'kingsideAttack', 'development', 'castle'],
    planGoalsRu: ['ставим слона на длинную диагональ', 'бьём по центру пешкой е пять', 'идём пешкой эф пять в атаку на короля'],
  },

  // ─────────────── Black: against other first moves ───────────────
  {
    id: 'classic-development',
    titleRu: 'Классическое развитие',
    titleAccRu: 'классическое развитие',
    ideaRu: 'пешка в центр, фигуры в игру, король в домик',
    side: 'b',
    against: 'other',
    mainLineSan: ['Nf3', 'd5', 'g3', 'Nf6', 'Bg2', 'e6', 'O-O', 'Be7', 'd3', 'O-O', 'Nbd2', 'c5', 'e4', 'Nc6', 'Re1', 'b5'],
    lineSan: ['d5', 'Nf6', 'e6', 'Be7', 'O-O', 'c5', 'Nc6', 'b5'],
    stepsRu: ['пешка на дэ пять в центр', 'конь на эф шесть', 'пешка е шесть открывает слона', 'слон на е семь и рокировка'],
    middlegameRu: ['пешки ферзевого фланга идут вперёд', 'слон встаёт на длинную диагональ', 'ладья встаёт на линию цэ'],
    middlegameSan: ['b5', 'Bb7', 'Rc8', 'c4', 'a5'],
    minStage: 1,
    themes: ['center', 'development', 'castle', 'queensideAttack'],
    planGoalsRu: ['держим центр пешкой дэ пять', 'выводим фигуры и прячем короля', 'двигаем пешки ферзевого фланга вперёд'],
    // 1.c4 d5? 2.cxd5 is more than the tolerance behind 1…e5
    answersUci: except('c2c4'),
  },
  {
    id: 'kings-indian-setup',
    titleRu: 'Староиндийское построение',
    titleAccRu: 'Староиндийское построение',
    ideaRu: 'слон на длинной диагонали, король за ним в крепости',
    side: 'b',
    against: 'other',
    mainLineSan: ['Nf3', 'Nf6', 'g3', 'g6', 'Bg2', 'Bg7', 'O-O', 'O-O', 'd3', 'd6', 'e4', 'e5', 'Nc3', 'Nc6'],
    lineSan: ['Nf6', 'g6', 'Bg7', 'O-O', 'd6', 'e5', 'Nc6'],
    stepsRu: ['конь на эф шесть', 'пешка же шесть и слон на же семь', 'рокировка прячет короля в крепость', 'пешки дэ шесть и е пять держат центр'],
    middlegameRu: ['конь на цэ шесть помогает центру', 'ладья встаёт на е восемь', 'пешка эф пять идёт вперёд'],
    middlegameSan: ['Nc6', 'Re8', 'h6', 'Nh5', 'f5', 'Be6'],
    minStage: 1,
    themes: ['fortress', 'center', 'development', 'castle'],
    planGoalsRu: ['ставим слона на длинную диагональ', 'прячем короля в крепость рокировкой', 'держим центр пешками дэ шесть и е пять'],
    // 1.g4 Nf6? 2.g5 and 1.Na3 Nf6 are more than the tolerance behind 1…d5 / 1…e5
    answersUci: except('g2g4', 'b1a3'),
  },
  {
    id: 'queens-indian-setup',
    titleRu: 'Новоиндийское построение',
    titleAccRu: 'Новоиндийское построение',
    ideaRu: 'слон на бэ семь смотрит по длинной диагонали',
    side: 'b',
    against: 'other',
    mainLineSan: ['Nf3', 'Nf6', 'g3', 'b6', 'Bg2', 'Bb7', 'O-O', 'e6', 'd3', 'Be7', 'e4', 'd6', 'Nc3', 'O-O'],
    lineSan: ['Nf6', 'b6', 'Bb7', 'e6', 'Be7', 'd6', 'O-O'],
    stepsRu: ['конь на эф шесть', 'пешка бэ шесть открывает дорогу слону', 'слон на бэ семь смотрит на центр', 'пешка е шесть и слон на е семь', 'рокировка'],
    middlegameRu: ['конь на дэ семь помогает центру', 'пешка цэ пять бьёт по центру', 'ферзь встаёт на цэ семь'],
    middlegameSan: ['Nbd7', 'c5', 'Qc7', 'Re8', 'a6'],
    minStage: 2,
    themes: ['center', 'development', 'castle', 'queensideAttack'],
    planGoalsRu: ['ставим слона на бэ семь смотреть на центр', 'держим клетку е четыре слоном и конём', 'прячем короля рокировкой'],
    answersUci: except('g2g4', 'b1a3'),
  },
  {
    id: 'botvinnik-system',
    titleRu: 'Система Ботвинника',
    titleAccRu: 'Систему Ботвинника',
    ideaRu: 'пешки цэ пять и е пять крепко держат центр',
    side: 'b',
    against: 'other',
    mainLineSan: ['c4', 'c5', 'Nc3', 'Nc6', 'g3', 'g6', 'Bg2', 'Bg7', 'e3', 'e5', 'Nge2', 'Nge7', 'O-O', 'O-O', 'd3', 'd6'],
    lineSan: ['c5', 'Nc6', 'g6', 'Bg7', 'e5', 'Nge7', 'O-O', 'd6'],
    stepsRu: ['пешка цэ пять', 'конь на цэ шесть', 'пешка же шесть и слон на же семь', 'пешка е пять держит центр', 'второй конь на е семь и рокировка'],
    middlegameRu: ['пешка эф пять идёт вперёд', 'слон выходит на е шесть', 'ладья встаёт на линию бэ'],
    middlegameSan: ['f5', 'Be6', 'Rb8', 'a6', 'b5', 'h6'],
    minStage: 1,
    themes: ['center', 'fortress', 'development', 'castle'],
    planGoalsRu: ['держим центр пешками цэ пять и е пять', 'ставим слона на длинную диагональ', 'готовим пешку эф пять вперёд'],
    // 1.g4, 1.Na3 and 1.b4 c5 are more than the tolerance behind 1…d5 / 1…e5
    answersUci: except('g2g4', 'b1a3', 'b2b4'),
  },
  {
    id: 'reversed-sicilian',
    titleRu: 'Сицилианская наоборот',
    titleAccRu: 'Сицилианскую наоборот',
    ideaRu: 'сразу ставим пешку на е пять и выводим коней',
    side: 'b',
    against: 'other',
    mainLineSan: ['c4', 'e5', 'Nc3', 'Nf6', 'Nf3', 'Nc6', 'g3', 'd5', 'cxd5', 'Nxd5', 'Bg2', 'Nb6', 'O-O', 'Be7', 'd3', 'O-O'],
    lineSan: ['e5', 'Nf6', 'Nc6', 'd5', 'Nxd5', 'Nb6', 'Be7', 'O-O'],
    stepsRu: ['пешка е пять занимает центр', 'кони на эф шесть и цэ шесть', 'пешка дэ пять бьёт по центру', 'конь отходит на бэ шесть', 'слон на е семь и рокировка'],
    middlegameRu: ['слон выходит на е шесть', 'пешка эф пять идёт вперёд', 'ладья встаёт на линию дэ'],
    middlegameSan: ['Be6', 'f5', 'f6', 'Qd7', 'Rd8', 'a5'],
    minStage: 1,
    themes: ['center', 'development', 'counterCenter', 'castle'],
    planGoalsRu: ['ставим пешку на е пять в центр', 'выводим обоих коней к центру', 'бьём по центру пешкой дэ пять'],
    // 1.Nf3 e5? loses the pawn, 1.f4 e5 is a gambit: those first moves get the other systems
    answersUci: except('g1f3', 'f2f4'),
  },
];

const BY_ID: ReadonlyMap<string, StrategyEntry> = new Map(STRATEGIES.map((s) => [s.id, s]));

/** The library card by id (undefined for an unknown id — the strategist's answer must be one of these). */
export function getStrategy(id: string): StrategyEntry | undefined {
  return BY_ID.get(id);
}

/** Which group of Black strategies answers the opponent's first move (UCI): 1.e4 → 'e4', 1.d4 → 'd4', anything else → 'other'. */
export function strategyGroupOf(opponentFirstUci: string): StrategyCard['against'] {
  const u = opponentFirstUci.trim().toLowerCase();
  if (u === 'e2e4') return 'e4';
  if (u === 'd2d4') return 'd4';
  return 'other';
}

/** A Black system answers this first move (its `answersUci`; no list = any). */
export function answersFirstMove(s: Pick<StrategyEntry, 'answersUci'>, opponentFirstUci: string): boolean {
  return s.answersUci === undefined || s.answersUci.includes(opponentFirstUci.trim().toLowerCase());
}

/**
 * The library strategies that fit a game: the child's colour, the stage (`minStage ≤ stage`; when none fits, the
 * easiest ones) and — for Black — the opponent's first move (without it: every Black strategy, the game re-asks once
 * the first move is known; a system only when it answers that move — `answersUci`, never empty: the whole group when
 * no system does). Library order (easiest first).
 */
export function getStrategiesFor(color: Color, stage: number, opponentFirstUci?: string): StrategyEntry[] {
  const group = color === 'b' && opponentFirstUci ? strategyGroupOf(opponentFirstUci) : null;
  const inGroup = STRATEGIES.filter((s) => s.side === color && (group === null || s.against === group));
  const answering = group === null || opponentFirstUci === undefined ? inGroup : inGroup.filter((s) => answersFirstMove(s, opponentFirstUci));
  const pool = answering.length > 0 ? answering : inGroup;
  const fitting = pool.filter((s) => s.minStage <= stage);
  if (fitting.length > 0) return fitting;
  const easiest = Math.min(...pool.map((s) => s.minStage));
  return pool.filter((s) => s.minStage === easiest);
}

/** How many of the latest strategies are never repeated while an alternative exists. */
export const STRATEGY_NO_REPEAT = 3;

/**
 * The free fallback of the strategist: a strategy the child did not play in the last `STRATEGY_NO_REPEAT` games when
 * possible — never-played ones first, then any fresh one (chosen by `rng`); when every candidate was played recently,
 * the one played longest ago. `history` = strategy ids of the student's games, OLDEST FIRST (the latest last).
 * Deterministic for an injected `rng`; null for no candidates.
 */
export function pickStrategyDeterministic<T extends Pick<StrategyCard, 'id'>>(candidates: readonly T[], history: readonly string[], rng: () => number = Math.random): T | null {
  if (candidates.length === 0) return null;
  const recent = new Set(history.slice(-STRATEGY_NO_REPEAT));
  const fresh = candidates.filter((c) => !recent.has(c.id));
  if (fresh.length === 0) {
    // every candidate was played recently: the one whose last game is the oldest
    const lastIndex = (id: string): number => history.lastIndexOf(id);
    return [...candidates].sort((a, b) => lastIndex(a.id) - lastIndex(b.id))[0] ?? null;
  }
  const played = new Set(history);
  const never = fresh.filter((c) => !played.has(c.id));
  const pool = never.length > 0 ? never : fresh;
  const r = rng();
  const i = Number.isFinite(r) ? Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length))) : 0;
  return pool[i] ?? null;
}
