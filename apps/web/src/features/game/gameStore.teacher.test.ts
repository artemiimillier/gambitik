/**
 * «Учитель» in the live game (docs/TEACHING.md §2, §4.6): the per-turn loop of the game controller with a SCRIPTED
 * engine (the MultiPV lines of TEACHER-MODE §8.1) and the real content — the lesson director of @gambit/core picks the
 * moment and the pre-written words; the game shows its board, says its words, keeps its timers and its memory.
 *
 * The wordings change with the writers' work: the checks here are structural (the pools in `say[]`, the cues, the
 * arrows on the board, the timing, the journal), never a sentence. Real timers: the timings of §2.1 are measured.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { getConceptCard } from '@gambit/content';
import { hasSpokenSquare } from '@gambit/core';
import { lookupOpening } from '@gambit/openings';
import type { CoachEvent, Color, GameRecord, StudentProfile, Talkativeness, TimeControlId } from '@gambit/shared';
import { gameRecordSchema } from '../../../../server/src/schemas.ts';
import { getRepertoirePlan, mainLineMoves } from '../../../../../packages/content/src/openings.ts';
import { TEACHER_CONCEPTS_KEY, createGameController, resolveCoachStyle } from './gameStore.ts';
import type { GameController } from './gameStore.ts';
import type { GameConfig, GameTimings } from './gameTypes.ts';
import { readResumableGame } from './resume.ts';
import { createTestHarness, positionKey } from './testing/fakes.ts';
import type { ScriptedLine, TestHarness } from './testing/fakes.ts';

// ───────────────────────── scripted engine (TEACHER-MODE §8.1) ─────────────────────────

type Score = number | { mate: number };
/** [SAN, score from the side to move, …continuation SANs] */
type Spec = [string, Score, ...string[]];

function fenAfter(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

function uciLine(fen: string, sans: readonly string[]): string[] {
  const chess = new Chess(fen);
  return sans.map((san) => {
    const move = chess.move(san);
    return `${move.from}${move.to}${move.promotion ?? ''}`;
  });
}

function lines(fen: string, specs: readonly Spec[]): ScriptedLine[] {
  return specs.map(([san, score, ...rest]) => ({ ...(typeof score === 'number' ? { cp: score } : { mate: score.mate }), pv: uciLine(fen, [san, ...rest]) }));
}

function script(h: TestHarness, sans: readonly string[], specs: readonly Spec[]): string {
  const fen = fenAfter(sans);
  h.judge.scriptFen(fen, lines(fen, specs));
  return fen;
}

const E1: Spec[] = [['e4', 28], ['Nf3', 20], ['d4', 20]];
const E2: Spec[] = [['Nf3', 19], ['Nc3', 8], ['Bc4', 8]];
const E3: Spec[] = [['Nc6', 30], ['d6', 24], ['Qe7', 24]];
const E4: Spec[] = [['g6', 28], ['Qe7', 11], ['Qf6', -11]];
const E5: Spec[] = [['d4', 33], ['Bb5', 32], ['Bc4', 20]];
const E6: Spec[] = [['Qxg5', 611], ['Be7', 80], ['h6', 42]];
const E7: Spec[] = [['Qxd4', 553], ['f4', -44], ['Be3', -47]];
const E12: Spec[] = [['d3', 12], ['Nc3', 10], ['c3', 8]];
/** Black after 1.e4 — not in the §8.1 table; plausible numbers only to reach T3 through the real first turn. */
const B1: Spec[] = [['e5', -25], ['c5', -30], ['e6', -38]];

// ───────────────────────── harness ─────────────────────────

function teacherHarness(o: { stage?: number; timings?: Partial<GameTimings>; talk?: Talkativeness; profile?: Partial<StudentProfile> } = {}): TestHarness {
  const h = createTestHarness({ profile: { stage: o.stage ?? 1, ...o.profile }, timings: o.timings });
  h.deps.teacherContent = {
    repertoirePlan: getRepertoirePlan,
    mainLineMoves,
    openingNameRu: (fen) => lookupOpening(fen)?.nameRu,
    conceptCard: getConceptCard,
  };
  if (o.talk) h.coach.talkativeness = o.talk;
  return h;
}

function cfg(tc: TimeControlId, childColor: Color = 'w', extra: Partial<GameConfig> = {}): GameConfig {
  return { personaId: 'petya', timeControlId: tc, childColor, examMode: false, coachStyle: 'teacher', ...extra };
}

let current: GameController | null = null;

function make(h: TestHarness): GameController {
  current = createGameController(h.deps);
  return current;
}

afterEach(() => {
  current?.dispose();
  current = null;
});

function childPlays(game: GameController, san: string): boolean {
  const move = new Chess(game.store.getState().fen).move(san);
  return game.dropPiece(move.from, move.to);
}

async function turn(game: GameController, san: string): Promise<void> {
  expect(childPlays(game, san), san).toBe(true);
  await game.whenSettled();
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`waitFor: ${what} not met in time`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function teachTurns(h: TestHarness): CoachEvent[] {
  return h.coach.said.filter((e) => e.kind === 'teachTurn');
}

/** The first teacher words of each child ply (the turn itself: advice, quiz, «Сам», a treasure, a mini-lesson…). */
function turnEvents(h: TestHarness): CoachEvent[] {
  const seen = new Set<number>();
  return teachTurns(h).filter((e) => {
    const ply = e.teach?.ply ?? -1;
    if (seen.has(ply) || e.teach?.moment === 'repeat' || e.teach?.moment === 'reveal' || e.teach?.moment === 'answer') return false;
    seen.add(ply);
    return true;
  });
}

function last<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) throw new Error('empty list');
  return item;
}

/** Records when every coach event was handed to the coach (ms, wall clock). */
function recordSayTimes(h: TestHarness): Map<CoachEvent, number> {
  const times = new Map<CoachEvent, number>();
  const say = h.coach.say.bind(h.coach);
  h.coach.say = (event: CoachEvent) => {
    times.set(event, Date.now());
    return say(event);
  };
  return times;
}

