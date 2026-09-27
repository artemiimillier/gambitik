/**
 * Types of the live game module: the reactive state read by GameScreen, and the dependencies the
 * game controller needs (all injectable — tests run without Worker, DOM, network or sound).
 */
import type { LessonVoicePolicy, RepertoirePlanLike, TeachMode } from '@gambit/core';
import type {
  BoardAnnotations,
  CoachEvent,
  CoachMode,
  CoachStyle,
  CoachToolHost,
  Color,
  ConceptCard,
  ConversationState,
  GameRecord,
  GameResult,
  GameStrategy,
  GameSummary,
  GameThought,
  IBotEngine,
  IJudgeEngine,
  LessonQuiz,
  MascotPose,
  MoveJudgement,
  Persona,
  PersonaId,
  PieceType,
  ReplanRequest,
  ReplanResponse,
  Square,
  StrategyCard,
  StrategyRequest,
  StudentProfile,
  Talkativeness,
  TeachAdvice,
  Termination,
  TimeControl,
  TimeControlId,
} from '@gambit/shared';

// ───────────────────────── state machine ─────────────────────────

/**
 * ARCHITECTURE §2:
 *   idle → childTurn → judging → (coachIntervention →) botThinking → childTurn … → gameOver
 */
export type GamePhase = 'idle' | 'childTurn' | 'judging' | 'coachIntervention' | 'botThinking' | 'gameOver';

/**
 * How the coach helps in a game (docs/TEACHER-MODE.md §1) as the route asks for it: a `CoachStyle`, or 'auto' =
 * `defaultCoachStyle(timeControl, profile.stage)` once the profile is loaded (a route without `coach=`).
 */
export type GameCoachStyle = CoachStyle | 'auto';

export interface GameConfig {
  personaId: PersonaId;
  timeControlId: TimeControlId;
  childColor: Color;
  /** derived from the coach style when one is given (`coachStyle === 'exam'`) */
  examMode: boolean;
  /**
   * The coach style (TEACHER-MODE §1.2). Absent = the behaviour before teacher mode (`examMode ? 'exam' : 'helper'`);
   * a style the time control does not offer (teacher in blitz) becomes `defaultCoachStyle`. The controller writes the
   * resolved style back into its config (snapshot and record carry a concrete one).
   */
  coachStyle?: GameCoachStyle;
  /**
   * «Учитель»: the strategy this game is played with (the smart strategist, POST /coach/strategy). A new game gets it
   * through `GameDeps.strategist` (prefetched by the wizard); the controller writes it back here once it is known, so
   * the resume snapshot keeps it and a continued game goes on with the same plan. null / absent = none (yet).
   */
  strategy?: GameStrategy | null;
}

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

/** One move of the main line (what is on the board right now). */
export interface MoveEntry {
  /** 1-based: ply 1 is White's first move */
  ply: number;
  color: Color;
  by: 'child' | 'bot';
  san: string;
  uci: string;
  from: Square;
  to: Square;
  fenBefore: string;
  fenAfter: string;
  /** mover's remaining clock right after the move; null = untimed */
  clockMs: number | null;
  /** time the mover spent on this move */
  spentMs: number;
  captured?: PieceType;
}

export interface LegalTarget {
  square: Square;
  capture: boolean;
}

export interface PendingPromotion {
  from: Square;
  to: Square;
  color: Color;
}

/** Bots never speak aloud — their lines appear in a text bubble next to the avatar. */
export interface BotBubble {
  kind: 'intro' | 'goodMove' | 'win' | 'lose' | 'draw';
  text: string;
}

export interface TakebackOfferState {
  ply: number;
  san: string;
  judgement: MoveJudgement;
}

export type SaveStatus = 'pending' | 'saved' | 'local' | 'skipped';

/** What happens after the last move: missing judgements → record → save. */
export interface EndingState {
  stage: 'analysing' | 'saving' | 'done';
  /** judgements finished / to do in the 'analysing' stage */
  judged: number;
  toJudge: number;
  save: SaveStatus;
}

