// Manual integration check: runs the REAL Stockfish 19 lite-single WASM under Node through the production
// parser / UciEngine / judge / bot code (no browser, no Worker).
//
//   node apps/web/src/engine/__manual__/node-smoke.mjs
//
// Needs Node >= 26 (native TypeScript type stripping for the imported .ts sources). Not part of `pnpm test`.
//
// Two Node transports are used:
//   A. in-process: `require('stockfish')('lite-single')` — the package factory returns a PROMISE (research 02, И4),
//      `sendCommand` exists only after it resolves, so commands are buffered until then. Only ONE in-process instance
//      per Node process works (the emscripten loader cannot be initialised twice and it nulls `globalThis.fetch`).
//   B. child process: `node stockfish-19-lite-single.js` over stdin/stdout — killable, so it can exercise the
//      CRITICAL ERROR → automatic restart path exactly like a terminated Worker.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import { Chess } from 'chess.js';

import { UciEngine } from '../UciEngine.ts';
import { createBotEngine } from '../botEngine.ts';
import { BOT_LEVELS } from '../botLevels.ts';
import { createJudgeEngine } from '../judgeEngine.ts';
import { createSeededRng } from '../rng.ts';

const require = createRequire(import.meta.url);

const MIDDLEGAME_FEN = 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2P1PN2/PP1N1PPP/R2QKB1R w KQ - 2 8';
const MATE_IN_TWO_FEN = 'r5k1/5ppp/8/8/8/8/1Q3PPP/1R4K1 w - - 0 1'; // 1.Qb8+ Rxb8 2.Rxb8#
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const rawLog = [];

/** Transport A: in-process WASM through the npm package factory (returns a Promise). */
function createInProcessTransport() {
  let lineCb = null;
  let engine = null;
  let dead = false;
  const backlog = [];
  const enginePromise = require('stockfish')('lite-single');
  assert.ok(enginePromise instanceof Promise, 'stockfish factory must return a Promise when called without a callback');
  enginePromise.then((instance) => {
    engine = instance;
    engine.listener = (line) => {
      if (dead || typeof line !== 'string') return;
      rawLog.push(line);
      lineCb?.(line);
    };
    for (const cmd of backlog.splice(0)) engine.sendCommand(cmd);
  });
  return {
    post(cmd) {
      if (dead) return;
      if (engine === null) backlog.push(cmd);
      else engine.sendCommand(cmd);
    },
    onLine(cb) {
      lineCb = cb;
    },
    terminate() {
      dead = true;
      engine?.sendCommand('stop');
    },
  };
}

/** Transport B: the same WASM build as a child process speaking UCI over stdin/stdout. */
const children = new Set();
function createChildProcessTransport() {
  const enginePath = require.resolve('stockfish/bin/stockfish-19-lite-single.js');
  const child = spawn(process.execPath, [enginePath], { stdio: ['pipe', 'pipe', 'ignore'] });
  children.add(child);
  let lineCb = null;
  let errorCb = null;
  let dead = false;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!dead && line.trim().length > 0) lineCb?.(line);
  });
  child.on('exit', (code) => {
    children.delete(child);
    if (!dead) errorCb?.(new Error(`engine process exited with code ${code}`));
  });
  child.stdin.on('error', () => undefined);
  return {
    post(cmd) {
      if (!dead) child.stdin.write(`${cmd}\n`);
    },
    onLine(cb) {
      lineCb = cb;
    },
    onError(cb) {
      errorCb = cb;
    },
    terminate() {
      dead = true;
      child.kill('SIGKILL');
    },
  };
}

