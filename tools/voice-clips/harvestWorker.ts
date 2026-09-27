/**
 * One worker of `voice:harvest --clip` (free, silent): plays engine games with the REAL coach builders of @gambit/core
 * in clip mode (every ported builder attaches `CoachEvent.clip`) and writes what Гамбитик would say, event by event,
 * as JSON lines (./harvest.ts reads them).
 *
 *   node tools/voice-clips/harvestWorker.ts --out <file.jsonl> --games 3,19,35 [--blitz]
 *
 * Real Stockfish 19 lite-single WASM as a Node child process per engine (the judge and the bot, as the game has them),
 * the production `createJudgeEngine` / `createBotEngine`, the real content (strategies, repertoire, main lines, concept
 * cards, openings). No network, no audio, no ports, no `data/`. Every game is seeded by its index alone (the bot's
 * random choices come from a per-game generator and both engines clear their hash per game), so a game can be
 * re-played on any worker.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Chess } from 'chess.js';
import * as core from '../../packages/core/src/index.ts';
import * as content from '../../packages/content/src/index.ts';
import { lookupOpening } from '../../packages/openings/src/index.ts';
import { TIME_CONTROLS } from '../../packages/shared/src/index.ts';
import type { AnalysisResult, CoachEvent, EngineLine, MoveJudgement, StudentProfile, Talkativeness, TimeControlId } from '../../packages/shared/src/index.ts';
import { REPO_ROOT } from '../lib/cli.ts';
import { gameConfigOf, toHarvestEvent } from './harvest.ts';
import type { HarvestGame, HarvestLine, HarvestPly } from './harvest.ts';

const ENGINE_JS = path.join(REPO_ROOT, 'apps', 'web', 'node_modules', 'stockfish', 'bin', 'stockfish-19-lite-single.js');
const ENGINE_DIR = path.join(REPO_ROOT, 'apps', 'web', 'src', 'engine');

// ───────────────────────── the engines (loaded by path: the web sources are not part of the tools' typecheck) ─────────────────────────

type Rng = () => number;
interface Transport {
  post(cmd: string): void;
  onLine(cb: (line: string) => void): void;
  onError(cb: (err: unknown) => void): void;
  terminate(): void;
}
interface JudgeLike {
  ready(): Promise<void>;
  newGame(): Promise<void>;
  analyze(fen: string, opts: { depth?: number; multipv?: number; searchmoves?: string[] }): Promise<AnalysisResult>;
  dispose(): void;
}
interface BotLike {
  ready(): Promise<void>;
  pickMove(fen: string, personaId: string, ctx: { moveNumber: number; remainingMs: number | null }): Promise<{ uci: string }>;
  dispose(): void;
}

function childTransport(): Transport {
  const child = spawn(process.execPath, [ENGINE_JS], { stdio: ['pipe', 'pipe', 'ignore'] });
  let lineCb: ((l: string) => void) | null = null;
  let dead = false;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!dead && line.trim().length > 0) lineCb?.(line);
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

async function loadEngines(botRng: Rng): Promise<{ judge: JudgeLike; bot: BotLike }> {
  const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(path.join(ENGINE_DIR, file)).href)) as T;
  const { createJudgeEngine } = await load<{ createJudgeEngine: (cfg: { createTransport: () => Transport }) => JudgeLike }>('judgeEngine.ts');
  const { createBotEngine } = await load<{ createBotEngine: (cfg: { createTransport: () => Transport; rng: Rng }) => BotLike }>('botEngine.ts');
  const judge = createJudgeEngine({ createTransport: childTransport });
  const bot = createBotEngine({ createTransport: childTransport, rng: botRng });
  await judge.ready();
  await bot.ready();
  return { judge, bot };
}

/** mulberry32, as apps/web/src/engine/rng.ts (the bot's and the game's random choices are reproducible per seed). */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function profileOf(nickname: string, address: 'm' | 'f', stage: number, games: number): StudentProfile {
  return {
    nickname,
    address,
    stage,
    totals: { games, wins: 2, losses: 2, draws: 1, puzzlesAttempted: 20, puzzlesSolved: 12, minutesPlayed: 90 },
    puzzleRating: { rating: 650, rd: 200, vol: 0.06, attempts: 20, solved: 12, lastSeen: null },
    themeSkills: {},
    recentAccuracy: [60, 70],
    weaknesses: [],
    strengths: [],
    bestWin: null,
    updatedAt: '2026-09-21T10:00:00.000Z',
  } as unknown as StudentProfile;
}

