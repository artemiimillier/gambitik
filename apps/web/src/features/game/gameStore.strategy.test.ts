/**
 * «Учитель» + the strategist in the live game (the lesson model, docs/TEACHING.md §2.1, §4.4):
 * the strategy of the game is prefetched (with runtime AI off the server answers from its template library and keeps the
 * theme history) and its THEME is the first teacher line — one sentence, never a move; re-plans are the smart model's:
 * only with runtime AI (`coach.runtimeAi()`) are they asked for at the moment the bot's REAL move is decided (before its
 * human pause), carry the engine's candidates, are stored by ply and reach the teacher from the next TeachContext on;
 * stale answers are dropped; no teacher line ever waits for a re-plan; no clock facts; «Поторопись!» once.
 *
 * The TeachContext each turn is planned from is recorded by wrapping the director's `lessonTurn` (core decides what to SAY
 * with it — here only what the game HANDS it is checked). Real timers, scripted engine, fake strategist.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { getStrategy } from '@gambit/content';
import type { StrategyEntry } from '@gambit/content';
import { CLOCK_WORDS_RE } from '@gambit/core';
import type { TeachContext } from '@gambit/core';
import type { CoachEvent, Color, GameStrategy, ReplanRequest, ReplanResponse, StrategyCard, StrategyRequest, TimeControlId } from '@gambit/shared';
import { HURRY_TEXT_RU, createGameController } from './gameStore.ts';
import type { GameController, TeachStrategyContext } from './gameStore.ts';
import type { GameConfig, GameStrategist, GameTimings } from './gameTypes.ts';
import { readResumableGame } from './resume.ts';
import { createBrowserStrategist, createStrategyPrefetcher } from './strategy.ts';
import { THEME_FAMILY_BADGE_RU, themeBadgeRu } from './teacherContent.ts';
import { createTestHarness } from './testing/fakes.ts';
import type { ScriptedLine, TestHarness } from './testing/fakes.ts';

const rec = vi.hoisted(() => ({ planned: [] as unknown[] }));

vi.mock('@gambit/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@gambit/core')>();
  return {
    ...real,
    lessonTurn: (ctx: TeachContext, book: Parameters<typeof real.lessonTurn>[1], rng?: () => number) => {
      rec.planned.push({ ...ctx });
      return real.lessonTurn(ctx, book, rng);
    },
  };
});

type PlannedCtx = TeachContext & Partial<TeachStrategyContext>;

function planned(): PlannedCtx[] {
  return rec.planned as PlannedCtx[];
}

function plannedFor(ply: number): PlannedCtx | undefined {
  return planned().findLast((ctx) => ctx.ply === ply);
}

// ───────────────────────── fixtures ─────────────────────────

const ITALIAN: GameStrategy = {
  strategyId: 'italian',
  titleRu: 'Итальянская партия',
  introRu: 'В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е четыре.',
  ideaRu: 'Быстро выводим фигуры и целимся в слабую точку эф семь.',
  provider: 'codex',
  model: 'gpt-5.6-sol',
  billing: 'subscription',
};

const CARO_KANN: GameStrategy = {
  strategyId: 'caro-kann',
  titleRu: 'Защита Каро-Канн',
  introRu: 'В этот раз разыграем защиту Каро-Канн — строим крепкий центр. Ответь пешкой на цэ шесть.',
  ideaRu: 'Строим крепкий центр, а слон выходит на свободу.',
  provider: 'openrouter',
};

/** The real library cards (@gambit/content): the child's line AND the whole main line of both sides. */
const ITALIAN_CARD = getStrategy('italian') as StrategyEntry;
const CARO_KANN_CARD = getStrategy('caro-kann') as StrategyEntry;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A strategist that records every call with the board as it was at that moment. */
class FakeStrategist implements GameStrategist {
  readonly strategyCalls: { request: StrategyRequest; at: number; movesOnBoard: number; signal: AbortSignal | undefined }[] = [];
  readonly replanCalls: { request: ReplanRequest; at: number; movesOnBoard: number; reply: Deferred<ReplanResponse | null> }[] = [];
  strategyAnswer: GameStrategy | null = ITALIAN;
  strategyDelayMs = 0;
  /** re-plans of these plies (or all, `true`) wait for `reply.resolve` */
  holdReplans: boolean | ((request: ReplanRequest) => boolean) = false;
  replanAnswer: (request: ReplanRequest) => ReplanResponse | null = (request) => ({
    ply: request.ply,
    planRu: 'Забираем пешку в центре и выводим фигуры.',
    preferredUci: request.candidates[0]?.uci ?? null,
    whyRu: 'Так мы выигрываем пешку и не отстаём в развитии.',
    provider: 'openrouter',
  });
  cards: Record<string, StrategyCard> = { italian: ITALIAN_CARD, 'caro-kann': CARO_KANN_CARD };
  board: () => number = () => 0;

  strategy(request: StrategyRequest, opts?: { signal?: AbortSignal }): Promise<GameStrategy | null> {
    this.strategyCalls.push({ request, at: Date.now(), movesOnBoard: this.board(), signal: opts?.signal });
    const answer = this.strategyAnswer;
    if (this.strategyDelayMs <= 0) return Promise.resolve(answer);
    return new Promise((resolve) => setTimeout(() => resolve(answer), this.strategyDelayMs));
  }

