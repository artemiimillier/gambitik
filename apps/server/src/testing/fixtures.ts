/**
 * Test fixtures (not imported by production code): a realistic finished game built with chess.js,
 * and a server context on a throw-away DATA_DIR that can never reach a real LLM or the network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import type { GameEvent, GameRecord, MoveClass, MoveJudgement, MotifId } from '@gambit/shared';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import type { ServerConfig } from '../config.ts';
import { createServerContext } from '../context.ts';
import type { ContextOverrides, ServerContext } from '../context.ts';

export const TEST_HOST = '127.0.0.1:8787';
export const TEST_ORIGIN = 'http://127.0.0.1:8787';

interface JudgeSpec {
  classification: MoveClass;
  winBefore: number;
  winAfter: number;
  best?: string;
  allowedMotif?: MotifId;
  missedMotif?: MotifId;
  refutation?: string[];
  materialLossPawns?: number;
}

function judgement(fenBefore: string, san: string, ply: number, spec: JudgeSpec): MoveJudgement {
  const chess = new Chess(fenBefore);
  const move = chess.move(san);
  const fenAfter = chess.fen();
  let bestUci = move.lan;
  let bestSan = move.san;
  if (spec.best !== undefined) {
    const alt = new Chess(fenBefore);
    const best = alt.move(spec.best);
    bestUci = best.lan;
    bestSan = best.san;
  }
  const refutationSan: string[] = [];
  const refutationUci: string[] = [];
  const line = new Chess(fenAfter);
  for (const reply of spec.refutation ?? []) {
    const m = line.move(reply);
    refutationSan.push(m.san);
    refutationUci.push(m.lan);
  }
  return {
    ply,
    color: move.color,
    san: move.san,
    uci: move.lan,
    fenBefore,
    fenAfter,
    evalBefore: { cp: 30, mate: null },
    evalAfter: { cp: spec.classification === 'blunder' ? -600 : 40, mate: null },
    winPctBefore: spec.winBefore,
    winPctAfter: spec.winAfter,
    winPctLoss: Math.max(0, spec.winBefore - spec.winAfter),
    classification: spec.classification,
    accuracy: Math.max(0, 100 - Math.max(0, spec.winBefore - spec.winAfter) * 2),
    bestUci,
    bestSan,
    bestPvSan: [bestSan],
    refutationPvSan: refutationSan,
    refutationPvUci: refutationUci,
    ...(spec.allowedMotif !== undefined ? { allowedMotif: spec.allowedMotif } : {}),
    ...(spec.missedMotif !== undefined ? { missedMotif: spec.missedMotif } : {}),
    materialLossPawns: spec.materialLossPawns ?? 0,
    confidence: 'confirmed',
  };
}

/**
 * White (the child) beats Petya with the scholar's mate; on move 3 the child first grabs a pawn
 * with the queen (a blunder), accepts the coach's take-back offer, asks for a hint and finds Bc4.
 */
