/**
 * The bag against the word cap (docs/TEACHING.md §2.2, §2.11) after the second 50-game run: the cap narrows each
 * part to the wordings that fit, the BAG still chooses among them (not «the shortest every time»: «Ой-ой, твоего коня
 * могут забрать даром!» was heard 44 times, 9 in one game); a sentence whose fresh wordings do not fit is dropped rather
 * than repeated; no utterance repeats the last one. Also: blitz mini-lessons of one sentence only, no danger mini in
 * blitz; a quiz answer that shows the advice arrow keeps its words about the move; blitz «можно не спасать» at stage 1.
 *
 * A SYNTHETIC library (as ./turn.test.ts: every pool a few neutral wordings) where a test may replace the wordings of
 * a pool (`over`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, CoachEvent, Color, EngineLine, StudentProfile } from '@gambit/shared';
import { initialTeachMemory } from '../teacher.ts';
import type { TeachContext, TeachMemory } from '../teacher.ts';
import { profile as makeProfile } from '../test-fixtures.ts';
import { createLessonBook } from './book.ts';
import type { LessonBook } from './book.ts';
import { lessonAnswer, lessonHurry, lessonRepeat, lessonTurn } from './director.ts';
import './engine.ts';
import { initialLessonMemory } from './memory.ts';
import type { LessonMemory } from './types.ts';

const over = vi.hoisted(() => new Map<string, { t: string; when?: string[] }[]>());

vi.mock('@gambit/content', async (importOriginal) => {
  const real = await importOriginal<typeof import('@gambit/content')>();
  const RU = ['раз', 'два', 'три', 'четыре', 'пять', 'шесть'];
  const lines = real.LESSON_POOLS.map((spec) => {
    const option = spec.id.startsWith('v3.quiz.opt.') || spec.id.startsWith('v3.quiz.cat.');
    const piece = spec.subject ? (spec.role === 'lead' ? ' {конём}' : ' {коня}') : '';
    const make = (i: number): string => {
      if (option) return `Кнопка ${RU[i]}`;
      if (spec.role === 'lead') return `Ведущая ${RU[i]}${piece}`;
      if (spec.role === 'tail') return `— хвост ${RU[i]}${piece}.`;
      return `Фраза ${RU[i]}${piece}.`;
    };
    const wordings: { t: string; when?: string[] }[] = [0, 1, 2].map((i) => ({ t: make(i) }));
    (spec.variants ?? []).forEach((v, k) => wordings.push({ t: make(3 + (k % 3)).replace(/(\.?)$/u, ` вариант${'а'.repeat(k + 1)}$1`), when: [v] }));
    return { ...spec, wordings };
  });
  const byId = new Map(lines.map((l) => [l.id, l] as const));
  const lessonLine = (id: string): (typeof lines)[number] | undefined => {
    const l = byId.get(id);
    const o = over.get(id);
    return l && o ? { ...l, wordings: o } : l;
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

function memoryWith(lesson: Partial<LessonMemory>): TeachMemory {
  return { ...initialTeachMemory(), lesson: { ...initialLessonMemory(), ...lesson } };
}

const QUIET_LESSON: Partial<LessonMemory> = {
  quizzes: [{ turn: 999, ply: 0, kind: 'why', correct: null }],
  minis: [
    { turn: 0, ply: 0, topic: 'x', level: 1, slot: 'opening' },
    { turn: 0, ply: 0, topic: 'y', level: 1, slot: 'tactic' },
  ],
};

function ctxFen(fen: string, stage: number, specs: readonly LineSpec[], over2: Partial<TeachContext> = {}): TeachContext {
  return { fen, ply: 41, childColor: new Chess(fen).turn() as Color, profile: prof(stage), analysis: scripted(fen, specs), lastBotMove: null, historySan: [], tc: 'training', ...over2 };
}

function ctxAfter(sans: readonly string[], stage: number, specs: readonly LineSpec[], over2: Partial<TeachContext> = {}): TeachContext {
  const fen = fenOf(sans);
  const before = fenOf(sans.slice(0, -1));
  const last = sans[sans.length - 1] as string;
  return {
    fen,
    ply: sans.length + 1,
    childColor: 'w',
    profile: prof(stage),
    analysis: scripted(fen, specs),
    lastBotMove: { uci: uciOf(before, last), san: last, fenBefore: before },
    historySan: sans,
    tc: 'training',
    ...over2,
  };
}

function pools(ev: CoachEvent | null): string[] {
  return (ev?.say ?? []).map((s) => s.pool);
}

function wordsOf(text: string): number {
  return text.split(/\s+/u).filter((x) => /[А-Яа-яЁё]/u.test(x)).length;
}

function sentencesOf(ev: CoachEvent | null): string[] {
  return (ev?.text ?? '').split(/(?<=[.!?…])\s+/u).filter((s) => s.trim() !== '');
}

/** A wording of `n` words: «Слово раз два …» (+ the piece placeholder, which is one more word). */
function line(first: string, n: number, piece = ''): string {
  const RU = ['раз', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать'];
  return `${first} ${RU.slice(0, n - 1 - (piece ? 1 : 0)).join(' ')}${piece}.`.replace(/ \./u, '.');
}

const ADVICE_RE = /^v3\.(lead\.|go\.|helper$|whole\.)/u;

function rescueWords(said: readonly string[]): boolean {
  return said.includes('v3.lead.rescue') || said.some((p) => /^v3\.(idea|aim|q)\.(escape|defend|block|answerCheck|defendMate)$/u.test(p));
}

/** Say the event as the game does (the book remembers the last utterance). */
function heard(b: LessonBook, ev: CoachEvent | null): string {
  const text = ev?.text ?? '';
  b.noteSaid(text);
  return text;
}

const HANGING_FEN = '6k1/8/8/4p3/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';
const KNIGHT: LineSpec[] = [['Nf5', 300], ['Nb5', 280], ['Ne2', 250]];

afterEach(() => {
  over.clear();
});

describe('the danger wording: the bag within the cap, never the shortest every time (§2.11)', () => {
  // four short danger lines (3–6 words) and two long ones (13 words)
  const DANGER = [3, 4, 5, 6, 13, 13].map((n, i) => ({ t: line(`Опасность${'абвгде'[i]}`, n, ' {коня}') }));

  it('stage 1 (16 words): each short line once, then — only long unheard lines left — the danger sentence gives way to the rescuing advice', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      over.set('v3.danger.hanging.undefended', DANGER);
      const b = createLessonBook({ seed });
      const said: number[] = [];
      let last = '';
      for (let i = 0; i < 6; i++) {
        const r = lessonTurn({ ...ctxFen(HANGING_FEN, 1, KNIGHT), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }) }, b);
        expect(r.result.moment).toBe('danger');
        const ev = r.result.event;
        const d = (ev?.say ?? []).find((s) => s.pool === 'v3.danger.hanging.undefended');
        if (i < 4) {
          expect(d, ev?.text).toBeDefined();
          said.push(d?.n ?? 0);
        } else {
          // never a short line again while the long ones are unheard: the rescue in the advice's own words
          expect(d, ev?.text).toBeUndefined();
          expect(rescueWords(pools(ev)), pools(ev).join(' ')).toBe(true);
        }
        expect(wordsOf(ev?.text ?? '')).toBeLessThanOrEqual(16);
        expect(pools(ev).some((p) => ADVICE_RE.test(p))).toBe(true);
        const text = heard(b, ev);
        expect(text).not.toBe(last);
        last = text;
      }
      expect([...said].sort()).toEqual([1, 2, 3, 4]);
    }
  });

  it('stage 3 (22 words): the long lines fit too — six turns, six different lines', () => {
    over.set('v3.danger.hanging.undefended', DANGER);
    const b = createLessonBook({ seed: 9 });
    const said: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = lessonTurn({ ...ctxFen(HANGING_FEN, 3, KNIGHT), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }) }, b);
      said.push((r.result.event?.say ?? []).find((s) => s.pool === 'v3.danger.hanging.undefended')?.n ?? 0);
      expect(wordsOf(r.result.event?.text ?? '')).toBeLessThanOrEqual(22);
      heard(b, r.result.event);
    }
    expect([...said].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('never the same utterance twice in a row, even when the bag has a tie (both wordings heard once)', () => {
    over.set('v3.hurry', [{ t: 'Скорее, раз.' }, { t: 'Скорее, два.' }]);
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const b = createLessonBook({ seed });
      let last = '';
      for (let i = 0; i < 6; i++) {
        const text = heard(b, lessonHurry(prof(2), b));
        expect(text).not.toBe(last);
        last = text;
      }
    }
  });
});