/** Wall time of the child's turn: mostly 1.5–7.5 s, now and then a long think (a 7–10-year-old in a 5-minute game). */
function childThinkMs(rng: Rng): number {
  const base = 1500 + rng() * 6000;
  return Math.round(rng() < 0.1 ? base + 5000 + rng() * 15000 : base);
}

function botThinkMs(rng: Rng): number {
  return Math.round(900 + rng() * 1600);
}

// ───────────────────────── one game ─────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- the simulation drives many core builders with loose shapes */
async function playGame(index: number, engines: { judge: JudgeLike; bot: BotLike }, setBotRng: (r: Rng) => void, out: (line: HarvestLine) => void, blitzOnly: boolean): Promise<void> {
  const cfg = gameConfigOf(index, { blitz: blitzOnly });
  const { judge, bot } = engines;
  const rng = seededRng(cfg.seed);
  setBotRng(seededRng(cfg.seed ^ 0x5bd1e995));
  const gameId = cfg.game;
  const profile = profileOf(cfg.name, cfg.address, cfg.stage, cfg.gamesPlayed);
  const teacher = cfg.coachStyle === 'teacher';
  const childColor = cfg.childColor;
  const persona = content.getPersona(cfg.persona) as any;
  const timeControl = TIME_CONTROLS[cfg.tc as TimeControlId];
  const talk: Talkativeness = cfg.talk;
  const plies: HarvestPly[] = [];
  let n = 0;
  const say = (ev: CoachEvent | null | undefined, family: string): void => {
    if (!ev) return;
    out({ t: 'ev', game: gameId, n: n++, afterPly: plies.length, family, event: toHarvestEvent(ev, `${gameId}-${n}`) });
  };
  try {
    await judge.newGame();
  } catch {
    // a fresh engine
  }
  // the child's and the bot's clocks (the coach's speech holds the child's clock, so only thinking time runs)
  let childLeft: number | null = timeControl.initialMs;
  let botLeft: number | null = timeControl.initialMs;

  say(core.buildGreeting({ profile, hour: cfg.hour }, rng), 'greeting');
  const chess = new Chess();
  const history: string[] = [];
  const judgements: MoveJudgement[] = [];
  const gameEvents: any[] = [];
  const concepts: string[] = [];
  let memory: any = null;
  let pendingReaction: any = null;
  let offersMade = 0;
  let lastOfferPly = -100;
  let lastPraisePly = -100;
  let strategy: any = null;
  let strategyCard: any = null;
  let introSaid = false;
  let openingIdeaSaid = false;
  let declined: MoveJudgement | null = null;
  let lastChildTo: string | null = null;
  let lastBot: { uci: string; san: string; fenBefore: string } | null = null;
  let flagged = false;

  const pickStrategy = (): void => {
    const oppFirst = childColor === 'b' && history[0] ? (() => {
      const c = new Chess();
      const mv = c.move(history[0] as string);
      return `${mv.from}${mv.to}`;
    })() : undefined;
    const card = content.pickStrategyDeterministic(content.getStrategiesFor(childColor, cfg.stage, oppFirst), [], rng) as any;
    if (!card) return;
    strategyCard = card;
    strategy = { strategyId: card.id, titleRu: card.titleRu, ideaRu: card.ideaRu, introRu: '', provider: 'template' };
  };
  const teachStrategy = (): any => core.resolveTeachStrategy({ strategy, strategyCard });
  const teacherStart = (): void => {
    pickStrategy();
    say(core.buildGameStart({ persona, timeControl, childColor, profile, coachStyle: 'teacher', strategy: teachStrategy(), fen: chess.fen() } as any, rng), 'gameStart.teacher');
    introSaid = true;
  };
  if (teacher) {
    if (childColor === 'w') teacherStart();
    else say(core.buildGameHello(profile, rng), 'gameHello');
  } else {
    say(core.buildGameStart({ persona, timeControl, childColor, profile, coachStyle: 'helper', greet: index % 2 === 0 } as any, rng), 'gameStart.helper');
    if (cfg.stage <= 2) say(core.buildThinkingRoutine(profile, rng), 'thinkingRoutine');
  }

  const toUci = (m: { from: string; to: string; promotion?: string }): string => `${m.from}${m.to}${m.promotion ?? ''}`;
  const maxPlies = 70 + Math.floor(rng() * 30);
  while (!chess.isGameOver() && plies.length < maxPlies) {
    const fen = chess.fen();
    if (chess.turn() !== childColor) {
      // ── the bot ──
      const thinkMs = botThinkMs(rng);
      let mv: any;
      try {
        const pick = await bot.pickMove(fen, cfg.persona, { moveNumber: Math.floor(plies.length / 2) + 1, remainingMs: botLeft });
        mv = chess.move({ from: pick.uci.slice(0, 2), to: pick.uci.slice(2, 4), ...(pick.uci[4] ? { promotion: pick.uci[4] } : {}) });
      } catch {
        const moves = chess.moves({ verbose: true });
        mv = chess.move(moves[Math.floor(rng() * moves.length)] as any);
      }
      if (botLeft !== null) botLeft = Math.max(1000, botLeft - thinkMs);
      history.push(mv.san);
      plies.push({ by: 'bot', uci: toUci(mv), san: mv.san, thinkMs });
      lastBot = { uci: toUci(mv), san: mv.san, fenBefore: fen };
      if (declined) {
        const ign: MoveJudgement = declined;
        declined = null;
        if (ign.refutationPvUci[0] === lastBot.uci || (ign.materialLossPawns >= 2 && mv.captured)) {
          say(core.buildExplainBest(ign, profile, rng), 'explainBest.punished');
          if (!teacher) say(core.buildThinkingRoutine(profile, rng), 'thinkingRoutine.afterPunish');
        }
      }
      if (teacher && childColor === 'b' && plies.length === 1 && !strategy) teacherStart();
      if (!teacher && !openingIdeaSaid && history.length >= 4 && history.length <= 16) {
        try {
          const adv = content.getRepertoireAdvice(history, childColor) as any;
          if (adv && !(adv.inBook && adv.matchedPlies < 6)) {
            openingIdeaSaid = true;
            say(core.buildOpeningIdea({ title: adv.lineTitle, idea: adv.idea, warning: adv.warning, profile }, rng), 'openingIdea');
          }
        } catch {
          // no repertoire line
        }
      }
      continue;
    }

    // ── the child's turn ──
    const thinkMs = childThinkMs(rng);
    const analysis = await judge.analyze(fen, { depth: 12, multipv: 3 });
    let threat: any = null;
    try {
      const nf = core.nullMoveFen(fen);
      if (nf && !chess.inCheck()) {
        const t = await judge.analyze(nf, { depth: 10, multipv: 1 });
        if (t.lines[0]) threat = core.threatFromNullMoveLine(fen, t.lines[0]);
      }
    } catch {
      // no threat search
    }
    const facts = core.computePositionFacts(fen);
    let plan: any = null;
    if (teacher) {
      const ctx: any = {
        fen,
        ply: plies.length + 1,
        childColor,
        profile,
        talkativeness: talk,
        analysis,
        threat,
        lastBotMove: lastBot,
        historySan: [...history],
        repertoire: content.getRepertoirePlan(history, childColor) ?? null,
        mainLineSans: content.mainLineMoves(fen),
        openingNameRu: (f: string) => lookupOpening(f)?.nameRu,
        conceptCard: (id: string) => content.getConceptCard(id),
        conceptsIntroduced: [...concepts],
        reaction: pendingReaction,
        memory,
        timed: timeControl.initialMs !== null,
        remainingMs: childLeft,
        strategy,
        strategyCard,
        introSaid,
      };
      pendingReaction = null;
      const verified: EngineLine[] = [];
      for (const uci of core.bookMovesToVerify(ctx)) {
        try {
          const r = await judge.analyze(fen, { depth: 12, searchmoves: [uci] });
          if (r.lines[0]) verified.push(r.lines[0]);
        } catch {
          // not verified
        }
      }
      if (verified.length > 0) ctx.verified = verified;
      plan = core.planTeachTurn(ctx, rng);
      memory = plan.memory;
      for (const c of plan.memory.conceptsThisGame) if (!concepts.includes(c)) concepts.push(c);
      say(core.buildTeachTurn(plan, rng), `teachTurn.${plan.moment}`);
      if (plan.treasure && rng() < 0.5) say(core.buildTeachReveal(plan, rng), 'teachReveal');
      else if (rng() < 0.12) say(core.buildTeachRepeat(plan, rng, { asked: true }), 'teachRepeat');
    } else {
      const tw = core.buildThreatWarning({ fen, facts, profile, threat, lastMove: lastBot ? { san: lastBot.san, fenBefore: lastBot.fenBefore } : null } as any, rng);
      if (tw && rng() < 0.6) say(tw, 'threatWarning');
      if (rng() < 0.2) {
        const top = Math.min(4, 1 + Math.floor(rng() * 4));
        for (let level = 1; level <= top; level++) {
          say(core.buildHint(level as any, { fen, best: analysis, facts, profile } as any, rng), `hint.${level}`);
          gameEvents.push({ t: 0, type: 'hintGiven', ply: plies.length + 1, data: { level } });
        }
      }
    }
    if (childLeft !== null) {
      childLeft -= thinkMs;
      if (childLeft <= 0) {
        flagged = true;
        break;
      }
    }

    // the child's move: 60 % the green arrow, 10 % the blue, 15 % one of the engine's three, 15 % any legal move
    const legal = chess.moves({ verbose: true });
    const lines = analysis.lines;
    const r = rng();
    let uci: string;
    if (teacher && plan && plan.advice.length > 0 && r < 0.6) uci = plan.advice[0].uci;
    else if (teacher && plan && plan.advice.length > 1 && r < 0.7) uci = plan.advice[1].uci;
    else if (r < 0.85 && lines.length > 0) uci = (lines[Math.floor(rng() * lines.length)] as EngineLine).pvUci[0] as string;
    else uci = toUci(legal[Math.floor(rng() * legal.length)] as any);
    const judgeOne = (u: string): Promise<MoveJudgement> =>
      core.judgeMove(judge as any, { fenBefore: fen, uci: u, ply: plies.length + 1, cachedBefore: analysis, quickDepth: 11, confirmDepth: 13 } as any);
    let j = await judgeOne(uci);
    const decision = core.decideIntervention(j, { coachMode: timeControl.coachMode, stage: cfg.stage, offersMade, remainingMs: childLeft, examMode: false, pliesSinceLastOffer: plies.length + 1 - lastOfferPly });
    if (decision.action === 'offerTakeback') {
      offersMade++;
      lastOfferPly = plies.length + 1;
      gameEvents.push({ t: 0, type: 'takebackOffered', ply: plies.length + 1, data: {} });
      say(core.buildTakebackOffer(j, profile, rng, teacher ? { advice: memory?.advice ?? [] } : {}), teacher ? 'takebackOffer.teacher' : 'takebackOffer.helper');
      if (rng() < 0.7) {
        gameEvents.push({ t: 0, type: 'takebackAccepted', ply: plies.length + 1, data: {} });
        say(core.buildTakebackAccepted(profile, rng), 'takebackAccepted');
        if (teacher && plan) say(core.buildTeachRepeat(plan, rng, { asked: false }), 'teachRepeat.afterTakeback');
        const again = rng() < 0.25;
        const alt = again ? toUci(legal[Math.floor(rng() * legal.length)] as any) : teacher && plan?.advice[0] ? plan.advice[0].uci : ((lines[0] as EngineLine | undefined)?.pvUci[0] ?? uci);
        if (alt !== uci) {
          const j2 = await judgeOne(alt);
          const d2 = core.decideIntervention(j2, { coachMode: timeControl.coachMode, stage: cfg.stage, offersMade, remainingMs: childLeft, examMode: false, pliesSinceLastOffer: 0 }, { retryAfterTakeback: true });
          if (d2.action === 'offerTakeback') {
            offersMade++;
            say(core.buildTakebackOffer(j2, profile, rng, { ...(teacher ? { advice: memory?.advice ?? [] } : {}), again: true }), 'takebackOffer.again');
            say(core.buildTakebackDeclined(profile, rng), 'takebackDeclined');
            declined = j2;
          }
          j = j2;
          uci = alt;
        }
      } else {
        say(core.buildTakebackDeclined(profile, rng), 'takebackDeclined');
        if (rng() < 0.6) say(core.buildDeclineReasonReply((['planned', 'dontSee', 'risk'] as const)[Math.floor(rng() * 3)] as any, profile, rng), 'declineReasonReply');
        declined = j;
      }
    }
    judgements.push(j);
    const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
    lastChildTo = mv.to;
    history.push(mv.san);
    plies.push({ by: 'child', uci: toUci(mv), san: mv.san, thinkMs });
    // (after the move is on the board: the praise / the reaction to it, as the game says them)
    if (decision.action !== 'offerTakeback' && teacher) {
      try {
        const prevBot = lastBot ? { uci: lastBot.uci, fenBefore: lastBot.fenBefore } : null;
        let motif: any;
        try {
          motif = core.detectMotif(j.fenBefore, [j.uci, ...j.refutationPvUci]);
        } catch {
          // no motif
        }
        const verdict: any = core.reactionVerdict({ prev: prevBot, judgement: j, advice: memory?.advice ?? [], decision, foundMotif: motif, treasureHidden: !!plan?.treasure, repertoireNextSan: memory?.repertoireNextSan ?? null, stage: cfg.stage } as any);
        if (verdict.kind === 'tactic') say(core.buildPraise(j, profile, rng, verdict.foundMotif), 'praise.teacher');
        else if (verdict.speakNow) {
          const ev = core.buildTeachReaction(verdict, { profile, prev: prevBot, missedTreasureRu: plan?.treasure ? plan.treasure.factRu : null, lastChildMoveTo: lastChildTo, conceptCard: (id: string) => content.getConceptCard(id) } as any, rng);
          if (ev) say(ev, 'teachReaction');
        } else if (['followed', 'ownGood', 'fine'].includes(verdict.kind)) pendingReaction = verdict;
      } catch (e) {
        out({ t: 'error', game: gameId, error: `reaction: ${String(e)}` });
      }
    } else if (decision.action !== 'offerTakeback' && (j.classification === 'best' || j.classification === 'excellent') && plies.length - lastPraisePly >= 6) {
      let motif: any;
      try {
        motif = core.detectMotif(j.fenBefore, [j.uci, ...j.refutationPvUci]);
      } catch {
        // no motif
      }
      if (j.san.includes('#') || motif) {
        lastPraisePly = plies.length;
        say(core.buildPraise(j, profile, rng, motif), 'praise.helper');
      }
    }
  }

  let termination = 'abandoned';
  let result = '*';
  if (flagged) {
    termination = 'timeout';
    result = childColor === 'w' ? '0-1' : '1-0';
  } else if (chess.isCheckmate()) {
    termination = 'checkmate';
    result = chess.turn() === 'w' ? '0-1' : '1-0';
  } else if (chess.isStalemate()) {
    termination = 'stalemate';
    result = '1/2-1/2';
  } else if (chess.isDraw()) {
    termination = 'draw';
    result = '1/2-1/2';
  } else {
    // a long unfinished game: the side ahead «wins on time» or the other resigns most of the time, else unfinished
    const f = core.computePositionFacts(chess.fen());
    const diff = childColor === 'w' ? f.material.diff : -f.material.diff;
    if (Math.abs(diff) >= 3 && rng() < 0.7) {
      termination = rng() < 0.5 ? 'timeout' : 'resign';
      result = diff > 0 === (childColor === 'w') ? '1-0' : '0-1';
    }
  }
  const summary = core.summarizeGame({ judgements, events: gameEvents, stage: cfg.stage });
  say(core.buildGameEnd({ result, childColor, termination, summary, persona, profile, takebacksImproved: 0 } as any, rng), 'gameEnd');
  const game: HarvestGame = {
    t: 'game',
    ...cfg,
    strategyId: strategy?.strategyId ?? null,
    plies,
    result,
    termination,
    clockMs: timeControl.initialMs,
    events: n,
  };
  out(game);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' }, games: { type: 'string' }, blitz: { type: 'boolean' } }, strict: true });
  if (!values.out || !values.games) throw new Error('usage: harvestWorker.ts --out <file> --games 1,2,3 [--blitz]');
  const out = values.out;
  const indices = values.games.split(',').map((s) => Number(s)).filter((x) => Number.isInteger(x) && x >= 0);
  writeFileSync(out, '');
  let botRng: Rng = seededRng(1);
  const engines = await loadEngines(() => botRng());
  const write = (line: HarvestLine): void => appendFileSync(out, `${JSON.stringify(line)}\n`);
  for (const index of indices) {
    try {
      await playGame(index, engines, (r) => (botRng = r), write, values.blitz === true);
    } catch (e) {
      write({ t: 'error', game: `g${index}`, error: String(e instanceof Error ? (e.stack ?? e.message) : e) });
    }
    process.stdout.write(`done ${index}\n`);
  }
  engines.judge.dispose();
  engines.bot.dispose();
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    process.stderr.write(`${String(e instanceof Error ? (e.stack ?? e.message) : e)}\n`);
    process.exit(1);
  },
);
