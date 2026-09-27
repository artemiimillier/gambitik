/**
 * The strategy library as the server sees it: the curated cards of @gambit/content (STRATEGIES,
 * `getStrategiesFor`, `pickStrategyDeterministic`, `STRATEGY_NO_REPEAT` — imported defensively by
 * content.ts; a small built-in set only when those exports are missing), the variety rule and the
 * first move of a card.
 *
 * The CODE decides which cards are candidates for a game (colour, stage, the opponent's first move,
 * the last strategies of this student). A model may only choose among them.
 */
import { Chess } from 'chess.js';
import type { Color, StrategyCard } from '@gambit/shared';

export type StrategyAgainst = StrategyCard['against'];

/** A library card; `titleAccRu` = the title in the accusative for «В этот раз разыграем …» (@gambit/content). */
export interface LibraryCard extends StrategyCard {
  titleAccRu?: string;
}

/** How many recent strategy ids are remembered per student (kv 'strategy-history'). */
export const STRATEGY_HISTORY_LIMIT = 5;
/** Never repeat one of the last N strategies while an alternative exists (@gambit/content STRATEGY_NO_REPEAT). */
export const DEFAULT_NO_REPEAT = 3;
/** At most this many cards are shown to the model (a short prompt is a fast prompt). */
export const MAX_STRATEGY_CANDIDATES = 6;

/**
 * Last resort for each colour when nothing in the library fits: the principles every teacher falls
 * back to. Never offered while a real card fits.
 */
export const GENERIC_STRATEGIES: readonly LibraryCard[] = [
  {
    id: 'principles-white',
    titleRu: 'Игра по правилам',
    titleAccRu: 'игру по правилам',
    ideaRu: 'пешка в центр, фигуры в игру, король в домик',
    side: 'w',
    against: 'any',
    lineSan: ['e4'],
    stepsRu: ['пешка в центр', 'кони и слоны выходят в игру', 'рокировка прячет короля в домик'],
    middlegameRu: ['ставим фигуры туда, где они видят больше клеток', 'ищем слабые места соперника'],
    minStage: 1,
    themes: ['center', 'development', 'castle'],
  },
  {
    id: 'principles-black',
    titleRu: 'Игра по правилам',
    titleAccRu: 'игру по правилам',
    ideaRu: 'пешка в центр, фигуры в игру, король в домик',
    side: 'b',
    against: 'any',
    lineSan: [],
    stepsRu: ['пешка в центр', 'кони и слоны выходят в игру', 'рокировка прячет короля в домик'],
    middlegameRu: ['ставим фигуры туда, где они видят больше клеток', 'ищем слабые места соперника'],
    minStage: 1,
    themes: ['center', 'development', 'castle'],
  },
];

/** Used only when @gambit/content exports no valid STRATEGIES (content.ts warns loudly then). */
export const FALLBACK_STRATEGIES: readonly LibraryCard[] = [
  {
    id: 'italian',
    titleRu: 'Итальянская партия',
    titleAccRu: 'Итальянскую партию',
    ideaRu: 'быстро выводим фигуры и целимся в слабую точку',
    side: 'w',
    against: 'any',
    lineSan: ['e4', 'Nf3', 'Bc4', 'c3', 'd3', 'O-O'],
    stepsRu: ['пешка на е четыре занимает центр', 'конь на эф три нападает на пешку е пять', 'слон на цэ четыре целится в слабую точку эф семь', 'рокировка прячет короля в домик'],
    middlegameRu: ['ладья встаёт на е один и помогает центру', 'потом готовим удар пешкой дэ четыре'],
    minStage: 1,
    themes: ['center', 'development', 'f7', 'castle'],
  },
  {
    id: 'london',
    titleRu: 'Лондонская система',
    titleAccRu: 'Лондонскую систему',
    ideaRu: 'сначала выводим слона, потом строим крепость из пешек',
    side: 'w',
    against: 'any',
    lineSan: ['d4', 'Bf4', 'e3', 'Nf3', 'Bd3', 'O-O'],
    stepsRu: ['пешка на дэ четыре занимает центр', 'слон на эф четыре выходит раньше пешки е три', 'пешки е три и цэ три строят крепость', 'рокировка'],
    middlegameRu: ['конь прыгает на е пять', 'потом пешка е четыре открывает игру'],
    minStage: 1,
    themes: ['fortress', 'development', 'center', 'castle'],
  },
  {
    id: 'open-game',
    titleRu: 'Открытая игра',
    titleAccRu: 'Открытую игру',
    ideaRu: 'отвечаем пешкой в центр и выводим все фигуры',
    side: 'b',
    against: 'e4',
    lineSan: ['e5', 'Nc6', 'Bc5', 'Nf6', 'd6', 'O-O'],
    stepsRu: ['пешка на е пять занимает центр', 'конь на цэ шесть защищает её', 'слон на цэ пять и конь на эф шесть', 'пешка дэ шесть и рокировка'],
    middlegameRu: ['ладья встаёт на е восемь', 'держим пешку е пять'],
    minStage: 1,
    themes: ['center', 'development', 'castle'],
  },
  {
    id: 'orthodox',
    titleRu: 'Ортодоксальная защита',
    titleAccRu: 'Ортодоксальную защиту',
    ideaRu: 'крепко держим пешку в центре и спокойно развиваемся',
    side: 'b',
    against: 'd4',
    lineSan: ['d5', 'e6', 'Nf6', 'Be7', 'O-O'],
    stepsRu: ['пешка на дэ пять', 'пешка е шесть поддерживает её', 'конь на эф шесть и слон на е семь', 'рокировка'],
    middlegameRu: ['меняем фигуры, чтобы стало просторнее', 'пешка е пять освобождает слона'],
    minStage: 1,
    themes: ['fortress', 'center', 'development', 'castle'],
  },
];

