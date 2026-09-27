import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { applyUci, isCaptureMove, materialSwing, uciToSan } from './pv.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('uciToSan', () => {
  it('converts a line including castling, captures, checks and promotions', () => {
    expect(uciToSan(START, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1g1'])).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O']);
    expect(uciToSan('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', ['h5f7'])).toEqual(['Qxf7#']);
    expect(uciToSan('3r2k1/4P3/8/8/8/8/8/4K3 w - - 0 1', ['e7d8q'])).toEqual(['exd8=Q+']);
    expect(uciToSan('3r2k1/4P3/8/8/8/8/8/4K3 w - - 0 1', ['E7E8N'])).toEqual(['e8=N']);
  });

  it('stops at the first illegal or malformed move', () => {
    expect(uciToSan(START, ['e2e4', 'e2e4', 'g1f3'])).toEqual(['e4']);
    expect(uciToSan(START, ['(none)'])).toEqual([]);
    expect(uciToSan(START, [])).toEqual([]);
    expect(() => uciToSan('bad fen', ['e2e4'])).toThrow();
  });

  it('applyUci leaves the position untouched on failure', () => {
    const chess = new Chess();
    expect(applyUci(chess, 'e2e5')).toBeNull();
    expect(applyUci(chess, 'e7e8')).toBeNull();
    expect(chess.fen()).toBe(START);
    expect(applyUci(chess, 'e2e4')?.san).toBe('e4');
  });
});

describe('materialSwing (pawns won by the side to move = lost by the other side)', () => {
  it('is 0 for quiet lines and empty PVs', () => {
    expect(materialSwing(START, ['e2e4', 'e7e5', 'g1f3', 'b8c6'])).toBe(0);
    expect(materialSwing(START, [])).toBe(0);
  });

  it('counts a piece that is simply taken', () => {
    // Black to move takes the queen on g5 for free.
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p1Q1/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 3 3';
    expect(materialSwing(fen, ['d8g5', 'g1f3', 'g5g6'])).toBe(9);
  });

  it('nets out recaptures', () => {
    // Pawn takes knight, pawn takes back: +3 −1.
    expect(materialSwing('4k3/8/4p3/3n4/4P3/8/8/4K3 w - - 0 1', ['e4d5', 'e6d5'])).toBe(2);
    // Even queen trade.
    expect(materialSwing('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', ['d1d8', 'e8d8'])).toBe(0);
  });

  it('is negative when the side to move comes out behind', () => {
    // Queen takes a defended pawn and is recaptured.
    expect(materialSwing('4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 1', ['d1d5', 'e6d5'])).toBe(-8);
  });

  it('settles a PV that is cut right after a capture by static exchange evaluation', () => {
    // "QxQ" alone is not a won queen: the king recaptures.
    expect(materialSwing('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', ['d1d8'])).toBe(0);
    // … but a really loose piece stays won.
    expect(materialSwing('4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1', ['g2d5'])).toBe(3);
  });

  it('does not cut an exchange in the middle when the ply limit is reached', () => {
    // 4 plies end after Bxf6; the PV continues with the recapture gxf6, which must be included.
    const fen = '6k1/6pp/5n2/6B1/8/8/6PP/6K1 w - - 0 1';
    const pv = ['h2h3', 'h7h6', 'g1h2', 'g8h8', 'g5f6', 'g7f6', 'h2g3'];
    expect(materialSwing(fen, pv, 5)).toBe(0);
    // within the first 4 plies nothing was taken at all
    expect(materialSwing(fen, pv, 4)).toBe(0);
    expect(materialSwing(fen, pv, 2)).toBe(0);
  });

  it('stops following the PV after `plies` when no exchange is running', () => {
    // The knight is only taken on ply 5: outside the default window.
    const fen = '4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1';
    const pv = ['e1e2', 'e8e7', 'e2e1', 'e7e8', 'g2d5'];
    expect(materialSwing(fen, pv)).toBe(3); // ply 5 is a capture that directly follows the window → exchange is followed
    expect(materialSwing(fen, [...pv.slice(0, 4), 'e1d1', 'e8d8', 'g2d5'])).toBe(0);
  });

  it('counts promotions as material', () => {
    expect(materialSwing('8/4P1k1/8/8/8/8/8/4K3 w - - 0 1', ['e7e8q'])).toBe(8);
  });

  it('throws on an invalid FEN', () => {
    expect(() => materialSwing('bad', ['e2e4'])).toThrow();
  });

  it('treats en passant as a capture: a truncated "exf6" line settles the pending recapture', () => {
    // chess.js 1.4: Move.isCapture() is false for en passant.
    const fen = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
    expect(materialSwing(fen, ['e5f6'])).toBe(0); // …Nxf6 / …exf6 takes back
    expect(materialSwing(fen, ['e5f6', 'g8f6'])).toBe(0);
  });
});

describe('isCaptureMove', () => {
  it('is true for ordinary captures and en passant, false for quiet moves', () => {
    const chess = new Chess('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
    const ep = chess.move({ from: 'e5', to: 'f6' });
    expect(ep.isCapture()).toBe(false);
    expect(isCaptureMove(ep)).toBe(true);
    expect(isCaptureMove(chess.move({ from: 'g8', to: 'f6' }))).toBe(true);
    expect(isCaptureMove(chess.move({ from: 'd2', to: 'd4' }))).toBe(false);
  });
});
