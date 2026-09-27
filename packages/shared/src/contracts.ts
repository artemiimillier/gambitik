/**
 * CONTRACTS — single source of truth for cross-module types.
 * Every package imports these types; a contract is changed here, never redefined locally.
 *
 * Conventions:
 *  - Squares are algebraic ('e4'), moves are UCI ('e2e4', 'e7e8q') unless a field says San.
 *  - All evals inside MoveJudgement are from the MOVER's point of view.
 *  - EngineLine scores are from the SIDE-TO-MOVE point of view (raw UCI).
 *  - All child-facing text is Russian.
 */

// ───────────────────────── ids & basics ─────────────────────────

export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Square = string;

export const PERSONA_IDS = ['petya', 'sonya', 'grisha', 'sasha', 'vika', 'lyova', 'nika', 'dima'] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

export const TIME_CONTROL_IDS = ['bullet1', 'blitz5', 'rapid10', 'training'] as const;
export type TimeControlId = (typeof TIME_CONTROL_IDS)[number];

/** How much the coach may intervene during a live game. */
export type CoachMode = 'off' | 'light' | 'full';

export interface TimeControl {
  id: TimeControlId;
  /** Russian label, e.g. '5 минут'. */
  label: string;
  /** null = no clock (training). */
  initialMs: number | null;
  incrementMs: number;
  coachMode: CoachMode;
}

export const TIME_CONTROLS: Record<TimeControlId, TimeControl> = {
  bullet1: { id: 'bullet1', label: '1 минута', initialMs: 60_000, incrementMs: 0, coachMode: 'off' },
  blitz5: { id: 'blitz5', label: '5 минут', initialMs: 300_000, incrementMs: 0, coachMode: 'light' },
  rapid10: { id: 'rapid10', label: '10 минут', initialMs: 600_000, incrementMs: 0, coachMode: 'full' },
  training: { id: 'training', label: 'Тренировка без часов', initialMs: null, incrementMs: 0, coachMode: 'full' },
};

// ───────────────────────── engine ─────────────────────────

export interface EvalScore {
  /** centipawns; null when mate is set */
  cp: number | null;
  /** mate in N (positive = the POV side mates); null when cp is set */
  mate: number | null;
}

export interface EngineLine extends EvalScore {
  multipv: number;
  depth: number;
  pvUci: string[];
}

export interface AnalyzeOptions {
  depth?: number;
  movetimeMs?: number;
  nodes?: number;
  multipv?: number;
  /** restrict the search to these root moves (UCI) */
  searchmoves?: string[];
}

export interface AnalysisResult {
  fen: string;
  /** sorted by multipv ascending; lines[0] is the best line */
  lines: EngineLine[];
  bestmove: string;
  depth: number;
  timeMs: number;
}

/** Full-strength analysis engine used by the coach. Never shared with the bot engine. */
export interface IJudgeEngine {
  ready(): Promise<void>;
  /** Rejects on engine CRITICAL ERROR, watchdog timeout, or if superseded by stop(). */
  analyze(fen: string, opts: AnalyzeOptions): Promise<AnalysisResult>;
  stop(): void;
  dispose(): void;
}

export interface BotMove {
  uci: string;
  /** human-like delay the UI should wait before showing the move (already includes search time) */
  thinkMs: number;
}

export interface IBotEngine {
  ready(): Promise<void>;
  pickMove(fen: string, personaId: PersonaId, ctx: { moveNumber: number; remainingMs: number | null }): Promise<BotMove>;
  dispose(): void;
}

/** Bot strength config for the custom sampler (see docs/research/02-engines-bots.md). */
export interface BotLevelConfig {
  personaId: PersonaId;
  nominalElo: number;
  /** 'sampler' = depth-limited MultiPV softmax sampler; 'full' = plain best move with movetime */
  mode: 'sampler' | 'full';
  depth?: number;
  multipv?: number;
  /** probability of a uniformly random legal move */
  pRandom?: number;
  /** softmax temperature in centipawns */
  tempCp?: number;
  /** never pick a move losing more than this vs the best line (cp) */
  maxLossCp?: number;
  movetimeMs?: number;
}

// ───────────────────────── judgement & facts ─────────────────────────

export type MoveClass = 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'missedWin';

export type MotifId =
  | 'hangingPiece'
  | 'freeCapture'
  | 'badTrade'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'discoveredAttack'
  | 'doubleCheck'
  | 'removeDefender'
  | 'trappedPiece'
  | 'backRankMate'
  | 'mateIn1'
  | 'mateIn2'
  | 'mateIn3'
  | 'promotion'
  | 'kingSafety'
  | 'development'
  | 'center';

export interface MoveJudgement {
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  evalBefore: EvalScore;
  evalAfter: EvalScore;
  /** 0..100, lichess formula, mover POV */
  winPctBefore: number;
  winPctAfter: number;
  /** max(0, winPctBefore - winPctAfter) */
  winPctLoss: number;
  classification: MoveClass;
  /** 0..100 lichess move accuracy */
  accuracy: number;
  bestUci: string;
  bestSan: string;
  bestPvSan: string[];
  /** opponent's best reply line after the played move (how the mistake gets punished) */
  refutationPvSan: string[];
  refutationPvUci: string[];
  /** motif of the refutation (what the child allowed) */
  allowedMotif?: MotifId;
  /** motif of the best move (what the child missed) */
  missedMotif?: MotifId;
  /** material the mover loses along the refutation within ~4 plies, in pawns (0 if none) */
  materialLossPawns: number;
  /** 'quick' = shallow gate search only; 'confirmed' = re-searched deeper and still bad */
  confidence: 'quick' | 'confirmed';
}

export interface PieceRef {
  square: Square;
  piece: PieceType;
  color: Color;
}

