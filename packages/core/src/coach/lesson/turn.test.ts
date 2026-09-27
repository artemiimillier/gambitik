/**
 * The turn half of the lesson director (docs/TEACHING.md §2.1–§2.7) through the director API, on real positions with
 * a scripted engine. The words come from a SYNTHETIC library (every pool of the spec gets a few neutral wordings, a
 * pointing one where the pool has a cue, a «лучше всего» lead) so the tests check the structure — moments, pools, cues,
 * arrows, memory — and never depend on the library's words. The real library is checked by ./engine.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, CoachEvent, Color, EngineLine, StudentProfile, Threat } from '@gambit/shared';
import { lessonLine } from '@gambit/content';
import { getStrategy } from '../../../../content/src/strategies.ts';
import { initialTeachMemory } from '../teacher.ts';
import type { TeachContext, TeachMemory } from '../teacher.ts';
import { profile as makeProfile } from '../test-fixtures.ts';
import { cueDrawable } from './board.ts';
import { createLessonBook } from './book.ts';
import type { LessonBook, Picked } from './book.ts';
import { lessonAnswer, lessonGameStart, lessonHurry, lessonOpponent, lessonRepeat, lessonReveal, lessonTurn, lessonWhy } from './director.ts';
import './engine.ts';
import { claimsBest, isDeictic } from './lint.ts';
import { initialLessonMemory } from './memory.ts';
import { renderUtterance } from './render.ts';
import { IDEA_MINI } from './mini.ts';
import { expectedQuizText, expectedSentenceText, requestSentenceOf } from '../clips/lessonPlan.ts';
import { DANGER_EVERY, compose, dangerCadenceClass, dangerClass, dangerSpoken, lessonHintsLive, mistakeJustTold, partArgs, turnMemoOf, warnedBefore } from './turn.ts';
import type { Sent } from './turn.ts';
import type { LessonMemory } from './types.ts';
import type { LessonTurnMemo } from '../teacher.ts';

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
    if (spec.cue.length > 0 && !option) {
      wordings.push({ t: spec.role === 'lead' ? `Вот сюда${piece}` : spec.role === 'tail' ? '— вот эти клетки.' : 'Смотри сюда.' });
    }
    if (spec.id === 'v3.lead.advice') wordings.unshift({ t: 'Лучше всего {конём}' });
    return { ...spec, wordings };
  });
  const byId = new Map(lines.map((l) => [l.id, l] as const));
  return { ...real, LESSON_LINES: lines, lessonLine: (id: string) => byId.get(id) };
});

// ───────────────────────── the scripted engine ─────────────────────────

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

function ctxAfter(sans: readonly string[], color: Color, stage: number, specs: readonly LineSpec[], over: Partial<TeachContext> & { depth?: number } = {}): TeachContext {
  const { depth, ...rest } = over;
  const fen = fenOf(sans);
  let lastBotMove: TeachContext['lastBotMove'] = null;
  if (sans.length > 0) {
    const before = fenOf(sans.slice(0, -1));
    lastBotMove = { uci: uciOf(before, sans[sans.length - 1] as string), san: sans[sans.length - 1] as string, fenBefore: before };
  }
  return { fen, ply: sans.length + 1, childColor: color, profile: prof(stage), analysis: scripted(fen, specs, depth), lastBotMove, historySan: sans, tc: 'training', ...rest };
}

function ctxFen(fen: string, stage: number, specs: readonly LineSpec[], over: Partial<TeachContext> & { depth?: number } = {}): TeachContext {
  const { depth, ...rest } = over;
  return { fen, ply: 41, childColor: new Chess(fen).turn(), profile: prof(stage), analysis: scripted(fen, specs, depth), lastBotMove: null, historySan: [], tc: 'training', ...rest };
}

function prof(stage: number, address: 'm' | 'f' = 'm'): StudentProfile {
  return makeProfile({ stage, address });
}

/** A TeachMemory with the lesson memory overridden. */
function memoryWith(lesson: Partial<LessonMemory>, over: Partial<TeachMemory> = {}): TeachMemory {
  return { ...initialTeachMemory(), ...over, lesson: { ...initialLessonMemory(), ...lesson } };
}

/** Quizzes / minis out of the way (a quiz «asked in the future», both mini slots used). */
const QUIET_LESSON: Partial<LessonMemory> = {
  quizzes: [{ turn: 999, ply: 0, kind: 'why', correct: null }],
  minis: [
    { turn: 0, ply: 0, topic: 'x', level: 1, slot: 'opening' },
    { turn: 0, ply: 0, topic: 'y', level: 1, slot: 'tactic' },
  ],
};

function pools(ev: CoachEvent | null): string[] {
  return (ev?.say ?? []).map((s) => s.pool);
}

/** The advice carries the rescue: the rescue lead, or the move's own rescue idea (escape / defend / block / check). */
function rescueWords(said: readonly string[]): boolean {
  return said.includes('v3.lead.rescue') || said.some((p) => /^v3\.(idea|aim|q)\.(escape|defend|block|answerCheck|defendMate)$/u.test(p));
}

function book(seed = 7): LessonBook {
  return createLessonBook({ seed });
}

const E2: LineSpec[] = [['Nf3', 19], ['Nc3', 8], ['Bc4', 8]];

afterEach(() => {
  vi.restoreAllMocks();
});

// ───────────────────────── the advice ─────────────────────────

describe('the advice moment', () => {
  it('say[] without clip / brief; the green arrow at once, its cue after the idea (at: end); the memory advances', () => {
    const b = book();
    const { plan, result, memory } = lessonTurn(ctxAfter(['e4', 'e5'], 'w', 1, E2), b);
    expect(result.moment).toBe('advice');
    const ev = result.event as CoachEvent;
    expect(ev.kind).toBe('teachTurn');
    expect(ev.say?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(ev.clip).toBeUndefined();
    expect(ev.brief).toBeUndefined();
    expect(ev.teach).toMatchObject({ moment: 'turn', ply: 3, reveal: 'now' });
    expect(result.board.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });
    expect(result.advice).toEqual([{ uci: 'g1f3', san: 'Nf3', source: 'engine', arrow: 'green' }]);
    const move = (ev.cues ?? []).filter((c) => c.kind === 'move');
    expect(move.length).toBeGreaterThan(0);
    expect(move.every((c) => c.at === 'end')).toBe(true);
    expect(memory.lesson?.turn).toBe(1);
    expect(memory.lesson?.lastAdvice).toMatchObject({ ply: 3, uci: 'g1f3', hidden: false });
    expect(memory.lesson?.adviceShown).toContain(3);
    expect(memory.lesson?.shapes.length).toBe(1);
    expect(plan.lesson?.moment).toBe('advice');
    expect(plan.memory).toBe(memory);
  });

  it('the five shapes take turns: never the same twice in a row, shape A at most once in three advices', () => {
    const b = book(3);
    let memory: TeachMemory = memoryWith(QUIET_LESSON);
    const shapes: string[] = [];
    for (let i = 0; i < 14; i++) {
      const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 3, E2), memory }, b);
      expect(r.result.moment).toBe('advice');
      shapes.push(r.plan.lesson?.shape ?? '-');
      memory = { ...r.memory, lesson: { ...(r.memory.lesson as LessonMemory), lastIdea: null } };
    }
    for (let i = 1; i < shapes.length; i++) expect(shapes[i], shapes.join('')).not.toBe(shapes[i - 1]);
    for (let i = 2; i < shapes.length; i++) expect(shapes.slice(i - 2, i + 1).filter((s) => s === 'A').length, shapes.join('')).toBeLessThanOrEqual(1);
    expect(new Set(shapes).size).toBeGreaterThanOrEqual(4);
  });

  it('«лучше всего» only when the advice is the engine\'s first move with a ≥ 3 win% gap', () => {
    const b = book(5);
    let memory: TeachMemory = memoryWith({ ...QUIET_LESSON, shapes: ['C', 'B'] });
    for (let i = 0; i < 12; i++) {
      // Nf3 19 vs Nc3 8: < 3 win% — the claim is never picked
      const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 3, E2), memory }, b);
      expect(r.result.event?.text ?? '').not.toMatch(/Лучше всего/u);
      memory = { ...r.memory, lesson: { ...(r.memory.lesson as LessonMemory), lastIdea: null, shapes: ['C', 'B'] } };
    }
    // a clear best move: the claim is allowed (the book may take it)
    let claimed = false;
    for (let i = 0; i < 60 && !claimed; i++) {
      const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 3, [['Nf3', 90], ['Nc3', -40], ['Bc4', -45]]), memory }, b);
      claimed = /Лучше всего/u.test(r.result.event?.text ?? '');
      memory = { ...r.memory, lesson: { ...(r.memory.lesson as LessonMemory), lastIdea: null, shapes: ['C', 'B'] } };
    }
    expect(claimed).toBe(true);
    expect(claimsBest('Лучше всего конём')).toBe(true);
  });

  it('stage 5: a calm advice is told first and shown later; the reveal shows the arrow', () => {
    const b = book();
    const { plan, result, memory } = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 5, E2), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }) }, b);
    expect(result.moment).toBe('advice');
    expect(result.adviceHidden).toBe(true);
    expect(result.revealAfterMs).toBe(15_000);
    expect(result.board.arrows).toEqual([]);
    expect(result.event?.board?.arrows ?? []).toEqual([]);
    expect((result.event?.cues ?? []).some((c) => c.kind === 'move' || c.kind === 'attacks' || c.kind === 'capture')).toBe(false);
    expect(result.event?.teach?.reveal).toBe('later');
    expect(memory.lesson?.adviceShown).not.toContain(3);
    const shown = lessonReveal(plan, memory, b);
    expect(shown.board.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });
    expect(pools(shown.event)[0]).toBe('v3.lead.reveal');
    expect(shown.event.teach?.moment).toBe('reveal');
    expect(shown.memory.lesson?.adviceShown).toContain(3);
  });

  it('stage 5 «позже» — the theme link is hidden with the advice (no cue of the move, no pointing word)', () => {
    const card = getStrategy('four-knights') ?? null;
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6', 'Bb5', 'Bb4', 'O-O', 'O-O', 'd3', 'd6'];
    const REVEAL = new Set(['move', 'capture', 'attacks', 'line', 'path', 'piece']);
    let checked = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = lessonTurn({ ...ctxAfter(sans, 'w', 5, [['Bg5', 30], ['Be3', 20], ['h3', 10]]), strategyCard: card, memory: memoryWith({ ...QUIET_LESSON, turn: 6 }) }, book(seed));
      const link = (r.result.event?.say ?? []).find((s) => s.pool.startsWith('v3.goal.') || s.pool.startsWith('v3.why.'));
      if (!r.result.adviceHidden || !link) continue;
      checked++;
      const said = pools(r.result.event).join(' ');
      expect((r.result.event?.cues ?? []).filter((c) => REVEAL.has(c.kind)), said).toEqual([]);
      expect(r.result.event?.board?.arrows ?? [], said).toEqual([]);
      expect(r.result.board.arrows, said).toEqual([]);
      expect(isDeictic(lessonLine(link.pool)?.wordings[link.n - 1]?.t ?? ''), said).toBe(false);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('without an engine (rules mode) the turn still works: a curated move is never «я проверил, так сильнее»', () => {
    const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 2, E2), analysis: null, mainLineSans: ['Nf3'] }, book());
    expect(r.result.moment).toBe('advice');
    expect(pools(r.result.event)).not.toContain('v3.idea.none');
    const late = lessonTurn({ fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 40', ply: 79, childColor: 'w', profile: prof(3), analysis: null }, book());
    expect(late.result.advice).toEqual([]);
    expect(late.result.event).toBeNull();
  });

  it('pointing words only for a cue the board can draw (deixis = false otherwise)', () => {
    const facts = { fen: fenOf(['e4', 'e5']), childColor: 'w' as const, move: { uci: 'g1f3' } };
    const s = (pool: string, hide = false): Sent => ({ key: 'x', prio: 1, parts: [{ pool }], facts, ...(hide ? { hide: true } : {}) });
    const w = { stage: 3 as const, g: 'm' as const };
    expect(partArgs({ pool: 'v3.theme.remind.center' }, s('v3.theme.remind.center'), w).deixis).toBe(true);
    expect(partArgs({ pool: 'v3.theme.remind.kingsideAttack' }, s('v3.theme.remind.kingsideAttack'), w).deixis).toBe(false); // the flank is not drawn
    expect(partArgs({ pool: 'v3.go.move' }, s('v3.go.move'), w).deixis).toBe(true);
    expect(partArgs({ pool: 'v3.go.move' }, s('v3.go.move', true), w).deixis).toBe(false); // a hidden move
    expect(partArgs({ pool: 'v3.theme.left' }, s('v3.theme.left'), w).deixis).toBe(false); // no cue at all
  });
});

