import { describe, expect, it } from 'vitest';
import type { InterventionContext, MoveJudgement } from '@gambit/shared';
import {
  TEACHER_DEFAULT_MAX_STAGE,
  coachStylesFor,
  defaultCoachStyle,
  MIN_PLIES_BETWEEN_OFFERS,
  MIN_REMAINING_MS,
  TAKEBACK_BUDGET,
  decideIntervention,
  isExplainable,
  isWorthReviewing,
  takebackThresholdForStage,
} from './policy.ts';
import { queenBlunder } from './test-fixtures.ts';

/** A judgement that satisfies every take-back condition at stage 1. */
function bad(over: Partial<MoveJudgement> = {}): MoveJudgement {
  return queenBlunder({ winPctBefore: 55, winPctAfter: 25, winPctLoss: 30, materialLossPawns: 8, allowedMotif: 'hangingPiece', ...over });
}

function ctx(over: Partial<InterventionContext> = {}): InterventionContext {
  return { coachMode: 'full', stage: 1, offersMade: 0, remainingMs: 300_000, examMode: false, pliesSinceLastOffer: 99, ...over };
}

describe('takebackThresholdForStage', () => {
  it.each([
    [1, 20],
    [2, 20],
    [3, 20],
    [4, 15],
    [5, 15],
    [6, 15],
    [7, 12],
    [8, 12],
    [10, 12],
    [0, 20],
    [Number.NaN, 20],
  ])('stage %s → %s', (stage, threshold) => {
    expect(takebackThresholdForStage(stage)).toBe(threshold);
  });
});

