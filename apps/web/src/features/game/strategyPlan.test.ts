/**
 * WHEN the game asks the smart model to re-plan, and WHAT it may choose from (strategyPlan.ts) — pure, engine lines scripted.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { EngineLine } from '@gambit/shared';
import { REPLAN_EVERY_PLIES, positionAfter, replanCandidates, replanTrigger, strategyLineStatus } from './strategyPlan.ts';

function fenAfter(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function line(multipv: number, cp: number, pvUci: string[], depth = 14): EngineLine {
  return { multipv, depth, cp, mate: null, pvUci };
}

const ITALIAN_LINE = ['e4', 'Nf3', 'Bc4', 'c3', 'd3', 'O-O'];

describe('strategyLineStatus: is the game still on the strategy\'s line?', () => {
  it('the child played the plan so far and the next plan move is legal and within tolerance → on', () => {
    const history = ['e4', 'e5', 'Nf3', 'Nc6'];
    const fen = fenAfter(history);
    const lines = [line(1, 33, ['d2d4']), line(2, 32, ['f1b5']), line(3, 20, ['f1c4'])];
    expect(strategyLineStatus({ fen, childColor: 'w', historySan: history, lineSan: ITALIAN_LINE, lines })).toEqual({ status: 'on', nextSan: 'Bc4' });
    // without an analysis: legality alone
    expect(strategyLineStatus({ fen, childColor: 'w', historySan: history, lineSan: ITALIAN_LINE }).status).toBe('on');
  });

  it('the plan move is out of tolerance, not even among the engine lines, or illegal → off', () => {
    const history = ['e4', 'e5', 'Nf3', 'Nc6'];
    const fen = fenAfter(history);
    expect(strategyLineStatus({ fen, childColor: 'w', historySan: history, lineSan: ITALIAN_LINE, lines: [line(1, 90, ['d2d4']), line(2, 20, ['f1c4'])] }).status).toBe('off');
    expect(strategyLineStatus({ fen, childColor: 'w', historySan: history, lineSan: ITALIAN_LINE, lines: [line(1, 33, ['d2d4']), line(2, 32, ['f1b5'])] }).status).toBe('off');
    // a plan move the bot's reply made impossible (here: a capture that is not there) is off the plan at once
    const noCapture = ['e4', 'e6', 'Nf3', 'd5'];
    expect(strategyLineStatus({ fen: fenAfter(noCapture), childColor: 'w', historySan: noCapture, lineSan: ['e4', 'Nf3', 'Bxf7'] })).toEqual({ status: 'off', nextSan: 'Bxf7' });
  });

  it('the child left the plan himself → off; the plan played to its end → done', () => {
    const own = ['e4', 'e5', 'Nc3', 'Nc6'];
    expect(strategyLineStatus({ fen: fenAfter(own), childColor: 'w', historySan: own, lineSan: ITALIAN_LINE }).status).toBe('off');
    const short = ['e4', 'e5', 'Nf3', 'Nc6'];
    expect(strategyLineStatus({ fen: fenAfter(short), childColor: 'w', historySan: short, lineSan: ['e4', 'Nf3'] }).status).toBe('done');
  });

  it('Black: the child\'s moves are the even plies', () => {
    const history = ['e4', 'c5', 'Nf3', 'd6', 'd4'];
    const fen = fenAfter(history);
    expect(strategyLineStatus({ fen, childColor: 'b', historySan: history, lineSan: ['c5', 'd6', 'cxd4'] })).toEqual({ status: 'on', nextSan: 'cxd4' });
    expect(strategyLineStatus({ fen, childColor: 'b', historySan: history, lineSan: ['c5', 'Nc6', 'cxd4'] }).status).toBe('off');
  });

  it('the card\'s whole main line (both sides): the bot\'s deviation leaves it at once, even when the plan move stays legal', () => {
    const MAIN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'];
    const onLine = ['e4', 'e5', 'Nf3', 'Nc6'];
    expect(strategyLineStatus({ fen: fenAfter(onLine), childColor: 'w', historySan: onLine, lineSan: ITALIAN_LINE, mainLineSan: MAIN })).toEqual({ status: 'on', nextSan: 'Bc4' });
    // 2…Nf6 (Petrov): Bc4 is still legal — the child's line alone would not see it
    const petrov = ['e4', 'e5', 'Nf3', 'Nf6'];
    expect(strategyLineStatus({ fen: fenAfter(petrov), childColor: 'w', historySan: petrov, lineSan: ITALIAN_LINE }).status).toBe('on');
    expect(strategyLineStatus({ fen: fenAfter(petrov), childColor: 'w', historySan: petrov, lineSan: ITALIAN_LINE, mainLineSan: MAIN }).status).toBe('off');
    // a check sign does not make a move different
    const checked = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'];
    expect(strategyLineStatus({ fen: fenAfter(checked), childColor: 'w', historySan: checked, lineSan: ITALIAN_LINE, mainLineSan: [...MAIN.slice(0, 7), 'Nf6+', 'd3'] }).status).toBe('on');
    // past the end of the main line: the child's line decides
    const longer = [...MAIN, 'd3', 'd6'];
    expect(strategyLineStatus({ fen: fenAfter(longer), childColor: 'w', historySan: longer, lineSan: ITALIAN_LINE, mainLineSan: MAIN })).toEqual({ status: 'on', nextSan: 'O-O' });
  });

  it('no card: the teacher\'s repertoire memory says whether the bot played the model reply; nothing known → unknown', () => {
    const history = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6'];
    const fen = fenAfter(history);
    expect(strategyLineStatus({ fen, childColor: 'w', historySan: history, lineSan: null, repertoireInBook: true, repertoireOppNext: 'Bc5' }).status).toBe('off');
    expect(strategyLineStatus({ fen, childColor: 'w', historySan: history, lineSan: null, repertoireInBook: true, repertoireOppNext: 'h6' }).status).toBe('on');
    expect(strategyLineStatus({ fen, childColor: 'w', historySan: history, lineSan: null, repertoireInBook: false, repertoireOppNext: 'Bc5' }).status).toBe('unknown');
    expect(strategyLineStatus({ fen, childColor: 'w', historySan: history, lineSan: null }).status).toBe('unknown');
  });
});

describe('replanTrigger: when the smart model thinks again', () => {
  const base = { ply: 7, phase: 'opening' as const, planPhase: 'opening' as const, lineBefore: 'on' as const, lineAfter: 'on' as const, lastReplanPly: null };

  it('on the line in the opening: no re-plan (the plan holds)', () => {
    expect(replanTrigger(base)).toBeNull();
    expect(replanTrigger({ ...base, lineBefore: 'unknown', lineAfter: 'unknown' })).toBeNull();
  });

  it('the opponent left the line → once, on the move that leaves it', () => {
    expect(replanTrigger({ ...base, lineAfter: 'off' })).toBe('leftLine');
    expect(replanTrigger({ ...base, lineBefore: 'unknown', lineAfter: 'off' })).toBe('leftLine');
    expect(replanTrigger({ ...base, lineBefore: 'off', lineAfter: 'off' })).toBeNull();
  });

  it('a new phase → re-plan; in the middlegame / endgame every ~6 plies after the last one', () => {
    expect(replanTrigger({ ...base, phase: 'middlegame' })).toBe('phase');
    expect(replanTrigger({ ...base, phase: 'endgame', planPhase: 'middlegame', lineBefore: 'off', lineAfter: 'off' })).toBe('phase');
    const mid = { ...base, phase: 'middlegame' as const, planPhase: 'middlegame' as const, lineBefore: 'off' as const, lineAfter: 'off' as const };
    expect(replanTrigger({ ...mid, ply: 20, lastReplanPly: 20 - REPLAN_EVERY_PLIES + 1 })).toBeNull();
    expect(replanTrigger({ ...mid, ply: 20, lastReplanPly: 20 - REPLAN_EVERY_PLIES })).toBe('cadence');
    expect(replanTrigger({ ...mid, ply: 20, lastReplanPly: 18, everyPlies: 2 })).toBe('cadence');
    // never by cadence in the opening
    expect(replanTrigger({ ...base, lineBefore: 'off', lineAfter: 'off', ply: 30, lastReplanPly: 2 })).toBeNull();
  });
});

describe('replanCandidates: the engine\'s proven moves, with the code\'s ideas', () => {
  it('lines within the tolerance of the best (the best always), SAN + cp for the child + Russian ideas', () => {
    const fen = fenAfter(['e4', 'e5']);
    const candidates = replanCandidates(fen, [line(1, 19, ['g1f3', 'b8c6']), line(2, 8, ['b1c3']), line(3, -40, ['d1h5'])], { stage: 1, phase: 'opening' });
    expect(candidates.map((c) => [c.uci, c.san, c.cp])).toEqual([
      ['g1f3', 'Nf3', 19],
      ['b1c3', 'Nc3', 8],
    ]);
    expect(candidates[0]?.ideasRu.join(' ')).toMatch(/кон/);
    for (const c of candidates) for (const idea of c.ideasRu) expect(idea).not.toMatch(/[A-Za-z]/);
  });

  it('a mate is scored like the teacher scores it; duplicates, illegal and empty lines are skipped; at most three', () => {
    const fen = fenAfter(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']);
    const mate: EngineLine = { multipv: 1, depth: 12, cp: null, mate: 1, pvUci: ['h5f7'] };
    const candidates = replanCandidates(fen, [mate, line(2, 300, ['h5f7']), line(3, 250, ['a1a8']), line(4, 200, [])], { stage: 2 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ uci: 'h5f7', san: 'Qxf7#', cp: 99_900 });
    expect(replanCandidates(fen, [])).toEqual([]);
    const many = replanCandidates(fenAfter([]), [line(1, 20, ['e2e4']), line(2, 18, ['d2d4']), line(3, 17, ['g1f3']), line(4, 15, ['c2c4'])], { stage: 1, max: 3 });
    expect(many).toHaveLength(3);
  });

  it('positionAfter: the real move\'s position, or null', () => {
    expect(positionAfter(fenAfter([]), 'e2e4')).toMatchObject({ san: 'e4', over: false });
    expect(positionAfter(fenAfter([]), 'e2e5')).toBeNull();
    expect(positionAfter(fenAfter(['f3', 'e5', 'g4']), 'd8h4')).toMatchObject({ san: 'Qh4#', over: true });
  });
});
