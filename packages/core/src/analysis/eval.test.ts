import { describe, expect, it } from 'vitest';
import type { EvalScore, MoveJudgement } from '@gambit/shared';
import { classifyByLoss, classifyMove, finalJudgements, gameAccuracy, moveAccuracy, scoreToCp, toMoverPov, winPct } from './eval.ts';

const cp = (value: number): EvalScore => ({ cp: value, mate: null });
const mate = (n: number): EvalScore => ({ cp: null, mate: n });

function judgement(ply: number, before: number, after: number, extra: Partial<MoveJudgement> = {}): MoveJudgement {
  return {
    ply,
    color: ply % 2 === 1 ? 'w' : 'b',
    san: 'e4',
    uci: 'e2e4',
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    evalBefore: cp(0),
    evalAfter: cp(0),
    winPctBefore: before,
    winPctAfter: after,
    winPctLoss: Math.max(0, before - after),
    classification: 'good',
    accuracy: moveAccuracy(before, after),
    bestUci: 'e2e4',
    bestSan: 'e4',
    bestPvSan: ['e4'],
    refutationPvSan: [],
    refutationPvUci: [],
    materialLossPawns: 0,
    confidence: 'quick',
    ...extra,
  };
}

describe('winPct (lichess formula)', () => {
  it('matches the verified reference values', () => {
    expect(winPct(cp(0))).toBe(50);
    expect(winPct(cp(100))).toBeCloseTo(59.1, 2);
    expect(winPct(cp(200))).toBeCloseTo(67.62, 2);
    expect(winPct(cp(300))).toBeCloseTo(75.11, 2);
    expect(winPct(cp(500))).toBeCloseTo(86.31, 2);
    expect(winPct(cp(900))).toBeCloseTo(96.49, 2);
  });

  it('is symmetric and clamps centipawns to ±1000', () => {
    expect(winPct(cp(-300))).toBeCloseTo(100 - winPct(cp(300)), 10);
    expect(winPct(cp(2500))).toBe(winPct(cp(1000)));
    expect(winPct(cp(-2500))).toBe(winPct(cp(-1000)));
  });

  it('treats any mate as ±1000 cp (lichess server convention)', () => {
    expect(winPct(mate(1))).toBe(winPct(cp(1000)));
    expect(winPct(mate(12))).toBe(winPct(cp(1000)));
    expect(winPct(mate(-3))).toBe(winPct(cp(-1000)));
    expect(winPct(mate(0))).toBe(winPct(cp(-1000))); // raw UCI: the side to move is checkmated
    expect(scoreToCp(mate(2))).toBe(1000);
    expect(scoreToCp(cp(-1234))).toBe(-1000);
  });
});

describe('moveAccuracy (lila AccuracyPercent)', () => {
  it('is 100 when the win% did not drop', () => {
    expect(moveAccuracy(50, 50)).toBe(100);
    expect(moveAccuracy(40, 63)).toBe(100);
  });

  it('applies the exponential formula with the +1 bonus', () => {
    const drop = 25.11;
    const expected = 103.1668100711649 * Math.exp(-0.04354415386753951 * drop) - 3.166924740191411 + 1;
    expect(moveAccuracy(50, 50 - drop)).toBeCloseTo(expected, 10);
    expect(moveAccuracy(50, 50 - drop)).toBeCloseTo(32.4, 1); // "a piece blundered from equality ≈ 32"
    expect(moveAccuracy(60, 55)).toBeCloseTo(80.82, 1);
  });

  it('is clamped to 0..100', () => {
    expect(moveAccuracy(100, 0)).toBe(0);
    expect(moveAccuracy(50, 49.999)).toBeLessThanOrEqual(100);
    expect(moveAccuracy(50, 49.999)).toBeGreaterThan(99);
  });
});

describe('toMoverPov', () => {
  it('keeps the score when the mover is to move and negates it otherwise', () => {
    expect(toMoverPov(cp(35), 'w', 'w')).toEqual(cp(35));
    expect(toMoverPov(cp(35), 'b', 'w')).toEqual(cp(-35));
    expect(toMoverPov(mate(3), 'b', 'w')).toEqual(mate(-3));
    expect(toMoverPov(mate(-2), 'w', 'b')).toEqual(mate(2));
  });

  it('never produces -0 and encodes a delivered mate as mate 1', () => {
    expect(Object.is(toMoverPov(cp(0), 'b', 'w').cp, 0)).toBe(true);
    expect(toMoverPov(mate(0), 'b', 'w')).toEqual(mate(1));
  });

  it('strips engine-line extras', () => {
    const line = { cp: 12, mate: null, multipv: 1, depth: 14, pvUci: ['e2e4'] };
    expect(toMoverPov(line, 'w', 'w')).toEqual({ cp: 12, mate: null });
  });
});