const legalMoves = (fen) => new Set(new Chess(fen).moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`));
const fmtScore = (line) => (line.mate !== null ? `mate ${line.mate}` : `cp ${line.cp}`);
const section = (title) => console.log(`\n=== ${title} ===`);

async function partA() {
  section('A1. judge (in-process WASM): depth 10, MultiPV 3');
  const judge = createJudgeEngine({ createTransport: createInProcessTransport });
  const t0 = performance.now();
  await judge.ready();
  console.log(`handshake ok in ${Math.round(performance.now() - t0)} ms`);

  const result = await judge.analyze(MIDDLEGAME_FEN, { depth: 10, multipv: 3 });
  console.log(`fen      ${result.fen}`);
  console.log(`bestmove ${result.bestmove}   depth ${result.depth}   time ${result.timeMs} ms`);
  for (const line of result.lines) {
    console.log(`  multipv ${line.multipv}  depth ${line.depth}  ${fmtScore(line).padEnd(9)} pv ${line.pvUci.slice(0, 8).join(' ')}`);
  }
  const lastRawInfo = rawLog.filter((l) => l.startsWith('info depth 10 ') && l.includes(' multipv ')).slice(-3);
  console.log('raw engine lines the parser saw (last depth-10 set):');
  for (const raw of lastRawInfo) console.log(`  ${raw.slice(0, 150)}${raw.length > 150 ? ' …' : ''}`);

  const legal = legalMoves(MIDDLEGAME_FEN);
  assert.equal(result.lines.length, 3, 'three MultiPV lines');
  assert.deepEqual(result.lines.map((l) => l.multipv), [1, 2, 3]);
  assert.ok(result.lines.every((l) => l.depth === 10), 'every line reached depth 10');
  assert.ok(result.lines.every((l) => legal.has(l.pvUci[0])), 'every root move is legal');
  assert.equal(new Set(result.lines.map((l) => l.pvUci[0])).size, 3, 'three distinct root moves');
  assert.ok(result.lines.every((l) => (l.cp === null) !== (l.mate === null)), 'exactly one of cp / mate');
  assert.equal(result.bestmove, result.lines[0].pvUci[0], 'bestmove is the first PV move');
  for (let i = 1; i < result.lines.length; i += 1) {
    assert.ok((result.lines[i - 1].cp ?? 0) >= (result.lines[i].cp ?? 0), 'lines are ordered best first');
  }
  // Cross-check against the raw text: the parsed score of multipv 1 equals the last raw depth-10 multipv-1 line.
  const rawBest = rawLog.filter((l) => / depth 10 .* multipv 1 /.test(l) && !/bound/.test(l)).at(-1);
  assert.ok(rawBest?.includes(` score cp ${result.lines[0].cp} `), 'parsed cp matches the raw line');
  // Replaying each PV with chess.js proves the pv tokens were split correctly.
  for (const line of result.lines) {
    const chess = new Chess(MIDDLEGAME_FEN);
    for (const uci of line.pvUci) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }
  console.log('OK: 3 lines, depth 10, legal + replayable PVs, scores match the raw output');

  section('A2. searchmoves (score of one specific move)');
  const only = await judge.analyze(MIDDLEGAME_FEN, { depth: 10, searchmoves: ['h2h4'] });
  console.log(`  h2h4 → ${fmtScore(only.lines[0])} depth ${only.lines[0].depth} pv ${only.lines[0].pvUci.slice(0, 6).join(' ')}`);
  assert.equal(only.bestmove, 'h2h4');
  assert.equal(only.lines.length, 1);
  assert.ok((only.lines[0].cp ?? 0) <= (result.lines[0].cp ?? 0) + 30, 'a side move is not better than the best move');

  section('A3. mate score');
  const mate = await judge.analyze(MATE_IN_TWO_FEN, { depth: 12, multipv: 2 });
  for (const line of mate.lines) console.log(`  multipv ${line.multipv}  ${fmtScore(line).padEnd(9)} pv ${line.pvUci.join(' ')}`);
  assert.equal(mate.lines[0].mate, 2);
  assert.equal(mate.lines[0].cp, null);
  assert.equal(mate.bestmove, 'b2b8');

  section('A4. negative score (side to move is much worse)');
  const losing = await judge.analyze('6k1/5ppp/8/8/8/8/q4PPP/6K1 w - - 0 1', { depth: 10 });
  console.log(`  ${fmtScore(losing.lines[0])}`);
  assert.ok(losing.lines[0].mate !== null ? losing.lines[0].mate < 0 : losing.lines[0].cp < -500);

  section('A5. stop() supersedes a long search');
  const long = judge.analyze(MIDDLEGAME_FEN, { depth: 40, multipv: 3 });
  setTimeout(() => judge.stop(), 150);
  const stopped = await long.then(
    () => null,
    (error) => error,
  );
  assert.equal(stopped?.code, 'stopped');
  console.log(`  rejected with code "${stopped.code}", partial depth ${stopped.partial?.depth}, ${stopped.partial?.lines.length} lines`);
  const after = await judge.analyze(START_FEN, { movetimeMs: 100 });
  console.log(`  next search fine: bestmove ${after.bestmove} depth ${after.depth} (${after.timeMs} ms), restarts ${judge.restartCount}`);
  assert.ok(legalMoves(START_FEN).has(after.bestmove));
  assert.equal(judge.restartCount, 0, 'no restart needed: options were accepted, stop worked');

  section('A6. terminal position is rejected before reaching the engine');
  const terminal = await judge.analyze('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', { depth: 5 }).catch((e) => e);
  assert.equal(terminal.code, 'no-legal-moves');
  console.log(`  ${terminal.code}: ${terminal.message}`);
  judge.dispose();
}

async function partB() {
  section('B1. CRITICAL ERROR (child-process WASM): reject + automatic restart');
  const engine = new UciEngine({ createTransport: createChildProcessTransport, options: { Hash: 16 } });
  const bad = await engine.search({ fen: START_FEN, moves: ['e2e5'], depth: 8 }).catch((e) => e);
  assert.equal(bad.code, 'critical-error');
  console.log(`  rejected: ${bad.message}`);
  const good = await engine.search({ fen: START_FEN, moves: ['e2e4'], depth: 8 });
  console.log(`  after restart #${engine.restartCount}: bestmove ${good.bestmove} (${fmtScore(good.lines[0])})`);
  assert.equal(engine.restartCount, 1);
  assert.ok(legalMoves('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1').has(good.bestmove));

  const none = await engine.search({ fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', depth: 5 }).catch((e) => e);
  assert.equal(none.code, 'no-move');
  console.log(`  stalemate sent raw → ${none.code}: ${none.message}`);
  engine.dispose();

  section('B2. bot ladder on the real engine (seeded rng)');
  const bot = createBotEngine({ createTransport: createChildProcessTransport, rng: createSeededRng(20260921) });
  await bot.ready();
  const legal = legalMoves(MIDDLEGAME_FEN);
  for (const personaId of Object.keys(BOT_LEVELS)) {
    const picks = [];
    for (let i = 0; i < 6; i += 1) {
      const pick = await bot.pickMove(MIDDLEGAME_FEN, personaId, { moveNumber: 12, remainingMs: personaId === 'dima' ? 20_000 : 300_000 });
      assert.ok(legal.has(pick.uci), `${personaId}: illegal move ${pick.uci}`);
      assert.ok(pick.thinkMs >= 400 && pick.thinkMs >= pick.searchMs);
      assert.notEqual(pick.source, 'fallback', `${personaId}: engine failure`);
      picks.push(`${pick.uci}/${pick.source[0]}/${pick.searchMs}ms→${pick.thinkMs}ms`);
    }
    console.log(`  ${personaId.padEnd(7)} ${picks.join('  ')}`);
  }
  assert.equal(bot.restartCount, 0);

  section('B3. a whole bot-vs-bot game stays legal (petya vs nika, max 120 plies)');
  const chess = new Chess();
  let plies = 0;
  while (!chess.isGameOver() && plies < 120) {
    const personaId = chess.turn() === 'w' ? 'petya' : 'nika';
    const pick = await bot.pickMove(chess.fen(), personaId, { moveNumber: chess.moveNumber(), remainingMs: null });
    chess.move({ from: pick.uci.slice(0, 2), to: pick.uci.slice(2, 4), promotion: pick.uci[4] });
    plies += 1;
  }
  console.log(`  ${plies} plies, game over: ${chess.isGameOver()}, checkmate: ${chess.isCheckmate()}, winner: ${chess.isCheckmate() ? (chess.turn() === 'w' ? 'nika (black)' : 'petya (white)') : '-'}`);
  assert.equal(bot.restartCount, 0);
  bot.dispose();
}

try {
  await partA();
  await partB();
  console.log('\nALL SMOKE CHECKS PASSED');
  for (const child of children) child.kill('SIGKILL');
  process.exit(0);
} catch (error) {
  console.error('\nSMOKE CHECK FAILED');
  console.error(error instanceof Error ? (error.stack ?? error.message).slice(0, 2000) : error);
  for (const child of children) child.kill('SIGKILL');
  process.exit(1);
}
