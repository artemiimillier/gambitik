import { Chess } from 'chess.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERSONA_IDS } from '@gambit/shared';
import { createBotEngine } from './botEngine.ts';
import type { BotMoveDetail } from './botEngine.ts';
import { BOT_LEVELS } from './botLevels.ts';
import { createSeededRng } from './rng.ts';
import { FakeEngine, infoLine } from './testing/fakeEngine.ts';
import { MIN_THINK_MS } from './thinkTime.ts';
import { EngineError } from './types.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATE_IN_ONE_FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const SINGLE_REPLY_FEN = '7k/8/8/8/8/8/6q1/7K w - - 0 1';
const CHECKMATE_FEN = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';

/** Eval (side to move, cp) of scripted root moves in the start position; everything else is "not in MultiPV". */
const SCRIPT: [string, number][] = [
  ['e2e4', 40],
  ['d2d4', 35],
  ['g1f3', 20],
  ['c2c4', 10],
  ['b1c3', -20],
  ['a2a4', -110],
  ['h2h4', -300],
  ['g2g4', -700],
  ['f2f3', -2600],
];
const SCRIPT_CP = new Map(SCRIPT);

function scriptedGo(ctx: { multipv: number }): string[] {
  const lines = SCRIPT.slice(0, ctx.multipv).map(([uci, cp], index) => infoLine({ depth: 3, multipv: index + 1, cp, pv: uci }));
  return [...lines, `bestmove ${SCRIPT[0]![0]}`];
}

