/**
 * Robustness of the game module: resume, the child's thoughts without voice, the opening idea, a punished decline,
 * honest take-back praise, the exam start, «Вернуть ход», resigning while judging, repetition, en passant,
 * plus the silent context notes for the listening voice model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { AnalysisResult, AnalyzeOptions, Color, GameRecord, PersonaId, StudentProfile, TimeControlId } from '@gambit/shared';
import { createGameController, lastQuestionRu } from './gameStore.ts';
import type { GameController } from './gameStore.ts';
import type { GameConfig, GameTimings, PromotionPiece } from './gameTypes.ts';
import { RESUME_GAME_KEY, clearResumableGame, hasResumableGame, readResumableGame, resumableGameInfo } from './resume.ts';
import { FakeJudge, createTestHarness } from './testing/fakes.ts';
import type { TestHarness } from './testing/fakes.ts';
import { readUnsavedGames } from './unsavedGames.ts';

function config(timeControlId: TimeControlId, extra: Partial<GameConfig> = {}): GameConfig {
  return { personaId: 'petya' as PersonaId, timeControlId, childColor: 'w' as Color, examMode: false, ...extra };
}

function childPlays(game: GameController, san: string): boolean {
  const chess = new Chess(game.store.getState().fen);
  const move = chess.move(san);
  const played = game.dropPiece(move.from, move.to);
  if (!played && move.promotion && game.store.getState().pendingPromotion) {
    game.choosePromotion(move.promotion as PromotionPiece);
    return true;
  }
  return played;
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

const QUEEN_BLUNDER = ['e4', 'e5', 'Qh5', 'Nc6', 'Qg5'] as const;

async function playUpToQueenBlunder(h: TestHarness, game: GameController): Promise<void> {
  h.bot.replies = ['e7e5', 'b8c6', 'd8g5'];
  h.judge.scriptAfter(QUEEN_BLUNDER, [{ cp: 900, pv: ['d8g5'] }]);
  await turn(game, 'e4');
  await turn(game, 'Qh5');
}

const live: GameController[] = [];

function make(h: TestHarness): GameController {
  const game = createGameController(h.deps);
  live.push(game);
  return game;
}

function harness(overrides: { timings?: Partial<GameTimings>; profile?: Partial<StudentProfile> } = {}, shareStorageWith?: TestHarness): TestHarness {
  const h = createTestHarness(overrides);
  if (shareStorageWith) h.deps.storage = shareStorageWith.storage;
  return h;
}

afterEach(() => {
  for (const game of live.splice(0)) game.dispose();
});

// ───────────────────────── #1 resume ─────────────────────────

describe('a game in progress survives a closed tab', () => {
  it('writes a snapshot after every move and continues from it: same id, one journal, one record', async () => {
    const h = harness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('rapid10'));
    expect(readResumableGame(h.storage)).toBeNull(); // nothing to continue before the first move
    await turn(game, 'e4');
    const first = readResumableGame(h.storage);
    expect(first?.moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    await game.requestHint();
    await turn(game, 'Nf3');

    const snapshot = readResumableGame(h.storage);
    expect(snapshot?.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(snapshot?.judgements.map((j) => j.san)).toEqual(['e4', 'Nf3']);
    expect(snapshot?.events.some((e) => e.type === 'hintGiven')).toBe(true);
    expect(snapshot?.ended).toBeNull();
    expect(typeof snapshot?.clock.w).toBe('number');
    expect(hasResumableGame(h.storage)).toBe(true);
    expect(resumableGameInfo(h.storage)).toMatchObject({ config: config('rapid10'), personaName: 'Петя', moveCount: 4 });
    // the tab is closed: nobody calls dispose(), nothing is posted

    const h2 = harness({}, h);
    const resumed = make(h2);
    h2.bot.replies = ['g8f6'];
    // the route may say anything — the saved game keeps its own settings
    await resumed.start(config('bullet1', { childColor: 'b' }), { resume: snapshot });
    let state = resumed.store.getState();
    expect(state.resumed).toBe(true);
    expect(state.config).toEqual(config('rapid10'));
    expect(state.phase).toBe('childTurn');
    expect(state.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(state.fen).toBe(snapshot?.moves[3]?.fenAfter);
    expect(state.lastMove).toEqual({ from: 'b8', to: 'c6' });
    // the clock goes on from the saved times, not from ten fresh minutes
    expect(state.clock.w).toBeLessThanOrEqual(snapshot?.clock.w ?? 0);
    expect(state.clock.running).toBe('w');
    // one happy line with a wave — never whose move it is: the board and the clock show it
    expect(h2.coach.said[0]).toMatchObject({ kind: 'gameStart', pose: 'wave' });
    expect(h2.coach.said[0]?.text).not.toMatch(/твой ход|ход соперника/);
    expect(h2.coach.kinds()).not.toContain('thinkingRoutine');

    await turn(resumed, 'Bc4');
    resumed.resign();
    await resumed.whenSettled();
    state = resumed.store.getState();
    expect(h.saved).toHaveLength(0);
    expect(h2.saved).toHaveLength(1);
    const record = h2.saved[0] as GameRecord;
    expect(record.id).toBe(snapshot?.gameId);
    expect(record.startedAt).toBe(snapshot?.startedAt);
    expect(record.events.filter((e) => e.type === 'gameStart')).toHaveLength(1);
    expect(record.events.filter((e) => e.type === 'gameEnd')).toHaveLength(1);
    const times = record.events.map((e) => e.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(record.judgements.map((j) => j.san)).toEqual(['e4', 'Nf3', 'Bc4']);
    expect(record.summary.hintsUsed).toBe(1);
    const replay = new Chess();
    replay.loadPgn(record.pgn);
    expect(replay.history()).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']);
    // delivered → the question is never asked again
    expect(h.storage.getItem(RESUME_GAME_KEY)).toBeNull();
    expect(hasResumableGame(h.storage)).toBe(false);
  });

  it('«вернуть ход?» on the screen survives a reload: the question comes back, the bot does not answer the blunder', async () => {
    const h = harness();
    const game = make(h);
    await game.start(config('blitz5'));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');
    expect(game.store.getState().phase).toBe('coachIntervention');
    const childClockBefore = game.store.getState().clock.w;
    game.dispose(); // the tab goes away with the question open
    const snapshot = readResumableGame(h.storage);
    expect(snapshot?.pendingOffer).toMatchObject({ ply: 5, uci: 'h5g5' });
    expect(snapshot?.moves.at(-1)?.san).toBe('Qg5');

    const continued = async (): Promise<{ h2: TestHarness; resumed: GameController }> => {
      const h2 = harness({}, h);
      h2.bot.replies = ['d8g5'];
      const resumed = make(h2);
      // (a fresh copy each time, as a reload reads it from localStorage: a continued game marks its journal events)
      await resumed.start(config('blitz5'), { resume: structuredClone(snapshot) });
      await resumed.whenSettled();
      return { h2, resumed };
    };

    // «Партия ждала тебя» — with the question, not with the bot's capture
    const a = await continued();
    let state = a.resumed.store.getState();
    expect(state.phase).toBe('coachIntervention');
    expect(state.takeback?.san).toBe('Qg5');
    expect(state.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Qg5']);
    expect(a.h2.bot.asked).toHaveLength(0);
    expect(state.clock.paused).toBe(true);
    expect(a.h2.coach.kinds()).toEqual(['takebackOffer']);
    expect(state.annotations?.highlights.every((x) => x.color === 'red')).toBe(true);
    // «Верну ход»: the position and the child's clock from before the move
    a.resumed.acceptTakeback();
    await a.resumed.whenSettled();
    state = a.resumed.store.getState();
    expect(state.phase).toBe('childTurn');
    expect(state.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6']);
    expect(state.clock.w).toBeGreaterThanOrEqual(childClockBefore ?? 0);
    expect(a.h2.bot.asked).toHaveLength(0);
    // the budget counted the offer once — no second «takebackOffered» in the journal
    a.resumed.resign();
    await a.resumed.whenSettled();
    const record = a.h2.saved[0] as GameRecord;
    expect(record.summary.takebacksOffered).toBe(1);
    expect(record.summary.takebacksAccepted).toBe(1);

    // «Оставлю свой ход» after the reload: now the bot answers
    const b = await continued();
    b.resumed.declineTakeback();
    await b.resumed.whenSettled();
    expect(b.resumed.store.getState().moves.at(-1)?.san).toBe('Qxg5');
    expect(b.h2.bot.asked).toHaveLength(1);
  });

  it('a snapshot without the question (or with a broken one) continues as before: the bot answers', async () => {
    const h = harness();
    const game = make(h);
    h.bot.thinkMs = 3_000;
    await game.start(config('rapid10'));
    expect(childPlays(game, 'e4')).toBe(true);
    await waitFor(() => game.store.getState().phase === 'botThinking');
    await waitFor(() => readResumableGame(h.storage)?.moves.length === 1);
    const snapshot = readResumableGame(h.storage);
    game.dispose();
    expect(snapshot?.pendingOffer).toBeUndefined();
    for (const pendingOffer of [undefined, { ply: 9, uci: 'a2a3', childClockBefore: null, botClockBefore: null }]) {
      const h2 = harness({}, h);
      h2.bot.replies = ['e7e5'];
      const resumed = make(h2);
      await resumed.start(config('rapid10'), { resume: snapshot ? { ...snapshot, ...(pendingOffer ? { pendingOffer } : {}) } : null });
      await resumed.whenSettled();
      expect(resumed.store.getState().moves.map((m) => m.san)).toEqual(['e4', 'e5']);
      expect(resumed.store.getState().phase).toBe('childTurn');
      resumed.dispose();
    }
  });

  it('continues with the bot to move, and judges the move whose judgement was lost with the tab', async () => {
    const h = harness();
    const game = make(h);
    h.judge.mode = 'hang'; // the live judgement never arrives → the move waits in the post-game queue
    h.bot.thinkMs = 3_000; // …and the tab is closed while the bot is still «thinking»
    await game.start(config('rapid10'));
    expect(childPlays(game, 'e4')).toBe(true);
    await waitFor(() => game.store.getState().phase === 'botThinking');
    await waitFor(() => readResumableGame(h.storage)?.moves.length === 1);
    const snapshot = readResumableGame(h.storage);
    expect(snapshot?.judgements).toHaveLength(0);
    game.dispose();

    const h2 = harness({}, h);
    const resumed = make(h2);
    h2.bot.replies = ['e7e5', 'b8c6'];
    await resumed.start(config('rapid10'), { resume: snapshot });
    expect(h2.coach.said[0]?.kind).toBe('gameStart');
    await resumed.whenSettled();
    expect(resumed.store.getState().phase).toBe('childTurn');
    expect(resumed.store.getState().moves.map((m) => m.san)).toEqual(['e4', 'e5']);

    await turn(resumed, 'Nf3');
    resumed.resign();
    await resumed.whenSettled();
    expect((h2.saved[0] as GameRecord).judgements.map((j) => j.san)).toEqual(['e4', 'Nf3']);
  });

  it('«Новая партия»: the interrupted game is not lost — it reaches the server as an unfinished game', async () => {
    const h = harness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    const id = readResumableGame(h.storage)?.gameId;
    game.dispose(); // in-app «Назад»: the snapshot stays, nothing is posted
    expect(h.saved).toHaveLength(0);

    // a new game is started without continuing: start() settles the old snapshot and flushes it
    const h2 = harness({}, h);
    const fresh = make(h2);
    await fresh.start(config('training'));
    await fresh.whenSettled();
    expect(fresh.store.getState().resumed).toBe(false);
    expect(h2.saved.map((r) => [r.id, r.termination, r.result])).toEqual([[id, 'abandoned', '*']]);
    expect(h2.saved[0]?.events.filter((e) => e.type === 'gameEnd')).toHaveLength(1);
    expect(readResumableGame(h.storage)).toBeNull();
  });

  it('a broken, tampered or stale snapshot is never offered; a stale one still becomes a journal entry', async () => {
    const h = harness();
    h.storage.setItem(RESUME_GAME_KEY, '{not json');
    expect(hasResumableGame(h.storage)).toBe(false);
    expect(h.storage.getItem(RESUME_GAME_KEY)).toBeNull();

    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    const raw = h.storage.getItem(RESUME_GAME_KEY) as string;

    // an illegal main line (edited storage) cannot be resumed
    const tampered = JSON.parse(raw) as { moves: { uci: string }[] };
    (tampered.moves[0] as { uci: string }).uci = 'e2e5';
    h.storage.setItem(RESUME_GAME_KEY, JSON.stringify(tampered));
    expect(readResumableGame(h.storage)).toBeNull();

    // four days later the question is not asked any more, but the game is in the journal queue
    h.storage.setItem(RESUME_GAME_KEY, raw);
    const later = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    expect(hasResumableGame(h.storage, later)).toBe(false);
    expect(readUnsavedGames(h.storage).map((r) => r.termination)).toEqual(['abandoned']);
    expect(h.storage.getItem(RESUME_GAME_KEY)).toBeNull();
  });

  it('a snapshot that does not replay starts a fresh game instead of a broken one', async () => {
    const h = harness();
    const game = make(h);
    h.bot.replies = ['e7e5'];
    await game.start(config('training'));
    await turn(game, 'e4');
    const snapshot = readResumableGame(h.storage);
    game.dispose();
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;
    const broken = { ...snapshot, moves: snapshot.moves.map((m, i) => (i === 1 ? { ...m, fenAfter: 'garbage' } : m)) };

    const h2 = harness({}, h);
    const fresh = make(h2);
    await fresh.start(config('training'), { resume: broken });
    expect(fresh.store.getState().resumed).toBe(false);
    expect(fresh.store.getState().moves).toHaveLength(0);
    expect(fresh.store.getState().phase).toBe('childTurn');
    expect(h2.coach.kinds()).toContain('gameStart');
  });

  it('the tab is closed on the result card: the finished game is delivered later with its real result', async () => {
    const h = harness({ timings: { childNoteWaitMs: 60_000 } });
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.resign();
    await waitFor(() => game.store.getState().note === 'asking');
    expect(h.saved).toHaveLength(0);
    expect(readResumableGame(h.storage)?.ended).toEqual({ result: '0-1', termination: 'resign' });

    // next launch: not a game to continue — a record to deliver
    expect(hasResumableGame(h.storage)).toBe(false);
    const parked = readUnsavedGames(h.storage);
    expect(parked.map((r) => [r.result, r.termination])).toEqual([['0-1', 'resign']]);
    expect(parked[0]?.events.filter((e) => e.type === 'gameEnd')).toHaveLength(1);
  });

  it('leaving the result card before the record went out still saves it (diary question open)', async () => {
    const h = harness({ timings: { childNoteWaitMs: 60_000 } });
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.resign();
    await waitFor(() => game.store.getState().note === 'asking');
    game.dispose(); // «Домой»
    await waitFor(() => h.saved.length === 1);
    expect(h.saved[0]?.termination).toBe('resign');
    expect(h.storage.getItem(RESUME_GAME_KEY)).toBeNull();
  });

  it('without localStorage the fallback safety net works: leaving mid-game posts an abandoned record', async () => {
    const h = harness();
    h.deps.storage = null;
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    expect(game.persistNow()).toBe(false);
    game.dispose();
    await Promise.resolve();
    expect(h.saved.map((r) => r.termination)).toEqual(['abandoned']);
  });
});

// ───────────────────────── #2 the child's thoughts ─────────────────────────

describe('the child\'s thoughts are journaled without any paid voice', () => {
  async function finishedGame(timings: Partial<GameTimings>): Promise<{ h: TestHarness; game: GameController }> {
    const h = harness({ timings });
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.resign();
    return { h, game };
  }

  it('the diary sentence is asked on the result card and journaled BEFORE the record is posted', async () => {
    const { h, game } = await finishedGame({ childNoteWaitMs: 60_000 });
    await waitFor(() => game.store.getState().note === 'asking');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.saved).toHaveLength(0); // the record waits for the child
    expect(game.store.getState().ending?.stage).not.toBe('done');

    game.touchChildNote();
    game.submitChildNote(`  Трудно было   заметить вилку.  ${'я'.repeat(400)}`);
    await game.whenSettled();
    expect(game.store.getState().note).toBe('saved');
    const record = h.saved[0] as GameRecord;
    const said = record.events.filter((e) => e.type === 'childSaid');
    expect(said).toHaveLength(1);
    expect(said[0]?.data.source).toBe('typed');
    expect(String(said[0]?.data.text)).toMatch(/^Трудно было заметить вилку\. я+$/);
    expect(String(said[0]?.data.text)).toHaveLength(200);
    // a second answer changes nothing
    game.submitChildNote('ещё');
    expect(record.events.filter((e) => e.type === 'childSaid')).toHaveLength(1);
  });

  it('«Пропустить» and an empty sentence save the game without a note; nobody is kept waiting for ever', async () => {
    const skipped = await finishedGame({ childNoteWaitMs: 60_000 });
    await waitFor(() => skipped.game.store.getState().note === 'asking');
    skipped.game.submitChildNote(null);
    await skipped.game.whenSettled();
    expect(skipped.game.store.getState().note).toBe('skipped');
    expect(skipped.h.saved[0]?.events.some((e) => e.type === 'childSaid')).toBe(false);

    const blank = await finishedGame({ childNoteWaitMs: 60_000 });
    await waitFor(() => blank.game.store.getState().note === 'asking');
    blank.game.submitChildNote('   ');
    await blank.game.whenSettled();
    expect(blank.game.store.getState().note).toBe('skipped');

    // the child walked away: the record goes out without the answer — the question stays on the card for a late one
    const away = await finishedGame({ childNoteWaitMs: 30 });
    await away.game.whenSettled();
    expect(away.h.saved).toHaveLength(1);
    expect(away.game.store.getState().note).toBe('asking');
    expect(away.h.thoughts).toEqual([]);
    // (without the thoughts route the question closes as before: nobody could take a late answer)
    const noRoute = harness({ timings: { childNoteWaitMs: 30 } });
    delete noRoute.deps.appendThoughts;
    const old = make(noRoute);
    noRoute.bot.replies = ['e7e5', 'b8c6'];
    await old.start(config('training'));
    await turn(old, 'e4');
    await turn(old, 'Nf3');
    old.resign();
    await old.whenSettled();
    expect(old.store.getState().note).toBe('skipped');
    expect(noRoute.saved).toHaveLength(1);
  });

  it('a too-short game asks nothing', async () => {
    const h = harness({ timings: { childNoteWaitMs: 60_000 } });
    const game = make(h);
    h.bot.replies = ['e7e5'];
    await game.start(config('training'));
    await turn(game, 'e4');
    game.resign();
    await game.whenSettled();
    expect(game.store.getState().note).toBe('none');
    expect(game.store.getState().ending?.save).toBe('skipped');
  });

  it('after «Оставлю свой ход» three tappable reasons are offered; the answer is journaled as the child\'s words', async () => {
    const h = harness({ profile: { address: 'f' } });
    const game = make(h);
    await game.start(config('rapid10'));
    await playUpToQueenBlunder(h, game);
    h.bot.replies = ['a7a6']; // the opponent overlooks the queen: the decline is not punished at once
    game.giveDeclineReason('risk'); // nothing was asked yet
    await turn(game, 'Qg5');
    game.declineTakeback();
    expect(game.store.getState().declineReasons).toEqual({ ply: 5 });
    await game.whenSettled(); // the game went on by itself: the bot has moved
    expect(game.store.getState().phase).toBe('childTurn');

    game.giveDeclineReason('planned');
    expect(game.store.getState().declineReasons).toBeNull();
    game.giveDeclineReason('risk'); // only one answer
    game.resign();
    await game.whenSettled();
    const said = (h.saved[0] as GameRecord).events.filter((e) => e.type === 'childSaid');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ ply: 5, data: { source: 'choice', reason: 'planned', text: 'Я так задумала', about: 'takebackDeclined' } });
    const reply = h.coach.said.find((e) => e.text.includes('план'));
    expect(reply?.priority).toBe(0);
  });

  it('the reasons never block: they disappear with the child\'s next move', async () => {
    const h = harness();
    const game = make(h);
    await game.start(config('rapid10'));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');
    game.declineTakeback();
    await game.whenSettled();
    expect(game.store.getState().declineReasons).not.toBeNull();
    h.bot.replies = ['g8f6'];
    await turn(game, 'Nf3');
    expect(game.store.getState().declineReasons).toBeNull();
  });
});


// ───────────────────────── the child's thoughts after the record went out ─────────────────────────

describe('the child\'s words after the record went out follow it to the server (POST /games/:id/thoughts)', () => {
  async function finished(timings: Partial<GameTimings> = {}, h: TestHarness = harness({ timings })): Promise<{ h: TestHarness; game: GameController }> {
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    // (words during the game are part of the record — never sent again)
    h.coach.hear('child', 'А конь куда?');
    await turn(game, 'Nf3');
    game.resign();
    return { h, game };
  }

  it('the talk after the game: each child sentence with the last question Гамбитик asked, never the words already in the record', async () => {
    const { h, game } = await finished();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    expect(record.events.filter((e) => e.type === 'childSaid').map((e) => e.data.text)).toEqual(['А конь куда?']);
    h.coach.hear('coach', 'Ух, боевая партия! Что тебе больше всего понравилось?');
    h.coach.hear('child', 'Как я вывел коня');
    h.coach.hear('child', 'и ещё рокировка');
    await waitFor(() => h.thoughts.length > 0);
    const sent = h.thoughts.flatMap((call) => call.thoughts);
    expect(h.thoughts.every((call) => call.gameId === record.id)).toBe(true);
    expect(sent.map((t) => [t.id, t.source, t.question, t.text])).toEqual([
      [`${record.id}-t1`, 'voice', 'Что тебе больше всего понравилось?', 'Как я вывел коня'],
      [`${record.id}-t2`, 'voice', 'Что тебе больше всего понравилось?', 'и ещё рокировка'],
    ]);
    expect(sent.every((t) => Number.isFinite(Date.parse(t.at)))).toBe(true);
    // a question from the middle of the game is not what the talk after it answers
    expect(sent.some((t) => /конь куда/.test(t.question ?? ''))).toBe(false);
  });

  it('a late diary answer goes out with its question; a spoken one counts for the diary while the question is open', async () => {
    const late = await finished({ childNoteWaitMs: 30 });
    await late.game.whenSettled();
    expect(late.game.store.getState().note).toBe('asking');
    late.game.submitChildNote('Трудно было  следить за слоном');
    expect(late.game.store.getState().note).toBe('saved');
    await waitFor(() => late.h.thoughts.length > 0);
    expect(late.h.thoughts[0]?.thoughts).toMatchObject([{ source: 'typed', question: 'Что было самым трудным в этой партии?', text: 'Трудно было следить за слоном' }]);
    expect((late.h.saved[0] as GameRecord).events.filter((e) => e.type === 'childSaid' && e.data.about === 'hardestMoment')).toHaveLength(0);

    // the question is open, the talk too: the child answers aloud — that is the diary's answer, in the record itself
    const spoken = await finished({ childNoteWaitMs: 60_000 });
    await waitFor(() => spoken.game.store.getState().note === 'asking');
    spoken.h.coach.hear('coach', 'Хорошая игра! Что было самым трудным?');
    spoken.h.coach.hear('child', 'Когда ферзь напал на коня');
    await spoken.game.whenSettled();
    expect(spoken.game.store.getState().note).toBe('saved');
    const said = (spoken.h.saved[0] as GameRecord).events.filter((e) => e.type === 'childSaid');
    expect(said.map((e) => [e.data.source, e.data.text, e.data.about ?? null])).toEqual([
      ['voice', 'А конь куда?', null],
      ['voice', 'Когда ферзь напал на коня', 'hardestMoment'],
    ]);
    expect(spoken.h.thoughts).toEqual([]);

    // Гамбитик asked something else after the game: the child's words answer that, the diary stays open
    const other = await finished({ childNoteWaitMs: 60_000 });
    await waitFor(() => other.game.store.getState().note === 'asking');
    other.h.coach.hear('coach', 'Сыграем ещё разок?');
    other.h.coach.hear('child', 'Давай');
    expect(other.game.store.getState().note).toBe('asking');
  });

  it('lastQuestionRu: a question in quotes is one to practise, not one asked now', () => {
    expect(lastQuestionRu('Хорошая игра! Что было самым трудным?')).toBe('Что было самым трудным?');
    expect(lastQuestionRu('Идея на завтра: потренируем вопрос «Это безопасно?» — чтобы каждая фигура была под защитой.')).toBeNull();
    expect(lastQuestionRu('Перед каждым ходом спрашиваем: «Это безопасно?»')).toBeNull();
    expect(lastQuestionRu('Спроси себя: "Это безопасно?". А что было самым трудным?')).toBe('А что было самым трудным?');
    expect(lastQuestionRu('Молодец!')).toBeNull();
  });

  it('the game end of the lesson (outcome + ONE takeaway, every style) never becomes «the question the child answers»: the spoken answer goes to the diary', async () => {
    const h = harness({ timings: { childNoteWaitMs: 60_000 } });
    const { game } = await finished({}, h);
    await waitFor(() => game.store.getState().note === 'asking');
    const end = h.coach.said.find((event) => event.kind === 'gameEnd');
    // the lesson model (docs/TEACHING.md §2.9): pre-written wordings (`say`: an end opener, a takeaway), no clip, no brief
    expect(end?.teach).toMatchObject({ moment: 'takeaway' });
    expect(end?.say?.[0]?.pool).toMatch(/^v3\.end\./);
    expect(end?.clip).toBeUndefined();
    expect(end?.brief).toBeUndefined();
    // the voice says a line that ends with «?» after the game — a practice question in quotes is not asked either
    h.coach.hear('coach', 'Идея на завтра: потренируем вопрос «Это безопасно?»');
    h.coach.hear('child', 'Когда слон висел');
    await game.whenSettled();
    expect(game.store.getState().note).toBe('saved');
    const said = (h.saved[0] as GameRecord).events.filter((e) => e.type === 'childSaid' && e.data.about === 'hardestMoment');
    expect(said.map((e) => e.data.text)).toEqual(['Когда слон висел']);
  });

  it('the takeaway of a «Подсказчик» game is on the result card and in the journal as coachSaid {kind: gameEnd, teach.moment takeaway}', async () => {
    const h = harness({ timings: { childNoteWaitMs: 60_000 } });
    const game = make(h);
    // the bot leaves its queen en prise, the child does not take it
    h.bot.replies = ['e7e5', 'd8h4', 'b8c6'];
    h.judge.scriptAfter(['e4', 'e5', 'Nf3', 'Qh4'], [{ cp: 900, pv: ['f3h4'] }]);
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    await turn(game, 'a3');
    game.resign();
    await waitFor(() => game.store.getState().note === 'asking');
    const end = h.coach.said.find((event) => event.kind === 'gameEnd');
    expect(end?.teach?.moment).toBe('takeaway');
    const takeaway = game.store.getState().takeaway;
    expect(takeaway, 'the result card has the takeaway').not.toBeNull();
    expect(end?.text).toContain(takeaway ?? '');
    expect(end?.say?.some((s) => s.pool.startsWith('v3.takeaway.'))).toBe(true);
    // no quiz in a «Подсказчик» game: no score line
    expect(game.store.getState().quizScore).toBeNull();
    h.coach.hear('child', 'Я не заметил ферзя');
    await game.whenSettled();
    expect(game.store.getState().note).toBe('saved');
    const record = h.saved[0] as GameRecord;
    const journaled = record.events.find((e) => e.type === 'coachSaid' && e.data.kind === 'gameEnd');
    expect(journaled?.data.teach).toMatchObject({ moment: 'takeaway' });
    const said = record.events.filter((e) => e.type === 'childSaid' && e.data.about === 'hardestMoment');
    expect(said.map((e) => e.data.text)).toEqual(['Я не заметил ферзя']);
  });

  it('offline: the thoughts are parked and go out after the parked game when the next game starts', async () => {
    const first = harness({ timings: { childNoteWaitMs: 0 } });
    first.saveFailures.remaining = Number.POSITIVE_INFINITY; // the server is down
    first.thoughtFailures.remaining = Number.POSITIVE_INFINITY;
    const { game } = await finished({}, first);
    await game.whenSettled();
    expect(game.store.getState().ending?.save).toBe('local');
    first.coach.hear('coach', 'Что тебе понравилось?');
    first.coach.hear('child', 'Шах конём');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.thoughts).toEqual([]);
    const parked = JSON.parse(first.storage.getItem('gambit.unsentThoughts') ?? '[]') as { gameId: string; thoughts: { text: string }[] }[];
    expect(parked.map((g) => g.thoughts.map((t) => t.text))).toEqual([['Шах конём']]);
    const gameId = readUnsavedGames(first.storage)[0]?.id;
    expect(parked[0]?.gameId).toBe(gameId);
    game.dispose();

    // the next game: the server is back — first the parked game, then its thoughts
    const second = harness({}, first);
    const order: string[] = [];
    const save = second.deps.saveGame;
    second.deps.saveGame = (record) => {
      order.push(`game ${record.id}`);
      return save(record);
    };
    const append = second.deps.appendThoughts;
    second.deps.appendThoughts = (id, list) => {
      order.push(`thoughts ${id}`);
      return append ? append(id, list) : Promise.resolve();
    };
    const next = make(second);
    second.bot.replies = ['e7e5'];
    await next.start(config('training'));
    await waitFor(() => second.thoughts.length > 0);
    expect(order).toEqual([`game ${gameId}`, `thoughts ${gameId}`]);
    expect(second.thoughts[0]?.thoughts.map((t) => t.text)).toEqual(['Шах конём']);
    expect(first.storage.getItem('gambit.unsentThoughts')).toBeNull();
  });

  it('a refusal («too-old», an unknown game) drops them; leaving the card parks what is not sent yet', async () => {
    const refused = await finished({ thoughtsSendDelayMs: 0 });
    await refused.game.whenSettled();
    refused.h.thoughtFailures.remaining = 1;
    refused.h.thoughtFailures.error = Object.assign(new Error('too-old'), { status: 409 });
    refused.h.coach.hear('child', 'Было интересно');
    await new Promise((resolve) => setTimeout(resolve, 20));
    refused.h.coach.hear('child', 'И ещё');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refused.h.thoughts).toEqual([]);
    expect(refused.h.storage.getItem('gambit.unsentThoughts')).toBeNull();

    const leaving = await finished({ thoughtsSendDelayMs: 60_000 });
    await leaving.game.whenSettled();
    leaving.h.coach.hear('child', 'Пока!');
    leaving.game.dispose(); // «Домой» before the words went out
    const parked = JSON.parse(leaving.h.storage.getItem('gambit.unsentThoughts') ?? '[]') as { thoughts: { text: string }[] }[];
    expect(parked.flatMap((g) => g.thoughts.map((t) => t.text))).toEqual(['Пока!']);
  });
});

// ───────────────────────── #35 «Вернуть ход» ─────────────────────────

describe('«Вернуть ход» for a slip of the hand', () => {
  it('training game: the last own move (and the reply) is undone once, journaled as voluntary', async () => {
    const h = harness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'd7d5', 'g8f6'];
    await game.start(config('training'));
    expect(game.store.getState().canUndo).toBe(false); // nothing to undo yet
    expect(game.undoLastMove()).toBe(false);
    await turn(game, 'a4');
    expect(game.store.getState().canUndo).toBe(true);

    expect(game.undoLastMove()).toBe(true);
    await game.whenSettled();
    let state = game.store.getState();
    expect(state.moves).toHaveLength(0);
    expect(state.phase).toBe('childTurn');
    expect(state.canUndo).toBe(false);
    expect(h.coach.said.at(-1)?.text).toMatch(/вернули/i);

    // the replayed move cannot be undone again (it is for slips, not for trying every move)
    await turn(game, 'd4');
    expect(game.store.getState().canUndo).toBe(false);
    expect(game.undoLastMove()).toBe(false);
    // …the next own move can
    await turn(game, 'c4');
    expect(game.store.getState().canUndo).toBe(true);

    game.resign();
    await game.whenSettled();
    state = game.store.getState();
    expect(state.canUndo).toBe(false);
    const record = h.saved[0] as GameRecord;
    const undo = record.events.filter((e) => e.type === 'takebackAccepted');
    expect(undo).toHaveLength(1);
    expect(undo[0]?.data).toMatchObject({ voluntary: true, source: 'button', san: 'a4', pliesUndone: 2 });
    expect(record.summary.takebacksAccepted).toBe(0); // not an accepted coach offer
    expect(record.judgements.map((j) => j.san)).toEqual(['a4', 'd4', 'c4']);
    expect(record.summary.counts.best + record.summary.counts.excellent + record.summary.counts.good).toBe(2);
  });

  it('is not available with a clock or in an exam', async () => {
    for (const cfg of [config('rapid10'), config('blitz5'), config('training', { examMode: true })]) {
      const h = harness();
      const game = make(h);
      h.bot.replies = ['e7e5'];
      await game.start(cfg);
      await turn(game, 'e4');
      expect(game.store.getState().canUndo).toBe(false);
      expect(game.undoLastMove()).toBe(false);
      expect(game.store.getState().moves).toHaveLength(2);
    }
  });
});

// ───────────────────────── #10 / #12 ─────────────────────────

/** 1.e4 e6 2.Qh5 Nc6 — sound developing moves; 3.Qg6?? can be taken by the f- AND the h-pawn. */
const BEFORE_QG6 = [
  { cp: 30, pv: ['g1f3'] },
  { cp: 20, pv: ['b1c3'] },
  { cp: 10, pv: ['f1c4'] },
];

