/**
 * The end of a game (docs/TEACHING.md §2.9): an opener by the outcome and ONE takeaway, chosen in the outcome's
 * order — a win: the found tactic → the theme worked → the questions → a (repeated) mistake; a loss / draw / an
 * unfinished game: the mistake that decided it («В следующий раз…») → the theme → the tactic. A mistake «decided the
 * game» only by what really happened on the board: ≥ 3 pawns lost within 4 plies after it, a mate, or one concept twice
 * with a real loss. The same key never two games in a row and at most twice in the last five; the two «found» keys
 * (a mate, a tactic) count as one lesson for that rule, so «ищи удары» does not become every other game's conclusion
 * (the first 50-game run: found.* in 20 of 50, up to 6 of one child's 10).
 *
 * A takeaway is a LESSON to carry into the next game, not praise: a win with a found tactic is summed up by the lesson
 * of THAT tactic — the key `found.tactic` with the motif as its pool variant (`takeawayVariant`: fork, pin, skewer,
 * discovered, removeDefender, trapped, doubleCheck, promotion, freeCapture), so the words can say «Главное сегодня:
 * вилка — один ход, две цели…».
 *
 * Pure: ./reaction.ts picks the words, records the key in the learner model and returns the event.
 */
import type { Color, GameResult, MoveJudgement, Termination } from '@gambit/shared';
import { THEME_PRIMARY_FAMILY } from '@gambit/content';
import { Chess } from 'chess.js';
import { parsePlacement, squareIndex } from '../../analysis/board.ts';
import type { StrategyCardLike } from '../teacher.ts';
import type { LessonHistory } from './book.ts';
import { BIG_LOSS_PAWNS, isMistakeMove, materialTrack, mistakeConcepts, realizedLoss, takeawayOfConcept } from './mistake.ts';
import type { LessonMemory } from './types.ts';

export type GameOutcome = 'win' | 'loss' | 'draw' | 'unfinished';

/** How many takeaways back the «at most twice» rule looks. */
export const TAKEAWAY_WINDOW = 5;
export const TAKEAWAY_MAX_IN_WINDOW = 2;
/** «Тема сработала» by castling + development: castled within this many plies of the game with all minors out. */
export const THEME_CASTLE_PLY = 20;
/** Two goals of the card achieved by the child's moves make «тема сработала». */
export const THEME_GOALS_DONE = 2;
/** Treasures not found that make «ищи подарки» a takeaway. */
export const MISSED_TREASURES = 2;

export function gameOutcome(result: GameResult, childColor: Color, termination: Termination): GameOutcome {
  if (result === '*' || termination === 'abandoned') return 'unfinished';
  if (result === '1/2-1/2') return 'draw';
  const won = (result === '1-0' && childColor === 'w') || (result === '0-1' && childColor === 'b');
  return won ? 'win' : 'loss';
}

export interface TakeawayInput {
  outcome: GameOutcome;
  stage: number;
  childColor: Color;
  lesson: LessonMemory;
  judgements: readonly MoveJudgement[];
  historySan: readonly string[];
  card: StrategyCardLike | null;
}

/** A weaker move of the game with its concept and what it really cost. */
export interface PlayedMistake {
  ply: number;
  concept: string;
  takeaway: string | null;
  pawns: number;
  mated: boolean;
}

/**
 * The child's weaker moves that stayed on the board (a taken-back attempt is not in `historySan`), each with its concept
 * (the one said during the game when there was one, else recognised now) and the realized loss.
 */
