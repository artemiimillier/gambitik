/**
 * Mini-lessons (docs/TEACHING.md §2.6, §6.6): the triggers on real positions, the slots of a game, the levels of
 * the learner model and the cross-game spacing.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { explainMove } from '../moveIdeas.ts';
import { createLessonBook, emptyLessonHistory, restoreLessonHistory } from './book.ts';
import type { LessonHistory } from './book.ts';
import { initialLessonMemory } from './memory.ts';
import { IDEA_MINI, WHY_MINI_GAMES, adviceMiniTopics, dangerMiniTopic, decideMini, miniLevel, recallMiniTopic, whyMini } from './mini.ts';

function fenOf(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function advice(fen: string, san: string): { uci: string; san: string; allIdeas: ReturnType<typeof explainMove> } {
  const m = new Chess(fen).move(san);
  const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
  return { uci, san: m.san, allIdeas: explainMove({ fen, uci }) };
}

function history(over: Partial<LessonHistory> = {}): LessonHistory {
  return { ...emptyLessonHistory(), ...over };
}

describe('the triggers of §6.6', () => {
  it('the third move of every teacher game is «как думать» (first)', () => {
    const fen = fenOf(['e4', 'e5', 'Nf3', 'Nc6']);
    const topics = adviceMiniTopics({ fen, childColor: 'w', ply: 5, turnNo: 3, advice: advice(fen, 'Bc4'), opponent: null, proof: null });
    expect(topics[0]).toBe('thinking');
  });

  it('castling «now»: the advice is the castle', () => {
    const fen = fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    const topics = adviceMiniTopics({ fen, childColor: 'w', ply: 7, turnNo: 4, advice: advice(fen, 'O-O'), opponent: null, proof: null });
    expect(topics).toContain('castle');
  });

  it('the early queen: the opponent brought her out and the advice attacks her', () => {
    const fen = fenOf(['e4', 'e5', 'Qh5']);
    const topics = adviceMiniTopics({ fen, childColor: 'b', ply: 4, turnNo: 2, advice: advice(fen, 'Nf6'), opponent: { earlyQueen: true }, proof: null });
    expect(topics).toContain('earlyQueen');
    const calm = adviceMiniTopics({ fen, childColor: 'b', ply: 4, turnNo: 2, advice: advice(fen, 'Nf6'), opponent: { earlyQueen: false }, proof: null });
    expect(calm).not.toContain('earlyQueen');
  });

  it('the opening words wait for turn 4 (turn 3 belongs to «как думать»)', () => {
    const fen = fenOf(['e4', 'e5']);
    expect(adviceMiniTopics({ fen, childColor: 'w', ply: 3, turnNo: 2, advice: advice(fen, 'Nf3'), opponent: null, proof: null })).not.toContain('development');
    expect(adviceMiniTopics({ fen, childColor: 'w', ply: 3, turnNo: 5, advice: advice(fen, 'Nf3'), opponent: null, proof: null })).toContain('development');
  });

  it('the danger minis: hanging, check, scholar\'s mate, back rank, fork', () => {
    expect(dangerMiniTopic({ kind: 'hanging' })).toBe('hanging');
    expect(dangerMiniTopic({ kind: 'check' })).toBe('checkEscape');
    expect(dangerMiniTopic({ kind: 'mate', conceptId: 'scholars-mate' })).toBe('scholarsMate');
    expect(dangerMiniTopic({ kind: 'mate', conceptId: 'back-rank-mate' })).toBe('backRank');
    expect(dangerMiniTopic({ kind: 'mate' })).toBe('mateInOne');
    expect(dangerMiniTopic({ kind: 'threat', conceptId: 'fork' })).toBe('fork');
    expect(dangerMiniTopic({ kind: 'threat' })).toBeNull();
    expect(IDEA_MINI.develop).toBe('development');
    expect(recallMiniTopic('mistake.hanging')).toBe('hanging');
  });
});

describe('slots and levels', () => {
  const lm = initialLessonMemory();

  it('one opening and one tactic/safety mini a game; blitz one at all; the topic fits the stage', () => {
    expect(decideMini(['pin', 'castle'], { stage: 2, blitz: false, lm, history: null })?.topic).toBe('castle'); // pin is stage 3+
    const openingUsed = { ...lm, minis: [{ turn: 3, ply: 5, topic: 'thinking', level: 1, slot: 'opening' as const }] };
    expect(decideMini(['castle', 'hanging'], { stage: 2, blitz: false, lm: openingUsed, history: null })?.topic).toBe('hanging');
    const tacticUsed = { ...lm, minis: [{ turn: 3, ply: 5, topic: 'kingActive', level: 1, slot: 'endgame' as const }] };
    expect(decideMini(['hanging', 'castle'], { stage: 2, blitz: false, lm: tacticUsed, history: null })?.topic).toBe('castle');
    expect(decideMini(['hanging', 'castle'], { stage: 2, blitz: true, lm: openingUsed, history: null })).toBeNull();
    // blitz: «как думать» only — no danger mini-lesson, no opening lesson
    expect(decideMini(['hanging', 'checkEscape', 'castle'], { stage: 2, blitz: true, lm, history: null })).toBeNull();
    expect(decideMini(['hanging', 'thinking'], { stage: 2, blitz: true, lm, history: null })?.topic).toBe('thinking');
    expect(decideMini(['castle'], { stage: 2, blitz: false, lm, history: null, has: () => false })).toBeNull();
    expect(decideMini(['castle', 'hanging'], { stage: 2, blitz: false, lm, history: null, recallTopic: 'hanging' })?.topic).toBe('hanging');
  });

  it('l1 first; the next level once the child showed it; the same level not in two games in a row; retired topics rest', () => {
    expect(miniLevel('castle', null)).toBe(1);
    expect(miniLevel('castle', history({ gameSeq: 4, minis: { castle: { level: 1, lastGame: 3, shown: 0 } } }))).toBeNull();
    expect(miniLevel('castle', history({ gameSeq: 5, minis: { castle: { level: 1, lastGame: 3, shown: 0 } } }))).toBe(1);
    expect(miniLevel('castle', history({ gameSeq: 4, minis: { castle: { level: 1, lastGame: 3, shown: 1 } } }))).toBe(2);
    expect(miniLevel('castle', history({ gameSeq: 9, minis: { castle: { level: 3, lastGame: 3, shown: 1 } } }))).toBe(3);
    expect(miniLevel('castle', history({ gameSeq: 9, minis: { castle: { level: 3, lastGame: 3, shown: 2, retired: true } } }))).toBeNull();
    const decided = decideMini(['castle'], { stage: 2, blitz: false, lm, history: history({ gameSeq: 4, minis: { castle: { level: 1, lastGame: 3, shown: 1 } } }) });
    expect(decided).toEqual({ topic: 'castle', level: 2, slot: 'opening' });
  });

  it('showings count from the level\'s telling — never l3 without a showing after l2; retired after two showings past l3', () => {
    const b = createLessonBook({ seed: 1 });
    const level = (): 1 | 2 | 3 | null => miniLevel('freeCapture', b.history());
    // game 0: l1 heard, then shown twice (a right «Да, бесплатно» and a found free capture)
    b.learner.miniTold('freeCapture', 1);
    b.learner.miniShown('freeCapture');
    b.learner.miniShown('freeCapture');
    b.finishGame();
    // game 1: l2
    expect(level()).toBe(2);
    b.learner.miniTold('freeCapture', 2);
    expect(b.history().minis.freeCapture).toMatchObject({ level: 2, shown: 0 });
    b.finishGame();
    // game 2: nothing shown since l2 — not l3, and not l2 two games in a row
    expect(level()).toBeNull();
    b.finishGame();
    // game 3: l2 again; shown now
    expect(level()).toBe(2);
    b.learner.miniTold('freeCapture', 2);
    b.learner.miniShown('freeCapture');
    b.finishGame();
    // game 4: l3; one showing after it does not retire the topic, the second does
    expect(level()).toBe(3);
    b.learner.miniTold('freeCapture', 3);
    b.learner.miniShown('freeCapture');
    expect(b.history().minis.freeCapture).toMatchObject({ level: 3, shown: 1 });
    expect(b.history().minis.freeCapture?.retired).toBeUndefined();
    b.learner.miniShown('freeCapture');
    expect(b.history().minis.freeCapture?.retired).toBe(true);
    b.finishGame();
    expect(level()).toBeNull();
  });

  it('an older save with a running total of showings still loads and advances', () => {
    const old = restoreLessonHistory({ v: 1, gameSeq: 5, minis: { castle: { level: 2, lastGame: 3, shown: 3 } } });
    expect(old.minis.castle).toEqual({ level: 2, lastGame: 3, shown: 3 });
    expect(miniLevel('castle', old)).toBe(3);
  });
});

describe('«Почему так?» mini-lesson (§2.3, §2.6)', () => {
  const lm = initialLessonMemory();
  const has = (): boolean => true;

  it('the child\'s level, not l1 again; spaced across games; not a topic of this game; only at its stages', () => {
    expect(whyMini('castle', { stage: 2, lm, history: history(), has })).toEqual({ topic: 'castle', level: 1 });
    // heard l1 and showed it — l2
    expect(whyMini('castle', { stage: 2, lm, history: history({ gameSeq: 6, minis: { castle: { level: 1, lastGame: 1, shown: 1 } } }), has })).toEqual({ topic: 'castle', level: 2 });
    // told within the last WHY_MINI_GAMES games — no
    expect(whyMini('castle', { stage: 2, lm, history: history({ gameSeq: 6, minis: { castle: { level: 1, lastGame: 6 - WHY_MINI_GAMES + 1, shown: 1 } } }), has })).toBeNull();
    expect(whyMini('castle', { stage: 2, lm, history: history({ gameSeq: 6, minis: { castle: { level: 1, lastGame: 6 - WHY_MINI_GAMES, shown: 1 } } }), has })).toEqual({ topic: 'castle', level: 2 });
    // retired, told this game, out of its stages, no words
    expect(whyMini('castle', { stage: 2, lm, history: history({ gameSeq: 9, minis: { castle: { level: 3, lastGame: 1, shown: 2, retired: true } } }), has })).toBeNull();
    expect(whyMini('castle', { stage: 2, lm: { ...lm, minis: [{ turn: 2, ply: 3, topic: 'castle', level: 1, slot: 'opening' }] }, history: history(), has })).toBeNull();
    expect(whyMini('hanging', { stage: 4, lm, history: history(), has })).toBeNull();
    expect(whyMini('castle', { stage: 2, lm, history: history(), has: () => false })).toBeNull();
    expect(whyMini(undefined, { stage: 2, lm, history: history(), has })).toBeNull();
  });
});
