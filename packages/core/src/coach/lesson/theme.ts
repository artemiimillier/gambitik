/**
 * The theme of the game in «Учитель» (docs/TEACHING.md §2.1, §2.3, §6.3): what is announced at the start (the
 * family idea at stages 1–2 and for White before move 1; the card's name + idea at stages 3–5 when the game has not
 * contradicted it), the recall of the last takeaway (§2.9), the one theme sentence of a turn (the name confirmed or
 * given as a reward, «соперник свернул с дороги», a chapter of the game, a reminder) and the link of an advice to the
 * theme — only for the pairs «family + idea» whose condition holds on the board.
 *
 * Pure decisions (pool ids); the lesson turn picks the words. The card's structured goals come from ./goals.ts.
 */
import type { Color, Square } from '@gambit/shared';
import { LESSON_STRATEGY_IDS, LESSON_THEME_FAMILIES, THEME_PRIMARY_FAMILY, lessonLine } from '@gambit/content';
import type { LessonThemeFamily } from '@gambit/content';
import { attacksFrom, fileOf, findKing, materialOf, opposite, parsePlacement, rankOf, squareIndex } from '../../analysis/board.ts';
import type { MoveIdea } from '../moveIdeas.ts';
import { strategyProgress } from '../strategy.ts';
import type { StrategyProgress, TeachStrategy } from '../strategy.ts';
import type { StrategyCardLike } from '../teacher.ts';
import type { LessonHistory } from './book.ts';
import { goalDoneBy, goalImpossible, goalAchieved, goalsOfCard } from './goals.ts';
import type { LessonMemory } from './types.ts';
import { ideaVariant, isMinorFromHome, moveFacts } from './truth.ts';
import type { MoveFacts } from './truth.ts';

/** The cards whose name is true from move 1 for White: a system against anything (§2.1). */
export const NAMED_AT_START: ReadonlySet<string> = new Set(['london', 'colle']);
/**
 * A theme reminder when the theme was not mentioned for this many child turns: at most one in 10 plies (the second
 * 50-game run heard up to 7 a game, 5 of them in the endgame).
 */
export const THEME_REMIND_TURNS = 5;
/** A theme link at most once in this many advices. */
export const THEME_LINK_EVERY = 3;

/** What the lesson needs of a card: the library card, or the game's strategy (the same fields). */
export interface ThemeCard {
  id: string;
  themes: readonly string[];
  mainLineSan: readonly string[];
  lineSan: readonly string[];
  against?: 'any' | 'e4' | 'd4' | 'other';
  /** the card as the goals module reads it */
  card: StrategyCardLike | null;
}

export function themeCardOf(card: StrategyCardLike | null | undefined, strategy?: TeachStrategy | null): ThemeCard | null {
  if (card) {
    return {
      id: card.id,
      themes: card.themes ?? [],
      mainLineSan: card.mainLineSan ?? [],
      lineSan: card.lineSan ?? [],
      against: card.against,
      card,
    };
  }
  if (strategy?.strategyId) {
    return {
      id: strategy.strategyId,
      themes: strategy.themes ?? [],
      mainLineSan: strategy.mainLineSan ?? [],
      lineSan: strategy.lineSan ?? [],
      ...(strategy.against ? { against: strategy.against } : {}),
      card: null,
    };
  }
  return null;
}

function isFamily(t: string): t is LessonThemeFamily {
  return (LESSON_THEME_FAMILIES as readonly string[]).includes(t);
}

/** The family a card is announced by (`THEME_PRIMARY_FAMILY`, else its first theme that is a family). */
export function familyOf(c: ThemeCard | null): LessonThemeFamily | null {
  if (!c) return null;
  return THEME_PRIMARY_FAMILY[c.id] ?? c.themes.find(isFamily) ?? null;
}

/** The families a link may speak for: the primary one first, then the card's themes in card order. */
export function linkFamilies(c: ThemeCard | null): LessonThemeFamily[] {
  const first = familyOf(c);
  if (!c || !first) return [];
  return [...new Set([first, ...c.themes.filter(isFamily)])];
}

