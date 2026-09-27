/**
 * Praise for a deed (docs/TEACHING.md §2.5, §6.5) on real positions, with the §7 checks: London 2.Nf3 is no
 * «сначала конь», Na3 is no development, the Italian goal after the bishop is lost is no goal praise; a found fork has
 * its actor; a followed arrow gets only an outcome line.
 */
import { describe, expect, it } from 'vitest';
import type { MoveJudgement, TeachAdvice } from '@gambit/shared';
import { LESSON_GOAL_KEYS, LESSON_THEME_FAMILIES, RESULT_IDEAS, getStrategy, lessonLine, lessonPoolSpec } from '@gambit/content';
import { judgement } from '../test-fixtures.ts';
import type { StrategyCardLike } from '../teacher.ts';
import { createLessonBook, emptyLessonHistory } from './book.ts';
import type { LessonHistory } from './book.ts';
import { initialLessonMemory } from './memory.ts';
import { MISTAKE_CONCEPTS, ruleOfConcept, takeawayOfConcept } from './mistake.ts';
import {
  HABIT_REASONS,
  OWN_IDEA_MAX_WIN_PCT_LOSS,
  PRAISE_MAX_WORDS,
  PRAISE_REASONS,
  ROUTINE_ANY_CLASS_MAX_WIN_PCT_LOSS,
  ROUTINE_MAX_WIN_PCT_LOSS,
  foundBy,
  habitMode,
  habitsDone,
  miniShownBy,
  ownIdeaSure,
  praiseCap,
  praiseChoices,
  resultChoice,
  routinePraiseSure,
} from './praise.ts';
import type { PraiseInput } from './praise.ts';

function card(id: string): StrategyCardLike {
  const c = getStrategy(id);
  if (!c) throw new Error(id);
  return c;
}

const good = { winPctLoss: 0.3, classification: 'best' as const, winPctBefore: 55, winPctAfter: 55, evalAfter: { cp: 30, mate: null } };

function input(j: MoveJudgement, over: Partial<PraiseInput> = {}): PraiseInput {
  return {
    judgement: j,
    advice: [],
    stage: 2,
    own: true,
    adviceHidden: false,
    treasureHidden: false,
    card: null,
    historySan: [],
    lesson: initialLessonMemory(),
    history: emptyLessonHistory(),
    ...over,
  };
}

const reasons = (i: PraiseInput): string[] => praiseChoices(i).map((c) => c.reason);

describe('knightFirst (§6.5)', () => {
  it('Italian 2.Nf3: «сначала конь» and «вывел фигуру»', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    const r = reasons(input(j, { card: card('italian'), historySan: ['e4', 'e5', 'Nf3'] }));
    expect(r).toContain('knightFirst');
    expect(r).toContain('developed');
    expect(r.indexOf('knightFirst')).toBeLessThan(r.indexOf('developed'));
  });

  it('London 2.Nf3 — the card plays the bishop first: no knightFirst', () => {
    const j = judgement({ setup: ['d4', 'd5'], played: 'Nf3', best: 'Bf4', over: { ...good, ply: 3 } });
    expect(reasons(input(j, { card: card('london'), historySan: ['d4', 'd5', 'Nf3'] }))).not.toContain('knightFirst');
  });

  it("the engine's best is the bishop and the knight loses ≥ 1 %: no knightFirst", () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nc3', best: 'Bc4', over: { ...good, winPctLoss: 1.5, ply: 3 } });
    expect(reasons(input(j))).not.toContain('knightFirst');
  });

  it('not when a minor piece already left home', () => {
    const j = judgement({ setup: ['e4', 'e5', 'Bc4', 'Nc6'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 5 } });
    expect(reasons(input(j))).not.toContain('knightFirst');
  });
});

