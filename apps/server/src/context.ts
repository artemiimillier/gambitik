/**
 * Composition root: builds every service from a `ServerConfig`. Routes receive the resulting
 * `ServerContext`; tests build one on a temporary DATA_DIR with fake providers.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { contentWarningLines, loadContent } from './content.ts';
import type { ContentBundle, LoadContentOptions } from './content.ts';
import type { ServerConfig } from './config.ts';
import { LlmGateway, providerChain } from './llm/gateway.ts';
import { createCodexProvider } from './llm/providers/codex.ts';
import type { CodexProvider } from './llm/providers/codex.ts';
import { createOpenAiApiProvider } from './llm/providers/openaiApi.ts';
import { createOpenRouterProvider } from './llm/providers/openrouter.ts';
import { createTemplateProvider } from './llm/providers/template.ts';
import type { LlmProvider } from './llm/types.ts';
import { GameService } from './services/games.ts';
import { themeTitle } from './services/progress.ts';
import { openPuzzleSource } from './services/puzzles.ts';
import type { PuzzleSource } from './services/puzzles.ts';
import { MistakeRepetition } from './services/repetition.ts';
import { ReviewService } from './services/reviews.ts';
import { StudentService } from './services/student.ts';
import { VoiceUsageService } from './services/voiceUsage.ts';
import { maskSecrets } from './sanitize.ts';
import { StrategyHistory } from './strategist/history.ts';
import { Strategist } from './strategist/strategist.ts';
import type { StrategistTiming } from './strategist/strategist.ts';
import { stageFor } from './content.ts';
import { PRIVATE_DIR_MODE, openAppDb } from './storage/db.ts';
import type { Db } from './storage/db.ts';
import { dataPaths } from './storage/files.ts';
import type { DataPaths } from './storage/files.ts';
import { Repo } from './storage/repo.ts';
import { DataFileWriter } from './storage/writer.ts';
import { createClipGenService } from './voiceGen/service.ts';
import type { ClipGenOverrides, ClipGenService } from './voiceGen/service.ts';

export interface ServerContext {
  config: ServerConfig;
  paths: DataPaths;
  db: Db;
  repo: Repo;
  content: ContentBundle;
  puzzles: PuzzleSource;
  codex: CodexProvider;
  gateway: LlmGateway;
  student: StudentService;
  writer: DataFileWriter;
  reviews: ReviewService;
  games: GameService;
  voiceUsage: VoiceUsageService;
  /** spaced repetition of the child's own failed puzzles */
  repetition: MistakeRepetition;
  /** the smart strategist of «Учитель» (POST /coach/strategy, /coach/replan) */
  strategist: Strategist;
  strategyHistory: StrategyHistory;
  /** «Дозапись голоса»: records missing lesson phrases on first use (off unless GAMBIT_CLIP_GEN) */
  clipGen: ClipGenService;
  /** injectable for tests (voice session minting) */
  fetchImpl: typeof fetch;
  log: (message: string) => void;
  /** Resolves when background reviews and file writes have settled. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface ContextOverrides {
  /** replaces the whole provider chain (tests) */
  providers?: readonly LlmProvider[];
  codex?: CodexProvider;
  puzzles?: PuzzleSource;
  fetchImpl?: typeof fetch;
  content?: LoadContentOptions;
  log?: (message: string) => void;
  /** shorter strategist budgets (tests) */
  strategistTiming?: Partial<StrategistTiming>;
  /** fake clock of the strategy history (tests) */
  now?: () => number;
  /** «Дозапись голоса» (tests): a fake Higgsfield runner, finish, protocol, clock … — see voiceGen/service.ts */
  clipGen?: ClipGenOverrides;
  /**
   * Accounts (./accounts/users.ts): what every account's context shares with the server's own — the content, the
   * puzzle source and the recorder of «Дозапись голоса». A context built with them owns none of them: its `close()`
   * leaves them open.
   */
  shared?: SharedServices;
}

/** The read-only / machine-wide services a per-account context borrows (see `ContextOverrides.shared`). */
export interface SharedServices {
  content: ContentBundle;
  puzzles: PuzzleSource;
  clipGen: ClipGenService;
}