export interface HangingPiece extends PieceRef {
  attackers: Square[];
  defenders: Square[];
  /** expected material loss by static exchange evaluation, centipawns (>0 means it can be won) */
  seeLossCp: number;
}

export interface Threat {
  /** the threatening move of the opponent if the mover passes (null-move search) */
  uci: string;
  san: string;
  motif: MotifId;
  targetSquares: Square[];
  gainCp: number;
}

export interface PositionFacts {
  fen: string;
  sideToMove: Color;
  phase: 'opening' | 'middlegame' | 'endgame';
  inCheck: boolean;
  legalMoveCount: number;
  /** material in pawns (p=1,n=3,b=3,r=5,q=9); diff = w - b */
  material: { w: number; b: number; diff: number };
  /** hanging / en-prise pieces of BOTH colours */
  hanging: HangingPiece[];
  /** minor pieces developed (0..4) */
  development: { w: number; b: number };
  castled: { w: boolean; b: boolean };
  canStillCastle: { w: boolean; b: boolean };
  /** number of central squares (d4,e4,d5,e5) occupied or attacked by pawns */
  centerControl: { w: number; b: number };
  openingName?: string;
}

// ───────────────────────── coach ─────────────────────────

export type MascotPose = 'idle' | 'wave' | 'talk' | 'think' | 'cheer' | 'oops' | 'sleep' | 'listen';

export type AnnotationColor = 'green' | 'red' | 'yellow' | 'blue';

export interface BoardAnnotations {
  arrows: { from: Square; to: Square; color: AnnotationColor }[];
  highlights: { square: Square; color: AnnotationColor }[];
}

export type CoachEventKind =
  | 'greeting'
  | 'gameStart'
  | 'praise'
  | 'takebackOffer'
  | 'hint'
  | 'explainBest'
  | 'threatWarning'
  | 'botMoveComment'
  | 'gameEnd'
  | 'reviewMoment'
  | 'encourage'
  | 'thinkingRoutine'
  | 'answer'
  | 'teachTurn'
  | 'teachReaction';

/**
 * How the coach helps during a game (docs/TEACHER-MODE.md): 'teacher' = proactive advice with arrows and reasons
 * every turn, 'helper' = on request (hint ladder, take-back offers, threat warnings), 'exam' = silent until the end.
 */
export type CoachStyle = 'teacher' | 'helper' | 'exam';

/** Honesty tier of an advised move: what the coach may say about how common it is. */
export type AdviceSource = 'repertoire' | 'mainLine' | 'book' | 'engine';
/**
 * What an utterance of «Учитель» is. The first five are the teacher's move moments; the rest belong to the lesson
 * model (docs/TEACHING.md): the theme of the game, a button quiz and its answer, a mini-lesson, the takeaway.
 */
export type TeachMoment = 'turn' | 'openingPlan' | 'repeat' | 'reveal' | 'reaction' | 'theme' | 'quiz' | 'answer' | 'mini' | 'takeaway';

// ───────────────────────── lesson model (docs/TEACHING.md) ─────────────────────────

/**
 * What the board highlights while a phrase is spoken (docs/TEACHING.md §3). The voice never names a square — it
 * names the piece and the idea («оттуда конь будет бить вот эти клетки»), the board shows where.
 */
export type CueKind =
  | 'move' // the arrow of the advised move
  | 'attacks' // squares the moved piece will attack after the move («куда будет стрелять конь»)
  | 'line' // a file / rank / diagonal a rook, bishop or queen takes or opens
  | 'flank' // the king's side (files e–h) or the queen's side (a–d)
  | 'center' // d4, e4, d5, e5
  | 'capture' // the piece we are going to capture (+ the arrow to it)
  | 'threat' // the opponent's threat: his attacking arrow + its targets
  | 'hanging' // an unprotected piece
  | 'piece' // the piece the phrase is about
  | 'king' // a king: castling, safety, mate
  | 'weak' // the weak pawn next to the king (f7 / f2)
  | 'path' // a passed pawn's road to promotion
  | 'defend' // the piece we defend
  | 'lastMove'; // the child's previous move («Зачем мы так сходили?»)

/** A board cue resolved by code from the position. Empty `squares` = the code could not resolve it (the words stay true). */
export interface LessonCue {
  kind: CueKind;
  /** 0-based index of the sentence of `text` during which the board shows it */
  sentence: number;
  squares: Square[];
  arrows?: { from: Square; to: Square }[];
  tone: 'good' | 'danger' | 'info';
  /**
   * when the board shows it: 'start' = as the sentence starts (danger, rescue), 'end' = after the sentence is said —
   * the advice arrow of a calm turn appears only after its WHY was heard (docs/TEACHING.md §2.2). Absent = 'start'.
   */
  at?: 'start' | 'end';
}

export type QuizKind = 'oppIdea' | 'whichPiece' | 'canCapture' | 'checkEscape' | 'danger' | 'why';

/** A question with three answer buttons (docs/TEACHING.md §2.4). The correct answer is proven by the engine and code. */
export interface LessonQuiz {
  /** unique within the game */
  id: string;
  kind: QuizKind;
  /** ply of the position the question is about (the child's move number) — a stale quiz is dropped */
  ply: number;
  /** the question sentence as said (the last sentence of the asking event's `text`) */
  question: string;
  /** exactly three, in display order; label ≤ 3 words / 18 chars; icon = a piece letter (p n b r q k) or ✓ ⇄ ✗ … */
  options: { id: string; label: string; icon?: string }[];
  correctId: string;
}

/** One pre-written wording that was said: content pool id, 1-based wording number and its variant. */
export interface LessonSay {
  pool: string;
  n: number;
  piece?: PieceType;
  g?: 'm' | 'f';
}