function asStrategy(c: ThemeCard): TeachStrategy {
  return { strategyId: c.id, titleRu: c.id, ideaRu: '', lineSan: c.lineSan, mainLineSan: c.mainLineSan, ...(c.against ? { against: c.against } : {}) };
}

export function progressOf(c: ThemeCard | null, historySan: readonly string[], color: Color): StrategyProgress | null {
  return c ? strategyProgress(asStrategy(c), historySan, color) : null;
}

function sameSan(a: string, b: string): boolean {
  return a.replace(/[+#!?]+$/u, '') === b.replace(/[+#!?]+$/u, '');
}

/** Is the card still true of the game (the moves so far follow its main line / its system)? */
export function cardTrue(c: ThemeCard | null, historySan: readonly string[], color: Color): boolean {
  if (!c) return false;
  if (historySan.length === 0) return true;
  const p = progressOf(c, historySan, color);
  return !!p && p.onLine;
}

// ───────────────────────── the start of the game (§2.1, §2.9) ─────────────────────────

export interface ThemeStart {
  family: LessonThemeFamily | null;
  /** `v3.theme.<id>` (the name + idea) or `v3.theme.family.<family>`; null = no theme to announce */
  pool: string | null;
  named: boolean;
  /** the takeaway key to recall (`v3.recall.<key>`), null = none this game */
  recallKey: string | null;
}

export interface ThemeStartArgs {
  stage: number;
  childColor: Color;
  historySan: readonly string[];
  card: ThemeCard | null;
  history: Readonly<LessonHistory> | null | undefined;
}

/**
 * The announcement: stages 1–2 the family; stages 3–5 the card's name + idea when the card is still true — White before
 * move 1 only for London / Colle (Italian after 1…c5 is impossible), Black after the opponent's first move.
 */
export function themeStart(a: ThemeStartArgs): ThemeStart {
  const family = familyOf(a.card);
  const recallKey = recallKeyOf(a.history);
  if (!a.card || !family) return { family, pool: null, named: false, recallKey };
  const known = (LESSON_STRATEGY_IDS as readonly string[]).includes(a.card.id);
  const beforeMove1 = a.childColor === 'w' && a.historySan.length === 0;
  const nameable = a.stage >= 3 && known && cardTrue(a.card, a.historySan, a.childColor) && (!beforeMove1 || NAMED_AT_START.has(a.card.id));
  if (nameable) return { family, pool: `v3.theme.${a.card.id}`, named: true, recallKey };
  return { family, pool: `v3.theme.family.${family}`, named: false, recallKey };
}

/**
 * «Помнишь, в прошлый раз…» in one of two games (the odd games of the book: 1, 3, 5 …): the takeaway of the last game,
 * else of the one before, when it is a concept with a recall line (a mistake or a theme).
 */
export function recallKeyOf(history: Readonly<LessonHistory> | null | undefined): string | null {
  if (!history) return null;
  const g = history.gameSeq;
  if (g % 2 === 0) return null;
  const recallable = (key: string): boolean => (key.startsWith('mistake.') || key.startsWith('theme.')) && !!lessonLine(`v3.recall.${key}`);
  for (const back of [1, 2]) {
    const t = [...history.takeaways].reverse().find((x) => x.game === g - back);
    if (t && recallable(t.key)) return t.key;
  }
  return null;
}

// ───────────────────────── the theme sentence of a turn ─────────────────────────

export type ThemeLineKind = 'named' | 'left' | 'phase' | 'remind';

export interface ThemeLineArgs {
  stage: number;
  childColor: Color;
  ply: number;
  /** child turn number this game (1-based) */
  turnNo: number;
  historySan: readonly string[];
  fen: string;
  phase: 'opening' | 'middlegame' | 'endgame' | undefined;
  /** the opening part of the game (phase opening, or the first ten moves) */
  opening: boolean;
  card: ThemeCard | null;
  lm: Pick<LessonMemory, 'theme' | 'phaseSaid'>;
}

/** The last child turn the theme was spoken about (0 = the announcement). */
export function lastThemeTurn(lm: Pick<LessonMemory, 'theme'>): number {
  return Math.max(0, lm.theme.lastRemindTurn ?? 0, ...lm.theme.links);
}

/**
 * The one theme sentence of a turn, most important first: the opening's name (stages 3–5: once the game really went
 * into the card's line — White after the opponent's first reply matched it; stages 1–2: a reward after the child played the
 * first three moves of the line), «соперник свернул с дороги» (stages 3–5), a chapter (middlegame / endgame, once each;
 * never the middlegame after the endgame was said — a promotion may bring the material back), a reminder of the family
 * (never in the endgame; only while the family's own goal is still possible — `familyGoalLive` — and in the opening or
 * while a goal of the card is open; after 10+ plies of silence).
 */
export function themeLine(a: ThemeLineArgs): { pool: string; kind: ThemeLineKind } | null {
  const c = a.card;
  const family = familyOf(c);
  const known = !!c && (LESSON_STRATEGY_IDS as readonly string[]).includes(c.id);
  if (c && known && !a.lm.theme.named && cardTrue(c, a.historySan, a.childColor)) {
    const childMoves = a.historySan.filter((_, i) => i % 2 === (a.childColor === 'w' ? 0 : 1));
    const main = c.mainLineSan;
    if (a.stage >= 3) {
      // after the opponent's first reply matched the card's line (1.e4 c5 is never «Итальянская»)
      const need = Math.min(2, main.length);
      if (a.historySan.length >= need && need > 0) return { pool: `v3.theme.named.${c.id}`, kind: 'named' };
    } else if (childMoves.length >= 3 && c.lineSan.length >= 3 && c.lineSan.slice(0, 3).every((m, i) => sameSan(m, childMoves[i] as string))) {
      return { pool: `v3.theme.named.${c.id}`, kind: 'named' };
    }
  }
  if (c && a.stage >= 3) {
    const p = progressOf(c, a.historySan, a.childColor);
    if (p?.left && p.left.by === 'opponent' && p.left.ply === a.ply - 1) return { pool: 'v3.theme.left', kind: 'left' };
  }
  if (a.phase === 'middlegame' && !a.lm.phaseSaid.middlegame && !a.lm.phaseSaid.endgame && a.turnNo >= 4) return { pool: 'v3.phase.middlegame', kind: 'phase' };
  if (a.phase === 'endgame' && !a.lm.phaseSaid.endgame) return { pool: 'v3.phase.endgame', kind: 'phase' };
  const endgame = a.phase === 'endgame' || a.lm.phaseSaid.endgame;
  if (
    family &&
    !endgame &&
    a.lm.theme.announced &&
    a.turnNo - lastThemeTurn(a.lm) >= THEME_REMIND_TURNS &&
    familyGoalLive(family, a.fen, a.childColor) &&
    (a.opening || goalsOpen(c, a.fen, a.childColor, a.historySan))
  ) {
    return { pool: `v3.theme.remind.${family}`, kind: 'remind' };
  }
  return null;
}

const MINOR_HOMES: Readonly<Record<Color, readonly [string, 'n' | 'b'][]>> = {
  w: [
    ['b1', 'n'],
    ['g1', 'n'],
    ['c1', 'b'],
    ['f1', 'b'],
  ],
  b: [
    ['b8', 'n'],
    ['g8', 'n'],
    ['c8', 'b'],
    ['f8', 'b'],
  ],
};

/**
 * Is the family's own goal still possible on the board (a reminder of it must be true)? f7: the opponent's pawn f7
 * (f2) stands and his king is at home; castle: our king is at home with a castling right left; development: a knight
 * or a bishop of ours still stands at home. The other families: yes (their goals are the card's, `goalsOpen`).
 */
export function familyGoalLive(family: LessonThemeFamily, fen: string, childColor: Color): boolean {
  let b: ReturnType<typeof parsePlacement>;
  try {
    b = parsePlacement(fen);
  } catch {
    return false;
  }
  const them = opposite(childColor);
  const at = (sq: string): ReturnType<typeof parsePlacement>[number] => b[squareIndex(sq)];
  switch (family) {
    case 'f7': {
      const pawn = at(them === 'b' ? 'f7' : 'f2');
      const king = at(them === 'b' ? 'e8' : 'e1');
      return !!pawn && pawn.type === 'p' && pawn.color === them && !!king && king.type === 'k' && king.color === them;
    }
    case 'castle': {
      const king = at(childColor === 'w' ? 'e1' : 'e8');
      const rights = fen.split(' ')[2] ?? '-';
      const ours = childColor === 'w' ? /[KQ]/u : /[kq]/u;
      return !!king && king.type === 'k' && king.color === childColor && ours.test(rights);
    }
    case 'development':
      return MINOR_HOMES[childColor].some(([sq, type]) => {
        const p = at(sq);
        return !!p && p.color === childColor && p.type === type;
      });
    default:
      return true;
  }
}

/** Some structured goal of the card is neither achieved nor impossible (./goals.ts). */
export function goalsOpen(c: ThemeCard | null, fen: string, color: Color, historySan: readonly string[]): boolean {
  if (!c?.card) return false;
  try {
    return goalsOfCard(c.card, color).some((g) => !goalAchieved(g, fen, color, historySan) && !goalImpossible(g, fen, color));
  } catch {
    return false;
  }
}

// ───────────────────────── the theme link of an advice (§2.3, §6.3) ─────────────────────────

function chebyshev(a: number, b: number): number {
  return Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
}

const CENTER_IDX: readonly number[] = ['d4', 'e4', 'd5', 'e5'].map(squareIndex);

/**
 * Does the pair «family + idea» hold on the board (§6.3)? f7 needs the pawn on f7 (f2), the king at home and the moved
 * piece hitting it; open lines only the rook ideas; the kingside attack a target within two squares of the enemy king on
 * files f–h; the queenside a target / rook on files a–c; the counter-strike a trade in the centre; development + centre
 * only a minor piece from home (never an early queen); the gambit «a pawn given» only when the material really is a
 * pawn down.
 */
export function pairHolds(family: LessonThemeFamily, idea: Pick<MoveIdea, 'id' | 'squares' | 'variant' | 'phraseRu' | 'covers' | 'conceptId'>, f: MoveFacts): boolean {
  const id = idea.id;
  const { b0, b1, to, mover, other } = f;
  switch (family) {
    case 'f7': {
      if (id !== 'develop' && id !== 'aimWeakSquare' && id !== 'threatMate') return false;
      const weak = squareIndex(other === 'b' ? 'f7' : 'f2');
      const home = squareIndex(other === 'b' ? 'e8' : 'e1');
      const pawn = b1[weak];
      const king = b1[home];
      return !!pawn && pawn.type === 'p' && pawn.color === other && !!king && king.type === 'k' && king.color === other && attacksFrom(b1, to).includes(weak);
    }
    case 'development':
      if (id === 'develop' || id === 'prepareCastle' || id === 'connectRooks' || id === 'castle') return true;
      return id === 'centerControl' && isMinorFromHome(f);
    case 'center':
      if (id === 'centerPawn' || id === 'fightCenter' || id === 'supportCenter') return true;
      return (id === 'develop' || id === 'centerControl') && isMinorFromHome(f) && attacksFrom(b1, to).some((t) => CENTER_IDX.includes(t));
    case 'castle':
      return id === 'castle' || id === 'prepareCastle';
    case 'fortress':
      return id === 'supportCenter' || id === 'defend' || id === 'centerPawn';
    case 'gambit':
      return (id === 'fightCenter' || id === 'openLine' || id === 'develop') && materialOf(b0, mover) - materialOf(b0, other) <= -1;
    case 'openFile':
      return (id === 'rookOpenFile' && ideaVariant(idea, f.fenBefore, f.uci) === 'open') || id === 'rookSeventh' || id === 'connectRooks';
    case 'kingsideAttack': {
      if (id !== 'attack' && id !== 'check' && id !== 'threatMate' && id !== 'aimWeakSquare') return false;
      const king = findKing(b1, other);
      if (king < 0 || fileOf(king) < 5) return false;
      const target = id === 'check' ? king : idea.squares[0] ? squareIndex(idea.squares[0]) : -1;
      return target >= 0 && chebyshev(target, king) <= 2;
    }
    case 'queensideAttack': {
      if (id === 'attack') return !!idea.squares[0] && fileOf(squareIndex(idea.squares[0])) <= 2;
      if (id === 'rookOpenFile') return fileOf(to) <= 2;
      return id === 'space';
    }
    case 'counterCenter': {
      if (id === 'fightCenter' || id === 'centerPawn') return true;
      if (id !== 'trade' && id !== 'recapture') return false;
      const inCentre = fileOf(to) >= 2 && fileOf(to) <= 5 && rankOf(to) >= 2 && rankOf(to) <= 5;
      return inCentre || (f.mv.captured === 'p' && CENTER_IDX.includes(to));
    }
  }
}

export type ThemeLinkKind = 'goal' | 'why' | 'tail';

export interface ThemeLinkArgs {
  card: ThemeCard | null;
  blitz: boolean;
  fen: string;
  childColor: Color;
  advice: { uci: string; san: string } | null;
  /** the idea the advice is told by */
  idea: MoveIdea | undefined;
  historySan: readonly string[];
  turnNo: number;
  lm: Pick<LessonMemory, 'theme'>;
  /** ignore the «once in three advices» rule (the «Почему так?» answer goes one level deeper) */
  force?: boolean;
}

/**
 * The theme link of an advice: a goal of the card the move achieves (`v3.goal.<key>`), else the first family (primary,
 * then the card's themes) whose pair with the idea holds (`v3.why.<family>`; in blitz `v3.themeTail.<family>` replaces
 * the idea's tail). At most once in `THEME_LINK_EVERY` advices.
 */
export function themeLink(a: ThemeLinkArgs): { pool: string; kind: ThemeLinkKind; family: LessonThemeFamily | null; square?: Square } | null {
  if (!a.card || !a.advice) return null;
  const lastLink = a.lm.theme.links[a.lm.theme.links.length - 1];
  if (!a.force && lastLink !== undefined && a.turnNo - lastLink < THEME_LINK_EVERY) return null;
  const f = moveFacts(a.fen, a.advice.uci);
  if (!f) return null;
  if (!a.blitz && a.card.card) {
    try {
      const goals = goalsOfCard(a.card.card, a.childColor);
      const done = goalDoneBy(goals, a.fen, f.mv.fenAfter, a.childColor, a.historySan, [...a.historySan, f.mv.san]);
      if (done) return { pool: `v3.goal.${done.key}`, kind: 'goal', family: familyOf(a.card) };
    } catch {
      // a goal module error never breaks the turn
    }
  }
  if (!a.idea) return null;
  for (const family of linkFamilies(a.card)) {
    if (!pairHolds(family, a.idea, f)) continue;
    return a.blitz ? { pool: `v3.themeTail.${family}`, kind: 'tail', family } : { pool: `v3.why.${family}`, kind: 'why', family };
  }
  return null;
}

/** The side whose king / weak pawn a family's cue shows (castle / fortress: ours; f7 / attacks: the opponent's). */
export function familyKingOf(family: LessonThemeFamily, childColor: Color): Color {
  return family === 'castle' || family === 'fortress' || family === 'development' ? childColor : opposite(childColor);
}
