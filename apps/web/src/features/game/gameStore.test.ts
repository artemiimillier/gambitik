import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import type { Color, GameRecord, PersonaId, TimeControlId } from '@gambit/shared';
import { createGameController } from './gameStore.ts';
import type { GameController } from './gameStore.ts';
import type { GameConfig, GamePhase, PromotionPiece } from './gameTypes.ts';
import { createTestHarness } from './testing/fakes.ts';
import type { TestHarness } from './testing/fakes.ts';
import { RESUME_GAME_KEY, clearResumableGame, hasResumableGame, readResumableGame, resumableGameInfo } from './resume.ts';
import { UNSAVED_GAMES_KEY, readUnsavedGames } from './unsavedGames.ts';

function config(timeControlId: TimeControlId, extra: Partial<GameConfig> = {}): GameConfig {
  return { personaId: 'petya' as PersonaId, timeControlId, childColor: 'w' as Color, examMode: false, ...extra };
}

/** Plays the child's move given in SAN through the same entry points the board uses. */
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

/** Child move + everything it triggers (judgement, bot reply, background analysis). */
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

function recordPhases(game: GameController): GamePhase[] {
  const phases: GamePhase[] = [game.store.getState().phase];
  game.store.subscribe((state) => {
    if (phases[phases.length - 1] !== state.phase) phases.push(state.phase);
  });
  return phases;
}

function expectValidRecord(record: GameRecord, plies: number): void {
  const chess = new Chess();
  chess.loadPgn(record.pgn);
  expect(chess.history()).toHaveLength(plies);
  expect(chess.getHeaders().Result).toBe(record.result);
  expect(record.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  expect(Date.parse(record.endedAt)).toBeGreaterThanOrEqual(Date.parse(record.startedAt));
  expect(record.events[0]?.type).toBe('gameStart');
  expect(record.events.filter((e) => e.type === 'gameEnd')).toHaveLength(1);
  const times = record.events.map((e) => e.t);
  expect([...times].sort((a, b) => a - b)).toEqual(times);
  for (const judgement of record.judgements) expect(judgement.color).toBe(record.childColor);
  // must survive the trip to the server
  expect(JSON.parse(JSON.stringify(record))).toEqual(record);
}

/** 1.e4 e5 2.Qh5 Nc6 3.Qg5?? — the queen can simply be taken. */
const QUEEN_BLUNDER = ['e4', 'e5', 'Qh5', 'Nc6', 'Qg5'] as const;

async function playUpToQueenBlunder(h: TestHarness, game: GameController): Promise<void> {
  h.bot.replies = ['e7e5', 'b8c6', 'd8g5'];
  h.judge.scriptAfter(QUEEN_BLUNDER, [{ cp: 900, pv: ['d8g5'] }]);
  await turn(game, 'e4');
  await turn(game, 'Qh5');
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

describe('game controller — the core loop', () => {
  it('starts idle, wakes the engines and hands the first move to the child', async () => {
    const h = createTestHarness();
    const game = make(h);
    expect(game.store.getState().phase).toBe('idle');

    await game.start(config('rapid10'));
    const state = game.store.getState();
    expect(state.phase).toBe('childTurn');
    expect(state.persona?.id).toBe('petya');
    expect(state.profile?.nickname).toBe('Лёва');
    // the clock is already running (nothing holds it at the start): allow the few ms the start-up took
    expect(state.clock.w).toBeLessThanOrEqual(600_000);
    expect(state.clock.w).toBeGreaterThan(599_500);
    expect(state.clock.running).toBe('w');
    expect(state.hintsEnabled).toBe(true);
    expect(state.botBubble?.kind).toBe('intro');
    expect(h.coach.kinds()).toContain('gameStart');
    expect(h.coach.toolHost).toBe(game.toolHost);
    // background analysis of the child's position started right away (MultiPV 3)
    expect(h.judge.calls[0]?.opts.multipv).toBe(3);
  });

  it('normal move → judged → bot reply → child again', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5'];
    await game.start(config('rapid10'));
    const phases = recordPhases(game);

    await turn(game, 'e4');

    const state = game.store.getState();
    expect(phases).toEqual(['childTurn', 'judging', 'botThinking', 'childTurn']);
    expect(state.moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect(state.moves.map((m) => m.by)).toEqual(['child', 'bot']);
    expect(state.lastMove).toEqual({ from: 'e7', to: 'e5' });
    expect(state.turn).toBe('w');
    expect(h.bot.asked).toHaveLength(1);
    expect(h.bot.asked[0]?.moveNumber).toBe(1);
    expect(h.bot.asked[0]?.remainingMs).toBeGreaterThan(599_000);
    expect(h.bot.asked[0]?.remainingMs).toBeLessThanOrEqual(600_000);
    expect(h.sounds.filter((s) => s === 'move')).toHaveLength(2);
    expect(h.coach.activity).toBeGreaterThan(0);
  });

  it('the bot moves first when the child plays Black', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['d2d4'];
    await game.start(config('rapid10', { childColor: 'b' }));
    await game.whenSettled();

    const state = game.store.getState();
    expect(state.phase).toBe('childTurn');
    expect(state.moves.map((m) => m.san)).toEqual(['d4']);
    expect(state.turn).toBe('b');
    expect(game.dropPiece('d2', 'd3')).toBe(false); // not the child's pieces
    await turn(game, 'd5');
    expect(game.store.getState().moves).toHaveLength(3);
  });

  it('click-to-move: select, show targets, move; clicks outside the turn are ignored', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('training'));

    game.selectSquare('e7'); // opponent's pawn
    expect(game.store.getState().selected).toBeNull();

    game.selectSquare('g1');
    expect(game.store.getState().selected).toBe('g1');
    expect(game.store.getState().legalTargets.map((t) => t.square).sort()).toEqual(['f3', 'h3']);

    game.selectSquare('e2'); // switching to another own piece
    expect(game.store.getState().legalTargets.map((t) => t.square).sort()).toEqual(['e3', 'e4']);

    game.selectSquare('e4');
    expect(game.store.getState().moves[0]?.san).toBe('e4');
    expect(game.store.getState().selected).toBeNull();

    game.selectSquare('d2'); // judging / bot thinking: no selection
    expect(game.store.getState().selected).toBeNull();
    await game.whenSettled();

    game.beginDrag('d2');
    expect(game.store.getState().selected).toBe('d2');
    expect(game.dropPiece('d2', 'd5')).toBe(false);
    expect(game.store.getState().selected).toBeNull();
  });

  it('promotion needs a choice: the move is played only after the picker answers', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['g7g5', 'h7h6', 'a7a6', 'a6a5'];
    await game.start(config('training'));
    for (const san of ['h4', 'hxg5', 'gxh6', 'h7']) await turn(game, san);

    expect(game.dropPiece('h7', 'g8')).toBe(false);
    expect(game.store.getState().pendingPromotion).toEqual({ from: 'h7', to: 'g8', color: 'w' });
    expect(game.store.getState().moves).toHaveLength(8);

    game.choosePromotion(null); // «Отмена»
    expect(game.store.getState().pendingPromotion).toBeNull();
    expect(game.store.getState().moves).toHaveLength(8);

    game.dropPiece('h7', 'g8');
    game.choosePromotion('n');
    await game.whenSettled();
    expect(game.store.getState().moves[8]?.san).toBe('hxg8=N');
    expect(game.store.getState().moves[8]?.uci).toBe('h7g8n');
  });
});

