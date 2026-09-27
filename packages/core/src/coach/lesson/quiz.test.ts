/**
 * The button quiz (docs/TEACHING.md §2.4, §6.1): the cadence, and every kind asked only with a proven answer — on
 * real positions with scripted engine lines.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, EngineLine } from '@gambit/shared';
import { explainOpponentMove, isEarlyQueenMove, pickIdeas } from '../moveIdeas.ts';
import type { TeachDanger } from '../teacher.ts';
import { constRng, seededRng } from '../test-fixtures.ts';
import { initialLessonMemory } from './memory.ts';
import { canCaptureQuiz, dangerQuiz, oppIdeaQuiz, quizBudget, quizDue, quizEvery, recallQuizKinds, turnQuiz, whichPieceQuiz, whyQuiz } from './quiz.ts';
import type { QuizInput } from './quiz.ts';
import { engineProof, moveFacts, optionFalse } from './truth.ts';

type Score = number | { mate: number };
type LineSpec = [string, Score, ...string[]];

function fenOf(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function uciOf(fen: string, san: string): string {
  const m = new Chess(fen).move(san);
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

function scripted(fen: string, specs: readonly LineSpec[], depth = 16): AnalysisResult {
  const lines: EngineLine[] = specs.map(([san, score], i) => ({ multipv: i + 1, depth, pvUci: [uciOf(fen, san)], cp: typeof score === 'number' ? score : null, mate: typeof score === 'number' ? null : score.mate }));
  return { fen, lines, bestmove: lines[0]?.pvUci[0] ?? '', depth, timeMs: 300 };
}

/** The quiz input after `sans` (the last move is the bot's), child to move. */
function inputAfter(sans: readonly string[], stage: number, specs: readonly LineSpec[] | null, over: Partial<QuizInput> = {}): QuizInput {
  const fen = fenOf(sans);
  const before = fenOf(sans.slice(0, -1));
  const bot = sans[sans.length - 1] as string;
  const uci = uciOf(before, bot);
  const res = explainOpponentMove(before, uci, fen, { threat: null });
  const ideas = pickIdeas(res.ideas, { stage, max: 1 });
  const chess = new Chess(fen);
  const advice = specs?.[0] ? { uci: uciOf(fen, specs[0][0]), san: specs[0][0] } : null;
  return {
    stage,
    fen,
    childColor: chess.turn(),
    ply: sans.length + 1,
    proof: specs ? engineProof(fen, scripted(fen, specs)) : null,
    advice,
    opponent: { uci, san: bot, fenBefore: before, ideas, earlyQueen: isEarlyQueenMove(before, uci) },
    threat: null,
    lastChild: null,
    lastAdvice: null,
    adviceShown: [],
    rng: constRng(0.3),
    ...over,
  };
}

describe('the cadence (§2.4 «Частота»)', () => {
  it('every 6 / 5 / 4 child turns by stage; 4–5 a game untimed, 4 in 10 minutes, 3 in blitz', () => {
    expect([1, 2, 3, 4, 5].map(quizEvery)).toEqual([6, 5, 5, 4, 4]);
    expect(quizBudget(1, 'training')).toBe(4);
    expect(quizBudget(4, undefined)).toBe(5);
    expect(quizBudget(4, 'rapid10')).toBe(4);
    expect(quizBudget(5, 'blitz5')).toBe(3);
  });

  it('not before the third turn, not twice at one ply, not over the budget, spaced', () => {
    const lm = initialLessonMemory();
    expect(quizDue(lm, 2, 3, 3, 'training')).toBe(false);
    expect(quizDue(lm, 3, 5, 3, 'training')).toBe(true);
    const asked = { ...lm, quizzes: [{ turn: 3, ply: 5, kind: 'oppIdea' as const, correct: true }] };
    expect(quizDue(asked, 3, 5, 3, 'training')).toBe(false); // the same ply (a resumed game)
    expect(quizDue(asked, 7, 13, 3, 'training')).toBe(false); // 4 turns later, stage 3 needs 5
    expect(quizDue(asked, 8, 15, 3, 'training')).toBe(true);
    const full = { ...lm, quizzes: [1, 2, 3].map((t) => ({ turn: t * 6, ply: t * 12, kind: 'oppIdea' as const, correct: null })) };
    expect(quizDue(full, 40, 81, 1, 'blitz5')).toBe(false);
  });
});