/**
 * «Дозапись голоса»: the stage 1–2 options sentence «Ладью, коня или слона?» as ids, so the recorded voice (and the
 * server that records it) rebuilds exactly the bubble's words. `say` = an index into the event's `say` (a
 * `v3.quiz.opt.*` / `v3.quiz.cat.*` button wording), `piece` = a button that names a piece type (no pool).
 */
export interface LessonQuizVoice {
  kind: QuizKind;
  options: ({ say: number } | { piece: PieceType })[];
}

/** lesson model: one sentence of `text` for the recorded voice (docs/TEACHING.md §4.5). */
export interface LessonSaySentence {
  /** exactly as in `text` (the `joinSentence` output, or the composed quiz options sentence) */
  text: string;
  /** indexes into `say`: [whole] | [lead] | [lead, tail]; [] for the composed quiz options (see `quiz`) */
  parts: number[];
  /** the options sentence said aloud at stages 1–2 */
  quiz?: LessonQuizVoice;
}

export interface TeachAdvice {
  uci: string;
  san: string;
  source: AdviceSource;
  arrow: 'green' | 'blue';
}

export interface TeachSummary {
  moment: TeachMoment;
  style: 'full' | 'short' | 'concept';
  /** ply of the position the advice is for (the child's move number) — stale events are dropped */
  ply: number;
  /** 0..2 advised moves */
  advice: TeachAdvice[];
  /** a ConceptCard introduced in this utterance */
  conceptId?: string;
  /** «сокровище»: 'later' = no arrow yet, the child is invited to find it first */
  reveal?: 'now' | 'later';
}

/** Hint ladder: 1 = Socratic question, 2 = board zone / theme, 3 = which piece, 4 = show the move. */
export type HintLevel = 1 | 2 | 3 | 4;

export interface CoachEvent {
  id: string;
  kind: CoachEventKind;
  /** 2 = must be said now (interrupts), 1 = normal, 0 = optional chatter (dropped when busy) */
  priority: 0 | 1 | 2;
  /**
   * Russian, ready to be spoken verbatim. No Latin notation and NO squares (docs/TEACHING.md §2.3): the piece and
   * the idea — «Давай пойдём конём — оттуда он будет бить центр», never «конь на эф три»; the board shows the square.
   */
  text: string;
  /** Same content for the speech bubble (lesson events: the same words as `text`; helper events MAY hold notation). */
  bubbleText: string;
  pose: MascotPose;
  board?: BoardAnnotations;
  pauseClock: boolean;
  hintLevel?: HintLevel;
  motif?: MotifId;
  judgement?: MoveJudgement;
  /**
   * Situation brief for CONVERSATIONAL voice layers (Live / Realtime): engine-verified facts + the goal of
   * this moment, in Russian, NOT a script. The model says it in its own words. Must never contain the best
   * move unless hintLevel is 4. `text` stays the verbatim fallback for browser TTS / silent layers.
   */
  brief?: string;
  /** teacher mode: what was advised (teachTurn / teachReaction / teacher takebackOffer) */
  teach?: TeachSummary;
  /**
   * «Записи» voice (docs/voice-clips/SPEC.md §3.4): the same utterance as recorded-clip units — the clip twin, set by
   * the builders of the families that have one (teacher turn / reveal / «Совет», take-back, praise, greeting, game start / end);
   * absent = the clip layer compiles `text` (the bridge). Layers other than 'clips' ignore it.
   */
  clip?: ClipUtterance;
  /** lesson model: what the board highlights, per sentence of `text` (drawn by the board layer; docs/TEACHING.md §3) */
  cues?: LessonCue[];
  /** lesson model: a question with three buttons asked by this event */
  quiz?: LessonQuiz;
  /** lesson model: the pre-written wordings this utterance is made of, in order (repetition stats, the recorded voice) */
  say?: LessonSay[];
  /**
   * lesson model (additive): `text` sentence by sentence as the recorded voice plays it — which `say` parts make each
   * sentence. Absent on events stored without it (the clip layer then derives it from the parts' roles).
   */
  saySentences?: LessonSaySentence[];
}

// ───────────────────────── «Записи»: pre-recorded clips (docs/voice-clips/SPEC.md §3) ─────────────────────────

/** A line of the clip catalogue (packages/content/src/voice/catalog.ru.ts), e.g. 'teach.head.advice'. */
export type ClipLineId = string;

/**
 * One unit of a sentence in clip mode: a catalogue line (its piece / child's-gender variant is chosen by enum, never
 * by free text) or a move slot keyed from chess.js-verified SAN — 'nom' «конь на эф шесть», 'cap' «конь бьёт на дэ
 * пять», 'ins' «конём на эф шесть». Squares are never text.
 */
export type ClipItem = { line: ClipLineId; piece?: PieceType; g?: 'm' | 'f' } | { slot: 'nom' | 'cap' | 'ins'; san: string; fen: string };

/** One spoken sentence: W, H·S, S·T or H·S·T (≤ 1 slot, ≤ 3 items). `prio` 100 = the core, never dropped. */
export interface ClipSentence {
  items: ClipItem[];
  prio: number;
  end: '.' | '!' | '?';
}

/** An utterance in clip mode: ≤ 2 sentences, an optional bark pose in front, the generic line of its moment (L5). */
export interface ClipUtterance {
  sentences: ClipSentence[];
  bark?: MascotPose;
  generic: ClipLineId;
  moment?: string;
}

/** One recorded wording of a catalogue line; placeholders ({коня}, {g:сам|сама} …) are documented in core clips/catalog.ts. */
export interface ClipWording {
  t: string;
  mood?: 'calm' | 'excited';
}