describe('a punished decline is explained whichever piece takes', () => {
  it('the judge predicted fxg6, the bot played hxg6: the coach still explains, the red arrow shows what happened', async () => {
    const h = harness();
    const game = make(h);
    h.bot.replies = ['e7e6', 'b8c6', 'h7g6'];
    h.judge.scriptAfter(['e4', 'e6', 'Qh5', 'Nc6'], BEFORE_QG6);
    h.judge.scriptAfter(['e4', 'e6', 'Qh5', 'Nc6', 'Qg6'], [{ cp: 900, pv: ['f7g6'] }]);
    await game.start(config('rapid10'));
    await turn(game, 'e4');
    await turn(game, 'Qh5');
    await turn(game, 'Qg6');
    expect(game.store.getState().phase).toBe('coachIntervention');
    game.declineTakeback();
    await game.whenSettled();

    expect(game.store.getState().moves.at(-1)?.san).toBe('hxg6');
    const explain = h.coach.said.filter((e) => e.kind === 'explainBest');
    expect(explain).toHaveLength(1);
    expect(explain[0]?.board?.arrows).toContainEqual({ from: 'h7', to: 'g6', color: 'red' });
    expect(h.coach.kinds()).toContain('thinkingRoutine');

    // the reasons are still on offer (the child's thinking is data), but a cheerful «посмотрим, что получится»
    // after the queen is gone would be tactless: the answer is journaled, the coach adds nothing
    expect(game.store.getState().declineReasons).toEqual({ ply: 5 });
    const saidBefore = h.coach.said.length;
    game.giveDeclineReason('dontSee');
    expect(h.coach.said).toHaveLength(saidBefore);
    game.resign();
    await game.whenSettled();
    const said = (h.saved[0] as GameRecord).events.filter((e) => e.type === 'childSaid');
    expect(said.map((e) => e.data.text)).toEqual(['Не вижу, что не так']);
  });

  it('a quiet reply after a declined offer is NOT treated as a punishment', async () => {
    const h = harness();
    const game = make(h);
    h.bot.replies = ['e7e6', 'b8c6', 'a7a6'];
    h.judge.scriptAfter(['e4', 'e6', 'Qh5', 'Nc6'], BEFORE_QG6);
    h.judge.scriptAfter(['e4', 'e6', 'Qh5', 'Nc6', 'Qg6'], [{ cp: 900, pv: ['f7g6'] }]);
    await game.start(config('rapid10'));
    await turn(game, 'e4');
    await turn(game, 'Qh5');
    await turn(game, 'Qg6');
    game.declineTakeback();
    await game.whenSettled();
    expect(h.coach.kinds()).not.toContain('explainBest');
  });
});