/** Records when each bot move appeared on the board (ply → ms) and whether its position was being analysed already. */
function recordBotMoves(game: GameController, h: TestHarness): { at: Map<number, number>; prewarmed: Map<number, boolean> } {
  const at = new Map<number, number>();
  const prewarmed = new Map<number, boolean>();
  game.store.subscribe((state) => {
    const move = state.moves[state.moves.length - 1];
    if (!move || move.by !== 'bot' || at.has(move.ply)) return;
    at.set(move.ply, Date.now());
    prewarmed.set(move.ply, h.judge.calls.some((c) => positionKey(c.fen) === positionKey(move.fenAfter) && c.opts.multipv === 3));
  });
  return { at, prewarmed };
}

const LATIN = /[A-Za-z]/;

/**
 * A lesson utterance (§4.1, §4.5): pre-written wordings only (`say[]` of `v3.*` pools), no brief, no clip; the bubble is
 * the text; never a square, a Latin letter, a digit or «молодец» (§2.2 «Никогда»).
 */
function checkLesson(ev: CoachEvent): void {
  expect(ev.say?.length ?? 0, `${ev.kind}: ${ev.text}`).toBeGreaterThan(0);
  for (const s of ev.say ?? []) expect(s.pool, ev.text).toMatch(/^v3\./);
  expect(ev.brief, ev.text).toBeUndefined();
  expect(ev.clip, ev.text).toBeUndefined();
  expect(ev.bubbleText).toBe(ev.text);
  expect(ev.text.trim(), ev.kind).not.toBe('');
  expect(ev.text, ev.text).not.toMatch(LATIN);
  expect(ev.text, ev.text).not.toMatch(/\d/);
  expect(hasSpokenSquare(ev.text), ev.text).toBe(false);
  expect(ev.text, ev.text).not.toMatch(/молод(ец|чина)|умниц|лучший ход/i);
}

// ───────────────────────── T1 ─────────────────────────

describe('T1 — White, stage 1: the first advice is the first line of the game (E1)', () => {
  it('one teachTurn for ply 1 in the lesson\'s words: e4, a green arrow only (no blue in the lesson model), shown after its sentence', async () => {
    const h = teacherHarness();
    script(h, [], E1);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();

    expect(game.store.getState().coachStyle).toBe('teacher');
    // ONE line at the start: without a strategy there is no theme — the first line is the advice
    expect(h.coach.kinds()).toEqual(['teachTurn']);
    const ev = last(teachTurns(h));
    expect(ev.teach).toMatchObject({ moment: 'turn', ply: 1, reveal: 'now' });
    expect(ev.teach?.advice.map((a) => [a.san, a.arrow])).toEqual([['e4', 'green']]);
    checkLesson(ev);
    // the calm advice's arrow comes after its WHY (§2.2 `at: 'end'`): the coach never shows it while he speaks
    expect(ev.cues?.some((c) => c.kind === 'move' && c.at === 'end')).toBe(true);
    expect((ev.board?.arrows ?? []).filter((a) => a.color === 'green')).toEqual([]);

    const state = game.store.getState();
    // (the fake coach «says» it at once; FAST_TIMINGS read no bubble: the arrow is up after the words)
    expect(state.annotations?.arrows).toEqual([{ from: 'e2', to: 'e4', color: 'green' }]);
    expect(state.advice?.map((a) => a.san)).toEqual(['e4']);
    expect(state.teachMode).toBe('engine');
    expect(state.quiz).toBeNull();
  });

  it('the coach hears the style (dock «Совет», no nudge); the journal has the teacher\'s words with their moment', async () => {
    const h = teacherHarness();
    script(h, [], E1);
    h.bot.replies = ['e7e5'];
    script(h, ['e4', 'e5'], E2);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    expect(h.coach.gameStarts[0]).toMatchObject({ coachStyle: 'teacher', examMode: false });
    expect(h.coach.said[0]?.kind).toBe('teachTurn');
    await turn(game, 'e4');
    game.persistNow();
    const events = readResumableGame(h.storage)?.events ?? [];
    const said = events.filter((e) => e.type === 'coachSaid' && e.data.kind === 'teachTurn');
    expect(said.length).toBeGreaterThanOrEqual(1);
    expect(said[0]?.data.teach).toMatchObject({ moment: 'turn', ply: 1 });
    expect(typeof said[0]?.data.text).toBe('string');
    // the child's move with the advice it saw
    const moves = events.filter((e) => e.type === 'move' && e.data.by === 'child');
    expect(moves[0]?.data).toMatchObject({ san: 'e4', advice: ['e4'], followed: 'primary', teachVerdict: 'followed' });
  });
});

// ───────────────────────── T2 ─────────────────────────