/** Effort-based stars (ARCHITECTURE §6: «stars for effort»). Halves are possible. */
export interface StarsBreakdown {
  total: number;
  /** played the game to the end */
  finished: boolean;
  /** few blunders stayed on the board — the thinking routine was used */
  careful: boolean;
  /** took a second look when the coach asked (or never needed to) */
  listened: boolean;
  /** stars taken off for leaning on hints (0, 0.5 or 1) */
  hintPenalty: number;
}

export interface ClockView {
  w: number | null;
  b: number | null;
  running: Color | null;
  paused: boolean;
}

export interface GameState {
  phase: GamePhase;
  config: GameConfig | null;
  persona: Persona | null;
  timeControl: TimeControl | null;
  profile: StudentProfile | null;
  /** current position */
  fen: string;
  turn: Color;
  moves: MoveEntry[];
  lastMove: { from: Square; to: Square } | null;
  /** king square of the side in check */
  checkSquare: Square | null;
  selected: Square | null;
  legalTargets: LegalTarget[];
  pendingPromotion: PendingPromotion | null;
  /** arrows / highlights owned by the game (hints, danger squares after a take-back) */
  annotations: BoardAnnotations | null;
  clock: ClockView;
  takeback: TakebackOfferState | null;
  /** highest hint level given for the current move (0 = none yet) */
  hintLevel: 0 | 1 | 2 | 3 | 4;
  hintBusy: boolean;
  /** the «Подсказка» button pulses after an accepted take-back */
  hintPulse: boolean;
  /** hints are possible at all in this game (coach not 'off', not an exam) */
  hintsEnabled: boolean;
  botBubble: BotBubble | null;
  openingName: string | null;
  result: GameResult;
  termination: Termination | null;
  ending: EndingState | null;
  summary: GameSummary | null;
  stars: StarsBreakdown | null;
  /** id under which the game was saved (server or local queue); null when nothing was saved */
  savedGameId: string | null;
  record: GameRecord | null;
  /** the engines could not be started at all — the game still works, without the coach's checks */
  judgeUnavailable: boolean;
  /** the bot engine failed at least once: the opponent plays random legal moves (shown as a note) */
  botUnavailable: boolean;
  /** «Вернуть ход» is possible right now: untimed non-exam game, the child's turn, the last own move not undone yet */
  canUndo: boolean;
  /** after «Оставлю свой ход»: three tappable reasons are on offer for the move of this ply (never blocks the game) */
  declineReasons: { ply: number } | null;
  /** the one-sentence diary question on the result card («Что было самым трудным?») */
  note: ChildNoteStatus;
  /** this game was continued from a saved snapshot («Продолжить партию?») */
  resumed: boolean;
  /** the resolved coach style of the running game (null before start) */
  coachStyle: CoachStyle | null;
  /** «Учитель»: the advice of the child's current move (green / blue arrows live until the child moves); null = none */
  advice: TeachAdvice[] | null;
  /** «Учитель»: a hidden «сокровище» waits for the child (the arrow comes at `revealAt`, monotonic ms) */
  treasure: { ply: number; revealAt: number } | null;
  /** «Учитель»: how much engine the last advice had (§2.1 degradation; 'rules' = no engine, opening moves only) */
  teachMode: TeachMode | null;
  /** «Учитель»: the strategy of this game once it is known (title / idea for the screen and the e2e); null = none */
  strategy: GameStrategy | null;
  /** «Учитель»: the smart model's latest accepted re-plan (its `ply` = the child's move it was made for); null = none */
  replan: ReplanResponse | null;
  /**
   * «Учитель» (docs/TEACHING.md §2.4): the question with three buttons of the child's current move — the card on
   * the screen; `answeredId` = the tapped option (the card stays a moment with the right one marked), `streak` = right
   * answers in a row before it. null = no card. Never restored after a reload.
   */
  quiz: GameQuiz | null;
  /** The lesson (§2.9): the ONE takeaway of the finished game (the result card shows it); null = none */
  takeaway: string | null;
  /** The lesson: the questions of this game — right answers / asked (the result card: «Ответил на 3 из 4»); null = no quiz */
  quizScore: { right: number; total: number } | null;
  /** The lesson: the «Тема: …» badge of a teacher game (stages 3–5: the card's title, 1–2: a short family label); null = none */
  themeBadge: string | null;
}