describe('developed / centerPawn / castled — re-checked on the position', () => {
  it('Na3 is no development praise at all', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Na3', best: 'Nf3', over: { ...good, winPctLoss: 1.5, ply: 3 } });
    const r = reasons(input(j));
    expect(r).not.toContain('developed');
    expect(r).not.toContain('own.develop');
    expect(r).not.toContain('knightFirst');
  });

  it('to the edge, or onto a square a pawn takes, is not «developed»', () => {
    const edge = judgement({ setup: ['e4', 'e5'], played: 'Nh3', best: 'Nf3', over: { ...good, winPctLoss: 1.5, ply: 3 } });
    expect(reasons(input(edge))).not.toContain('developed');
    // 1.e4 d5 2.Nf3 d4 3.Nc3? — the d4 pawn takes the knight
    const hit = judgement({ setup: ['e4', 'd5', 'Nf3', 'd4'], played: 'Nc3', best: 'Bc4', over: { ...good, winPctLoss: 1.5, ply: 5 } });
    expect(reasons(input(hit))).not.toContain('developed');
    // a minor piece to a safe square is
    const safe = judgement({ setup: ['e4', 'd5', 'Nf3', 'd4'], played: 'Bc4', best: 'Bc4', over: { ...good, ply: 5 } });
    expect(reasons(input(safe))).toContain('developed');
  });

  it('a centre pawn only when it stands safe', () => {
    const safe = judgement({ setup: [], played: 'e4', best: 'e4', over: { ...good, ply: 1 } });
    expect(reasons(input(safe))).toContain('centerPawn');
    const hanging = judgement({ setup: ['e4', 'd5', 'Nc3', 'Nf6'], played: 'd4', best: 'exd5', over: { ...good, winPctLoss: 1.2, ply: 5 } });
    // d4 is defended by the queen and attacked by nobody — safe; e4 hangs to d5xe4, but the praised pawn is d4
    expect(reasons(input(hanging))).toContain('centerPawn');
  });

  it('castled — not while something of ours hangs or a threat is known', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'];
    const j = judgement({ setup: sans, played: 'O-O', best: 'O-O', over: { ...good, ply: 7 } });
    expect(reasons(input(j))).toContain('castled');
    expect(reasons(input(j, { threatAfter: { uci: 'c5f2', san: 'Bxf2+', motif: 'hangingPiece', targetSquares: ['f2'], gainCp: 100 } }))).not.toContain('castled');
  });
});

describe('the goal of the card (structured, §6.4)', () => {
  it('Italian 3.Bc4 — the goal «aim at f7» is praised as the goal', () => {
    const j = judgement({ setup: ['e4', 'e5', 'Nf3', 'Nc6'], played: 'Bc4', best: 'Bc4', over: { ...good, ply: 5 } });
    const c = praiseChoices(input(j, { card: card('italian'), historySan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] }));
    const goal = c.find((x) => x.reason === 'goal.aimF7');
    expect(goal?.pool).toBe('v3.goalDone.aimF7');
  });

  it('Italian after the bishop is lost: no goal praise for aiming at f7', () => {
    const setup = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Na5', 'd3', 'Nxc4', 'dxc4', 'd6'];
    const j = judgement({ setup, played: 'Nc3', best: 'Nc3', over: { ...good, ply: 11 } });
    const r = reasons(input(j, { card: card('italian'), historySan: [...setup, 'Nc3'] }));
    expect(r.filter((x) => x.startsWith('goal.'))).toEqual([]);
  });

  it('a goal already done this game is not praised again', () => {
    const j = judgement({ setup: ['e4', 'e5', 'Nf3', 'Nc6'], played: 'Bc4', best: 'Bc4', over: { ...good, ply: 5 } });
    const lesson = { ...initialLessonMemory(), goalsDone: ['aimF7'] };
    expect(reasons(input(j, { card: card('italian'), historySan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], lesson }))).not.toContain('goal.aimF7');
  });
});