describe('T2 — White, stage 1: the bot answers 1…e5 (E2)', () => {
  it('the advice comes ≤ 1500 ms after the bot\'s move (judge 300 ms, prewarmed during the bot\'s pause)', async () => {
    const h = teacherHarness();
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    h.judge.searchDelayMs = 300;
    h.bot.thinkMs = 600;
    h.bot.replies = ['e7e5'];
    const said = recordSayTimes(h);
    const game = make(h);
    const bot = recordBotMoves(game, h);
    await game.start(cfg('training'));
    await waitFor(() => teachTurns(h).length === 1, 3_000, 'the first advice');

    expect(childPlays(game, 'e4')).toBe(true);
    // the child moved: the arrows are gone at once
    expect(game.store.getState().annotations).toBeNull();
    expect(game.store.getState().advice).toBeNull();
    await waitFor(() => teachTurns(h).some((e) => e.teach?.ply === 3), 6_000, 'the advice after 1…e5');

    const ev = teachTurns(h).find((e) => e.teach?.ply === 3) as CoachEvent;
    const shownAt = bot.at.get(2) ?? Number.NaN;
    expect((said.get(ev) ?? Number.NaN) - shownAt).toBeLessThanOrEqual(1_500);
    // the position after 1…e5 was already being analysed when the move appeared
    expect(bot.prewarmed.get(2)).toBe(true);
    expect(ev.teach?.advice[0]).toMatchObject({ san: 'Nf3', arrow: 'green' });
    expect(ev.teach?.advice).toHaveLength(1);
    checkLesson(ev);
    await game.whenSettled();
    // (the arrow of the new advice is on the board until the child's next move)
    expect(game.store.getState().annotations?.arrows).toContainEqual({ from: 'g1', to: 'f3', color: 'green' });

    await turn(game, 'Nf3');
    game.persistNow();
    const moves = readResumableGame(h.storage)?.events.filter((e) => e.type === 'move' && e.data.by === 'child') ?? [];
    expect(moves[1]?.data).toMatchObject({ san: 'Nf3', advice: ['Nf3'], followed: 'primary', teachVerdict: 'followed' });
  });

  it('a slow engine: the shallow lines of the deadline give one advice («partial», §2.1)', async () => {
    const h = teacherHarness({ timings: { teachAnalysisMs: 60, teachDeadlineMs: 400 } });
    script(h, [], E1);
    h.judge.searchDelayMs = 10_000;
    h.judge.progressDepth = 9;
    const said = recordSayTimes(h);
    const game = make(h);
    const startedAt = Date.now();
    await game.start(cfg('training'));
    await waitFor(() => teachTurns(h).length === 1, 3_000, 'the partial advice');
    const ev = last(teachTurns(h));
    expect((said.get(ev) ?? Number.NaN) - startedAt).toBeLessThan(1_500);
    expect(ev.teach?.advice).toHaveLength(1);
    expect(ev.teach?.advice[0]?.san).toBe('e4');
    expect(game.store.getState().teachMode).toBe('partial');
  });

  it('no engine at all: «by the rules» — only a curated move of the opening, and the screen can say why', async () => {
    const h = teacherHarness();
    h.judge.readyFails = true;
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    const ev = last(teachTurns(h));
    expect(ev.teach?.advice.map((a) => a.san)).toEqual(['e4']);
    expect(game.store.getState().teachMode).toBe('rules');
    expect(game.store.getState().judgeUnavailable).toBe(true);
    checkLesson(ev);
  });
});

// ───────────────────────── T3 / T4 ─────────────────────────