/** The quiz card of the game screen: the lesson's question and the child's answer so far. */
export type GameQuiz = LessonQuiz & { answeredId: string | null; streak: number };

/** 'asking' = the record waits for the child's sentence (or «Пропустить»); it is journaled BEFORE the record is posted. */
export type ChildNoteStatus = 'none' | 'asking' | 'saved' | 'skipped';

/** Longest sentence the diary takes. */
export const CHILD_NOTE_MAX_CHARS = 200;

/** The diary question of the result card — also the question a late or spoken answer belongs to in the journal. */
export const CHILD_NOTE_QUESTION_RU = 'Что было самым трудным в этой партии?';

// ───────────────────────── dependencies ─────────────────────────

/** The part of the coach controller the game uses (`coach` from apps/web/src/coach satisfies it). */
export interface GameCoach {
  say(event: CoachEvent): Promise<void>;
  /**
   * `grace` = the child moved while the coach speaks: waiting phrases go at once, the sentence being said may end
   * (a coach controller without it simply stops).
   */
  stopSpeaking(opts?: { clearBubble?: boolean; grace?: boolean }): void;
  setToolHost(host: CoachToolHost | null): void;
  onHintRequested(cb: () => void): () => void;
  /**
   * «Записи» (docs/voice-clips/SPEC.md §8.2): the dock's «Спроси» chips — the game answers each through its own
   * `sayEvent`, so the child's clock stands while the answer plays. Optional: a coach without it has no chips.
   */
  onAsk?(cb: (question: 'why' | 'opponent' | 'hint' | 'repeat') => void): () => void;
  /** «Записи» speaks now: builders may add their clip twins (`CoachEvent.clip`). Optional: absent = false. */
  readonly clipVoice?: boolean;
  noteActivity?(): void;
  clearAnnotations?(): void;
  onTranscript?(cb: (who: 'child' | 'coach', text: string) => void): () => void;
  /**
   * Tells the dock whether «Подсказка» makes sense in this game (false in exams and bullet — the round
   * hint button should be hidden there). Optional — a coach controller without it keeps its button.
   */
  setHintAvailable?(available: boolean): void;
  /**
   * Silent context for a conversational voice model (contracts: `VoiceLayer.pushContext`): short Russian notes
   * without notation after every bot move and judgement. Optional — older coach controllers do not have it.
   */
  pushContext?(note: string): void;
  /**
   * A game begins (a fresh one or a continued one): a conversational coach may open its session now — the click
   * that started the game is the user gesture — unless the game is 1-minute bullet (silent coach) or settings say no.
   * Optional: a coach controller without it keeps its lazy behaviour.
   */
  onGameStart?(info: GameConversationInfo): void;
  /** The game is over (or left): the coach may close the conversation after its last words. Optional. */
  onGameEnd?(info: { result: GameResult; termination: Termination | 'left' }): void;
  /**
   * State of the conversational session (contracts: `ConversationState`) — the game only nudges a silent child to
   * think aloud while somebody is really listening. Optional: without it the game never sends that nudge.
   */
  onConversationState?(cb: (state: ConversationState) => void): () => void;
  /** The same state, read on demand (the app's coach controller exposes it as a getter). Optional. */
  readonly conversationState?: ConversationState;
  /**
   * The talkativeness setting of the coach. In «Учитель» it sets the LENGTH of the teacher's utterances, never whether
   * they happen (TEACHER-MODE §2.7). Optional: without it the game assumes 'normal'.
   */
  readonly talkativeness?: Talkativeness;
  /**
   * The lesson model (docs/TEACHING.md §4.4): the server allows generative AI in the child's game (`health.ai.runtime`).
   * false / absent = no strategist re-plans (and no «Поговорить», the coach's own business). Optional: absent = false.
   */
  runtimeAi?(): boolean;
  /** The lesson: the game's quiz card is open — the dock hides «Спроси» until false. Optional. */
  setAskSuppressed?(suppressed: boolean): void;
  /**
   * A pose without words (a quiet turn's short nod, the joy over a find when the praise cap is reached — never an
   * empty bubble, no sound). Held for `ms`; a phrase being said keeps its own pose. Optional: absent = nothing shows.
   */
  showPose?(pose: MascotPose, ms: number): void;
  /**
   * The lesson (docs/TEACHING.md §4.6): the phrase being said now is really played aloud — a sounding voice, not muted, no
   * click still needed, not a «не озвучено» lesson phrase (nothing being said = false). false: the child only reads the
   * bubble, so the calm advice's arrow comes after the reading time, not after the silent layer's end (up to 9 s).
   * Optional: absent = the game waits for `say()` to end.
   */
  speaksAloud?(): boolean;
  /**
   * «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): the lesson book asks it on EVERY pick — a policy = prefer wordings that already
   * play in the recorded voice; null = the default book, byte for byte (another voice, muted, automation). Optional:
   * absent = null.
   */
  voicePolicy?(): LessonVoicePolicy | null;
  /**
   * «Дозапись голоса» (G2): the board changed — every ply, every take-back. A phrase recorded while its bubble was up is
   * played late only while the position it spoke about is still on the board. Optional: absent = nothing to cut.
   */
  noteBoardChange?(): void;
  /**
   * «Дозапись голоса» (G2): a phrase played late — outside `say()`, so no clock hold of `say` covers it — starts (true)
   * and stops (false) sounding; the game holds the child's clock meanwhile. Optional: absent = nothing is played late.
   */
  onLateSpeech?(cb: (speaking: boolean) => void): () => void;
}

