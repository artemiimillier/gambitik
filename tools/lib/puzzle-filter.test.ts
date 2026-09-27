import { describe, expect, it } from 'vitest';
import {
  columnsFromHeader,
  countPlies,
  DEFAULT_FILTER,
  emptyStats,
  formatStats,
  isHeaderLine,
  isMateTheme,
  KID_THEMES,
  parsePuzzleLine,
  PuzzleSelector,
  ratingBand,
  recordKept,
  validatePuzzleRow,
} from './puzzle-filter.ts';
import type { RawPuzzleRow } from './puzzle-filter.ts';

const HEADER = 'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate';
// Real rows from the official export.
const LINE_LONG =
  '00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1797,76,95,10183,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#48,,';

function row(overrides: Partial<RawPuzzleRow> = {}): RawPuzzleRow {
  return {
    id: 'abcde',
    fen: '6k1/1p3ppp/8/8/8/8/5PPP/R5K1 b - - 0 1',
    moves: 'b7b6 a1a8',
    rating: 650,
    ratingDeviation: 75,
    popularity: 92,
    nbPlays: 1200,
    themes: 'backRankMate endgame mate mateIn1 oneMove',
    ...overrides,
  };
}

describe('CSV parsing', () => {
  it('detects the header and maps the 11-column layout by name', () => {
    expect(isHeaderLine(HEADER)).toBe(true);
    expect(isHeaderLine(LINE_LONG)).toBe(false);
    expect(columnsFromHeader(HEADER)).toEqual({ id: 0, fen: 1, moves: 2, rating: 3, ratingDeviation: 4, popularity: 5, nbPlays: 6, themes: 7 });
  });

  it('survives reordered / extra columns and rejects a header without required columns', () => {
    const cols = columnsFromHeader('Extra,PuzzleId,FEN,Moves,Themes,Rating,RatingDeviation,Popularity,NbPlays');
    const parsed = parsePuzzleLine('x,00008,8/8/8/8/8/8/8/K1k5 w - - 0 1,a1a2 c1c2,fork short,900,80,90,500', cols);
    expect(parsed).toMatchObject({ id: '00008', rating: 900, ratingDeviation: 80, popularity: 90, nbPlays: 500, themes: 'fork short' });
    expect(() => columnsFromHeader('PuzzleId,FEN,Moves')).toThrow(/Rating/);
  });

  it('parses a real row', () => {
    expect(parsePuzzleLine(LINE_LONG)).toEqual({
      id: '00008',
      fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
      moves: 'f2g3 e6e7 b2b1 b3c1 b1c1 h6c1',
      rating: 1797,
      ratingDeviation: 76,
      popularity: 95,
      nbPlays: 10183,
      themes: 'crushing hangingPiece long middlegame',
    });
  });

  it('returns null for malformed lines', () => {
    expect(parsePuzzleLine('')).toBeNull();
    expect(parsePuzzleLine('garbage')).toBeNull();
    expect(parsePuzzleLine('00008,fen,e2e4 e7e5,notanumber,76,95,100,fork')).toBeNull();
    expect(parsePuzzleLine('bad id!,fen,e2e4 e7e5,1000,76,95,100,fork')).toBeNull();
    expect(parsePuzzleLine('00008,fen,e2e4 e7e5,1000,76,95,100')).toBeNull();
  });
});

describe('helpers', () => {
  it('countPlies / ratingBand / isMateTheme', () => {
    expect(countPlies('e2e4')).toBe(1);
    expect(countPlies('f2g3 e6e7 b2b1 b3c1 b1c1 h6c1')).toBe(6);
    expect(ratingBand(1797, 100)).toBe(1700);
    expect(ratingBand(400, 100)).toBe(400);
    expect(['mate', 'mateIn1', 'mateIn3', 'backRankMate', 'smotheredMate'].every(isMateTheme)).toBe(true);
    expect(['fork', 'endgame', 'material', 'pin'].some(isMateTheme)).toBe(false);
  });

  it('kid themes exclude meta tags and the tags research 05 ruled out', () => {
    for (const t of ['mateIn1', 'mateIn2', 'fork', 'pin', 'skewer', 'hangingPiece', 'discoveredAttack', 'backRankMate', 'pawnEndgame', 'rookEndgame']) {
      expect(KID_THEMES.has(t), t).toBe(true);
    }
    for (const t of ['oneMove', 'castling', 'opening', 'short', 'long', 'crushing', 'advantage', 'mate', 'endgame', 'middlegame', 'master', 'mix']) {
      expect(KID_THEMES.has(t), t).toBe(false);
    }
  });
});

