/**
 * The length of a danger utterance (docs/TEACHING.md §2.2 «Длина одной реплики»): 16 words at stages 1–2, 22 at
 * 3–5 (with its mini-lesson 32) — the cap narrows each part's bag to the wordings that fit (the bag still chooses among
 * them), then the danger sentence gives way to the advice whose words already say it; never over the cap. A SYNTHETIC library where every pool has a short wording and one as long as the
 * writing rules allow (a whole line 14 words, a lead 7, a tail 10); some pools can be switched to their long wording only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, CoachEvent, Color, EngineLine, StudentProfile } from '@gambit/shared';
import { initialTeachMemory } from '../teacher.ts';
import type { TeachContext, TeachMemory } from '../teacher.ts';
import { profile as makeProfile } from '../test-fixtures.ts';
import { createLessonBook } from './book.ts';
import { lessonTurn } from './director.ts';
import './engine.ts';
import { initialLessonMemory } from './memory.ts';
import { compose, fitSents } from './turn.ts';
import type { Sent } from './turn.ts';
import type { LessonMemory } from './types.ts';

const mode = vi.hoisted(() => ({ longOnly: new Set<string>(), long: new Set<string>() }));

vi.mock('@gambit/content', async (importOriginal) => {
  const real = await importOriginal<typeof import('@gambit/content')>();
  const NUM = ['раз', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать'];
  const words = (k: number): string => NUM.slice(0, k).join(' ');
  const lines = real.LESSON_POOLS.map((spec) => {
    const option = spec.id.startsWith('v3.quiz.opt.') || spec.id.startsWith('v3.quiz.cat.');
    const piece = spec.subject ? (spec.role === 'lead' ? ' {конём}' : ' {коня}') : '';
    const extra = piece ? 1 : 0;
    // short: 3 words; long: the writing rule's maximum (whole 14, lead 7, tail 10)
    const make = (long: boolean, tag = ''): string => {
      if (option) return long ? 'Кнопка два' : 'Кнопка';
      if (spec.role === 'lead') return `Ведущая ${words(long ? 6 - extra : 2 - extra)}${tag}${piece}`;
      if (spec.role === 'tail') return `— хвост ${words(long ? 9 - extra : 2 - extra)}${tag}${piece}.`;
      return `Фраза ${words(long ? 13 - extra : 2 - extra)}${tag}${piece}.`;
    };
    const wordings: { t: string; when?: string[] }[] = [{ t: make(false) }, { t: make(true) }];
    (spec.variants ?? []).forEach((v) => {
      wordings.push({ t: make(false).replace(/(\.?)$/u, ` вариант$1`), when: [v] }, { t: make(true).replace(/(\.?)$/u, ` вариант$1`), when: [v] });
    });
    for (const w of wordings) if (/одиннадцать|восемь|пять/u.test(w.t)) mode.long.add(w.t);
    return { ...spec, wordings };
  });
  const byId = new Map(lines.map((l) => [l.id, l] as const));
  const lessonLine = (id: string): (typeof lines)[number] | undefined => {
    const l = byId.get(id);
    if (!l || !mode.longOnly.has(id)) return l;
    return { ...l, wordings: l.wordings.filter((w) => mode.long.has(w.t)) };
  };
  return { ...real, LESSON_LINES: lines, lessonLine };
});

type LineSpec = [string, number];

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
  const lines: EngineLine[] = specs.map(([san, cp], i) => ({ multipv: i + 1, depth, pvUci: [uciOf(fen, san)], cp, mate: null }));
  return { fen, lines, bestmove: lines[0]?.pvUci[0] ?? '', depth, timeMs: 300 };
}

function prof(stage: number): StudentProfile {
  return makeProfile({ stage, address: 'm' });
}

/** Quizzes / minis out of the way (a quiz «asked in the future», both mini slots used). */
const QUIET_LESSON: Partial<LessonMemory> = {
  quizzes: [{ turn: 999, ply: 0, kind: 'why', correct: null }],
  minis: [
    { turn: 0, ply: 0, topic: 'x', level: 1, slot: 'opening' },
    { turn: 0, ply: 0, topic: 'y', level: 1, slot: 'tactic' },
  ],
};