/** What the coach learns when a game starts. */
export interface GameConversationInfo {
  personaId: PersonaId;
  timeControlId: TimeControlId;
  coachMode: CoachMode;
  examMode: boolean;
  childColor: Color;
  /** true when the game continues a saved one */
  resumed: boolean;
  /**
   * The resolved coach style: «Совет» instead of «Подсказка» in the dock, no nudge in «Учитель» / «Экзамен». Sent when
   * the route named a style (or «Учитель» was chosen by default); absent = `examMode ? 'exam' : 'helper'`.
   */
  coachStyle?: CoachStyle;
}

/**
 * The content «Учитель» reads (TEACHER-MODE §3): the repertoire plan and the main-line table of @gambit/content, the
 * Russian opening names of @gambit/openings and the concept cards. Injectable (tests pass the real modules, the
 * browser wiring preloads the opening book so that the synchronous name lookup works).
 */
export interface TeacherContent {
  /** `getRepertoirePlan(historySan, childColor)` */
  repertoirePlan(history: readonly string[], childColor: Color): RepertoirePlanLike | null | undefined;
  /** `mainLineMoves(fen)` — curated frequent moves of the position (English SAN) */
  mainLineMoves(fen: string): readonly string[];
  /** `lookupOpening(fen)?.nameRu` — synchronous; undefined while the book is not loaded */
  openingNameRu(fen: string): string | undefined;
  /** `getConceptCard(id)` */
  conceptCard(id: string): ConceptCard | undefined;
}

/**
 * «Учитель»: the smart strategist (server: codex «Sol» → OpenRouter → deterministic template). The game asks it for
 * the strategy of the game and for re-plans; it never waits for it longer than its timings allow, and it checks every
 * answer (a strategy needs a Russian title and intro, a re-plan may only pick one of the engine candidates it was given).
 */