describe('the always-praise: finds', () => {
  it('a knight fork now: the actor is the knight, the variant «now»', () => {
    const j = judgement({ fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', played: 'Nc7+', best: 'Nc7+', refutation: ['Kd7', 'Nxa8'], over: good });
    const [first] = praiseChoices(input(j));
    expect(first).toMatchObject({ reason: 'tactic.fork', pool: 'v3.praise.tactic.fork', piece: 'n', variant: 'now', tier: 'always' });
    expect(foundBy(input(j))).toEqual({ kind: 'tactic', motif: 'fork' });
  });

  it('a fork on the 2nd half-move after a check: «начал комбинацию» (variant ply2)', () => {
    const j = judgement({ fen: '1r4k1/8/8/8/4n3/8/6K1/3Q4 b - - 0 1', played: 'Rb2+', best: 'Rb2+', refutation: ['Kh1', 'Nf2+', 'Kg1', 'Nxd1'], over: good });
    const [first] = praiseChoices(input(j));
    expect(first).toMatchObject({ reason: 'tactic.fork', variant: 'ply2', piece: 'n' });
  });

  it('a fork after following the arrow is no praise (the arrow found it)', () => {
    const j = judgement({ fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', played: 'Nc7+', best: 'Nc7+', refutation: ['Kd7', 'Nxa8'], over: good });
    expect(reasons(input(j, { own: false }))).toEqual([]);
    expect(foundBy(input(j, { own: false }))).toBeNull();
  });

  it('the found hidden treasure', () => {
    const j = judgement({ fen: '4k3/8/8/3n4/8/8/6B1/4K3 w - - 0 1', played: 'Bxd5', best: 'Bxd5', over: good });
    const advice: TeachAdvice[] = [{ uci: 'g2d5', san: 'Bxd5', source: 'engine', arrow: 'green' }];
    const i = input(j, { advice, treasureHidden: true, adviceHidden: true });
    expect(reasons(i)[0]).toBe('treasureFound');
    expect(foundBy(i)?.kind).toBe('treasure');
    // once a game
    expect(reasons({ ...i, lesson: { ...initialLessonMemory(), praises: [{ turn: 1, reason: 'treasureFound' }] } })).not.toContain('treasureFound');
  });

  it("mate — even the scholar's mate after the arrow is a fact", () => {
    const j = judgement({ setup: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6'], played: 'Qxf7#', best: 'Qxf7#', over: { ...good, ply: 7 } });
    expect(reasons(input(j, { own: false }))).toEqual(['mate']);
  });
});

describe('routine praise only for an own good move', () => {
  it('a followed arrow gives no routine praise, only an outcome line', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    expect(reasons(input(j, { own: false, card: card('italian') }))).toEqual([]);
    const lesson = { ...initialLessonMemory(), lastAdvice: { ply: 3, uci: 'g1f3', san: 'Nf3', ideas: [{ id: 'develop', variant: 'center' }], hidden: false } };
    const r = resultChoice({ judgement: j, lesson, stage: 2, prev: null });
    expect(r).toMatchObject({ pool: 'v3.result.develop', piece: 'n', variant: 'center' });
  });

  it('a slightly weaker own move (≥ 2 %) is not praised', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, winPctLoss: 3, ply: 3 } });
    expect(reasons(input(j))).toEqual([]);
  });

  it('the routine gate is < 1.5 % at the judged depth (a 2 % gate let praises 2–3.9 % below the best through)', () => {
    expect(ROUTINE_MAX_WIN_PCT_LOSS).toBe(1.5);
    const at = (winPctLoss: number, over: Partial<MoveJudgement> = {}): string[] =>
      reasons(input(judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, winPctLoss, ply: 3, ...over } })));
    expect(at(1.4)).toContain('knightFirst');
    expect(at(1.5)).toEqual([]);
    expect(at(1.9)).toEqual([]);
    // a quick verdict is judged by the same number; a «missed win» is never routine praise, however small the loss
    expect(at(0.5, { confidence: 'quick' })).toContain('developed');
    expect(at(0.5, { classification: 'missedWin' })).toEqual([]);
    expect(routinePraiseSure({ winPctLoss: 0.2, classification: 'inaccuracy' })).toBe(false);
  });

  it('provably good: classed best / excellent, or < 1 % of any praisable class', () => {
    expect(ROUTINE_ANY_CLASS_MAX_WIN_PCT_LOSS).toBe(1);
    expect(routinePraiseSure({ winPctLoss: 1.4, classification: 'best' })).toBe(true);
    expect(routinePraiseSure({ winPctLoss: 1.4, classification: 'excellent' })).toBe(true);
    // 'good' alone proves nothing: only under 1 %
    expect(routinePraiseSure({ winPctLoss: 1.49, classification: 'good' })).toBe(false);
    expect(routinePraiseSure({ winPctLoss: 1, classification: 'good' })).toBe(false);
    expect(routinePraiseSure({ winPctLoss: 0.9, classification: 'good' })).toBe(true);
    // the win% gate still holds for the sure classes; a verdict without a number is never sure
    expect(routinePraiseSure({ winPctLoss: 1.5, classification: 'best' })).toBe(false);
    expect(routinePraiseSure({ winPctLoss: Number.NaN, classification: 'best' })).toBe(false);
    expect(routinePraiseSure({ winPctLoss: 0, classification: 'missedWin' })).toBe(false);
    // through praiseChoices: a 'good' verdict at 1.2 % gets no routine praise
    const nf3 = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, winPctLoss: 1.2, classification: 'good', ply: 3 } });
    expect(reasons(input(nf3))).toEqual([]);
    expect(reasons(input({ ...nf3, classification: 'excellent' }))).toContain('knightFirst');
  });

  it('a real find is praised above the routine gate (tactic / mate / treasure keep the 5 % gate)', () => {
    const fork = judgement({ fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', played: 'Nc7+', best: 'Nc7+', refutation: ['Kd7', 'Nxa8'], over: { ...good, winPctLoss: 3 } });
    expect(reasons(input(fork))).toEqual(['tactic.fork']);
    // the habit model still counts a move within 2 %
    const nf3 = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, winPctLoss: 1.8, ply: 3 } });
    expect(habitsDone(input(nf3))).toContain('knightFirst');
  });

  it('one reason once a game', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    const lesson = { ...initialLessonMemory(), praises: [{ turn: 1, reason: 'knightFirst' }] };
    expect(reasons(input(j, { lesson }))).not.toContain('knightFirst');
  });
});

