/**
 * The lesson director of «Учитель» (docs/TEACHING.md §4.3) — the ONLY entry point of the lesson for the game
 * store (apps/web gameStore.ts) and the 50-game report (tools/teaching/worker.ts), so the report measures the app.
 *
 * Every function is pure apart from the phrase book (`book`, the one mutable object): it takes the lesson memory in
 * `TeachMemory` and returns the next one; the caller commits it (`teachMemory = result.memory`). Engine calls, timers
 * and clocks stay with the caller. No generative AI: every word is a wording of @gambit/content.
 *
 * The API (signatures) lives here; the bodies are installed by ./engine.ts.
 */
import type {
  BoardAnnotations,
  CoachEvent,
  CoachStyle,
  Color,
  GameResult,
  GameSummary,
  InterventionDecision,
  LessonQuiz,
  MotifId,
  MoveJudgement,
  StudentProfile,
  TeachAdvice,
  Termination,
  Threat,
  TimeControlId,
} from '@gambit/shared';
import type { Rng } from '../phrase.ts';
import type { StrategyCardLike, TeachContext, TeachMemory, TeachPlan } from '../teacher.ts';
import type { TeachStrategy } from '../strategy.ts';
import type { LessonBook } from './book.ts';
import type { LessonTurnResult } from './types.ts';

// ───────────────────────── arguments ─────────────────────────

export interface LessonStartArgs {
  profile: StudentProfile;
  childColor: Color;
  tc: TimeControlId;
  coachStyle: CoachStyle;
  strategy: TeachStrategy | null;
  strategyCard: StrategyCardLike | null;
  /** SAN of the game so far: [] before White's first move; Black: the opponent's first move */
  historySan: readonly string[];
  /** the position the child moves first in */
  fen: string;
}

export interface LessonReactionArgs {
  profile: StudentProfile;
  tc: TimeControlId;
  judgement: MoveJudgement;
  /** the advice of the previous turn (hidden or not) */
  advice: readonly TeachAdvice[];
  /** the child saw the green arrow before moving (false: quiz, «Сам», treasure, reveal-later not yet revealed) */
  adviceShown: boolean;
  /** the child answered a quiz this turn (a move after a quiz is his own) */
  quizAnswered?: boolean;
  decision?: InterventionDecision | null;
  foundMotif?: MotifId;
  /** the treasure of that ply was hidden and not revealed */
  treasureHidden?: boolean;
  repertoireNextSan?: string | null;
  prev?: { uci: string; fenBefore: string } | null;
  strategyCard?: StrategyCardLike | null;
  /** SAN of the game up to and including the child's move */
  historySan: readonly string[];
  /** the null-move threat of the position after the child's move, if known (poisoned-praise checks) */
  threatAfter?: Threat | null;
}

export interface LessonReactionResult {
  /** say now, while the bot thinks: praise / an outcome line / a mistake; null = nothing */
  now: CoachEvent | null;
  /** the take-back offer path is the caller's (decision 'offerTakeback'): `now` is then null */
  memory: TeachMemory;
}

export interface LessonTakebackArgs {
  profile: StudentProfile;
  judgement: MoveJudgement;
  advice: readonly TeachAdvice[];
  /** a second offer in the same position (the retry also loses) */
  again?: boolean;
}

export interface LessonEndArgs {
  profile: StudentProfile;
  tc: TimeControlId;
  result: GameResult;
  childColor: Color;
  termination: Termination;
  summary: GameSummary;
  strategyCard: StrategyCardLike | null;
  /** the child's judged moves (for the realized loss of a mistake) */
  judgements: readonly MoveJudgement[];
  /** SAN of the whole game */
  historySan: readonly string[];
}

/**
 * What a reply that may put the hidden advice on the board tells the caller besides its words (additive, optional):
 * `stopHints` true — the advice is shown now, the hint timers of the hidden advice (a treasure's steps, §2.7) stop; false
 * — the advice is still hidden (a «Почему так?» on a hidden gift, an answer whose advice words did not fit: the arrow
 * waits for «Совет»).
 */
export interface LessonHintsStop {
  stopHints?: boolean;
}

export interface LessonEndResult {
  event: CoachEvent;
  /** the takeaway sentence alone (the result card shows it) */
  takeaway: string;
  takeawayKey: string;
  memory: TeachMemory;
}

// ───────────────────────── the API ─────────────────────────

/**
 * The start of a teacher game: the theme announcement (family / card, §2.1) and, in 1 of 2 games after a takeaway,
 * the recall («Помнишь, в прошлый раз…», §2.9). White before move 1: the family only.
 */
export function lessonGameStart(args: LessonStartArgs, memory: TeachMemory, book: LessonBook): { events: CoachEvent[]; memory: TeachMemory } {
  return impl.lessonGameStart(args, memory, book);
}

/**
 * One child turn: `planTeachTurn` (chess truth, unchanged) + the lesson moment (§2.2) + the words. `ctx.memory` is the
 * current TeachMemory; the returned `memory` is the next one.
 */
