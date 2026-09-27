/**
 * Pure session bookkeeping for the puzzle trainer: stars for effort, the streak, the attempt sent to
 * the server and which theme title to reveal after a puzzle. No React, no timers.
 *
 * Reward rules (research 08 §1.4 — no dark patterns):
 *  - stars reward EFFORT: finishing a puzzle always gives at least one star, a second try is rewarded;
 *  - the streak only grows or quietly restarts — nothing is ever "lost" or shown as a penalty;
 *  - the timer is measured for the journal but never shown.
 */
import type { Puzzle, PuzzleAttempt } from '@gambit/shared';

export const SESSION_SIZE = 10;
/** «Разминка» of the today plan: three puzzles, then the game (research 08 §1.5). */
export const WARMUP_SESSION_SIZE = 3;
/** The server answers at most this many puzzles per request. */
export const MAX_PUZZLES_PER_REQUEST = 30;
/** A child who walked away must not produce a 40-minute "thinking time". */
export const MAX_MS_SPENT = 10 * 60_000;
export const MAX_HINTS = 2;

export type HintStep = 0 | 1 | 2;

/** What happened while one puzzle was on the board. */
export interface PuzzleRun {
  wrongAttempts: number;
  /** 0 = none, 1 = the piece was highlighted, 2 = the move arrow was shown */
  hintsUsed: HintStep;
  /** the child asked to see the solution */
  solutionShown: boolean;
}

export const EMPTY_RUN: PuzzleRun = { wrongAttempts: 0, hintsUsed: 0, solutionShown: false };

export interface PuzzleOutcome extends PuzzleRun {
  puzzleId: string;
  /** solved at the first try and without looking at the solution — what the rating system counts as solved */
  solvedClean: boolean;
  stars: 1 | 2 | 3;
  msSpent: number;
}

/** Solved for rating purposes: the very first move tried at every step was right, and the solution was not shown. */
export function isSolvedForRating(run: PuzzleRun): boolean {
  return run.wrongAttempts === 0 && !run.solutionShown;
}

/** 3 = on my own at once, 2 = needed a hint or a second try, 1 = watched the solution (still finished it). */
export function starsForRun(run: PuzzleRun): 1 | 2 | 3 {
  if (run.solutionShown) return 1;
  if (run.wrongAttempts === 0 && run.hintsUsed === 0) return 3;
  return 2;
}

export function clampMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(MAX_MS_SPENT, Math.round(ms));
}

export function finishRun(puzzle: Pick<Puzzle, 'id'>, run: PuzzleRun, msSpent: number): PuzzleOutcome {
  return { ...run, puzzleId: puzzle.id, solvedClean: isSolvedForRating(run), stars: starsForRun(run), msSpent: clampMs(msSpent) };
}

/** Body of `POST /puzzles/attempt`. */
export function toAttempt(puzzle: Pick<Puzzle, 'id' | 'themes' | 'rating'>, outcome: PuzzleOutcome): PuzzleAttempt {
  return {
    puzzleId: puzzle.id,
    solved: outcome.solvedClean,
    msSpent: outcome.msSpent,
    hintsUsed: outcome.hintsUsed,
    themes: [...puzzle.themes],
    puzzleRating: puzzle.rating,
  };
}

/** Consecutive puzzles solved at the first try. A miss restarts the count from zero — silently. */
export function nextStreak(current: number, outcome: Pick<PuzzleOutcome, 'solvedClean'>): number {
  return outcome.solvedClean ? current + 1 : 0;
}

export interface SessionStats {
  total: number;
  solvedClean: number;
  /** solved, but with a hint or after another try */
  solvedWithHelp: number;
  solutionsShown: number;
  stars: number;
  maxStars: number;
  bestStreak: number;
}

export function summarizeSession(outcomes: readonly PuzzleOutcome[]): SessionStats {
  let streak = 0;
  let bestStreak = 0;
  let stars = 0;
  let solvedClean = 0;
  let solutionsShown = 0;
  for (const outcome of outcomes) {
    streak = nextStreak(streak, outcome);
    bestStreak = Math.max(bestStreak, streak);
    stars += outcome.stars;
    if (outcome.solvedClean) solvedClean++;
    if (outcome.solutionShown) solutionsShown++;
  }
  return {
    total: outcomes.length,
    solvedClean,
    solvedWithHelp: outcomes.length - solvedClean - solutionsShown,
    solutionsShown,
    stars,
    maxStars: outcomes.length * 3,
    bestStreak,
  };
}