// ───────────────────────── treasure ─────────────────────────

describe('the treasure', () => {
  const FORK = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
  const specs: LineSpec[] = [['Nc7+', 480, 'Kd7', 'Nxa8'], ['Kd2', 0], ['Ke2', 0]];

  it('a fork on stage 5 is a treasure to find, not an arrow', () => {
    const r = lessonTurn(ctxFen(FORK, 5, specs), book());
    expect(r.plan.treasure).not.toBeNull();
    expect(r.result.moment).toBe('treasure');
    expect(r.result.adviceHidden).toBe(true);
    expect(r.result.board.arrows).toEqual([]);
    expect(r.result.event?.board?.arrows ?? []).toEqual([]);
    expect(r.result.revealAfterMs).toBe(15_000);
    expect(r.result.hints).toEqual([{ atMs: 8_000, board: { arrows: [], highlights: [{ square: expect.any(String), color: 'yellow' }] } }]);
    expect(pools(r.result.event)).toEqual(['v3.treasure.hunt', 'v3.treasure.ask']);
    expect(r.memory.lesson?.treasureTurns).toEqual([1]);
    expect(r.memory.lesson?.lastAdvice).toMatchObject({ uci: 'b5c7', hidden: true });
  });

  it('stages 1–2: the kind of the gift, the target lit at once, our piece after 5 s, the arrow after 10 s', () => {
    const r = lessonTurn(ctxFen(FORK, 1, specs), book());
    expect(r.result.moment).toBe('treasure');
    expect(pools(r.result.event)[0]).toBe('v3.treasure.fork');
    expect(r.result.board.highlights.length).toBeGreaterThan(0);
    expect(r.result.hints[0]?.atMs).toBe(5_000);
    expect(r.result.hints[0]?.board.highlights).toContainEqual({ square: 'b5', color: 'blue' });
    expect(r.result.revealAfterMs).toBe(10_000);
  });

  it('the gift\'s own mini-lesson waits for the reveal (the tactic slot, once)', () => {
    const b = book();
    const r = lessonTurn(ctxFen(FORK, 3, specs), b);
    expect(pools(r.result.event).some((p) => p.startsWith('v3.mini.'))).toBe(false);
    const shown = lessonReveal(r.plan, r.memory, b);
    expect(pools(shown.event)[0]).toBe('v3.lead.reveal');
    expect(pools(shown.event)).toContain('v3.mini.fork.l1');
    expect(shown.event.teach?.conceptId).toBe('fork');
    expect(shown.memory.lesson?.minis.map((m) => m.topic)).toEqual(['fork']);
    expect(shown.board.arrows).toContainEqual({ from: 'b5', to: 'c7', color: 'green' });
    // a second show of the same gift does not repeat the lesson
    const again = lessonRepeat(r.plan, shown.memory, b);
    expect(pools(again.event)).not.toContain('v3.mini.fork.l1');
  });

  it('the mate-in-one lesson after a mate gift is revealed lights the opponent\'s king, never ours', () => {
    const MATE = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
    const mateSpecs: LineSpec[] = [['Ra8#', { mate: 1 }], ['Kf1', 0], ['h3', 0]];
    let checked = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const b = book(seed);
      const r = lessonTurn(ctxFen(MATE, 1, mateSpecs), b);
      if (r.result.moment !== 'treasure') continue;
      const shown = lessonReveal(r.plan, r.memory, b);
      const said = pools(shown.event);
      const mi = said.indexOf('v3.mini.mateInOne.l1');
      if (mi < 0) continue;
      checked++;
      const kings = (shown.event.cues ?? []).filter((c) => c.kind === 'king').flatMap((c) => c.squares);
      expect(kings, said.join(' ')).not.toContain('g1');
      expect(shown.board.highlights.map((h) => h.square), said.join(' ')).not.toContain('g1');
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('over the cap the gift is an ordinary advice with its arrow', () => {
    const memory = memoryWith({ turn: 9, treasureTurns: [1, 4, 7] });
    const r = lessonTurn({ ...ctxFen(FORK, 1, specs), memory }, book());
    expect(r.result.moment).not.toBe('treasure');
    expect(r.result.board.arrows).toContainEqual({ from: 'b5', to: 'c7', color: 'green' });
  });
});

// ───────────────────────── the theme ─────────────────────────

describe('the theme in the turn', () => {
  const italian = getStrategy('italian') ?? null;
  const announced = memoryWith({ theme: { announced: true, named: false, recalled: false, lastRemindTurn: null, links: [] } });

  it('1.e4 c5 with the Italian card — the name is never said; after 1…e5 it is', () => {
    const b = book();
    const c5 = lessonTurn({ ...ctxAfter(['e4', 'c5'], 'w', 3, [['Nf3', 30], ['Nc3', 20], ['d4', 10]]), strategyCard: italian, memory: announced }, b);
    expect(pools(c5.result.event).some((p) => p.startsWith('v3.theme.named.'))).toBe(false);
    expect(c5.memory.lesson?.theme.named).toBe(false);
    const e5 = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 3, [['Nf3', 30], ['Nc3', 20], ['d4', 10]]), strategyCard: italian, memory: announced }, b);
    expect(pools(e5.result.event)).toContain('v3.theme.named.italian');
    expect(e5.memory.lesson?.theme.named).toBe(true);
  });

  it('the game start: the family at stages 1–2 / for White before move 1, the name at 3–5, the recall in one of two games', () => {
    const b = book();
    const w1 = lessonGameStart({ profile: prof(1), childColor: 'w', tc: 'training', coachStyle: 'teacher', strategy: null, strategyCard: italian, historySan: [], fen: new Chess().fen() }, initialTeachMemory(), b);
    expect(w1.events.map((e) => pools(e)[0])).toEqual(['v3.theme.family.f7']);
    expect(w1.events[0]).toMatchObject({ kind: 'gameStart', teach: { moment: 'theme' } });
    expect(w1.events[0]?.clip).toBeUndefined();
    expect(w1.memory.lesson?.theme).toMatchObject({ announced: true, named: false });
    const sicilian = getStrategy('sicilian') ?? null;
    const b3 = lessonGameStart({ profile: prof(3), childColor: 'b', tc: 'training', coachStyle: 'teacher', strategy: null, strategyCard: sicilian, historySan: ['e4'], fen: fenOf(['e4']) }, initialTeachMemory(), b);
    expect(pools(b3.events[0] ?? null)).toEqual(['v3.theme.sicilian']);
    expect(b3.memory.lesson?.theme.named).toBe(true);
    const odd = createLessonBook({ seed: 1, history: { v: 1, gameSeq: 1, recent: {}, minis: {}, habits: {}, takeaways: [{ game: 0, key: 'mistake.hanging' }], habitSaid: {} } });
    const rec = lessonGameStart({ profile: prof(2), childColor: 'w', tc: 'training', coachStyle: 'teacher', strategy: null, strategyCard: italian, historySan: [], fen: new Chess().fen() }, initialTeachMemory(), odd);
    expect(rec.events.map((e) => pools(e)[0])).toEqual(['v3.theme.family.f7', 'v3.recall.mistake.hanging']);
    expect(rec.memory.lesson?.theme.recalled).toBe(true);
    const helper = lessonGameStart({ profile: prof(2), childColor: 'w', tc: 'training', coachStyle: 'helper', strategy: null, strategyCard: italian, historySan: [], fen: new Chess().fen() }, initialTeachMemory(), b);
    expect(helper.events).toEqual([]);
  });
});