describe('own.* («своя идея») only for a provably good move', () => {
  // c5g07, ply 17: Bf4 (the engine's 2nd line) praised as own.attack — 5.7 % below the deep best e5
  const C5G07 = '1rb1kb1r/pp1pppp1/4nn1p/q1p5/2B1P3/2N1BN2/PPPQ1PPP/2KR3R w k - 8 9';
  // c5g10, ply 24: …h6 (the card's middlegame move) praised as own.plan — 5.1 % below the deep best Bf5
  const C5G10 = 'r1bq1rk1/ppp2ppp/3b4/4p3/4N1n1/PP3N2/2P1QPPP/R1B2RK1 b - - 0 12';
  const bf4 = (best: string, over: Partial<MoveJudgement>): MoveJudgement => judgement({ fen: C5G07, played: 'Bf4', best, over: { ...good, ply: 17, ...over } });
  const h6 = (best: string, over: Partial<MoveJudgement>): MoveJudgement => judgement({ fen: C5G10, played: 'h6', best, over: { ...good, ply: 24, ...over } });

  it('the gate: the engine’s own first choice, or < 0.5 %', () => {
    expect(OWN_IDEA_MAX_WIN_PCT_LOSS).toBe(0.5);
    const j = (winPctLoss: number, classification: MoveJudgement['classification'], bestUci: string): Parameters<typeof ownIdeaSure>[0] => ({ winPctLoss, classification, uci: 'e3f4', bestUci });
    expect(ownIdeaSure(j(0, 'best', 'e3f4'))).toBe(true);
    expect(ownIdeaSure(j(0.49, 'best', 'e4e5'))).toBe(true);
    expect(ownIdeaSure(j(0.5, 'best', 'e4e5'))).toBe(false);
    expect(ownIdeaSure(j(0.67, 'best', 'e4e5'))).toBe(false);
    expect(ownIdeaSure(j(1.08, 'excellent', 'c8f5'))).toBe(false);
    // never looser than the routine gate
    expect(ownIdeaSure(j(0, 'missedWin', 'e3f4'))).toBe(false);
  });

  it('c5g07: the engine’s 2nd line judged within 1 % is no own.attack; the engine’s first choice is', () => {
    expect(reasons(input(bf4('e5', { winPctLoss: 0.67, classification: 'best' }), { stage: 5, card: card('spanish') }))).not.toContain('own.attack');
    expect(reasons(input(bf4('e5', { winPctLoss: 0.3 }), { stage: 5, card: card('spanish') }))).toContain('own.attack');
    expect(reasons(input(bf4('Bf4', { winPctLoss: 0 }), { stage: 5, card: card('spanish') }))).toContain('own.attack');
  });

  it('c5g10: the card’s move judged ≈ 1 % below the best is no own.plan', () => {
    const botvinnik = card('botvinnik-system');
    expect(reasons(input(h6('Bf5', { winPctLoss: 1.08, classification: 'excellent' }), { stage: 5, card: botvinnik }))).not.toContain('own.plan');
    expect(reasons(input(h6('Bf5', { winPctLoss: 0.4 }), { stage: 5, card: botvinnik }))).toContain('own.plan');
  });

  it('a concrete deed on the board keeps the routine gate (only own.* is stricter)', () => {
    const e4 = judgement({ played: 'e4', best: 'd4', over: { ...good, winPctLoss: 0.8, classification: 'best', ply: 1 } });
    expect(reasons(input(e4))).toEqual(['centerPawn']);
  });

  it('own.good for a found hidden advice needs the same proof', () => {
    const advice: TeachAdvice[] = [{ uci: 'h7h6', san: 'h6', source: 'repertoire', arrow: 'green' }];
    const at = (winPctLoss: number): string[] => reasons(input(h6('Bf5', { winPctLoss, classification: winPctLoss < 1 ? 'best' : 'excellent' }), { stage: 5, advice, adviceHidden: true }));
    expect(at(0.8)).not.toContain('own.good');
    expect(at(0.2)).toContain('own.good');
  });
});

