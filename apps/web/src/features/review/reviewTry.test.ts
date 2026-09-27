import { describe, expect, it, vi } from 'vitest';
import type { AnalysisResult, IJudgeEngine, MoveJudgement } from '@gambit/shared';
import { createTryEvaluator } from './reviewTry.ts';
import { FEN_MOVE3, judgementOf } from './testFixtures.ts';

function fakeEngine(overrides: Partial<IJudgeEngine> = {}): IJudgeEngine & { stopped: number; disposed: number } {
  const engine = {
    stopped: 0,
    disposed: 0,
    ready: () => Promise.resolve(),
    analyze: (fen: string): Promise<AnalysisResult> => Promise.resolve({ fen, lines: [], bestmove: 'f1c4', depth: 12, timeMs: 5 }),
    stop() {
      engine.stopped += 1;
    },
    dispose() {
      engine.disposed += 1;
    },
    ...overrides,
  };
  return engine;
}

const goodTry: MoveJudgement = { ...judgementOf(FEN_MOVE3, 'Nf3', 'Bc4', 'best', 5), winPctLoss: 1.5, winPctAfter: 50.5, classification: 'excellent' };

describe('createTryEvaluator', () => {
  it('judges a try with the judge engine, created lazily and only once', async () => {
    const engine = fakeEngine();
    const createEngine = vi.fn(() => engine);
    const judge = vi.fn(() => Promise.resolve(goodTry));
    const evaluator = createTryEvaluator({ createEngine, judge });
    expect(createEngine).not.toHaveBeenCalled();

    await expect(evaluator.evaluate(FEN_MOVE3, 'g1f3')).resolves.toEqual({ winPctLoss: 1.5, winPctAfter: 50.5, classification: 'excellent' });
    await evaluator.evaluate(FEN_MOVE3, 'b1c3');
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenLastCalledWith(engine, expect.objectContaining({ fenBefore: FEN_MOVE3, uci: 'b1c3' }));
  });

  it('hands the background analysis of the task position to judgeMove as its cache', async () => {
    const analysis: AnalysisResult = { fen: FEN_MOVE3, lines: [{ multipv: 1, depth: 12, cp: 30, mate: null, pvUci: ['f1c4'] }], bestmove: 'f1c4', depth: 12, timeMs: 9 };
    const engine = fakeEngine({ analyze: () => Promise.resolve(analysis) });
    const judge = vi.fn(() => Promise.resolve(goodTry));
    const evaluator = createTryEvaluator({ createEngine: () => engine, judge });
    evaluator.prepare(FEN_MOVE3);
    await evaluator.evaluate(FEN_MOVE3, 'g1f3');
    expect(judge).toHaveBeenCalledWith(engine, expect.objectContaining({ cachedBefore: analysis }));
  });

  it('answers null — never rejects — when the engine is missing, broken or throws on the move', async () => {
    const noEngine = createTryEvaluator({ createEngine: () => Promise.reject(new Error('no Worker')) });
    await expect(noEngine.evaluate(FEN_MOVE3, 'g1f3')).resolves.toBeNull();

    const neverReady = createTryEvaluator({ createEngine: () => fakeEngine({ ready: () => Promise.reject(new Error('wasm failed')) }) });
    await expect(neverReady.evaluate(FEN_MOVE3, 'g1f3')).resolves.toBeNull();

    const failingJudge = createTryEvaluator({ createEngine: () => fakeEngine(), judge: () => Promise.reject(new Error('CRITICAL ERROR')) });
    await expect(failingJudge.evaluate(FEN_MOVE3, 'g1f3')).resolves.toBeNull();
  });

  it('gives up after the timeout, stops the search and lets the fallback answer', async () => {
    const engine = fakeEngine();
    let fire: (() => void) | null = null;
    const evaluator = createTryEvaluator({
      createEngine: () => engine,
      judge: () => new Promise<MoveJudgement>(() => undefined), // an engine that never answers
      timeoutMs: 6000,
      setTimer: (callback) => {
        fire = callback;
        return 1;
      },
      clearTimer: () => undefined,
    });
    const pending = evaluator.evaluate(FEN_MOVE3, 'g1f3');
    await Promise.resolve();
    await Promise.resolve();
    expect(fire).not.toBeNull();
    (fire as unknown as () => void)();
    await expect(pending).resolves.toBeNull();
    expect(engine.stopped).toBe(1);
  });

  it('disposes the engine and answers null afterwards', async () => {
    const engine = fakeEngine();
    const evaluator = createTryEvaluator({ createEngine: () => engine, judge: () => Promise.resolve(goodTry) });
    await evaluator.evaluate(FEN_MOVE3, 'g1f3');
    evaluator.dispose();
    evaluator.dispose();
    expect(engine.disposed).toBe(1);
    await expect(evaluator.evaluate(FEN_MOVE3, 'g1f3')).resolves.toBeNull();
  });

  it('an engine that arrives after dispose() is disposed at once', async () => {
    const engine = fakeEngine();
    let release: (value: IJudgeEngine) => void = () => undefined;
    const evaluator = createTryEvaluator({ createEngine: () => new Promise<IJudgeEngine>((resolve) => (release = resolve)) });
    const pending = evaluator.evaluate(FEN_MOVE3, 'g1f3');
    evaluator.dispose();
    release(engine);
    await expect(pending).resolves.toBeNull();
    expect(engine.disposed).toBe(1);
  });
});
