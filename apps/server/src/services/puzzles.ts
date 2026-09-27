/**
 * Puzzles: sources (imported SQLite → bundled starter JSON → tiny built-in set), conversion of
 * raw Lichess rows to the `Puzzle` contract, adaptive selection and Glicko-2 rating updates.
 *
 * Lichess CSV semantics (research 06/09): `FEN` is the position BEFORE the opponent's move;
 * `Moves[0]` is that move and is applied here, so the child sees the position after it and the
 * solution starts with `Moves[1]`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { glicko2 } from 'glicko2-lite';
import type { Puzzle, PuzzleAttempt, StudentProfile, ThemeSkill } from '@gambit/shared';
import { openDb } from '../storage/db.ts';
import type { Db } from '../storage/db.ts';
import { BUILTIN_PUZZLE_ROWS } from './builtinPuzzles.ts';
import { initialThemeSkill } from './profile.ts';

// ───────────────────────── raw rows → contract ─────────────────────────

export interface RawPuzzleRow {
  id: string;
  /** position before the opponent's first move */
  fen: string;
  /** space-separated UCI moves; the first one is the opponent's */
  moves: string;
  rating: number;
  /** space-separated lichess theme keys */
  themes: string;
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function applyUci(chess: Chess, uci: string): boolean {
  if (!UCI_RE.test(uci)) return false;
  try {
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length === 5 ? uci[4] : undefined });
    return true;
  } catch {
    return false;
  }
}

/** Returns null for rows that are malformed or whose moves are not legal. */
export function convertRawPuzzle(row: RawPuzzleRow): Puzzle | null {
  const moves = row.moves.trim().split(/\s+/).filter((m) => m !== '');
  const first = moves[0];
  if (first === undefined || moves.length < 2 || !Number.isFinite(row.rating)) return null;
  let chess: Chess;
  try {
    chess = new Chess(row.fen);
  } catch {
    return null;
  }
  if (!applyUci(chess, first)) return null;
  const fen = chess.fen();
  for (const uci of moves.slice(1)) {
    if (!applyUci(chess, uci)) return null;
  }
  return {
    id: row.id,
    fen,
    lastMoveUci: first,
    solutionUci: moves.slice(1),
    rating: Math.round(row.rating),
    themes: row.themes.trim().split(/\s+/).filter((t) => t !== ''),
  };
}

/** Checks a puzzle that is already in contract form (solution must be legal from `fen`). */
export function isPlayablePuzzle(puzzle: Puzzle): boolean {
  if (puzzle.solutionUci.length === 0) return false;
  try {
    const chess = new Chess(puzzle.fen);
    return puzzle.solutionUci.every((uci) => applyUci(chess, uci));
  } catch {
    return false;
  }
}

// ───────────────────────── sources ─────────────────────────

export interface CandidateQuery {
  theme?: string;
  lo: number;
  hi: number;
  exclude: ReadonlySet<string>;
  limit: number;
}

export interface PuzzleSource {
  readonly kind: 'sqlite' | 'starter' | 'builtin';
  count(): number;
  /** random candidates inside the rating window */
  candidates(query: CandidateQuery): Puzzle[];
  getById(id: string): Puzzle | undefined;
  close(): void;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a !== undefined && b !== undefined) {
      items[i] = b;
      items[j] = a;
    }
  }
  return items;
}

export class MemoryPuzzleSource implements PuzzleSource {
  readonly kind: 'starter' | 'builtin';
  private readonly puzzles: Puzzle[];
  private readonly byId: Map<string, Puzzle>;
  private readonly rng: () => number;

  constructor(kind: 'starter' | 'builtin', puzzles: Puzzle[], rng: () => number = Math.random) {
    this.kind = kind;
    this.puzzles = puzzles;
    this.byId = new Map(puzzles.map((p) => [p.id, p]));
    this.rng = rng;
  }

  count(): number {
    return this.puzzles.length;
  }

  candidates(query: CandidateQuery): Puzzle[] {
    const matching = this.puzzles.filter(
      (p) => p.rating >= query.lo && p.rating <= query.hi && !query.exclude.has(p.id) && (query.theme === undefined || p.themes.includes(query.theme)),
    );
    return shuffle(matching, this.rng).slice(0, query.limit);
  }

  getById(id: string): Puzzle | undefined {
    return this.byId.get(id);
  }

  close(): void {}
}

interface PuzzleSqlRow {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  themes: string;
}

