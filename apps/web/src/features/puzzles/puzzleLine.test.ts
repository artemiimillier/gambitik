import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { Puzzle } from '@gambit/shared';
import {
  applyUci,
  checkPuzzleMove,
  expectedMove,
  isPlayablePuzzle,
  parseUci,
  placementBeforeLastMove,
  puzzlePositionAt,
  remainingLine,
  sameMove,
  sideToMove,
  toUci,
} from './puzzleLine.ts';

/** Real Lichess puzzles from kb/puzzles-starter.json, already converted to the Puzzle contract. */
const BACK_RANK: Puzzle = {
  id: '0URgB',
  fen: '3r3k/pq4pp/4r3/3R4/2p1p3/8/P1P2PPP/3R2K1 w - - 0 31',
  lastMoveUci: 'f6e6',
  solutionUci: ['d5d8', 'e6e8', 'd8e8'],
  rating: 438,
  themes: ['backRankMate', 'endgame', 'mate', 'mateIn2', 'short'],
};

const FORK_BLACK: Puzzle = {
  id: 'mRP8m',
  fen: '6k1/5p1p/8/p1Pn2p1/2B5/P5P1/7P/5K2 b - - 2 35',
  lastMoveUci: 'd3c4',
  solutionUci: ['d5e3', 'f1e2', 'e3c4'],
  rating: 486,
  themes: ['crushing', 'endgame', 'fork', 'short'],
};

const PROMOTION: Puzzle = {
  id: 'jNjSQ',
  fen: '8/8/7P/5p2/K3p3/5k2/8/8 w - - 1 44',
  lastMoveUci: 'e3f3',
  solutionUci: ['h6h7', 'e4e3', 'h7h8q'],
  rating: 453,
  themes: ['advancedPawn', 'crushing', 'endgame', 'pawnEndgame', 'promotion', 'short'],
};

/** Hand-made: both rooks mate on the back rank; the stored line uses the a-rook. */
const TWO_MATES: Puzzle = {
  id: 'two-mates',
  fen: '6k1/5ppp/8/8/8/8/5PPP/R3R1K1 w - - 0 1',
  lastMoveUci: 'g7g8',
  solutionUci: ['a1a8'],
  rating: 400,
  themes: ['mateIn1', 'backRankMate'],
};

describe('parseUci / toUci', () => {
  it('parses plain and promotion moves', () => {
    expect(parseUci('e2e4')).toEqual({ from: 'e2', to: 'e4' });
    expect(parseUci('H7H8Q')).toEqual({ from: 'h7', to: 'h8', promotion: 'q' });
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'e2', 'e2e9', 'i1a1', 'e7e8k', 'e2e4 ; go', '<script>']) expect(parseUci(bad)).toBeNull();
  });

  it('round-trips', () => {
    expect(toUci('e7', 'e8', 'n')).toBe('e7e8n');
    expect(toUci('g1', 'f3')).toBe('g1f3');
  });
});

describe('applyUci', () => {
  it('reports an en-passant capture as a capture (chess.js isCapture() alone says no)', () => {
    const move = applyUci('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', 'e5f6');
    expect(move?.san).toBe('exf6');
    expect(move?.isCapture).toBe(true);
  });

  it('applies a legal move and reports its flags', () => {
    const move = applyUci(BACK_RANK.fen, 'd5d8');
    expect(move).not.toBeNull();
    expect(move?.san).toBe('Rxd8+');
    expect(move?.isCapture).toBe(true);
    expect(move?.isCheck).toBe(true);
    expect(move?.isMate).toBe(false);
    expect(move?.fenBefore).toBe(BACK_RANK.fen);
  });

  it('returns null for illegal moves and broken FENs — never throws', () => {
    expect(applyUci(BACK_RANK.fen, 'd5d7x')).toBeNull();
    expect(applyUci(BACK_RANK.fen, 'g1g3')).toBeNull();
    expect(applyUci('not a fen', 'e2e4')).toBeNull();
  });

  it('understands castling written as king-takes-rook', () => {
    const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    expect(applyUci(fen, 'e1h1')?.uci).toBe('e1g1');
    expect(applyUci(fen, 'e1a1')?.san).toBe('O-O-O');
    expect(sameMove(fen, 'e1h1', 'e1g1')).toBe(true);
    expect(sameMove(fen, 'e1h1', 'e1c1')).toBe(false);
  });
});