// ───────────────────────── danger ─────────────────────────

describe('the danger moment', () => {
  const HANGING_FEN = '6k1/8/8/4p3/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';

  it('«спасаем» when the advice saves the piece; the first danger of the game brings its mini-lesson', () => {
    const r = lessonTurn(ctxFen(HANGING_FEN, 2, [['Nf5', 300], ['Nb5', 280], ['Ne2', 250]]), book());
    expect(r.result.moment).toBe('danger');
    const said = pools(r.result.event);
    expect(said[0]).toBe('v3.danger.hanging.undefended');
    expect(rescueWords(said), said.join(' ')).toBe(true);
    expect(said).toContain('v3.mini.hanging.l1');
    expect(r.result.event?.teach).toMatchObject({ moment: 'mini', conceptId: 'hanging-piece' });
    expect(r.result.board.arrows).toContainEqual({ from: 'd4', to: 'f5', color: 'green' });
    expect(r.memory.lesson?.lastDanger).toMatchObject({ ply: 41, square: 'd4', kind: 'hanging' });
    expect(r.memory.lesson?.minis.map((m) => m.topic)).toEqual(['hanging']);
    // the arrow of a danger is shown at once (not after the sentence)
    expect((r.result.event?.cues ?? []).filter((c) => c.kind === 'move').every((c) => c.at !== 'end')).toBe(true);
  });

  it('the advice does not save the queen (Сxf7+ is stronger): «можно не спасать», never «спасаем»', () => {
    const sans = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4'];
    const r = lessonTurn(ctxAfter(sans, 'w', 3, [['Bxf7+', -439], ['Qa4', -446], ['Qg3', -452]], { depth: 12 }), book());
    expect(r.result.moment).toBe('danger');
    const said = pools(r.result.event);
    if (r.plan.advice[0]?.san === 'Bxf7+') {
      expect(said).toContain('v3.danger.letGo.check');
      expect(said).not.toContain('v3.lead.rescue');
    }
  });

  it('a poisoned «hanging» piece (the threat search found nothing) is no danger', () => {
    const r = lessonTurn(ctxFen(HANGING_FEN, 2, [['Nf5', 300], ['Nb5', 280], ['Ne2', 250]], { threat: null }), book());
    expect(r.result.moment).not.toBe('danger');
    expect(pools(r.result.event).some((p) => p.startsWith('v3.danger.'))).toBe(false);
  });

  it('the danger quiz: «Шах! Как спасаемся?» when a quiz is due and the way out is proven', () => {
    const g04 = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4', 'Qa4', 'Nxc2+'];
    const r = lessonTurn({ ...ctxAfter(g04, 'w', 1, [['Qxc2', 390], ['Kd1', -551], ['Ke2', -671]], { depth: 12 }), memory: memoryWith({ turn: 5 }) }, book());
    expect(r.result.moment).toBe('danger');
    expect(r.result.quiz?.kind).toBe('checkEscape');
    expect(r.result.quiz?.correctId).toBe('escCapture');
    expect(r.result.quiz?.options.map((o) => o.id).sort()).toEqual(['escBlock', 'escCapture', 'escKing']);
    expect(r.result.adviceHidden).toBe(true);
    expect(r.result.board.arrows).toEqual([]);
    expect(r.result.event?.priority).toBe(2);
    expect(r.result.event?.quiz?.id).toBe(r.result.quiz?.id);
    const ans = lessonAnswer(r.plan, r.memory, 'escCapture', book());
    expect(ans.correct).toBe(true);
    expect(pools(ans.event)).toEqual(expect.arrayContaining(['v3.quiz.right', 'v3.quiz.explain.escCapture']));
    expect(ans.board.arrows).toContainEqual({ from: 'a4', to: 'c2', color: 'green' });
  });

  it('the king takes the checker — no checkEscape quiz, the danger is said', () => {
    const fen = '4k3/8/8/8/8/3B4/4q3/4K3 w - - 0 1';
    const r = lessonTurn({ ...ctxFen(fen, 1, [['Kxe2', 900], ['Bxe2', 890]]), memory: memoryWith({ turn: 5 }) }, book());
    expect(r.result.moment).toBe('danger');
    expect(r.result.quiz).toBeNull();
    expect(pools(r.result.event)[0]).toBe('v3.danger.check');
  });
});

// ───────────────────────── quiz ─────────────────────────

describe('the quiz moment and the answer', () => {
  const sans = ['e4', 'e5', 'Nc3', 'Bb4'];
  const specs: LineSpec[] = [['Nf3', 30], ['Nge2', 20], ['a3', 10]];

  function asked(stage = 1): ReturnType<typeof lessonTurn> {
    return lessonTurn({ ...ctxAfter(sans, 'w', stage, specs), threat: null, memory: memoryWith({ turn: 2 }) }, book());
  }

  it('«Что задумал соперник?» first; the answer is proven, «напасть» is never a wrong button; the arrow waits', () => {
    const r = asked();
    expect(r.result.moment).toBe('quiz');
    const q = r.result.quiz;
    expect(q?.kind).toBe('oppIdea');
    expect(q?.correctId).toBe('develop');
    expect(q?.options).toHaveLength(3);
    expect(q?.options.map((o) => o.id)).not.toContain('attack');
    expect(q?.options.every((o) => o.label.length > 0 && !/[.!?]$/u.test(o.label))).toBe(true);
    expect(q?.ply).toBe(5);
    expect(r.result.event?.quiz).toEqual(q);
    expect(r.result.event?.teach).toMatchObject({ moment: 'quiz', reveal: 'later', advice: [] });
    expect(r.result.adviceHidden).toBe(true);
    expect(r.result.revealAfterMs).toBe(20_000);
    expect(r.result.board.arrows).toEqual([]);
    // stage 1: the question, then the three options said aloud
    const said = pools(r.result.event);
    expect(said[0]).toBe('v3.quiz.q.oppIdea');
    expect(said.filter((p) => p.startsWith('v3.quiz.cat.'))).toHaveLength(3);
    expect(q?.question).toBe(r.result.event?.text.split(/(?<=[.!?…])\s+/u)[0]);
    // for the recorded voice: the question is its wording, the options sentence its buttons as ids into `say`
    const ev = r.result.event as CoachEvent;
    const ss = ev.saySentences ?? [];
    expect(ss.map((x) => x.text).join(' ')).toBe(ev.text);
    expect(ss[0]).toEqual({ text: q?.question, parts: [0] });
    expect(ss[1]).toMatchObject({ parts: [], quiz: { kind: 'oppIdea', options: [{ say: 1 }, { say: 2 }, { say: 3 }] } });
    const ids = requestSentenceOf(ev, ss[1] as NonNullable<typeof ss[1]>);
    expect(ids && 'quiz' in ids ? expectedQuizText(ids.quiz) : null).toBe(ss[1]?.text);
    expect(r.memory.lesson?.quizzes).toEqual([{ turn: 3, ply: 5, kind: 'oppIdea', correct: null }]);
    expect(r.memory.lesson?.lastAdvice?.hidden).toBe(true);
  });

  it('right: «верно» + the truth + the advice with its arrow; wrong: softly + the same truth; skipped: the truth', () => {
    const r = asked();
    const right = lessonAnswer(r.plan, r.memory, 'develop', book());
    expect(right.correct).toBe(true);
    expect(pools(right.event)[0]).toBe('v3.quiz.right');
    expect(pools(right.event)).toContain('v3.opp.develop');
    expect(right.event.teach?.moment).toBe('answer');
    expect(right.board.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });
    expect(right.memory.lesson?.quizzes[0]?.correct).toBe(true);
    expect(right.memory.lesson?.adviceShown).toContain(5);
    const wrongId = r.result.quiz?.options.find((o) => o.id !== 'develop')?.id ?? '';
    const wrong = lessonAnswer(r.plan, r.memory, wrongId, book());
    expect(wrong.correct).toBe(false);
    expect(pools(wrong.event)[0]).toBe('v3.quiz.wrong');
    expect(pools(wrong.event)).toContain('v3.opp.develop');
    const skipped = lessonAnswer(r.plan, r.memory, null, book());
    expect(skipped.correct).toBeNull();
    expect(pools(skipped.event)).not.toContain('v3.quiz.right');
    expect(pools(skipped.event)).not.toContain('v3.quiz.wrong');
    expect(skipped.memory.lesson?.quizzes[0]?.correct).toBeNull();
  });

  it('a quiz asked at this ply is never asked again (a resumed game re-plans the ply as an advice)', () => {
    const r = asked();
    const again = lessonTurn({ ...ctxAfter(sans, 'w', 1, specs), threat: null, memory: { ...r.memory, lesson: { ...(r.memory.lesson as LessonMemory), turn: 2 } } }, book());
    expect(again.result.moment).not.toBe('quiz');
  });
});