export class SqlitePuzzleSource implements PuzzleSource {
  readonly kind = 'sqlite' as const;
  private readonly db: Db;
  private readonly hasThemeTable: boolean;
  private readonly total: number;

  constructor(db: Db) {
    this.db = db;
    const tables = new Set(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => row.name));
    if (!tables.has('puzzle')) throw new Error('puzzles.sqlite has no "puzzle" table');
    this.hasThemeTable = tables.has('puzzle_theme');
    this.total = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM puzzle')?.n ?? 0);
  }

  count(): number {
    return this.total;
  }

  candidates(query: CandidateQuery): Puzzle[] {
    const exclude = JSON.stringify([...query.exclude]);
    let rows: PuzzleSqlRow[];
    if (query.theme === undefined) {
      rows = this.db.all<PuzzleSqlRow>(
        `SELECT id, fen, moves, rating, themes FROM puzzle
          WHERE rating BETWEEN ? AND ? AND id NOT IN (SELECT value FROM json_each(?))
          ORDER BY random() LIMIT ?`,
        query.lo,
        query.hi,
        exclude,
        query.limit,
      );
    } else if (this.hasThemeTable) {
      rows = this.db.all<PuzzleSqlRow>(
        `SELECT p.id, p.fen, p.moves, p.rating, p.themes
           FROM puzzle_theme t JOIN puzzle p ON p.id = t.puzzle_id
          WHERE t.theme = ? AND t.rating BETWEEN ? AND ? AND p.id NOT IN (SELECT value FROM json_each(?))
          ORDER BY random() LIMIT ?`,
        query.theme,
        query.lo,
        query.hi,
        exclude,
        query.limit,
      );
    } else {
      rows = this.db.all<PuzzleSqlRow>(
        `SELECT id, fen, moves, rating, themes FROM puzzle
          WHERE rating BETWEEN ? AND ? AND (' ' || themes || ' ') LIKE ? AND id NOT IN (SELECT value FROM json_each(?))
          ORDER BY random() LIMIT ?`,
        query.lo,
        query.hi,
        `% ${query.theme} %`,
        exclude,
        query.limit,
      );
    }
    const puzzles: Puzzle[] = [];
    for (const row of rows) {
      const puzzle = convertRawPuzzle(row);
      if (puzzle !== null) puzzles.push(puzzle);
    }
    return puzzles;
  }

  getById(id: string): Puzzle | undefined {
    const row = this.db.get<PuzzleSqlRow>('SELECT id, fen, moves, rating, themes FROM puzzle WHERE id = ?', id);
    return row === undefined ? undefined : (convertRawPuzzle(row) ?? undefined);
  }

  close(): void {
    this.db.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(item: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(' ');
  }
  return null;
}

function numberField(item: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/**
 * Accepts the starter file in either shape — raw Lichess rows (`fen` before the opponent's move +
 * `moves`) or ready `Puzzle` objects (`lastMoveUci` + `solutionUci`) — as a top-level array or
 * under a `puzzles` key. Invalid entries are dropped.
 */
export function parseStarterPuzzles(json: unknown): Puzzle[] {
  const list = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.puzzles) ? json.puzzles : [];
  const puzzles: Puzzle[] = [];
  const seen = new Set<string>();
  for (const item of list as unknown[]) {
    if (!isRecord(item)) continue;
    const id = stringField(item, 'id', 'PuzzleId', 'puzzleId');
    const fen = stringField(item, 'fen', 'FEN');
    const rating = numberField(item, 'rating', 'Rating');
    const themes = stringField(item, 'themes', 'Themes') ?? '';
    if (id === null || fen === null || rating === null || seen.has(id)) continue;
    let puzzle: Puzzle | null = null;
    const solution = stringField(item, 'solutionUci');
    const lastMove = stringField(item, 'lastMoveUci');
    if (solution !== null && lastMove !== null) {
      const candidate: Puzzle = { id, fen, lastMoveUci: lastMove, solutionUci: solution.split(/\s+/), rating: Math.round(rating), themes: themes.split(/\s+/).filter((t) => t !== '') };
      puzzle = isPlayablePuzzle(candidate) ? candidate : null;
    } else {
      const moves = stringField(item, 'moves', 'Moves');
      puzzle = moves === null ? null : convertRawPuzzle({ id, fen, moves, rating, themes });
    }
    if (puzzle !== null) {
      seen.add(id);
      puzzles.push(puzzle);
    }
  }
  return puzzles;
}