export function sampleGameRecord(overrides: Partial<GameRecord> = {}): GameRecord {
  const chess = new Chess();
  const fens: string[] = [];
  for (const san of ['e4', 'e5', 'Qh5', 'Nc6']) {
    fens.push(chess.fen());
    chess.move(san);
  }
  const fenMove3 = chess.fen();
  const attempt = judgement(fenMove3, 'Qxe5+', 5, {
    classification: 'blunder',
    winBefore: 55,
    winAfter: 8,
    best: 'Bc4',
    allowedMotif: 'hangingPiece',
    refutation: ['Nxe5'],
    materialLossPawns: 8,
  });
  chess.move('Bc4');
  chess.move('Nf6');
  const fenMove4 = chess.fen();
  chess.move('Qxf7#');

  const judgements: MoveJudgement[] = [
    judgement(fens[0] ?? '', 'e4', 1, { classification: 'best', winBefore: 52, winAfter: 52 }),
    judgement(fens[2] ?? '', 'Qh5', 3, { classification: 'inaccuracy', winBefore: 53, winAfter: 46, best: 'Nf3' }),
    attempt,
    judgement(fenMove3, 'Bc4', 5, { classification: 'best', winBefore: 55, winAfter: 55 }),
    judgement(fenMove4, 'Qxf7#', 7, { classification: 'best', winBefore: 100, winAfter: 100, missedMotif: 'mateIn1' }),
  ];

  const events: GameEvent[] = [
    { t: 0, type: 'gameStart', data: { personaId: 'petya' } },
    { t: 500, type: 'coachSaid', data: { kind: 'gameStart', text: 'Поехали! Сегодня играем с Петей.', bubbleText: 'Поехали! Сегодня играем с Петей.' } },
    { t: 4_000, type: 'move', ply: 1, data: { san: 'e4', uci: 'e2e4', by: 'child' } },
    { t: 6_000, type: 'move', ply: 2, data: { san: 'e5', uci: 'e7e5', by: 'bot' } },
    { t: 12_000, type: 'move', ply: 3, data: { san: 'Qh5', uci: 'd1h5', by: 'child' } },
    { t: 14_000, type: 'move', ply: 4, data: { san: 'Nc6', uci: 'b8c6', by: 'bot' } },
    { t: 21_000, type: 'move', ply: 5, data: { san: 'Qxe5+', uci: 'h5e5', by: 'child', takenBack: true } },
    { t: 21_400, type: 'takebackOffered', ply: 5, data: { san: 'Qxe5+', winPctLoss: 47, motif: 'hangingPiece', text: 'Стой-стой! Посмотри, кто защищает эту пешку.' } },
    { t: 27_000, type: 'takebackAccepted', ply: 5, data: { san: 'Qxe5+' } },
    { t: 30_000, type: 'hintRequested', ply: 5, data: {} },
    { t: 30_300, type: 'hintGiven', ply: 5, data: { level: 1, text: 'Какая твоя фигура ещё не вышла и может напасть на слабый пункт?' } },
    { t: 41_000, type: 'childSaid', ply: 5, data: { text: 'Слон может пойти на це четыре!' } },
    { t: 43_000, type: 'move', ply: 5, data: { san: 'Bc4', uci: 'f1c4', by: 'child' } },
    { t: 45_000, type: 'move', ply: 6, data: { san: 'Nf6', uci: 'g8f6', by: 'bot' } },
    { t: 52_000, type: 'move', ply: 7, data: { san: 'Qxf7#', uci: 'h5f7', by: 'child' } },
    { t: 52_500, type: 'coachSaid', ply: 7, data: { kind: 'praise', text: 'Мат! Ты сам нашёл слабое поле.' } },
    { t: 53_000, type: 'gameEnd', data: { result: '1-0' } },
  ];

  const record: GameRecord = {
    id: 'game-0001',
    startedAt: '2026-09-21T14:42:10.000Z',
    endedAt: '2026-09-21T14:49:40.000Z',
    personaId: 'petya',
    timeControlId: 'rapid10',
    childColor: 'w',
    result: '1-0',
    termination: 'checkmate',
    pgn: '1. e4 {[%clk 0:09:56]} e5 2. Qh5 {[%clk 0:09:48]} Nc6 3. Bc4 {[%clk 0:09:17]} Nf6 4. Qxf7# {[%clk 0:09:08]} 1-0',
    events,
    judgements,
    summary: {
      accuracy: 81.4,
      acpl: 38,
      counts: { best: 3, excellent: 0, good: 0, inaccuracy: 1, mistake: 0, blunder: 1, missedWin: 0 },
      takebacksOffered: 1,
      takebacksAccepted: 1,
      hintsUsed: 1,
      motifsMissed: [],
      motifsAllowed: ['hangingPiece'],
      openingName: "King's Pawn Game",
      keyMoments: [
        {
          ply: 5,
          fenBefore: fenMove3,
          playedSan: 'Qxe5+',
          bestSan: 'Bc4',
          classification: 'blunder',
          motif: 'hangingPiece',
          explanation: 'Пешку защищает конь, поэтому ферзь пропал бы. Хорошо, что ход был возвращён.',
        },
      ],
    },
    examMode: false,
  };
  return { ...record, ...overrides };
}