describe('praise keeps to ≤ 10 words (§2.5)', () => {
  it('the cap never silences a praise pool: wherever a pool can speak, it can speak within the cap', () => {
    expect(PRAISE_MAX_WORDS).toBe(10);
    const ids = [
      ...PRAISE_REASONS.map((r) => `v3.praise.${r}`),
      ...HABIT_REASONS.map((r) => `v3.praise.habit.${r}`),
      ...LESSON_GOAL_KEYS.map((k) => `v3.goalDone.${k}`),
    ];
    const book = createLessonBook({ seed: 1 });
    const lost: string[] = [];
    for (const id of ids) {
      const line = lessonLine(id);
      if (!line) continue;
      for (const stage of [1, 2, 3, 4, 5]) {
        for (const piece of [null, 'p', 'n', 'b', 'r', 'q', 'k'] as const) {
          for (const variant of [null, ...(line.variants ?? [])]) {
            for (const g of ['m', 'f'] as const) {
              const a = { stage, piece, variant, g };
              if (book.has(id, a) && !book.has(id, { ...a, maxWords: PRAISE_MAX_WORDS })) lost.push(`${id} stage ${stage} ${piece ?? '-'} ${variant ?? '-'} ${g}`);
            }
          }
        }
      }
    }
    expect(lost).toEqual([]);
  });
});

describe('habits fade across games', () => {
  const hist = (over: Partial<LessonHistory>): LessonHistory => ({ ...emptyLessonHistory(), ...over });

  it('done 3 games in a row → the habit praise, then 1 game of 3, then the habit praise again after 7 games', () => {
    expect(habitMode('castled', hist({ gameSeq: 3, habits: { castled: [0, 1] } }))).toBe('normal');
    expect(habitMode('castled', hist({ gameSeq: 3, habits: { castled: [0, 1, 2] } }))).toBe('habit');
    expect(habitMode('castled', hist({ gameSeq: 4, habits: { castled: [1, 2, 3] }, habitSaid: { castled: 3 } }))).toBe('skip');
    expect(habitMode('castled', hist({ gameSeq: 6, habits: { castled: [3, 4, 5] }, habitSaid: { castled: 3 } }))).toBe('normal');
    expect(habitMode('castled', hist({ gameSeq: 10, habits: { castled: [7, 8, 9] }, habitSaid: { castled: 3 } }))).toBe('habit');
    expect(habitMode('own.attack', hist({ gameSeq: 10, habits: { 'own.attack': [7, 8, 9] } }))).toBe('normal');
  });

  it('the habit praise replaces the reason', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'];
    const j = judgement({ setup: sans, played: 'O-O', best: 'O-O', over: { ...good, ply: 7 } });
    const c = praiseChoices(input(j, { history: hist({ gameSeq: 3, habits: { castled: [0, 1, 2] } }) }));
    expect(c.find((x) => x.reason === 'habit.castled')).toMatchObject({ pool: 'v3.praise.habit.castled', tier: 'habit' });
    expect(c.some((x) => x.reason === 'castled')).toBe(false);
  });

  it('habitsDone lists what the child did himself', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    expect(habitsDone(input(j))).toEqual(['knightFirst', 'developed']);
    expect(habitsDone(input(j, { own: false }))).toEqual([]);
  });
});

