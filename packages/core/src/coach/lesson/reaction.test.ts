/**
 * The reaction half of the lesson director (docs/TEACHING.md §2.5, §2.8, §2.9) through the director API:
 * praise / outcome / mistake right after the child's move, the take-back offer and reply, the end with ONE takeaway.
 *
 * Every pool is filled here with neutral test wordings (a piece placeholder where the pool has a subject), so the
 * tests do not depend on the library's words: they assert the pools (`say`), the event shape, the cues and the
 * memory — never the words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoachEvent, TeachAdvice } from '@gambit/shared';
import { getStrategy } from '@gambit/content';

vi.mock('@gambit/content', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@gambit/content')>();
  const cache = new Map<string, unknown>();
  const lessonLine = (id: string): unknown => {
    const spec = orig.lessonPoolSpec(id);
    if (!spec) return undefined;
    if (!cache.has(id)) {
      const wordings = spec.subject ? [{ t: 'Проба {конь} раз.' }, { t: 'Проба {конь} два.' }] : [{ t: 'Проба раз.' }, { t: 'Проба два.' }];
      // an 11-word wording beside short ones, and a pool with nothing but it (praise keeps to ≤ 10 words)
      const long = 'Проба один два три четыре пять шесть семь восемь девять десять.';
      // the lesson of the found tactic by its motif (the words exist only per variant here)
      if (id === 'v3.takeaway.found.tactic') cache.set(id, { ...spec, variants: ['fork', 'pin'], wordings: [{ t: 'Проба вилка.', when: ['fork'] }, { t: 'Проба связка.', when: ['pin'] }] });
      else if (id === 'v3.praise.centerPawn') cache.set(id, { ...spec, wordings: [{ t: long }, { t: 'Проба раз.' }, { t: 'Проба два.' }] });
      else if (id === 'v3.praise.castled') cache.set(id, { ...spec, wordings: [{ t: long }] });
      else cache.set(id, { ...spec, wordings });
    }
    return cache.get(id);
  };
  return { ...orig, lessonLine };
});

import { backRankBlunder, forkBlunder, judgement, profile, queenBlunder } from '../test-fixtures.ts';
import { expectedSentenceText } from '../clips/lessonPlan.ts';
import { initialTeachMemory } from '../teacher.ts';
import { restoreTeachMemory } from './memory.ts';
import { mistakeSaidAbout } from './mistake.ts';
import type { TeachMemory } from '../teacher.ts';
import { createLessonBook } from './book.ts';
import type { LessonBook } from './book.ts';
import type { LessonReactionArgs } from './director.ts';
import { REACTION_IMPL } from './reaction.ts';
import { initialLessonMemory } from './memory.ts';
import type { LessonMemory } from './types.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// the reaction half alone; one test below goes through the installed director
const { lessonEnd, lessonReaction, lessonTakebackOffer, lessonTakebackReply } = REACTION_IMPL;

const good = { winPctLoss: 0.3, classification: 'best' as const, winPctBefore: 55, winPctAfter: 55, evalAfter: { cp: 30, mate: null } };

function mem(lesson: Partial<LessonMemory> = {}): TeachMemory {
  return { ...initialTeachMemory(), lesson: { ...initialLessonMemory(), ...lesson } };
}

function book(history?: unknown): LessonBook {
  return createLessonBook({ seed: 7, ...(history ? { history } : {}) });
}

function args(over: Partial<LessonReactionArgs> & Pick<LessonReactionArgs, 'judgement'>): LessonReactionArgs {
  return { profile: profile({ stage: 2 }), tc: 'training', advice: [], adviceShown: true, historySan: [], ...over };
}

const pools = (e: CoachEvent | null | undefined): string[] => (e?.say ?? []).map((s) => s.pool);

/**
 * Every lesson event: words from the book (`say`), no recorded clip, no brief for a live voice; `saySentences` rebuild the
 * text sentence by sentence from the ids (what the recorded voice plays and records), every part in exactly one.
 */