/** The first opponent move as the `against` key of a Black card; null = not known yet. */
export function againstKeyFor(opponentFirstUci: string | undefined): Exclude<StrategyAgainst, 'any'> | null {
  if (opponentFirstUci === undefined) return null;
  if (opponentFirstUci === 'e2e4') return 'e4';
  if (opponentFirstUci === 'd2d4') return 'd4';
  return 'other';
}

export interface EligibilityQuery {
  childColor: Color;
  stage: number;
  opponentFirstUci?: string;
}

/**
 * The built-in rule (same semantics as `getStrategiesFor` of @gambit/content): the child's colour,
 * `minStage ≤ stage` (a child below every card gets the easiest ones), and for Black a card answering
 * the opponent's first move — every Black card while that move is unknown (the game asks again once
 * it is). Empty when nothing fits.
 */
export function eligibleStrategies(cards: readonly LibraryCard[], query: EligibilityQuery): LibraryCard[] {
  const key = query.childColor === 'b' ? againstKeyFor(query.opponentFirstUci) : null;
  const pool = cards.filter((card) => card.side === query.childColor && (key === null || card.against === key || card.against === 'any'));
  const fitting = pool.filter((card) => card.minStage <= query.stage);
  if (fitting.length > 0 || pool.length === 0) return fitting;
  const easiest = Math.min(...pool.map((card) => card.minStage));
  return pool.filter((card) => card.minStage === easiest);
}

/**
 * Variety: cards not played in the last `noRepeat` games (history oldest → newest). When every card
 * was played recently, the least recently played half — never an empty list for a non-empty input.
 */
export function varietyCandidates<T extends Pick<StrategyCard, 'id'>>(eligible: readonly T[], history: readonly string[], noRepeat = DEFAULT_NO_REPEAT): T[] {
  const recent = new Set(history.slice(-Math.max(0, noRepeat)));
  const fresh = eligible.filter((card) => !recent.has(card.id));
  if (fresh.length > 0) return fresh;
  const lastPlayed = (id: string): number => history.lastIndexOf(id);
  const byAge = [...eligible].sort((a, b) => lastPlayed(a.id) - lastPlayed(b.id));
  return byAge.slice(0, Math.max(1, Math.ceil(byAge.length / 2)));
}

/** Built-in deterministic pick: a never-played candidate first (library order), else the first one. */
export function pickStrategyBuiltin<T extends Pick<StrategyCard, 'id'>>(candidates: readonly T[], history: readonly string[]): T | null {
  const played = new Set(history);
  return candidates.find((card) => !played.has(card.id)) ?? candidates[0] ?? null;
}

export interface FirstMove {
  san: string;
  uci: string;
  /** position before the child's first move */
  fenBefore: string;
}

/**
 * The child's first move of a card, proved legal with chess.js: White — the first move of the line;
 * Black — the reply to the opponent's (known) first move. `lineSan` holds the child's moves; a line
 * written with both sides' moves (starting with the opponent's move) is understood too.
 */
