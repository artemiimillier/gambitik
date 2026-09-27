import { PERSONA_IDS } from '@gambit/shared';
import type { BotLevelConfig, PersonaId } from '@gambit/shared';

/**
 * The 8 personas mapped onto the tournament-verified sampler ladder of docs/research/02-engines-bots.md
 * (§5.1 / §6.1, configs P1, P2, L1, L2, L3, L4, L5 and MAX), in ascending strength.
 *
 * `maxLossCp` is the measured value of the very same ladder rung — the ladder was calibrated with these
 * exact (depth, MultiPV, pRandom, tempCp, maxLossCp) tuples, so changing one knob alone invalidates the ordering.
 * `nominalElo` is a UI label, not a measured human rating (research §5.3).
 *
 * Strength comes from the depth limit, so it does not depend on the speed of the device.
 */
export const BOT_LEVELS: Record<PersonaId, BotLevelConfig> = {
  petya: { personaId: 'petya', nominalElo: 300, mode: 'sampler', depth: 1, multipv: 20, pRandom: 0.55, tempCp: 400, maxLossCp: 2000 },
  sonya: { personaId: 'sonya', nominalElo: 500, mode: 'sampler', depth: 2, multipv: 12, pRandom: 0.4, tempCp: 300, maxLossCp: 1200 },
  grisha: { personaId: 'grisha', nominalElo: 700, mode: 'sampler', depth: 3, multipv: 10, pRandom: 0.3, tempCp: 200, maxLossCp: 900 },
  sasha: { personaId: 'sasha', nominalElo: 900, mode: 'sampler', depth: 4, multipv: 8, pRandom: 0.15, tempCp: 150, maxLossCp: 600 },
  vika: { personaId: 'vika', nominalElo: 1100, mode: 'sampler', depth: 5, multipv: 6, pRandom: 0.07, tempCp: 100, maxLossCp: 400 },
  lyova: { personaId: 'lyova', nominalElo: 1400, mode: 'sampler', depth: 6, multipv: 5, pRandom: 0.03, tempCp: 60, maxLossCp: 250 },
  nika: { personaId: 'nika', nominalElo: 1800, mode: 'sampler', depth: 8, multipv: 4, pRandom: 0.01, tempCp: 35, maxLossCp: 150 },
  dima: { personaId: 'dima', nominalElo: 2500, mode: 'full', movetimeMs: 1000 },
};

/** Personas from weakest to strongest (same order as `PERSONA_IDS`). */
export const BOT_LEVEL_ORDER: readonly PersonaId[] = PERSONA_IDS;
