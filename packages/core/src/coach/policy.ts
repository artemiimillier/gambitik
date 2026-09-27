/**
 * Intervention policy — the pure decision "do we offer a take-back for this move?".
 * Implements docs/ARCHITECTURE.md §5 exactly. The engine decides, this code proves;
 * no LLM is ever consulted here.
 */
import type { CoachMode, CoachStyle, InterventionContext, InterventionDecision, MoveJudgement, TimeControlId } from '@gambit/shared';

/**
 * Take-back offers allowed per game, by coach mode. 5 minutes ('light') has the same three as 10 minutes: the child's
 * clock stands while Гамбитик speaks and while the offer is on the screen (one «верни ход» per 5-minute game would let
 * most blunders pass in silence).
 */
export const TAKEBACK_BUDGET: Readonly<Record<CoachMode, number>> = { off: 0, light: 3, full: 3 };

/** At least this many plies must pass after an offer before the next one. */
export const MIN_PLIES_BETWEEN_OFFERS = 4;

/** The child must have MORE than this on the clock (untimed games always pass). */
export const MIN_REMAINING_MS = 30_000;

/** Below this win% (mover POV, before the move) the game was already lost — we do not nag. */
export const MIN_WIN_PCT_BEFORE = 15;

/** A move losing less than this (and not classified as a mistake) is not worth a review note. */
export const REVIEW_MIN_WIN_PCT_LOSS = 10;

/** A forced mate against the child this close counts as "explainable". */
export const EXPLAINABLE_MATE_WITHIN = 3;

/** Material loss (pawns) along the refutation that counts as "explainable". */
export const EXPLAINABLE_MATERIAL_PAWNS = 2;

/** Losing at least this much (a rook or the queen) is severe enough to skip the cooldown. */
export const SEVERE_MATERIAL_PAWNS = 5;

/** Stable machine-readable reasons returned in `InterventionDecision.reason`. */
export type InterventionReason =
  | 'moveOk'
  | 'coachOff'
  | 'examMode'
  | 'notConfirmed'
  | 'belowThreshold'
  | 'notExplainable'
  | 'alreadyLost'
  | 'budgetExhausted'
  | 'cooldown'
  | 'timeTrouble'
  | 'offer';

/** win% loss needed for a take-back offer: stage 1–3 → 20, stage 4–6 → 15, stage 7+ → 12. */
export function takebackThresholdForStage(stage: number): number {
  const s = Number.isFinite(stage) ? stage : 1;
  if (s <= 3) return 20;
  if (s <= 6) return 15;
  return 12;
}

/**
 * "Explainable" = the coach can show something concrete: at least 2 pawns of material go,
 * or the child gets mated within 3, or the refutation is a recognised motif.
 */
export function isExplainable(j: MoveJudgement): boolean {
  if (j.materialLossPawns >= EXPLAINABLE_MATERIAL_PAWNS) return true;
  const mate = j.evalAfter.mate; // mover POV: negative = the child is getting mated
  if (mate !== null && mate < 0 && -mate <= EXPLAINABLE_MATE_WITHIN) return true;
  return j.allowedMotif !== undefined;
}

/**
 * "Severe" = the child drops a rook or the queen, or walks into mate within 3. The cooldown
 * exists to avoid nagging about ordinary mistakes; it must not let a child hang the queen twice
 * in a row. The per-game budget still applies.
 */
export function isSevere(j: MoveJudgement): boolean {
  if (j.materialLossPawns >= SEVERE_MATERIAL_PAWNS) return true;
  const mate = j.evalAfter.mate;
  return mate !== null && mate < 0 && -mate <= EXPLAINABLE_MATE_WITHIN;
}

/** Is the move bad enough to be remembered for the post-game review? */
export function isWorthReviewing(j: MoveJudgement): boolean {
  return (
    j.classification === 'mistake' ||
    j.classification === 'blunder' ||
    j.classification === 'missedWin' ||
    j.winPctLoss >= REVIEW_MIN_WIN_PCT_LOSS
  );
}

