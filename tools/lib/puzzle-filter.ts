/**
 * Pure logic of the Lichess puzzle import: CSV line parsing, the kid-friendly quality filter,
 * soft-capped (theme × rating band) selection, solution validation and statistics.
 * No I/O here — tools/import-puzzles.ts and tools/build-starter.ts do the streaming / SQLite part.
 *
 * CSV semantics (database.lichess.org, 11 columns since 2026 — `DailyDate` was added):
 *   PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate
 *   - FEN is the position BEFORE the opponent's move; Moves[0] is the opponent's move, the solver
 *     plays Moves[1], Moves[3], …  The raw row is stored unchanged; the server converts it to the
 *     `Puzzle` contract.
 *   - Fields never contain quotes or commas, so a plain split(',') is a correct parser.
 */
import { Chess } from 'chess.js';

// ───────────────────────── themes ─────────────────────────

/**
 * Themes that make a puzzle worth keeping for a child (research 05 curriculum stages + research 06
 * §2.5). Deliberately NOT here (research 05 verification): `oneMove` (duplicates mateIn1),
 * `castling` (rare, rating ≥ 1400), `opening` (a game-phase tag, not a lesson), and the meta tags
 * (short/long/crushing/advantage/mate/middlegame/endgame/master…). Meta tags of kept puzzles are
 * still indexed in `puzzle_theme`, so `theme=endgame` or `theme=short` queries work.
 */
export const KID_THEMES: ReadonlySet<string> = new Set([
  // stage 1–3: first tactics
  'mateIn1',
  'mateIn2',
  'hangingPiece',
  'backRankMate',
  'fork',
  'pin',
  'skewer',
  // stage 4: combinations
  'discoveredAttack',
  'discoveredCheck',
  'doubleCheck',
  'capturingDefender',
  'deflection',
  'attraction',
  'defensiveMove',
  // stage 5: calculation
  'intermezzo',
  'trappedPiece',
  'xRayAttack',
  'mateIn3',
  'mateIn4',
  'promotion',
  'underPromotion',
  'advancedPawn',
  'enPassant',
  // stage 6–7: attack and strategy
  'kingsideAttack',
  'queensideAttack',
  'attackingF2F7',
  'sacrifice',
  'clearance',
  'interference',
  'exposedKing',
  'quietMove',
  'zugzwang',
  // endgames
  'pawnEndgame',
  'rookEndgame',
  'bishopEndgame',
  'knightEndgame',
  'queenEndgame',
  'queenRookEndgame',
  // «матовые картинки»
  'smotheredMate',
  'arabianMate',
  'anastasiaMate',
  'bodenMate',
  'doubleBishopMate',
  'dovetailMate',
  'swallowstailMate',
  'hookMate',
  'epauletteMate',
  'operaMate',
  'pillsburysMate',
  'morphysMate',
  'cornerMate',
  'triangleMate',
  'vukovicMate',
  'killBoxMate',
  'balestraMate',
  'blindSwineMate',
]);

/** True for `mate`, `mateIn1…5` and every named mate pattern (`backRankMate`, `smotheredMate`, …). */
export function isMateTheme(theme: string): boolean {
  return theme === 'mate' || /^mateIn\d$/.test(theme) || theme.endsWith('Mate');
}

// ───────────────────────── CSV parsing ─────────────────────────

export interface RawPuzzleRow {
  id: string;
  /** position BEFORE the opponent's first move */
  fen: string;
  /** space-separated UCI: opponent, solver, opponent, solver, … */
  moves: string;
  rating: number;
  ratingDeviation: number;
  popularity: number;
  nbPlays: number;
  /** space-separated Lichess theme keys */
  themes: string;
}

export interface ColumnIndex {
  id: number;
  fen: number;
  moves: number;
  rating: number;
  ratingDeviation: number;
  popularity: number;
  nbPlays: number;
  themes: number;
}

const HEADER_NAMES: Record<keyof ColumnIndex, string> = {
  id: 'PuzzleId',
  fen: 'FEN',
  moves: 'Moves',
  rating: 'Rating',
  ratingDeviation: 'RatingDeviation',
  popularity: 'Popularity',
  nbPlays: 'NbPlays',
  themes: 'Themes',
};

/** Column order of the official export; used when a file has no header line. */
export const DEFAULT_COLUMNS: ColumnIndex = {
  id: 0,
  fen: 1,
  moves: 2,
  rating: 3,
  ratingDeviation: 4,
  popularity: 5,
  nbPlays: 6,
  themes: 7,
};

export function isHeaderLine(line: string): boolean {
  return line.startsWith('PuzzleId,');
}

/** Maps the columns we need by NAME, so new trailing/inserted columns never break the import. */
export function columnsFromHeader(headerLine: string): ColumnIndex {
  const names = headerLine.trim().split(',');
  const index = {} as ColumnIndex;
  for (const key of Object.keys(HEADER_NAMES) as (keyof ColumnIndex)[]) {
    const at = names.indexOf(HEADER_NAMES[key]);
    if (at < 0) throw new Error(`puzzle CSV header has no "${HEADER_NAMES[key]}" column: ${headerLine.slice(0, 200)}`);
    index[key] = at;
  }
  return index;
}

