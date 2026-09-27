/**
 * The lesson-model seams of the game controller (docs/TEACHING.md §2.4, §4.6): the quiz card and its clock hold, the
 * green arrow after its sentence (`at: 'end'`), the quiet turn, hidden advice and its reveal, the reactions' inputs, the
 * phrase book's life (snapshot, localStorage), the takeaway and the quiz score of the result card.
 *
 * The director of @gambit/core is the real one, wrapped: every call is recorded, and a test may turn one turn result
 * into a quiz / a quiet turn — so the store's behaviour is checked exactly, whatever moment the content would choose.
 * Real timers (short ones), scripted engine, fake coach — silent, free, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { getConceptCard } from '@gambit/content';
import type { LessonHistory, LessonVoicePolicy, TeachContext, TeachMemory } from '@gambit/core';
import { lookupOpening } from '@gambit/openings';
import type { CoachEvent, Color, LessonQuiz, Square, TimeControlId } from '@gambit/shared';
import { getRepertoirePlan, mainLineMoves } from '../../../../../packages/content/src/openings.ts';
import { createGameController } from './gameStore.ts';
import type { GameController } from './gameStore.ts';
import type { GameConfig, GameTimings } from './gameTypes.ts';
import { LESSON_BOOK_KEY, LESSON_BOOK_MAX_CHARS, readResumableGame, resumedLessonHistory, trimLessonHistory } from './resume.ts';
import { FakeCoach, createTestHarness } from './testing/fakes.ts';
import type { ScriptedLine, TestHarness } from './testing/fakes.ts';

type Core = typeof import('@gambit/core');
type TurnOut = ReturnType<Core['lessonTurn']>;
type ReactionOut = ReturnType<Core['lessonReaction']>;

const ctl = vi.hoisted(() => ({
  turn: null as null | ((out: unknown) => unknown),
  reaction: null as null | ((out: unknown) => unknown),
  turns: [] as unknown[],
  answers: [] as { ply: number; optionId: string | null }[],
  reactions: [] as unknown[],
  reveals: [] as number[],
  repeats: [] as number[],
  whys: [] as number[],
}));

vi.mock('@gambit/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@gambit/core')>();
  return {
    ...real,
    lessonTurn: (...args: Parameters<typeof real.lessonTurn>) => {
      ctl.turns.push({ ...args[0] });
      const out = real.lessonTurn(...args);
      return ctl.turn ? ctl.turn(out) : out;
    },
    lessonAnswer: (...args: Parameters<typeof real.lessonAnswer>) => {
      ctl.answers.push({ ply: args[0].ply, optionId: args[2] });
      return real.lessonAnswer(...args);
    },
    lessonReaction: (...args: Parameters<typeof real.lessonReaction>) => {
      ctl.reactions.push({ ...args[0] });
      const out = real.lessonReaction(...args);
      return ctl.reaction ? ctl.reaction(out) : out;
    },
    lessonReveal: (...args: Parameters<typeof real.lessonReveal>) => {
      ctl.reveals.push(args[0].ply);
      return real.lessonReveal(...args);
    },
    lessonRepeat: (...args: Parameters<typeof real.lessonRepeat>) => {
      ctl.repeats.push(args[0].ply);
      return real.lessonRepeat(...args);
    },
    lessonWhy: (...args: Parameters<typeof real.lessonWhy>) => {
      ctl.whys.push(args[0].ply);
      return real.lessonWhy(...args);
    },
  };
});

// ───────────────────────── harness ─────────────────────────

type Spec = [string, number, ...string[]];

function fenAfter(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function script(h: TestHarness, sans: readonly string[], specs: readonly Spec[]): void {
  const fen = fenAfter(sans);
  const lines: ScriptedLine[] = specs.map(([san, cp, ...rest]) => {
    const chess = new Chess(fen);
    return { cp, pv: [san, ...rest].map((m) => chess.move(m)).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`) };
  });
  h.judge.scriptFen(fen, lines);
}

const E1: Spec[] = [['e4', 28], ['Nf3', 20], ['d4', 20]];
const E2: Spec[] = [['Nf3', 19], ['Nc3', 8], ['Bc4', 8]];
const E5: Spec[] = [['d4', 33], ['Bb5', 32], ['Bc4', 20]];

type Ask = 'why' | 'opponent' | 'hint' | 'repeat';

/** The fake coach plus the dock's «Спроси» chips. */
class AskingCoach extends FakeCoach {
  private askListeners: ((q: Ask) => void)[] = [];
  onAsk(cb: (q: Ask) => void): () => void {
    this.askListeners.push(cb);
    return () => {
      this.askListeners = this.askListeners.filter((l) => l !== cb);
    };
  }
  ask(q: Ask): void {
    for (const listener of [...this.askListeners]) listener(q);
  }
}

const live: GameController[] = [];

function setup(timings: Partial<GameTimings> = {}, stage = 1): { h: TestHarness; coach: AskingCoach; game: GameController } {
  const h = createTestHarness({ profile: { stage }, timings });
  h.deps.teacherContent = { repertoirePlan: getRepertoirePlan, mainLineMoves, openingNameRu: (fen) => lookupOpening(fen)?.nameRu, conceptCard: getConceptCard };
  const coach = new AskingCoach();
  h.deps.coach = coach;
  script(h, [], E1);
  script(h, ['e4', 'e5'], E2);
  script(h, ['e4', 'e5', 'Nf3', 'Nc6'], E5);
  h.bot.replies = ['e7e5', 'b8c6', 'g8f6'];
  const game = createGameController(h.deps);
  live.push(game);
  return { h, coach, game };
}

function cfg(tc: TimeControlId = 'training', childColor: Color = 'w'): GameConfig {
  return { personaId: 'petya', timeControlId: tc, childColor, examMode: false, coachStyle: 'teacher' };
}

