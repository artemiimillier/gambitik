import { describe, expect, it } from 'vitest';
import {
  endangeredSquares,
  fullMoveNumber,
  kingSquare,
  parseUci,
  pieceAt,
  resolveUciMove,
  sideToMove,
  zoneOf,
  zoneSquares,
} from './board.ts';
import { BACK_RANK_FEN, backRankBlunder, forkBlunder, queenBlunder } from './test-fixtures.ts';

describe('basic helpers', () => {
  it('parseUci', () => {
    expect(parseUci('e2e4')).toEqual({ from: 'e2', to: 'e4', promotion: undefined });
    expect(parseUci('e7e8q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(parseUci('E7E8Q')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(parseUci('e2')).toBeNull();
    expect(parseUci('(none)')).toBeNull();
  });

  it('reads FEN fields and survives garbage', () => {
    expect(sideToMove(BACK_RANK_FEN)).toBe('w');
    expect(fullMoveNumber(BACK_RANK_FEN)).toBe(30);
    expect(sideToMove('garbage')).toBe('w');
    expect(fullMoveNumber('garbage')).toBe(1);
    expect(pieceAt('garbage', 'e4')).toBeUndefined();
    expect(kingSquare('garbage', 'w')).toBeUndefined();
  });

  it('pieceAt / kingSquare', () => {
    expect(pieceAt(BACK_RANK_FEN, 'e8')).toEqual({ square: 'e8', piece: 'r', color: 'b' });
    expect(pieceAt(BACK_RANK_FEN, 'e4')).toBeUndefined();
    expect(pieceAt(BACK_RANK_FEN, 'z9')).toBeUndefined();
    expect(kingSquare(BACK_RANK_FEN, 'w')).toBe('g1');
  });

  it('resolveUciMove', () => {
    const mate = resolveUciMove('4r1k1/5ppp/8/8/8/8/R4PPP/6K1 b - - 0 30', 'e8e1');
    expect(mate).toMatchObject({ san: 'Re1#', piece: 'r', color: 'b', givesCheck: true, givesMate: true, isCastle: false });
    const castle = resolveUciMove('r3k2r/ppp2ppp/8/8/3n4/8/PPP2PPP/R3K2R w KQkq - 0 12', 'e1g1');
    expect(castle).toMatchObject({ san: 'O-O', isCastle: true, piece: 'k' });
    expect(resolveUciMove(BACK_RANK_FEN, 'a1a9')).toBeUndefined();
    expect(resolveUciMove(BACK_RANK_FEN, 'g1g3')).toBeUndefined();
  });
});

describe('endangeredSquares', () => {
  it('marks the piece that simply gets captured', () => {
    const j = queenBlunder();
    expect(endangeredSquares(j.fenAfter, j.refutationPvUci)).toEqual(['e5']);
  });

  it('marks both victims of a fork, in PV order', () => {
    const j = forkBlunder();
    expect(endangeredSquares(j.fenAfter, j.refutationPvUci)).toEqual(['c2', 'a1']);
  });

  it('marks the king when the line ends in mate', () => {
    const j = backRankBlunder();
    expect(endangeredSquares(j.fenAfter, j.refutationPvUci)).toEqual(['g1']);
  });

  it('adds the king on request (mate threat known from the eval)', () => {
    const j = queenBlunder();
    expect(endangeredSquares(j.fenAfter, j.refutationPvUci, { mateThreat: true })).toEqual(['e5', 'e1']);
  });

  it('traces a piece back to where the child sees it now', () => {
    // Black to move: …Bg4 attacks the queen on f3; the PV has the queen step to g3 and get taken there.
    const fen = '4k3/8/8/7n/6b1/5Q2/8/4K3 b - - 0 1';
    expect(endangeredSquares(fen, ['g4h3', 'f3g3', 'h5g3'])).toEqual(['f3']);
  });

  it('handles en passant (the captured pawn is not on the landing square)', () => {
    const fen = '4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1';
    expect(endangeredSquares(fen, ['d4e3'])).toEqual(['e4']);
  });

  it('falls back to what the moved piece attacks when the PV is short', () => {
    // Knight lands on c2 with check and attacks the rook on a1; the PV stops right there.
    const fen = 'r3k2r/ppp2ppp/8/8/3n4/8/PP3PPP/R3K2R b KQkq - 0 12';
    expect(endangeredSquares(fen, ['d4c2'])).toEqual(['e1', 'a1']);
  });

  it('last resort: the landing square of the first move', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 b - - 0 1';
    expect(endangeredSquares(fen, ['e8d7'])).toEqual(['d7']);
  });

  it('is safe on broken input', () => {
    expect(endangeredSquares('garbage', ['e2e4'])).toEqual([]);
    expect(endangeredSquares(BACK_RANK_FEN, [])).toEqual([]);
    expect(endangeredSquares(BACK_RANK_FEN, ['zzzz'])).toEqual([]);
    expect(endangeredSquares(BACK_RANK_FEN, ['g1g5'])).toEqual([]);
  });

  it('never returns more than maxSquares', () => {
    const j = forkBlunder();
    expect(endangeredSquares(j.fenAfter, j.refutationPvUci, { maxSquares: 1 })).toEqual(['c2']);
  });
});

describe('zones', () => {
  it('zoneOf', () => {
    expect(zoneOf('e4')).toBe('center');
    expect(zoneOf('c6')).toBe('center');
    expect(zoneOf('g1')).toBe('kingside');
    expect(zoneOf('h7')).toBe('kingside');
    expect(zoneOf('a1')).toBe('queenside');
    expect(zoneOf('d8')).toBe('queenside');
  });

  it('zoneSquares is always a 3×3 block containing the square', () => {
    for (const sq of ['a1', 'h8', 'e4', 'g1', 'a8', 'd5', 'h1']) {
      const zone = zoneSquares(sq);
      expect(zone).toHaveLength(9);
      expect(new Set(zone).size).toBe(9);
      expect(zone).toContain(sq);
      for (const z of zone) expect(z).toMatch(/^[a-h][1-8]$/);
    }
    expect(zoneSquares('zz')).toEqual([]);
  });

  it('zoneSquares does not give the target away: its place inside the block varies with the seed, deterministically', () => {
    const places = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const seed = `fen-${i}`;
      const zone = zoneSquares('e4', seed);
      expect(zone).toHaveLength(9);
      expect(zone).toContain('e4');
      expect(zoneSquares('e4', seed)).toEqual(zone); // asking the same hint again shows the same squares
      places.add(zone.indexOf('e4'));
    }
    // index 4 is the middle of the 3×3 block — the target must not always sit there
    expect(places.size).toBeGreaterThanOrEqual(6);
    for (const sq of ['a1', 'h8', 'g1', 'b7']) {
      for (let i = 0; i < 20; i++) expect(zoneSquares(sq, `s${i}`)).toContain(sq);
    }
  });
});
