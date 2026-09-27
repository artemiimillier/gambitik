import type { BotLevelConfig, BotMove, IBotEngine, PersonaId } from '@gambit/shared';
import { UciEngine } from './UciEngine.ts';
import { BOT_LEVELS } from './botLevels.ts';
import { inspectPosition } from './position.ts';
import type { PositionInfo } from './position.ts';
import { defaultRng, pickUniform } from './rng.ts';
import { buildCandidatePool, samplePool, scoreToCp } from './sampler.ts';
import type { SamplerCandidate } from './sampler.ts';
import { computeThinkMs } from './thinkTime.ts';
import { EngineError, isEngineError } from './types.ts';
import type { EngineTransportFactory, Rng, SearchRequest, SearchResult, UciOptionValue } from './types.ts';

export interface BotEngineConfig {
  workerUrl?: string;
  /** Inject a transport (tests). The bot always owns its transport exclusively. */
  createTransport?: EngineTransportFactory;
  /** Hash in MB. Default 16 — small on purpose, bots search to depth ≤ 8. */
  hashMb?: number;
  /** Random source for the sampler and the think-time jitter. Default Math.random. */
  rng?: Rng;
  /** Override the ladder (adaptive half-steps, tests). Default BOT_LEVELS. */
  levels?: Record<PersonaId, BotLevelConfig>;
  /** Hard cap on one engine consultation (on top of the movetime) before the random-move fallback. Default 6 s. */
  maxEngineWaitMs?: number;
  now?: () => number;
}

/**
 * How the move was chosen:
 *  'forced'   – the only legal move;
 *  'random'   – the pRandom roll: a uniformly random legal move (the "beginner blunder");
 *  'sampled'  – softmax sample from the MultiPV candidates;
 *  'best'     – the engine's best move (full-strength mode, or no usable MultiPV lines);
 *  'fallback' – the engine failed or answered nonsense: random legal move so the game never hangs.
 */
export type BotMoveSource = 'forced' | 'random' | 'sampled' | 'best' | 'fallback';

export interface BotMoveDetail extends BotMove {
  source: BotMoveSource;
  /** Time actually spent inside pickMove (engine search included). `thinkMs` is never smaller. */
  searchMs: number;
  /** The softmax pool the move was drawn from (empty unless source is 'sampled' / opening variety). */
  candidates: SamplerCandidate[];
}

export interface BotEngine extends IBotEngine {
  /**
   * Picks the bot's move. `ctx.moveNumber` is the full-move number (1-based), `ctx.remainingMs` the BOT's clock.
   * The returned move is always legal (validated with chess.js). Rejects only with
   * 'invalid-fen', 'no-legal-moves' (game already over) or 'disposed'.
   */
  pickMove(
    fen: string,
    personaId: PersonaId,
    ctx: { moveNumber: number; remainingMs: number | null },
  ): Promise<BotMoveDetail>;
  readonly restartCount: number;
}

export const BOT_DEFAULT_HASH_MB = 16;
/** Sampler searches are depth ≤ 8 and take milliseconds; anything slower means the worker is stuck. */
const SAMPLER_WATCHDOG_MS = 4_000;
const FULL_MODE_GRACE_MS = 3_000;
const FULL_MODE_DEFAULT_MOVETIME_MS = 1_000;
const FULL_MODE_MIN_MOVETIME_MS = 80;
/** The full-strength bot is deterministic; in the first moves it picks among near-equal top lines for variety. */
const FULL_MODE_VARIETY_MOVES = 8;
const FULL_MODE_VARIETY_MULTIPV = 3;
const FULL_MODE_VARIETY_MAX_LOSS_CP = 15;

export function botUciOptions(hashMb: number = BOT_DEFAULT_HASH_MB): Record<string, UciOptionValue> {
  return {
    Threads: 1,
    Hash: hashMb,
    // Weakening is done by our sampler, never by Stockfish's own Skill Level (it cannot go below ~1320).
    'Skill Level': 20,
    UCI_LimitStrength: false,
    UCI_ShowWDL: false,
  };
}

interface Choice {
  uci: string;
  source: BotMoveSource;
  candidates: SamplerCandidate[];
  topGapCp: number | null;
}

function topGap(result: SearchResult, position: PositionInfo): number | null {
  const legalLines = result.lines.filter((line) => position.legalSet.has(line.pvUci[0] ?? ''));
  const first = legalLines[0];
  const second = legalLines[1];
  if (first === undefined || second === undefined) return null;
  return Math.max(0, scoreToCp(first) - scoreToCp(second));
}

/**
 * Bot move generator with its OWN Stockfish worker.
 *
 * 'sampler' levels (research 02 §4.4): with probability pRandom play a uniformly random legal move (no exception
 * for available mates — weak bots are supposed to miss them); otherwise `go depth D` with MultiPV K, drop
 * candidates losing more than maxLossCp, softmax-sample the rest with temperature tempCp over the eval loss.
 * 'full' level: plain `go movetime` best move (scaled down when the clock runs low).
 */
