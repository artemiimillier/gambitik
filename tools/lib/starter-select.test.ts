import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { repoPath } from './cli.ts';
import { isMateTheme, validatePuzzleRow } from './puzzle-filter.ts';
import { pickStarter, serializeStarter, STARTER_OPTIONS, STARTER_QUOTAS, themeCounts } from './starter-select.ts';
import type { StarterCandidate, StarterPuzzle } from './starter-select.ts';

// Back-rank mate in one (1…b6 2.Ra8#) and a non-mating rook endgame line from the same position.
const MATE_FEN = '6k1/1p3ppp/8/8/8/8/5PPP/R5K1 b - - 0 1';

function candidate(id: string, rating: number, themes: string, extra: Partial<StarterCandidate> = {}): StarterCandidate {
  const mate = themes.split(' ').includes('mate');
  return { id, fen: MATE_FEN, moves: mate ? 'b7b6 a1a8' : 'b7b6 a1a7', rating, themes, popularity: 90, nbPlays: 1000, ...extra };
}

describe('pickStarter', () => {
  it('spreads each quota over rating bands, best quality first, without duplicates', () => {
    const candidates: StarterCandidate[] = [];
    for (let band = 400; band < 1000; band += 100) {
      for (let i = 0; i < 5; i++) {
        candidates.push(candidate(`m${band}x${i}`, band + i, 'mate mateIn1 oneMove', { popularity: 90 + i }));
      }
    }
    const picked = pickStarter(candidates, [{ theme: 'mateIn1', count: 12 }]);
    expect(picked).toHaveLength(12);
    expect(new Set(picked.map((p) => p.id)).size).toBe(12);
    // 6 bands × 2 rounds → exactly two per band, and the most popular (i = 4, 3) first
    for (let band = 400; band < 1000; band += 100) {
      const ids = picked.filter((p) => Math.floor(p.rating / 100) * 100 === band).map((p) => p.id).sort();
      expect(ids).toEqual([`m${band}x3`, `m${band}x4`]);
    }
    // sorted by rating, raw-row shape only
    expect(picked.map((p) => p.rating)).toEqual([...picked.map((p) => p.rating)].sort((a, b) => a - b));
    expect(Object.keys(picked[0] ?? {}).sort()).toEqual(['fen', 'id', 'moves', 'rating', 'themes']);
  });

  it('respects rating range, line length, avoidMate and skips invalid rows', () => {
    const candidates = [
      candidate('low', 350, 'mate mateIn1'),
      candidate('high', 1401, 'mate mateIn1'),
      candidate('long', 800, 'fork', { moves: 'b7b6 a1a7 b6b5 a7a8 g8h7 a8a7 h7g8 a7a8' }),
      candidate('illegal', 800, 'fork', { moves: 'b7b6 a1h8' }),
      candidate('notmate', 800, 'mate mateIn1', { moves: 'b7b6 a1a7' }),
      candidate('matefork', 800, 'fork mate mateIn1'),
      candidate('okfork', 800, 'fork endgame'),
    ];
    expect(pickStarter(candidates, [{ theme: 'fork', count: 5, avoidMate: true }]).map((p) => p.id)).toEqual(['okfork']);
    expect(pickStarter(candidates, [{ theme: 'mateIn1', count: 5 }]).map((p) => p.id)).toEqual(['matefork']);
  });

  it('gives up gracefully when a theme runs dry', () => {
    expect(pickStarter([candidate('only', 700, 'pin')], [{ theme: 'pin', count: 10 }])).toHaveLength(1);
    expect(pickStarter([], STARTER_QUOTAS)).toEqual([]);
  });

  it('serialises one puzzle per line as valid JSON', () => {
    const puzzles = pickStarter([candidate('a1b2c', 700, 'pin'), candidate('d3e4f', 600, 'pin')], [{ theme: 'pin', count: 2 }]);
    const json = serializeStarter(puzzles);
    expect(json.split('\n')).toHaveLength(5);
    expect(JSON.parse(json)).toEqual(puzzles);
  });
});

describe('kb/puzzles-starter.json (bundled file)', () => {
  const puzzles = JSON.parse(readFileSync(repoPath('kb', 'puzzles-starter.json'), 'utf8')) as StarterPuzzle[];

  it('has about 400 unique raw rows in the 400–1400 range', () => {
    expect(puzzles.length).toBeGreaterThanOrEqual(350);
    expect(puzzles.length).toBeLessThanOrEqual(450);
    expect(new Set(puzzles.map((p) => p.id)).size).toBe(puzzles.length);
    for (const p of puzzles) {
      expect(Object.keys(p).sort()).toEqual(['fen', 'id', 'moves', 'rating', 'themes']);
      expect(typeof p.id).toBe('string');
      expect(typeof p.fen).toBe('string');
      expect(typeof p.moves).toBe('string');
      expect(typeof p.themes).toBe('string');
      expect(Number.isInteger(p.rating)).toBe(true);
      expect(p.rating).toBeGreaterThanOrEqual(STARTER_OPTIONS.minRating);
      expect(p.rating).toBeLessThanOrEqual(STARTER_OPTIONS.maxRating);
    }
  });

  it('every solution is legal and every mate theme ends in checkmate', () => {
    for (const p of puzzles) expect(validatePuzzleRow(p), p.id).toEqual([]);
  });

  it('keeps Lichess semantics: FEN is before the opponent move, the solver moves second and last', () => {
    for (const p of puzzles) {
      const moves = p.moves.split(' ');
      expect(moves.length % 2, p.id).toBe(0);
      expect(moves.length, p.id).toBeLessThanOrEqual(STARTER_OPTIONS.maxPlies);
      const chess = new Chess(p.fen);
      const opponent = chess.turn();
      for (const uci of moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      // after an even number of plies it is the opponent's turn again → the solver made the last move
      expect(chess.turn(), p.id).toBe(opponent);
      if (p.themes.split(' ').some(isMateTheme)) expect(chess.isCheckmate(), p.id).toBe(true);
    }
  });

  it('covers the early-curriculum themes and every rating band', () => {
    const counts = themeCounts(puzzles);
    const minimum: Record<string, number> = {
      mateIn1: 50, mateIn2: 40, fork: 40, pin: 30, hangingPiece: 30, skewer: 20, discoveredAttack: 20, backRankMate: 25, endgame: 60,
    };
    for (const [theme, min] of Object.entries(minimum)) expect(counts[theme] ?? 0, theme).toBeGreaterThanOrEqual(min);
    for (let band = 400; band < 1400; band += 100) {
      const n = puzzles.filter((p) => p.rating >= band && p.rating < band + 100).length;
      expect(n, `band ${band}`).toBeGreaterThanOrEqual(15);
    }
  });
});