describe('«Что задумал соперник?»', () => {
  it('2…Сb4 hits a defended knight — the answer is «выводит фигуру», «нападает» is never a wrong button', () => {
    for (const stage of [1, 3]) {
      for (let seed = 1; seed <= 6; seed++) {
        const inp = inputAfter(['e4', 'e5', 'Nc3', 'Bb4'], stage, [['Nf3', 30], ['Nge2', 20], ['a3', 10]], { rng: seededRng(seed) });
        const q = oppIdeaQuiz(inp);
        expect(q, `stage ${stage}`).not.toBeNull();
        if (!q) continue;
        expect(q.correct).toBe('develop');
        expect(q.options.map((o) => o.id)).toContain('develop');
        expect(q.options.map((o) => o.id)).not.toContain('attack');
        expect(q.options).toHaveLength(3);
        // every wrong button is provably false for the move
        const f = moveFacts(fenOf(['e4', 'e5', 'Nc3']), 'f8b4');
        for (const o of q.options) if (o.id !== q.correct && f) expect(optionFalse(o.id as never, f, { threatAfter: null }), o.id).toBe(true);
        expect(q.options.every((o) => o.pool.startsWith(stage <= 2 ? 'v3.quiz.cat.' : 'v3.quiz.opt.'))).toBe(true);
        expect(q.explain).toMatchObject({ kind: 'pool', pool: 'v3.opp.develop', subjects: { oppPiece: 'b' } });
        expect(q.sayOptions).toBe(stage <= 2);
      }
    }
  });

  it('no idea of the opponent\'s move — no question', () => {
    const inp = inputAfter(['e4', 'a6'], 1, [['d4', 60], ['Nf3', 50], ['Nc3', 45]]);
    expect(oppIdeaQuiz(inp)).toBeNull();
  });
});