describe('saySentences (the recorded voice, «Дозапись голоса»)', () => {
  const W = { stage: 1, g: 'f' } as const;
  const question: Sent = { key: 'question', prio: 100, core: true, parts: [{ pool: 'v3.quiz.q.oppIdea' }], facts: null };
  const pair: Sent = { key: 'advice', prio: 95, core: true, parts: [{ pool: 'v3.lead.advice', subjects: { mover: 'n' } }, { pool: 'v3.idea.develop', subjects: { mover: 'n' } }], facts: null };

  it('renderUtterance: sentence i is the i-th sentence, its parts index `say` (empty specs are skipped)', () => {
    const b = book();
    const pick = (pool: string, piece?: 'n'): Picked => {
      const p = b.pick(pool, { stage: 1, g: 'f', ...(piece ? { piece } : {}) });
      if (!p) throw new Error(pool);
      return p;
    };
    const r = renderUtterance([null, { parts: [pick('v3.lead.advice', 'n'), pick('v3.idea.develop', 'n')] }, { parts: [] }, { parts: [pick('v3.quiz.right')] }]);
    expect(r.saySentences).toEqual([
      { text: r.sentences[0], parts: [0, 1] },
      { text: r.sentences[1], parts: [2] },
    ]);
    expect(r.saySentences.map((x) => x.text).join(' ')).toBe(r.text);
    r.saySentences.forEach((x) => expect(expectedSentenceText(x.parts.map((k) => r.say[k] as NonNullable<(typeof r.say)[number]>))).toBe(x.text));
  });

  it('compose: sentence i is the i-th rendered sentence, its parts index the event`s `say`', () => {
    const c = compose([pair, question], { cap: 40, maxSentences: 3 }, W, book());
    const { sentences, say, saySentences } = c.rendered;
    expect(saySentences.map((x) => x.text)).toEqual(sentences);
    expect(saySentences.map((x) => x.parts)).toEqual([[0, 1], [2]]);
    saySentences.forEach((x) => expect(expectedSentenceText(x.parts.map((k) => say[k] as NonNullable<(typeof say)[number]>))).toBe(x.text));
    expect(saySentences.map((x) => x.text).join(' ')).toBe(c.rendered.text);
  });

  it('compose: the options sentence carries its buttons as ids, shifted into the event`s `say` (pieces by type)', () => {
    const options: Sent = {
      key: 'options',
      prio: 90,
      parts: [],
      facts: null,
      literal: { text: 'Конём, кнопка раз или слоном?', say: [{ pool: 'v3.quiz.cat.attack', n: 1 }], quiz: { kind: 'whichPiece', options: [{ piece: 'n' }, { say: 0 }, { piece: 'b' }] } },
    };
    const c = compose([question, options], { cap: 40, maxSentences: 2 }, W, book());
    const ss = c.rendered.saySentences;
    expect(ss[1]).toEqual({ text: 'Конём, кнопка раз или слоном?', parts: [], quiz: { kind: 'whichPiece', options: [{ piece: 'n' }, { say: 1 }, { piece: 'b' }] } });
    expect(c.rendered.say[1]).toEqual({ pool: 'v3.quiz.cat.attack', n: 1 });
    const ids = requestSentenceOf(c.rendered, ss[1] as NonNullable<(typeof ss)[1]>);
    expect(ids && 'quiz' in ids ? expectedQuizText(ids.quiz) : null).toBe('Конём, кнопка раз или слоном?');
    // a literal without ids (never recorded) still marks its sentence, with no parts
    const bare = compose([question, { ...options, literal: { text: 'Раз, два или три?', say: [] } }], { cap: 40, maxSentences: 2 }, W, book());
    expect(bare.rendered.saySentences[1]).toEqual({ text: 'Раз, два или три?', parts: [] });
  });
});

// ───────────────────────── quiet, «Сам», mini ─────────────────────────

describe('quiet, «Сам» and the mini-lesson', () => {
  it('quiet (stage 1): the same idea with the same piece — a sound word, no bubble, the arrow at once; at most twice', () => {
    const b = book();
    const first = lessonTurn(ctxAfter(['e4', 'e5'], 'w', 1, E2), b);
    const idea = first.memory.lesson?.lastIdea;
    expect(idea).not.toBeNull();
    let memory: TeachMemory = memoryWith({ ...QUIET_LESSON, turn: 5, lastIdea: idea ?? null });
    const moments: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 1, E2), memory }, b);
      moments.push(r.result.moment);
      if (r.result.moment === 'quiet') {
        expect(r.result.event).toBeNull();
        expect(r.result.bark).not.toBeNull();
        expect(r.result.board.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });
      }
      memory = r.memory;
    }
    expect(moments).toEqual(['quiet', 'quiet', 'advice']);
  });

  it('«Сам» (stage 2): after three followed arrows — find it yourself, the target lit, the arrow after 8 s', () => {
    const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 2, E2), memory: memoryWith({ ...QUIET_LESSON, turn: 4, followStreak: 3 }) }, book());
    expect(r.result.moment).toBe('self');
    expect(pools(r.result.event)[0]).toMatch(/^v3\.self\./);
    expect(r.result.adviceHidden).toBe(true);
    expect(r.result.revealAfterMs).toBe(8_000);
    expect(r.result.board.arrows).toEqual([]);
    expect(r.memory.lesson?.followStreak).toBe(0);
    expect(r.memory.lesson?.selfTurns).toEqual([5]);
    // «Совет» reveals it
    const rep = lessonRepeat(r.plan, r.memory, book());
    expect(pools(rep.event)[0]).toBe('v3.lead.reveal');
    expect(rep.board.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });
  });

  it('the mini-lesson «как думать» on the third turn, then the advice, the arrow after the lesson', () => {
    const b = book();
    const r = lessonTurn({ ...ctxAfter(['e4', 'e5', 'Nf3', 'Nc6'], 'w', 1, [['Bc4', 30], ['Bb5', 25], ['d4', 20]]), memory: memoryWith({ turn: 2, quizzes: QUIET_LESSON.quizzes ?? [] }) }, b);
    expect(r.result.moment).toBe('mini');
    expect(pools(r.result.event)[0]).toBe('v3.mini.thinking.l1');
    expect(r.result.event?.teach).toMatchObject({ moment: 'mini', conceptId: 'thinking-routine' });
    expect(r.memory.lesson?.minis).toEqual([{ turn: 3, ply: 5, topic: 'thinking', level: 1, slot: 'opening' }]);
    expect(b.history().minis.thinking?.level).toBe(1);
    expect(r.result.board.arrows).toContainEqual({ from: 'f1', to: 'c4', color: 'green' });
    expect((r.result.event?.cues ?? []).filter((c) => c.kind === 'move').every((c) => c.at === 'end')).toBe(true);
  });
});

// ───────────────────────── the buttons ─────────────────────────

