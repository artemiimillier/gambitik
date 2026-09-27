import { describe, expect, it } from 'vitest';
import {
  absolutePins,
  attackersOf,
  attacksFrom,
  captureCandidates,
  materialOf,
  parsePlacement,
  seeCapture,
  seeExchange,
  seeLoss,
  squareIndex,
  squareName,
} from './board.ts';

const sq = squareIndex;
const names = (xs: number[]): string[] => xs.map(squareName).sort();

describe('board geometry', () => {
  it('maps squares both ways', () => {
    expect(sq('a1')).toBe(0);
    expect(sq('h1')).toBe(7);
    expect(sq('a8')).toBe(56);
    expect(sq('h8')).toBe(63);
    expect(squareName(sq('e4'))).toBe('e4');
    expect(sq('i9')).toBe(-1);
    expect(sq('e')).toBe(-1);
  });

  it('parses a FEN placement and rejects garbage', () => {
    const board = parsePlacement('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(board[sq('e1')]).toEqual({ type: 'k', color: 'w' });
    expect(board[sq('d8')]).toEqual({ type: 'q', color: 'b' });
    expect(board[sq('e4')]).toBeNull();
    expect(materialOf(board, 'w')).toBe(39);
    expect(() => parsePlacement('8/8/8 w - - 0 1')).toThrow();
    expect(() => parsePlacement('9/8/8/8/8/8/8/8 w - - 0 1')).toThrow();
  });

  it('generates attacks for every piece type', () => {
    const board = parsePlacement('4k3/8/8/3p4/4P3/2N5/8/R3K2B w - - 0 1');
    expect(names(attacksFrom(board, sq('e4')))).toEqual(['d5', 'f5']);
    expect(names(attacksFrom(board, sq('d5')))).toEqual(['c4', 'e4']);
    expect(names(attacksFrom(board, sq('c3')))).toEqual(['a2', 'a4', 'b1', 'b5', 'd1', 'd5', 'e2', 'e4']);
    expect(names(attacksFrom(board, sq('a1')))).toEqual(['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'b1', 'c1', 'd1', 'e1']);
    expect(names(attacksFrom(board, sq('h1')))).toEqual(['e4', 'f3', 'g2']); // stops at its own pawn
    expect(names(attackersOf(board, sq('d5'), 'w'))).toEqual(['c3', 'e4']);
    expect(names(attackersOf(board, sq('e4'), 'b'))).toEqual(['d5']);
  });

  it('finds absolute pins and removes pinned pieces from the capture candidates', () => {
    // Black knight e7 is pinned by the rook e2; it "attacks" c6 geometrically but cannot recapture there.
    const board = parsePlacement('4k3/4n3/2b5/8/8/8/4R1B1/4K3 w - - 0 1');
    expect(absolutePins(board, 'b')).toEqual([{ pinned: sq('e7'), pinner: sq('e2'), king: sq('e8') }]);
    expect(names(attackersOf(board, sq('c6'), 'b'))).toEqual(['e7']);
    expect(captureCandidates(board, sq('c6'), 'b')).toEqual([]);
    // … but a pinned piece may capture along its pin line
    const onLine = parsePlacement('4k3/4r3/8/8/8/8/4R3/4K3 b - - 0 1');
    expect(names(captureCandidates(onLine, sq('e2'), 'b'))).toEqual(['e7']);
  });
});

describe('static exchange evaluation', () => {
  it('an undefended piece is lost completely', () => {
    const board = parsePlacement('4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1');
    expect(seeCapture(board, sq('g2'), sq('d5'))).toBe(300);
    expect(seeLoss(board, sq('d5'))).toBe(300);
  });

  it('a defended pawn is not worth a queen', () => {
    const board = parsePlacement('4k3/8/4p3/3p4/8/8/8/3QK3 w - - 0 1');
    expect(seeCapture(board, sq('d1'), sq('d5'))).toBe(100 - 900);
    expect(seeExchange(board, sq('d5'), 'w')).toBe(0); // the side may simply decline
    expect(seeLoss(board, sq('d5'))).toBe(0);
  });

  it('a cheaper attacker wins material even if the piece is defended', () => {
    const board = parsePlacement('4k3/8/4p3/3n4/4P3/8/8/4K3 w - - 0 1');
    expect(seeCapture(board, sq('e4'), sq('d5'))).toBe(300 - 100);
  });

  it('counts x-ray batteries on both sides', () => {
    // Rd1 + Rd2 against the d5 knight defended once by a pawn: RxN, exd5, Rxd5 → +300 -500 +100 = -100 → decline.
    const once = parsePlacement('4k3/8/4p3/3n4/8/8/3R4/3RK3 w - - 0 1');
    expect(seeLoss(once, sq('d5'))).toBe(0);
    // Two attackers against an undefended-but-x-ray-defended rook: Rd1xd5, Rd8xd5, Rd2xd5 → +500 -500 +500.
    const battery = parsePlacement('3rk3/8/8/3r4/8/8/3R4/3RK3 w - - 0 1');
    expect(seeCapture(battery, sq('d2'), sq('d5'))).toBe(500);
    // Same, but White has only one rook: the trade is even.
    const single = parsePlacement('3rk3/8/8/3r4/8/8/8/3RK3 w - - 0 1');
    expect(seeCapture(single, sq('d1'), sq('d5'))).toBe(0);
  });

  it('a king can recapture on an unprotected square, but not on a protected one', () => {
    // Rook takes a knight defended only by the king: Kxb3 is possible because the rook is unprotected.
    const loose = parsePlacement('8/8/8/8/8/kn6/8/1R2K3 w - - 0 1');
    expect(seeCapture(loose, sq('b1'), sq('b3'))).toBe(300 - 500);
    // Pawn takes the same knight with the rook behind it: Kxb3 would be illegal, the knight is simply lost.
    const covered = parsePlacement('8/8/8/8/8/kn6/2P5/1R2K3 w - - 0 1');
    expect(seeCapture(covered, sq('c2'), sq('b3'))).toBe(300);
    expect(captureCandidates(covered, sq('b3'), 'w').map(squareName).sort()).toEqual(['b1', 'c2']);
  });

  it('a pinned defender does not count', () => {
    const board = parsePlacement('4k3/4n3/2b5/8/8/8/4R1B1/4K3 w - - 0 1');
    expect(seeCapture(board, sq('g2'), sq('c6'))).toBe(300);
  });

  it('handles capture-promotions', () => {
    const board = parsePlacement('3r2k1/4P3/8/8/8/8/8/4K3 w - - 0 1');
    expect(seeCapture(board, sq('e7'), sq('d8'))).toBe(500 + 800);
  });

  it('restores the board after searching', () => {
    const fen = '3rk3/8/8/3r4/8/8/3R4/3RK3 w - - 0 1';
    const board = parsePlacement(fen);
    seeCapture(board, sq('d2'), sq('d5'));
    seeLoss(board, sq('d5'));
    expect(board).toEqual(parsePlacement(fen));
  });
});