export function playedMistakes(input: Pick<TakeawayInput, 'judgements' | 'historySan' | 'childColor' | 'lesson' | 'stage'>): PlayedMistake[] {
  const track = materialTrack(input.historySan, input.childColor);
  const out: PlayedMistake[] = [];
  const seen = new Set<number>();
  for (const j of input.judgements) {
    if (j.color !== input.childColor || seen.has(j.ply)) continue;
    const played = input.historySan[j.ply - 1];
    if (!played || played.replace(/[+#]/g, '') !== j.san.replace(/[+#]/g, '')) continue;
    if (!isMistakeMove(j)) continue;
    seen.add(j.ply);
    // the concept said for THIS move (a taken-back attempt of the same ply has its own uci)
    const said = input.lesson.mistakes.find((m) => m.ply === j.ply && (m.uci === '' || m.uci === j.uci));
    let concept = said?.concept ?? null;
    if (!concept) {
      try {
        concept = mistakeConcepts({ judgement: j, stage: input.stage }).find((m) => m.takeaway !== null)?.concept ?? null;
      } catch {
        concept = null;
      }
    }
    if (!concept) continue;
    const loss = realizedLoss(track, j.ply, input.childColor);
    out.push({ ply: j.ply, concept, takeaway: takeawayOfConcept(concept), pawns: loss.pawns, mated: loss.mated });
  }
  return out;
}

/** The mistake takeaway of the game (decisive for a non-win, or one concept repeated with a real loss), or null. */
export function mistakeTakeaway(outcome: GameOutcome, mistakes: readonly PlayedMistake[]): string | null {
  const keyed = mistakes.filter((m) => m.takeaway !== null && m.concept !== 'slower' && m.concept !== 'missedTreasure');
  if (outcome !== 'win') {
    const decisive = keyed.filter((m) => m.pawns >= BIG_LOSS_PAWNS || m.mated);
    const mate = decisive.find((m) => m.mated);
    const top = mate ?? [...decisive].sort((a, b) => b.pawns - a.pawns || a.ply - b.ply)[0];
    if (top?.takeaway) return top.takeaway;
  }
  const counts = new Map<string, number>();
  for (const m of keyed) if (m.pawns >= 1) counts.set(m.takeaway as string, (counts.get(m.takeaway as string) ?? 0) + 1);
  for (const m of keyed) if ((counts.get(m.takeaway as string) ?? 0) >= 2) return m.takeaway;
  return null;
}

/** «Тема сработала» (a fact, never «поэтому выиграли»): two goals of the card done by the child, or an early castle with every minor out for the development / castle families. */
export function themeTakeaway(input: Pick<TakeawayInput, 'card' | 'lesson' | 'historySan' | 'childColor'>): string | null {
  const family = input.card ? THEME_PRIMARY_FAMILY[input.card.id] : undefined;
  if (!family) return null;
  if (input.lesson.goalsDone.length >= THEME_GOALS_DONE) return `theme.${family}`;
  if ((family === 'development' || family === 'castle') && castledEarlyDeveloped(input.historySan, input.childColor)) return `theme.${family}`;
  return null;
}

const MINOR_HOME: Readonly<Record<Color, readonly string[]>> = { w: ['b1', 'g1', 'c1', 'f1'], b: ['b8', 'g8', 'c8', 'f8'] };

function castledEarlyDeveloped(historySan: readonly string[], color: Color): boolean {
  const first = color === 'w' ? 0 : 1;
  const chess = new Chess();
  for (let i = 0; i < Math.min(historySan.length, THEME_CASTLE_PLY); i++) {
    try {
      chess.move(historySan[i] as string);
    } catch {
      return false;
    }
    if (i % 2 === first && /^O-O/.test(historySan[i] as string)) {
      const board = parsePlacement(chess.fen());
      const home = MINOR_HOME[color].filter((sq, k) => {
        const p = board[squareIndex(sq)];
        return !!p && p.color === color && p.type === (k < 2 ? 'n' : 'b');
      });
      return home.length === 0;
    }
  }
  return false;
}

/** The quiz kind the child answered well: ≥ 2 right, or every answer of the kind right when ≥ 2 were right in all. */
export function quizTakeaway(lesson: Pick<LessonMemory, 'quizzes'>): string | null {
  const right = new Map<string, number>();
  const wrong = new Map<string, number>();
  for (const q of lesson.quizzes) {
    if (q.correct === true) right.set(q.kind, (right.get(q.kind) ?? 0) + 1);
    else if (q.correct === false) wrong.set(q.kind, (wrong.get(q.kind) ?? 0) + 1);
  }
  const ranked = [...right.entries()].sort((a, b) => b[1] - a[1]);
  const two = ranked.find(([, n]) => n >= 2);
  if (two) return `quiz.${two[0]}`;
  const total = [...right.values()].reduce((a, b) => a + b, 0);
  if (total >= 2) {
    const clean = ranked.find(([k]) => (wrong.get(k) ?? 0) === 0);
    if (clean) return `quiz.${clean[0]}`;
  }
  return null;
}

/** A treasure the child found that was a mate (the treasure's motif) counts as a found mate. */
const MATE_MOTIFS: readonly string[] = ['mateIn1', 'backRankMate'];

/** A found motif (describeMotif ids) → the variant of `v3.takeaway.found.tactic` (the lesson of that tactic). */
const FOUND_VARIANT: Readonly<Record<string, string>> = {
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discoveredAttack: 'discovered',
  removeDefender: 'removeDefender',
  trappedPiece: 'trapped',
  doubleCheck: 'doubleCheck',
  promotion: 'promotion',
  hangingPiece: 'freeCapture',
  freeCapture: 'freeCapture',
};
/** Every variant `takeawayVariant` gives for `found.tactic` (for the content spec `variants`). */
export const FOUND_TACTIC_VARIANTS: readonly string[] = [...new Set(Object.values(FOUND_VARIANT))];
/** Which find teaches most: a named tactic before a plain free capture (a lower rank wins; ties — the latest find). */
const VARIANT_RANK: Readonly<Record<string, number>> = { fork: 0, pin: 1, skewer: 2, discovered: 3, removeDefender: 4, trapped: 5, doubleCheck: 6, promotion: 7, freeCapture: 8 };

function isMateFind(f: LessonMemory['found'][number]): boolean {
  return f.kind === 'mate' || (f.kind === 'treasure' && !!f.motif && MATE_MOTIFS.includes(f.motif));
}

/** The find the game's takeaway is about (null = nothing found): the found mate, else the most instructive tactic. */
export function foundLesson(lesson: Pick<LessonMemory, 'found'>): { key: 'found.mate' | 'found.tactic'; variant: string | null } | null {
  if (lesson.found.some(isMateFind)) return { key: 'found.mate', variant: null };
  const finds = lesson.found.filter((f) => f.kind === 'tactic' || f.kind === 'treasure');
  if (finds.length === 0) return null;
  let best: { variant: string | null; rank: number } = { variant: null, rank: Number.POSITIVE_INFINITY };
  for (const f of finds) {
    const variant = f.motif ? (FOUND_VARIANT[f.motif] ?? null) : null;
    // an own tactic outranks a treasure of the same motif; a find without a known motif teaches least
    const rank = (variant !== null ? (VARIANT_RANK[variant] ?? 9) : 10) + (f.kind === 'treasure' ? 0.5 : 0);
    if (rank <= best.rank) best = { variant, rank };
  }
  return { key: 'found.tactic', variant: best.variant };
}

/** The found-tactic takeaway: a mate the child found himself (or a mate treasure), else a tactic or a treasure. */
export function foundTakeaway(lesson: Pick<LessonMemory, 'found'>): { mate: string | null; tactic: string | null } {
  const tactic = lesson.found.some((f) => (f.kind === 'tactic' || f.kind === 'treasure') && !isMateFind(f));
  return {
    mate: lesson.found.some(isMateFind) ? 'found.mate' : null,
    tactic: tactic ? 'found.tactic' : null,
  };
}

/** The pool variant of a takeaway key (the words of `v3.takeaway.<key>` true for it), or null for every other key. */
export function takeawayVariant(key: string, lesson: Pick<LessonMemory, 'found'>): string | null {
  if (key !== 'found.tactic') return null;
  const finds = lesson.found.filter((f) => (f.kind === 'tactic' || f.kind === 'treasure') && !isMateFind(f));
  return foundLesson({ found: finds })?.variant ?? null;
}

/** Every takeaway key that is true for the game, in the order of the outcome (the stage key last, always). */
export function takeawayCandidates(input: TakeawayInput): string[] {
  const mistakes = playedMistakes(input);
  const mistake = mistakeTakeaway(input.outcome, mistakes);
  const found = foundTakeaway(input.lesson);
  const theme = themeTakeaway(input);
  const quiz = quizTakeaway(input.lesson);
  const treasuresMissed = input.lesson.treasureTurns.length - input.lesson.found.filter((f) => f.kind === 'treasure').length;
  const missed = treasuresMissed >= MISSED_TREASURES ? 'mistake.missedTreasure' : null;
  const stage = `stage.${Math.min(5, Math.max(1, Math.round(input.stage)))}`;
  const order =
    input.outcome === 'win'
      ? [found.mate, found.tactic, theme, quiz, mistake, missed, stage]
      : [mistake, missed, theme, found.tactic, found.mate, quiz, stage];
  return [...new Set(order.filter((k): k is string => k !== null))];
}

/** The lesson a key teaches, for the rotation: the found mate and the found tactic are one lesson («ищи удары»). */
export function takeawayLesson(key: string): string {
  return key.startsWith('found.') ? 'found' : key;
}

/** The rotation of §2.9: not the same lesson as the last game's, at most twice among the last five. */
export function takeawayRotationOk(key: string, history: Pick<LessonHistory, 'takeaways' | 'gameSeq'>): boolean {
  const lesson = takeawayLesson(key);
  const past = history.takeaways.filter((t) => t.game < history.gameSeq);
  const last = past[past.length - 1];
  if (last && takeawayLesson(last.key) === lesson) return false;
  return past.slice(-TAKEAWAY_WINDOW).filter((t) => takeawayLesson(t.key) === lesson).length < TAKEAWAY_MAX_IN_WINDOW;
}
