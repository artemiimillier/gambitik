/**
 * A mistake by a concept (docs/TEACHING.md §2.8) on real positions: the §2.8 order, the split of the hanging piece
 * (only «.undefended» may say «без защиты»), the realized loss for the takeaway.
 */
import { describe, expect, it } from 'vitest';
import { backRankBlunder, forkBlunder, judgement, queenBlunder } from '../test-fixtures.ts';
import {
  firstLostPiece,
  isMistakeMove,
  materialTrack,
  mistakeConcepts,
  mistakeSaidAbout,
  pendingCueFacts,
  readTakebackMark,
  realizedLoss,
  ruleOfConcept,
  takeawayOfConcept,
  takebackConcepts,
  takebackMark,
  takebackPending,
} from './mistake.ts';
import { initialLessonMemory } from './memory.ts';

const concepts = (...a: Parameters<typeof mistakeConcepts>): string[] => mistakeConcepts(...a).map((m) => m.concept);

describe('isMistakeMove', () => {
  it('speaks only about a weaker move that is confirmed or loses ≥ 15 win%', () => {
    expect(isMistakeMove({ winPctLoss: 4, confidence: 'confirmed' })).toBe(false);
    expect(isMistakeMove({ winPctLoss: 6, confidence: 'confirmed' })).toBe(true);
    expect(isMistakeMove({ winPctLoss: 12, confidence: 'quick' })).toBe(false);
    expect(isMistakeMove({ winPctLoss: 16, confidence: 'quick' })).toBe(true);
  });
});

