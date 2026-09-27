/**
 * The turn half of the lesson director with the REAL words of @gambit/content (the writers' library): the director is
 * installed, and over scripted games × stages 1–5 × m/f every lesson utterance keeps the lesson's rules — no spoken square,
 * no Latin, no digits, no «молодец», no unfilled placeholder, `say` and never a `clip` / `brief`, a pointing word only
 * over a cue the board can draw. Where the library has no words for a moment, the turn is silent (no event), never a
 * broken one.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, CoachEvent, EngineLine, StudentProfile } from '@gambit/shared';
import { getStrategy } from '../../../../content/src/strategies.ts';
import { buildClipIndex, lessonQuizKey, mergeClipIndexes } from '../clips/keys.ts';
import type { ClipIndexEntry } from '../clips/keys.ts';
import { expectedPartText, expectedQuizText, expectedSentenceText, planLessonClips, requestSentenceOf } from '../clips/lessonPlan.ts';
import { hasSpokenSquare } from '../clips/lint.ts';
import { initialTeachMemory } from '../teacher.ts';
import type { TeachContext, TeachMemory } from '../teacher.ts';
import { profile as makeProfile } from '../test-fixtures.ts';
import { cueDrawable } from './board.ts';
import { createLessonBook, lessonUnitKey } from './book.ts';
import { lessonAnswer, lessonGameStart, lessonOpponent, lessonRepeat, lessonReveal, lessonTurn, lessonWhy } from './director.ts';
import { TURN_IMPL } from './engine.ts';
import { isDeictic } from './lint.ts';
import { initialLessonMemory } from './memory.ts';
import type { LessonMemory } from './types.ts';

type LineSpec = [string, number];

function fenOf(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function scripted(fen: string, specs: readonly LineSpec[]): AnalysisResult {
  const lines: EngineLine[] = specs.map(([san, cp], i) => {
    const m = new Chess(fen).move(san);
    return { multipv: i + 1, depth: 16, pvUci: [`${m.from}${m.to}${m.promotion ?? ''}`], cp, mate: null };
  });
  return { fen, lines, bestmove: lines[0]?.pvUci[0] ?? '', depth: 16, timeMs: 300 };
}

function prof(stage: number, address: 'm' | 'f'): StudentProfile {
  return makeProfile({ stage, address, nickname: address === 'f' ? 'Маша' : 'Миша' });
}

/** The child's line first, two other legal moves clearly worse. */
function specsFor(fen: string, next: string): LineSpec[] {
  const others = new Chess(fen)
    .moves()
    .filter((m) => m !== next)
    .slice(0, 2);
  return [[next, 40], ...others.map((m, i): LineSpec => [m, -70 - 10 * i])];
}