describe('PuzzleSelector', () => {
  it('applies the documented default thresholds', () => {
    expect(DEFAULT_FILTER).toMatchObject({ minPopularity: 85, minPlays: 300, maxRatingDeviation: 90, maxRating: 2000, maxPlies: 8, perBucket: 80 });
    const s = new PuzzleSelector();
    expect(s.consider(row())).toEqual({ accept: true, kidThemes: ['backRankMate', 'mateIn1'] });
    expect(s.consider(row({ rating: 2000 })).accept).toBe(true);
    expect(s.consider(row({ rating: 2001 }))).toEqual({ accept: false, reason: 'rating' });
    expect(s.consider(row({ ratingDeviation: 91 }))).toEqual({ accept: false, reason: 'deviation' });
    expect(s.consider(row({ popularity: 84 }))).toEqual({ accept: false, reason: 'popularity' });
    expect(s.consider(row({ nbPlays: 299 }))).toEqual({ accept: false, reason: 'plays' });
    expect(s.consider(row({ moves: 'a2a3 a7a6 b2b3 b7b6 c2c3 c7c6 d2d3 d7d6' })).accept).toBe(true);
    expect(s.consider(row({ moves: 'a2a3 a7a6 b2b3 b7b6 c2c3 c7c6 d2d3 d7d6 e2e3 e7e6' }))).toEqual({ accept: false, reason: 'length' });
    expect(s.consider(row({ themes: 'crushing endgame short' }))).toEqual({ accept: false, reason: 'theme' });
    expect(s.consider(row({ themes: 'castling opening oneMove' }))).toEqual({ accept: false, reason: 'theme' });
  });

  it('caps buckets softly per (theme × rating band)', () => {
    const s = new PuzzleSelector({ perBucket: 2 });
    const take = (r: RawPuzzleRow): boolean => {
      const v = s.consider(r);
      if (v.accept) s.commit(r, v.kidThemes);
      return v.accept;
    };
    expect(take(row({ id: 'a1', themes: 'fork short', rating: 910 }))).toBe(true);
    expect(take(row({ id: 'a2', themes: 'fork short', rating: 999 }))).toBe(true);
    // fork:900 is full now
    expect(s.consider(row({ id: 'a3', themes: 'fork short', rating: 950 }))).toEqual({ accept: false, reason: 'bucketsFull' });
    // another band of the same theme still has room
    expect(take(row({ id: 'a4', themes: 'fork short', rating: 1000 }))).toBe(true);
    // soft cap: a row with a second theme that has room is taken and pushes fork:900 above the cap
    expect(take(row({ id: 'a5', themes: 'fork pin', rating: 920 }))).toBe(true);
    expect(s.bucketCount('fork', 900)).toBe(3);
    expect(s.bucketCount('pin', 900)).toBe(1);
  });

  it('lets rating == maxRating share the top band instead of opening a new one', () => {
    const s = new PuzzleSelector({ perBucket: 1 });
    const first = row({ themes: 'fork', rating: 1950 });
    s.commit(first, ['fork']);
    expect(s.consider(row({ themes: 'fork', rating: 2000 }))).toEqual({ accept: false, reason: 'bucketsFull' });
    expect(s.bucketCount('fork', 2000)).toBe(1);
  });

  it('consider() has no side effects until commit()', () => {
    const s = new PuzzleSelector({ perBucket: 1 });
    for (let i = 0; i < 5; i++) expect(s.consider(row()).accept).toBe(true);
    s.commit(row(), ['backRankMate', 'mateIn1']);
    expect(s.consider(row()).accept).toBe(false);
  });
});

describe('validatePuzzleRow', () => {
  it('accepts a legal mate in one and a real multi-move puzzle', () => {
    expect(validatePuzzleRow(row())).toEqual([]);
    const parsed = parsePuzzleLine(LINE_LONG);
    expect(parsed && validatePuzzleRow(parsed)).toEqual([]);
  });

  it('reports illegal moves, bad FENs and odd line lengths', () => {
    expect(validatePuzzleRow(row({ moves: 'b7b6 a1b8' }))[0]).toMatch(/illegal move a1b8/);
    expect(validatePuzzleRow(row({ moves: 'b7b6 zz' }))[0]).toMatch(/not UCI/);
    expect(validatePuzzleRow(row({ fen: 'not a fen' }))[0]).toMatch(/bad FEN/);
    expect(validatePuzzleRow(row({ moves: 'b7b6' }))[0]).toMatch(/even number of plies/);
  });

  it('requires mate themes to end in checkmate with the right length', () => {
    // 1…b6 2.Ra7 is legal but not mate
    expect(validatePuzzleRow(row({ moves: 'b7b6 a1a7' }))).toContain('mate theme but the line does not end in checkmate');
    expect(validatePuzzleRow(row({ themes: 'mateIn2 mate' }))).toContain('mateIn2 but the line has 2 plies');
    // the same non-mating line is fine for a non-mate theme
    expect(validatePuzzleRow(row({ moves: 'b7b6 a1a7', themes: 'rookEndgame endgame' }))).toEqual([]);
  });

  it('handles promotions', () => {
    expect(validatePuzzleRow({ fen: '8/P6k/8/8/8/8/K6p/8 b - - 0 1', moves: 'h2h1q a7a8q', themes: 'promotion' })).toEqual([]);
    expect(validatePuzzleRow({ fen: '8/P6k/8/8/8/8/K6p/8 b - - 0 1', moves: 'h2h1 a7a8q', themes: 'promotion' })[0]).toMatch(/illegal move h2h1/);
  });
});

describe('stats', () => {
  it('counts themes and rating bands and renders a report', () => {
    const stats = emptyStats();
    stats.scanned = 10;
    recordKept(stats, row({ rating: 650 }));
    recordKept(stats, row({ rating: 699, themes: 'fork short' }));
    recordKept(stats, row({ rating: 1200, themes: 'fork long' }));
    expect(stats.kept).toBe(3);
    expect(stats.themeCounts).toMatchObject({ fork: 2, mateIn1: 1, short: 1, long: 1 });
    expect(stats.ratingHistogram).toEqual({ '600': 2, '1200': 1 });
    const report = formatStats(stats);
    expect(report).toContain('puzzles kept : 3');
    expect(report).toContain('fork 2');
    expect(report).toMatch(/600–699\s+2/);
  });
});