describe('T3 / T4 — Black, stage 2, 10 minutes: 1.e4 e5 2.Фh5 Кc6 3.Сc4', () => {
  it('the clock stands from the bot\'s move to the end of the words; the queen\'s attack; the scholar\'s mate threat at once', async () => {
    const h = teacherHarness({ stage: 2 });
    h.bot.replies = ['e2e4', 'd1h5', 'f1c4'];
    script(h, ['e4'], B1);
    script(h, ['e4', 'e5', 'Qh5'], E3);
    script(h, ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4'], E4);
    h.coach.holdSpeech = true;
    const game = make(h);
    await game.start(cfg('rapid10', 'b'));
    await waitFor(() => teachTurns(h).length === 1, 3_000, 'the first Black advice');

    // T3 (5): the child's clock does not run while the teacher speaks (hold 'teach')
    let state = game.store.getState();
    expect(state.clock.running).toBe('b');
    expect(state.clock.paused).toBe(true);
    const heldAt = state.clock.b;
    await tick(60);
    expect(game.store.getState().clock.b).toBe(heldAt);
    h.coach.releaseSpeech();
    await tick(5);
    expect(game.store.getState().clock.paused).toBe(false);

    expect(childPlays(game, 'e5')).toBe(true);
    await waitFor(() => turnEvents(h).some((e) => e.teach?.ply === 4), 3_000, 'the advice after 2.Фh5');
    const t3 = turnEvents(h).find((e) => e.teach?.ply === 4) as CoachEvent;
    state = game.store.getState();
    expect(state.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5']);
    expect(state.clock.paused).toBe(true);
    // T3: Кc6 from the repertoire defends — never the early queen Фe7 (kid filter); the opponent's attack is named
    expect(t3.teach?.advice[0]).toMatchObject({ san: 'Nc6', arrow: 'green' });
    checkLesson(t3);
    expect(t3.say?.some((s) => s.pool.startsWith('v3.opp.') || s.pool.startsWith('v3.danger.'))).toBe(true);
    h.coach.releaseSpeech();
    await tick(5);

    expect(childPlays(game, 'Nc6')).toBe(true);
    await waitFor(() => turnEvents(h).some((e) => e.teach?.ply === 6), 3_000, 'the advice after 3.Сc4');
    const t4 = turnEvents(h).find((e) => e.teach?.ply === 6) as CoachEvent;
    // T4: the mate threat Фxf7# — a danger (§2.2 moment 1): priority 2, the threat in red, the rescue shown AT ONCE
    checkLesson(t4);
    expect(t4.priority).toBe(2);
    expect(t4.say?.[0]?.pool).toMatch(/^v3\.danger\./);
    expect(t4.board?.highlights).toContainEqual({ square: 'f7', color: 'red' });
    expect(t4.board?.arrows).toContainEqual({ from: 'h5', to: 'f7', color: 'red' });
    expect(t4.teach?.advice.map((a) => a.san)).toEqual(['g6']);
    expect(t4.cues?.some((c) => c.at === 'end')).toBe(false);
    // the danger's first time: its mini-lesson (the scholar's mate) inside the moment, remembered as a card
    if (t4.teach?.moment === 'mini') {
      expect(t4.teach.conceptId).toBe('scholars-mate');
      expect(JSON.parse(h.storage.getItem(TEACHER_CONCEPTS_KEY) ?? '[]')).toContain('scholars-mate');
    }
    // the arrow and the danger are on the board for the child at once
    expect(game.store.getState().annotations?.arrows).toContainEqual({ from: 'g7', to: 'g6', color: 'green' });
    h.coach.releaseSpeech();
  });

  it('«Тихо» still gets the teacher (the talkativeness never silences the lesson)', async () => {
    const h = teacherHarness({ stage: 2, talk: 'quiet' });
    h.bot.replies = ['e2e4', 'd1h5', 'f1c4'];
    script(h, ['e4'], B1);
    script(h, ['e4', 'e5', 'Qh5'], E3);
    script(h, ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4'], E4);
    const game = make(h);
    await game.start(cfg('training', 'b'));
    await game.whenSettled();
    await turn(game, 'e5');
    await turn(game, 'Nc6');
    expect(turnEvents(h).map((e) => e.teach?.ply)).toEqual([2, 4, 6]);
    for (const ev of turnEvents(h)) checkLesson(ev);
  });
});

// ───────────────────────── «Как думать»: the mini-lesson of the third move (§2.6, §6.6) ─────────────────────────

describe('mini-lessons (§2.6)', () => {
  it('«как думать» on the child\'s third move: a mini moment with its card, remembered for this child', async () => {
    const h = teacherHarness();
    h.bot.replies = ['e7e5', 'b8c6'];
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    script(h, ['e4', 'e5', 'Nf3', 'Nc6'], E5);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    const third = turnEvents(h).find((e) => e.teach?.ply === 5) as CoachEvent;
    checkLesson(third);
    expect(third.teach).toMatchObject({ moment: 'mini', style: 'concept', conceptId: 'thinking-routine' });
    expect(third.say?.[0]?.pool).toBe('v3.mini.thinking.l1');
    expect(JSON.parse(h.storage.getItem(TEACHER_CONCEPTS_KEY) ?? '[]')).toContain('thinking-routine');
    // the lesson's memory has it (the next level only after the child showed the idea, in a later game)
    game.persistNow();
    expect(readResumableGame(h.storage)?.teach?.memory.lesson?.minis.map((m) => m.topic)).toContain('thinking');
  });
});

// ───────────────────────── T5 ─────────────────────────

describe('T5 — White, stage 1: advice Сc4 (E5), the child plays 3.Кg5 (E6)', () => {
  it('the lesson\'s take-back offer by a concept; «Верну ход»: «да» and the advice again with its arrow; the journal has it all', async () => {
    const h = teacherHarness();
    h.bot.replies = ['e7e5', 'b8c6', 'g8f6'];
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    const e5Fen = script(h, ['e4', 'e5', 'Nf3', 'Nc6'], E5);
    script(h, ['e4', 'e5', 'Nf3', 'Nc6', 'Ng5'], E6);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'Nf3');

    const before = turnEvents(h).find((e) => e.teach?.ply === 5) as CoachEvent;
    expect(before.teach?.advice).toEqual([expect.objectContaining({ san: 'Bc4', arrow: 'green' })]);
    const asked = h.bot.asked.length;

    await turn(game, 'Ng5');
    // (1) the policy offers the take-back; the lesson says what happened by its concept (§2.8, stages 1–2)
    expect(game.store.getState().phase).toBe('coachIntervention');
    const offer = last(h.coach.said);
    expect(offer.kind).toBe('takebackOffer');
    checkLesson(offer);
    expect(offer.say?.map((s) => s.pool)).toEqual(['v3.takeback.stop', expect.stringMatching(/^v3\.mistake\./), 'v3.takeback.ask']);
    expect(offer.teach?.advice).toEqual(before.teach?.advice);
    // the red marks of what happened are on the board
    expect(game.store.getState().annotations?.highlights).toContainEqual({ square: 'g5', color: 'red' });
    // (2) the bot waits for the child's decision
    await tick(30);
    expect(h.bot.asked.length).toBe(asked);

    // (3) «Верну ход»: position E5 again, «да» in the lesson's words, then the advice with its arrow
    game.acceptTakeback();
    await game.whenSettled();
    const state = game.store.getState();
    expect(positionKey(state.fen)).toBe(positionKey(e5Fen));
    expect(state.annotations?.arrows).toContainEqual({ from: 'f1', to: 'c4', color: 'green' });
    expect(state.advice?.[0]?.san).toBe('Bc4');
    const [yes, repeat] = h.coach.said.slice(-2) as [CoachEvent, CoachEvent];
    expect(yes.say?.[0]?.pool).toBe('v3.takeback.yes');
    expect(repeat.kind).toBe('teachTurn');
    expect(repeat.teach?.moment).toMatch(/^(repeat|reveal)$/);
    checkLesson(repeat);

    await turn(game, 'Bc4');
    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    expect(record.coachStyle).toBe('teacher');
    const offered = record.events.find((e) => e.type === 'takebackOffered');
    expect(offered?.data.teach).toMatchObject({ advice: before.teach?.advice });
    const childMoves = record.events.filter((e) => e.type === 'move' && e.data.by === 'child');
    expect(childMoves.find((e) => e.data.san === 'Ng5')?.data).toMatchObject({ advice: ['Bc4'], followed: 'own', takenBack: true });
    expect(childMoves.find((e) => e.data.san === 'Bc4' && e.data.takenBack !== true)?.data).toMatchObject({ followed: 'primary' });
    // advice is not a hint: no hint events in the journal (§1.4)
    expect(record.events.some((e) => e.type === 'hintRequested' || e.type === 'hintGiven')).toBe(false);
    // the end of the game: the lesson's takeaway (every style), journaled with its moment
    const end = record.events.find((e) => e.type === 'coachSaid' && e.data.kind === 'gameEnd');
    expect(end?.data.teach).toMatchObject({ moment: 'takeaway' });
    const parsed = gameRecordSchema.safeParse(record);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    expect(parsed.data).toEqual(record);
  });

  it('«Оставлю свой ход» and the bot takes the knight: no old «Сильнее было так» with the arrows of the old position — the lesson\'s «нет» and its next turn carry it', async () => {
    for (const stage of [1, 3]) {
      const h = teacherHarness({ stage });
      h.bot.replies = ['e7e5', 'b8c6', 'd8g5'];
      script(h, [], E1);
      script(h, ['e4', 'e5'], E2);
      script(h, ['e4', 'e5', 'Nf3', 'Nc6'], E5);
      script(h, ['e4', 'e5', 'Nf3', 'Nc6', 'Ng5'], E6);
      const game = make(h);
      await game.start(cfg('training'));
      await game.whenSettled();
      await turn(game, 'e4');
      await turn(game, 'Nf3');
      await turn(game, 'Ng5');
      expect(game.store.getState().phase).toBe('coachIntervention');
      const before = h.coach.said.length;

      game.declineTakeback();
      await game.whenSettled();
      // the warning came true: Qxg5
      expect(game.store.getState().moves.map((m) => m.san).slice(-2)).toEqual(['Ng5', 'Qxg5']);
      const after = h.coach.said.slice(before);
      expect(after.map((e) => e.kind), `stage ${stage}`).not.toContain('explainBest');
      expect(after.map((e) => e.kind), `stage ${stage}`).not.toContain('thinkingRoutine');
      // only the lesson's words: its «нет» first, then the next turn of the lesson (on the board as it is now)
      for (const ev of after) expect(ev.say?.length ?? 0, `${ev.kind}: ${ev.text}`).toBeGreaterThan(0);
      for (const ev of after) for (const s of ev.say ?? []) expect(s.pool, ev.text).toMatch(/^v3\./);
      expect(after[0]?.say?.[0]?.pool).toBe('v3.takeback.no');
      expect(after.some((e) => e.kind === 'teachTurn' && e.teach?.ply === 7)).toBe(true);
      // the punished move is still no occasion for a cheerful reason reply (the «почему?» answer is journaled only)
      expect(game.store.getState().declineReasons).not.toBeNull();
      const said = h.coach.said.length;
      game.giveDeclineReason('planned');
      expect(game.store.getState().declineReasons).toBeNull();
      expect(h.coach.said.length).toBe(said);
      game.dispose();
      current = null;
    }
  });
});

// ───────────────────────── T6 ─────────────────────────

describe('T6 — White, stage 1: 1.e4 Кc6 2.d4 Кxd4 — the bot gave the knight away (E7)', () => {
  it('a hidden treasure (the target at once, our piece a little later, no arrow); after the reveal time the green arrow d1→d4', async () => {
    // treasureRevealMs 300 = the lesson's times × 0.03: the stage-1 hint at 5 s → 150 ms, the reveal at 10 s → 300 ms
    const h = teacherHarness({ timings: { treasureRevealMs: 300 } });
    h.bot.replies = ['b8c6', 'c6d4'];
    script(h, [], E1);
    script(h, ['e4', 'Nc6', 'd4', 'Nxd4'], E7);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'd4');

    const hidden = turnEvents(h).find((e) => e.teach?.ply === 5) as CoachEvent;
    checkLesson(hidden);
    expect(hidden.teach?.reveal).toBe('later');
    expect(hidden.teach?.advice).toEqual([]);
    expect(hidden.say?.map((s) => s.pool)).toEqual([expect.stringMatching(/^v3\.treasure\./), 'v3.treasure.ask']);
    expect(hidden.board?.arrows ?? []).toEqual([]);
    let state = game.store.getState();
    expect(state.treasure?.ply).toBe(5);
    expect(state.advice).toBeNull();
    expect(state.annotations?.arrows ?? []).toEqual([]);
    expect(state.annotations?.highlights).toContainEqual({ square: 'd4', color: 'yellow' });

    // (§2.7, stages 1–2) a little later our piece lights up — still no arrow
    await waitFor(() => (game.store.getState().annotations?.highlights ?? []).some((x) => x.square === 'd1'), 1_000, 'the second hint');
    expect(game.store.getState().annotations?.arrows ?? []).toEqual([]);

    await waitFor(() => teachTurns(h).some((e) => e.teach?.moment === 'reveal'), 2_000, 'the reveal');
    const reveal = last(teachTurns(h));
    checkLesson(reveal);
    expect(reveal.say?.[0]?.pool).toBe('v3.lead.reveal');
    state = game.store.getState();
    expect(state.annotations?.arrows).toEqual([{ from: 'd1', to: 'd4', color: 'green' }]);
    expect(state.advice?.map((a) => a.san)).toEqual(['Qxd4']);
    expect(state.treasure).toBeNull();
  });

  it('found alone before the reveal → praise for the find, and no reveal afterwards', async () => {
    const h = teacherHarness({ timings: { treasureRevealMs: 300 } });
    h.bot.replies = ['b8c6', 'c6d4', 'e7e5'];
    script(h, [], E1);
    script(h, ['e4', 'Nc6', 'd4', 'Nxd4'], E7);
    script(h, ['e4', 'Nc6', 'd4', 'Nxd4', 'Qxd4'], [['e5', -553]]);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'd4');
    expect(turnEvents(h).find((e) => e.teach?.ply === 5)?.teach?.reveal).toBe('later');
    const praisedBefore = h.coach.said.filter((e) => e.kind === 'praise').length;
    await turn(game, 'Qxd4');
    const praise = h.coach.said.filter((e) => e.kind === 'praise').slice(praisedBefore);
    expect(praise).toHaveLength(1);
    checkLesson(praise[0] as CoachEvent);
    expect(praise[0]?.say?.[0]?.pool).toMatch(/^v3\.praise\./);
    await tick(400);
    expect(teachTurns(h).some((e) => e.teach?.moment === 'reveal')).toBe(false);
  });

  it('«Совет» shows a hidden treasure at once', async () => {
    const h = teacherHarness({ timings: { treasureRevealMs: 60_000 } });
    h.bot.replies = ['b8c6', 'c6d4'];
    script(h, [], E1);
    script(h, ['e4', 'Nc6', 'd4', 'Nxd4'], E7);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'd4');
    await game.requestHint('button');
    const shown = last(h.coach.said);
    expect(shown.kind).toBe('teachTurn');
    expect(shown.teach?.moment).toBe('reveal');
    checkLesson(shown);
    expect(game.store.getState().annotations?.arrows).toEqual([{ from: 'd1', to: 'd4', color: 'green' }]);
    expect(game.store.getState().treasure).toBeNull();
  });
});