/** The sample game played with the teacher: every child move carries the advice it was shown (docs/TEACHER-MODE.md §7.5). */
export function sampleTeacherGameRecord(): GameRecord {
  const base = sampleGameRecord();
  const advised: Record<string, { advice: string[]; followed: 'primary' | 'alternative' | 'own' }> = {
    e4: { advice: ['e4', 'd4'], followed: 'primary' },
    Qh5: { advice: ['Nf3', 'Nc3'], followed: 'own' },
    'Qxe5+': { advice: ['Bc4', 'd4'], followed: 'own' },
    Bc4: { advice: ['Bc4', 'd4'], followed: 'primary' },
    'Qxf7#': { advice: ['Qxf7#'], followed: 'primary' },
  };
  const events = base.events.map((event) => {
    const san = typeof event.data.san === 'string' ? event.data.san : '';
    const extra = event.type === 'move' && event.data.by === 'child' ? advised[san] : undefined;
    return extra ? { ...event, data: { ...event.data, ...extra } } : event;
  });
  events.splice(1, 0, {
    t: 900,
    type: 'coachSaid',
    ply: 0,
    data: {
      kind: 'teachTurn',
      text: 'Начинаем с центра! Пешка на е четыре — или на дэ четыре.',
      teach: { moment: 'openingPlan', style: 'concept', ply: 1, advice: [{ uci: 'e2e4', san: 'e4', source: 'mainLine', arrow: 'green' }, { uci: 'd2d4', san: 'd4', source: 'mainLine', arrow: 'blue' }], conceptId: 'opening-center' },
    },
  });
  return { ...base, events, coachStyle: 'teacher' };
}

export interface TestServer {
  ctx: ServerContext;
  app: ReturnType<typeof createApp>;
  dataDir: string;
  /** app.request with the Host (and, for non-GET, Origin + JSON) headers a real browser would send */
  request(path: string, init?: { method?: string; json?: unknown; headers?: Record<string, string>; body?: string }): Promise<Response>;
  cleanup(): Promise<void>;
}

/**
 * A full server on a temporary DATA_DIR. By default: runtime AI off (as the child's server — GAMBIT_RUNTIME_AI unset),
 * no codex binary, no API key, no puzzle database, no starter file — i.e. only the template provider and the built-in
 * puzzles. A test of a paid / model path opts in with `{ runtimeAi: true }`. Recording new phrases (GAMBIT_CLIP_GEN)
 * is off and never has the real Higgsfield CLI: a test of it injects a fake runner through `overrides.clipGen`.
 */
export async function createTestServer(configOverrides: Partial<ServerConfig> = {}, overrides: ContextOverrides = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'gambit-data-'));
  const config = loadConfig(
    {},
    {
      ...throwAwayPaths(dataDir),
      runtimeAi: false,
      codexBin: null,
      openaiApiKey: null,
      llmProvider: 'auto',
      log: false,
      ...configOverrides,
    },
  );
  return serve(config, dataDir, overrides);
}

/**
 * A server configured from an ENVIRONMENT, as the launcher starts the child's server (`node --env-file-if-exists=.env`):
 * only the paths are overridden (a throw-away DATA_DIR, no puzzle database, no SPA) and the log is off — every other
 * setting (GAMBIT_RUNTIME_AI, LLM_PROVIDER, VOICE_PREFERRED, CODEX_BIN, the keys) comes from `env`. The network stays
 * off (a failing fetch) unless `overrides.fetchImpl` says otherwise.
 */
export async function createEnvTestServer(env: NodeJS.ProcessEnv, overrides: ContextOverrides = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'gambit-data-'));
  return serve(loadConfig(env, { ...throwAwayPaths(dataDir), log: false }), dataDir, overrides);
}

function throwAwayPaths(dataDir: string): Pick<ServerConfig, 'dataDir' | 'puzzlesDbPath' | 'starterPuzzlesPath' | 'webDistDir'> {
  return { dataDir, puzzlesDbPath: join(dataDir, 'build', 'puzzles.sqlite'), starterPuzzlesPath: join(dataDir, 'no-starter.json'), webDistDir: join(dataDir, 'no-dist') };
}

async function serve(config: ServerConfig, dataDir: string, overrides: ContextOverrides): Promise<TestServer> {
  const failingFetch: typeof fetch = () => Promise.reject(new Error('network access is not allowed in tests'));
  // «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): a test server never gets the real Higgsfield CLI — whatever the environment or
  // the overrides say, only an injected fake runner (`overrides.clipGen.runCli`) can answer
  const safe: ServerConfig = { ...config, clipGen: { ...config.clipGen, bin: null } };
  const ctx = await createServerContext(safe, { fetchImpl: failingFetch, ...overrides });
  const app = createApp(ctx);
  return {
    ctx,
    app,
    dataDir,
    async request(path, init = {}) {
      const method = init.method ?? 'GET';
      const headers: Record<string, string> = { host: TEST_HOST };
      if (method !== 'GET') headers.origin = TEST_ORIGIN;
      let body = init.body;
      if (init.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.json);
      }
      return app.request(path, { method, headers: { ...headers, ...init.headers }, body });
    },
    async cleanup() {
      await ctx.idle();
      await ctx.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