function memoryWith(lesson: Partial<LessonMemory>): TeachMemory {
  return { ...initialTeachMemory(), lesson: { ...initialLessonMemory(), ...lesson } };
}

function pools(ev: CoachEvent | null): string[] {
  return (ev?.say ?? []).map((s) => s.pool);
}

function wordsOf(ev: CoachEvent | null): number {
  return (ev?.text ?? '').split(/\s+/u).filter((x) => /[А-Яа-яЁё]/u.test(x)).length;
}

const HANGING_FEN = '6k1/8/8/4p3/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';
const KNIGHT: LineSpec[] = [['Nf5', 300], ['Nb5', 280], ['Ne2', 250]];
const QUEEN_SANS = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4'];
const QUEEN: LineSpec[] = [['Bxf7+', -439], ['Qa4', -446], ['Qg3', -452]];

function hangingCtx(stage: number, seedMemory: Partial<LessonMemory> = QUIET_LESSON, tc: TeachContext['tc'] = 'training'): TeachContext {
  return { fen: HANGING_FEN, ply: 41, childColor: 'w', profile: prof(stage), analysis: scripted(HANGING_FEN, KNIGHT), lastBotMove: null, historySan: [], tc, memory: memoryWith({ ...seedMemory, turn: 5 }) };
}

function queenCtx(stage: number): TeachContext {
  const fen = fenOf(QUEEN_SANS);
  const before = fenOf(QUEEN_SANS.slice(0, -1));
  return {
    fen,
    ply: QUEEN_SANS.length + 1,
    childColor: 'w' as Color,
    profile: prof(stage),
    analysis: scripted(fen, QUEEN, 12),
    lastBotMove: { uci: uciOf(before, 'Nd4'), san: 'Nd4', fenBefore: before },
    historySan: QUEEN_SANS,
    tc: 'training',
    memory: memoryWith({ ...QUIET_LESSON, turn: 5 }),
  };
}

afterEach(() => {
  mode.longOnly.clear();
});

describe('fitSents / compose: the cap narrows the bag, it never chooses the words (§2.2, §2.11)', () => {
  const w = { stage: 2 as const, g: 'm' as const };
  const n = { mover: 'n', target: 'n', victim: 'n', defended: 'n' } as const;
  const danger = (): Sent => ({ key: 'danger', prio: 100, core: true, parts: [{ pool: 'v3.danger.check' }], facts: null });
  const advice = (): Sent => ({ key: 'advice', prio: 95, core: true, parts: [{ pool: 'v3.lead.advice', subjects: n }, { pool: 'v3.idea.develop', subjects: n }], facts: null });

  it('the sentences fit when the shortest wordings of their bags do; null when even those do not', () => {
    const [s, a] = [danger(), advice()];
    expect(fitSents([s, a], 40, w)).toEqual([s, a]);
    expect(fitSents([s, a], 10, w)).toEqual([s, a]); // 3 + 3 + 3 words
    expect(fitSents([s, a], 5, w)).toBeNull();
  });

  it('within the room the bag picks among ALL the wordings that fit, not the shortest every time', () => {
    const b = createLessonBook({ seed: 3 });
    const picked: number[] = [];
    for (let i = 0; i < 2; i++) {
      const c = compose([danger(), advice()], { cap: 22, maxSentences: 3 }, w, b);
      picked.push(c.picked.get('danger')?.[0]?.n ?? 0);
      b.noteSaid(c.rendered.text);
    }
    // the short (3 words) and the long (14 words) danger line both fit 22 words with the advice: the bag takes both
    expect([...picked].sort()).toEqual([1, 2]);
  });

  it('a droppable sentence whose only fresh wording does not fit is dropped (never said again while another is left)', () => {
    const b = createLessonBook({ seed: 5 });
    // 16 words: only the short danger line fits with the advice
    const first = compose([danger(), advice()], { cap: 16, maxSentences: 3 }, w, b);
    expect(first.picked.get('danger')?.[0]?.n).toBe(1);
    b.noteSaid(first.rendered.text);
    // the short one was said; the long one is fresh but does not fit: the danger sentence cannot be said now
    expect(fitSents([danger(), advice()], 16, w, b)).toBeNull();
    expect(fitSents([advice()], 16, w, b)).not.toBeNull();
  });
});