describe('game controller — the board tells the coach it changed («Дозапись голоса»)', () => {
  it('every ply (the child\'s, the bot\'s) and every take-back (offered, voluntary) calls noteBoardChange', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('rapid10'));
    expect(h.coach.boardChanges).toBe(0);
    await playUpToQueenBlunder(h, game);
    // e4 e5 Qh5 Nc6
    expect(h.coach.boardChanges).toBe(4);
    await turn(game, 'Qg5');
    expect(game.store.getState().phase).toBe('coachIntervention');
    expect(h.coach.boardChanges).toBe(5);
    game.acceptTakeback();
    await game.whenSettled();
    expect(h.coach.boardChanges).toBe(6);
    game.dispose();

    const training = createTestHarness();
    const slip = make(training);
    training.bot.replies = ['e7e5'];
    await slip.start(config('training'));
    await turn(slip, 'a4');
    expect(training.coach.boardChanges).toBe(2);
    expect(slip.undoLastMove()).toBe(true);
    await slip.whenSettled();
    // the child's move and the bot's reply go back together: one change of the board
    expect(training.coach.boardChanges).toBe(3);
  });
});

describe('game controller — take-back', () => {
  it('blunder → offer → accept: position and clock restored, journal has offered + accepted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('rapid10'));
    await playUpToQueenBlunder(h, game);

    await vi.advanceTimersByTimeAsync(7_000);
    const fenBefore = game.store.getState().fen;
    const clockBefore = game.store.getState().clock.w ?? 0;
    expect(clockBefore).toBe(593_000);
    const botAsked = h.bot.asked.length;

    await turn(game, 'Qg5');

    let state = game.store.getState();
    expect(state.phase).toBe('coachIntervention');
    expect(state.takeback?.san).toBe('Qg5');
    expect(state.takeback?.judgement.classification).toBe('blunder');
    expect(state.takeback?.judgement.confidence).toBe('confirmed');
    expect(h.bot.asked).toHaveLength(botAsked); // the bot is NOT asked while the offer is open
    expect(h.sounds).toContain('oops');
    const offer = h.coach.said.find((e) => e.kind === 'takebackOffer');
    expect(offer?.priority).toBe(2);
    expect(state.annotations?.highlights.every((x) => x.color === 'red')).toBe(true);
    expect(state.annotations?.highlights.length).toBeGreaterThan(0);
    expect(state.annotations?.arrows).toEqual([]); // never the solution

    // both clocks stand while the child decides
    await vi.advanceTimersByTimeAsync(40_000);
    expect(game.store.getState().clock.paused).toBe(true);
    expect(game.dropPiece('g1', 'f3')).toBe(false);

    game.acceptTakeback();
    await game.whenSettled();

    state = game.store.getState();
    expect(state.phase).toBe('childTurn');
    expect(state.fen).toBe(fenBefore);
    expect(state.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6']);
    expect(state.clock.w).toBe(clockBefore);
    expect(state.clock.b).toBe(600_000);
    expect(state.clock.running).toBe('w');
    expect(state.takeback).toBeNull();
    expect(state.hintPulse).toBe(true);
    expect(state.lastMove).toEqual({ from: 'b8', to: 'c6' });
    // the red danger squares stay while the child thinks again
    expect(state.annotations?.highlights.length).toBeGreaterThan(0);
    expect(h.bot.asked).toHaveLength(botAsked);

    // the clock runs again for the child
    await vi.advanceTimersByTimeAsync(1_000);
    expect(game.store.getState().clock.w).toBe(clockBefore - 1_000);

    // retry with a sound move: no second offer, the bot answers
    h.bot.replies = ['g8f6'];
    await turn(game, 'Nf3');
    state = game.store.getState();
    expect(state.phase).toBe('childTurn');
    expect(state.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Nf3', 'Nf6']);
    expect(state.annotations).toBeNull();

    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    const types = record.events.map((e) => e.type);
    expect(types).toContain('takebackOffered');
    expect(types).toContain('takebackAccepted');
    expect(types.indexOf('takebackOffered')).toBeLessThan(types.indexOf('takebackAccepted'));
    const offered = record.events.find((e) => e.type === 'takebackOffered');
    expect(offered?.ply).toBe(5);
    expect(offered?.data.san).toBe('Qg5');
    expect(typeof offered?.data.text).toBe('string');
    const takenBack = record.events.filter((e) => e.type === 'move' && e.data.takenBack === true);
    expect(takenBack.map((e) => e.data.san)).toEqual(['Qg5']);
    // the taken-back attempt keeps its judgement, the retry at the same ply comes after it
    expect(record.judgements.filter((j) => j.ply === 5).map((j) => j.san)).toEqual(['Qg5', 'Nf3']);
    expect(record.summary.takebacksOffered).toBe(1);
    expect(record.summary.takebacksAccepted).toBe(1);
    expect(record.summary.counts.blunder).toBe(0); // the blunder did not stay on the board
    expectValidRecord(record, 6);
  });

  it('decline → the bot punishes → one gentle explanation, the move stays', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('rapid10'));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');
    expect(game.store.getState().phase).toBe('coachIntervention');

    game.declineTakeback();
    await game.whenSettled();

    const state = game.store.getState();
    expect(state.phase).toBe('childTurn');
    expect(state.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Qg5', 'Qxg5']);
    expect(state.takeback).toBeNull();
    expect(state.annotations).toBeNull();
    expect(h.sounds).toContain('capture');
    const kinds = h.coach.kinds();
    expect(kinds.filter((k) => k === 'explainBest')).toHaveLength(1);
    expect(kinds.indexOf('explainBest')).toBeGreaterThan(kinds.indexOf('takebackOffer'));
    expect(h.coach.said.find((e) => e.kind === 'explainBest')?.priority).toBe(1);

    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    expect(record.events.map((e) => e.type)).toContain('takebackDeclined');
    expect(record.events.some((e) => e.type === 'takebackAccepted')).toBe(false);
    expect(record.summary.counts.blunder).toBe(1);
    expectValidRecord(record, 6);
  });

  it('5 minutes offers again (budget 3, like 10 minutes): the second blunder of the game is offered too', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('blitz5'));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');
    game.declineTakeback();
    await game.whenSettled();

    h.bot.replies = ['g5g6', 'a7a6'];
    await turn(game, 'Nf3');
    await turn(game, 'Nc3');
    const line = [...QUEEN_BLUNDER, 'Qxg5', 'Nf3', 'Qg6', 'Nc3', 'a6', 'Nxe5'];
    h.judge.scriptAfter(line, [{ cp: 900, pv: ['c6e5'] }]);
    h.bot.replies = ['c6e5'];
    const phases = recordPhases(game);

    await turn(game, 'Nxe5');

    // one «верни ход» per 5-minute game would let many blunders pass in silence
    expect(phases).toContain('coachIntervention');
    expect(h.coach.kinds().filter((k) => k === 'takebackOffer')).toHaveLength(2);
    game.declineTakeback();
    await game.whenSettled();

    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    expect(record.summary.takebacksOffered).toBe(2);
    const second = record.events.find((e) => e.type === 'move' && e.data.san === 'Nxe5');
    expect(second?.data.decision).toBe('offerTakeback');
    expect(record.judgements.find((j) => j.san === 'Nxe5')?.classification).toBe('blunder');
  });

  it('after a take-back another losing move in the same position is offered again at once — «и этот ход теряет …»; once per position', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('blitz5'));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');
    game.acceptTakeback();
    await game.whenSettled();

    // 3.Сa6?? — the bishop is lost (3 pawns: not «severe», the cooldown alone would have kept silent)
    h.judge.scriptAfter(['e4', 'e5', 'Qh5', 'Nc6', 'Ba6'], [{ cp: 350, pv: ['b7a6'] }]);
    await turn(game, 'Ba6');
    let state = game.store.getState();
    expect(state.phase).toBe('coachIntervention');
    expect(state.takeback?.san).toBe('Ba6');
    const again = h.coach.said.filter((e) => e.kind === 'takebackOffer')[1];
    expect(again?.text).toMatch(/слона/);
    expect(again?.text).toMatch(/подумаем/);
    expect(again?.text).not.toMatch(/Стоп-стоп|Тпру|Погоди-ка/);
    expect(again?.brief).toMatch(/в той же позиции другой/);
    expect(h.bot.asked).toHaveLength(2); // the bot waits for the choice

    // once per position: the next try there (3.d4?, not «severe») waits for the cooldown again
    game.acceptTakeback();
    await game.whenSettled();
    h.judge.scriptAfter(['e4', 'e5', 'Qh5', 'Nc6', 'd4'], [{ cp: 300, pv: ['c6d4', 'g1f3', 'd4c2'] }]);
    h.bot.replies = ['c6d4'];
    await turn(game, 'd4');
    state = game.store.getState();
    expect(state.phase).toBe('childTurn');
    expect(h.coach.kinds().filter((k) => k === 'takebackOffer')).toHaveLength(2);

    game.resign();
    await game.whenSettled();
    const record = h.saved[0] as GameRecord;
    const offers = record.events.filter((e) => e.type === 'takebackOffered');
    expect(offers.map((e) => [e.data.san, e.data.again ?? false])).toEqual([
      ['Qg5', false],
      ['Ba6', true],
    ]);
    const third = record.events.find((e) => e.type === 'move' && e.data.san === 'd4' && e.data.by === 'child');
    expect(third?.data.decisionReason).toBe('cooldown');
  });

  it('the same move again after the take-back is the child\'s decision — no second offer (insisted)', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('blitz5'));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');
    game.acceptTakeback();
    await game.whenSettled();
    await turn(game, 'Qg5');
    expect(game.store.getState().phase).toBe('childTurn');
    expect(h.coach.kinds().filter((k) => k === 'takebackOffer')).toHaveLength(1);
  });

  it('a taken-back blunder never counts against the child, even when the game ends before the retry', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('rapid10'));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');
    game.acceptTakeback();
    await game.whenSettled();
    game.resign();
    await game.whenSettled();

    const record = h.saved[0] as GameRecord;
    expect(record.judgements.map((j) => j.san)).toEqual(['e4', 'Qh5', 'Qg5']); // the attempt stays in the journal
    expect(record.summary.counts.blunder).toBe(0);
    expect(record.summary.counts.best + record.summary.counts.excellent + record.summary.counts.good).toBe(2);
    expect(record.summary.accuracy).toBeGreaterThan(90);
    expect(record.summary.motifsAllowed).toContain('hangingPiece'); // …but the overlooked idea is remembered
    expect(game.store.getState().stars?.careful).toBe(true);
    expectValidRecord(record, 4);
  });

  it('exam mode: the same blunder is judged and logged, never interrupted', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('rapid10', { examMode: true }));
    await playUpToQueenBlunder(h, game);
    await turn(game, 'Qg5');

    expect(game.store.getState().phase).toBe('childTurn');
    expect(game.store.getState().hintsEnabled).toBe(false);
    expect(h.coach.kinds()).not.toContain('takebackOffer');
    expect(h.coach.kinds()).not.toContain('explainBest');
  });

  it('the realtime tool may take the move back only during the offer (or in training games)', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('rapid10'));
    await playUpToQueenBlunder(h, game);
    expect(game.toolHost.takeBackMove()).toBe(false);

    await turn(game, 'Qg5');
    expect(game.toolHost.takeBackMove()).toBe(true);
    await game.whenSettled();
    expect(game.store.getState().phase).toBe('childTurn');
    expect(game.store.getState().moves).toHaveLength(4);
  });

  it('training game: a voluntary take-back undoes the child move and the reply', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5'];
    await game.start(config('training'));
    expect(game.toolHost.takeBackMove()).toBe(false); // nothing to take back yet
    await turn(game, 'e4');

    expect(game.toolHost.takeBackMove()).toBe(true);
    await game.whenSettled();
    const state = game.store.getState();
    expect(state.moves).toHaveLength(0);
    expect(state.phase).toBe('childTurn');
    expect(new Chess(state.fen).fen()).toBe(new Chess().fen());

    h.bot.replies = ['d7d5'];
    await turn(game, 'd4');
    game.resign();
    await game.whenSettled();
    // one child move only → too short to be saved, but the journal logic held together
    expect(h.saved).toHaveLength(0);
    expect(game.store.getState().termination).toBe('abandoned');
  });
});

