/**
 * The Russian catalogue of the «Записи» voice (docs/voice-clips/SPEC.md §3.3, §7): every line Гамбитик can say from
 * recordings, as `ClipCatalogLine`s — the one list the tools record (`catalogUnits`), the lint checks (`lintCatalog`),
 * the clip twins of the builders point into (./twins.ts) and the tests measure. Written for the ear of a 7–10-year-old
 * (short, warm, concrete, varied) and for Гамбитик as a BOY.
 *
 * It lives in @gambit/core (not @gambit/content) because the twins must know which lines exist and how long they are;
 * core has no runtime dependency on content. What comes from content — the 24 strategies and their plan goals — is
 * mirrored by id / text here and checked against the real library by catalog.test.ts (test-only relative import).
 *
 * Parts: ./catalog.teach.ru.ts (the teacher turn: heads, reasons, goals, opponent, danger, treasure, plans) and
 * ./catalog.game.ru.ts (greeting, start, strategy intros, praise, take-backs, game end, generics, barks, «Спроси»).
 */
import type { ClipCatalogLine } from '@gambit/shared';
import { GAME_CATALOG } from './catalog.game.ru.ts';
import { TEACH_CATALOG } from './catalog.teach.ru.ts';

export { CLIP_TAP_LINES } from './catalog.game.ru.ts';

export const CLIP_CATALOG: readonly ClipCatalogLine[] = [...TEACH_CATALOG, ...GAME_CATALOG];

const BY_ID: ReadonlyMap<string, ClipCatalogLine> = new Map(CLIP_CATALOG.map((l) => [l.id, l]));

/** The catalogue line with this id, or undefined. */
export function clipCatalogLine(id: string): ClipCatalogLine | undefined {
  return BY_ID.get(id);
}

/** Is this a line of the catalogue (a twin never points at anything else)? */
export function hasClipLine(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * The strategy library's plan goals (`planGoalsRu` of @gambit/content, as `planGoalRu` returns them: trimmed, without
 * the end mark) → the goal tail that says them without squares. A goal missing here is told as the plain plan tail
 * (`teach.tail.plan`); catalog.test.ts keeps this table complete for the real library.
 */
export const PLAN_GOAL_LINES: Readonly<Record<string, string>> = {
  'целимся слоном в слабую точку эф семь': 'goal.aimF7',
  'держим центр пешками цэ три и дэ три': 'goal.holdCentre',
  'держим центр пешками дэ три и цэ три': 'goal.holdCentre',
  'готовим удар пешкой дэ четыре': 'goal.centreStrike',
  'готовим пешку дэ четыре в центр': 'goal.centreStrike',
  'готовим пешку дэ четыре': 'goal.centreStrike',
  'готовим удар пешкой е четыре': 'goal.centreStrike',
  'готовим удар пешкой цэ пять': 'goal.centreStrike',
  'выводим обоих коней к центру': 'goal.bothKnights',
  'связываем коня соперника слоном на же пять': 'goal.pinKnight',
  'связываем коня соперника слоном на же четыре': 'goal.pinKnight',
  'выводим слона на эф четыре раньше пешки е три': 'goal.bishopFirst',
  'выводим слона раньше пешки е шесть': 'goal.bishopFirst',
  'выводим слона на эф пять раньше пешки е шесть': 'goal.bishopFirst',
  'строим крепость из пешек в центре': 'goal.pawnFortress',
  'строим крепость пешками дэ четыре, е три и цэ три': 'goal.pawnFortress',
  'прыгаем конём на е пять': 'goal.knightJump',
  'прыгаем конём на е четыре': 'goal.knightJump',
  'ставим слона на дэ три смотреть на короля': 'goal.bishopAtKing',
  'сразу бьёмся за центр пешкой дэ четыре': 'goal.fightCentre',
  'выводим фигуры на открытые линии': 'goal.openLines',
  'держим центр конём на цэ три': 'goal.knightHoldsCentre',
  'давим слоном на коня, который защищает центр': 'goal.pressKnight',
  'ставим ладью на е один в помощь центру': 'goal.rookCentre',
  'бьём пешкой цэ четыре по центру соперника': 'goal.hitCentre',
  'сразу бьём по центру пешкой дэ пять': 'goal.hitCentre',
  'бьём по центру пешкой е пять': 'goal.hitCentre',
  'бьём по центру пешкой дэ пять': 'goal.hitCentre',
  'давим ладьёй по линии цэ': 'goal.rookFile',
  'занимаем центр пешкой е четыре': 'goal.takeCentre',
  'ставим пешку на е пять в центр': 'goal.takeCentre',
  'держим центр пешкой е пять': 'goal.holdCentre',
  'держим центр пешкой дэ пять': 'goal.holdCentre',
  'крепко держим пешку дэ пять': 'goal.holdCentre',
  'держим центр пешками цэ шесть и дэ пять': 'goal.holdCentre',
  'держим центр крепкими пешками цэ шесть и дэ пять': 'goal.holdCentre',
  'держим центр пешками дэ шесть и е пять': 'goal.holdCentre',
  'держим центр пешками цэ пять и е пять': 'goal.holdCentre',
  'быстро выводим все фигуры': 'goal.developAll',
  'прячем короля рокировкой': 'goal.castle',
  'прячем короля в крепость рокировкой': 'goal.castle',
  'нападаем конями на пешку е четыре': 'goal.pressCentrePawn',
  'давим конями на пешку в центре': 'goal.pressCentrePawn',
  'давим конём и ферзём на пешку дэ четыре': 'goal.pressCentrePawn',
  'прогоняем слона соперника пешками': 'goal.chaseBishop',
  'бьём по цепочке пешек ударом цэ пять': 'goal.chain',
  'ломаем цепочку ударом эф шесть': 'goal.chain',
  'спорим за центр пешкой цэ пять сбоку': 'goal.flankCentre',
  'ставим слона-дракона на длинную диагональ': 'goal.longDiagonal',
  'ставим слона на длинную диагональ': 'goal.longDiagonal',
  'ставим слона на бэ семь смотреть на центр': 'goal.longDiagonal',
  'меняем фигуры, чтобы стало просторнее': 'goal.tradeForSpace',
  'освобождаем слона ударом е пять': 'goal.freeBishop',
  'держим клетку е четыре стеной из пешек': 'goal.holdSquare',
  'держим клетку е четыре слоном и конём': 'goal.holdSquare',
  'ведём ферзя и ладью в атаку на короля': 'goal.attackKing',
  'идём пешкой эф пять в атаку на короля': 'goal.attackKing',
  'выводим фигуры и прячем короля': 'goal.developCastle',
  'двигаем пешки ферзевого фланга вперёд': 'goal.queensidePawns',
  'готовим пешку эф пять вперёд': 'goal.pawnStorm',
};

/** The goal tail of a library goal text (with or without its end mark), or null when the catalogue has none. */
export function planGoalLineOf(goalRu: string | null | undefined): string | null {
  if (typeof goalRu !== 'string') return null;
  const key = goalRu.trim().replace(/[.!…]+$/u, '').replace(/\s+/g, ' ');
  return PLAN_GOAL_LINES[key] ?? PLAN_GOAL_LINES[key.charAt(0).toLowerCase() + key.slice(1)] ?? null;
}

/** The strategy's intro line (`strategy.<id>`), or null when the id is not one of the 24 library strategies. */
export function strategyLineOf(strategyId: string | null | undefined): string | null {
  if (typeof strategyId !== 'string' || strategyId === '') return null;
  const id = `strategy.${strategyId}`;
  return BY_ID.has(id) ? id : null;
}
