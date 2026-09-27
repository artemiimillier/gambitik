/**
 * Which strategies this student was served lately (kv 'strategy-history'), so the next game is a
 * different one. Stored as `{ ids: string[] (oldest → newest), sides: ('w' | 'b' | null)[] (the colour of
 * each id), servedAt }`; the first version (`ids` + `servedAt`, no colours) reads as ids of both colours.
 *
 * Per colour: the variety rule looks at the last strategies of the SAME colour (STRATEGY_HISTORY_LIMIT each), so a
 * game as Black never pushes the White strategies out of it.
 *
 * Every served strategy counts — also two quick games in a row («каждую партию новую стратегию»): nothing is replaced
 * within a time window, so a lost game plus a quick rematch never gets the first game's strategy again. The wizard asks
 * once per game (a prefetch is taken by the game, not re-asked), so a rare extra entry only means that an unplayed
 * strategy waits a few games too — never that a played one repeats. The same id twice in a row is kept once.
 */
import type { Color } from '@gambit/shared';
import { STRATEGY_HISTORY_LIMIT } from './library.ts';

interface StoredHistory {
  ids: string[];
  /** parallel to `ids`; null = an entry of the first version (colour unknown) */
  sides: (Color | null)[];
  servedAt: number | null;
}

export interface StrategyHistoryStore {
  loadStrategyHistoryRaw(): unknown;
  saveStrategyHistory(value: unknown): void;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function sideOf(value: unknown): Color | null {
  return value === 'w' || value === 'b' ? value : null;
}

function parse(raw: unknown): StoredHistory {
  if (typeof raw !== 'object' || raw === null) return { ids: [], sides: [], servedAt: null };
  const rawIds: unknown[] = 'ids' in raw && Array.isArray(raw.ids) ? (raw.ids as unknown[]) : [];
  const rawSides: unknown[] = 'sides' in raw && Array.isArray(raw.sides) ? (raw.sides as unknown[]) : [];
  const ids: string[] = [];
  const sides: (Color | null)[] = [];
  rawIds.forEach((id, index) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return;
    ids.push(id);
    sides.push(sideOf(rawSides[index]));
  });
  const servedAt = 'servedAt' in raw && typeof raw.servedAt === 'number' && Number.isFinite(raw.servedAt) ? raw.servedAt : null;
  return trim({ ids, sides, servedAt });
}

/** At most STRATEGY_HISTORY_LIMIT entries per colour (entries of unknown colour count for both): the oldest go first. */
function trim(history: StoredHistory): StoredHistory {
  const keep = new Array<boolean>(history.ids.length).fill(false);
  for (const colour of ['w', 'b'] as const) {
    let kept = 0;
    for (let i = history.ids.length - 1; i >= 0 && kept < STRATEGY_HISTORY_LIMIT; i -= 1) {
      const side = history.sides[i] ?? null;
      if (side === colour || side === null) {
        keep[i] = true;
        kept += 1;
      }
    }
  }
  return {
    ids: history.ids.filter((_, i) => keep[i]),
    sides: history.sides.filter((_, i) => keep[i]),
    servedAt: history.servedAt,
  };
}

export class StrategyHistory {
  private readonly store: StrategyHistoryStore;
  private readonly now: () => number;

  constructor(store: StrategyHistoryStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /**
   * The last strategy ids, oldest → newest: of one colour (≤ STRATEGY_HISTORY_LIMIT; entries of unknown colour
   * included), or of both colours without `side`.
   */
  recent(side?: Color): string[] {
    const history = parse(this.store.loadStrategyHistoryRaw());
    if (side === undefined) return history.ids;
    return history.ids.filter((_, i) => {
      const entry = history.sides[i] ?? null;
      return entry === side || entry === null;
    });
  }

  /** Remembers a served strategy of this colour (see the file comment). */
  record(id: string, side?: Color): void {
    if (!ID_RE.test(id)) return;
    const current = parse(this.store.loadStrategyHistoryRaw());
    const colour = side ?? null;
    const ids = [...current.ids];
    const sides = [...current.sides];
    const last = ids.length - 1;
    // the same answer twice in a row (a repeated request) is one entry
    if (!(last >= 0 && ids[last] === id && (sides[last] ?? null) === colour)) {
      ids.push(id);
      sides.push(colour);
    }
    const next = trim({ ids, sides, servedAt: this.now() });
    this.store.saveStrategyHistory({ ids: next.ids, sides: next.sides, servedAt: next.servedAt });
  }
}