export function builtinPuzzles(): Puzzle[] {
  const puzzles: Puzzle[] = [];
  for (const row of BUILTIN_PUZZLE_ROWS) {
    const puzzle = convertRawPuzzle(row);
    if (puzzle !== null) puzzles.push(puzzle);
  }
  return puzzles;
}

/** How long a read of puzzles.sqlite may wait for a foreign lock. node:sqlite blocks the whole server meanwhile. */
export const PUZZLE_DB_BUSY_TIMEOUT_MS = 150;
/** After a failed read the imported database is left alone for this long (no repeated stalls within one request). */
export const PUZZLE_DB_RETRY_AFTER_MS = 30_000;

/**
 * The imported database with an in-memory safety net. puzzles.sqlite can be locked
 * (backup tool, a manual sqlite3 session) or damaged (partial copy) long after start-up; a read
 * error then logs once and the request is answered from the starter / built-in set instead of a
 * 500 — and for the next 30 s the database is not touched at all, so one request cannot stall the
 * event loop a dozen times in a row.
 */
export class ResilientPuzzleSource implements PuzzleSource {
  readonly kind = 'sqlite' as const;
  private readonly primary: PuzzleSource;
  private readonly loadFallback: () => PuzzleSource;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private fallback: PuzzleSource | null = null;
  private skipPrimaryUntil = 0;

