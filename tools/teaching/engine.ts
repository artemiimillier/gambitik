/**
 * The real engines of the report, run silently in Node (docs/TEACHING.md §7): Stockfish 19 lite-single WASM as a
 * child process per engine, driven by the production `createJudgeEngine` / `createBotEngine` of apps/web (loaded by
 * path: the web sources are not part of the tools' typecheck). Copied from tools/voice-clips/harvestWorker.ts, which
 * cannot be imported (it runs its main at import). No network, no audio, no ports.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { AnalysisResult } from '../../packages/shared/src/index.ts';
import { REPO_ROOT } from '../lib/cli.ts';

export const ENGINE_JS = path.join(REPO_ROOT, 'apps', 'web', 'node_modules', 'stockfish', 'bin', 'stockfish-19-lite-single.js');
const ENGINE_DIR = path.join(REPO_ROOT, 'apps', 'web', 'src', 'engine');

export type Rng = () => number;

interface Transport {
  post(cmd: string): void;
  onLine(cb: (line: string) => void): void;
  onError(cb: (err: unknown) => void): void;
  terminate(): void;
}

export interface JudgeLike {
  ready(): Promise<void>;
  newGame(): Promise<void>;
  analyze(fen: string, opts: { depth?: number; multipv?: number; searchmoves?: string[] }): Promise<AnalysisResult>;
  dispose(): void;
}

export interface BotLike {
  ready(): Promise<void>;
  pickMove(fen: string, personaId: string, ctx: { moveNumber: number; remainingMs: number | null }): Promise<{ uci: string }>;
  dispose(): void;
}

export interface Engines {
  judge: JudgeLike;
  bot: BotLike;
  /** a separate, deeper judge for the truth audit (its hash never touches the game's judge) */
  audit: JudgeLike | null;
  /** the bot's random choices come from this stream (set per game) */
  setBotRng(r: Rng): void;
  dispose(): void;
}

function childTransport(): Transport {
  const child = spawn(process.execPath, [ENGINE_JS], { stdio: ['pipe', 'pipe', 'ignore'] });
  let lineCb: ((l: string) => void) | null = null;
  let dead = false;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!dead && line.trim().length > 0) lineCb?.(line);
  });
  child.on('error', () => {
    dead = true;
  });
  return {
    post(cmd) {
      if (!dead) child.stdin.write(`${cmd}\n`);
    },
    onLine(cb) {
      lineCb = cb;
    },
    onError() {},
    terminate() {
      dead = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  };
}

/** The judge, the bot and (with `audit`) the audit judge, ready to use. */
export async function loadEngines(opts: { audit: boolean }): Promise<Engines> {
  if (!existsSync(ENGINE_JS)) throw new Error(`Stockfish is not installed: ${ENGINE_JS} (run pnpm install)`);
  const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(path.join(ENGINE_DIR, file)).href)) as T;
  const { createJudgeEngine } = await load<{ createJudgeEngine: (cfg: { createTransport: () => Transport }) => JudgeLike }>('judgeEngine.ts');
  const { createBotEngine } = await load<{ createBotEngine: (cfg: { createTransport: () => Transport; rng: Rng }) => BotLike }>('botEngine.ts');
  let botRng: Rng = () => 0.5;
  const judge = createJudgeEngine({ createTransport: childTransport });
  const bot = createBotEngine({ createTransport: childTransport, rng: () => botRng() });
  const audit = opts.audit ? createJudgeEngine({ createTransport: childTransport }) : null;
  await judge.ready();
  await bot.ready();
  if (audit) await audit.ready();
  return {
    judge,
    bot,
    audit,
    setBotRng(r) {
      botRng = r;
    },
    dispose() {
      judge.dispose();
      bot.dispose();
      audit?.dispose();
    },
  };
}
