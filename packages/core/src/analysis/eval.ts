/**
 * Evaluation math — lichess formulas (scalachess eval.scala, lila AccuracyPercent.scala and
 * Advice.scala; see docs/research 05 §3 + 07 §1.3, §2.1).
 *
 * Conventions
 *  - `EvalScore` is always relative to some point of view (POV). Raw engine lines are from the
 *    side to move; everything inside a MoveJudgement is from the mover's POV.
 *  - `mate > 0`: the POV side mates; `mate < 0`: the POV side gets mated; `mate === 0` keeps the
 *    raw UCI meaning "the POV side is checkmated right now".
 *  - A checkmate DELIVERED by the mover is encoded by `toMoverPov` / `judgeMove` as `mate: 1`
 *    (never as `mate: 0`), so naive `mate > 0` checks and JSON round-trips stay sign-safe.
 */
import type { Color, EvalScore, MoveClass, MoveJudgement } from '@gambit/shared';

/** lichess PR #11148 logistic constant. */
const WIN_PCT_K = 0.00368208;
/** scalachess Cp.CEILING: centipawns are clamped to this range, a mate counts as the ceiling. */
export const CP_CEILING = 1000;
/** lila Cp.initial — the eval assumed for the starting position in the game-accuracy windows. */
const INITIAL_CP = 15;

/** Win%-loss thresholds (mover POV, percentage points) — ARCHITECTURE §5. */
export const CLASSIFY_THRESHOLDS = { best: 1, excellent: 2, good: 5, inaccuracy: 10, mistake: 20 } as const;
/** `missedWin`: a forced mate or at least this advantage (cp) was available … */
export const MISSED_WIN_AVAILABLE_CP = 500;
/** … and the move keeps less than this (cp) … */
export const MISSED_WIN_KEEPS_BELOW_CP = 200;
/** … while the position did not turn bad (otherwise it is a plain mistake / blunder). */
export const MISSED_WIN_NOT_WORSE_THAN_CP = -200;
/**
 * lila's MateLost rule is applied only to mates this short. Longer announced mates flicker in
 * and out of shallow searches and are invisible to a child; they are judged by win% only.
 */
export const MATE_LOST_MAX_MOVES = 5;

/** Score → centipawns on the lichess server scale: cp clamped to ±1000, any mate = ±1000. */
export function scoreToCp(score: EvalScore): number {
  if (score.mate !== null && score.mate !== undefined) return score.mate > 0 ? CP_CEILING : -CP_CEILING;
  const cp = score.cp ?? 0;
  return Math.max(-CP_CEILING, Math.min(CP_CEILING, cp));
}

/** lichess Win% (0..100) for the POV side: `50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)`. */
export function winPct(score: EvalScore): number {
  return 50 + 50 * (2 / (1 + Math.exp(-WIN_PCT_K * scoreToCp(score))) - 1);
}

/** lila `AccuracyPercent.fromWinPercents`, including the +1 "uncertainty bonus"; clamped to 0..100. */
export function moveAccuracy(winPctBefore: number, winPctAfter: number): number {
  if (winPctAfter >= winPctBefore) return 100;
  const diff = winPctBefore - winPctAfter;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * diff) - 3.166924740191411 + 1;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Converts a score given from the point of view of `sideToMove` (raw UCI) into the point of view
 * of `mover`. Flipping `mate: 0` (side to move is checkmated) yields `mate: 1`, see file header.
 */
export function toMoverPov(line: EvalScore, sideToMove: Color, mover: Color): EvalScore {
  const hasMate = line.mate !== null && line.mate !== undefined;
  if (sideToMove === mover) return { cp: hasMate ? null : (line.cp ?? 0), mate: hasMate ? line.mate : null };
  if (hasMate) return { cp: null, mate: line.mate === 0 ? 1 : -(line.mate as number) };
  const cp = line.cp ?? 0;
  return { cp: cp === 0 ? 0 : -cp, mate: null };
}

/**
 * When the same ply was judged several times (a taken-back attempt followed by the retry), only
 * the LAST judgement of that ply is the move that stayed on the board.
 */
export function finalJudgements(judgements: readonly MoveJudgement[]): MoveJudgement[] {
  const byPly = new Map<number, MoveJudgement>();
  for (const j of judgements) byPly.set(j.ply, j);
  return [...byPly.values()].sort((a, b) => a.ply - b.ply);
}

function standardDeviation(xs: readonly number[]): number {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}

/**
 * lila `AccuracyPercent.gameAccuracy` for one player: the mean of the volatility-weighted mean
 * and the harmonic mean of the move accuracies.
 *
 * lila works on the evals of every ply of the game; we only have the child's judgements, so the
 * win% sequence is rebuilt from them as `[before₁, after₁, before₂, after₂, …]` (child POV, which
 * is the full game sequence as long as `before` of the next move ≈ the eval after the bot's reply;
 * for Black the initial +0.15 position is prepended like lila does). Window size is
 * `clamp(plies / 10, 2, 8)`, a move's weight is the population standard deviation of its window
 * clamped to 0.5..12. Taken-back attempts are ignored (last judgement per ply wins).
 * Returns 0 when there are no judgements.
 */