/** 0–3 stars for the whole session, shown big on the summary card (half stars allowed). */
export function sessionStars(stats: Pick<SessionStats, 'stars' | 'maxStars'>): number {
  if (stats.maxStars <= 0) return 0;
  return Math.round((stats.stars / stats.maxStars) * 6) / 2;
}

/**
 * Tags that describe the length, phase, goal or origin of a puzzle — true, but not "what the trick was".
 * They are skipped when we pick the theme to reveal after solving.
 */
const META_THEMES: ReadonlySet<string> = new Set([
  'short',
  'long',
  'veryLong',
  'oneMove',
  'opening',
  'middlegame',
  'endgame',
  'advantage',
  'crushing',
  'equality',
  'mate',
  'master',
  'masterVsMaster',
  'superGM',
  'mix',
  'playerGames',
]);

/** Generic mate-in-N tags are less telling than a named pattern («Мат на последней линии»). */
const GENERIC_MATE_RE = /^mateIn\d$/;

/**
 * The theme to reveal after the puzzle («Это тема „Вилка“!»). Prefers a concrete tactical idea, then a named
 * mate, then mate-in-N, then whatever is left. `known` filters out keys we have no Russian title for.
 */
export function pickRevealTheme(themes: readonly string[], known: (theme: string) => boolean): string | undefined {
  const usable = themes.filter((theme) => known(theme));
  const concrete = usable.filter((theme) => !META_THEMES.has(theme));
  return concrete.find((theme) => !GENERIC_MATE_RE.test(theme)) ?? concrete[0] ?? usable[0];
}

/** Signed rating change for the summary card: «+12», «−5», «0». Uses a real minus sign. */
export function formatRatingDelta(before: number, after: number): string {
  const delta = Math.round(after) - Math.round(before);
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return '0';
}

// ───────────────────────── theme sessions: the instruction must fit the puzzle ─────────────────────────

/** Session sizes the screen accepts from outside (a broken value falls back to the standard ten). */
export function normaliseSessionSize(size: number | undefined): number {
  if (size === undefined || !Number.isInteger(size) || size < 1) return SESSION_SIZE;
  return Math.min(size, MAX_PUZZLES_PER_REQUEST);
}

/**
 * Themes whose instruction talks about WINNING MATERIAL («Её можно забрать бесплатно»). At low ratings a third of the
 * Lichess `hangingPiece` puzzles are really mates in one — the child would look for a free piece that is not there.
 */
const MATERIAL_THEMES: ReadonlySet<string> = new Set(['hangingPiece', 'trappedPiece']);

/** The solution ends in mate (any Lichess mate tag: mate, mateIn1…, backRankMate, smotheredMate, …). */
export function isMatePuzzle(puzzle: Pick<Puzzle, 'themes'>): boolean {
  return puzzle.themes.some((theme) => theme === 'mate' || /^mateIn\d+$/.test(theme) || /Mate$/.test(theme));
}

/** True when a puzzle would contradict the instruction of the chosen session theme. */
export function contradictsTheme(theme: string | undefined, puzzle: Pick<Puzzle, 'themes'>): boolean {
  return theme !== undefined && MATERIAL_THEMES.has(theme) && isMatePuzzle(puzzle);
}

/** How many puzzles to ask the server for: a material theme asks for spares, because some will be filtered out. */
export function requestCountFor(theme: string | undefined, size: number): number {
  return theme !== undefined && MATERIAL_THEMES.has(theme) ? Math.min(MAX_PUZZLES_PER_REQUEST, size * 3) : size;
}

/**
 * The puzzles of one session: those that fit the theme's instruction first; only when the server has too few of
 * them the rest fills the session up (the screen then shows a neutral instruction for such a puzzle).
 */
export function selectSessionPuzzles<T extends Pick<Puzzle, 'themes'>>(batch: readonly T[], theme: string | undefined, size: number): T[] {
  const fitting = batch.filter((puzzle) => !contradictsTheme(theme, puzzle));
  const rest = batch.filter((puzzle) => contradictsTheme(theme, puzzle));
  return [...fitting, ...rest].slice(0, size);
}

export const NEUTRAL_INSTRUCTION_RU = 'Найди лучший ход! Посмотри, что у соперника плохо защищено — и как стоит его король.';

/** The line under the title of a theme session: the theme's own description — unless THIS puzzle contradicts it. */
export function themeInstructionRu(theme: string | undefined, description: string | undefined, puzzle: Pick<Puzzle, 'themes'> | undefined): string | undefined {
  if (description === undefined) return undefined;
  return puzzle !== undefined && contradictsTheme(theme, puzzle) ? NEUTRAL_INSTRUCTION_RU : description;
}