// ───────────────────────── «Совет», voice tools ─────────────────────────

describe('«Совет» and the voice tools in «Учитель» (§1.4, §7.1)', () => {
  it('«Совет» repeats the advice in fresh words with the arrow — no ladder, no hint in the journal', async () => {
    const h = teacherHarness();
    h.bot.replies = ['e7e5'];
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    const advised = turnEvents(h).find((e) => e.teach?.ply === 3) as CoachEvent;
    game.toolHost.showOnBoard({ arrows: [], highlights: [] }); // the arrows went away (e.g. the model cleared the board)
    h.coach.pressHintButton();
    await waitFor(() => last(h.coach.said).teach?.moment === 'repeat', 2_000, 'the repeat');
    const repeat = last(h.coach.said);
    checkLesson(repeat);
    expect(repeat.say?.[0]?.pool).toBe('v3.lead.repeat');
    expect(repeat.teach?.advice.map((a) => a.san)).toEqual(advised.teach?.advice.map((a) => a.san));
    // fresh words: the same idea is never the same wording twice in a game while the bag has others (§2.11)
    expect(repeat.text).not.toBe(advised.text);
    const state = game.store.getState();
    expect(state.annotations?.arrows[0]).toEqual({ from: 'g1', to: 'f3', color: 'green' });
    expect(state.hintLevel).toBe(0);
    game.persistNow();
    const events = readResumableGame(h.storage)?.events ?? [];
    expect(events.some((e) => e.type === 'hintRequested' || e.type === 'hintGiven')).toBe(false);
    expect(events.some((e) => e.type === 'coachSaid' && (e.data.teach as { moment?: string } | undefined)?.moment === 'repeat')).toBe(true);
  });

  it('getHint («что мне ходить?») and repeatAdvice return the teacher\'s advice; «Подсказчик» has no repeatAdvice', async () => {
    const h = teacherHarness();
    script(h, [], E1);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    const hint = await game.toolHost.getHint(4);
    expect(hint.kind).toBe('teachTurn');
    expect(hint.teach?.moment).toBe('repeat');
    const again = await game.toolHost.repeatAdvice?.();
    expect(again?.teach?.advice.map((a) => a.san)).toEqual(['e4']);

    const helper = createTestHarness();
    const other = createGameController(helper.deps);
    await other.start(cfg('training', 'w', { coachStyle: 'helper' }));
    expect(await other.toolHost.repeatAdvice?.()).toBeNull();
    expect((await other.toolHost.getHint(1)).kind).toBe('hint');
    other.dispose();
  });

  it('T10 — «а почему не ферзём?» after 1.e4 e5: the best queen move, «немного слабее», the chase by the g6 pawn', async () => {
    const h = teacherHarness();
    h.judge.honorSearchmoves = true;
    h.bot.replies = ['e7e5'];
    script(h, [], E1);
    script(h, ['e4', 'e5'], [...E2, ['Qh5', -24, 'Nc6', 'Bc4', 'g6', 'Qf3', 'Nf6'], ['Qf3', -31], ['Qe2', -32]]);
    script(h, ['e4', 'e5', 'Qh5'], [['Nc6', 24, 'Bc4', 'g6', 'Qf3', 'Nf6']]);
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    expect(game.store.getState().advice?.[0]?.san).toBe('Nf3');

    const startedAt = Date.now();
    const answer = await (game.toolHost.compareMove?.({ piece: 'q' }) ?? Promise.resolve(''));
    expect(Date.now() - startedAt).toBeLessThanOrEqual(1_500);
    expect(answer).toContain('ферзь на аш пять');
    expect(answer).toContain('немного слабее');
    expect(answer).toContain('пешка на же шесть');
    expect(answer).not.toMatch(LATIN);
    // the game did not change
    expect(game.store.getState().moves).toHaveLength(2);

    const same = await (game.toolHost.compareMove?.({ move: 'конь на эф три' }) ?? Promise.resolve(''));
    expect(same).toContain('ход из совета');
    const unclear = await (game.toolHost.compareMove?.({}) ?? Promise.resolve(''));
    expect(unclear).not.toMatch(LATIN);

    // the position answer ends with the advice in «Учитель» (never «ничего не происходит» without a move)
    const position = (await game.toolHost.analyzePosition?.()) ?? '';
    expect(position).toContain('Совет учителя');
    expect(position).toContain('конь на эф три');
    expect(position).not.toMatch(/Лучший ход не называй|подсказки по ступенькам/);
    expect(position).toContain('называй только из совета учителя');
  });
});

