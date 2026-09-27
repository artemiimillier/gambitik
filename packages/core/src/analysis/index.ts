/**
 * @gambit/core — analysis: eval math, move judgement, position facts, motifs, game summary, PGN.
 * Public API as fixed in docs/ARCHITECTURE.md §3 (plus a few clearly named extras).
 * Isomorphic: no DOM, no `node:` imports; chess.js is the only rules library.
 */
export {
  CLASSIFY_THRESHOLDS,
  classifyMove,
  finalJudgements,
  gameAccuracy,
  moveAccuracy,
  scoreToCp,
  toMoverPov,
  winPct,
} from './eval.ts';
export { judgeMove, DEFAULT_QUICK_DEPTH, DEFAULT_CONFIRM_DEPTH, CONFIRM_LOSS_THRESHOLD } from './judge.ts';
export type { JudgeMoveArgs } from './judge.ts';
export { computePositionFacts } from './facts.ts';
export { findHanging } from './hanging.ts';
export { describeMotif, detectMotif } from './motifs.ts';
export type { MotifDetail } from './motifs.ts';
export { isCaptureMove, materialSwing, uciToSan } from './pv.ts';
export { INACCURACY_MOMENTS_FROM_STAGE, summarizeGame, takebackOutcomes } from './summary.ts';
export type { TakebackOutcome } from './summary.ts';
export { buildPgn, formatClk } from './pgn.ts';
export type { PgnMove } from './pgn.ts';