function expectV3(e: CoachEvent): void {
  expect(e.say?.length ?? 0).toBeGreaterThan(0);
  expect(e.clip).toBeUndefined();
  expect(e.brief).toBeUndefined();
  expect(e.text).toBe(e.bubbleText);
  const say = e.say ?? [];
  const ss = e.saySentences ?? [];
  expect(ss.map((s) => s.text).join(' ')).toBe(e.text);
  expect(ss.flatMap((s) => s.parts)).toEqual(say.map((_, i) => i));
  for (const s of ss) expect(expectedSentenceText(s.parts.map((k) => say[k] as NonNullable<(typeof say)[number]>))).toBe(s.text);
}

describe('lessonReaction: praise for a deed', () => {
  it('an own knight-first move: specific praise, kind praise, the reason is remembered once a game', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    const b = book();
    const r = lessonReaction(args({ judgement: j, adviceShown: false, strategyCard: getStrategy('italian') ?? null, historySan: ['e4', 'e5', 'Nf3'] }), mem({ turn: 2 }), b);
    expect(r.now?.kind).toBe('praise');
    expect(pools(r.now)).toEqual(['v3.praise.knightFirst']);
    expect(r.now?.pose).toBe('cheer');
    expectV3(r.now as CoachEvent);
    expect(r.memory.lesson?.praises).toEqual([{ turn: 2, reason: 'knightFirst' }]);
    expect(b.history().habits.knightFirst).toEqual([0]);
    // the same reason is not praised again this game — the next true reason is
    const again = lessonReaction(args({ judgement: j, adviceShown: false, strategyCard: getStrategy('italian') ?? null, historySan: ['e4', 'e5', 'Nf3'] }), r.memory, b);
    expect(pools(again.now)).toEqual(['v3.praise.developed']);
  });

  it('a found fork: the actor piece in the words, the find in memory', () => {
    const j = judgement({ fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', played: 'Nc7+', best: 'Nc7+', refutation: ['Kd7', 'Nxa8'], over: good });
    const r = lessonReaction(args({ judgement: j, advice: [{ uci: 'e1e2', san: 'Ke2', source: 'engine', arrow: 'green' }] }), mem({ turn: 9 }), book());
    expect(pools(r.now)).toEqual(['v3.praise.tactic.fork']);
    expect(r.now?.say?.[0]?.piece).toBe('n');
    expect(r.memory.lesson?.found).toEqual([{ turn: 9, ply: 5, kind: 'tactic', motif: 'fork' }]);
  });

  it('a followed arrow: no praise, an outcome line without priority, at most every 3 turns', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    const advice: TeachAdvice[] = [{ uci: 'g1f3', san: 'Nf3', source: 'engine', arrow: 'green' }];
    const lastAdvice = { ply: 3, uci: 'g1f3', san: 'Nf3', ideas: [{ id: 'develop', variant: 'center' }], hidden: false };
    const b = book();
    const r = lessonReaction(args({ judgement: j, advice, strategyCard: getStrategy('italian') ?? null }), mem({ turn: 2, lastAdvice }), b);
    expect(r.now?.kind).toBe('teachReaction');
    expect(r.now?.priority).toBe(0);
    expect(pools(r.now)).toEqual(['v3.result.develop']);
    expect(r.memory.lesson?.followStreak).toBe(1);
    expect(r.memory.lesson?.praises).toEqual([]);
    expect(r.memory.lesson?.resultTurns).toEqual([2]);
    // the next followed move one turn later: silence
    const next = lessonReaction(args({ judgement: j, advice }), { ...r.memory, lesson: { ...(r.memory.lesson as LessonMemory), turn: 3, lastAdvice } }, b);
    expect(next.now).toBeNull();
    expect(next.memory.lesson?.followStreak).toBe(2);
  });

  it('a move after a quiz is the child’s own even with the arrow shown', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    const advice: TeachAdvice[] = [{ uci: 'g1f3', san: 'Nf3', source: 'engine', arrow: 'green' }];
    const r = lessonReaction(args({ judgement: j, advice, quizAnswered: true }), mem({ turn: 2 }), book());
    expect(r.now?.kind).toBe('praise');
    expect(r.memory.lesson?.followStreak).toBe(0);
  });

  it('the cap: 4 praises at stage 3 (the last slot is kept for a real find)', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    const praises = [1, 2, 3].map((turn) => ({ turn, reason: `x${turn}` }));
    const routine = lessonReaction(args({ judgement: j, adviceShown: false, profile: profile({ stage: 3 }) }), mem({ turn: 4, praises }), book());
    expect(routine.now).toBeNull();
    const fork = judgement({ fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', played: 'Nc7+', best: 'Nc7+', refutation: ['Kd7', 'Nxa8'], over: good });
    const find = lessonReaction(args({ judgement: fork, adviceShown: false, profile: profile({ stage: 3 }) }), mem({ turn: 4, praises }), book());
    expect(pools(find.now)).toEqual(['v3.praise.tactic.fork']);
  });

  it('no Math.random anywhere in the reaction', () => {
    const spy = vi.spyOn(Math, 'random');
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    lessonReaction(args({ judgement: j, adviceShown: false }), mem(), book());
    lessonReaction(args({ judgement: queenBlunder() }), mem(), book());
    lessonEnd(
      { profile: profile(), tc: 'training', result: '0-1', childColor: 'w', termination: 'resign', summary: SUMMARY, strategyCard: null, judgements: [queenBlunder()], historySan: QUEEN_LOST },
      mem(),
      book(),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('lessonReaction: praise keeps to ≤ 10 words', () => {
  const words = (t: string): number => t.split(/\s+/).filter((w) => /[а-яё]/iu.test(w)).length;

  it('the book picks among the short wordings only — the bag turns over them, the long one never comes', () => {
    const j = judgement({ played: 'e4', best: 'e4', over: { ...good, ply: 1 } });
    const b = book();
    const said: number[] = [];
    for (let k = 0; k < 4; k++) {
      // a fresh game memory each time: the same reason may be praised again, the book remembers the plays
      const r = lessonReaction(args({ judgement: j, adviceShown: false, historySan: ['e4'] }), mem({ turn: 1 }), b);
      expect(pools(r.now)).toEqual(['v3.praise.centerPawn']);
      expect(words(r.now?.text ?? '')).toBeLessThanOrEqual(10);
      said.push(r.now?.say?.[0]?.n ?? 0);
    }
    expect(said).not.toContain(1);
    // the bag works among the fitting wordings: both short ones before either repeats
    expect(new Set(said.slice(0, 2))).toEqual(new Set([2, 3]));
    expect(new Set(said.slice(2, 4))).toEqual(new Set([2, 3]));
  });

  it('a praise pool with nothing short enough stays silent instead of saying a long wording', () => {
    const j = judgement({ setup: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'], played: 'O-O', best: 'O-O', over: { ...good, ply: 7 } });
    const r = lessonReaction(args({ judgement: j, adviceShown: false, historySan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O'] }), mem({ turn: 4 }), book());
    expect(pools(r.now)).not.toContain('v3.praise.castled');
    expect(r.memory.lesson?.praises.map((p) => p.reason) ?? []).not.toContain('castled');
  });
});

describe('lessonReaction: a mistake by a concept', () => {
  it('the lost queen: the concept «без защиты» + the rule, red on the board, remembered', () => {
    const r = lessonReaction(args({ judgement: queenBlunder() }), mem({ turn: 3 }), book());
    const e = r.now as CoachEvent;
    expect(e.kind).toBe('teachReaction');
    expect(pools(e)).toEqual(['v3.mistake.hanging.undefended', 'v3.rule.hanging']);
    expect(e.say?.[0]?.piece).toBe('q');
    expectV3(e);
    expect(e.board?.highlights).toContainEqual({ square: 'e5', color: 'red' });
    expect(e.cues?.every((c) => c.sentence === 0)).toBe(true);
    expect(r.memory.lesson?.mistakes).toEqual([{ turn: 3, ply: 5, concept: 'hanging.undefended', uci: 'h5e5', lossPawns: 8, mated: false, victim: 'e5' }]);
    expect(r.memory.lesson?.rulesSaid).toEqual(['hanging']);
  });

  it('what was said is remembered for the next danger: the piece and the move (§2.2, read by the turn half)', () => {
    const r = lessonReaction(args({ judgement: queenBlunder() }), mem({ turn: 3 }), book());
    const lm = r.memory.lesson as LessonMemory;
    // the child's next turn is ply 7: a danger about the queen on e5 is not said again
    expect(mistakeSaidAbout(lm, 7, ['e5'])).toMatchObject({ concept: 'hanging.undefended', uci: 'h5e5', victim: 'e5' });
    expect(mistakeSaidAbout(lm, 7, ['d4'])).toBeNull();
    expect(mistakeSaidAbout(lm, 9, ['e5'])).toBeNull();
    // it survives the snapshot of a resumed game
    expect(restoreTeachMemory(JSON.parse(JSON.stringify(r.memory))).lesson?.mistakes[0]?.victim).toBe('e5');
    // a mate names no piece
    const mate = lessonReaction(args({ judgement: backRankBlunder({ ply: 5 }) }), mem(), book());
    expect(mate.memory.lesson?.mistakes[0]).toMatchObject({ concept: 'backRank', victim: null });
  });

  it('the second time: a question at stages 3–5, nothing at stages 1–2', () => {
    const earlier = { mistakes: [{ turn: 1, ply: -9, concept: 'hanging.cheaper', uci: 'a2a3', lossPawns: 3, mated: false }], rulesSaid: ['hanging'] };
    const old = lessonReaction(args({ judgement: queenBlunder(), profile: profile({ stage: 4 }) }), mem(earlier), book());
    expect(pools(old.now)).toEqual(['v3.mistake.hanging.undefended', 'v3.rule.ask.hanging']);
    const young = lessonReaction(args({ judgement: queenBlunder(), profile: profile({ stage: 1 }) }), mem(earlier), book());
    expect(pools(young.now)).toEqual(['v3.mistake.hanging.undefended']);
  });

  it('blitz: one sentence, no rule', () => {
    const r = lessonReaction(args({ judgement: queenBlunder(), tc: 'blitz5' }), mem(), book());
    expect(pools(r.now)).toEqual(['v3.mistake.hanging.undefended']);
  });

  it('at most one mistake reaction in 3 child moves — unless ≥ 3 pawns or mate', () => {
    const recent = { mistakes: [{ turn: 2, ply: 3, concept: 'fork', uci: 'a2a3', lossPawns: 2, mated: false }] };
    const small = queenBlunder({ materialLossPawns: 1 });
    expect(lessonReaction(args({ judgement: small }), mem(recent), book()).now).toBeNull();
    expect(pools(lessonReaction(args({ judgement: queenBlunder() }), mem(recent), book()).now)[0]).toBe('v3.mistake.hanging.undefended');
    const mate = backRankBlunder({ ply: 5 });
    const m = lessonReaction(args({ judgement: mate }), mem(recent), book());
    expect(pools(m.now)[0]).toBe('v3.mistake.backRank');
    expect(m.now?.priority).toBe(2);
  });

  it('a knight fork allowed: the attacker is the knight', () => {
    const r = lessonReaction(args({ judgement: forkBlunder() }), mem(), book());
    expect(pools(r.now)[0]).toBe('v3.mistake.fork');
    expect(r.now?.say?.[0]?.piece).toBe('n');
  });

  it('a quick judgement losing < 15 win% is not explained (and not praised)', () => {
    const r = lessonReaction(args({ judgement: queenBlunder({ confidence: 'quick', winPctLoss: 10 }) }), mem(), book());
    expect(r.now).toBeNull();
  });

  it('the Bxf7+ sacrifice the engine approves is no mistake and no «потеряем»', () => {
    const j = judgement({ setup: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4'], played: 'Bxf7+', best: 'Bxf7+', refutation: ['Kxf7', 'Nxe5+'], over: { ...good, ply: 7 } });
    const r = lessonReaction(args({ judgement: j, adviceShown: false, strategyCard: getStrategy('italian') ?? null, historySan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4', 'Bxf7+'] }), mem(), book());
    expect(pools(r.now).some((p) => p.startsWith('v3.mistake.') || p.startsWith('v3.rule.'))).toBe(false);
    expect(pools(r.now)).not.toContain('v3.goalDone.aimF7');
    expect(r.memory.lesson?.mistakes).toEqual([]);
  });

  it('the take-back decision leaves the words to lessonTakebackOffer', () => {
    const r = lessonReaction(args({ judgement: queenBlunder(), decision: { action: 'offerTakeback', reason: 'blunder' } }), mem(), book());
    expect(r.now).toBeNull();
  });
});

describe('the take-back', () => {
  it('stages 1–2: stop + what happened + «Вернём ход?», red at once, priority 2, pose oops', () => {
    const r = lessonTakebackOffer({ profile: profile({ stage: 1 }), judgement: queenBlunder(), advice: [] }, mem({ turn: 3 }), book());
    expect(r.event.kind).toBe('takebackOffer');
    expect(r.event.priority).toBe(2);
    expect(r.event.pose).toBe('oops');
    expect(pools(r.event)).toEqual(['v3.takeback.stop', 'v3.mistake.hanging.undefended', 'v3.takeback.ask']);
    expectV3(r.event);
    expect(r.event.board?.highlights).toContainEqual({ square: 'e5', color: 'red' });
    expect(r.memory.lesson?.mistakes.map((m) => m.concept)).toEqual(['hanging.undefended']);
  });

  it('again: the retry also loses', () => {
    const r = lessonTakebackOffer({ profile: profile({ stage: 2 }), judgement: queenBlunder(), advice: [], again: true }, mem(), book());
    expect(pools(r.event)).toEqual(['v3.takeback.again', 'v3.mistake.hanging.undefended', 'v3.takeback.ask']);
  });

  it('stages 3–5: the question first, no highlight; the concept and the red square after the reply', () => {
    const b = book();
    const offer = lessonTakebackOffer({ profile: profile({ stage: 4 }), judgement: queenBlunder(), advice: [] }, mem(), b);
    expect(pools(offer.event)).toEqual(['v3.takeback.askThink']);
    expect(offer.event.board).toBeUndefined();
    const yes = lessonTakebackReply('yes', profile({ stage: 4 }), offer.memory, b);
    expect(pools(yes.event)).toEqual(['v3.takeback.yes', 'v3.mistake.hanging.undefended']);
    expect(yes.event.say?.[1]?.piece).toBe('q');
    expect(yes.event.board?.highlights).toContainEqual({ square: 'e5', color: 'red' });
    expect(yes.memory.lesson?.lastDanger).toBeNull();
    expectV3(yes.event);
  });

  it('c5g02 (stage 5): the queens traded first, the warned bishop lost — the reply names it; the pending take-back has its own field', () => {
    const warned = { ply: 30, square: 'e6', kind: 'hanging' };
    const advice: TeachAdvice[] = [{ uci: 'e7g5', san: 'Bxg5', source: 'engine', arrow: 'green' }];
    const b = book();
    const p5 = profile({ stage: 5 });
    const offer = lessonTakebackOffer({ profile: p5, judgement: c5g02Qe8(), advice }, mem({ turn: 15, lastDanger: warned }), b);
    expect(pools(offer.event)).toEqual(['v3.takeback.askThink']);
    expect(offer.event.board).toBeUndefined();
    expect(offer.memory.lesson?.pendingTakeback).toMatchObject({ ply: 30, uci: 'd8e8', concept: 'ignoredDanger', piece: 'b', square: 'e6' });
    // the warning stays where it was (a retry that ignores it again is «ignoredDanger» again)
    expect(offer.memory.lesson?.lastDanger).toEqual(warned);
    expect(offer.memory.lesson?.mistakes).toEqual([{ turn: 15, ply: 30, concept: 'ignoredDanger', uci: 'd8e8', lossPawns: 3, mated: false, victim: 'e6' }]);
    // the game is saved and resumed between the offer and the reply
    const saved = restoreTeachMemory(JSON.parse(JSON.stringify(offer.memory)));
    const yes = lessonTakebackReply('yes', p5, saved, b);
    expect(pools(yes.event)).toEqual(['v3.takeback.yes', 'v3.mistake.ignoredDanger']);
    expect(yes.event.say?.[1]?.piece).toBe('b');
    expect(yes.event.board?.highlights).toContainEqual({ square: 'e6', color: 'red' });
    expect(yes.event.board?.arrows).toContainEqual(expect.objectContaining({ from: 'g5', to: 'e6' }));
    expect(yes.memory.lesson?.pendingTakeback).toBeNull();
    expect(yes.memory.lesson?.lastDanger).toEqual(warned);
    expectV3(yes.event);
  });

  it('stages 3–5: «да» and «нет» are always followed by the concept when anything is provable', () => {
    const gift: TeachAdvice[] = [{ uci: 'g2d5', san: 'Bxd5', source: 'engine', arrow: 'green' }];
    const cases: { name: string; j: ReturnType<typeof queenBlunder>; advice?: TeachAdvice[]; lesson?: Partial<LessonMemory> }[] = [
      { name: 'the queen', j: queenBlunder() },
      { name: 'the fork', j: forkBlunder() },
      { name: 'the last rank', j: backRankBlunder() },
      { name: 'c5g02', j: c5g02Qe8(), lesson: { lastDanger: { ply: 30, square: 'e6', kind: 'hanging' } } },
      { name: 'c5g02 without the warning', j: c5g02Qe8() },
      { name: 'a loss on the 5th ply', j: judgement({ fen: '6k1/1p6/8/8/8/2N5/8/6K1 w - - 0 1', played: 'Kh1', best: 'Nd5', refutation: ['b5', 'Kg1', 'b4', 'Kh1', 'bxc3'], over: { materialLossPawns: 0 } }) },
      { name: 'only «был ход сильнее»', j: judgement({ fen: '4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1', played: 'Kd2', best: 'Bxd5', over: { materialLossPawns: 0, winPctLoss: 30 } }), advice: gift },
    ];
    for (const stage of [3, 4, 5]) {
      for (const kind of ['yes', 'no'] as const) {
        for (const c of cases) {
          const b = book();
          const p = profile({ stage });
          const offer = lessonTakebackOffer({ profile: p, judgement: c.j, advice: c.advice ?? [] }, mem(c.lesson), b);
          const reply = lessonTakebackReply(kind, p, offer.memory, b);
          const said = pools(reply.event);
          expect(said[0], `${c.name} ${stage} ${kind}`).toBe(`v3.takeback.${kind}`);
          expect(said[1], `${c.name} ${stage} ${kind}`).toMatch(/^v3\.mistake\./);
        }
      }
    }
  });

  it('a game saved before `pendingTakeback` (the mark in `lastDanger`) still gets its concept', () => {
    const legacy = { lastDanger: { ply: 5, square: 'e5', kind: 'takeback:hanging.undefended:q' } };
    const yes = lessonTakebackReply('yes', profile({ stage: 4 }), mem(legacy), book());
    expect(pools(yes.event)).toEqual(['v3.takeback.yes', 'v3.mistake.hanging.undefended']);
    expect(yes.event.say?.[1]?.piece).toBe('q');
    expect(yes.memory.lesson?.lastDanger).toBeNull();
  });

  it('an offer that never got its reply does not leak into a later move', () => {
    const b = book();
    const offer = lessonTakebackOffer({ profile: profile({ stage: 4 }), judgement: queenBlunder(), advice: [] }, mem(), b);
    const later = judgement({ setup: ['e4', 'e5', 'Nf3', 'Nc6'], played: 'Bc4', best: 'Bc4', over: { ...good, ply: 7 } });
    const r = lessonReaction(args({ judgement: later, profile: profile({ stage: 4 }) }), offer.memory, b);
    expect(r.memory.lesson?.pendingTakeback).toBeNull();
  });

  it('stages 1–2 reply: just yes / no', () => {
    const b = book();
    const offer = lessonTakebackOffer({ profile: profile({ stage: 2 }), judgement: queenBlunder(), advice: [] }, mem(), b);
    expect(pools(lessonTakebackReply('no', profile({ stage: 2 }), offer.memory, b).event)).toEqual(['v3.takeback.no']);
  });
});

const QUEEN_LOST = ['e4', 'e5', 'Qh5', 'Nc6', 'Qxe5+', 'Nxe5', 'd4', 'Nc6', 'Nf3', 'd5'];

/** c5g02 of the first 50-game run: 15…Qe8? after «твой слон без защиты» — Qxe8 Rxe8 Nxe6. */
function c5g02Qe8(): ReturnType<typeof queenBlunder> {
  return judgement({
    fen: 'r2q1rk1/pp2b1p1/4b1n1/P1pp1pNp/Q6P/2B1PB2/1PP2PP1/RN3K1R b - - 3 15',
    played: 'Qe8',
    best: 'Bxg5',
    refutation: ['Qxe8', 'Rfxe8', 'Nxe6'],
    over: { ply: 30, materialLossPawns: 3 },
  });
}
const SUMMARY = {
  accuracy: 50,
  acpl: 120,
  counts: { best: 1, excellent: 0, good: 2, inaccuracy: 0, mistake: 0, blunder: 1, missedWin: 0 },
  takebacksOffered: 0,
  takebacksAccepted: 0,
  hintsUsed: 0,
  motifsMissed: [],
  motifsAllowed: [],
  keyMoments: [],
};

describe('lessonEnd: ONE takeaway', () => {
  it('a lost hanging piece and a lost game → mistake.hanging; gameEnd, priority 2, moment takeaway; the book remembers', () => {
    const b = book();
    const r = lessonEnd(
      { profile: profile(), tc: 'training', result: '0-1', childColor: 'w', termination: 'resign', summary: SUMMARY, strategyCard: null, judgements: [queenBlunder()], historySan: QUEEN_LOST },
      mem({ mistakes: [{ turn: 3, ply: 5, concept: 'hanging.undefended', uci: 'h5e5', lossPawns: 8, mated: false }] }),
      b,
    );
    expect(r.takeawayKey).toBe('mistake.hanging');
    expect(r.event.kind).toBe('gameEnd');
    expect(r.event.priority).toBe(2);
    expect(r.event.teach?.moment).toBe('takeaway');
    expect(pools(r.event)).toEqual(['v3.end.loss', 'v3.takeaway.mistake.hanging']);
    expectV3(r.event);
    expect(r.takeaway).not.toBe('');
    expect(r.event.text.endsWith(r.takeaway)).toBe(true);
    expect(b.history().takeaways).toEqual([{ game: 0, key: 'mistake.hanging' }]);
    // the realized loss replaces the expected one
    expect(r.memory.lesson?.mistakes[0]?.lossPawns).toBe(9);
  });

  it('two right quiz answers of three in a won game → a quiz.* key', () => {
    const quizzes = [
      { turn: 3, ply: 5, kind: 'oppIdea' as const, correct: true },
      { turn: 7, ply: 13, kind: 'whichPiece' as const, correct: false },
      { turn: 12, ply: 23, kind: 'oppIdea' as const, correct: true },
    ];
    const r = lessonEnd(
      { profile: profile(), tc: 'training', result: '1-0', childColor: 'w', termination: 'resign', summary: SUMMARY, strategyCard: null, judgements: [], historySan: ['e4', 'e5'] },
      mem({ quizzes }),
      book(),
    );
    expect(r.takeawayKey).toMatch(/^quiz\./);
    expect(pools(r.event)).toEqual(['v3.end.win', `v3.takeaway.${r.takeawayKey}`]);
  });

  it('the same key is not the takeaway two games in a row', () => {
    const history = { v: 1, gameSeq: 4, recent: {}, minis: {}, habits: {}, takeaways: [{ game: 3, key: 'mistake.hanging' }], habitSaid: {} };
    const r = lessonEnd(
      { profile: profile({ stage: 3 }), tc: 'training', result: '0-1', childColor: 'w', termination: 'resign', summary: SUMMARY, strategyCard: null, judgements: [queenBlunder()], historySan: QUEEN_LOST },
      mem(),
      book(history),
    );
    expect(r.takeawayKey).toBe('stage.3');
  });

  it('a won game with a found fork: the lesson of the fork (the key found.tactic, its variant «fork»)', () => {
    const found = [
      { turn: 6, ply: 11, kind: 'treasure' as const, motif: 'hangingPiece' },
      { turn: 9, ply: 17, kind: 'tactic' as const, motif: 'fork' },
    ];
    const r = lessonEnd(
      { profile: profile({ stage: 3 }), tc: 'training', result: '1-0', childColor: 'w', termination: 'checkmate', summary: SUMMARY, strategyCard: null, judgements: [], historySan: ['e4', 'e5'] },
      mem({ found }),
      book(),
    );
    expect(r.takeawayKey).toBe('found.tactic');
    expect(r.takeaway).toBe('Проба вилка.');
    // the last game ended on a found mate: a found pin is the same lesson («ищи удары») — another key now
    const history = { v: 1, gameSeq: 1, recent: {}, minis: {}, habits: {}, takeaways: [{ game: 0, key: 'found.mate' }], habitSaid: {} };
    const next = lessonEnd(
      { profile: profile({ stage: 3 }), tc: 'training', result: '1-0', childColor: 'w', termination: 'checkmate', summary: SUMMARY, strategyCard: null, judgements: [], historySan: ['e4', 'e5'] },
      mem({ found: [{ turn: 9, ply: 17, kind: 'tactic' as const, motif: 'pin' }] }),
      book(history),
    );
    expect(next.takeawayKey).toBe('stage.3');
  });

  it('an unfinished game has its own opener', () => {
    const r = lessonEnd(
      { profile: profile(), tc: 'training', result: '*', childColor: 'b', termination: 'abandoned', summary: SUMMARY, strategyCard: null, judgements: [], historySan: [] },
      mem(),
      book(),
    );
    expect(pools(r.event)[0]).toBe('v3.end.unfinished');
    expect(r.takeawayKey).toBe('stage.2');
  });

  it('the director installs this half', async () => {
    const director = await import('./index.ts');
    const r = director.lessonReaction(args({ judgement: queenBlunder() }), mem(), book());
    expect(pools(r.now)[0]).toBe('v3.mistake.hanging.undefended');
  });

  it('memory without a lesson (an old snapshot) still works', () => {
    const r = lessonReaction(args({ judgement: queenBlunder() }), initialTeachMemory(), book());
    expect(r.memory.lesson?.v).toBe(1);
  });
});
