/**
 * The hint ladder, enforced in CODE for both voice models (ARCHITECTURE §0.1):
 * whatever level the model — or a child talking the model into it — asks for, a hint is never more
 * than ONE step above the last hint given for the same position. A new position starts from step 1.
 *
 * The position is identified by the tool host's own summary text: it changes whenever the board does.
 */
import type { CoachEvent, CoachToolHost, HintLevel } from '@gambit/shared';

export interface HintLadder {
  /** Asks the host for a hint, clamped to the ladder. `requested` = null means "the next step". */
  give(host: CoachToolHost, requested: HintLevel | null): Promise<{ event: CoachEvent; level: HintLevel }>;
  reset(): void;
  /** last level given for the current position (0 = none yet) */
  readonly lastLevel: number;
}

export function toHintLevel(value: number): HintLevel {
  if (value >= 4) return 4;
  if (value >= 3) return 3;
  if (value >= 2) return 2;
  return 1;
}

/** Pure clamp: `lastGiven` = 0 when no hint was given for this position yet. */
export function clampHintLevel(requested: HintLevel | null, lastGiven: number): HintLevel {
  const next = toHintLevel(Math.min(4, Math.max(0, lastGiven) + 1));
  return requested === null ? next : toHintLevel(Math.min(requested, next));
}

export function createHintLadder(): HintLadder {
  let positionKey: string | null = null;
  let lastLevel = 0;

  return {
    async give(host, requested) {
      let key: string;
      try {
        key = await host.getPositionSummary();
      } catch {
        key = '';
      }
      if (key !== positionKey) {
        positionKey = key;
        lastLevel = 0;
      }
      const level = clampHintLevel(requested, lastLevel);
      const event = await host.getHint(level);
      // the host may lower the level itself (exam mode, not the child's move): trust what was really given
      const given = event.hintLevel ?? level;
      lastLevel = Math.max(lastLevel, Math.min(given, level));
      return { event, level: toHintLevel(Math.min(given, level)) };
    },
    reset() {
      positionKey = null;
      lastLevel = 0;
    },
    get lastLevel() {
      return lastLevel;
    },
  };
}