/** A catalogue line (Russian lives in @gambit/content; core, tools and tests read it structurally through this type). */
export interface ClipCatalogLine {
  id: ClipLineId;
  /** whole sentence, head up to a seam («Мой совет —»), tail from a seam («— так мы давим на центр.»), bark («Ого!») */
  role: 'whole' | 'head' | 'tail' | 'bark';
  /** the seam a head ends with / a tail starts with */
  join?: '—' | ':';
  /** plays per game in the harvest: sizes the pool (SPEC §7.1) */
  freq?: number;
  /** the sibling said when this line has no recording (ladder L3) */
  fallback?: ClipLineId;
  /** recorded once per piece: true = pawn, knight, bishop, rook, queen; or the exact list */
  byPiece?: boolean | readonly PieceType[];
  /** recorded once per child's gender (`profile.address`) */
  byGender?: boolean;
  wordings: readonly ClipWording[];
}

/** How often the conversational coach speaks up on its own (it always answers when the child talks). */
export type Talkativeness = 'quiet' | 'normal' | 'chatty';

/** State of a conversational voice session, for the «Поговорить» control. */
export type ConversationState = 'off' | 'connecting' | 'listening' | 'childSpeaking' | 'thinking' | 'coachSpeaking' | 'error';

export interface InterventionContext {
  coachMode: CoachMode;
  stage: number;
  /** take-back offers already made this game */
  offersMade: number;
  /** child's remaining clock, null = untimed */
  remainingMs: number | null;
  examMode: boolean;
  /** plies since last intervention */
  pliesSinceLastOffer: number;
}

export type InterventionDecision =
  | { action: 'none'; reason: string }
  | { action: 'offerTakeback'; reason: string }
  | { action: 'logForReview'; reason: string };

/** 'open' = always-listening mic with barge-in (needs headphones); 'push' = hold-to-talk. */
export type MicMode = 'open' | 'push';

export interface VoiceLayer {
  /**
   * 'openai-live' = full-duplex gpt-live-1 (Live API); 'openai-realtime' = gpt-realtime-2.x (Realtime API);
   * 'clips' = the pre-recorded «Записи» voice (docs/voice-clips/SPEC.md).
   */
  readonly kind: 'browser-tts' | 'openai-realtime' | 'openai-live' | 'silent' | 'clips';
  init(): Promise<void>;
  /** Resolves when the utterance has finished (or was interrupted). */
  speak(text: string, opts?: { interrupt?: boolean }): Promise<void>;
  /**
   * Layers that need the whole event (kind, teach, pose, `clip`) instead of its text — the clips layer. Resolves at the
   * audible end (or when stopped). The controller prefers it over `speak(event.text)` when present.
   */
  speakEvent?(event: CoachEvent, opts?: { interrupt?: boolean }): Promise<void>;
  stop(): void;
  /** 0..1 mouth-open level, called at animation rate while speaking. Returns unsubscribe. */
  onLevel(cb: (level: number) => void): () => void;
  onSpeakingChange(cb: (speaking: boolean) => void): () => void;
  /** Conversational layers only (push-to-talk). */
  startListening?(): Promise<void>;
  stopListening?(): void;
  /** Conversational layers: switch between always-listening and hold-to-talk. */
  setMicMode?(mode: MicMode): Promise<void>;
  /** Push a silent context update to the model (position changed, judgement arrived) — never spoken verbatim. */
  pushContext?(note: string): void;
  /**
   * Conversational layers: react to a situation IN THE MODEL'S OWN WORDS (brief = facts + goal, see CoachEvent.brief).
   * Resolves when that speech has finished (or was interrupted / timed out). Layers without it get speak(fallbackText).
   */
  speakBrief?(brief: string, opts?: { interrupt?: boolean; fallbackText?: string }): Promise<void>;
  /** Conversational layers: current session state for the UI. Returns unsubscribe. */
  onConversationState?(cb: (state: ConversationState) => void): () => void;
  onTranscript?(cb: (who: 'child' | 'coach', text: string) => void): () => void;
  dispose(): void;
}

/** Tools the realtime voice model may call; implemented by the game module, all answer < 300 ms. */
export interface CoachToolHost {
  getPositionSummary(): Promise<string>;
  getHint(level: HintLevel): Promise<CoachEvent>;
  explainLastMove(): Promise<CoachEvent | null>;
  showOnBoard(a: BoardAnnotations): void;
  takeBackMove(): boolean;
  /**
   * Engine-grounded FACTS about the current position for free conversation (Russian, no Latin notation in the
   * text meant for speech): side to move, material, threats of both sides, hanging pieces, what the last moves did,
   * clock, opening idea. Never the best move. < 600 ms (uses cached analysis).
   */
  analyzePosition?(): Promise<string>;
  /**
   * «А если я пойду конём на эф три?» — judge a HYPOTHETICAL move of the side to move without playing it.
   * `move` is SAN or UCI as produced by the model. Returns Russian facts: legal?, is it safe, what the opponent
   * can answer (spoken Russian), win-chance change in words. Never reveals the best move. < 1.5 s.
   */
  evaluateMove?(move: string): Promise<string>;
  /** «а почему не ферзём?» / «а если не так?» — compare a move (or the best move of a piece type) with the current advice. Facts, Russian, ≤ 1.5 s. */
  compareMove?(query: { move?: string; piece?: PieceType }): Promise<string>;
  /** Teacher mode: re-say the current advice (arrows again); `more` = add a third candidate within tolerance (P1). */
  repeatAdvice?(opts?: { more?: boolean }): Promise<CoachEvent | null>;
}

// ───────────────────────── personas & content ─────────────────────────