describe('game controller — «Подсказка» in a game without hints', () => {
  it('the coach answers kindly — a clip twin of the catalogue\'s own words (a fast game, an exam), so «Записи» can say it', async () => {
    for (const [cfg, line] of [
      [config('bullet1'), 'shell.noHints.fast'],
      [config('rapid10', { examMode: true }), 'shell.noHints.exam'],
    ] as const) {
      const h = createTestHarness();
      const game = make(h);
      h.bot.replies = ['e7e5'];
      await game.start(cfg);
      await turn(game, 'e4');
      expect(game.store.getState().hintsEnabled).toBe(false);
      await game.requestHint('dock');
      const said = h.coach.said.at(-1);
      expect(said?.kind).toBe('encourage');
      expect(said?.clip?.sentences.map((s) => s.items)).toEqual([[{ line }]]);
      game.dispose();
    }
  });
});

describe('game controller — coach silence and engine trouble', () => {
  it('bullet never blocks on the judge and says nothing during the game', async () => {
    const h = createTestHarness({ timings: { postGameJudgeTimeoutMs: 20 } });
    const game = make(h);
    h.judge.mode = 'hang';
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('bullet1'));
    const phases = recordPhases(game);
    expect(game.store.getState().hintsEnabled).toBe(false);

    expect(childPlays(game, 'e4')).toBe(true);
    await waitFor(() => game.store.getState().moves.length === 2);
    expect(childPlays(game, 'Nf3')).toBe(true);
    await waitFor(() => game.store.getState().moves.length === 4);

    expect(phases).not.toContain('judging');
    expect(phases).not.toContain('coachIntervention');
    expect(h.coach.kinds()).toEqual(['gameStart']);

    game.resign();
    await game.whenSettled();
    const state = game.store.getState();
    expect(state.ending?.stage).toBe('done');
    expect(state.ending?.save).toBe('saved');
    expect(h.coach.kinds()).toEqual(['gameStart', 'gameEnd']);
    expectValidRecord(h.saved[0] as GameRecord, 4);
  });

  it('bullet: judgements are computed in the background and missing ones after the game', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6', 'g8f6'];
    await game.start(config('bullet1'));
    await turn(game, 'e4');
    await turn(game, 'Bc4');
    await turn(game, 'Qh5');
    const stages: string[] = [];
    game.store.subscribe((s) => {
      if (s.ending && stages[stages.length - 1] !== s.ending.stage) stages.push(s.ending.stage);
    });

    await turn(game, 'Qxf7#');

    const record = h.saved[0] as GameRecord;
    expect(record.result).toBe('1-0');
    expect(record.judgements.map((j) => j.ply)).toEqual([1, 3, 5, 7]);
    expect(stages).toEqual(['analysing', 'saving', 'done']);
    expect(record.pgn).toContain('[%clk 0:0');
    expectValidRecord(record, 7);
  });

  it('judge rejection → the game continues without a judgement', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.judge.mode = 'reject';
    h.bot.replies = ['e7e5'];
    await game.start(config('rapid10'));
    const phases = recordPhases(game);

    await turn(game, 'e4');

    expect(phases).toEqual(['childTurn', 'judging', 'botThinking', 'childTurn']);
    expect(game.store.getState().moves).toHaveLength(2);
    expect(h.logs.some((l) => l.includes('could not be judged'))).toBe(true);
  });

  it('judge hang → live judging times out, the bot still answers', async () => {
    const h = createTestHarness({ timings: { judgeTimeoutMs: 25, postGameJudgeTimeoutMs: 10 } });
    const game = make(h);
    h.judge.mode = 'hang';
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('rapid10'));

    expect(childPlays(game, 'e4')).toBe(true);
    expect(game.store.getState().phase).toBe('judging');
    await waitFor(() => game.store.getState().phase === 'childTurn' && game.store.getState().moves.length === 2);
    expect(h.judge.stops).toBeGreaterThan(0);

    expect(childPlays(game, 'Nf3')).toBe(true);
    await waitFor(() => game.store.getState().moves.length === 4);
    game.resign();
    await waitFor(() => game.store.getState().ending?.stage === 'done');
    expectValidRecord(h.saved[0] as GameRecord, 4);
  });

  it('judge that cannot start at all → the game runs without checks', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.judge.readyFails = true;
    h.bot.replies = ['e7e5'];
    await game.start(config('rapid10'));
    expect(game.store.getState().judgeUnavailable).toBe(true);
    await turn(game, 'e4');
    expect(game.store.getState().moves).toHaveLength(2);
    expect(h.judge.calls).toHaveLength(0);
  });

  it('bot failure or an illegal bot move → a random legal move keeps the game going', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.mode = 'reject';
    await game.start(config('training'));
    await turn(game, 'e4');
    expect(game.store.getState().moves).toHaveLength(2);

    h.bot.mode = 'illegal';
    await turn(game, 'd4');
    const state = game.store.getState();
    expect(state.moves).toHaveLength(4);
    expect(state.phase).toBe('childTurn');
    expect(h.logs.some((l) => l.includes('not legal'))).toBe(true);
  });

  it('the child\'s move interrupts a phrase that holds the clock — the bot never waits for a hint to end', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5'];
    await game.start(config('rapid10'));

    h.coach.holdSpeech = true; // a hint (pauseClock) is still being spoken when the child moves
    await game.requestHint();
    expect(game.store.getState().clock.paused).toBe(true);
    const stopsBefore = h.coach.stopCalls;
    expect(childPlays(game, 'e4')).toBe(true);
    expect(h.coach.stopCalls).toBe(stopsBefore + 1);
    // …gently: a nearly finished sentence may end (≤ 2 s), nothing waits behind it
    expect(h.coach.stopOptions.at(-1)).toEqual({ grace: true });

    await game.whenSettled();
    expect(game.store.getState().clock.paused).toBe(false);
    expect(game.store.getState().moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect(game.store.getState().phase).toBe('childTurn');
  });

  it('chatter that holds nothing (the greeting) is NOT cut off by a quick first move', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5'];
    h.coach.holdSpeech = true; // the opening phrases are still being spoken
    await game.start(config('rapid10'));
    const stopsBefore = h.coach.stopCalls;
    expect(childPlays(game, 'e4')).toBe(true);
    expect(h.coach.stopCalls).toBe(stopsBefore);
    h.coach.holdSpeech = false;
    h.coach.releaseSpeech();
    await game.whenSettled();
    expect(game.store.getState().moves).toHaveLength(2);
  });

  it('a bot engine failure is shown on screen, not only in the console', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('training'));
    expect(game.store.getState().botUnavailable).toBe(false);
    h.bot.mode = 'reject';
    await turn(game, 'e4');
    expect(game.store.getState().botUnavailable).toBe(true);
    expect(game.store.getState().moves).toHaveLength(2);
  });

  it('a judge that could not start gets a second chance when the game ends: «посмотрю позже» comes true', async () => {
    const h = createTestHarness();
    h.judge.readyFails = true;
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    expect(game.store.getState().judgeUnavailable).toBe(true);
    await turn(game, 'e4');
    await turn(game, 'Nf3');

    h.judge.readyFails = false; // the worker came up in the meantime
    game.resign();
    await game.whenSettled();
    expect(game.store.getState().judgeUnavailable).toBe(false);
    expect((h.saved[0] as GameRecord).judgements.map((j) => j.san)).toEqual(['e4', 'Nf3']);
  });

  it('the opening phrases never freeze the bot — only the CHILD\'s clock waits for their end', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.coach.holdSpeech = true; // «gameStart» and the thinking routine are still being spoken
    h.bot.replies = ['e2e4'];
    await game.start(config('rapid10', { childColor: 'b' }));
    await waitFor(() => game.store.getState().moves.length === 1);

    expect(h.coach.kinds()).toContain('thinkingRoutine');
    expect(h.coach.said.find((e) => e.kind === 'thinkingRoutine')?.pauseClock).toBe(false);
    // the bot moved while he spoke; now it is the child's turn and his words still go on: the child's clock stands
    let state = game.store.getState();
    expect(state.phase).toBe('childTurn');
    expect(state.clock.running).toBe('b');
    expect(state.clock.paused).toBe(true);
    expect(state.clock.b).toBe(600_000);
    h.coach.releaseSpeech();
    await game.whenSettled();
    state = game.store.getState();
    expect(state.clock.paused).toBe(false);
  });
});