export function firstChildMove(card: StrategyCard, childColor: Color, opponentFirstUci?: string): FirstMove | null {
  const chess = new Chess();
  let opponentSan: string | null = null;
  if (childColor === 'b') {
    if (opponentFirstUci === undefined) return null;
    try {
      opponentSan = chess.move({ from: opponentFirstUci.slice(0, 2), to: opponentFirstUci.slice(2, 4), ...(opponentFirstUci.length > 4 ? { promotion: opponentFirstUci.slice(4) } : {}) }).san;
    } catch {
      return null;
    }
  }
  const fenBefore = chess.fen();
  const tryMove = (san: string | undefined): FirstMove | null => {
    if (san === undefined) return null;
    try {
      const move = new Chess(fenBefore).move(san);
      return { san: move.san, uci: move.lan, fenBefore };
    } catch {
      return null;
    }
  };
  const first = tryMove(card.lineSan[0]);
  if (first !== null) return first;
  if (opponentSan !== null && card.lineSan[0] === opponentSan) return tryMove(card.lineSan[1]);
  return null;
}

// ───────────────────────── the library object ─────────────────────────

export interface StrategyLibrary {
  /** the validated cards (content or built-in) */
  readonly cards: readonly LibraryCard[];
  /** where the cards and the rules came from — for the start-up log */
  readonly source: 'content' | 'builtin';
  readonly noRepeat: number;
  /** cards for this game in library order; the generic principles card when nothing fits */
  eligible(query: EligibilityQuery): LibraryCard[];
  /** the free deterministic choice among `candidates` (history oldest → newest) */
  pick(candidates: readonly LibraryCard[], history: readonly string[]): LibraryCard | null;
  /** a card by id (the generic principles cards too) */
  byId(id: string): LibraryCard | undefined;
}

export type GetStrategiesForFn = (color: Color, stage: number, opponentFirstUci?: string) => unknown;
export type PickStrategyFn = (candidates: readonly LibraryCard[], history: readonly string[], rng: () => number) => unknown;

export interface StrategyLibraryParts {
  cards: readonly LibraryCard[];
  source: 'content' | 'builtin';
  /** `getStrategiesFor` of @gambit/content (checked at every call; the built-in rule when it misbehaves) */
  getStrategiesFor?: GetStrategiesForFn | null;
  /** `pickStrategyDeterministic` of @gambit/content (called with rng = () => 0: the same history gives the same card) */
  pickStrategyDeterministic?: PickStrategyFn | null;
  noRepeat?: number;
}

function hasId(value: unknown): value is { id: string } {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string';
}

export function createStrategyLibrary(parts: StrategyLibraryParts): StrategyLibrary {
  const cards = parts.cards;
  const byId = (id: string): LibraryCard | undefined => cards.find((card) => card.id === id) ?? GENERIC_STRATEGIES.find((card) => card.id === id);
  return {
    cards,
    source: parts.source,
    noRepeat: parts.noRepeat ?? DEFAULT_NO_REPEAT,
    eligible(query) {
      let eligible: LibraryCard[] | null = null;
      if (typeof parts.getStrategiesFor === 'function') {
        try {
          const raw = parts.getStrategiesFor(query.childColor, query.stage, query.opponentFirstUci);
          if (Array.isArray(raw)) {
            // only validated cards of the right colour; ids the server does not know are dropped
            eligible = (raw as unknown[])
              .filter(hasId)
              .map((item) => cards.find((card) => card.id === item.id))
              .filter((card): card is LibraryCard => card !== undefined && card.side === query.childColor);
          }
        } catch {
          eligible = null;
        }
      }
      eligible ??= eligibleStrategies(cards, query);
      return eligible.length > 0 ? eligible : GENERIC_STRATEGIES.filter((card) => card.side === query.childColor);
    },
    pick(candidates, history) {
      if (candidates.length === 0) return null;
      if (typeof parts.pickStrategyDeterministic === 'function') {
        try {
          const raw = parts.pickStrategyDeterministic(candidates, history, () => 0);
          const chosen = hasId(raw) ? candidates.find((card) => card.id === raw.id) : undefined;
          if (chosen !== undefined) return chosen;
        } catch {
          // the built-in pick below
        }
      }
      return pickStrategyBuiltin(candidates, history);
    },
    byId,
  };
}