describe('pressing «Верну ход» is not the achievement', () => {
  async function takebackGame(retry: string): Promise<{ h: TestHarness; game: GameController }> {
    const h = harness();
    const game = make(h);
    await game.start(config('rapid10'));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');
    game.acceptTakeback();
    await game.whenSettled();
    if (retry !== 'Qg5') h.bot.replies = ['g8f6'];
    await turn(game, retry);
    game.resign();
    await game.whenSettled();
    return { h, game };
  }

  it('the very same blunder replayed: no «нашёл лучше», no star for listening', async () => {
    const { h, game } = await takebackGame('Qg5');
    expect(game.store.getState().moves.at(-1)?.san).toBe('Qxg5');
    const end = h.coach.said.find((e) => e.kind === 'gameEnd');
    expect(end?.text).not.toMatch(/наш(ёл|ла) лучше/);
    expect(game.store.getState().stars?.listened).toBe(false);
    expect((h.saved[0] as GameRecord).summary.takebacksAccepted).toBe(1);
  });

  it('the replayed blunder is the child\'s decision: no second offer, journaled as «insisted»', async () => {
    const { h } = await takebackGame('Qg5');
    const record = h.saved[0] as GameRecord;
    expect(record.summary.takebacksOffered).toBe(1);
    const replayed = record.events.filter((e) => e.type === 'move' && e.data.san === 'Qg5' && e.data.takenBack !== true);
    expect(replayed.at(-1)?.data.decisionReason).toBe('insisted');
  });

  it('a different move after the take-back earns the star', async () => {
    const { game } = await takebackGame('Nf3');
    expect(game.store.getState().stars?.listened).toBe(true);
  });
});