describe('classifyMove', () => {
  const byLoss = (loss: number, isBest = false) =>
    classifyMove({ winPctBefore: 60, winPctAfter: 60 - loss, evalBefore: cp(110), evalAfter: cp(0), isBest });

  it('uses the win%-loss thresholds 1 / 2 / 5 / 10 / 20', () => {
    expect(byLoss(0)).toBe('best');
    expect(byLoss(0.99)).toBe('best');
    expect(byLoss(1)).toBe('excellent');
    expect(byLoss(1.99)).toBe('excellent');
    expect(byLoss(2)).toBe('good');
    expect(byLoss(4.99)).toBe('good');
    expect(byLoss(5)).toBe('inaccuracy');
    expect(byLoss(9.99)).toBe('inaccuracy');
    expect(byLoss(10)).toBe('mistake');
    expect(byLoss(19.99)).toBe('mistake');
    expect(byLoss(20)).toBe('blunder');
    expect(byLoss(55)).toBe('blunder');
    expect(classifyByLoss(-3)).toBe('best');
  });

  it("the engine's first choice is always best", () => {
    expect(byLoss(30, true)).toBe('best');
  });

  it('a gain is never punished', () => {
    expect(classifyMove({ winPctBefore: 40, winPctAfter: 55, evalBefore: cp(-100), evalAfter: cp(50), isBest: false })).toBe('best');
  });

  const classify = (before: EvalScore, after: EvalScore) =>
    classifyMove({ winPctBefore: winPct(before), winPctAfter: winPct(after), evalBefore: before, evalAfter: after, isBest: false });

  it('MateCreated as in lila: blunder, softened when already lost', () => {
    expect(classify(cp(30), mate(-2))).toBe('blunder');
    expect(classify(cp(-650), mate(-2))).toBe('blunder');
    expect(classify(cp(-800), mate(-4))).toBe('mistake');
    expect(classify(cp(-1200), mate(-4))).toBe('inaccuracy');
  });

  it('MateLost as in lila, with missedWin when little is kept', () => {
    expect(classify(mate(2), cp(1200))).toBe('inaccuracy');
    expect(classify(mate(2), cp(850))).toBe('mistake');
    expect(classify(mate(2), cp(450))).toBe('blunder');
    expect(classify(mate(2), cp(60))).toBe('missedWin');
    expect(classify(mate(2), cp(-450))).toBe('blunder');
    expect(classify(mate(1), mate(-1))).toBe('blunder');
  });

  it('MateDelayed and long-mate noise are not punished', () => {
    expect(classify(mate(2), mate(4))).toBe('best');
    expect(classify(mate(-3), mate(-1))).toBe('best');
    // a mate in 9 that "disappears" while staying +9 is judged by win% only
    expect(classify(mate(9), cp(900))).toBe('excellent');
  });

  it('missedWin: ≥ +5 was available, less than +2 is kept, position not bad', () => {
    expect(classify(cp(620), cp(40))).toBe('missedWin');
    expect(classify(cp(620), cp(-150))).toBe('missedWin');
    expect(classify(cp(620), cp(-320))).toBe('blunder');
    expect(classify(cp(620), cp(250))).toBe('mistake');
    expect(classify(cp(480), cp(40))).toBe('blunder'); // not "winning" before → ordinary ladder
  });
});

describe('gameAccuracy (lila: mean of volatility-weighted and harmonic means)', () => {
  it('returns 0 without moves and 100 for a flawless game', () => {
    expect(gameAccuracy([])).toBe(0);
    expect(gameAccuracy([judgement(1, 52, 52), judgement(3, 53, 53), judgement(5, 55, 56)])).toBe(100);
  });

  it('matches a hand-computed example', () => {
    // values [50, 50, 50, 25] → 3 plies → window 2 → weights: sd[50,50]=0→0.5, (opponent ply), sd[50,25]=12.5→12
    const accBad = 103.1668100711649 * Math.exp(-0.04354415386753951 * 25) - 3.166924740191411 + 1;
    const weighted = (100 * 0.5 + accBad * 12) / 12.5;
    const harmonic = 2 / (1 / 100 + 1 / accBad);
    const expected = (weighted + harmonic) / 2;
    expect(gameAccuracy([judgement(1, 50, 50), judgement(3, 50, 25)])).toBeCloseTo(expected, 10);
    expect(expected).toBeCloseTo(42.2, 1);
  });

  it('weights a blunder in a volatile stretch more than quiet moves', () => {
    const quiet = Array.from({ length: 19 }, (_, i) => judgement(2 * i + 1, 55, 55));
    const withBlunder = [...quiet, judgement(39, 55, 20)];
    const accuracy = gameAccuracy(withBlunder);
    const plainMean = (19 * 100 + moveAccuracy(55, 20)) / 20;
    expect(accuracy).toBeLessThan(plainMean);
    expect(accuracy).toBeGreaterThan(0);
  });

  it('handles Black (initial position prepended) and ignores taken-back attempts', () => {
    const black = [judgement(2, 48, 48), judgement(4, 47, 30)];
    expect(gameAccuracy(black)).toBeGreaterThan(0);
    expect(gameAccuracy(black)).toBeLessThan(100);

    const takenBack = judgement(3, 50, 5, { san: 'Qg5', uci: 'h5g5' });
    const retry = judgement(3, 50, 50);
    expect(gameAccuracy([judgement(1, 50, 50), takenBack, retry])).toBe(100);
    expect(finalJudgements([judgement(1, 50, 50), takenBack, retry]).map((j) => j.uci)).toEqual(['e2e4', 'e2e4']);
  });
});
