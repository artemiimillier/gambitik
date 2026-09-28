import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { glicko2 } from 'glicko2-lite';
import { afterAll, describe, expect, it } from 'vitest';
import type { Puzzle, StudentProfile, ThemeSkill } from '@gambit/shared';
import { openDb } from '../storage/db.ts';
import { BUILTIN_PUZZLE_ROWS } from './builtinPuzzles.ts';
import { defaultProfile } from './profile.ts';
import {
  MIN_FITTING_SUCCESS,
  MemoryPuzzleSource,
  PUZZLE_RATING_FLOOR,
  PUZZLE_RD,
  SqlitePuzzleSource,
  TARGET_SUCCESS,
  WINDOW_HALF_WIDTH,
  applyAttemptToProfile,
  attemptScore,
  builtinPuzzles,
  convertRawPuzzle,
  expectedScore,
  isMatePuzzle,
  parseStarterPuzzles,
  puzzleRatingFor,
  rateAttempt,
  selectNextPuzzles,
  skillThemes,
  targetRating,
} from './puzzles.ts';

describe('built-in puzzles', () => {
  it('has at least 20 rows and every one is a verified mate in one', () => {
    expect(BUILTIN_PUZZLE_ROWS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(BUILTIN_PUZZLE_ROWS.map((r) => r.id)).size).toBe(BUILTIN_PUZZLE_ROWS.length);
    expect(builtinPuzzles()).toHaveLength(BUILTIN_PUZZLE_ROWS.length);
    for (const row of BUILTIN_PUZZLE_ROWS) {
      const [opponentMove, solution, ...rest] = row.moves.split(' ');
      expect(rest, row.id).toEqual([]);
      const chess = new Chess(row.fen);
      expect(chess.isCheckmate() || chess.isStalemate(), row.id).toBe(false);
      chess.move({ from: (opponentMove ?? '').slice(0, 2), to: (opponentMove ?? '').slice(2, 4) });
      expect(chess.isCheck(), `${row.id}: the child must not start in check`).toBe(false);
      chess.move({ from: (solution ?? '').slice(0, 2), to: (solution ?? '').slice(2, 4), promotion: (solution ?? '')[4] });
      expect(chess.isCheckmate(), `${row.id} must end in mate`).toBe(true);
      expect(row.themes.split(' ')).toContain('mateIn1');
      expect(row.rating).toBeGreaterThanOrEqual(400);
      expect(row.rating).toBeLessThanOrEqual(800);
    }
  });
});

describe('convertRawPuzzle', () => {
  it('applies the opponent\'s first move: the FEN of a Lichess row is the position BEFORE it', () => {
    const puzzle = convertRawPuzzle({
      id: '00008',
      fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
      moves: 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1',
      rating: 1797,
      themes: 'crushing hangingPiece long middlegame',
    });
    expect(puzzle).toEqual({
      id: '00008',
      fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2b1/PqP3PP/7K w - - 0 25',
      lastMoveUci: 'f2g3',
      solutionUci: ['e6e7', 'b2b1', 'b3c1', 'b1c1', 'h6c1'],
      rating: 1797,
      themes: ['crushing', 'hangingPiece', 'long', 'middlegame'],
    });
  });

  it('handles promotions and rejects broken rows', () => {
    const promo = convertRawPuzzle({ id: 'p', fen: '7k/3P1ppp/8/8/8/8/8/6K1 b - - 0 39', moves: 'h8g8 d7d8q', rating: 600, themes: 'promotion' });
    expect(promo?.solutionUci).toEqual(['d7d8q']);
    expect(convertRawPuzzle({ id: 'x', fen: 'not a fen', moves: 'e2e4 e7e5', rating: 600, themes: '' })).toBeNull();
    expect(convertRawPuzzle({ id: 'x', fen: '7k/3P1ppp/8/8/8/8/8/6K1 b - - 0 39', moves: 'h8g8 a1a8', rating: 600, themes: '' })).toBeNull();
    expect(convertRawPuzzle({ id: 'x', fen: '7k/3P1ppp/8/8/8/8/8/6K1 b - - 0 39', moves: 'h8g8', rating: 600, themes: '' })).toBeNull();
    expect(convertRawPuzzle({ id: 'x', fen: '7k/3P1ppp/8/8/8/8/8/6K1 b - - 0 39', moves: 'h8g8 zz', rating: 600, themes: '' })).toBeNull();
  });
});