// ───────────────────────── #30, #5, context notes ─────────────────────────

describe('coach phrases around the game', () => {
  it('an exam starts with the exam phrase, never with «жми Подсказку»', async () => {
    for (let i = 0; i < 6; i++) {
      const h = harness();
      const game = make(h);
      await game.start(config('training', { examMode: true }));
      const start = h.coach.said.find((e) => e.kind === 'gameStart');
      expect(start?.text).toMatch(/экзамен/i);
      expect(start?.text).not.toMatch(/Подсказка|я рядом/);
      game.dispose();
    }
  });

  it('the idea of the opening is told once — at any stage and in 5 minutes too', async () => {
    const italian = async (stage: number, cfg: GameConfig): Promise<string[]> => {
      const h = harness({ profile: { stage } });
      const game = make(h);
      h.bot.replies = ['e7e5', 'b8c6', 'f8c5', 'g8f6', 'd7d6'];
      await game.start(cfg);
      for (const san of ['e4', 'Nf3', 'Bc4', 'c3', 'd3']) await turn(game, san);
      return h.coach.said.filter((e) => /итальянка/i.test(e.text)).map((e) => e.text);
    };
    const told = await italian(5, config('rapid10'));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/тихая итальянка\. Никаких ловушек/);
    expect(told[0]).not.toMatch(/[A-Za-z]/);
    // the child knows how the pieces move: the main idea is named from stage 1, and the 5-minute helper is not passive
    expect(await italian(1, config('rapid10'))).toHaveLength(1);
    expect(await italian(1, config('blitz5'))).toHaveLength(1);
    // never in an exam, never in bullet (the coach is silent there)
    expect(await italian(5, config('rapid10', { examMode: true }))).toEqual([]);
    expect(await italian(1, config('bullet1'))).toEqual([]);
  });

  it('silent context notes follow every bot move and judgement: short, Russian, no notation, no best move', async () => {
    const h = harness();
    const game = make(h);
    await game.start(config('rapid10'));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');
    const notes = h.coach.context;
    expect(notes.some((n) => /^Ход соперника: пешка на е пять\. Под боем у ученика ничего нет\.$/.test(n))).toBe(true);
    expect(notes.some((n) => /^Ход ученика: .+ — (лучший|отличный|хороший) ход\.$/.test(n))).toBe(true);
    const blunder = notes.at(-1) ?? '';
    expect(blunder).toMatch(/^Ход ученика: ферзь на же пять — зевок\. Тренер предложил вернуть ход/);
    for (const note of notes) {
      expect(note).not.toMatch(/[A-Za-z]/);
      expect(note.length).toBeLessThan(160);
    }

    // an exam: the model hears the moves, never a verdict or a danger list
    const exam = harness();
    const examGame = make(exam);
    exam.bot.replies = ['e7e5'];
    await examGame.start(config('training', { examMode: true }));
    await turn(examGame, 'e4');
    expect(exam.coach.context).toEqual(['Ход соперника: пешка на е пять.']);
  });
});

