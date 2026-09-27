import { describe, expect, it } from 'vitest';
import { computePositionFacts } from './facts.ts';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('computePositionFacts', () => {
  it('describes the starting position', () => {
    const facts = computePositionFacts(START);
    expect(facts).toEqual({
      fen: START,
      sideToMove: 'w',
      phase: 'opening',
      inCheck: false,
      legalMoveCount: 20,
      material: { w: 39, b: 39, diff: 0 },
      hanging: [],
      development: { w: 0, b: 0 },
      castled: { w: false, b: false },
      canStillCastle: { w: true, b: true },
      centerControl: { w: 0, b: 0 },
    });
    expect('openingName' in facts).toBe(false);
  });

  it('tracks development, castling, centre and the opening name in an Italian position', () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O Nf6 5.d3
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQ1RK1 b kq - 0 5';
    const facts = computePositionFacts(fen, 'Итальянская партия');
    expect(facts.openingName).toBe('Итальянская партия');
    expect(facts.sideToMove).toBe('b');
    expect(facts.phase).toBe('opening');
    expect(facts.development).toEqual({ w: 2, b: 3 });
    expect(facts.castled).toEqual({ w: true, b: false });
    expect(facts.canStillCastle).toEqual({ w: false, b: true });
    // White: e4 occupied, d5 attacked by e4 (+ d3 covers e4 only, already counted). Black: e5 occupied, d4 attacked by e5.
    expect(facts.centerControl).toEqual({ w: 2, b: 2 });
    expect(facts.material).toEqual({ w: 39, b: 39, diff: 0 });
  });

  it('does not call a hand-walked king "castled" and honours castling rights', () => {
    // King walked e1-f1-g1 with the rook still boxed in on h1.
    expect(computePositionFacts('4k3/8/8/8/8/8/8/6KR w - - 0 20').castled.w).toBe(false);
    // Queenside castled king.
    expect(computePositionFacts('4k3/8/8/8/8/8/8/2KR4 w - - 0 20').castled.w).toBe(true);
    // Rights still present → not castled yet, even with the king at home.
    const facts = computePositionFacts('r3k2r/8/8/8/8/8/8/R3K2R w Kq - 0 20');
    expect(facts.castled).toEqual({ w: false, b: false });
    expect(facts.canStillCastle).toEqual({ w: true, b: true });
  });

  it('recognises check, material imbalance and hanging pieces', () => {
    const facts = computePositionFacts('r1bqkbnr/pppp1ppp/2n5/4p1Q1/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 3 3');
    expect(facts.inCheck).toBe(false);
    expect(facts.hanging.map((h) => h.square)).toContain('g5');
    const check = computePositionFacts('4k3/8/8/8/8/8/4r3/4K3 w - - 0 40');
    expect(check.inCheck).toBe(true);
    expect(check.material).toEqual({ w: 0, b: 5, diff: -5 });
    expect(check.phase).toBe('endgame');
  });

  it('labels phases by material and move number', () => {
    // Full material but move 25 with everything developed → middlegame.
    const middlegame = 'r2q1rk1/ppp2ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPP2PPP/R2Q1RK1 w - - 0 25';
    expect(computePositionFacts(middlegame).phase).toBe('middlegame');
    // Rook endgame.
    expect(computePositionFacts('8/5pk1/6p1/8/8/6P1/r4PK1/1R6 w - - 0 45').phase).toBe('endgame');
    // Queenless with few pieces.
    expect(computePositionFacts('2r2rk1/pp3ppp/2n5/8/8/2N5/PP3PPP/2R2RK1 w - - 0 22').phase).toBe('endgame');
  });

  it('throws on an invalid FEN', () => {
    expect(() => computePositionFacts('8/8/8 w')).toThrow();
  });
});