describe('mistakeConcepts: the §2.8 order', () => {
  it('the last rank before mate', () => {
    const m = mistakeConcepts({ judgement: backRankBlunder(), stage: 3 });
    expect(m.map((x) => x.concept).slice(0, 2)).toEqual(['backRank', 'mate']);
    expect(m[0]?.mated).toBe(true);
    expect(m[0]?.facts.kingOf).toBe('w'); // the board shows OUR king
    expect(m[0]?.rule).toBe('backRank');
  });

  it('a knight fork: the attacker is the knight, the board shows the threat arrow', () => {
    const [first] = mistakeConcepts({ judgement: forkBlunder(), stage: 2 });
    expect(first?.concept).toBe('fork');
    expect(first?.piece).toBe('n');
    expect(first?.facts.threat?.uci).toBe('d4c2');
    expect(first?.facts.threat?.targetSquares).toEqual(expect.arrayContaining(['e1', 'a1']));
    expect(first?.takeaway).toBe('mistake.fork');
  });

  it('the queen taken by a knight on an undefended square: «без защиты», then the bad trade', () => {
    const m = mistakeConcepts({ judgement: queenBlunder(), stage: 2 });
    expect(m[0]?.concept).toBe('hanging.undefended');
    expect(m[0]?.piece).toBe('q');
    expect(m[0]?.victim).toBe('e5');
    expect(m.map((x) => x.concept)).toContain('badTrade');
    expect(m[0]?.pool).toBe('v3.mistake.hanging.undefended');
    expect(m[0]?.takeaway).toBe('mistake.hanging');
  });

  it('a defended bishop attacked by a pawn is «cheaper», never «без защиты»', () => {
    const j = judgement({ fen: '6k1/8/8/8/3p4/8/5PP1/2B3K1 w - - 0 1', played: 'Be3', best: 'Kf1', refutation: ['dxe3', 'fxe3'], over: { materialLossPawns: 2 } });
    const m = concepts({ judgement: j, stage: 2 });
    expect(m[0]).toBe('hanging.cheaper');
    expect(m).not.toContain('hanging.undefended');
  });

  it('a pawn attacked by two knights and defended by one is «outnumbered»', () => {
    const j = judgement({ fen: '6k1/8/2n5/5n2/3P4/5N2/8/6K1 w - - 0 1', played: 'Kh1', best: 'Kh2', refutation: ['c6d4', 'f3d4', 'f5d4'], over: { materialLossPawns: 1 } });
    expect(concepts({ judgement: j, stage: 3 })[0]).toBe('hanging.outnumbered');
  });

  it('a warned piece that stayed is «ignoredDanger» first, then the hanging concept', () => {
    const j = judgement({ fen: '6k1/8/8/8/1p6/2N5/6PP/6K1 w - - 0 1', played: 'h3', best: 'Ne4', refutation: ['b4c3'], over: { materialLossPawns: 3 } });
    const warned = concepts({ judgement: j, stage: 2, lastDanger: { ply: j.ply, square: 'c3', kind: 'hanging' } });
    expect(warned.slice(0, 2)).toEqual(['ignoredDanger', 'hanging.undefended']);
    // no warning at this ply → no «ignored»
    expect(concepts({ judgement: j, stage: 2, lastDanger: { ply: j.ply - 2, square: 'c3', kind: 'hanging' } })[0]).toBe('hanging.undefended');
    // a take-back mark is not a warning
    expect(concepts({ judgement: j, stage: 2, lastDanger: { ply: j.ply, square: 'c3', kind: 'takeback:hanging.undefended:n' } })[0]).toBe('hanging.undefended');
  });

  it('a trade that is only a trade is no mistake concept', () => {
    // 1.e4 d5 2.exd5 Qxd5 — the child's capture is fine; a made-up refutation that just recaptures loses nothing
    const j = judgement({ setup: ['e4', 'd5'], played: 'exd5', best: 'exd5', refutation: ['Qxd5'], over: { materialLossPawns: 0 } });
    expect(concepts({ judgement: j, stage: 3 })).toEqual([]);
  });

  it('the early queen only when the refutation chases it', () => {
    const chased = judgement({ setup: ['e4', 'e5'], played: 'Qh5', best: 'Nf3', refutation: ['Nf6', 'Qh4'], over: { materialLossPawns: 0, winPctLoss: 8 } });
    expect(concepts({ judgement: chased, stage: 2 })).toContain('earlyQueen');
    const quiet = judgement({ setup: ['e4', 'e5'], played: 'Qh5', best: 'Nf3', refutation: ['d6'], over: { materialLossPawns: 0, winPctLoss: 8 } });
    expect(concepts({ judgement: quiet, stage: 2 })).not.toContain('earlyQueen');
  });

  it('a missed gift: the hidden treasure the child did not play', () => {
    const j = judgement({ fen: '4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1', played: 'Kd2', best: 'Bxd5', over: { materialLossPawns: 0, winPctLoss: 30 } });
    const advice = [{ uci: 'g2d5', san: 'Bxd5', source: 'engine' as const, arrow: 'green' as const }];
    const m = mistakeConcepts({ judgement: j, stage: 2, advice, treasureHidden: true });
    expect(m[0]?.concept).toBe('missedTreasure');
    expect(m[0]?.piece).toBe('n');
    expect(m[0]?.facts.target).toBe('d5');
  });

  it('«был ход сильнее» only at stages 3–5, with a concrete gain of the advice and a proven gap', () => {
    const j = judgement({ fen: '4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1', played: 'Kd2', best: 'Bxd5', over: { materialLossPawns: 0, winPctLoss: 30 } });
    const advice = [{ uci: 'g2d5', san: 'Bxd5', source: 'engine' as const, arrow: 'green' as const }];
    expect(concepts({ judgement: j, stage: 3, advice })).toContain('slower');
    expect(concepts({ judgement: j, stage: 2, advice })).not.toContain('slower');
    // the advice is not the engine's best and the loss is small: no proven gap
    const small = { ...j, winPctLoss: 7, bestUci: 'e1f1' };
    expect(concepts({ judgement: small, stage: 4, advice })).not.toContain('slower');
  });
});

/** c5g02 of the first 50-game run, before 15…Qe8?: the bishop on e6 was just said to be under attack (Ng5). */
const C5G02_FEN = 'r2q1rk1/pp2b1p1/4b1n1/P1pp1pNp/Q6P/2B1PB2/1PP2PP1/RN3K1R b - - 3 15';
const C5G02_WARNED = { ply: 30, square: 'e6', kind: 'hanging' };
function qe8(refutation = ['Qxe8', 'Rfxe8', 'Nxe6']) {
  return judgement({ fen: C5G02_FEN, played: 'Qe8', best: 'Bxg5', refutation, over: { ply: 30, materialLossPawns: 3 } });
}