// ───────────────────────── #40, #41, #43 ─────────────────────────

class SlowJudge extends FakeJudge {
  delayMs = 0;

  override analyze(fen: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
    const answer = super.analyze(fen, opts);
    if (this.delayMs <= 0) return answer;
    return new Promise((resolve, reject) => setTimeout(() => answer.then(resolve, reject), this.delayMs));
  }
}

describe('chess correctness', () => {
  it('resigning while the last move is being judged keeps that judgement in the record', async () => {
    const h = harness();
    const judge = new SlowJudge();
    h.deps.judge = judge;
    const game = make(h);
    h.bot.replies = ['e7e5'];
    await game.start(config('rapid10'));
    await turn(game, 'e4');

    judge.delayMs = 40;
    expect(childPlays(game, 'Qh5')).toBe(true);
    expect(game.store.getState().phase).toBe('judging');
    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    expect(record.judgements.map((j) => j.san)).toEqual(['e4', 'Qh5']);
    expect(record.summary.counts.best + record.summary.counts.excellent + record.summary.counts.good).toBe(2);
  });

  it('repeating a won position into a draw is judged as the draw it is', async () => {
    const h = harness();
    const game = make(h);
    h.bot.replies = ['Nf3', 'Ng1', 'Nf3', 'Ng1'];
    // Black (the child) is "winning" here; the engine, blind to the history, still likes the knight retreat best
    h.judge.scriptAfter(['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1'], [
      { cp: 900, pv: ['f6g8'] },
      { cp: 880, pv: ['d7d5'] },
    ]);
    await game.start(config('training', { childColor: 'b' }));
    await game.whenSettled();
    for (const san of ['Nf6', 'Ng8', 'Nf6']) await turn(game, san);
    await turn(game, 'Ng8'); // third time the start position: the game is a draw

    const state = game.store.getState();
    expect(state.phase).toBe('gameOver');
    expect(state.termination).toBe('draw');
    const record = h.saved[0] as GameRecord;
    const last = record.judgements.at(-1);
    expect(last?.san).toBe('Ng8');
    expect(last?.evalAfter).toEqual({ cp: 0, mate: null });
    expect(last?.bestUci).toBe('d7d5');
    expect(['missedWin', 'blunder']).toContain(last?.classification);
    // the same retreat earlier in the game (no repetition yet) was fine
    expect(record.judgements[1]?.san).toBe('Ng8');
    expect(record.judgements[1]?.winPctLoss).toBe(0);
  });

  it('en passant is shown and sounds like the capture it is', async () => {
    const h = harness();
    const game = make(h);
    h.bot.replies = ['a7a6', 'd7d5'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'e5');
    game.selectSquare('e5');
    expect(game.store.getState().legalTargets).toContainEqual({ square: 'd6', capture: true });
    expect(game.store.getState().legalTargets).toContainEqual({ square: 'e6', capture: false });
    h.sounds.length = 0;
    h.bot.replies = ['c7d6'];
    game.selectSquare('d6');
    expect(h.sounds[0]).toBe('capture');
    await game.whenSettled();
  });
});

describe('resume helpers used by the shell', () => {
  it('clearResumableGame on an empty storage and with no storage at all is a no-op', () => {
    const h = harness();
    expect(() => clearResumableGame(h.storage)).not.toThrow();
    expect(() => clearResumableGame(null)).not.toThrow();
    expect(hasResumableGame(null)).toBe(false);
    expect(resumableGameInfo(h.storage)).toBeNull();
  });
});