describe('the concepts the child showed (the next mini-lesson level)', () => {
  const told = (...topics: string[]): LessonHistory => ({
    ...emptyLessonHistory(),
    gameSeq: 2,
    minis: Object.fromEntries(topics.map((t) => [t, { level: 1, lastGame: 1, shown: 0 }])),
  });

  it('an own castle shows «castle» — only when the topic was told', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'];
    const j = judgement({ setup: sans, played: 'O-O', best: 'O-O', over: { ...good, ply: 7 } });
    expect(miniShownBy(input(j, { history: told('castle') }), null)).toEqual(['castle']);
    expect(miniShownBy(input(j), null)).toEqual([]);
    expect(miniShownBy(input(j, { own: false, history: told('castle') }), null)).toEqual([]);
  });

  it('development once a game, a found fork once per motif', () => {
    const j = judgement({ setup: ['e4', 'e5'], played: 'Nf3', best: 'Nf3', over: { ...good, ply: 3 } });
    expect(miniShownBy(input(j, { history: told('development') }), null)).toEqual(['development']);
    const again = { ...told('development'), habits: { developed: [2] } };
    expect(miniShownBy(input(j, { history: again }), null)).toEqual([]);
    const fork = judgement({ fen: 'r3k3/8/8/3N4/8/8/8/4K3 w - - 0 1', played: 'Nc7+', best: 'Nc7+', refutation: ['Kd7', 'Nxa8'], over: good });
    const i = input(fork, { history: told('fork') });
    expect(miniShownBy(i, foundBy(i))).toEqual(['fork']);
    const before = { ...initialLessonMemory(), found: [{ turn: 2, ply: 3, kind: 'tactic' as const, motif: 'fork' }] };
    expect(miniShownBy({ ...i, lesson: before }, foundBy(i))).toEqual([]);
  });
});

describe('caps', () => {
  it('6 at stages 1–2, 4 at 3–5', () => {
    expect(praiseCap(1)).toBe(6);
    expect(praiseCap(2)).toBe(6);
    expect(praiseCap(3)).toBe(4);
    expect(praiseCap(5)).toBe(4);
  });
});

describe('every pool the reaction half can say is a pool of the content spec', () => {
  it('praise, habits, goals, outcomes', () => {
    const ids = [
      ...PRAISE_REASONS.map((r) => `v3.praise.${r}`),
      ...HABIT_REASONS.map((r) => `v3.praise.habit.${r}`),
      ...LESSON_GOAL_KEYS.map((k) => `v3.goalDone.${k}`),
      ...RESULT_IDEAS.map((i) => `v3.result.${i}`),
    ];
    expect(ids.filter((id) => !lessonPoolSpec(id))).toEqual([]);
  });

  it('mistakes, rules, take-back, the end and every takeaway key', () => {
    const rules = [...new Set(MISTAKE_CONCEPTS.map(ruleOfConcept).filter((r): r is NonNullable<typeof r> => r !== null))];
    const takeaways = [
      ...new Set(MISTAKE_CONCEPTS.map(takeawayOfConcept).filter((k): k is string => k !== null)),
      ...LESSON_THEME_FAMILIES.map((f) => `theme.${f}`),
      'found.mate',
      'found.tactic',
      ...['oppIdea', 'whichPiece', 'canCapture', 'checkEscape', 'danger', 'why'].map((k) => `quiz.${k}`),
      ...[1, 2, 3, 4, 5].map((s) => `stage.${s}`),
    ];
    const ids = [
      ...MISTAKE_CONCEPTS.map((c) => `v3.mistake.${c}`),
      ...rules.map((r) => `v3.rule.${r}`),
      ...rules.map((r) => `v3.rule.ask.${r}`),
      ...['stop', 'ask', 'askThink', 'again', 'yes', 'no'].map((k) => `v3.takeback.${k}`),
      ...['win', 'loss', 'draw', 'unfinished'].map((k) => `v3.end.${k}`),
      ...takeaways.map((k) => `v3.takeaway.${k}`),
    ];
    expect(ids.filter((id) => !lessonPoolSpec(id))).toEqual([]);
  });
});