describe('«Почему так?», «Повтори», «Что задумал соперник?», «Поторопись!»', () => {
  it('«Почему так?» goes one level deeper each press and never repeats the tail said', () => {
    const b = book(11);
    const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 1, E2), memory: memoryWith(QUIET_LESSON) }, b);
    const told = r.memory.lesson?.lastAdvice?.ideas[0]?.id;
    expect(told).toBeDefined();
    const first = lessonWhy(r.plan, r.memory, b);
    const p1 = pools(first.event);
    expect(p1.some((p) => p === `v3.idea.${told}`)).toBe(false);
    expect(first.memory.lessonWhy?.ply).toBe(3);
    const second = lessonWhy(r.plan, first.memory, b);
    expect(second.memory.lessonWhy?.step).toBeGreaterThan(first.memory.lessonWhy?.step ?? -1);
    expect(pools(second.event)).not.toEqual(p1);
  });

  it('«Повтори»: the same advice in fresh words, the arrow shown', () => {
    const b = book();
    const r = lessonTurn(ctxAfter(['e4', 'e5'], 'w', 1, E2), b);
    const a = lessonRepeat(r.plan, r.memory, b);
    const c = lessonRepeat(r.plan, a.memory, b);
    expect(pools(a.event)[0]).toBe('v3.lead.repeat');
    expect(a.board.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });
    expect(a.event.teach?.moment).toBe('repeat');
    expect(a.event.say?.[0]?.n).not.toBe(c.event.say?.[0]?.n);
  });

  it('«Что задумал соперник?»: «тихий ход» only when the threat search finished with none', () => {
    const b = book();
    const quiet = lessonOpponent({ profile: prof(2), fenBefore: fenOf(['e4']), uci: 'a7a6', childFen: fenOf(['e4', 'a6']), threat: null }, initialTeachMemory(), b);
    expect(pools(quiet.event)).toEqual(['v3.opp.quiet']);
    const unknown = lessonOpponent({ profile: prof(2), fenBefore: fenOf(['e4']), uci: 'a7a6', childFen: fenOf(['e4', 'a6']), threat: undefined }, initialTeachMemory(), b);
    expect(pools(unknown.event)).not.toContain('v3.opp.quiet');
    const develop = lessonOpponent({ profile: prof(2), fenBefore: fenOf(['e4', 'e5', 'Nc3']), uci: 'f8b4', childFen: fenOf(['e4', 'e5', 'Nc3', 'Bb4']), threat: null }, initialTeachMemory(), b);
    expect(pools(develop.event)).toEqual(['v3.opp.develop']);
    const mate: Threat = { uci: 'h5f7', san: 'Qxf7#', motif: 'mateIn1', targetSquares: ['e8'], gainCp: 10_000 };
    const danger = lessonOpponent({ profile: prof(2), fenBefore: fenOf(['e4', 'e5', 'Bc4', 'Nc6']), uci: 'd1h5', childFen: fenOf(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5']), threat: mate }, initialTeachMemory(), b);
    expect(pools(danger.event)).toEqual(['v3.danger.mate']);
    expect(danger.event.kind).toBe('answer');
  });

  it('«Поторопись!» does not stop the clock', () => {
    const ev = lessonHurry(prof(3), book());
    expect(ev).toMatchObject({ kind: 'encourage', pauseClock: false });
    expect(pools(ev)).toEqual(['v3.hurry']);
  });
});

// ───────────────────────── a whole scripted game ─────────────────────────

const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1', 'a6', 'Bb3', 'Ba7', 'Nbd2', 'h6', 'Nf1', 'Re8'];

/** The child's line as the engine's first choice and two other legal moves a little worse. */
function gameSpecs(fen: string, next: string): LineSpec[] {
  const others = new Chess(fen)
    .moves()
    .filter((m) => m !== next)
    .slice(0, 2);
  return [[next, 40], ...others.map((m, i): LineSpec => [m, -60 - 10 * i])];
}

function playGame(stage: number, address: 'm' | 'f', seed: number): { events: CoachEvent[]; memory: TeachMemory } {
  const b = createLessonBook({ seed });
  const card = getStrategy('italian') ?? null;
  const start = lessonGameStart({ profile: prof(stage, address), childColor: 'w', tc: 'training', coachStyle: 'teacher', strategy: null, strategyCard: card, historySan: [], fen: new Chess().fen() }, initialTeachMemory(), b);
  const events: CoachEvent[] = [...start.events];
  let memory = start.memory;
  for (let k = 0; k < ITALIAN.length; k += 2) {
    const sans = ITALIAN.slice(0, k);
    const next = ITALIAN[k] as string;
    const fen = fenOf(sans);
    const r = lessonTurn({ ...ctxAfter(sans, 'w', stage, gameSpecs(fen, next)), profile: prof(stage, address), strategyCard: card, memory, threat: null }, b);
    memory = r.memory;
    if (r.result.event) events.push(r.result.event);
    if (r.result.quiz) {
      const ans = lessonAnswer(r.plan, memory, r.result.quiz.options[0]?.id ?? null, b);
      events.push(ans.event);
      memory = ans.memory;
    } else if (r.result.adviceHidden) {
      const rev = lessonReveal(r.plan, memory, b);
      events.push(rev.event);
      memory = rev.memory;
    }
    const why = lessonWhy(r.plan, memory, b);
    events.push(why.event);
    memory = why.memory;
  }
  return { events, memory };
}

describe('a scripted Italian game, stages 1–5 × m/f', () => {
  const games: { name: string; events: CoachEvent[]; memory: TeachMemory }[] = [];
  for (const stage of [1, 2, 3, 4, 5]) for (const address of ['m', 'f'] as const) games.push({ name: `s${stage}${address}`, ...playGame(stage, address, stage * 10 + (address === 'f' ? 1 : 0)) });

  it('every lesson event: say[], no clip, no brief; Latin-free', () => {
    for (const g of games) {
      expect(g.events.length, g.name).toBeGreaterThan(10);
      for (const ev of g.events) {
        if (ev.text === '') continue;
        expect(ev.say?.length ?? 0, `${g.name}: ${ev.text}`).toBeGreaterThan(0);
        expect(ev.clip, g.name).toBeUndefined();
        expect(ev.brief, g.name).toBeUndefined();
        expect(ev.text, g.name).not.toMatch(/[A-Za-z0-9]/);
      }
    }
  });

  it('a pointing sentence always has a drawable cue with squares in that sentence', () => {
    for (const g of games) {
      for (const ev of g.events) {
        const sentences = ev.text.split(/(?<=[.!?…])\s+/u);
        sentences.forEach((s, i) => {
          if (!isDeictic(s)) return;
          const cues = (ev.cues ?? []).filter((c) => c.sentence === i && cueDrawable(c));
          expect(cues.length, `${g.name}: «${s}»`).toBeGreaterThan(0);
        });
      }
    }
  });

  it('the lesson memory keeps the rhythm: a turn per child move, quizzes within the budget, one mini per slot', () => {
    for (const g of games) {
      const lm = g.memory.lesson as LessonMemory;
      expect(lm.turn, g.name).toBe(ITALIAN.length / 2);
      expect(lm.quizzes.length, g.name).toBeLessThanOrEqual(5);
      expect(lm.minis.filter((m) => m.slot === 'opening').length, g.name).toBeLessThanOrEqual(1);
      expect(lm.minis.filter((m) => m.slot !== 'opening').length, g.name).toBeLessThanOrEqual(1);
      expect(lm.theme.announced, g.name).toBe(true);
    }
  });

  it('the lesson never calls Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    playGame(3, 'm', 99);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ───────────────────────── the fixes after the first 50-game run ─────────────────────────

/** Words of the advice (as the report counts them): a lead, «go», the helper, a whole castling line. */
const ADVICE_RE = /^v3\.(lead\.|go\.|helper$|whole\.)/u;

function memo(over: Partial<LessonTurnMemo> = {}): LessonTurnMemo {
  return { dangerTurns: [], laterTurns: [], lastCalmLater: false, adviceSaidPly: null, ...over };
}

function sentencesOf(ev: CoachEvent | null): string[] {
  return (ev?.text ?? '').split(/(?<=[.!?…])\s+/u).filter((s) => s.trim() !== '');
}

describe('«Опасность — не в каждом ходе» (§2.2)', () => {
  const HANGING_FEN = '6k1/8/8/4p3/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';
  /** Кd4 defended by c3, attacked by the pawn e5: the loss is 2 pawns — an «other» danger */
  const DEFENDED_FEN = '6k1/8/8/4p3/3N4/2P5/PP3PPP/R1B2RK1 w - - 0 1';
  const KNIGHT: LineSpec[] = [['Nf5', 300], ['Nb5', 280], ['Ne2', 250]];
  const knight = { kind: 'hanging' as const, piece: { piece: 'n' as const, square: 'd4' }, squares: ['d4'] };
  const pawn = { kind: 'hanging' as const, piece: { piece: 'p' as const, square: 'e4' }, squares: ['e4'] };

  it('the classes: a check / a mate threat / a piece losing ≥ 3 pawns always; a cheaper loss, a threat, a pawn by the cadence', () => {
    expect(dangerClass({ kind: 'check', squares: [] }, HANGING_FEN)).toBe('always');
    expect(dangerClass({ kind: 'mate', squares: ['f7'] }, HANGING_FEN)).toBe('always');
    expect(dangerClass(knight, HANGING_FEN)).toBe('always');
    expect(dangerClass(knight, DEFENDED_FEN)).toBe('other');
    expect(dangerClass(pawn, HANGING_FEN)).toBe('pawn');
    expect(dangerClass({ kind: 'threat', squares: ['d4'] }, HANGING_FEN)).toBe('other');
    expect(dangerClass({ kind: 'threat', squares: ['a2', 'b2'] }, HANGING_FEN)).toBe('pawn');
  });

  it('the cadence: «other» once in 3 turns, a pawn never at stages 1–2, once in 4 at 3–5 and only when the advice saves it', () => {
    const base = { fen: DEFENDED_FEN, stage: 3, turnNo: 10, ply: 21, lm: initialLessonMemory(), saves: true };
    expect(dangerSpoken({ ...base, danger: knight, dangerTurns: [] })).toBe(true);
    expect(dangerSpoken({ ...base, danger: knight, dangerTurns: [10 - DANGER_EVERY.other + 1] })).toBe(false);
    expect(dangerSpoken({ ...base, danger: knight, dangerTurns: [10 - DANGER_EVERY.other] })).toBe(true);
    // a piece losing ≥ 3 pawns: always, whatever was said the turn before
    expect(dangerSpoken({ ...base, fen: HANGING_FEN, danger: knight, dangerTurns: [9] })).toBe(true);
    expect(dangerSpoken({ ...base, fen: HANGING_FEN, danger: { kind: 'check', squares: [] }, dangerTurns: [9] })).toBe(true);
    // a pawn
    expect(dangerSpoken({ ...base, stage: 2, danger: pawn, dangerTurns: [] })).toBe(false);
    expect(dangerSpoken({ ...base, danger: pawn, dangerTurns: [] })).toBe(true);
    expect(dangerSpoken({ ...base, danger: pawn, dangerTurns: [], saves: false })).toBe(false);
    expect(dangerSpoken({ ...base, danger: pawn, dangerTurns: [10 - DANGER_EVERY.pawn + 1] })).toBe(false);
    expect(dangerSpoken({ ...base, danger: pawn, dangerTurns: [10 - DANGER_EVERY.pawn] })).toBe(true);
  });

  it('an «other» danger right after another danger: the advice alone, with its rescue words and the arrow at once', () => {
    const said = lessonTurn({ ...ctxFen(DEFENDED_FEN, 3, KNIGHT), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }) }, book());
    expect(said.result.moment).toBe('danger');
    expect(pools(said.result.event).some((p) => p.startsWith('v3.danger.'))).toBe(true);
    expect(turnMemoOf(said.memory).dangerTurns).toEqual([6]);
    expect(said.memory.lesson?.lastDanger).toMatchObject({ square: 'd4', kind: 'hanging' });

    const skipped = lessonTurn({ ...ctxFen(DEFENDED_FEN, 3, KNIGHT), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }, { lessonTurnMemo: memo({ dangerTurns: [5] }) }) }, book());
    expect(skipped.result.moment).toBe('advice');
    const p = pools(skipped.result.event);
    expect(p.some((x) => x.startsWith('v3.danger.')), p.join(' ')).toBe(false);
    expect(rescueWords(p), p.join(' ')).toBe(true);
    expect(skipped.result.board.arrows).toContainEqual({ from: 'd4', to: 'f5', color: 'green' });
    expect(skipped.result.adviceHidden).toBe(false);
    expect(turnMemoOf(skipped.memory).dangerTurns).toEqual([5]);
    // (an unsaid danger is no «warning»: an ignored one is not blamed later)
    expect(skipped.memory.lesson?.lastDanger).toBeNull();

    const again = lessonTurn({ ...ctxFen(DEFENDED_FEN, 3, KNIGHT), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }, { lessonTurnMemo: memo({ dangerTurns: [3] }) }) }, book());
    expect(again.result.moment).toBe('danger');
  });

  it('the mistake reaction just told of the same piece: the danger is not repeated — the advice at once', () => {
    // the reaction (or the take-back offer) records the square of the piece its words named
    const told = { turn: 5, ply: 39, concept: 'hanging.undefended', uci: 'a1a2', lossPawns: 3, mated: false, victim: 'd4' };
    expect(mistakeJustTold({ mistakes: [told], lastDanger: null }, 41, knight)).toBe(true);
    expect(mistakeJustTold({ mistakes: [{ ...told, victim: 'c1' }], lastDanger: null }, 41, knight)).toBe(false);
    expect(mistakeJustTold({ mistakes: [{ ...told, victim: null }], lastDanger: null }, 41, knight)).toBe(false);
    expect(mistakeJustTold({ mistakes: [{ ...told, ply: 37 }], lastDanger: null }, 41, knight)).toBe(false);
    // a record saved before the victim was kept: the warning of the turn before on that square, or the moved piece
    const { victim: _v, ...old } = told;
    expect(mistakeJustTold({ mistakes: [{ ...old, concept: 'ignoredDanger' }], lastDanger: { ply: 39, square: 'd4', kind: 'hanging' } }, 41, knight)).toBe(true);
    expect(mistakeJustTold({ mistakes: [{ ...old, uci: 'b3d4' }], lastDanger: null }, 41, knight)).toBe(true);
    expect(mistakeJustTold({ mistakes: [old], lastDanger: null }, 41, knight)).toBe(false);
    // a check and a mate threat are always said
    expect(mistakeJustTold({ mistakes: [told], lastDanger: null }, 41, { kind: 'check', squares: [] })).toBe(false);
    expect(mistakeJustTold({ mistakes: [{ ...told, concept: 'mate', mated: true, victim: null }], lastDanger: null }, 41, { kind: 'mate', squares: ['f7'] })).toBe(false);

    const r = lessonTurn({ ...ctxFen(HANGING_FEN, 2, KNIGHT), memory: memoryWith({ ...QUIET_LESSON, turn: 5, mistakes: [told] }) }, book());
    expect(r.result.moment).toBe('advice');
    const p = pools(r.result.event);
    expect(p.some((x) => x.startsWith('v3.danger.')), p.join(' ')).toBe(false);
    expect(rescueWords(p), p.join(' ')).toBe(true);
  });

  it('a warning repeated about the same piece on the same square (the child let it stand) is «other»: once in 3 turns', () => {
    const lm = { ...initialLessonMemory(), lastDanger: { ply: 39, square: 'd4', kind: 'hanging' } };
    expect(dangerClass(knight, HANGING_FEN)).toBe('always');
    expect(warnedBefore(lm, 41, knight)).toBe(true);
    expect(dangerCadenceClass({ danger: knight, fen: HANGING_FEN, lm, ply: 41 })).toBe('other');
    const base = { fen: HANGING_FEN, stage: 3, turnNo: 10, ply: 41, lm, saves: true };
    expect(dangerSpoken({ ...base, danger: knight, dangerTurns: [9] })).toBe(false);
    expect(dangerSpoken({ ...base, danger: knight, dangerTurns: [10 - DANGER_EVERY.other] })).toBe(true);
    // a check and a mate threat are always said; a piece on another square is a new danger
    expect(dangerSpoken({ ...base, danger: { kind: 'check', squares: [] }, dangerTurns: [9] })).toBe(true);
    expect(dangerSpoken({ ...base, danger: { kind: 'mate', squares: ['d4'] }, dangerTurns: [9] })).toBe(true);
    expect(dangerSpoken({ ...base, lm: { ...lm, lastDanger: { ply: 39, square: 'c3', kind: 'hanging' } }, danger: knight, dangerTurns: [9] })).toBe(true);
    // (the warning of a check is no warning about a piece)
    expect(warnedBefore({ lastDanger: { ply: 39, square: 'd4', kind: 'check' } }, 41, knight)).toBe(false);

    // two turns after the warning: only when the history shows the same piece stood there all along
    const stood = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'];
    const moved = ['e4', 'e5', 'Nf3', 'Nc6', 'Ng5', 'Nf6', 'Nf3', 'Bc5'];
    const f3 = { kind: 'hanging' as const, piece: { piece: 'n' as const, square: 'f3' }, squares: ['f3'] };
    const mark = { lastDanger: { ply: 5, square: 'f3', kind: 'hanging' } };
    expect(warnedBefore(mark, 9, f3, stood)).toBe(true);
    expect(warnedBefore(mark, 9, f3, moved)).toBe(false);
    expect(warnedBefore(mark, 9, f3)).toBe(false);

    // the turn: the knight warned about the turn before is not warned about again — the advice rescues it in words
    const r = lessonTurn({ ...ctxFen(HANGING_FEN, 3, KNIGHT), memory: memoryWith({ ...QUIET_LESSON, turn: 5, lastDanger: { ply: 39, square: 'd4', kind: 'hanging' } }, { lessonTurnMemo: memo({ dangerTurns: [5] }) }) }, book());
    expect(r.result.moment).toBe('advice');
    const p = pools(r.result.event);
    expect(p.some((x) => x.startsWith('v3.danger.')), p.join(' ')).toBe(false);
    expect(rescueWords(p), p.join(' ')).toBe(true);
    expect((r.plan.lesson as { x?: { dangerCls?: string } }).x?.dangerCls).toBe('other');
    // a fresh warning (nothing said about that knight before) is always said
    const fresh = lessonTurn({ ...ctxFen(HANGING_FEN, 3, KNIGHT), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }, { lessonTurnMemo: memo({ dangerTurns: [5] }) }) }, book());
    expect(fresh.result.moment).toBe('danger');
  });

  it('the danger share of a game stays low: the same attacked knight every turn is spoken of once in 3 turns', () => {
    const b = book(13);
    let memory: TeachMemory = memoryWith({ ...QUIET_LESSON, turn: 3 });
    const moments: string[] = [];
    for (let i = 0; i < 9; i++) {
      const r = lessonTurn({ ...ctxFen(DEFENDED_FEN, 4, KNIGHT), memory }, b);
      moments.push(r.result.moment);
      memory = r.memory;
    }
    expect(moments).toEqual(['danger', 'advice', 'advice', 'danger', 'advice', 'advice', 'danger', 'advice', 'advice']);
  });
});