  constructor(primary: PuzzleSource, loadFallback: () => PuzzleSource, options: { log?: (message: string) => void; now?: () => number } = {}) {
    this.primary = primary;
    this.loadFallback = loadFallback;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** true while the imported database is being bypassed after a read error */
  get degraded(): boolean {
    return this.now() < this.skipPrimaryUntil;
  }

  count(): number {
    return this.primary.count();
  }

  private guarded<T>(read: (source: PuzzleSource) => T): T {
    if (!this.degraded) {
      try {
        return read(this.primary);
      } catch (error) {
        this.skipPrimaryUntil = this.now() + PUZZLE_DB_RETRY_AFTER_MS;
        this.log(`[puzzles] puzzles.sqlite is not readable right now (${error instanceof Error ? error.message.slice(0, 160) : 'error'}) — serving the starter set for a while`);
      }
    }
    this.fallback ??= this.loadFallback();
    return read(this.fallback);
  }

  candidates(query: CandidateQuery): Puzzle[] {
    return this.guarded((source) => source.candidates(query));
  }

  getById(id: string): Puzzle | undefined {
    return this.guarded((source) => source.getById(id));
  }

  close(): void {
    this.primary.close();
    this.fallback?.close();
  }
}

export interface OpenPuzzleSourceOptions {
  puzzlesDbPath: string;
  starterPuzzlesPath: string;
  log?: (message: string) => void;
  rng?: () => number;
}

/** kb/puzzles-starter.json → built-in mate-in-1 set */
function openMemorySource(options: OpenPuzzleSourceOptions, log: (message: string) => void): MemoryPuzzleSource {
  if (existsSync(options.starterPuzzlesPath)) {
    try {
      const puzzles = parseStarterPuzzles(JSON.parse(readFileSync(options.starterPuzzlesPath, 'utf8')) as unknown);
      if (puzzles.length > 0) return new MemoryPuzzleSource('starter', puzzles, options.rng);
      log('kb/puzzles-starter.json has no usable puzzles — falling back to the built-in set');
    } catch (error) {
      log(`cannot read kb/puzzles-starter.json (${error instanceof Error ? error.message : String(error)}) — falling back to the built-in set`);
    }
  }
  return new MemoryPuzzleSource('builtin', builtinPuzzles(), options.rng);
}

/** imported SQLite (read-only, short busy timeout, guarded) → kb/puzzles-starter.json → built-in mate-in-1 set */
export function openPuzzleSource(options: OpenPuzzleSourceOptions): PuzzleSource {
  const log = options.log ?? (() => undefined);
  if (existsSync(options.puzzlesDbPath)) {
    let db: Db | null = null;
    try {
      db = openDb(options.puzzlesDbPath, { readOnly: true, busyTimeoutMs: PUZZLE_DB_BUSY_TIMEOUT_MS });
      const source = new SqlitePuzzleSource(db);
      if (source.count() > 0) return new ResilientPuzzleSource(source, () => openMemorySource(options, log), { log });
      source.close();
      log('puzzles.sqlite is empty — falling back to the starter set');
    } catch (error) {
      db?.close(); // idempotent; an unusable file must not stay open
      log(`cannot use puzzles.sqlite (${error instanceof Error ? error.message : String(error)}) — falling back to the starter set`);
    }
  }
  return openMemorySource(options, log);
}

// ───────────────────────── ratings (Glicko-2) ─────────────────────────

/** Lichess puzzle ratings are stable; their deviation is not imported, so a fixed one is used. */
export const PUZZLE_RD = 80;
const MIN_RATING = 100;
const MIN_RD = 45;
const MAX_RD = 350;

/** 1 = solved without help, 0.5 = solved with a hint (kinder than Lichess' 0), 0 = not solved. */
export function attemptScore(attempt: Pick<PuzzleAttempt, 'solved' | 'hintsUsed'>): 0 | 0.5 | 1 {
  if (!attempt.solved) return 0;
  return attempt.hintsUsed > 0 ? 0.5 : 1;
}

/** One attempt = one Glicko-2 rated game between the student and the puzzle. */
export function rateAttempt(skill: ThemeSkill, puzzleRating: number, score: 0 | 0.5 | 1, solved: boolean, nowIso: string, rated = true): ThemeSkill {
  const base = { ...skill, attempts: skill.attempts + 1, solved: skill.solved + (solved ? 1 : 0), lastSeen: nowIso };
  if (!rated) return base;
  const next = glicko2(skill.rating, skill.rd, skill.vol, [[puzzleRating, PUZZLE_RD, score]], { tau: 0.5 });
  if (!Number.isFinite(next.rating) || !Number.isFinite(next.rd) || !Number.isFinite(next.vol)) return base;
  return {
    ...base,
    rating: Math.max(MIN_RATING, Math.round(next.rating * 10) / 10),
    rd: Math.min(MAX_RD, Math.max(MIN_RD, Math.round(next.rd * 10) / 10)),
    vol: next.vol,
  };
}

/** Lichess tags that describe length / phase / evaluation rather than a skill — no own scale. */
const SERVICE_THEMES = new Set(['short', 'long', 'veryLong', 'oneMove', 'middlegame', 'opening', 'advantage', 'crushing', 'equality', 'mate', 'master', 'masterVsMaster', 'superGM']);

export function skillThemes(themes: readonly string[]): string[] {
  return [...new Set(themes)].filter((theme) => /^[A-Za-z0-9]{1,40}$/.test(theme) && !SERVICE_THEMES.has(theme));
}

export interface AttemptOutcome {
  profile: StudentProfile;
  puzzleRating: ThemeSkill;
  rated: boolean;
}

/**
 * Applies an attempt to the profile: overall rating + one scale per skill theme + totals.
 * A repeated attempt on an already seen puzzle is counted but not rated (as on Lichess).
 */
export function applyAttemptToProfile(profile: StudentProfile, attempt: PuzzleAttempt, options: { rated: boolean; now?: Date }): AttemptOutcome {
  const nowIso = (options.now ?? new Date()).toISOString();
  const score = attemptScore(attempt);
  const puzzleRating = rateAttempt(profile.puzzleRating, attempt.puzzleRating, score, attempt.solved, nowIso, options.rated);
  const themeSkills = { ...profile.themeSkills };
  for (const theme of skillThemes(attempt.themes)) {
    // a new theme scale starts from the student's current overall level
    const current = themeSkills[theme] ?? initialThemeSkill(profile.puzzleRating.rating);
    themeSkills[theme] = rateAttempt(current, attempt.puzzleRating, score, attempt.solved, nowIso, options.rated);
  }
  return {
    rated: options.rated,
    puzzleRating,
    profile: {
      ...profile,
      puzzleRating,
      themeSkills,
      totals: {
        ...profile.totals,
        puzzlesAttempted: profile.totals.puzzlesAttempted + 1,
        puzzlesSolved: profile.totals.puzzlesSolved + (attempt.solved ? 1 : 0),
      },
      updatedAt: nowIso,
    },
  };
}

// ───────────────────────── adaptive selection ─────────────────────────

export const WINDOW_HALF_WIDTH = 150;
/** aim slightly below the student's rating: ~75–80 % success keeps a child motivated */
export const TARGET_OFFSET = -50;
export const RECENT_EXCLUDE_LIMIT = 200;
const MAX_WIDENINGS = 12;

export interface NextPuzzlesRequest {
  theme?: string;
  count: number;
  /** themes of the current curriculum stage — about half of an un-themed batch comes from them */
  preferredThemes?: readonly string[];
  /** ids of the most recently attempted puzzles (at most RECENT_EXCLUDE_LIMIT are honoured) */
  recentIds: readonly string[];
}

function targetRating(profile: StudentProfile, theme: string | undefined): number {
  const skill = theme !== undefined ? profile.themeSkills[theme] : undefined;
  return (skill ?? profile.puzzleRating).rating + TARGET_OFFSET;
}

/**
 * Widening search: ±150 first, then ±300, … Puzzles found in a narrower window are kept, a wider
 * window only tops the batch up — so the batch stays as close to the target as the source allows.
 */
function pickWindowed(source: PuzzleSource, theme: string | undefined, count: number, target: number, exclude: ReadonlySet<string>): Puzzle[] {
  if (count <= 0) return [];
  const found: Puzzle[] = [];
  const seen = new Set(exclude);
  for (let step = 0; step <= MAX_WIDENINGS && found.length < count; step += 1) {
    const unbounded = step === MAX_WIDENINGS;
    const half = WINDOW_HALF_WIDTH * (step + 1);
    const candidates = source.candidates({
      theme,
      lo: unbounded ? 0 : Math.round(target - half),
      hi: unbounded ? 100_000 : Math.round(target + half),
      exclude: seen,
      limit: count - found.length,
    });
    for (const puzzle of candidates) {
      if (seen.has(puzzle.id)) continue;
      seen.add(puzzle.id);
      found.push(puzzle);
    }
  }
  return found.slice(0, count);
}

/**
 * Themes whose kid-facing instruction is about winning MATERIAL («забери бесплатно», «поймай фигуру»). Lichess tags
 * many mating puzzles with them too; a mate served under such an instruction contradicts it.
 */
export const MATERIAL_THEMES: ReadonlySet<string> = new Set(['hangingPiece', 'trappedPiece']);
/** how many candidates are looked at per wanted puzzle when some of them will be filtered out */
const FILTER_OVERSAMPLE = 4;

export function isMatePuzzle(puzzle: Pick<Puzzle, 'themes'>): boolean {
  return puzzle.themes.some((theme) => theme === 'mate' || /^mateIn\d+$/.test(theme) || /Mate$/.test(theme));
}

export function selectNextPuzzles(source: PuzzleSource, profile: StudentProfile, request: NextPuzzlesRequest): Puzzle[] {
  const recent = new Set(request.recentIds.slice(0, RECENT_EXCLUDE_LIMIT));
  const picked: Puzzle[] = [];
  const pickedIds = new Set<string>();
  const take = (theme: string | undefined, n: number, exclude: ReadonlySet<string>, accept?: (puzzle: Puzzle) => boolean) => {
    if (n <= 0) return;
    const merged = new Set([...exclude, ...pickedIds]);
    const wanted = accept === undefined ? n : n * FILTER_OVERSAMPLE;
    let added = 0;
    for (const puzzle of pickWindowed(source, theme, wanted, targetRating(profile, theme), merged)) {
      if (added >= n) break;
      if (pickedIds.has(puzzle.id) || (accept !== undefined && !accept(puzzle))) continue;
      picked.push(puzzle);
      pickedIds.add(puzzle.id);
      added += 1;
    }
  };

  if (request.theme !== undefined) {
    if (MATERIAL_THEMES.has(request.theme)) {
      // puzzles that fit the instruction first — fresh ones, then repeats; mates only fill what is still missing
      const fits = (puzzle: Puzzle) => !isMatePuzzle(puzzle);
      take(request.theme, request.count, recent, fits);
      take(request.theme, request.count - picked.length, new Set(), fits);
    }
    take(request.theme, request.count - picked.length, recent);
    // a small source may be exhausted by the "recently seen" rule — then repeats are fine
    if (picked.length < request.count) take(request.theme, request.count - picked.length, new Set());
  } else {
    const preferred = [...new Set(request.preferredThemes ?? [])];
    const fromStage = preferred.length === 0 ? 0 : Math.ceil(request.count / 2);
    for (let i = 0; i < fromStage; i += 1) {
      const theme = preferred[i % preferred.length];
      if (theme !== undefined) take(theme, 1, recent);
    }
    take(undefined, request.count - picked.length, recent);
    if (picked.length < request.count) take(undefined, request.count - picked.length, new Set());
  }
  return picked.slice(0, request.count).sort((a, b) => a.rating - b.rating);
}