describe('game controller — the child\'s clock stands while Гамбитик speaks (5 and 10 minutes, any style)', () => {
  it('the start line holds only the child\'s clock; a quick move lets the bot\'s clock run; the child\'s waits for the words', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.coach.holdSpeech = true; // the start line is still being spoken
    h.bot.replies = ['e7e5'];
    h.bot.thinkMs = 60;
    await game.start(config('blitz5'));
    let state = game.store.getState();
    expect(state.clock.running).toBe('w');
    expect(state.clock.paused).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(game.store.getState().clock.w).toBe(300_000);

    // the child moves while he still speaks: nothing is cut, the BOT's clock runs as usual
    expect(childPlays(game, 'e4')).toBe(true);
    await waitFor(() => game.store.getState().phase === 'botThinking');
    state = game.store.getState();
    expect(state.clock.running).toBe('b');
    expect(state.clock.paused).toBe(false);
    await waitFor(() => game.store.getState().moves.length === 2);
    expect(game.store.getState().clock.b).toBeLessThan(300_000);

    // the child's turn again, the words go on: the child's clock stands until they end
    state = game.store.getState();
    expect(state.clock.running).toBe('w');
    expect(state.clock.paused).toBe(true);
    h.coach.releaseSpeech();
    await game.whenSettled();
    expect(game.store.getState().clock.paused).toBe(false);
  });

  it('the conversational voice speaking (an answer to the child\'s question) holds the child\'s clock, in every style', async () => {
    for (const cfg of [config('blitz5'), config('rapid10'), config('blitz5', { examMode: true }), config('blitz5', { coachStyle: 'teacher' })]) {
      const h = createTestHarness();
      const game = createGameController(h.deps);
      await game.start(cfg);
      await game.whenSettled();
      expect(game.store.getState().clock.paused, `${cfg.timeControlId} ${cfg.coachStyle ?? ''}`).toBe(false);
      h.coach.setConversation('coachSpeaking');
      expect(game.store.getState().clock.paused).toBe(true);
      const heldAt = game.store.getState().clock.w;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(game.store.getState().clock.w).toBe(heldAt);
      h.coach.setConversation('listening');
      expect(game.store.getState().clock.paused).toBe(false);
      game.dispose();
    }
  });

  it('a phrase played late, once its recording arrived («Дозапись голоса»), holds the child\'s clock while it sounds (5 and 10 minutes)', async () => {
    for (const cfg of [config('blitz5'), config('rapid10'), config('rapid10', { coachStyle: 'teacher' })]) {
      const h = createTestHarness();
      const game = make(h);
      await game.start(cfg);
      await game.whenSettled();
      expect(game.store.getState().clock.paused, cfg.timeControlId).toBe(false);
      h.coach.setLateSpeech(true);
      expect(game.store.getState().clock.paused, cfg.timeControlId).toBe(true);
      const heldAt = game.store.getState().clock.w;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(game.store.getState().clock.w).toBe(heldAt);
      h.coach.setLateSpeech(false);
      expect(game.store.getState().clock.paused).toBe(false);
      game.dispose();
    }
    // bullet: never held (the coach is silent there anyway)
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('bullet1'));
    await game.whenSettled();
    h.coach.setLateSpeech(true);
    expect(game.store.getState().clock.paused).toBe(false);
    h.coach.setLateSpeech(false);
    game.dispose();
  });

  it('the child asked and Гамбитик is looking for the answer (`thinking`): the child\'s clock stands too; the child speaking does not stop it', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('blitz5'));
    await game.whenSettled();
    h.coach.setConversation('childSpeaking'); // the child's own words are the child's time
    expect(game.store.getState().clock.paused).toBe(false);
    h.coach.setConversation('thinking');
    expect(game.store.getState().clock.paused).toBe(true);
    const heldAt = game.store.getState().clock.w;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(game.store.getState().clock.w).toBe(heldAt);
    h.coach.setConversation('coachSpeaking'); // the answer follows: still one hold
    expect(game.store.getState().clock.paused).toBe(true);
    h.coach.setConversation('listening');
    expect(game.store.getState().clock.paused).toBe(false);
    game.dispose();
  });

  it('bullet: nothing stops (the coach is silent, a 1-minute clock cannot pause); training has no clock to hold', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.coach.holdSpeech = true;
    await game.start(config('bullet1'));
    expect(game.store.getState().clock.paused).toBe(false);
    h.coach.setConversation('coachSpeaking');
    expect(game.store.getState().clock.paused).toBe(false);
    h.coach.releaseSpeech();
  });
});

