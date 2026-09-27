/**
 * One worker of `pnpm teach:report` (free, silent, local Stockfish): plays the games of its simulated children through
 * the lesson director of @gambit/core ONLY (lessonGameStart / lessonTurn / lessonAnswer / lessonReaction /
 * lessonTakebackOffer / lessonTakebackReply / lessonReveal / lessonRepeat / lessonWhy / lessonOpponent / lessonHurry /
 * lessonEnd) plus the unchanged chess helpers the game uses (judgeMove, decideIntervention, computePositionFacts, the
 * null-move threat, bookMovesToVerify, the strategies of @gambit/content), in the order of the game store, and writes
 * every utterance as JSON lines (./config.ts records). As the store: the take-back offer gets only the advice the child
 * saw, «Верну» → reply + `lessonRepeat` + the move again (another losing move is offered back once more: «и этот
 * ход…»; the same move is «insisted»), a hidden advice's hints stop when it is shown (`stopHints`, `lessonHintsLive`), a
 * quiz answer puts the arrow on the board only when its words speak of the move (else it waits for «Совет»). Each turn
 * also records the danger the lesson found (its cadence class as the lesson counted it, said or not) for the §2.2
 * cadence of the report.
 *
 *   node tools/teaching/worker.ts --out <file.jsonl> --children 1:10,4:10 --seed 20260924 [--audit]
 *        [--voice lazy|k<K>[c]] [--voice-pricing pack|unit] [--daily-cap N] [--games-per-day N]
 *        [--state-dir DIR --first N] [--voice-seed FILE]
 *
 * «Дозапись голоса» (the voice simulation): `--voice` keeps a cache of recorded units per child (./config.ts
 * `VoiceSpec`), records every utterance's recordable units (`EvRecord.vu`: voiced when said, recorded right after) and
 * adds the missing ones to the cache right after it was said — one request priced by the pack recipe, under the day's
 * cap (./voice.ts `recordAfter`; a child plays `--games-per-day` games a day); `k<K>` gives the book the «recorded first»
 * policy through its live `voice` getter. `--state-dir` stores each child's state (book history, strategies, concepts,
 * cache, the day's spend) after every game and `--first N` starts at the child's game N from it (the CLI's rounds,
 * where the cache is shared between the children between rounds). `--voice-seed` pre-fills a new child's cache
 * (`{"<child>": [unit keys]}` or `{"*": [...]}`: the prefetch). Without `--voice` nothing of this runs and the records
 * are exactly the report's (an event's `saySentences` is never copied into the log either: docs/voice-clips/ONDEMAND.md).
 *
 * Separate random streams per game: the simulated child (`seed`), the phrase book (`bookSeed`, the book's own PRNG),
 * the bot (`botSeed`), the strategy choice (`stratSeed`) and the «было» words (`legacySeed`); both engines clear their
 * hash per game, so a game plays the same on any worker. A child's games run in order in one worker: its book history
 * and strategy history carry over, as the app's localStorage does. The audit engine is a third Stockfish (its hash
 * never touches the game). No network, no audio, no ports, no data/.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Chess } from 'chess.js';
import * as core from '../../packages/core/src/index.ts';
import type { LessonBook, LessonTurnResult, LessonVoicePolicy, TeachContext, TeachDanger, TeachMemory, TeachPlan } from '../../packages/core/src/index.ts';
import * as content from '../../packages/content/src/index.ts';
import { lookupOpening } from '../../packages/openings/src/index.ts';
import { TIME_CONTROLS } from '../../packages/shared/src/index.ts';
import type {
  AnalysisResult,
  CoachEvent,
  Color,
  EngineLine,
  GameEvent,
  GameResult,
  InterventionDecision,
  MotifId,
  MoveJudgement,
  StudentProfile,
  Termination,
  Threat,
} from '../../packages/shared/src/index.ts';
import { adviceSaves, engineProof, lineWin } from '../../packages/core/src/coach/lesson/truth.ts';
import { dangerClass, mistakeJustTold } from '../../packages/core/src/coach/lesson/turn.ts';
import { CHILD_NAMES, CHILD_POLICY as P, DEFAULT_VOICE_MONEY, ENGINE, FAMILY_RU, gameConfigs, parseVoiceMoney, parseVoiceSpec, seededRng } from './config.ts';
import type {
  AuditItem,
  DangerRecord,
  EvMoment,
  EvRecord,
  EvSource,
  GameConfig,
  GameRecord,
  MoveHow,
  PlyRecord,
  QuizHow,
  RunLine,
  TakebackTry,
  TurnRecord,
  VoiceMoney,
  VoiceSpec,
  VoiceUnitRecord,
} from './config.ts';
import { dayOfGame, recordAfter, voiceUnitsOf } from './voice.ts';
import type { VoiceDay } from './voice.ts';
import { loadEngines } from './engine.ts';
import type { Engines, Rng } from './engine.ts';
import { auditBestVerdict, auditPraiseVerdict, auditQuizVerdict, boardShowsAdvice, claimsBestLead } from './report.ts';
import type { DeepView } from './report.ts';

// ───────────────────────── the child ─────────────────────────

/** What one simulated child keeps between games (the app's localStorage). */
export interface ChildState {
  /** `gambit.lessonBook` — the book's cross-game history */
  history: unknown;
  /** the strategies of the past games, oldest first (the server's history, per colour) */
  strategies: { id: string; side: Color }[];
  /** `gambit.teacher.concepts` */
  concepts: string[];
  /** (voice simulation only) the recorded units (`lessonUnitKey` / `lessonQuizKey`) this child's voice can play */
  voiced?: Set<string>;
  /** (voice simulation only) what the simulated server spent on this child's current day, and whether the cap paused it */
  voiceDay?: VoiceDay;
}

/** A child's state as a JSON file (the rounds of a shared-cache voice simulation). */
export function childStateToJson(s: ChildState): string {
  return JSON.stringify({
    history: s.history ?? null,
    strategies: s.strategies,
    concepts: s.concepts,
    ...(s.voiced ? { voiced: [...s.voiced].sort() } : {}),
    ...(s.voiceDay ? { voiceDay: s.voiceDay } : {}),
  });
}

