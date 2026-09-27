/**
 * The live game: an explicit state machine around chess.js, two engines and the coach
 * (docs/ARCHITECTURE.md §2 + §5, research 07 §4).
 *
 *   idle → childTurn → judging → (coachIntervention →) botThinking → childTurn … → gameOver
 *
 *  - The bot is asked only AFTER the child's move was judged and the intervention decision was taken.
 *    With coachMode 'off' (bullet) judging runs in a background queue and never blocks the bot.
 *  - While it is the child's turn the judge analyses the position in the background (MultiPV 3): that result is
 *    the `cachedBefore` of the next judgement and the source of hints.
 *  - Everything is journaled as GameEvent[] (ms since game start): moves with clocks, take-back offers and the
 *    child's choice, hints, coach phrases, voice transcripts, game end.
 *  - No engine failure may hang the game: every engine await has a timeout and a fallback.
 *  - The conversational coach: every CoachEvent carries a `brief` (facts + goal) that a Live / Realtime
 *    voice says in its own words; the tool host answers free questions with engine FACTS (`analyzePosition`,
 *    `evaluateMove` on a scratch board — never the best move); proactive moments are few and meaningful (a new
 *    danger after the bot's move — the null-move threat search runs right after the background analysis —, a real
 *    tactic found, one nudge after a long silence); `coach.onGameStart` / `onGameEnd` let the conversation follow
 *    the game.
 *  - «Учитель» (docs/TEACHING.md §4.6): no generative AI in the child's game — the lesson director of
 *    @gambit/core (`lessonGameStart` / `lessonTurn` / `lessonAnswer` / `lessonReaction` / `lessonEnd` …) picks the ONE
 *    moment of a turn and its pre-written words; this controller shows its board (the calm advice's arrow after its
 *    sentence), keeps its timers (reveal, hints, the quiz's time-out), the quiz card with its clock hold, and one phrase
 *    book per game (`sayEvent` notes every phrase; the snapshot keeps its bag and the child's memory so far; `finish()`
 *    writes the child's cross-game memory to localStorage). Re-plans of the smart strategist only with runtime AI
 *    (`coach.runtimeAi()`).
 *
 * `createGameController(deps)` has no DOM / Worker / network dependency of its own — GameScreen wires the real
 * ones in (gameDeps.ts), tests inject fakes.
 */
import { Chess } from 'chess.js';
import type { Move, Square as ChessSquare } from 'chess.js';
import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import { PERSONAS, getPersona, getRepertoireAdvice } from '@gambit/content';
import {
  TAKEBACK_DECLINE_REASONS,
  bookMovesToVerify,
  buildCompareMoveAnswerRu,
  buildDeclineReasonReply,
  buildExplainBest,
  buildGameHello,
  buildGameResumed,
  buildGameStart,
  buildHint,
  buildOpeningIdea,
  buildMoveCheckAnswerRu,
  buildPositionAnswerRu,
  buildPraise,
  buildSilenceNudge,
  buildTakebackAccepted,
  buildTakebackDeclined,
  buildTakebackOffer,
  buildTakebackQuestion,
  buildThinkingRoutine,
  buildThreatWarning,
  buildVoluntaryTakeback,
  childOutcome,
  coachStylesFor,
  composeBrief,
  computePositionFacts,
  createLessonBook,
  decideIntervention,
  declineReasonLabelRu,
  defaultCoachStyle,
  detectMotif,
  initialTeachMemory,
  isCaptureMove,
  isRealTacticMotif,
  judgeMove,
  lessonAnswer,
  lessonEnd,
  lessonGameStart,
  lessonHurry,
  lessonOpponent,
  lessonReaction,
  lessonRepeat,
  lessonReveal,
  lessonTakebackOffer,
  lessonTakebackReply,
  lessonTurn,
  lessonWhy,
  mateInOneThreat,
  moveTextProblemRu,
  nullMoveFen,
  parseMoveText,
  planTeachTurn,
  reactionVerdict,
  restoreTeachMemory,
  spokenMoveRu,
  strategyProgress,
  studentWords,
  takebackOutcomes,
  teachScoreCp,
  threatFromNullMoveLine,
  toMoverPov,
  winPct,
} from '@gambit/core';
import type { LessonBook, LessonTurnResult, LessonVoicePolicy, ScoredAdvice, TakebackDeclineReason, TeachContext, TeachMemory, TeachPlan } from '@gambit/core';
import { TIME_CONTROLS } from '@gambit/shared';
import type {
  AnalysisResult,
  AnalyzeOptions,
  BoardAnnotations,
  CoachEvent,
  CoachStyle,
  CoachToolHost,
  Color,
  ConversationState,
  EngineLine,
  GameEvent,
  GameEventType,
  GameResult,
  GameStrategy,
  HintLevel,
  IJudgeEngine,
  InterventionDecision,
  LessonCue,
  LessonQuiz,
  MascotPose,
  MotifId,
  MoveJudgement,
  Persona,
  PieceType,
  ReplanRequest,
  ReplanResponse,
  Square,
  StrategyCard,
  StrategyRequest,
  StudentProfile,
  TeachAdvice,
  Termination,
  Threat,
  TimeControl,
  TimeControlId,
} from '@gambit/shared';
import { THOUGHT_QUESTION_RU, THOUGHT_TAPS_MAX, isAboutThePosition, isThoughtChipId, opponentAnswerEvent, repeatEvent, repeatStaleEvent, thoughtReplyEvent, thoughtText, whyNothingEvent } from '../../coach/clips/clipAsk.ts';
import type { ThoughtChipId } from '../../coach/clips/clipAsk.ts';
import { withShellTwin } from '../../coach/clips/shellTwin.ts';
import { createGameClock } from './clock.ts';
import type { GameClock } from './clock.ts';
import { botMoveNoteRu, judgementNoteRu } from './contextNotes.ts';
import type {
  BotBubble,
  GameConfig,
  GameDeps,
  GameSoundName,
  GameState,
  GameTimings,
  LegalTarget,
  MoveEntry,
  OpeningLookup,
  PromotionPiece,
  TeacherContent,
} from './gameTypes.ts';
import { CHILD_NOTE_MAX_CHARS, CHILD_NOTE_QUESTION_RU } from './gameTypes.ts';
import { describePositionRu } from './positionSummary.ts';
import { MIN_CHILD_MOVES_TO_SAVE, buildGameRecord, computeStars, makeGameId, orderJudgements, resultFor, summarizeWithTakebacks } from './record.ts';
import { RESUME_VERSION, dropResumableGame, readLessonHistory, readResumableGame, resumedLessonHistory, settleResumableGame, writeLessonHistory, writeResumableGame } from './resume.ts';
import type { ResumableGame, ResumeStrategyState } from './resume.ts';
import { acceptReplan, sanitizeStrategy, strategyRequestKey } from './strategy.ts';
import { positionAfter, replanCandidates, replanTrigger, strategyLineStatus } from './strategyPlan.ts';
import type { GamePhase as PositionPhase, LineStatus, ReplanTrigger } from './strategyPlan.ts';
import { DEFAULT_TEACHER_CONTENT, themeBadgeRu } from './teacherContent.ts';
import { createThoughtsOutbox, flushParkedThoughts, makeThought } from './thoughts.ts';
import type { ThoughtsOutbox } from './thoughts.ts';
import { flushUnsavedGames, readUnsavedGames, storeUnsavedGame } from './unsavedGames.ts';

export { MIN_CHILD_MOVES_TO_SAVE };

// ───────────────────────── constants ─────────────────────────

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const DEFAULT_GAME_TIMINGS: GameTimings = {
  engineReadyTimeoutMs: 8_000,
  profileTimeoutMs: 2_500,
  backgroundDepth: 16,
  backgroundMovetimeMs: 3_000,
  backgroundMultipv: 3,
  quickMovetimeMs: 450,
  confirmMovetimeMs: 1_200,
  judgeTimeoutMs: 4_500,
  postGameJudgeTimeoutMs: 3_500,
  postGameBudgetMs: 45_000,
  botTimeoutMs: 12_000,
  minBotDelayMs: 350,
  hintWaitMs: 1_500,
  botBubbleMs: 6_000,
  threatWarningDelayMs: 4_000,
  threatSearchDepth: 10,
  threatSearchMovetimeMs: 350,
  silenceNudgeMs: 60_000,
  silenceNudgeRepeatMs: 120_000,
  evaluateMoveTimeoutMs: 1_400,
  evaluateMoveMovetimeMs: 450,
  saveRetryDelayMs: 1_200,
  coachAutoResumeMs: 25_000,
  childNoteWaitMs: 40_000,
  thoughtsSendDelayMs: 3_000,
  declineReasonsMs: 20_000,
  teachDeadlineMs: 1_500,
  teachMinDepth: 12,
  teachAnalysisMs: 1_100,
  teachFallbackDepth: 8,
  teachHoldMaxMs: 20_000,
  treasureRevealMs: 10_000,
  teachVerifyMovetimeMs: 300,
  // Sol answers the strategy in 2.6–6 s through OpenRouter (the server asks the fast API first,
  // without a reasoning pass, and answers from the template by 8.3 s at the latest): the intro waits for that —
  // White asks at the colour tap, before the board opens
  strategyWaitMs: 8_500,
  replanMinDepth: 10,
  replanWaitMs: 1_500,
  replanEveryPlies: 6,
  hurryBelowMs: 30_000,
  adviceArrowMinMs: 1_500,
  adviceArrowPerWordMs: 300,
  adviceArrowMaxMs: 4_000,
  adviceArrowWaitMaxMs: 10_000,
  quizHoldMaxMs: 25_000,
  quizCloseMs: 1_200,
};

/**
 * A calm advice said aloud waits for the end of its words; meanwhile the game asks this often whether they are still
 * heard (`coach.speaksAloud()`: the sound switched off, a lesson phrase found unrecorded late → the arrow at once).
 */
export const ADVICE_ARROW_RECHECK_MS = 200;

/** localStorage: the concept cards «Учитель» has already explained to this child (TEACHER-MODE §5.2, P0). */
export const TEACHER_CONCEPTS_KEY = 'gambit.teacher.concepts';
const TEACHER_CONCEPTS_MAX = 200;

/**
 * The coach style a game really gets (TEACHER-MODE §1.2): the route's style when the time control offers it, else
 * `defaultCoachStyle`; 'auto' = the default for the child's stage; no style at all = the behaviour before teacher
 * mode (`examMode ? 'exam' : 'helper'`). Bullet has no style (the coach is silent there anyway).
 */
export function resolveCoachStyle(config: Pick<GameConfig, 'timeControlId' | 'examMode' | 'coachStyle'>, stage: number): CoachStyle {
  const tc: TimeControlId = config.timeControlId;
  const requested = config.coachStyle;
  if (requested === undefined) return config.examMode ? 'exam' : 'helper';
  const offered = coachStylesFor(tc);
  if (offered.length === 0) return requested === 'exam' || config.examMode ? 'exam' : 'helper';
  if (requested === 'auto') return config.examMode ? 'exam' : defaultCoachStyle(tc, stage);
  return offered.includes(requested) ? requested : defaultCoachStyle(tc, stage);
}

/** Praise at most this often (plies), ARCHITECTURE §5. */
export const PRAISE_MIN_PLY_GAP = 6;
/** "Only move": the second-best line is at least this many win% worse. */
const ONLY_MOVE_WIN_PCT_GAP = 15;
/** Proactive threat warnings: at most one per this many plies (design D). */
export const THREAT_WARNING_MIN_PLY_GAP = 4;
/** …and none right after a take-back offer (the coach has just talked about the danger). */
const THREAT_AFTER_OFFER_PLIES = 2;
/** «а если я пойду…?»: the scratch judgement searches this deep (quick and «confirm» alike — it has to be fast). */
const EVALUATE_MOVE_DEPTH = 10;
/** Conversation states in which somebody is really listening to the child. */
const LISTENING_STATES: ReadonlySet<ConversationState> = new Set<ConversationState>(['listening', 'childSpeaking', 'thinking', 'coachSpeaking']);
/**
 * …plus 'connecting' for the JOURNAL: at the start of a game the conversation is still connecting while the opening
 * phrases are queued, and the model then says them in its own words (otherwise the templates of the start would be
 * journaled as «Тренер: …» next to what the model really said).
 */
const MODEL_VOICE_STATES: ReadonlySet<ConversationState> = new Set<ConversationState>([...LISTENING_STATES, 'connecting']);
/** The opening idea (repertoire) is mentioned once, inside this window of plies. */
const OPENING_IDEA_MAX_PLY = 16;
/** …as soon as the model line was followed this deep (or the game left it after at least REPERTOIRE_MIN_PLIES). */
const OPENING_IDEA_READY_PLIES = 6;
/** A declined take-back counts as punished when the bot's capture is worth at least this much (pawns). */
const PUNISH_MIN_CAPTURE_PAWNS = 3;
const PIECE_PAWNS: Readonly<Record<string, number>> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** judgeMove searches at or above this depth are "confirmation" searches (longer movetime cap). */
const CONFIRM_DEPTH_FROM = 14;
/** A cached partial analysis at least this deep is good enough for a hint. */
const HINT_MIN_DEPTH = 8;
const OPENING_MAX_PLY = 40;
const NO_HINTS_PHRASE_GAP_MS = 20_000;

export const INITIAL_GAME_STATE: GameState = {
  phase: 'idle',
  config: null,
  persona: null,
  timeControl: null,
  profile: null,
  fen: START_FEN,
  turn: 'w',
  moves: [],
  lastMove: null,
  checkSquare: null,
  selected: null,
  legalTargets: [],
  pendingPromotion: null,
  annotations: null,
  clock: { w: null, b: null, running: null, paused: false },
  takeback: null,
  hintLevel: 0,
  hintBusy: false,
  hintPulse: false,
  hintsEnabled: false,
  botBubble: null,
  openingName: null,
  result: '*',
  termination: null,
  ending: null,
  summary: null,
  stars: null,
  savedGameId: null,
  record: null,
  judgeUnavailable: false,
  botUnavailable: false,
  canUndo: false,
  declineReasons: null,
  note: 'none',
  resumed: false,
  coachStyle: null,
  advice: null,
  treasure: null,
  teachMode: null,
  strategy: null,
  replan: null,
  quiz: null,
  takeaway: null,
  quizScore: null,
  themeBadge: null,
};

/** The only words that ever touch the clock: once per game, when the child is nearly out of time. */
export const HURRY_TEXT_RU = 'Поторопись!';
/** Accepted re-plans kept for the teacher (the newest one on the game's line is used). */
const MAX_REPLANS = 4;
/** The abort reason of a re-plan request a newer one replaced. */
const REPLAN_SUPERSEDED = 'superseded by a newer re-plan';

/**
 * What «Учитель» gets from the smart strategist in its `TeachContext` (@gambit/core):
 *  - `strategy` — the strategy of this game (the first teacher line is its intro, `introRu`); null = none (yet);
 *  - `strategyCard` — its library card (the child's line, the whole main line, the middlegame moves) when the content knows it;
 *  - `replan` — the smart model's latest re-plan that still belongs to the game's line: `planRu` / `whyRu` are the new
 *    plan in kid words; `preferredUci` (one of the engine candidates it was given) is meant for `replan.ply === ctx.ply`
 *    only — for a later position it is history, the plan words still hold.
 */
export interface TeachStrategyContext {
  strategy: GameStrategy | null;
  strategyCard: StrategyCardOf | null;
  replan: ReplanResponse | null;
}

/** The library card as the game passes it on (`StrategyEntry` of @gambit/content has the whole main line too). */
export type StrategyCardOf = StrategyCard & { titleAccRu?: string; mainLineSan?: readonly string[]; middlegameSan?: readonly string[] };

/** `ctx` with the strategist's fields. */
export function withStrategyContext(ctx: TeachContext, extra: TeachStrategyContext): TeachContext {
  ctx.strategy = extra.strategy;
  ctx.strategyCard = extra.strategyCard;
  ctx.replan = extra.replan;
  return ctx;
}

export function defaultStudentProfile(now: Date = new Date()): StudentProfile {
  return {
    nickname: 'Шахматист',
    address: 'm',
    stage: 1,
    totals: { games: 0, wins: 0, losses: 0, draws: 0, puzzlesAttempted: 0, puzzlesSolved: 0, minutesPlayed: 0 },
    puzzleRating: { rating: 600, rd: 300, vol: 0.06, attempts: 0, solved: 0, lastSeen: null },
    themeSkills: {},
    recentAccuracy: [],
    weaknesses: [],
    strengths: [],
    bestWin: null,
    updatedAt: now.toISOString(),
  };
}

// ───────────────────────── small helpers ─────────────────────────

const SQUARE_RE = /^[a-h][1-8]$/;

function isSquare(value: string): value is ChessSquare {
  return SQUARE_RE.test(value);
}

function other(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

/** First four FEN fields — identifies a position regardless of the move counters. */
function positionKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

function uciOf(move: Pick<Move, 'from' | 'to' | 'promotion'>): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function isEngineLineArray(value: unknown): value is EngineLine[] {
  return Array.isArray(value) && value.every((line) => typeof line === 'object' && line !== null && Array.isArray((line as EngineLine).pvUci));
}

/** `EngineError.partial` of the engine module, read structurally so the store does not depend on that class. */
function partialAnalysisOf(error: unknown, fen: string): AnalysisResult | null {
  if (typeof error !== 'object' || error === null || !('partial' in error)) return null;
  const partial = error.partial;
  if (typeof partial !== 'object' || partial === null || !('lines' in partial)) return null;
  const lines = partial.lines;
  if (!isEngineLineArray(lines) || lines.length === 0) return null;
  return analysisFromLines(fen, lines);
}

function analysisFromLines(fen: string, lines: EngineLine[]): AnalysisResult | null {
  const best = lines[0];
  const bestmove = best?.pvUci[0];
  if (!best || !bestmove) return null;
  return { fen, lines, bestmove, depth: best.depth, timeMs: 0 };
}

/** K, K+N or K+B cannot deliver mate — a flag fall against such an army is a draw. */
function hasMatingMaterial(chess: Chess, color: Color): boolean {
  let minors = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== color) continue;
      if (cell.type === 'p' || cell.type === 'r' || cell.type === 'q') return true;
      if (cell.type === 'n' || cell.type === 'b') minors += 1;
    }
  }
  return minors >= 2;
}