// ───────────────────────── 5 minutes ─────────────────────────

describe('«Учитель» in 5 minutes', () => {
  it('the default up to stage 5; the advice every move, prewarmed on the bot\'s REAL move; the child\'s clock stands while he speaks', async () => {
    const h = teacherHarness();
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    h.bot.thinkMs = 300;
    h.bot.replies = ['e7e5'];
    const game = make(h);
    const bot = recordBotMoves(game, h);
    await game.start(cfg('blitz5', 'w', { coachStyle: 'auto' }));
    expect(game.store.getState().coachStyle).toBe('teacher');
    await waitFor(() => teachTurns(h).length === 1, 3_000, 'the first advice');
    await game.whenSettled();
    h.coach.holdSpeech = true;
    expect(childPlays(game, 'e4')).toBe(true);
    await waitFor(() => teachTurns(h).some((e) => e.teach?.ply === 3), 6_000, 'the advice after 1…e5');
    // the position after 1…e5 was analysed during the bot's pause — the move it had decided, never a guess
    expect(bot.prewarmed.get(2)).toBe(true);
    const ev = teachTurns(h).find((e) => e.teach?.ply === 3) as CoachEvent;
    expect(ev.teach?.advice[0]).toMatchObject({ san: 'Nf3', arrow: 'green' });
    checkLesson(ev);

    // the child's 5 minutes stand while the teacher speaks (hold 'teach'), then run again
    let state = game.store.getState();
    expect(state.clock.running).toBe('w');
    expect(state.clock.paused).toBe(true);
    const heldAt = state.clock.w;
    await tick(60);
    expect(game.store.getState().clock.w).toBe(heldAt);
    h.coach.releaseSpeech();
    await tick(5);
    state = game.store.getState();
    expect(state.clock.paused).toBe(false);
    // never a word about the clock
    for (const e of h.coach.said) expect(e.text).not.toMatch(/минут|секунд|часы|время/i);
  });
});

// ───────────────────────── T11 ─────────────────────────