describe('game controller — «Привет» when the app\'s hello was not heard (wave, then talk)', () => {
  it('the start line carries «Привет!» and waves; heard recently → no second hello; unknown → none', async () => {
    const said = async (heard: (() => boolean) | undefined, cfg: GameConfig): Promise<{ kind: string; text: string; pose: string }[]> => {
      const h = createTestHarness();
      if (heard) h.deps.helloHeard = heard;
      const game = createGameController(h.deps);
      await game.start(cfg);
      await game.whenSettled();
      game.dispose();
      return h.coach.said.map((e) => ({ kind: e.kind, text: e.text, pose: e.pose }));
    };
    const notHeard = await said(() => false, config('blitz5'));
    expect(notHeard[0]).toMatchObject({ kind: 'gameStart', pose: 'wave' });
    expect(notHeard[0]?.text).toMatch(/^Привет, Лёва!/);
    expect(notHeard[0]?.text).not.toMatch(/белыми|чёрными|твой ход/);

    const heard = await said(() => true, config('blitz5'));
    expect(heard[0]).toMatchObject({ kind: 'gameStart', pose: 'wave' });
    expect(heard[0]?.text).not.toMatch(/Привет/);

    expect((await said(undefined, config('rapid10')))[0]?.text).not.toMatch(/Привет/);
    // a watch that throws is «heard»: never a crash at the start
    expect((await said(() => { throw new Error('boom'); }, config('rapid10')))[0]?.text).not.toMatch(/Привет/);

    // bullet: he only greets and promises the talk after the game
    const bullet = await said(() => false, config('bullet1'));
    expect(bullet[0]?.text).toMatch(/^Привет.*(молч|помолчу|подсказок не будет)/);
  });

  it('«Учитель»: one «Привет!» with a wave at once — the strategy intro follows when it is ready', async () => {
    const h = createTestHarness();
    h.deps.helloHeard = () => false;
    const game = make(h);
    await game.start(config('blitz5', { coachStyle: 'teacher' }));
    await game.whenSettled();
    expect(h.coach.said[0]).toMatchObject({ kind: 'greeting', pose: 'wave' });
    expect(h.coach.said[0]?.text).toMatch(/^Привет/);
    expect(h.coach.kinds().slice(1)).toContain('teachTurn');
    expect(h.coach.kinds().filter((k) => k === 'greeting')).toHaveLength(1);
  });
});

