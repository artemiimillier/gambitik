/**
 * The proofs of «Учитель» (docs/TEACHING.md §6) on real positions: the MultiPV closure, the quiz buttons' TRUE /
 * provably-FALSE predicates, checkEscape / canCapture / danger / whichPiece proofs, the danger guards, the variants.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, EngineLine, Threat } from '@gambit/shared';
import type { TeachDanger } from '../teacher.ts';
import {
  adviceSaves,
  allowBestClaim,
  canCaptureProof,
  checkEscapeProof,
  dangerQuizProof,
  engineProof,
  guardDanger,
  ideaVariant,
  moveFacts,
  optionFalse,
  optionTrue,
  provenWithin,
  provenWorse,
  sideToMoveMatesInOne,
  whichPieceProof,
} from './truth.ts';

type Score = number | { mate: number };
type LineSpec = [string, Score, ...string[]];

function fenOf(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function scripted(fen: string, specs: readonly LineSpec[], depth = 16): AnalysisResult {
  const lines: EngineLine[] = specs.map(([san, score, ...cont], i) => {
    const chess = new Chess(fen);
    const pvUci = [san, ...cont].map((s) => {
      const m = chess.move(s);
      return `${m.from}${m.to}${m.promotion ?? ''}`;
    });
    return { multipv: i + 1, depth, pvUci, cp: typeof score === 'number' ? score : null, mate: typeof score === 'number' ? null : score.mate };
  });
  return { fen, lines, bestmove: lines[0]?.pvUci[0] ?? '', depth, timeMs: 300 };
}

/** White: Nd4 en prise to the pawn e5 and undefended; the bishop, the rooks and the pawns are not attacked at all. */
const HANGING_FEN = '6k1/8/8/4p3/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';
const HANGING: TeachDanger = { kind: 'hanging', factRu: '', textRu: '', squares: ['d4'], arrows: [{ from: 'e5', to: 'd4' }], piece: { piece: 'n', square: 'd4' } };

describe('the MultiPV closure (§6.1)', () => {
  const fen = fenOf(['e4', 'e5']);
  const p = engineProof(fen, scripted(fen, [['Nf3', 30], ['Nc3', 26], ['d4', -60]]));
  it('a listed move has its own score; an unlisted move is bounded by the last line', () => {
    expect(p).not.toBeNull();
    if (!p) return;
    expect(provenWithin(p, 'g1f3', 0)).toBe(true);
    expect(provenWithin(p, 'b1c3', 5)).toBe(true);
    expect(provenWithin(p, 'f1c4', 5)).toBe(false); // not scored — never «proven good»
    expect(provenWorse(p, 'd2d4', 8)).toBe(true);
    expect(provenWorse(p, 'f1c4', 8)).toBe(true); // ≤ the third line
    expect(provenWorse(p, 'b1c3', 8)).toBe(false);
  });

  it('«лучше всего» only for the engine first move with a ≥ 3 win% gap at depth ≥ 12', () => {
    const start = new Chess().fen();
    expect(allowBestClaim(start, scripted(start, [['e4', 80], ['d4', 10]]), 'e2e4')).toBe(true);
    expect(allowBestClaim(start, scripted(start, [['e4', 80], ['d4', 10]]), 'd2d4')).toBe(false);
    expect(allowBestClaim(start, scripted(start, [['e4', 40], ['d4', 35]]), 'e2e4')).toBe(false);
    expect(allowBestClaim(start, scripted(start, [['e4', 80], ['d4', 10]], 10), 'e2e4')).toBe(false);
    expect(allowBestClaim(start, null, 'e2e4')).toBe(false);
  });
});

