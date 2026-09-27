import { describe, expect, it } from 'vitest';
import { findHanging } from './hanging.ts';

describe('findHanging', () => {
  it('finds nothing in the starting position', () => {
    expect(findHanging('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toEqual([]);
  });

  it('reports an attacked, undefended piece with attackers, defenders and SEE loss', () => {
    // After 1.e4 e5 2.Qh5 Nc6 3.Qg5?? the white queen can be taken by the black queen.
    const hanging = findHanging('r1bqkbnr/pppp1ppp/2n5/4p1Q1/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 3 3');
    expect(hanging[0]).toEqual({ square: 'g5', piece: 'q', color: 'w', attackers: ['d8'], defenders: [], seeLossCp: 900 });
  });

  it('covers both colours and sorts by expected loss', () => {
    // White rook a1 is attacked by the bishop g7 (loose), black knight d5 is attacked by the pawn e4 (defended by e6).
    const hanging = findHanging('4k3/6b1/4p3/3n4/4P3/8/8/R3K3 w - - 0 1');
    expect(hanging.map((h) => [h.square, h.color, h.seeLossCp])).toEqual([
      ['a1', 'w', 500],
      ['d5', 'b', 200],
    ]);
    expect(hanging[1]?.defenders).toEqual(['e6']);
  });

  it('does not report a sufficiently defended piece', () => {
    // Knight d5 attacked by a rook, defended by a pawn: RxN exd5 loses the exchange.
    expect(findHanging('4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1').filter((h) => h.square === 'd5')).toEqual([]);
  });

  it('reports a defended piece that is attacked by something cheaper', () => {
    const hanging = findHanging('4k3/8/4p3/3q4/4P3/8/8/4K3 w - - 0 1');
    expect(hanging).toEqual([
      { square: 'd5', piece: 'q', color: 'b', attackers: ['e4'], defenders: ['e6'], seeLossCp: 800 },
      // … and the undefended pawn is itself attacked by the queen
      { square: 'e4', piece: 'p', color: 'w', attackers: ['d5'], defenders: [], seeLossCp: 100 },
    ]);
  });

  it('includes hanging pawns (e5 after 1.e4 e5 2.Nf3) but never kings', () => {
    const hanging = findHanging('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
    expect(hanging).toEqual([{ square: 'e5', piece: 'p', color: 'b', attackers: ['f3'], defenders: [], seeLossCp: 100 }]);
    expect(findHanging('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1').some((h) => h.piece === 'k')).toBe(false);
  });

  it('ignores a pinned "defender"', () => {
    const hanging = findHanging('4k3/4n3/2b5/8/8/8/4R1B1/4K3 w - - 0 1');
    const bishop = hanging.find((h) => h.square === 'c6');
    expect(bishop?.seeLossCp).toBe(300);
    expect(bishop?.defenders).toEqual([]);
  });

  it('requires a legal first capture for the side to move (it may be in check)', () => {
    // White is in check from the rook e8; the loose black knight a5 cannot be taken by Ra1 right now.
    const fen = '4r1k1/8/8/n7/8/8/8/R3K3 w - - 0 1';
    expect(findHanging(fen).filter((h) => h.square === 'a5')).toEqual([]);
    // Without the check the same knight is reported.
    expect(findHanging('6k1/8/8/n7/8/8/8/R3K3 w - - 0 1').map((h) => h.square)).toEqual(['a5']);
  });

  it('throws on an invalid FEN', () => {
    expect(() => findHanging('nonsense')).toThrow();
  });
});