describe('game controller — hints, praise, warnings, voice', () => {
  it('«Подсказка» walks the ladder 1→4, is journaled and resets with every move', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5'];
    await game.start(config('training'));

    for (const level of [1, 2, 3, 4]) {
      await game.requestHint();
      expect(game.store.getState().hintLevel).toBe(level);
    }
    await game.requestHint(); // stays on the last step
    expect(game.store.getState().hintLevel).toBe(4);

    const hints = h.coach.said.filter((e) => e.kind === 'hint');
    expect(hints.map((e) => e.hintLevel)).toEqual([1, 2, 3, 4, 4]);
    expect(hints.every((e) => e.priority === 2)).toBe(true);
    expect(game.store.getState().annotations?.arrows[0]?.color).toBe('green');

    await turn(game, 'e4');
    expect(game.store.getState().hintLevel).toBe(0);
    expect(game.store.getState().annotations).toBeNull();

    h.coach.pressHintButton(); // the dock's button
    await game.whenSettled();
    await waitFor(() => game.store.getState().hintLevel === 1);

    game.resign();
    await game.whenSettled();
    expect(game.store.getState().termination).toBe('abandoned');
  });

  it('hint events land in the journal with their levels', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('rapid10'));
    await game.requestHint();
    await game.requestHint();
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();

    const record = h.saved[0] as GameRecord;
    const given = record.events.filter((e) => e.type === 'hintGiven');
    expect(given.map((e) => e.data.level)).toEqual([1, 2]);
    expect(given.every((e) => e.ply === 1)).toBe(true);
    expect(record.events.filter((e) => e.type === 'hintRequested')).toHaveLength(2);
    expect(record.summary.hintsUsed).toBe(2);
    // hint phrases are journaled once (as hintGiven), not again as coachSaid
    expect(record.events.filter((e) => e.type === 'coachSaid' && e.data.kind === 'hint')).toHaveLength(0);
  });

  it('no hints in bullet and in exams', async () => {
    const h = createTestHarness();
    const game = make(h);
    await game.start(config('bullet1'));
    await game.requestHint();
    expect(h.coach.kinds()).not.toContain('hint');
    expect(game.store.getState().hintLevel).toBe(0);

    // the dock's button still exists: the coach explains kindly, once, instead of staying mute
    h.coach.pressHintButton();
    h.coach.pressHintButton();
    const answers = h.coach.said.filter((e) => e.kind === 'encourage');
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).not.toMatch(/[A-Za-z]/);
    expect(answers[0]?.pauseClock).toBe(false);
  });

  it('praises a non-obvious best move (only move) with priority 0', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.judge.scriptAfter([], [
      { cp: 300, pv: ['e2e4', 'e7e5'] },
      { cp: -300, pv: ['d2d4'] },
    ]);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('rapid10'));
    await turn(game, 'e4');

    const praise = h.coach.said.find((e) => e.kind === 'praise');
    expect(praise?.priority).toBe(0);
    expect(praise?.pauseClock).toBe(false);

    // …but an ordinary fine move right after it is not praised again
    await turn(game, 'Nf3');
    expect(h.coach.kinds().filter((k) => k === 'praise')).toHaveLength(1);
  });

  it('warns about a piece left en prise when the child keeps thinking', async () => {
    const h = createTestHarness({ timings: { threatWarningDelayMs: 15 }, profile: { stage: 3 } });
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6', 'h7h6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Qh5');
    await turn(game, 'Qg5'); // unscripted → judged as fine; the pawn now attacks the queen

    await waitFor(() => h.coach.kinds().includes('threatWarning'));
    const warning = h.coach.said.find((e) => e.kind === 'threatWarning');
    expect(warning?.board?.highlights[0]).toEqual({ square: 'g5', color: 'red' });
    expect(game.store.getState().annotations?.highlights[0]?.square).toBe('g5');
  });

  it('voice transcripts are journaled; template phrases are not duplicated', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    h.coach.hear('child', '  А почему он так пошёл?  ');
    h.coach.hear('coach', 'Он хочет занять центр.');
    const gameStart = h.coach.said.find((e) => e.kind === 'gameStart');
    h.coach.hear('coach', gameStart?.text ?? '');
    h.coach.hear('child', '   ');
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();

    const record = h.saved[0] as GameRecord;
    const child = record.events.filter((e) => e.type === 'childSaid');
    expect(child.map((e) => e.data.text)).toEqual(['А почему он так пошёл?']);
    const voiced = record.events.filter((e) => e.type === 'coachSaid' && e.data.source === 'voice');
    expect(voiced.map((e) => e.data.text)).toEqual(['Он хочет занять центр.']);
  });

  it('tool host: Russian position summary without Latin, safe board marks, hint via voice', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5'];
    await game.start(config('training'));
    await turn(game, 'e4');

    const summary = await game.toolHost.getPositionSummary();
    // colour and whose move: only as the «only if asked» reference
    expect(summary).toMatch(/Только если ребёнок сам спросит об этом: ребёнок играет белыми, идёт 2-й ход, сейчас ход ребёнка\./);
    expect(summary).not.toMatch(/[A-Za-z]/);

    game.toolHost.showOnBoard({
      arrows: [
        { from: 'e2', to: 'e4', color: 'green' },
        { from: 'z9', to: 'e4', color: 'red' },
      ],
      highlights: [{ square: 'q1', color: 'red' }],
    });
    expect(game.store.getState().annotations).toEqual({ arrows: [{ from: 'e2', to: 'e4', color: 'green' }], highlights: [] });

    // the ladder is enforced by CODE: «просто скажи ход» (level 4) still gets the first step
    const hint = await game.toolHost.getHint(4);
    expect(hint.kind).toBe('hint');
    expect(hint.hintLevel).toBe(1);
    expect(hint.board).toBeUndefined();
    expect(game.store.getState().hintLevel).toBe(1);
    expect((await game.toolHost.getHint(4)).hintLevel).toBe(2);
    expect((await game.toolHost.getHint(3)).hintLevel).toBe(3);
    // going back down the ladder is fine, skipping ahead is not
    expect((await game.toolHost.getHint(1)).hintLevel).toBe(1);
    expect(game.store.getState().hintLevel).toBe(3);
    const shown = await game.toolHost.getHint(4);
    expect(shown.hintLevel).toBe(4);
    expect(shown.board?.arrows).toHaveLength(1);
    expect(h.coach.kinds()).not.toContain('hint'); // the voice model speaks it, the game does not say it twice
    // garbage from the model never breaks the ladder
    expect((await game.toolHost.getHint(Number.NaN as unknown as 1)).hintLevel).toBe(1);

    const explained = await game.toolHost.explainLastMove();
    expect(explained?.kind).toBe('explainBest');
  });
});