/** The concept cards a journal's teacher phrases explained (`coachSaid` → `teach.conceptId`, TEACHER-MODE §7.5). */
export function conceptIdsOf(events: readonly GameEvent[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if (event.type !== 'coachSaid') continue;
    const teach = event.data.teach;
    const id = typeof teach === 'object' && teach !== null && 'conceptId' in teach ? teach.conceptId : undefined;
    if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The last question of a coach phrase («Ого! Что было самым трудным?» → «Что было самым трудным?»); null without one.
 * A question in quotes is a question to practise, not one asked now: «Потренируем вопрос «Это безопасно?»» asks nothing.
 */
export function lastQuestionRu(text: string): string | null {
  let unquoted = text;
  // innermost quotes first, so a quote inside a quote goes too
  for (let prev = ''; prev !== unquoted; ) {
    prev = unquoted;
    unquoted = unquoted.replace(/«[^«»]*»|„[^„“”]*[“”]|“[^“”]*”|"[^"]*"/gu, ' ');
  }
  const question = unquoted.match(/[^.!?…«»„“”"]+\?/gu)?.at(-1)?.trim();
  return question ? question : null;
}

function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// ───────────────────────── lesson helpers (docs/TEACHING.md §4.6) ─────────────────────────

/** A 31-bit seed from a game id (FNV-1a): the phrase book of one game picks the same words on every replay of it. */
export function lessonSeedOf(gameId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < gameId.length; i++) {
    h ^= gameId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 1) || 1;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** null for a board with nothing on it (the game's `annotations` convention). */
function boardOrNull(board: BoardAnnotations | null | undefined): BoardAnnotations | null {
  return board && (board.arrows.length > 0 || board.highlights.length > 0) ? board : null;
}

/** `a` with what `b` adds (an arrow once per from→to, a square once — the first colour wins). */
function mergeBoards(a: BoardAnnotations | null, b: BoardAnnotations | null): BoardAnnotations | null {
  if (!a) return boardOrNull(b);
  if (!b) return boardOrNull(a);
  const arrows = [...a.arrows];
  for (const arrow of b.arrows) if (!arrows.some((x) => x.from === arrow.from && x.to === arrow.to)) arrows.push(arrow);
  const highlights = [...a.highlights];
  for (const mark of b.highlights) if (!highlights.some((x) => x.square === mark.square)) highlights.push(mark);
  return boardOrNull({ arrows, highlights });
}

/** The cues that wait for the end of their sentence (the calm advice's move / capture, §2.2). */
function endCuesOf(event: CoachEvent | null): LessonCue[] {
  return (event?.cues ?? []).filter((c) => c.at === 'end');
}

/**
 * `board` without what waits for the end of the sentence: the advice arrows and the arrows / squares of the `at: 'end'`
 * cues. (A square another cue of the board also lights stays — only the waiting cue's own marks go.)
 */
function withoutEndCues(board: BoardAnnotations | null | undefined, advice: readonly TeachAdvice[], cues: readonly LessonCue[]): BoardAnnotations | null {
  if (!board) return null;
  const arrowKeys = new Set<string>(advice.map((a) => `${a.uci.slice(0, 2)}${a.uci.slice(2, 4)}`));
  const squares = new Set<string>();
  for (const cue of cues) {
    for (const a of cue.arrows ?? []) arrowKeys.add(`${a.from}${a.to}`);
    for (const sq of cue.squares) squares.add(sq);
  }
  return boardOrNull({
    arrows: board.arrows.filter((a) => !arrowKeys.has(`${a.from}${a.to}`)),
    highlights: board.highlights.filter((h) => !squares.has(h.square)),
  });
}

interface CacheEntry {
  result: AnalysisResult;
  complete: boolean;
}

interface BackgroundSearch {
  key: string;
  fen: string;
  latest: EngineLine[];
  settled: boolean;
  /** stopBackground() asked it to stop: no follow-up search */
  stopped: boolean;
  promise: Promise<void>;
}

interface JudgeJob {
  ply: number;
  fenBefore: string;
  uci: string;
  /** the move completed a threefold repetition — the FEN alone cannot show that */
  drawnByRepetition?: boolean;
}

type ProgressListener = (done: number, total: number) => void;

/** The take-back question on the screen: the judged move and both clocks from before it (restored on «Верну ход»). */
interface PendingOffer {
  judgement: MoveJudgement;
  childClockBefore: number | null;
  botClockBefore: number | null;
}

// ───────────────────────── controller ─────────────────────────

export interface GameController {
  readonly store: StoreApi<GameState>;
  /**
   * Loads the profile, wakes the engines and starts the game. Never rejects.
   * `resume`: continue this saved game (its own config wins); a snapshot that cannot be restored starts a new game.
   */
  start(config: GameConfig, options?: { resume?: ResumableGame | null }): Promise<void>;
  /** Click-to-move: select an own piece, then a target (or another piece). */
  selectSquare(square: Square): void;
  /** Drag start: shows the legal targets of the dragged piece. */
  beginDrag(square: Square): void;
  /** Drop of a dragged piece. Returns true when the move was played (false: illegal, or a promotion choice is pending). */
  dropPiece(from: Square, to: Square): boolean;
  /** Answer of the promotion picker; null cancels the move. */
  choosePromotion(piece: PromotionPiece | null): void;
  acceptTakeback(): void;
  declineTakeback(): void;
  /** «Подсказка»: the next step of the 1→4 ladder for the current move. */
  requestHint(source?: 'button' | 'dock'): Promise<void>;
  /** «Вернуть ход» (untimed, non-exam games): undoes the child's last move and the bot's reply. False when not possible. */
  undoLastMove(): boolean;
  /** One of the three tappable answers after «Оставлю свой ход» — journaled as `childSaid {source:'choice'}`. */
  giveDeclineReason(reason: TakebackDeclineReason): void;
  /**
   * «Учитель» (docs/TEACHING.md §2.4): a button of the quiz card — journaled as `childSaid {source:'choice',
   * about:'quiz'}`, answered (right / wrong + the truth + the advice, the arrow). A stale card (another move) is dropped.
   */
  answerQuiz(optionId: string): void;
  /** Result card diary: the child's sentence (journaled as `childSaid {source:'typed'}`), or null for «Пропустить». */
  submitChildNote(text: string | null): void;
  /** The child is typing the diary sentence: the auto-skip timer starts over. */
  touchChildNote(): void;
  /**
   * «Записи», after the game (docs/voice-clips/SPEC.md §8.3): a «Как тебе партия?» chip was tapped — journaled (the
   * record) or sent after it (`POST /games/:id/thoughts`), and answered with a recorded line. ≤ 2 chips a game, each
   * once; false = not taken.
   */
  tapThought(chip: ThoughtChipId): boolean;
  /** Writes the resume snapshot right now (page is being hidden). Returns false when nothing was written. */
  persistNow(): boolean;
  resign(): void;
  /** A dialog (resign confirmation) is open: both clocks stand still. */
  setModalOpen(open: boolean): void;
  dismissBotBubble(): void;
  /** The object registered with `coach.setToolHost` while the game is active. */
  readonly toolHost: CoachToolHost;
  /** Resolves when no engine work or post-game work is pending (tests, e2e). */
  whenSettled(): Promise<void>;
  dispose(): void;
}

export function createGameController(deps: GameDeps): GameController {
  const timings: GameTimings = { ...DEFAULT_GAME_TIMINGS, ...deps.timings };
  const now = deps.now ?? (() => performance.now());
  const wallClock = deps.wallClock ?? (() => new Date());
  const rng = deps.rng ?? Math.random;
  const log = deps.log ?? ((message: string, error?: unknown) => console.warn(`[game] ${message}`, error ?? ''));
  const playSound = (name: GameSoundName): void => {
    try {
      deps.playSound?.(name);
    } catch {
      // sound is decoration
    }
  };

  const store = createStore<GameState>()(() => ({ ...INITIAL_GAME_STATE }));
  const set = (patch: Partial<GameState>): void => store.setState(patch);
  const get = (): GameState => store.getState();

  // ───── mutable game data (not reactive) ─────
  let chess: Chess | null = null; // created lazily in start()
  let clock: GameClock | null = null;
  let config: GameConfig | null = null;
  let persona: Persona = PERSONAS.petya;
  let timeControl: TimeControl = TIME_CONTROLS.training;
  let profile: StudentProfile = defaultStudentProfile(wallClock());
  let gameId = '';
  let startedAt = wallClock();
  let startedAtMono = now();
  let turnStartedAt = now();

  const events: GameEvent[] = [];
  const moveEvents: GameEvent[] = []; // parallel to state.moves
  const judgements: MoveJudgement[] = [];
  /** judgements of attempts that were taken back (they stay in the record, but not in the accuracy) */
  const takenBackJudgements = new Set<MoveJudgement>();
  const fensAfter: string[] = [];
  const cache = new Map<string, CacheEntry>();
  const jobs: JudgeJob[] = [];
  const recentCoachPhrases: string[] = [];
  /** concept cards planned in this game (a planned card counts even when its words were not journaled) */
  const conceptsThisGame = new Set<string>();
  /** concept cards of the games parked offline at the start (not in the server's list yet) */
  let parkedConcepts: string[] = [];

  let background: BackgroundSearch | null = null;
  let jobRunner: Promise<void> | null = null;
  let jobsDone = 0;
  let jobListener: ProgressListener | null = null;
  let jobDeadline = Number.POSITIVE_INFINITY;
  let judgeOk = true;
  let opening: OpeningLookup | undefined;

  let offersMade = 0;
  let lastOfferPly = Number.NEGATIVE_INFINITY;
  let lastPraisePly = Number.NEGATIVE_INFINITY;
  let threatWarnings = 0;
  let lastThreatWarningPly = Number.NEGATIVE_INFINITY;
  /** what the last warning was about (squares + motif): the same danger is not announced twice in a row */
  let lastWarningKey = '';
  /** the opponent's null-move threat per position (null = searched, nothing found) */
  const threats = new Map<string, Threat | null>();
  /** the pending proactive threat check of the current child turn */
  let threatCheck: { at: number; key: string; ply: number; fired: boolean; done: boolean } | null = null;
  /** «а если я пойду…?» judgement in flight on the judge engine */
  let adhocSearch: Promise<unknown> | null = null;
  /** the conversational voice session, as the coach reports it */
  let conversationState: ConversationState = 'off';
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastNudgeAt = Number.NEGATIVE_INFINITY;
  let gameEndNotified = false;
  let routineAfterPunishSaid = false;
  let movesShown = 0;
  let lastNoHintsAt = Number.NEGATIVE_INFINITY;
  let retryingAfterTakeback = false;
  let pendingOffer: PendingOffer | null = null;
  /** an offer that was on the screen when the page went away (resume): shown again instead of the bot's answer */
  let restoredOffer: PendingOffer | null = null;
  /** the offered move was taken back in this position: the child's next move there may be offered again at once */
  let offerRetry: { key: string; uci: string } | null = null;
  /** positions whose cooldown a new try after a take-back has skipped already — once per position */
  const retryBypassed = new Set<string>();
  /** 5 and 10 minutes: the child's clock stands while the conversational voice answers or speaks (answers, moments) */
  let voiceHold: (() => void) | null = null;
  /** …and while a phrase recorded while its bubble was up is played late («Дозапись голоса» G2) */
  let lateHold: (() => void) | null = null;
  let declined: MoveJudgement | null = null;
  let openingIdeaSaid = false;
  /** ply of the child's move that «Вернуть ход» gave back — one undo per own move */
  let undoUsedAtPly: number | null = null;
  /** the live judgement of the child's last move, until it is stored (runEnding waits for it) */
  let liveJudging: Promise<unknown> | null = null;
  /** clock-holding coach phrases that are being spoken right now */
  let coachHolds = 0;
  /** set by finish(): the game is over, its record is not delivered yet */
  let ended: { result: GameResult; termination: Termination } | null = null;
  /** the record went to saveRecord() — nobody else may send it */
  let recordHandedOff = false;
  let persistQueued = false;
  /** the snapshot's life is over (record saved / parked / not worth one) */
  let persistClosed = false;
  let persistFailureLogged = false;
  let noteResolve: (() => void) | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  /** the child's words after the record went out → POST /games/:id/thoughts (./thoughts.ts); null before that */
  let thoughts: ThoughtsOutbox | null = null;
  let thoughtSeq = 0;
  /** the last question Гамбитик asked since the game ended — a thought of the child belongs to it */
  let lastCoachQuestion: string | null = null;
  /**
   * «Записи»: the last phrase said and the position it was said about — null for a timeless phrase (the «Повтори» chip:
   * after a move or a take-back a phrase about the old board is not replayed — its arrows and its move belong to
   * another board), and the thought chips tapped after the game
   */
  let lastSaid: { event: CoachEvent; key: string | null } | null = null;
  /** the move whose take-back the child accepted: «Почему так?» asks its question again while the child tries anew */
  let takenBackOffer: MoveJudgement | null = null;
  const tappedThoughts = new Set<ThoughtChipId>();
  let declineTimer: ReturnType<typeof setTimeout> | null = null;
  /** the move the child insisted on has already been punished on the board */
  let declinePunished = false;

  // ───── «Учитель» (docs/TEACHER-MODE.md §2) ─────
  /** the resolved coach style of this game */
  let coachStyle: CoachStyle = 'helper';
  const teacherContent: TeacherContent = { ...DEFAULT_TEACHER_CONTENT, ...deps.teacherContent };
  /** what the teacher remembers between turns (TeachPlan.memory of the last planned turn) */
  let teachMemory: TeachMemory = initialTeachMemory();
  /** the plans of the latest child plies (by the ply the child is about to play): «Совет», verdicts, take-backs */
  const teachPlans = new Map<number, TeachPlan>();
  /** the teachTurn of this ply is being prepared (engine, plan) — a child's move makes it stale */
  let teachRun: { ply: number; at: number; preparing: boolean; done: Promise<void> } | null = null;
  /** a search of the teacher pipeline (null-move threat, searchmoves verification, a piece's best move) */
  let teachSearch: Promise<unknown> | null = null;
  /** teacher utterances holding the child's clock right now (timed games) */
  let teachSpeaking = 0;
  let teachHoldTimer: ReturnType<typeof setTimeout> | null = null;
  /** the silent note about the bot's move waits for the teachTurn: it goes out only when no teachTurn does (§2.9) */
  let deferredBotNote: string | null = null;

  // ───── «Учитель»: the lesson (docs/TEACHING.md §4.6) ─────
  /** the phrase book of this game (every style: the takeaway of any game uses it); replaced in start() */
  let book: LessonBook = createLessonBook({ seed: 1 });
  /**
   * «Дозапись голоса»: the book asks the coach on every pick whether the recorded voice speaks and what it already has
   * (null = the default book, byte for byte). A broken coach never breaks a pick.
   */
  const lessonVoice = (): LessonVoicePolicy | null => {
    try {
      return deps.coach.voicePolicy?.() ?? null;
    } catch (error) {
      log('coach.voicePolicy failed', error);
      return null;
    }
  };
  /**
   * The timers of the current lesson moment (the arrow after its sentence, a hidden advice's reveal, the treasure's
   * hints, the quiz's time-out): all of them end with the child's move, a take-back, a new turn, the end and dispose.
   */
  const lessonTimers = new Set<{ cancel(): void }>();
  let lessonGen = 0;
  /** plies whose green advice arrow has been on the board (at once, after its sentence, revealed, «Совет», an answer) */
  const arrowShown = new Set<number>();
  /**
   * Settles when every phrase the game has given the coach so far is over (said, cut or dropped). The coach says them
   * in the order they came (the queue drops, never reorders, the phrases of one priority), so a phrase given now comes up
   * about then: the reading time of a calm advice counts from there (§4.6) — not while the reaction before it is still
   * in the bubble.
   */
  let speechTail: Promise<void> = Promise.resolve();
  /** plies whose quiz the child answered with a button (the move after it is his own) */
  const quizAnswered = new Set<number>();
  /** right quiz answers in a row */
  let quizStreak = 0;
  let quizHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let quizCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** «Спроси» is hidden for the open quiz card (coach.setAskSuppressed) */
  let askSuppressed = false;

  // ───── «Учитель» + the smart strategist (strategy of the game, re-plans) ─────
  /** the strategy this game is played with (null = none yet / none at all) */
  let strategy: GameStrategy | null = null;
  /** its library card (the child's line, the whole main line), when the content knows it */
  let strategyCard: StrategyCardOf | null = null;
  /** the strategy request of this game: its promise (never rejects), when it was asked, what it asked */
  let strategyAsk: { key: string; startedAt: number; promise: Promise<GameStrategy | null>; controller: AbortController } | null = null;
  /** the first teacher line of the game has been planned and said (only that one ever waits for the strategy) */
  let firstTeachSaid = false;
  /** accepted re-plans (newest last) with the key of the position each was made for */
  const replans: { answer: ReplanResponse; fenKey: string }[] = [];
  /** bumped by every re-plan request: an answer to an older one is stale */
  let replanSeq = 0;
  let replanController: AbortController | null = null;
  let lastReplanPly: number | null = null;
  /** the phase the current plan was made for (a strategy starts in the opening) */
  let planPhase: PositionPhase = 'opening';
  /** is the game on the strategy's line (what the plan assumed before the bot's next move)? */
  let lineStatus: LineStatus = 'unknown';
  /** «Поторопись!» has been said this game (once, below `hurryBelowMs`) */
  let hurrySaid = false;
  /** the theme of the game (`lessonGameStart`) has been announced: never a second time */
  let themeSaid = false;
  /** the game said its own «Привет!» with a wave: the teacher's intro after it talks (a wave, then the words) */
  let gameHelloWaved = false;

  /** Bumped by every transition that makes pending async continuations stale. */
  let epoch = 0;
  let disposed = false;
  /** named 'modal' holds of the clock: the take-back decision, the resign dialog */
  const holds = new Map<string, () => void>();
  let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  let threatTimer: ReturnType<typeof setTimeout> | null = null;
  let activity: Promise<void> = Promise.resolve();
  let ending: Promise<void> = Promise.resolve();
  const unsubs: (() => void)[] = [];

  const stale = (at: number): boolean => disposed || at !== epoch;
  const childColor = (): Color => config?.childColor ?? 'w';
  const botColor = (): Color => other(childColor());
  const coachMode = () => timeControl.coachMode;
  const currentPly = (): number => get().moves.length;
  /** «Учитель» is on: the style, a coached time control, not an exam */
  const teacherOn = (): boolean => coachStyle === 'teacher' && coachMode() !== 'off' && config?.examMode !== true;
  /**
   * 5 and 10 minutes, any style: the CHILD's clock does not run while Гамбитик speaks — the greeting, praise, answers to
   * the child's questions, take-back offers. The bot's clock is not touched. Bullet: the coach is
   * silent (a 1-minute clock cannot stop); training: no clock.
   */
  const speechHoldsChildClock = (): boolean => clock !== null && clock.timed && coachMode() !== 'off' && get().phase !== 'gameOver';
  /**
   * The lesson model (docs/TEACHING.md §4.4): generative AI may be used in the child's game (the server's `health.ai.runtime`,
   * through the coach). Without it the strategist is never asked for re-plans (the template strategy stays).
   */
  const runtimeAiOn = (): boolean => {
    try {
      return deps.coach.runtimeAi?.() === true;
    } catch {
      return false;
    }
  };

  /** Tracks fire-and-forget work so `whenSettled()` can wait for it. */
  function track(work: Promise<void>): void {
    const safe = work.catch((error: unknown) => log('unexpected error in the game loop', error));
    activity = Promise.all([activity, safe]).then(() => undefined);
  }

  function holdClock(name: string): void {
    if (!clock || holds.has(name) || get().phase === 'gameOver') return;
    holds.set(name, clock.hold('modal'));
  }

  function releaseClock(name: string): void {
    holds.get(name)?.();
    holds.delete(name);
  }

  // ───────────────────────── journal ─────────────────────────

  function addEvent(type: GameEventType, data: Record<string, unknown>, ply?: number): GameEvent {
    const event: GameEvent = { t: Math.max(0, Math.round(now() - startedAtMono)), type, data };
    if (ply !== undefined) event.ply = ply;
    events.push(event);
    schedulePersist();
    return event;
  }

  // ───────────────────────── resume snapshot ─────────────────────────

  const finiteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);

  function buildSnapshot(): ResumableGame | null {
    if (!config || !chess || !clock) return null;
    const moves = get().moves;
    if (moves.length === 0 && ended === null) return null; // nothing to continue yet
    const takenBack: number[] = [];
    judgements.forEach((judgement, index) => {
      if (takenBackJudgements.has(judgement)) takenBack.push(index);
    });
    return {
      v: RESUME_VERSION,
      savedAt: wallClock().toISOString(),
      gameId,
      config,
      nickname: profile.nickname,
      stage: profile.stage,
      startedAt: startedAt.toISOString(),
      elapsedMs: Math.max(0, Math.round(now() - startedAtMono)),
      moves,
      events,
      judgements,
      takenBack,
      clock: { w: clock.remaining('w'), b: clock.remaining('b') },
      opening: opening ?? null,
      counters: {
        offersMade,
        lastOfferPly: finiteOrNull(lastOfferPly),
        lastPraisePly: finiteOrNull(lastPraisePly),
        threatWarnings,
        lastThreatWarningPly: finiteOrNull(lastThreatWarningPly),
        routineAfterPunishSaid,
        movesShown,
        openingIdeaSaid,
        undoUsedAtPly,
      },
      ended,
      teach: coachStyle === 'teacher' ? { memory: teachMemory, strategy: strategy !== null ? strategyState() : null } : null,
      // the lesson: the phrase book of this game for every style (its bag goes on after a reload; never the quiz card) and
      // the child's cross-game memory as this game has changed it so far (localStorage gets it only in finish())
      lesson: { book: book.snapshotGame(), history: book.snapshotHistory() },
      // the take-back question on the screen survives a reload («Партия ждала тебя» must not let the bot answer the blunder)
      ...(pendingOffer ? { pendingOffer: { ply: pendingOffer.judgement.ply, uci: pendingOffer.judgement.uci, childClockBefore: pendingOffer.childClockBefore, botClockBefore: pendingOffer.botClockBefore } } : {}),
    };
  }

  /** Where the plan stands, for the snapshot (the strategy itself is in `config.strategy`). */
  function strategyState(): ResumeStrategyState {
    const latest = replans[replans.length - 1] ?? null;
    return { lineStatus, lastReplanPly, planPhase, replan: latest ? { answer: latest.answer, fenKey: latest.fenKey } : null };
  }

  /** Writes the snapshot now. False: nothing to write, no storage, or the write failed. */
  function persistNow(): boolean {
    if (disposed || persistClosed || !deps.storage) return false;
    const snapshot = buildSnapshot();
    if (!snapshot) return false;
    const ok = writeResumableGame(deps.storage, snapshot);
    if (!ok && !persistFailureLogged) {
      persistFailureLogged = true;
      log('the game in progress could not be written to localStorage — «Продолжить партию?» will not be offered');
    }
    return ok;
  }

  /** Coalesces the many journal writes of one move into one localStorage write. */
  function schedulePersist(): void {
    if (persistQueued || disposed || persistClosed || !deps.storage) return;
    persistQueued = true;
    queueMicrotask(() => {
      persistQueued = false;
      persistNow();
    });
  }

  /** The record is delivered (or parked, or the game is not worth one): the snapshot must not come back. */
  function closeSnapshot(): void {
    persistClosed = true;
    dropResumableGame(deps.storage, gameId);
  }

  function hintAvailability(available: boolean): void {
    try {
      deps.coach.setHintAvailable?.(available);
    } catch (error) {
      log('coach.setHintAvailable failed', error);
    }
  }

  function notifyGameEnd(info: { result: GameResult; termination: Termination | 'left' }): void {
    if (gameEndNotified) return;
    gameEndNotified = true;
    try {
      deps.coach.onGameEnd?.(info);
    } catch (error) {
      log('coach.onGameEnd failed', error);
    }
  }

  function pushContext(note: string): void {
    try {
      deps.coach.pushContext?.(note);
    } catch (error) {
      log('coach.pushContext failed', error);
    }
  }

  /**
   * «Дозапись голоса» (G2): the board changed (a ply, a take-back) — a phrase of the position before, recorded only now,
   * is never played late over the new one.
   */
  function noteBoardChange(): void {
    try {
      deps.coach.noteBoardChange?.();
    } catch (error) {
      log('coach.noteBoardChange failed', error);
    }
  }

  /**
   * The words of a coach event for the journal. While a conversational voice is listening, the model says the moment
   * IN ITS OWN WORDS (its transcript is journaled as `coachSaid {source:'voice'}`): the template is then kept under
   * `template` — not rendered as «Тренер сказал» — so the journal shows what was really said, not a script.
   */
  function journalWords(event: CoachEvent): Record<string, unknown> {
    return MODEL_VOICE_STATES.has(deps.coach.conversationState ?? conversationState)
      ? { template: event.text, spokenBy: 'model' }
      : { text: event.text, bubbleText: event.bubbleText };
  }

  function rememberCoachPhrase(text: string, noteQuestion = true): void {
    recentCoachPhrases.push(normalizePhrase(text));
    if (recentCoachPhrases.length > 6) recentCoachPhrases.shift();
    if (noteQuestion) noteCoachQuestion(text);
  }

  /** «… Что было самым трудным?» — the question the child's next words answer (the post-game thoughts carry it). */
  function noteCoachQuestion(text: string): void {
    const question = lastQuestionRu(text);
    if (question) lastCoachQuestion = question;
  }

  /** A thought of the child that came after the record went out: it follows the record to the server. */
  function sendThought(source: 'voice' | 'typed', text: string, question: string | null): void {
    if (!thoughts) return;
    thoughtSeq += 1;
    const thought = makeThought({ id: `${gameId}-t${thoughtSeq}`, source, text, question, at: wallClock() });
    if (thought) thoughts.add(thought);
  }

  /**
   * Says a coach phrase: journals it, holds the clock while it is spoken when the event asks for it.
   * Never rejects. The returned promise resolves when the phrase is over (spoken, interrupted or dropped).
   */
  function sayEvent(event: CoachEvent, journalAs: 'coachSaid' | 'none' = 'coachSaid', opts: { holdClock?: boolean } = {}): Promise<void> {
    if (disposed) return Promise.resolve();
    // (a lesson reply the library has no words for comes with an empty text: nothing is said, no empty bubble)
    if (event.text.trim() === '') return Promise.resolve();
    if (journalAs === 'coachSaid') {
      // teacher moments carry what was advised (arrows, moment, style, a new topic) for the journal (TEACHER-MODE §7.5);
      // a lesson question carries its buttons (the server's journal shows them, the right one marked)
      addEvent(
        'coachSaid',
        { kind: event.kind, ...journalWords(event), priority: event.priority, ...(event.teach ? { teach: event.teach } : {}), ...(event.quiz ? { quiz: event.quiz } : {}) },
        currentPly(),
      );
    }
    // the phrase book hears everything that is said (two phrases in a row never open with the same word, §2.11)
    try {
      book.noteSaid(event.text);
    } catch (error) {
      log('the phrase book could not note a phrase', error);
    }
    // whoever says «Поторопись» first (the teacher's own line, or ours) — it is said once per game
    if (/оторопи/i.test(event.text)) hurrySaid = true;
    // the game-end template asks the child nothing (its practice line only quotes a question): what the child says next
    // answers the diary question on the card, or what the voice asks in its own words
    rememberCoachPhrase(event.text, event.kind !== 'gameEnd');
    if (event.priority >= 1) lastSaid = { event, key: isAboutThePosition(event) ? (chess ? positionKey(chess.fen()) : '') : null };
    const holdsClock = opts.holdClock ?? event.pauseClock;
    const release = holdsClock && get().phase !== 'gameOver' ? clock?.hold('coach') : undefined;
    if (release) coachHolds += 1;
    // 5 and 10 minutes: whatever the phrase, the CHILD's clock does not run while it is said (the bot's clock does)
    const childHold = speechHoldsChildClock() ? clock?.holdFor(childColor()) : undefined;
    let spoken: Promise<void>;
    try {
      spoken = deps.coach.say(event);
    } catch (error) {
      spoken = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const over = spoken.then(
      () => undefined,
      () => undefined,
    );
    speechTail = Promise.all([speechTail, over]).then(() => undefined);
    return spoken
      .catch((error: unknown) => log('coach.say failed', error))
      .finally(() => {
        if (release) coachHolds = Math.max(0, coachHolds - 1);
        release?.();
        childHold?.();
      });
  }

  /**
   * The conversational voice speaks in its own words — an answer to the child's question, a moment of the game: the
   * child's clock stands until it stops (5 and 10 minutes, any style). Driven by the coach's conversation state:
   * `coachSpeaking`, and `thinking` — the child asked and Гамбитик is looking at the board for the answer (the clock
   * must not run while he answers).
   */
  function syncVoiceHold(): void {
    const speaking = !disposed && (conversationState === 'coachSpeaking' || conversationState === 'thinking') && speechHoldsChildClock();
    if (speaking && voiceHold === null && clock) voiceHold = clock.holdFor(childColor());
    else if (!speaking) releaseVoiceHold();
  }

  function releaseVoiceHold(): void {
    const release = voiceHold;
    voiceHold = null;
    release?.();
    releaseLateHold();
  }

  /**
   * «Дозапись голоса» G2: a phrase that was silent a moment ago sounds now that its recording arrived — outside the
   * coach's queue, so `sayEvent` holds nothing for it. 5 and 10 minutes: the child's clock stands while it sounds, as
   * for any phrase.
   */
  function syncLateHold(speaking: boolean): void {
    if (speaking && !disposed && lateHold === null && clock && speechHoldsChildClock() && get().phase !== 'gameOver') lateHold = clock.holdFor(childColor());
    else if (!speaking) releaseLateHold();
  }

  function releaseLateHold(): void {
    const release = lateHold;
    lateHold = null;
    release?.();
  }

  // ───────────────────────── board state ─────────────────────────

  function kingInCheckSquare(game: Chess): Square | null {
    if (!game.inCheck()) return null;
    return game.findPiece({ type: 'k', color: game.turn() })[0] ?? null;
  }

  function syncBoard(extra: Partial<GameState> = {}): void {
    if (!chess) return;
    set({ fen: chess.fen(), turn: chess.turn(), checkSquare: kingInCheckSquare(chess), selected: null, legalTargets: [], pendingPromotion: null, ...extra });
    // a move may leave the card's line, a take-back come back to it: the «Тема: …» badge follows the game
    syncThemeBadge();
  }

  function legalTargetsFrom(square: ChessSquare): LegalTarget[] {
    if (!chess) return [];
    const seen = new Map<string, LegalTarget>();
    for (const move of chess.moves({ square, verbose: true })) {
      if (!seen.has(move.to)) seen.set(move.to, { square: move.to, capture: isCaptureMove(move) }); // en passant too (chess.js: isCapture() is false for it)
    }
    return [...seen.values()];
  }

  function setBotBubble(bubble: BotBubble | null, autoHide = true): void {
    if (bubbleTimer !== null) clearTimeout(bubbleTimer);
    bubbleTimer = null;
    set({ botBubble: bubble });
    if (bubble && autoHide) {
      bubbleTimer = setTimeout(() => {
        bubbleTimer = null;
        set({ botBubble: null });
      }, timings.botBubbleMs);
    }
  }

  function pickLine(lines: readonly string[]): string {
    if (lines.length === 0) return '';
    return lines[Math.min(lines.length - 1, Math.floor(rng() * lines.length))] ?? '';
  }

  function clearThreatTimer(): void {
    if (threatTimer !== null) clearTimeout(threatTimer);
    threatTimer = null;
  }

  // ───────────────────────── judge: background analysis + cache ─────────────────────────

  function storeAnalysis(key: string, result: AnalysisResult, complete: boolean): void {
    const existing = cache.get(key);
    if (existing && (existing.complete || existing.result.depth >= result.depth) && !complete) return;
    cache.set(key, { result, complete });
    // only the few latest positions matter (current move, and the one before it after a take-back)
    while (cache.size > 6) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function startBackground(fen: string): void {
    if (!judgeOk || disposed || coachMode() === 'off') return;
    const key = positionKey(fen);
    if (cache.get(key)?.complete) {
      if (!threats.has(key) && !(background && !background.settled && background.key === key)) {
        const search: BackgroundSearch = { key, fen, latest: [], settled: false, stopped: false, promise: Promise.resolve() };
        search.promise = searchThreat(search).finally(() => {
          search.settled = true;
        });
        background = search;
        track(search.promise);
      }
      return;
    }
    if (background && !background.settled && background.key === key) return;

    const search: BackgroundSearch = { key, fen, latest: [], settled: false, stopped: false, promise: Promise.resolve() };
    const options: AnalyzeOptions & { onProgress?: (lines: EngineLine[]) => void } = {
      depth: timings.backgroundDepth,
      multipv: timings.backgroundMultipv,
      movetimeMs: timings.backgroundMovetimeMs,
      onProgress: (lines) => {
        search.latest = lines;
      },
    };
    let pending: Promise<AnalysisResult>;
    try {
      pending = deps.judge.analyze(fen, options);
    } catch (error) {
      pending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    search.promise = pending
      .then(
        (result) => storeAnalysis(key, result, true),
        (error: unknown) => {
          const partial = partialAnalysisOf(error, fen) ?? analysisFromLines(fen, search.latest);
          if (partial) storeAnalysis(key, partial, false);
        },
      )
      // «что хочет соперник?» — the null-move search right after the analysis, in the same background slot
      .then(() => searchThreat(search))
      .finally(() => {
        search.settled = true;
      });
    background = search;
    track(search.promise);
  }

  /**
   * The opponent's threat in the child's position: a short search of the NULL-MOVE position (the child passes).
   * Only in coached, non-exam games (nothing uses it elsewhere), only while this is still the position on the board.
   */
  async function searchThreat(search: BackgroundSearch): Promise<void> {
    const key = search.key;
    if (search.stopped || disposed || threats.has(key) || config?.examMode || coachMode() === 'off') return;
    if (!chess || positionKey(chess.fen()) !== key || chess.turn() !== childColor()) return;
    const nullFen = nullMoveFen(search.fen);
    if (!nullFen) {
      threats.set(key, null);
      onThreatKnown(key);
      return;
    }
    try {
      const result = await deps.judge.analyze(nullFen, { depth: timings.threatSearchDepth, multipv: 1, movetimeMs: timings.threatSearchMovetimeMs });
      const line = result.lines.find((l) => l.multipv === 1) ?? result.lines[0];
      threats.set(key, line ? threatFromNullMoveLine(search.fen, line) : null);
      while (threats.size > 6) {
        const oldest = threats.keys().next().value;
        if (oldest === undefined) break;
        threats.delete(oldest);
      }
    } catch {
      // stopped (the child moved, a hint was asked) or the engine hiccuped: the threat stays unknown
      return;
    }
    onThreatKnown(key);
  }

  /** Stops a running background search (and an ad-hoc move check) and waits until its (partial) result is in the cache. */
  async function stopBackground(): Promise<void> {
    const search = background;
    const adhoc = adhocSearch;
    const teach = teachSearch;
    if ((!search || search.settled) && !adhoc && !teach) return;
    if (search && !search.settled) search.stopped = true;
    try {
      deps.judge.stop();
    } catch (error) {
      log('judge.stop failed', error);
    }
    if (search && !search.settled) await withTimeout(search.promise, 2_500, 'background analysis stop').catch(() => undefined);
    if (adhoc) await withTimeout(adhoc, 2_500, 'move check stop').catch(() => undefined);
    if (teach) await withTimeout(teach, 2_500, 'teacher search stop').catch(() => undefined);
  }

  /** judgeMove asks for depth-limited searches; live play also needs a time limit (engine report: «always pass movetimeMs»). */
  function timeBoxedJudge(): IJudgeEngine {
    const judge = deps.judge;
    return {
      ready: () => judge.ready(),
      analyze: (fen, opts) =>
        judge.analyze(fen, {
          ...opts,
          movetimeMs: opts.movetimeMs ?? ((opts.depth ?? 0) >= CONFIRM_DEPTH_FROM ? timings.confirmMovetimeMs : timings.quickMovetimeMs),
        }),
      stop: () => judge.stop(),
      dispose: () => undefined,
    };
  }

  async function judgeNow(job: JudgeJob, timeoutMs: number): Promise<MoveJudgement | null> {
    if (!judgeOk) return null;
    const cachedBefore = cache.get(positionKey(job.fenBefore))?.result;
    try {
      return await withTimeout(
        judgeMove(timeBoxedJudge(), { fenBefore: job.fenBefore, uci: job.uci, ply: job.ply, cachedBefore, drawnByRepetition: job.drawnByRepetition === true }),
        timeoutMs,
        'judgeMove',
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        try {
          deps.judge.stop();
        } catch {
          // the engine is in trouble anyway
        }
      }
      log(`move ${job.ply} could not be judged now`, error);
      return null;
    }
  }

  /** Background / post-game queue of moves that still need a judgement. One job at a time. */
  function runJobs(): Promise<void> {
    jobRunner ??= (async () => {
      try {
        while (jobs.length > 0 && !disposed) {
          if (now() > jobDeadline) {
            jobsDone += jobs.length;
            jobs.length = 0;
            break;
          }
          const job = jobs.shift() as JudgeJob;
          const judgement = await judgeNow(job, timings.postGameJudgeTimeoutMs);
          if (judgement) {
            judgements.push(judgement);
            schedulePersist();
          }
          jobsDone += 1;
          jobListener?.(jobsDone, jobsDone + jobs.length);
        }
      } finally {
        jobRunner = null;
      }
    })();
    return jobRunner;
  }

  // ───────────────────────── opening book ─────────────────────────

  function refreshOpening(): void {
    const lookup = deps.lookupOpening;
    if (!lookup || fensAfter.length > OPENING_MAX_PLY) return;
    const fens = [...fensAfter];
    track(
      lookup(fens).then(
        (hit) => {
          if (!hit || disposed) return;
          opening = hit;
          // on screen and in spoken facts only the Russian name is used; rare openings without one stay unnamed
          set({ openingName: hit.nameRu ?? null });
        },
        (error: unknown) => log('opening lookup failed', error),
      ),
    );
  }

  // ───────────────────────── moves ─────────────────────────

  /** Applies a legal move of `by`, journals it, switches the clock. Returns null when the game ended by flag instead. */
  function playMove(by: 'child' | 'bot', input: { from: string; to: string; promotion?: string }): MoveEntry | null {
    if (!chess || !clock) return null;
    const mover = chess.turn();
    const left = clock.remaining(mover);
    if (left !== null && left <= 0) {
      clock.switchTo(other(mover)); // lets the flag fall
      return null;
    }
    const fenBefore = chess.fen();
    const move = chess.move(input); // throws on an illegal move — callers validate first
    noteBoardChange();
    const ply = get().moves.length + 1;
    let entry: MoveEntry = {
      ply,
      color: mover,
      by,
      san: move.san,
      uci: uciOf(move),
      from: move.from,
      to: move.to,
      fenBefore,
      fenAfter: chess.fen(),
      clockMs: null,
      spentMs: Math.max(0, Math.round(now() - turnStartedAt)),
    };
    if (move.captured) entry.captured = move.captured;

    const event = addEvent(
      'move',
      { by, color: mover, san: entry.san, uci: entry.uci, fenBefore, fenAfter: entry.fenAfter, spentMs: entry.spentMs },
      ply,
    );
    moveEvents.push(event);
    fensAfter.push(entry.fenAfter);
    set({ moves: [...get().moves, entry], lastMove: { from: entry.from, to: entry.to } });

    // the entry is in the list BEFORE the clock is pressed: a flag that falls right here still sees the move
    clock.switchTo(other(mover));
    const clockMs = clock.remaining(mover);
    if (clockMs !== null) {
      const pushed = entry;
      entry = { ...pushed, clockMs };
      const withClock = entry;
      set({ moves: get().moves.map((m) => (m === pushed ? withClock : m)) });
    }
    event.data.clockMs = clockMs;
    turnStartedAt = now();

    syncBoard();
    playSound(chess.inCheck() ? 'check' : isCaptureMove(move) ? 'capture' : 'move');
    if (ply <= OPENING_MAX_PLY) refreshOpening();
    return entry;
  }

  /** Ends the game when the position on the board is final. */
  function finishIfOver(lastMover: Color): boolean {
    if (!chess) return false;
    if (get().phase === 'gameOver') return true;
    if (chess.isCheckmate()) finish(resultFor(lastMover), 'checkmate');
    else if (chess.isStalemate()) finish('1/2-1/2', 'stalemate');
    else if (chess.isDraw()) finish('1/2-1/2', 'draw');
    else return false;
    return true;
  }

  function findLegal(from: string, to: string): Move[] {
    if (!chess || !isSquare(from) || !isSquare(to)) return [];
    return chess.moves({ square: from, verbose: true }).filter((move) => move.to === to);
  }

  /** Validates and plays the child's move; returns false when nothing was played. */
  function tryChildMove(from: string, to: string, promotion?: PromotionPiece): boolean {
    if (disposed || get().phase !== 'childTurn' || !chess || chess.turn() !== childColor()) return false;
    const candidates = findLegal(from, to);
    if (candidates.length === 0) {
      set({ selected: null, legalTargets: [] });
      return false;
    }
    if (candidates.some((move) => move.promotion) && !promotion) {
      set({ pendingPromotion: { from, to, color: childColor() }, selected: null, legalTargets: [] });
      return false;
    }
    commitChildMove(from, to, promotion);
    return true;
  }

  function commitChildMove(from: string, to: string, promotion?: PromotionPiece): void {
    if (!chess || !clock) return;
    const child = childColor();
    const childClockBefore = clock.remaining(child);
    const botClockBefore = clock.remaining(botColor());
    clearThreatTimer();
    threatCheck = null;
    clearSilenceTimer();
    // «Учитель»: the advice the child SAW for this move (journal: an arrow still hidden — a quiz, «Сам», a treasure, a
    // sentence not finished — was not seen), and the teacher's utterance of this ply is over — the clock hold ends
    // BEFORE the clock is pressed, a remark still being prepared or said is cut (§2.1); an open quiz card closes silently
    const movePly = currentPly() + 1;
    const shownAdvice = teacherOn() ? (arrowShown.has(movePly) ? (get().advice ?? []) : []) : null;
    const adviceWasHidden = teacherOn() && !arrowShown.has(movePly) && (teachPlans.get(movePly)?.advice.length ?? 0) > 0;
    closeQuiz();
    const teachCut = endTeachUtterances();

    const at = ++epoch;
    const entry = playMove('child', promotion ? { from, to, promotion } : { from, to });
    if (!entry) return;

    // The child has moved on: a phrase that still holds the clock (a hint, a warning, «ход вернули…») would keep
    // the BOT waiting for up to 25 s. Chatter that holds nothing (greeting, praise) is left alone.
    // Gently (in a fast 5-minute game most teacher remarks would otherwise be chopped mid-word): what waits
    // is dropped, but the sentence he is saying may end (≤ 2 s) before the newest remark comes.
    if (coachHolds > 0 || teachCut) deps.coach.stopSpeaking({ grace: true });
    deps.coach.noteActivity?.();
    deps.coach.clearAnnotations?.();
    retryingAfterTakeback = false;
    takenBackOffer = null;
    clearDeclineReasons();
    set({ annotations: null, hintPulse: false, hintLevel: 0, canUndo: false, ...(shownAdvice ? { advice: null, treasure: null } : {}) });
    if (shownAdvice) journalAdvice(entry, shownAdvice);
    if (adviceWasHidden && moveEvents[moveEvents.length - 1]?.ply === entry.ply) (moveEvents[moveEvents.length - 1] as GameEvent).data.adviceHidden = true;
    const job: JudgeJob = { ply: entry.ply, fenBefore: entry.fenBefore, uci: entry.uci };
    // only the game knows its history: a third repetition ends it as a draw, whatever the position is worth
    if (chess.isThreefoldRepetition()) job.drawnByRepetition = true;
    if (get().phase === 'gameOver') return; // the flag fell with the move
    if (chess.isGameOver()) {
      // a mating / drawing move still deserves its judgement in the record (queued BEFORE the end pipeline starts)
      jobs.push(job);
      finishIfOver(child);
      return;
    }
    if (coachMode() === 'off' || !judgeOk) {
      // bullet: the judgement is computed in the background and never blocks the bot
      jobs.push(job);
      if (judgeOk) track(runJobs());
      track(botTurn(at, 0));
      return;
    }

    set({ phase: 'judging' });
    track(judgeAndContinue(at, job, entry, { childClockBefore, botClockBefore }));
  }

  async function judgeAndContinue(
    at: number,
    job: JudgeJob,
    entry: MoveEntry,
    clocks: { childClockBefore: number | null; botClockBefore: number | null },
  ): Promise<void> {
    const startedJudging = now();
    // The judgement is part of the record even when the game ends while it is computed (resign, the bot's flag):
    // runEnding() waits for `liveJudging` before it counts what is still missing.
    const judging = (async (): Promise<MoveJudgement | null> => {
      let result: MoveJudgement | null = null;
      try {
        await stopBackground();
        if (disposed) return null;
        result = await judgeNow(job, timings.judgeTimeoutMs);
      } catch (error) {
        log('judging failed', error);
      }
      if (stale(at) && !disposed) {
        // the game moved on: keep what we learned, or queue the move for the post-game pass
        if (result) judgements.push(result);
        else jobs.push(job);
        schedulePersist();
      }
      return result;
    })();
    liveJudging = judging;
    const judgement = await judging;
    if (liveJudging === judging) liveJudging = null;
    if (stale(at)) return;
    if (!judgement) {
      jobs.push(job);
      await botTurn(at, now() - startedJudging);
      return;
    }

    judgements.push(judgement);
    schedulePersist();
    const cfg = config;
    // the child took this exact move back and played it again — that is their decision, not a new slip
    const insisted = [...takenBackJudgements].some((t) => t.fenBefore === judgement.fenBefore && t.uci === judgement.uci);
    // ANOTHER move in the position whose offered move was just taken back: when it loses too, the offer comes again at
    // once («и этот ход теряет …») — the cooldown is skipped once per position
    const retryKey = positionKey(judgement.fenBefore);
    const retryOfOffer = offerRetry !== null && offerRetry.key === retryKey && offerRetry.uci !== judgement.uci;
    offerRetry = null;
    const skipCooldown = retryOfOffer && !retryBypassed.has(retryKey);
    const policyDecision = decideIntervention(
      judgement,
      {
        coachMode: coachMode(),
        stage: profile.stage,
        offersMade,
        remainingMs: clocks.childClockBefore,
        examMode: cfg?.examMode ?? false,
        pliesSinceLastOffer: entry.ply - lastOfferPly,
      },
      { retryAfterTakeback: skipCooldown },
    );
    const decision: InterventionDecision =
      insisted && policyDecision.action === 'offerTakeback' ? { action: 'logForReview', reason: 'insisted' } : policyDecision;
    const moveEvent = moveEvents[moveEvents.length - 1];
    if (moveEvent && moveEvent.ply === entry.ply) {
      Object.assign(moveEvent.data, {
        classification: judgement.classification,
        winPctLoss: Math.round(judgement.winPctLoss * 10) / 10,
        decision: decision.action,
        decisionReason: decision.reason,
      });
    }

    // the listening coach learns what happened — never in an exam, never the better move
    if (!cfg?.examMode) pushContext(judgementNoteRu(judgement, { offered: decision.action === 'offerTakeback' }));

    if (decision.action === 'offerTakeback') {
      if (skipCooldown) retryBypassed.add(retryKey);
      beginOffer(judgement, entry, clocks, { again: retryOfOffer });
      return;
    }
    if (teacherOn()) teachReact(judgement, entry, decision);
    else maybePraise(judgement, entry);
    await botTurn(at, now() - startedJudging);
  }

  // ───────────────────────── take-back ─────────────────────────

  /** `opts.again`: a new try in the position whose losing move was just taken back — «и этот ход теряет …». */
  function beginOffer(judgement: MoveJudgement, entry: MoveEntry, clocks: { childClockBefore: number | null; botClockBefore: number | null }, opts: { again?: boolean } = {}): void {
    if (!clock) return;
    epoch += 1;
    offersMade += 1;
    lastOfferPly = entry.ply;
    pendingOffer = { judgement, ...clocks };
    // the decision has no time limit: both clocks stand until the child chooses
    holdClock('offer');

    // «Учитель»: the lesson's offer (§2.8, «Стоп-стоп! {что случилось}. Вернём ход?»; stages 3–5 ask first) with the
    // advice the child SAW (never a hidden one); the other styles keep their offer
    const advice = teacherOn() ? shownAdviceOf(entry.ply) : [];
    const event = teacherOn()
      ? teacherOffer(judgement, advice, opts.again === true, true)
      : buildTakebackOffer(judgement, profile, rng, { ...(advice.length > 0 ? { advice } : {}), ...(opts.again === true ? { again: true } : {}) });
    addEvent(
      'takebackOffered',
      {
        san: judgement.san,
        uci: judgement.uci,
        winPctLoss: Math.round(judgement.winPctLoss * 10) / 10,
        classification: judgement.classification,
        allowedMotif: judgement.allowedMotif ?? null,
        kind: event.kind,
        ...(opts.again === true ? { again: true } : {}),
        ...journalWords(event),
        ...(event.teach ? { teach: event.teach } : {}),
      },
      entry.ply,
    );
    set({ phase: 'coachIntervention', takeback: { ply: entry.ply, san: judgement.san, judgement }, annotations: event.board ?? null });
    playSound('oops');
    void sayEvent({ ...event, pauseClock: false }, 'none');
  }

  /**
   * «Партия ждала тебя» while the take-back question was on the screen: the same question comes back (the bot never
   * answers the losing move by itself). Not a new offer — the budget counted it and the journal has it already.
   */
  function resumeOffer(offer: PendingOffer): void {
    const entry = get().moves[get().moves.length - 1];
    if (!clock || !entry || entry.by !== 'child') return;
    epoch += 1;
    pendingOffer = offer;
    holdClock('offer');
    // (the lesson memory of a restored game already has this offer: the words only, not a second mistake)
    const event = teacherOn() ? teacherOffer(offer.judgement, [], false, false) : buildTakebackOffer(offer.judgement, profile, rng);
    set({ phase: 'coachIntervention', takeback: { ply: entry.ply, san: offer.judgement.san, judgement: offer.judgement }, annotations: event.board ?? null });
    void sayEvent({ ...event, pauseClock: false }, 'none');
  }

  /** «Учитель»: the lesson's take-back offer; `commit` = its memory counts (a restored question does not count twice). */
  function teacherOffer(judgement: MoveJudgement, advice: readonly TeachAdvice[], again: boolean, commit: boolean): CoachEvent {
    try {
      const out = lessonTakebackOffer({ profile, judgement, advice, ...(again ? { again: true } : {}) }, teachMemory, book);
      if (commit) commitLessonMemory(out.memory);
      if (out.event.text.trim() !== '') return out.event;
    } catch (error) {
      log('the lesson take-back offer failed', error);
    }
    return buildTakebackOffer(judgement, profile, rng, { ...(advice.length > 0 ? { advice: [...advice] } : {}), ...(again ? { again: true } : {}) });
  }

  /** «Учитель»: the answer to the child's «Верну ход» / «Оставлю свой ход» (stages 3–5: now what could be taken). */
  function teacherTakebackReply(kind: 'yes' | 'no'): CoachEvent | null {
    try {
      const out = lessonTakebackReply(kind, profile, teachMemory, book);
      commitLessonMemory(out.memory);
      return out.event.text.trim() !== '' ? out.event : null;
    } catch (error) {
      log('the lesson take-back reply failed', error);
      return null;
    }
  }

  function acceptTakeback(): void {
    const offer = pendingOffer;
    if (get().phase !== 'coachIntervention' || !offer || !chess || !clock) return;
    epoch += 1;
    closeQuiz();
    clearLessonTimers();
    pendingOffer = null;
    takenBackJudgements.add(offer.judgement);
    takenBackOffer = offer.judgement;
    offerRetry = { key: positionKey(offer.judgement.fenBefore), uci: offer.judgement.uci };
    const child = childColor();

    chess.undo();
    noteBoardChange();
    const moves = get().moves.slice(0, -1);
    const undoneEvent = moveEvents.pop();
    if (undoneEvent) undoneEvent.data.takenBack = true;
    fensAfter.pop();
    const previous = moves[moves.length - 1];

    // the clock goes back to where it was before the move
    if (offer.childClockBefore !== null) clock.set(child, offer.childClockBefore);
    if (offer.botClockBefore !== null) clock.set(botColor(), offer.botClockBefore);
    clock.switchTo(child, { increment: false });

    addEvent(
      'takebackAccepted',
      { san: offer.judgement.san, uci: offer.judgement.uci, clockRestoredMs: offer.childClockBefore, classification: offer.judgement.classification },
      offer.judgement.ply,
    );

    // «Учитель» (§2.8): «да» in the lesson's words, then the advice of the restored position again (its arrows back;
    // a hidden one is shown now) instead of the ladder
    const plan = teacherOn() ? teachPlans.get(offer.judgement.ply) : undefined;
    if (plan) {
      retryingAfterTakeback = true;
      set({ moves, takeback: null, lastMove: previous ? { from: previous.from, to: previous.to } : null, hintPulse: false });
      syncBoard({ annotations: null });
      turnStartedAt = now();
      deps.coach.stopSpeaking({ clearBubble: true });
      releaseClock('offer');
      enterChildTurn();
      const reply = teacherTakebackReply('yes');
      if (reply) void sayTeach(reply);
      repeatAdvice(plan);
      return;
    }

    // keep the red danger squares (never the solution) while the child thinks again
    const danger: BoardAnnotations | null = get().annotations ? { arrows: [], highlights: get().annotations?.highlights ?? [] } : null;
    retryingAfterTakeback = true;
    set({ moves, takeback: null, lastMove: previous ? { from: previous.from, to: previous.to } : null, hintPulse: get().hintsEnabled });
    syncBoard({ annotations: danger });
    turnStartedAt = now();

    deps.coach.stopSpeaking({ clearBubble: true });
    const lessonReply = teacherOn() ? teacherTakebackReply('yes') : null;
    const accepted = sayEvent(lessonReply ?? buildTakebackAccepted(profile, rng));
    releaseClock('offer');
    if (teacherOn()) {
      // «Учитель» without a plan of this position (an offer that came back after a reload): the advice is planned anew
      holdTeach();
      enterChildTurn({ teach: { after: accepted } });
    } else enterChildTurn();
  }

  function declineTakeback(): void {
    const offer = pendingOffer;
    if (get().phase !== 'coachIntervention' || !offer) return;
    const at = ++epoch;
    pendingOffer = null;
    declined = offer.judgement;
    addEvent('takebackDeclined', { san: offer.judgement.san, uci: offer.judgement.uci }, offer.judgement.ply);
    deps.coach.clearAnnotations?.();
    // «почему?» — three tappable answers next to the board; the game goes on whether the child taps one or not
    declinePunished = false;
    set({ takeback: null, annotations: null, declineReasons: { ply: offer.judgement.ply } });
    if (declineTimer !== null) clearTimeout(declineTimer);
    declineTimer = setTimeout(clearDeclineReasons, timings.declineReasonsMs);
    deps.coach.stopSpeaking({ clearBubble: true });
    void sayEvent((teacherOn() ? teacherTakebackReply('no') : null) ?? buildTakebackDeclined(profile, rng));
    releaseClock('offer');
    track(botTurn(at, 0));
  }

  function clearDeclineReasons(): void {
    if (declineTimer !== null) clearTimeout(declineTimer);
    declineTimer = null;
    if (!disposed && get().declineReasons !== null) set({ declineReasons: null });
  }

  /** The child's own words about the kept move: journaled as `childSaid {source:'choice'}`. */
  function giveDeclineReason(reason: TakebackDeclineReason): void {
    const asked = get().declineReasons;
    if (disposed || !asked || !TAKEBACK_DECLINE_REASONS.includes(reason)) return;
    clearDeclineReasons();
    addEvent('childSaid', { source: 'choice', text: declineReasonLabelRu(reason, profile.address), reason, about: 'takebackDeclined' }, asked.ply);
    // once the move was punished the explanation has been given — a cheerful «посмотрим, что получится» would be tactless
    if (get().phase !== 'gameOver' && !declinePunished) void sayEvent(buildDeclineReasonReply(reason, profile, rng));
  }

  // ───────────────────────── praise / warnings ─────────────────────────

  function foundMotifOf(judgement: MoveJudgement): MotifId | undefined {
    try {
      return detectMotif(judgement.fenBefore, [judgement.uci, ...judgement.refutationPvUci]);
    } catch {
      return undefined;
    }
  }

  function wasOnlyMove(judgement: MoveJudgement): boolean {
    const lines = cache.get(positionKey(judgement.fenBefore))?.result.lines ?? [];
    const [best, second] = lines;
    if (!best || !second || best.pvUci[0] !== judgement.uci) return false;
    const mover = judgement.color;
    return winPct(toMoverPov(best, mover, mover)) - winPct(toMoverPov(second, mover, mover)) >= ONLY_MOVE_WIN_PCT_GAP;
  }

  /**
   * Praise only non-obvious best / excellent moves, at most every ~6 plies (ARCHITECTURE §5). Priority 0 (only a
   * «chatty» coach says it) — or 1 when the child found a REAL tactic (fork, pin, mate…): that is worth saying in the
   * normal talkativeness too (design D).
   */
  function maybePraise(judgement: MoveJudgement, entry: MoveEntry): void {
    if (coachMode() === 'off' || config?.examMode) return;
    if (judgement.classification !== 'best' && judgement.classification !== 'excellent') return;
    if (entry.ply - lastPraisePly < PRAISE_MIN_PLY_GAP) return;
    const moves = get().moves;
    const previous = moves[moves.length - 2];
    const recapture = entry.captured !== undefined && previous?.captured !== undefined && previous.to === entry.to;
    const motif = foundMotifOf(judgement);
    const simpleCapture = motif === 'freeCapture' || motif === 'hangingPiece';
    const onlyMove = !recapture && wasOnlyMove(judgement);
    const nonObvious = entry.san.endsWith('#') || (motif !== undefined && !(recapture && simpleCapture)) || onlyMove;
    if (!nonObvious) return;

    lastPraisePly = entry.ply;
    const event = buildPraise(judgement, profile, rng, motif, { onlyMove });
    if (entry.san.endsWith('#') || isRealTacticMotif(motif)) event.priority = 1;
    void sayEvent(event);
    if (rng() < 0.5) setBotBubble({ kind: 'goodMove', text: pickLine(persona.lines.onGoodMoveByChild) });
  }

  /**
   * After the BOT's move (design D): when the child now has a piece en prise, or the opponent threatens mate /
   * material (the null-move threat of the background analysis), the coach speaks up — priority 1, never in exams or
   * bullet, at most once per 4 plies, not right after a take-back offer, not twice about the same danger. The child
   * first gets `threatWarningDelayMs` to notice it alone; a threat the engine finds later still counts in this turn.
   */
  function scheduleThreatWarning(at: number): void {
    clearThreatTimer();
    threatCheck = null;
    // «Учитель»: the danger is part of the teachTurn — no separate warning (TEACHER-MODE §2.9)
    if (!chess || coachMode() === 'off' || config?.examMode || retryingAfterTakeback || teacherOn()) return;
    const ply = currentPly();
    if (ply - lastThreatWarningPly < THREAT_WARNING_MIN_PLY_GAP) return;
    if (ply - lastOfferPly <= THREAT_AFTER_OFFER_PLIES) return;
    const check = { at, key: positionKey(chess.fen()), ply, fired: false, done: false };
    threatCheck = check;
    threatTimer = setTimeout(() => {
      threatTimer = null;
      check.fired = true;
      tryThreatWarning(check);
    }, timings.threatWarningDelayMs);
  }

  /** The null-move search of `key` finished: a warning that was waiting for it may be said now. */
  function onThreatKnown(key: string): void {
    const check = threatCheck;
    if (check && check.fired && !check.done && check.key === key) tryThreatWarning(check);
  }

  function tryThreatWarning(check: { at: number; key: string; ply: number; done: boolean }): void {
    if (check.done || stale(check.at) || disposed || !chess || threatCheck !== check) return;
    const state = get();
    if (state.phase !== 'childTurn' || state.hintLevel > 0 || state.hintBusy) return;
    const fen = chess.fen();
    if (positionKey(fen) !== check.key) return;
    try {
      const known = threats.get(check.key);
      const threat = known !== undefined ? known : mateInOneThreat(fen);
      const moves = state.moves;
      const last = moves[moves.length - 1];
      const event = buildThreatWarning(
        {
          fen,
          facts: computePositionFacts(fen, state.openingName ?? undefined),
          profile,
          threat,
          lastMove: last && last.by === 'bot' ? { san: last.san, fenBefore: last.fenBefore } : null,
        },
        rng,
      );
      if (!event) return;
      const warningKey = `${event.motif ?? ''}:${(event.board?.highlights ?? []).map((h) => h.square).join(',')}:${threat?.uci ?? ''}`;
      if (warningKey === lastWarningKey) {
        check.done = true; // the same danger as last time: the child has heard it, no nagging
        return;
      }
      check.done = true;
      lastWarningKey = warningKey;
      threatWarnings += 1;
      lastThreatWarningPly = check.ply;
      if (event.board) set({ annotations: event.board });
      void sayEvent(event);
    } catch (error) {
      log('threat warning failed', error);
    }
  }

  // ───────────────────────── the child's long silence ─────────────────────────

  function clearSilenceTimer(): void {
    if (silenceTimer !== null) clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  /**
   * Untimed and 10-minute games only; never in exams (the coach is silent there). `silenceNudgeMs ≤ 0` switches the
   * game's nudge off — the browser wiring does that because the app's coach controller runs its own (gameDeps.ts).
   */
  function silenceNudgesAllowed(): boolean {
    // «Учитель» speaks every move anyway: no nudge in P0 (TEACHER-MODE §2.9)
    return timings.silenceNudgeMs > 0 && (timeControl.id === 'training' || timeControl.id === 'rapid10') && !config?.examMode && coachMode() !== 'off' && !teacherOn();
  }

  /** Somebody is really listening: the coach's own state when it exposes one, else what it reported. */
  function conversationListening(): boolean {
    return LISTENING_STATES.has(deps.coach.conversationState ?? conversationState);
  }

  /**
   * The child moved or spoke: the silence count starts over. After the nudge nothing re-arms it but the child —
   * one gentle nudge per silence, never two within `silenceNudgeRepeatMs`.
   */
  function armSilenceNudge(): void {
    clearSilenceTimer();
    if (disposed || !silenceNudgesAllowed() || get().phase !== 'childTurn') return;
    silenceTimer = setTimeout(fireSilenceNudge, timings.silenceNudgeMs);
  }

  function fireSilenceNudge(): void {
    silenceTimer = null;
    if (disposed || !silenceNudgesAllowed() || get().phase !== 'childTurn' || !conversationListening()) return;
    const wait = lastNudgeAt + timings.silenceNudgeRepeatMs - now();
    if (wait > 0) {
      silenceTimer = setTimeout(fireSilenceNudge, wait);
      return;
    }
    lastNudgeAt = now();
    void sayEvent(buildSilenceNudge(profile, rng));
  }

  // ───────────────────────── turns ─────────────────────────

  /**
   * `teach` («Учитель»): plan and say the teachTurn of this position — `t0` = when the bot's move appeared, `after` = a
   * phrase to finish first (the game start: T0 is the end of the greeting, TEACHER-MODE §2.1).
   */
  function enterChildTurn(opts: { afterBotMove?: boolean; teach?: { t0?: number; after?: Promise<void> | null } } = {}): void {
    if (!chess || disposed || get().phase === 'gameOver') return;
    const at = ++epoch;
    set({ phase: 'childTurn', hintLevel: 0, hintBusy: false, canUndo: undoAllowed() });
    startBackground(chess.fen());
    if (opts.afterBotMove) scheduleThreatWarning(at);
    else {
      clearThreatTimer();
      threatCheck = null;
    }
    if (opts.teach && teacherOn()) startTeachTurn(at, opts.teach);
    // «Поторопись!» once a game when the child is nearly out of time (in «Учитель» the lesson's own words)
    maybeHurry();
    armSilenceNudge();
  }

  /** «Вернуть ход»: untimed, non-exam games; only the LAST own move, once (a slip of the hand, not a time machine). */
  function undoAllowed(): boolean {
    if (!config || config.examMode || timeControl.initialMs !== null) return false;
    const moves = get().moves;
    const lastChild = moves.findLast((move) => move.by === 'child');
    return lastChild !== undefined && undoUsedAtPly !== lastChild.ply && undoUsedAtPly !== moves.length + 1;
  }

  /**
   * Did the bot's reply punish the move the child insisted on? Not only the engine's exact line counts: another
   * piece taking the same victim, or any capture of a piece after a warning about lost material, is the very
   * thing the coach warned about (e.g. fxg6 was predicted, hxg6 was played).
   */
  function punishes(ignored: MoveJudgement, reply: MoveEntry): boolean {
    const predicted = ignored.refutationPvUci[0];
    if (predicted === reply.uci) return true;
    if (reply.captured === undefined) return false;
    if (predicted !== undefined && predicted.slice(2, 4) === reply.to) return true;
    return ignored.materialLossPawns >= 2 && (PIECE_PAWNS[reply.captured] ?? 0) >= PUNISH_MIN_CAPTURE_PAWNS;
  }

  /** The judgement with the refutation that was really played (the red arrow must show what happened on the board). */
  function asPlayed(ignored: MoveJudgement, reply: MoveEntry): MoveJudgement {
    if (ignored.refutationPvUci[0] === reply.uci) return ignored;
    const sameVictim = ignored.refutationPvUci[0]?.slice(2, 4) === reply.to;
    const patched: MoveJudgement = { ...ignored, refutationPvUci: [reply.uci], refutationPvSan: [reply.san] };
    if (!sameVictim) delete patched.allowedMotif; // the named tactic belonged to the other line
    return patched;
  }

  /**
   * One sentence about the IDEA of the opening, once per game — at any stage and in 5-minute games too (the child knows
   * how the pieces move; a helper that only waits for the button is too passive).
   */
  function maybeOpeningIdea(): void {
    // «Учитель» tells the opening plan itself (TEACHER-MODE §3)
    if (openingIdeaSaid || coachMode() === 'off' || config?.examMode || teacherOn()) return;
    const moves = get().moves;
    if (moves.length < 4 || moves.length > OPENING_IDEA_MAX_PLY) return;
    try {
      const advice = getRepertoireAdvice(moves.map((move) => move.san), childColor());
      if (!advice) return;
      // still inside a line that may branch: wait until it is clear which plan this is
      if (advice.inBook && advice.matchedPlies < OPENING_IDEA_READY_PLIES) return;
      openingIdeaSaid = true;
      void sayEvent(buildOpeningIdea({ title: advice.lineTitle, idea: advice.idea, warning: advice.warning, profile }, rng));
    } catch (error) {
      log('opening idea failed', error);
    }
  }

  async function botTurn(at: number, alreadyWaitedMs: number): Promise<void> {
    if (stale(at) || !chess || !clock || !config) return;
    set({ phase: 'botThinking' });
    const bot = botColor();
    const fen = chess.fen();
    const askedAt = now();
    let uci: string | null = null;
    let thinkMs = timings.minBotDelayMs;
    try {
      const picked = await withTimeout(
        deps.bot.pickMove(fen, config.personaId, { moveNumber: chess.moveNumber(), remainingMs: clock.remaining(bot) }),
        timings.botTimeoutMs,
        'bot.pickMove',
      );
      uci = picked.uci;
      thinkMs = picked.thinkMs;
    } catch (error) {
      log('the bot engine failed — playing a random legal move', error);
      // never silently: a «grandmaster» who plays at random must be explained on screen
      if (!disposed && !get().botUnavailable) set({ botUnavailable: true });
    }
    if (stale(at)) return;
    // «Учитель»: the bot's move is known and the judge is free during its human pause — the analysis of the position
    // AFTER that move starts now, so the advice is ready soon after the move appears (TEACHER-MODE §2.1 «прогрев»)
    const prewarmKey = teacherOn() && uci !== null ? prewarm(fen, uci) : null;
    // …and so does the smart strategist: Black's strategy answers this REAL first move; later moves may need a re-plan
    // (never a guess of the bot's move — this is the move it will play, the pause is only for show)
    if (teacherOn() && uci !== null) onBotMoveDecided(fen, uci);

    // human-like pause: thinkMs already contains the search; the time spent judging counts as waiting too
    const pause = Math.max(thinkMs, timings.minBotDelayMs) - (now() - askedAt) - alreadyWaitedMs;
    if (pause > 0) await sleep(pause);
    if (stale(at)) {
      abandonPrewarm(prewarmKey);
      return;
    }
    // the bot does not move while the coach holds the clock (an explanation is being spoken)
    await clock.whenRunning();
    if (stale(at)) {
      abandonPrewarm(prewarmKey);
      return;
    }

    const legal = chess.moves({ verbose: true });
    if (legal.length === 0) {
      finishIfOver(childColor());
      return;
    }
    const chosen = legal.find((move) => uciOf(move) === uci) ?? legal[Math.min(legal.length - 1, Math.floor(rng() * legal.length))];
    if (!chosen) return;
    if (uci !== null && uciOf(chosen) !== uci) log(`bot move ${uci} is not legal here — replaced by ${uciOf(chosen)}`);

    const entry = playMove('bot', { from: chosen.from, to: chosen.to, promotion: chosen.promotion });
    if (!entry) return;
    if (prewarmKey !== null && positionKey(entry.fenAfter) !== prewarmKey) abandonPrewarm(prewarmKey);
    if (finishIfOver(bot)) return;
    // T0 of the teacher (§2.1): timed games — the child's clock stands from now until the end of the teacher's words (§2.2)
    const teaching = teacherOn();
    const t0 = now();
    if (teaching) holdTeach();
    // Black: a first move that was not the decided one (engine failure → random move) gets its own strategy request
    if (teaching && entry.ply === 1) requestStrategy(strategyRequestFor(entry.uci));

    if (deps.coach.pushContext) {
      const exam = config.examMode || coachMode() === 'off';
      let facts = null;
      try {
        facts = exam ? null : computePositionFacts(entry.fenAfter, get().openingName ?? undefined);
      } catch (error) {
        log('position facts for the context note failed', error);
      }
      const note = botMoveNoteRu({ san: entry.san, fenBefore: entry.fenBefore, childColor: childColor(), facts });
      // «Учитель»: the teachTurn brief says all of it — the note goes out only if no teachTurn does (§2.9, STATUS §6)
      if (teaching) deferredBotNote = note;
      else pushContext(note);
    }

    const ignored = declined;
    declined = null;
    if (ignored && punishes(ignored, entry)) {
      // the declined warning came true: one gentle explanation, no «I told you so» (and no cheerful reason reply)
      declinePunished = true;
      // «Учитель»: the lesson's take-back reply and its next turn carry the lesson — the helper's «Сильнее было так» is no
      // lesson wording (§2.8: never at stages 1–2) and its arrows belong to the position before the child's move; nor a
      // separate thinking routine (the teacher's next turn is the reminder, §2.9)
      if (!teaching) {
        void sayEvent(buildExplainBest(asPlayed(ignored, entry), profile, rng));
        if (!routineAfterPunishSaid) {
          routineAfterPunishSaid = true;
          void sayEvent(buildThinkingRoutine(profile, rng));
        }
      }
    } else {
      maybeOpeningIdea();
    }
    // «Учитель», Black: the theme of the game comes after the bot's REAL first move (its card answers that move)
    enterChildTurn(teaching ? { afterBotMove: true, teach: { t0, after: firstTeachSaid ? null : lessonStart() } } : { afterBotMove: true });
  }

  // ───────────────────────── «Учитель» (docs/TEACHER-MODE.md §2) ─────────────────────────
  //
  //   bot.pickMove resolved ─► prewarm: MultiPV-3 of the position after its move, during the bot's pause
  //   the move appears (T0) ─► timed games (10 and 5 minutes): hold('teach') on the child's clock
  //     ├─ 1) the analysis until depth ≥ teachMinDepth (or teachAnalysisMs; < teachFallbackDepth waits up to
  //     │     backgroundMovetimeMs) — then stopped, its lines stay cached
  //     ├─ 2) the null-move threat   3) ≤ 2 searchmoves checks of book moves (opening only, inside the deadline)
  //     ├─ ≤ T0 + teachDeadlineMs: planTeachTurn → buildTeachTurn → coach.say; the arrows stay until the child moves
  //     └─ 4) the background analysis goes on (depth 16) — the cache for judging the child's next move
  //   the words end (or teachHoldMaxMs) ─► the hold ends; a child's move before that cuts the remark (stopSpeaking)

  const TEACH_POLL_MS = 40;
  const MAX_TEACH_PLANS = 8;
  let teachGen = 0;

  function holdTeach(): void {
    if (!teacherOn() || !clock || !clock.timed || get().phase === 'gameOver') return;
    holdClock('teach');
    if (teachHoldTimer !== null) clearTimeout(teachHoldTimer);
    // never longer than this per utterance: a voice that never reports «done» must not freeze the child's clock
    teachHoldTimer = setTimeout(() => {
      teachHoldTimer = null;
      releaseClock('teach');
    }, timings.teachHoldMaxMs);
  }

  function releaseTeachHold(): void {
    if (teachHoldTimer !== null) clearTimeout(teachHoldTimer);
    teachHoldTimer = null;
    releaseClock('teach');
  }

  /** The hold ends when no teacher utterance is being prepared or said. */
  function maybeReleaseTeach(): void {
    if (teachSpeaking === 0 && !(teachRun?.preparing ?? false)) releaseTeachHold();
  }

  /**
   * The child moved (or the game went back / ended): the teacher's utterances of the old position are over, and so are
   * the timers of its lesson moment. Returns true when one was still queued or being said — the caller cuts it with
   * `coach.stopSpeaking()` (§2.1).
   */
  function endTeachUtterances(): boolean {
    const cut = teachSpeaking > 0;
    teachGen += 1;
    teachSpeaking = 0;
    teachRun = null;
    clearLessonTimers();
    releaseTeachHold();
    return cut;
  }

  // ───────────────────────── «Учитель»: the lesson on the board (docs/TEACHING.md §4.6) ─────────────────────────

  /** The lesson memory from a director function: the next memory of this game (the snapshot follows). */
  function commitLessonMemory(memory: TeachMemory): void {
    teachMemory = memory;
    schedulePersist();
    // (the lesson may just have named the opening: the «Тема: …» badge follows it)
    syncThemeBadge();
  }

  /** A lesson time from core scaled by the game's timings (`treasureRevealMs / 10 000`: tests shorten them). */
  function lessonMs(ms: number): number {
    return Math.max(0, Math.round((ms * timings.treasureRevealMs) / 10_000));
  }

  /** `fn` after `ms`, unless the lesson moment ends first (a move, a take-back, a new turn, the end). */
  function lessonAfter(ms: number, fn: () => void): void {
    const gen = lessonGen;
    const entry = {
      cancel: () => clearTimeout(timer),
    };
    const timer = setTimeout(() => {
      lessonTimers.delete(entry);
      if (gen !== lessonGen || disposed) return;
      try {
        fn();
      } catch (error) {
        log('a lesson timer failed', error);
      }
    }, ms);
    lessonTimers.add(entry);
  }

  function clearLessonTimers(): void {
    lessonGen += 1;
    const timers = [...lessonTimers];
    lessonTimers.clear();
    for (const timer of timers) timer.cancel();
  }

  function suppressAsk(suppressed: boolean): void {
    if (askSuppressed === suppressed) return;
    askSuppressed = suppressed;
    try {
      deps.coach.setAskSuppressed?.(suppressed);
    } catch (error) {
      log('coach.setAskSuppressed failed', error);
    }
  }

  function showPose(pose: MascotPose, ms: number): void {
    try {
      deps.coach.showPose?.(pose, ms);
    } catch (error) {
      log('coach.showPose failed', error);
    }
  }

  /** The advice of a plan as the lesson shows it: the primary move, a green arrow (no blue alternative). */
  function lessonAdviceOf(plan: TeachPlan | null | undefined): TeachAdvice[] {
    const primary = plan?.advice[0];
    return primary ? [{ uci: primary.uci, san: primary.san, source: primary.source, arrow: 'green' }] : [];
  }

  function adviceArrows(advice: readonly TeachAdvice[]): BoardAnnotations | null {
    return boardOrNull({ arrows: advice.map((a) => ({ from: a.uci.slice(0, 2) as Square, to: a.uci.slice(2, 4) as Square, color: a.arrow })), highlights: [] });
  }

  /**
   * One child turn on the screen (the director's `LessonTurnResult`): the board at once — without the advice arrow
   * while it waits for the end of its sentence, or while it is hidden (quiz, «Сам», a treasure, stage-5 «позже») —, the
   * words (none on a quiet turn: a short nod), the quiz card, and the timers of the moment: the arrow after its
   * sentence, a hidden advice's reveal (a quiz: its time-out), the treasure's hints.
   */
  function showLesson(plan: TeachPlan, result: LessonTurnResult, at: number): void {
    clearLessonTimers();
    closeQuiz();
    const ply = plan.ply;
    // a new plan of this ply (another line after a take-back, a continued game): nothing of it was seen or answered yet
    arrowShown.delete(ply);
    quizAnswered.delete(ply);
    const hidden = result.adviceHidden;
    const event = result.event && result.event.text.trim() !== '' ? result.event : null;
    const waiting = !hidden && event !== null && result.advice.length > 0 ? endCuesOf(event) : [];
    const pending = waiting.length > 0;
    const boardNow = pending ? withoutEndCues(result.board, result.advice, waiting) : boardOrNull(result.board);
    const revealMs = result.revealAfterMs !== null ? lessonMs(result.revealAfterMs) : null;
    set({
      annotations: boardNow,
      advice: !hidden && result.advice.length > 0 ? result.advice : null,
      treasure: result.moment === 'treasure' && revealMs !== null ? { ply, revealAt: now() + revealMs } : null,
    });
    if (!hidden && !pending && result.advice.length > 0) arrowShown.add(ply);
    if (result.quiz) openQuiz(result.quiz);
    let spoken: Promise<void> | null = null;
    // what the game gave the coach before this turn's words (a reaction still in the bubble): they come up after it
    const ahead = speechTail;
    if (event) {
      // the coach shows the event's own board while it speaks: never the arrow that waits for the end of the sentence
      const said = pending ? { ...event, board: withoutEndCues(event.board, result.advice, waiting) ?? { arrows: [], highlights: [] } } : event;
      spoken = sayTeach(said);
    } else {
      // a quiet turn (§2.2): no bubble — a short nod, the arrow is on the board already
      showPose('talk', 900);
    }
    if (pending && event) arrowAfterSentence(ply, result.board, spoken ?? Promise.resolve(), wordCount(event.text), ahead);
    if (hidden) {
      const gen = lessonGen;
      // the reveal and the hints count from the end of the words (the child hears the question first)
      void (spoken ?? Promise.resolve()).then(() => {
        if (gen !== lessonGen || disposed || stale(at)) return;
        // a hint is part of the hidden advice: once it is on the board (revealed, «Совет», «Повтори», an answer) the
        // hints stop — showRevealed() cancels their timers, and one that fires anyway adds nothing
        for (const hint of result.hints) {
          lessonAfter(lessonMs(hint.atMs), () => {
            if (!arrowShown.has(ply)) set({ annotations: mergeBoards(get().annotations, hint.board) });
          });
        }
        if (revealMs === null) return;
        if (result.moment === 'treasure') set({ treasure: { ply, revealAt: now() + revealMs } });
        lessonAfter(revealMs, () => revealNow(plan));
      });
    }
  }

  /** The coach plays the phrase being said aloud (§4.6); a coach that cannot tell: yes — the end of its `say()` decides. */
  function coachSpeaksAloud(): boolean {
    if (!deps.coach.speaksAloud) return true;
    try {
      return deps.coach.speaksAloud();
    } catch (error) {
      log('coach.speaksAloud failed', error);
      return true;
    }
  }

  /**
   * The green arrow of a calm advice after the sentence that carries it (§2.2 `at: 'end'`, §4.6). Its reading time
   * max(adviceArrowMinMs, adviceArrowPerWordMs × words) ≤ adviceArrowMaxMs counts from the moment its words come up
   * (`ahead`: the phrases given before it are over). Then:
   *   - nothing is heard (`coach.speaksAloud()` false: the silent layer, muted, «не озвучено», a click still needed) →
   *     the arrow at the reading time: the bubble is all the child gets (never the silent layer's end, up to 9 s);
   *   - said aloud → when the coach says the words are over (its `say()` resolves); asked again every
   *     ADVICE_ARROW_RECHECK_MS meanwhile (the sound switched off, a phrase found unrecorded late).
   * Never later than adviceArrowWaitMaxMs after the words were given (a voice that never says «done», a stuck queue).
   */
  function arrowAfterSentence(ply: number, board: BoardAnnotations, spoken: Promise<void>, words: number, ahead: Promise<void>): void {
    const gen = lessonGen;
    const readMs = Math.min(timings.adviceArrowMaxMs, Math.max(timings.adviceArrowMinMs, timings.adviceArrowPerWordMs * words));
    let read = false;
    let heard = false;
    let done = false;
    let finish: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, fn: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };
    const end = (): void => {
      done = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      lessonTimers.delete(entry);
      finish();
    };
    const entry = { cancel: end };
    const show = (): void => {
      if (done || !read || !heard) return;
      const onBoard = gen === lessonGen && !disposed && get().phase === 'childTurn' && currentPly() + 1 === ply;
      end();
      if (onBoard) {
        arrowShown.add(ply);
        set({ annotations: mergeBoards(get().annotations, board) });
      }
    };
    const listen = (): void => {
      if (done) return;
      if (!coachSpeaksAloud()) {
        heard = true;
        show();
        return;
      }
      later(ADVICE_ARROW_RECHECK_MS, listen);
    };
    lessonTimers.add(entry);
    void ahead.then(() => {
      if (done) return;
      later(readMs, () => {
        read = true;
        show();
        listen();
      });
    });
    later(Math.max(readMs, timings.adviceArrowWaitMaxMs), () => {
      read = true;
      heard = true;
      show();
    });
    void spoken.then(() => {
      heard = true;
      show();
    });
    track(settled);
  }

  /** A hidden advice's time is up: a quiz still open is answered «nobody answered» (§2.4), anything else revealed. */
  function revealNow(plan: TeachPlan): void {
    if (disposed || get().phase !== 'childTurn' || currentPly() + 1 !== plan.ply || arrowShown.has(plan.ply)) return;
    const quiz = get().quiz;
    try {
      if (quiz && quiz.ply === plan.ply && quiz.answeredId === null) {
        const out = lessonAnswer(plan, teachMemory, null, book);
        commitLessonMemory(out.memory);
        closeQuiz();
        showRevealed(plan, out.board, out.event, answerShowsAdvice(out));
        return;
      }
      const out = lessonReveal(plan, teachMemory, book);
      commitLessonMemory(out.memory);
      showRevealed(plan, out.board, out.event);
    } catch (error) {
      log('the advice could not be revealed', error);
    }
  }

  /** The advice is on the board now (a reveal, «Совет», «Повтори», an answer): its arrows, the words. */
  function showRevealed(plan: TeachPlan, board: BoardAnnotations, event: CoachEvent | null, adviceOk = true): Promise<void> {
    clearLessonTimers();
    if (!adviceOk) {
      // a quiz answer whose words could not carry the advice: its truth is on the board, the arrow waits for «Совет»
      // (never an arrow nobody talked about, docs/TEACHING.md §2.2)
      set({ annotations: boardOrNull(board), treasure: null });
      return event && event.text.trim() !== '' ? sayTeach(event) : Promise.resolve();
    }
    const advice = lessonAdviceOf(plan);
    arrowShown.add(plan.ply);
    set({ annotations: boardOrNull(board) ?? adviceArrows(advice), advice: advice.length > 0 ? advice : null, treasure: null });
    // (a gift's own mini-lesson comes with its reveal: its card is remembered like a turn's)
    rememberConcept(event?.teach?.conceptId);
    return event && event.text.trim() !== '' ? sayTeach(event) : Promise.resolve();
  }

  /** Did the quiz answer's words carry the advice (then its arrow may show)? `stopHints: false` / no advice = no. */
  function answerShowsAdvice(out: { event: CoachEvent; stopHints?: boolean }): boolean {
    return out.stopHints !== false && (out.event.teach?.advice?.length ?? 0) > 0;
  }

  // ───────────────────────── the quiz card (§2.4) ─────────────────────────

  function openQuiz(quiz: LessonQuiz): void {
    if (quiz.options.length !== 3) return;
    set({ quiz: { ...quiz, answeredId: null, streak: quizStreak } });
    // both clocks stand while the question is open — never longer than quizHoldMaxMs (the 'modal' hold has no safety)
    holdClock('quiz');
    if (quizHoldTimer !== null) clearTimeout(quizHoldTimer);
    quizHoldTimer = setTimeout(() => {
      quizHoldTimer = null;
      releaseClock('quiz');
    }, timings.quizHoldMaxMs);
    suppressAsk(true);
  }

  /** The card goes away (answered and shown, skipped, a move, the end): the clock runs, «Спроси» comes back. */
  function closeQuiz(): void {
    if (quizHoldTimer !== null) clearTimeout(quizHoldTimer);
    quizHoldTimer = null;
    if (quizCloseTimer !== null) clearTimeout(quizCloseTimer);
    quizCloseTimer = null;
    releaseClock('quiz');
    if (get().quiz !== null) set({ quiz: null });
    suppressAsk(false);
  }

  function answerQuiz(optionId: string): void {
    const quiz = get().quiz;
    if (disposed || !quiz || quiz.answeredId !== null || !chess) return;
    // a card of another position (the child moved, a take-back) is dropped
    if (get().phase !== 'childTurn' || quiz.ply !== currentPly() + 1) {
      closeQuiz();
      return;
    }
    const option = quiz.options.find((o) => o.id === optionId);
    if (!option) return;
    const plan = planAt(quiz.ply, chess.fen());
    if (!plan) {
      closeQuiz();
      return;
    }
    deps.coach.noteActivity?.();
    let out: ReturnType<typeof lessonAnswer>;
    try {
      out = lessonAnswer(plan, teachMemory, optionId, book);
    } catch (error) {
      log('the quiz answer failed', error);
      closeQuiz();
      return;
    }
    commitLessonMemory(out.memory);
    const correct = out.correct ?? optionId === quiz.correctId;
    quizAnswered.add(quiz.ply);
    quizStreak = correct ? quizStreak + 1 : 0;
    addEvent('childSaid', { source: 'choice', about: 'quiz', quizId: quiz.id, optionId, correct, question: quiz.question, text: option.label }, quiz.ply);
    // the answer ends the question: the clock runs again (the explanation holds it as any teacher phrase does)
    if (quizHoldTimer !== null) clearTimeout(quizHoldTimer);
    quizHoldTimer = null;
    releaseClock('quiz');
    set({ quiz: { ...quiz, answeredId: optionId, streak: quizStreak } });
    void showRevealed(plan, out.board, out.event, answerShowsAdvice(out));
    // the card stays a moment with the right answer marked, then goes
    if (quizCloseTimer !== null) clearTimeout(quizCloseTimer);
    quizCloseTimer = setTimeout(() => {
      quizCloseTimer = null;
      if (get().quiz?.id === quiz.id) closeQuiz();
    }, timings.quizCloseMs);
  }

  /** A teacher utterance: journaled with its `teach` summary; timed games — the child's clock stands until it is said. */
  function sayTeach(event: CoachEvent): Promise<void> {
    const gen = teachGen;
    teachSpeaking += 1;
    holdTeach();
    return sayEvent(event, 'coachSaid', { holdClock: false }).finally(() => {
      if (gen !== teachGen) return;
      teachSpeaking = Math.max(0, teachSpeaking - 1);
      maybeReleaseTeach();
    });
  }

  /** The plan made for the position the child faces at `ply` (null when that position was planned differently). */
  function planAt(ply: number, fen: string): TeachPlan | null {
    const plan = teachPlans.get(ply);
    return plan && positionKey(plan.fen) === positionKey(fen) ? plan : null;
  }

  function commitTeachPlan(plan: TeachPlan): void {
    teachPlans.set(plan.ply, plan);
    while (teachPlans.size > MAX_TEACH_PLANS) {
      const oldest = teachPlans.keys().next().value;
      if (oldest === undefined) break;
      teachPlans.delete(oldest);
    }
    teachMemory = plan.memory;
    schedulePersist();
    syncThemeBadge();
  }

  /** The advice the child could SEE for the move of `ply` (an arrow still hidden or not drawn yet was not seen). */
  function shownAdviceOf(ply: number): TeachAdvice[] {
    const plan = teachPlans.get(ply);
    if (!plan || !arrowShown.has(ply)) return [];
    return lessonAdviceOf(plan);
  }

  /** The advice with the engine scores (child's point of view) for comparisons (§7.1); nothing while it is hidden. */
  function scoredAdvice(plan: TeachPlan | null): ScoredAdvice[] {
    if (!plan || !arrowShown.has(plan.ply)) return [];
    const primary = plan.advice[0];
    return primary ? [{ uci: primary.uci, san: primary.san, source: primary.source, arrow: 'green', scoreCp: primary.scoreCp }] : [];
  }

  /** Journal (§7.5): the child's move with the advice it had — `advice` (SAN, green first) and `followed`. */
  function journalAdvice(entry: MoveEntry, shown: readonly TeachAdvice[]): void {
    if (shown.length === 0) return;
    const event = moveEvents[moveEvents.length - 1];
    if (!event || event.ply !== entry.ply) return;
    const index = shown.findIndex((a) => a.uci === entry.uci);
    event.data.advice = shown.map((a) => a.san);
    event.data.followed = index === 0 ? 'primary' : index > 0 ? 'alternative' : 'own';
  }

  /**
   * The concept cards this child has heard (§5.2). The profile's list comes from the games that COUNT (P1: the server
   * derives it from their journals), so a game the parent marks «играл взрослый» — an adult may play 5-minute games with
   * «Учитель» too — gives its cards back; the games parked offline and this game (its journal and the cards planned
   * so far) are added. Only a profile without the list (an older server) falls back to this browser's own list.
   */
  function readConcepts(): string[] {
    // (the profile may be the shell's cached copy: only a real list counts)
    const counted = Array.isArray(profile.conceptsIntroduced) ? profile.conceptsIntroduced.filter((id) => typeof id === 'string') : null;
    if (!counted) return readLocalConcepts();
    return [...new Set([...counted, ...parkedConcepts, ...conceptIdsOf(events), ...conceptsThisGame])];
  }

  function readLocalConcepts(): string[] {
    try {
      const raw = deps.storage?.getItem(TEACHER_CONCEPTS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(-TEACHER_CONCEPTS_MAX) : [];
    } catch {
      return [];
    }
  }

  /** A card explained in a teachTurn is not explained again to this child (§5.2; the local list is the fallback). */
  function rememberConcept(id: string | undefined): void {
    if (!id) return;
    conceptsThisGame.add(id);
    if (!deps.storage) return;
    const known = readLocalConcepts();
    if (known.includes(id)) return;
    try {
      deps.storage.setItem(TEACHER_CONCEPTS_KEY, JSON.stringify([...known, id].slice(-TEACHER_CONCEPTS_MAX)));
    } catch {
      // a full storage only means the card may be explained once more
    }
  }

  /** Starts the analysis of the position after the bot's (known) move; returns its key, or null. */
  function prewarm(fenBefore: string, uci: string): string | null {
    try {
      const scratch = new Chess(fenBefore);
      scratch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
      if (scratch.isGameOver()) return null;
      const fenAfter = scratch.fen();
      startBackground(fenAfter);
      return positionKey(fenAfter);
    } catch {
      return null;
    }
  }

  /** The bot's move was not played (the game moved on, another move came): a prewarm of its position stops. */
  function abandonPrewarm(key: string | null): void {
    if (key === null) return;
    const search = background;
    if (search && search.key === key && !search.settled) void stopBackground();
  }

  // ───────────────────────── the smart strategist (strategy of the game, re-plans) ─────────────────────────
  //
  //   wizard (colour tap, White) ─► POST /coach/strategy prefetched while the board opens
  //   Black: bot.pickMove resolved (its REAL first move, before the human pause) ─► POST /coach/strategy
  //   the first teacher line waits ≤ strategyWaitMs for it (its intro is that line); a late strategy counts from the next move
  //   every later bot move, the moment it is decided ─► the prewarmed analysis (≤ replanWaitMs) ─► left the line / new
  //     phase / every replanEveryPlies in the middlegame? ─► POST /coach/replan with the engine's candidates
  //   the answer (checked: same ply, a candidate or nothing) is stored by ply and reaches the teacher from the next
  //   TeachContext on; an answer to an older request, or to a position no longer on the board's line, is dropped.
  //   No teacher line ever waits for a re-plan (teachDeadlineMs stays).

  /** Resolves null on abort: a shared (prefetched) promise must not keep a disposed game busy. */
  function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise<T | null>((resolve, reject) => {
      const onAbort = (): void => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  function strategyRequestFor(opponentFirstUci?: string): StrategyRequest {
    const cfg = config;
    const request: StrategyRequest = {
      childColor: childColor(),
      stage: profile.stage,
      personaId: cfg?.personaId ?? persona.id,
      timeControlId: cfg?.timeControlId ?? timeControl.id,
    };
    if (opponentFirstUci !== undefined) request.opponentFirstUci = opponentFirstUci;
    return request;
  }

  /** Asks the strategist once per game (a changed request — Black's replaced first move — asks again). Never throws. */
  function requestStrategy(request: StrategyRequest): void {
    const strategist = deps.strategist;
    if (!strategist || strategy !== null || disposed) return;
    const key = strategyRequestKey(request);
    if (strategyAsk && strategyAsk.key === key) return;
    strategyAsk?.controller.abort();
    const controller = new AbortController();
    let pending: Promise<GameStrategy | null>;
    try {
      pending = strategist.strategy(request, { signal: controller.signal });
    } catch (error) {
      pending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const promise = untilAborted(pending, controller.signal).then(
      (answer) => (controller.signal.aborted ? null : sanitizeStrategy(answer)),
      (error: unknown) => {
        if (!controller.signal.aborted) log('no strategy for this game — the teacher goes on without one', error);
        return null;
      },
    );
    const ask = { key, startedAt: now(), promise, controller };
    strategyAsk = ask;
    track(promise.then((answer) => onStrategyAnswer(ask, answer)));
  }

  function onStrategyAnswer(ask: NonNullable<typeof strategyAsk>, answer: GameStrategy | null): void {
    if (disposed || strategyAsk !== ask || strategy !== null || ask.controller.signal.aborted) return;
    const latencyMs = Math.max(0, Math.round(now() - ask.startedAt));
    if (!answer) {
      addEvent('coachSaid', { kind: 'strategy', failed: true, latencyMs }, currentPly());
      return;
    }
    adoptStrategy(answer, { latencyMs, late: firstTeachSaid });
  }

  /** The strategy of this game from now on: state, config (→ snapshot), the journal, a silent note for the voice model. */
  function adoptStrategy(chosen: GameStrategy, journal: { latencyMs: number; late: boolean } | null): void {
    strategy = chosen;
    strategyCard = safeCall(() => deps.strategist?.card?.(chosen.strategyId) ?? null, null);
    if (config) config = { ...config, strategy: chosen };
    set({ config, strategy: chosen, themeBadge: themeBadgeNow() });
    if (journal) {
      lineStatus = strategyCard ? 'on' : 'unknown';
      planPhase = 'opening';
      addEvent(
        'coachSaid',
        {
          kind: 'strategy',
          strategyId: chosen.strategyId,
          titleRu: chosen.titleRu,
          ideaRu: chosen.ideaRu,
          provider: chosen.provider,
          // the model and the bill of the strategist (the journal's «ИИ в этой партии»: через подписку / платно)
          ...(chosen.model ? { model: chosen.model } : {}),
          ...(chosen.billing ? { billing: chosen.billing } : {}),
          latencyMs: journal.latencyMs,
          late: journal.late,
        },
        currentPly(),
      );
      // (no silent note about it: the intro brief says the strategy aloud, and every voice question about the
      // position gets it with the facts — after a silent note «Стратегия этой партии: …» a live model may say
      // «Служебная заметка, запомнил стратегию» and open later lines with «Служебная заметка получена»)
    }
  }

  /**
   * The FIRST teacher line of the game waits for the strategy (its intro is that line) — at most `strategyWaitMs` after
   * the request; null = nothing to wait for. Every later line keeps the 1.5 s deadline.
   */
  function firstLineWait(): Promise<void> | null {
    const ask = strategyAsk;
    if (firstTeachSaid || strategy !== null || !ask) return null;
    const left = ask.startedAt + timings.strategyWaitMs - now();
    if (left <= 0) return null;
    return Promise.race([ask.promise.then(() => undefined), sleep(left)]);
  }

  /** The strategy as the teacher reads it: the server's `GameStrategy` over its library card (the line, the main line). */
  function teachStrategyOf(): (GameStrategy & Partial<Omit<StrategyCardOf, 'id' | 'titleRu' | 'ideaRu'>>) | null {
    if (!strategy) return null;
    const card = strategyCard && strategyCard.id === strategy.strategyId ? strategyCard : null;
    if (!card) return { ...strategy };
    const { id: _id, titleRu: _title, ideaRu: _idea, ...rest } = card;
    return { ...rest, ...strategy };
  }

  /**
   * The «Тема: …» badge (a UI label, never spoken): stages 1–2 the family of the card; stages 3–5 the card's name only
   * as the lesson gives it (docs/TEACHING.md §2.1) — once the lesson has said it (`lesson.theme.named`: London / Colle
   * from move 1, any other card after the opponent's reply matched its line) and while the game has not left that line
   * since (a take-back onto the line brings it back); the family label otherwise.
   */
  function themeBadgeNow(): string | null {
    const chosen = strategy;
    if (!chosen) return null;
    const named =
      profile.stage >= 3 &&
      teachMemory.lesson?.theme.named === true &&
      safeCall(() => strategyProgress(teachStrategyOf(), get().moves.map((m) => m.san), childColor())?.left == null, false);
    return safeCall(() => themeBadgeRu(chosen, profile.stage, strategyCard?.themes ?? [], named), null);
  }

  /** The badge after the lesson memory or the line of the game changed (a move, a take-back, a lesson turn). */
  function syncThemeBadge(): void {
    if (strategy === null) return;
    const badge = themeBadgeNow();
    if (get().themeBadge !== badge) set({ themeBadge: badge });
  }

  /**
   * «Учитель» (docs/TEACHING.md §2.1): the theme of the game — ONE sentence without a move (the family's idea, at
   * stages 3–5 the card's name when the game still fits it), and in one of two games the recall of the last takeaway.
   * It waits for the strategy (template card + theme history, at most `strategyWaitMs` after it was asked); without one
   * — or once the child has moved on — nothing is said here and the first advice is the first line. Resolves when the
   * words have been said (T0 of the first advice).
   */
  function lessonStart(): Promise<void> {
    const ply = currentPly();
    // only before the child's FIRST move (White: ply 1, Black: ply 2) — later a strategy is used, not announced
    if (ply + 1 !== (childColor() === 'w' ? 1 : 2)) return Promise.resolve();
    const job = (async (): Promise<void> => {
      const wait = firstLineWait();
      if (wait) await wait;
      if (disposed || !chess || !config || !teacherOn() || themeSaid || firstTeachSaid) return;
      if (currentPly() !== ply || chess.turn() !== childColor() || get().phase === 'gameOver') return;
      let out: ReturnType<typeof lessonGameStart>;
      try {
        out = lessonGameStart(
          {
            profile,
            childColor: childColor(),
            tc: timeControl.id,
            coachStyle,
            strategy: teachStrategyOf(),
            strategyCard,
            historySan: get().moves.map((m) => m.san),
            fen: chess.fen(),
          },
          teachMemory,
          book,
        );
      } catch (error) {
        log('the theme of the game could not be built', error);
        return;
      }
      commitLessonMemory(out.memory);
      const words = out.events.filter((e) => e.text.trim() !== '');
      if (words.length === 0) return;
      themeSaid = true;
      // the game's first line waves; right after the game's own «Привет!» (which waved) it simply talks
      const said = words.map((event, i) => (i === 0 ? { ...event, pose: gameHelloWaved ? ('talk' as const) : ('wave' as const) } : event));
      await Promise.all(said.map((event) => sayTeach(event)));
    })();
    return job.catch((error: unknown) => log('the theme of the game failed', error));
  }

  /** At the moment the bot's move is decided (before its human pause): Black's strategy request, or a re-plan check. */
  function onBotMoveDecided(fenBefore: string, uci: string): void {
    if (!deps.strategist) return;
    if (currentPly() === 0) {
      requestStrategy(strategyRequestFor(uci));
      return;
    }
    // re-plans are the smart model's: never without runtime AI (docs/TEACHING.md §4.4)
    if (strategy !== null && runtimeAiOn()) startReplanWatch(fenBefore, uci);
  }

  /** The child's position of `ply` (after the bot's move `ply − 1`) is — or is about to be — on the board's line. */
  function replanPositionAlive(ply: number, fenBefore: string, key: string): boolean {
    if (disposed || !chess || get().phase === 'gameOver') return false;
    const played = get().moves[ply - 2];
    if (played) return played.by === 'bot' && positionKey(played.fenAfter) === key;
    // not shown yet: the bot is still «thinking» over the same position
    return get().phase === 'botThinking' && positionKey(chess.fen()) === positionKey(fenBefore);
  }

  /** The prewarmed MultiPV of the child's next position: deep enough, complete, or whatever is there after `replanWaitMs`. */
  async function replanLines(key: string, alive: () => boolean): Promise<EngineLine[]> {
    const startedAt = now();
    for (;;) {
      if (!alive()) return [];
      const cached = cache.get(key);
      if (cached?.complete) return cached.result.lines;
      const search = background;
      const latest = search && search.key === key ? search.latest : [];
      const cachedLines = cached?.result.lines ?? [];
      const lines = latest.length > 0 && (latest[0]?.depth ?? 0) >= (cachedLines[0]?.depth ?? 0) ? latest : cachedLines;
      const depth = lines.reduce((d, line) => Math.max(d, line.depth), 0);
      if (lines.length > 0 && depth >= timings.replanMinDepth) return lines;
      // nothing analyses this position (any more), or the time is up: use what there is
      if (!(search && search.key === key && !search.settled) || now() - startedAt >= timings.replanWaitMs) return lines;
      await sleep(TEACH_POLL_MS);
    }
  }

  /** The bot's move is decided: does the plan need the smart model? (left the line / a new phase / cadence) */
  function startReplanWatch(fenBefore: string, uci: string): void {
    const strategist = deps.strategist;
    const current = strategy;
    if (!strategist || !current || !chess || !runtimeAiOn()) return;
    const after = positionAfter(fenBefore, uci);
    if (!after || after.over) return;
    const ply = currentPly() + 2;
    const key = positionKey(after.fen);
    const historySan = [...get().moves.map((m) => m.san), after.san];
    const childLast = get().moves.findLast((m) => m.by === 'child');
    const alive = (): boolean => replanPositionAlive(ply, fenBefore, key);
    const job = (async (): Promise<void> => {
      const lines = await replanLines(key, alive);
      if (!alive() || strategy !== current) return;
      const memory = teachMemory;
      // the child left the repertoire line himself: the opponent's model reply means nothing any more
      const childOnRepertoire = memory.repertoireNextSan === null || childLast === undefined || childLast.san === memory.repertoireNextSan;
      const status = strategyLineStatus({
        fen: after.fen,
        childColor: childColor(),
        historySan,
        lineSan: strategyCard?.lineSan ?? null,
        // a Black system against any first move (against «other») starts its main line with one example move: only
        // the child's own planned moves count (core's strategyProgress does the same)
        mainLineSan: strategyCard?.against === 'other' ? null : (strategyCard?.mainLineSan ?? null),
        lines,
        repertoireInBook: memory.repertoireInBook && childOnRepertoire,
        repertoireOppNext: memory.repertoireOppNext ?? null,
      });
      const phase = safeCall(() => computePositionFacts(after.fen).phase, planPhase);
      const trigger = replanTrigger({ ply, phase, planPhase, lineBefore: lineStatus, lineAfter: status.status, lastReplanPly, everyPlies: timings.replanEveryPlies });
      lineStatus = status.status;
      if (trigger === null) return;
      const candidates = replanCandidates(after.fen, lines, { stage: profile.stage, phase });
      if (candidates.length === 0) return; // no engine lines: the model would have nothing proven to choose from
      await askReplan({ ply, fen: after.fen, childColor: childColor(), strategyId: current.strategyId, movesSan: historySan, candidates, stage: profile.stage }, trigger, key, alive, phase);
    })();
    track(job.catch((error: unknown) => log('the re-plan check failed', error)));
  }

  async function askReplan(request: ReplanRequest, trigger: ReplanTrigger, key: string, alive: () => boolean, phase: PositionPhase): Promise<void> {
    const strategist = deps.strategist;
    if (!strategist || !runtimeAiOn()) return;
    const seq = ++replanSeq;
    // the older question is stale now: cancelled (a server may stop the model), its answer would be dropped anyway
    replanController?.abort(REPLAN_SUPERSEDED);
    const controller = new AbortController();
    replanController = controller;
    lastReplanPly = request.ply;
    planPhase = phase;
    const startedAt = now();
    const journal = (data: Record<string, unknown>): void => {
      if (!disposed) addEvent('coachSaid', { kind: 'replan', ply: request.ply, trigger, latencyMs: Math.max(0, Math.round(now() - startedAt)), ...data }, currentPly());
    };
    let raw: ReplanResponse | null;
    try {
      raw = await untilAborted(strategist.replan(request, { signal: controller.signal }), controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        log('the re-plan failed — the teacher keeps the plan it has', error);
        journal({ dropped: 'failed' });
      }
      return;
    } finally {
      if (replanController === controller) replanController = null;
    }
    if (controller.signal.aborted || disposed) {
      // a newer re-plan took its place (journaled — the parent sees what the model was asked); game over / leaving: silence
      if (controller.signal.reason === REPLAN_SUPERSEDED && !disposed && get().phase !== 'gameOver') journal({ dropped: 'stale' });
      return;
    }
    // stale: a newer re-plan was asked, or this position is no longer the game's line (a take-back, the game ended)
    if (seq !== replanSeq || !alive()) {
      journal({ dropped: 'stale', provider: raw?.provider ?? null });
      return;
    }
    const answer = acceptReplan(request, raw);
    if (!answer) {
      journal({ dropped: 'invalid', provider: raw?.provider ?? null });
      return;
    }
    replans.push({ answer, fenKey: key });
    while (replans.length > MAX_REPLANS) replans.shift();
    set({ replan: answer });
    journal({ provider: answer.provider, planRu: answer.planRu, whyRu: answer.whyRu, preferredUci: answer.preferredUci });
    // (the new plan reaches the voice in the next teacher brief — «новый план: …» — and in the position answer; no
    // silent note: see the strategy above)
    schedulePersist();
  }

  /** The latest accepted re-plan that belongs to the game's line up to the child's position `fen` of `ply`. */
  function replanFor(ply: number, fen: string): ReplanResponse | null {
    const moves = get().moves;
    for (let i = replans.length - 1; i >= 0; i--) {
      const entry = replans[i];
      if (!entry || entry.answer.ply > ply) continue;
      const onLine = entry.answer.ply === ply ? entry.fenKey === positionKey(fen) : positionKey(moves[entry.answer.ply - 2]?.fenAfter ?? '') === entry.fenKey;
      if (onLine) return entry.answer;
    }
    return null;
  }

  function strategyContextFor(ply: number, fen: string): TeachStrategyContext {
    return { strategy, strategyCard, replan: strategy !== null && runtimeAiOn() ? replanFor(ply, fen) : null };
  }

  /** Requests in flight are of no use any more (game over, dispose). */
  function abortStrategist(): void {
    strategyAsk?.controller.abort();
    replanController?.abort();
    replanController = null;
  }

  /** Once per game, when the child is nearly out of time: the one word about the clock the coach ever says. */
  function maybeHurry(): void {
    if (hurrySaid || disposed || !clock || !clock.timed || coachMode() === 'off' || config?.examMode || get().phase !== 'childTurn') return;
    const left = clock.remaining(childColor());
    if (left === null || left <= 0 || left >= timings.hurryBelowMs) return;
    hurrySaid = true;
    if (teacherOn()) {
      // «Учитель»: the lesson's own words for it (an empty one — no words in the library — is not said)
      try {
        void sayEvent(lessonHurry(profile, book));
      } catch (error) {
        log('the lesson hurry failed', error);
      }
      return;
    }
    // (no clock words even in the brief — the clock is never read out; the model says this one word only)
    const brief = composeBrief({
      moment: 'ученику пора ходить быстрее',
      facts: ['думать долго сейчас нельзя'],
      goal: `скажи только одно слово: «${HURRY_TEXT_RU}» — тепло, без паники`,
      forbid: ['никаких чисел и ничего, кроме этого слова', 'не называй ходы'],
    });
    // (its clip twin: «Записи» says it and records it on first use)
    void sayEvent(withShellTwin({ id: `game-hurry-${gameId}`, kind: 'encourage', priority: 1, text: HURRY_TEXT_RU, bubbleText: HURRY_TEXT_RU, pose: 'talk', pauseClock: false, brief }, ['shell.hurry']));
  }

  function startTeachTurn(at: number, opts: { t0?: number; after?: Promise<void> | null }): void {
    if (!chess) return;
    const run = { ply: currentPly() + 1, at, preparing: true, done: Promise.resolve() };
    teachRun = run;
    run.done = runTeachTurn(run, opts)
      .catch((error: unknown) => log('the teacher turn failed', error))
      .finally(() => {
        run.preparing = false;
        if (teachRun === run) teachRun = null;
        // no teachTurn went out: the voice model still learns about the bot's move from the silent note (a stale run
        // leaves the note of a newer bot move alone)
        if (!stale(run.at)) {
          if (deferredBotNote !== null) pushContext(deferredBotNote);
          deferredBotNote = null;
        }
        maybeReleaseTeach();
      });
    track(run.done);
  }

  async function runTeachTurn(run: { ply: number; at: number; preparing: boolean }, opts: { t0?: number; after?: Promise<void> | null }): Promise<void> {
    if (opts.after) await withTimeout(opts.after, timings.coachAutoResumeMs, 'the phrase before the first advice').catch(() => undefined);
    if (stale(run.at) || !chess || !config) return;
    const t0 = opts.after ? now() : (opts.t0 ?? now());
    const fen = chess.fen();
    const key = positionKey(fen);
    const analysis = await teachAnalysis(run.at, key, fen, t0);
    if (stale(run.at)) return;
    const threat = await teachThreat(run.at, key, fen, t0);
    if (stale(run.at)) return;
    const ctx = teachContextFor(fen, run.ply, analysis, threat);
    const verified = await teachVerify(run.at, ctx, t0);
    if (stale(run.at)) return;

    // the lesson director (docs/TEACHING.md §4.3): the chess truth of planTeachTurn + the ONE moment of this turn +
    // its words from the phrase book (no generative AI)
    let out: ReturnType<typeof lessonTurn>;
    try {
      out = lessonTurn(verified.length > 0 ? { ...ctx, verified } : ctx, book);
    } catch (error) {
      log('the teacher could not plan this move', error);
      return;
    }
    commitTeachPlan(out.plan);
    commitLessonMemory(out.memory);
    set({ teachMode: out.plan.mode });
    rememberConcept(out.result.event?.teach?.conceptId);
    deferredBotNote = null;
    // 4) the background analysis goes on: a deeper cache for the judgement of the child's next move
    startBackground(fen);
    run.preparing = false;
    firstTeachSaid = true;
    showLesson(out.plan, out.result, run.at);
  }

  /** Step 1: the MultiPV analysis of the child's position, as deep as the deadline allows (§2.1 degradation). */
  async function teachAnalysis(at: number, key: string, fen: string, t0: number): Promise<AnalysisResult | null> {
    if (!judgeOk) return null;
    const depthNow = (): number => {
      let depth = cache.get(key)?.result.depth ?? 0;
      const search = background;
      if (search && search.key === key) for (const line of search.latest) depth = Math.max(depth, line.depth);
      return depth;
    };
    for (;;) {
      if (stale(at) || disposed) return null;
      if (cache.get(key)?.complete) break;
      const search = background;
      if (!search || search.key !== key || search.settled) break; // nothing analyses this position (any more)
      const depth = depthNow();
      const elapsed = now() - t0;
      if (depth >= timings.teachMinDepth) break;
      if (elapsed >= timings.teachAnalysisMs && depth >= timings.teachFallbackDepth) break;
      if (elapsed >= timings.backgroundMovetimeMs) break;
      await sleep(TEACH_POLL_MS);
    }
    // the judge must be free for the threat and the checks: a running analysis stops here, its lines stay cached
    const search = background;
    if (search && search.key === key && !search.settled && !cache.get(key)?.complete) await stopBackground();
    const entry = cache.get(key);
    if (entry) return entry.result;
    return search && search.key === key ? analysisFromLines(fen, search.latest) : null;
  }

  /** Step 2: the opponent's null-move threat — a Threat, null = none, undefined = not known in time. */
  async function teachThreat(at: number, key: string, fen: string, t0: number): Promise<Threat | null | undefined> {
    if (threats.has(key)) return threats.get(key) ?? null;
    if (!judgeOk || stale(at)) return undefined;
    const deadline = t0 + timings.teachDeadlineMs;
    const search = background;
    if (search && search.key === key && !search.settled) {
      // the background slot is already on it (the analysis is complete, the null-move search runs)
      const left = deadline - now();
      if (left > 0) await Promise.race([search.promise, sleep(left)]);
      if (!search.settled) await stopBackground();
      return threats.has(key) ? (threats.get(key) ?? null) : undefined;
    }
    if (now() + timings.threatSearchMovetimeMs > deadline) return undefined;
    const own: BackgroundSearch = { key, fen, latest: [], settled: false, stopped: false, promise: Promise.resolve() };
    const pending = searchThreat(own).finally(() => {
      own.settled = true;
    });
    teachSearch = pending;
    try {
      await Promise.race([pending, sleep(Math.max(0, deadline - now()))]);
      if (!own.settled) {
        // out of time: the advice goes without the engine's threat (the static mate check still works)
        own.stopped = true;
        try {
          deps.judge.stop();
        } catch {
          // the engine is in trouble anyway
        }
        await withTimeout(pending, 2_500, 'threat search stop').catch(() => undefined);
      }
    } finally {
      if (teachSearch === pending) teachSearch = null;
    }
    return threats.has(key) ? (threats.get(key) ?? null) : undefined;
  }

  /** Step 3: book / repertoire moves outside the MultiPV lines, checked by `searchmoves` (≤ 2, opening, in time). */
  async function teachVerify(at: number, ctx: TeachContext, t0: number): Promise<EngineLine[]> {
    const analysis = ctx.analysis;
    if (!judgeOk || !analysis || analysis.lines.length === 0) return [];
    let moves: string[];
    try {
      moves = bookMovesToVerify(ctx);
    } catch {
      return [];
    }
    const out: EngineLine[] = [];
    const deadline = t0 + timings.teachDeadlineMs;
    const depth = Math.max(10, (analysis.depth || timings.teachMinDepth) - 2);
    for (const uci of moves) {
      if (stale(at) || disposed || now() + timings.teachVerifyMovetimeMs > deadline) break;
      if (background && !background.settled) await stopBackground();
      let pending: Promise<AnalysisResult>;
      try {
        pending = deps.judge.analyze(ctx.fen, { searchmoves: [uci], depth, movetimeMs: timings.teachVerifyMovetimeMs, multipv: 1 });
      } catch (error) {
        pending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      const tracked = pending.catch(() => undefined);
      teachSearch = tracked;
      try {
        const result = await withTimeout(pending, Math.max(50, deadline - now()), 'book move check');
        const line = result.lines.find((l) => l.pvUci[0] === uci);
        if (line) out.push(line);
      } catch (error) {
        if (error instanceof TimeoutError) {
          try {
            deps.judge.stop();
          } catch {
            // the engine is in trouble anyway
          }
        }
      } finally {
        if (teachSearch === tracked) teachSearch = null;
      }
    }
    return out;
  }

  function safeCall<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  /** Everything one teacher turn is computed from (TeachContext of @gambit/core). */
  function teachContextFor(fen: string, ply: number, analysis: AnalysisResult | null, threat: Threat | null | undefined): TeachContext {
    const moves = get().moves;
    const last = moves[moves.length - 1];
    const history = moves.map((m) => m.san);
    const child = childColor();
    const ctx: TeachContext = {
      fen,
      ply,
      childColor: child,
      profile,
      talkativeness: safeCall(() => deps.coach.talkativeness, undefined) ?? 'normal',
      analysis,
      lastBotMove: last && last.by === 'bot' && positionKey(last.fenAfter) === positionKey(fen) ? { uci: last.uci, san: last.san, fenBefore: last.fenBefore } : null,
      historySan: history,
      repertoire: safeCall(() => teacherContent.repertoirePlan(history, child), null) ?? null,
      mainLineSans: safeCall(() => teacherContent.mainLineMoves(fen), []),
      openingNameRu: (f) => safeCall(() => teacherContent.openingNameRu(f), undefined),
      conceptCard: (id) => safeCall(() => teacherContent.conceptCard(id), undefined),
      conceptsIntroduced: readConcepts(),
      // (the lesson says its reactions right after the move — nothing is glued into the next turn)
      reaction: null,
      memory: teachMemory,
      timed: timeControl.initialMs !== null,
      // the one clock word («Поторопись!», once a game below 30 s) is the teacher's — it needs the child's clock
      remainingMs: clock?.remaining(child) ?? null,
      // the lesson: blitz speaks one sentence and asks fewer questions; the learner model of the phrase book (read-only)
      tc: timeControl.id,
      lessonHistory: book.history(),
    };
    if (threat !== undefined) ctx.threat = threat;
    // the theme was the game's first line: the first turn does not announce it again
    if (themeSaid) ctx.introSaid = true;
    // the smart strategist's part: the strategy of the game and the latest re-plan that still belongs to this game's
    // line — its `preferredUci` is only for `replan.ply === ctx.ply`
    return withStrategyContext(ctx, strategyContextFor(ply, fen));
  }

  /**
   * The child's move in «Учитель» (§2.5, §2.8): specific praise for a deed, the outcome of a followed arrow, or a
   * mistake by its concept — said right away, while the bot thinks (`lessonReaction`). Over the praise cap a real find
   * only gets the joyful pose (no words). The verdict of the move against the advice stays in the journal.
   */
  function teachReact(judgement: MoveJudgement, entry: MoveEntry, decision: InterventionDecision): void {
    const plan = planAt(entry.ply, entry.fenBefore);
    const shown = arrowShown.has(entry.ply);
    // hidden only when the lesson really hid it («найдёшь сам?»): a gift over the cap is told as a normal advice (§2.7)
    // whose words name the capture — taken before its arrow came up it is no «сам нашёл», nor a found treasure
    const treasureHidden = plan?.treasure != null && plan.lesson?.moment === 'treasure' && !shown;
    // the bot's move just before the child's: a capture back on that square is a recapture, not a gift
    const botBefore = get().moves.find((m) => m.ply === entry.ply - 1 && m.by === 'bot');
    const prev = botBefore ? { uci: botBefore.uci, fenBefore: botBefore.fenBefore } : null;
    const advice = lessonAdviceOf(plan);
    const foundMotif = foundMotifOf(judgement);
    const moveEvent = moveEvents[moveEvents.length - 1];
    try {
      // (a hidden treasure's own move counts: «found alone» is recognised by it)
      const verdict = reactionVerdict({ prev, judgement, advice, decision, foundMotif, treasureHidden, repertoireNextSan: plan?.memory.repertoireNextSan ?? null, stage: profile.stage });
      if (moveEvent && moveEvent.ply === entry.ply) moveEvent.data.teachVerdict = verdict.kind;
    } catch (error) {
      log('the verdict of the move failed', error);
    }
    const foundBefore = teachMemory.lesson?.found.length ?? 0;
    let out: ReturnType<typeof lessonReaction>;
    try {
      out = lessonReaction(
        {
          profile,
          tc: timeControl.id,
          judgement,
          advice,
          adviceShown: shown,
          quizAnswered: quizAnswered.has(entry.ply),
          decision,
          ...(foundMotif !== undefined ? { foundMotif } : {}),
          treasureHidden,
          repertoireNextSan: plan?.memory.repertoireNextSan ?? null,
          prev,
          strategyCard,
          // (from the start, the child's move included)
          historySan: get().moves.map((m) => m.san),
        },
        teachMemory,
        book,
      );
    } catch (error) {
      log('the teacher reaction failed', error);
      return;
    }
    commitLessonMemory(out.memory);
    if (out.now && out.now.text.trim() !== '') {
      if (out.now.kind === 'praise') lastPraisePly = entry.ply;
      void sayEvent(out.now);
      return;
    }
    // a real find over the praise cap: joy without words
    if ((out.memory.lesson?.found.length ?? 0) > foundBefore) showPose('cheer', 1_500);
  }

  /** The plan of the position on the board: the planned one, the one being prepared, or a new one from the cache. */
  async function currentTeachPlan(at: number): Promise<TeachPlan | null> {
    if (!chess || !teacherOn() || get().phase !== 'childTurn') return null;
    const ply = currentPly() + 1;
    const ready = planAt(ply, chess.fen());
    if (ready) return ready;
    const run = teachRun;
    if (run && run.ply === ply && run.preparing) {
      await withTimeout(run.done, timings.teachDeadlineMs + timings.backgroundMovetimeMs, 'teacher turn').catch(() => undefined);
      if (stale(at) || !chess) return null;
      const planned = planAt(ply, chess.fen());
      if (planned) return planned;
    }
    if (stale(at) || !chess || get().phase !== 'childTurn') return null;
    // nothing planned for this position (the engine hiccuped, a take-back of two plies): plan it from what is cached
    const fen = chess.fen();
    const key = positionKey(fen);
    try {
      const plan = planTeachTurn(teachContextFor(fen, ply, cache.get(key)?.result ?? null, threats.has(key) ? (threats.get(key) ?? null) : undefined), rng);
      commitTeachPlan(plan);
      set({ teachMode: plan.mode });
      return plan;
    } catch (error) {
      log('the teacher could not plan this move', error);
      return null;
    }
  }

  /**
   * «Совет» / «Повтори» (docs/TEACHING.md §2.3): the advice of this move again in fresh words, its arrows back on the
   * board — a hidden one (quiz, «Сам», a treasure, stage-5 «позже») is shown now. A question still open is closed first
   * as skipped (its answer is not said). Returns the words (null = none), the board is already updated.
   */
  function repeatAdviceEvent(plan: TeachPlan): CoachEvent | null {
    closeQuiz();
    try {
      const out = lessonRepeat(plan, teachMemory, book);
      commitLessonMemory(out.memory);
      void showRevealed(plan, out.board, null);
      rememberConcept(out.event.teach?.conceptId);
      return out.event.text.trim() !== '' ? out.event : null;
    } catch (error) {
      log('the advice could not be repeated', error);
      return null;
    }
  }

  function repeatAdvice(plan: TeachPlan): void {
    const event = repeatAdviceEvent(plan);
    if (event) void sayTeach(event);
  }

  async function teachAdviceEvent(at: number): Promise<CoachEvent | null> {
    const plan = await currentTeachPlan(at);
    if (!plan || stale(at) || disposed) return null;
    return repeatAdviceEvent(plan);
  }

  /** The «Совет» button / the dock in «Учитель»: no ladder, no hint in the journal (advice is not a hint, §1.4). */
  async function requestAdvice(): Promise<void> {
    const at = epoch;
    set({ hintBusy: true, hintPulse: false });
    deps.coach.noteActivity?.();
    try {
      // the advice of this move is being prepared right now: it comes by itself in a moment — no second «вот мой совет»
      // (unless that turn hides its advice — a quiz, «Сам», a treasure: then «Совет» shows it)
      const run = teachRun;
      if (run && run.preparing && run.ply === currentPly() + 1) {
        await withTimeout(run.done, timings.teachDeadlineMs + timings.backgroundMovetimeMs, 'teacher turn').catch(() => undefined);
        if (stale(at) || !chess) return;
        const planned = planAt(run.ply, chess.fen());
        if (planned && !(planned.lesson?.adviceHidden === true && !arrowShown.has(planned.ply))) return;
      }
      const event = await teachAdviceEvent(at);
      if (event && !stale(at)) void sayTeach(event);
    } catch (error) {
      log('advice failed', error);
    } finally {
      if (!disposed) set({ hintBusy: false });
    }
  }

  /** A teacher event handed to the voice layer by a tool (it says it): journaled like explainLastMove. */
  function journalToolEvent(event: CoachEvent): void {
    addEvent('coachSaid', { kind: event.kind, ...journalWords(event), priority: event.priority, ...(event.teach ? { teach: event.teach } : {}), source: 'voice' }, currentPly());
    rememberCoachPhrase(event.text);
  }

  // ───────────────────────── hints ─────────────────────────

  async function bestForHint(fen: string): Promise<AnalysisResult | null> {
    const key = positionKey(fen);
    const usable = (): AnalysisResult | null => {
      const entry = cache.get(key);
      return entry && (entry.complete || entry.result.depth >= HINT_MIN_DEPTH) ? entry.result : null;
    };
    const ready = usable();
    if (ready) return ready;
    if (!judgeOk) return null;

    const search = background;
    if (search && search.key === key && !search.settled) {
      await Promise.race([search.promise, sleep(timings.hintWaitMs)]);
      if (!search.settled) await stopBackground();
      return cache.get(key)?.result ?? null;
    }
    try {
      const result = await withTimeout(
        deps.judge.analyze(fen, { depth: 12, multipv: timings.backgroundMultipv, movetimeMs: timings.confirmMovetimeMs }),
        timings.judgeTimeoutMs,
        'hint analysis',
      );
      storeAnalysis(key, result, false);
      return result;
    } catch (error) {
      log('no analysis for the hint', error);
      return cache.get(key)?.result ?? null;
    }
  }

  /** Builds (and journals) the hint of `level` for the current position. */
  async function produceHint(level: HintLevel, source: 'button' | 'dock' | 'voice'): Promise<CoachEvent> {
    const fen = chess?.fen() ?? START_FEN;
    const ply = currentPly() + 1;
    addEvent('hintRequested', { level, source }, ply);
    const onTurn = get().phase === 'childTurn';
    const best = onTurn ? await bestForHint(fen) : null;
    const facts = computePositionFacts(fen, get().openingName ?? undefined);
    const event = buildHint(level, { fen, best: best ?? { fen, lines: [], bestmove: '', depth: 0, timeMs: 0 }, facts, profile }, rng);
    addEvent('hintGiven', { level, kind: event.kind, ...journalWords(event), source }, ply);
    if (level === 4 && event.board && event.board.arrows.length > 0) movesShown += 1;
    return event;
  }

  /** The dock's «Подсказка» button is always there; in games without hints the coach answers kindly instead of staying mute. */
  function explainNoHints(): void {
    if (now() - lastNoHintsAt < NO_HINTS_PHRASE_GAP_MS) return;
    lastNoHintsAt = now();
    const exam = config?.examMode === true;
    const text = exam ? 'Это экзамен — сегодня играем без подсказок. Я в тебя верю!' : 'В быстрой партии я молчу, чтобы не мешать. Всё разберём после игры!';
    const s = studentWords(profile);
    const brief = composeBrief({
      moment: `${s.nom} ${s.g('нажал', 'нажала')} «Подсказка», но в этой партии подсказок нет`,
      facts: [exam ? 'это экзамен: без подсказок, как на турнире' : 'партия очень быстрая: до конца игры ты молчишь'],
      goal: exam ? 'одной фразой по-доброму объясни, что сегодня без подсказок, и подбодри' : 'одной фразой объясни, что сейчас ты молчишь, а после партии всё разберёте',
      forbid: ['не подсказывай и не называй ходы'],
    });
    void sayEvent(withShellTwin({ id: `game-nohints-${gameId}-${events.length}`, kind: 'encourage', priority: 1, text, bubbleText: text, pose: 'talk', pauseClock: false, brief }, [exam ? 'shell.noHints.exam' : 'shell.noHints.fast']));
  }

  async function requestHint(source: 'button' | 'dock' = 'button'): Promise<void> {
    const state = get();
    if (disposed) return;
    if (!state.hintsEnabled) {
      if (source === 'dock' && state.phase !== 'idle' && state.phase !== 'gameOver') explainNoHints();
      return;
    }
    if (state.phase !== 'childTurn' || state.hintBusy) return;
    // «Учитель»: «Совет» repeats the current advice (arrows again) — there is no ladder (TEACHER-MODE §1.4)
    if (teacherOn()) {
      await requestAdvice();
      return;
    }
    const at = epoch;
    const level = Math.min(4, state.hintLevel + 1) as HintLevel;
    set({ hintBusy: true, hintPulse: false });
    deps.coach.noteActivity?.();
    clearThreatTimer();
    armSilenceNudge();
    try {
      const event = await produceHint(level, source);
      if (stale(at)) return;
      set({ hintLevel: level, annotations: event.board ?? get().annotations });
      void sayEvent(event, 'none');
    } catch (error) {
      log('hint failed', error);
    } finally {
      if (!disposed) set({ hintBusy: false });
    }
  }

  // ───────────────────────── realtime-voice tools ─────────────────────────

  /**
   * A judge engine for ONE hypothetical-move check: every search is time-boxed, and repeated identical searches
   * (judgeMove's confirmation step at the same depth) are answered from a per-check memo.
   */
  function scratchJudge(movetimeMs: number): IJudgeEngine {
    const judge = deps.judge;
    const memo = new Map<string, Promise<AnalysisResult>>();
    return {
      ready: () => judge.ready(),
      analyze: (fen, opts) => {
        const memoKey = `${positionKey(fen)}|${opts.depth ?? ''}|${opts.multipv ?? 1}|${(opts.searchmoves ?? []).join(',')}`;
        let pending = memo.get(memoKey);
        if (!pending) {
          pending = judge.analyze(fen, { ...opts, movetimeMs: opts.movetimeMs ?? movetimeMs });
          memo.set(memoKey, pending);
        }
        return pending;
      },
      stop: () => judge.stop(),
      dispose: () => undefined,
    };
  }

  /**
   * judgeMove on a SCRATCH position: nothing of the game changes (board, journal, hint ladder, clocks). The running
   * background search is paused (its partial result stays cached) and resumed afterwards. Null when the engine is
   * unavailable, busy for too long or was stopped because the child moved.
   */
  async function judgeHypothetical(fen: string, uci: string, budgetMs: number = timings.evaluateMoveTimeoutMs): Promise<MoveJudgement | null> {
    if (!judgeOk || disposed) return null;
    const at = epoch;
    const key = positionKey(fen);
    const startedAt = now();
    // the voice layer waits ~3 s for the answer: the whole check, the pause of the background search included, stays inside the budget
    await withTimeout(stopBackground(), Math.max(200, Math.floor(budgetMs / 2)), 'background stop').catch(() => undefined);
    if (stale(at)) return null;
    const budget = Math.max(300, budgetMs - (now() - startedAt));
    const judging = judgeMove(scratchJudge(timings.evaluateMoveMovetimeMs), {
      fenBefore: fen,
      uci,
      ply: currentPly() + 1,
      cachedBefore: cache.get(key)?.result,
      quickDepth: EVALUATE_MOVE_DEPTH,
      confirmDepth: EVALUATE_MOVE_DEPTH,
    });
    adhocSearch = judging.catch(() => undefined);
    try {
      return await withTimeout(judging, budget, 'evaluateMove');
    } catch (error) {
      if (error instanceof TimeoutError) {
        try {
          deps.judge.stop();
        } catch {
          // the engine is in trouble anyway
        }
      }
      return null;
    } finally {
      adhocSearch = null;
      // the child is still thinking over the same position: the background analysis goes on
      if (!stale(at) && get().phase === 'childTurn' && chess && positionKey(chess.fen()) === key) startBackground(fen);
    }
  }

  /**
   * «а почему не ферзём?» (§7.1): the representative move of a piece — its best move by a `searchmoves` search (the
   * cached MultiPV answers when one of its lines already moves that piece). Falls back to the first legal move.
   */
  async function bestMoveOfPiece(fen: string, legal: readonly Move[], budgetMs: number): Promise<{ move: { uci: string; san: string }; scoreCp: number | null }> {
    const ucis = legal.map((m) => uciOf(m));
    const byUci = (uci: string): Move | undefined => legal.find((m) => uciOf(m) === uci);
    const first = legal[0] as Move;
    const fallback = { move: { uci: uciOf(first), san: first.san }, scoreCp: null };
    const cached = [...(cache.get(positionKey(fen))?.result.lines ?? [])].sort((a, b) => a.multipv - b.multipv).find((l) => ucis.includes(l.pvUci[0] ?? ''));
    const cachedMove = cached ? byUci(cached.pvUci[0] ?? '') : undefined;
    if (cached && cachedMove) return { move: { uci: uciOf(cachedMove), san: cachedMove.san }, scoreCp: teachScoreCp(cached) };
    if (!judgeOk || disposed) return fallback;
    await withTimeout(stopBackground(), Math.max(150, Math.floor(budgetMs / 3)), 'background stop').catch(() => undefined);
    let pending: Promise<AnalysisResult>;
    try {
      pending = deps.judge.analyze(fen, { searchmoves: ucis, multipv: 1, depth: EVALUATE_MOVE_DEPTH, movetimeMs: Math.min(400, budgetMs) });
    } catch (error) {
      pending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    adhocSearch = pending.catch(() => undefined);
    try {
      const result = await withTimeout(pending, Math.max(200, Math.floor(budgetMs / 2)), 'the best move of a piece');
      const line = result.lines.find((l) => ucis.includes(l.pvUci[0] ?? ''));
      const move = line ? byUci(line.pvUci[0] ?? '') : undefined;
      if (line && move) return { move: { uci: uciOf(move), san: move.san }, scoreCp: teachScoreCp(line) };
    } catch (error) {
      if (error instanceof TimeoutError) {
        try {
          deps.judge.stop();
        } catch {
          // the engine is in trouble anyway
        }
      }
    } finally {
      adhocSearch = null;
    }
    return fallback;
  }

  /** Why the coach cannot check a move right now (exam, bullet, not the child's turn…); null = it can. */
  function moveCheckRefusal(): string | null {
    if (!chess || !config) return 'Партия ещё не началась.';
    const state = get();
    const s = studentWords(profile);
    if (state.phase === 'gameOver') return 'Партия уже закончилась: такие вопросы лучше разобрать в разборе партии.';
    if (config.examMode) return `Это экзамен: ходы сегодня ${s.nom} проверяет ${s.g('сам', 'сама')}. Ход не оценивай — подбодри.`;
    if (coachMode() === 'off') return 'В быстрой партии ты молчишь до конца: ход не оценивай, скажи, что разберёте после партии.';
    if (state.phase === 'coachIntervention') return `Сейчас на экране выбор: вернуть ход или оставить. Сначала пусть ${s.nom} решит, потом проверим новый ход.`;
    if (state.phase !== 'childTurn' || chess.turn() !== childColor()) {
      return `Сейчас ходит соперник: после его хода позиция изменится. Предложи спросить ещё раз, когда будет ход ${s.gen}.`;
    }
    return null;
  }

  const PIECE_TYPES: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];

  /** The current advice in words for a voice answer (analyzePosition in «Учитель», §7.1). */
  function adviceFactsRu(fen: string): string {
    const plan = planAt(currentPly() + 1, fen);
    if (!plan) return '';
    // (a hidden advice — a quiz, «Сам», a treasure, stage-5 «позже» — is the child's to find: never named)
    if (!arrowShown.has(plan.ply)) return plan.treasure ? ' В позиции есть подарок: ход не называй — пусть ученик найдёт его сам.' : ' Ход не называй: пусть ученик сначала подумает сам.';
    const spoken = lessonAdviceOf(plan)
      .map((a) => ({ words: spokenMoveRu(a.san, fen), arrow: a.arrow === 'green' ? 'зелёная' : 'синяя' }))
      .filter((a) => a.words !== '')
      .map((a) => `${a.words} (${a.arrow} стрелка)`);
    return spoken.length > 0 ? ` Совет учителя на этот ход: ${spoken.join('; ')}. Эти ходы можно назвать.` : '';
  }

  /** The plan of this game in words for a voice answer: the strategy and, when there is one, the latest re-plan. */
  function strategyFactsRu(fen: string): string {
    if (!strategy) return '';
    const idea = strategy.ideaRu.replace(/[.!…]+$/u, '');
    const replan = replanFor(currentPly() + 1, fen);
    return ` Стратегия этой партии — «${strategy.titleRu}»${idea ? `: ${idea.charAt(0).toLowerCase()}${idea.slice(1)}` : ''}.${replan ? ` План сейчас: ${replan.planRu.replace(/[.!…]+$/u, '')}.` : ''}`;
  }

  /**
   * The only clock fact the voice model ever gets: nothing while there is time — the child sees
   * the clock — and «мало времени» when the child has less than `hurryBelowMs` left in a timed game.
   */
  function lowTimeFactRu(): string {
    if (!clock || !clock.timed || get().phase === 'gameOver') return '';
    const left = clock.remaining(childColor());
    if (left === null || left >= timings.hurryBelowMs) return '';
    return ' У ученика мало времени: отвечай совсем коротко, можно поторопить его одним словом. Сколько времени осталось, не называй.';
  }

  const toolHost: CoachToolHost = {
    getPositionSummary(): Promise<string> {
      if (!chess || !config) return Promise.resolve('Партия ещё не началась.');
      try {
        const fen = chess.fen();
        const moves = get().moves;
        const last = moves[moves.length - 1];
        return Promise.resolve(
          describePositionRu({
            facts: computePositionFacts(fen, get().openingName ?? undefined),
            childColor: config.childColor,
            analysis: cache.get(positionKey(fen))?.result ?? null,
            lastMove: last ? { san: last.san, fenBefore: last.fenBefore, by: last.by } : null,
            moveNumber: chess.moveNumber(),
            gameOver: get().phase === 'gameOver',
          }),
        );
      } catch (error) {
        log('position summary failed', error);
        return Promise.resolve('Сейчас не получается описать позицию.');
      }
    },

    analyzePosition(): Promise<string> {
      if (!chess || !config || !clock) return Promise.resolve('Партия ещё не началась.');
      try {
        const fen = chess.fen();
        const key = positionKey(fen);
        const state = get();
        const moves = state.moves;
        const child = childColor();
        const quiet = config.examMode || coachMode() === 'off';
        let opening: { name?: string | null; title?: string; idea?: string } = { name: state.openingName };
        if (!quiet) {
          try {
            // the idea of the opening at any stage, as the game names it (maybeOpeningIdea)
            const advice = getRepertoireAdvice(moves.map((m) => m.san), child);
            if (advice) opening = { ...opening, title: advice.lineTitle, idea: advice.idea };
          } catch {
            // the plan is a nice-to-have
          }
        }
        // «Учитель»: the advice closes the answer and may be named — no helper «Лучший ход не называй» next to it
        const teaching = teacherOn() && state.phase === 'childTurn';
        const answer = buildPositionAnswerRu({
          fen,
          facts: computePositionFacts(fen, state.openingName ?? undefined),
          childColor: child,
          profile,
          analysis: cache.get(key)?.result ?? null,
          threat: threats.has(key) ? (threats.get(key) ?? null) : undefined,
          lastMoves: moves.slice(-2).map((m) => ({ san: m.san, fenBefore: m.fenBefore, by: m.by })),
          moveNumber: chess.moveNumber(),
          // no clock in the facts (a model would read out «у тебя четыре минуты пятьдесят девять секунд» — the child
          // sees the clock); only «мало времени» below `hurryBelowMs`, see lowTimeFactRu
          opening,
          gameOver: state.phase === 'gameOver',
          examMode: quiet,
          teacher: teaching,
        });
        // «Учитель» never leaves «what now?» empty: the current advice closes the answer (§2.3, §7.1) — and the plan of
        // the game (the strategy, the smart model's latest re-plan) lets the answer say WHY
        const full = teaching ? `${answer}${strategyFactsRu(fen)}${adviceFactsRu(fen)}` : answer;
        return Promise.resolve(`${full}${lowTimeFactRu()}`);
      } catch (error) {
        log('position analysis failed', error);
        return Promise.resolve('Сейчас не получается разобрать позицию. Скажи честно, что проверишь чуть позже.');
      }
    },

    async evaluateMove(move: string): Promise<string> {
      const refusal = moveCheckRefusal();
      if (refusal !== null || !chess) return refusal ?? 'Партия ещё не началась.';
      const fen = chess.fen();
      const parsed = parseMoveText(fen, typeof move === 'string' ? move : '');
      if (!parsed.ok) return moveTextProblemRu(parsed);
      deps.coach.noteActivity?.();
      const judgement = await judgeHypothetical(fen, parsed.uci);
      const takenBackBefore = [...takenBackJudgements].some((j) => positionKey(j.fenBefore) === positionKey(fen) && j.uci === parsed.uci);
      // «Учитель»: the answer may compare the move with the current advice (TEACHER-MODE §6.4, answers.ts)
      const advice = teacherOn() ? scoredAdvice(planAt(currentPly() + 1, fen)) : [];
      return buildMoveCheckAnswerRu({ judgement, move: { uci: parsed.uci, san: parsed.san, fenBefore: fen }, profile, takenBackBefore, ...(advice.length > 0 ? { advice } : {}) });
    },

    /**
     * «а почему не ферзём?» / «а почему не конём на цэ три?» (TEACHER-MODE §7.1): the named move — or the best move of
     * the named piece — judged on a scratch board and compared with the current advice (none in «Подсказчик»), with
     * the engine line in words, the queen chase and the opening principle. Nothing in the game changes. ≤ ~1.5 s.
     */
    async compareMove(query: { move?: string; piece?: PieceType }): Promise<string> {
      const refusal = moveCheckRefusal();
      if (refusal !== null || !chess) return refusal ?? 'Партия ещё не началась.';
      const fen = chess.fen();
      const startedAt = now();
      deps.coach.noteActivity?.();
      const asked: { move?: string; piece?: PieceType } = {};
      if (typeof query?.move === 'string' && query.move.trim() !== '') asked.move = query.move.trim();
      if (query?.piece !== undefined && PIECE_TYPES.includes(query.piece)) asked.piece = query.piece;
      const plan = teacherOn() ? planAt(currentPly() + 1, fen) : null;
      const advice = scoredAdvice(plan);
      let move: { uci: string; san: string } | null = null;
      let moveScoreCp: number | null = null;
      let problemRu: string | null = null;
      if (asked.move !== undefined) {
        const parsed = parseMoveText(fen, asked.move);
        if (parsed.ok) move = { uci: parsed.uci, san: parsed.san };
        else problemRu = moveTextProblemRu(parsed);
      } else if (asked.piece !== undefined) {
        const legal = new Chess(fen).moves({ piece: asked.piece, verbose: true });
        const only = legal.length === 1 ? legal[0] : undefined;
        if (only) move = { uci: uciOf(only), san: only.san };
        else if (legal.length > 1) {
          const representative = await bestMoveOfPiece(fen, legal, timings.evaluateMoveTimeoutMs);
          move = representative.move;
          moveScoreCp = representative.scoreCp;
        }
      } else {
        problemRu = 'Непонятно, какой ход сравнить: попроси назвать ход или фигуру.';
      }
      const budget = Math.max(300, timings.evaluateMoveTimeoutMs - (now() - startedAt));
      const judgement = move ? await judgeHypothetical(fen, move.uci, budget) : null;
      const phase = safeCall(() => computePositionFacts(fen).phase, undefined);
      return buildCompareMoveAnswerRu({
        fen,
        query: asked,
        move,
        judgement,
        advice,
        moveScoreCp,
        profile,
        ...(phase ? { phase } : {}),
        conceptCard: (id) => safeCall(() => teacherContent.conceptCard(id), undefined),
        problemRu,
      });
    },

    /** «Учитель»: the current advice again (arrows back on the board) as a short teachTurn 'repeat'; null otherwise. */
    async repeatAdvice(): Promise<CoachEvent | null> {
      if (!teacherOn() || get().phase !== 'childTurn') return null;
      const event = await teachAdviceEvent(epoch);
      if (event) journalToolEvent(event);
      return event;
    },

    async getHint(level: HintLevel): Promise<CoachEvent> {
      const state = get();
      // «Учитель» (§1.4, §7.1): «подскажи» / «что мне ходить?» get the teacher's advice — never the ladder, never a hint in the journal
      if (teacherOn() && state.phase === 'childTurn') {
        const advice = await teachAdviceEvent(epoch);
        if (advice) {
          journalToolEvent(advice);
          return advice;
        }
      }
      const allowed = state.hintsEnabled && state.phase === 'childTurn';
      // Outside the child's own move (or in an exam) the ladder stays on its first, Socratic step. On the child's
      // move the CODE keeps the order 1→2→3→4, exactly like the button: whatever level the voice model asks for
      // («просто скажи ход»), it gets at most the next step — `event.hintLevel` tells it which one.
      const asked = Number.isFinite(level) ? Math.max(1, Math.min(4, Math.floor(level))) : 1;
      const effective = (allowed ? Math.min(asked, state.hintLevel + 1) : 1) as HintLevel;
      const at = epoch;
      const event = await produceHint(effective, 'voice');
      if (allowed && !stale(at)) {
        const reached = Math.max(get().hintLevel, effective) as GameState['hintLevel'];
        set({ hintLevel: reached, hintPulse: false, annotations: event.board ?? get().annotations });
      }
      return event;
    },

    explainLastMove(): Promise<CoachEvent | null> {
      const child = childColor();
      const last = [...judgements].reverse().find((j) => j.color === child);
      const state = get();
      // never while the same move can still be replayed: the explanation names the best move
      if (!last || config?.examMode || state.phase === 'coachIntervention' || retryingAfterTakeback) return Promise.resolve(null);
      const event = buildExplainBest(last, profile, rng);
      addEvent('coachSaid', { kind: event.kind, ...journalWords(event), priority: event.priority, source: 'voice' }, currentPly());
      rememberCoachPhrase(event.text);
      return Promise.resolve(event);
    },

    showOnBoard(a: BoardAnnotations): void {
      const arrows = (a.arrows ?? []).filter((arrow) => isSquare(arrow.from) && isSquare(arrow.to)).slice(0, 8);
      const highlights = (a.highlights ?? []).filter((h) => isSquare(h.square)).slice(0, 16);
      set({ annotations: arrows.length + highlights.length > 0 ? { arrows, highlights } : null });
    },

    takeBackMove(): boolean {
      if (get().phase === 'coachIntervention' && pendingOffer) {
        acceptTakeback();
        return true;
      }
      return voluntaryTakeback('voice');
    },
  };

  /**
   * Training games only: the child asks — by voice or with the «Вернуть ход» button — to take the last own move
   * back (a slip of the hand). Journaled as a voluntary take-back; one undo per own move.
   */
  function voluntaryTakeback(source: 'voice' | 'button'): boolean {
    if (disposed || !chess || !clock || !config) return false;
    if (get().phase !== 'childTurn' || !undoAllowed()) return false;
    const moves = get().moves;
    const lastChildIndex = moves.findLastIndex((move) => move.by === 'child');
    if (lastChildIndex < 0) return false;

    epoch += 1;
    clearThreatTimer();
    // an open quiz card closes as skipped (its answer is not said), the lesson's timers end
    closeQuiz();
    const teachCut = endTeachUtterances();
    const undone = moves.slice(lastChildIndex);
    for (let i = 0; i < undone.length; i++) {
      chess.undo();
      const event = moveEvents.pop();
      if (event) event.data.takenBack = true;
      fensAfter.pop();
    }
    noteBoardChange();
    const kept = moves.slice(0, lastChildIndex);
    const childMove = undone[0] as MoveEntry;
    const undoneJudgement = judgements.findLast((j) => j.ply === childMove.ply && j.uci === childMove.uci);
    if (undoneJudgement) takenBackJudgements.add(undoneJudgement);
    // a judgement still waiting in the queue would arrive later and look like the move that stayed
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i]?.ply === childMove.ply) jobs.splice(i, 1);
    addEvent('takebackAccepted', { san: childMove.san, uci: childMove.uci, voluntary: true, source, pliesUndone: undone.length }, childMove.ply);
    undoUsedAtPly = childMove.ply;
    declined = null;
    clearDeclineReasons();
    const previous = kept[kept.length - 1];
    deps.coach.clearAnnotations?.();
    set({ moves: kept, lastMove: previous ? { from: previous.from, to: previous.to } : null });
    syncBoard({ annotations: null });
    clock.switchTo(config.childColor, { increment: false });
    turnStartedAt = now();
    if (source === 'button' || teachCut) {
      deps.coach.stopSpeaking({ clearBubble: true });
    }
    if (source === 'button') void sayEvent(buildVoluntaryTakeback(profile, rng));
    enterChildTurn();
    if (teacherOn()) {
      // «Учитель»: the advice of the position the child is back at returns silently
      for (const ply of [...teachPlans.keys()]) if (ply > childMove.ply) teachPlans.delete(ply);
      for (const ply of [...arrowShown]) if (ply > childMove.ply) arrowShown.delete(ply);
      for (const ply of [...quizAnswered]) if (ply > childMove.ply) quizAnswered.delete(ply);
      // a re-plan made for a position that is gone now belongs to no line any more
      for (let i = replans.length - 1; i >= 0; i--) if ((replans[i]?.answer.ply ?? 0) > childMove.ply) replans.splice(i, 1);
      set({ replan: replans[replans.length - 1]?.answer ?? null });
      const plan = planAt(childMove.ply, childMove.fenBefore);
      // (only an arrow the child had seen: a hidden advice stays hidden)
      if (plan && arrowShown.has(plan.ply)) {
        const advice = lessonAdviceOf(plan);
        set({ annotations: adviceArrows(advice), advice: advice.length > 0 ? advice : null });
      }
    }
    return true;
  }

  // ───────────────────────── game end ─────────────────────────

  function finish(result: GameResult, termination: Termination): void {
    if (disposed || get().phase === 'gameOver' || !config) return;
    epoch += 1;
    clearThreatTimer();
    clearDeclineReasons();
    closeQuiz();
    endTeachUtterances();
    abortStrategist();
    pendingOffer = null;
    declined = null;
    clock?.stop();
    for (const name of [...holds.keys()]) releaseClock(name);
    releaseVoiceHold();

    const outcome = childOutcome(result, config.childColor);
    addEvent('gameEnd', { result, termination, outcome }, currentPly());
    // the lesson (§2.9): the outcome and ONE takeaway, for every style — built now, while the phrase book still counts
    // this game; then the book closes the game and the child's cross-game memory is written (localStorage, ≤ 16 KB)
    const preliminary = summarizeWithTakebacks({ judgements, takenBack: takenBackJudgements, events, openingName: get().openingName ?? undefined, stage: profile.stage });
    const lessonEnding = termination === 'abandoned' ? null : endOfLesson(result, termination, preliminary);
    try {
      // (a game given up before it began is no game of the lesson: it does not count, the words it said still do)
      if (termination !== 'abandoned') book.finishGame();
      if (!writeLessonHistory(deps.storage, book.snapshotHistory()) && deps.storage) log('the lesson memory could not be written to localStorage');
    } catch (error) {
      log('the phrase book could not close the game', error);
    }
    // (a question from the middle of the game is not what the child answers after it)
    lastCoachQuestion = null;
    // from here on the snapshot is a finished game waiting for delivery: it is never offered as «Продолжить?»
    ended = { result, termination };
    persistNow();
    set({
      phase: 'gameOver',
      canUndo: false,
      declineReasons: null,
      result,
      termination,
      takeback: null,
      selected: null,
      legalTargets: [],
      pendingPromotion: null,
      hintPulse: false,
      hintBusy: false,
      annotations: null,
      advice: null,
      treasure: null,
      quiz: null,
      takeaway: lessonEnding?.takeaway ?? null,
      quizScore: lessonEnding?.quizScore ?? null,
    });
    deps.coach.setToolHost(null);
    hintAvailability(true);
    deps.coach.clearAnnotations?.();
    clearSilenceTimer();
    notifyGameEnd({ result, termination });

    if (outcome === 'win') {
      playSound('win');
      try {
        deps.celebrate?.();
      } catch {
        // confetti is decoration
      }
      setBotBubble({ kind: 'lose', text: pickLine(persona.lines.onLose) }, false);
    } else if (outcome === 'loss') {
      playSound('lose');
      setBotBubble({ kind: 'win', text: pickLine(persona.lines.onWin) }, false);
    } else if (outcome === 'draw') {
      setBotBubble({ kind: 'draw', text: pickLine(persona.lines.onDraw) }, false);
    } else {
      setBotBubble(null);
    }

    ending = runEnding(result, termination, preliminary, lessonEnding?.event ?? null).catch((error: unknown) => log('post-game pipeline failed', error));
    track(ending);
  }

  /**
   * The end of the lesson (`lessonEnd`, docs/TEACHING.md §2.9): the outcome opener + one takeaway (the result card
   * shows it, the book remembers its key for the next games), and the quiz score of this game. null = nothing to say.
   */
  function endOfLesson(result: GameResult, termination: Termination, summary: ReturnType<typeof summarizeWithTakebacks>): { event: CoachEvent | null; takeaway: string | null; quizScore: { right: number; total: number } | null } | null {
    if (!config) return null;
    const quizzes = teachMemory.lesson?.quizzes ?? [];
    const quizScore = quizzes.length > 0 ? { right: quizzes.filter((q) => q.correct === true).length, total: quizzes.length } : null;
    try {
      const out = lessonEnd(
        {
          profile,
          tc: timeControl.id,
          result,
          childColor: config.childColor,
          termination,
          summary,
          strategyCard,
          judgements: judgements.filter((j) => j.color === config?.childColor),
          historySan: get().moves.map((m) => m.san),
        },
        teachMemory,
        book,
      );
      commitLessonMemory(out.memory);
      const takeaway = out.takeaway.trim();
      return { event: out.event.text.trim() !== '' ? out.event : null, takeaway: takeaway !== '' ? takeaway : null, quizScore };
    } catch (error) {
      log('the end of the lesson failed', error);
      return { event: null, takeaway: null, quizScore };
    }
  }

  function childMoveCount(): number {
    return get().moves.filter((move) => move.by === 'child').length;
  }

  function makeRecord(result: GameResult, termination: Termination) {
    if (!config) throw new Error('no game config');
    return buildGameRecord({
      id: gameId,
      config,
      persona,
      timeControl,
      nickname: profile.nickname,
      startedAt,
      endedAt: wallClock(),
      moves: get().moves,
      result,
      termination,
      opening,
      events,
      judgements,
      takenBack: takenBackJudgements,
      stage: profile.stage,
      coachStyle,
    });
  }

  async function saveRecord(record: ReturnType<typeof makeRecord>): Promise<'saved' | 'local'> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await deps.saveGame(record);
        return 'saved';
      } catch (error) {
        log(`saving the game failed (attempt ${attempt + 1})`, error);
        if (attempt === 0) await sleep(timings.saveRetryDelayMs);
      }
    }
    // the server is down: park the game, it is re-sent when the next game starts
    if (!storeUnsavedGame(deps.storage, record)) log('the game could not be parked in localStorage either');
    return 'local';
  }

  async function runEnding(result: GameResult, termination: Termination, preliminary: ReturnType<typeof summarizeWithTakebacks>, endEvent: CoachEvent | null): Promise<void> {
    if (!config) return;

    // 1. the coach reacts right away, with what is known so far: the outcome and the ONE takeaway of the lesson (every
    // style; journaled as coachSaid {kind:'gameEnd', teach:{moment:'takeaway'}})
    if (endEvent) void sayEvent(endEvent);

    if (childMoveCount() < MIN_CHILD_MOVES_TO_SAVE) {
      closeSnapshot();
      set({ ending: { stage: 'done', judged: 0, toJudge: 0, save: 'skipped' }, summary: preliminary });
      return;
    }

    // 2a. the child's one diary sentence — asked now, journaled BEFORE the record is built and posted
    const noteAnswered = termination === 'abandoned' ? Promise.resolve() : askChildNote();

    // 2b. moves that are still unjudged (bullet, engine hiccups, a resignation while the judge was looking)
    const live = liveJudging;
    if (live) await withTimeout(live, timings.judgeTimeoutMs + 500, 'live judgement').catch(() => undefined);
    await stopBackground();
    if (!judgeOk && jobs.length > 0 && !disposed) {
      // the judge could not start before the game: one more try, so that «посмотрю партию позже» is true
      judgeOk = await withTimeout(deps.judge.ready(), timings.engineReadyTimeoutMs, 'judge.ready (after the game)').then(
        () => true,
        () => false,
      );
      if (judgeOk && !disposed) set({ judgeUnavailable: false });
    }
    const total = jobs.length + (jobRunner ? 1 : 0);
    if (judgeOk && total > 0) {
      jobsDone = 0;
      jobDeadline = now() + timings.postGameBudgetMs;
      set({ ending: { stage: 'analysing', judged: 0, toJudge: total, save: 'pending' } });
      jobListener = (done, all) => {
        if (!disposed) set({ ending: { stage: 'analysing', judged: Math.min(done, all), toJudge: Math.max(all, total), save: 'pending' } });
      };
      await runJobs();
      jobListener = null;
    }
    await noteAnswered;
    if (disposed || recordHandedOff) return; // dispose() has sent the record itself

    // 3. record
    const record = makeRecord(result, termination);
    const stars = computeStars({
      termination,
      childMoves: childMoveCount(),
      summary: record.summary,
      movesShown,
      takebacks: takebackOutcomes(orderJudgements(judgements), events),
    });
    set({ ending: { stage: 'saving', judged: total, toJudge: total, save: 'pending' }, summary: record.summary, stars, record });

    // 4. save (retry once, then park locally — the child never sees an error). From now on the child's words — the talk
    // after the game, a late diary answer — follow the record on their own (POST /games/:id/thoughts)
    const appendThoughts = deps.appendThoughts;
    thoughts = appendThoughts ? createThoughtsOutbox({ gameId: record.id, send: (id, list) => appendThoughts(id, list), storage: deps.storage, delayMs: timings.thoughtsSendDelayMs, log }) : null;
    recordHandedOff = true;
    const saved = await saveRecord(record);
    thoughts?.recordDelivered(saved);
    closeSnapshot();
    if (disposed) return;
    set({ ending: { stage: 'done', judged: total, toJudge: total, save: saved }, savedGameId: record.id });
  }

  // ───────────────────────── the child's diary sentence ─────────────────────────

  function armNoteTimer(): void {
    if (noteTimer !== null) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => (deps.appendThoughts ? releaseNoteWait() : submitChildNote(null)), timings.childNoteWaitMs);
  }

  /**
   * The child went quiet over the diary question: the record goes out without the answer, but the question stays on
   * the card — an answer that comes later follows the record to the server (with the question it answers).
   */
  function releaseNoteWait(): void {
    noteTimer = null;
    const resolve = noteResolve;
    noteResolve = null;
    resolve?.();
  }

  /**
   * The diary question is open and the child says the answer aloud (the talk is open): that is the diary's answer —
   * unless Гамбитик has asked something else since the game ended (then it answers that).
   */
  function answersDiaryByVoice(): boolean {
    return get().note === 'asking' && (lastCoachQuestion === null || /трудн/iu.test(lastCoachQuestion));
  }

  /** Shows «Что было самым трудным в этой партии?» and resolves when the child answered, skipped, or walked away. */
  function askChildNote(): Promise<void> {
    // childNoteWaitMs ≤ 0 switches the question off
    if (disposed || timings.childNoteWaitMs <= 0) return Promise.resolve();
    set({ note: 'asking' });
    return new Promise<void>((resolve) => {
      noteResolve = resolve;
      armNoteTimer();
    });
  }

  function submitChildNote(text: string | null, source: 'typed' | 'voice' = 'typed'): void {
    if (get().note !== 'asking') return;
    if (noteTimer !== null) clearTimeout(noteTimer);
    noteTimer = null;
    const clean = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, CHILD_NOTE_MAX_CHARS);
    if (clean !== '') {
      // journaled after 'gameEnd' on purpose: it is a thought ABOUT the finished game
      addEvent('childSaid', { source, text: clean, about: 'hardestMoment' }, currentPly());
      persistNow();
      // the record went out without it (the child answered late): the answer follows it, with its question
      if (recordHandedOff) sendThought(source, clean, CHILD_NOTE_QUESTION_RU);
    }
    if (!disposed) set({ note: clean !== '' ? 'saved' : 'skipped' });
    const resolve = noteResolve;
    noteResolve = null;
    resolve?.();
  }

  // ───────────────────────── «Записи»: «Спроси» and the thought chips (docs/voice-clips/SPEC.md §8) ─────────────────────────

  /** A «Спроси» chip: every answer goes through sayEvent, so the child's clock stands while it is heard. */
  function answerAsk(question: 'why' | 'opponent' | 'hint' | 'repeat'): void {
    if (disposed) return;
    deps.coach.noteActivity?.();
    switch (question) {
      case 'hint':
        void requestHint('dock');
        return;
      case 'repeat':
        track(answerRepeat());
        return;
      case 'opponent': {
        // his threat (the null-move search of this very position, when the game has it), else his last move — named
        // WITHOUT a square (the board shows it) — board facts only
        const lastBot = get().moves.findLast((m) => m.by === 'bot');
        const here = chess ? positionKey(chess.fen()) : null;
        const onBoard = !!lastBot && here !== null && positionKey(lastBot.fenAfter) === here;
        const threat = onBoard && here !== null && threats.has(here) ? (threats.get(here) ?? null) : undefined;
        // «Учитель»: his idea or threat in the lesson's words (never «ничего опасного» unless the search proved it)
        if (teacherOn() && onBoard && lastBot && chess) {
          try {
            const { event } = lessonOpponent({ profile, fenBefore: lastBot.fenBefore, uci: lastBot.uci, childFen: chess.fen(), threat }, teachMemory, book);
            if (event.text.trim() !== '') void sayEvent(event);
            return;
          } catch (error) {
            log('the lesson answer about the opponent failed', error);
          }
        }
        void sayEvent(opponentAnswerEvent(lastBot ? { san: lastBot.san, fenBefore: lastBot.fenBefore } : null, threat));
        return;
      }
      case 'why':
        track(answerWhy());
        return;
    }
  }

  /**
   * «Почему так?»: the take-back question again while it is open; in «Учитель» on the child's turn one level deeper than
   * the last reason (`lessonWhy`: the second idea, the theme link, the first level of its mini-lesson — a hidden advice
   * stays hidden: nothing is revealed, the reveal timer and the arrows are left alone; an open quiz closes as skipped);
   * after a taken-back move its question again; else why a better move was better; else a question back.
   */
  async function answerWhy(): Promise<void> {
    const state = get();
    const offered = state.phase === 'coachIntervention' ? pendingOffer?.judgement : undefined;
    if (offered) {
      void sayEvent(buildTakebackQuestion(offered, profile, rng));
      return;
    }
    if (teacherOn() && state.phase === 'childTurn') {
      const at = epoch;
      const plan = await currentTeachPlan(at);
      if (disposed || stale(at)) return;
      if (plan) {
        closeQuiz();
        try {
          const out = lessonWhy(plan, teachMemory, book);
          commitLessonMemory(out.memory);
          if (out.event.text.trim() !== '') void sayEvent(out.event);
        } catch (error) {
          log('the lesson «why» failed', error);
        }
        return;
      }
    }
    if (retryingAfterTakeback && takenBackOffer) {
      void sayEvent(buildTakebackQuestion(takenBackOffer, profile, rng));
      return;
    }
    // (explainLastMove journals its own event)
    const explained = await toolHost.explainLastMove();
    if (disposed) return;
    if (explained) void sayEvent(explained, 'none');
    else void sayEvent(whyNothingEvent());
  }

  /**
   * «Повтори»: «Учитель» on the child's turn says the CURRENT advice again in fresh words (`lessonRepeat` — like «Совет»
   * it shows a hidden advice; an open quiz closes as skipped). Otherwise the last phrase again while the board is the
   * one it was said about — after a move or a take-back its arrows and its move would be wrong: a short recorded «это
   * было про прошлый ход».
   */
  async function answerRepeat(): Promise<void> {
    if (teacherOn() && get().phase === 'childTurn') {
      const at = epoch;
      const plan = await currentTeachPlan(at);
      if (disposed || stale(at)) return;
      if (plan) {
        repeatAdvice(plan);
        return;
      }
    }
    const last = lastSaid;
    if (!last) return;
    if (last.key === null || (chess !== null && positionKey(chess.fen()) === last.key)) {
      void sayEvent(repeatEvent(last.event), 'none');
      return;
    }
    if (disposed) return;
    void sayEvent(repeatStaleEvent());
  }

  function tapThought(chip: ThoughtChipId): boolean {
    if (disposed || get().phase !== 'gameOver' || !isThoughtChipId(chip) || tappedThoughts.has(chip) || tappedThoughts.size >= THOUGHT_TAPS_MAX) return false;
    tappedThoughts.add(chip);
    const text = thoughtText(chip, profile.address);
    if (recordHandedOff) {
      // the record went out already: the thought follows it (the existing thoughts route, source 'typed')
      sendThought('typed', text, THOUGHT_QUESTION_RU);
    } else {
      addEvent('childSaid', { source: 'choice', text, about: 'gameFeeling', question: THOUGHT_QUESTION_RU }, currentPly());
      persistNow();
    }
    touchChildNote();
    void sayEvent(thoughtReplyEvent(chip), 'none');
    return true;
  }

  function touchChildNote(): void {
    if (get().note === 'asking' && noteResolve) armNoteTimer();
  }

  function resign(): void {
    const phase = get().phase;
    if (phase === 'idle' || phase === 'gameOver' || !config) return;
    if (childMoveCount() < MIN_CHILD_MOVES_TO_SAVE) finish('*', 'abandoned');
    else finish(resultFor(botColor()), 'resign');
  }

  function onFlag(color: Color): void {
    if (!chess || get().phase === 'gameOver') return;
    const winner = other(color);
    finish(hasMatingMaterial(chess, winner) ? resultFor(winner) : '1/2-1/2', 'timeout');
  }

  // ───────────────────────── resume ─────────────────────────

  /**
   * Puts a saved game back: board, journal, judgements, clocks and the coach's budgets. Called by start() after
   * `chess` / `clock` / ids were created for a fresh game; returns false (and leaves the fresh game untouched)
   * when the snapshot does not replay cleanly.
   */
  function restore(snapshot: ResumableGame): boolean {
    if (!clock || snapshot.ended !== null || snapshot.moves.length === 0) return false;
    const board = new Chess();
    const restoredMoveEvents: GameEvent[] = [];
    try {
      for (const move of snapshot.moves) {
        if (board.fen() !== move.fenBefore) return false;
        const played = board.move({ from: move.from, to: move.to, promotion: move.uci.slice(4) || undefined });
        if (played.san !== move.san || board.fen() !== move.fenAfter) return false;
        const event = snapshot.events.findLast((e) => e.type === 'move' && e.ply === move.ply && e.data.uci === move.uci && e.data.takenBack !== true);
        if (!event) return false;
        restoredMoveEvents.push(event);
      }
    } catch {
      return false;
    }
    if (board.isGameOver()) return false;

    chess = board;
    gameId = snapshot.gameId;
    startedAt = new Date(snapshot.startedAt);
    startedAtMono = now() - Math.max(0, snapshot.elapsedMs);
    turnStartedAt = now();
    events.splice(0, events.length, ...snapshot.events);
    moveEvents.splice(0, moveEvents.length, ...restoredMoveEvents);
    judgements.splice(0, judgements.length, ...snapshot.judgements);
    takenBackJudgements.clear();
    for (const index of snapshot.takenBack) {
      const judgement = judgements[index];
      if (judgement) takenBackJudgements.add(judgement);
    }
    fensAfter.splice(0, fensAfter.length, ...snapshot.moves.map((move) => move.fenAfter));
    opening = snapshot.opening ?? undefined;

    const c = snapshot.counters;
    offersMade = Number.isFinite(c.offersMade) ? c.offersMade : 0;
    lastOfferPly = c.lastOfferPly ?? Number.NEGATIVE_INFINITY;
    lastPraisePly = c.lastPraisePly ?? Number.NEGATIVE_INFINITY;
    threatWarnings = Number.isFinite(c.threatWarnings) ? c.threatWarnings : 0;
    lastThreatWarningPly = c.lastThreatWarningPly ?? Number.NEGATIVE_INFINITY;
    routineAfterPunishSaid = c.routineAfterPunishSaid === true;
    movesShown = Number.isFinite(c.movesShown) ? c.movesShown : 0;
    openingIdeaSaid = c.openingIdeaSaid === true;
    undoUsedAtPly = c.undoUsedAtPly ?? null;
    // «Учитель» remembers what it has said (principles, topics, the plan, the lesson's rhythm) across the reload — a deep,
    // tolerant restore: an older or partial snapshot never leaves a lesson field undefined
    teachMemory = restoreTeachMemory(snapshot.teach?.memory ?? null);

    // the child's moves that never got their judgement (the tab was closed while the judge was looking)
    for (const move of snapshot.moves) {
      if (move.by === 'child' && !judgements.some((j) => j.ply === move.ply && j.uci === move.uci)) jobs.push({ ply: move.ply, fenBefore: move.fenBefore, uci: move.uci });
    }

    if (snapshot.clock.w !== null) clock.set('w', snapshot.clock.w);
    if (snapshot.clock.b !== null) clock.set('b', snapshot.clock.b);
    const last = snapshot.moves[snapshot.moves.length - 1];
    // the take-back question that was on the screen (its judged move is the last one on the board, not taken back)
    restoredOffer = null;
    const saved = snapshot.pendingOffer;
    if (saved && typeof saved === 'object' && last && last.by === 'child' && saved.ply === last.ply && saved.uci === last.uci) {
      const judgement = judgements.findLast((j) => j.ply === last.ply && j.uci === last.uci && !takenBackJudgements.has(j));
      const clockOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      if (judgement) restoredOffer = { judgement, childClockBefore: clockOf(saved.childClockBefore), botClockBefore: clockOf(saved.botClockBefore) };
    }
    set({ moves: [...snapshot.moves], lastMove: last ? { from: last.from, to: last.to } : null, openingName: snapshot.opening?.nameRu ?? null });
    return true;
  }

  // ───────────────────────── start ─────────────────────────

  async function start(requestedConfig: GameConfig, options: { resume?: ResumableGame | null } = {}): Promise<void> {
    if (config !== null || disposed) return;
    const resume = options.resume ?? null;
    // a continued game keeps its own settings, whatever the route said
    const routeConfig = resume ? resume.config : requestedConfig;
    config = routeConfig;
    persona = getPersona(routeConfig.personaId) ?? PERSONAS[routeConfig.personaId];
    timeControl = TIME_CONTROLS[routeConfig.timeControlId];
    set({ config: routeConfig, persona, timeControl });

    // An interrupted game nobody continues becomes an unfinished game in the journal — BEFORE the new game's own
    // snapshot takes its place — and parked games from an earlier session go out first (fire and forget).
    if (!resume || readResumableGame(deps.storage)?.gameId !== resume.gameId) settleResumableGame(deps.storage);
    // (their concept cards were heard even though the server has not counted them yet)
    parkedConcepts = readUnsavedGames(deps.storage).flatMap((record) => conceptIdsOf(record.events));
    // (the parked thoughts of a finished game go after the parked games: the game must be on the server first)
    track(
      flushUnsavedGames(deps.storage, (record) => deps.saveGame(record))
        .then(() => (deps.appendThoughts ? flushParkedThoughts(deps.storage, (id, list) => deps.appendThoughts?.(id, list) ?? Promise.resolve()) : 0))
        .then(() => undefined),
    );

    const profileLoad = withTimeout(deps.loadProfile(), timings.profileTimeoutMs, 'profile').catch((error: unknown) => {
      log('profile is unavailable — using defaults', error);
      return null;
    });
    // «Учитель» as White: the strategy is asked for (or the wizard's prefetch taken) as soon as the child's stage is
    // known — while the engines are still waking up (a continued game keeps the strategy of its snapshot)
    if (!resume && routeConfig.childColor === 'w' && deps.strategist) {
      void profileLoad.then((loaded) => {
        if (disposed || config === null) return;
        const stage = (loaded ?? profile).stage;
        const teacherGame = resolveCoachStyle(routeConfig, stage) === 'teacher' && timeControl.coachMode !== 'off' && routeConfig.examMode !== true;
        if (!teacherGame) return;
        if (loaded) profile = loaded;
        requestStrategy(strategyRequestFor());
      });
    }

    const [loadedProfile, judgeReady] = await Promise.all([
      profileLoad,
      withTimeout(deps.judge.ready(), timings.engineReadyTimeoutMs, 'judge.ready').then(
        () => true,
        (error: unknown) => {
          // a controller disposed during start-up (React StrictMode's first mount, a quick «Назад») is not a failure
          if (!disposed) log('the judge engine did not start — playing without move checks', error);
          return false;
        },
      ),
      // the bot falls back to random legal moves by itself; a failed handshake must not block the game
      withTimeout(deps.bot.ready(), timings.engineReadyTimeoutMs, 'bot.ready').catch((error: unknown) => {
        if (!disposed) log('the bot engine did not start', error);
      }),
    ]);
    if (disposed) return;
    if (loadedProfile) profile = loadedProfile;
    judgeOk = judgeReady;

    // the coach style (TEACHER-MODE §1.2) needs the child's stage; the resolved one is written back into the config
    // (examMode = style 'exam'), so the snapshot and the record carry a concrete style. A config without a style keeps
    // the behaviour from before teacher mode.
    coachStyle = resolveCoachStyle(routeConfig, profile.stage);
    const gameConfig: GameConfig = routeConfig.coachStyle === undefined ? routeConfig : { ...routeConfig, coachStyle, examMode: coachStyle === 'exam' };
    config = gameConfig;
    set({ config: gameConfig, coachStyle });

    chess = new Chess();
    startedAt = wallClock();
    startedAtMono = now();
    turnStartedAt = startedAtMono;
    gameId = makeGameId(startedAt, rng);
    clock = createGameClock({
      initialMs: timeControl.initialMs,
      incrementMs: timeControl.incrementMs,
      now,
      coachAutoResumeMs: timings.coachAutoResumeMs,
      onFlag,
      onChange: (snapshot) => set({ clock: { w: snapshot.w, b: snapshot.b, running: snapshot.running, paused: snapshot.paused } }),
    });

    const hintsEnabled = coachMode() !== 'off' && !gameConfig.examMode;
    const restored = resume !== null && restore(resume);
    if (resume !== null && !restored) {
      // the snapshot could not be put back on the board: it goes to the journal, the child gets a fresh game
      log('the saved game could not be restored — starting a new one');
      settleResumableGame(deps.storage);
      chess = new Chess();
    }
    // the lesson: ONE phrase book per game — the child's cross-game memory (localStorage) and, for a continued game, the
    // bag of this game from its snapshot; its own PRNG is seeded by the game (tests: by their rng). A continued game also
    // goes on with the snapshot's copy of the memory: the mini-lessons, wordings and habits of this game before the reload
    // are not in localStorage yet (finish() writes them, and counts the game once)
    try {
      const seed = deps.rng !== undefined ? Math.floor(rng() * 0x7fffffff) || 1 : lessonSeedOf(gameId);
      const stored = readLessonHistory(deps.storage);
      const history = restored ? resumedLessonHistory(resume?.lesson?.history, stored) : stored;
      book = createLessonBook({ seed, history, voice: lessonVoice, ...(restored && resume?.lesson?.book ? { game: resume.lesson.book } : {}) });
      if (!restored) book.newGame();
    } catch (error) {
      log('the phrase book could not be opened — a fresh one', error);
      book = createLessonBook({ seed: lessonSeedOf(gameId), voice: lessonVoice });
    }
    set({ profile, hintsEnabled, judgeUnavailable: !judgeOk, resumed: restored });
    syncBoard();
    if (!restored) {
      addEvent('gameStart', {
        gameId,
        personaId: gameConfig.personaId,
        timeControlId: gameConfig.timeControlId,
        childColor: gameConfig.childColor,
        examMode: gameConfig.examMode,
        coachMode: coachMode(),
        coachStyle,
        stage: profile.stage,
        startedAt: startedAt.toISOString(),
      });
    }

    deps.coach.setToolHost(toolHost);
    hintAvailability(hintsEnabled);
    unsubs.push(deps.coach.onHintRequested(() => void requestHint('dock')));
    // «Записи»: the «Спроси» chips of the dock (no microphone) — answered through sayEvent (the clock stands meanwhile)
    const offAsk = deps.coach.onAsk?.((question) => answerAsk(question));
    if (offAsk) unsubs.push(offAsk);
    const offTranscript = deps.coach.onTranscript?.((who, text) => {
      if (disposed || text.trim() === '') return;
      if (who === 'coach') noteCoachQuestion(text);
      if (who === 'coach' && recentCoachPhrases.includes(normalizePhrase(text))) return; // a template phrase, already journaled
      // the diary question is open and the child answers it aloud: the diary's answer (journaled by submitChildNote)
      if (who === 'child' && answersDiaryByVoice()) {
        submitChildNote(text, 'voice');
        return;
      }
      // the child's own words are part of the game's story: journaled whether a phrase or a question
      addEvent(who === 'child' ? 'childSaid' : 'coachSaid', { text: text.trim(), source: 'voice' }, currentPly());
      if (who === 'child') {
        armSilenceNudge(); // the child is not silent
        // after the record went out, the talk about the game follows it (with the question it answers)
        if (recordHandedOff) sendThought('voice', text, lastCoachQuestion);
      }
    });
    if (offTranscript) unsubs.push(offTranscript);
    const offConversation = deps.coach.onConversationState?.((state) => {
      conversationState = state;
      syncVoiceHold();
    });
    if (offConversation) unsubs.push(offConversation);
    const offLate = deps.coach.onLateSpeech?.((speaking) => syncLateHold(speaking));
    if (offLate) unsubs.push(offLate);
    // the click that started the game is the user gesture: a conversational coach may open its session now
    try {
      deps.coach.onGameStart?.({
        personaId: gameConfig.personaId,
        timeControlId: gameConfig.timeControlId,
        coachMode: coachMode(),
        examMode: gameConfig.examMode,
        childColor: gameConfig.childColor,
        resumed: restored,
        // the dock's «Совет» / no nudge; absent = the coach derives exactly this from examMode
        ...(gameConfig.coachStyle !== undefined || coachStyle === 'teacher' ? { coachStyle } : {}),
      });
    } catch (error) {
      log('coach.onGameStart failed', error);
    }
    const teaching = teacherOn();

    if (restored && teaching) {
      // the plan goes on where it was: the same strategy (no new request, no second theme), the latest re-plan
      const kept = sanitizeStrategy(resume?.config.strategy);
      if (kept) adoptStrategy(kept, null);
      restoreStrategyState(resume?.teach?.strategy);
      firstTeachSaid = true;
      themeSaid = kept !== null || teachMemory.lesson?.theme.announced === true;
    }

    if (restored) {
      const childToMove = chess.turn() === gameConfig.childColor;
      const offer = restoredOffer;
      restoredOffer = null;
      if (offer && !childToMove) {
        // the page went away while «вернуть ход?» was on the screen: the question comes back, the bot waits
        clock.start(chess.turn());
        resumeOffer(offer);
        return;
      }
      const resumedPhrase = sayEvent(buildGameResumed({ childToMove, profile }, rng));
      clock.start(chess.turn());
      if (childToMove && teaching) {
        holdTeach();
        enterChildTurn({ teach: { after: resumedPhrase } });
      } else if (childToMove) enterChildTurn();
      else track(botTurn(++epoch, 0));
      return;
    }

    setBotBubble({ kind: 'intro', text: pickLine(persona.lines.intro) });
    // «Привет!» when the app's hello was not heard (the wizard's remarks often cut it off): the game's
    // first line carries it — a wave, then the words. Unknown (no `helloHeard`) = heard: no extra hello.
    const greet = deps.helloHeard !== undefined && !safeCall(() => deps.helloHeard?.() ?? true, true);
    if (teaching) {
      // «Учитель» (one short line at the start, no reading out what is visible): no greeting —
      // the ONE line is the theme of the game (docs/TEACHING.md §2.1: an idea, never a move — the arrow and the advice come
      // with the first turn); without a strategy the first advice is that line. The journal still has the start event
      // above. Not heard the app's hello: one «Привет!» with a wave at once — the theme waits for the strategy (Black:
      // for the opponent's first move), the child should not start in silence.
      if (greet) {
        gameHelloWaved = true;
        void sayEvent(buildGameHello(profile, rng));
      }
      clock.start('w');
      if (gameConfig.childColor === 'w') {
        // the theme of the game first (it waits ≤ strategyWaitMs for the strategy); T0 of the first advice = its end (§2.1)
        holdTeach();
        enterChildTurn({ teach: { after: lessonStart() } });
      } else track(botTurn(++epoch, 0));
      return;
    }
    void sayEvent(buildGameStart({ persona, timeControl, childColor: gameConfig.childColor, profile, examMode: gameConfig.examMode, coachStyle, greet }, rng));
    // The opening reminder never holds the clock: a held clock also holds the BOT (it does not move while the coach
    // explains something), and a child who answers 1.e4 at once would watch a frozen opponent for the 10–20 s the
    // two opening phrases take to speak. Later reminders (after a punished decline) do pause, as the event asks.
    if (coachMode() === 'full' && !gameConfig.examMode && profile.stage <= 2) void sayEvent({ ...buildThinkingRoutine(profile, rng), pauseClock: false });

    clock.start('w');
    if (gameConfig.childColor === 'w') enterChildTurn();
    else track(botTurn(++epoch, 0));
  }

  /** A snapshot's plan state (tolerant: anything malformed is ignored). */
  function restoreStrategyState(saved: ResumeStrategyState | null | undefined): void {
    if (!saved || typeof saved !== 'object') return;
    if (saved.lineStatus === 'on' || saved.lineStatus === 'off' || saved.lineStatus === 'done' || saved.lineStatus === 'unknown') lineStatus = saved.lineStatus;
    if (typeof saved.lastReplanPly === 'number' && Number.isFinite(saved.lastReplanPly)) lastReplanPly = saved.lastReplanPly;
    if (saved.planPhase === 'opening' || saved.planPhase === 'middlegame' || saved.planPhase === 'endgame') planPhase = saved.planPhase;
    const kept = saved.replan;
    if (kept && typeof kept.fenKey === 'string' && typeof kept.answer?.ply === 'number') {
      // checked like a fresh answer: a plan in Russian, a preferred move only among what it was (its own move stays)
      const answer = acceptReplan({ ply: kept.answer.ply, candidates: kept.answer.preferredUci ? [{ uci: kept.answer.preferredUci, san: '', cp: 0, ideasRu: [] }] : [] }, kept.answer);
      if (answer) {
        replans.push({ answer, fenKey: kept.fenKey });
        set({ replan: answer });
      }
    }
  }

  // ───────────────────────── UI actions ─────────────────────────

  function selectSquare(square: Square): void {
    const state = get();
    if (disposed || state.phase !== 'childTurn' || state.pendingPromotion || !chess || !isSquare(square)) return;
    deps.coach.noteActivity?.();
    if (state.selected && state.selected !== square && state.legalTargets.some((target) => target.square === square)) {
      tryChildMove(state.selected, square);
      return;
    }
    const piece = chess.get(square);
    if (piece && piece.color === childColor() && state.selected !== square) {
      set({ selected: square, legalTargets: legalTargetsFrom(square) });
    } else {
      set({ selected: null, legalTargets: [] });
    }
  }

  function beginDrag(square: Square): void {
    const state = get();
    if (disposed || state.phase !== 'childTurn' || state.pendingPromotion || !chess || !isSquare(square)) return;
    const piece = chess.get(square);
    if (piece && piece.color === childColor()) set({ selected: square, legalTargets: legalTargetsFrom(square) });
  }

  function choosePromotion(piece: PromotionPiece | null): void {
    const pending = get().pendingPromotion;
    if (!pending) return;
    set({ pendingPromotion: null });
    if (piece) tryChildMove(pending.from, pending.to, piece);
  }

  function setModalOpen(open: boolean): void {
    if (open) holdClock('dialog');
    else releaseClock('dialog');
  }

  function dispose(): void {
    if (disposed) return;
    const phase = get().phase;
    const inProgress = config !== null && chess !== null && phase !== 'gameOver' && phase !== 'idle';
    if (inProgress) {
      // Leaving mid-game: the snapshot stays, and the next visit asks «Продолжить партию?». The journal reaches the
      // server exactly once — as the finished game, or as an unfinished one when the child starts a new game instead.
      const kept = persistNow();
      if (!kept && childMoveCount() >= MIN_CHILD_MOVES_TO_SAVE) {
        // no localStorage: the fallback — the journal is still worth keeping
        try {
          addEvent('gameEnd', { result: '*', termination: 'abandoned', outcome: 'unfinished' }, currentPly());
          const record = makeRecord('*', 'abandoned');
          void deps.saveGame(record).catch(() => storeUnsavedGame(deps.storage, record));
        } catch (error) {
          log('the abandoned game could not be saved', error);
        }
      }
    } else if (phase === 'gameOver' && ended !== null && !recordHandedOff && !persistClosed && childMoveCount() >= MIN_CHILD_MOVES_TO_SAVE) {
      // the result card was left before the record went out (diary question open, moves still being analysed)
      try {
        const record = makeRecord(ended.result, ended.termination);
        recordHandedOff = true;
        const storage = deps.storage;
        void deps.saveGame(record).catch(() => {
          storeUnsavedGame(storage, record);
        });
        closeSnapshot(); // the record is on its way (or parked): the shell must not see a half-delivered game
      } catch (error) {
        log('the finished game could not be saved on the way out', error);
      }
    }
    if (config !== null && phase !== 'idle') notifyGameEnd({ result: ended?.result ?? '*', termination: ended?.termination ?? 'left' });
    closeQuiz();
    disposed = true;
    epoch += 1;
    releaseVoiceHold();
    abortStrategist();
    clearThreatTimer();
    clearSilenceTimer();
    clearLessonTimers();
    if (teachHoldTimer !== null) clearTimeout(teachHoldTimer);
    teachHoldTimer = null;
    if (noteTimer !== null) clearTimeout(noteTimer);
    if (declineTimer !== null) clearTimeout(declineTimer);
    noteResolve?.();
    noteResolve = null;
    // the child's words not sent yet wait in localStorage for the next game start
    thoughts?.close();
    if (bubbleTimer !== null) clearTimeout(bubbleTimer);
    for (const unsub of unsubs.splice(0)) unsub();
    clock?.dispose();
    deps.coach.setToolHost(null);
    hintAvailability(true);
    deps.coach.clearAnnotations?.();
    deps.coach.stopSpeaking({ clearBubble: true });
    try {
      deps.judge.dispose();
    } catch (error) {
      log('judge.dispose failed', error);
    }
    try {
      deps.bot.dispose();
    } catch (error) {
      log('bot.dispose failed', error);
    }
  }

  async function whenSettled(): Promise<void> {
    // work may schedule more work: wait until the chain stops growing
    let seen: Promise<void> | null = null;
    while (seen !== activity) {
      seen = activity;
      await seen;
    }
    await ending;
  }

  return {
    store,
    start,
    selectSquare,
    beginDrag,
    dropPiece: (from, to) => tryChildMove(from, to),
    choosePromotion,
    acceptTakeback,
    declineTakeback,
    requestHint,
    undoLastMove: () => voluntaryTakeback('button'),
    giveDeclineReason,
    answerQuiz,
    submitChildNote,
    touchChildNote,
    tapThought,
    persistNow,
    resign,
    setModalOpen,
    dismissBotBubble: () => setBotBubble(null),
    toolHost,
    whenSettled,
    dispose,
  };
}