describe('the lost piece behind an even trade (c5g02 15…Qe8?: Qxe8 Rxe8 Nxe6)', () => {
  it('the traded queens are passed over: the bishop on e6 is the loss', () => {
    expect(firstLostPiece(qe8())).toMatchObject({ index: 2, square: 'e6', victim: 'b' });
    // the same loss straight away
    expect(firstLostPiece(qe8(['Nxe6']))).toMatchObject({ index: 0, square: 'e6', victim: 'b' });
  });

  it('the warned bishop: «ignoredDanger», then «без защиты» (not only «был ход сильнее»)', () => {
    const m = mistakeConcepts({ judgement: qe8(), stage: 5, lastDanger: C5G02_WARNED });
    expect(m.map((x) => x.concept).slice(0, 2)).toEqual(['ignoredDanger', 'hanging.undefended']);
    expect(m[0]).toMatchObject({ piece: 'b', victim: 'e6' });
    expect(m[0]?.facts.threat?.uci).toBe('g5e6');
    expect(concepts({ judgement: qe8(), stage: 5 })[0]).toBe('hanging.undefended');
  });

  it('an exchange the opponent wins is no even trade: the outnumbered pawn stays the loss', () => {
    const j = judgement({ fen: '6k1/8/2n5/5n2/3P4/5N2/8/6K1 w - - 0 1', played: 'Kh1', best: 'Kh2', refutation: ['c6d4', 'f3d4', 'f5d4'], over: { materialLossPawns: 1 } });
    expect(firstLostPiece(j)).toMatchObject({ index: 0, square: 'd4', victim: 'p' });
  });
});

describe('the take-back concept (§2.8: after «да» / «нет» at stages 3–5 the reply names it)', () => {
  it('the §2.8 concepts first, «был ход сильнее» only as the last resort', () => {
    const advice = [{ uci: 'e7g5', san: 'Bxg5', source: 'engine' as const, arrow: 'green' as const }];
    const tb = takebackConcepts({ judgement: qe8(), advice, stage: 5, lastDanger: C5G02_WARNED }).map((m) => m.concept);
    expect(tb[0]).toBe('ignoredDanger');
    expect(tb.indexOf('slower')).toBe(tb.length - 1);
    // nothing but «был ход сильнее» provable: it is the concept
    const j = judgement({ fen: '4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1', played: 'Kd2', best: 'Bxd5', over: { materialLossPawns: 0, winPctLoss: 30 } });
    const gift = [{ uci: 'g2d5', san: 'Bxd5', source: 'engine' as const, arrow: 'green' as const }];
    expect(takebackConcepts({ judgement: j, advice: gift, stage: 4 }).map((m) => m.concept)).toEqual(['slower']);
  });

  it('a loss further than 4 plies is read up to 8 plies, only when it is a net loss', () => {
    // Kh1?: …b5, Kg1, b4, Kh1, bxc3 — the knight goes on the 5th ply of the refutation
    const late = judgement({ fen: '6k1/1p6/8/8/8/2N5/8/6K1 w - - 0 1', played: 'Kh1', best: 'Nd5', refutation: ['b5', 'Kg1', 'b4', 'Kh1', 'bxc3'], over: { materialLossPawns: 0 } });
    expect(mistakeConcepts({ judgement: late, stage: 4 })).toEqual([]);
    const [m] = takebackConcepts({ judgement: late, stage: 4 });
    expect(m).toMatchObject({ concept: 'hanging.undefended', piece: 'n', victim: 'c3' });
    // the child takes back more than he loses: nothing to name
    const even = judgement({ fen: '1q4k1/1p6/8/8/8/2N5/8/1R4K1 w - - 0 1', played: 'Kh1', best: 'Nd5', refutation: ['b5', 'Kg1', 'b4', 'Kh1', 'bxc3', 'Rxb8+'], over: { materialLossPawns: 0 } });
    expect(takebackConcepts({ judgement: even, stage: 4 })).toEqual([]);
  });

  it('the pending record keeps the concept, the piece, the square and its board facts as plain data', () => {
    const [m] = takebackConcepts({ judgement: qe8(), stage: 5, lastDanger: C5G02_WARNED });
    const p = takebackPending(qe8(), m ?? null);
    expect(p).toMatchObject({ ply: 30, uci: 'd8e8', childColor: 'b', concept: 'ignoredDanger', piece: 'b', square: 'e6' });
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
    const f = pendingCueFacts(p);
    expect(f).toMatchObject({ childColor: 'b', victim: 'e6' });
    expect(f.threat?.uci).toBe('g5e6');
    // nothing provable: no concept, the move still recorded
    expect(takebackPending(qe8(), null)).toMatchObject({ concept: null, piece: null, square: null, uci: 'd8e8' });
  });
});