export async function createServerContext(config: ServerConfig, overrides: ContextOverrides = {}): Promise<ServerContext> {
  const rawLog = overrides.log ?? (config.log ? (message: string) => console.log(message) : () => undefined);
  // second line of defence: whatever a caller logs, nothing key-shaped reaches stdout / data/server.log
  const log = (message: string): void => rawLog(maskSecrets(message, [config.openaiApiKey, config.openrouterApiKey]));
  const fetchImpl = overrides.fetchImpl ?? fetch;

  const paths = dataPaths(config.dataDir);
  // journals hold a child's words: the data directory is private to this account
  mkdirSync(paths.dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(paths.dataDir, PRIVATE_DIR_MODE); // also tightens a directory created by an older version
  } catch {
    log(`[server] cannot restrict the permissions of ${paths.dataDir} — check that other accounts of this Mac cannot read it`);
  }
  const db = openAppDb(paths.appDb, { log });
  const repo = new Repo(db);
  const shared = overrides.shared ?? null;
  const content = shared?.content ?? (await loadContent(overrides.content));
  if (shared === null) for (const line of contentWarningLines(content)) log(line);
  const puzzles = shared?.puzzles ?? overrides.puzzles ?? openPuzzleSource({ puzzlesDbPath: config.puzzlesDbPath, starterPuzzlesPath: config.starterPuzzlesPath, log });

  const student = new StudentService(repo, content);

  // GAMBIT_RUNTIME_AI off: loadConfig already dropped codex and the LLM chain; checked again here for a config built by
  // hand (belt and braces — docs/TEACHING.md §4.4). Injected test providers (`overrides`) are the caller's choice.
  const runtimeAi = config.runtimeAi === true;
  const codex = overrides.codex ?? createCodexProvider({ codexBin: runtimeAi ? config.codexBin : null, model: config.codexModel, log });
  const allProviders: readonly LlmProvider[] =
    overrides.providers ??
    [
      codex,
      createOpenRouterProvider({
        apiKey: config.openrouterApiKey,
        model: config.openrouterReviewModel,
        fallbackModels: config.openrouterFallbackModels,
        baseUrl: config.openrouterBaseUrl,
        fetchImpl,
        log,
      }),
      createOpenAiApiProvider({ apiKey: config.openaiApiKey, model: config.openaiTextModel, baseUrl: config.openaiBaseUrl, fetchImpl }),
      createTemplateProvider({
        templateReview: content.templateReview,
        motifTitleRu: content.motifTitleRu,
        themeTitleRu: (theme) => themeTitle(content.themeTitlesRu, theme),
        defaultTheme: (profile) => stageFor(content.curriculum, profile.stage).puzzleThemes[0] ?? 'hangingPiece',
      }),
    ];
  const chain = providerChain(runtimeAi ? config.llmProvider : 'template');
  const providers = overrides.providers ?? chain.flatMap((id) => allProviders.filter((p) => p.id === id));
  const gateway = new LlmGateway({ providers, log });

  const writer = new DataFileWriter({ paths, repo, content, getProfile: () => student.getProfile(), log });
  const reviews = new ReviewService({ repo, content, gateway, student, writer, timeoutMs: config.llmTimeoutMs, includeChildSpeech: config.reviewIncludeChildSpeech, log });
  const voiceUsage = new VoiceUsageService(repo);
  const repetition = new MistakeRepetition(repo);
  const games = new GameService({ dataDir: config.dataDir, repo, content, student, writer, reviews, autoReview: config.autoReview });
  const strategyHistory = new StrategyHistory(repo, overrides.now);
  const strategist = new Strategist({
    gateway,
    library: content.strategyLibrary,
    history: strategyHistory,
    getProfile: () => student.getProfile(),
    personas: content.personas,
    sanToSpokenRu: content.sanToSpokenRu,
    models: { codex: config.codexStrategyModel, openrouter: config.openrouterStrategyModel, openaiApi: config.openaiStrategyModel },
    log,
    // STRATEGY_CODEX_FIRST / STRATEGY_CODEX_MS: the owner's subscription first (tests may shorten every budget)
    codexFirst: config.strategyCodexFirst,
    timing: { strategyCodexMs: config.strategyCodexMs, ...overrides.strategistTiming },
  });

  const clipGen = shared?.clipGen ?? createClipGenService({
    config,
    db,
    nickname: () => {
      try {
        return student.getProfile().nickname;
      } catch {
        return null;
      }
    },
    fetchImpl,
    log,
    ...(overrides.clipGen !== undefined ? { overrides: overrides.clipGen } : {}),
  });

  let closed = false;
  const idle = async (): Promise<void> => {
    await reviews.idle();
    await gateway.onIdle();
    await writer.idle();
  };

  return {
    config,
    paths,
    db,
    repo,
    content,
    puzzles,
    codex,
    gateway,
    student,
    writer,
    reviews,
    games,
    voiceUsage,
    repetition,
    strategist,
    strategyHistory,
    clipGen,
    fetchImpl,
    log,
    idle,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // kills a running Higgsfield / finish child; a pending job stays in the overlay ledger and is resumed next start
      // (a per-account context borrows the recorder and the puzzles: the server's own context closes them)
      if (shared === null) await clipGen.dispose();
      gateway.dispose();
      codex.dispose();
      await reviews.idle();
      await writer.idle();
      if (shared === null) puzzles.close();
      db.close();
    },
  };
}
