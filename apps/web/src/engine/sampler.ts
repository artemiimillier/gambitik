import type { EngineLine, EvalScore } from '@gambit/shared';
import type { Rng } from './types.ts';

/** Mate scores are mapped onto the centipawn axis as ±(MATE_SCORE_CP − 10·N), as in research. */
export const MATE_SCORE_CP = 10_000;

/** Side-to-move score of a line on one centipawn axis (mate in 1 = 9990, being mated in 2 = −9980). */
export function scoreToCp(score: EvalScore): number {
  if (score.mate !== null) {
    // `mate 0` only appears when the side to move is already checkmated.
    if (score.mate === 0) return -MATE_SCORE_CP;
    return Math.sign(score.mate) * (MATE_SCORE_CP - Math.abs(score.mate) * 10);
  }
  return score.cp ?? 0;
}

export interface SamplerCandidate {
  uci: string;
  scoreCp: number;
  /** Eval loss versus the best candidate, ≥ 0. */
  lossCp: number;
  /** Normalised softmax probability (sums to 1 over the pool). */
  probability: number;
}

export interface SamplerParams {
  /** Softmax temperature in centipawns. ≤ 0 means "always the best move". */
  tempCp: number;
  /** Candidates losing more than this versus the best line are never played. */
  maxLossCp: number;
}

/**
 * Turns MultiPV lines into a probability distribution:
 *   1. keep only lines whose first move is legal (`legalUci`),
 *   2. drop candidates losing more than `maxLossCp` versus the best one,
 *   3. weight the rest with softmax over the eval loss: w = exp(−loss / tempCp).
 * The best move always survives step 2, so the pool is empty only when no line is legal.
 */
export function buildCandidatePool(
  lines: readonly EngineLine[],
  legalUci: ReadonlySet<string>,
  params: SamplerParams,
): SamplerCandidate[] {
  const scored = new Map<string, number>();
  for (const line of lines) {
    const uci = line.pvUci[0];
    if (uci === undefined || !legalUci.has(uci)) continue;
    const scoreCp = scoreToCp(line);
    const previous = scored.get(uci);
    if (previous === undefined || scoreCp > previous) scored.set(uci, scoreCp);
  }
  if (scored.size === 0) return [];

  const top = Math.max(...scored.values());
  const maxLoss = Math.max(0, params.maxLossCp);
  const pool: { uci: string; scoreCp: number; lossCp: number; weight: number }[] = [];
  for (const [uci, scoreCp] of scored) {
    const lossCp = top - scoreCp;
    if (lossCp > maxLoss) continue;
    const weight = params.tempCp > 0 ? Math.exp(-lossCp / params.tempCp) : lossCp === 0 ? 1 : 0;
    pool.push({ uci, scoreCp, lossCp, weight });
  }
  const total = pool.reduce((sum, candidate) => sum + candidate.weight, 0);
  return pool
    .map(({ uci, scoreCp, lossCp, weight }) => ({ uci, scoreCp, lossCp, probability: weight / total }))
    .sort((a, b) => a.lossCp - b.lossCp);
}

/** Roulette-wheel pick according to `probability`. `pool` must not be empty. */
export function samplePool(pool: readonly SamplerCandidate[], rng: Rng): SamplerCandidate {
  let ticket = rng();
  for (const candidate of pool) {
    ticket -= candidate.probability;
    if (ticket < 0) return candidate;
  }
  // Floating-point leftovers: fall back to the best candidate.
  return pool[0] as SamplerCandidate;
}