describe('the words of a danger: the cap, blitz, the arrow always with words (§2.2)', () => {
  const HANGING_FEN = '6k1/8/8/4p3/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';
  const KNIGHT: LineSpec[] = [['Nf5', 300], ['Nb5', 280], ['Ne2', 250]];
  const QUEEN_SANS = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4'];
  const QUEEN: LineSpec[] = [['Bxf7+', -439], ['Qa4', -446], ['Qg3', -452]];

  it('blitz, the advice saves the piece: one sentence — the rescuing advice (its words say the rescue)', () => {
    const r = lessonTurn({ ...ctxFen(HANGING_FEN, 2, KNIGHT, { tc: 'blitz5' }), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }) }, book());
    expect(r.result.moment).toBe('danger');
    expect(sentencesOf(r.result.event)).toHaveLength(1);
    const p = pools(r.result.event);
    expect(p.some((x) => ADVICE_RE.test(x)), p.join(' ')).toBe(true);
    expect(rescueWords(p), p.join(' ')).toBe(true);
    expect(r.result.board.arrows).toContainEqual({ from: 'd4', to: 'f5', color: 'green' });
  });

  it('blitz, the advice lets the piece go: «можно не спасать» + the advice — never the danger alone with an arrow', () => {
    let checked = 0;
    for (const stage of [2, 3, 5]) {
      const r = lessonTurn({ ...ctxAfter(QUEEN_SANS, 'w', stage, QUEEN, { depth: 12, tc: 'blitz5' }), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }) }, book());
      if (r.plan.advice[0]?.san !== 'Bxf7+' || r.result.moment !== 'danger') continue;
      checked++;
      const p = pools(r.result.event);
      expect(p[0], p.join(' ')).toBe('v3.danger.letGo.check');
      expect(p.some((x) => ADVICE_RE.test(x)), p.join(' ')).toBe(true);
      expect(sentencesOf(r.result.event)).toHaveLength(2);
      // «можно не спасать» shows the danger's own red square
      expect((r.result.event?.cues ?? []).some((c) => c.sentence === 0 && (c.kind === 'hanging' || c.kind === 'threat'))).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('blitz: no danger mini-lesson — the first danger of the game is the rescuing advice alone; the lesson waits', () => {
    const r = lessonTurn({ ...ctxFen(HANGING_FEN, 2, KNIGHT, { tc: 'blitz5' }), memory: memoryWith({ turn: 5, quizzes: QUIET_LESSON.quizzes ?? [] }) }, book());
    expect(r.result.moment).toBe('danger');
    const p = pools(r.result.event);
    expect(p.some((x) => x.startsWith('v3.mini.')), p.join(' ')).toBe(false);
    expect(sentencesOf(r.result.event)).toHaveLength(1);
    expect(rescueWords(p), p.join(' ')).toBe(true);
    expect(r.memory.lesson?.minis).toEqual([]);
    expect(r.plan.lesson?.mini).toBeNull();
  });

  it('blitz at stage 1, the advice lets the knight go (it wins the queen): «можно не спасать» + the advice, as at the other stages', () => {
    // Кd4 hangs to the pawn e5; Сc1:g5 takes the queen instead
    const fen = '6k1/8/8/4p1q1/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';
    const r = lessonTurn({ ...ctxFen(fen, 1, [['Bxg5', 900], ['Nf5', -250], ['Nb5', -260]], { tc: 'blitz5' }), memory: memoryWith({ ...QUIET_LESSON, turn: 5 }) }, book());
    expect(r.plan.advice[0]?.san).toBe('Bxg5');
    expect(r.result.moment).toBe('danger');
    const p = pools(r.result.event);
    expect(p[0], p.join(' ')).toBe('v3.danger.letGo.stronger');
    expect(p.some((x) => x.startsWith('v3.danger.hanging.') || x === 'v3.danger.threat'), p.join(' ')).toBe(false);
    expect(p.some((x) => ADVICE_RE.test(x)), p.join(' ')).toBe(true);
    expect(sentencesOf(r.result.event)).toHaveLength(2);
  });

  it('a mate that cannot be stopped — no «можно не спасать», no tail that calls the move safe', () => {
    // the lone black king is boxed in: Кg8 is the only move, and Фg7# follows whatever
    const LOST = '7k/Q7/6K1/8/8/8/8/8 b - - 0 1';
    for (const stage of [1, 2, 3, 4, 5]) {
      for (const seed of [1, 2, 3]) {
        for (const tc of ['training', 'blitz5'] as const) {
          for (const lesson of [QUIET_LESSON, { quizzes: QUIET_LESSON.quizzes ?? [] }]) {
            const r = lessonTurn({ ...ctxFen(LOST, stage, [['Kg8', { mate: -1 }]], { tc }), memory: memoryWith({ ...lesson, turn: 5 }) }, book(seed));
            const p = pools(r.result.event);
            const name = `s${stage} #${seed} ${tc}: ${p.join(' ')}`;
            expect(r.result.moment, name).toBe('danger');
            expect(p.some((x) => x.startsWith('v3.danger.letGo.')), name).toBe(false);
            expect(p.some((x) => x.startsWith('v3.idea.') || x.startsWith('v3.whole.') || x === 'v3.lead.rescue'), name).toBe(false);
            // the advice is said (the arrow never comes without words) and ends honestly
            expect(p.some((x) => ADVICE_RE.test(x)), name).toBe(true);
            expect(p, name).toContain('v3.danger.lastStand');
            if (tc === 'blitz5') expect(sentencesOf(r.result.event), name).toHaveLength(1);
            else expect(p, name).toContain('v3.danger.mate');
            expect(r.result.board.arrows, name).toContainEqual({ from: 'h8', to: 'g8', color: 'green' });
            // «Совет» / «Повтори» and «Почему так?» never call the move safe either
            const b = book(seed);
            const again = pools(lessonRepeat(r.plan, r.memory, b).event);
            expect(again, `${name} / again: ${again.join(' ')}`).toContain('v3.danger.lastStand');
            let mem = r.memory;
            for (let k = 0; k < 4; k++) {
              const why = lessonWhy(r.plan, mem, b);
              mem = why.memory;
              const wp = pools(why.event);
              expect(wp.some((x) => x === 'v3.idea.quiet' || x === 'v3.idea.none'), `${name} / why: ${wp.join(' ')}`).toBe(false);
            }
          }
        }
      }
    }
  });

  it('every danger utterance keeps to the cap (16 words at stages 1–2, 22 at 3–5; with its mini-lesson 32)', () => {
    for (const stage of [1, 2, 3, 4, 5]) {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        for (const tc of ['training', 'blitz5'] as const) {
          for (const lesson of [QUIET_LESSON, { quizzes: QUIET_LESSON.quizzes ?? [] }]) {
            const r = lessonTurn({ ...ctxFen(HANGING_FEN, stage, KNIGHT, { tc }), memory: memoryWith({ ...lesson, turn: 5 }) }, book(seed));
            const words = (r.result.event?.text ?? '').split(/\s+/u).filter((x) => /[А-Яа-яЁё]/u.test(x)).length;
            const withMini = pools(r.result.event).some((x) => x.startsWith('v3.mini.'));
            expect(words, r.result.event?.text).toBeLessThanOrEqual(withMini ? 32 : stage <= 2 ? 16 : 22);
          }
        }
      }
    }
  });
});

