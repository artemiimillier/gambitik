/**
 * Soundness of the strategy library on the REAL engine: Stockfish 19 lite single-threaded WASM, run under Node as a UCI
 * process (the same build the browser uses). Every child move of every `mainLineSan` must be within
 * `STRATEGY_TOLERANCE_CP` of the best move of that position at depth ≥ `STRATEGY_CHECK_DEPTH` — and the first move of
 * every Black system after each first move it answers (`answersUci`), since the intro names it («Ответь …»).
 *
 * Skipped when the engine file is missing (a fresh checkout before `pnpm install`) or outside Node. The Node modules
 * are imported dynamically by name: @gambit/content is isomorphic and its typecheck has no Node types.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { STRATEGIES, getStrategiesFor } from './strategies.ts';

/** = STRATEGY_TOLERANCE_CP of @gambit/core: the teacher advises a planned move up to this gap (never worse than «good»). */
const STRATEGY_TOLERANCE_CP = 50;
const STRATEGY_CHECK_DEPTH = 12;
const ENGINES = 4;

interface ChildProcess {
  stdin: { write(s: string): unknown; end(): unknown };
  stdout: { on(ev: 'data', cb: (chunk: { toString(): string }) => void): unknown };
  on(ev: 'exit' | 'error', cb: () => void): unknown;
  kill(): unknown;
}
interface NodeApi {
  spawn(cmd: string, args: string[], opts?: Record<string, unknown>): ChildProcess;
  existsSync(path: string): boolean;
  execPath: string;
}

const ENGINE_CANDIDATES = [
  '../../../apps/web/node_modules/stockfish/bin/stockfish-19-lite-single.js',
  '../../../node_modules/.pnpm/stockfish@19.0.0/node_modules/stockfish/bin/stockfish-19-lite-single.js',
];

async function nodeApi(): Promise<NodeApi | null> {
  const proc = (globalThis as { process?: { versions?: { node?: string }; execPath?: string } }).process;
  if (!proc?.versions?.node || !proc.execPath) return null;
  try {
    const cpName = 'node:child_process';
    const fsName = 'node:fs';
    const cp = (await import(/* @vite-ignore */ cpName)) as { spawn: NodeApi['spawn'] };
    const fs = (await import(/* @vite-ignore */ fsName)) as { existsSync: NodeApi['existsSync'] };
    return { spawn: cp.spawn, existsSync: fs.existsSync, execPath: proc.execPath };
  } catch {
    return null;
  }
}

const api = await nodeApi();
const enginePath = api ? (ENGINE_CANDIDATES.map((rel) => decodeURIComponent(new URL(rel, import.meta.url).pathname)).find((p) => api.existsSync(p)) ?? null) : null;

interface Score {
  cp: number;
  pv0: string;
}

/** One UCI engine process. */
function startEngine(node: NodeApi, path: string) {
  const child = node.spawn(node.execPath, [path], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const listeners = new Set<(line: string) => void>();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      for (const l of [...listeners]) l(line);
      i = buf.indexOf('\n');
    }
  });
  const send = (cmd: string): void => void child.stdin.write(`${cmd}\n`);
  const waitFor = (re: RegExp): Promise<void> =>
    new Promise((resolve) => {
      const l = (line: string): void => {
        if (re.test(line)) {
          listeners.delete(l);
          resolve();
        }
      };
      listeners.add(l);
    });
  const toCp = (kind: string, v: number): number => (kind === 'mate' ? (v > 0 ? 100_000 - 100 * v : -100_000 - 100 * v) : v);
  return {
    async init(): Promise<void> {
      const ok = waitFor(/^uciok/);
      send('uci');
      await ok;
      const ready = waitFor(/^readyok/);
      send('isready');
      await ready;
    },
    /** MultiPV lines at the check depth (side-to-move scores); `searchmoves` restricts the root. */
    async analyse(fen: string, multipv: number, searchmoves?: string): Promise<Map<number, Score>> {
      const lines = new Map<number, Score>();
      const l = (line: string): void => {
        const m = /^info depth (\d+) .*multipv (\d+) score (cp|mate) (-?\d+).* pv (\S+)/.exec(line);
        if (m && Number(m[1]) >= STRATEGY_CHECK_DEPTH) lines.set(Number(m[2]), { cp: toCp(m[3] as string, Number(m[4])), pv0: m[5] as string });
      };
      listeners.add(l);
      const done = waitFor(/^bestmove/);
      send(`setoption name MultiPV value ${multipv}`);
      send(`position fen ${fen}`);
      send(`go depth ${STRATEGY_CHECK_DEPTH}${searchmoves ? ` searchmoves ${searchmoves}` : ''}`);
      await done;
      listeners.delete(l);
      return lines;
    },
    quit(): void {
      send('quit');
      child.stdin.end();
      setTimeout(() => void child.kill(), 500);
    },
  };
}

