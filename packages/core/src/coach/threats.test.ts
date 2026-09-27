import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { mateInOneThreat, nullMoveFen, threatFactsRu, threatFromNullMoveLine } from './threats.ts';
import { FORK_FEN } from './test-fixtures.ts';

/** White to move; Black's rook threatens …Re1# on the back rank. */
const BACK_RANK_THREAT_FEN = '4r1k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 30';

describe('nullMoveFen', () => {
  it('passes the move to the other side and clears en passant', () => {
    expect(nullMoveFen('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2')).toBe('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2');
    expect(nullMoveFen(FORK_FEN)?.split(' ')[1]).toBe('b');
  });

  it('is null in check (a null move would be illegal) and for a broken FEN', () => {
    expect(nullMoveFen('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1')).toBeNull();
    expect(nullMoveFen('not a fen')).toBeNull();
  });
});

describe('threatFromNullMoveLine', () => {
  it('a knight fork that wins a rook is a threat, told from the child\'s side', () => {
    const threat = threatFromNullMoveLine(FORK_FEN, { cp: 500, mate: null, pvUci: ['d4c2', 'e1d1', 'c2a1'] });
    expect(threat).toMatchObject({ uci: 'd4c2', san: 'Nxc2+', motif: 'fork' });
    expect(threat?.gainCp).toBeGreaterThanOrEqual(200);
    expect(threat?.targetSquares).toContain('a1');
    const facts = threatFactsRu(FORK_FEN, threat!).join(' ');
    expect(facts).toContain('конь бьёт на цэ два, шах');
    expect(facts).toContain('вилку');
    expect(facts).not.toMatch(/[A-Za-z]/);
  });

  it('a mate within three is a threat whatever the material', () => {
    const threat = threatFromNullMoveLine(BACK_RANK_THREAT_FEN, { cp: null, mate: 1, pvUci: ['e8e1'] });
    expect(threat?.san).toBe('Re1#');
    expect(['backRankMate', 'mateIn1']).toContain(threat?.motif);
    expect(threat?.targetSquares).toContain('g1');
    expect(threatFactsRu(BACK_RANK_THREAT_FEN, threat!).join(' ')).toMatch(/ладья на е один, мат/);
  });

  it('positional "threats" and small gains are not reported', () => {
    expect(threatFromNullMoveLine(FORK_FEN, { cp: 40, mate: null, pvUci: ['h7h6'] })).toBeNull();
    expect(threatFromNullMoveLine(FORK_FEN, { cp: 40, mate: null, pvUci: [] })).toBeNull();
    expect(threatFromNullMoveLine(FORK_FEN, { cp: 40, mate: null, pvUci: ['a1a8'] })).toBeNull(); // not a legal null-move reply
    expect(threatFromNullMoveLine(BACK_RANK_THREAT_FEN, { cp: null, mate: 7, pvUci: ['e8e1'] })).toBeNull();
  });
});

describe('mateInOneThreat', () => {
  it('finds a back-rank mate threat without any engine', () => {
    const threat = mateInOneThreat(BACK_RANK_THREAT_FEN);
    expect(threat).toMatchObject({ san: 'Re1#', motif: 'mateIn1' });
    // after the defence h3 there is none
    const chess = new Chess(BACK_RANK_THREAT_FEN);
    chess.move('h3');
    chess.move('Kf8'); // black makes a waiting move
    expect(mateInOneThreat(chess.fen())).toBeNull();
  });

  it('is null when the side to move is in check', () => {
    expect(mateInOneThreat('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1')).toBeNull();
  });
});