export interface Persona {
  id: PersonaId;
  name: string;
  age: number;
  nominalElo: number;
  /** one-line character, Russian */
  tagline: string;
  /** play-style description, Russian */
  style: string;
  /** avatar colours + emoji-like face features used by the code-drawn SVG avatar */
  avatar: { bg: string; skin: string; hair: string; hairStyle: 'short' | 'curly' | 'ponytail' | 'bob' | 'cap' | 'spiky' | 'long' | 'bun'; accessory?: 'glasses' | 'headphones' | 'bow' | 'cap' | 'scarf' };
  lines: { intro: string[]; onWin: string[]; onLose: string[]; onDraw: string[]; onGoodMoveByChild: string[] };
  /** curriculum stage from which this bot is recommended */
  recommendedFromStage: number;
}

export interface CurriculumStage {
  stage: number;
  title: string;
  ratingBand: string;
  goal: string;
  skills: string[];
  puzzleThemes: string[];
  endgames: string[];
  openingFocus: string;
  mastery: { description: string; minPuzzleRating?: number; maxBlundersPerGame?: number; minAccuracy?: number };
  recommendedPersonas: PersonaId[];
}

export interface ConceptCard {
  id: string;
  title: string;
  motif?: MotifId;
  lichessThemes: string[];
  stage: number;
  /** kid-friendly Russian explanation, 2-5 short sentences */
  explanation: string;
  /** what to ask yourself */
  question: string;
  examples: { fen: string; solutionSan: string[]; comment: string }[];
}

// ───────────────────────── journal & persistence ─────────────────────────

export type GameEventType =
  | 'gameStart'
  | 'move'
  | 'takebackOffered'
  | 'takebackAccepted'
  | 'takebackDeclined'
  | 'hintRequested'
  | 'hintGiven'
  | 'coachSaid'
  | 'childSaid'
  | 'gameEnd';

export interface GameEvent {
  /** ms since game start */
  t: number;
  type: GameEventType;
  ply?: number;
  data: Record<string, unknown>;
}

export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';
export type Termination = 'checkmate' | 'resign' | 'timeout' | 'stalemate' | 'draw' | 'abandoned';

export interface KeyMoment {
  ply: number;
  fenBefore: string;
  playedSan: string;
  bestSan: string;
  classification: MoveClass;
  motif?: MotifId;
  /** Russian, kid-friendly */
  explanation: string;
}

export interface GameSummary {
  accuracy: number;
  acpl: number;
  counts: Record<MoveClass, number>;
  takebacksOffered: number;
  takebacksAccepted: number;
  hintsUsed: number;
  motifsMissed: MotifId[];
  motifsAllowed: MotifId[];
  openingName?: string;
  keyMoments: KeyMoment[];
}

export interface GameRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  personaId: PersonaId;
  timeControlId: TimeControlId;
  childColor: Color;
  result: GameResult;
  termination: Termination;
  /** main line only, with {[%clk]} comments when timed */
  pgn: string;
  events: GameEvent[];
  /** judgements of the CHILD's moves only (incl. taken-back attempts, flagged in events) */
  judgements: MoveJudgement[];
  summary: GameSummary;
  examMode: boolean;
  /** how the coach helped in this game (examMode === (coachStyle === 'exam')); absent in records saved without a coach style */
  coachStyle?: CoachStyle;
}

export interface GameListItem {
  id: string;
  startedAt: string;
  personaId: PersonaId;
  timeControlId: TimeControlId;
  childColor: Color;
  result: GameResult;
  accuracy: number;
  blunders: number;
  reviewStatus: ReviewStatus;
  /** additive: why the game does not count in the child's progress; null / absent = it counts */
  excluded?: GameExclusion | null;
}

/**
 * Why a saved game does not count in the child's progress (totals, charts, level, profile.md, the coach's view of the
 * child). The game, its files and its review stay: 'adult' = the parent marked it «играл взрослый / проверка»,
 * 'archived' = left behind by «Начать прогресс заново». Nothing is ever deleted.
 */
export type GameExclusion = 'adult' | 'archived';

export type ReviewStatus = 'pending' | 'ready' | 'template' | 'failed';

export interface GameReview {
  gameId: string;
  status: ReviewStatus;
  provider: 'codex' | 'openrouter' | 'openai-api' | 'template';
  /** Russian markdown for the parent + child */
  markdown: string;
}

export interface ThemeSkill {
  rating: number;
  rd: number;
  vol: number;
  attempts: number;
  solved: number;
  lastSeen: string | null;
}

export interface StudentProfile {
  /** pseudonym only — never the real full name */
  nickname: string;
  /** Russian past-tense agreement for coach phrases */
  address: 'm' | 'f';
  stage: number;
  totals: { games: number; wins: number; losses: number; draws: number; puzzlesAttempted: number; puzzlesSolved: number; minutesPlayed: number };
  puzzleRating: ThemeSkill;
  themeSkills: Record<string, ThemeSkill>;
  recentAccuracy: number[];
  weaknesses: string[];
  strengths: string[];
  /** highest persona beaten */
  bestWin: PersonaId | null;
  updatedAt: string;
  /**
   * Concept cards «Учитель» has explained to the child (TEACHER-MODE §5.2, P1): the `teach.conceptId`s of the
   * `coachSaid` events of the games that COUNT — a game marked «играл взрослый» or archived gives its cards back.
   * Absent = a profile from before this field (the game falls back to its local list).
   */
  conceptsIntroduced?: string[];
}

export interface ProgressPoint {
  date: string;
  gameId: string;
  accuracy: number;
  blunders: number;
  personaId: PersonaId;
  result: GameResult;
}

export interface ProgressSnapshot {
  profile: StudentProfile;
  games: ProgressPoint[];
  puzzleRatingHistory: { date: string; rating: number }[];
  themeTable: { theme: string; title: string; rating: number; attempts: number; solved: number }[];
  stage: CurriculumStage;
  nextStage: CurriculumStage | null;
}

// ───────────────────────── the child's progress: adult games, post-game thoughts, journals ─────────────────────────