describe('quiz buttons: TRUE and provably FALSE (§6.1)', () => {
  it('a knight / bishop attacking a DEFENDED piece — «напасть» is never provably false', () => {
    // 1.e4 e5 2.Nc3 Bb4: the bishop develops and hits the knight c3, defended by b2 / d2 (SEE 0 — no `attack` idea)
    const f = moveFacts(fenOf(['e4', 'e5', 'Nc3']), 'f8b4');
    expect(f).not.toBeNull();
    if (!f) return;
    expect(optionFalse('attack', f)).toBe(false);
    expect(optionTrue('develop', f)).toBe(true);
    expect(optionFalse('develop', f)).toBe(false);
    expect(optionFalse('capture', f)).toBe(true);
    expect(optionFalse('center', f)).toBe(true);
    expect(optionFalse('queenOut', f)).toBe(true);
    // f8 is between the king and the rook: «спрятать короля» is not provably false
    expect(optionFalse('castle', f)).toBe(false);
  });

  it('§7: a knight attacking a defended bishop — «напасть» is not a wrong answer', () => {
    // 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.d3 Na5: the knight hits the bishop c4, defended by d3 (SEE 0)
    const f = moveFacts(fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3']), 'c6a5');
    expect(f).not.toBeNull();
    if (!f) return;
    expect(optionFalse('attack', f)).toBe(false);
    expect(optionTrue('attack', f)).toBe(true);
    expect(optionFalse('develop', f)).toBe(true); // not from home
  });

  it('center: a pawn that hits a centre square is not «не центр»; mate is false only when the search found no mate', () => {
    const c5 = moveFacts(fenOf(['e4']), 'c7c5');
    expect(c5 && optionFalse('center', c5)).toBe(false);
    const a6 = moveFacts(fenOf(['e4']), 'a7a6');
    expect(a6 && optionFalse('center', a6)).toBe(true);
    if (!a6) return;
    expect(optionFalse('mate', a6, { threatAfter: null })).toBe(true);
    expect(optionFalse('mate', a6, { threatAfter: undefined })).toBe(false);
    const mateThreat: Threat = { uci: 'd8h4', san: 'Qh4#', motif: 'mateIn1', targetSquares: ['e1'], gainCp: 10_000 };
    expect(optionFalse('mate', a6, { threatAfter: mateThreat })).toBe(false);
    expect(optionFalse('mate', a6, { staticMate: true })).toBe(true);
  });

  it('a check is TRUE «шах», never FALSE; a capture is TRUE «съесть»', () => {
    const check = moveFacts(fenOf(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']), 'h5f7');
    expect(check).not.toBeNull();
    if (!check) return;
    expect(optionTrue('mate', check)).toBe(true); // Qxf7#
    expect(optionTrue('capture', check)).toBe(true);
    expect(optionFalse('check', check)).toBe(false);
  });

  it('a check is an attack on the king — «напасть» is never provably false for Сb5+', () => {
    // 1.e4 c5 2.Nf3 d6 3.Bb5+: the bishop's only new target is the king (no piece newly attacked)
    const f = moveFacts(fenOf(['e4', 'c5', 'Nf3', 'd6']), 'f1b5');
    expect(f).not.toBeNull();
    if (!f) return;
    expect(optionTrue('check', f)).toBe(true);
    expect(optionTrue('develop', f)).toBe(true);
    expect(optionFalse('attack', f)).toBe(false);
    // a quiet move that attacks nothing new stays provably «не напасть»
    const quiet = moveFacts(fenOf(['e4', 'c5']), 'a2a3');
    expect(quiet && optionFalse('attack', quiet)).toBe(true);
  });
});

describe('checkEscape (§6.1)', () => {
  it('the king takes the checker — no quiz (it is both «уйти» and «съесть»)', () => {
    const fen = '4k3/8/8/8/8/3B4/4q3/4K3 w - - 0 1';
    expect(checkEscapeProof(fen, engineProof(fen, scripted(fen, [['Kxe2', 900], ['Bxe2', 890]])), 1)).toBeNull();
  });

  it('G04 …Кxc2+: taking the knight with the queen is proven the one way out', () => {
    const fen = fenOf(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4', 'Qa4', 'Nxc2+']);
    const proof = checkEscapeProof(fen, engineProof(fen, scripted(fen, [['Qxc2', 390], ['Kd1', -551], ['Ke2', -671]], 12)), 1);
    expect(proof?.correct).toBe('escCapture');
    expect(proof?.available).toContain('escKing');
    expect(proof?.checkers).toEqual(['c2']);
    // too shallow, or the other ways not proven worse → no quiz
    expect(checkEscapeProof(fen, engineProof(fen, scripted(fen, [['Qxc2', 390], ['Kd1', -551]], 10)), 1)).toBeNull();
    expect(checkEscapeProof(fen, engineProof(fen, scripted(fen, [['Qxc2', 20], ['Kd1', 15], ['Ke2', 10]], 12)), 1)).toBeNull();
  });
});

describe('canCapture (§6.1)', () => {
  it('«потеряем»: Кxe5?? into dxe5, proven ≥ 10 win% worse', () => {
    const fen = fenOf(['e4', 'e5', 'Nf3', 'd6']);
    const proof = canCaptureProof(fen, engineProof(fen, scripted(fen, [['d4', 40], ['Bc4', 35], ['Nxe5', -180]])), 'd2d4');
    expect(proof).toMatchObject({ bucket: 'capLose', target: 'e5', victim: 'p', mover: 'n', uci: 'f3e5' });
    // unlisted, the closure bound too close to the best: nothing is proven
    expect(canCaptureProof(fen, engineProof(fen, scripted(fen, [['d4', 40], ['Bc4', 35], ['Nc3', 30]])), 'd2d4')).toBeNull();
  });

  it('«будет размен»: Сxc6 of the Spanish — equal pieces, SEE 0, within 5 win% of the best — only when it IS the advice', () => {
    const fen = fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
    const lines = engineProof(fen, scripted(fen, [['Ba4', 30], ['O-O', 25], ['Bxc6', 20]]));
    const proof = canCaptureProof(fen, lines, 'b5c6');
    expect(proof).toMatchObject({ bucket: 'capTrade', target: 'c6', victim: 'n', mover: 'b', uci: 'b5c6' });
    // the advice is Сa4: «Будет размен» and then an arrow to another move — no question
    expect(canCaptureProof(fen, lines, 'b5a4')).toBeNull();
    expect(canCaptureProof(fen, lines, null)).toBeNull();
  });

  it('«да, бесплатно» only when the free capture IS the advice; «нет, потеряем» only when the advice is another move', () => {
    // the black knight d5 hangs: Кxd5 takes it for free
    const fen = '6k1/8/8/3n4/8/2N5/PPP2PPP/R1B2RK1 w - - 0 1';
    const lines = engineProof(fen, scripted(fen, [['Nxd5', 600], ['a3', 120], ['b3', 110]]));
    expect(canCaptureProof(fen, lines, 'c3d5')).toMatchObject({ bucket: 'capYes', target: 'd5', victim: 'n', uci: 'c3d5' });
    expect(canCaptureProof(fen, lines, 'a2a3')).toBeNull();
    // «потеряем» (Кxe5?? dxe5) with the advice d4 — never a question whose «нет» is about the advised capture itself
    const lose = fenOf(['e4', 'e5', 'Nf3', 'd6']);
    const loseLines = engineProof(lose, scripted(lose, [['d4', 40], ['Bc4', 35], ['Nxe5', -180]]));
    expect(canCaptureProof(lose, loseLines, 'd2d4')?.bucket).toBe('capLose');
    expect(canCaptureProof(lose, loseLines, 'f3e5')).toBeNull();
  });

  it('the engine-approved sacrifice Сxf7+ is never «потеряем»', () => {
    const fen = fenOf(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4']);
    const proof = canCaptureProof(fen, engineProof(fen, scripted(fen, [['Bxf7+', -439], ['Qa4', -446], ['Qg3', -452]], 12)), 'c4f7');
    expect(proof?.target === 'f7' && proof.bucket === 'capLose').toBe(false);
  });
});

describe('the danger quiz and whichPiece (§6.1)', () => {
  it('«Что соперник может съесть?»: one hanging type, the wrong types have no piece attacked at all', () => {
    const proof = dangerQuizProof(HANGING_FEN, HANGING, 'w', 1);
    expect(proof?.correct).toBe('n');
    expect(proof?.distractors).toHaveLength(2);
    expect(proof?.distractors).not.toContain('n');
    // no quiz for a non-hanging danger
    expect(dangerQuizProof(HANGING_FEN, { ...HANGING, kind: 'threat' }, 'w', 1)).toBeNull();
  });

  it('«Какой фигурой?»: every near move a knight, the other types proven ≥ 8 win% worse', () => {
    const fen = fenOf(['e4', 'e5']);
    const ok = whichPieceProof(fen, engineProof(fen, scripted(fen, [['Nf3', 30], ['Nc3', 26], ['d4', -60]])), 'g1f3');
    expect(ok?.correct).toBe('n');
    expect(ok?.distractors).toEqual(['b', 'p']);
    // a bishop move within 5 win%: the answer is not unique
    expect(whichPieceProof(fen, engineProof(fen, scripted(fen, [['Nf3', 30], ['Bc4', 28], ['d4', 20]])), 'g1f3')).toBeNull();
    // never about a capture / castling / a shallow analysis
    expect(whichPieceProof(fen, engineProof(fen, scripted(fen, [['Nf3', 30], ['Nc3', 26], ['d4', -60]], 10)), 'g1f3')).toBeNull();
  });
});

describe('the danger guards (§6.2)', () => {
  it('a «hanging» piece the null-move search does not win is poisoned: no danger; unknown search: kept', () => {
    expect(guardDanger(HANGING, { fen: HANGING_FEN, threat: null })).toBeNull();
    expect(guardDanger(HANGING, { fen: HANGING_FEN, threat: undefined })).toBe(HANGING);
    const same: Threat = { uci: 'e5d4', san: 'exd4', motif: 'hangingPiece', targetSquares: ['d4'], gainCp: 300 };
    expect(guardDanger(HANGING, { fen: HANGING_FEN, threat: same })).toBe(HANGING);
  });

  it('a bigger threat elsewhere is the danger instead', () => {
    const other: Threat = { uci: 'e5f4', san: 'f4', motif: 'fork', targetSquares: ['g3', 'e3'], gainCp: 500 };
    const d = guardDanger(HANGING, { fen: HANGING_FEN, threat: other });
    expect(d?.kind).toBe('threat');
    expect(d?.squares).toEqual(['g3', 'e3']);
    expect(d?.conceptId).toBe('fork');
  });

  it('«спасаем» only when the advice leaves the piece safe', () => {
    expect(adviceSaves(HANGING, HANGING_FEN, 'd4f5')).toBe(true);
    expect(adviceSaves(HANGING, HANGING_FEN, 'a2a3')).toBe(false);
    // a mate threat: saved only when the opponent has no mate in one after the advice
    const scholar = fenOf(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5']);
    const mate: TeachDanger = { kind: 'mate', factRu: '', textRu: '', squares: ['f7'], arrows: [{ from: 'h5', to: 'f7' }] };
    expect(adviceSaves(mate, scholar, 'g7g6')).toBe(true);
    expect(adviceSaves(mate, scholar, 'a7a6')).toBe(false);
    expect(sideToMoveMatesInOne(fenOf(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'a6']))).toBe(true);
  });
});

describe('idea variants (the pool sub-cases)', () => {
  it('reads the sub-case from the board when the detector gave none', () => {
    const fen = fenOf(['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4', 'Qa4', 'Nxc2+']);
    const idea = { id: 'answerCheck' as const, squares: ['c2'], phraseRu: '' };
    expect(ideaVariant(idea, fen, 'a4c2')).toBe('capture');
    expect(ideaVariant(idea, fen, 'e1d1')).toBe('king');
    expect(ideaVariant({ id: 'develop' as const, squares: ['f3'], phraseRu: '' }, fenOf(['e4', 'e5']), 'g1f3')).toBe('center');
    expect(ideaVariant({ id: 'develop' as const, squares: ['h3'], phraseRu: '' }, fenOf(['e4', 'e5']), 'g1h3')).toBe('plain');
    expect(ideaVariant({ id: 'develop' as const, squares: ['f3'], phraseRu: '', variant: 'plain' }, fenOf(['e4', 'e5']), 'g1f3')).toBe('plain');
  });
});