export function createBotEngine(config: BotEngineConfig = {}): BotEngine {
  const rng = config.rng ?? defaultRng;
  const levels = config.levels ?? BOT_LEVELS;
  const now = config.now ?? (() => performance.now());
  const maxEngineWaitMs = config.maxEngineWaitMs ?? 6_000;
  const engine = new UciEngine({
    workerUrl: config.workerUrl,
    createTransport: config.createTransport,
    options: botUciOptions(config.hashMb),
    now: config.now,
  });
  let disposed = false;
  let searchesDone = 0;

  async function consult(request: SearchRequest, deadlineMs: number): Promise<SearchResult> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          engine.stop();
          reject(new EngineError('timeout', `bot engine did not answer within ${deadlineMs} ms`));
        }, deadlineMs);
      });
      try {
        const result = await Promise.race([engine.search(request), deadline]);
        searchesDone += 1;
        return result;
      } catch (error) {
        lastError = error;
        // Fast failures are worth one retry on the freshly restarted worker; slow ones are not.
        const retryable = isEngineError(error) && (error.code === 'critical-error' || error.code === 'worker-error');
        if (!retryable) break;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    throw lastError;
  }

  async function chooseWithEngine(
    position: PositionInfo,
    level: BotLevelConfig,
    ctx: { moveNumber: number; remainingMs: number | null },
  ): Promise<Choice> {
    if (level.mode === 'full') {
      const configured = level.movetimeMs ?? FULL_MODE_DEFAULT_MOVETIME_MS;
      const movetimeMs =
        ctx.remainingMs === null
          ? configured
          : Math.round(Math.min(configured, Math.max(FULL_MODE_MIN_MOVETIME_MS, ctx.remainingMs / 80)));
      const variety = ctx.moveNumber <= FULL_MODE_VARIETY_MOVES;
      const result = await consult(
        {
          fen: position.fen,
          movetimeMs,
          multipv: variety ? FULL_MODE_VARIETY_MULTIPV : 1,
          watchdogMs: movetimeMs + FULL_MODE_GRACE_MS,
        },
        movetimeMs + maxEngineWaitMs,
      );
      if (variety) {
        const pool = buildCandidatePool(result.lines, position.legalSet, {
          tempCp: Number.POSITIVE_INFINITY,
          maxLossCp: FULL_MODE_VARIETY_MAX_LOSS_CP,
        });
        if (pool.length > 0) {
          return { uci: samplePool(pool, rng).uci, source: 'best', candidates: pool, topGapCp: topGap(result, position) };
        }
      }
      if (position.legalSet.has(result.bestmove)) {
        return { uci: result.bestmove, source: 'best', candidates: [], topGapCp: topGap(result, position) };
      }
      throw new EngineError('critical-error', `illegal bestmove from the engine: ${result.bestmove}`);
    }

    const result = await consult(
      {
        fen: position.fen,
        depth: level.depth ?? 1,
        multipv: level.multipv ?? 1,
        watchdogMs: SAMPLER_WATCHDOG_MS,
      },
      maxEngineWaitMs,
    );
    const pool = buildCandidatePool(result.lines, position.legalSet, {
      tempCp: level.tempCp ?? 0,
      maxLossCp: level.maxLossCp ?? 0,
    });
    if (pool.length > 0) {
      return { uci: samplePool(pool, rng).uci, source: 'sampled', candidates: pool, topGapCp: topGap(result, position) };
    }
    if (position.legalSet.has(result.bestmove)) {
      return { uci: result.bestmove, source: 'best', candidates: [], topGapCp: null };
    }
    throw new EngineError('critical-error', `illegal bestmove from the engine: ${result.bestmove}`);
  }

  return {
    ready: () => engine.ready(),

    async pickMove(
      fen: string,
      personaId: PersonaId,
      ctx: { moveNumber: number; remainingMs: number | null },
    ): Promise<BotMoveDetail> {
      if (disposed) throw new EngineError('disposed', 'bot engine disposed');
      const startedAt = now();
      const position = inspectPosition(fen);
      if (position.legalUci.length === 0) {
        throw new EngineError('no-legal-moves', 'the game is over: the bot has no legal move');
      }
      const level = levels[personaId] ?? BOT_LEVELS[personaId];

      // A new game: forget the previous game's hash so every game starts equally "fresh".
      if (ctx.moveNumber <= 1 && searchesDone > 0) void engine.newGame();

      let choice: Choice;
      if (position.legalUci.length === 1) {
        choice = { uci: position.legalUci[0] as string, source: 'forced', candidates: [], topGapCp: null };
      } else if (level.mode === 'sampler' && rng() < (level.pRandom ?? 0)) {
        choice = { uci: pickUniform(position.legalUci, rng), source: 'random', candidates: [], topGapCp: null };
      } else {
        try {
          choice = await chooseWithEngine(position, level, ctx);
        } catch (error) {
          if (disposed || (isEngineError(error) && error.code === 'disposed')) {
            throw new EngineError('disposed', 'bot engine disposed');
          }
          // Whatever went wrong (timeout, CRITICAL ERROR, crashed worker, illegal bestmove): keep the game going.
          choice = { uci: pickUniform(position.legalUci, rng), source: 'fallback', candidates: [], topGapCp: null };
        }
      }

      const modelMs = computeThinkMs({
        moveNumber: ctx.moveNumber,
        remainingMs: ctx.remainingMs,
        legalMoveCount: position.legalUci.length,
        inCheck: position.inCheck,
        topGapCp: choice.topGapCp,
        rng,
      });
      const searchMs = Math.max(0, Math.round(now() - startedAt));
      return {
        uci: choice.uci,
        thinkMs: Math.max(modelMs, searchMs),
        source: choice.source,
        searchMs,
        candidates: choice.candidates,
      };
    },

    dispose(): void {
      disposed = true;
      engine.dispose();
    },

    get restartCount(): number {
      return engine.restartCount;
    },
  };
}
