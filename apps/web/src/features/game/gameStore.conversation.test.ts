/**
 * The conversational coach («как голосовой ChatGPT»): the game gives the voice model
 * engine-grounded FACTS (analyzePosition, evaluateMove), briefs for meaningful moments (threat after the bot's move,
 * a real tactic found, a long silence) and tells the coach when a game starts / ends. Chess truth stays in code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { sanToSpokenRu } from '@gambit/core';
import type { Color, ConversationState, GameRecord, PersonaId, TimeControlId } from '@gambit/shared';
import { createGameController } from './gameStore.ts';
import type { GameController } from './gameStore.ts';
import type { GameConfig } from './gameTypes.ts';
import { createTestHarness } from './testing/fakes.ts';
import type { TestHarness } from './testing/fakes.ts';

const LATIN = /[A-Za-z]/;

function config(timeControlId: TimeControlId, extra: Partial<GameConfig> = {}): GameConfig {
  return { personaId: 'petya' as PersonaId, timeControlId, childColor: 'w' as Color, examMode: false, ...extra };
}

function childPlays(game: GameController, san: string): boolean {
  const chess = new Chess(game.store.getState().fen);
  const move = chess.move(san);
  return game.dropPiece(move.from, move.to);
}

async function turn(game: GameController, san: string): Promise<void> {
  expect(childPlays(game, san)).toBe(true);
  await game.whenSettled();
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function fenAfter(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

let current: GameController | null = null;

function make(h: TestHarness): GameController {
  current = createGameController(h.deps);
  return current;
}

afterEach(() => {
  current?.dispose();
  current = null;
  vi.useRealTimers();
});

describe('tool host: evaluateMove — «а если я пойду…?»', () => {
  it('judges a hypothetical move on a scratch board: facts in words, the game does not change', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    // after 3.Qg5?? the queen is simply taken
    h.judge.scriptAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Qg5'], [{ cp: 900, pv: ['d8g5'] }]);
    await game.start(config('rapid10'));
    await turn(game, 'e4');
    await turn(game, 'Qh5');

    const before = game.store.getState();
    const eventsBefore = JSON.stringify(before.moves);
    const saidBefore = h.coach.said.length;
    const fen = before.fen;
    const bestSan = new Chess(fen).moves()[0] as string; // the fake engine's «best» in an unscripted position

    const answer = await game.toolHost.evaluateMove?.('Qg5');
    expect(answer).toMatch(/^Ученик спрашивает про ход: ферзь на же пять/);
    expect(answer).toMatch(/Опасно: после него у соперника сильный ответ — ферзь бьёт на же пять/);
    expect(answer).toContain('ферзя');
    expect(answer).not.toMatch(LATIN);
    expect(answer).not.toContain(sanToSpokenRu(bestSan, fen));

    // nothing of the game moved: board, moves, hint ladder, marks, what the coach said
    const after = game.store.getState();
    expect(after.fen).toBe(fen);
    expect(JSON.stringify(after.moves)).toBe(eventsBefore);
    expect(after.phase).toBe('childTurn');
    expect(after.hintLevel).toBe(0);
    expect(after.annotations).toBe(before.annotations);
    expect(h.coach.said.length).toBe(saidBefore);

    // Russian notation and plain words work too; a safe move is only called safe
    expect(await game.toolHost.evaluateMove?.('Кf3')).toMatch(/конь на эф три.*Ход безопасный и хороший/s);
    expect(await game.toolHost.evaluateMove?.('конь на эф три')).toMatch(/Ход безопасный и хороший/);
    // the ladder was never touched, and the move can still be played normally
    await turn(game, 'Nf3');
    expect(game.store.getState().moves.slice(0, 5).map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Nf3']);
    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    expect(record.events.filter((e) => e.type === 'hintRequested')).toHaveLength(0);
  });

  it('explains why an impossible or unclear move cannot be checked', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('training'));
    expect(await game.toolHost.evaluateMove?.('Nf4')).toMatch(/сейчас сделать нельзя: конь так не ходит/);
    expect(await game.toolHost.evaluateMove?.('Ke2')).toMatch(/на е два уже стоит своя фигура/);
    expect(await game.toolHost.evaluateMove?.('как дела')).toMatch(/Не понял, какой ход/);
    expect(await game.toolHost.evaluateMove?.(undefined as unknown as string)).toMatch(/Не понял, какой ход/);
  });

  it('refuses in an exam and in bullet, waits for the child\'s turn, knows a taken-back move', async () => {
    const exam = createTestHarness();
    const examGame = make(exam);
    await examGame.start(config('rapid10', { examMode: true }));
    expect(await examGame.toolHost.evaluateMove?.('e4')).toMatch(/экзамен/);
    examGame.dispose();

    const bullet = createTestHarness();
    const bulletGame = make(bullet);
    await bulletGame.start(config('bullet1'));
    expect(await bulletGame.toolHost.evaluateMove?.('e4')).toMatch(/быстрой партии/);
    bulletGame.dispose();

    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6', 'd8g5'];
    h.judge.scriptAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Qg5'], [{ cp: 900, pv: ['d8g5'] }]);
    await game.start(config('rapid10'));
    await turn(game, 'e4');
    await turn(game, 'Qh5');
    await turn(game, 'Qg5');
    expect(game.store.getState().phase).toBe('coachIntervention');
    expect(await game.toolHost.evaluateMove?.('Nf3')).toMatch(/вернуть ход или оставить/);
    game.acceptTakeback();
    await game.whenSettled();
    expect(await game.toolHost.evaluateMove?.('Qg5')).toContain('Это тот самый ход, который недавно вернули.');
  });
});

describe('tool host: analyzePosition — engine-grounded facts, never the best move', () => {
  it('whose move, material and the last moves — no clocks (the child sees them), Latin-free, without the engine\'s best move', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5'];
    h.judge.scriptAfter(['e4', 'e5'], [{ cp: 40, pv: ['g1f3', 'b8c6'] }, { cp: 20, pv: ['f1c4'] }]);
    await game.start(config('rapid10'));
    await turn(game, 'e4');

    const text = (await game.toolHost.analyzePosition?.()) ?? '';
    // the colour, the move number, whose move: only a reference for a direct question, never a fact to retell
    expect(text).toMatch(/^Сейчас дебют\. /);
    expect(text).toMatch(/Только если ученик сам спросит об этом: ученик играет белыми, идёт 2-й ход, сейчас ход ученика\. Сам этого не говори/);
    expect(text).toContain('Ход ученика: пешка на е четыре.');
    expect(text).toContain('Последний ход соперника: пешка на е пять.');
    expect(text).toContain('Материал равный.');
    // never «у тебя осталось четыре минуты пятьдесят девять секунд…»
    expect(text).not.toMatch(/Часы|часов|минут|секунд|времени/);
    expect(text).toContain('Лучший ход не называй');
    expect(text).not.toContain('конь на эф три');
    expect(text).not.toMatch(LATIN);
  });

  it('reports the opponent\'s threat found by the null-move search; an exam gets neutral facts only', async () => {
    const h = createTestHarness();
    const game = make(h);
    // the child plays Black; White builds the Scholar's mate threat 3.Qh5
    h.bot.replies = ['e2e4', 'f1c4', 'd1h5'];
    const threatened = fenAfter(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5']);
    const nullFen = threatened.replace(' b ', ' w ');
    h.judge.scriptFen(nullFen, [{ mate: 1, pv: ['h5f7'] }]);
    await game.start(config('training', { childColor: 'b' }));
    await game.whenSettled();
    await turn(game, 'e5');
    await turn(game, 'Nc6');
    expect(game.store.getState().fen).toBe(threatened);

    const text = (await game.toolHost.analyzePosition?.()) ?? '';
    expect(text).not.toMatch(/часов|Часы/);
    expect(text).toMatch(/соперник сыграет ферзь бьёт на эф семь, мат и получит мат/);
    expect(text).toMatch(/сначала защита короля/);
    // the null-move search really ran on the flipped position
    expect(h.judge.calls.some((c) => c.fen === nullFen)).toBe(true);

    const exam = createTestHarness();
    const examGame = make(exam);
    await examGame.start(config('rapid10', { examMode: true }));
    const neutral = (await examGame.toolHost.analyzePosition?.()) ?? '';
    expect(neutral).toMatch(/Это экзамен/);
    expect(neutral).not.toMatch(/Под боем|соперник сыграет/);
    examGame.dispose();
  });
});

describe('proactive moments (design D)', () => {
  it('after the BOT\'s move a new danger is announced once, with a brief of facts', async () => {
    const h = createTestHarness({ timings: { threatWarningDelayMs: 10 } });
    const game = make(h);
    h.bot.replies = ['e2e4', 'f1c4', 'd1h5'];
    h.judge.scriptFen(fenAfter(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5']).replace(' b ', ' w '), [{ mate: 1, pv: ['h5f7'] }]);
    await game.start(config('training', { childColor: 'b' }));
    await game.whenSettled();
    await turn(game, 'e5');
    await turn(game, 'Nc6');

    await waitFor(() => h.coach.kinds().includes('threatWarning'));
    const warning = h.coach.said.find((e) => e.kind === 'threatWarning');
    expect(warning?.priority).toBe(1);
    expect(['mateIn1', 'backRankMate']).toContain(warning?.motif);
    expect(warning?.brief).toMatch(/^Момент: Соперник сыграл ферзь на аш пять/);
    expect(warning?.brief).toMatch(/мат/);
    expect(warning?.brief).not.toMatch(LATIN);
    expect(game.store.getState().annotations?.highlights.some((x) => x.square === 'e8')).toBe(true);
  });

  it('at most once per 4 plies, and never twice about the same danger', async () => {
    const h = createTestHarness({ timings: { threatWarningDelayMs: 5 }, profile: { stage: 3 } });
    const game = make(h);
    // 3.Qg5 h6: the queen is attacked by a pawn and the child leaves it there
    h.bot.replies = ['e7e5', 'b8c6', 'h7h6', 'a7a6', 'a6a5'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Qh5');
    await turn(game, 'Qg5');
    await waitFor(() => h.coach.kinds().includes('threatWarning'));
    expect(h.coach.said.filter((e) => e.kind === 'threatWarning')).toHaveLength(1);

    await turn(game, 'Nf3'); // ply 7, the bot's a6 at ply 8: only 2 plies after the warning
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.coach.said.filter((e) => e.kind === 'threatWarning')).toHaveLength(1);

    await turn(game, 'Nc3'); // the bot's a5 at ply 10: the cooldown is over, but it is the same queen on the same square
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.coach.said.filter((e) => e.kind === 'threatWarning')).toHaveLength(1);
  });

  it('never in an exam, never in bullet, never right after a take-back offer', async () => {
    for (const cfg of [config('training', { examMode: true }), config('bullet1')]) {
      const h = createTestHarness({ timings: { threatWarningDelayMs: 5 }, profile: { stage: 3 } });
      const game = make(h);
      h.bot.replies = ['e7e5', 'b8c6', 'h7h6'];
      await game.start(cfg);
      await game.whenSettled();
      await turn(game, 'e4');
      await turn(game, 'Qh5');
      await turn(game, 'Qg5');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(h.coach.kinds(), cfg.timeControlId).not.toContain('threatWarning');
      game.dispose();
    }

    // declined offer → the bot takes the queen: the coach explains that, and does not add a threat warning
    const h = createTestHarness({ timings: { threatWarningDelayMs: 5 } });
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6', 'd8g5'];
    h.judge.scriptAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Qg5'], [{ cp: 900, pv: ['d8g5'] }]);
    await game.start(config('rapid10'));
    await turn(game, 'e4');
    await turn(game, 'Qh5');
    await turn(game, 'Qg5');
    const offer = h.coach.said.find((e) => e.kind === 'takebackOffer');
    expect(offer?.brief).toMatch(/Факты: Ход ученика: ферзь на же пять/);
    game.declineTakeback();
    await game.whenSettled();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.coach.kinds()).toContain('explainBest');
    expect(h.coach.kinds()).not.toContain('threatWarning');
  });

  it('a found REAL tactic is praised with priority 1 (normal talkativeness); the brief names it', async () => {
    const h = createTestHarness();
    const game = make(h);
    // 1.a3 Nf6 2.b3 Nd5 3.c3 d6 4.d3 Bf5 5.e4! — the pawn forks the knight and the bishop
    h.bot.replies = ['g8f6', 'f6d5', 'd7d6', 'c8f5', 'd5f6'];
    h.judge.scriptAfter(['a3', 'Nf6', 'b3', 'Nd5', 'c3', 'd6', 'd3', 'Bf5'], [
      { cp: 320, pv: ['e2e4', 'd5f6', 'e4f5'] },
      { cp: 20, pv: ['g1f3'] },
      { cp: 10, pv: ['h2h3'] },
    ]);
    await game.start(config('rapid10'));
    for (const san of ['a3', 'b3', 'c3', 'd3']) await turn(game, san);
    await turn(game, 'e4');

    const praise = h.coach.said.find((e) => e.kind === 'praise');
    expect(praise?.motif).toBe('fork');
    expect(praise?.priority).toBe(1);
    expect(praise?.brief).toContain('Ход ученика: пешка на е четыре.');
    expect(praise?.brief).toMatch(/Это вилка/);
  });
});

describe('the child\'s long silence (untimed / 10-minute games)', () => {
  const SILENCE = { silenceNudgeMs: 60_000, silenceNudgeRepeatMs: 120_000 };

  async function silentGame(cfg: GameConfig, listening = true): Promise<{ h: TestHarness; game: GameController }> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));
    const h = createTestHarness({ timings: SILENCE });
    const game = make(h);
    await game.start(cfg);
    if (listening) h.coach.setConversation('listening');
    return { h, game };
  }

  const nudges = (h: TestHarness) => h.coach.said.filter((e) => e.kind === 'encourage' && e.pose === 'listen');

  it('one gentle invitation to think aloud after 60 s of silence — not again for the same silence', async () => {
    const { h } = await silentGame(config('training'));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(nudges(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(nudges(h)).toHaveLength(1);
    expect(nudges(h)[0]?.priority).toBe(1);
    expect(nudges(h)[0]?.pauseClock).toBe(false);
    expect(nudges(h)[0]?.brief).toMatch(/молча думает/);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(nudges(h)).toHaveLength(1);
  });

  it('the child\'s words restart the count (journaled as childSaid), but never two nudges within 2 minutes', async () => {
    const { h, game } = await silentGame(config('rapid10'));
    await vi.advanceTimersByTimeAsync(61_000); // nudge #1 at 60 s
    expect(nudges(h)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_000);
    h.coach.hear('child', 'Я думаю, может конём?'); // t = 70 s
    await vi.advanceTimersByTimeAsync(60_500); // t ≈ 130 s: 60 s of silence, but only 70 s after the last nudge
    expect(nudges(h)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50_000); // t ≈ 180 s: 2 minutes after nudge #1
    expect(nudges(h)).toHaveLength(2);
    expect(game.store.getState().phase).toBe('childTurn');
  });

  it('a move restarts the count; no nudge in blitz, bullet, exams or without a listening conversation', async () => {
    const { h, game } = await silentGame(config('training'));
    h.bot.replies = ['e7e5'];
    await vi.advanceTimersByTimeAsync(50_000);
    expect(childPlays(game, 'e4')).toBe(true);
    await vi.advanceTimersByTimeAsync(50_000); // 50 s after the move (the bot answered at once)
    expect(nudges(h)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(nudges(h)).toHaveLength(1);
    game.dispose();

    for (const [cfg, listening] of [
      [config('blitz5'), true],
      [config('bullet1'), true],
      [config('training', { examMode: true }), true],
      [config('training'), false],
    ] as const) {
      vi.useRealTimers();
      const run = await silentGame(cfg, listening);
      await vi.advanceTimersByTimeAsync(200_000);
      expect(nudges(run.h), `${cfg.timeControlId} exam=${cfg.examMode} listening=${listening}`).toHaveLength(0);
      run.game.dispose();
    }
  });
});

describe('the silence nudge — who runs it', () => {
  it('reads the coach\'s own conversationState getter; silenceNudgeMs ≤ 0 leaves the nudge to the coach controller', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));
    const h = createTestHarness({ timings: { silenceNudgeMs: 60_000, silenceNudgeRepeatMs: 120_000 } });
    let state = 'listening';
    Object.defineProperty(h.coach, 'conversationState', { get: () => state, configurable: true });
    const game = make(h);
    await game.start(config('training'));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.coach.said.filter((e) => e.pose === 'listen')).toHaveLength(1);
    state = 'off';
    game.dispose();

    const off = createTestHarness({ timings: { silenceNudgeMs: 0 } });
    off.coach.setConversation('listening');
    const quiet = make(off);
    await quiet.start(config('training'));
    off.coach.setConversation('listening');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(off.coach.said.filter((e) => e.pose === 'listen')).toHaveLength(0);
  });
});

describe('the conversation follows the game', () => {
  it('coach.onGameStart when the game starts, onGameEnd once when it ends', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('rapid10'));
    expect(h.coach.gameStarts).toEqual([{ personaId: 'petya', timeControlId: 'rapid10', coachMode: 'full', examMode: false, childColor: 'w', resumed: false }]);
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();
    expect(h.coach.gameEnds).toEqual([{ result: '0-1', termination: 'resign' }]);
    game.dispose();
    expect(h.coach.gameEnds).toHaveLength(1);
  });

  it('leaving mid-game ends the conversation too; bullet tells the coach it is a silent game', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('bullet1'));
    expect(h.coach.gameStarts[0]).toMatchObject({ timeControlId: 'bullet1', coachMode: 'off' });
    game.dispose();
    expect(h.coach.gameEnds).toEqual([{ result: '*', termination: 'left' }]);
  });

  it('what the child says by voice is journaled as childSaid {source: voice}; every coach event carries a brief', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    h.coach.hear('child', 'Привет, Гамбитик!');
    await turn(game, 'e4');
    h.coach.hear('child', 'А что хочет соперник?');
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    const child = record.events.filter((e) => e.type === 'childSaid');
    expect(child.map((e) => e.data)).toEqual([
      { text: 'Привет, Гамбитик!', source: 'voice' },
      { text: 'А что хочет соперник?', source: 'voice' },
    ]);
    for (const e of h.coach.said) {
      // lesson events (the game end's takeaway, docs/TEACHING.md §4.1) carry pre-written wordings and no brief:
      // a live voice reads their text as it is
      if (e.say !== undefined) {
        expect(e.brief, e.kind).toBeUndefined();
        expect(e.text, e.kind).not.toMatch(LATIN);
        continue;
      }
      expect(e.brief, e.kind).toMatch(/^Момент: /);
      expect(e.brief, e.kind).not.toMatch(LATIN);
    }
  });
});

describe('the journal tells what was really said', () => {
  it('while a conversation listens, coach events keep their template under `template` — the model\'s own words come as transcripts', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    h.coach.setConversation('listening');
    await game.requestHint();
    h.coach.hear('coach', 'Давай вместе подумаем: что хочет соперник?');
    await turn(game, 'e4');
    h.coach.setConversation('off');
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    const hint = record.events.find((e) => e.type === 'hintGiven');
    expect(hint?.data.text).toBeUndefined();
    expect(hint?.data.template).toMatch(/\?$/);
    expect(hint?.data.spokenBy).toBe('model');
    const voiced = record.events.filter((e) => e.type === 'coachSaid' && e.data.source === 'voice');
    expect(voiced.map((e) => e.data.text)).toEqual(['Давай вместе подумаем: что хочет соперник?']);
    // without a conversation (browser voice reads the template) the template IS what was said
    const end = record.events.find((e) => e.type === 'coachSaid' && e.data.kind === 'gameEnd');
    expect(typeof end?.data.text).toBe('string');
  });

  it('a conversation that is still CONNECTING at the start also speaks in its own words — no template lines', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    // the app's coach says 'connecting' synchronously when a game start opens the conversation (coachController.onGameStart)
    let state: ConversationState = 'off';
    Object.defineProperty(h.coach, 'conversationState', { get: () => state, configurable: true });
    const onGameStart = h.coach.onGameStart.bind(h.coach);
    h.coach.onGameStart = (info) => {
      onGameStart(info);
      state = 'connecting';
    };
    await game.start(config('training'));
    state = 'listening';
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    const start = record.events.find((e) => e.type === 'coachSaid' && e.data.kind === 'gameStart');
    expect(start?.data.text).toBeUndefined();
    expect(start?.data.spokenBy).toBe('model');
  });
});

