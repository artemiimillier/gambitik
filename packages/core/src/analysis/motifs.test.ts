import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { MotifId } from '@gambit/shared';
import { describeMotif, detectMotif } from './motifs.ts';

interface Fixture {
  name: string;
  fen: string;
  pv: string[];
  motif: MotifId | undefined;
}

const FIXTURES: Fixture[] = [
  // ── forks ──
  { name: 'knight fork: king + rook', fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', pv: ['d5c7', 'e8d7', 'c7a8'], motif: 'fork' },
  { name: 'pawn fork: knight + bishop', fen: '4k3/8/3n1b2/8/3PP3/8/8/4K3 w - - 0 1', pv: ['e4e5', 'f6e7', 'e5d6', 'e7d6'], motif: 'fork' },
  { name: 'queen fork: check + loose rook', fen: '4k3/8/8/8/8/6Q1/1r6/4K3 w - - 0 1', pv: ['g3e5', 'e8d7', 'e5b2'], motif: 'fork' },
  {
    name: 'black knight fork after a forcing check (fork on the second move)',
    fen: '1r4k1/8/8/8/4n3/8/6K1/3Q4 b - - 0 1',
    pv: ['b8b2', 'g2h1', 'e4f2', 'h1g1', 'f2d1'],
    motif: 'fork',
  },
  // ── pins ──
  {
    name: 'pin: pawn attacks the knight pinned to the king',
    fen: '4k3/1p3ppp/2n5/1B6/3P4/8/5PPP/6K1 w - - 0 1',
    pv: ['d4d5', 'g7g6', 'd5c6', 'b7c6', 'b5c6'],
    motif: 'pin',
  },
  { name: 'pin: rook pins the queen to the king', fen: '4k3/8/8/4q3/8/8/8/R4K2 w - - 0 1', pv: ['a1e1', 'e5e1', 'f1e1'], motif: 'pin' },
  // ── skewers ──
  { name: 'skewer: rook checks, queen behind the king falls', fen: '3q4/8/8/3k4/8/8/8/R3K3 w - - 0 1', pv: ['a1d1', 'd5e6', 'd1d8'], motif: 'skewer' },
  { name: 'skewer: bishop hits the queen, rook behind falls', fen: 'r3k3/8/8/3q4/8/8/8/5BK1 w - - 0 1', pv: ['f1g2', 'd5d7', 'g2a8'], motif: 'skewer' },
  // ── mates ──
  { name: 'back-rank mate in one', fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', pv: ['a1a8'], motif: 'backRankMate' },
  { name: 'back-rank mate in two', fen: 'r5k1/5ppp/8/8/8/8/4R3/4R1K1 w - - 0 1', pv: ['e2e8', 'a8e8', 'e1e8'], motif: 'backRankMate' },
  {
    name: "scholar's mate (mate in one, not a back-rank pattern)",
    fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
    pv: ['h5f7'],
    motif: 'mateIn1',
  },
  { name: 'rook ladder: mate in two', fen: '7k/8/R7/1R6/8/8/8/6K1 w - - 0 1', pv: ['a6a7', 'h8g8', 'b5b8'], motif: 'mateIn2' },
  {
    name: 'mate in three',
    fen: '7k/8/8/R7/1R6/8/8/6K1 w - - 0 1',
    pv: ['a5a7', 'h8g8', 'b4b6', 'g8f8', 'b6b8'],
    motif: 'mateIn3',
  },
  // ── captures ──
  { name: 'free capture: undefended knight', fen: '4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1', pv: ['g2d5'], motif: 'freeCapture' },
  { name: 'hanging piece: pawn takes a defended knight', fen: '4k3/8/4p3/3n4/4P3/8/8/4K3 w - - 0 1', pv: ['e4d5', 'e6d5'], motif: 'hangingPiece' },
  {
    name: 'capture of a piece whose only defender is pinned',
    fen: '4k3/4n3/2b5/8/8/8/4R1B1/4K3 w - - 0 1',
    pv: ['g2c6'],
    motif: 'pin',
  },
  // ── discovered attack / double check ──
  { name: 'discovered attack on the queen', fen: '6k1/4q1pp/8/8/4N3/8/8/4R1K1 w - - 0 1', pv: ['e4f6', 'g7f6', 'e1e7'], motif: 'discoveredAttack' },
  { name: 'double check', fen: '4k3/8/8/8/4N3/8/8/4R1K1 w - - 0 1', pv: ['e4f6'], motif: 'doubleCheck' },
  // ── remove the defender / trapped piece / promotion ──
  { name: 'removing the defender', fen: '6k1/6pp/5n2/3r2B1/8/8/8/3RK3 w - - 0 1', pv: ['g5f6', 'g7f6', 'd1d5'], motif: 'removeDefender' },
  { name: "trapped bishop (Noah's ark)", fen: '6k1/8/8/1pp5/8/1B6/P1P5/4K3 b - - 0 1', pv: ['c5c4', 'b3c4', 'b5c4'], motif: 'trappedPiece' },
  { name: 'promotion', fen: '8/4P1k1/8/8/8/8/8/4K3 w - - 0 1', pv: ['e7e8q'], motif: 'promotion' },
  { name: 'promotion two moves away', fen: '8/8/4P3/8/8/6k1/8/4K3 w - - 0 1', pv: ['e6e7', 'g3f3', 'e7e8q'], motif: 'promotion' },
  // ── nothing to see ──
  { name: 'quiet opening moves', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', pv: ['e2e4', 'e7e5', 'g1f3'], motif: undefined },
  { name: 'even queen trade', fen: '3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', pv: ['d1d8', 'e8d8'], motif: undefined },
  {
    name: 'a pinner sliding along its own line does not create a "new" pin',
    fen: '5k2/B3p3/8/p4q2/6P1/5N2/b1P2K2/R7 b - - 1 21',
    pv: ['f5f6', 'f2g1', 'f6f3', 'g4g5', 'f3a3'],
    motif: undefined,
  },
  {
    name: 'no "removing the defender" when the first capture is not taken back',
    fen: 'rnb5/1p1pk3/p7/4p1bB/P2P3R/8/1P2K3/R1B5 b - - 3 27',
    pv: ['g5c1', 'd4e5', 'c1b2'],
    motif: undefined,
  },
  {
    name: 'knight "fork" of two defended minor pieces wins nothing',
    fen: '4k3/3p4/2b1b3/8/8/5N2/8/4K3 w - - 0 1',
    pv: ['f3d4', 'c6d5', 'd4e6', 'd7e6'],
    motif: undefined,
  },
];

describe('detectMotif fixtures', () => {
  for (const fx of FIXTURES) {
    it(fx.name, () => {
      // every fixture PV must be legal, otherwise the fixture itself is wrong
      const chess = new Chess(fx.fen);
      for (const uci of fx.pv) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      expect(detectMotif(fx.fen, fx.pv)).toBe(fx.motif);
    });
  }
});

describe('describeMotif', () => {
  it('reports the forking piece and its targets', () => {
    const d = describeMotif('r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', ['d5c7', 'e8d7', 'c7a8']);
    expect(d).toEqual({ motif: 'fork', ply: 0, actor: 'c7', targets: expect.arrayContaining(['e8', 'a8']) });
    expect(d?.targets).toHaveLength(2);
  });

  it('returns undefined for an empty or illegal PV and throws on a bad FEN', () => {
    expect(detectMotif('4k3/8/8/8/8/8/8/4K3 w - - 0 1', [])).toBeUndefined();
    expect(detectMotif('4k3/8/8/8/8/8/8/4K3 w - - 0 1', ['e1e5'])).toBeUndefined();
    expect(() => detectMotif('not a fen', ['e2e4'])).toThrow();
  });

  it('ignores lines in which the side to move gets mated', () => {
    // White grabs a pawn and is mated on the back rank.
    expect(detectMotif('3r2k1/5ppp/8/8/8/8/p4PPP/R5K1 w - - 0 1', ['a1a2', 'd8d1'])).toBeUndefined();
  });

  it('never reports a motif for the wrong side', () => {
    // Black to move simply loses a knight to a fork next move, but the PV starts with Black.
    expect(detectMotif('r3k3/8/8/3N4/8/8/8/4K3 b - - 0 1', ['a8a7', 'd5c7'])).toBeUndefined();
  });
});