describe('blitz mini-lessons (§2.2): one sentence of the lesson + the advice; no danger mini in blitz', () => {
  const OPEN = ['e4', 'e5', 'Nf3', 'Nc6'];
  const BC4: LineSpec[] = [['Bc4', 30], ['Bb5', 25], ['d4', 20]];
  const memory = (): TeachMemory => memoryWith({ turn: 2, quizzes: QUIET_LESSON.quizzes ?? [] });

  it('a level whose wordings are all longer than one sentence: no mini-lesson in blitz (the advice instead)', () => {
    over.set('v3.mini.thinking.l1', [{ t: 'Первое раз. Второе два.' }, { t: 'Сначала раз. Потом два. Ещё три.' }]);
    const r = lessonTurn({ ...ctxAfter(OPEN, 1, BC4, { tc: 'blitz5' }), memory: memory() }, createLessonBook({ seed: 3 }));
    expect(r.result.moment).not.toBe('mini');
    expect(pools(r.result.event).some((p) => p.startsWith('v3.mini.'))).toBe(false);
    expect(r.memory.lesson?.minis).toEqual([]);
    // (outside blitz the same lesson is told)
    const slow = lessonTurn({ ...ctxAfter(OPEN, 1, BC4), memory: memory() }, createLessonBook({ seed: 3 }));
    expect(slow.result.moment).toBe('mini');
  });

  it('blitz takes only the one-sentence wording of the level: lesson + advice, two sentences', () => {
    over.set('v3.mini.thinking.l1', [{ t: 'Первое раз. Второе два.' }, { t: 'Думаем раз два.' }, { t: 'Сначала раз. Потом два.' }]);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = lessonTurn({ ...ctxAfter(OPEN, 1, BC4, { tc: 'blitz5' }), memory: memory() }, createLessonBook({ seed }));
      expect(r.result.moment).toBe('mini');
      const m = (r.result.event?.say ?? []).find((s) => s.pool === 'v3.mini.thinking.l1');
      expect(m?.n).toBe(2);
      expect(sentencesOf(r.result.event)).toHaveLength(2);
      expect(pools(r.result.event).some((p) => ADVICE_RE.test(p))).toBe(true);
    }
  });

  it('the first danger of a blitz game: no mini-lesson — the rescuing advice alone, one sentence', () => {
    const r = lessonTurn({ ...ctxFen(HANGING_FEN, 2, KNIGHT, { tc: 'blitz5' }), memory: memoryWith({ turn: 5, quizzes: QUIET_LESSON.quizzes ?? [] }) }, createLessonBook({ seed: 4 }));
    expect(r.result.moment).toBe('danger');
    expect(pools(r.result.event).some((p) => p.startsWith('v3.mini.'))).toBe(false);
    expect(sentencesOf(r.result.event)).toHaveLength(1);
  });
});