describe('puzzlePositionAt', () => {
  it('replays the stored line', () => {
    expect(puzzlePositionAt(BACK_RANK, 0)).toBe(BACK_RANK.fen);
    const afterTwo = puzzlePositionAt(BACK_RANK, 2);
    expect(afterTwo).not.toBeNull();
    expect(sideToMove(afterTwo ?? '')).toBe('w');
    const end = puzzlePositionAt(BACK_RANK, 3);
    expect(new Chess(end ?? undefined).isCheckmate()).toBe(true);
  });

  it('returns null for a broken line and flags the puzzle as unplayable', () => {
    const broken: Puzzle = { ...BACK_RANK, solutionUci: ['d5d8', 'a1a2'] };
    expect(puzzlePositionAt(broken, 2)).toBeNull();
    expect(isPlayablePuzzle(broken)).toBe(false);
    expect(isPlayablePuzzle({ ...BACK_RANK, solutionUci: [] })).toBe(false);
    expect(isPlayablePuzzle({ ...BACK_RANK, fen: 'garbage' })).toBe(false);
    for (const puzzle of [BACK_RANK, FORK_BLACK, PROMOTION, TWO_MATES]) expect(isPlayablePuzzle(puzzle)).toBe(true);
  });
});

describe('checkPuzzleMove', () => {
  it('accepts the solution move and returns the scripted reply', () => {
    const verdict = checkPuzzleMove(BACK_RANK, 0, 'd5d8');
    expect(verdict.kind).toBe('correct');
    if (verdict.kind !== 'correct') return;
    expect(verdict.alternateMate).toBe(false);
    expect(verdict.done).toBe(false);
    expect(verdict.nextIndex).toBe(2);
    expect(verdict.reply?.uci).toBe('e6e8');
    expect(verdict.reply?.fenBefore).toBe(verdict.played.fenAfter);
  });

  it('finishes the line on the last move', () => {
    const verdict = checkPuzzleMove(BACK_RANK, 2, 'd8e8');
    expect(verdict.kind).toBe('correct');
    if (verdict.kind !== 'correct') return;
    expect(verdict.done).toBe(true);
    expect(verdict.reply).toBeNull();
    expect(verdict.played.isMate).toBe(true);
  });

  it('works with Black to move', () => {
    const first = checkPuzzleMove(FORK_BLACK, 0, 'd5e3');
    expect(first.kind).toBe('correct');
    if (first.kind !== 'correct') return;
    expect(first.played.san).toBe('Ne3+');
    expect(first.reply?.uci).toBe('f1e2');
    const second = checkPuzzleMove(FORK_BLACK, 2, 'e3c4');
    expect(second.kind === 'correct' && second.done).toBe(true);
  });

  it('calls a legal non-solution move "wrong" and tells what was expected', () => {
    const verdict = checkPuzzleMove(BACK_RANK, 0, 'g1f1');
    expect(verdict.kind).toBe('wrong');
    if (verdict.kind !== 'wrong') return;
    expect(verdict.expectedUci).toBe('d5d8');
    expect(verdict.played.san).toBe('Kf1');
  });

  it('calls an impossible move "illegal"', () => {
    expect(checkPuzzleMove(BACK_RANK, 0, 'g1g5').kind).toBe('illegal');
    expect(checkPuzzleMove(BACK_RANK, 0, 'zz').kind).toBe('illegal');
    // odd indexes are the opponent's moves, index past the end has no expected move
    expect(checkPuzzleMove(BACK_RANK, 1, 'e6e8').kind).toBe('illegal');
    expect(checkPuzzleMove(BACK_RANK, 4, 'd8e8').kind).toBe('illegal');
  });

  it('accepts ANY checkmating move, not only the stored one', () => {
    const stored = checkPuzzleMove(TWO_MATES, 0, 'a1a8');
    expect(stored.kind === 'correct' && !stored.alternateMate && stored.done).toBe(true);
    const other = checkPuzzleMove(TWO_MATES, 0, 'e1e8');
    expect(other.kind).toBe('correct');
    if (other.kind !== 'correct') return;
    expect(other.alternateMate).toBe(true);
    expect(other.done).toBe(true);
    expect(other.reply).toBeNull();
  });

  it('does not accept a mere check as an alternate solution', () => {
    // Re7 is legal and quiet, Rd1-d7 too: neither mates
    expect(checkPuzzleMove(TWO_MATES, 0, 'e1e7').kind).toBe('wrong');
  });

  it('requires the right promotion piece', () => {
    expect(checkPuzzleMove(PROMOTION, 2, 'h7h8q').kind).toBe('correct');
    expect(checkPuzzleMove(PROMOTION, 2, 'h7h8n').kind).toBe('wrong');
    // a promotion without a piece letter is not a legal UCI move here
    expect(checkPuzzleMove(PROMOTION, 2, 'h7h8').kind).toBe('illegal');
  });
});