/** Body of `PUT /games/:id/excluded` (parent only): mark / unmark a game «играл взрослый / проверка». */
export interface GameExclusionRequest {
  excluded: 'adult' | null;
}

export interface GameExclusionResponse {
  id: string;
  excluded: GameExclusion | null;
  /** the profile recounted from the games that count */
  profile: StudentProfile;
}

/** Body of `POST /student/reset-progress` (parent only): every game that counts now is archived — nothing is deleted. */
export interface ProgressResetRequest {
  confirm: true;
}

export interface ProgressResetResponse {
  archivedGames: number;
  profile: StudentProfile;
}

/** `GET /games/:id/journal` — the markdown journal of that one game, read-only. */
export interface GameJournalResponse {
  gameId: string;
  /** e.g. '2026-09-21_1742_vs-petya.md' */
  fileName: string;
  markdown: string;
}

/**
 * A thought of the child about a finished game that arrives after its record was saved (the post-game talk, the
 * diary). `id` is chosen by the client and makes the append idempotent.
 */
export interface GameThought {
  id: string;
  /** 'voice' = a transcript of the child's speech, 'typed' = typed into the diary */
  source: 'voice' | 'typed';
  /** the question it answers, as it was asked (e.g. «Что было самым трудным в этой партии?») */
  question?: string;
  text: string;
  /** when it was said / typed (ISO) */
  at: string;
}

/** Body of `POST /games/:id/thoughts` — only for the latest few games. */
export interface GameThoughtsRequest {
  thoughts: GameThought[];
}

export interface GameThoughtsResponse {
  gameId: string;
  /** new thoughts stored by this call (repeated ids are skipped) */
  added: number;
  /** thoughts of this game now */
  total: number;
}

// ───────────────────────── puzzles ─────────────────────────

export interface Puzzle {
  id: string;
  /** position with the CHILD to move (opponent's first move already applied) */
  fen: string;
  /** the opponent move that led to `fen`, for animation */
  lastMoveUci: string;
  /** alternating: child, opponent, child, ... */
  solutionUci: string[];
  rating: number;
  themes: string[];
}

export interface PuzzleAttempt {
  puzzleId: string;
  solved: boolean;
  msSpent: number;
  hintsUsed: number;
  themes: string[];
  puzzleRating: number;
}

// ───────────────────────── server API ─────────────────────────

export interface HealthInfo {
  ok: true;
  llm: {
    codexCli: boolean;
    codexLoggedIn: boolean;
    openaiKey: boolean;
    openrouterKey?: boolean;
    /**
     * additive: codex is installed but skipped right now — 'limit' = the subscription's usage limit (until its reset),
     * 'login' = it answered «not logged in», 'failing' = it failed several times in a row, 'slow' = too slow for the
     * game's first line (only the strategy of a game goes to the next provider; reviews still use it). `until` = epoch
     * ms when it is tried again. Absent = usable.
     */
    codexPaused?: { reason: 'limit' | 'login' | 'failing' | 'slow'; until: number };
  };
  /** realtime = gpt-realtime-2.x available; live = full-duplex gpt-live-1 available (both need OPENAI_API_KEY) */
  voice: { realtime: boolean; model: string; voice: string; live?: boolean; liveModel?: string; preferred?: 'live' | 'realtime' | 'clips' };
  puzzles: { count: number };
  /** DATA_DIR is a throw-away temp folder (tests, smoke runs): only then may automation write a profile or games there */
  dataDirIsTemp?: boolean;
  build?: ServerBuildInfo;
  /** seconds since the last /api request that was not a health check (a game, a conversation…); null = none since the start */
  activity?: { idleSeconds: number | null };
  /**
   * additive (docs/TEACHING.md §4.4): runtime = generative AI may be used in the child's game (the live OpenAI voice,
   * the microphone conversation, the LLM strategist and reviews). Off by default (`GAMBIT_RUNTIME_AI`); absent (a server
   * without the field) is treated as off by the web.
   */
  ai?: { runtime: boolean };
  /** additive («Дозапись голоса»): recording missing phrases (lesson wordings, whole catalogue sentences) on first use. Codes only — never a path or a key. */
  clipGen?: ClipGenHealth;
}

// ───────────────────────── «Дозапись голоса»: recording missing phrases on demand ─────────────────────────

/**
 * Why the server records nothing right now. Setup-side: 'no-budget' (no CLIP_GEN_BUDGET), 'no-cli' (no Higgsfield
 * binary), 'no-tools' (ffmpeg / whisper missing), 'temp-data' (a throw-away DATA_DIR), 'data-dir' (DATA_DIR is not
 * CLIP_GEN_DATA_DIR), 'no-overlay' (VOICE_OVERLAY_DIR is off or refused: nothing could be kept), 'model' / 'price' (the provider changed), 'audit' (the tools ledger's balance audit failed),
 * 'total-cap', 'duplicate' (un-ledgered paid jobs were found), 'unresolved' (a create whose job is not known yet).
 * Parent-side: 'parent-off'. Timed: 'login' (sign-in expired), 'rate', 'failing', 'tool-busy' (the
 * `voice:generate` tool holds the lock), 'day-cap', 'no-credits' (the account is empty).
 */
export type ClipGenPauseReason =
  | 'parent-off'
  | 'no-budget'
  | 'no-cli'
  | 'no-tools'
  | 'temp-data'
  | 'data-dir'
  | 'no-overlay'
  | 'login'
  | 'rate'
  | 'failing'
  | 'price'
  | 'model'
  | 'audit'
  | 'tool-busy'
  | 'day-cap'
  | 'total-cap'
  | 'duplicate'
  | 'no-credits'
  | 'unresolved';

