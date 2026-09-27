/**
 * Pure selection logic for kb/puzzles-starter.json — the small puzzle set bundled with the app so
 * the trainer works before (or without) the big Lichess import.
 */
import { ratingBand, validatePuzzleRow } from './puzzle-filter.ts';

/** Raw row with the same semantics as the `puzzle` table / Lichess CSV (FEN before the opponent's move). */
export interface StarterPuzzle {
  id: string;
  fen: string;
  /** space-separated UCI, opponent's move first */
  moves: string;
  rating: number;
  /** space-separated Lichess theme keys */
  themes: string;
}

export interface StarterCandidate extends StarterPuzzle {
  popularity: number;
  nbPlays: number;
}

export interface StarterQuota {
  theme: string;
  count: number;
  /**
   * Skip rows that are also tagged `mate`. Below ~800 almost every Lichess `hangingPiece` / `fork`
   * puzzle is really a mate in one (research 05 verification) — material themes should teach
   * winning material, the mate quotas cover mating.
   */
  avoidMate?: boolean;
}

/** ≈ 400 puzzles, weighted towards the first curriculum stages (research 05). */
export const STARTER_QUOTAS: readonly StarterQuota[] = [
  { theme: 'mateIn1', count: 60 },
  { theme: 'hangingPiece', count: 40, avoidMate: true },
  { theme: 'backRankMate', count: 30 },
  { theme: 'fork', count: 50, avoidMate: true },
  { theme: 'pin', count: 35, avoidMate: true },
  { theme: 'skewer', count: 25, avoidMate: true },
  { theme: 'mateIn2', count: 45 },
  { theme: 'discoveredAttack', count: 25, avoidMate: true },
  { theme: 'discoveredCheck', count: 10 },
  { theme: 'doubleCheck', count: 5 },
  { theme: 'deflection', count: 10 },
  { theme: 'attraction', count: 10 },
  { theme: 'capturingDefender', count: 5, avoidMate: true },
  { theme: 'trappedPiece', count: 5, avoidMate: true },
  { theme: 'smotheredMate', count: 5 },
  { theme: 'mateIn3', count: 5 },
  { theme: 'pawnEndgame', count: 12, avoidMate: true },
  { theme: 'rookEndgame', count: 12, avoidMate: true },
  { theme: 'queenEndgame', count: 5, avoidMate: true },
  { theme: 'promotion', count: 8, avoidMate: true },
];

export interface StarterOptions {
  minRating: number;
  maxRating: number;
  /** longest allowed line in plies (incl. the opponent's first move) */
  maxPlies: number;
  bandWidth: number;
}

export const STARTER_OPTIONS: StarterOptions = { minRating: 400, maxRating: 1400, maxPlies: 6, bandWidth: 100 };

function byQuality(a: StarterCandidate, b: StarterCandidate): number {
  return b.popularity - a.popularity || b.nbPlays - a.nbPlays || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Deterministic pick: for every quota, walk the rating bands round-robin (easy → hard → easy …)
 * and take the best-rated-by-players unused puzzle of each band, so every theme is spread over
 * the whole 400–1400 range. Every pick is replayed with chess.js; invalid rows are skipped.
 */
export function pickStarter(
  candidates: readonly StarterCandidate[],
  quotas: readonly StarterQuota[] = STARTER_QUOTAS,
  options: StarterOptions = STARTER_OPTIONS,
): StarterPuzzle[] {
  const eligible = candidates.filter(
    (c) => c.rating >= options.minRating && c.rating <= options.maxRating && c.moves.split(' ').length <= options.maxPlies,
  );
  const used = new Set<string>();
  const picked: StarterPuzzle[] = [];

  for (const quota of quotas) {
    const bands = new Map<number, StarterCandidate[]>();
    for (const c of eligible) {
      const themes = c.themes.split(' ');
      if (used.has(c.id) || !themes.includes(quota.theme)) continue;
      if (quota.avoidMate && themes.includes('mate')) continue;
      const band = ratingBand(c.rating, options.bandWidth);
      const list = bands.get(band);
      if (list) list.push(c);
      else bands.set(band, [c]);
    }
    const order = [...bands.keys()].sort((a, b) => a - b);
    for (const band of order) bands.get(band)?.sort(byQuality);

    let taken = 0;
    let progressed = true;
    while (taken < quota.count && progressed) {
      progressed = false;
      for (const band of order) {
        if (taken >= quota.count) break;
        const list = bands.get(band);
        let next = list?.shift();
        while (next && (used.has(next.id) || validatePuzzleRow(next).length > 0)) next = list?.shift();
        if (!next) continue;
        used.add(next.id);
        picked.push({ id: next.id, fen: next.fen, moves: next.moves, rating: next.rating, themes: next.themes });
        taken++;
        progressed = true;
      }
    }
  }

  return picked.sort((a, b) => a.rating - b.rating || (a.id < b.id ? -1 : 1));
}

/** One puzzle per line: compact, diff-friendly, stable. */
export function serializeStarter(puzzles: readonly StarterPuzzle[]): string {
  return `[\n${puzzles.map((p) => JSON.stringify(p)).join(',\n')}\n]\n`;
}

export function themeCounts(puzzles: readonly StarterPuzzle[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of puzzles) for (const t of p.themes.split(' ')) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}