const GAMES: { name: string; moves: string[]; color: 'w' | 'b'; card: string }[] = [
  { name: 'italian', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6', 'O-O', 'O-O', 'Re1', 'a6', 'Bb3', 'Ba7', 'Nbd2', 'h6', 'Nf1', 'Re8'], color: 'w', card: 'italian' },
  { name: 'sicilian', moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Be2', 'e5', 'Nb3', 'Be7', 'O-O', 'O-O', 'Be3', 'Be6'], color: 'b', card: 'sicilian' },
];

function play(g: (typeof GAMES)[number], stage: number, address: 'm' | 'f'): CoachEvent[] {
  const b = createLessonBook({ seed: stage * 7 + (address === 'f' ? 3 : 0) });
  const card = getStrategy(g.card) ?? null;
  const p = prof(stage, address);
  const first = g.color === 'w' ? 0 : 1;
  const start = lessonGameStart({ profile: p, childColor: g.color, tc: 'training', coachStyle: 'teacher', strategy: null, strategyCard: card, historySan: g.moves.slice(0, first), fen: fenOf(g.moves.slice(0, first)) }, initialTeachMemory(), b);
  const out: CoachEvent[] = [...start.events];
  let memory: TeachMemory = start.memory;
  for (let k = first; k < g.moves.length; k += 2) {
    const sans = g.moves.slice(0, k);
    const fen = fenOf(sans);
    const before = k > 0 ? fenOf(sans.slice(0, -1)) : null;
    const last = k > 0 ? new Chess(before as string).move(sans[k - 1] as string) : null;
    const ctx: TeachContext = {
      fen,
      ply: k + 1,
      childColor: g.color,
      profile: p,
      analysis: scripted(fen, specsFor(fen, g.moves[k] as string)),
      lastBotMove: last && before ? { uci: `${last.from}${last.to}${last.promotion ?? ''}`, san: last.san, fenBefore: before } : null,
      historySan: sans,
      strategyCard: card,
      tc: 'training',
      threat: null,
      memory,
      lessonHistory: b.history(),
    };
    const r = lessonTurn(ctx, b);
    memory = r.memory;
    if (r.result.event) out.push(r.result.event);
    if (r.result.quiz) {
      const a = lessonAnswer(r.plan, memory, r.result.quiz.correctId, b);
      out.push(a.event);
      memory = a.memory;
    } else if (r.result.adviceHidden) {
      const rv = lessonReveal(r.plan, memory, b);
      out.push(rv.event);
      memory = rv.memory;
    }
    const w = lessonWhy(r.plan, memory, b);
    out.push(w.event);
    memory = w.memory;
    out.push(lessonRepeat(r.plan, memory, b).event);
    if (ctx.lastBotMove) out.push(lessonOpponent({ profile: p, fenBefore: ctx.lastBotMove.fenBefore, uci: ctx.lastBotMove.uci, childFen: fen, threat: null }, memory, b).event);
  }
  return out;
}

describe('the turn half is installed', () => {
  it('TURN_IMPL covers the turn functions of the director', () => {
    expect(Object.keys(TURN_IMPL).sort()).toEqual(['lessonAnswer', 'lessonGameStart', 'lessonHurry', 'lessonOpponent', 'lessonRepeat', 'lessonReveal', 'lessonTurn', 'lessonWhy']);
  });
});

describe('the real library over scripted games × stages 1–5 × m/f', () => {
  const all: { name: string; ev: CoachEvent }[] = [];
  for (const g of GAMES) {
    for (const stage of [1, 2, 3, 4, 5]) {
      for (const address of ['m', 'f'] as const) for (const ev of play(g, stage, address)) all.push({ name: `${g.name} s${stage}${address}`, ev });
    }
  }
  const spoken = all.filter((x) => x.ev.text.trim() !== '');

  it('no square, no Latin, no digits, no «молодец», no placeholder in any lesson utterance', () => {
    for (const { name, ev } of spoken) {
      expect(hasSpokenSquare(ev.text), `${name}: ${ev.text}`).toBe(false);
      expect(ev.text, name).not.toMatch(/[A-Za-z0-9{}]/);
      expect(ev.text, name).not.toMatch(/(?<![а-яё])(молод(ец|цы)|умниц[аы])/iu);
      expect(ev.bubbleText, name).toBe(ev.text);
    }
  });

  it('say ⇒ no clip, no brief; every spoken event has its wordings', () => {
    for (const { name, ev } of all) {
      expect(ev.clip, name).toBeUndefined();
      expect(ev.brief, name).toBeUndefined();
      if (ev.text.trim() !== '') expect(ev.say?.length ?? 0, `${name}: ${ev.text}`).toBeGreaterThan(0);
    }
  });

  it('a pointing word only over a cue the board can draw, in the same sentence', () => {
    for (const { name, ev } of spoken) {
      ev.text.split(/(?<=[.!?…])\s+/u).forEach((s, i) => {
        if (!isDeictic(s)) return;
        expect((ev.cues ?? []).some((c) => c.sentence === i && cueDrawable(c)), `${name}: «${s}»`).toBe(true);
      });
    }
  });

  it('saySentences rebuild the text sentence by sentence from the ids (the recorded voice says exactly the bubble)', () => {
    let quizzes = 0;
    let pairs = 0;
    for (const { name, ev } of spoken) {
      const say = ev.say ?? [];
      const ss = ev.saySentences ?? [];
      expect(ss.length, `${name}: ${ev.text}`).toBeGreaterThan(0);
      expect(ss.map((x) => x.text).join(' '), name).toBe(ev.text);
      for (const s of ss) {
        if (s.quiz) {
          quizzes++;
          expect(s.parts, name).toEqual([]);
          const ids = requestSentenceOf(ev, s);
          expect(ids && 'quiz' in ids ? expectedQuizText(ids.quiz) : null, `${name}: ${s.text}`).toBe(s.text);
          continue;
        }
        if (s.parts.length === 2) pairs++;
        expect(expectedSentenceText(s.parts.map((k) => say[k] as NonNullable<(typeof say)[number]>)), `${name}: ${s.text}`).toBe(s.text);
      }
      // every said part belongs to exactly one sentence (a quiz button through the options' ids), in order
      const covered = ss.flatMap((s) => (s.quiz ? s.quiz.options.flatMap((o) => ('say' in o ? [o.say] : [])) : s.parts));
      expect(covered, name).toEqual(say.map((_, i) => i));
    }
    expect(quizzes).toBeGreaterThan(0);
    expect(pairs).toBeGreaterThan(20);
  });

  it('a library with every unit recorded voices every utterance whole, exactly as the bubble; an empty one asks for every sentence', () => {
    const entries = new Map<string, ClipIndexEntry>();
    for (const { ev } of spoken) {
      for (const s of ev.saySentences ?? []) {
        const units = s.quiz ? [{ key: lessonQuizKey(s.text), text: s.text }] : s.parts.map((k) => ({ key: lessonUnitKey(ev.say?.[k] as NonNullable<CoachEvent['say']>[number]), text: expectedPartText(ev.say?.[k] as NonNullable<CoachEvent['say']>[number]) as string }));
        for (const u of units) if (!entries.has(u.key)) entries.set(u.key, { id: `c${entries.size.toString(16).padStart(13, '0')}`, key: u.key, text: u.text, ms: 800 });
      }
    }
    const full = mergeClipIndexes(buildClipIndex([...entries.values()]), null);
    const empty = mergeClipIndexes(null, null);
    for (const { name, ev } of spoken) {
      const plan = planLessonClips(ev, full, { jitter: false });
      expect(plan.src, `${name}: ${ev.text}`).toBe('lesson');
      expect(plan.heard, name).toBe(ev.text);
      expect(plan.lessonMissing, name).toEqual([]);
      expect(plan.clips.length, name).toBe((ev.saySentences ?? []).reduce((n, s) => n + (s.quiz ? 1 : s.parts.length), 0));
      const silent = planLessonClips(ev, empty);
      expect(silent.clips, name).toEqual([]);
      expect(silent.lessonMissing, name).toEqual((ev.saySentences ?? []).map((_, i) => i));
    }
  });

  it('the Italian is never named for White before Black answered', () => {
    for (const { name, ev } of all.filter((x) => x.name.startsWith('italian') && x.ev.kind === 'gameStart')) {
      expect((ev.say ?? []).some((s) => s.pool === 'v3.theme.italian'), name).toBe(false);
    }
  });
});

describe('the real library: a danger keeps to the cap and never shows an arrow without words (§2.2)', () => {
  const HANGING = '6k1/8/8/4p3/3N4/8/PPP2PPP/R1B2RK1 w - - 0 1';
  const DEFENDED = '6k1/8/8/4p3/3N4/2P5/PP3PPP/R1B2RK1 w - - 0 1';
  const KNIGHT: LineSpec[] = [['Nf5', 300], ['Nb5', 280], ['Ne2', 250]];
  const QUEEN_SANS = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6', 'Qb3', 'Nd4'];
  const QUIET: Partial<LessonMemory> = {
    quizzes: [{ turn: 999, ply: 0, kind: 'why', correct: null }],
    minis: [
      { turn: 0, ply: 0, topic: 'x', level: 1, slot: 'opening' },
      { turn: 0, ply: 0, topic: 'y', level: 1, slot: 'tactic' },
    ],
  };
  const ADVICE = /^v3\.(lead\.|go\.|helper$|whole\.)/u;
  const words = (t: string): number => t.split(/\s+/u).filter((x) => /[А-Яа-яЁё]/u.test(x)).length;
  const sentences = (t: string): number => t.split(/(?<=[.!?…])\s+/u).filter((x) => x.trim() !== '').length;

  function ctxOf(kind: 'hanging' | 'defended' | 'queen', stage: number, address: 'm' | 'f', tc: 'training' | 'blitz5', lesson: Partial<LessonMemory>): TeachContext {
    const memory: TeachMemory = { ...initialTeachMemory(), lesson: { ...initialLessonMemory(), ...lesson, turn: 5 } };
    if (kind === 'queen') {
      const fen = fenOf(QUEEN_SANS);
      const before = fenOf(QUEEN_SANS.slice(0, -1));
      const m = new Chess(before).move('Nd4');
      return { fen, ply: 11, childColor: 'w', profile: prof(stage, address), analysis: scripted(fen, [['Bxf7+', -439], ['Qa4', -446], ['Qg3', -452]]), lastBotMove: { uci: `${m.from}${m.to}`, san: m.san, fenBefore: before }, historySan: QUEEN_SANS, tc, memory };
    }
    const fen = kind === 'hanging' ? HANGING : DEFENDED;
    return { fen, ply: 41, childColor: 'w', profile: prof(stage, address), analysis: scripted(fen, KNIGHT), lastBotMove: null, historySan: [], tc, memory };
  }

  it('stages 1–5 × m/f × blitz / not × with / without its mini-lesson', () => {
    let dangers = 0;
    for (const kind of ['hanging', 'defended', 'queen'] as const) {
      for (const stage of [1, 2, 3, 4, 5]) {
        for (const address of ['m', 'f'] as const) {
          for (const tc of ['training', 'blitz5'] as const) {
            for (const lesson of [QUIET, { quizzes: QUIET.quizzes ?? [] }]) {
              const r = lessonTurn(ctxOf(kind, stage, address, tc, lesson), createLessonBook({ seed: stage * 11 + (address === 'f' ? 1 : 0) }));
              const ev = r.result.event;
              if (!ev || ev.quiz || (r.result.moment !== 'danger' && r.result.moment !== 'advice')) continue;
              if (r.result.moment === 'danger') dangers++;
              const said = (ev.say ?? []).map((x) => x.pool);
              const mini = said.some((p) => p.startsWith('v3.mini.'));
              const name = `${kind} s${stage}${address} ${tc}: ${ev.text}`;
              expect(words(ev.text), name).toBeLessThanOrEqual(mini ? 32 : stage <= 2 ? 16 : 22);
              // the arrow of the advice always comes with words about the move
              expect(said.some((p) => ADVICE.test(p)), name).toBe(true);
              if (tc === 'blitz5') {
                const n = sentences(ev.text);
                if (!mini && !said.some((p) => p.startsWith('v3.danger.letGo.'))) expect(n, name).toBe(1);
              }
            }
          }
        }
      }
    }
    expect(dangers).toBeGreaterThan(20);
  });

  it('a mate that cannot be stopped is never «есть ход сильнее» nor a move called safe', () => {
    // the lone black king is boxed in: Кg8 is the only move, and Фg7# follows whatever
    const fen = '7k/Q7/6K1/8/8/8/8/8 b - - 0 1';
    const analysis: AnalysisResult = { fen, lines: [{ multipv: 1, depth: 16, pvUci: ['h8g8'], cp: null, mate: -1 }], bestmove: 'h8g8', depth: 16, timeMs: 300 };
    for (const stage of [1, 2, 3, 4, 5]) {
      for (const address of ['m', 'f'] as const) {
        for (const tc of ['training', 'blitz5'] as const) {
          for (const lesson of [QUIET, { quizzes: QUIET.quizzes ?? [] }]) {
            const memory: TeachMemory = { ...initialTeachMemory(), lesson: { ...initialLessonMemory(), ...lesson, turn: 5 } };
            const ctx: TeachContext = { fen, ply: 61, childColor: 'b', profile: prof(stage, address), analysis, lastBotMove: null, historySan: [], tc, memory };
            const r = lessonTurn(ctx, createLessonBook({ seed: stage * 13 + (address === 'f' ? 1 : 0) }));
            const ev = r.result.event;
            const said = (ev?.say ?? []).map((x) => x.pool);
            const name = `s${stage}${address} ${tc}: ${ev?.text ?? ''}`;
            expect(r.result.moment, name).toBe('danger');
            expect(said, name).toContain('v3.danger.lastStand');
            expect(said.some((p) => p.startsWith('v3.danger.letGo.') || p.startsWith('v3.idea.')), name).toBe(false);
            expect(ev?.text ?? '', name).not.toMatch(/сильнее|мощнее|надёжн|безопасн|риск|спасаемся/iu);
            expect(words(ev?.text ?? ''), name).toBeLessThanOrEqual(said.some((p) => p.startsWith('v3.mini.')) ? 32 : stage <= 2 ? 16 : 22);
          }
        }
      }
    }
  });
});