async function turn(game: GameController, san: string): Promise<void> {
  const move = new Chess(game.store.getState().fen).move(san);
  expect(game.dropPiece(move.from, move.to), san).toBe(true);
  await game.whenSettled();
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor: ${what} not met in time`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function journal(h: TestHarness, game: GameController): { type: string; data: Record<string, unknown>; ply?: number }[] {
  game.persistNow();
  return h.saved[0]?.events ?? readResumableGame(h.storage)?.events ?? [];
}

function greenArrows(game: GameController): { from: string; to: string }[] {
  return (game.store.getState().annotations?.arrows ?? []).filter((a) => a.color === 'green').map(({ from, to }) => ({ from, to }));
}

function teachTurns(coach: FakeCoach): CoachEvent[] {
  return coach.said.filter((e) => e.kind === 'teachTurn');
}

// ───────────────────────── turning a turn into a quiz / a quiet turn ─────────────────────────

const QUESTION = 'Как думаешь, что задумал соперник?';

function quizFor(ply: number): LessonQuiz {
  return {
    id: `q${ply}-oppIdea`,
    kind: 'oppIdea',
    ply,
    question: QUESTION,
    options: [
      { id: 'attack', label: 'Нападает' },
      { id: 'develop', label: 'Выводит фигуру' },
      { id: 'center', label: 'Занимает центр' },
    ],
    correctId: 'develop',
  };
}

/** The lesson memory as the director would leave it after asking: the advice not shown, the quiz asked. */
function askedMemory(memory: TeachMemory, ply: number): TeachMemory {
  const lesson = memory.lesson;
  if (!lesson) return memory;
  return {
    ...memory,
    lesson: {
      ...lesson,
      adviceShown: lesson.adviceShown.filter((p) => p !== ply),
      lastAdvice: lesson.lastAdvice ? { ...lesson.lastAdvice, hidden: true } : null,
      quizzes: [...lesson.quizzes, { turn: lesson.turn, ply, kind: 'oppIdea', correct: null }],
    },
  };
}

/** The turn of `ply` becomes a quiz (its advice hidden until the answer, the time-out after `revealAfterMs`). */
function quizAt(ply: number, revealAfterMs = 20_000): (raw: unknown) => unknown {
  return (raw) => {
    const out = raw as TurnOut;
    if (out.plan.ply !== ply) return out;
    const quiz = quizFor(ply);
    const event: CoachEvent = {
      id: `test-quiz-${ply}`,
      kind: 'teachTurn',
      priority: 1,
      text: QUESTION,
      bubbleText: QUESTION,
      pose: 'think',
      pauseClock: true,
      teach: { moment: 'quiz', style: 'short', ply, advice: [], reveal: 'later' },
      say: [{ pool: 'v3.quiz.q.oppIdea', n: 1 }],
      quiz,
    };
    const memory = askedMemory(out.memory, ply);
    const quizPlan = { kind: 'oppIdea' as const, options: quiz.options.map((o) => ({ id: o.id, pool: `v3.quiz.opt.${o.id}` })), correct: quiz.correctId, questionPool: 'v3.quiz.q.oppIdea', answerSquares: [] };
    const lesson = out.plan.lesson ? { ...out.plan.lesson, moment: 'quiz' as const, quiz: quizPlan, adviceHidden: true, revealAfterMs } : undefined;
    return {
      plan: { ...out.plan, memory, ...(lesson ? { lesson } : {}) },
      memory,
      result: { ...out.result, moment: 'quiz', event, board: { arrows: [], highlights: [] }, adviceHidden: true, revealAfterMs, hints: [], quiz, bark: null },
    } satisfies TurnOut;
  };
}

/**
 * The turn of `ply` hides its advice (a treasure: «найдёшь сам?», §2.7): no arrow, timed hints (a yellow square each),
 * the reveal after `revealAfterMs` (lesson ms, scaled by the test's `treasureRevealMs / 10 000`).
 */
function hiddenAt(ply: number, revealAfterMs: number, hints: readonly { atMs: number; square: Square }[]): (raw: unknown) => unknown {
  return (raw) => {
    const out = raw as TurnOut;
    if (out.plan.ply !== ply) return out;
    const text = 'Ого, тут подарок! Найдёшь сам?';
    const event: CoachEvent = {
      id: `test-hidden-${ply}`,
      kind: 'teachTurn',
      priority: 1,
      text,
      bubbleText: text,
      pose: 'think',
      pauseClock: false,
      teach: { moment: 'turn', style: 'short', ply, advice: [], reveal: 'later' },
      say: [{ pool: 'v3.treasure.ask', n: 1 }],
    };
    const lesson = out.memory.lesson;
    const memory: TeachMemory = lesson
      ? { ...out.memory, lesson: { ...lesson, adviceShown: lesson.adviceShown.filter((p) => p !== ply), lastAdvice: lesson.lastAdvice ? { ...lesson.lastAdvice, hidden: true } : null } }
      : out.memory;
    const planLesson = out.plan.lesson ? { ...out.plan.lesson, moment: 'treasure' as const, adviceHidden: true, revealAfterMs } : undefined;
    return {
      plan: { ...out.plan, memory, ...(planLesson ? { lesson: planLesson } : {}) },
      memory,
      result: {
        ...out.result,
        moment: 'treasure',
        event,
        board: { arrows: [], highlights: [] },
        adviceHidden: true,
        revealAfterMs,
        hints: hints.map((hint) => ({ atMs: hint.atMs, board: { arrows: [], highlights: [{ square: hint.square, color: 'yellow' as const }] } })),
        quiz: null,
        bark: null,
      },
    } satisfies TurnOut;
  };
}

function highlighted(game: GameController, square: Square): boolean {
  return (game.store.getState().annotations?.highlights ?? []).some((h) => h.square === square);
}

/** The turn of `ply` becomes quiet (§2.2 moment 7): no words, the arrow at once. */
function quietAt(ply: number): (raw: unknown) => unknown {
  return (raw) => {
    const out = raw as TurnOut;
    if (out.plan.ply !== ply) return out;
    const arrows = out.result.advice.map((a) => ({ from: a.uci.slice(0, 2), to: a.uci.slice(2, 4), color: 'green' as const })) as TurnOut['result']['board']['arrows'];
    return { ...out, result: { ...out.result, moment: 'quiet', event: null, board: { arrows, highlights: [] }, adviceHidden: false, revealAfterMs: null, hints: [], quiz: null, bark: 'Ага' } } satisfies TurnOut;
  };
}

beforeEach(() => {
  ctl.turn = null;
  ctl.reaction = null;
  ctl.turns.length = 0;
  ctl.answers.length = 0;
  ctl.reactions.length = 0;
  ctl.reveals.length = 0;
  ctl.repeats.length = 0;
  ctl.whys.length = 0;
});

afterEach(() => {
  for (const game of live.splice(0)) game.dispose();
});

// ───────────────────────── the quiz card (§2.4) ─────────────────────────

describe('the quiz card (docs/TEACHING.md §2.4)', () => {
  it('question + three buttons, no arrow, both clocks held, «Спроси» hidden; an answer is journaled, explained with the arrow, then the card goes', async () => {
    const { h, coach, game } = setup();
    ctl.turn = quizAt(3);
    await game.start(cfg('rapid10'));
    await game.whenSettled();
    await turn(game, 'e4');

    let state = game.store.getState();
    expect(state.quiz).toMatchObject({ id: 'q3-oppIdea', ply: 3, question: QUESTION, answeredId: null, streak: 0 });
    expect(state.quiz?.options.map((o) => o.label)).toEqual(['Нападает', 'Выводит фигуру', 'Занимает центр']);
    // the advice waits for the answer: no arrow, nothing «shown»
    expect(state.advice).toBeNull();
    expect(greenArrows(game)).toEqual([]);
    expect(coach.askSuppressed).toBe(true);
    // both clocks stand while the question is open (the words are over — the 'quiz' hold, not the teacher's)
    await tick(20);
    expect(game.store.getState().clock.paused).toBe(true);
    const heldAt = game.store.getState().clock.w;
    await tick(40);
    expect(game.store.getState().clock.w).toBe(heldAt);
    // journal: the question with its buttons (the server's journal shows them, the right one marked)
    const asked = journal(h, game).find((e) => e.type === 'coachSaid' && (e.data.teach as { moment?: string } | undefined)?.moment === 'quiz');
    expect(asked?.data).toMatchObject({ kind: 'teachTurn', text: QUESTION, quiz: { id: 'q3-oppIdea', correctId: 'develop' } });

    game.answerQuiz('develop');
    expect(ctl.answers).toEqual([{ ply: 3, optionId: 'develop' }]);
    state = game.store.getState();
    // the card stays a moment with the answer marked; the streak counts the right answer
    expect(state.quiz).toMatchObject({ id: 'q3-oppIdea', answeredId: 'develop', streak: 1 });
    // the explanation: right + the truth + the advice, and the arrow NOW
    const answer = coach.said.at(-1) as CoachEvent;
    expect(answer.teach?.moment).toBe('answer');
    expect(answer.say?.[0]?.pool).toBe('v3.quiz.right');
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
    expect(state.advice?.[0]?.san).toBe('Nf3');
    // the clock runs again (the explanation holds it only while it is said)
    await tick(10);
    expect(game.store.getState().clock.paused).toBe(false);
    await waitFor(() => game.store.getState().quiz === null, 1_000, 'the card goes');
    expect(coach.askSuppressed).toBe(false);
    // journal: the child's answer, exactly as the server's journal expects it
    const answered = journal(h, game).find((e) => e.type === 'childSaid' && e.data.about === 'quiz');
    expect(answered?.data).toEqual({ source: 'choice', about: 'quiz', quizId: 'q3-oppIdea', optionId: 'develop', correct: true, question: QUESTION, text: 'Выводит фигуру' });
    expect(answered?.ply).toBe(3);

    // the move after a quiz is the child's own; the arrow was on the board; the history includes the move
    await turn(game, 'Nf3');
    expect(ctl.reactions.at(-1)).toMatchObject({ quizAnswered: true, adviceShown: true, historySan: ['e4', 'e5', 'Nf3'] });
  });

  it('a wrong answer: «не угадал» in the journal, the streak starts over, the right option is marked', async () => {
    const { h, game } = setup();
    ctl.turn = quizAt(3);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    game.answerQuiz('attack');
    expect(game.store.getState().quiz).toMatchObject({ answeredId: 'attack', correctId: 'develop', streak: 0 });
    const answered = journal(h, game).find((e) => e.type === 'childSaid' && e.data.about === 'quiz');
    expect(answered?.data).toMatchObject({ optionId: 'attack', correct: false, text: 'Нападает' });
    // a second tap on the answered card changes nothing
    game.answerQuiz('develop');
    expect(ctl.answers).toHaveLength(1);
  });

  it('a move closes the card silently: no answer said, the director not asked; the move is the child\'s own, the arrow unseen', async () => {
    const { h, coach, game } = setup();
    ctl.turn = quizAt(3);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    expect(game.store.getState().quiz).not.toBeNull();
    const before = coach.said.length;
    await turn(game, 'Nf3');
    expect(ctl.answers).toEqual([]);
    expect(coach.said.slice(before).some((e) => e.teach?.moment === 'answer' && e.teach.ply === 3)).toBe(false);
    expect(coach.askSuppressedLog).toEqual([true, false]);
    expect(ctl.reactions.at(-1)).toMatchObject({ quizAnswered: false, adviceShown: false });
    const move = journal(h, game).find((e) => e.type === 'move' && e.data.san === 'Nf3');
    expect(move?.data.adviceHidden).toBe(true);
    expect(move?.data.followed).toBeUndefined();
    expect(journal(h, game).some((e) => e.type === 'childSaid' && e.data.about === 'quiz')).toBe(false);
  });

  it('nobody answers: after the quiz time lessonAnswer(null) explains it and shows the arrow; the card closes', async () => {
    // treasureRevealMs 100 = the lesson's times × 0.01: the quiz time 20 s → 200 ms
    const { h, coach, game } = setup({ treasureRevealMs: 100 });
    ctl.turn = quizAt(3);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    expect(game.store.getState().quiz).not.toBeNull();
    await waitFor(() => ctl.answers.length === 1, 2_000, 'the time-out');
    expect(ctl.answers).toEqual([{ ply: 3, optionId: null }]);
    expect(game.store.getState().quiz).toBeNull();
    expect(coach.askSuppressed).toBe(false);
    expect((coach.said.at(-1) as CoachEvent).teach?.moment).toBe('answer');
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
    expect(journal(h, game).some((e) => e.type === 'childSaid' && e.data.about === 'quiz')).toBe(false);
  });

  it('the quiz hold has its own safety: after quizHoldMaxMs the clock runs although the card is still open', async () => {
    const { game } = setup({ quizHoldMaxMs: 80, treasureRevealMs: 60_000 });
    ctl.turn = quizAt(3);
    await game.start(cfg('rapid10'));
    await game.whenSettled();
    await turn(game, 'e4');
    await tick(10);
    expect(game.store.getState().clock.paused).toBe(true);
    await waitFor(() => !game.store.getState().clock.paused, 1_000, 'the safety release');
    expect(game.store.getState().quiz).not.toBeNull();
  });

  it('a stale card (a position that is not on the board) is dropped: no answer, no journal line', async () => {
    const { h, game } = setup();
    ctl.turn = quizAt(3);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    const quiz = game.store.getState().quiz;
    expect(quiz).not.toBeNull();
    if (quiz) game.store.setState({ quiz: { ...quiz, ply: quiz.ply + 2 } });
    game.answerQuiz('develop');
    expect(ctl.answers).toEqual([]);
    expect(game.store.getState().quiz).toBeNull();
    expect(journal(h, game).some((e) => e.type === 'childSaid' && e.data.about === 'quiz')).toBe(false);
  });

  it('«Совет» closes the card as skipped (its answer is not said) and shows the advice', async () => {
    const { coach, game } = setup({ treasureRevealMs: 60_000 });
    ctl.turn = quizAt(3);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await game.requestHint('button');
    expect(ctl.answers).toEqual([]);
    expect(ctl.repeats).toEqual([3]);
    expect(game.store.getState().quiz).toBeNull();
    expect(coach.askSuppressed).toBe(false);
    expect((coach.said.at(-1) as CoachEvent).teach?.moment).toBe('reveal');
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
  });

  it('«Почему так?» closes the card as skipped but keeps the advice hidden — its time reveals it later (a reveal, not an answer)', async () => {
    const { coach, game } = setup({ treasureRevealMs: 100 });
    ctl.turn = quizAt(3);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    coach.ask('why');
    await waitFor(() => ctl.whys.length === 1, 1_000, '«Почему так?»');
    expect(game.store.getState().quiz).toBeNull();
    expect(greenArrows(game)).toEqual([]);
    await waitFor(() => ctl.reveals.length === 1, 2_000, 'the reveal');
    expect(ctl.answers).toEqual([]);
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
  });

  it('«Вернуть ход» closes the card as skipped', async () => {
    const { game } = setup({ treasureRevealMs: 60_000 });
    ctl.turn = quizAt(5);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    expect(game.store.getState().quiz?.ply).toBe(5);
    expect(game.undoLastMove()).toBe(true);
    expect(game.store.getState().quiz).toBeNull();
    expect(ctl.answers).toEqual([]);
  });

  it('the takeaway and the quiz score go to the result card', async () => {
    const { coach, game } = setup();
    ctl.turn = quizAt(3);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    game.answerQuiz('develop');
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();
    const state = game.store.getState();
    expect(state.quizScore).toEqual({ right: 1, total: 1 });
    expect(state.takeaway).not.toBeNull();
    const end = coach.said.find((e) => e.kind === 'gameEnd') as CoachEvent;
    expect(end.teach?.moment).toBe('takeaway');
    expect(end.text).toContain(state.takeaway ?? '');
  });
});

// ───────────────────────── the arrow after its sentence (§2.2 `at: 'end'`, §4.6) ─────────────────────────

describe('the green arrow of a calm advice comes after its sentence', () => {
  it('never while the coach is still saying it; the event handed to the coach has no arrow; the words over → the arrow', async () => {
    const { coach, game } = setup({ adviceArrowMinMs: 60, adviceArrowPerWordMs: 0, adviceArrowMaxMs: 60, adviceArrowWaitMaxMs: 5_000 });
    coach.holdSpeech = true;
    await game.start(cfg());
    await waitFor(() => teachTurns(coach).length === 1, 2_000, 'the first advice');
    const ev = teachTurns(coach)[0] as CoachEvent;
    expect(ev.cues?.some((c) => c.kind === 'move' && c.at === 'end')).toBe(true);
    expect((ev.board?.arrows ?? []).filter((a) => a.color === 'green')).toEqual([]);
    // the advice is decided (the screen and the e2e know it), its arrow waits
    expect(game.store.getState().advice?.[0]?.san).toBe('e4');
    await tick(150);
    expect(greenArrows(game)).toEqual([]);
    coach.releaseSpeech();
    await waitFor(() => greenArrows(game).length === 1, 1_000, 'the arrow after the words');
    expect(greenArrows(game)).toEqual([{ from: 'e2', to: 'e4' }]);
  });

  it('a coach whose words end at once (no voice): the reading time max(min, per word × words) ≤ max', async () => {
    const { coach, game } = setup({ adviceArrowMinMs: 30, adviceArrowPerWordMs: 20, adviceArrowMaxMs: 400, adviceArrowWaitMaxMs: 5_000 });
    const saidAt = new Map<string, number>();
    const say = coach.say.bind(coach);
    coach.say = (event: CoachEvent) => {
      saidAt.set(event.id, Date.now());
      return say(event);
    };
    let arrowAt: number | null = null;
    game.store.subscribe((s) => {
      if (arrowAt === null && (s.annotations?.arrows ?? []).some((a) => a.color === 'green')) arrowAt = Date.now();
    });
    await game.start(cfg());
    await waitFor(() => arrowAt !== null, 2_000, 'the arrow');
    const ev = teachTurns(coach)[0] as CoachEvent;
    const words = ev.text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    const expected = Math.min(400, Math.max(30, 20 * words));
    expect((arrowAt ?? 0) - (saidAt.get(ev.id) ?? 0)).toBeGreaterThanOrEqual(expected - 5);
  });

  it('a voice that never says «done» does not hide the arrow for ever (adviceArrowWaitMaxMs)', async () => {
    const { coach, game } = setup({ adviceArrowMinMs: 20, adviceArrowPerWordMs: 0, adviceArrowMaxMs: 20, adviceArrowWaitMaxMs: 120 });
    coach.holdSpeech = true;
    await game.start(cfg());
    await waitFor(() => teachTurns(coach).length === 1, 2_000, 'the first advice');
    await waitFor(() => greenArrows(game).length === 1, 1_000, 'the capped arrow');
    coach.releaseSpeech();
  });

  it('a move before the arrow: it never appears for the old position, and the advice counts as not seen', async () => {
    const { h, coach, game } = setup({ adviceArrowMinMs: 60, adviceArrowPerWordMs: 0, adviceArrowMaxMs: 60, adviceArrowWaitMaxMs: 5_000 });
    coach.holdSpeech = true;
    await game.start(cfg());
    await waitFor(() => teachTurns(coach).length === 1, 2_000, 'the first advice');
    // (the next advice is held by the speaking coach too: step by the board, not by whenSettled)
    const e4 = new Chess(game.store.getState().fen).move('e4');
    expect(game.dropPiece(e4.from, e4.to)).toBe(true);
    await waitFor(() => game.store.getState().moves.length === 2, 2_000, 'the bot\'s reply');
    await tick(100);
    expect(greenArrows(game).some((a) => a.from === 'e2')).toBe(false);
    coach.holdSpeech = false;
    coach.releaseSpeech();
    await game.whenSettled();
    const move = journal(h, game).find((e) => e.type === 'move' && e.data.san === 'e4');
    expect(move?.data.followed).toBeUndefined();
    expect(move?.data.adviceHidden).toBe(true);
    expect(ctl.reactions[0]).toMatchObject({ adviceShown: false });
  });

  it('nothing heard (the silent layer, muted, «не озвучено»): the arrow after the reading time — never waiting for the silent end', async () => {
    const { coach, game } = setup({ adviceArrowMinMs: 60, adviceArrowPerWordMs: 0, adviceArrowMaxMs: 60, adviceArrowWaitMaxMs: 5_000 });
    coach.aloud = false;
    // the advice's say() lasts «9 s» like the silent layer's bubble; the phrases before it are over at once
    coach.holdSpeech = true;
    coach.holdOnly = (e) => e.kind === 'teachTurn';
    const saidAt = new Map<string, number>();
    const say = coach.say.bind(coach);
    coach.say = (event: CoachEvent) => {
      saidAt.set(event.id, Date.now());
      return say(event);
    };
    let arrowAt: number | null = null;
    game.store.subscribe((s) => {
      if (arrowAt === null && (s.annotations?.arrows ?? []).some((a) => a.color === 'green')) arrowAt = Date.now();
    });
    void game.start(cfg());
    await waitFor(() => arrowAt !== null, 2_000, 'the arrow without the words\' end');
    const ev = teachTurns(coach)[0] as CoachEvent;
    const waited = (arrowAt ?? 0) - (saidAt.get(ev.id) ?? 0);
    expect(waited).toBeGreaterThanOrEqual(55);
    expect(waited).toBeLessThan(1_000);
    expect(greenArrows(game)).toEqual([{ from: 'e2', to: 'e4' }]);
    expect(coach.speaksAloudCalls).toBeGreaterThan(0);
    coach.holdSpeech = false;
    coach.releaseSpeech();
    await game.whenSettled();
  });

  it('the reading time counts from when its words come up: never while the reaction before it is still in the bubble', async () => {
    const { coach, game } = setup({ adviceArrowMinMs: 60, adviceArrowPerWordMs: 0, adviceArrowMaxMs: 60, adviceArrowWaitMaxMs: 5_000 });
    coach.aloud = false;
    await game.start(cfg());
    await game.whenSettled();
    const reaction: CoachEvent = { id: 'test-reaction', kind: 'teachReaction', priority: 1, text: 'Пешка встала в центр.', bubbleText: 'Пешка встала в центр.', pose: 'talk', pauseClock: false };
    ctl.reaction = (raw) => ({ ...(raw as ReactionOut), now: reaction });
    // the reaction to the child's move is still «said» (silent: its bubble's time) while the bot answers
    coach.holdSpeech = true;
    coach.holdOnly = (e) => e.id === reaction.id;
    const e4 = new Chess(game.store.getState().fen).move('e4');
    expect(game.dropPiece(e4.from, e4.to)).toBe(true);
    await waitFor(() => teachTurns(coach).some((e) => e.teach?.ply === 3), 2_000, 'the next advice');
    expect(game.store.getState().advice?.[0]?.san).toBe('Nf3');
    await tick(250);
    expect(greenArrows(game)).toEqual([]);
    const releasedAt = Date.now();
    coach.releaseSpeech();
    await waitFor(() => greenArrows(game).length === 1, 1_000, 'the arrow after its own reading time');
    expect(Date.now() - releasedAt).toBeGreaterThanOrEqual(55);
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
    coach.holdSpeech = false;
    await game.whenSettled();
  });

  it('said aloud, then the sound goes off mid-sentence: the arrow at the next check, not at the end of the words', async () => {
    const { coach, game } = setup({ adviceArrowMinMs: 30, adviceArrowPerWordMs: 0, adviceArrowMaxMs: 30, adviceArrowWaitMaxMs: 5_000 });
    coach.holdSpeech = true;
    coach.holdOnly = (e) => e.kind === 'teachTurn';
    void game.start(cfg());
    await waitFor(() => teachTurns(coach).length === 1, 2_000, 'the first advice');
    await tick(300);
    // heard: the arrow waits for the end of the words
    expect(greenArrows(game)).toEqual([]);
    coach.aloud = false;
    await waitFor(() => greenArrows(game).length === 1, 1_000, 'the arrow once nothing is heard');
    coach.holdSpeech = false;
    coach.releaseSpeech();
    await game.whenSettled();
  });
});

// ───────────────────────── a hidden advice: its hints stop once it is shown (§2.7) ─────────────────────────

describe('the hints of a hidden advice stop once the advice is on the board', () => {
  // treasureRevealMs 1 000 = the lesson's times × 0.1
  const HINTS = [
    { atMs: 3_000, square: 'a6' as Square },
    { atMs: 6_000, square: 'h6' as Square },
  ];

  it('the hints come on their times while it is hidden', async () => {
    const { game } = setup({ treasureRevealMs: 1_000 });
    ctl.turn = hiddenAt(3, 60_000, HINTS);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    expect(greenArrows(game)).toEqual([]);
    expect(highlighted(game, 'a6')).toBe(false);
    await waitFor(() => highlighted(game, 'a6'), 1_000, 'the first hint');
    await waitFor(() => highlighted(game, 'h6'), 1_000, 'the second hint');
    expect(greenArrows(game)).toEqual([]);
  });

  it('«Совет» before the first hint: the advice now, no hint afterwards', async () => {
    const { game } = setup({ treasureRevealMs: 1_000 });
    ctl.turn = hiddenAt(3, 60_000, HINTS);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await game.requestHint('button');
    expect(ctl.repeats).toEqual([3]);
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
    await tick(800);
    expect(highlighted(game, 'a6')).toBe(false);
    expect(highlighted(game, 'h6')).toBe(false);
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
  });

  it('«Повтори» after the first hint: the advice now, the second hint never comes', async () => {
    const { coach, game } = setup({ treasureRevealMs: 1_000 });
    ctl.turn = hiddenAt(3, 60_000, HINTS);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await waitFor(() => highlighted(game, 'a6'), 1_000, 'the first hint');
    coach.ask('repeat');
    await waitFor(() => ctl.repeats.length === 1, 1_000, '«Повтори»');
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
    await tick(600);
    expect(highlighted(game, 'h6')).toBe(false);
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
  });

  it('its time reveals it: a hint set for later never lands on the shown advice', async () => {
    const { game } = setup({ treasureRevealMs: 1_000 });
    ctl.turn = hiddenAt(3, 3_000, [
      { atMs: 1_000, square: 'a6' },
      { atMs: 6_000, square: 'h6' },
    ]);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await waitFor(() => ctl.reveals.length === 1, 1_500, 'the reveal');
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
    await tick(600);
    expect(highlighted(game, 'h6')).toBe(false);
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
  });
});

// ───────────────────────── the quiet turn (§2.2 moment 7) ─────────────────────────

describe('a quiet turn', () => {
  it('no words (never an empty bubble) — a short nod; the arrow at once; the move by it is «followed»', async () => {
    const { h, coach, game } = setup();
    ctl.turn = quietAt(3);
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    expect(teachTurns(coach).some((e) => e.teach?.ply === 3)).toBe(false);
    expect(coach.said.some((e) => e.text.trim() === '')).toBe(false);
    expect(coach.poses.at(-1)).toMatchObject({ pose: 'talk' });
    expect(greenArrows(game)).toEqual([{ from: 'g1', to: 'f3' }]);
    expect(game.store.getState().advice?.[0]?.san).toBe('Nf3');
    await turn(game, 'Nf3');
    expect(ctl.reactions.at(-1)).toMatchObject({ adviceShown: true, quizAnswered: false });
    const move = journal(h, game).find((e) => e.type === 'move' && e.data.san === 'Nf3');
    expect(move?.data).toMatchObject({ advice: ['Nf3'], followed: 'primary' });
  });
});

// ───────────────────────── reactions (§2.5) ─────────────────────────

describe('reactions to the child\'s move', () => {
  it('a find over the praise cap: no words, the joyful pose', async () => {
    const { coach, game } = setup();
    await game.start(cfg());
    await game.whenSettled();
    ctl.reaction = (raw) => {
      const out = raw as ReactionOut;
      const lesson = out.memory.lesson;
      if (!lesson) return out;
      return { now: null, memory: { ...out.memory, lesson: { ...lesson, found: [...lesson.found, { turn: lesson.turn, ply: 1, kind: 'tactic' as const }] } } } satisfies ReactionOut;
    };
    const before = coach.said.length;
    await turn(game, 'e4');
    expect(coach.said.slice(before).some((e) => e.kind === 'praise' || e.kind === 'teachReaction')).toBe(false);
    expect(coach.poses.some((p) => p.pose === 'cheer')).toBe(true);
  });

  it('what the reaction is told: the time control, the advice of that ply, the whole history with the move', async () => {
    const { game } = setup();
    await game.start(cfg('rapid10'));
    await game.whenSettled();
    await turn(game, 'e4');
    const args = ctl.reactions[0] as { tc: string; advice: { san: string }[]; adviceShown: boolean; historySan: string[]; judgement: { san: string } };
    expect(args.tc).toBe('rapid10');
    expect(args.advice.map((a) => a.san)).toEqual(['e4']);
    expect(args.adviceShown).toBe(true);
    expect(args.historySan).toEqual(['e4']);
    expect(args.judgement.san).toBe('e4');
  });

  /**
   * The plan of `ply` carries a gift (`plan.treasure`); `moment` is what the lesson made of it: 'treasure' = hidden
   * («найдёшь сам?»), 'advice' = over the per-game cap, told as a normal advice whose words name the capture (§2.7).
   */
  function giftAt(ply: number, moment: 'treasure' | 'advice'): (raw: unknown) => unknown {
    const hide = hiddenAt(ply, 60_000, []);
    return (raw) => {
      const out = (moment === 'treasure' ? hide(raw) : raw) as TurnOut;
      if (out.plan.ply !== ply || !out.plan.lesson) return out;
      const treasure: NonNullable<TurnOut['plan']['treasure']> = { uci: 'e2e4', san: 'e4', from: 'e2', target: 'e4', kind: 'capture', factRu: '', textRu: '', pieceRu: '' };
      const lesson = { ...out.plan.lesson, moment, ...(moment === 'advice' ? { adviceHidden: false, revealAfterMs: null } : {}) };
      return { ...out, plan: { ...out.plan, treasure, lesson } } satisfies TurnOut;
    };
  }

  it('a gift over the cap told as a normal advice is no hidden treasure: taken before its arrow, no «сам нашёл» (§2.7)', async () => {
    const { coach, game } = setup({ adviceArrowMinMs: 60, adviceArrowPerWordMs: 0, adviceArrowMaxMs: 60, adviceArrowWaitMaxMs: 5_000 });
    ctl.turn = giftAt(1, 'advice');
    // the advice is still being said: its arrow (after the sentence) is not up when the child moves
    coach.holdSpeech = true;
    void game.start(cfg());
    await waitFor(() => teachTurns(coach).length === 1, 2_000, 'the advice that names the gift');
    const e4 = new Chess(game.store.getState().fen).move('e4');
    expect(game.dropPiece(e4.from, e4.to)).toBe(true);
    await waitFor(() => ctl.reactions.length === 1, 2_000, 'the reaction');
    expect(ctl.reactions[0]).toMatchObject({ adviceShown: false, treasureHidden: false });
    coach.holdSpeech = false;
    coach.releaseSpeech();
    await game.whenSettled();
  });

  it('a gift the lesson really hid («найдёшь сам?»), taken before its reveal: the treasure was hidden', async () => {
    const { game } = setup({ treasureRevealMs: 1_000 });
    ctl.turn = giftAt(1, 'treasure');
    await game.start(cfg());
    await game.whenSettled();
    expect(greenArrows(game)).toEqual([]);
    await turn(game, 'e4');
    expect(ctl.reactions[0]).toMatchObject({ adviceShown: false, treasureHidden: true });
  });
});

// ───────────────────────── the phrase book (§2.11, §4.6) ─────────────────────────

describe('the phrase book: one per game, its bag in the snapshot, the child\'s memory in localStorage at the end', () => {
  it('«Дозапись голоса»: the book asks the coach for its voice policy on every pick; null = the same words; a broken coach never breaks a pick', async () => {
    const said = async (policy?: () => LessonVoicePolicy | null): Promise<string[]> => {
      const { coach, game } = setup();
      if (policy) (coach as AskingCoach & { voicePolicy?: () => LessonVoicePolicy | null }).voicePolicy = policy;
      await game.start(cfg());
      await game.whenSettled();
      await turn(game, 'e4');
      await turn(game, 'Nf3');
      return coach.said.map((e) => e.text);
    };
    const plain = await said();
    // a coach whose recorded voice does not speak (muted, another voice): the default book, word for word
    let asked = 0;
    expect(
      await said(() => {
        asked += 1;
        return null;
      }),
    ).toEqual(plain);
    expect(asked).toBeGreaterThan(0);
    // the recorded voice speaks: the book probes the lesson units it considers
    const probed: string[] = [];
    await said(() => ({
      voiced: (unitKey) => {
        probed.push(unitKey);
        return false;
      },
      minVoiced: 3,
      growCheap: false,
    }));
    expect(probed.length).toBeGreaterThan(0);
    expect(probed.every((key) => /^line:v3\./.test(key))).toBe(true);
    // a broken coach: the pick goes on as the default book
    const broken = await said(() => {
      throw new Error('boom');
    });
    expect(broken).toEqual(plain);
  });

  it('snapshot → lesson.book; finish → gambit.lessonBook (gameSeq + 1); the next game reads it', async () => {
    const { h, game } = setup();
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    const snapshot = readResumableGame(h.storage);
    expect(Object.keys(snapshot?.lesson?.book.plays ?? {}).length).toBeGreaterThan(0);
    expect(snapshot?.lesson?.book.lastTexts.length).toBeGreaterThan(0);
    // the cross-game memory is written once, at the end of the game
    expect(h.storage.getItem(LESSON_BOOK_KEY)).toBeNull();
    game.resign();
    await game.whenSettled();
    const stored = JSON.parse(h.storage.getItem(LESSON_BOOK_KEY) ?? '{}') as LessonHistory;
    expect(stored.gameSeq).toBe(1);
    expect(Object.keys(stored.recent).length).toBeGreaterThan(0);
    // the takeaway of this game is remembered for the next ones
    expect(stored.takeaways.map((t) => t.game)).toEqual([0]);

    // the next game on this browser: its book starts from that memory
    const next = setup();
    next.h.deps.storage = h.storage;
    ctl.turns.length = 0;
    const second = createGameController(next.h.deps);
    live.push(second);
    await second.start(cfg());
    await second.whenSettled();
    expect((ctl.turns[0] as TeachContext).lessonHistory?.gameSeq).toBe(1);
  });

  it('a continued game goes on with the memory it had before the reload: what it taught reaches localStorage at its end, counted once', async () => {
    const { h, game } = setup();
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.persistNow();
    const snapshot = readResumableGame(h.storage);
    // the wordings said before the reload (every pick is also the cross-game «recently said» of its pool)
    const saidBefore = Object.entries(snapshot?.lesson?.book.plays ?? {}).flatMap(([pool, plays]) => Object.keys(plays).map((n) => [pool, Number(n)] as const));
    expect(saidBefore.length).toBeGreaterThan(0);
    expect(snapshot?.lesson?.history).toMatchObject({ gameSeq: 0 });
    expect(h.storage.getItem(LESSON_BOOK_KEY)).toBeNull();
    game.dispose();

    // the page is reloaded: «Продолжить партию» on the same browser
    const next = setup();
    next.h.deps.storage = h.storage;
    const resumed = createGameController(next.h.deps);
    live.push(resumed);
    await resumed.start(cfg(), { resume: snapshot });
    await resumed.whenSettled();
    expect(resumed.store.getState().resumed).toBe(true);
    resumed.resign();
    await resumed.whenSettled();
    const stored = JSON.parse(h.storage.getItem(LESSON_BOOK_KEY) ?? '{}') as LessonHistory;
    expect(stored.gameSeq).toBe(1);
    for (const [pool, n] of saidBefore) expect(stored.recent[pool], pool).toContain(n);
  });

  it('resumedLessonHistory: the snapshot\'s copy, unless localStorage is ahead of it (a game finished since) or the snapshot has none', () => {
    const at = (gameSeq: number, key: string): LessonHistory => ({ v: 1, gameSeq, recent: {}, minis: { [key]: { level: 1, lastGame: gameSeq, shown: 0 } }, habits: {}, takeaways: [], habitSaid: {} });
    const snap = at(3, 'center');
    expect(resumedLessonHistory(snap, at(3, 'fork'))).toBe(snap);
    expect(resumedLessonHistory(snap, null)).toBe(snap);
    const ahead = at(4, 'fork');
    expect(resumedLessonHistory(snap, ahead)).toBe(ahead);
    expect(resumedLessonHistory(undefined, ahead)).toBe(ahead);
    expect(resumedLessonHistory(null, null)).toBeNull();
  });

  it('every coach style keeps the book in its snapshot, and every style gets the takeaway', async () => {
    const h = createTestHarness();
    h.bot.replies = ['e7e5', 'b8c6'];
    const game = createGameController(h.deps);
    live.push(game);
    await game.start({ personaId: 'petya', timeControlId: 'training', childColor: 'w', examMode: false, coachStyle: 'helper' });
    await turn(game, 'e4');
    expect(readResumableGame(h.storage)?.lesson?.book).toBeDefined();
    expect(readResumableGame(h.storage)?.teach).toBeNull();
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();
    expect(game.store.getState().takeaway).not.toBeNull();
    expect(JSON.parse(h.storage.getItem(LESSON_BOOK_KEY) ?? '{}').gameSeq).toBe(1);
  });

  it('a blocked localStorage never breaks the end of a game', async () => {
    const { h, game } = setup();
    await game.start(cfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    h.storage.failWrites = true;
    game.resign();
    await game.whenSettled();
    expect(game.store.getState().phase).toBe('gameOver');
    expect(game.store.getState().takeaway).not.toBeNull();
  });

  it('the stored history is cut to 16 KB, the oldest wordings first', () => {
    const recent: Record<string, number[]> = {};
    for (let i = 0; i < 400; i++) recent[`v3.pool.number.${i}`] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const big: LessonHistory = { v: 1, gameSeq: 40, recent, minis: {}, habits: {}, takeaways: [{ game: 39, key: 'theme.center' }], habitSaid: {} };
    expect(JSON.stringify(big).length).toBeGreaterThan(LESSON_BOOK_MAX_CHARS);
    const cut = trimLessonHistory(big);
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(LESSON_BOOK_MAX_CHARS);
    // the newest numbers of a pool stay (they are kept oldest first)
    const kept = cut.recent['v3.pool.number.0'] ?? [];
    if (kept.length > 0) expect(kept[kept.length - 1]).toBe(12);
    expect(cut.gameSeq).toBe(40);
    expect(cut.takeaways).toEqual([{ game: 39, key: 'theme.center' }]);
    // a small one is left as it is
    const small: LessonHistory = { ...big, recent: { a: [1, 2] } };
    expect(trimLessonHistory(small)).toEqual(small);
  });
});