describe('parseStarterPuzzles', () => {
  it('accepts raw Lichess rows, CSV-style keys and ready Puzzle objects; drops junk', () => {
    const ready: Puzzle = { id: 'c', fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 1 30', lastMoveUci: 'h8g8', solutionUci: ['a1a8'], rating: 400, themes: ['mateIn1'] };
    const puzzles = parseStarterPuzzles({
      puzzles: [
        { id: 'a', fen: '7k/5ppp/8/8/8/8/8/R5K1 b - - 0 29', moves: 'h8g8 a1a8', rating: 400, themes: 'mateIn1 backRankMate' },
        { PuzzleId: 'b', FEN: '7k/5ppp/8/8/8/8/8/R5K1 b - - 0 29', Moves: ['h8g8', 'a1a8'], Rating: '450', Themes: ['mateIn1'] },
        ready,
        { ...ready, id: 'broken', solutionUci: ['a1a7', 'zz'] },
        { id: 'a', fen: '7k/5ppp/8/8/8/8/8/R5K1 b - - 0 29', moves: 'h8g8 a1a8', rating: 400, themes: 'duplicate' },
        { id: 'no-moves', fen: '7k/5ppp/8/8/8/8/8/R5K1 b - - 0 29', rating: 1 },
        'junk',
      ],
    });
    expect(puzzles.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(puzzles[1]).toMatchObject({ rating: 450, lastMoveUci: 'h8g8', solutionUci: ['a1a8'], themes: ['mateIn1'] });
    expect(parseStarterPuzzles([{ id: 'a', fen: '7k/5ppp/8/8/8/8/8/R5K1 b - - 0 29', moves: 'h8g8 a1a8', rating: 400, themes: 'x' }])).toHaveLength(1);
    expect(parseStarterPuzzles(null)).toEqual([]);
  });
});

describe('Glicko-2 rating', () => {
  it('scores attempts kindly: a hint halves the point', () => {
    expect(attemptScore({ solved: true, hintsUsed: 0 })).toBe(1);
    expect(attemptScore({ solved: true, hintsUsed: 2 })).toBe(0.5);
    expect(attemptScore({ solved: false, hintsUsed: 0 })).toBe(0);
  });

  it('matches Glickman\'s reference behaviour qualitatively and keeps sane bounds', () => {
    const start: ThemeSkill = { rating: 600, rd: 300, vol: 0.06, attempts: 0, solved: 0, lastSeen: null };
    const won = rateAttempt(start, 700, 1, true, 'now');
    const lost = rateAttempt(start, 700, 0, false, 'now');
    expect(won.rating).toBeGreaterThan(600);
    expect(lost.rating).toBeLessThan(600);
    expect(won.rating - 600).toBeGreaterThan(600 - lost.rating); // beating a stronger puzzle moves more
    expect(won.rd).toBeLessThan(300);
    expect(won).toMatchObject({ attempts: 1, solved: 1, lastSeen: 'now' });
    // floor: the rating never drops below 100, the deviation never below 45
    let skill: ThemeSkill = { ...start, rating: 120, rd: 50 };
    for (let i = 0; i < 30; i += 1) skill = rateAttempt(skill, 400, 0, false, 'now');
    expect(skill.rating).toBeGreaterThanOrEqual(100);
    expect(skill.rd).toBeGreaterThanOrEqual(45);
    // unrated repeat
    expect(rateAttempt(start, 700, 1, true, 'now', false)).toMatchObject({ rating: 600, rd: 300, attempts: 1, solved: 1 });
  });

  it('updates the overall scale and one scale per skill theme', () => {
    expect(skillThemes(['mateIn1', 'short', 'oneMove', 'middlegame', 'fork', 'fork', 'bad theme!'])).toEqual(['mateIn1', 'fork']);
    const { profile, puzzleRating } = applyAttemptToProfile(
      defaultProfile(),
      { puzzleId: 'p1', solved: true, msSpent: 1000, hintsUsed: 0, themes: ['fork', 'short', 'endgame'], puzzleRating: 650 },
      { rated: true, now: new Date('2026-09-21T10:00:00Z') },
    );
    expect(puzzleRating.rating).toBeGreaterThan(600);
    expect(Object.keys(profile.themeSkills).sort()).toEqual(['endgame', 'fork']);
    expect(profile.themeSkills.fork?.rating).toBeGreaterThan(600);
    expect(profile.totals).toMatchObject({ puzzlesAttempted: 1, puzzlesSolved: 1 });
    expect(profile.puzzleRating.lastSeen).toBe('2026-09-21T10:00:00.000Z');
  });
});

describe('difficulty target', () => {
  /** E = 1 / (1 + 10^(−g(RD)·Δ/400)), g(RD) = 1 / √(1 + 3q²RD²/π²), q = ln 10 / 400 */
  const closedForm = (delta: number, rd: number) => {
    const q = Math.LN10 / 400;
    const g = 1 / Math.sqrt(1 + (3 * q * q * rd * rd) / (Math.PI * Math.PI));
    return 1 / (1 + 10 ** ((-g * delta) / 400));
  };

  it('is the Glicko expected score — the very one glicko2-lite rates an attempt against', () => {
    for (const [rating, puzzle] of [[600, 400], [1000, 750], [1500, 1600], [2000, 1200]] as const) {
      const e = expectedScore({ rating, rd: 0 }, puzzle);
      expect(e).toBeCloseTo(closedForm(rating - puzzle, PUZZLE_RD), 7); // glicko2-lite rounds 400 / ln 10 to 173.7178
      // scoring exactly the expectation leaves the rating where it was
      expect(glicko2(rating, 120, 0.06, [[puzzle, PUZZLE_RD, e]], { tau: 0.5 }).rating).toBeCloseTo(rating, 6);
    }
    // the student's own deviation flattens the forecast: g(√(RD² + RDⱼ²))
    expect(expectedScore({ rating: 1000, rd: 300 }, 750)).toBeCloseTo(closedForm(250, Math.hypot(300, PUZZLE_RD)), 7);
  });

  it('aims at four puzzles of five — «50 below the rating» gave only 57 %', () => {
    expect(expectedScore({ rating: 1000, rd: 0 }, 950)).toBeCloseTo(0.57, 2);
    expect(TARGET_SUCCESS).toBe(0.8);
    for (const rd of [45, 80, 150, 300]) {
      const skill = { rating: 1500, rd };
      expect(expectedScore(skill, targetRating(skill))).toBeCloseTo(0.8, 9);
    }
    // a settled rating: about 250 below it — where the rating update itself expects 80.2 %
    expect(1500 - targetRating({ rating: 1500, rd: 45 })).toBeCloseTo(250.8, 1);
    expect(expectedScore({ rating: 1500, rd: 0 }, 1500 - 250.8)).toBeCloseTo(0.802, 3);
  });

  it('aims lower while the rating is uncertain, but never below the easy end of the scale', () => {
    const gap = (rd: number) => 1500 - targetRating({ rating: 1500, rd });
    expect(gap(80)).toBeCloseTo(255.9, 1);
    expect(gap(150)).toBeCloseTo(273.6, 1);
    expect(gap(300)).toBeCloseTo(338.1, 1);
    // a new child (600 ± 300) and a struggling one are aimed at the easiest band, not below the easiest puzzle
    expect(targetRating(defaultProfile().puzzleRating)).toBe(PUZZLE_RATING_FLOOR);
    expect(targetRating({ rating: 450, rd: 45 })).toBe(PUZZLE_RATING_FLOOR);
  });

  it('puzzleRatingFor solves expectedScore for the puzzle', () => {
    for (const skill of [{ rating: 600, rd: 300 }, { rating: 1200, rd: 45 }, { rating: 1800, rd: 150 }]) {
      for (const success of [MIN_FITTING_SUCCESS, 0.5, TARGET_SUCCESS, 0.9]) expect(expectedScore(skill, puzzleRatingFor(skill, success))).toBeCloseTo(success, 9);
    }
    expect(puzzleRatingFor({ rating: 900, rd: 60 }, 0.5)).toBeCloseTo(900, 9);
  });
});

describe('adaptive selection', () => {
  const pool: Puzzle[] = [];
  for (let rating = 300; rating <= 2000; rating += 20) {
    for (const theme of ['fork', 'pin']) pool.push({ id: `${theme}-${rating}`, fen: 'x', lastMoveUci: 'a1a2', solutionUci: ['a2a3'], rating, themes: [theme] });
  }
  const source = () => new MemoryPuzzleSource('starter', pool);
  const skill = (r: number): ThemeSkill => ({ rating: r, rd: 100, vol: 0.06, attempts: 20, solved: 10, lastSeen: null });
  const profileAt = (rating: number, themes: Record<string, number> = {}): StudentProfile => {
    const base = defaultProfile();
    return { ...base, puzzleRating: skill(rating), themeSkills: Object.fromEntries(Object.entries(themes).map(([t, r]) => [t, skill(r)])) };
  };
  /** where a batch for a student rated `r` is centred */
  const target = (r: number) => targetRating(skill(r));

  it('stays inside the ±150 window around the target and sorts easier first', () => {
    const picked = selectNextPuzzles(source(), profileAt(1000), { count: 8, recentIds: [] });
    expect(picked).toHaveLength(8);
    for (const p of picked) expect(Math.abs(p.rating - target(1000))).toBeLessThanOrEqual(WINDOW_HALF_WIDTH);
    expect(picked.map((p) => p.rating)).toEqual([...picked.map((p) => p.rating)].sort((a, b) => a - b));
    expect(new Set(picked.map((p) => p.id)).size).toBe(8);
  });

  it('uses the theme scale when a theme is requested', () => {
    const picked = selectNextPuzzles(source(), profileAt(1000, { pin: 1500 }), { theme: 'pin', count: 5, recentIds: [] });
    expect(picked).toHaveLength(5);
    for (const p of picked) {
      expect(p.themes).toEqual(['pin']);
      expect(Math.abs(p.rating - target(1500))).toBeLessThanOrEqual(WINDOW_HALF_WIDTH);
    }
  });

  it('widens the window when there are not enough puzzles', () => {
    // the target is 2410: ±450 reaches 1960–2000 (three puzzles); only the fourth comes from the next, wider window
    const picked = selectNextPuzzles(source(), profileAt(2410 + (1000 - target(1000))), { theme: 'fork', count: 4, recentIds: [] });
    const ratings = picked.map((p) => p.rating);
    expect(ratings).toHaveLength(4);
    expect(ratings.slice(1)).toEqual([1960, 1980, 2000]);
    expect(ratings[0]).toBeGreaterThanOrEqual(1810);
    expect(ratings[0]).toBeLessThan(1960);
  });

  it('starts a new child at the easy end, and a theme that only starts far above is still served', () => {
    const picked = selectNextPuzzles(source(), defaultProfile(), { count: 10, recentIds: [] });
    expect(picked).toHaveLength(10);
    for (const p of picked) expect(p.rating).toBeLessThanOrEqual(PUZZLE_RATING_FLOOR + WINDOW_HALF_WIDTH);

    const hard = new MemoryPuzzleSource('starter', pool.filter((p) => p.rating >= 1200));
    const late = selectNextPuzzles(hard, defaultProfile(), { theme: 'pin', count: 3, recentIds: [] });
    expect(late).toHaveLength(3);
    // the first window that reaches the theme (400 ± 900) — its easiest band
    for (const p of late) expect(p.rating).toBeLessThanOrEqual(1300);
  });

  it('excludes recently attempted puzzles, but repeats rather than returning nothing', () => {
    const near = pool.filter((p) => p.themes[0] === 'fork' && Math.abs(p.rating - target(1000)) <= WINDOW_HALF_WIDTH).map((p) => p.id);
    const picked = selectNextPuzzles(source(), profileAt(1000), { theme: 'fork', count: 5, recentIds: near });
    expect(picked).toHaveLength(5);
    for (const p of picked) expect(near).not.toContain(p.id);

    const tiny = new MemoryPuzzleSource('builtin', pool.slice(0, 3));
    const all = selectNextPuzzles(tiny, profileAt(600), { count: 3, recentIds: pool.slice(0, 3).map((p) => p.id) });
    expect(all).toHaveLength(3);
  });

  it('does not serve mates under a «win material» theme while other puzzles exist', () => {
    const mixed: Puzzle[] = [];
    for (let i = 0; i < 12; i += 1) {
      // two of every three «hangingPiece» puzzles near the target are really mates
      const themes = i % 3 === 0 ? ['hangingPiece', 'short'] : ['hangingPiece', 'mate', 'mateIn1'];
      mixed.push({ id: `h-${i}`, fen: 'x', lastMoveUci: 'a1a2', solutionUci: ['a2a3'], rating: 540 + i * 5, themes });
    }
    mixed.push({ id: 'h-back', fen: 'x', lastMoveUci: 'a1a2', solutionUci: ['a2a3'], rating: 560, themes: ['hangingPiece', 'backRankMate'] });
    const src = new MemoryPuzzleSource('starter', mixed);

    const four = selectNextPuzzles(src, profileAt(600), { theme: 'hangingPiece', count: 4, recentIds: [] });
    expect(four).toHaveLength(4);
    expect(four.every((p) => !isMatePuzzle(p))).toBe(true);

    // more wanted than fit: the fitting ones are all there, mates only fill the rest
    const eight = selectNextPuzzles(src, profileAt(600), { theme: 'hangingPiece', count: 8, recentIds: [] });
    expect(eight).toHaveLength(8);
    expect(eight.filter((p) => !isMatePuzzle(p))).toHaveLength(4);

    // other themes are untouched by the filter
    const mate = selectNextPuzzles(src, profileAt(600), { theme: 'mateIn1', count: 3, recentIds: [] });
    expect(mate).toHaveLength(3);
    expect(mate.every(isMatePuzzle)).toBe(true);
  });

  it('stage 1: looks past the easy mates for puzzles that win material, but not at ever harder ones', () => {
    const puzzles: Puzzle[] = [];
    const add = (id: string, rating: number, themes: string[]) => puzzles.push({ id, fen: 'x', lastMoveUci: 'a1a2', solutionUci: ['a2a3'], rating, themes });
    // as in the Lichess database: the easy `hangingPiece` puzzles are mates, the ones that win a piece start higher
    for (let i = 0; i < 40; i += 1) add(`mate-${i}`, 400 + i * 5, ['hangingPiece', 'mate', 'mateIn1']);
    for (const rating of [560, 610, 650, 690]) add(`free-${rating}`, rating, ['hangingPiece', 'short']);
    for (const rating of [800, 900, 1000]) add(`hard-${rating}`, rating, ['hangingPiece', 'short']);
    const src = new MemoryPuzzleSource('starter', puzzles);
    const child = profileAt(600);
    const ceiling = puzzleRatingFor(child.puzzleRating, MIN_FITTING_SUCCESS);
    expect(target(600)).toBe(PUZZLE_RATING_FLOOR);
    expect(ceiling).toBeGreaterThan(690);
    expect(ceiling).toBeLessThan(800);

    // every fitting puzzle within reach and none of the too hard ones; mates near the target fill the rest
    const batch = selectNextPuzzles(src, child, { theme: 'hangingPiece', count: 10, recentIds: [] });
    expect(batch).toHaveLength(10);
    expect(batch.filter((p) => !isMatePuzzle(p)).map((p) => p.id).sort()).toEqual(['free-560', 'free-610', 'free-650', 'free-690']);
    for (const p of batch.filter(isMatePuzzle)) expect(p.rating).toBeLessThanOrEqual(PUZZLE_RATING_FLOOR + WINDOW_HALF_WIDTH);

    // used up: they come back as repeats — not a mate, not a puzzle beyond reach
    const free = ['free-560', 'free-610', 'free-650', 'free-690'];
    expect(selectNextPuzzles(src, child, { theme: 'hangingPiece', count: 4, recentIds: free }).map((p) => p.id).sort()).toEqual(free);

    // the stage mix takes its «free piece» picks from the fitting ones too
    const mix = selectNextPuzzles(src, child, { count: 4, preferredThemes: ['hangingPiece'], recentIds: [] });
    expect(mix.filter((p) => p.id.startsWith('free-'))).toHaveLength(2);
  });

  it('mixes in the themes of the current curriculum stage', () => {
    const picked = selectNextPuzzles(source(), profileAt(1000), { count: 6, preferredThemes: ['pin'], recentIds: [] });
    expect(picked.filter((p) => p.themes[0] === 'pin').length).toBeGreaterThanOrEqual(3);
  });

  it('returns an empty list for an unknown theme', () => {
    expect(selectNextPuzzles(source(), profileAt(1000), { theme: 'zugzwang', count: 3, recentIds: [] })).toEqual([]);
  });
});

describe('SqlitePuzzleSource', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gambit-puzzles-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // one legal Lichess line filed under different tags
  const FEN = 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24';
  const MOVES = 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1';
  const TAGS: Record<string, string> = {
    free: 'crushing hangingPiece long middlegame',
    mate: 'hangingPiece mate mateIn2 short',
    back: 'backRankMate hangingPiece mate mateIn1 oneMove',
    // a pattern or a length tag alone still means a mate; look-alike words do not
    pattern: 'hangingPiece smotheredMate',
    length: 'hangingPiece mateIn3',
    lookalike: 'hangingPiece matey mated',
  };

  function build(name: string, withThemeTable: boolean): SqlitePuzzleSource {
    const path = join(dir, `${name}.sqlite`);
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE puzzle (id TEXT PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL, popularity INTEGER, nb_plays INTEGER, themes TEXT NOT NULL)');
    if (withThemeTable) db.exec('CREATE TABLE puzzle_theme (theme TEXT NOT NULL, rating INTEGER NOT NULL, puzzle_id TEXT NOT NULL, PRIMARY KEY (theme, rating, puzzle_id)) WITHOUT ROWID');
    for (const [id, themes] of Object.entries(TAGS)) {
      db.prepare('INSERT INTO puzzle VALUES (?, ?, ?, 600, 95, 1000, ?)').run(id, FEN, MOVES, themes);
      if (withThemeTable) for (const theme of themes.split(' ')) db.prepare('INSERT INTO puzzle_theme VALUES (?, 600, ?)').run(theme, id);
    }
    db.close();
    return new SqlitePuzzleSource(openDb(path, { readOnly: true }));
  }

  it.each([true, false])('leaves out exactly what isMatePuzzle calls a mate (theme table: %s)', (withThemeTable) => {
    const source = build(`tags-${withThemeTable}`, withThemeTable);
    try {
      const query = { lo: 0, hi: 3000, exclude: new Set<string>(), limit: 100 };
      const notMates = Object.entries(TAGS)
        .filter(([, themes]) => !isMatePuzzle({ themes: themes.split(' ') }))
        .map(([id]) => id)
        .sort();
      expect(notMates).toEqual(['free', 'lookalike']);
      for (const theme of [undefined, 'hangingPiece']) {
        expect(source.candidates({ ...query, theme, noMates: true }).map((p) => p.id).sort()).toEqual(notMates);
        expect(source.candidates({ ...query, theme })).toHaveLength(Object.keys(TAGS).length);
      }
    } finally {
      source.close();
    }
  });
});

const STARTER_PATH = fileURLToPath(new URL('../../../../kb/puzzles-starter.json', import.meta.url));

describe.skipIf(!existsSync(STARTER_PATH))('kb/puzzles-starter.json (written by the tools agent)', () => {
  it('is understood by the starter parser', () => {
    const raw: unknown = JSON.parse(readFileSync(STARTER_PATH, 'utf8'));
    const puzzles = parseStarterPuzzles(raw);
    expect(puzzles.length).toBeGreaterThan(50);
    const total = Array.isArray(raw) ? raw.length : puzzles.length;
    expect(puzzles.length / total).toBeGreaterThan(0.95);
  });
});
