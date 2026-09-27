import type { AnalysisResult, AnalyzeOptions, EngineLine, IJudgeEngine } from '@gambit/shared';
import { UciEngine } from './UciEngine.ts';
import { inspectPosition } from './position.ts';
import { EngineError } from './types.ts';
import type { EngineTransportFactory, UciOptionValue } from './types.ts';

export interface JudgeEngineConfig {
  workerUrl?: string;
  /** Inject a transport (tests, native Stockfish, ...). The judge still owns it exclusively. */
  createTransport?: EngineTransportFactory;
  /** Hash in MB. Default 64. */
  hashMb?: number;
  now?: () => number;
}

export interface JudgeAnalyzeOptions extends AnalyzeOptions {
  /** Live lines while the search runs (for a thinking indicator / early peeks). */
  onProgress?: (lines: EngineLine[]) => void;
}

/** `IJudgeEngine` plus a few extras the game module may use. */
export interface JudgeEngine extends IJudgeEngine {
  /**
   * Full-strength analysis of `fen`. At least one of depth / movetimeMs / nodes should be given
   * (they may be combined, the first limit hit wins); with none the search runs to depth 12.
   *
   * Rejects with `EngineError`:
   *  - 'invalid-fen', 'invalid-searchmoves' — caught by chess.js before the engine is touched;
   *  - 'no-legal-moves' — checkmate / stalemate positions have nothing to analyse (check `chess.isGameOver()` first);
   *  - 'critical-error', 'no-move', 'timeout', 'worker-error' — engine failures (the worker restarts itself);
   *  - 'stopped' — superseded by `stop()`; `error.partial` carries the lines found so far.
   */
  analyze(fen: string, opts: JudgeAnalyzeOptions): Promise<AnalysisResult>;
  /** Clears the hash between games. */
  newGame(): Promise<void>;
  /** Number of automatic worker restarts so far (diagnostics). */
  readonly restartCount: number;
}

export const JUDGE_DEFAULT_HASH_MB = 64;
const DEEP_SEARCH_DEPTH = 18;
const DEEP_SEARCH_WATCHDOG_MS = 90_000;

export function judgeUciOptions(hashMb: number = JUDGE_DEFAULT_HASH_MB): Record<string, UciOptionValue> {
  return {
    Threads: 1,
    Hash: hashMb,
    'Skill Level': 20,
    UCI_LimitStrength: false,
    UCI_ShowWDL: false,
  };
}

/**
 * The coach's analysis engine: its OWN worker (never shared with the bot — a shared hash table would make
 * weak bots stronger), full strength, MultiPV chosen per call.
 */
export function createJudgeEngine(config: JudgeEngineConfig = {}): JudgeEngine {
  const engine = new UciEngine({
    workerUrl: config.workerUrl,
    createTransport: config.createTransport,
    options: judgeUciOptions(config.hashMb),
    now: config.now,
  });

  return {
    ready: () => engine.ready(),

    async analyze(fen: string, opts: JudgeAnalyzeOptions): Promise<AnalysisResult> {
      const position = inspectPosition(fen);
      if (position.legalUci.length === 0) {
        throw new EngineError(
          'no-legal-moves',
          position.isCheckmate ? 'position is checkmate: nothing to analyse' : 'position is stalemate: nothing to analyse',
        );
      }
      const searchmoves = opts.searchmoves ?? [];
      const illegal = searchmoves.filter((move) => !position.legalSet.has(move));
      if (illegal.length > 0) {
        throw new EngineError('invalid-searchmoves', `searchmoves not legal in this position: ${illegal.join(' ')}`);
      }

      const deep = opts.movetimeMs === undefined && (opts.depth ?? 0) >= DEEP_SEARCH_DEPTH;
      const result = await engine.search({
        fen,
        depth: opts.depth,
        movetimeMs: opts.movetimeMs,
        nodes: opts.nodes,
        multipv: opts.multipv,
        searchmoves,
        watchdogMs: deep ? DEEP_SEARCH_WATCHDOG_MS : undefined,
        onInfo: opts.onProgress,
      });

      // Paranoia against "silently searched another position": every root move must be legal here.
      const lines = result.lines.filter((line) => position.legalSet.has(line.pvUci[0] ?? ''));
      if (!position.legalSet.has(result.bestmove)) {
        throw new EngineError('critical-error', `engine answered for a different position (bestmove ${result.bestmove})`);
      }
      if (lines.length === 0) throw new EngineError('no-move', 'engine produced no principal variation');
      return {
        fen,
        lines: lines.map((line, index) => ({ ...line, multipv: index + 1 })),
        bestmove: result.bestmove,
        depth: lines[0]?.depth ?? result.depth,
        timeMs: result.timeMs,
      };
    },

    stop: () => engine.stop(),
    newGame: () => engine.newGame(),
    dispose: () => engine.dispose(),
    get restartCount(): number {
      return engine.restartCount;
    },
  };
}