const ID_RE = /^[A-Za-z0-9]{3,12}$/;

/** Returns `null` for a malformed line (wrong field count, non-numeric numbers, empty fields). */
export function parsePuzzleLine(line: string, columns: ColumnIndex = DEFAULT_COLUMNS): RawPuzzleRow | null {
  const f = line.split(',');
  const id = f[columns.id];
  const fen = f[columns.fen];
  const moves = f[columns.moves];
  const themes = f[columns.themes];
  if (!id || !fen || !moves || themes === undefined || !ID_RE.test(id)) return null;
  const rating = Number(f[columns.rating]);
  const ratingDeviation = Number(f[columns.ratingDeviation]);
  const popularity = Number(f[columns.popularity]);
  const nbPlays = Number(f[columns.nbPlays]);
  if (!Number.isInteger(rating) || !Number.isFinite(ratingDeviation) || !Number.isFinite(popularity) || !Number.isFinite(nbPlays)) {
    return null;
  }
  return { id, fen, moves, rating, ratingDeviation, popularity, nbPlays, themes: themes.trim() };
}

// ───────────────────────── selection ─────────────────────────

export interface FilterOptions {
  minPopularity: number;
  minPlays: number;
  maxRatingDeviation: number;
  maxRating: number;
  /** whole solution line incl. the opponent's first move, in plies */
  maxPlies: number;
  /** soft cap per (kid theme × 100-point rating band) */
  perBucket: number;
  /** width of a rating band */
  bandWidth: number;
}

export const DEFAULT_FILTER: FilterOptions = {
  minPopularity: 85,
  minPlays: 300,
  maxRatingDeviation: 90,
  maxRating: 2000,
  maxPlies: 8,
  perBucket: 80,
  bandWidth: 100,
};

export type RejectReason = 'rating' | 'deviation' | 'popularity' | 'plays' | 'length' | 'theme' | 'bucketsFull';

export type Verdict = { accept: true; kidThemes: string[] } | { accept: false; reason: RejectReason };

export function countPlies(moves: string): number {
  let n = 1;
  for (let i = 0; i < moves.length; i++) if (moves.charCodeAt(i) === 32) n++;
  return n;
}

export function ratingBand(rating: number, bandWidth: number): number {
  return Math.floor(rating / bandWidth) * bandWidth;
}

/**
 * Streaming selector. `consider()` is side-effect free; call `commit()` only for rows that were
 * really stored (after validation), so bucket counts equal the real content of the database.
 *
 * The cap is SOFT: a row is taken when at least one of its kid themes still has room in its
 * rating band; its other themes may then push their (already full) buckets above the cap.
 */
export class PuzzleSelector {
  readonly options: FilterOptions;
  private readonly buckets = new Map<string, number>();

  constructor(options: Partial<FilterOptions> = {}) {
    this.options = { ...DEFAULT_FILTER, ...options };
  }

  consider(row: RawPuzzleRow): Verdict {
    const o = this.options;
    if (row.rating > o.maxRating) return { accept: false, reason: 'rating' };
    if (row.ratingDeviation > o.maxRatingDeviation) return { accept: false, reason: 'deviation' };
    if (row.popularity < o.minPopularity) return { accept: false, reason: 'popularity' };
    if (row.nbPlays < o.minPlays) return { accept: false, reason: 'plays' };
    if (countPlies(row.moves) > o.maxPlies) return { accept: false, reason: 'length' };
    const kidThemes = row.themes.split(' ').filter((t) => KID_THEMES.has(t));
    if (kidThemes.length === 0) return { accept: false, reason: 'theme' };
    const band = this.band(row.rating);
    const hasRoom = kidThemes.some((t) => (this.buckets.get(`${t}:${band}`) ?? 0) < o.perBucket);
    if (!hasRoom) return { accept: false, reason: 'bucketsFull' };
    return { accept: true, kidThemes };
  }

  commit(row: RawPuzzleRow, kidThemes: readonly string[]): void {
    const band = this.band(row.rating);
    for (const t of kidThemes) {
      const key = `${t}:${band}`;
      this.buckets.set(key, (this.buckets.get(key) ?? 0) + 1);
    }
  }

  bucketCount(theme: string, rating: number): number {
    return this.buckets.get(`${theme}:${this.band(rating)}`) ?? 0;
  }

  /**
   * Selection band. A rating exactly equal to `maxRating` (e.g. 2000) shares the top band
   * (1900–1999) instead of opening a one-value band of its own with a full quota of 80.
   */
  private band(rating: number): number {
    return ratingBand(Math.min(rating, this.options.maxRating - 1), this.options.bandWidth);
  }
}

// ───────────────────────── validation ─────────────────────────

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * Replays the raw row with chess.js. Returns a list of problems (empty = valid):
 *  - the FEN loads, every move is legal UCI;
 *  - the line has an even number of plies ≥ 2 (opponent first, solver last);
 *  - rows tagged with a mate theme end in checkmate; `mateInN` (N ≤ 4) has exactly 2·N plies.
 */
