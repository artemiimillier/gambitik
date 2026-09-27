/**
 * Engine check of a try in «Найди ход лучше!».
 *
 * The recorded game only knows ONE best move, but in most positions several moves are fine. So a try that
 * is not the recorded best is judged by the same judge engine as in the game (`judgeMove` of @gambit/core):
 * "engine decides, code proves". The engine is created lazily (its own worker, only when a task is opened),
 * every check is bounded by a timeout, and any failure simply answers `null` — the screen then falls back
 * to comparing with the recorded best move and claims nothing about the try.
 */
import { DEFAULT_QUICK_DEPTH, judgeMove } from '@gambit/core';
import type { AnalysisResult, IJudgeEngine, MoveClass, MoveJudgement } from '@gambit/shared';
import { positionKey } from './reviewModel.ts';

/** What the screen needs to know about a tried move. */
export interface TryEvaluation {
  /** 0..100 points of winning chances lost against the engine's best move (0 = as good as the best) */
  winPctLoss: number;
  winPctAfter: number;
  classification: MoveClass;
}

/** One try may wait this long for the engine (worker start included); after that the fallback answers. */
export const TRY_EVAL_TIMEOUT_MS = 6000;

export interface TryEvaluatorDeps {
  /** e.g. `() => import('../../engine/index.ts').then((m) => m.createJudgeEngine())` */
  createEngine: () => Promise<IJudgeEngine> | IJudgeEngine;
  judge?: (engine: IJudgeEngine, args: { fenBefore: string; uci: string; ply: number; cachedBefore?: AnalysisResult }) => Promise<MoveJudgement>;
  timeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TryEvaluator {
  /** Starts the engine and analyses the task position in the background, so the first try is answered quickly. */
  prepare(fenBefore: string): void;
  /** Never rejects: `null` = the engine could not answer (missing, broken, too slow, disposed). */
  evaluate(fenBefore: string, uci: string): Promise<TryEvaluation | null>;
  dispose(): void;
}

export function createTryEvaluator(deps: TryEvaluatorDeps): TryEvaluator {
  const judge = deps.judge ?? judgeMove;
  const timeoutMs = deps.timeoutMs ?? TRY_EVAL_TIMEOUT_MS;
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let disposed = false;
  let engine: IJudgeEngine | null = null;
  let enginePromise: Promise<IJudgeEngine | null> | null = null;
  /** background analysis of the position of the open task (one entry: the newest task wins) */
  let prepared: { key: string; analysis: Promise<AnalysisResult | null> } | null = null;

  function getEngine(): Promise<IJudgeEngine | null> {
    if (disposed) return Promise.resolve(null);
    enginePromise ??= (async () => {
      try {
        const created = await deps.createEngine();
        if (disposed) {
          created.dispose();
          return null;
        }
        await created.ready();
        if (disposed) {
          created.dispose();
          return null;
        }
        engine = created;
        return created;
      } catch {
        enginePromise = null; // a later task may try again
        return null;
      }
    })();
    return enginePromise;
  }

  function prepare(fenBefore: string): void {
    if (disposed) return;
    const key = positionKey(fenBefore);
    if (prepared?.key === key) return;
    const analysis = getEngine().then(async (ready) => {
      if (!ready) return null;
      try {
        return await ready.analyze(fenBefore, { depth: DEFAULT_QUICK_DEPTH, multipv: 3 });
      } catch {
        return null; // game over position, superseded by a try, engine trouble — judgeMove will search by itself
      }
    });
    prepared = { key, analysis };
  }

  async function evaluateUnbounded(fenBefore: string, uci: string): Promise<TryEvaluation | null> {
    const ready = await getEngine();
    if (!ready) return null;
    const cached = prepared?.key === positionKey(fenBefore) ? await prepared.analysis : null;
    if (disposed) return null;
    try {
      const judgement = await judge(ready, { fenBefore, uci, ply: 0, ...(cached ? { cachedBefore: cached } : {}) });
      return { winPctLoss: judgement.winPctLoss, winPctAfter: judgement.winPctAfter, classification: judgement.classification };
    } catch {
      return null;
    }
  }

  function evaluate(fenBefore: string, uci: string): Promise<TryEvaluation | null> {
    if (disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: TryEvaluation | null): void => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      };
      const timer = setTimer(() => {
        // too slow for a child to wait: free the engine for the next try and let the fallback answer
        try {
          engine?.stop();
        } catch {
          /* a broken worker must not break the screen */
        }
        finish(null);
      }, timeoutMs);
      evaluateUnbounded(fenBefore, uci).then(finish, () => finish(null));
    });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    prepared = null;
    try {
      engine?.dispose();
    } catch {
      /* already gone */
    }
    engine = null;
  }

  return { prepare, evaluate, dispose };
}

/** The app's evaluator: the real Stockfish judge, loaded only when a task is opened. */
export function createBrowserTryEvaluator(): TryEvaluator {
  return createTryEvaluator({
    createEngine: async () => {
      if (typeof Worker === 'undefined') throw new Error('no Worker in this environment');
      const { createJudgeEngine } = await import('../../engine/index.ts');
      return createJudgeEngine();
    },
  });
}