/** HealthInfo.clipGen: 'off' = the feature is disabled in the environment (GAMBIT_CLIP_GEN), the web hides it. */
export interface ClipGenHealth {
  state: 'off' | 'ready' | 'paused';
  reason?: ClipGenPauseReason;
  /** epoch ms when a timed pause is lifted; null = until the setup is fixed / a restart */
  until?: number | null;
  /** a valid overlay folder exists: recorded phrases are served (even while generation is off or paused) */
  overlay: boolean;
}

/**
 * A whole sentence of the clip catalogue to record (a W item of a clip twin, `ClipItem` `{ line }`), as ids only:
 * `n` = the 1-based wording number. The web normalises the variant to that wording: `piece` only when the wording
 * names a piece (and the line is recorded by piece), `g` only when the line is `byGender` and the wording uses
 * `{g:…}`. The server renders the words itself from the catalogue (never the lesson pools), accepts only a line of
 * role 'whole' outside the lesson namespace (`v3.*` goes through `parts` / `quiz`), and records the unit
 * `line:<poolKey>#<n>` — the same key as the pre-recorded starter takes, so a recording joins that line's pools.
 */
export interface ClipGenLine {
  id: ClipLineId;
  n: number;
  piece?: PieceType;
  g?: 'm' | 'f';
}

/**
 * One sentence to record, as ids only (the server renders the Russian text itself from @gambit/content and never
 * accepts text): a whole lesson wording, a lead said alone, a lead + its tail, the stage 1–2 quiz options sentence,
 * or (additive) a whole catalogue sentence of an event without lesson parts — a greeting, an answer, a take-back reply… (`line`).
 */
export type ClipGenSentence =
  | { parts: [LessonSay] | [LessonSay, LessonSay] }
  | { quiz: { kind: QuizKind; options: ({ say: LessonSay } | { piece: PieceType })[] } }
  | { line: ClipGenLine };

/** POST /voice/clips/request: the sentences of one utterance that have no recording (1..6). */
export interface ClipGenRequest {
  sentences: ClipGenSentence[];
  /** priority hint only */
  kind?: CoachEventKind;
}

/**
 * Per sentence: 'queued' / 'recording' = it will be recorded (the bubble says so), 'voiced' = already recorded,
 * 'budget' = a cap is reached, 'given-up' = its attempts are used up, 'invalid' = refused ids, 'queue-full',
 * 'paused' = see `health.reason`.
 */
export type ClipGenOutcome = 'queued' | 'recording' | 'voiced' | 'budget' | 'given-up' | 'invalid' | 'queue-full' | 'paused';

export interface ClipGenRequestResult {
  /** one per request sentence, in order; `keys` = the unit keys of that sentence (a `line` sentence: one, `line:<poolKey>#<n>`) */
  results: { outcome: ClipGenOutcome; keys: string[] }[];
  health: ClipGenHealth;
  /** jobs waiting in the server's queue */
  queue: number;
}

/** PUT /voice/clips/settings (the parent's switch; kv `voice.clipGen`). The daily cap can only be lower than the env's. */
export interface ClipGenSettings {
  enabled: boolean;
  /** milli-credits per local day (1 credit = 1000) */
  dailyCapMilli: number;
}

/** GET /voice/clips/status — for the parent's card and the web poller. Spend is read from the overlay ledger. */
export interface ClipGenStatus {
  health: ClipGenHealth;
  /** the parent's switch */
  enabled: boolean;
  queue: number;
  /** a job is being recorded right now */
  busy: boolean;
  /** the overlay index: its version changes when a phrase is published (the web reloads it); null = no overlay */
  overlay: { version: number; units: number } | null;
  /** `today` = the server's local day (YYYY-MM-DD); pending jobs and unresolved creates count at full price */
  spent: { today: string; todayMilli: number; totalMilli: number; prefetchMilli: number };
  /** dailyMilli = the effective daily cap (parent's, ≤ env max); dailyMaxMilli = CLIP_GEN_DAILY_MAX; totalMilli = CLIP_GEN_BUDGET */
  caps: { dailyMilli: number; dailyMaxMilli: number; totalMilli: number };
  /** units whose attempts are used up (listed for a listening check) */
  givenUp: number;
  /** distinct phrases this server recorded during games that are published now (the prefetch not counted) */
  recorded?: number;
  /** paid jobs whose download or check failed every retry: their phrases wait for the next start of the server */
  stuck?: number;
}

/** Which code the server runs (GET /health — for the launcher and the parent). Never a path, never a key. */
export interface ServerBuildInfo {
  /** short git commit of the checkout when the server started; null outside a git checkout */
  gitSha: string | null;
  /** when this server process started (ISO): the launcher restarts a server that is older than the code on disk */
  startedAt: string;
  /** when the served web bundle (apps/web/dist/index.html) was built (ISO); null = no bundle, API only */
  distBuiltAt: string | null;
}

export interface VoiceSessionResponse {
  provider: 'openai-realtime';
  /** ephemeral client secret — short-lived, safe for the browser */
  clientSecret: string;
  model: string;
  voice: string;
  expiresAt: number;
  /** system instructions already applied server-side */
  instructionsApplied: boolean;
}

/** Full-duplex Live API: the browser sends its SDP offer to OUR server, which creates the session with the real key. */
export interface LiveVoiceSessionRequest {
  sdp: string;
}

export interface LiveVoiceSessionResponse {
  provider: 'openai-live';
  /** SDP answer from OpenAI */
  sdp: string;
  model: string;
  voice: string;
  sessionId: string | null;
  expiresAt: number | null;
}

// ───────────────────────── game strategy (teacher mode, smart strategist) ─────────────────────────

