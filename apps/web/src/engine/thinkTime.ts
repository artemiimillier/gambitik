import type { Rng } from './types.ts';

/** The coach's quick judgement must fit into the bot's pause, so the bot never answers faster than this. */
export const MIN_THINK_MS = 400;
/** Children are impatient: even a "deep think" never lasts longer than this. */
export const MAX_THINK_MS = 5_000;

export interface ThinkTimeInput {
  /** Full-move number of the game (1-based). */
  moveNumber: number;
  /** Bot's remaining clock; null = untimed game. */
  remainingMs: number | null;
  legalMoveCount: number;
  inCheck: boolean;
  /** Eval gap between the two best candidate moves in centipawns; null when unknown. */
  topGapCp: number | null;
  rng: Rng;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Human-like delay before the bot's move is shown (total, i.e. it already covers the engine search).
 *  - time control: a fraction of the remaining clock (bullet ≈ 1 s, blitz / rapid ≈ 2.6 s), 1.8 s when untimed;
 *  - opening moves are played quickly;
 *  - complex positions (many legal moves, two candidates of similar value) take longer,
 *    forced / obvious moves (single reply, check evasions, one move far ahead) are quick;
 *  - ±30 % jitter so the rhythm never feels mechanical;
 *  - never more than 1/12 of the remaining clock, never less than MIN_THINK_MS.
 */
export function computeThinkMs(input: ThinkTimeInput): number {
  const { moveNumber, remainingMs, legalMoveCount, inCheck, topGapCp, rng } = input;

  if (legalMoveCount <= 1) {
    const forced = MIN_THINK_MS + rng() * 300;
    return Math.round(remainingMs === null ? forced : Math.max(MIN_THINK_MS, Math.min(forced, remainingMs / 12)));
  }

  const base = remainingMs === null ? 1_800 : clamp(remainingMs / 60, 450, 2_600);
  const phase = moveNumber <= 5 ? 0.45 : moveNumber <= 10 ? 0.7 : 1;

  let complexity = 0.75 + 0.5 * clamp((legalMoveCount - 5) / 30, 0, 1);
  if (inCheck) complexity *= 0.8;
  if (topGapCp !== null) {
    if (topGapCp >= 200) complexity *= 0.65;
    else if (topGapCp <= 40) complexity *= 1.15;
  }

  const jitter = 0.7 + rng() * 0.6;
  let thinkMs = base * phase * complexity * jitter;
  if (remainingMs !== null) thinkMs = Math.min(thinkMs, remainingMs / 12);
  return Math.round(clamp(thinkMs, MIN_THINK_MS, MAX_THINK_MS));
}