describe('T11 — styles and defaults', () => {
  it('resolveCoachStyle: the defaults (teacher up to stage 5, TEACHER_DEFAULT_MAX_STAGE), what the time control offers, the old configs', () => {
    expect(resolveCoachStyle({ timeControlId: 'training', examMode: false, coachStyle: 'auto' }, 2)).toBe('teacher');
    expect(resolveCoachStyle({ timeControlId: 'rapid10', examMode: false, coachStyle: 'auto' }, 4)).toBe('teacher');
    // the lesson model (docs/TEACHING.md §2.10): «Учитель» by default on stages 1–5
    expect(resolveCoachStyle({ timeControlId: 'rapid10', examMode: false, coachStyle: 'auto' }, 5)).toBe('teacher');
    expect(resolveCoachStyle({ timeControlId: 'rapid10', examMode: false, coachStyle: 'auto' }, 6)).toBe('helper');
    // 5 minutes: the teacher too
    expect(resolveCoachStyle({ timeControlId: 'blitz5', examMode: false, coachStyle: 'auto' }, 1)).toBe('teacher');
    expect(resolveCoachStyle({ timeControlId: 'blitz5', examMode: false, coachStyle: 'auto' }, 5)).toBe('teacher');
    expect(resolveCoachStyle({ timeControlId: 'blitz5', examMode: false, coachStyle: 'teacher' }, 1)).toBe('teacher');
    expect(resolveCoachStyle({ timeControlId: 'bullet1', examMode: false, coachStyle: 'teacher' }, 1)).toBe('helper');
    expect(resolveCoachStyle({ timeControlId: 'training', examMode: true, coachStyle: 'auto' }, 1)).toBe('exam');
    expect(resolveCoachStyle({ timeControlId: 'rapid10', examMode: false, coachStyle: 'exam' }, 1)).toBe('exam');
    // a config from before teacher mode keeps its behaviour
    expect(resolveCoachStyle({ timeControlId: 'training', examMode: false }, 1)).toBe('helper');
    expect(resolveCoachStyle({ timeControlId: 'training', examMode: true }, 1)).toBe('exam');
  });

  it('«auto» picks the default for the child\'s stage; the config, the coach and the record get the concrete style', async () => {
    const cases: [TimeControlId, number, string][] = [
      ['training', 2, 'teacher'],
      ['rapid10', 4, 'teacher'],
      ['rapid10', 5, 'teacher'],
      ['rapid10', 6, 'helper'],
      ['blitz5', 1, 'teacher'],
      ['blitz5', 5, 'teacher'],
    ];
    for (const [tc, stage, expected] of cases) {
      const h = teacherHarness({ stage });
      const game = createGameController(h.deps);
      await game.start(cfg(tc, 'w', { coachStyle: 'auto' }));
      await game.whenSettled();
      expect(game.store.getState().coachStyle, `${tc} stage ${stage}`).toBe(expected);
      expect(game.store.getState().config?.coachStyle).toBe(expected);
      expect(h.coach.gameStarts[0]?.coachStyle).toBe(expected);
      expect(teachTurns(h).length > 0, `${tc} stage ${stage}`).toBe(expected === 'teacher');
      game.dispose();
    }
  });

  it('«Подсказчик» for 20 plies: no teacher words, the ladder and the threat warnings as before', async () => {
    const h = teacherHarness({ timings: { threatWarningDelayMs: 0 } });
    h.bot.replies = ['e5', 'Nc6', 'Bc5', 'Nf6', 'd6', 'O-O', 'a6', 'Ba7', 'h6', 'Re8'];
    const game = make(h);
    await game.start(cfg('training', 'w', { coachStyle: 'helper' }));
    for (const san of ['e4', 'Nf3', 'Bc4', 'c3', 'd3', 'O-O', 'Re1', 'Nbd2', 'Nf1', 'Ng3']) await turn(game, san);
    expect(game.store.getState().moves).toHaveLength(20);
    expect(h.coach.kinds().filter((k) => k === 'teachTurn' || k === 'teachReaction')).toEqual([]);
    expect(h.coach.said.some((e) => e.teach !== undefined)).toBe(false);
    expect(game.store.getState().quiz).toBeNull();
    await game.requestHint('button');
    expect(last(h.coach.said).kind).toBe('hint');
    expect(game.store.getState().hintLevel).toBe(1);
    expect(game.store.getState().advice).toBeNull();
  });

  it('«Экзамен» and bullet: not one teacher word', async () => {
    for (const [tc, style] of [
      ['training', 'exam'],
      ['bullet1', 'teacher'],
    ] as const) {
      const h = teacherHarness();
      h.bot.replies = ['e5', 'Nc6', 'Bc5'];
      const game = createGameController(h.deps);
      await game.start(cfg(tc, 'w', { coachStyle: style }));
      for (const san of ['e4', 'Nf3', 'Bc4']) await turn(game, san);
      expect(h.coach.said.filter((e) => e.kind === 'teachTurn' || e.kind === 'teachReaction' || e.teach !== undefined), `${tc}`).toEqual([]);
      expect(game.store.getState().hintsEnabled).toBe(false);
      game.dispose();
    }
  });
});

// ───────────────────────── T12 ─────────────────────────