export function lessonTurn(ctx: TeachContext, book: LessonBook, rng?: Rng): { plan: TeachPlan; result: LessonTurnResult; memory: TeachMemory } {
  return impl.lessonTurn(ctx, book, rng);
}

/** The child pressed a quiz button (or null = skipped / timed out): right/wrong + the true explanation + the advice. */
export function lessonAnswer(
  plan: TeachPlan,
  memory: TeachMemory,
  optionId: string | null,
  book: LessonBook,
): { event: CoachEvent; board: BoardAnnotations; correct: boolean | null; memory: TeachMemory } & LessonHintsStop {
  return impl.lessonAnswer(plan, memory, optionId, book);
}

/** Right after the child's move, while the bot thinks: specific praise, an outcome line, or a mistake by a concept. */
export function lessonReaction(args: LessonReactionArgs, memory: TeachMemory, book: LessonBook): LessonReactionResult {
  return impl.lessonReaction(args, memory, book);
}

/** The take-back offer (§2.8): stop + what happened by a concept + «Вернём ход?» (stages 3–5: a question first). */
export function lessonTakebackOffer(args: LessonTakebackArgs, memory: TeachMemory, book: LessonBook): { event: CoachEvent; memory: TeachMemory } {
  return impl.lessonTakebackOffer(args, memory, book);
}

/** The child's answer to the offer: 'yes' (then the caller asks `lessonRepeat`), 'no', or 'again' (the retry also loses). */
export function lessonTakebackReply(kind: 'yes' | 'no', profile: StudentProfile, memory: TeachMemory, book: LessonBook): { event: CoachEvent; memory: TeachMemory } {
  return impl.lessonTakebackReply(kind, profile, memory, book);
}

/** Show a hidden advice (treasure / «Сам» / stage-5 reveal-later): «Вот он: ход {конём}» + its idea; the arrows. */
export function lessonReveal(plan: TeachPlan, memory: TeachMemory, book: LessonBook): { event: CoachEvent; board: BoardAnnotations; memory: TeachMemory } & LessonHintsStop {
  return impl.lessonReveal(plan, memory, book);
}

/** «Совет» / «Повтори»: the current advice again, with fresh words (and it reveals a hidden advice). */
export function lessonRepeat(plan: TeachPlan, memory: TeachMemory, book: LessonBook): { event: CoachEvent; board: BoardAnnotations; memory: TeachMemory } & LessonHintsStop {
  return impl.lessonRepeat(plan, memory, book);
}

/** «Почему так?»: one level deeper than the last tail — the second idea, the theme link or the l1 of its mini-lesson. */
export function lessonWhy(plan: TeachPlan, memory: TeachMemory, book: LessonBook): { event: CoachEvent; memory: TeachMemory } & LessonHintsStop {
  return impl.lessonWhy(plan, memory, book);
}

/** «Что задумал соперник?» chip: the opponent's idea or threat in words (never «ничего опасного» unless proven). */
export function lessonOpponent(
  args: { profile: StudentProfile; fenBefore: string; uci: string; childFen: string; threat: Threat | null | undefined },
  memory: TeachMemory,
  book: LessonBook,
): { event: CoachEvent } {
  return impl.lessonOpponent(args, memory, book);
}

/** «Поторопись!» (once a game, the caller decides when). */
export function lessonHurry(profile: StudentProfile, book: LessonBook): CoachEvent {
  return impl.lessonHurry(profile, book);
}

/** The end of the game: the outcome opener + ONE takeaway (§2.9); records the takeaway in the book's learner model. */
export function lessonEnd(args: LessonEndArgs, memory: TeachMemory, book: LessonBook): LessonEndResult {
  return impl.lessonEnd(args, memory, book);
}

/** The quiz of a turn result, for the caller's card (null when the turn asks nothing). */
export function quizOf(result: LessonTurnResult): LessonQuiz | null {
  return result.quiz;
}

// ───────────────────────── implementation slot ─────────────────────────

/**
 * The implementation is installed by ./engine.ts. Keeping the signatures here lets the game store and the report
 * worker compile against them without importing the engine.
 */
export interface LessonDirectorImpl {
  lessonGameStart: typeof lessonGameStart;
  lessonTurn: typeof lessonTurn;
  lessonAnswer: typeof lessonAnswer;
  lessonReaction: typeof lessonReaction;
  lessonTakebackOffer: typeof lessonTakebackOffer;
  lessonTakebackReply: typeof lessonTakebackReply;
  lessonReveal: typeof lessonReveal;
  lessonRepeat: typeof lessonRepeat;
  lessonWhy: typeof lessonWhy;
  lessonOpponent: typeof lessonOpponent;
  lessonHurry: typeof lessonHurry;
  lessonEnd: typeof lessonEnd;
}

let impl: LessonDirectorImpl = new Proxy({} as LessonDirectorImpl, {
  get(_t, name) {
    return () => {
      throw new Error(`lesson director: ${String(name)} is not installed (import ./engine.ts)`);
    };
  },
});

/** Installed once by ./engine.ts (side-effect import in ./index.ts). */
export function installLessonDirector(i: LessonDirectorImpl): void {
  impl = i;
}