/** A curated, engine-verified strategy the teacher can lead a game with (packages/content STRATEGIES). */
export interface StrategyCard {
  id: string;
  /** «Итальянская партия» */
  titleRu: string;
  /** one kid-level sentence: what we are going to do in this game and why */
  ideaRu: string;
  side: Color;
  /** which first opponent moves it answers (Black strategies); 'any' for White */
  against: 'any' | 'e4' | 'd4' | 'other';
  /** the child's planned moves along the main line (SAN, verified) */
  lineSan: string[];
  /** 3–6 short spoken steps of the plan (no Latin letters) */
  stepsRu: string[];
  /** middlegame follow-up ideas in kid words */
  middlegameRu: string[];
  minStage: number;
  themes: string[];
  /**
   * additive: 2–4 goals of the plan as «мы» verb phrases («бьём по цепочке пешек ударом цэ пять») — what the teacher
   * keeps talking about once the opponent has left the main line (no Latin letters)
   */
  planGoalsRu?: string[];
}

/** Who paid for a strategist answer: the parent's ChatGPT subscription (codex), a per-call API bill, or nobody (template). */
export type StrategyBilling = 'subscription' | 'paid' | 'free';

/** The strategy chosen for one game (by the smart strategist or deterministically). */
export interface GameStrategy {
  strategyId: string;
  titleRu: string;
  /** ≤ 20 words, spoken at game start: «В этот раз разыграем …, поэтому начни …» (no Latin letters) */
  introRu: string;
  ideaRu: string;
  provider: 'codex' | 'openrouter' | 'openai-api' | 'template';
  /** additive: the model that actually chose the strategy (e.g. 'gpt-5.6-sol'); absent for the template */
  model?: string;
  /** additive: «через подписку» ('subscription', codex) / «платно» ('paid', OpenRouter or the OpenAI API) / 'free' (template) */
  billing?: StrategyBilling;
}

export interface StrategyRequest {
  childColor: Color;
  stage: number;
  personaId: PersonaId;
  timeControlId: TimeControlId;
  /** first opponent move when the child is Black and it is already known (UCI) */
  opponentFirstUci?: string;
}

/** Ask the smart model to re-plan after the opponent broke the plan or the phase changed. Engine facts only. */
export interface ReplanRequest {
  ply: number;
  fen: string;
  childColor: Color;
  strategyId: string;
  movesSan: string[];
  /** engine top candidates for the child with code-computed ideas; the answer must pick one of these */
  candidates: { uci: string; san: string; cp: number; ideasRu: string[] }[];
  stage: number;
}

export interface ReplanResponse {
  ply: number;
  /** ≤ 15 words, the new plan in kid words (no Latin letters) */
  planRu: string;
  /** one of the request candidates, or null */
  preferredUci: string | null;
  /** ≤ 15 words, why this move serves the plan (no Latin letters) */
  whyRu: string;
  provider: 'codex' | 'openrouter' | 'openai-api' | 'template';
}

/**
 * REST routes (all under /api, JSON):
 *  GET  /health                      -> HealthInfo
 *  GET  /student                     -> StudentProfile
 *  PUT  /student                     -> StudentProfile            (body: Partial<Pick<StudentProfile,'nickname'|'address'|'stage'>>)
 *  POST /games                       -> { id: string }            (body: GameRecord) writes PGN + md journal, updates profile, enqueues review
 *  GET  /games?limit=50&offset=0     -> GameListItem[]            (newest first, every game incl. excluded ones)
 *  GET  /games/:id                   -> GameRecord
 *  GET  /games/:id/review            -> GameReview
 *  GET  /games/:id/journal           -> GameJournalResponse       (the .md of that game only)
 *  PUT  /games/:id/excluded          -> GameExclusionResponse     (body: GameExclusionRequest) recounts the profile
 *  POST /games/:id/thoughts          -> GameThoughtsResponse      (body: GameThoughtsRequest) latest few games only, 409 { error: 'too-old' }
 *  POST /student/reset-progress      -> ProgressResetResponse     (body: ProgressResetRequest) archives, never deletes
 *  GET  /progress                    -> ProgressSnapshot
 *  GET  /puzzles/next?theme=&count=  -> Puzzle[]                  (adaptive to student's rating; theme optional)
 *  POST /puzzles/attempt             -> { puzzleRating: ThemeSkill } (body: PuzzleAttempt)
 *  GET  /curriculum                  -> { stages: CurriculumStage[]; current: number }
 *  GET  /kb/:id                      -> ConceptCard
 *  POST /voice/session               -> VoiceSessionResponse | 503 { error: 'no-api-key' }
 *  POST /voice/live                  -> LiveVoiceSessionResponse | 503 { error: 'no-api-key' }   (body: LiveVoiceSessionRequest)
 *  POST /coach/strategy              -> GameStrategy              (body: StrategyRequest; smart strategist codex (subscription, ≤ 7.5 s) → openrouter → openai-api → template, ≤ 8 s)
 *  POST /coach/replan                -> ReplanResponse            (body: ReplanRequest; async, stale answers are dropped by ply)
 *  POST /coach/rephrase              -> { text: string; provider: string } (body: { event: CoachEvent }) optional LLM polish, falls back to event.text
 *  POST /voice/clips/request         -> 202 ClipGenRequestResult | 503 { error: 'clip-gen-off' | 'automation' } | 429 { error: 'clip-gen-rate' }  (body: ClipGenRequest, strict; ids only — lesson `parts` / `quiz`, or a whole catalogue `line`; refused ids = outcome 'invalid')
 *  GET  /voice/clips/status          -> ClipGenStatus             (also answers when off)
 *  PUT  /voice/clips/settings        -> ClipGenStatus             (body: ClipGenSettings, strict; stores nothing under automation)
 *  GET  /voice/clips/overlay/*       -> the recorded overlay: index.json, <voice>/manifest.<hash>.json, <voice>/<xx>/<id>.mp3 (JSON 404 otherwise)
 */
export const API_BASE = '/api';
export const SERVER_PORT = 8787;
export const WEB_DEV_PORT = 5173;
