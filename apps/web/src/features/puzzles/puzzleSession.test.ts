import { describe, expect, it } from 'vitest';
import {
  EMPTY_RUN,
  MAX_MS_SPENT,
  MAX_PUZZLES_PER_REQUEST,
  NEUTRAL_INSTRUCTION_RU,
  SESSION_SIZE,
  WARMUP_SESSION_SIZE,
  clampMs,
  contradictsTheme,
  finishRun,
  formatRatingDelta,
  isMatePuzzle,
  isSolvedForRating,
  nextStreak,
  normaliseSessionSize,
  pickRevealTheme,
  requestCountFor,
  selectSessionPuzzles,
  sessionStars,
  starsForRun,
  summarizeSession,
  themeInstructionRu,
  toAttempt,
} from './puzzleSession.ts';
import type { PuzzleOutcome, PuzzleRun } from './puzzleSession.ts';

const puzzle = { id: 'abc12', themes: ['fork', 'short', 'middlegame'], rating: 640 };

function outcome(run: Partial<PuzzleRun>, id = 'p'): PuzzleOutcome {
  return finishRun({ id }, { ...EMPTY_RUN, ...run }, 5000);
}

describe('stars and rating flag', () => {
  it('gives three stars for a clean solution', () => {
    expect(starsForRun(EMPTY_RUN)).toBe(3);
    expect(isSolvedForRating(EMPTY_RUN)).toBe(true);
  });

  it('rewards a second try and a hinted solution with two stars', () => {
    expect(starsForRun({ ...EMPTY_RUN, wrongAttempts: 3 })).toBe(2);
    expect(starsForRun({ ...EMPTY_RUN, hintsUsed: 2 })).toBe(2);
  });

  it('the first wrong attempt makes the puzzle "not solved" for the rating, hints alone do not', () => {
    expect(isSolvedForRating({ ...EMPTY_RUN, wrongAttempts: 1 })).toBe(false);
    expect(isSolvedForRating({ ...EMPTY_RUN, hintsUsed: 1 })).toBe(true);
    expect(isSolvedForRating({ ...EMPTY_RUN, solutionShown: true })).toBe(false);
  });

  it('still gives one star for watching the solution to the end', () => {
    expect(starsForRun({ wrongAttempts: 4, hintsUsed: 2, solutionShown: true })).toBe(1);
  });
});

describe('toAttempt', () => {
  it('builds the server body', () => {
    const attempt = toAttempt(puzzle, finishRun(puzzle, { wrongAttempts: 0, hintsUsed: 1, solutionShown: false }, 12_345.6));
    expect(attempt).toEqual({ puzzleId: 'abc12', solved: true, msSpent: 12_346, hintsUsed: 1, themes: ['fork', 'short', 'middlegame'], puzzleRating: 640 });
  });

  it('clamps absurd thinking times', () => {
    expect(clampMs(-5)).toBe(0);
    expect(clampMs(Number.NaN)).toBe(0);
    expect(clampMs(99 * 60_000)).toBe(MAX_MS_SPENT);
  });
});

describe('streak and summary', () => {
  it('grows on clean solutions and quietly restarts otherwise', () => {
    expect(nextStreak(2, { solvedClean: true })).toBe(3);
    expect(nextStreak(7, { solvedClean: false })).toBe(0);
  });

  it('summarises a session', () => {
    const stats = summarizeSession([outcome({}), outcome({}), outcome({ wrongAttempts: 1 }), outcome({}), outcome({ solutionShown: true, wrongAttempts: 2 })]);
    expect(stats).toEqual({ total: 5, solvedClean: 3, solvedWithHelp: 1, solutionsShown: 1, stars: 3 + 3 + 2 + 3 + 1, maxStars: 15, bestStreak: 2 });
    expect(sessionStars(stats)).toBe(2.5);
  });

  it('handles an empty session', () => {
    const stats = summarizeSession([]);
    expect(stats.total).toBe(0);
    expect(sessionStars(stats)).toBe(0);
  });
});

describe('pickRevealTheme', () => {
  const known = (theme: string) => theme !== 'unknownTag';

  it('prefers the concrete idea over length / phase tags', () => {
    expect(pickRevealTheme(['short', 'middlegame', 'fork', 'crushing'], known)).toBe('fork');
  });

  it('prefers a named mate over mate-in-N, and mate-in-N over nothing', () => {
    expect(pickRevealTheme(['mate', 'mateIn2', 'backRankMate', 'short'], known)).toBe('backRankMate');
    expect(pickRevealTheme(['mate', 'mateIn1', 'oneMove'], known)).toBe('mateIn1');
  });

  it('falls back to a meta tag, skips unknown keys, and may find nothing', () => {
    expect(pickRevealTheme(['unknownTag', 'endgame'], known)).toBe('endgame');
    expect(pickRevealTheme(['unknownTag'], known)).toBeUndefined();
    expect(pickRevealTheme([], known)).toBeUndefined();
  });
});