export function childStateFromJson(text: string): ChildState {
  const o = JSON.parse(text) as { history?: unknown; strategies?: ChildState['strategies']; concepts?: string[]; voiced?: string[]; voiceDay?: VoiceDay };
  return {
    history: o.history ?? undefined,
    strategies: o.strategies ?? [],
    concepts: o.concepts ?? [],
    ...(o.voiced ? { voiced: new Set(o.voiced) } : {}),
    ...(o.voiceDay ? { voiceDay: o.voiceDay } : {}),
  };
}

function profileOf(cfg: GameConfig): StudentProfile {
  return {
    nickname: cfg.name,
    address: cfg.address,
    stage: cfg.stage,
    totals: { games: cfg.gamesPlayed, wins: 2, losses: 2, draws: 1, puzzlesAttempted: 20, puzzlesSolved: 12, minutesPlayed: 90 },
    puzzleRating: { rating: 650, rd: 200, vol: 0.06, attempts: 20, solved: 12, lastSeen: null },
    themeSkills: {},
    recentAccuracy: [60, 70],
    weaknesses: [],
    strengths: [],
    bestWin: null,
    updatedAt: '2026-09-24T10:00:00.000Z',
  } as unknown as StudentProfile;
}

/** The child's own thinking: mostly 1.5–7.5 s, now and then a long think (a 7–10-year-old). */
function childThinkMs(rng: Rng): number {
  const base = 1500 + rng() * 6000;
  return Math.round(rng() < 0.1 ? base + 5000 + rng() * 15000 : base);
}

function botThinkMs(rng: Rng): number {
  return Math.round(900 + rng() * 1600);
}

type MoveLike = { from: string; to: string; promotion?: string };
const toUci = (m: MoveLike): string => `${m.from}${m.to}${m.promotion ?? ''}`;
const fromUci = (u: string): MoveLike => ({ from: u.slice(0, 2), to: u.slice(2, 4), ...(u[4] ? { promotion: u[4] } : {}) });

function momentOf(ev: CoachEvent, source: EvSource): EvMoment {
  const pools = (ev.say ?? []).map((s) => s.pool);
  switch (source) {
    case 'start':
      return pools[0]?.startsWith('v3.recall.') ? 'recall' : 'theme';
    case 'reaction':
      if (ev.kind === 'praise') return 'praise';
      if (pools.some((p) => p.startsWith('v3.result.'))) return 'result';
      if (pools.some((p) => p.startsWith('v3.mistake.') || p.startsWith('v3.rule.'))) return 'mistake';
      return 'reaction';
    case 'takebackOffer':
    case 'takebackReply':
      return 'takeback';
    case 'bark':
      return 'quiet';
    case 'turn':
      return 'advice';
    default:
      return source;
  }
}

/** Moves tried in one position with take-back offers (the store has no hard limit; the budget and cooldown end it). */
const MAX_TRIES = 4;

/** What the lesson package keeps of a turn besides the frozen `LessonTurnPlan` (./lesson/turn.ts `TurnPlanX`). */
interface TurnPlanExtra {
  revealLater?: boolean;
  x?: { danger?: TeachDanger | null; dangerCls?: DangerRecord['cls'] | null; turnNo?: number } | null;
}

function turnExtra(plan: TeachPlan): TurnPlanExtra {
  return (plan.lesson as TurnPlanExtra | undefined) ?? {};
}

/**
 * The danger of the turn as the lesson saw it (§2.2): its cadence class this turn (the plan's `dangerCls`: a warning
 * repeated about the same piece on the same square counts as «other»; else the static `dangerClass`), whether the
 * advice saves it, whether it was said.
 */
function dangerRecordOf(plan: TeachPlan, memBefore: TeachMemory, result: LessonTurnResult, fen: string, ply: number): DangerRecord | null {
  const x = turnExtra(plan).x;
  const d = x?.danger;
  if (!d) return null;
  const lm = core.restoreTeachMemory(memBefore).lesson ?? core.initialLessonMemory();
  const uci = result.advice[0]?.uci ?? null;
  const safe = <T>(f: () => T, dflt: T): T => {
    try {
      return f();
    } catch {
      return dflt;
    }
  };
  const base = safe<DangerRecord['cls']>(() => dangerClass(d, fen), 'other');
  const cls = x?.dangerCls ?? base;
  return {
    kind: d.kind,
    piece: d.piece?.piece ?? null,
    square: d.piece?.square ?? null,
    cls,
    ...(cls !== base ? { baseCls: base } : {}),
    saves: uci ? safe(() => adviceSaves(d, fen, uci), false) : false,
    justTold: safe(() => mistakeJustTold(lm, ply, d), false),
    spoken: result.moment === 'danger',
  };
}

interface AuditTodo {
  kind: AuditItem['kind'];
  ply: number;
  fen: string;
  uci: string;
  claim: string;
  n: number;
  quiz?: { kind: string; correctId: string; optionIds: string[]; captureUci: string | null };
  praise?: { reason: string; san: string };
}