describe('decideIntervention — every branch of ARCHITECTURE §5', () => {
  interface Row {
    name: string;
    j?: Partial<MoveJudgement>;
    ctx?: Partial<InterventionContext>;
    action: 'none' | 'offerTakeback' | 'logForReview';
    reason: string;
  }

  const rows: Row[] = [
    { name: 'all conditions hold → offer', action: 'offerTakeback', reason: 'offer' },

    // nothing to note
    { name: 'best move → none', j: { classification: 'best', winPctLoss: 0 }, action: 'none', reason: 'moveOk' },
    { name: 'good move → none', j: { classification: 'good', winPctLoss: 4 }, action: 'none', reason: 'moveOk' },
    { name: 'inaccuracy below 10 → none', j: { classification: 'inaccuracy', winPctLoss: 7 }, action: 'none', reason: 'moveOk' },
    { name: 'a fine move is "none" even with the coach off', j: { classification: 'best', winPctLoss: 0 }, ctx: { coachMode: 'off' }, action: 'none', reason: 'moveOk' },

    // coach mode / exam
    { name: 'coachMode off (bullet) → log only', ctx: { coachMode: 'off' }, action: 'logForReview', reason: 'coachOff' },
    { name: 'exam mode → log only', ctx: { examMode: true }, action: 'logForReview', reason: 'examMode' },

    // confidence
    { name: 'quick (unconfirmed) judgement → log only', j: { confidence: 'quick' }, action: 'logForReview', reason: 'notConfirmed' },

    // thresholds by stage
    { name: 'stage 3: loss 19.9 < 20', j: { classification: 'mistake', winPctLoss: 19.9 }, ctx: { stage: 3 }, action: 'logForReview', reason: 'belowThreshold' },
    { name: 'stage 3: loss 20 → offer', j: { winPctLoss: 20 }, ctx: { stage: 3 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'stage 4: loss 14.9 < 15', j: { classification: 'mistake', winPctLoss: 14.9 }, ctx: { stage: 4 }, action: 'logForReview', reason: 'belowThreshold' },
    { name: 'stage 4: loss 15 → offer', j: { classification: 'mistake', winPctLoss: 15 }, ctx: { stage: 4 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'stage 6: loss 15 → offer', j: { classification: 'mistake', winPctLoss: 15 }, ctx: { stage: 6 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'stage 1: loss 15 is not enough', j: { classification: 'mistake', winPctLoss: 15 }, ctx: { stage: 1 }, action: 'logForReview', reason: 'belowThreshold' },
    { name: 'stage 7: loss 11.9 < 12', j: { classification: 'mistake', winPctLoss: 11.9 }, ctx: { stage: 7 }, action: 'logForReview', reason: 'belowThreshold' },
    { name: 'stage 7: loss 12 → offer', j: { classification: 'mistake', winPctLoss: 12 }, ctx: { stage: 7 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'stage 9: loss 12 → offer', j: { classification: 'mistake', winPctLoss: 12 }, ctx: { stage: 9 }, action: 'offerTakeback', reason: 'offer' },

    // explainability
    { name: 'no material, no mate, no motif → not explainable', j: { materialLossPawns: 0, allowedMotif: undefined }, action: 'logForReview', reason: 'notExplainable' },
    { name: '1 pawn only, no motif → not explainable', j: { materialLossPawns: 1, allowedMotif: undefined }, action: 'logForReview', reason: 'notExplainable' },
    { name: 'material ≥ 2 alone is explainable', j: { materialLossPawns: 2, allowedMotif: undefined }, action: 'offerTakeback', reason: 'offer' },
    { name: 'a recognised motif alone is explainable', j: { materialLossPawns: 0, allowedMotif: 'fork' }, action: 'offerTakeback', reason: 'offer' },
    { name: 'mated in 3 alone is explainable', j: { materialLossPawns: 0, allowedMotif: undefined, evalAfter: { cp: null, mate: -3 } }, action: 'offerTakeback', reason: 'offer' },
    { name: 'mated in 1 alone is explainable', j: { materialLossPawns: 0, allowedMotif: undefined, evalAfter: { cp: null, mate: -1 } }, action: 'offerTakeback', reason: 'offer' },
    { name: 'mated in 4 is too deep', j: { materialLossPawns: 0, allowedMotif: undefined, evalAfter: { cp: null, mate: -4 } }, action: 'logForReview', reason: 'notExplainable' },
    { name: "the child's own mate (+3) does not count", j: { materialLossPawns: 0, allowedMotif: undefined, evalAfter: { cp: null, mate: 3 } }, action: 'logForReview', reason: 'notExplainable' },

    // already lost
    { name: 'winPctBefore 14.9 → already lost', j: { winPctBefore: 14.9 }, action: 'logForReview', reason: 'alreadyLost' },
    { name: 'winPctBefore exactly 15 → offer', j: { winPctBefore: 15 }, action: 'offerTakeback', reason: 'offer' },

    // budget
    { name: 'full: third offer still allowed', ctx: { coachMode: 'full', offersMade: 2 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'full: budget of 3 exhausted', ctx: { coachMode: 'full', offersMade: 3 }, action: 'logForReview', reason: 'budgetExhausted' },
    { name: 'light: first offer allowed', ctx: { coachMode: 'light', offersMade: 0 }, action: 'offerTakeback', reason: 'offer' },
    // 5 minutes: the child's clock stands while Гамбитик speaks — the same three offers as 10 minutes
    { name: 'light: the third offer is still allowed', ctx: { coachMode: 'light', offersMade: 2 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'light: budget of 3 exhausted', ctx: { coachMode: 'light', offersMade: 3 }, action: 'logForReview', reason: 'budgetExhausted' },

    // cooldown
    { name: '3 plies since the last offer → cooldown', j: { materialLossPawns: 3 }, ctx: { offersMade: 1, pliesSinceLastOffer: 3 }, action: 'logForReview', reason: 'cooldown' },
    { name: '4 plies since the last offer → offer', j: { materialLossPawns: 3 }, ctx: { offersMade: 1, pliesSinceLastOffer: 4 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'hanging the queen again 2 plies later skips the cooldown', j: { materialLossPawns: 8 }, ctx: { offersMade: 1, pliesSinceLastOffer: 2 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'losing a rook (5) skips the cooldown', j: { materialLossPawns: 5 }, ctx: { offersMade: 1, pliesSinceLastOffer: 2 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'walking into mate in 2 skips the cooldown', j: { materialLossPawns: 0, allowedMotif: undefined, evalAfter: { cp: null, mate: -2 } }, ctx: { offersMade: 1, pliesSinceLastOffer: 2 }, action: 'offerTakeback', reason: 'offer' },
    { name: 'severe blunders still respect the budget', j: { materialLossPawns: 8 }, ctx: { offersMade: 3, pliesSinceLastOffer: 2 }, action: 'logForReview', reason: 'budgetExhausted' },
    { name: 'no offer yet → pliesSinceLastOffer is irrelevant', ctx: { offersMade: 0, pliesSinceLastOffer: 0 }, action: 'offerTakeback', reason: 'offer' },

    // time guard
    { name: 'untimed game → offer', ctx: { remainingMs: null }, action: 'offerTakeback', reason: 'offer' },
    { name: 'exactly 30 s left → time trouble', ctx: { remainingMs: 30_000 }, action: 'logForReview', reason: 'timeTrouble' },
    { name: '30.001 s left → offer', ctx: { remainingMs: 30_001 }, action: 'offerTakeback', reason: 'offer' },
    { name: '5 s left → time trouble', ctx: { remainingMs: 5_000 }, action: 'logForReview', reason: 'timeTrouble' },

    // missed win is remembered but (without a concrete refutation) never interrupts
    { name: 'missed win without refutation → log', j: { classification: 'missedWin', winPctLoss: 30, materialLossPawns: 0, allowedMotif: undefined }, action: 'logForReview', reason: 'notExplainable' },
    { name: 'missedWin with a tiny loss is still logged', j: { classification: 'missedWin', winPctLoss: 3, materialLossPawns: 0, allowedMotif: undefined }, action: 'logForReview', reason: 'belowThreshold' },
  ];

  it.each(rows)('$name', (row) => {
    expect(decideIntervention(bad(row.j), ctx(row.ctx))).toEqual({ action: row.action, reason: row.reason });
  });

  it('reports the FIRST failed condition (documented order)', () => {
    const everythingWrong = bad({ confidence: 'quick', winPctLoss: 11, classification: 'mistake', winPctBefore: 5, materialLossPawns: 0, allowedMotif: undefined });
    const c = ctx({ coachMode: 'off', examMode: true, offersMade: 9, pliesSinceLastOffer: 0, remainingMs: 1 });
    expect(decideIntervention(everythingWrong, c).reason).toBe('coachOff');
    expect(decideIntervention(everythingWrong, { ...c, coachMode: 'light' }).reason).toBe('examMode');
    expect(decideIntervention(everythingWrong, { ...c, coachMode: 'light', examMode: false }).reason).toBe('notConfirmed');
  });

  it('never offers when the coach is off, whatever else is true', () => {
    for (const stage of [1, 4, 7]) {
      expect(decideIntervention(bad(), ctx({ coachMode: 'off', stage })).action).toBe('logForReview');
    }
  });

  it('exposes the constants used by the policy', () => {
    expect(TAKEBACK_BUDGET).toEqual({ off: 0, light: 3, full: 3 });
    expect(MIN_PLIES_BETWEEN_OFFERS).toBe(4);
    expect(MIN_REMAINING_MS).toBe(30_000);
  });
});

describe('decideIntervention — a new try right after a take-back', () => {
  const retry = { retryAfterTakeback: true };
  // the child took the offered move back: the new move is played at the SAME ply → 0 plies since the offer
  const sameMove = ctx({ offersMade: 1, pliesSinceLastOffer: 0 });

  it('another losing move from the same position is offered again at once — the cooldown does not apply', () => {
    const minor = bad({ materialLossPawns: 3 }); // not severe: without the retry the cooldown would hold it back
    expect(decideIntervention(minor, sameMove)).toEqual({ action: 'logForReview', reason: 'cooldown' });
    expect(decideIntervention(minor, sameMove, retry)).toEqual({ action: 'offerTakeback', reason: 'offer' });
  });

  it('only the cooldown is skipped: the budget, the threshold, the clock and the exam still decide', () => {
    expect(decideIntervention(bad({ materialLossPawns: 3 }), ctx({ offersMade: 3, pliesSinceLastOffer: 0 }), retry).reason).toBe('budgetExhausted');
    expect(decideIntervention(bad({ classification: 'mistake', winPctLoss: 12 }), sameMove, retry).reason).toBe('belowThreshold');
    expect(decideIntervention(bad({ materialLossPawns: 3 }), ctx({ offersMade: 1, pliesSinceLastOffer: 0, remainingMs: 20_000 }), retry).reason).toBe('timeTrouble');
    expect(decideIntervention(bad(), ctx({ examMode: true }), retry).reason).toBe('examMode');
    expect(decideIntervention(bad({ classification: 'best', winPctLoss: 0 }), sameMove, retry)).toEqual({ action: 'none', reason: 'moveOk' });
  });
});

describe('isExplainable / isWorthReviewing', () => {
  it('isExplainable', () => {
    expect(isExplainable(bad({ materialLossPawns: 3, allowedMotif: undefined }))).toBe(true);
    expect(isExplainable(bad({ materialLossPawns: 0, allowedMotif: 'pin' }))).toBe(true);
    expect(isExplainable(bad({ materialLossPawns: 0, allowedMotif: undefined }))).toBe(false);
  });

  it('isWorthReviewing', () => {
    expect(isWorthReviewing(bad({ classification: 'good', winPctLoss: 3 }))).toBe(false);
    expect(isWorthReviewing(bad({ classification: 'inaccuracy', winPctLoss: 10 }))).toBe(true);
    expect(isWorthReviewing(bad({ classification: 'mistake', winPctLoss: 9 }))).toBe(true);
    expect(isWorthReviewing(bad({ classification: 'blunder', winPctLoss: 40 }))).toBe(true);
  });
});

describe('coach styles — T11 of TEACHER-MODE §8.2 (§1.2 table)', () => {
  it('the defaults: teacher on stages 1–5 in training, 10 and 5 minutes; helper beyond', () => {
    expect(TEACHER_DEFAULT_MAX_STAGE).toBe(5);
    expect(defaultCoachStyle('training', 2)).toBe('teacher');
    expect(defaultCoachStyle('training', 1)).toBe('teacher');
    expect(defaultCoachStyle('rapid10', 4)).toBe('teacher');
    expect(defaultCoachStyle('rapid10', 5)).toBe('teacher');
    expect(defaultCoachStyle('rapid10', 6)).toBe('helper');
    expect(defaultCoachStyle('training', 5)).toBe('teacher');
    expect(defaultCoachStyle('training', 7)).toBe('helper');
    // 5-minute games get the teacher by default too
    expect(defaultCoachStyle('blitz5', 1)).toBe('teacher');
    expect(defaultCoachStyle('blitz5', 4)).toBe('teacher');
    expect(defaultCoachStyle('blitz5', 5)).toBe('teacher');
    expect(defaultCoachStyle('blitz5', 6)).toBe('helper');
    // every stage of the curriculum (1–5) defaults to the teacher wherever it is offered
    for (let stage = 1; stage <= 5; stage++) for (const tc of ['training', 'rapid10', 'blitz5'] as const) expect(defaultCoachStyle(tc, stage)).toBe('teacher');
    expect(defaultCoachStyle('rapid10', Number.NaN)).toBe('teacher');
    // bullet: nothing to choose — the harmless 'helper'
    expect(defaultCoachStyle('bullet1', 1)).toBe('helper');
  });

  it('the choices per time control: the teacher in 5, 10 minutes and training, nothing in bullet', () => {
    expect(coachStylesFor('training')).toEqual(['teacher', 'helper', 'exam']);
    expect(coachStylesFor('rapid10')).toEqual(['teacher', 'helper', 'exam']);
    expect(coachStylesFor('blitz5')).toEqual(['teacher', 'helper', 'exam']);
    expect(coachStylesFor('bullet1')).toEqual([]);
    // a copy — callers may not mutate the table
    coachStylesFor('training').pop();
    expect(coachStylesFor('training')).toHaveLength(3);
  });

  it('the default is always one of the offered styles (where there are any)', () => {
    for (const tc of ['training', 'rapid10', 'blitz5'] as const) {
      for (let stage = 1; stage <= 10; stage++) expect(coachStylesFor(tc)).toContain(defaultCoachStyle(tc, stage));
    }
  });
});