describe('the other kinds', () => {
  it('whichPiece: three piece types, the answer the advice\'s type', () => {
    const inp = inputAfter(['e4', 'e5'], 2, [['Nf3', 30], ['Nc3', 26], ['d4', -60]]);
    const q = whichPieceQuiz(inp);
    expect(q?.correct).toBe('n');
    expect(q?.options.map((o) => o.id).sort()).toEqual(['b', 'n', 'p']);
    expect(q?.options.every((o) => o.pool === '' && o.icon === o.id)).toBe(true);
    expect(q?.explain).toEqual({ kind: 'advice' });
  });

  it('canCapture: the three fixed buttons, the victim is the question\'s subject', () => {
    const inp = inputAfter(['e4', 'e5', 'Nf3', 'd6'], 2, [['d4', 40], ['Bc4', 35], ['Nxe5', -180]]);
    const q = canCaptureQuiz(inp);
    expect(q?.correct).toBe('capLose');
    expect(q?.options.map((o) => o.id)).toEqual(['capYes', 'capTrade', 'capLose']);
    expect(q?.questionSubjects).toEqual({ target: 'p' });
    expect(q?.questionFacts.move).toEqual({ uci: 'f3e5' });
    expect(q?.explain).toMatchObject({ kind: 'pool', pool: 'v3.quiz.explain.capLose', subjects: { target: 'p' } });
    // the recapture is shown as the threat arrow of the explanation
    expect(q?.explain.kind === 'pool' ? q.explain.facts.threat?.uci : null).toBe('d6e5');
  });

  it('canCapture «да» / «размен» only about the advised capture, «нет» only when the advice is another move', () => {
    // Сxc6 of the Spanish: «Будет размен» — only when Сxc6 is the advice (the arrow after the answer shows that capture)
    const trade = inputAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'], 2, [['Bxc6', 30], ['Ba4', 28], ['O-O', 25]]);
    expect(canCaptureQuiz(trade)?.correct).toBe('capTrade');
    expect(canCaptureQuiz(trade)?.questionFacts.move).toEqual(trade.advice ? { uci: trade.advice.uci } : null);
    expect(canCaptureQuiz({ ...trade, advice: { uci: 'b5a4', san: 'Ba4' } })).toBeNull();
    // «Нет, потеряем» about Кxe5 while the advice is d4 — never when the advice is that capture itself
    const lose = inputAfter(['e4', 'e5', 'Nf3', 'd6'], 2, [['d4', 40], ['Bc4', 35], ['Nxe5', -180]]);
    expect(canCaptureQuiz(lose)?.correct).toBe('capLose');
    expect(canCaptureQuiz({ ...lose, advice: { uci: 'f3e5', san: 'Nxe5' } })).toBeNull();
    expect(canCaptureQuiz({ ...lose, advice: null })).toBeNull();
  });

  it('turnQuiz tries the kinds in order and returns the first proven one', () => {
    const inp = inputAfter(['e4', 'e5', 'Nf3', 'd6'], 2, [['d4', 40], ['Bc4', 35], ['Nxe5', -180]]);
    expect(turnQuiz(inp, ['whichPiece', 'canCapture'])?.kind).toBe('canCapture');
    expect(turnQuiz(inp, ['why'])).toBeNull();
  });

  it('why (stages 3–5): about the previous move by the shown advice, the idea stored then', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6'];
    const lastChild = { fenBefore: fenOf(['e4', 'e5']), uci: 'g1f3' };
    const lastAdvice = { ply: 3, uci: 'g1f3', san: 'Nf3', ideas: [{ id: 'develop', variant: 'center' }], hidden: false };
    const base = inputAfter(sans, 3, [['Bb5', 30], ['Bc4', 25], ['d4', 20]], { lastChild, lastAdvice, adviceShown: [3] });
    const q = whyQuiz(base);
    expect(q?.correct).toBe('develop');
    expect(q?.questionFacts.lastMove).toEqual({ uci: 'g1f3' });
    expect(q?.explain).toMatchObject({ kind: 'why', idea: { id: 'develop', variant: 'center' }, piece: 'n' });
    const f = moveFacts(lastChild.fenBefore, 'g1f3');
    for (const o of q?.options ?? []) if (o.id !== 'develop' && f) expect(optionFalse(o.id as never, f, { staticMate: true }), o.id).toBe(true);
    // not at stage 2, not for a hidden advice, not when the child played another move
    expect(whyQuiz({ ...base, stage: 2 })).toBeNull();
    expect(whyQuiz({ ...base, adviceShown: [] })).toBeNull();
    expect(whyQuiz({ ...base, lastChild: { ...lastChild, uci: 'b1c3' } })).toBeNull();
  });

  it('why about 3.Сb5+ told as «развитие» — «Напасть» is never a wrong button (a check attacks the king)', () => {
    const sans = ['e4', 'c5', 'Nf3', 'd6', 'Bb5+', 'Bd7'];
    const lastChild = { fenBefore: fenOf(['e4', 'c5', 'Nf3', 'd6']), uci: 'f1b5' };
    const lastAdvice = { ply: 5, uci: 'f1b5', san: 'Bb5+', ideas: [{ id: 'develop' }], hidden: false };
    let asked = 0;
    for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
      const q = whyQuiz(inputAfter(sans, 3, [['Bxd7+', 30], ['Ba4', 20], ['a4', 10]], { lastChild, lastAdvice, adviceShown: [5], rng: constRng(r) }));
      if (!q) continue;
      asked++;
      expect(q.correct).toBe('develop');
      expect(q.options.map((o) => o.id), String(r)).not.toContain('attack');
    }
    expect(asked).toBeGreaterThan(0);
  });

  it('checkEscape inside the danger moment; the king takes the checker → no quiz', () => {
    const g04 = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4', 'Qa4', 'Nxc2+'];
    const check: TeachDanger = { kind: 'check', factRu: '', textRu: '', squares: [], arrows: [] };
    const inp = { ...inputAfter(g04, 1, [['Qxc2', 390], ['Kd1', -551], ['Ke2', -671]]), proof: engineProof(fenOf(g04), scripted(fenOf(g04), [['Qxc2', 390], ['Kd1', -551], ['Ke2', -671]], 12)) };
    const q = dangerQuiz(inp, check);
    expect(q?.kind).toBe('checkEscape');
    expect(q?.correct).toBe('escCapture');
    expect(q?.options.map((o) => o.id).sort()).toEqual(['escBlock', 'escCapture', 'escKing']);
    expect(q?.explain).toMatchObject({ kind: 'pool', pool: 'v3.quiz.explain.escCapture' });
    const kingFen = '4k3/8/8/8/8/3B4/4q3/4K3 w - - 0 1';
    const kingInp: QuizInput = { ...inp, fen: kingFen, proof: engineProof(kingFen, scripted(kingFen, [['Kxe2', 900], ['Bxe2', 890]])), advice: { uci: 'e1e2', san: 'Kxe2' } };
    expect(dangerQuiz(kingInp, check)).toBeNull();
  });

  it('the danger quiz: «Что соперник может съесть?» with a hanging knight', () => {
    const fen = '6k1/8/8/4p3/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';
    const hanging: TeachDanger = { kind: 'hanging', factRu: '', textRu: '', squares: ['d4'], arrows: [{ from: 'e5', to: 'd4' }], piece: { piece: 'n', square: 'd4' } };
    const inp: QuizInput = { stage: 1, fen, childColor: 'w', ply: 21, proof: null, advice: { uci: 'd4f5', san: 'Nf5' }, opponent: null, threat: undefined, lastChild: null, lastAdvice: null, adviceShown: [], rng: constRng(0) };
    const q = dangerQuiz(inp, hanging);
    expect(q?.kind).toBe('danger');
    expect(q?.correct).toBe('n');
    expect(q?.questionPool).toBe('v3.quiz.q.danger');
    // the question shows no threat (it would give the answer away)
    expect(q?.questionFacts.victim).toBeUndefined();
    expect(q?.explain).toMatchObject({ kind: 'pool', pool: 'v3.quiz.explain.danger', subjects: { victim: 'n' } });
  });

  it('a recalled concept puts its quiz first', () => {
    expect(recallQuizKinds('mistake.hanging')).toEqual(['canCapture']);
    expect(recallQuizKinds('quiz.whichPiece')).toEqual(['whichPiece']);
    expect(recallQuizKinds('theme.center')).toEqual([]);
    expect(recallQuizKinds(null)).toEqual([]);
  });
});