/** What the game knows beyond `InterventionContext` (kept out of the shared contract). */
export interface InterventionExtras {
  /**
   * The child took the offered move back and now played ANOTHER move from the same position (the game sets it once per
   * position): when this one loses too, the offer comes again at once — the cooldown does not apply to it.
   */
  retryAfterTakeback?: boolean;
}

/**
 * Decides what the coach does right after the child's move (before the bot answers).
 *
 *  - 'none'          — the move is fine, nothing to note.
 *  - 'offerTakeback' — ALL conditions of ARCHITECTURE §5 hold.
 *  - 'logForReview'  — the move is noteworthy but at least one condition failed; `reason` names
 *                      the first failed condition (order below).
 *
 * The cooldown only applies once an offer has actually been made this game (`offersMade > 0`),
 * so the value of `pliesSinceLastOffer` before the first offer is irrelevant. Severe blunders
 * (see `isSevere`) and a new try right after a take-back (`extras.retryAfterTakeback`) skip the cooldown; the budget
 * always holds.
 */
export function decideIntervention(j: MoveJudgement, ctx: InterventionContext, extras: InterventionExtras = {}): InterventionDecision {
  const none: InterventionReason = 'moveOk';
  if (!isWorthReviewing(j)) return { action: 'none', reason: none };

  const log = (reason: InterventionReason): InterventionDecision => ({ action: 'logForReview', reason });

  if (ctx.coachMode === 'off') return log('coachOff');
  if (ctx.examMode) return log('examMode');
  if (j.confidence !== 'confirmed') return log('notConfirmed');
  if (!(j.winPctLoss >= takebackThresholdForStage(ctx.stage))) return log('belowThreshold');
  if (!isExplainable(j)) return log('notExplainable');
  if (!(j.winPctBefore >= MIN_WIN_PCT_BEFORE)) return log('alreadyLost');
  if (ctx.offersMade >= TAKEBACK_BUDGET[ctx.coachMode]) return log('budgetExhausted');
  if (ctx.offersMade > 0 && ctx.pliesSinceLastOffer < MIN_PLIES_BETWEEN_OFFERS && !isSevere(j) && extras.retryAfterTakeback !== true) return log('cooldown');
  if (ctx.remainingMs !== null && !(ctx.remainingMs > MIN_REMAINING_MS)) return log('timeTrouble');

  const offer: InterventionReason = 'offer';
  return { action: 'offerTakeback', reason: offer };
}

// ═════════════════════════ coach styles (docs/TEACHER-MODE.md §1.2) ═════════════════════════

/**
 * Up to this curriculum stage the proactive «Учитель» is the default (in training, 10- and 5-minute games): stages 1–5,
 * the whole curriculum of the lesson model (docs/TEACHING.md §2.10). The web router's «unknown stage» stays 5.
 */
export const TEACHER_DEFAULT_MAX_STAGE = 5;

const STYLES_BY_TIME_CONTROL: Readonly<Record<TimeControlId, readonly CoachStyle[]>> = {
  training: ['teacher', 'helper', 'exam'],
  rapid10: ['teacher', 'helper', 'exam'],
  // children often play 5-minute games and the teacher belongs there too: the child's clock
  // stands while Гамбитик speaks, so the explanations cost the child no time
  blitz5: ['teacher', 'helper', 'exam'],
  // bullet: no choice — Гамбитик only greets and talks after the game (coachMode 'off'); a clock that cannot stop
  bullet1: [],
};

/** The coach styles offered for a time control, in the order of the wizard tiles; bullet → none. */
export function coachStylesFor(tc: TimeControlId): CoachStyle[] {
  return [...(STYLES_BY_TIME_CONTROL[tc] ?? [])];
}

/**
 * The preselected style: «Учитель» in training, 10- and 5-minute games up to stage 5, «Подсказчик» from stage 6.
 * Bullet has no style (the coach is off) — 'helper' is returned only as a harmless value for code that needs one;
 * `coachStylesFor('bullet1')` is empty.
 */
export function defaultCoachStyle(tc: TimeControlId, stage: number): CoachStyle {
  const styles = coachStylesFor(tc);
  const s = Number.isFinite(stage) ? stage : 1;
  if (styles.includes('teacher') && s <= TEACHER_DEFAULT_MAX_STAGE) return 'teacher';
  return 'helper';
}