  replan(request: ReplanRequest): Promise<ReplanResponse | null> {
    const reply = deferred<ReplanResponse | null>();
    this.replanCalls.push({ request, at: Date.now(), movesOnBoard: this.board(), reply });
    const hold = typeof this.holdReplans === 'function' ? this.holdReplans(request) : this.holdReplans;
    if (!hold) reply.resolve(this.replanAnswer(request));
    return reply.promise;
  }

  card(strategyId: string): StrategyCard | undefined {
    return this.cards[strategyId];
  }
}

function fenAfter(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

type Spec = [string, number, ...string[]];

function script(h: TestHarness, sans: readonly string[], specs: readonly Spec[]): string {
  const fen = fenAfter(sans);
  const lines: ScriptedLine[] = specs.map(([san, cp, ...rest]) => {
    const chess = new Chess(fen);
    const pv = [san, ...rest].map((s) => {
      const move = chess.move(s);
      return `${move.from}${move.to}${move.promotion ?? ''}`;
    });
    return { cp, pv };
  });
  h.judge.scriptFen(fen, lines);
  return fen;
}

const E1: Spec[] = [['e4', 28], ['Nf3', 20], ['d4', 20]];
const E2: Spec[] = [['Nf3', 19], ['Nc3', 8], ['Bc4', 8]];
/** 1.e4 e5 2.Nf3 Nf6 (the bot leaves the Italian): the plan's Bc4 is not among the engine's moves */
const PETROV: Spec[] = [['Nxe5', 40], ['Nc3', 30], ['d4', 25]];

let current: GameController | null = null;

afterEach(() => {
  current?.dispose();
  current = null;
  rec.planned.length = 0;
});

function harness(o: { timings?: Partial<GameTimings>; stage?: number; runtimeAi?: boolean } = {}): { h: TestHarness; strategist: FakeStrategist } {
  const h = createTestHarness({ profile: { stage: o.stage ?? 1 }, timings: o.timings });
  const strategist = new FakeStrategist();
  h.deps.strategist = strategist;
  // the server's runtime AI (health.ai.runtime): off by default, as on the child's machine
  h.coach.runtimeAiOn = o.runtimeAi === true;
  return { h, strategist };
}

/** The theme of the game (§2.1): a gameStart line of the lesson — one lesson theme sentence, never a move, no brief. */
function themeEvents(h: TestHarness): CoachEvent[] {
  return h.coach.said.filter((e) => e.kind === 'gameStart' && e.teach?.moment === 'theme');
}

function expectTheme(ev: CoachEvent | undefined): void {
  expect(ev, 'the theme line').toBeDefined();
  expect(ev?.say?.[0]?.pool ?? '').toMatch(/^v3\.(theme|recall)\./);
  expect(ev?.brief).toBeUndefined();
  expect(ev?.teach?.advice).toEqual([]);
  expect(ev?.board?.arrows ?? []).toEqual([]);
  expect(ev?.text ?? '').not.toMatch(/[A-Za-z]|\d|минут|секунд|белыми|твой ход|Начни|Ответь/);
}

function make(h: TestHarness, strategist?: FakeStrategist): GameController {
  current = createGameController(h.deps);
  const game = current;
  if (strategist) strategist.board = () => game.store.getState().moves.length;
  return game;
}

function cfg(tc: TimeControlId, childColor: Color = 'w', extra: Partial<GameConfig> = {}): GameConfig {
  return { personaId: 'petya', timeControlId: tc, childColor, examMode: false, coachStyle: 'teacher', ...extra };
}

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

function teachTurns(h: TestHarness): CoachEvent[] {
  return h.coach.said.filter((e) => e.kind === 'teachTurn');
}

function recordSayTimes(h: TestHarness): Map<CoachEvent, number> {
  const times = new Map<CoachEvent, number>();
  const say = h.coach.say.bind(h.coach);
  h.coach.say = (event: CoachEvent) => {
    times.set(event, Date.now());
    return say(event);
  };
  return times;
}

function botShownAt(game: GameController): Map<number, number> {
  const at = new Map<number, number>();
  game.store.subscribe((state) => {
    const move = state.moves[state.moves.length - 1];
    if (move && move.by === 'bot' && !at.has(move.ply)) at.set(move.ply, Date.now());
  });
  return at;
}

/** The journal so far: the saved record's events once the game is delivered, else the resume snapshot's. */
function events(h: TestHarness, game: GameController, kind: string): Record<string, unknown>[] {
  game.persistNow();
  const all = h.saved[0]?.events ?? readResumableGame(h.storage)?.events ?? [];
  return all.filter((e) => e.type === 'coachSaid' && e.data.kind === kind).map((e) => e.data);
}

// ───────────────────────── the strategy of the game ─────────────────────────

describe('White: the strategy is asked for at once and its THEME is the FIRST teacher line', () => {
  it('one request; the ONE start line is the theme (the idea of its family, never a move); the first advice follows with its arrow', async () => {
    const { h, strategist } = harness();
    script(h, [], E1);
    strategist.strategyDelayMs = 150;
    const said = recordSayTimes(h);
    const game = make(h, strategist);
    const startedAt = Date.now();
    await game.start(cfg('training'));
    await game.whenSettled();

    expect(strategist.strategyCalls.map((c) => c.request)).toEqual([{ childColor: 'w', stage: 1, personaId: 'petya', timeControlId: 'training' }]);
    // the theme first (stage 1, White before move 1: the family's idea, §2.1), then the first advice
    expect(h.coach.kinds()).toEqual(['gameStart', 'teachTurn']);
    const theme = h.coach.said[0] as CoachEvent;
    expectTheme(theme);
    expect(theme.say?.[0]?.pool).toBe('v3.theme.family.f7');
    expect(theme.pose).toBe('wave');
    // it waited for the strategy
    expect((said.get(theme) ?? 0) - startedAt).toBeGreaterThanOrEqual(140);
    // the first advice was planned WITH the strategy (no re-plan without runtime AI) and knows the theme was said
    expect(plannedFor(1)).toMatchObject({ strategy: ITALIAN, strategyCard: ITALIAN_CARD, replan: null, introSaid: true, tc: 'training' });
    expect(game.store.getState().advice?.[0]).toMatchObject({ san: 'e4', arrow: 'green' });
    expect(game.store.getState().annotations?.arrows).toContainEqual({ from: 'e2', to: 'e4', color: 'green' });
    // the game knows its strategy (screen: the «Тема: …» badge — stage 1 the family, never the opening's name —, e2e, snapshot)
    const state = game.store.getState();
    expect(state.strategy).toEqual(ITALIAN);
    expect(state.config?.strategy).toEqual(ITALIAN);
    expect(state.themeBadge).toBe(themeBadgeRu(ITALIAN, 1));
    expect(state.themeBadge).not.toBe(ITALIAN.titleRu);
    // journal (written with the first move): which strategy, which model, how long it took; the theme with its moment
    await turn(game, 'e4');
    const [journaled] = events(h, game, 'strategy');
    // (the model and the bill reach the journal's «ИИ в этой партии»: «через подписку»)
    expect(journaled).toMatchObject({ strategyId: 'italian', titleRu: 'Итальянская партия', provider: 'codex', model: 'gpt-5.6-sol', billing: 'subscription', late: false });
    expect(journaled?.latencyMs).toBeGreaterThanOrEqual(140);
    expect(events(h, game, 'gameStart')[0]).toMatchObject({ teach: { moment: 'theme' } });
    expect(h.coach.context.some((n) => /Стратегия этой партии/.test(n))).toBe(false);
  });

  it('stages 3–5: the badge is the card\'s title once the lesson named it (the opponent\'s reply matched), the family again when the game leaves the line', async () => {
    const { h, strategist } = harness({ stage: 3 });
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    script(h, ['e4', 'e5', 'Nf3', 'Nc6'], [['Bc4', 30], ['Bb5', 30], ['d4', 25]]);
    h.bot.replies = ['e7e5', 'b8c6', 'g8f6'];
    const game = make(h, strategist);
    await game.start(cfg('training'));
    await game.whenSettled();
    expectTheme(themeEvents(h)[0]);
    // before move 1 the Italian is not the game yet (1…c5 is no Italian, §2.1): the family, as the theme said it
    const family = THEME_FAMILY_BADGE_RU.f7;
    expect(themeEvents(h)[0]?.say?.[0]?.pool).toBe('v3.theme.family.f7');
    expect(game.store.getState().themeBadge).toBe(family);
    // 1…e5 matches the card: the lesson names it — and so does the badge
    await turn(game, 'e4');
    expect(teachTurns(h).some((e) => e.say?.some((x) => x.pool === 'v3.theme.named.italian'))).toBe(true);
    expect(game.store.getState().themeBadge).toBe('Итальянская партия');
    await turn(game, 'Nf3');
    expect(game.store.getState().themeBadge).toBe('Итальянская партия');
    // 3…Кf6 instead of 3…Сc5: the game left the card's line — the name goes, the family stays
    await turn(game, 'Bc4');
    expect(game.store.getState().moves.at(-1)?.san).toBe('Nf6');
    expect(game.store.getState().themeBadge).toBe(family);
  });

  it('stages 3–5: 1.e4 c5 is no Italian — the badge keeps the family, never the card\'s name', async () => {
    const { h, strategist } = harness({ stage: 3 });
    script(h, [], E1);
    script(h, ['e4', 'c5'], [['Nf3', 30], ['Nc3', 20], ['d4', 15]]);
    h.bot.replies = ['c7c5', 'b8c6'];
    const game = make(h, strategist);
    const badges = new Set<string | null>();
    game.store.subscribe((state) => badges.add(state.themeBadge));
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    expect(game.store.getState().themeBadge).toBe(THEME_FAMILY_BADGE_RU.f7);
    expect(badges.has('Итальянская партия')).toBe(false);
  });

  it('a child who moves during the theme cuts it, and hears the next advice', async () => {
    const { h, strategist } = harness();
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    h.bot.replies = ['e7e5'];
    h.coach.holdSpeech = true;
    const game = make(h, strategist);
    await game.start(cfg('training'));
    await waitFor(() => themeEvents(h).length === 1, 2_000, 'the theme');
    // the child does not wait for the end of the sentence
    const stops = h.coach.stopCalls;
    expect(childPlays(game, 'e4')).toBe(true);
    expect(h.coach.stopCalls).toBeGreaterThan(stops);
    h.coach.holdSpeech = false;
    h.coach.releaseSpeech();
    await game.whenSettled();
    expect(plannedFor(1)).toBeUndefined();
    const next = teachTurns(h).find((e) => e.teach?.ply === 3);
    expect(next, 'the advice after 1…e5 is said').toBeDefined();
    expect(h.coach.kinds().filter((k) => k === 'gameStart')).toHaveLength(1);
  });

  it('the wizard\'s prefetch is the game\'s strategy: no second request (GameDeps.strategist of the browser)', async () => {
    const h = createTestHarness();
    script(h, [], E1);
    const wizard = vi.fn(() => Promise.resolve<GameStrategy | null>(ITALIAN));
    const own = vi.fn(() => Promise.resolve<GameStrategy | null>(CARO_KANN));
    const registry = createStrategyPrefetcher(wizard);
    // the colour tap: «Учитель», White, Петя, no clock
    registry.prefetch({ childColor: 'w', stage: 1, personaId: 'petya', timeControlId: 'training' });
    h.deps.strategist = { ...createBrowserStrategist(registry, own), card: () => ITALIAN_CARD };
    const game = make(h);
    await game.start(cfg('training'));
    await game.whenSettled();
    expect(wizard).toHaveBeenCalledTimes(1);
    expect(own).not.toHaveBeenCalled();
    expect(game.store.getState().strategy?.strategyId).toBe('italian');
    expect(plannedFor(1)?.strategy?.strategyId).toBe('italian');
  });

  it('the first line never waits longer than strategyWaitMs; a late strategy counts from the next move', async () => {
    const { h, strategist } = harness({ timings: { strategyWaitMs: 150 } });
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    h.bot.replies = ['e7e5'];
    strategist.strategyDelayMs = 500;
    const said = recordSayTimes(h);
    const game = make(h, strategist);
    const startedAt = Date.now();
    await game.start(cfg('training'));
    await waitFor(() => teachTurns(h).length === 1, 2_000, 'the first line');
    expect((said.get(teachTurns(h)[0] as CoachEvent) ?? 0) - startedAt).toBeLessThan(450);
    // no strategy in time: no theme — the first advice itself is the first line
    expect(h.coach.kinds()).toEqual(['teachTurn']);
    expect(plannedFor(1)?.strategy).toBeNull();
    await game.whenSettled();
    expect(game.store.getState().strategy).toEqual(ITALIAN);

    await turn(game, 'e4');
    expect(plannedFor(3)?.strategy).toEqual(ITALIAN);
    expect(events(h, game, 'strategy')[0]).toMatchObject({ strategyId: 'italian', late: true });
  });

  it('no strategist answer (server down, bad data): the teacher goes on without one', async () => {
    const { h, strategist } = harness();
    script(h, [], E1);
    strategist.strategyAnswer = { ...ITALIAN, titleRu: 'Italian Game' };
    const game = make(h, strategist);
    await game.start(cfg('training'));
    await game.whenSettled();
    expect(h.coach.kinds()).toEqual(['teachTurn']);
    expect(game.store.getState().strategy).toBeNull();
    await turn(game, 'e4');
    expect(events(h, game, 'strategy')[0]).toMatchObject({ failed: true });
    expect(strategist.replanCalls).toEqual([]);
  });

  it('5 minutes: the strategy of the game and its ONE intro line, as in 10 minutes; Black asks on the real first move', async () => {
    const white = harness();
    script(white.h, [], E1);
    const game = make(white.h, white.strategist);
    await game.start(cfg('blitz5'));
    await game.whenSettled();
    expect(white.strategist.strategyCalls.map((c) => c.request)).toEqual([{ childColor: 'w', stage: 1, personaId: 'petya', timeControlId: 'blitz5' }]);
    expect(white.h.coach.kinds()).toEqual(['gameStart', 'teachTurn']);
    expectTheme(white.h.coach.said[0]);
    expect(white.h.coach.said[0]?.pose).toBe('wave');
    game.dispose();
    current = null;

    const black = harness({ stage: 3 });
    black.strategist.strategyAnswer = CARO_KANN;
    black.h.bot.replies = ['e2e4'];
    black.h.bot.thinkMs = 300;
    script(black.h, ['e4'], [['c6', -30], ['e5', -25], ['c5', -30]]);
    const blackGame = make(black.h, black.strategist);
    await blackGame.start(cfg('blitz5', 'b'));
    await blackGame.whenSettled();
    expect(black.strategist.strategyCalls[0]?.request).toEqual({ childColor: 'b', stage: 3, personaId: 'petya', timeControlId: 'blitz5', opponentFirstUci: 'e2e4' });
    expect(black.strategist.strategyCalls[0]?.movesOnBoard).toBe(0);
    // stage 3, the card holds after 1.e4: its name and idea (§2.1)
    expectTheme(black.h.coach.said[0]);
    expect(black.h.coach.said[0]?.say?.[0]?.pool).toBe('v3.theme.caro-kann');
    expect(blackGame.store.getState().themeBadge).toBe('Защита Каро-Канн');
  });

  it('the app\'s hello was not heard: «Привет!» waves first, then the theme TALKS («помахал и начал говорить»)', async () => {
    const { h, strategist } = harness();
    h.deps.helloHeard = () => false;
    script(h, [], E1);
    const game = make(h, strategist);
    await game.start(cfg('blitz5'));
    await game.whenSettled();
    expect(h.coach.said.slice(0, 2).map((e) => [e.kind, e.pose])).toEqual([
      ['greeting', 'wave'],
      ['gameStart', 'talk'],
    ]);
    expectTheme(h.coach.said[1]);
  });

  it('«Подсказчик», «Экзамен» and bullet never ask the strategist', async () => {
    for (const config of [cfg('training', 'w', { coachStyle: 'helper' }), cfg('rapid10', 'w', { coachStyle: 'exam', examMode: true }), cfg('bullet1', 'b', { coachStyle: 'helper' })]) {
      const { h, strategist } = harness();
      h.bot.replies = ['e2e4'];
      const game = make(h, strategist);
      await game.start(config);
      await game.whenSettled();
      expect(strategist.strategyCalls, config.coachStyle).toEqual([]);
      expect(game.store.getState().strategy).toBeNull();
      game.dispose();
      current = null;
    }
  });
});

describe('Black: the strategy answers the bot\'s REAL first move — asked the moment it is decided', () => {
  it('the request goes out during the bot\'s human pause, with that move; the first line waits for it', async () => {
    const { h, strategist } = harness({ stage: 3 });
    strategist.strategyAnswer = CARO_KANN;
    strategist.strategyDelayMs = 100;
    h.bot.replies = ['e2e4'];
    h.bot.thinkMs = 400;
    script(h, ['e4'], [['c6', -30], ['e5', -25], ['c5', -30]]);
    const game = make(h, strategist);
    const shown = botShownAt(game);
    await game.start(cfg('training', 'b'));
    await game.whenSettled();

    expect(strategist.strategyCalls).toHaveLength(1);
    const call = strategist.strategyCalls[0];
    expect(call?.request).toEqual({ childColor: 'b', stage: 3, personaId: 'petya', timeControlId: 'training', opponentFirstUci: 'e2e4' });
    // decided, not yet shown: never a guess of the bot's move, and ~thinkMs of head start
    expect(call?.movesOnBoard).toBe(0);
    expect((shown.get(1) ?? 0) - (call?.at ?? 0)).toBeGreaterThanOrEqual(300);
    expect(plannedFor(2)).toMatchObject({ strategy: CARO_KANN, introSaid: true });
    // the theme (the Caro-Kann by name at stage 3 — the card answers the bot's real 1.e4), then the first advice c6
    expect(h.coach.kinds()).toEqual(['gameStart', 'teachTurn']);
    expectTheme(h.coach.said[0]);
    expect(h.coach.said[0]?.teach).toMatchObject({ moment: 'theme', ply: 2 });
    expect(h.coach.said[0]?.say?.[0]?.pool).toBe('v3.theme.caro-kann');
    expect(game.store.getState().advice?.[0]).toMatchObject({ san: 'c6', arrow: 'green' });
  });

  it('a system against any first move (1.b3): the theme names no move, the engine-checked first advice shows it', async () => {
    // e.g. «Ответь пешкой на дэ пять», then at once «по нашему плану — пешка на е пять» (1…d5 is not in
    // the engine's tolerance after 1.b3) — the intro must never promise a move the first advice then contradicts
    const { h, strategist } = harness();
    const system: GameStrategy = {
      strategyId: 'classic-development',
      titleRu: 'Классическое развитие',
      introRu: 'В этот раз разыграем классическое развитие — пешка в центр, фигуры в игру. Ответь пешкой на дэ пять.',
      ideaRu: 'пешка в центр, фигуры в игру, король в домик',
      provider: 'openrouter',
    };
    strategist.strategyAnswer = system;
    strategist.cards['classic-development'] = getStrategy('classic-development') as StrategyEntry;
    h.bot.replies = ['b2b3'];
    script(h, ['b3'], [['e5', -20], ['Nf6', -45], ['d5', -80]]);
    const game = make(h, strategist);
    await game.start(cfg('training', 'b'));
    await game.whenSettled();
    expect(strategist.strategyCalls[0]?.request.opponentFirstUci).toBe('b2b3');
    // the theme never names a move (docs/TEACHING.md §2.1): the idea of the system's family
    expectTheme(themeEvents(h)[0]);
    expect(themeEvents(h)[0]?.text).not.toMatch(/дэ пять|Ответь/);
    // the first advice follows and is said: the engine's move, whatever the example line of the system says
    const first = teachTurns(h).find((e) => e.teach?.ply === 2);
    expect(first, 'the first advice is said after the theme').toBeDefined();
    expect(game.store.getState().advice?.[0]).toMatchObject({ san: 'e5', arrow: 'green' });
  });
});

// ───────────────────────── re-plans ─────────────────────────

describe('re-plans (runtime AI only): fired on the REAL bot move when it is decided; stored by ply; never waited for', () => {
  function italianGame(o: { timings?: Partial<GameTimings>; runtimeAi?: boolean } = {}) {
    const { h, strategist } = harness({ runtimeAi: true, ...o });
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    const petrov = script(h, ['e4', 'e5', 'Nf3', 'Nf6'], PETROV);
    h.bot.replies = ['e7e5', 'g8f6'];
    h.bot.thinkMs = 300;
    return { h, strategist, petrov };
  }

  it('on the plan: no re-plan; the bot leaves it → one request with the engine\'s candidates, before the move is shown', async () => {
    const { h, strategist, petrov } = italianGame();
    const game = make(h, strategist);
    const shown = botShownAt(game);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    // 1…e5: the plan's Nf3 is the engine's first move — the plan holds, the model is not asked
    expect(strategist.replanCalls).toEqual([]);
    await turn(game, 'Nf3');

    expect(strategist.replanCalls).toHaveLength(1);
    const call = strategist.replanCalls[0];
    const request = call?.request as ReplanRequest;
    expect(request).toMatchObject({ ply: 5, fen: petrov, childColor: 'w', strategyId: 'italian', movesSan: ['e4', 'e5', 'Nf3', 'Nf6'], stage: 1 });
    // the engine's lines within the teacher's tolerance, each with the code's ideas in Russian
    expect(request.candidates.map((c) => [c.san, c.cp])).toEqual([
      ['Nxe5', 40],
      ['Nc3', 30],
      ['d4', 25],
    ]);
    for (const c of request.candidates) for (const idea of c.ideasRu) expect(idea).not.toMatch(/[A-Za-z]/);
    // asked while the bot was still «thinking» over its REAL move
    expect(call?.movesOnBoard).toBe(3);
    expect((shown.get(4) ?? 0) - (call?.at ?? 0)).toBeGreaterThan(100);

    // a voice question («что делать?») gets the plan of the game with the facts
    const facts = (await game.toolHost.analyzePosition?.()) ?? '';
    expect(facts).toContain('Стратегия этой партии — «Итальянская партия»');
    expect(facts).toContain('План сейчас: Забираем пешку в центре и выводим фигуры.');
    expect(facts).not.toMatch(/[A-Za-z]/);
    // the answer (in before the teacher planned the move) reaches the teacher for exactly that ply
    const ctx = plannedFor(5);
    expect(ctx?.replan).toMatchObject({ ply: 5, preferredUci: 'f3e5', provider: 'openrouter' });
    expect(game.store.getState().replan?.ply).toBe(5);
    const [replan] = events(h, game, 'replan');
    expect(replan).toMatchObject({ ply: 5, trigger: 'leftLine', provider: 'openrouter', preferredUci: 'f3e5', planRu: 'Забираем пешку в центре и выводим фигуры.' });
    expect(typeof replan?.latencyMs).toBe('number');
    // (no silent note: the plan reaches the voice through the next brief and the position answer above)
    expect(h.coach.context.some((n) => /Новый план партии/.test(n))).toBe(false);
  });

  it('without runtime AI (the child\'s machine: health.ai.runtime false) the strategist is never asked for a re-plan', async () => {
    const { h, strategist } = italianGame({ runtimeAi: false });
    const game = make(h, strategist);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    // 2…Кf6 leaves the Italian: with runtime AI this is a re-plan — without it, nothing is asked
    await turn(game, 'Nf3');
    expect(strategist.replanCalls).toEqual([]);
    expect(plannedFor(5)?.replan).toBeNull();
    expect(game.store.getState().replan).toBeNull();
    expect(events(h, game, 'replan')).toEqual([]);
    // the template strategy still plans the game
    expect(plannedFor(5)?.strategy).toEqual(ITALIAN);
  });

  it('the teacher line never waits for the model: a re-plan that does not answer leaves the 1.5 s deadline alone', async () => {
    const { h, strategist } = italianGame();
    strategist.holdReplans = true;
    const said = recordSayTimes(h);
    const game = make(h, strategist);
    const shown = botShownAt(game);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    expect(childPlays(game, 'Nf3')).toBe(true);
    await waitFor(() => teachTurns(h).some((e) => e.teach?.ply === 5), 3_000, 'the advice after 2…Nf6');
    const ev = teachTurns(h).find((e) => e.teach?.ply === 5) as CoachEvent;
    expect((said.get(ev) ?? Number.NaN) - (shown.get(4) ?? Number.NaN)).toBeLessThanOrEqual(1_500);
    expect(plannedFor(5)?.replan).toBeNull();
    expect(strategist.replanCalls).toHaveLength(1);

    // it answers later: stored, and the NEXT teacher context has it (as history — its ply is 5)
    strategist.replanCalls[0]?.reply.resolve({ ply: 5, planRu: 'Выводим фигуры и прячем короля.', preferredUci: 'b1c3', whyRu: 'Конь смотрит в центр.', provider: 'codex' });
    await waitFor(() => game.store.getState().replan !== null, 1_000, 'the late re-plan');
    h.bot.replies = ['d7d6'];
    await turn(game, 'Nc3');
    expect(plannedFor(7)?.replan).toMatchObject({ ply: 5, planRu: 'Выводим фигуры и прячем короля.' });
  });

  it('checked like any answer: a move that is not a candidate is dropped (the plan stays); another ply = invalid', async () => {
    const { h, strategist } = italianGame();
    strategist.replanAnswer = (request) => ({ ply: request.ply, planRu: 'Нападаем ферзём.', preferredUci: 'd1h5', whyRu: 'Ферзь рядом.', provider: 'codex' });
    const game = make(h, strategist);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    expect(plannedFor(5)?.replan).toEqual({ ply: 5, planRu: 'Нападаем ферзём.', preferredUci: null, whyRu: '', provider: 'codex' });

    const other = italianGame();
    other.strategist.replanAnswer = (request) => ({ ply: request.ply + 2, planRu: 'План.', preferredUci: null, whyRu: '', provider: 'codex' });
    const second = make(other.h, other.strategist);
    await second.start(cfg('training'));
    await second.whenSettled();
    await turn(second, 'e4');
    await turn(second, 'Nf3');
    expect(plannedFor(5)?.replan).toBeNull();
    expect(events(other.h, second, 'replan')[0]).toMatchObject({ ply: 5, dropped: 'invalid' });
  });

  it('a stale answer (a newer re-plan was asked meanwhile) is dropped; the newer one is used', { timeout: 20_000 }, async () => {
    // the Italian of T12 into the middlegame: 10…Re8 is the first middlegame position (a new phase), then every 2 plies
    const WHITE = ['e4', 'Nf3', 'Bc4', 'c3', 'd3', 'O-O', 'Re1', 'Nbd2', 'Nf1', 'Ng3', 'h3'];
    const BLACK = ['e5', 'Nc6', 'Bc5', 'Nf6', 'd6', 'O-O', 'a6', 'Ba7', 'h6', 'Re8', 'Be6'];
    const { h, strategist } = harness({ timings: { replanEveryPlies: 2 }, runtimeAi: true });
    h.bot.replies = [...BLACK];
    strategist.holdReplans = (request) => request.ply >= 21;
    const game = make(h, strategist);
    await game.start(cfg('training'));
    await game.whenSettled();
    for (const san of WHITE.slice(0, 9)) await turn(game, san);
    // from here on a held re-plan keeps the game «busy»: step by the board, not by whenSettled
    const step = async (san: string, ply: number): Promise<void> => {
      expect(childPlays(game, san), san).toBe(true);
      await waitFor(() => game.store.getState().phase === 'childTurn' && game.store.getState().moves.length === ply, 3_000, `the bot's reply to ${san}`);
    };
    await step(WHITE[9] as string, 20);
    await waitFor(() => strategist.replanCalls.some((c) => c.request.ply === 21), 2_000, 'the new phase asks the model');
    const phase = strategist.replanCalls.find((c) => c.request.ply === 21);
    await step(WHITE[10] as string, 22);
    await waitFor(() => strategist.replanCalls.some((c) => c.request.ply === 23), 2_000, 'two plies later (replanEveryPlies 2) it asks again');
    const cadence = strategist.replanCalls.find((c) => c.request.ply === 23);

    // the older answer comes last → dropped; the newer one is the plan
    cadence?.reply.resolve({ ply: 23, planRu: 'Готовим пешкой дэ четыре.', preferredUci: null, whyRu: '', provider: 'codex' });
    phase?.reply.resolve({ ply: 21, planRu: 'Старый план.', preferredUci: null, whyRu: '', provider: 'codex' });
    await game.whenSettled();
    const replans = events(h, game, 'replan');
    expect(replans.find((r) => r.ply === 21)).toMatchObject({ dropped: 'stale', trigger: 'phase' });
    expect(replans.find((r) => r.ply === 23)).toMatchObject({ trigger: 'cadence', planRu: 'Готовим пешкой дэ четыре.' });
    expect(game.store.getState().replan).toMatchObject({ ply: 23 });
  });

  it('an answer for a position that is no longer on the board (the child took the move back) is dropped', async () => {
    const { h, strategist } = italianGame();
    strategist.holdReplans = true;
    const game = make(h, strategist);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    expect(childPlays(game, 'Nf3')).toBe(true);
    await waitFor(() => game.store.getState().phase === 'childTurn' && game.store.getState().moves.length === 4, 3_000, '2…Nf6 on the board');
    expect(strategist.replanCalls).toHaveLength(1);
    // «Вернуть ход»: 2.Кf3 and 2…Кf6 are gone — the re-plan was for the position after 2…Кf6
    expect(game.undoLastMove()).toBe(true);
    strategist.replanCalls[0]?.reply.resolve({ ply: 5, planRu: 'Забираем пешку.', preferredUci: 'f3e5', whyRu: 'Пешка без защиты.', provider: 'codex' });
    await game.whenSettled();
    expect(game.store.getState().replan).toBeNull();
    expect(events(h, game, 'replan')[0]).toMatchObject({ ply: 5, dropped: 'stale', provider: 'codex' });
    // the teacher of the position the child is back at gets no re-plan of a position that is gone
    await turn(game, 'Nc3');
    expect(plannedFor(5)?.replan ?? null).toBeNull();
  });

  it('game over / dispose: requests in flight are aborted, nothing arrives afterwards', async () => {
    const { h, strategist } = italianGame();
    strategist.holdReplans = true;
    const game = make(h, strategist);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    expect(childPlays(game, 'Nf3')).toBe(true);
    await waitFor(() => strategist.replanCalls.length === 1, 2_000, 'the re-plan');
    game.resign();
    strategist.replanCalls[0]?.reply.resolve({ ply: 5, planRu: 'Поздно.', preferredUci: null, whyRu: '', provider: 'codex' });
    await game.whenSettled();
    expect(game.store.getState().replan).toBeNull();
    expect(events(h, game, 'replan')).toEqual([]);
  });
});

// ───────────────────────── resume ─────────────────────────

describe('resume: the strategy and the plan survive a reload (no second request, no second theme)', () => {
  it('config.strategy and the plan state are in the snapshot; the continued game plans with them', async () => {
    const { h, strategist } = harness({ runtimeAi: true });
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    script(h, ['e4', 'e5', 'Nf3', 'Nf6'], PETROV);
    h.bot.replies = ['e7e5', 'g8f6'];
    const game = make(h, strategist);
    await game.start(cfg('training'));
    await game.whenSettled();
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.persistNow();
    const snapshot = readResumableGame(h.storage);
    expect(snapshot?.config.strategy).toEqual(ITALIAN);
    expect(snapshot?.teach?.strategy).toMatchObject({ lineStatus: 'off', lastReplanPly: 5, replan: { answer: { ply: 5 } } });
    game.dispose();
    current = null;
    rec.planned.length = 0;

    const again = harness({ runtimeAi: true });
    again.h.storage.map.set('gambit.resumeGame', h.storage.getItem('gambit.resumeGame') ?? '');
    script(again.h, ['e4', 'e5', 'Nf3', 'Nf6'], PETROV);
    const resumed = make(again.h, again.strategist);
    await resumed.start(cfg('training'), { resume: snapshot });
    await resumed.whenSettled();
    expect(again.strategist.strategyCalls).toEqual([]);
    expect(resumed.store.getState().strategy).toEqual(ITALIAN);
    expect(resumed.store.getState().themeBadge).toBe(themeBadgeRu(ITALIAN, 1));
    expect(plannedFor(5)).toMatchObject({ strategy: ITALIAN, replan: { ply: 5 } });
    // no second theme after the reload
    expect(themeEvents(again.h)).toEqual([]);
  });
});

// ───────────────────────── the clock ─────────────────────────

describe('the clock is never read out («у тебя осталось четыре минуты пятьдесят девять секунд…»)', () => {
  it('analyzePosition has no clock; below 30 s only «мало времени»; the teacher says its one «Поторопись!» in the lesson\'s words', async () => {
    const { h, strategist } = harness();
    let skew = 0;
    h.deps.now = () => Date.now() + skew;
    script(h, [], E1);
    script(h, ['e4', 'e5'], E2);
    h.bot.replies = ['e7e5', 'b8c6', 'f8c5'];
    const game = make(h, strategist);
    await game.start(cfg('rapid10'));
    await game.whenSettled();
    expect(plannedFor(1)?.remainingMs).toBeGreaterThan(590_000);

    const plenty = (await game.toolHost.analyzePosition?.()) ?? '';
    expect(plenty).not.toMatch(/[Чч]асы|минут|секунд|времени/);

    await turn(game, 'e4');
    // the child thinks for a long time: 25 s left on his clock
    skew += (game.store.getState().clock.w ?? 0) - 25_000;
    const low = (await game.toolHost.analyzePosition?.()) ?? '';
    expect(low).toMatch(/мало времени/);
    expect(low).not.toMatch(/минут|секунд/);

    await turn(game, 'Nf3');
    await turn(game, 'Bc4');
    // «Поторопись!» once a game (the lesson model: `lessonHurry`, a `v3.hurry` wording — never the helper's template, no brief)
    expect(plannedFor(5)?.remainingMs).toBeLessThan(30_000);
    const hurries = h.coach.said.filter((e) => e.say?.[0]?.pool === 'v3.hurry');
    expect(hurries).toHaveLength(1);
    expect(hurries[0]).toMatchObject({ kind: 'encourage', pauseClock: false });
    expect(hurries[0]?.brief).toBeUndefined();
    expect(h.coach.said.filter((e) => e.text === HURRY_TEXT_RU && e.say === undefined)).toHaveLength(0);
    for (const event of h.coach.said) expect(event.text, event.kind).not.toMatch(/минут|секунд/);
  });

  it('«Подсказчик»: nothing about the clock, and «Поторопись!» once when the child is nearly out of time', async () => {
    const h = createTestHarness();
    let skew = 0;
    h.deps.now = () => Date.now() + skew;
    h.bot.replies = ['e7e5', 'b8c6', 'f8c5'];
    const game = make(h);
    await game.start(cfg('rapid10', 'w', { coachStyle: 'helper' }));
    await game.whenSettled();
    await turn(game, 'e4');
    skew += (game.store.getState().clock.w ?? 0) - 25_000;
    await turn(game, 'Nf3');
    await turn(game, 'Bc4');
    const hurries = h.coach.said.filter((e) => e.text === HURRY_TEXT_RU);
    expect(hurries).toHaveLength(1);
    expect(hurries[0]).toMatchObject({ kind: 'encourage', priority: 1, pauseClock: false });
    // «Записи» says it from the catalogue's `shell.hurry` (and records it on first use, «Дозапись голоса»)
    expect(hurries[0]?.clip?.sentences.map((s) => s.items)).toEqual([[{ line: 'shell.hurry' }]]);
    // its brief asks for that one word and forbids numbers; nothing the coach said names minutes or seconds
    expect(hurries[0]?.brief).toMatch(/Поторопись/);
    for (const event of h.coach.said) expect(`${event.text} ${event.brief ?? ''}`, event.kind).not.toMatch(/минут|секунд/);
    expect(hurries[0]?.brief ?? '').not.toMatch(CLOCK_WORDS_RE);
  });
});
