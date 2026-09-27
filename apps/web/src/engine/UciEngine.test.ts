import { afterEach, describe, expect, it, vi } from 'vitest';
import { UciEngine, buildGoCommand, buildPositionCommand } from './UciEngine.ts';
import { FakeEngine, infoLine } from './testing/fakeEngine.ts';
import { EngineError } from './types.ts';
import type { EngineErrorCode } from './types.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

async function expectCode(promise: Promise<unknown>, code: EngineErrorCode): Promise<EngineError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EngineError);
  expect((error as EngineError).code).toBe(code);
  return error as EngineError;
}

/** Lets queued microtasks (fake engine output, promise chains) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('command builders', () => {
  it('builds go commands with combined limits and searchmoves last', () => {
    expect(buildGoCommand({ depth: 12 })).toBe('go depth 12');
    expect(buildGoCommand({ movetimeMs: 300 })).toBe('go movetime 300');
    expect(buildGoCommand({ nodes: 50_000 })).toBe('go nodes 50000');
    expect(buildGoCommand({ depth: 12, movetimeMs: 300, nodes: 9 })).toBe('go depth 12 movetime 300 nodes 9');
    expect(buildGoCommand({ depth: 14, searchmoves: ['g1f3', 'e7e8q'] })).toBe('go depth 14 searchmoves g1f3 e7e8q');
    expect(buildGoCommand({})).toBe('go depth 12');
    expect(buildGoCommand({ depth: 0, movetimeMs: -5 }, 9)).toBe('go depth 9');
  });

  it('rejects malformed searchmoves', () => {
    expect(() => buildGoCommand({ depth: 5, searchmoves: ['Nf3'] })).toThrowError(EngineError);
  });

  it('normalises whitespace so a FEN cannot inject commands', () => {
    expect(buildPositionCommand({ fen: `${START_FEN}\nquit` })).toBe(`position fen ${START_FEN} quit`);
    expect(buildPositionCommand({ fen: START_FEN, moves: ['e2e4', 'e7e5'] })).toBe(`position fen ${START_FEN} moves e2e4 e7e5`);
  });
});

describe('UciEngine', () => {
  it('performs the uci / isready handshake and applies options before isready', async () => {
    const fake = new FakeEngine();
    const engine = new UciEngine({ createTransport: fake.createTransport, options: { Hash: 64, 'Skill Level': 20, UCI_ShowWDL: false } });
    await engine.ready();
    expect(fake.sent).toEqual([
      'uci',
      'setoption name Hash value 64',
      'setoption name Skill Level value 20',
      'setoption name UCI_ShowWDL value false',
      'isready',
    ]);
    await engine.ready();
    expect(fake.created).toBe(1);
    engine.dispose();
    expect(fake.terminated).toBe(1);
  });

  it('parses cp / mate / multipv / negative scores into EngineLine[] keeping the deepest line per multipv', async () => {
    const fake = new FakeEngine(() => [
      'info string NNUE evaluation using nn-61e7af4bb97d.nnue (1MiB, (768, 1024, 32, 32, 1))',
      infoLine({ depth: 9, multipv: 1, cp: 31, pv: 'e2e4 e7e5' }),
      infoLine({ depth: 9, multipv: 2, cp: -12, pv: 'a2a4 e7e5' }),
      infoLine({ depth: 9, multipv: 3, mate: -4, pv: 'g2g4 e7e5 f2f3 d8h4' }),
      infoLine({ depth: 10, multipv: 1, mate: 3, pv: 'd1h5 g8f6 h5f7' }),
      infoLine({ depth: 10, multipv: 2, cp: -40, pv: 'a2a4 d7d5' }),
      infoLine({ depth: 11, multipv: 1, cp: 500, pv: 'd1h5', bound: 'lowerbound' }),
      'bestmove d1h5 ponder g8f6',
    ]);
    const engine = new UciEngine({ createTransport: fake.createTransport });
    const progress: number[] = [];
    const result = await engine.search({ fen: START_FEN, depth: 11, multipv: 3, onInfo: (lines) => progress.push(lines.length) });

    expect(result.bestmove).toBe('d1h5');
    expect(result.ponder).toBe('g8f6');
    expect(result.depth).toBe(10);
    expect(result.fen).toBe(START_FEN);
    expect(result.lines).toEqual([
      { multipv: 1, depth: 10, cp: null, mate: 3, pvUci: ['d1h5', 'g8f6', 'h5f7'] },
      { multipv: 2, depth: 10, cp: -40, mate: null, pvUci: ['a2a4', 'd7d5'] },
      { multipv: 3, depth: 9, cp: null, mate: -4, pvUci: ['g2g4', 'e7e5', 'f2f3', 'd8h4'] },
    ]);
    expect(progress).toEqual([1, 2, 3, 3, 3]);
    expect(fake.sent.slice(-3)).toEqual(['setoption name MultiPV value 3', `position fen ${START_FEN}`, 'go depth 11']);
  });

  it('sends searchmoves as the last go tokens', async () => {
    const fake = new FakeEngine(() => [infoLine({ depth: 8, cp: -80, pv: 'g1f3 d7d5' }), 'bestmove g1f3']);
    const engine = new UciEngine({ createTransport: fake.createTransport });
    await engine.search({ fen: START_FEN, depth: 8, movetimeMs: 250, searchmoves: ['g1f3', 'b1c3'] });
    expect(fake.goCommands()).toEqual(['go depth 8 movetime 250 searchmoves g1f3 b1c3']);
  });

  it('serialises searches: the second go is sent only after the first bestmove', async () => {
    const fake = new FakeEngine(() => 'hang');
    const engine = new UciEngine({ createTransport: fake.createTransport });
    const first = engine.search({ fen: START_FEN, depth: 5 });
    const second = engine.search({ fen: START_FEN, depth: 6 });
    await flush();
    expect(fake.goCommands()).toEqual(['go depth 5']);

    fake.emit([infoLine({ depth: 5, cp: 10, pv: 'e2e4' }), 'bestmove e2e4']);
    await expect(first).resolves.toMatchObject({ bestmove: 'e2e4' });
    await flush();
    expect(fake.goCommands()).toEqual(['go depth 5', 'go depth 6']);

    fake.emit([infoLine({ depth: 6, cp: 12, pv: 'd2d4' }), 'bestmove d2d4']);
    await expect(second).resolves.toMatchObject({ bestmove: 'd2d4', depth: 6 });
    engine.dispose();
  });

  it('rejects on CRITICAL ERROR even though the engine still prints a bestmove, then recreates the worker', async () => {
    const fake = new FakeEngine(() => [infoLine({ depth: 3, cp: 15, pv: 'e2e4 e7e5' }), 'bestmove e2e4 ponder e7e5']);
    fake.onPosition = (command) =>
      command.includes('moves e2e5') ? ['info string CRITICAL ERROR: Command `` failed. Reason: Illegal move: e2e5'] : [];
    const engine = new UciEngine({ createTransport: fake.createTransport });

    const error = await expectCode(engine.search({ fen: START_FEN, moves: ['e2e5'], depth: 3 }), 'critical-error');
    expect(error.message).toContain('Illegal move: e2e5');
    expect(fake.terminated).toBe(1);

    // The next search runs on a brand-new worker (fresh handshake) and works.
    const result = await engine.search({ fen: START_FEN, depth: 3 });
    expect(result.bestmove).toBe('e2e4');
    expect(fake.created).toBe(2);
    expect(fake.terminated).toBe(1);
    expect(engine.restartCount).toBe(1);
    expect(fake.sent.filter((cmd) => cmd === 'uci')).toHaveLength(2);
  });

  it('CRITICAL ERROR with a go that is never answered (real worker behaviour): rejects at once, no watchdog wait', async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine(() => 'hang');
    fake.ignoreStop = true;
    fake.onPosition = () => ['info string CRITICAL ERROR: Command `` failed. Reason: Unsupported position.'];
    const engine = new UciEngine({ createTransport: fake.createTransport });
    const outcome = expectCode(engine.search({ fen: START_FEN, depth: 12 }), 'critical-error');
    await vi.advanceTimersByTimeAsync(0);
    await outcome;
    expect(fake.terminated).toBe(1);

    fake.onPosition = () => [];
    fake.onGo = () => ['bestmove g1f3'];
    const next = engine.search({ fen: START_FEN, depth: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(next).resolves.toMatchObject({ bestmove: 'g1f3' });
    expect(engine.restartCount).toBe(1);
  });

  it('a CRITICAL ERROR outside a search (bad option) recycles the worker before the next search', async () => {
    const fake = new FakeEngine(() => ['bestmove e2e4']);
    const engine = new UciEngine({ createTransport: fake.createTransport });
    await engine.ready();
    fake.emit(['info string CRITICAL ERROR: Command `` failed. Reason: bad option']);
    await flush();
    expect(fake.terminated).toBe(0);
    await engine.search({ fen: START_FEN, depth: 1 });
    expect(fake.created).toBe(2);
    expect(engine.restartCount).toBe(1);
  });

  it('rejects "bestmove (none)"', async () => {
    const fake = new FakeEngine(() => ['info depth 0 score mate 0', 'bestmove (none)']);
    const engine = new UciEngine({ createTransport: fake.createTransport });
    await expectCode(engine.search({ fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', depth: 5 }), 'no-move');
    expect(engine.restartCount).toBe(0);
  });

  it('watchdog: rejects with the partial lines, kills the hung worker and recovers on the next search', async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine(() => 'hang');
    fake.ignoreStop = true;
    const engine = new UciEngine({ createTransport: fake.createTransport, movetimeGraceMs: 1_000 });
    const pending = engine.search({ fen: START_FEN, movetimeMs: 500 });
    const outcome = expectCode(pending, 'timeout');
    await flush();
    fake.emit([infoLine({ depth: 4, cp: 22, pv: 'e2e4 e7e5' })]);
    await flush();

    await vi.advanceTimersByTimeAsync(1_499);
    expect(fake.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    const error = await outcome;
    expect(error.partial?.lines[0]?.pvUci[0]).toBe('e2e4');
    expect(fake.terminated).toBe(1);

    fake.onGo = () => [infoLine({ depth: 2, cp: 5, pv: 'd2d4' }), 'bestmove d2d4'];
    const next = engine.search({ fen: START_FEN, depth: 2 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(next).resolves.toMatchObject({ bestmove: 'd2d4' });
    expect(fake.created).toBe(2);
    expect(engine.restartCount).toBe(1);
  });

  it('uses the explicit watchdogMs when given', async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine(() => 'hang');
    fake.ignoreStop = true;
    const engine = new UciEngine({ createTransport: fake.createTransport });
    const outcome = expectCode(engine.search({ fen: START_FEN, depth: 30, watchdogMs: 700 }), 'timeout');
    await flush();
    await vi.advanceTimersByTimeAsync(701);
    await outcome;
  });

  it('stop() rejects the running search at once (with partial lines) and short-circuits queued ones', async () => {
    const fake = new FakeEngine(() => 'hang');
    fake.stopReply = ['bestmove e2e4'];
    const engine = new UciEngine({ createTransport: fake.createTransport });
    const running = engine.search({ fen: START_FEN, depth: 30, multipv: 2 });
    const queued = engine.search({ fen: START_FEN, depth: 31 });
    const runningOutcome = expectCode(running, 'stopped');
    const queuedOutcome = expectCode(queued, 'stopped');
    await flush();
    fake.emit([infoLine({ depth: 7, multipv: 1, cp: 18, pv: 'e2e4 e7e5' }), infoLine({ depth: 7, multipv: 2, cp: 9, pv: 'd2d4 d7d5' })]);
    await flush();

    engine.stop();
    const error = await runningOutcome;
    await queuedOutcome;
    expect(error.partial?.lines.map((line) => line.pvUci[0])).toEqual(['e2e4', 'd2d4']);
    expect(error.partial?.bestmove).toBe('e2e4');
    expect(fake.sent).toContain('stop');
    // The superseded request never reached the engine.
    expect(fake.goCommands()).toEqual(['go depth 30']);

    // The stale bestmove of the stopped search must not leak into the next one.
    await flush();
    fake.onGo = () => [infoLine({ depth: 3, cp: 1, pv: 'c2c4' }), 'bestmove c2c4'];
    await expect(engine.search({ fen: START_FEN, depth: 3 })).resolves.toMatchObject({ bestmove: 'c2c4' });
    expect(fake.created).toBe(1);
    expect(engine.restartCount).toBe(0);
  });

  it('a search requested right after stop() waits for the stale bestmove and then runs normally', async () => {
    const fake = new FakeEngine(() => 'hang');
    const engine = new UciEngine({ createTransport: fake.createTransport });
    const first = expectCode(engine.search({ fen: START_FEN, depth: 30 }), 'stopped');
    await flush();
    engine.stop();
    fake.onGo = () => [infoLine({ depth: 4, cp: 7, pv: 'g1f3' }), 'bestmove g1f3'];
    const second = engine.search({ fen: START_FEN, depth: 4 });
    await first;
    await expect(second).resolves.toMatchObject({ bestmove: 'g1f3' });
    expect(fake.goCommands()).toEqual(['go depth 30', 'go depth 4']);
  });

  it('recycles a worker that ignores stop', async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine(() => 'hang');
    fake.ignoreStop = true;
    const engine = new UciEngine({ createTransport: fake.createTransport, stopTimeoutMs: 300 });
    const outcome = expectCode(engine.search({ fen: START_FEN, depth: 30 }), 'stopped');
    await flush();
    engine.stop();
    await outcome;
    expect(fake.terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(301);
    expect(fake.terminated).toBe(1);

    fake.onGo = () => ['bestmove b1c3'];
    const next = engine.search({ fen: START_FEN, depth: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(next).resolves.toMatchObject({ bestmove: 'b1c3', lines: [] });
    expect(fake.created).toBe(2);
  });

  it('rejects the running search when the worker crashes and restarts for the next one', async () => {
    const fake = new FakeEngine(() => 'hang');
    const engine = new UciEngine({ createTransport: fake.createTransport });
    const outcome = expectCode(engine.search({ fen: START_FEN, depth: 9 }), 'worker-error');
    await flush();
    fake.crash('wasm out of memory');
    const error = await outcome;
    expect(error.message).toContain('wasm out of memory');

    fake.onGo = () => ['bestmove e2e4'];
    await expect(engine.search({ fen: START_FEN, depth: 1 })).resolves.toMatchObject({ bestmove: 'e2e4' });
    expect(fake.created).toBe(2);
  });

  it('fails the handshake with init-failed and retries with a new worker later', async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine();
    fake.silentHandshake = true;
    const engine = new UciEngine({ createTransport: fake.createTransport, handshakeTimeoutMs: 1_000 });
    const outcome = expectCode(engine.ready(), 'init-failed');
    await vi.advanceTimersByTimeAsync(1_001);
    await outcome;
    expect(fake.terminated).toBe(1);

    fake.silentHandshake = false;
    const ready = engine.ready();
    await vi.advanceTimersByTimeAsync(0);
    await expect(ready).resolves.toBeUndefined();
    expect(fake.created).toBe(2);
  });

  it('reports init-failed when the transport cannot be created (e.g. no Worker)', async () => {
    const engine = new UciEngine({
      createTransport: () => {
        throw new Error('Worker is not defined');
      },
    });
    await expectCode(engine.search({ fen: START_FEN, depth: 1 }), 'init-failed');
  });

  it('setOption is applied between searches and re-applied after a restart', async () => {
    const fake = new FakeEngine(() => ['bestmove e2e4']);
    const engine = new UciEngine({ createTransport: fake.createTransport, options: { Hash: 16 } });
    await engine.ready();
    await engine.setOption('Hash', 32);
    expect(fake.sent.slice(-2)).toEqual(['setoption name Hash value 32', 'isready']);

    fake.onPosition = () => ['info string CRITICAL ERROR: broken'];
    await expectCode(engine.search({ fen: START_FEN, depth: 1 }), 'critical-error');
    fake.onPosition = () => [];
    await engine.search({ fen: START_FEN, depth: 1 });
    const secondHandshake = fake.sent.slice(fake.sent.lastIndexOf('uci'));
    expect(secondHandshake.slice(0, 3)).toEqual(['uci', 'setoption name Hash value 32', 'isready']);
  });

  it('newGame sends ucinewgame and waits for readyok', async () => {
    const fake = new FakeEngine();
    const engine = new UciEngine({ createTransport: fake.createTransport });
    await engine.newGame();
    expect(fake.sent.slice(-2)).toEqual(['ucinewgame', 'isready']);
  });

  it('dispose rejects everything that is pending and refuses new work', async () => {
    const fake = new FakeEngine(() => 'hang');
    const engine = new UciEngine({ createTransport: fake.createTransport });
    const running = expectCode(engine.search({ fen: START_FEN, depth: 20 }), 'disposed');
    const queued = expectCode(engine.search({ fen: START_FEN, depth: 21 }), 'disposed');
    await flush();
    engine.dispose();
    await running;
    await queued;
    await expectCode(engine.search({ fen: START_FEN, depth: 1 }), 'disposed');
    await expectCode(engine.ready(), 'disposed');
    expect(fake.terminated).toBe(1);
  });
});