describe('mini-lessons in blitz and the arrow (§2.2)', () => {
  const ITALIAN4 = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'];
  const CASTLE: LineSpec[] = [['O-O', 30], ['d3', 25], ['c3', 22]];

  it('blitz: «как думать» on the third turn — the lesson and the advice it is about', () => {
    const r = lessonTurn({ ...ctxAfter(['e4', 'e5', 'Nf3', 'Nc6'], 'w', 1, [['Bc4', 30], ['Bb5', 25], ['d4', 20]], { tc: 'blitz5' }), memory: memoryWith({ turn: 2, quizzes: QUIET_LESSON.quizzes ?? [] }) }, book());
    expect(r.result.moment).toBe('mini');
    const p = pools(r.result.event);
    expect(p[0]).toBe('v3.mini.thinking.l1');
    expect(p.some((x) => ADVICE_RE.test(x)), p.join(' ')).toBe(true);
  });

  it('blitz: no castling mini-lesson (only «как думать» and the danger minis); outside blitz it carries the castling words', () => {
    const memory = memoryWith({ turn: 4, quizzes: QUIET_LESSON.quizzes ?? [] });
    const blitz = lessonTurn({ ...ctxAfter(ITALIAN4, 'w', 2, CASTLE, { tc: 'blitz5' }), memory }, book());
    expect(blitz.result.moment).not.toBe('mini');
    expect(pools(blitz.result.event).some((x) => x.startsWith('v3.mini.'))).toBe(false);
    const slow = lessonTurn({ ...ctxAfter(ITALIAN4, 'w', 2, CASTLE), memory }, book());
    expect(slow.result.moment).toBe('mini');
    const p = pools(slow.result.event);
    expect(p[0]).toBe('v3.mini.castle.l1');
    expect(p.some((x) => ADVICE_RE.test(x)), p.join(' ')).toBe(true);
  });
});