// ───────────────────────── one game ─────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- the TeachContext / strategy shapes of the game store are loose */
export async function playGame(cfg: GameConfig, state: ChildState, eng: Engines, auditOn: boolean, voice: VoiceSpec | null = null, money: VoiceMoney = DEFAULT_VOICE_MONEY): Promise<RunLine[]> {
  const policy = seededRng(cfg.seed);
  const stratRng = seededRng(cfg.stratSeed);
  const legacyRng = seededRng(cfg.legacySeed);
  eng.setBotRng(seededRng(cfg.botSeed));
  try {
    await eng.judge.newGame();
  } catch {
    // a fresh engine
  }
  const profile = profileOf(cfg);
  const tcDef = TIME_CONTROLS[cfg.tc];
  const childColor = cfg.childColor;
  const persona = content.getPersona(cfg.persona as any);
  // a new book per game from the child's stored history (as the app: createLessonBook({ seed, history }))
  // (voice simulation: the child's cache of recorded units; `k<K>` gives the book the «recorded first» policy)
  const cache: Set<string> | null = voice ? (state.voiced ??= new Set<string>()) : null;
  if (cache) {
    // a new day of this child: the simulated server's daily cap starts afresh
    const day = dayOfGame(cfg.gameNo, money.gamesPerDay);
    if (state.voiceDay?.day !== day) state.voiceDay = { day, milli: 0, capped: false };
  }
  const voicePolicy: LessonVoicePolicy | null =
    voice?.mode === 'k' && cache ? { voiced: (k: string) => cache.has(k), minVoiced: voice.k, growCheap: voice.growCheap } : null;
  const book: LessonBook = core.createLessonBook({
    seed: cfg.bookSeed,
    history: state.history,
    ...(voicePolicy ? { voice: () => voicePolicy } : {}),
  });
  let memory: TeachMemory = core.initialTeachMemory();
  const chess = new Chess();
  const history: string[] = [];
  const plies: PlyRecord[] = [];
  const turns: TurnRecord[] = [];
  const evs: EvRecord[] = [];
  const judgements: MoveJudgement[] = [];
  const gameEvents: GameEvent[] = [];
  const todo: AuditTodo[] = [];
  let childLeft: number | null = tcDef.initialMs;
  let botLeft: number | null = tcDef.initialMs;
  let strategy: any = null;
  let strategyCard: any = null;
  let teachStrategy: any = null;
  let family: string | null = null;
  let legacyStart: string | null = null;
  let lastBot: { uci: string; san: string; fenBefore: string } | null = null;
  let offersMade = 0;
  let lastOfferPly = -100;
  let flagged = false;

  interface SayMeta {
    source: EvSource;
    moment?: EvMoment;
    ply: number;
    afterPly: number;
    atMs: number;
    advice?: string | null;
    pressed?: EvRecord['pressed'];
    arrowHidden?: boolean;
  }
  const say = (ev: CoachEvent | null | undefined, m: SayMeta): EvRecord | null => {
    if (!ev) return null;
    const text = ev.text ?? '';
    const empty = text.trim() === '';
    // the single choke point of what was said (the book's «two in a row never open with one word»)
    if (!empty) book.noteSaid(text);
    // (voice simulation) which units had a recording when said; then the server records the missing ones at once
    let vu: VoiceUnitRecord[] | undefined;
    if (cache && state.voiceDay && !empty && (ev.say?.length ?? 0) > 0) {
      const units = voiceUnitsOf({ say: ev.say ?? [], text, ...(ev.quiz ? { quiz: ev.quiz } : {}) });
      const heard = units.map((u) => cache.has(u.k));
      const { recorded, day } = recordAfter(units, cache, money, state.voiceDay);
      state.voiceDay = day;
      for (const k of recorded) cache.add(k);
      vu = units.map((u, i) => ({ k: u.k, t: u.t, s: u.s, ...(heard[i] ? { v: 1 as const } : {}), ...(recorded.has(u.k) ? { r: 1 as const } : {}) }));
    }
    const rec: EvRecord = {
      t: 'ev',
      game: cfg.game,
      n: evs.length,
      afterPly: m.afterPly,
      ply: m.ply,
      atMs: m.atMs,
      source: m.source,
      moment: m.moment ?? momentOf(ev, m.source),
      kind: ev.kind,
      priority: ev.priority,
      text,
      bubble: ev.bubbleText ?? '',
      say: ev.say ?? [],
      cues: ev.cues ?? [],
      ...(ev.board ? { board: ev.board } : {}),
      ...(ev.quiz ? { quiz: ev.quiz } : {}),
      ...(ev.teach?.moment ? { teachMoment: ev.teach.moment } : {}),
      ...(m.advice !== undefined ? { advice: m.advice } : {}),
      ...(m.pressed ? { pressed: m.pressed } : {}),
      ...(m.arrowHidden ? { arrowHidden: true } : {}),
      ...(empty ? { empty: true } : {}),
      ...(vu ? { vu } : {}),
    };
    evs.push(rec);
    return rec;
  };
  /** «лучше всего» leads go to the audit */
  const noteBest = (rec: EvRecord | null, ply: number, fen: string, uci: string | null): void => {
    if (rec && uci && !rec.empty && claimsBestLead(rec.say)) todo.push({ kind: 'best', ply, fen, uci, claim: '«лучше всего»', n: rec.n });
  };

  // ── the theme of the game (White: before move 1; Black: after the opponent's first move) ──
  const pickStrategy = (): void => {
    let oppFirst: string | undefined;
    if (childColor === 'b' && history[0]) {
      const c = new Chess();
      const mv = c.move(history[0]);
      oppFirst = toUci(mv);
    }
    const cands = content.getStrategiesFor(childColor, cfg.stage, oppFirst);
    const past = state.strategies.filter((s) => s.side === childColor).map((s) => s.id);
    const card = content.pickStrategyDeterministic(cands, past, stratRng) as any;
    if (!card) return;
    strategyCard = card;
    strategy = { strategyId: card.id, titleRu: card.titleRu, ideaRu: card.ideaRu, introRu: '', provider: 'template' };
    teachStrategy = core.resolveTeachStrategy({ strategy, strategyCard } as any);
    const primary = (content.THEME_PRIMARY_FAMILY as Record<string, string | undefined>)[card.id];
    family = primary ?? (card.themes ?? []).find((t: string) => t in FAMILY_RU) ?? null;
  };
  const lessonStart = (): void => {
    pickStrategy();
    try {
      legacyStart = core.buildGameStart({ persona, timeControl: tcDef, childColor, profile, coachStyle: 'teacher', strategy: teachStrategy, fen: chess.fen() } as any, legacyRng).text;
    } catch {
      legacyStart = null;
    }
    const r = core.lessonGameStart({ profile, childColor, tc: cfg.tc, coachStyle: 'teacher', strategy: teachStrategy, strategyCard, historySan: [...history], fen: chess.fen() }, memory, book);
    memory = r.memory;
    for (const ev of r.events) say(ev, { source: 'start', ply: plies.length + 1, afterPly: plies.length, atMs: 0 });
  };

  const foundMotifOf = (j: MoveJudgement): MotifId | undefined => {
    try {
      return core.detectMotif(j.fenBefore, [j.uci, ...j.refutationPvUci]);
    } catch {
      return undefined;
    }
  };

  // ── one child turn ──
  const childTurn = async (fen: string): Promise<boolean> => {
    const ply = plies.length + 1;
    const analysis: AnalysisResult = await eng.judge.analyze(fen, { depth: ENGINE.judge.depth, multipv: ENGINE.judge.multipv });
    let threat: Threat | null | undefined;
    try {
      const nf = chess.inCheck() ? null : core.nullMoveFen(fen);
      if (nf) {
        const t = await eng.judge.analyze(nf, { depth: ENGINE.threat.depth, multipv: ENGINE.threat.multipv });
        threat = t.lines[0] ? core.threatFromNullMoveLine(fen, t.lines[0]) : null;
      }
    } catch {
      threat = undefined;
    }
    const ctx: TeachContext = {
      fen,
      ply,
      childColor,
      profile,
      talkativeness: 'normal',
      analysis,
      ...(threat !== undefined ? { threat } : {}),
      lastBotMove: lastBot,
      historySan: [...history],
      repertoire: (content.getRepertoirePlan(history, childColor) as any) ?? null,
      mainLineSans: content.mainLineMoves(fen),
      openingNameRu: (f: string) => lookupOpening(f)?.nameRu,
      conceptCard: (id: string) => content.getConceptCard(id),
      conceptsIntroduced: [...state.concepts],
      reaction: null,
      memory,
      facts: core.computePositionFacts(fen),
      timed: tcDef.initialMs !== null,
      remainingMs: childLeft,
      strategy: teachStrategy,
      strategyCard,
      introSaid: true,
      tc: cfg.tc,
      lessonHistory: book.history(),
    };
    const verified: EngineLine[] = [];
    for (const uci of core.bookMovesToVerify(ctx as any)) {
      try {
        const r = await eng.judge.analyze(fen, { depth: ENGINE.verify.depth, searchmoves: [uci] });
        if (r.lines[0]) verified.push(r.lines[0]);
      } catch {
        // not verified
      }
    }
    if (verified.length > 0) ctx.verified = verified;

    const memBefore = memory;
    const turn = core.lessonTurn(ctx, book);
    const plan: TeachPlan = turn.plan;
    const result: LessonTurnResult = turn.result;
    memory = turn.memory;
    const extra = turnExtra(plan);
    const danger = dangerRecordOf(plan, memBefore, result, fen, ply);
    const turnInfo = {
      ...(typeof extra.x?.turnNo === 'number' ? { turnNo: extra.x.turnNo } : {}),
      ...(extra.revealLater === true ? { revealLater: true } : {}),
      ...(danger ? { danger } : {}),
    };
    for (const c of plan.memory.conceptsThisGame ?? []) if (!state.concepts.includes(c)) state.concepts.push(c);
    // the «было»: the template teacher's words for the same plan (its own random stream; never said)
    let legacy: string | null = null;
    try {
      legacy = core.buildTeachTurn(plan, legacyRng)?.text ?? null;
    } catch {
      legacy = null;
    }
    const advice0 = result.advice[0] ?? null;
    const adviceUci = advice0?.uci ?? null;
    const before = ply - 1;
    if (result.event) {
      const rec = say(result.event, { source: 'turn', moment: result.moment, ply, afterPly: before, atMs: 0, advice: adviceUci, arrowHidden: result.adviceHidden });
      noteBest(rec, ply, fen, adviceUci);
    } else if (result.bark) {
      evs.push({ t: 'ev', game: cfg.game, n: evs.length, afterPly: before, ply, atMs: 0, source: 'bark', moment: 'quiet', kind: 'bark', priority: 0, text: result.bark, bubble: '', say: [], cues: [], ...(result.board ? { board: result.board } : {}) });
    }
    let hurry = false;
    if (plan.hurry) {
      hurry = true;
      say(core.lessonHurry(profile, book), { source: 'hurry', ply, afterPly: before, atMs: 0 });
    }

    // ── the simulated child: the quiz, the hidden arrow, the buttons ──
    let t = 0;
    let heldMs = 0;
    let arrowShown = !result.adviceHidden;
    let reveal: TurnRecord['reveal'] = null;
    let quizRec: TurnRecord['quiz'] = null;
    let quizAnswered = false;
    let decided: MoveHow | null = null;
    const buttons: TurnRecord['buttons'] = [];
    // the hints of a hidden advice stop once it is shown (the reveal, «Совет», an answer with the advice: `stopHints`,
    // §2.7) — the store cancels their timers then and its hint timer asks `lessonHintsLive`; «Почему так?» and an answer
    // whose advice words did not fit keep them (the advice is still hidden)
    let hintsStopMs: number | null = null;
    /** a call that showed the advice left the planned hints alive (`stopHints: false` or `lessonHintsLive`: a broken contract) */
    let hintsKept = false;
    const stopHints = (at: number, r: object, shown: boolean): void => {
      const says = (r as { stopHints?: boolean }).stopHints;
      const live = core.lessonHintsLive(plan, memory);
      if (shown && (says === false || live)) {
        if (result.hints.length > 0) hintsKept = true;
        return;
      }
      if ((says === true || !live) && hintsStopMs === null) hintsStopMs = at;
    };
    const sovet = (at: number): void => {
      const r = core.lessonRepeat(plan, memory, book);
      memory = r.memory;
      stopHints(at, r, !!adviceUci);
      const rec = say(r.event, { source: 'repeat', ply, afterPly: before, atMs: at, advice: adviceUci });
      noteBest(rec, ply, fen, adviceUci);
      buttons.push('sovet');
      if (!arrowShown) reveal = { atMs: at, by: 'button' };
      arrowShown = true;
    };
    if (result.quiz) {
      const q = result.quiz;
      const r = policy();
      const answerAt = Math.round(2000 + policy() * 6000);
      let how: QuizHow;
      let pressed: string | null = null;
      if (r < P.quiz.right) {
        how = 'right';
        pressed = q.correctId;
      } else if (r < P.quiz.right + P.quiz.wrong) {
        how = 'wrong';
        const wrong = q.options.filter((o) => o.id !== q.correctId);
        pressed = wrong[Math.min(wrong.length - 1, Math.floor(policy() * wrong.length))]?.id ?? null;
      } else {
        const r2 = policy();
        how = r2 < P.quizIgnore.moveNow ? 'moved' : r2 < P.quizIgnore.moveNow + P.quizIgnore.sovet ? 'sovet' : 'timeout';
      }
      let atMs = answerAt;
      // (the answer shows the advice arrow only with words about the move; else the arrow waits for «Совет», §2.2)
      if (how === 'right' || how === 'wrong') {
        const a = core.lessonAnswer(plan, memory, pressed, book);
        memory = a.memory;
        const shown = boardShowsAdvice(a.event.board ?? a.board, adviceUci);
        stopHints(atMs, a, shown);
        const label = q.options.find((o) => o.id === pressed)?.label ?? null;
        const rec = say(a.event, { source: 'answer', ply, afterPly: before, atMs, advice: adviceUci, pressed: { optionId: pressed, label, correct: a.correct, how }, arrowHidden: !shown && !!adviceUci });
        noteBest(rec, ply, fen, adviceUci);
        if (shown) arrowShown = true;
        quizAnswered = true;
      } else if (how === 'timeout') {
        atMs = result.revealAfterMs ?? core.treasureRevealMs(cfg.stage) + 10_000;
        const a = core.lessonAnswer(plan, memory, null, book);
        memory = a.memory;
        const shown = boardShowsAdvice(a.event.board ?? a.board, adviceUci);
        stopHints(atMs, a, shown);
        const rec = say(a.event, { source: 'answer', ply, afterPly: before, atMs, advice: adviceUci, pressed: { optionId: null, label: null, correct: null, how }, arrowHidden: !shown && !!adviceUci });
        noteBest(rec, ply, fen, adviceUci);
        if (shown) {
          reveal = { atMs, by: 'timeout' };
          arrowShown = true;
        }
      } else if (how === 'sovet') {
        sovet(atMs);
      } else {
        decided = 'guess';
      }
      // the quiz holds the child's clock (≤ 25 s)
      heldMs = Math.min(atMs, 25_000);
      t = atMs;
      const qp: any = plan.lesson?.quiz ?? null;
      quizRec = {
        id: q.id,
        kind: q.kind,
        question: q.question,
        options: q.options.map((o) => ({ id: o.id, label: o.label, ...(o.icon ? { icon: o.icon } : {}) })),
        correctId: q.correctId,
        how,
        pressed,
        atMs,
        captureUci: qp?.questionFacts?.move?.uci ?? null,
      };
      todo.push({
        kind: 'quiz',
        ply,
        fen,
        uci: adviceUci ?? '',
        claim: `${q.kind} → ${q.correctId}`,
        n: evs.find((e) => e.quiz?.id === q.id)?.n ?? -1,
        quiz: { kind: q.kind, correctId: q.correctId, optionIds: q.options.map((o) => o.id), captureUci: quizRec.captureUci ?? null },
      });
    } else if (result.adviceHidden && advice0) {
      // «Сам», a treasure, a stage-5 reveal-later: find it, or wait for the reveal («Совет» brings it sooner)
      if (policy() < P.findHidden) decided = 'found';
      else {
        const revealAt = result.revealAfterMs ?? 15_000;
        if (policy() < P.sovet) {
          const at = Math.min(revealAt - 500, Math.round(3000 + policy() * 3000));
          sovet(at);
          t = at;
        } else {
          const r = core.lessonReveal(plan, memory, book);
          memory = r.memory;
          stopHints(revealAt, r, true);
          const rec = say(r.event, { source: 'reveal', ply, afterPly: before, atMs: revealAt, advice: adviceUci });
          noteBest(rec, ply, fen, adviceUci);
          reveal = { atMs: revealAt, by: 'timeout' };
          arrowShown = true;
          t = revealAt;
        }
      }
    }
    if (decided !== 'guess') {
      if (lastBot && policy() < P.opponent) {
        t += 1500;
        const r = core.lessonOpponent({ profile, fenBefore: lastBot.fenBefore, uci: lastBot.uci, childFen: fen, threat }, memory, book);
        say(r.event, { source: 'opponent', ply, afterPly: before, atMs: t });
        buttons.push('opponent');
      }
      if (policy() < P.why) {
        t += 1500;
        const r = core.lessonWhy(plan, memory, book);
        memory = r.memory;
        // («Почему так?» never shows a hidden advice: its hints go on unless it says otherwise)
        if ((r as { stopHints?: boolean }).stopHints === true && hintsStopMs === null && !arrowShown) hintsStopMs = t;
        say(r.event, { source: 'why', ply, afterPly: before, atMs: t, arrowHidden: !arrowShown });
        buttons.push('why');
      }
      if (decided === null && !buttons.includes('sovet') && policy() < P.sovet) {
        t += 1500;
        sovet(t);
      }
    }

    // ── the move ──
    const legal = chess.moves({ verbose: true });
    const lines = analysis.lines;
    const pv = (): string | null => {
      if (lines.length === 0) return null;
      return (lines[Math.min(lines.length - 1, Math.floor(policy() * lines.length))] as EngineLine).pvUci[0] ?? null;
    };
    const anyMove = (): string => toUci(legal[Math.min(legal.length - 1, Math.floor(policy() * legal.length))] as MoveLike);
    let how: MoveHow;
    let uci: string;
    if (decided === 'found' && adviceUci) {
      how = 'found';
      uci = adviceUci;
    } else if (decided === 'guess') {
      const g = policy() < 0.65 ? pv() : null;
      how = g ? 'pv' : 'random';
      uci = g ?? anyMove();
    } else {
      const r = policy();
      const second = lines[1]?.pvUci[0] ?? null;
      if (adviceUci && arrowShown && r < P.move.arrow) {
        how = 'arrow';
        uci = adviceUci;
      } else if (second && r < P.move.arrow + P.move.second) {
        how = 'second';
        uci = second;
      } else if (r < P.move.arrow + P.move.second + P.move.pv && lines.length > 0) {
        how = 'pv';
        uci = pv() ?? anyMove();
      } else {
        how = 'random';
        uci = anyMove();
      }
    }
    const think = childThinkMs(policy);
    let moveMs: number;
    if (decided === 'found') moveMs = Math.min(t + think, Math.max(1000, (result.revealAfterMs ?? 15_000) - 500));
    else if (decided === 'guess') moveMs = t + 800;
    else moveMs = t + think;
    if (childLeft !== null) {
      childLeft -= Math.max(0, moveMs - heldMs);
      if (childLeft <= 0) {
        flagged = true;
        turns.push({ ply, fen, moment: result.moment, ...turnInfo, advice: advice0 ? { uci: advice0.uci, san: advice0.san } : null, adviceHidden: result.adviceHidden, revealAfterMs: result.revealAfterMs, hints: result.hints, hintsStopMs, ...(hintsKept ? { hintsKept } : {}), quiz: quizRec, reveal, buttons, move: { uci: '', san: '', how, arrowShown, thinkMs: moveMs }, legacy, ...(hurry ? { hurry } : {}) });
        return false;
      }
    }

    // ── judged, then praise / a mistake / the take-back offer (said while the bot thinks) ──
    const judgeOne = (u: string): Promise<MoveJudgement> =>
      core.judgeMove(eng.judge as any, { fenBefore: fen, uci: u, ply, cachedBefore: analysis, quickDepth: ENGINE.judgeMove.quickDepth, confirmDepth: ENGINE.judgeMove.confirmDepth } as any);
    const react = (j: MoveJudgement, decision: InterventionDecision, shown: boolean, answered: boolean, atMs: number): void => {
      const r = core.lessonReaction(
        {
          profile,
          tc: cfg.tc,
          judgement: j,
          advice: result.advice,
          adviceShown: shown,
          quizAnswered: answered,
          decision,
          ...(foundMotifOf(j) ? { foundMotif: foundMotifOf(j) } : {}),
          treasureHidden: plan.treasure != null && !shown,
          repertoireNextSan: (plan.memory as any).repertoireNextSan ?? null,
          prev: lastBot ? { uci: lastBot.uci, fenBefore: lastBot.fenBefore } : null,
          strategyCard,
          historySan: [...history, j.san],
        },
        memory,
        book,
      );
      memory = r.memory;
      const rec = say(r.now, { source: 'reaction', ply, afterPly: ply, atMs });
      if (rec && rec.kind === 'praise' && !rec.empty) {
        const reason = (rec.say[0]?.pool ?? '').replace(/^v3\.(praise|goalDone)\./, (_m, a: string) => (a === 'goalDone' ? 'goal.' : ''));
        todo.push({ kind: 'praise', ply, fen: j.fenBefore, uci: j.uci, claim: `похвала ${reason}`, n: rec.n, praise: { reason, san: j.san } });
      }
    };

    // The game store's loop (judgeAndContinue → beginOffer → acceptTakeback / declineTakeback): an offered move gets the
    // offer, not a reaction; «Верну» → the reply, the advice again (`lessonRepeat`, its arrow now), the clock back to
    // before the move, and the child moves again. The same move again is his decision («insisted»: no offer); ANOTHER
    // losing move in that position is offered back at once («и этот ход…», the cooldown skipped once per position).
    const tries: TakebackTry[] = [];
    const takenBack = new Set<string>();
    let offerRetryUci: string | null = null;
    let bypassed = false;
    for (let attempt = 1; ; attempt++) {
      const j = await judgeOne(uci);
      judgements.push(j);
      const insisted = takenBack.has(uci);
      const retryOfOffer = offerRetryUci !== null && offerRetryUci !== uci;
      offerRetryUci = null;
      const skipCooldown = retryOfOffer && !bypassed;
      // (the child's clock at the moment of the move: the store's `childClockBefore`, where a take-back sets it back)
      const dctx = { coachMode: tcDef.coachMode, stage: cfg.stage, offersMade, remainingMs: childLeft, examMode: false, pliesSinceLastOffer: ply - lastOfferPly };
      let decision: InterventionDecision = core.decideIntervention(j, dctx, { retryAfterTakeback: skipCooldown });
      if (insisted && decision.action === 'offerTakeback') decision = { action: 'logForReview', reason: 'insisted' };
      if (attempt >= MAX_TRIES && decision.action === 'offerTakeback') decision = { action: 'logForReview', reason: 'budgetExhausted' };
      if (decision.action !== 'offerTakeback') {
        react(j, decision, arrowShown, quizAnswered, moveMs);
        if (tries.length > 0) tries.push({ uci, san: j.san, offered: false, accepted: null, again: false });
        break;
      }
      if (skipCooldown) bypassed = true;
      offersMade++;
      lastOfferPly = ply;
      gameEvents.push({ t: 0, type: 'takebackOffered', ply, data: {} });
      // (the store: the advice the child SAW — never a hidden one, `shownAdviceOf`)
      const o = core.lessonTakebackOffer({ profile, judgement: j, advice: arrowShown ? result.advice : [], ...(retryOfOffer ? { again: true } : {}) }, memory, book);
      memory = o.memory;
      say(o.event, { source: 'takebackOffer', ply, afterPly: ply, atMs: moveMs });
      const accept = policy() < P.takebackAccept;
      const rep = core.lessonTakebackReply(accept ? 'yes' : 'no', profile, memory, book);
      memory = rep.memory;
      say(rep.event, { source: 'takebackReply', ply, afterPly: ply, atMs: moveMs + 2000 });
      tries.push({ uci, san: j.san, offered: true, accepted: accept, again: retryOfOffer });
      if (!accept) break;
      gameEvents.push({ t: 0, type: 'takebackAccepted', ply, data: {} });
      takenBack.add(uci);
      offerRetryUci = uci;
      // «при «да» — lessonRepeat»: the advice again with its arrow, then the child moves again
      const again = core.lessonRepeat(plan, memory, book);
      memory = again.memory;
      stopHints(moveMs + 3000, again, !!adviceUci);
      const rec = say(again.event, { source: 'repeat', ply, afterPly: ply, atMs: moveMs + 3000, advice: adviceUci });
      noteBest(rec, ply, fen, adviceUci);
      arrowShown = true;
      const random = policy() < P.retryRandom;
      uci = random || !adviceUci ? anyMove() : adviceUci;
      how = 'retry';
      const rethink = childThinkMs(policy);
      moveMs += 3000 + rethink;
      if (childLeft !== null) childLeft = Math.max(1000, childLeft - rethink);
    }
    const first = tries[0];
    const takeback: TurnRecord['takeback'] = first
      ? { uci: first.uci, san: first.san, accepted: first.accepted === true, again: tries.slice(1).some((x) => x.offered), tries }
      : null;
    const mv = chess.move(fromUci(uci));
    history.push(mv.san);
    plies.push({ by: 'child', uci: toUci(mv), san: mv.san, thinkMs: moveMs });
    turns.push({
      ply,
      fen,
      moment: result.moment,
      ...turnInfo,
      advice: advice0 ? { uci: advice0.uci, san: advice0.san } : null,
      adviceHidden: result.adviceHidden,
      revealAfterMs: result.revealAfterMs,
      hints: result.hints,
      hintsStopMs,
      ...(hintsKept ? { hintsKept } : {}),
      quiz: quizRec,
      reveal,
      buttons,
      move: { uci: toUci(mv), san: mv.san, how, arrowShown, thinkMs: moveMs },
      takeback,
      legacy,
      ...(hurry ? { hurry } : {}),
    });
    return true;
  };

  // ── the game ──
  if (childColor === 'w') lessonStart();
  const maxPlies = 70 + Math.floor(policy() * 30);
  while (!chess.isGameOver() && plies.length < maxPlies) {
    const fen = chess.fen();
    if (chess.turn() !== childColor) {
      const thinkMs = botThinkMs(policy);
      let mv;
      try {
        const pick = await eng.bot.pickMove(fen, cfg.persona, { moveNumber: Math.floor(plies.length / 2) + 1, remainingMs: botLeft });
        mv = chess.move(fromUci(pick.uci));
      } catch {
        const moves = chess.moves({ verbose: true });
        mv = chess.move(moves[Math.min(moves.length - 1, Math.floor(policy() * moves.length))] as MoveLike);
      }
      if (botLeft !== null) botLeft = Math.max(1000, botLeft - thinkMs);
      history.push(mv.san);
      plies.push({ by: 'bot', uci: toUci(mv), san: mv.san, thinkMs });
      lastBot = { uci: toUci(mv), san: mv.san, fenBefore: fen };
      if (childColor === 'b' && plies.length === 1) lessonStart();
      continue;
    }
    if (!(await childTurn(fen))) break;
  }

  // ── the end ──
  let termination: Termination = 'abandoned';
  let result: GameResult = '*';
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
    if (Math.abs(diff) >= 3 && policy() < 0.7) {
      termination = policy() < 0.5 ? 'timeout' : 'resign';
      result = diff > 0 === (childColor === 'w') ? '1-0' : '0-1';
    }
  }
  const summary = core.summarizeGame({ judgements, events: gameEvents, stage: cfg.stage });
  const end = core.lessonEnd({ profile, tc: cfg.tc, result, childColor, termination, summary, strategyCard, judgements, historySan: [...history] }, memory, book);
  memory = end.memory;
  say(end.event, { source: 'end', ply: plies.length, afterPly: plies.length, atMs: 0 });
  book.finishGame();
  state.history = book.snapshotHistory();
  if (strategy) state.strategies.push({ id: strategy.strategyId, side: childColor });

  const game: GameRecord = {
    t: 'game',
    game: cfg.game,
    child: cfg.child,
    stage: cfg.stage,
    gameNo: cfg.gameNo,
    seed: cfg.seed,
    name: cfg.name,
    address: cfg.address,
    childColor,
    tc: cfg.tc,
    persona: cfg.persona,
    strategyId: strategy?.strategyId ?? null,
    strategyTitle: strategy?.titleRu ?? null,
    family,
    plies,
    turns,
    result,
    termination,
    takeaway: end.takeaway,
    takeawayKey: end.takeawayKey,
    events: evs.length,
    bookBytes: Buffer.byteLength(JSON.stringify(state.history), 'utf8'),
    legacyStart,
  };
  if (auditOn && eng.audit) game.audit = await runAudit(eng, todo);
  return [...evs, game];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ───────────────────────── the truth audit (a deeper, separate Stockfish) ─────────────────────────

