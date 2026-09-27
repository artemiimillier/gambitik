import { describe, expect, it } from 'vitest';
import { createJudgeEngine } from './judgeEngine.ts';
import { FakeEngine, infoLine } from './testing/fakeEngine.ts';
import { EngineError } from './types.ts';
import type { EngineErrorCode } from './types.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const CHECKMATE_FEN = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
const STALEMATE_FEN = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';

async function expectCode(promise: Promise<unknown>, code: EngineErrorCode): Promise<EngineError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EngineError);
  expect((error as EngineError).code).toBe(code);
  return error as EngineError;
}

describe('createJudgeEngine', () => {
  it('configures a full-strength engine: Hash 64, Skill 20, no strength limit, no WDL', async () => {
    const fake = new FakeEngine();
    const judge = createJudgeEngine({ createTransport: fake.createTransport });
    await judge.ready();
    expect(fake.sent).toEqual([
      'uci',
      'setoption name Threads value 1',
      'setoption name Hash value 64',
      'setoption name Skill Level value 20',
      'setoption name UCI_LimitStrength value false',
      'setoption name UCI_ShowWDL value false',
      'isready',
    ]);
    judge.dispose();
  });

  it('maps AnalyzeOptions onto MultiPV + go and returns an AnalysisResult', async () => {
    const fake = new FakeEngine(() => [
      infoLine({ depth: 12, multipv: 1, cp: 35, pv: 'e2e4 e7e5 g1f3' }),
      infoLine({ depth: 12, multipv: 2, cp: 30, pv: 'd2d4 d7d5' }),
      infoLine({ depth: 12, multipv: 3, cp: -5, pv: 'g1f3 d7d5' }),
      'bestmove e2e4 ponder e7e5',
    ]);
    const judge = createJudgeEngine({ createTransport: fake.createTransport });
    const result = await judge.analyze(START_FEN, { depth: 12, movetimeMs: 300, multipv: 3 });
    expect(fake.sent.slice(-3)).toEqual([
      'setoption name MultiPV value 3',
      `position fen ${START_FEN}`,
      'go depth 12 movetime 300',
    ]);
    expect(result.fen).toBe(START_FEN);
    expect(result.bestmove).toBe('e2e4');
    expect(result.depth).toBe(12);
    expect(result.lines.map((line) => [line.multipv, line.cp, line.pvUci[0]])).toEqual([
      [1, 35, 'e2e4'],
      [2, 30, 'd2d4'],
      [3, -5, 'g1f3'],
    ]);
    expect(result.timeMs).toBeGreaterThanOrEqual(0);
  });

  it('supports nodes and searchmoves (the played move only)', async () => {
    const fake = new FakeEngine(() => [infoLine({ depth: 14, cp: -310, pv: 'g2g4 d7d5' }), 'bestmove g2g4']);
    const judge = createJudgeEngine({ createTransport: fake.createTransport });
    const result = await judge.analyze(START_FEN, { nodes: 20_000, searchmoves: ['g2g4'] });
    expect(fake.goCommands()).toEqual(['go nodes 20000 searchmoves g2g4']);
    expect(result.lines[0]).toEqual({ multipv: 1, depth: 14, cp: -310, mate: null, pvUci: ['g2g4', 'd7d5'] });
  });

  it('never sends an invalid FEN or illegal searchmoves to the engine', async () => {
    const fake = new FakeEngine();
    const judge = createJudgeEngine({ createTransport: fake.createTransport });
    await expectCode(judge.analyze('8/8/8/8/8/8/8/8 w - - 0 1', { depth: 10 }), 'invalid-fen');
    await expectCode(judge.analyze('not a fen', { depth: 10 }), 'invalid-fen');
    await expectCode(judge.analyze(START_FEN, { depth: 10, searchmoves: ['e2e5'] }), 'invalid-searchmoves');
    expect(fake.sent).toEqual([]);
  });

  it('rejects terminal positions without touching the engine', async () => {
    const fake = new FakeEngine();
    const judge = createJudgeEngine({ createTransport: fake.createTransport });
    const mate = await expectCode(judge.analyze(CHECKMATE_FEN, { depth: 10 }), 'no-legal-moves');
    expect(mate.message).toContain('checkmate');
    const stalemate = await expectCode(judge.analyze(STALEMATE_FEN, { depth: 10 }), 'no-legal-moves');
    expect(stalemate.message).toContain('stalemate');
    expect(fake.goCommands()).toEqual([]);
  });

  it('rejects when the engine answers for a different position (illegal bestmove)', async () => {
    const fake = new FakeEngine(() => [infoLine({ depth: 5, cp: 20, pv: 'e7e5' }), 'bestmove e7e5']);
    const judge = createJudgeEngine({ createTransport: fake.createTransport });
    await expectCode(judge.analyze(START_FEN, { depth: 5 }), 'critical-error');
  });

  it('stop() supersedes the running analysis; the partial lines stay available on the error', async () => {
    const fake = new FakeEngine(() => 'hang');
    const judge = createJudgeEngine({ createTransport: fake.createTransport });
    const progress: string[] = [];
    const outcome = expectCode(
      judge.analyze(START_FEN, { depth: 22, multipv: 3, onProgress: (lines) => progress.push(lines[0]?.pvUci[0] ?? '') }),
      'stopped',
    );
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    fake.emit([infoLine({ depth: 15, multipv: 1, cp: 28, pv: 'e2e4 e7e5' })]);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    judge.stop();
    const error = await outcome;
    expect(error.partial?.lines[0]).toMatchObject({ depth: 15, cp: 28 });
    expect(progress).toEqual(['e2e4']);
    judge.dispose();
  });
});