export function validatePuzzleRow(row: Pick<RawPuzzleRow, 'fen' | 'moves' | 'themes'>): string[] {
  const problems: string[] = [];
  const moves = row.moves.split(' ').filter((m) => m !== '');
  if (moves.length < 2 || moves.length % 2 !== 0) problems.push(`expected an even number of plies ≥ 2, got ${moves.length}`);

  let chess: Chess;
  try {
    chess = new Chess(row.fen);
  } catch (err) {
    return [...problems, `bad FEN: ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const [i, uci] of moves.entries()) {
    if (!UCI_RE.test(uci)) return [...problems, `ply ${i + 1}: "${uci}" is not UCI`];
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
    } catch {
      return [...problems, `ply ${i + 1}: illegal move ${uci}`];
    }
  }

  const themes = row.themes.split(' ');
  if (themes.some(isMateTheme)) {
    if (!chess.isCheckmate()) problems.push('mate theme but the line does not end in checkmate');
    for (const t of themes) {
      const m = /^mateIn([1-4])$/.exec(t);
      if (m && moves.length !== 2 * Number(m[1])) problems.push(`${t} but the line has ${moves.length} plies`);
    }
  }
  return problems;
}

// ───────────────────────── statistics ─────────────────────────

export interface ImportStats {
  scanned: number;
  malformed: number;
  invalid: number;
  kept: number;
  rejected: Record<RejectReason, number>;
  /** kept puzzles per theme (ALL themes, kid and meta) */
  themeCounts: Record<string, number>;
  /** kept puzzles per 100-point band, keyed by the band's lower bound */
  ratingHistogram: Record<string, number>;
}

export function emptyStats(): ImportStats {
  return {
    scanned: 0,
    malformed: 0,
    invalid: 0,
    kept: 0,
    rejected: { rating: 0, deviation: 0, popularity: 0, plays: 0, length: 0, theme: 0, bucketsFull: 0 },
    themeCounts: {},
    ratingHistogram: {},
  };
}

export function recordKept(stats: ImportStats, row: RawPuzzleRow): void {
  stats.kept++;
  for (const t of row.themes.split(' ')) {
    if (t !== '') stats.themeCounts[t] = (stats.themeCounts[t] ?? 0) + 1;
  }
  const band = String(ratingBand(row.rating, 100));
  stats.ratingHistogram[band] = (stats.ratingHistogram[band] ?? 0) + 1;
}

/** Human-readable report printed at the end of the import. */
export function formatStats(stats: ImportStats): string {
  const nf = new Intl.NumberFormat('en-US');
  const lines: string[] = [];
  lines.push(`rows scanned : ${nf.format(stats.scanned)}`);
  lines.push(`puzzles kept : ${nf.format(stats.kept)}`);
  lines.push(`malformed    : ${nf.format(stats.malformed)}   failed chess.js validation: ${nf.format(stats.invalid)}`);
  const r = stats.rejected;
  lines.push(
    `rejected     : rating ${nf.format(r.rating)} · deviation ${nf.format(r.deviation)} · popularity ${nf.format(r.popularity)} · ` +
      `plays ${nf.format(r.plays)} · length ${nf.format(r.length)} · no kid theme ${nf.format(r.theme)} · buckets full ${nf.format(r.bucketsFull)}`,
  );

  const byCount = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);
  const entries = Object.entries(stats.themeCounts);
  const kid = entries.filter(([t]) => KID_THEMES.has(t)).sort(byCount);
  const meta = entries.filter(([t]) => !KID_THEMES.has(t)).sort(byCount);
  lines.push('', `per theme (${kid.length} kid themes):`);
  lines.push(wrap(kid.map(([t, n]) => `${t} ${nf.format(n)}`)));
  lines.push('', 'other tags on kept puzzles (indexed too):');
  lines.push(wrap(meta.map(([t, n]) => `${t} ${nf.format(n)}`)));

  lines.push('', 'rating histogram (100-point bands):');
  const bands = Object.entries(stats.ratingHistogram)
    .map(([band, n]) => [Number(band), n] as const)
    .sort((a, b) => a[0] - b[0]);
  const max = Math.max(1, ...bands.map(([, n]) => n));
  for (const [band, n] of bands) {
    const bar = '#'.repeat(Math.max(1, Math.round((n / max) * 40)));
    lines.push(`  ${String(band).padStart(4)}–${String(band + 99).padEnd(4)} ${nf.format(n).padStart(7)} ${bar}`);
  }
  return lines.join('\n');
}

function wrap(items: string[], width = 100): string {
  const out: string[] = [];
  let line = ' ';
  for (const item of items) {
    if (line.length + item.length + 3 > width && line.trim() !== '') {
      out.push(line);
      line = ' ';
    }
    line += ` ${item} ·`;
  }
  if (line.trim() !== '') out.push(line);
  return out.join('\n').replace(/ ·$/gm, '');
}