const legalMovesOf = (fen: string): Set<string> =>
  new Set(new Chess(fen).moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`));

async function play(
  bot: ReturnType<typeof createBotEngine>,
  personaId: (typeof PERSONA_IDS)[number],
  games: number,
  fen = START_FEN,
): Promise<BotMoveDetail[]> {
  const picks: BotMoveDetail[] = [];
  for (let i = 0; i < games; i += 1) picks.push(await bot.pickMove(fen, personaId, { moveNumber: 12, remainingMs: null }));
  return picks;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('BOT_LEVELS', () => {
  it('covers the 8 personas with the verified ladder rungs in ascending strength', () => {
    expect(Object.keys(BOT_LEVELS)).toEqual([...PERSONA_IDS]);
    expect(PERSONA_IDS.map((id) => BOT_LEVELS[id].nominalElo)).toEqual([300, 500, 700, 900, 1100, 1400, 1800, 2500]);
    const samplers = PERSONA_IDS.slice(0, 7).map((id) => BOT_LEVELS[id]);
    expect(samplers.map((l) => [l.depth, l.multipv, l.pRandom, l.tempCp, l.maxLossCp])).toEqual([
      [1, 20, 0.55, 400, 2000],
      [2, 12, 0.4, 300, 1200],
      [3, 10, 0.3, 200, 900],
      [4, 8, 0.15, 150, 600],
      [5, 6, 0.07, 100, 400],
      [6, 5, 0.03, 60, 250],
      [8, 4, 0.01, 35, 150],
    ]);
    for (let i = 1; i < samplers.length; i += 1) {
      const weaker = samplers[i - 1]!;
      const stronger = samplers[i]!;
      expect(stronger.mode).toBe('sampler');
      expect(stronger.depth!).toBeGreaterThanOrEqual(weaker.depth!);
      expect(stronger.pRandom!).toBeLessThan(weaker.pRandom!);
      expect(stronger.tempCp!).toBeLessThan(weaker.tempCp!);
      expect(stronger.maxLossCp!).toBeLessThan(weaker.maxLossCp!);
    }
    expect(BOT_LEVELS.dima).toEqual({ personaId: 'dima', nominalElo: 2500, mode: 'full', movetimeMs: 1000 });
    for (const id of PERSONA_IDS) expect(BOT_LEVELS[id].personaId).toBe(id);
  });
});

describe('createBotEngine', () => {
  it('uses its own small-hash engine configuration', async () => {
    const fake = new FakeEngine();
    const bot = createBotEngine({ createTransport: fake.createTransport });
    await bot.ready();
    expect(fake.sent).toContain('setoption name Hash value 16');
    expect(fake.sent).toContain('setoption name Skill Level value 20');
    expect(fake.sent).toContain('setoption name UCI_LimitStrength value false');
    bot.dispose();
  });

  it('weak level (petya): ~55 % random legal moves, sampled moves sometimes non-best, never above maxLossCp', async () => {
    const fake = new FakeEngine(scriptedGo);
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: createSeededRng(42) });
    const legal = legalMovesOf(START_FEN);
    const picks = await play(bot, 'petya', 600);

    expect(picks.every((p) => legal.has(p.uci))).toBe(true);
    expect(picks.every((p) => p.thinkMs >= MIN_THINK_MS)).toBe(true);

    const random = picks.filter((p) => p.source === 'random');
    const sampled = picks.filter((p) => p.source === 'sampled');
    expect(random.length + sampled.length).toBe(picks.length);
    expect(random.length / picks.length).toBeGreaterThan(0.48);
    expect(random.length / picks.length).toBeLessThan(0.62);
    // Random moves are uniform over ALL legal moves, so they reach moves the engine never listed.
    expect(random.some((p) => !SCRIPT_CP.has(p.uci))).toBe(true);

    // The engine is asked exactly as the ladder prescribes.
    expect(new Set(fake.goCommands())).toEqual(new Set(['go depth 1']));
    expect(fake.sent).toContain('setoption name MultiPV value 20');

    const best = SCRIPT[0]![1];
    const nonBest = sampled.filter((p) => p.uci !== 'e2e4');
    expect(nonBest.length).toBeGreaterThan(sampled.length * 0.5);
    for (const pick of sampled) {
      const cp = SCRIPT_CP.get(pick.uci);
      expect(cp).toBeDefined();
      expect(best - cp!).toBeLessThanOrEqual(BOT_LEVELS.petya.maxLossCp!);
    }
    // f2f3 loses 2640 cp > maxLossCp 2000: only the random roll may ever play it.
    expect(sampled.some((p) => p.uci === 'f2f3')).toBe(false);
    expect(sampled.some((p) => p.uci === 'g2g4')).toBe(true);
  });

  it('strong sampler level (nika): almost never random, stays within 150 cp, mostly the best move', async () => {
    const fake = new FakeEngine(scriptedGo);
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: createSeededRng(7) });
    const picks = await play(bot, 'nika', 400);
    const sampled = picks.filter((p) => p.source === 'sampled');
    expect(sampled.length / picks.length).toBeGreaterThan(0.96);
    expect(new Set(fake.goCommands())).toEqual(new Set(['go depth 8']));
    expect(fake.sent).toContain('setoption name MultiPV value 4');
    for (const pick of sampled) expect(40 - SCRIPT_CP.get(pick.uci)!).toBeLessThanOrEqual(150);
    const bestShare = sampled.filter((p) => p.uci === 'e2e4').length / sampled.length;
    const petyaLikeShare = 1 / 8;
    expect(bestShare).toBeGreaterThan(petyaLikeShare * 2);
  });

  it('weaker personas deviate from the best move more often than stronger ones', async () => {
    const share = async (personaId: (typeof PERSONA_IDS)[number]): Promise<number> => {
      const fake = new FakeEngine(scriptedGo);
      const bot = createBotEngine({ createTransport: fake.createTransport, rng: createSeededRng(99) });
      const picks = await play(bot, personaId, 300);
      return picks.filter((p) => p.uci === 'e2e4').length / picks.length;
    };
    const petya = await share('petya');
    const sasha = await share('sasha');
    const nika = await share('nika');
    expect(petya).toBeLessThan(sasha);
    expect(sasha).toBeLessThan(nika);
  });

  it('plays a found mate whenever it thinks, but the random roll may still miss it (weak bots stay weak)', async () => {
    const fake = new FakeEngine((ctx) => [
      infoLine({ depth: 1, multipv: 1, mate: 1, pv: 'a1a8' }),
      ...(ctx.multipv > 1 ? [infoLine({ depth: 1, multipv: 2, cp: 620, pv: 'a1a7' }), infoLine({ depth: 1, multipv: 3, cp: 600, pv: 'g2g3' })] : []),
      'bestmove a1a8',
    ]);
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: createSeededRng(5) });
    const picks = await play(bot, 'petya', 200, MATE_IN_ONE_FEN);
    expect(picks.filter((p) => p.source === 'sampled').every((p) => p.uci === 'a1a8')).toBe(true);
    expect(picks.some((p) => p.source === 'random' && p.uci !== 'a1a8')).toBe(true);
  });

  it('illegal bestmove / illegal lines → legal fallback move, the game never hangs', async () => {
    const fake = new FakeEngine(() => [infoLine({ depth: 4, cp: 50, pv: 'e7e5 g1f3' }), 'bestmove e7e5 ponder g1f3']);
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: () => 0.99 });
    const pick = await bot.pickMove(START_FEN, 'lyova', { moveNumber: 20, remainingMs: 120_000 });
    expect(pick.source).toBe('fallback');
    expect(legalMovesOf(START_FEN).has(pick.uci)).toBe(true);
  });

  it('keeps a legal bestmove when the MultiPV lines are unusable', async () => {
    const fake = new FakeEngine(() => ['bestmove d2d4']);
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: () => 0.99 });
    const pick = await bot.pickMove(START_FEN, 'vika', { moveNumber: 20, remainingMs: null });
    expect(pick).toMatchObject({ uci: 'd2d4', source: 'best' });
  });

  it('CRITICAL ERROR: one retry on a fresh worker, then a legal fallback', async () => {
    const fake = new FakeEngine(scriptedGo);
    fake.onPosition = () => ['info string CRITICAL ERROR: Command `` failed. Reason: whatever'];
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: () => 0.99 });
    const pick = await bot.pickMove(START_FEN, 'sasha', { moveNumber: 20, remainingMs: null });
    expect(pick.source).toBe('fallback');
    expect(legalMovesOf(START_FEN).has(pick.uci)).toBe(true);
    expect(fake.goCommands()).toHaveLength(2);
    expect(fake.created).toBe(2);

    // The engine recovers for the next move.
    fake.onPosition = () => [];
    const next = await bot.pickMove(START_FEN, 'sasha', { moveNumber: 21, remainingMs: null });
    expect(next.source).toBe('sampled');
  });

  it('hung engine: the watchdog fires and a legal fallback is returned', async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine(() => 'hang');
    fake.ignoreStop = true;
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: () => 0.99, now: () => Date.now() });
    const pending = bot.pickMove(START_FEN, 'grisha', { moveNumber: 20, remainingMs: null });
    await vi.advanceTimersByTimeAsync(4_001);
    const pick = await pending;
    expect(pick.source).toBe('fallback');
    expect(legalMovesOf(START_FEN).has(pick.uci)).toBe(true);
    // thinkMs "already includes search time".
    expect(pick.searchMs).toBeGreaterThanOrEqual(4_000);
    expect(pick.thinkMs).toBeGreaterThanOrEqual(pick.searchMs);
  });

  it('engine that cannot even start: still returns a legal move', async () => {
    const bot = createBotEngine({
      createTransport: () => {
        throw new Error('Worker is not defined');
      },
      rng: () => 0.99,
    });
    const pick = await bot.pickMove(START_FEN, 'nika', { moveNumber: 3, remainingMs: 60_000 });
    expect(pick.source).toBe('fallback');
    expect(legalMovesOf(START_FEN).has(pick.uci)).toBe(true);
  });

  it('plays a forced move without consulting the engine', async () => {
    const fake = new FakeEngine(scriptedGo);
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: createSeededRng(1) });
    const pick = await bot.pickMove(SINGLE_REPLY_FEN, 'dima', { moveNumber: 40, remainingMs: 200_000 });
    expect(pick).toMatchObject({ uci: 'h1g2', source: 'forced' });
    expect(pick.thinkMs).toBeGreaterThanOrEqual(MIN_THINK_MS);
    expect(pick.thinkMs).toBeLessThanOrEqual(MIN_THINK_MS + 300);
    expect(fake.goCommands()).toEqual([]);
  });

  it("full mode (dima): go movetime, scaled down on a low clock, opening variety within 15 cp", async () => {
    const fake = new FakeEngine(scriptedGo);
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: createSeededRng(3) });

    const untimed = await bot.pickMove(START_FEN, 'dima', { moveNumber: 20, remainingMs: null });
    expect(untimed).toMatchObject({ uci: 'e2e4', source: 'best' });
    expect(fake.goCommands().at(-1)).toBe('go movetime 1000');
    expect(fake.sent).toContain('setoption name MultiPV value 1');

    await bot.pickMove(START_FEN, 'dima', { moveNumber: 20, remainingMs: 8_000 });
    expect(fake.goCommands().at(-1)).toBe('go movetime 100');
    await bot.pickMove(START_FEN, 'dima', { moveNumber: 20, remainingMs: 1_000 });
    expect(fake.goCommands().at(-1)).toBe('go movetime 80');

    const openingPicks = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      openingPicks.add((await bot.pickMove(START_FEN, 'dima', { moveNumber: 2, remainingMs: null })).uci);
    }
    expect(fake.sent).toContain('setoption name MultiPV value 3');
    // e2e4 (+40) and d2d4 (+35) are within 15 cp; g1f3 (+20) is not.
    expect(openingPicks).toEqual(new Set(['e2e4', 'd2d4']));
  });

  it('clears the hash at the start of a new game (ucinewgame), but not on a fresh engine', async () => {
    const fake = new FakeEngine(scriptedGo);
    const bot = createBotEngine({ createTransport: fake.createTransport, rng: () => 0.99 });
    await bot.pickMove(START_FEN, 'vika', { moveNumber: 1, remainingMs: null });
    expect(fake.sent).not.toContain('ucinewgame');
    await bot.pickMove(START_FEN, 'vika', { moveNumber: 1, remainingMs: null });
    expect(fake.sent.filter((cmd) => cmd === 'ucinewgame')).toHaveLength(1);
    expect(fake.sent.indexOf('ucinewgame')).toBeLessThan(fake.sent.lastIndexOf('go depth 5'));
  });

  it('thinks faster in bullet / on a low clock than in an untimed game', async () => {
    const average = async (remainingMs: number | null): Promise<number> => {
      const fake = new FakeEngine(scriptedGo);
      const bot = createBotEngine({ createTransport: fake.createTransport, rng: createSeededRng(11) });
      let total = 0;
      for (let i = 0; i < 100; i += 1) total += (await bot.pickMove(START_FEN, 'sasha', { moveNumber: 15, remainingMs })).thinkMs;
      return total / 100;
    };
    const untimed = await average(null);
    const bullet = await average(45_000);
    const flagging = await average(3_000);
    expect(bullet).toBeLessThan(untimed);
    expect(flagging).toBeLessThanOrEqual(bullet);
    expect(flagging).toBeGreaterThanOrEqual(MIN_THINK_MS);
  });

  it('rejects positions that cannot be played', async () => {
    const fake = new FakeEngine(scriptedGo);
    const bot = createBotEngine({ createTransport: fake.createTransport });
    await expect(bot.pickMove('garbage', 'petya', { moveNumber: 1, remainingMs: null })).rejects.toMatchObject({ code: 'invalid-fen' });
    await expect(bot.pickMove(CHECKMATE_FEN, 'petya', { moveNumber: 3, remainingMs: null })).rejects.toMatchObject({ code: 'no-legal-moves' });
    bot.dispose();
    await expect(bot.pickMove(START_FEN, 'petya', { moveNumber: 1, remainingMs: null })).rejects.toBeInstanceOf(EngineError);
  });
});