describe('formatRatingDelta', () => {
  it('uses explicit signs', () => {
    expect(formatRatingDelta(600, 612.4)).toBe('+12');
    expect(formatRatingDelta(600, 594.6)).toBe('−5');
    expect(formatRatingDelta(600.2, 599.9)).toBe('0');
  });
});

describe('theme sessions keep the promise of their instruction', () => {
  const free = { id: 'free', themes: ['hangingPiece', 'short', 'middlegame'] };
  const mateIn1 = { id: 'm1', themes: ['backRankMate', 'hangingPiece', 'mate', 'mateIn1', 'oneMove'] };
  const smothered = { id: 'sm', themes: ['hangingPiece', 'smotheredMate'] };

  it('recognises every kind of mate tag', () => {
    expect(isMatePuzzle(mateIn1)).toBe(true);
    expect(isMatePuzzle(smothered)).toBe(true);
    expect(isMatePuzzle({ themes: ['mate'] })).toBe(true);
    expect(isMatePuzzle(free)).toBe(false);
    expect(isMatePuzzle({ themes: ['intermezzo', 'material'] })).toBe(false);
  });

  it('«забери бесплатно» is never illustrated by a mate in one when other puzzles exist', () => {
    expect(contradictsTheme('hangingPiece', mateIn1)).toBe(true);
    expect(contradictsTheme('hangingPiece', free)).toBe(false);
    expect(contradictsTheme('mateIn1', mateIn1)).toBe(false);
    expect(contradictsTheme(undefined, mateIn1)).toBe(false);

    const batch = [mateIn1, free, smothered, { ...free, id: 'free2' }, { ...free, id: 'free3' }];
    expect(selectSessionPuzzles(batch, 'hangingPiece', 3).map((p) => p.id)).toEqual(['free', 'free2', 'free3']);
    // too few fitting puzzles: the mates fill the session up, at the END
    expect(selectSessionPuzzles(batch, 'hangingPiece', 4).map((p) => p.id)).toEqual(['free', 'free2', 'free3', 'm1']);
    // other themes and the adaptive mix are untouched
    expect(selectSessionPuzzles(batch, 'mateIn1', 2).map((p) => p.id)).toEqual(['m1', 'free']);
    expect(selectSessionPuzzles(batch, undefined, 2).map((p) => p.id)).toEqual(['m1', 'free']);
  });

  it('asks the server for spares only where puzzles will be filtered', () => {
    expect(requestCountFor('hangingPiece', 10)).toBe(30);
    expect(requestCountFor('hangingPiece', 3)).toBe(9);
    expect(requestCountFor('fork', 10)).toBe(10);
    expect(requestCountFor(undefined, 10)).toBe(10);
  });

  it('a mate that still got into the session is shown under a neutral instruction', () => {
    const description = 'Фигуру никто не защищает. Её можно забрать бесплатно — найди её!';
    expect(themeInstructionRu('hangingPiece', description, free)).toBe(description);
    expect(themeInstructionRu('hangingPiece', description, mateIn1)).toBe(NEUTRAL_INSTRUCTION_RU);
    expect(NEUTRAL_INSTRUCTION_RU).not.toMatch(/бесплатно/);
    expect(themeInstructionRu('hangingPiece', description, undefined)).toBe(description);
    expect(themeInstructionRu('hangingPiece', undefined, mateIn1)).toBeUndefined();
  });
});

describe('session size (the warm-up is three puzzles)', () => {
  it('accepts a sane size and falls back to ten otherwise', () => {
    expect(WARMUP_SESSION_SIZE).toBe(3);
    expect(normaliseSessionSize(WARMUP_SESSION_SIZE)).toBe(3);
    expect(normaliseSessionSize(undefined)).toBe(SESSION_SIZE);
    expect(normaliseSessionSize(0)).toBe(SESSION_SIZE);
    expect(normaliseSessionSize(2.5)).toBe(SESSION_SIZE);
    expect(normaliseSessionSize(500)).toBe(MAX_PUZZLES_PER_REQUEST);
  });
});
