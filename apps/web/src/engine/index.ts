/**
 * Browser engine layer (see docs/ARCHITECTURE.md §3 and docs/research/02-engines-bots.md).
 *
 *   const judge = createJudgeEngine();   // coach: full strength, own worker, Hash 64
 *   const bot = createBotEngine();       // opponent: own worker, Hash 16, sampler ladder
 *
 * The two engines must never share a worker: the judge's deep hash would make weak bots stronger.
 */
export { UciEngine, buildGoCommand, buildPositionCommand } from './UciEngine.ts';
export type { UciEngineConfig } from './UciEngine.ts';
export { createJudgeEngine, judgeUciOptions, JUDGE_DEFAULT_HASH_MB } from './judgeEngine.ts';
export type { JudgeAnalyzeOptions, JudgeEngine, JudgeEngineConfig } from './judgeEngine.ts';
export { createBotEngine, botUciOptions, BOT_DEFAULT_HASH_MB } from './botEngine.ts';
export type { BotEngine, BotEngineConfig, BotMoveDetail, BotMoveSource } from './botEngine.ts';
export { BOT_LEVELS, BOT_LEVEL_ORDER } from './botLevels.ts';
export { buildCandidatePool, samplePool, scoreToCp, MATE_SCORE_CP } from './sampler.ts';
export type { SamplerCandidate, SamplerParams } from './sampler.ts';
export { computeThinkMs, MIN_THINK_MS, MAX_THINK_MS } from './thinkTime.ts';
export type { ThinkTimeInput } from './thinkTime.ts';
export { parseInfoLine, parseBestmoveLine, isCriticalErrorLine, isUciMove, LineCollector } from './parseUci.ts';
export type { ParsedBestmove, ParsedInfo } from './parseUci.ts';
export { createWorkerTransport } from './workerTransport.ts';
export { createSeededRng } from './rng.ts';
export { DEFAULT_ENGINE_URL, EngineError, isEngineError } from './types.ts';
export type {
  EngineErrorCode,
  EngineTransport,
  EngineTransportFactory,
  Rng,
  SearchRequest,
  SearchResult,
  UciOptionValue,
} from './types.ts';