interface MoveCheck {
  strategy: string;
  san: string;
  lossCp: number;
}

const onCi = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CI);
// Engine scores at a fixed depth differ by a few centipawns between CPUs, so this content check runs on a developer
// machine (before a strategy change), not on shared CI runners.
describe.skipIf(enginePath === null || api === null || onCi)('strategy lines on the real Stockfish (depth ≥ 12)', () => {
  it(
    `every child move of every main line is within ${STRATEGY_TOLERANCE_CP} cp of the best move`,
    async () => {
      const node = api as NodeApi;
      const engines = Array.from({ length: ENGINES }, () => startEngine(node, enginePath as string));
      await Promise.all(engines.map((e) => e.init()));
      const checks: MoveCheck[] = [];
      try {
        const queue = [...STRATEGIES];
        await Promise.all(
          engines.map(async (engine) => {
            for (let s = queue.shift(); s; s = queue.shift()) {
              const chess = new Chess();
              for (const san of s.mainLineSan) {
                if (chess.turn() === s.side) {
                  const fen = chess.fen();
                  const mv = chess.move(san);
                  chess.undo();
                  const uci = `${mv.from}${mv.to}${mv.promotion ?? ''}`;
                  const top = await engine.analyse(fen, 4);
                  const best = top.get(1);
                  let mine = [...top.values()].find((x) => x.pv0 === uci);
                  if (!mine) mine = (await engine.analyse(fen, 1, uci)).get(1);
                  expect(best, `${s.id} ${san}: no analysis`).toBeDefined();
                  expect(mine, `${s.id} ${san}: no analysis of the move`).toBeDefined();
                  checks.push({ strategy: s.id, san, lossCp: (best as Score).cp - (mine as Score).cp });
                }
                chess.move(san);
              }
            }
          }),
        );
      } finally {
        for (const e of engines) e.quit();
      }
      const childMoves = STRATEGIES.reduce((n, s) => n + s.lineSan.length, 0);
      expect(checks.length).toBe(childMoves);
      const bad = checks.filter((c) => c.lossCp > STRATEGY_TOLERANCE_CP);
      expect(bad, JSON.stringify(bad)).toEqual([]);
    },
    180_000,
  );

  it(
    `the first move of every Black system is within ${STRATEGY_TOLERANCE_CP} cp after each first move it answers`,
    async () => {
      const node = api as NodeApi;
      const positions: { strategy: string; first: string; fen: string; uci: string; san: string }[] = [];
      for (const s of STRATEGIES.filter((card) => card.against === 'other')) {
        const reply = s.lineSan[0] as string;
        for (const first of s.answersUci ?? []) {
          const chess = new Chess();
          chess.move({ from: first.slice(0, 2), to: first.slice(2, 4) });
          const fen = chess.fen();
          const mv = chess.move(reply);
          positions.push({ strategy: s.id, first, fen, uci: `${mv.from}${mv.to}${mv.promotion ?? ''}`, san: mv.san });
        }
      }
      // (the list itself: every first move other than 1.e4 / 1.d4 has at least one system)
      expect(positions.length).toBeGreaterThan(40);
      expect(getStrategiesFor('b', 9, 'g2g4').length).toBeGreaterThan(0);
      const engines = Array.from({ length: ENGINES }, () => startEngine(node, enginePath as string));
      await Promise.all(engines.map((e) => e.init()));
      const checks: MoveCheck[] = [];
      try {
        const queue = [...positions];
        await Promise.all(
          engines.map(async (engine) => {
            for (let p = queue.shift(); p; p = queue.shift()) {
              const top = await engine.analyse(p.fen, 4);
              const best = top.get(1);
              let mine = [...top.values()].find((x) => x.pv0 === p.uci);
              if (!mine) mine = (await engine.analyse(p.fen, 1, p.uci)).get(1);
              expect(best, `${p.strategy} after ${p.first}: no analysis`).toBeDefined();
              expect(mine, `${p.strategy} after ${p.first}: no analysis of the move`).toBeDefined();
              checks.push({ strategy: `${p.strategy} after ${p.first}`, san: p.san, lossCp: (best as Score).cp - (mine as Score).cp });
            }
          }),
        );
      } finally {
        for (const e of engines) e.quit();
      }
      expect(checks.length).toBe(positions.length);
      const bad = checks.filter((c) => c.lossCp > STRATEGY_TOLERANCE_CP);
      expect(bad, JSON.stringify(bad)).toEqual([]);
    },
    180_000,
  );
});