describe('the next danger: said already by the mistake words? (§2.2)', () => {
  const lesson = {
    ...initialLessonMemory(),
    mistakes: [
      { turn: 14, ply: 28, concept: 'fork', uci: 'a7a6', lossPawns: 3, mated: false, victim: 'c7' },
      { turn: 15, ply: 30, concept: 'hanging.undefended', uci: 'd8e8', lossPawns: 3, mated: false, victim: 'e6' },
      { turn: 15, ply: 30, concept: 'mate', uci: 'g7g6', lossPawns: 0, mated: true, victim: null },
    ],
  };
  it('the entry of the child’s previous move about the same piece', () => {
    expect(mistakeSaidAbout(lesson, 32, ['e6'])?.concept).toBe('hanging.undefended');
    expect(mistakeSaidAbout(lesson, 32, [null, 'd5', 'e6'])?.uci).toBe('d8e8');
  });
  it('not another piece, not an older move, not without squares', () => {
    expect(mistakeSaidAbout(lesson, 32, ['d5'])).toBeNull();
    expect(mistakeSaidAbout(lesson, 32, ['c7'])).toBeNull();
    expect(mistakeSaidAbout(lesson, 34, ['e6'])).toBeNull();
    expect(mistakeSaidAbout(lesson, 32, [])).toBeNull();
    expect(mistakeSaidAbout({ mistakes: [{ turn: 1, ply: 30, concept: 'mate', uci: '', lossPawns: 0, mated: true }] }, 32, ['e6'])).toBeNull();
  });
});

describe('rules and takeaways of the concepts', () => {
  it('the hanging split shares one rule and one takeaway', () => {
    for (const c of ['hanging.undefended', 'hanging.cheaper', 'hanging.outnumbered']) {
      expect(ruleOfConcept(c)).toBe('hanging');
      expect(takeawayOfConcept(c)).toBe('mistake.hanging');
    }
    expect(ruleOfConcept('skewer')).toBe('tactic');
    expect(takeawayOfConcept('slower')).toBeNull();
  });

  it('the take-back mark keeps the concept, the piece and the square until the reply', () => {
    const [m] = mistakeConcepts({ judgement: queenBlunder(), stage: 3 });
    const mark = takebackMark(5, m ?? null);
    expect(readTakebackMark(mark)).toEqual({ ply: 5, concept: 'hanging.undefended', piece: 'q', victim: 'e5' });
    expect(readTakebackMark({ ply: 5, square: 'e5', kind: 'hanging' })).toBeNull();
  });
});

describe('the realized loss', () => {
  it('the queen blunder really loses 9 pawns within 4 plies', () => {
    const track = materialTrack(['e4', 'e5', 'Qh5', 'Nc6', 'Qxe5+', 'Nxe5', 'd4', 'Nc6'], 'w');
    expect(realizedLoss(track, 5, 'w')).toEqual({ pawns: 9, mated: false });
  });

  it('a mistake the opponent did not punish loses nothing', () => {
    const track = materialTrack(['e4', 'e5', 'Qh5', 'Nc6', 'Qxe5+', 'Be7', 'Qxg7'], 'w');
    expect(realizedLoss(track, 5, 'w').pawns).toBe(0);
  });

  it("the scholar's mate: the mistake before it is «mated»", () => {
    const track = materialTrack(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'], 'b');
    expect(realizedLoss(track, 6, 'b').mated).toBe(true);
  });
});