export function gameAccuracy(judgements: MoveJudgement[]): number {
  const moves = finalJudgements(judgements);
  if (moves.length === 0) return 0;

  const values: number[] = [];
  const first = moves[0] as MoveJudgement;
  if (first.color === 'b') values.push(100 - winPct({ cp: INITIAL_CP, mate: null }));
  const offset = values.length;
  for (const j of moves) values.push(j.winPctBefore, j.winPctAfter);

  const plies = values.length - 1;
  const windowSize = Math.max(2, Math.min(8, Math.floor(plies / 10)));
  const size = Math.min(windowSize, values.length);
  const windows: number[][] = [];
  for (let i = 0; i < size - 2; i++) windows.push(values.slice(0, size));
  for (let i = 0; i + size <= values.length; i++) windows.push(values.slice(i, i + size));
  const weights = windows.map((w) => Math.max(0.5, Math.min(12, standardDeviation(w))));

  let weightedSum = 0;
  let weightTotal = 0;
  let inverseSum = 0;
  moves.forEach((j, k) => {
    const accuracy = moveAccuracy(j.winPctBefore, j.winPctAfter);
    const weight = weights[offset + 2 * k] ?? 0.5;
    weightedSum += accuracy * weight;
    weightTotal += weight;
    inverseSum += 1 / Math.max(1, accuracy);
  });
  const weightedMean = weightedSum / weightTotal;
  const harmonicMean = moves.length / inverseSum;
  return (weightedMean + harmonicMean) / 2;
}

/** Plain win%-loss ladder: < 1 best, < 2 excellent, < 5 good, < 10 inaccuracy, < 20 mistake, else blunder. */
export function classifyByLoss(winPctLoss: number): MoveClass {
  const loss = Math.max(0, winPctLoss);
  if (loss < CLASSIFY_THRESHOLDS.best) return 'best';
  if (loss < CLASSIFY_THRESHOLDS.excellent) return 'excellent';
  if (loss < CLASSIFY_THRESHOLDS.good) return 'good';
  if (loss < CLASSIFY_THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (loss < CLASSIFY_THRESHOLDS.mistake) return 'mistake';
  return 'blunder';
}

function isMate(score: EvalScore): score is EvalScore & { mate: number } {
  return score.mate !== null && score.mate !== undefined;
}

/**
 * Classification on the lichess win% scale, mover POV.
 *
 *  1. `isBest` (the engine's first choice) → `best`.
 *  2. Mate rules as in lila `Advice.scala`:
 *     - MateCreated (no mate against the mover before, forced mate against the mover after):
 *       `blunder`, but `mistake` if the position was already < −700 cp, `inaccuracy` if < −999 cp.
 *     - MateLost (the mover had a forced mate in ≤ 5 and it is gone): if the mover now gets mated →
 *       `blunder`; if still > +999 cp → `inaccuracy`; > +700 cp → `mistake`; ≥ +200 cp → `blunder`;
 *       below that it is a `missedWin` (or a `blunder` once the position is worse than −200 cp).
 *     - MateDelayed (still mating, just slower) is never punished.
 *  3. `missedWin`: a forced mate or ≥ +5.00 was available, the move keeps less than +2.00 but the
 *     position is not bad (≥ −2.00). Kid-friendly "there was a gift here" category.
 *  4. Otherwise by win% loss: < 1 best, < 2 excellent, < 5 good, < 10 inaccuracy, < 20 mistake,
 *     ≥ 20 blunder.
 */
export function classifyMove(args: {
  winPctBefore: number;
  winPctAfter: number;
  evalBefore: EvalScore;
  evalAfter: EvalScore;
  isBest: boolean;
}): MoveClass {
  const { evalBefore, evalAfter } = args;
  if (args.isBest) return 'best';

  const mateBefore = isMate(evalBefore) ? evalBefore.mate : null;
  const mateAfter = isMate(evalAfter) ? evalAfter.mate : null;
  const cpBefore = evalBefore.cp ?? 0;
  const cpAfter = evalAfter.cp ?? 0;
  const hadMate = mateBefore !== null && mateBefore > 0;
  const getsMated = mateAfter !== null && mateAfter <= 0;
  const stillMates = mateAfter !== null && mateAfter > 0;
  const keepsLittle = !stillMates && !getsMated && cpAfter < MISSED_WIN_KEEPS_BELOW_CP;
  const notBad = !getsMated && cpAfter >= MISSED_WIN_NOT_WORSE_THAN_CP;

  // MateCreated
  if (mateBefore === null && getsMated) {
    if (cpBefore < -999) return 'inaccuracy';
    if (cpBefore < -700) return 'mistake';
    return 'blunder';
  }

  // MateLost
  if (hadMate && !stillMates && (mateBefore as number) <= MATE_LOST_MAX_MOVES) {
    if (getsMated) return 'blunder';
    if (cpAfter > 999) return 'inaccuracy';
    if (cpAfter > 700) return 'mistake';
    if (!keepsLittle) return 'blunder';
    return notBad ? 'missedWin' : 'blunder';
  }

  const loss = Math.max(0, args.winPctBefore - args.winPctAfter);
  const wasWinning = hadMate || (mateBefore === null && cpBefore >= MISSED_WIN_AVAILABLE_CP);
  if (wasWinning && keepsLittle && notBad && loss >= CLASSIFY_THRESHOLDS.inaccuracy) return 'missedWin';
  return classifyByLoss(loss);
}