describe('«Совет»: «Как я и говорил» only after the advice was said in words (§2.3)', () => {
  it('after a quiet turn (a sound word only) «Совет» gives the advice as new; the next press may say «Напомню»', () => {
    const b = book();
    const first = lessonTurn(ctxAfter(['e4', 'e5'], 'w', 1, E2), b);
    const idea = first.memory.lesson?.lastIdea ?? null;
    const quiet = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 1, E2), memory: memoryWith({ ...QUIET_LESSON, turn: 5, lastIdea: idea }) }, b);
    expect(quiet.result.moment).toBe('quiet');
    expect(turnMemoOf(quiet.memory).adviceSaidPly).toBeNull();
    const a = lessonRepeat(quiet.plan, quiet.memory, b);
    expect(pools(a.event)[0]).not.toBe('v3.lead.repeat');
    expect(pools(a.event).some((x) => ADVICE_RE.test(x))).toBe(true);
    expect(a.event.teach?.moment).toBe('repeat');
    expect(turnMemoOf(a.memory).adviceSaidPly).toBe(3);
    const c = lessonRepeat(quiet.plan, a.memory, b);
    expect(pools(c.event)[0]).toBe('v3.lead.repeat');
  });

  it('after a quiz answered with the advice in words, «Совет» may say «Напомню»; after an advice turn too', () => {
    const b = book();
    const turn = lessonTurn(ctxAfter(['e4', 'e5'], 'w', 1, E2), b);
    expect(turnMemoOf(turn.memory).adviceSaidPly).toBe(3);
    const q = lessonTurn({ ...ctxAfter(['e4', 'e5', 'Nc3', 'Bb4'], 'w', 1, [['Nf3', 30], ['Nge2', 20], ['a3', 10]]), threat: null, memory: memoryWith({ turn: 2 }) }, b);
    expect(q.result.moment).toBe('quiz');
    expect(turnMemoOf(q.memory).adviceSaidPly).toBeNull();
    const ans = lessonAnswer(q.plan, q.memory, q.result.quiz?.correctId ?? null, b);
    const said = pools(ans.event).some((x) => ADVICE_RE.test(x));
    expect(turnMemoOf(ans.memory).adviceSaidPly).toBe(said ? 5 : null);
    const rep = lessonRepeat(q.plan, ans.memory, b);
    expect(pools(rep.event)[0] === 'v3.lead.repeat').toBe(said);
  });
});

describe('stage 5 «позже» (§2.2): every second calm advice at most, never after a hidden arrow, the share kept', () => {
  it('over a run of calm turns: never two in a row, never on the first turn, at most 35 % hidden', () => {
    const b = book(21);
    let memory: TeachMemory = memoryWith(QUIET_LESSON);
    const hidden: boolean[] = [];
    for (let i = 0; i < 16; i++) {
      const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 5, E2), memory }, b);
      expect(r.result.moment).toBe('advice');
      hidden.push(r.result.adviceHidden);
      memory = { ...r.memory, lesson: { ...(r.memory.lesson as LessonMemory), lastIdea: null } };
    }
    expect(hidden[0]).toBe(false);
    for (let i = 1; i < hidden.length; i++) expect(hidden[i] && hidden[i - 1], hidden.join(',')).toBe(false);
    const share = hidden.filter(Boolean).length / hidden.length;
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThanOrEqual(0.35);
  });

  it('never right after another hidden-arrow turn (a quiz the turn before)', () => {
    const memory = memoryWith({ ...QUIET_LESSON, turn: 7, quizzes: [{ turn: 7, ply: 13, kind: 'oppIdea', correct: true }] });
    const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 5, E2), memory }, book());
    expect(r.result.moment).toBe('advice');
    expect(r.result.adviceHidden).toBe(false);
    const free = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 5, E2), memory: memoryWith({ ...QUIET_LESSON, turn: 7 }) }, book());
    expect(free.result.adviceHidden).toBe(true);
    expect(turnMemoOf(free.memory)).toMatchObject({ laterTurns: [8], lastCalmLater: true });
    const next = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 5, E2), memory: { ...free.memory, lesson: { ...(free.memory.lesson as LessonMemory), lastIdea: null } } }, book());
    expect(next.result.adviceHidden).toBe(false);
    expect(turnMemoOf(next.memory).lastCalmLater).toBe(false);
  });
});

describe('«Почему так?» mini-lesson: the child\'s level, spaced across games; a right answer shows the concept (§2.6)', () => {
  function whyAtMiniStep(b: LessonBook): { said: string[]; topic: string | undefined } {
    const r = lessonTurn({ ...ctxAfter(['e4', 'e5'], 'w', 1, E2), memory: memoryWith(QUIET_LESSON) }, b);
    const topic = IDEA_MINI[r.plan.advice[0]?.ideas[0]?.id ?? ''];
    // the third step of «Почему так?» is the mini-lesson
    const why = lessonWhy(r.plan, { ...r.memory, lessonWhy: { ply: 3, step: 1 } }, b);
    return { said: pools(why.event), topic };
  }

  it('the next level once the last was heard and shown; recorded as told', () => {
    const b = createLessonBook({ seed: 3, history: { v: 1, gameSeq: 6, recent: {}, minis: { development: { level: 1, lastGame: 1, shown: 1 }, center: { level: 1, lastGame: 1, shown: 1 } }, habits: {}, takeaways: [], habitSaid: {} } });
    const { said, topic } = whyAtMiniStep(b);
    expect(topic).toBeDefined();
    expect(said).toEqual([`v3.mini.${topic}.l2`]);
    expect(b.history().minis[topic as string]).toMatchObject({ level: 2, lastGame: 6 });
  });

  it('a topic told in the last 3 games is not told again (the next step instead)', () => {
    const b = createLessonBook({ seed: 3, history: { v: 1, gameSeq: 6, recent: {}, minis: { development: { level: 1, lastGame: 4, shown: 1 }, center: { level: 1, lastGame: 4, shown: 1 } }, habits: {}, takeaways: [], habitSaid: {} } });
    const { said } = whyAtMiniStep(b);
    expect(said.some((p) => p.startsWith('v3.mini.'))).toBe(false);
    expect(said.length).toBeGreaterThan(0);
  });

  it('a right «Шах! Как спасаемся?» shows the concept of its mini-lesson (once), a wrong one does not', () => {
    const g04 = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4', 'Qa4', 'Nxc2+'];
    const make = (): LessonBook => createLessonBook({ seed: 1, history: { v: 1, gameSeq: 2, recent: {}, minis: { checkEscape: { level: 1, lastGame: 0, shown: 0 } }, habits: {}, takeaways: [], habitSaid: {} } });
    const b = make();
    const r = lessonTurn({ ...ctxAfter(g04, 'w', 1, [['Qxc2', 390], ['Kd1', -551], ['Ke2', -671]], { depth: 12 }), memory: memoryWith({ turn: 5 }) }, b);
    expect(r.result.quiz?.kind).toBe('checkEscape');
    lessonAnswer(r.plan, r.memory, 'escCapture', b);
    expect(b.history().minis.checkEscape?.shown).toBe(1);
    const w = make();
    const r2 = lessonTurn({ ...ctxAfter(g04, 'w', 1, [['Qxc2', 390], ['Kd1', -551], ['Ke2', -671]], { depth: 12 }), memory: memoryWith({ turn: 5 }) }, w);
    lessonAnswer(r2.plan, r2.memory, 'escKing', w);
    expect(w.history().minis.checkEscape?.shown).toBe(0);
  });
});

describe('the hints of a hidden advice stop with its reveal (§2.7)', () => {
  const FORK = 'r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1';
  const specs: LineSpec[] = [['Nc7+', 480, 'Kd7', 'Nxa8'], ['Kd2', 0], ['Ke2', 0]];
  const stop = (x: unknown): boolean | undefined => (x as { stopHints?: boolean }).stopHints;

  it('reveal / «Совет» / an answer say stopHints; «Почему так?» on a hidden gift keeps them', () => {
    const b = book();
    const r = lessonTurn(ctxFen(FORK, 3, specs), b);
    expect(r.result.hints.length).toBeGreaterThan(0);
    expect(lessonHintsLive(r.plan, r.memory)).toBe(true);
    const why = lessonWhy(r.plan, r.memory, b);
    expect(stop(why)).toBe(false);
    expect(lessonHintsLive(r.plan, why.memory)).toBe(true);
    const shown = lessonReveal(r.plan, r.memory, b);
    expect(stop(shown)).toBe(true);
    expect(lessonHintsLive(r.plan, shown.memory)).toBe(false);
    const asked = lessonRepeat(r.plan, r.memory, b);
    expect(stop(asked)).toBe(true);
    expect(lessonHintsLive(r.plan, asked.memory)).toBe(false);
  });
});