describe('game controller — endings and the record', () => {
  it('checkmate by the child: win, confetti, stars, saved record', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6', 'g8f6'];
    await game.start(config('rapid10'));
    for (const san of ['e4', 'Bc4', 'Qh5']) await turn(game, san);
    await turn(game, 'Qxf7#');

    const state = game.store.getState();
    expect(state.phase).toBe('gameOver');
    expect(state.result).toBe('1-0');
    expect(state.termination).toBe('checkmate');
    expect(state.botBubble?.kind).toBe('lose');
    expect(h.sounds).toContain('win');
    expect(h.celebrations.count).toBe(1);
    expect(h.coach.toolHost).toBeNull();
    const end = h.coach.said.find((e) => e.kind === 'gameEnd');
    expect(end?.priority).toBe(2);
    expect(state.ending).toEqual({ stage: 'done', judged: 1, toJudge: 1, save: 'saved' });
    expect(state.stars).toEqual({ total: 3, finished: true, careful: true, listened: true, hintPenalty: 0 });

    const record = h.saved[0] as GameRecord;
    expect(state.savedGameId).toBe(record.id);
    expect(record.result).toBe('1-0');
    expect(record.termination).toBe('checkmate');
    expect(record.personaId).toBe('petya');
    expect(record.timeControlId).toBe('rapid10');
    expect(record.judgements).toHaveLength(4);
    expect(record.judgements[3]?.san).toBe('Qxf7#');
    expect(record.pgn).toContain('[White "Лёва"]');
    expect(record.pgn).toMatch(/\[%clk 0:(10:00|09:59)\]/); // whole seconds of a clock that ran for a few ms
    expect(record.pgn).toContain('[TimeControl "600+0"]');
    expectValidRecord(record, 7);

    // nothing moves after the end
    expect(game.dropPiece('a2', 'a3')).toBe(false);
    game.resign();
    expect(game.store.getState().termination).toBe('checkmate');
  });

  it('checkmate by the bot: loss, soft sound, no confetti', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'd8h4'];
    await game.start(config('training'));
    await turn(game, 'f3');
    await turn(game, 'g4');

    const state = game.store.getState();
    expect(state.result).toBe('0-1');
    expect(state.termination).toBe('checkmate');
    expect(state.botBubble?.kind).toBe('win');
    expect(h.sounds).toContain('lose');
    expect(h.celebrations.count).toBe(0);
    const record = h.saved[0] as GameRecord;
    expect(record.pgn).not.toContain('%clk'); // untimed
    expect(record.pgn).toContain('[TimeControl "-"]');
    expectValidRecord(record, 4);
  });

  it('stalemate is a draw', async () => {
    const h = createTestHarness();
    const game = make(h);
    // Sam Loyd's ten-move stalemate
    const white = ['e3', 'Qh5', 'Qxa5', 'h4', 'Qxc7', 'Qxd7+', 'Qxb7', 'Qxb8', 'Qxc8', 'Qe6'];
    h.bot.replies = ['a5', 'Ra6', 'h5', 'Rah6', 'f6', 'Kf7', 'Qd3', 'Qh7', 'Kg6'];
    await game.start(config('training'));
    for (const san of white) await turn(game, san);

    const state = game.store.getState();
    expect(state.phase).toBe('gameOver');
    expect(state.result).toBe('1/2-1/2');
    expect(state.termination).toBe('stalemate');
    expect(state.botBubble?.kind).toBe('draw');
    expectValidRecord(h.saved[0] as GameRecord, 19);
  });

  it('flag fall: the child loses on time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('bullet1'));
    await turn(game, 'e4');
    await vi.advanceTimersByTimeAsync(10_000);
    await turn(game, 'Nf3');
    expect(game.store.getState().clock.w).toBe(50_000);

    await vi.advanceTimersByTimeAsync(50_100);
    await game.whenSettled();

    const state = game.store.getState();
    expect(state.phase).toBe('gameOver');
    expect(state.result).toBe('0-1');
    expect(state.termination).toBe('timeout');
    expect(state.clock.w).toBe(0);
    const record = h.saved[0] as GameRecord;
    expect(record.pgn).toContain('[Termination "time forfeit"]');
    expect(record.pgn).toContain('[%clk 0:00:50]');
    expectValidRecord(record, 4);
  });

  it('resign: confirmed by the UI, the bot wins; too-short games are dropped as abandoned', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('blitz5', { childColor: 'w' }));
    await turn(game, 'e4');
    await turn(game, 'Nf3');

    game.setModalOpen(true);
    expect(game.store.getState().clock.paused).toBe(true);
    game.setModalOpen(false);
    expect(game.store.getState().clock.paused).toBe(false);

    game.resign();
    await game.whenSettled();
    const state = game.store.getState();
    expect(state.result).toBe('0-1');
    expect(state.termination).toBe('resign');
    expect(state.stars?.finished).toBe(false);
    expect(state.stars?.total).toBeGreaterThanOrEqual(0.5);
    expectValidRecord(h.saved[0] as GameRecord, 4);

    const h2 = createTestHarness();
    const early = createGameController(h2.deps);
    await early.start(config('blitz5'));
    early.resign();
    await early.whenSettled();
    expect(early.store.getState().termination).toBe('abandoned');
    expect(early.store.getState().result).toBe('*');
    expect(early.store.getState().ending).toEqual({ stage: 'done', judged: 0, toJudge: 0, save: 'skipped' });
    expect(h2.saved).toHaveLength(0);
    expect(h2.coach.kinds()).not.toContain('gameEnd');
    early.dispose();
  });

  it('server down: one retry, then the record is parked in localStorage and re-sent next game', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    h.saveFailures.remaining = Number.POSITIVE_INFINITY;
    await game.start(config('rapid10'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();

    const state = game.store.getState();
    expect(state.ending?.save).toBe('local');
    expect(state.savedGameId).not.toBeNull();
    expect(h.saved).toHaveLength(0);
    const parked = readUnsavedGames(h.storage);
    expect(parked.map((r) => r.id)).toEqual([state.savedGameId]);
    expect(h.storage.getItem(UNSAVED_GAMES_KEY)).not.toBeNull();

    // the server is back: the next game delivers the parked record first
    h.saveFailures.remaining = 0;
    const next = createGameController(h.deps);
    await next.start(config('rapid10'));
    await next.whenSettled();
    expect(h.saved.map((r) => r.id)).toEqual([state.savedGameId]);
    expect(readUnsavedGames(h.storage)).toEqual([]);
    next.dispose();
  });

  it('a single save failure is retried silently', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    h.saveFailures.remaining = 1;
    await game.start(config('rapid10'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');
    game.resign();
    await game.whenSettled();
    expect(game.store.getState().ending?.save).toBe('saved');
    expect(h.saved).toHaveLength(1);
    expect(readUnsavedGames(h.storage)).toEqual([]);
  });

  it('leaving mid-game keeps the game resumable, releases everything, and loses nothing when it is declined', async () => {
    const h = createTestHarness();
    const game = make(h);
    h.bot.replies = ['e7e5', 'b8c6'];
    await game.start(config('training'));
    await turn(game, 'e4');
    await turn(game, 'Nf3');

    game.dispose();
    await Promise.resolve();
    expect(h.judge.disposed).toBe(true);
    expect(h.bot.disposed).toBe(true);
    expect(h.coach.toolHost).toBeNull();
    expect(h.coach.hintListenerCount).toBe(0);
    // nothing is posted yet: the game waits for «Продолжить партию?» (one record per game id, ever)
    expect(h.saved).toHaveLength(0);
    expect(hasResumableGame(h.storage)).toBe(true);
    // «Новая партия» → the interrupted game goes to the journal as unfinished
    clearResumableGame(h.storage);
    expect(hasResumableGame(h.storage)).toBe(false);
    const record = readUnsavedGames(h.storage)[0] as GameRecord;
    expect(record.termination).toBe('abandoned');
    expect(record.result).toBe('*');
    expectValidRecord(record, 4);

    // a disposed game ignores everything
    expect(game.dropPiece('d2', 'd4')).toBe(false);
    game.dispose();
  });
});