describe('a danger utterance never goes over the cap (§2.2)', () => {
  it('stages 1–5 × seeds: the danger sentence kept in its short wording, ≤ 16 / 22 words', () => {
    for (const stage of [1, 2, 3, 4, 5]) {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const r = lessonTurn(hangingCtx(stage), createLessonBook({ seed }));
        expect(r.result.moment).toBe('danger');
        expect(wordsOf(r.result.event), r.result.event?.text).toBeLessThanOrEqual(stage <= 2 ? 16 : 22);
        expect(pools(r.result.event)[0]).toBe('v3.danger.hanging.undefended');
      }
    }
  });

  it('only a long danger line: at stages 1–2 it gives way to the rescuing advice (its words say it); at 3–5 it fits', () => {
    mode.longOnly.add('v3.danger.hanging.undefended');
    for (const seed of [1, 2, 3, 4]) {
      const young = lessonTurn(hangingCtx(2), createLessonBook({ seed }));
      expect(young.result.moment).toBe('danger');
      const p = pools(young.result.event);
      expect(p.some((x) => x.startsWith('v3.danger.')), p.join(' ')).toBe(false);
      expect(p.includes('v3.lead.rescue') || p.some((x) => /^v3\.(idea|aim|q)\.(escape|defend)$/u.test(x)), p.join(' ')).toBe(true);
      expect(wordsOf(young.result.event)).toBeLessThanOrEqual(16);
      expect(young.result.board.arrows).toContainEqual({ from: 'd4', to: 'f5', color: 'green' });
      const old = lessonTurn(hangingCtx(4), createLessonBook({ seed }));
      expect(pools(old.result.event)[0]).toBe('v3.danger.hanging.undefended');
      expect(wordsOf(old.result.event)).toBeLessThanOrEqual(22);
    }
  });

  it('the advice lets the queen go and the danger line is long: «можно не спасать» (with the red square) + the advice', () => {
    mode.longOnly.add('v3.danger.hanging.undefended');
    mode.longOnly.add('v3.danger.hanging.attacked');
    let checked = 0;
    for (const stage of [2, 3, 4, 5]) {
      const r = lessonTurn(queenCtx(stage), createLessonBook({ seed: stage }));
      if (r.plan.advice[0]?.san !== 'Bxf7+' || r.result.moment !== 'danger') continue;
      checked++;
      const p = pools(r.result.event);
      expect(p[0], p.join(' ')).toBe('v3.danger.letGo.check');
      expect(p.some((x) => /^v3\.(lead\.|go\.|helper$|whole\.)/u.test(x)), p.join(' ')).toBe(true);
      expect(wordsOf(r.result.event)).toBeLessThanOrEqual(stage <= 2 ? 16 : 22);
      expect((r.result.event?.cues ?? []).some((c) => c.sentence === 0 && (c.kind === 'hanging' || c.kind === 'threat'))).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('with its mini-lesson (the first danger of the game): ≤ 32 words, else the lesson waits', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = lessonTurn(hangingCtx(2, { quizzes: QUIET_LESSON.quizzes ?? [] }), createLessonBook({ seed }));
      const withMini = pools(r.result.event).some((x) => x.startsWith('v3.mini.'));
      expect(wordsOf(r.result.event), r.result.event?.text).toBeLessThanOrEqual(withMini ? 32 : 16);
      expect(r.memory.lesson?.minis.some((m) => m.topic === 'hanging')).toBe(withMini);
    }
  });

  it('blitz: one sentence within the cap', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = lessonTurn(hangingCtx(3, QUIET_LESSON, 'blitz5'), createLessonBook({ seed }));
      expect((r.result.event?.text ?? '').split(/(?<=[.!?…])\s+/u).filter((x) => x.trim() !== '')).toHaveLength(1);
      expect(wordsOf(r.result.event)).toBeLessThanOrEqual(22);
    }
  });
});