async function deepView(eng: Engines, fen: string, extra: readonly string[]): Promise<DeepView | null> {
  const judge = eng.audit;
  if (!judge) return null;
  const a = await judge.analyze(fen, { depth: ENGINE.audit.depth, multipv: ENGINE.audit.multipv });
  const p = engineProof(fen, a);
  if (!p) return null;
  const known: Record<string, number> = {};
  for (const [u, w] of p.known) known[u] = w;
  for (const u of extra) {
    const k = u.toLowerCase();
    if (!k || known[k] !== undefined) continue;
    try {
      const r = await judge.analyze(fen, { depth: ENGINE.audit.depth, searchmoves: [k] });
      if (r.lines[0]) known[k] = lineWin(r.lines[0]);
    } catch {
      // not scored
    }
  }
  return { depth: p.depth, best: p.best, bestUci: p.bestUci, lines: p.lines.map((l) => ({ uci: l.uci, win: l.win })), known, floor: p.floor };
}

async function runAudit(eng: Engines, todo: readonly AuditTodo[]): Promise<AuditItem[]> {
  const out: AuditItem[] = [];
  try {
    await eng.audit?.newGame();
  } catch {
    // a fresh engine
  }
  for (const x of todo) {
    const base = { kind: x.kind, ply: x.ply, fen: x.fen, uci: x.uci, claim: x.claim, n: x.n };
    try {
      if (x.kind === 'quiz' && x.quiz) {
        if (!['whichPiece', 'canCapture', 'checkEscape'].includes(x.quiz.kind)) {
          out.push({ ...base, verdict: 'static', detail: 'доказательство по позиции, без движка' });
          continue;
        }
        const d = await deepView(eng, x.fen, x.quiz.captureUci ? [x.quiz.captureUci] : []);
        if (!d) throw new Error('no deep analysis');
        out.push({ ...base, ...auditQuizVerdict({ kind: x.quiz.kind, correctId: x.quiz.correctId, fen: x.fen, optionIds: x.quiz.optionIds, captureUci: x.quiz.captureUci }, d) });
      } else if (x.kind === 'praise' && x.praise) {
        if (x.praise.reason === 'mate') {
          out.push({ ...base, ...auditPraiseVerdict('mate', x.praise.san, null, { depth: 0, best: 100, bestUci: x.uci, lines: [], known: {}, floor: 0 }) });
          continue;
        }
        const d = await deepView(eng, x.fen, [x.uci]);
        if (!d) throw new Error('no deep analysis');
        out.push({ ...base, ...auditPraiseVerdict(x.praise.reason, x.praise.san, d.known[x.uci.toLowerCase()] ?? null, d) });
      } else if (x.kind === 'best') {
        const d = await deepView(eng, x.fen, [x.uci]);
        if (!d) throw new Error('no deep analysis');
        out.push({ ...base, ...auditBestVerdict(x.uci, d) });
      }
    } catch (e) {
      out.push({ ...base, verdict: 'error', detail: String(e instanceof Error ? e.message : e) });
    }
  }
  return out;
}

