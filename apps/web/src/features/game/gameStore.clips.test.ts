/**
 * The game with «Записи» (docs/voice-clips/SPEC.md §8.2, §8.3): the dock's «Спроси» chips are answered through the
 * game's own `sayEvent` — so the child's clock stands while the answer plays — and the post-game thought chips are
 * journaled (or follow the record through the existing thoughts route) and answered with a recorded line.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { getConceptCard } from '@gambit/content';
import { hasSpokenSquare } from '@gambit/core';
import { lookupOpening } from '@gambit/openings';
import type { ClipItem, CoachEvent, Color, GameRecord, PersonaId, TimeControlId } from '@gambit/shared';
import { getRepertoirePlan, mainLineMoves } from '../../../../../packages/content/src/openings.ts';
import { createGameController } from './gameStore.ts';
import type { GameController } from './gameStore.ts';
import type { GameConfig, GameTimings } from './gameTypes.ts';
import { FakeCoach, createTestHarness } from './testing/fakes.ts';
import type { ScriptedLine, TestHarness } from './testing/fakes.ts';

type Ask = 'why' | 'opponent' | 'hint' | 'repeat';

/** The harness coach plus the optional `onAsk` of the app's coach controller. */
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

function config(timeControlId: TimeControlId, extra: Partial<GameConfig> = {}): GameConfig {
  return { personaId: 'petya' as PersonaId, timeControlId, childColor: 'w' as Color, examMode: false, ...extra };
}

