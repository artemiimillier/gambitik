/**
 * Last-resort puzzle set: 25 mate-in-1 positions, used only when neither data/build/puzzles.sqlite
 * nor kb/puzzles-starter.json exists. Same semantics as a raw Lichess row: `fen` is the position
 * BEFORE the opponent's move, `moves[0]` is that move, the rest is the solution.
 * Generated and verified with chess.js (see builtinPuzzles.test.ts, which re-verifies every row).
 */
import type { RawPuzzleRow } from './puzzles.ts';

const ROWS: readonly [fen: string, moves: string, rating: number, extraThemes: string][] = [
  ['7k/5ppp/8/8/8/8/8/R5K1 b - - 0 29', 'h8g8 a1a8', 400, 'backRankMate'],
  ['7k/5ppp/8/8/8/8/5PPP/3R2K1 b - - 0 29', 'h8g8 d1d8', 420, 'backRankMate'],
  ['6k1/6pp/8/8/8/8/6PP/4Q1K1 b - - 0 29', 'g8h8 e1e8', 440, 'backRankMate'],
  ['1k6/8/1K6/8/8/8/8/7R b - - 0 49', 'b8a8 h1h8', 480, 'rookEndgame'],
  ['6k1/8/6K1/8/8/8/8/R7 b - - 0 49', 'g8h8 a1a8', 480, 'rookEndgame'],
  ['8/5K1k/8/8/8/8/8/6Q1 b - - 0 49', 'h7h8 g1g7', 500, 'queenEndgame'],
  ['1k6/7R/6R1/8/8/8/8/6K1 b - - 0 49', 'b8a8 g6g8', 460, 'rookEndgame'],
  ['3r2k1/8/8/8/8/8/5PPP/7K w - - 0 30', 'h1g1 d8d1', 420, 'backRankMate'],
  ['4q1k1/8/8/8/8/8/6PP/6K1 w - - 0 30', 'g1h1 e8e1', 440, 'backRankMate'],
  ['8/8/8/8/8/1qk5/8/1K6 w - - 0 50', 'b1a1 b3b2', 520, 'queenEndgame'],
  ['r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3', 'g8f6 h5f7', 600, 'opening attackingF2F7'],
  ['rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2', 'g2g4 d8h4', 560, 'opening'],
  ['7k/5ppp/8/8/8/8/5PPP/4Q1K1 b - - 0 29', 'h8g8 e1e8', 430, 'backRankMate'],
  ['5r1k/6pp/8/6N1/8/8/8/6K1 b - - 0 29', 'f8g8 g5f7', 720, 'smotheredMate'],
  ['7k/5p1p/5Qp1/8/8/8/1B6/6K1 b - - 0 29', 'h8g8 f6g7', 640, 'kingsideAttack'],
  ['6k1/R7/5N2/8/8/8/8/6K1 b - - 0 39', 'g8h8 a7h7', 760, 'arabianMate'],
  ['7k/3P1ppp/8/8/8/8/8/6K1 b - - 0 39', 'h8g8 d7d8q', 620, 'promotion backRankMate'],
  ['6k1/8/8/8/8/r7/1r6/7K w - - 0 50', 'h1g1 a3a1', 460, 'rookEndgame'],
  ['6k1/8/8/8/4n3/8/6PP/5R1K w - - 0 30', 'f1g1 e4f2', 720, 'smotheredMate'],
  ['6k1/8/8/8/8/8/3p1PPP/7K w - - 0 40', 'h1g1 d2d1q', 620, 'promotion backRankMate'],
  ['5r1k/5ppp/8/8/8/3B4/7Q/6K1 b - - 0 24', 'h8g8 h2h7', 680, 'kingsideAttack'],
  ['rnb1k1nr/pppp1ppp/8/2b1p3/4P2q/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3', 'b1c3 h4f2', 620, 'opening attackingF2F7'],
  ['4k3/8/3K4/8/8/8/8/7R b - - 0 49', 'e8d8 h1h8', 500, 'rookEndgame'],
  ['8/k1K5/8/8/8/8/8/1Q6 b - - 0 49', 'a7a8 b1b7', 540, 'queenEndgame'],
  ['8/8/8/8/8/6k1/r7/6K1 w - - 0 50', 'g1h1 a2a1', 500, 'rookEndgame'],
];

export const BUILTIN_PUZZLE_ROWS: RawPuzzleRow[] = ROWS.map(([fen, moves, rating, extraThemes], index) => ({
  id: `gb${String(index + 1).padStart(3, '0')}`,
  fen,
  moves,
  rating,
  themes: `mateIn1 oneMove ${extraThemes}`,
}));