describe('T12 — 20 teacher plies of a scripted Italian game', () => {
  const WHITE = ['e4', 'Nf3', 'Bc4', 'c3', 'd3', 'O-O', 'Re1', 'Nbd2', 'Nf1', 'Ng3'];
  const BLACK = ['e5', 'Nc6', 'Bc5', 'Nf6', 'd6', 'O-O', 'a6', 'Ba7', 'h6', 'Re8'];

  it('every turn ≤ 1500 ms after the bot\'s move, within 30 cp, in the lesson\'s words; no warnings, routines or opening ideas', async () => {
    const h = teacherHarness();
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    script(h, ['e4', 'e5', 'Nf3', 'Nc6'], E5);
    script(h, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'], E12);
    h.bot.replies = [...BLACK];
    const said = recordSayTimes(h);
    const game = make(h);
    const bot = recordBotMoves(game, h);
    await game.start(cfg('training'));
    await game.whenSettled();
    for (const san of WHITE) await turn(game, san);
    expect(game.store.getState().moves).toHaveLength(20);

    // (a quiet turn says nothing — a nod — so there may be fewer utterances than turns)
    const turns = turnEvents(h);
    expect(turns.length).toBeGreaterThanOrEqual(6);
    for (const ev of h.coach.said) if (ev.say !== undefined) checkLesson(ev);
    for (const ev of turns) {
      const ply = ev.teach?.ply ?? 0;
      // (1) at most 1500 ms after the bot's move
      if (ply > 1) expect((said.get(ev) ?? Number.NaN) - (bot.at.get(ply - 1) ?? Number.NaN), `ply ${ply}`).toBeLessThanOrEqual(1_500);
      // (3) every advice is an engine line within 30 cp of the first one
      const fen = game.store.getState().moves[ply - 2]?.fenAfter ?? new Chess().fen();
      const analysis = await h.judge.analyze(fen, { depth: 16, multipv: 3 });
      const best = analysis.lines[0]?.cp ?? 0;
      for (const advice of ev.teach?.advice ?? []) {
        const line = analysis.lines.find((l) => l.pvUci[0] === advice.uci);
        expect(line, `${advice.san} at ply ${ply}`).toBeDefined();
        expect(best - (line?.cp ?? -Infinity), `${advice.san} at ply ${ply}`).toBeLessThanOrEqual(30);
      }
    }
    // (5) the teacher replaces them all
    const kinds = h.coach.kinds();
    expect(kinds).not.toContain('threatWarning');
    expect(kinds).not.toContain('thinkingRoutine');
    expect(kinds).not.toContain('encourage');
    // the child's moves are journaled with the advice they SAW (a hidden one: «adviceHidden»)
    game.persistNow();
    const snapshot = readResumableGame(h.storage);
    const moveEvents = snapshot?.events.filter((e) => e.type === 'move' && e.data.by === 'child') ?? [];
    expect(moveEvents).toHaveLength(10);
    for (const event of moveEvents) {
      if (event.data.adviceHidden === true) expect(event.data.followed).toBeUndefined();
      else expect(['primary', 'own']).toContain(event.data.followed);
    }
    // the snapshot keeps the lesson's memory and the phrase book of this game (resume v2, additive)
    expect(snapshot?.teach?.memory.lesson?.turn).toBe(11);
    expect(Object.keys(snapshot?.lesson?.book.plays ?? {}).length).toBeGreaterThan(0);
  });

  it('(6) a move during the remark cuts it (stopSpeaking); the advice of a position already left is never said', async () => {
    const h = teacherHarness();
    script(h, [], E1);
    h.bot.replies = ['e7e5', 'b8c6'];
    h.coach.holdSpeech = true;
    const game = make(h);
    await game.start(cfg('training'));
    h.coach.releaseSpeech();
    await waitFor(() => teachTurns(h).length === 1, 2_000, 'the first advice');
    const stops = h.coach.stopCalls;
    expect(childPlays(game, 'e4')).toBe(true);
    expect(h.coach.stopCalls).toBe(stops + 1);
    // gently (fast play): what waits is dropped, the sentence being said may end (coachGrace.test.ts)
    expect(h.coach.stopOptions.at(-1)).toEqual({ grace: true });

    // a slow engine: the child answers before the next advice is ready → it is dropped, never said late
    h.judge.searchDelayMs = 150;
    await waitFor(() => game.store.getState().phase === 'childTurn' && game.store.getState().moves.length === 2, 3_000, 'the bot\'s reply');
    expect(childPlays(game, 'Nf3')).toBe(true);
    await waitFor(() => game.store.getState().moves.length === 4, 5_000, 'the second reply');
    await waitFor(() => teachTurns(h).some((e) => e.teach?.ply === 5), 5_000, 'the advice of ply 5');
    h.coach.releaseSpeech();
    await game.whenSettled();
    expect([...new Set(teachTurns(h).map((e) => e.teach?.ply))]).toEqual([1, 5]);
  });
});

// ───────────────────────── resume ─────────────────────────

describe('resume (§4.6): the style, the lesson memory and the phrase book survive a reload', () => {
  it('a teacher game continues as a teacher game; the lesson goes on from its memory and its phrase book', async () => {
    const h = teacherHarness();
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    h.bot.replies = ['e7e5', 'b8c6'];
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    const before = readResumableGame(h.storage);
    expect(before?.teach?.memory.lesson?.turn).toBe(2);
    const playsBefore = before?.lesson?.book.plays ?? {};
    expect(Object.keys(playsBefore).length).toBeGreaterThan(0);
    game.dispose();
    current = null;

    const snapshot = readResumableGame(h.storage);
    expect(snapshot?.v).toBe(2);
    expect(snapshot?.config.coachStyle).toBe('teacher');
    const h2 = teacherHarness();
    h2.storage.map.set('gambit.resumeGame', h.storage.getItem('gambit.resumeGame') ?? '');
    const resumed = make(h2);
    await resumed.start(cfg('rapid10', 'b'), { resume: snapshot });
    await resumed.whenSettled();
    expect(resumed.store.getState().coachStyle).toBe('teacher');
    // (a quiz card is never part of the snapshot — the continued game plans its turn anew)
    expect(JSON.stringify(snapshot)).not.toContain('answeredId');
    const ev = last(turnEvents(h2));
    expect(ev.teach?.ply).toBe(3);
    // the lesson goes on: turn 3 of this game, and the bag of the phrase book still has what was said before the reload
    resumed.persistNow();
    const after = readResumableGame(h2.storage);
    expect(after?.teach?.memory.lesson?.turn).toBe(3);
    for (const [pool, counts] of Object.entries(playsBefore)) {
      for (const [n, plays] of Object.entries(counts)) expect(after?.lesson?.book.plays[pool]?.[n] ?? 0, `${pool}#${n}`).toBeGreaterThanOrEqual(plays);
    }
  });

  it('an old (v1) snapshot without a style continues in the style its examMode says', async () => {
    const h = createTestHarness();
    h.bot.replies = ['e7e5', 'b8c6'];
    const game = make(h);
    await game.start({ personaId: 'petya', timeControlId: 'training', childColor: 'w', examMode: false });
    await turn(game, 'e4');
    game.dispose();
    current = null;
    const raw = JSON.parse(h.storage.getItem('gambit.resumeGame') ?? '{}') as Record<string, unknown>;
    raw.v = 1;
    delete raw.teach;
    delete raw.lesson;
    h.storage.setItem('gambit.resumeGame', JSON.stringify(raw));
    const snapshot = readResumableGame(h.storage);
    expect(snapshot?.v).toBe(1);
    const again = make(createTestHarness());
    await again.start(cfg('training'), { resume: snapshot });
    expect(again.store.getState().coachStyle).toBe('helper');
    expect(again.store.getState().resumed).toBe(true);
  });
});