export interface GameStrategist {
  /** The strategy of this game — a prefetched answer when the wizard asked already. null = none (the teacher goes on without). */
  strategy(request: StrategyRequest, opts?: { signal?: AbortSignal }): Promise<GameStrategy | null>;
  /** A re-plan for the child's position of `request.ply`; the answer is checked with `acceptReplan` (strategy.ts). */
  replan(request: ReplanRequest, opts?: { signal?: AbortSignal }): Promise<ReplanResponse | null>;
  /** The curated card of a strategy (its line of the child's moves); optional — without it only the phase and the repertoire trigger re-plans. */
  card?(strategyId: string): StrategyCard | undefined;
}

export type GameSoundName = 'move' | 'capture' | 'check' | 'win' | 'lose' | 'oops' | 'star';

export interface OpeningLookup {
  eco: string;
  name: string;
  nameRu?: string;
}

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface GameTimings {
  /** how long start() waits for the two engine handshakes */
  engineReadyTimeoutMs: number;
  profileTimeoutMs: number;
  /** background MultiPV analysis of the child's position (cache for judgeMove, hints, threat warnings) */
  backgroundDepth: number;
  backgroundMovetimeMs: number;
  backgroundMultipv: number;
  /** movetime caps added to judgeMove's depth-limited searches */
  quickMovetimeMs: number;
  confirmMovetimeMs: number;
  /** a live judgement slower than this is abandoned — the game goes on, the move is judged after the game */
  judgeTimeoutMs: number;
  /** per-move and total limits of the post-game «missing judgements» pass */
  postGameJudgeTimeoutMs: number;
  postGameBudgetMs: number;
  /** pickMove slower than this → random legal move */
  botTimeoutMs: number;
  /** the bot never answers faster than this after the child's move */
  minBotDelayMs: number;
  /** how long a hint waits for the background analysis before using what is there */
  hintWaitMs: number;
  botBubbleMs: number;
  /**
   * After the BOT's move: the child gets this long to notice a new danger alone (a piece en prise, the opponent's
   * mate / tactic threat) before the coach speaks up (design D).
   */
  threatWarningDelayMs: number;
  /** the opponent's null-move threat search, run after the background analysis of the child's position */
  threatSearchDepth: number;
  threatSearchMovetimeMs: number;
  /**
   * untimed / 10-minute games: no move and no word from the child for this long → one invitation to think aloud.
   * ≤ 0 = the game never nudges (the coach controller does it itself — see gameDeps.ts).
   */
  silenceNudgeMs: number;
  /** …never again within this long */
  silenceNudgeRepeatMs: number;
  /** «а если я пойду…?» (CoachToolHost.evaluateMove): total budget, and the movetime of each search in it */
  evaluateMoveTimeoutMs: number;
  evaluateMoveMovetimeMs: number;
  saveRetryDelayMs: number;
  coachAutoResumeMs: number;
  /**
   * how long the finished game waits for the child's diary sentence before it is saved without one (typing restarts
   * it); with `appendThoughts` the question stays open after that — a late answer follows the record
   */
  childNoteWaitMs: number;
  /** the child's words after the record went out wait this long for the ones that follow, then go to the server */
  thoughtsSendDelayMs: number;
  /** how long the three «почему оставил ход» answers stay on screen */
  declineReasonsMs: number;
  // ───── «Учитель» (docs/TEACHER-MODE.md §2.1, §2.2, §2.6) ─────
  /** the teachTurn goes out at most this long after the bot's move is shown (T0) */
  teachDeadlineMs: number;
  /** step 1 of the pipeline: MultiPV-3 until this depth … */
  teachMinDepth: number;
  /** … or this long after T0 (then a shallower analysis is used) */
  teachAnalysisMs: number;
  /** below this depth (even after `backgroundMovetimeMs`) the teacher works «by the rules» */
  teachFallbackDepth: number;
  /** timed games (10 and 5 minutes): the child's clock stands at most this long per teacher utterance */
  teachHoldMaxMs: number;
  /**
   * a hidden «сокровище» gets its arrow after this long on stages 1–2 (×1.5 on stages 3–5). The lesson's own
   * times (reveal, «Сам», quiz, the treasure hints) come from core and are scaled by `treasureRevealMs / 10 000` —
   * the default 10 000 keeps them as they are, tests shorten them all at once.
   */
  treasureRevealMs: number;
  /** movetime of one `searchmoves` verification of a book move (≤ 2 per turn) */
  teachVerifyMovetimeMs: number;
  // ───── «Учитель» + the smart strategist ─────
  /**
   * The FIRST teacher line (the strategy intro) waits at most this long for the strategy, counted from its request
   * (White: the wizard's prefetch / the game start; Black: the moment the bot decided its first move). Later it is
   * used from the next move on. Every other teacher line keeps `teachDeadlineMs` and never waits for the model.
   */
  strategyWaitMs: number;
  /** A re-plan waits for the (prewarmed) analysis of the child's position until this depth… */
  replanMinDepth: number;
  /** …or this long after the bot's move was decided; then it uses what is there (nothing = no re-plan). */
  replanWaitMs: number;
  /** middlegame / endgame: re-plan at least every this many plies */
  replanEveryPlies: number;
  /** the child has less than this on the clock: the only time words ever touch the clock («Поторопись!», once) */
  hurryBelowMs: number;
  // ───── the lesson (docs/TEACHING.md §4.6) ─────
  /**
   * The green arrow of a calm advice comes after its sentence (cue `at: 'end'`). The reading time
   * max(adviceArrowMinMs, adviceArrowPerWordMs × words) capped at adviceArrowMaxMs counts from the moment its words come
   * up (every phrase the game gave the coach before it is over). Said aloud (`coach.speaksAloud()`): when the coach says
   * the phrase is over, never before the reading time. Nothing heard (the silent layer, muted, «не озвучено»): at the
   * reading time — not at the silent layer's end (up to 9 s). Never later than adviceArrowWaitMaxMs after it was given.
   */
  adviceArrowMinMs: number;
  adviceArrowPerWordMs: number;
  adviceArrowMaxMs: number;
  adviceArrowWaitMaxMs: number;
  /** the quiz card holds both clocks ('quiz' hold) at most this long */
  quizHoldMaxMs: number;
  /** after an answer the card stays this long with the right option marked */
  quizCloseMs: number;
}