// ───────────────────────── main ─────────────────────────

/** `1:10,4:10` → [{child 1, 10 games}, {child 4, 10 games}] */
export function parseChildren(spec: string): { child: number; games: number }[] {
  return spec
    .split(',')
    .map((part) => part.split(':').map((x) => Number(x)))
    .filter(([c, n]) => Number.isInteger(c) && Number.isInteger(n) && (c as number) >= 1 && (c as number) <= CHILD_NAMES.length && (n as number) > 0)
    .map(([c, n]) => ({ child: c as number, games: n as number }));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      children: { type: 'string' },
      seed: { type: 'string' },
      audit: { type: 'boolean' },
      voice: { type: 'string' },
      'voice-pricing': { type: 'string' },
      'daily-cap': { type: 'string' },
      'games-per-day': { type: 'string' },
      'state-dir': { type: 'string' },
      first: { type: 'string' },
      'voice-seed': { type: 'string' },
    },
    strict: true,
  });
  if (!values.out || !values.children) {
    throw new Error(
      'usage: worker.ts --out <file.jsonl> --children 1:10,4:10 [--seed N] [--audit] [--voice lazy|k<K>[c]] [--voice-pricing pack|unit] [--daily-cap N] [--games-per-day N] [--state-dir DIR --first N] [--voice-seed FILE]',
    );
  }
  const out = values.out;
  const seed = Number(values.seed ?? 0) >>> 0;
  const audit = values.audit === true;
  const voice = values.voice !== undefined ? parseVoiceSpec(values.voice) : null;
  if (values.voice !== undefined && !voice) throw new Error(`--voice expects lazy or k<K>[c], got "${values.voice}"`);
  const money = parseVoiceMoney({ pricing: values['voice-pricing'], dailyCap: values['daily-cap'], gamesPerDay: values['games-per-day'] });
  const first = Math.max(1, Number(values.first ?? 1) | 0);
  const stateDir = values['state-dir'] ?? null;
  const seedUnits = values['voice-seed'] ? (JSON.parse(readFileSync(values['voice-seed'], 'utf8')) as Record<string, string[]>) : null;
  if (stateDir) mkdirSync(stateDir, { recursive: true });
  writeFileSync(out, '');
  const eng = await loadEngines({ audit });
  const write = (lines: readonly RunLine[]): void => appendFileSync(out, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  try {
    for (const { child, games } of parseChildren(values.children)) {
      const who = CHILD_NAMES[child - 1] as { name: string; address: 'm' | 'f' };
      const stateFile = stateDir ? path.join(stateDir, `c${child}.json`) : null;
      const state: ChildState = stateFile && existsSync(stateFile) ? childStateFromJson(readFileSync(stateFile, 'utf8')) : { history: undefined, strategies: [], concepts: [] };
      if (voice && !state.voiced) state.voiced = new Set(seedUnits ? [...(seedUnits['*'] ?? []), ...(seedUnits[String(child)] ?? [])] : []);
      const plan = { child, stage: child, name: who.name, address: who.address, games: first - 1 + games };
      for (const cfg of gameConfigs(plan, seed).slice(first - 1)) {
        let lines: RunLine[];
        try {
          lines = await playGame(cfg, state, eng, audit, voice, money);
        } catch (e) {
          lines = [{ t: 'error', game: cfg.game, error: String(e instanceof Error ? (e.stack ?? e.message) : e) }];
        }
        write(lines);
        if (stateFile) writeFileSync(stateFile, childStateToJson(state));
        process.stdout.write(`done ${cfg.game}\n`);
      }
    }
  } finally {
    eng.dispose();
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      process.stderr.write(`${String(e instanceof Error ? (e.stack ?? e.message) : e)}\n`);
      process.exit(1);
    },
  );
}