describe('blitz at stage 1: a danger the advice does not solve (§2.2)', () => {
  // Кd4 hangs to the pawn e5; Сc1:g5 takes the queen instead
  const FEN = '6k1/8/8/4p1q1/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';
  const SPECS: LineSpec[] = [['Bxg5', 900], ['Nf5', -250], ['Nb5', -260]];

  it('«можно не спасать» + the advice (two sentences), never the danger sentence + the advice', () => {
    const r = lessonTurn({ ...ctxFen(FEN, 1, SPECS, { tc: 'blitz5' }), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }) }, createLessonBook({ seed: 2 }));
    expect(r.result.moment).toBe('danger');
    const p = pools(r.result.event);
    expect(p[0], p.join(' ')).toBe('v3.danger.letGo.stronger');
    expect(p.some((x) => x.startsWith('v3.danger.hanging.')), p.join(' ')).toBe(false);
    expect(sentencesOf(r.result.event)).toHaveLength(2);
  });

  it('no «можно не спасать» wording for the stage: the advice alone — one sentence, never the danger + the advice', () => {
    over.set('v3.danger.letGo.stronger', []);
    over.set('v3.danger.letGo.check', []);
    const r = lessonTurn({ ...ctxFen(FEN, 1, SPECS, { tc: 'blitz5' }), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }) }, createLessonBook({ seed: 2 }));
    expect(r.result.moment).toBe('danger');
    const p = pools(r.result.event);
    expect(p.some((x) => x.startsWith('v3.danger.')), p.join(' ')).toBe(false);
    expect(p.some((x) => ADVICE_RE.test(x)), p.join(' ')).toBe(true);
    expect(sentencesOf(r.result.event)).toHaveLength(1);
    expect(r.result.board.arrows).toContainEqual({ from: 'c1', to: 'g5', color: 'green' });
  });
});