async function turn(game: GameController, san: string): Promise<void> {
  const chess = new Chess(game.store.getState().fen);
  const move = chess.move(san);
  expect(game.dropPiece(move.from, move.to)).toBe(true);
  await game.whenSettled();
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const live: GameController[] = [];

function setup(timings: Partial<GameTimings> = {}): { h: TestHarness; coach: AskingCoach; game: GameController } {
  const h = createTestHarness({ timings });
  const coach = new AskingCoach();
  h.deps.coach = coach;
  const game = createGameController(h.deps);
  live.push(game);
  return { h, coach, game };
}

// ───────────────────────── «Учитель» with a scripted engine (as gameStore.teacher.test.ts, §8.1) ─────────────────────────

/** [SAN, score from the side to move, …continuation SANs] */
type Spec = [string, number, ...string[]];

function fenAfter(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function script(h: TestHarness, sans: readonly string[], specs: readonly Spec[]): string {
  const fen = fenAfter(sans);
  const lines: ScriptedLine[] = specs.map(([san, cp, ...rest]) => {
    const chess = new Chess(fen);
    return { cp, pv: [san, ...rest].map((m) => chess.move(m)).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`) };
  });
  h.judge.scriptFen(fen, lines);
  return fen;
}

const E1: Spec[] = [['e4', 28], ['Nf3', 20], ['d4', 20]];
const E2: Spec[] = [['Nf3', 19], ['Nc3', 8], ['Bc4', 8]];
/** 1.e4 Кc6 2.d4 Кxd4 — the bot gave the knight away: a hidden treasure (T6 of the teacher tests) */
const E7: Spec[] = [['Qxd4', 553], ['f4', -44], ['Be3', -47]];

function teacherSetup(timings: Partial<GameTimings> = {}): { h: TestHarness; coach: AskingCoach; game: GameController } {
  const h = createTestHarness({ profile: { stage: 1 }, timings });
  h.deps.teacherContent = { repertoirePlan: getRepertoirePlan, mainLineMoves, openingNameRu: (fen) => lookupOpening(fen)?.nameRu, conceptCard: getConceptCard };
  const coach = new AskingCoach();
  h.deps.coach = coach;
  const game = createGameController(h.deps);
  live.push(game);
  return { h, coach, game };
}

const teacherCfg = (tc: TimeControlId = 'training'): GameConfig => ({ ...config(tc), coachStyle: 'teacher' });
const itemsOf = (e: CoachEvent | undefined): ClipItem[] => (e?.clip?.sentences ?? []).flatMap((x) => x.items);
const hasSlot = (e: CoachEvent | undefined): boolean => itemsOf(e).some((i) => 'slot' in i);

async function answerTo(coach: AskingCoach, q: Ask): Promise<CoachEvent> {
  const before = coach.said.length;
  coach.ask(q);
  await waitFor(() => coach.said.length > before);
  return coach.said[coach.said.length - 1] as CoachEvent;
}

afterEach(() => {
  for (const game of live.splice(0)) game.dispose();
});

describe('«Спроси» — answered by the game, the clock held', () => {
  it('«Что задумал соперник?»: the bot\'s last move without its square, and the child\'s clock stands while it plays', async () => {
    const { h, coach, game } = setup();
    h.bot.replies = ['g8f6'];
    await game.start(config('blitz5'));
    await turn(game, 'e4');
    coach.said.length = 0;
    coach.holdSpeech = true;
    const before = game.store.getState().clock.w ?? 0;
    coach.ask('opponent');
    const answer = coach.said.at(-1);
    expect(answer?.kind).toBe('answer');
    expect(answer?.text).toMatch(/^Соперник вывел коня\./);
    expect(answer?.clip?.sentences[0]?.items).toEqual([{ line: 'opp.developed', piece: 'n' }]);
    // 5 minutes: the child's clock does not run while the answer is being said. It does run from the bot's move until
    // the question — a few ms here, a few tens on a busy CI runner; a clock that did not stand would lose all 120 ms
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(game.store.getState().clock.w).toBeGreaterThanOrEqual(before - 80);
    coach.releaseSpeech();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(game.store.getState().clock.w).toBeLessThan(before - 50);
  });

  it('«Повтори» says the last phrase again (a new id); «Совет»/«Подсказка» is the hint button', async () => {
    const { h, coach, game } = setup();
    h.bot.replies = ['e7e5'];
    await game.start(config('training'));
    await turn(game, 'e4');
    const last = coach.said.filter((e) => e.priority >= 1).at(-1);
    expect(last).toBeDefined();
    coach.ask('repeat');
    const again = coach.said.at(-1);
    expect(again?.text).toBe(last?.text);
    expect(again?.id).not.toBe(last?.id);
    const hintsBefore = coach.said.filter((e) => e.kind === 'hint').length;
    coach.ask('hint');
    await game.whenSettled();
    expect(coach.said.filter((e) => e.kind === 'hint').length).toBe(hintsBefore + 1);
  });

  it('«Почему так?» with nothing to explain asks the child back — its own recorded line, never «просто хороший ход»', async () => {
    const { coach, game } = setup();
    await game.start(config('training'));
    coach.ask('why');
    await waitFor(() => coach.said.some((e) => e.id.startsWith('ask-why-')));
    const answer = coach.said.find((e) => e.id.startsWith('ask-why-'));
    expect(answer?.clip?.sentences[0]?.items).toEqual([{ line: 'ask.why.think' }]);
    expect(answer?.text).toBe('Давай подумаем вместе: какая фигура ещё не в игре?');
  });

  it('«Почему так?» while the take-back question is open repeats that question — never «это хороший ход»', async () => {
    const { h, coach, game } = setup();
    h.bot.replies = ['e7e5', 'b8c6', 'd8g5'];
    h.judge.scriptAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Qg5'], [{ cp: 900, pv: ['d8g5'] }]);
    await game.start(config('rapid10'));
    await turn(game, 'e4');
    await turn(game, 'Qh5');
    await turn(game, 'Qg5');
    expect(game.store.getState().phase).toBe('coachIntervention');
    const answer = await answerTo(coach, 'why');
    const line = itemsOf(answer).map((i) => ('line' in i ? i.line : 'slot'));
    expect(line).toHaveLength(1);
    expect(line[0]).toMatch(/^takeback\.q\./);
    expect(answer.text.endsWith('?')).toBe(true);
    expect(answer.board?.arrows ?? []).toEqual([]); // never the better move
    expect(answer.board?.highlights.every((x) => x.color === 'red')).toBe(true);
    expect(game.store.getState().phase).toBe('coachIntervention');
    // after «Верну ход», while the child tries again: the same question, not the explanation of the better move
    game.acceptTakeback();
    await game.whenSettled();
    const again = await answerTo(coach, 'why');
    expect(itemsOf(again).map((i) => ('line' in i ? i.line : 'slot'))[0]).toMatch(/^takeback\.q\./);
    expect(again.kind).not.toBe('explainBest');
  });

  it('«Повтори» after a move never brings back the old arrows or names the old move', async () => {
    const { h, coach, game } = setup();
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    for (let level = 0; level < 4; level++) await game.requestHint('button');
    const hint = coach.said.filter((e) => e.kind === 'hint').at(-1);
    expect(hint?.board?.arrows.length).toBeGreaterThan(0);
    // the same board: said again, arrows and all
    const same = await answerTo(coach, 'repeat');
    expect(same.text).toBe(hint?.text);
    expect(same.board).toEqual(hint?.board);
    // the child moves, the bot answers: that hint was about another board
    await turn(game, 'Nf3');
    const stale = await answerTo(coach, 'repeat');
    expect(stale.board).toBeUndefined();
    expect(stale.teach).toBeUndefined();
    expect(stale.text).not.toBe(hint?.text);
    expect(hasSlot(stale)).toBe(false);
    expect(itemsOf(stale)).toEqual([{ line: 'ask.repeat.stale' }]);
    expect(game.store.getState().annotations).toBeNull();
  });
});

describe('«Спроси» in «Учитель» (docs/TEACHING.md §2.3): the lesson answers — a hidden advice stays hidden for «Почему так?»', () => {
  /** A lesson answer: pre-written wordings (`say[]`), no clip twin (not recorded yet, §4.5), no brief, no square. */
  function checkLessonAnswer(ev: CoachEvent): void {
    expect(ev.say?.length ?? 0, ev.text).toBeGreaterThan(0);
    for (const s of ev.say ?? []) expect(s.pool).toMatch(/^v3\./);
    expect(ev.clip).toBeUndefined();
    expect(ev.brief).toBeUndefined();
    expect(hasSpokenSquare(ev.text), ev.text).toBe(false);
    expect(ev.text).not.toMatch(/[A-Za-z]/);
  }

  it('«Почему так?» on an ordinary turn: one level deeper than the advice\'s reason — new words each press, the same advice', async () => {
    const { h, coach, game } = teacherSetup();
    h.bot.replies = ['e7e5'];
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    await game.start(teacherCfg());
    await game.whenSettled();
    await turn(game, 'e4');
    const turnEvent = coach.said.filter((e) => e.kind === 'teachTurn').at(-1);
    const advised = turnEvent?.teach?.advice[0]?.san;
    expect(advised).toBe('Nf3');
    const answer = await answerTo(coach, 'why');
    expect(answer.kind).toBe('teachTurn');
    checkLessonAnswer(answer);
    expect(answer.text).not.toBe(turnEvent?.text);
    expect(answer.teach?.advice.map((a) => a.san)).toEqual([advised]);
    // a second press goes one step further — never the same words
    const deeper = await answerTo(coach, 'why');
    checkLessonAnswer(deeper);
    expect(deeper.text).not.toBe(answer.text);
    // the advice arrow stays as it was
    expect(game.store.getState().annotations?.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });
  });

  it('«Почему так?» during a hidden treasure: the gift line and «найдёшь сам?» — no move, no arrow, nothing revealed; the reveal comes on time', async () => {
    const { h, coach, game } = teacherSetup({ treasureRevealMs: 400 });
    h.bot.replies = ['b8c6', 'c6d4'];
    script(h, [], E1);
    script(h, ['e4', 'Nc6', 'd4', 'Nxd4'], E7);
    await game.start(teacherCfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'd4');
    expect(game.store.getState().treasure?.ply).toBe(5);

    const answer = await answerTo(coach, 'why');
    checkLessonAnswer(answer);
    expect(answer.say?.map((x) => x.pool)).toEqual([expect.stringMatching(/^v3\.treasure\./), 'v3.treasure.ask']);
    expect(answer.board?.arrows ?? []).toEqual([]);
    expect(answer.teach).toMatchObject({ reveal: 'later', advice: [] });
    // nothing revealed: the treasure still waits, no green arrow on the board
    expect(game.store.getState().treasure?.ply).toBe(5);
    expect(game.store.getState().annotations?.arrows ?? []).toEqual([]);
    expect(coach.said.some((e) => e.teach?.moment === 'reveal')).toBe(false);
    // …so the reveal still comes by itself, on time (its timer untouched)
    await waitFor(() => coach.said.some((e) => e.teach?.moment === 'reveal'), 3_000);
    expect(game.store.getState().annotations?.arrows).toEqual([{ from: 'd1', to: 'd4', color: 'green' }]);
    // once revealed, «Почему так?» is about the gift's move
    const why = await answerTo(coach, 'why');
    checkLessonAnswer(why);
    expect(why.teach?.advice.map((a) => a.san)).toEqual(['Qxd4']);
  });

  it('«Повтори» in «Учитель» says the advice again in fresh words — like «Совет» it shows a hidden treasure', async () => {
    const { h, coach, game } = teacherSetup({ treasureRevealMs: 60_000 });
    h.bot.replies = ['b8c6', 'c6d4'];
    script(h, [], E1);
    script(h, ['e4', 'Nc6', 'd4', 'Nxd4'], E7);
    await game.start(teacherCfg());
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'd4');
    const again = await answerTo(coach, 'repeat');
    checkLessonAnswer(again);
    expect(again.teach?.moment).toBe('reveal');
    expect(game.store.getState().annotations?.arrows).toEqual([{ from: 'd1', to: 'd4', color: 'green' }]);
    expect(game.store.getState().treasure).toBeNull();
    // on the child's turn with the advice on the board: «Повтори» is the lesson's repeat (fresh words, the same move)
    const more = await answerTo(coach, 'repeat');
    checkLessonAnswer(more);
    expect(more.teach?.moment).toBe('repeat');
    expect(more.text).not.toBe(again.text);
  });

  it('«Что задумал соперник?» in «Учитель»: his idea in the lesson\'s words (a lesson answer, no square)', async () => {
    const { h, coach, game } = teacherSetup();
    h.bot.replies = ['g8f6'];
    script(h, [], E1);
    await game.start(teacherCfg());
    await game.whenSettled();
    await turn(game, 'e4');
    const answer = await answerTo(coach, 'opponent');
    expect(answer.kind).toBe('answer');
    checkLessonAnswer(answer);
    expect(answer.say?.[0]?.pool).toMatch(/^v3\.(opp|danger|mini)\./);
  });
});

describe('«Как тебе партия?» — the thought chips after the game', () => {
  async function finished(timings: Partial<GameTimings>) {
    const s = setup(timings);
    s.h.bot.replies = ['e7e5', 'b8c6'];
    await s.game.start(config('training'));
    await turn(s.game, 'e4');
    await turn(s.game, 'Nf3');
    s.game.resign();
    return s;
  }

  it('before the record goes out: journaled as the child\'s choice, answered with a recorded line; two chips at most', async () => {
    const { h, coach, game } = await finished({ childNoteWaitMs: 60_000 });
    await waitFor(() => game.store.getState().note === 'asking');
    expect(game.tapThought('hard')).toBe(true);
    expect(game.tapThought('hard')).toBe(false); // each chip once
    expect(game.tapThought('rematch')).toBe(true);
    expect(game.tapThought('easy')).toBe(false); // two at most
    const replies = coach.said.filter((e) => e.id.startsWith('thought-'));
    expect(replies.map((e) => e.clip?.sentences[0]?.items[0])).toEqual([{ line: 'thought.hard' }, { line: 'thought.rematch' }]);
    expect(replies[1]?.text).toContain('Я готов');
    game.submitChildNote(null);
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    const chosen = record.events.filter((e) => e.type === 'childSaid' && e.data.source === 'choice');
    expect(chosen.map((e) => e.data.text)).toEqual(['Было трудно (выбрал кнопкой)', 'Хочу реванш! (выбрал кнопкой)']);
    expect(chosen[0]?.data.about).toBe('gameFeeling');
  });

  it('after the record went out: the tap follows it through the thoughts route', async () => {
    const { h, game } = await finished({ childNoteWaitMs: 0 });
    await game.whenSettled();
    expect(h.saved).toHaveLength(1);
    expect(game.tapThought('goodMove')).toBe(true);
    await waitFor(() => h.thoughts.length > 0);
    expect(h.thoughts[0]?.thoughts.map((t) => [t.source, t.text, t.question])).toEqual([['typed', 'Я нашёл хороший ход (выбрал кнопкой)', 'Как тебе партия?']]);
  });

  it('never during a game', async () => {
    const { game } = setup();
    await game.start(config('training'));
    expect(game.tapThought('easy')).toBe(false);
  });
});