export interface GameDeps {
  /** The controller takes ownership of both engines and disposes them. */
  judge: IJudgeEngine;
  bot: IBotEngine;
  coach: GameCoach;
  loadProfile(): Promise<StudentProfile>;
  saveGame(record: GameRecord): Promise<{ id: string }>;
  /**
   * `POST /games/:id/thoughts`: the child's words about the game that come after its record went out (the talk after
   * the game, a late diary answer). Absent = they stay only in this page's journal.
   */
  appendThoughts?(gameId: string, thoughts: GameThought[]): Promise<unknown>;
  /** named opening for the FENs after every ply (lazy-loaded book); optional */
  lookupOpening?(fens: readonly string[]): Promise<OpeningLookup | undefined>;
  storage?: KeyValueStorage | null;
  playSound?(name: GameSoundName): void;
  /** confetti for a win */
  celebrate?(): void;
  /** monotonic milliseconds (default performance.now) */
  now?(): number;
  /** wall clock for ids and PGN dates (default () => new Date()) */
  wallClock?(): Date;
  rng?(): number;
  timings?: Partial<GameTimings>;
  log?(message: string, error?: unknown): void;
  /** «Учитель»: repertoire, main lines, opening names, concept cards (defaults: teacherContent.ts) */
  teacherContent?: Partial<TeacherContent>;
  /** «Учитель»: the smart strategist (strategy of the game, re-plans). Absent = the teacher without a strategy. */
  strategist?: GameStrategist | null;
  /**
   * Was Гамбитик heard saying hello recently (the shell's greeting, a previous game's start)? false → the game's first
   * line carries «Привет!» (he waves and then talks when the game starts; the wizard's remarks often cut the
   * shell's hello). Absent (tests) = assumed heard: no extra hello.
   */
  helloHeard?(): boolean;
}