describe('expectedMove / remainingLine', () => {
  it('describes the move a hint should point at', () => {
    const move = expectedMove(FORK_BLACK, 0);
    expect(move?.from).toBe('d5');
    expect(move?.to).toBe('e3');
    expect(move?.piece).toBe('n');
    expect(expectedMove(FORK_BLACK, 9)).toBeNull();
  });

  it('lists the rest of the line for the solution replay', () => {
    expect(remainingLine(BACK_RANK, 0).map((m) => m.san)).toEqual(['Rxd8+', 'Re8', 'Rxe8#']);
    expect(remainingLine(BACK_RANK, 2).map((m) => m.uci)).toEqual(['d8e8']);
    expect(remainingLine(BACK_RANK, 3)).toEqual([]);
  });
});

describe('placementBeforeLastMove', () => {
  it('moves the piece back to where it came from', () => {
    // f6e6: the black rook now on e6 came from f6
    expect(placementBeforeLastMove(BACK_RANK.fen, BACK_RANK.lastMoveUci)).toBe('3r3k/pq4pp/5r2/3R4/2p1p3/8/P1P2PPP/3R2K1');
  });

  it('turns a promoted piece back into a pawn', () => {
    expect(placementBeforeLastMove('4Q3/8/8/8/8/8/8/K6k b - - 0 1', 'e7e8q')).toBe('8/4P3/8/8/8/8/8/K6k');
  });

  it('puts the rook back into the corner after castling', () => {
    expect(placementBeforeLastMove('r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1', 'e1g1')).toBe('r3k2r/8/8/8/8/8/8/R3K2R');
    expect(placementBeforeLastMove('2kr3r/8/8/8/8/8/8/R3K2R w KQ - 1 2', 'e8c8')).toBe('r3k2r/8/8/8/8/8/8/R3K2R');
  });

  it('falls back to the given placement when the move does not fit the position', () => {
    const placement = BACK_RANK.fen.split(' ')[0];
    expect(placementBeforeLastMove(BACK_RANK.fen, 'a3a4')).toBe(placement);
    expect(placementBeforeLastMove(BACK_RANK.fen, 'nonsense')).toBe(placement);
    // the start square is occupied → cannot be the previous position
    expect(placementBeforeLastMove(BACK_RANK.fen, 'd8e6')).toBe(placement);
  });

  it('always yields a placement react-chessboard can read (8 ranks of 8 files)', () => {
    for (const puzzle of [BACK_RANK, FORK_BLACK, PROMOTION]) {
      const rows = placementBeforeLastMove(puzzle.fen, puzzle.lastMoveUci).split('/');
      expect(rows).toHaveLength(8);
      for (const row of rows) {
        const width = [...row].reduce((sum, ch) => sum + (/\d/.test(ch) ? Number(ch) : 1), 0);
        expect(width).toBe(8);
      }
    }
  });
});