describe('the quiz answer keeps its words about the move whenever it shows the arrow (§2.2)', () => {
  const SANS = ['e4', 'e5', 'Nc3', 'Bb4'];
  const SPECS: LineSpec[] = [['Nf3', 30], ['Nge2', 20], ['a3', 10]];

  function asked(stage: number, seed = 1): { r: ReturnType<typeof lessonTurn>; b: LessonBook } {
    const b = createLessonBook({ seed });
    const r = lessonTurn({ ...ctxAfter(SANS, stage, SPECS), threat: null, memory: memoryWith({ turn: 2 }) }, b);
    expect(r.result.quiz?.kind).toBe('oppIdea');
    return { r, b };
  }

  it('stages 1–2 (28 words): a long «верно» and a long truth are said with the advice — the arrow comes with its words', () => {
    for (const stage of [1, 2]) {
      for (const seed of [1, 2, 3]) {
        over.set('v3.quiz.right', [{ t: line('Верно', 10) }]);
        over.set('v3.quiz.wrong', [{ t: line('Почти', 10) }]);
        over.set('v3.opp.develop', [{ t: line('Соперник', 12, ' {коня}') }]);
        const { r, b } = asked(stage, seed);
        for (const id of [r.result.quiz?.correctId ?? '', r.result.quiz?.options.find((o) => o.id !== r.result.quiz?.correctId)?.id ?? '']) {
          const ans = lessonAnswer(r.plan, r.memory, id, b);
          const p = pools(ans.event);
          expect(p, ans.event.text).toContain('v3.opp.develop');
          expect(p.some((x) => ADVICE_RE.test(x)), `${stage}: ${ans.event.text}`).toBe(true);
          expect(wordsOf(ans.event.text)).toBeLessThanOrEqual(28);
          expect(ans.board.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });
          expect(ans.event.teach?.advice).toHaveLength(1);
          expect(ans.memory.lesson?.adviceShown).toContain(5);
        }
      }
    }
  });

  it('the opener and the truth are shortened for the advice: among two «верно» lines the one that leaves it room', () => {
    over.set('v3.quiz.right', [{ t: line('Верно', 3) }, { t: line('Правильно', 14) }]);
    over.set('v3.opp.develop', [{ t: line('Соперник', 12, ' {коня}') }]);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { r, b } = asked(1, seed);
      const ans = lessonAnswer(r.plan, r.memory, r.result.quiz?.correctId ?? '', b);
      expect(pools(ans.event)[0]).toBe('v3.quiz.right');
      expect(ans.event.say?.[0]?.n).toBe(1);
      expect(pools(ans.event).some((x) => ADVICE_RE.test(x)), ans.event.text).toBe(true);
    }
  });

  it('no room for the advice at all: no arrow with the answer — «Совет» shows it later with its words', () => {
    over.set('v3.quiz.right', [{ t: line('Верно', 14) }]);
    over.set('v3.opp.develop', [{ t: line('Соперник', 14, ' {коня}') }]);
    const { r, b } = asked(1);
    const ans = lessonAnswer(r.plan, r.memory, r.result.quiz?.correctId ?? '', b);
    const p = pools(ans.event);
    expect(p.some((x) => ADVICE_RE.test(x)), ans.event.text).toBe(false);
    expect(ans.board.arrows).toEqual([]);
    expect(ans.event.board?.arrows ?? []).toEqual([]);
    expect(ans.event.teach).toMatchObject({ advice: [], reveal: 'later' });
    expect(ans.memory.lesson?.adviceShown ?? []).not.toContain(5);
    expect((ans as { stopHints?: boolean }).stopHints).toBe(false);
    const sovet = lessonRepeat(r.plan, ans.memory, b);
    expect(pools(sovet.event)).toContain('v3.lead.reveal');
    expect(sovet.board.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });
  });
});
