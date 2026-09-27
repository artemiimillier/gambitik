/**
 * The teacher brain of «Учитель» (docs/TEACHER-MODE.md §2–§3, §5.1–§5.2, §6.1–§6.3, §7.1): the coach LEADS the child
 * every move — what the opponent did and wants, the one danger to see, 1–2 engine-checked good moves with arrows and a
 * kid-level «почему», the opening plan, and an honest reaction to the child's own choice.
 *
 * Truth is split as everywhere in the coach (ARCHITECTURE principle 1):
 *  - the ENGINE decides which moves are good: every advised move comes from the MultiPV lines of the position (or a
 *    `searchmoves` verification of a book move) within `TEACH_TOLERANCE_CP` of the best line;
 *  - this CODE proves why (`./moveIdeas.ts`), picks the moves deterministically (`pickAdvice`), keeps the talk varied
 *    and short (`planTeachTurn`) and writes the brief;
 *  - the VOICE MODEL only finds the words: the brief's «Можно назвать» line is the only list of the child's moves it
 *    may say, and it never hears the word «лучший» from us.
 *
 * Everything here is pure: engine results, the repertoire (`@gambit/content` getRepertoirePlan / mainLineMoves), the
 * opening book (`@gambit/openings` lookupOpening) and the concept cards come in through `TeachContext` — @gambit/core
 * does not depend on those packages. `rng` is always the last parameter (tests inject it), as in ./events.ts.
 */
import type { LessonHistory } from './lesson/book.ts';
import type { LessonMemory, LessonTurnPlan } from './lesson/types.ts';
import type {
  AdviceSource,
  AnalysisResult,
  BoardAnnotations,
  ClipItem,
  ClipUtterance,
  CoachEvent,
  Color,
  ConceptCard,
  EngineLine,
  InterventionDecision,
  MotifId,
  MoveJudgement,
  PieceType,
  PositionFacts,
  ReplanRequest,
  ReplanResponse,
  Square,
  StrategyCard,
  StudentProfile,
  Talkativeness,
  TeachAdvice,
  TeachMoment,
  TeachSummary,
  Threat,
  TimeControlId,
} from '@gambit/shared';
import { Chess } from 'chess.js';
import type { Board } from '../analysis/board.ts';
import { VALUE_PAWNS, attacksFrom, fileOf, findKing, opposite, parsePlacement, rankOf, seeCapture, seeLoss, squareIndex, squareName } from '../analysis/board.ts';
import { winPct } from '../analysis/eval.ts';
import { computePositionFacts } from '../analysis/facts.ts';
import { findHanging } from '../analysis/hanging.ts';
import { ADVICE_GAP_RU, adviceGapOf, teachScoreCp } from './answers.ts';
import type { ScoredAdvice } from './answers.ts';
import { parseUci, pieceAt, resolveUciMove } from './board.ts';
import type { ResolvedMove } from './board.ts';
import {
  FORBID_BEST_MOVE,
  FORBID_BEST_WORD,
  FORBID_MOVE_FOR_CHILD,
  FORBID_OBVIOUS,
  FORBID_OTHER_MOVES,
  FORBID_POPULARITY,
  FORBID_SHAME,
  FORBID_TWO_SENTENCES,
  MAX_TEACH_BRIEF_CHARS,
  capRu,
  capturedAlongRu,
  composeBrief,
  forbidFor,
  pawnsAccRu,
  pieceOnRu,
  spokenLineRu,
  spokenMoveRu,
  studentWords,
} from './brief.ts';
import type { BriefParts, StudentWords } from './brief.ts';
import { isRealTacticMotif, playedMoveRu } from './events.ts';
import { isMateMotif, motifTitleInlineRu } from './motifs.ts';
import { explainMove, explainMoveLoss, explainOpponentMove, isEarlyQueenMove, isKidFilteredQueenMove, joinIdeasRu, pickIdeas } from './moveIdeas.ts';
import type { ExplainMoveArgs, MoveIdea, MoveIdeaId } from './moveIdeas.ts';
import { countSentences, countWords, join, makeEvent, pick, render, say } from './phrase.ts';
import type { Rng, Template, Voice } from './phrase.ts';
import { pieceNameRu, sanToSpokenRu, squareToSpokenRu } from './spoken.ts';
import { mateInOneThreat, nullMoveFen, threatFactsRu } from './threats.ts';
import { HURRY_MS, freshReplan, moveInsRu, planFitOf, planGoalFor, planGoalRu, planStepRu, replanWords, strategyIntroTemplate, strategyNextSan, strategyProgress } from './strategy.ts';
import type { PlanFit, StrategyProgress, TeachStrategy } from './strategy.ts';
import { hasClipLine } from './clips/catalog.ru.ts';
import {
  TWIN_TAIL_WEIGHT,
  genderOf,
  goalItemOf,
  lineItem,
  moveSentence,
  reasonOfIdea,
  strategyIntroSentences,
  twinCapsFor,
  twinUtterance,
  wholeSentence,
  withClip,
} from './clips/twins.ts';
import type { TwinSentence } from './clips/twins.ts';

export { MAX_TEACH_BRIEF_CHARS };

// ═════════════════════════ constants ═════════════════════════

/** An advised move is at most this much worse than the engine's first line (§2.4). */
export const TEACH_TOLERANCE_CP = 30;
/** …with a shallow analysis (depth 8–11, §2.1 degradation): one advice only, a tighter tolerance. */
export const TEACH_PARTIAL_TOLERANCE_CP = 20;
/** Analysis depth for the normal teacher mode (`teachMinDepth` of the game). */
export const TEACH_MIN_DEPTH = 12;
/** Below this depth (or without an engine) the teacher works «by the rules» (`teachFallbackDepth`). */
export const TEACH_FALLBACK_DEPTH = 8;
/** Book / repertoire moves are considered up to this ply (the first 10 moves), and the kid filter works there too. */
export const TEACH_BOOK_MAX_PLY = 20;
/** At most this many `searchmoves` verifications of book moves per turn. */
export const TEACH_MAX_VERIFY = 2;
/** Movetime of one verification search (the game's `teachVerifyMovetimeMs`). */
export const TEACH_VERIFY_MOVETIME_MS = 300;
/** A move never gets advised when it would be classified worse than «good» against the best line (win% loss). */
export const TEACH_MAX_WIN_PCT_LOSS = 5;
/** «Здесь один хороший ход»: the second line is this much worse in win% (as `ONLY_MOVE_WIN_PCT_GAP` of the game). */
export const ONLY_MOVE_WIN_PCT_GAP = 15;
/** A plan phrase is repeated at most once in this many plies (chatty: `PLAN_EVERY_PLIES_CHATTY`). */
export const PLAN_EVERY_PLIES = 6;
export const PLAN_EVERY_PLIES_CHATTY = 4;
/** New concept cards: at least this many plies apart. */
export const CONCEPT_EVERY_PLIES = 8;
/**
 * New concept cards per game, by talkativeness (§5.2). «Обычно» gets 2: a turn with a new
 * topic is the one a voice model most often stretches past the 25-word budget.
 */
export const CONCEPTS_PER_GAME: Readonly<Record<Talkativeness, number>> = { quiet: 0, normal: 2, chatty: 4 };
/** «Сокровище» — find it yourself first — up to this stage (§2.6; the lesson model §2.7: a gift is a task on stage 5 too). */
export const TREASURE_MAX_STAGE = 5;
/** The opening names announced per game (stages 1–2: one). */
export const OPENING_NAMES_PER_GAME = 2;
/**
 * Spoken budget of a teacher utterance by style: words and sentences of `text`. ONE or TWO short sentences, ≤ 25 words — a new topic too (the model gets the card, not a lecture). The
 * voice frame of the web (`TEACH_MAX_SENTENCES` of apps/web) should follow `TEACH_TEXT_SENTENCES`; every teacher brief
 * also carries the hard «не больше двух коротких предложений» in its «Нельзя» line.
 */
export const TEACH_MAX_WORDS = 25;
export const TEACH_TEXT_WORDS: Readonly<Record<TeachStyle, number>> = { full: TEACH_MAX_WORDS, short: 15, concept: TEACH_MAX_WORDS };
export const TEACH_TEXT_SENTENCES: Readonly<Record<TeachStyle, number>> = { full: 2, short: 1, concept: 2 };
/** A calm position is told in the short style with this probability (the third calm turn in a row always). */
export const CALM_SHORT_P = 0.65;
/** «Что выбираешь?» at most once in this many teacher turns (not every turn). */
export const CHOICE_EVERY_TURNS = 4;
/** The strategy's planned move gets this bonus (above the repertoire's +2: the strategy of THIS game leads). */
export const STRATEGY_LINE_BONUS = 2.5;
/** …a planned move after the opponent left the main line (a system move: London's Bf4 against anything). */
export const STRATEGY_LATER_BONUS = 1.0;
/** …a middlegame move of the strategy. */
export const STRATEGY_MIDDLEGAME_BONUS = 0.5;
/**
 * A planned move of the strategy is advisable up to this gap to the first line (and never worse than «good» in win%):
 * the library lines are engine-verified offline within this margin (`strategies.engine.test.ts` of @gambit/content).
 */
export const STRATEGY_TOLERANCE_CP = 50;
/** Opponent-move mention in the text: at most this many words («Соперник вывел коня на эф шесть.»). */
export const OPPONENT_MENTION_WORDS = 6;
/** «Соперник вывел коня на эф шесть — по плану отвечаем слоном на цэ четыре: …» — one sentence, at most this long. */
export const OPP_SENTENCE_WORDS = 20;

/**
 * Brief budget by style (§2.7). A turn is the advice + one extra, and the budget is what the
 * Live voice frame of a teacher turn leaves in one append (`buildBriefCommentary` of the web: 1200 characters minus the
 * frame and its closing cap ≈ 795) — the brief is fitted HERE, where `kept` knows what was dropped, never cut there.
 */
export const TEACH_BRIEF_CHARS: Readonly<Record<TeachStyle, number>> = { full: 780, short: 600, concept: 780 };

/** Until the hidden «treasure» gets its arrow: 10 s on stages 1–2, 15 s on stages 3–5 (`treasureRevealMs`). */
export function treasureRevealMs(stage: number): number {
  return stage <= 2 ? 10_000 : 15_000;
}

/** Opening names that are too general to announce (§3.2) and never make a move «известный». */
const GENERIC_OPENING_NAMES: ReadonlySet<string> = new Set(['Дебют королевской пешки', 'Дебют ферзевой пешки', 'Дебют королевского коня']);

const WIN_IDEAS: ReadonlySet<MoveIdeaId> = new Set(['mate', 'mateSoon', 'promotion']);
const TACTIC_IDEAS: ReadonlySet<MoveIdeaId> = new Set(['fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'removeDefender', 'trappedPiece']);
/** Opening principles that earn the advice bonus of §2.4 п. 5 (+1.0: a 20 cp depth-12 wobble must not
 *  outweigh «выводит фигуру» / «защищает пешку»). */
const PRINCIPLE_IDEAS: ReadonlySet<MoveIdeaId> = new Set(['centerPawn', 'fightCenter', 'develop', 'castle', 'supportCenter', 'defend']);
/** The principle bonus of §2.4 п. 5 (the spec says +0.5). */
export const PRINCIPLE_BONUS = 1.0;
/** Below this depth a small gap to the first line is noise (G01: b4 +38 vs d3 +18 at depth 12, d3 best at depth 20). */
export const TEACH_NOISE_DEPTH = 16;
export const TEACH_NOISE_CP = 20;
/** Stages 1–2: a move within the tolerance that saves the unit the opponent just attacked becomes the primary. */
export const RESCUE_BONUS = 3.0;
const RESCUE_IDEAS: ReadonlySet<MoveIdeaId> = new Set(['escape', 'defend', 'block', 'defendMate', 'answerCheck']);
/** Ideas that do not explain a plan move by themselves (then the strategy card's step is the «why»). */
const WEAK_IDEAS: ReadonlySet<MoveIdeaId> = new Set(['quiet', 'improvePiece', 'centerControl']);
/**
 * A move whose main idea is one of these was chosen by the POSITION, not by the strategy: a tactic, a win, a rescue, a
 * check. It is never called «по нашему плану» unless it is the next move of the plan's own line
 * («по нашему плану тут есть подарок» sounds like a saying, not a strategy).
 */
const NOT_PLAN_IDEAS: ReadonlySet<MoveIdeaId> = new Set([
  ...WIN_IDEAS, ...TACTIC_IDEAS, 'freeCapture', 'winMaterial', 'recapture', 'defendMate', 'answerCheck', 'escape', 'defend', 'block', 'check',
]);
/** Opponent ideas worth a few words to the child: what he threatens, takes or attacks — not his own defence. */
const OPPONENT_MENTION_IDEAS: ReadonlySet<MoveIdeaId> = new Set([
  'mate', 'mateSoon', 'promotion', 'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'removeDefender', 'trappedPiece',
  'freeCapture', 'winMaterial', 'threatMate', 'attack', 'check', 'fightCenter', 'aimWeakSquare',
]);
const MINOR_HOMES: Readonly<Record<Color, readonly Square[]>> = { w: ['b1', 'g1', 'c1', 'f1'], b: ['b8', 'g8', 'c8', 'f8'] };
const BISHOP_HOMES: Readonly<Record<Color, readonly Square[]>> = { w: ['c1', 'f1'], b: ['c8', 'f8'] };
const KNIGHT_HOMES: Readonly<Record<Color, readonly Square[]>> = { w: ['b1', 'g1'], b: ['b8', 'g8'] };
const QUEEN_HOME: Readonly<Record<Color, Square>> = { w: 'd1', b: 'd8' };

/**
 * Concept card of an idea (§5.2 = the «Карточка» column of §4.2). `MoveIdea.conceptId` from the explainer wins; this
 * table is the fallback. `restrictKing` has no entry: its card depends on the material (queen / rook / two rooks) and
 * comes from the explainer's `conceptId`.
 */
export const IDEA_TO_CONCEPT: Readonly<Partial<Record<MoveIdeaId, string>>> = {
  mate: 'mate-in-1',
  mateSoon: 'mate-in-2',
  promotion: 'promotion',
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discoveredAttack: 'discovered-attack',
  doubleCheck: 'double-check',
  removeDefender: 'remove-defender',
  trappedPiece: 'trapped-piece',
  freeCapture: 'free-capture',
  winMaterial: 'bad-trade',
  defendMate: 'mate-in-1',
  escape: 'hanging-piece',
  defend: 'hanging-piece',
  block: 'hanging-piece',
  threatMate: 'mate-in-1',
  castle: 'opening-king-safety',
  develop: 'opening-development',
  centerPawn: 'opening-center',
  supportCenter: 'opening-center',
  openLine: 'opening-center',
  aimWeakSquare: 'scholars-mate',
  prepareCastle: 'opening-king-safety',
  centerControl: 'opening-center',
  passedPawn: 'promotion',
  trade: 'bad-trade',
  opposition: 'endgame-opposition',
};

// ═════════════════════════ types ═════════════════════════

export type TeachStyle = TeachSummary['style'];
/** The build of an utterance (§2.8.2): never the same one twice in a row. */
export type TeachShape = 'opponentFirst' | 'adviceFirst' | 'question' | 'dangerFirst';
/** How much engine the turn has (§2.1 degradation). */
export type TeachMode = 'engine' | 'partial' | 'rules';

/** The repertoire plan as the teacher needs it — structurally `RepertoirePlan` of `@gambit/content` (getRepertoirePlan). */
export interface RepertoirePlanLike {
  entryId: string;
  entryTitle?: string;
  lineId: string;
  lineTitle: string;
  inBook: boolean;
  /** the child's next model moves, English SAN (code only) */
  nextChildSans: readonly string[];
  nextIdea: string;
  /** the rest of the model line from the current position, both sides (to speak the plan position by position) */
  continuationSan?: readonly string[];
  warning?: boolean;
}

/** The explainer (./moveIdeas.ts) — injectable so tests can script it; the real module is the default. */
export interface MoveIdeasApi {
  explainMove(a: ExplainMoveArgs): MoveIdea[];
  pickIdeas(ideas: MoveIdea[], o: { stage: number; max: 1 | 2; avoid?: MoveIdeaId[] }): MoveIdea[];
  explainOpponentMove(
    fenBefore: string,
    uci: string,
    childFenAfter: string,
    opts?: { threat?: Threat | null; prev?: { uci: string; fenBefore: string } | null },
  ): { ideas: MoveIdea[]; wants: Threat | null };
}

const REAL_IDEAS: MoveIdeasApi = { explainMove, pickIdeas, explainOpponentMove };

/** Everything one teacher turn is computed from. The game gathers it; nothing here talks to an engine. */
export interface TeachContext {
  /** the position the advice is for — the CHILD is to move */
  fen: string;
  /** the ply the child is about to play (1 = White's first move); `teach.ply` of the events */
  ply: number;
  childColor: Color;
  profile: StudentProfile;
  /** `talkativeness` of the coach: it sets the LENGTH of teacher utterances, never whether they happen (§2.7) */
  talkativeness?: Talkativeness;
  /** MultiPV analysis of `fen` (scores from the side to move = the child). null = the judge is unavailable */
  analysis: AnalysisResult | null;
  /** extra lines of `searchmoves` verifications (`bookMovesToVerify`), each `pvUci[0]` = the verified move */
  verified?: readonly EngineLine[];
  /** the engine null-move threat of `fen`: a Threat, null = searched and none, undefined = not known */
  threat?: Threat | null;
  /** the bot's move that led to `fen`; null / absent before White's first move */
  lastBotMove?: { uci: string; san: string; fenBefore: string } | null;
  /** SAN moves of the game so far (the main line up to `fen`) */
  historySan?: readonly string[];
  /** `getRepertoirePlan(historySan, childColor)` of @gambit/content */
  repertoire?: RepertoirePlanLike | null;
  /** `mainLineMoves(fen)` of @gambit/content */
  mainLineSans?: readonly string[];
  /** `(fen) => lookupOpening(fen)?.nameRu` of @gambit/openings */
  openingNameRu?: (fen: string) => string | undefined;
  /** `getConceptCard` of @gambit/content — without it the teacher never introduces a card */
  conceptCard?: (id: string) => ConceptCard | undefined;
  /** cards already explained to this child (localStorage 'gambit.teacher.concepts') */
  conceptsIntroduced?: readonly string[];
  /** the verdict of the child's previous move to glue into this turn (followed / ownGood / fine); null = nothing */
  reaction?: ReactionVerdict | null;
  /** the memory returned by the previous `planTeachTurn` of this game (null = the first turn) */
  memory?: TeachMemory | null;
  /** facts of `fen` (computed when absent) */
  facts?: PositionFacts;
  /** a clock runs (rapid10) — kept for the game; the teacher never talks about the clock */
  timed?: boolean;
  /** the child's clock in ms (null / absent = untimed): below `HURRY_MS` the turn says «Поторопись!» once a game */
  remainingMs?: number | null;
  /**
   * The strategy of this game (the server's `GameStrategy`, or a `TeachStrategy`): the first turn is its intro, the
   * advice explains moves «по нашему плану». null / absent = no strategy (the repertoire / principles lead).
   */
  strategy?: TeachStrategy | null;
  /** the library card of `strategy` (`getStrategy(id)` of @gambit/content): the line, the main line, middlegame tags */
  strategyCard?: StrategyCardLike | null;
  /**
   * The smart strategist's latest re-plan (POST /coach/replan). `preferredUci` / `whyRu` are used only when
   * `replan.ply === ply` (a stale answer is dropped); an older one still updates the plan words from this turn on.
   */
  replan?: ReplanResponse | null;
  /** the strategy intro was already said (the `gameStart` intro of ./events.ts) — the first turn does not repeat it */
  introSaid?: boolean;
  /** explainer override (tests) */
  ideas?: MoveIdeasApi;
  /** the lesson model: the time control (blitz5 speaks one sentence, fewer quizzes; docs/TEACHING.md §2.2) */
  tc?: TimeControlId;
  /** the lesson model: the read-only learner model of the phrase book (`book.history()`): mini levels, habits, takeaways */
  lessonHistory?: Readonly<LessonHistory> | null;
}

/** The library card as the teacher reads it (`StrategyEntry` of @gambit/content has these extra fields). */
export type StrategyCardLike = StrategyCard & { titleAccRu?: string; mainLineSan?: readonly string[]; middlegameSan?: readonly string[] };

/** One advised move (§2.4 п. 8). */
export interface AdviceCandidate {
  uci: string;
  san: string;
  /** «конь на эф три» */
  spokenRu: string;
  /** engine score for the child (a mate as ±100000 ∓ 100·n) */
  scoreCp: number;
  role: 'primary' | 'alternative';
  arrow: 'green' | 'blue';
  source: AdviceSource;
  /** the 1–2 ideas to say (in speech order) */
  ideas: MoveIdea[];
  openingNameRu?: string;
  /** 'curated' (extra): the rules-only degradation — a repertoire / main-line move without an engine (§2.1) */
  verifiedBy: 'multipv' | 'searchmoves' | 'curated';
  /** every idea the explainer found, most important first */
  allIdeas: MoveIdea[];
  /** the deterministic order key of §2.4 п. 5 */
  teachScore: number;
  /** mate in n for the child along the line, null otherwise */
  mate: number | null;
  /** the move failed the kid filter (§2.4 п. 4) */
  kidFiltered: boolean;
  /** how the move serves the game's strategy («по нашему плану …»); absent = not a strategy move */
  planFit?: PlanFit;
  /** the smart strategist's «why» for this move (a fresh replan picked it), Latin-free, ≤ 15 words */
  planWhyRu?: string;
  /** the strategy card's own words for a plan move the explainer only calls «спокойный» («ладья встаёт на е один …») */
  planStepRu?: { textRu: string; namesMove: boolean };
  /**
   * the plan GOAL this move serves, proven by the code (`planGoalFor`: «прыгаем конём на е четыре» for Кe4) — the
   * reason of a plan move, also after the opponent left the main line; absent = the move serves no goal
   */
  planGoal?: { textRu: string; namesMove: boolean };
  /** the same reason was said last turn: the move is named without it (never «идёт длинным путём …» twice in a row) */
  noReason?: boolean;
}

export type ReactionKind = 'followed' | 'ownGood' | 'fine' | 'weaker' | 'takeback' | 'tactic';

/** How the child's move relates to the advice (§2.5). */
export interface ReactionVerdict {
  kind: ReactionKind;
  judgement: MoveJudgement;
  /** the advice of that half-move */
  advice: TeachAdvice[];
  /** for the journal: which arrow the child followed */
  followed: 'primary' | 'alternative' | 'own';
  /** ideas of the played move (to praise an own good move) */
  ideas: MoveIdea[];
  /** the child left the repertoire line with this move (§3.4) */
  leftBook: boolean;
  /** an early queen move (§3.1) */
  earlyQueen: boolean;
  /** say it NOW as its own `teachReaction` while the bot «thinks» (weaker, or an early queen) — else glue it into the next turn */
  speakNow: boolean;
  /** the found tactic for `buildPraise` (kind 'tactic') */
  foundMotif?: MotifId;
}

/** What the teacher remembers between turns of one game (store it with the game, pass it back as `ctx.memory`). */
export interface TeachMemory {
  /** teacher turns said this game */
  turns: number;
  lastPly: number | null;
  lastShape: TeachShape | null;
  /** consecutive calm turns before this one */
  calmStreak: number;
  lastMainIdea: { id: MoveIdeaId; piece: PieceType } | null;
  lastPlanKey: string | null;
  lastPlanPly: number | null;
  /** opening-principle facts (§3.1) already said this game */
  rulesSaid: string[];
  conceptsThisGame: string[];
  lastConceptPly: number | null;
  openingsAnnounced: string[];
  /** the repertoire was in book at the last turn, and the model move the child was expected to play */
  repertoireInBook: boolean;
  repertoireNextSan: string | null;
  /** the opponent's model reply after that move; null = the line ended there (the bot cannot «leave» it) */
  repertoireOppNext?: string | null;
  lastApprovalPly: number | null;
  lastApprovalWord: string | null;
  /** the advice of the last turn (compare the child's next move with it; for a hidden treasure — the hidden move) */
  advice: TeachAdvice[];
  /** the turn that last asked «Что выбираешь?» (at most every `CHOICE_EVERY_TURNS` turns) */
  lastChoiceTurn?: number | null;
  /** «Поторопись!» was said (once a game) */
  hurrySaid?: boolean;
  /** the strategy intro was said by a teacher turn */
  strategyIntroSaid?: boolean;
  /** the ply at which «соперник свернул с дороги» was said (once per deviation) */
  strategyLeftPly?: number | null;
  /** the ply of the latest re-plan whose plan words were taken, and those words */
  replanPly?: number | null;
  planRu?: string | null;
  /** the re-plan words were said aloud */
  planRuSaid?: boolean;
  /** the phase of the last turn (a new phase is a reason to re-plan) */
  lastPhase?: PositionFacts['phase'] | null;
  /** how the last two advice sentences began, newest first (`TeachOpener`) — the next one begins differently */
  openers?: TeachOpener[];
  /** plan goals said from the rotation (`planGoalRu` `turn`), and the last one — the goals take turns */
  goalTurn?: number;
  lastGoalRu?: string | null;
  /** the reason of the last advice (brief words) — the same one is not said twice in a row */
  lastReasonRu?: string | null;
  /** the lesson model (docs/TEACHING.md): the rhythm of the lesson this game — pure data, restored by `restoreTeachMemory` */
  lesson?: LessonMemory;
  /** the lesson model: the last «Почему так?» step of a ply (the next press goes one level deeper) */
  lessonWhy?: { ply: number; step: number } | null;
  /** the lesson model, the turn side (./lesson/turn.ts): the danger cadence, the stage-5 «позже» rhythm, the advice said in words */
  lessonTurnMemo?: LessonTurnMemo | null;
}

/**
 * What the lesson turn remembers besides `LessonMemory` (docs/TEACHING.md §2.2, §2.3) — pure data of one game, read
 * tolerantly by ./lesson/turn.ts (a missing or malformed memo is the empty one).
 */
export interface LessonTurnMemo {
  /** child turns whose words spoke of a danger (its sentence, «можно не спасать», the danger quiz), newest last */
  dangerTurns: number[];
  /** child turns whose calm advice was told with the arrow later (stage 5) */
  laterTurns: number[];
  /** the last calm advice at stage 5 was told with the arrow later (the next calm one shows it at once) */
  lastCalmLater: boolean;
  /** the ply whose advice was said in words (a turn, a quiz answer, a reveal, «Совет»): «Как я и говорил» needs it */
  adviceSaidPly: number | null;
}

/**
 * How the advice sentence begins (so that remarks do not all begin with «По нашему плану…» and pass the variety
 * check). About every second turn leads with the opponent's move — «Соперник
 * вывел коня на эф шесть — по плану отвечаем слоном на цэ четыре: …» ('opp'); otherwise a head that differs from the
 * last two: plan heads for a plan move, advice heads for any other. The brief asks the voice for the same start.
 */
export type TeachOpener = 'opp' | 'plan' | 'planNext' | 'planStep' | 'planMove' | 'advice' | 'arrow' | 'good' | 'go' | 'calm';
const PLAN_OPENERS: readonly TeachOpener[] = ['plan', 'planNext', 'planStep', 'planMove'];
const ADVICE_OPENERS: readonly TeachOpener[] = ['advice', 'arrow', 'good', 'go'];
const CALM_OPENERS: readonly TeachOpener[] = ['calm', 'advice', 'go', 'good'];
/** The first words the brief asks for (null = «начни прямо с хода»; 'opp' has its own goal). */
const OPENER_WORDS: Readonly<Record<TeachOpener, string | null>> = {
  opp: null,
  plan: 'По нашему плану',
  planNext: 'Дальше по плану',
  planStep: 'Следующий шаг плана',
  planMove: null,
  advice: 'Мой совет',
  arrow: 'Смотри на зелёную стрелку',
  good: 'Хороший ход',
  go: 'Ходи',
  calm: 'Спокойно',
};

export function initialTeachMemory(): TeachMemory {
  return {
    turns: 0,
    lastPly: null,
    lastShape: null,
    calmStreak: 0,
    lastMainIdea: null,
    lastPlanKey: null,
    lastPlanPly: null,
    rulesSaid: [],
    conceptsThisGame: [],
    lastConceptPly: null,
    openingsAnnounced: [],
    repertoireInBook: false,
    repertoireNextSan: null,
    lastApprovalPly: null,
    lastApprovalWord: null,
    advice: [],
    lastChoiceTurn: null,
    hurrySaid: false,
    strategyIntroSaid: false,
    strategyLeftPly: null,
    replanPly: null,
    planRu: null,
    planRuSaid: false,
    lastPhase: null,
    openers: [],
    goalTurn: 0,
    lastGoalRu: null,
    lastReasonRu: null,
  };
}

/** A danger of the child's position (§2.3 b) — one is named aloud. */
export interface TeachDanger {
  kind: 'check' | 'mate' | 'hanging' | 'threat';
  /** Russian fact for the brief (third person) */
  factRu: string;
  /** Russian phrase for the template (on «ты») */
  textRu: string;
  /** the opponent's move of the danger, spoken («ферзь бьёт на эф семь») — for «Можно назвать» */
  threatSpoken?: string;
  /** the answer to «Как думаешь, чего хочет соперник?» when the answer is this danger («Он грозит матом!») */
  answerRu?: string;
  squares: Square[];
  arrows: { from: Square; to: Square }[];
  /** the child's endangered piece (hanging) */
  piece?: { piece: PieceType; square: Square };
  /** the primary advice does not save it — the brief says why one may leave it */
  unresolvedRu?: string;
  conceptId?: string;
  /** «Записи»: the danger as a recorded line, piece only — the red square is on the board (./clips/twins.ts) */
  clip?: ClipItem;
}

/** A hidden «treasure» (§2.6). */
export interface TeachTreasure {
  uci: string;
  san: string;
  /** own piece (blue) and the target (yellow; the enemy king for a mate) */
  from: Square;
  target: Square;
  kind: 'mate' | 'capture' | 'tactic';
  /** brief fact without the move («конь соперника на дэ четыре стоит без защиты») */
  factRu: string;
  /** template sentence on «ты» */
  textRu: string;
  /** which own piece can do it («забрать может ферзь») — named, the move is not */
  pieceRu: string;
  /** «Записи»: the treasure as a recorded line — what it is, never the square or the move */
  clip?: ClipItem;
}

/** One middlegame / endgame plan (§5.1). */
export interface PlanHint {
  id: 'castleSoon' | 'tradeWhenAhead' | 'mateTechnique' | 'kingToCenter' | 'pushPassed' | 'improveWorstPiece';
  /** the plan for the brief, third person */
  factRu: string;
  /** the plan for the template */
  textRu: string;
  squares: Square[];
}

/**
 * The ONE thing a teacher turn may say besides its advice (the move + one reason): short
 * and clear, nothing extra. A voice model says nearly every fact of a brief (the opponent's move, an approval, a new
 * topic, the new plan, a principle) and runs past 25 words when a turn carries three or four of them, so
 * `planTeachTurn` picks at most one, by importance
 * (`TEACH_EXTRA_ORDER`); the others wait for a later turn or are dropped. A new topic (a concept card or an opening
 * principle) is a rare moment of its own: only on a turn with nothing else to say, it explains the advice itself, and
 * at most `CONCEPTS_PER_GAME` topics a game (cards and principles together), `CONCEPT_EVERY_PLIES` apart.
 */
export type TeachExtra = 'danger' | 'deviation' | 'bookLeft' | 'openingPlan' | 'ownGood' | 'newPlan' | 'unguarded' | 'opponent' | 'plan' | 'topic' | 'name' | 'onlyMove';

/**
 * The order in which a turn's one extra is chosen (first eligible wins). The opponent's move comes twice: his news (a
 * threat, a capture, an attack, an early queen) before a plan or a topic, the plain «the advice answers that move» after.
 */
export const TEACH_EXTRA_ORDER: readonly TeachExtra[] = ['danger', 'deviation', 'bookLeft', 'openingPlan', 'ownGood', 'newPlan', 'unguarded', 'opponent', 'plan', 'topic', 'opponent', 'name', 'onlyMove'];

/** Everything one teacher turn will say — `buildTeachTurn` turns it into the event, the game keeps it for «Совет». */
export interface TeachPlan {
  moment: Extract<TeachMoment, 'turn' | 'openingPlan'>;
  style: TeachStyle;
  shape: TeachShape;
  mode: TeachMode;
  ply: number;
  fen: string;
  childColor: Color;
  profile: StudentProfile;
  timed: boolean;
  advice: AdviceCandidate[];
  treasure: TeachTreasure | null;
  danger: TeachDanger | null;
  opponent: { san: string; spokenRu: string; ideas: MoveIdea[]; wants: Threat | null; earlyQueen: boolean; fenBefore: string } | null;
  /** the reaction glued into this turn (followed / ownGood / fine), null when nothing is said; `prio` keeps an own good move in the brief */
  reaction: { kind: ReactionKind; factRu: string; textRu: Template; shortRu?: Template; prio: number; clip?: ClipItem | null } | null;
  /** the plan sentence (opening or middlegame), null when not said this time; `clip` = its recorded line (none: not voiced from clips) */
  plan: { key: string; factRu: string; textRu: string; clip?: ClipItem | null } | null;
  /** extra facts: the opponent left the book, «здесь один хороший ход», no engine … */
  notes: string[];
  /** an opening principle (§3.1) said this turn */
  rules: string[];
  openingName: string | null;
  conceptId: string | null;
  concept: { id: string; title: string; factsRu: string[]; textRu: string; prio: number } | null;
  /** the strategy of the game (null = none) */
  strategy: TeachStrategy | null;
  /** this turn is the strategy intro («В этот раз разыграем …») */
  intro: boolean;
  /** the `gameStart` intro already named this very move: the game may keep the arrows and not say the turn again */
  alreadySaid: boolean;
  /**
   * the opponent left the strategy's road this turn: «Соперник свернул с нашей дороги — теперь …»; `goalRu` = the plan
   * goal said inside that line (a recorded twin says it as the advice's tail instead), `clip` = the recorded line
   */
  deviation: { factRu: string; textRu: string; shortRu: string; goalRu?: string | null; clip?: ClipItem } | null;
  /** new plan words of the smart strategist said this turn */
  newPlanRu: string | null;
  /** the opponent's move is worth a few words («Соперник вывел коня на эф шесть.»); null = do not narrate it */
  opponentMentionRu: string | null;
  /** «Записи»: the same words as a recorded line, piece only («Соперник вывел коня.») */
  opponentClip?: ClipItem | null;
  /** «Что выбираешь?» may be asked this turn */
  choice: boolean;
  /** «Поторопись!» this turn (once a game, < `HURRY_MS`) */
  hurry: boolean;
  /** how the advice sentence begins (null: the intro, a treasure, no advice) — 'opp' folds the opponent's move into it */
  opener: TeachOpener | null;
  /** the one extra said besides the advice (null = the advice alone); every other extra field above is null / empty */
  extra: TeachExtra | null;
  /** the memory to store for the next turn */
  memory: TeachMemory;
  /** the lesson model: what this turn will do (the moment, the advice shape, the quiz, the mini-lesson …); set by the lesson engine */
  lesson?: LessonTurnPlan;
}

// ═════════════════════════ small helpers ═════════════════════════

function ideasApi(ctx: { ideas?: MoveIdeasApi }): MoveIdeasApi {
  return ctx.ideas ?? REAL_IDEAS;
}

function safeFacts(fen: string): PositionFacts | null {
  try {
    return computePositionFacts(fen);
  } catch {
    return null;
  }
}

function safeHanging(fen: string) {
  try {
    return findHanging(fen);
  } catch {
    return [];
  }
}

function safeBoard(fen: string): Board | null {
  try {
    return parsePlacement(fen);
  } catch {
    return null;
  }
}

function sameSan(a: string, b: string): boolean {
  return a.replace(/[+#!?]+$/u, '') === b.replace(/[+#!?]+$/u, '');
}

function lineCp(line: Pick<EngineLine, 'cp' | 'mate'>): number {
  return teachScoreCp({ cp: line.cp, mate: line.mate });
}

/** Win% (0..100) of a comparable score (child's point of view). */
function winOf(cp: number): number {
  if (cp >= 90_000) return winPct({ cp: null, mate: 1 });
  if (cp <= -90_000) return winPct({ cp: null, mate: -1 });
  return winPct({ cp, mate: null });
}

/** The value (pawns) of what the bot's last move captured — a «gift» is measured against the material before it. */
function botTookPawns(ctx: Pick<TeachContext, 'lastBotMove'>): number {
  const b = ctx.lastBotMove;
  if (!b) return 0;
  const mv = resolveUciMove(b.fenBefore, b.uci);
  return mv?.captured ? VALUE_PAWNS[mv.captured] : 0;
}

/** The previous move for the explainer (a capture on the same square is a recapture). */
function prevOf(b: TeachContext['lastBotMove']): { uci: string; fenBefore: string } | null {
  return b ? { uci: b.uci, fenBefore: b.fenBefore } : null;
}

/**
 * The child's own units the bot's last move put en prise (pieces: SEE ≥ 200; a pawn: newly attacked by that move) —
 * the advice at stages 1–2 answers them first (§2.3 c).
 */
function threatenedUnits(ctx: Pick<TeachContext, 'fen' | 'childColor' | 'lastBotMove'>): Square[] {
  const now = safeHanging(ctx.fen).filter((h) => h.color === ctx.childColor && h.piece !== 'k');
  if (now.length === 0) return [];
  const before = ctx.lastBotMove ? safeHanging(ctx.lastBotMove.fenBefore).filter((h) => h.color === ctx.childColor) : [];
  return now
    .filter((h) => (h.piece !== 'p' ? h.seeLossCp >= 200 : h.seeLossCp >= 100 && !before.some((b) => b.square === h.square)))
    .map((h) => h.square);
}

/** Does the move leave the unit on `sq` safe (moved away with it, defended, blocked, or simply not en prise after)? */
function savesUnit(fen: string, uci: string, ideas: readonly MoveIdea[], sq: Square): boolean {
  if (ideas.some((i) => RESCUE_IDEAS.has(i.id) && (i.squares.includes(sq) || (i.id === 'escape' && parseUci(uci)?.from === sq)))) return true;
  const mv = resolveUciMove(fen, uci);
  if (!mv) return false;
  if (mv.from === sq) return seeLoss(parsePlacement(mv.fenAfter), squareIndex(mv.to)) === 0;
  const b1 = safeBoard(mv.fenAfter);
  const before = safeBoard(fen);
  if (!b1 || !before) return false;
  const idx = squareIndex(sq);
  const p0 = before[idx];
  const p1 = b1[idx];
  if (!p0 || !p1 || p0.type !== p1.type || p0.color !== p1.color) return false;
  // pseudo-legal SEE on the board after the move: a check does not «save» a hanging piece (G04 6.Сxf7+)
  return seeLoss(b1, idx) < 100;
}

/** «В дебюте» of §2.4: the opening phase, or the first ten moves (an early endgame is never the opening). */
function isOpeningTime(phase: PositionFacts['phase'] | undefined, ply: number): boolean {
  return phase === 'opening' || (ply <= TEACH_BOOK_MAX_PLY && phase !== 'endgame');
}

function isRealWin(idea: MoveIdea): boolean {
  return WIN_IDEAS.has(idea.id) || (idea.group === 'A' && (idea.gainPawns ?? 0) >= 2);
}

function mainIdea(ideas: readonly MoveIdea[]): MoveIdea | undefined {
  return ideas.find((i) => i.id !== 'centerControl');
}

function conceptOf(idea: MoveIdea): string | undefined {
  return idea.conceptId ?? IDEA_TO_CONCEPT[idea.id];
}

function words(profile: StudentProfile): StudentWords {
  return studentWords(profile);
}

/**
 * The «why» of an advised move for a sentence that already names the move: a castling needs no second «рокировка: …»
 * («короткая рокировка — король прячется в домик, а ладья выходит в игру»).
 */
function whyRu(a: Pick<AdviceCandidate, 'ideas' | 'san'>, voice: 'brief' | 'you' = 'brief', max = 2): string {
  // the move's own name already says «рокировка» / «превращается в ферзя»: the idea is not repeated after it
  const ideas = a.ideas.slice(0, max).filter((i) => !(i.id === 'promotion' && a.san.includes('=')));
  if (ideas.length === 0) return '';
  return stripMoveWordRu(joinIdeasRu(ideas, voice), a.san);
}

/** «короткая рокировка — рокировка: король…» → «короткая рокировка — король…». */
function stripMoveWordRu(why: string, san: string): string {
  return san.startsWith('O-O') ? why.replace(/^рокировка: /u, '') : why;
}

/**
 * The strategy of the game as one object: the server's `GameStrategy` (or a full `TeachStrategy`) merged with its
 * library card (used only when the ids match). null = no strategy.
 */
export function resolveTeachStrategy(ctx: Pick<TeachContext, 'strategy' | 'strategyCard'>): TeachStrategy | null {
  const s = ctx.strategy ?? null;
  const card = ctx.strategyCard ?? null;
  const c = card && (!s || card.id === s.strategyId) ? card : null;
  if (!s && !c) return null;
  const titleRu = (s?.titleRu || c?.titleRu || '').trim();
  if (!titleRu) return null;
  const out: TeachStrategy = { strategyId: s?.strategyId ?? c?.id ?? '', titleRu, ideaRu: (s?.ideaRu || c?.ideaRu || '').trim() };
  const titleAcc = s?.titleAccRu ?? c?.titleAccRu;
  if (titleAcc) out.titleAccRu = titleAcc;
  if (s?.introRu) out.introRu = s.introRu;
  const side = s?.side ?? c?.side;
  if (side) out.side = side;
  const against = s?.against ?? c?.against;
  if (against) out.against = against;
  const stepsRu = s?.stepsRu ?? c?.stepsRu;
  if (stepsRu) out.stepsRu = stepsRu;
  const middlegameRu = s?.middlegameRu ?? c?.middlegameRu;
  if (middlegameRu) out.middlegameRu = middlegameRu;
  const lineSan = s?.lineSan ?? c?.lineSan;
  if (lineSan) out.lineSan = lineSan;
  const mainLineSan = s?.mainLineSan ?? c?.mainLineSan;
  if (mainLineSan) out.mainLineSan = mainLineSan;
  const middlegameSan = s?.middlegameSan ?? c?.middlegameSan;
  if (middlegameSan) out.middlegameSan = middlegameSan;
  const themes = s?.themes ?? c?.themes;
  if (themes) out.themes = themes;
  // the goals the teacher keeps talking about once the game left the main line (`planGoalRu`, `planGoalFor`)
  const planGoalsRu = s?.planGoalsRu ?? c?.planGoalsRu;
  if (planGoalsRu) out.planGoalsRu = planGoalsRu;
  return out;
}

/** A move told as a step of the plan: the strategy's own move (line, tag, theme, re-plan) or one that serves a goal. */
function isPlanMove(a: Pick<AdviceCandidate, 'planFit' | 'planGoal'>, strategy: TeachStrategy | null): boolean {
  return !!strategy && (!!a.planFit || !!a.planGoal);
}

/** The one reason of an advice in brief words (third person): the strategist's «why», the goal, the card's step, the explainer's idea. */
function reasonRu(a: AdviceCandidate, voice: 'brief' | 'you' = 'brief', max = 1): string {
  if (a.noReason) return '';
  return a.planWhyRu ?? a.planGoal?.textRu ?? a.planStepRu?.textRu ?? whyRu(a, voice, max);
}

// ═════════════════════════ §2.4: which moves to advise ═════════════════════════

interface EngineState {
  mode: TeachMode;
  tolerance: number;
  maxAdvice: 1 | 2;
  best: EngineLine | null;
}

function engineState(analysis: AnalysisResult | null): EngineState {
  const lines = [...(analysis?.lines ?? [])].filter((l) => (l.pvUci[0] ?? '') !== '').sort((a, b) => a.multipv - b.multipv);
  const depth = Math.max(analysis?.depth ?? 0, ...lines.map((l) => l.depth));
  if (!analysis || lines.length === 0 || depth < TEACH_FALLBACK_DEPTH) return { mode: 'rules', tolerance: 0, maxAdvice: 1, best: null };
  if (depth < TEACH_MIN_DEPTH) return { mode: 'partial', tolerance: TEACH_PARTIAL_TOLERANCE_CP, maxAdvice: 1, best: lines[0] ?? null };
  return { mode: 'engine', tolerance: TEACH_TOLERANCE_CP, maxAdvice: 2, best: lines[0] ?? null };
}

/** The mode (engine / partial / rules) a context gives, for the game's degradation line (§2.1). */
export function teachModeOf(analysis: AnalysisResult | null): TeachMode {
  return engineState(analysis).mode;
}

/**
 * §2.4 п. 3: book moves of the position that the MultiPV lines do not contain — the game verifies them with
 * `judge.analyze(fen, { searchmoves: [uci], depth: max(10, d − 2), movetimeMs: TEACH_VERIFY_MOVETIME_MS, multipv: 1 })`
 * and passes the results back as `ctx.verified`. Opening time only, at most `TEACH_MAX_VERIFY`.
 */
export function bookMovesToVerify(
  ctx: Pick<TeachContext, 'fen' | 'ply' | 'analysis' | 'repertoire' | 'mainLineSans' | 'facts' | 'strategy' | 'strategyCard' | 'historySan'> & Partial<Pick<TeachContext, 'childColor'>>,
): string[] {
  const facts = ctx.facts ?? safeFacts(ctx.fen);
  if (!isOpeningTime(facts?.phase, ctx.ply)) return [];
  const known = new Set((ctx.analysis?.lines ?? []).map((l) => l.pvUci[0]).filter((u): u is string => !!u));
  const out: string[] = [];
  for (const san of curatedSans(ctx)) {
    const uci = sanToUci(ctx.fen, san);
    if (!uci || known.has(uci) || out.includes(uci)) continue;
    out.push(uci);
    if (out.length >= TEACH_MAX_VERIFY) break;
  }
  return out;
}

/** The curated moves of the position: the strategy's planned move first (verified offline), the repertoire, the main-line table. */
function curatedSans(ctx: Pick<TeachContext, 'repertoire' | 'mainLineSans' | 'strategy' | 'strategyCard' | 'historySan' | 'fen'> & Partial<Pick<TeachContext, 'childColor'>>): string[] {
  const out: string[] = [];
  const strategy = resolveTeachStrategy(ctx);
  const color = ctx.childColor ?? sideOf(ctx.fen);
  const planned = strategy ? strategyNextSan(strategy, ctx.historySan ?? [], color, ctx.fen) : null;
  if (planned) out.push(planned);
  const rep = ctx.repertoire;
  if (!strategy && rep && rep.inBook && rep.warning !== true && rep.nextChildSans[0]) out.push(rep.nextChildSans[0]);
  for (const san of ctx.mainLineSans ?? []) if (!out.some((s) => sameSan(s, san))) out.push(san);
  return out;
}

function sideOf(fen: string): Color {
  return fen.trim().split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

/** UCI of a SAN move in `fen` (null when it is not a legal move there). */
function sanToUci(fen: string, san: string): string | null {
  try {
    const hit = new Chess(fen).moves({ verbose: true }).find((m) => sameSan(m.san, san));
    return hit ? `${hit.from}${hit.to}${hit.promotion ?? ''}` : null;
  } catch {
    return null;
  }
}

interface RawCandidate {
  uci: string;
  cp: number;
  mate: number | null;
  pvUci: readonly string[];
  verifiedBy: AdviceCandidate['verifiedBy'];
  mv: ResolvedMove;
}

function bishopsAtHome(board: Board, color: Color): boolean {
  return BISHOP_HOMES[color].every((sq) => {
    const p = board[squareIndex(sq)];
    return !!p && p.type === 'b' && p.color === color;
  });
}

function attacksQueen(mv: ResolvedMove, them: Color): boolean {
  const b1 = safeBoard(mv.fenAfter);
  if (!b1) return false;
  return attacksFrom(b1, squareIndex(mv.to)).some((sq) => {
    const p = b1[sq];
    return !!p && p.type === 'q' && p.color === them;
  });
}

/** What the plan of the position asks for (§5.1: a move that follows the plan gets +0.5). */
function followsPlan(plan: PlanHint | null, mv: ResolvedMove, ideas: readonly MoveIdea[]): boolean {
  if (!plan) return false;
  const has = (id: MoveIdeaId): boolean => ideas.some((i) => i.id === id);
  switch (plan.id) {
    case 'castleSoon':
      return has('castle') || has('prepareCastle');
    case 'tradeWhenAhead':
      return has('trade') && mv.captured !== undefined && mv.captured !== 'p';
    case 'mateTechnique':
      return has('restrictKing');
    case 'kingToCenter':
      return has('kingActivity');
    case 'pushPassed':
      return has('passedPawn') || (mv.piece === 'p' && plan.squares.includes(mv.from));
    case 'improveWorstPiece':
      return plan.squares.includes(mv.from);
  }
}

/**
 * The advice of the position (§2.4), deterministic: engine lines within the tolerance, book moves verified by
 * `searchmoves`, the kid filter in the opening, the teach score, «a real win is never hidden», and the alternative
 * rules. Returns 0–2 candidates, primary first. `opts.max` caps the count (1 in the short style).
 */
export function pickAdvice(ctx: TeachContext, opts: { max?: 1 | 2; plan?: PlanHint | null } = {}): AdviceCandidate[] {
  const api = ideasApi(ctx);
  const facts = ctx.facts ?? safeFacts(ctx.fen);
  const stage = ctx.profile.stage;
  const engine = engineState(ctx.analysis);
  const opening = isOpeningTime(facts?.phase, ctx.ply);
  const me = ctx.childColor;
  const them = opposite(me);
  const board = safeBoard(ctx.fen);
  if (!board) return [];

  // 1. candidates with a score
  const raw: RawCandidate[] = [];
  const add = (uci: string, line: Pick<EngineLine, 'cp' | 'mate' | 'pvUci'> | null, verifiedBy: AdviceCandidate['verifiedBy']): void => {
    if (raw.some((c) => c.uci === uci)) return;
    const mv = resolveUciMove(ctx.fen, uci);
    if (!mv) return;
    raw.push({ uci, cp: line ? lineCp(line) : 0, mate: line?.mate ?? null, pvUci: line?.pvUci ?? [uci], verifiedBy, mv });
  };
  if (engine.mode !== 'rules') {
    for (const line of [...(ctx.analysis?.lines ?? [])].sort((a, b) => a.multipv - b.multipv)) {
      const uci = line.pvUci[0];
      if (uci) add(uci, line, 'multipv');
    }
    if (opening) for (const line of ctx.verified ?? []) if (line.pvUci[0]) add(line.pvUci[0], line, 'searchmoves');
  } else if (ctx.ply <= TEACH_BOOK_MAX_PLY) {
    // no engine: only curated moves of the first ten moves, and only when statically safe (§2.1)
    for (const san of curatedSans(ctx)) {
      const uci = sanToUci(ctx.fen, san);
      if (!uci) continue;
      const mv = resolveUciMove(ctx.fen, uci);
      if (!mv) continue;
      const hangsAfter = safeHanging(mv.fenAfter).some((h) => h.color === me && h.seeLossCp >= 100);
      if (!hangsAfter) add(uci, null, 'curated');
    }
  }
  if (raw.length === 0) return [];

  // the strategy of the game: its planned moves get a bonus and a slightly wider (still «good») tolerance in the
  // opening — the library lines are engine-verified within STRATEGY_TOLERANCE_CP
  const strategy = resolveTeachStrategy(ctx);
  const history = ctx.historySan ?? [];
  const progress = strategyProgress(strategy, history, me);
  const planned = strategy ? strategyNextSan(strategy, history, me, ctx.fen) : null;
  const isPlanned = (san: string): boolean => (planned !== null && sameSan(planned, san)) || (progress?.remaining.some((m) => sameSan(m, san)) ?? false);

  // 2. tolerance against the first line
  const bestCp = engine.best ? lineCp(engine.best) : 0;
  const bestMate = engine.best?.mate ?? null;
  const accepted = raw.filter((c) => {
    if (c.verifiedBy === 'curated') return true;
    if (bestMate !== null && bestMate > 0 && bestMate <= 3) return c.mate === bestMate;
    const lossWin = winOf(bestCp) - winOf(c.cp);
    if (lossWin >= TEACH_MAX_WIN_PCT_LOSS) return false;
    const tolerance = opening && engine.mode === 'engine' && isPlanned(c.mv.san) ? Math.max(engine.tolerance, STRATEGY_TOLERANCE_CP) : engine.tolerance;
    return bestCp - c.cp <= tolerance || (winOf(bestCp) >= 90 && winOf(c.cp) >= 90);
  });
  if (accepted.length === 0) return [];

  // 3. ideas, sources, kid filter, teach score
  const repRaw = ctx.repertoire && ctx.repertoire.inBook && ctx.repertoire.warning !== true ? ctx.repertoire.nextChildSans[0] : undefined;
  // with a strategy the repertoire counts only where it agrees with it (the strategy of THIS game leads)
  const repNext = strategy && repRaw !== undefined && !(planned !== null && sameSan(planned, repRaw)) ? undefined : repRaw;
  const mainLine = ctx.mainLineSans ?? [];
  const oppEarlyQueen = ctx.lastBotMove ? isEarlyQueenMove(ctx.lastBotMove.fenBefore, ctx.lastBotMove.uci) : false;
  const knightsFirst = bishopsAtHome(board, me);
  const prev = prevOf(ctx.lastBotMove);
  // the opening name of the position itself: a move is «известный» only when IT brings a new name (G07 1…Кc6 is
  // «Дебют Нимцовича» before and after 2.d4 — that name belongs to the position, not to d4)
  const nameHere = safeName(ctx, ctx.fen);
  const depth = Math.max(ctx.analysis?.depth ?? 0, ...(ctx.analysis?.lines ?? []).map((l) => l.depth));
  const noisy = depth < TEACH_NOISE_DEPTH;
  const threatened = stage <= 2 ? threatenedUnits(ctx) : [];
  const scored = accepted.map((c) => {
    const allIdeas = safeExplain(api, { fen: ctx.fen, uci: c.uci, pvUci: c.pvUci, lineScore: c.verifiedBy === 'curated' ? undefined : { cp: c.mate === null ? c.cp : null, mate: c.mate }, phase: facts?.phase, prev });
    let fit = planFitOf(strategy, progress, c.mv.san, allIdeas, ctx.fen);
    // off the main line the next legal planned move is still «наш план» (a system move)
    if (fit === null && planned !== null && sameSan(planned, c.mv.san)) fit = 'lineLater';
    const isRep = (repNext !== undefined && sameSan(repNext, c.mv.san)) || fit === 'line';
    const isMain = mainLine.some((s) => sameSan(s, c.mv.san));
    const nameRu = safeName(ctx, c.mv.fenAfter);
    const bookName = nameRu && !GENERIC_OPENING_NAMES.has(nameRu) && nameRu !== nameHere ? nameRu : undefined;
    // at the initial position there is no opening yet: «так часто начинают» is the honest label for e4 / d4
    const source: AdviceSource = isRep && !(isMain && ctx.ply <= 1) ? 'repertoire' : isMain ? 'mainLine' : isRep ? 'repertoire' : bookName && c.verifiedBy !== 'curated' ? 'book' : 'engine';
    const hasA = allIdeas.some((i) => i.group === 'A');
    // any queen move while two minor pieces sleep (a pawn grab too) — G02 3.Фg3, G08 7.Фb3 / 8.Фxb7
    const earlyQueen = opening && isKidFilteredQueenMove(ctx.fen, c.uci, allIdeas);
    const kingWalk = opening && c.mv.piece === 'k' && !c.mv.isCastle && accepted.length > 1;
    // flank pawns and rim knights in the opening, even when they attack something (G01 5.b4, G11 6.Кa4)
    const edgePawn = opening && c.mv.piece === 'p' && 'abgh'.includes(c.mv.from[0] ?? '') && !hasA;
    const rimKnight = opening && c.mv.piece === 'n' && 'ah'.includes(c.mv.to[0] ?? '') && !hasA;
    const kidFiltered = earlyQueen || kingWalk || edgePawn || rimKnight;
    const gap = bestCp - c.cp;
    let score = noisy && gap <= TEACH_NOISE_CP ? 0 : -gap / 10;
    if (c.verifiedBy === 'curated') score = 0;
    if (fit === 'line') score += STRATEGY_LINE_BONUS;
    else if (isRep) score += 2;
    if (fit === 'lineLater') score += STRATEGY_LATER_BONUS;
    if (fit === 'middlegame') score += STRATEGY_MIDDLEGAME_BONUS;
    if (isMain) score += 1.5;
    if (opening && allIdeas.some((i) => PRINCIPLE_IDEAS.has(i.id))) score += PRINCIPLE_BONUS;
    if (c.mv.piece === 'n' && KNIGHT_HOMES[me].includes(c.mv.from) && knightsFirst) score += 0.3;
    if (oppEarlyQueen && attacksQueen(c.mv, them) && allIdeas.some((i) => i.id === 'develop')) score += 0.5;
    if (followsPlan(opts.plan ?? null, c.mv, allIdeas)) score += 0.5;
    if (threatened.length > 0 && threatened.every((sq) => savesUnit(ctx.fen, c.uci, allIdeas, sq))) score += RESCUE_BONUS;
    if (kidFiltered) score -= 1;
    return { c, allIdeas, source, kidFiltered, score, bookName, fit };
  });

  const byScore = [...scored].sort((a, b) => b.score - a.score || b.c.cp - a.c.cp || raw.indexOf(a.c) - raw.indexOf(b.c));
  // «a real win is never hidden behind a “proper” move»: a mate / ≥ 2 pawns / promotion becomes the primary
  const winners = scored.filter((s) => s.allIdeas.some(isRealWin)).sort((a, b) => b.c.cp - a.c.cp || b.score - a.score);
  const eligible = byScore.filter((s) => !s.kidFiltered);
  let primary = winners[0] ?? eligible[0] ?? byScore[0];
  if (!primary) return [];
  // stages ≤ 3: a move the child can understand beats an unexplained one within the tolerance (G12 4…Кxe4 had no «why»)
  const explained = (s: (typeof scored)[number]): boolean => s.allIdeas.some((i) => i.id !== 'quiet' && i.id !== 'centerControl');
  if (!winners[0] && stage <= 3 && !explained(primary)) {
    const better = eligible.find((s) => s !== primary && explained(s));
    if (better) primary = better;
  }
  // the smart strategist's choice for THIS ply (a stale answer is dropped): one of the accepted candidates, never a
  // kid-filtered one, never instead of a real win
  const replan = freshReplan(ctx.replan, ctx.ply);
  const replanWhy = replanWords(replan).whyRu;
  const preferred = replan?.preferredUci ? scored.find((x) => x.c.uci === replan.preferredUci && !x.kidFiltered) : undefined;
  if (preferred && !winners[0]) primary = preferred;

  const say1 = (s: (typeof scored)[number]): MoveIdea[] => api.pickIdeas(s.allIdeas, { stage, max: 2 });
  const toCandidate = (s: (typeof scored)[number], role: AdviceCandidate['role']): AdviceCandidate => {
    const out: AdviceCandidate = {
      uci: s.c.uci,
      san: s.c.mv.san,
      spokenRu: sanToSpokenRu(s.c.mv.san, ctx.fen),
      scoreCp: s.c.cp,
      role,
      arrow: role === 'primary' ? 'green' : 'blue',
      source: s.source,
      ideas: say1(s),
      verifiedBy: s.c.verifiedBy,
      allIdeas: s.allIdeas,
      teachScore: Math.round(s.score * 100) / 100,
      mate: s.c.mate,
      kidFiltered: s.kidFiltered,
    };
    if (s.bookName) out.openingNameRu = s.bookName;
    if (s === preferred && role === 'primary') {
      out.planFit = 'replan';
      if (replanWhy) out.planWhyRu = replanWhy;
    } else if (s.fit) out.planFit = s.fit;
    // a tactic, a rescue, a capture is the position's move, not the plan's — unless it IS the next move of the line
    const positional = !out.ideas[0] || !NOT_PLAN_IDEAS.has(out.ideas[0].id);
    if (!positional && out.planFit !== 'line' && out.planFit !== 'replan') delete out.planFit;
    // the goal of the plan this move serves (also off the main line) — its reason «по нашему плану»
    const goal = positional && out.planFit !== 'replan' ? planGoalFor(strategy, { san: s.c.mv.san, ideas: s.allIdeas, fen: ctx.fen, color: me }) : null;
    if (goal) out.planGoal = goal;
    // a plan move whose only «why» is «спокойный крепкий ход»: the strategy card says what it is for
    const weak = out.ideas.every((i) => WEAK_IDEAS.has(i.id));
    if (!goal && out.planFit && out.planFit !== 'replan' && out.planFit !== 'theme' && weak) {
      const step = planStepRu(strategy, s.c.mv.san);
      if (step) out.planStepRu = step;
    }
    return out;
  };
  const out = [toCandidate(primary, 'primary')];

  // 4. the alternative (§2.4 п. 6)
  const max = Math.min(opts.max ?? 2, engine.maxAdvice);
  const lines = [...(ctx.analysis?.lines ?? [])].sort((a, b) => a.multipv - b.multipv);
  const second = lines[1];
  const gapToSecond = second && engine.best ? bestCp - lineCp(second) : 0;
  const treasure = stage <= TREASURE_MAX_STAGE && treasureIdea(primary.allIdeas, botTookPawns(ctx)) !== null;
  if (max >= 2 && !treasure && !(second && gapToSecond > TEACH_TOLERANCE_CP)) {
    const pMain = mainIdea(primary.allIdeas);
    const pBook = primary.source === 'repertoire' || primary.source === 'mainLine' || mainLine.some((s) => sameSan(s, primary.c.mv.san));
    const alt = byScore.find((s) => {
      if (s === primary || s.kidFiltered) return false;
      const sMain = mainIdea(s.allIdeas);
      const sBook = s.source === 'repertoire' || s.source === 'mainLine';
      const otherIdea = (sMain?.id ?? 'none') !== (pMain?.id ?? 'none');
      const otherPiece = s.c.mv.piece !== primary.c.mv.piece;
      return otherIdea || otherPiece || (pBook && sBook);
    });
    if (alt) {
      const second = toCandidate(alt, 'alternative');
      // one book name, one move: the same «известный ход, у него есть имя» twice would be false for one of them
      if (second.source === 'book' && out[0]?.source === 'book' && second.openingNameRu === out[0].openingNameRu) second.source = 'engine';
      out.push(second);
    }
  }
  return out;
}

function safeExplain(api: MoveIdeasApi, a: ExplainMoveArgs): MoveIdea[] {
  try {
    return api.explainMove(a);
  } catch {
    return [];
  }
}

function safeName(ctx: Pick<TeachContext, 'openingNameRu'>, fen: string): string | undefined {
  try {
    return ctx.openingNameRu?.(fen);
  } catch {
    return undefined;
  }
}

/**
 * Is there a «treasure» idea (§2.6) among the primary advice's ideas? A gift is measured against the material BEFORE
 * the bot's last move (`botTook` = what that move captured): taking back a piece the bot has just taken is a trade,
 * not a present (G08 5.Фxf3 after 4…Сxf3; G12 5…d5 regaining the knight) — the net gain must be ≥ 2 pawns.
 */
function treasureIdea(ideas: readonly MoveIdea[], botTook = 0): MoveIdea | null {
  for (const i of ideas) {
    const gain = i.gainPawns ?? 0;
    if (i.id === 'mate' || i.id === 'mateSoon') return i;
    if (TACTIC_IDEAS.has(i.id) && gain >= 2 && gain - botTook >= 2) return i;
    if ((i.id === 'freeCapture' || i.id === 'winMaterial') && gain >= 3 && gain - botTook >= 2) return i;
  }
  return null;
}

// ═════════════════════════ §2.3 b: dangers ═════════════════════════

function findDanger(ctx: TeachContext, facts: PositionFacts | null, s: StudentWords): TeachDanger | null {
  const me = ctx.childColor;
  if (facts?.inCheck) {
    return { kind: 'check', factRu: `королю ${s.gen} объявлен шах — сначала спасаем короля`, textRu: 'Шах! Сначала спасаем короля.', squares: [], arrows: [], clip: lineItem('danger.check') };
  }
  // mate: the engine null-move threat (≤ 3) or a static mate in one
  let mate: Threat | null = ctx.threat && isMateMotif(ctx.threat.motif) ? ctx.threat : null;
  if (!mate) {
    try {
      mate = mateInOneThreat(ctx.fen);
    } catch {
      mate = null;
    }
  }
  if (mate) {
    const parts = parseUci(mate.uci);
    const nullFen = nullMoveFen(ctx.fen);
    const spoken = nullFen ? spokenMoveRu(mate.san, nullFen) : '';
    const target = parts?.to;
    const onF7 = target === (me === 'w' ? 'f2' : 'f7');
    const actor = parts && nullFen ? pieceAt(nullFen, parts.from) : undefined;
    const conceptId = mate.motif === 'backRankMate' ? 'back-rank-mate' : onF7 && actor?.piece === 'q' ? 'scholars-mate' : 'mate-in-1';
    const why = onF7 ? `; клетку ${squareToSpokenRu(target ?? '')} в начале партии защищает только король — поэтому она слабая` : '';
    return {
      kind: 'mate',
      factRu: `соперник грозит матом${spoken ? `: ${spoken}` : ''}${why}`,
      textRu: 'Осторожно: соперник грозит матом!',
      answerRu: 'Он грозит матом!',
      threatSpoken: spoken || undefined,
      squares: target ? [target] : [],
      arrows: parts ? [{ from: parts.from, to: parts.to }] : [],
      conceptId,
      clip: lineItem('danger.mate'),
    };
  }
  const minPawnSee = ctx.profile.stage >= 3 ? 100 : Number.POSITIVE_INFINITY;
  const hanging = (facts?.hanging ?? safeHanging(ctx.fen))
    .filter((h) => h.color === me && h.piece !== 'k' && (h.piece === 'p' ? h.seeLossCp >= minPawnSee : h.seeLossCp >= 200))
    .sort((a, b) => b.seeLossCp - a.seeLossCp);
  const target = hanging[0];
  if (target) {
    const attackers = target.attackers.slice(0, 2);
    const attackerNames = attackers.map((sq) => pieceAt(ctx.fen, sq)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => `${pieceNameRu(p.piece, 'nom')} соперника`);
    return {
      kind: 'hanging',
      factRu: `под боем ${pieceOnRu(target.piece, target.square)}${attackerNames.length > 0 ? `, нападает ${attackerNames.join(' и ')}` : ''}, защиты не хватает`,
      textRu: `Осторожно: ${pieceGenderOwn(target.piece)} ${pieceNameRu(target.piece, 'nom')} на ${squareToSpokenRu(target.square)} под боем!`,
      answerRu: `Забрать ${pieceGenderOwnAcc(target.piece)} ${pieceNameRu(target.piece, 'acc')} на ${squareToSpokenRu(target.square)}!`,
      squares: [target.square],
      arrows: attackers.map((from) => ({ from, to: target.square })),
      piece: { piece: target.piece, square: target.square },
      conceptId: 'hanging-piece',
      // (piece only: «Осторожно: твой конь под боем!» — the red square shows where)
      clip: lineItem('danger.hanging', { piece: target.piece }),
    };
  }
  const threat = ctx.threat && !isMateMotif(ctx.threat.motif) ? ctx.threat : null;
  if (threat) {
    const parts = parseUci(threat.uci);
    const nullFen = nullMoveFen(ctx.fen);
    const spoken = nullFen ? spokenMoveRu(threat.san, nullFen) : '';
    const facts = threatFactsRu(ctx.fen, threat, s);
    return {
      kind: 'threat',
      // the first sentence joins the brief's facts (lower-cased like the others); the next ones keep their capital
      factRu: facts.map((f, i) => (i === 0 ? f.charAt(0).toLowerCase() + f.slice(1) : f)).join('. '),
      textRu: threat.motif === 'fork' ? 'Осторожно: соперник готовит вилку!' : 'Осторожно: соперник что-то задумал!',
      ...(threat.motif === 'fork' ? { answerRu: 'Он готовит вилку!' } : {}),
      threatSpoken: spoken || undefined,
      squares: threat.targetSquares.slice(0, 2),
      arrows: parts ? [{ from: parts.from, to: parts.to }] : [],
      conceptId: threat.motif === 'fork' ? 'fork' : threat.motif === 'hangingPiece' ? 'hanging-piece' : undefined,
      clip: lineItem(threat.motif === 'fork' ? 'danger.fork' : 'danger.threat'),
    };
  }
  return null;
}

function pieceGenderOwn(p: PieceType): string {
  return p === 'p' || p === 'r' ? 'твоя' : 'твой';
}

/** «твою пешку» / «твоего коня» (accusative). */
function pieceGenderOwnAcc(p: PieceType): string {
  return p === 'p' || p === 'r' ? 'твою' : 'твоего';
}

/**
 * Does the primary advice deal with the danger? If not, the brief says honestly why one may leave the piece (§2.3 c).
 * The check is on the board after the move (pseudo-legal SEE): `findHanging` of a position where the opponent is in
 * check lists nothing, so a checking move would otherwise count as «saving» the piece (G04 6.Сxf7+ with the queen en prise).
 */
function resolveDanger(danger: TeachDanger, primary: AdviceCandidate | undefined, fen: string): TeachDanger {
  if (!primary || danger.kind !== 'hanging' || !danger.piece) return danger;
  const sq = danger.piece.square;
  if (savesUnit(fen, primary.uci, primary.allIdeas, sq)) return danger;
  const mv = resolveUciMove(fen, primary.uci);
  const name = pieceNameRu(danger.piece.piece, 'acc');
  if (mv?.givesCheck) {
    return { ...danger, unresolvedRu: `можно не спасать ${name} сразу: ${primary.spokenRu} — это шах, сначала соперник спасает короля` };
  }
  const win = primary.ideas.find(isRealWin) ?? primary.ideas[0];
  const why = win ? joinIdeasRu([win]) : 'так сильнее — это проверено';
  return { ...danger, unresolvedRu: `можно не спасать ${name}: ход ${primary.spokenRu} сильнее — ${why}` };
}

// ═════════════════════════ §2.6: the treasure ═════════════════════════

function buildTreasure(ctx: TeachContext, primary: AdviceCandidate | undefined): TeachTreasure | null {
  if (!primary || ctx.profile.stage > TREASURE_MAX_STAGE || primary.verifiedBy === 'curated') return null;
  const idea = treasureIdea(primary.allIdeas, botTookPawns(ctx));
  if (!idea) return null;
  const mv = resolveUciMove(ctx.fen, primary.uci);
  if (!mv) return null;
  const pieceRu = pieceNameRu(mv.piece, 'nom');
  if (idea.id === 'mate' || idea.id === 'mateSoon') {
    const board = safeBoard(ctx.fen);
    const king = board ? findKing(board, opposite(ctx.childColor)) : -1;
    const n = idea.id === 'mate' ? 1 : (primary.mate ?? 2);
    const inN = n <= 1 ? 'в один ход' : n === 2 ? 'в два хода' : 'в три хода';
    // a mate in one is not «started» — it is given
    const who = n <= 1 ? `поставить мат может ${pieceRu}` : `первым ходит ${pieceRu}`;
    return {
      uci: primary.uci,
      san: primary.san,
      from: mv.from,
      target: king >= 0 ? squareName(king) : mv.to,
      kind: 'mate',
      factRu: `у ${studentWords(ctx.profile).gen} есть мат ${inN}: ${who}`,
      textRu: `Смотри, тут подарок: есть мат ${inN}!`,
      pieceRu,
      clip: lineItem(n <= 1 ? 'treasure.mate1' : n === 2 ? 'treasure.mate2' : 'treasure.mate3'),
    };
  }
  if (idea.id === 'freeCapture' || idea.id === 'winMaterial') {
    const victim = mv.captured ?? 'p';
    const free = idea.id === 'freeCapture';
    const on = `соперника на ${squareToSpokenRu(mv.to)}`;
    // «ферзь соперника … стоит без защиты», but «ферзя соперника … можно выгодно забрать» (the object of «забрать»)
    const what = `${pieceNameRu(victim, 'nom')} ${on}`;
    const whatAcc = `${pieceNameRu(victim, 'acc')} ${on}`;
    return {
      uci: primary.uci,
      san: primary.san,
      from: mv.from,
      target: mv.to,
      kind: 'capture',
      factRu: free ? `${what} стоит без защиты — забрать может ${pieceRu}` : `${whatAcc} можно выгодно забрать — это может сделать ${pieceRu}`,
      textRu: free ? `Смотри, тут подарок: ${what} стоит без защиты!` : `Смотри, тут подарок: ${whatAcc} можно выгодно забрать!`,
      pieceRu,
      // (the victim only — «Смотри, тут подарок: конь соперника без защиты!»; the yellow square shows where)
      clip: lineItem(free ? 'treasure.free' : 'treasure.win', { piece: victim }),
    };
  }
  const title = motifTitleInlineRu(idea.id as MotifId);
  const target = idea.squares[0] ?? mv.to;
  // no gendered pronoun: «сквозной удар», «двойной шах» are masculine, «вилка», «связка» feminine
  const trapped = idea.id === 'trappedPiece';
  return {
    uci: primary.uci,
    san: primary.san,
    from: mv.from,
    target,
    kind: 'tactic',
    factRu: trapped
      ? `у ${studentWords(ctx.profile).gen} можно поймать фигуру соперника: ей некуда уйти; это может сделать ${pieceRu}`
      : `у ${studentWords(ctx.profile).gen} есть ${title}: так выигрывается материал; это может сделать ${pieceRu}`,
    textRu: trapped ? 'Смотри, тут подарок: можно поймать фигуру соперника!' : `Смотри, тут подарок: есть ${title}!`,
    pieceRu,
    clip: lineItem(TREASURE_TACTIC_LINES[idea.id] ?? 'treasure.gift'),
  };
}

/** The treasure lines of the tactics (`treasureIdea`'s TACTIC_IDEAS). */
const TREASURE_TACTIC_LINES: Readonly<Partial<Record<MoveIdeaId, string>>> = {
  fork: 'treasure.fork',
  pin: 'treasure.pin',
  skewer: 'treasure.skewer',
  discoveredAttack: 'treasure.discovered',
  doubleCheck: 'treasure.doubleCheck',
  removeDefender: 'treasure.removeDefender',
  trappedPiece: 'treasure.trapped',
};

// ═════════════════════════ §3: the opening plan ═════════════════════════

export interface OpeningPlanArgs {
  fen: string;
  childColor: Color;
  stage: number;
  repertoire?: RepertoirePlanLike | null;
  facts?: PositionFacts | null;
}

/** The plan of the opening in words (§3.3): from the repertoire when the game is in book, else by the principles. */
export interface OpeningPlanFacts {
  /** changes when the plan changes (a new line, or the principles) */
  key: string;
  source: 'repertoire' | 'principles';
  /** facts for the brief (third person, Latin-free) */
  factsRu: string[];
  /** the plan sentence for the template */
  textRu: string;
  /** the child's planned moves in words («конь на эф три») */
  spokenMoves: string[];
}

/** The child's next model moves spoken position by position along the model continuation. */
function spokenPlanMoves(fen: string, childColor: Color, rep: RepertoirePlanLike, max: number): { spoken: string[]; castles: boolean } {
  const spoken: string[] = [];
  let castles = false;
  const cont = rep.continuationSan ?? [];
  if (cont.length > 0) {
    let chess: Chess;
    try {
      chess = new Chess(fen);
    } catch {
      return { spoken, castles };
    }
    for (const san of cont) {
      const before = chess.fen();
      const mover = chess.turn();
      let played;
      try {
        played = chess.move(san);
      } catch {
        break;
      }
      if (mover !== childColor) continue;
      if (played.isKingsideCastle() || played.isQueensideCastle()) castles = true;
      if (spoken.length < max) spoken.push(sanToSpokenRu(played.san, before));
    }
    return { spoken, castles };
  }
  for (const san of rep.nextChildSans.slice(0, max)) spoken.push(sanToSpokenRu(san));
  castles = rep.nextChildSans.some((s) => s.startsWith('O-O'));
  return { spoken, castles };
}

/** «План: пешка на е четыре, потом конь на эф три — а потом рокировка» / by the principles. */
export function openingPlanFacts(a: OpeningPlanArgs): OpeningPlanFacts {
  const facts = a.facts ?? safeFacts(a.fen);
  const me = a.childColor;
  const castled = facts?.castled[me] ?? false;
  const canCastle = facts?.canStillCastle[me] ?? false;
  const rep = a.repertoire;
  if (rep && rep.inBook && rep.warning !== true && rep.nextChildSans.length > 0) {
    const { spoken, castles } = spokenPlanMoves(a.fen, me, rep, 2);
    if (spoken.length > 0) {
      // «…потом короткая рокировка, а потом рокировка» — the tail only when castling is not among the spoken moves
      const spokenCastle = spoken.some((m) => /рокировка/u.test(m));
      const tail = !spokenCastle && (castles || (!castled && canCastle)) ? ', а потом рокировка' : '';
      const moves = spoken.length > 1 ? `${spoken[0]}, потом ${spoken[1]}` : spoken[0];
      const plan = `план: ${moves}${tail}, если соперник не помешает`;
      const factsRu = [plan, a.stage >= 3 ? `этот план называется «${rep.lineTitle}»` : null].filter((x): x is string => x !== null);
      return { key: `rep:${rep.lineId}`, source: 'repertoire', factsRu, textRu: `План: ${moves}${tail}.`, spokenMoves: spoken };
    }
  }
  // by the principles (§3.3 «Без репертуара»)
  const board = safeBoard(a.fen);
  const home = board ? MINOR_HOMES[me].filter((sq) => {
    const p = board[squareIndex(sq)];
    return !!p && p.color === me && (p.type === 'n' || p.type === 'b') && (KNIGHT_HOMES[me].includes(sq) ? p.type === 'n' : p.type === 'b');
  }) : [];
  const centerPawn = board ? ['d4', 'e4', 'd5', 'e5'].some((sq) => {
    const p = board[squareIndex(sq)];
    return !!p && p.type === 'p' && p.color === me;
  }) : false;
  const steps: string[] = [];
  if (!centerPawn) steps.push('пешку в центр');
  const hasKnight = home.some((sq) => KNIGHT_HOMES[me].includes(sq));
  const hasBishop = home.some((sq) => BISHOP_HOMES[me].includes(sq));
  if (hasKnight && hasBishop) steps.push('вывести коня и слона');
  else if (hasKnight) steps.push('вывести коня');
  else if (hasBishop) steps.push('вывести слона');
  if (!castled && canCastle) steps.push('рокировка');
  // «конь на бэ один и слон на цэ один ещё дома»: one knight and one bishop when both kinds wait at home
  const knightHome = home.find((sq) => KNIGHT_HOMES[me].includes(sq));
  const bishopHome = home.find((sq) => BISHOP_HOMES[me].includes(sq));
  const shown = knightHome && bishopHome ? [knightHome, bishopHome] : home.slice(0, 2);
  const homeList = board ? shown.map((sq) => pieceOnRu((board[squareIndex(sq)] as { type: PieceType }).type, sq)) : [];
  const factsRu: string[] = [];
  if (homeList.length > 0) factsRu.push(`${homeList.join(' и ')} ещё дома`);
  const planText = steps.length > 0 ? steps.join(', потом ') : 'найти фигуре место получше';
  factsRu.push(`план: ${planText}`);
  // one key for «the principles»: a piece leaving home is not a new plan
  return { key: 'principles', source: 'principles', factsRu, textRu: `План: ${planText}.`, spokenMoves: [] };
}

// ═════════════════════════ §5.1: middlegame and endgame plans ═════════════════════════

function passedPawns(board: Board, color: Color): number[] {
  const out: number[] = [];
  const dir = color === 'w' ? 1 : -1;
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.type !== 'p' || p.color !== color) continue;
    const f = fileOf(i);
    let blocked = false;
    for (let r = rankOf(i) + dir; r >= 0 && r < 8 && !blocked; r += dir) {
      for (const df of [-1, 0, 1]) {
        const ff = f + df;
        if (ff < 0 || ff > 7) continue;
        const q = board[r * 8 + ff];
        if (q && q.type === 'p' && q.color !== color) blocked = true;
      }
    }
    if (!blocked) out.push(i);
  }
  return out;
}

function mobility(board: Board, sq: number): number {
  const p = board[sq];
  if (!p) return 0;
  return attacksFrom(board, sq).filter((t) => board[t]?.color !== p.color).length;
}

/**
 * The first fitting plan of §5.1 (P0 rows), or null. `board` may be a FEN. The facts are third person; the template
 * sentences speak to the child. `opts.calm`: only then «улучши худшую фигуру» is offered.
 *
 * `kingToCenter` fires while the child's king stands on its first THREE ranks (the spec says two; with two the spec's
 * own T9 position — king on e3 — would get no plan).
 */
export function middlegamePlan(facts: PositionFacts, board: Board | string, childColor: Color, opts: { calm?: boolean; profile?: Pick<StudentProfile, 'address'> } = {}): PlanHint | null {
  const b = typeof board === 'string' ? safeBoard(board) : board;
  if (!b) return null;
  const me = childColor;
  const s = studentWords(opts.profile);
  if (facts.phase === 'middlegame' && !facts.castled[me] && facts.canStillCastle[me]) {
    return { id: 'castleSoon', factRu: 'король ещё в центре — план: спрятать его рокировкой', textRu: 'Король ещё в центре — спрячь его рокировкой.', squares: [] };
  }
  const diff = me === 'w' ? facts.material.diff : -facts.material.diff;
  const theirs = b.filter((p): p is NonNullable<typeof p> => !!p && p.color !== me);
  const mine = b.filter((p): p is NonNullable<typeof p> => !!p && p.color === me);
  // a lone king: nothing to trade — the box mate (P1 mateTechnique of §5.1)
  if (diff >= 3 && theirs.every((p) => p.type === 'k') && mine.some((p) => p.type === 'q' || p.type === 'r')) {
    return {
      id: 'mateTechnique',
      factRu: 'у соперника остался один король: план — загнать его к краю доски, а свой король помогает',
      textRu: 'Загоняем короля к краю — твой король помогает!',
      squares: [],
    };
  }
  // «меняйся фигурами» needs a piece of the opponent to trade (P06 K+Ф против K: there is none)
  if (diff >= 3 && theirs.some((p) => p.type !== 'k' && p.type !== 'p')) {
    return {
      id: 'tradeWhenAhead',
      factRu: `у ${s.gen} больше фигур: план — меняться фигурами, а не пешками; чем меньше фигур, тем легче выиграть`,
      textRu: 'У тебя больше фигур: меняйся фигурами — так легче выиграть.',
      squares: [],
    };
  }
  const king = findKing(b, me);
  if (facts.phase === 'endgame' && king >= 0) {
    const rel = me === 'w' ? rankOf(king) : 7 - rankOf(king);
    if (rel <= 2) {
      return { id: 'kingToCenter', factRu: 'в эндшпиле король — боец: план — вести его ближе к центру', textRu: 'В эндшпиле король — боец: веди его к центру.', squares: [squareName(king)] };
    }
  }
  const passed = passedPawns(b, me);
  if (passed.length > 0) {
    // the most advanced one
    const best = [...passed].sort((x, y) => (me === 'w' ? rankOf(y) - rankOf(x) : rankOf(x) - rankOf(y)))[0] as number;
    const sq = squareName(best);
    return {
      id: 'pushPassed',
      factRu: `пешка на ${squareToSpokenRu(sq)} — проходная: план — вести её к превращению, а король пусть помогает`,
      textRu: 'Проходная пешка — веди её к превращению!',
      squares: [sq],
    };
  }
  if (opts.calm) {
    let worst = -1;
    let worstMob = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 64; i++) {
      const p = b[i];
      if (!p || p.color !== me || !['n', 'b', 'r', 'q'].includes(p.type)) continue;
      const m = mobility(b, i);
      if (m < worstMob) {
        worstMob = m;
        worst = i;
      }
    }
    if (worst >= 0 && worstMob <= 2) {
      const p = b[worst] as { type: PieceType };
      const sq = squareName(worst);
      return {
        id: 'improveWorstPiece',
        factRu: `${pieceOnRu(p.type, sq)} почти не ходит — план: найти ${p.type === 'r' ? 'ей' : 'ему'} место получше`,
        textRu: `${capRu(pieceOnRu(p.type, sq))} почти не ходит — найди ${p.type === 'r' ? 'ей' : 'ему'} место получше.`,
        squares: [sq],
      };
    }
  }
  return null;
}

// ═════════════════════════ §2.5: the child's move ═════════════════════════

export interface ReactionArgs {
  judgement: MoveJudgement;
  /** the advice the child saw for this move (the previous teachTurn) */
  advice: readonly TeachAdvice[];
  /** `decideIntervention` for this move */
  decision?: InterventionDecision | null;
  /** the motif of the child's move when it was the engine's choice (`judgement.missedMotif`), or found by the game */
  foundMotif?: MotifId;
  /** the advice was a hidden treasure (reveal 'later', no arrow yet) */
  treasureHidden?: boolean;
  /** the repertoire's model move for this position (the child leaving the book, §3.4) */
  repertoireNextSan?: string | null;
  stage?: number;
  ideas?: MoveIdeasApi;
  /** the bot's move before the child's (a recapture of the child is told as one) */
  prev?: { uci: string; fenBefore: string } | null;
}

/**
 * The verdict of §2.5 for the child's move: take-back (the policy said so) → a real tactic found alone → followed the
 * advice → own good (< 2 win%) → fine (< 5) → weaker. `speakNow`: a `teachReaction` goes out at once (weaker, or an
 * early queen move); otherwise the game glues the verdict into the next `teachTurn` as `ctx.reaction`.
 */
export function reactionVerdict(a: ReactionArgs): ReactionVerdict {
  const j = a.judgement;
  const api = a.ideas ?? REAL_IDEAS;
  const advice = a.advice.map((x) => ({ uci: x.uci, san: x.san, source: x.source, arrow: x.arrow }));
  const inAdvice = advice.findIndex((x) => x.uci === j.uci);
  const followed: ReactionVerdict['followed'] = inAdvice === 0 ? 'primary' : inAdvice > 0 ? 'alternative' : 'own';
  const ideas = safeExplain(api, { fen: j.fenBefore, uci: j.uci, pvUci: [j.uci, ...j.refutationPvUci], prev: a.prev ?? null });
  const leftBook = !!a.repertoireNextSan && !sameSan(a.repertoireNextSan, j.san);
  const hasA = ideas.some((i) => i.group === 'A');
  // a queen move the teacher itself advised is never «the early-queen mistake»
  const earlyQueen = followed === 'own' && isEarlyQueenMove(j.fenBefore, j.uci) && !hasA;
  const base = { judgement: j, advice, followed, ideas, leftBook, earlyQueen };
  if (a.decision?.action === 'offerTakeback') return { ...base, kind: 'takeback', speakNow: false };
  const mateFound = j.san.includes('#');
  const goodEnough = j.winPctLoss < TEACH_MAX_WIN_PCT_LOSS;
  const foundTactic = a.foundMotif !== undefined && isRealTacticMotif(a.foundMotif);
  const foundTreasure = a.treasureHidden === true && inAdvice === 0;
  if (goodEnough && (mateFound || foundTreasure || (followed === 'own' && foundTactic))) {
    const found = a.foundMotif ?? (mateFound ? 'mateIn1' : treasureMotif(ideas));
    const out: ReactionVerdict = { ...base, kind: 'tactic', speakNow: false };
    if (found) out.foundMotif = found;
    return out;
  }
  if (followed !== 'own') return { ...base, kind: 'followed', speakNow: false };
  if (j.winPctLoss < 2) return { ...base, kind: 'ownGood', speakNow: false };
  if (j.winPctLoss < TEACH_MAX_WIN_PCT_LOSS) return { ...base, kind: 'fine', speakNow: earlyQueen };
  return { ...base, kind: 'weaker', speakNow: true };
}

function treasureMotif(ideas: readonly MoveIdea[]): MotifId | undefined {
  for (const i of ideas) {
    if (TACTIC_IDEAS.has(i.id)) return i.id as MotifId;
    if (i.id === 'freeCapture') return 'freeCapture';
    if (i.id === 'mate') return 'mateIn1';
    if (i.id === 'promotion') return 'promotion';
  }
  return undefined;
}

const APPROVAL_WORDS: readonly string[] = ['так держать', 'отлично', 'здорово', 'молодец'];

/** Without an engine (§2.1 «по правилам») — said first, never cut. */
const RULES_NOTE = 'точной проверки ходов сейчас нет: советовать можно только знакомые ходы начала партии, остальное — по правилам';

/** The glued reaction (e) of a teachTurn: followed / ownGood / fine (§2.5). null = nothing to say this time. */
function gluedReaction(
  v: ReactionVerdict | null | undefined,
  ctx: TeachContext,
  memory: TeachMemory,
  rng: Rng,
): { factRu: string; textRu: Template; shortRu: Template; approval: string | null; clip: ClipItem | null } | null {
  if (!v) return null;
  const s = words(ctx.profile);
  const j = v.judgement;
  const spoken = spokenMoveRu(j.san, j.fenBefore) || 'его ход';
  // «и он тоже хороший: спокойный крепкий ход!» says nothing — a weak idea is no idea for the praise
  const main = pickIdeas(v.ideas, { stage: ctx.profile.stage, max: 1 }).filter((i) => !(i.id === 'promotion' && j.san.includes('=')) && !WEAK_IDEAS.has(i.id));
  const ideaRu = main.length > 0 ? stripMoveWordRu(joinIdeasRu(main), j.san) : '';
  const ideaYou = main.length > 0 ? stripMoveWordRu(joinIdeasRu(main, 'you'), j.san) : '';
  if (v.kind === 'followed') {
    // not more often than once in two moves, never the same word of approval twice in a row
    if (memory.lastApprovalPly !== null && ctx.ply - memory.lastApprovalPly < 4) return null;
    const pool = APPROVAL_WORDS.filter((w) => w !== memory.lastApprovalWord);
    const word = pick(pool, rng);
    const done = doneRu(main[0]?.id, j);
    return {
      factRu: `${s.nom} ${s.g('сыграл', 'сыграла')} по совету: ${spoken}${ideaRu ? ` — ${ideaRu}` : ''}; одно слово одобрения можно, но не обязательно`,
      // «Хороший ход — молодец! Хороший ход — …» read twice; without a concrete result the approval names the act
      textRu: done ? say(`${capRu(done)} — ${word}!`) : (voice) => `${voice.g('Сыграл', 'Сыграла')} по совету — ${word}!`,
      shortRu: say(`${capRu(word)}!`),
      approval: word,
      // (an approval of a followed advice is not said — `planTeachTurn` keeps only an own good move)
      clip: null,
    };
  }
  if (v.kind === 'ownGood') {
    return {
      factRu: v.leftBook
        ? `${s.nom} ${s.g('свернул', 'свернула')} со знакомой дороги дебюта: ${s.g('сыграл', 'сыграла')} ${playedMoveRu(j)} — ничего, ход хороший`
        : `${s.nom} ${s.g('выбрал', 'выбрала')} свой ход — ${spoken}, и он тоже хороший; похвали одним-двумя словами за самостоятельность`,
      textRu: v.leftBook
        ? (voice) => `Ты ${voice.g('свернул', 'свернула')} со знакомой дороги — ничего, ход хороший!`
        : (voice) => `Ты ${voice.g('выбрал', 'выбрала')} свой ход — и он тоже хороший${ideaYou ? `: ${ideaYou}` : ''}!`,
      shortRu: say('Твой ход тоже хороший!'),
      approval: null,
      clip: lineItem(v.leftBook ? 'react.leftBook' : 'react.ownGood', { g: genderOf(ctx.profile) }),
    };
  }
  if (v.kind === 'fine' && ideaRu) {
    return {
      factRu: `ход ${s.gen} ${spoken}: ${ideaRu}${v.leftBook ? '; это уже не ход нашего плана — дальше думаем по правилам' : ''}`,
      textRu: say(`Твой ход тоже можно: ${ideaYou}.`),
      shortRu: say('Твой ход тоже можно.'),
      approval: null,
      clip: null,
    };
  }
  return null;
}

function doneRu(id: MoveIdeaId | undefined, j: MoveJudgement): string | null {
  const mv = resolveUciMove(j.fenBefore, j.uci);
  switch (id) {
    case 'develop':
      return mv ? `${pieceNameRu(mv.piece, 'nom')} в игре` : 'фигура в игре';
    case 'centerPawn':
      return 'пешка в центре';
    case 'castle':
      return 'король в домике';
    case 'defendMate':
      return 'угрозы мата больше нет';
    case 'escape':
      return 'фигура спасена';
    default:
      return null;
  }
}

// ═════════════════════════ §3.1: principles in words ═════════════════════════

type RuleId = 'center' | 'develop' | 'knightsFirst' | 'castle' | 'earlyQueenOpponent' | 'earlyQueenChild' | 'sameTwice';

const RULE_FACTS: Readonly<Record<RuleId, string>> = {
  // (one short clause each: a principle is the reason of the move it comes with — «Разбуди фигуры: пока они дома, не
  // помогают. Каждым ходом — новая фигура в игру.» would be two more sentences)
  center: 'пешка в центре даёт место фигурам и открывает дорогу слону и ферзю',
  develop: 'каждым ходом — новая фигура в игру',
  knightsFirst: 'коню почти всегда хорошо на эф три или цэ шесть, а куда лучше поставить слона, видно чуть позже',
  castle: 'рокировка прячет короля в домик и будит ладью',
  earlyQueenOpponent: 'соперник рано вывел ферзя — это против правил дебюта: будем выводить фигуры и нападать на ферзя',
  earlyQueenChild:
    'ферзь самый дорогой. Если он вышел рано, соперник нападает на него конями и слонами — и каждым таким ходом выводит свою фигуру, а ферзь тратит ход на бегство',
  sameTwice: 'пока одна фигура гуляет, остальные спят',
};

/** «Коню почти всегда хорошо на эф три, а куда лучше поставить слона, видно чуть позже» — for the square the knight goes to. */
function knightsFirstRu(to: Square): string {
  return `коню почти всегда хорошо на ${squareToSpokenRu(to) || 'эф три'}, а куда лучше поставить слона, видно чуть позже`;
}

// ═════════════════════════ §5.2: concept cards ═════════════════════════

function firstSentences(text: string, n: number): string {
  const parts = text.match(/[^.!?]+[.!?]+/gu) ?? [text];
  return parts.slice(0, n).join(' ').trim();
}

/** Principles that are topics (the opponent's early queen is news about his move; the others belong to reactions). */
const TOPIC_RULES: ReadonlySet<RuleId> = new Set(['center', 'develop', 'knightsFirst', 'castle']);

/** The opening cards that say the same as a principle (§3.1) — one explanation, not two. */
const CARD_RULE: Readonly<Record<string, RuleId>> = { 'opening-center': 'center', 'opening-development': 'develop', 'opening-king-safety': 'castle' };

/**
 * A topic in ONE short fact: the principle's own words for an opening card, else the card's first sentence (two when the
 * first is only a lead-in like «В начале партии фигуры спят дома.»).
 */
function topicExplanationRu(card: ConceptCard): string {
  const rule = CARD_RULE[card.id];
  const title = conceptTitleRu(card.title);
  if (rule) return `новая тема «${title}»: ${RULE_FACTS[rule]}`;
  const first = firstSentences(card.explanation, 1);
  return `новая тема «${title}»: ${lowerFirstRu(first.replace(/[.!…]+$/u, ''))}`;
}

function lowerFirstRu(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** New topics told this game: concept cards and opening principles share one budget (`CONCEPTS_PER_GAME`). */
function topicsSaid(memory: TeachMemory): number {
  return memory.conceptsThisGame.length + memory.rulesSaid.filter((r) => TOPIC_RULES.has(r as RuleId)).length;
}

function chooseConcept(ctx: TeachContext, memory: TeachMemory, candidates: readonly { id: string; urgent: boolean }[]): ConceptCard | null {
  const talk = ctx.talkativeness ?? 'normal';
  const limit = CONCEPTS_PER_GAME[talk];
  if (!ctx.conceptCard || topicsSaid(memory) >= limit) return null;
  const known = new Set([...(ctx.conceptsIntroduced ?? []), ...memory.conceptsThisGame]);
  const gapOk = memory.lastConceptPly === null || ctx.ply - memory.lastConceptPly >= CONCEPT_EVERY_PLIES;
  for (const c of candidates) {
    if (known.has(c.id)) continue;
    // a danger of mate is explained at once: the child must understand what is going on (the 6-ply gap is waived)
    if (!gapOk && !c.urgent) continue;
    let card: ConceptCard | undefined;
    try {
      card = ctx.conceptCard(c.id);
    } catch {
      card = undefined;
    }
    if (!card || card.id !== c.id) continue;
    if (card.stage > ctx.profile.stage + 1) continue;
    return card;
  }
  return null;
}

// ═════════════════════════ §2.2–2.8: planning one turn ═════════════════════════

/** The child's move before the bot's last one (replayed from `historySan`), for the recapture rule of the explainer. */
function childPrevMove(ctx: Pick<TeachContext, 'lastBotMove' | 'historySan'>): { uci: string; fenBefore: string } | null {
  const bot = ctx.lastBotMove;
  const history = ctx.historySan ?? [];
  if (!bot || history.length < 2) return null;
  try {
    const chess = new Chess();
    for (const san of history.slice(0, -2)) chess.move(san);
    const fenBefore = chess.fen();
    const mv = chess.move(history[history.length - 2] as string);
    if ((chess.fen().split(' ')[0] ?? '') !== (bot.fenBefore.split(' ')[0] ?? '')) return null;
    return { uci: `${mv.from}${mv.to}${mv.promotion ?? ''}`, fenBefore };
  } catch {
    return null;
  }
}

/**
 * Plans one teacher turn (§2.3–§2.8): advice, danger, the opponent's idea, the glued reaction, the plan, a new concept,
 * the opening name, the treasure, the style (full / short / concept) and the shape. Pure; the new memory is in
 * `plan.memory`. Build the event with `buildTeachTurn(plan, rng)`.
 */
export function planTeachTurn(ctx: TeachContext, rng: Rng = Math.random): TeachPlan {
  const api = ideasApi(ctx);
  const s = words(ctx.profile);
  const facts = ctx.facts ?? safeFacts(ctx.fen);
  const memory: TeachMemory = { ...initialTeachMemory(), ...(ctx.memory ?? {}) };
  const talk = ctx.talkativeness ?? 'normal';
  const stage = ctx.profile.stage;
  const opening = isOpeningTime(facts?.phase, ctx.ply);
  const engine = engineState(ctx.analysis);
  const moment: TeachPlan['moment'] = memory.turns === 0 && facts?.phase === 'opening' ? 'openingPlan' : 'turn';
  const notes: string[] = [];
  const rules: RuleId[] = [];

  // the plan of the position first: a move that follows it gets a bonus (§5.1)
  const midPlan = facts && !opening ? middlegamePlan(facts, ctx.fen, ctx.childColor, { calm: true, profile: ctx.profile }) : null;
  let advice = pickAdvice({ ...ctx, facts: facts ?? undefined }, { plan: midPlan });
  // the strategy of the game: the intro, «по нашему плану», the deviation line, the replan words
  const strategy = resolveTeachStrategy(ctx);
  const progress: StrategyProgress | null = strategyProgress(strategy, ctx.historySan ?? [], ctx.childColor);

  // (a) the opponent's move
  let opponent: TeachPlan['opponent'] = null;
  if (ctx.lastBotMove) {
    let res: { ideas: MoveIdea[]; wants: Threat | null } = { ideas: [], wants: null };
    try {
      res = api.explainOpponentMove(ctx.lastBotMove.fenBefore, ctx.lastBotMove.uci, ctx.fen, { threat: ctx.threat ?? null, prev: childPrevMove(ctx) });
    } catch {
      res = { ideas: [], wants: null };
    }
    const botPly = ctx.ply - 1;
    let notable = res.ideas.filter((i) => i.group === 'A' || i.group === 'B' || (botPly <= 8 && (i.group === 'C' || i.group === 'D' || i.group === 'E')));
    // a move with a real threat is told by its threat (G06 4.Кg5: the point is f7, not «защищает пешку на е четыре»)
    if (res.wants) notable = [...notable.filter((i) => i.id === 'threatMate' || i.id === 'attack'), ...notable.filter((i) => i.id !== 'threatMate' && i.id !== 'attack')];
    const earlyQueen = isEarlyQueenMove(ctx.lastBotMove.fenBefore, ctx.lastBotMove.uci);
    opponent = {
      san: ctx.lastBotMove.san,
      spokenRu: spokenMoveRu(ctx.lastBotMove.san, ctx.lastBotMove.fenBefore) || 'его ход',
      ideas: api.pickIdeas(notable, { stage, max: 1 }),
      wants: res.wants,
      earlyQueen,
      fenBefore: ctx.lastBotMove.fenBefore,
    };
    if (earlyQueen && opening) rules.push('earlyQueenOpponent');
  }

  // (b) danger
  let danger = findDanger(ctx, facts, s);
  if (danger) danger = resolveDanger(danger, advice[0], ctx.fen);
  // stages 1–2 name no pawn danger, but the opponent's move may attack a pawn (G01 4…Кf6 → e4): when the advice does
  // not answer it, the brief says honestly why it may wait (§2.3 c)
  if (stage <= 2 && advice[0] && !danger) {
    const primaryNow = advice[0];
    for (const sq of threatenedUnits(ctx)) {
      const unit = pieceAt(ctx.fen, sq);
      if (!unit || unit.piece !== 'p' || savesUnit(ctx.fen, primaryNow.uci, primaryNow.allIdeas, sq)) continue;
      const win = primaryNow.ideas.find(isRealWin) ?? primaryNow.ideas[0];
      notes.push(`можно не защищать ${pieceNameRu('p', 'acc')} на ${squareToSpokenRu(sq)}: ход ${primaryNow.spokenRu} сильнее${win ? ` — ${joinIdeasRu([win])}` : ''}`);
      break;
    }
  }

  // the treasure (§2.6) — then no alternative and no arrow
  const treasure = buildTreasure(ctx, advice[0]);
  if (treasure) advice = advice.slice(0, 1);

  // the repertoire: the opponent left the book (§3.4)
  const history = ctx.historySan ?? [];
  const childLastSan = history.length >= 2 ? history[history.length - 2] : undefined;
  const repNow = ctx.repertoire ?? null;
  const leftLine = memory.repertoireInBook && (!repNow || !repNow.inBook) && !!memory.repertoireNextSan && !!childLastSan && sameSan(memory.repertoireNextSan, childLastSan);
  // the bot «left» the plan only when the line had a reply for him and he played another move; a line that simply
  // ended is not his deviation (G03 …5.Фb3, G13 …6.Кxc6)
  const oppNext = memory.repertoireOppNext;
  const lineEnded = leftLine && oppNext === null;
  const botLeftBook = leftLine && !lineEnded;
  // (with a strategy its own road decides — the repertoire's «not our plan» would contradict it)
  if (botLeftBook && !strategy) notes.push('соперник сыграл не так, как в нашем плане: дальше думаем по правилам — центр, фигуры, рокировка');
  if (lineEnded && !strategy) notes.push('наш заученный план закончился — дальше думаем по правилам: центр, фигуры, рокировка');

  // «здесь один хороший ход»
  const lines = [...(ctx.analysis?.lines ?? [])].sort((a, b) => a.multipv - b.multipv);
  if (engine.mode === 'engine' && lines[0] && lines[1] && winOf(lineCp(lines[0])) - winOf(lineCp(lines[1])) >= ONLY_MOVE_WIN_PCT_GAP && !treasure) notes.push('здесь один хороший ход');
  if (engine.mode === 'rules') notes.push(RULES_NOTE);

  // (e) the glued reaction
  const glued = gluedReaction(ctx.reaction, ctx, memory, rng);

  // the smart strategist's plan words: a re-plan of this or an earlier ply that was not taken yet (the move choice of
  // a stale one is dropped in pickAdvice; its words still update the plan from this turn on)
  const incoming = strategy && ctx.replan && ctx.replan.ply <= ctx.ply && ctx.replan.ply !== (memory.replanPly ?? null) ? ctx.replan : null;
  const incomingPlan = replanWords(incoming).planRu;
  const planRuNow = incomingPlan ?? memory.planRu ?? null;
  let freshPlanWords = incomingPlan !== null || (planRuNow !== null && memory.planRuSaid !== true) ? planRuNow : null;

  // a danger decides the move: it is never told as a step of the plan («Идём по плану — уводишь слона из-под боя»)
  const advised = advice[0];
  if (danger && advised && advised.planFit !== 'replan') {
    delete advised.planFit;
    delete advised.planGoal;
    delete advised.planStepRu;
  }

  // the opponent left the strategy's road with his last move → one short line (once per deviation). The strategy goes
  // on: the smart re-plan's words, else the goal the advised move serves («…но план тот же» — the advice itself says
  // it), else the plan's next goal («теперь бьём по цепочке пешек ударом цэ пять»); the generic «центр, фигуры,
  // рокировка» only for a card without goals
  const left = progress?.left ?? null;
  const leftNow = !!strategy && !!left && left.by === 'opponent' && left.ply === ctx.ply - 1 && memory.strategyLeftPly !== left.ply;
  let deviation: TeachPlan['deviation'] = null;
  let deviationGoal: string | null = null;
  /** the deviation line itself says where the plan goes now (a goal, the re-plan's words) */
  let deviationSaysPlan = false;
  if (leftNow && strategy) {
    const principleFact = opening ? 'думаем по правилам: центр, фигуры, рокировка' : 'думаем по правилам и ищем новый план';
    const principleText = opening ? 'играем по правилам: центр, фигуры, рокировка' : 'думаем по правилам';
    const served = !freshPlanWords && advised?.planGoal ? advised.planGoal.textRu : null;
    const next = !freshPlanWords && !served ? planGoalRu(strategy, { turn: memory.goalTurn ?? 0, fen: ctx.fen, color: ctx.childColor }) : null;
    deviationGoal = next?.textRu ?? null;
    deviation = served
      ? {
          factRu: `соперник свернул с дороги нашей стратегии «${strategy.titleRu}», но цели плана те же`,
          textRu: 'Соперник свернул с нашей дороги, но план тот же.',
          shortRu: 'Соперник свернул с нашей дороги.',
          clip: lineItem('teach.deviation.same'),
        }
      : {
          factRu: `соперник свернул с дороги нашей стратегии «${strategy.titleRu}» — теперь ${freshPlanWords ?? (deviationGoal ? `цель плана: ${deviationGoal}` : principleFact)}`,
          textRu: `Соперник свернул с нашей дороги — теперь ${freshPlanWords ?? deviationGoal ?? principleText}.`,
          shortRu: 'Соперник свернул с нашей дороги.',
          // (the strategist's own plan words are never recorded: the twin says the plain line; a goal of the library
          // becomes the tail of the advice that follows — `goalRu`)
          goalRu: freshPlanWords ? null : deviationGoal,
          clip: lineItem(freshPlanWords || deviationGoal ? 'teach.deviation' : 'teach.deviation.rules'),
        };
    deviationSaysPlan = !!deviationGoal || !!freshPlanWords;
    if (freshPlanWords) freshPlanWords = null; // said inside the deviation line
  }

  // the strategy intro: the first turn of a game with a strategy, when its planned move is advised here
  const primaryFit = advice[0]?.planFit;
  const introAlready = ctx.introSaid === true || memory.strategyIntroSaid === true;
  const intro = !!strategy && moment === 'openingPlan' && !introAlready && !treasure && !danger && (primaryFit === 'line' || primaryFit === 'lineLater');
  const alreadySaid = !!strategy && ctx.introSaid === true && memory.turns === 0 && moment === 'openingPlan' && primaryFit === 'line' && !treasure && !danger;
  if (intro) freshPlanWords = null;

  // «Поторопись!» — the one clock word, once a game
  const hurry = typeof ctx.remainingMs === 'number' && ctx.remainingMs > 0 && ctx.remainingMs < HURRY_MS && memory.hurrySaid !== true && !danger && !treasure && !intro;

  // the plan sentence
  const planEvery = talk === 'chatty' ? PLAN_EVERY_PLIES_CHATTY : PLAN_EVERY_PLIES;
  let planInfo: TeachPlan['plan'] = null;
  let planKey: string | null = null;
  if (strategy && opening) {
    // the strategy IS the plan: said once (the intro), never re-told (no repeating the whole plan)
    planKey = `strategy:${strategy.strategyId}`;
    if (intro) planInfo = { key: planKey, factRu: `стратегия этой партии — «${strategy.titleRu}»${strategy.ideaRu ? `: ${strategy.ideaRu}` : ''}`, textRu: '', clip: null };
  } else if (opening) {
    const op = openingPlanFacts({ fen: ctx.fen, childColor: ctx.childColor, stage, repertoire: repNow, facts });
    planKey = op.key;
    // a new or changed plan is said at once (§5.1); the same plan again only in «Болтливо», every 4 plies (§2.7)
    const changed = op.key !== memory.lastPlanKey;
    const due = memory.lastPlanPly === null || ctx.ply - memory.lastPlanPly >= planEvery;
    if (moment === 'openingPlan' || changed || botLeftBook || (talk === 'chatty' && due)) {
      // (the repertoire's plan names moves — two in one sentence: not recordable; the principles are one line)
      planInfo = { key: op.key, factRu: op.factsRu.join('; '), textRu: op.textRu, clip: op.source === 'principles' ? lineItem('plan.principles') : null };
    }
  } else if (midPlan) {
    planKey = midPlan.id;
    const changed = midPlan.id !== memory.lastPlanKey;
    const due = memory.lastPlanPly === null || ctx.ply - memory.lastPlanPly >= planEvery;
    if (changed || (talk === 'chatty' && due)) planInfo = { key: midPlan.id, factRu: midPlan.factRu, textRu: midPlan.textRu, clip: midPlanClip(midPlan, ctx.fen) };
  }
  // off the strategy's road its GOALS go on (not just «центр, фигуры, рокировка» after the bot leaves the line on
  // move 2–3): one goal every few plies, in turn — when the advice itself is no step of the plan
  // (then the advice says it) and no tactic (then it is not the moment); never claimed as the reason of that move
  const offRoad = !!strategy && !!progress && !progress.onLine;
  const advisedPlan = !!advised && isPlanMove(advised, strategy);
  const advisedTactic = !!advised?.ideas[0] && NOT_PLAN_IDEAS.has(advised.ideas[0].id);
  let goalLine: string | null = null;
  if (strategy && offRoad && !intro && !planInfo && !deviation && !advisedPlan && !advisedTactic) {
    const due = memory.lastPlanPly === null || ctx.ply - memory.lastPlanPly >= planEvery;
    const goal = due ? planGoalRu(strategy, { turn: memory.goalTurn ?? 0, fen: ctx.fen, color: ctx.childColor }) : null;
    if (goal && goal.textRu !== memory.lastGoalRu) {
      goalLine = goal.textRu;
      // (a goal beside advice that is no step of it has no recorded sentence of its own: the twin leaves it out)
      planInfo = { key: `goal:${goal.textRu}`, factRu: `цель нашего плана: ${goal.textRu}`, textRu: `${pick(GOAL_HEADS, rng, 'teach.goal')} ${goal.textRu}.`, clip: null };
    }
  }
  if (danger) planInfo = moment === 'openingPlan' ? planInfo : null;
  // a treasure is ONE task (§2.6): no plan next to «найди мат сам» (P11: «меняйся фигурами» beside a mate in one)
  if (treasure) planInfo = null;

  // opening principles (§3.1), each at most once a game
  const primary = advice[0];
  const alternative = advice[1];
  if (opening && primary && !treasure) {
    const pIds = new Set(primary.ideas.map((i) => i.id));
    if (pIds.has('centerPawn') || pIds.has('openLine') || pIds.has('fightCenter')) rules.push('center');
    if (pIds.has('develop')) rules.push('develop');
    // «кони — часто раньше слонов»: a knight to its natural square (f3 / c3 / f6 / c6) against a bishop alternative
    const natural = ['f3', 'c3', 'f6', 'c6'];
    const knightTo = primary.san.startsWith('N') ? parseUci(primary.uci)?.to : undefined;
    if (stage >= 2 && knightTo && natural.includes(knightTo) && alternative?.san.startsWith('B')) rules.push('knightsFirst');
    if (pIds.has('castle') || pIds.has('prepareCastle')) rules.push('castle');
  }
  // one principle at a time (§2.8.3): the others come on later moves; none next to a treasure (§2.6: one task) or the intro
  if (treasure || intro) rules.length = 0;
  const freshRules = rules.filter((r, i) => rules.indexOf(r) === i && !memory.rulesSaid.includes(r));

  // the opening name (§3.2)
  let openingName: string | null = null;
  const name = safeName(ctx, ctx.fen);
  const maxNames = stage <= 2 ? 1 : OPENING_NAMES_PER_GAME;
  // stages 1–2 hear the family only: «Итальянская партия», not «Итальянская партия, джоко пиано»
  const shownName = name && stage <= 2 ? (name.split(',')[0] ?? name).trim() : name;
  // (with a strategy its title is the name of the game — a second name would be one more thing to hear)
  if (shownName && name && !strategy && !GENERIC_OPENING_NAMES.has(name) && ctx.ply - 1 >= 3 && !memory.openingsAnnounced.includes(shownName) && memory.openingsAnnounced.length < maxNames && talk !== 'quiet' && !treasure) {
    openingName = shownName;
  }

  // a new topic (§5.2): a concept card that explains the ADVICE itself — a rare moment of its own (nothing
  // extra), never piled onto other news. A danger of mate keeps its card: «детский мат» names it.
  const conceptCandidates: { id: string; urgent: boolean }[] = [];
  if (danger?.conceptId && danger.kind === 'mate') conceptCandidates.push({ id: danger.conceptId, urgent: true });
  if (!danger) {
    for (const i of primary && !treasure ? primary.ideas : []) {
      const id = conceptOf(i);
      if (id) conceptCandidates.push({ id, urgent: false });
    }
  }
  const primaryMv = primary ? resolveUciMove(ctx.fen, primary.uci) : undefined;
  // never «не выводи ферзя рано» while the green arrow is a queen move; a treasure is one task — no new topic
  const allowedConcepts = conceptCandidates.filter((c) => !(c.id === 'opening-early-queen' && primaryMv?.piece === 'q'));
  const card = talk === 'quiet' || treasure || intro || alreadySaid ? null : chooseConcept(ctx, memory, allowedConcepts);
  // an opening principle is a topic too: the same budget and spacing as the cards; the card of the same principle says
  // it better — one explanation, not two
  const topicRoom = talk !== 'quiet' && topicsSaid(memory) < CONCEPTS_PER_GAME[talk] && (memory.lastConceptPly === null || ctx.ply - memory.lastConceptPly >= CONCEPT_EVERY_PLIES);
  const cardSaid = (r: RuleId): boolean => Object.entries(CARD_RULE).some(([id, same]) => same === r && (memory.conceptsThisGame.includes(id) || (ctx.conceptsIntroduced ?? []).includes(id)));
  const topicRule: RuleId | null = card || !topicRoom || danger || treasure || intro || alreadySaid ? null : (freshRules.find((r) => TOPIC_RULES.has(r) && !cardSaid(r)) ?? null);
  const earlyQueenRule = freshRules.includes('earlyQueenOpponent');

  // the opponent's move matters (≤ 6 words, or his threat): a threat / capture / attack, an early queen, or the advice
  // answers exactly that move — never «соперник сходил»
  const botTo = ctx.lastBotMove ? parseUci(ctx.lastBotMove.uci)?.to : undefined;
  const reacts = !!primary && !!botTo && primary.ideas.some((i) => i.squares.includes(botTo));
  const threatening = (opponent?.ideas ?? []).some((i) => OPPONENT_MENTION_IDEAS.has(i.id)) || !!opponent?.san.includes('x');
  // news about his move (a threat, a capture, an attack, an early queen) outranks a plan or a topic; the plain «the
  // advice answers that move» comes after them
  const opponentNews = !!opponent && !!ctx.lastBotMove && (threatening || opponent.earlyQueen || (!!opponent.wants && !danger));
  const opponentMatters = opponentNews || (!!opponent && !!ctx.lastBotMove && reacts);

  // ── the ONE extra of this turn (TeachExtra): the first eligible one in TEACH_EXTRA_ORDER ──
  const unguardedNote = notes.find((n) => n.startsWith('можно не защищать')) ?? null;
  const bookNote = notes.find((n) => n.startsWith('соперник сыграл не так') || n.startsWith('наш заученный')) ?? null;
  const onlyMoveNote = notes.find((n) => n === 'здесь один хороший ход') ?? null;
  const eligible: readonly (readonly [TeachExtra, boolean])[] = [
    ['danger', !!danger && !treasure],
    ['deviation', !!deviation],
    ['bookLeft', !!bookNote],
    ['openingPlan', moment === 'openingPlan' && !strategy && !!planInfo],
    ['ownGood', ctx.reaction?.kind === 'ownGood' && !!glued],
    ['newPlan', !!freshPlanWords],
    ['unguarded', !!unguardedNote],
    ['opponent', opponentNews],
    ['plan', !!planInfo && !(moment === 'openingPlan' && !strategy)],
    ['topic', !!card || !!topicRule],
    ['opponent', opponentMatters],
    ['name', !!openingName],
    ['onlyMove', !!onlyMoveNote],
  ];
  // (no advice to show — the rules mode deep in the game: the rule reminder is all there is to say, a danger aside)
  let extra: TeachExtra | null = treasure || intro ? null : (eligible.find(([k, ok]) => ok && (advice.length > 0 || k === 'danger'))?.[0] ?? null);

  // calm → short (§2.8.1)
  const opponentAB = (opponent?.ideas ?? []).some((i) => i.group === 'A' || i.group === 'B');
  // §2.8.1 as specified: no group-A idea in the advice (an A/B rule made 84 of 85 turns full — the attention risk of §10.6)
  const adviceA = advice.some((a) => a.allIdeas.some((i) => i.group === 'A'));
  const reactionCalm = !ctx.reaction || ctx.reaction.kind === 'followed' || ctx.reaction.kind === 'ownGood';
  // without an engine the teacher cannot claim the position is calm (§2.1 «по правилам»)
  const rulesMode = engine.mode === 'rules';
  // any news but the opponent's few words or «один хороший ход» makes the turn a full one (then the most important of
  // them is said — a calm turn stays short and says none)
  const newsBreaksCalm = eligible.some(([k, ok]) => ok && k !== 'opponent' && k !== 'onlyMove');
  // «Что выбираешь?» is due once in CHOICE_EVERY_TURNS turns
  const lastChoice = memory.lastChoiceTurn ?? null;
  const choiceDue = lastChoice === null ? memory.turns >= CHOICE_EVERY_TURNS - 1 : memory.turns - lastChoice >= CHOICE_EVERY_TURNS;
  const calm = !rulesMode && moment === 'turn' && !danger && !treasure && !opponentAB && !adviceA && reactionCalm && !newsBreaksCalm && !hurry;
  let style: TeachStyle;
  if (intro) style = 'full';
  else if (rulesMode) style = moment === 'openingPlan' ? 'concept' : 'full';
  else if (talk === 'quiet') style = danger || treasure ? 'full' : 'short';
  // (with a strategy the first turn is its intro — or, when the game said the intro already, a normal turn)
  else if (((extra === 'topic' || extra === 'danger') && card) || (moment === 'openingPlan' && !strategy)) style = 'concept';
  // (a calm position is short two times out of three, the third calm turn in a
  // row always — else the rare turn that lets the child choose between the two arrows keeps its second sentence)
  else if (calm) style = talk === 'chatty' ? 'full' : memory.calmStreak >= 2 ? 'short' : choiceDue && advice.length >= 2 ? 'full' : rng() < CALM_SHORT_P ? 'short' : 'full';
  else style = 'full';

  // one idea at a time: the same main idea with the same piece as last time → the second idea (§2.8.4)
  if (primary && memory.lastMainIdea) {
    const m = primary.ideas[0];
    const mv = resolveUciMove(ctx.fen, primary.uci);
    // a real gain is never replaced by a side idea (G07 4.Фxe5+ «забирает пешку» must not become «уводит ферзя»)
    const concrete = !!m && (WIN_IDEAS.has(m.id) || (m.group === 'A' && (m.gainPawns ?? 0) >= 1));
    if (m && mv && !concrete && m.id === memory.lastMainIdea.id && mv.piece === memory.lastMainIdea.piece) {
      const other = api.pickIdeas(primary.allIdeas, { stage, max: 1, avoid: [m.id] });
      if (other.length > 0) primary.ideas = other;
    }
  }

  // the short style: one advice, one idea, no extra at all (§2.7)
  const short = style === 'short';
  if (short) {
    advice = advice.slice(0, 1);
    if (advice[0]) advice[0].ideas = advice[0].ideas.slice(0, 1);
    extra = null;
  }

  // «Что выбираешь?» rarely: once in CHOICE_EVERY_TURNS turns, only with two arrows to choose from and nothing else to
  // say — the plain «the advice answers his move» gives way to it (a choice turn WITH the opponent's move would be four
  // sentences)
  const choicePossible = choiceDue && !short && !intro && !treasure && advice.length >= 2;
  if (choicePossible && extra === 'opponent' && !opponentNews) extra = null;
  let choice = choicePossible && extra === null;

  // how the advice begins (TeachOpener): the opponent's move first about every second turn — «Соперник
  // вывел коня на эф шесть — по плану отвечаем …» — when nothing else is said besides the advice (or his
  // move IS the extra), else a head unlike the last two
  const lastOpeners = memory.openers ?? [];
  const oppLead = primary && ctx.lastBotMove ? (opponentMention(ctx.lastBotMove, opponent?.ideas ?? [], opponent?.earlyQueen === true)?.text ?? null) : null;
  // ONE sentence holds his move, our answer AND why (every move tied to the plan) — only when all three fit
  // the voice's twenty words and the style's budget; else another head keeps the reason (a reason said last time is
  // dropped anyway, see below)
  const reasonDropped = !!primary && !!memory.lastReasonRu && reasonRu(primary) === memory.lastReasonRu;
  const oppFits =
    !!oppLead && !!primary && countWords(render(oppAdviceTemplate(oppLead, primary, strategy, ctx.fen, reasonDropped ? '' : adviceWhyRu(primary, strategy, 1)), ctx.profile).text) <= Math.min(OPP_SENTENCE_WORDS, TEACH_TEXT_WORDS[style]);
  const oppOk = oppFits && !intro && !alreadySaid && !treasure && !danger && !rulesMode && (extra === 'opponent' || extra === null);
  let opener: TeachOpener | null = null;
  if (primary && !intro && !treasure) {
    if (oppOk && (extra === 'opponent' || lastOpeners[0] !== 'opp')) opener = 'opp';
    else {
      const family = isPlanMove(primary, strategy) ? PLAN_OPENERS : short ? CALM_OPENERS : ADVICE_OPENERS;
      // («Ходи конём на эф три»; never «Ходи короткой рокировкой», never a capture — it has no such case)
      const usable = family.filter((o) => o !== 'go' || (moveInsRu(primary.san) !== '' && !primary.san.startsWith('O-O')));
      const fresh = usable.filter((o) => !lastOpeners.includes(o));
      opener = pick(fresh.length > 0 ? fresh : usable, rng, 'teach.opener');
    }
  }
  // (the opponent's move told in the advice sentence is the one extra of the turn; «Что выбираешь?» waits for the next
  // turn — his move, our answer, the reason AND the blue arrow would be four things in one breath)
  if (opener === 'opp') {
    extra = 'opponent';
    choice = false;
  }

  // the deviation line said where the plan goes now: the advice after it names the move only (25 words hold both)
  if (primary && extra === 'deviation' && deviationSaysPlan) primary.noReason = true;
  // never the same reason twice in a row (the Italian's Кf1 and Кg3 both «идёт длинным путём на королевский фланг»)
  if (primary && memory.lastReasonRu && reasonRu(primary) === memory.lastReasonRu) primary.noReason = true;

  // the shape (§2.8.2) follows the extra: the danger first, the opponent's move first, else the advice first
  const shape: TeachShape = short && extra !== 'opponent' ? 'adviceFirst' : extra === 'danger' || (!!danger && !treasure) ? 'dangerFirst' : extra === 'opponent' ? 'opponentFirst' : 'adviceFirst';

  const saidRules: RuleId[] = extra === 'opponent' && earlyQueenRule ? ['earlyQueenOpponent'] : extra === 'topic' && !card && topicRule ? [topicRule] : [];
  const ruleTexts = saidRules.map((r) => (r === 'knightsFirst' ? knightsFirstRu(parseUci(primary?.uci ?? '')?.to ?? '') : RULE_FACTS[r]));

  const mention = extra === 'opponent' && ctx.lastBotMove ? opponentMention(ctx.lastBotMove, opponent?.ideas ?? [], opponent?.earlyQueen === true) : null;
  const opponentMentionRu = mention?.text ?? null;

  const keepConcept = !!card && !short && (extra === 'topic' || (extra === 'danger' && card.id === danger?.conceptId));
  const draft: TeachPlan = {
    moment,
    style,
    shape,
    mode: engine.mode,
    ply: ctx.ply,
    fen: ctx.fen,
    childColor: ctx.childColor,
    profile: ctx.profile,
    timed: ctx.timed === true,
    advice,
    treasure,
    danger,
    opponent: short && extra !== 'opponent' ? null : opponent,
    // an own good move is praised (§2.5); an approval of a followed advice is not said (nothing extra)
    reaction: extra === 'ownGood' && glued && ctx.reaction ? { kind: ctx.reaction.kind, factRu: glued.factRu, textRu: glued.textRu, shortRu: glued.shortRu, prio: 9, clip: glued.clip } : null,
    plan: intro || extra === 'openingPlan' || extra === 'plan' ? planInfo : null,
    // the «no engine» note always; the other notes only as the extra of the turn
    notes: notes.filter((n) => n === RULES_NOTE || (extra === 'bookLeft' && n === bookNote) || (extra === 'unguarded' && n === unguardedNote) || (extra === 'onlyMove' && n === onlyMoveNote)),
    rules: ruleTexts,
    openingName: extra === 'name' ? openingName : null,
    conceptId: keepConcept && card ? card.id : null,
    concept:
      keepConcept && card
        ? {
            id: card.id,
            title: conceptTitleRu(card.title),
            // one sentence: the topic explains the advice (a danger's card only names the danger — its facts say it)
            factsRu: extra === 'topic' ? [topicExplanationRu(card)] : [],
            textRu: extra === 'topic' ? `${capRu(topicExplanationRu(card).replace(/^новая тема «[^»]+»: /u, '')).replace(/[.!]+$/u, '')}.` : firstSentences(card.explanation, 1),
            prio: extra === 'topic' ? 8 : 6,
          }
        : null,
    strategy,
    intro,
    alreadySaid,
    deviation: extra === 'deviation' ? deviation : null,
    newPlanRu: extra === 'newPlan' ? freshPlanWords : null,
    opponentMentionRu,
    opponentClip: mention?.clip ?? null,
    choice,
    hurry,
    opener,
    extra,
    memory,
  };

  // only what fits the brief counts as said: a rule, a plan or a name dropped for the budget comes another time. A new
  // topic whose explanation did not fit is not introduced at all (a goal asking for «пешкой в центр» without its facts
  // makes the model spend the phrase on it instead of the plan)
  let { kept } = teachTurnBrief(draft);
  // (a card about the danger itself is explained by the danger fact — it stays even when its own sentences are cut)
  if (draft.concept && draft.concept.prio >= 8 && !kept.has(draft.concept.factsRu[0] ?? '')) {
    // (the style keeps its budget: the turn is still a rich one — a rule, a name, a plan)
    draft.concept = null;
    draft.conceptId = null;
    kept = teachTurnBrief(draft).kept;
  }
  const keptRules = saidRules.filter((_, i) => kept.has(ruleFactRu(ruleTexts[i] ?? '')));
  draft.rules = ruleTexts.filter((t) => kept.has(ruleFactRu(t)));
  if (draft.plan && !kept.has(planFactRu(draft.plan))) draft.plan = null;
  if (draft.openingName && !kept.has(nameFactRu(draft.openingName))) draft.openingName = null;

  // the memory for the next turn
  const planWordsSaid = draft.newPlanRu !== null || (draft.deviation !== null && planRuNow !== null && draft.deviation.textRu.includes(planRuNow));
  // a goal of the rotation that was really said (the deviation line, or the plan line that fit the brief)
  const goalSaid = draft.plan && goalLine && draft.plan.key === `goal:${goalLine}` ? goalLine : draft.deviation && deviationGoal && draft.deviation.textRu.includes(deviationGoal) ? deviationGoal : null;
  const mainNow = advice[0]?.ideas[0];
  const mainMove = advice[0] ? resolveUciMove(ctx.fen, advice[0].uci) : undefined;
  draft.memory = {
    ...memory,
    turns: memory.turns + 1,
    lastPly: ctx.ply,
    lastShape: shape,
    calmStreak: calm ? memory.calmStreak + 1 : 0,
    lastMainIdea: mainNow && mainMove ? { id: mainNow.id, piece: mainMove.piece } : memory.lastMainIdea,
    // a plan counts as told only when it was said — a plan that changed during a short / danger turn comes next time
    lastPlanKey: draft.plan ? draft.plan.key : memory.lastPlanKey,
    lastPlanPly: draft.plan || goalSaid ? ctx.ply : memory.lastPlanPly,
    rulesSaid: [...memory.rulesSaid, ...keptRules],
    conceptsThisGame: draft.conceptId ? [...memory.conceptsThisGame, draft.conceptId] : memory.conceptsThisGame,
    // (an opening principle told as the topic of the turn keeps the same distance to the next topic as a card)
    lastConceptPly: draft.conceptId || keptRules.some((r) => TOPIC_RULES.has(r)) ? ctx.ply : memory.lastConceptPly,
    openingsAnnounced: draft.openingName ? [...memory.openingsAnnounced, draft.openingName] : memory.openingsAnnounced,
    repertoireInBook: !!repNow && repNow.inBook && repNow.warning !== true,
    repertoireNextSan: repNow && repNow.inBook ? (repNow.nextChildSans[0] ?? null) : null,
    ...oppReplyField(repNow),
    lastApprovalPly: draft.reaction && glued?.approval ? ctx.ply : memory.lastApprovalPly,
    lastApprovalWord: (draft.reaction ? glued?.approval : null) ?? memory.lastApprovalWord,
    // for a hidden treasure this is the hidden move (no arrow on the board): `reactionVerdict` recognises «found alone»
    advice: advice.map(toTeachAdvice),
    lastChoiceTurn: choice ? memory.turns : (memory.lastChoiceTurn ?? null),
    hurrySaid: memory.hurrySaid === true || hurry,
    strategyIntroSaid: memory.strategyIntroSaid === true || intro || ctx.introSaid === true,
    strategyLeftPly: leftNow && left ? left.ply : (memory.strategyLeftPly ?? null),
    replanPly: incoming ? incoming.ply : (memory.replanPly ?? null),
    planRu: planRuNow,
    planRuSaid: incomingPlan !== null ? planWordsSaid : memory.planRuSaid === true || planWordsSaid,
    lastPhase: facts?.phase ?? memory.lastPhase ?? null,
    openers: opener ? [opener, ...(memory.openers ?? [])].slice(0, 2) : (memory.openers ?? []),
    goalTurn: (memory.goalTurn ?? 0) + (goalSaid ? 1 : 0),
    lastGoalRu: goalSaid ?? (primary?.planGoal && !primary.noReason ? primary.planGoal.textRu : null) ?? memory.lastGoalRu ?? null,
    lastReasonRu: primary ? reasonRu(primary) || null : (memory.lastReasonRu ?? null),
  };
  return draft;
}

/**
 * Past tense of the opponent's move in ≤ 6 words: «Соперник вывел коня на эф шесть.» / «Соперник напал на коня.» —
 * and its recorded twin, piece only (the square is highlighted on the board): «Соперник вывел коня.»
 */
function opponentMention(bot: { uci: string; san: string; fenBefore: string }, ideas: readonly MoveIdea[], earlyQueen: boolean): { text: string; clip: ClipItem } | null {
  const mv = resolveUciMove(bot.fenBefore, bot.uci);
  if (!mv) return null;
  const sq = squareToSpokenRu(mv.to);
  const fit = (full: string, bare: string): string => (countWords(full) <= OPPONENT_MENTION_WORDS ? full : bare);
  if (earlyQueen) return { text: 'Соперник рано вывел ферзя.', clip: lineItem('opp.earlyQueen') };
  if (mv.captured) return { text: fit(`Соперник забрал ${pieceNameRu(mv.captured, 'acc')} на ${sq}.`, `Соперник забрал ${pieceNameRu(mv.captured, 'acc')}.`), clip: lineItem('opp.took', { piece: mv.captured }) };
  if (mv.isCastle) return { text: 'Соперник сделал рокировку.', clip: lineItem('opp.castled') };
  const attack = ideas.find((i) => i.id === 'attack' || i.id === 'fightCenter');
  const target = attack?.squares[0] ? pieceAt(mv.fenAfter, attack.squares[0]) : undefined;
  if (attack && target) return { text: fit(`Соперник напал на ${pieceNameRu(target.piece, 'acc')}.`, 'Соперник напал.'), clip: lineItem('opp.attack', { piece: target.piece }) };
  if (ideas.some((i) => i.id === 'threatMate')) return { text: 'Соперник грозит матом!', clip: lineItem('opp.mateThreat') };
  if (mv.givesCheck) return { text: 'Соперник объявил шах.', clip: lineItem('opp.check') };
  const home = MINOR_HOMES[mv.color].includes(mv.from) && (mv.piece === 'n' || mv.piece === 'b');
  if (home) return { text: fit(`Соперник вывел ${pieceNameRu(mv.piece, 'acc')} на ${sq}.`, `Соперник вывел ${pieceNameRu(mv.piece, 'acc')}.`), clip: lineItem('opp.developed', { piece: mv.piece }) };
  if (mv.piece === 'p') return { text: fit(`Соперник поставил пешку на ${sq}.`, 'Соперник пошёл пешкой.'), clip: lineItem('opp.pawn') };
  return { text: fit(`Соперник пошёл ${pieceNameRu(mv.piece, 'ins')} на ${sq}.`, `Соперник пошёл ${pieceNameRu(mv.piece, 'ins')}.`), clip: lineItem('opp.moved', { piece: mv.piece }) };
}

/** The recorded line of a middlegame / endgame plan (§5.1): «Король ещё в центре — спрячь его рокировкой.» */
function midPlanClip(p: PlanHint, fen: string): ClipItem | null {
  if (p.id === 'improveWorstPiece') {
    const sq = p.squares[0];
    return lineItem('plan.improve', { piece: sq ? (pieceAt(fen, sq)?.piece ?? null) : null });
  }
  const id = `plan.${p.id}`;
  return hasClipLine(id) ? lineItem(id) : null;
}

/** The opponent's model reply after the child's next move; null = the line ends with that move. An unknown line (no
 *  continuation) leaves the field out — then the plain rule applies: any other move is «not our plan». */
function oppReplyField(rep: RepertoirePlanLike | null): Pick<TeachMemory, 'repertoireOppNext'> {
  if (!rep || !rep.inBook) return { repertoireOppNext: null };
  if (!rep.continuationSan) return {};
  return { repertoireOppNext: rep.continuationSan[1] ?? null };
}

/** «Золотое правило 1: пешкой в центр» → «пешкой в центр» (no digits reach a brief). */
function conceptTitleRu(title: string): string {
  const t = title.replace(/^[^:]*\d[^:]*:\s*/u, '').replace(/\d+/gu, '').trim();
  return t.charAt(0).toLowerCase() + t.slice(1);
}

function toTeachAdvice(a: AdviceCandidate): TeachAdvice {
  return { uci: a.uci, san: a.san, source: a.source, arrow: a.arrow };
}

// ═════════════════════════ §6.2: the events ═════════════════════════

interface Fact {
  text: string | null | undefined;
  /** higher = kept longer when the brief is too long */
  prio: number;
}

/**
 * Composes a brief within `maxChars`: drops the least important facts first (the later one of equals) — never
 * «Можно назвать», «Цель», «Нельзя». Returns the brief and the texts of the facts that made it in.
 */
function fittedBrief(parts: Omit<BriefParts, 'facts'> & { facts: readonly Fact[] }, maxChars: number, maxFacts = Infinity): { brief: string; kept: ReadonlySet<string> } {
  const all = parts.facts.filter((f): f is { text: string; prio: number } => typeof f.text === 'string' && f.text.trim() !== '');
  let facts = all;
  let brief = composeBrief({ ...parts, facts: facts.map((f) => f.text) });
  while ((brief.length > maxChars || facts.length > maxFacts) && facts.length > 0) {
    let drop = 0;
    for (let i = 1; i < facts.length; i++) if ((facts[i] as Fact).prio <= (facts[drop] as Fact).prio) drop = i;
    facts = facts.filter((_, i) => i !== drop);
    brief = composeBrief({ ...parts, facts: facts.map((f) => f.text) });
  }
  // a fact dropped early may fit again once a longer one went: refill by priority, in the original order
  const dropped = all.filter((f) => !facts.includes(f)).sort((a, b) => b.prio - a.prio);
  for (const f of dropped) {
    if (facts.length >= maxFacts) break;
    const trial = all.filter((x) => facts.includes(x) || x === f);
    const candidate = composeBrief({ ...parts, facts: trial.map((x) => x.text) });
    if (candidate.length <= maxChars) {
      facts = trial;
      brief = candidate;
    }
  }
  return { brief, kept: new Set(facts.map((f) => f.text)) };
}

/** The honest «how common» words of §3.5 — said only without an engine, where they are the reason itself (§2.1). */
function sourceFactRu(a: AdviceCandidate): string | null {
  if (a.verifiedBy !== 'curated') return null;
  return a.source === 'repertoire' ? 'это ход нашего плана' : 'так часто начинают партию';
}

/**
 * «Конь на эф три (зелёная стрелка) — ход нашего плана: выводит коня в игру» — the move and ONE reason («ходи
 * конём, потому что …», short and clear). No «ход проверен: он сильный» / «так обычно играют»: a voice model turns
 * them into one more clause («это сильный ход», «ход сильный»). The alternative (only on a choice
 * turn) is named without a reason.
 */
function adviceFactRu(a: AdviceCandidate, strategy: TeachStrategy | null, withReason = true): string {
  if (a.arrow === 'blue') return `${a.spokenRu} (синяя стрелка)`;
  // (a topic turn: the new topic IS the reason — a second one would make the turn three sentences long)
  // (a plan move's reason is its goal: «ход нашего плана: прыгаем конём на е четыре»)
  const why = withReason ? reasonRu(a) : '';
  const tag = isPlanMove(a, strategy) ? (a.planFit === 'replan' ? ' — ход нового плана' : ' — ход нашего плана') : '';
  const source = sourceFactRu(a);
  return `${a.spokenRu} (зелёная стрелка)${tag}${why ? `: ${why}` : ''}${source ? `; ${source}` : ''}`;
}

function adviceLineRu(advice: readonly AdviceCandidate[], withArrows: boolean): string[] {
  return advice.map((a) => (withArrows ? `${a.spokenRu} (${a.arrow === 'green' ? 'зелёная' : 'синяя'} стрелка)` : a.spokenRu));
}

function teachAnnotations(plan: TeachPlan, opts: { arrows: boolean }): BoardAnnotations {
  const arrows: BoardAnnotations['arrows'] = [];
  const highlights: BoardAnnotations['highlights'] = [];
  if (opts.arrows) {
    for (const a of plan.advice) {
      const p = parseUci(a.uci);
      if (p) arrows.push({ from: p.from, to: p.to, color: a.arrow });
    }
  }
  if (plan.danger) {
    for (const sq of plan.danger.squares) highlights.push({ square: sq, color: 'red' });
    for (const a of plan.danger.arrows) arrows.push({ from: a.from, to: a.to, color: 'red' });
  }
  if (plan.treasure && !opts.arrows) {
    // a square that is already red (the danger) stays red — never red and blue at once (G08 d1)
    const red = new Set(highlights.map((h) => h.square));
    if (!red.has(plan.treasure.from)) highlights.push({ square: plan.treasure.from, color: 'blue' });
    if (!red.has(plan.treasure.target)) highlights.push({ square: plan.treasure.target, color: 'yellow' });
  }
  return { arrows, highlights };
}

/**
 * The «Момент» line: what happened, for the model's context only — no clock, no colour, no mode. The
 * opponent's move is in it only when it IS the extra of the turn: otherwise a voice model invents «Соперник медлит»,
 * «Соперник что-то замышляет» on turns whose brief only mentions his move here.
 */
function momentRu(plan: TeachPlan, s: StudentWords): string {
  // the first teacher turn of a game is usually the child's first move — not when an earlier turn was cut short
  const first = plan.ply <= 2 ? `, это ${s.g('его', 'её')} первый ход` : '';
  const opp = plan.opponent && plan.extra === 'opponent' ? plan.opponent.spokenRu : null;
  if (plan.intro) return `партия только началась${plan.opponent ? `, ход соперника: ${plan.opponent.spokenRu}` : ''}${first}; в этой партии мы ведём ${s.acc} по одной стратегии`;
  if (plan.moment === 'openingPlan') return `партия только началась${opp ? `, ход соперника: ${opp}` : ''}${first}`;
  if (plan.treasure) return `ход ${s.gen}, в позиции есть подарок`;
  if (plan.style === 'short') return `${opp ? `ход соперника: ${opp}; ` : ''}спокойная позиция, ход ${s.gen}`;
  return `${opp ? `ход соперника: ${opp}; теперь ` : ''}ход ${s.gen}`;
}

function moveTpl(san: string, fen: string): (v: Voice) => string {
  return (v) => v.move(san, fen);
}

/**
 * A move at the start of a sentence: capitalised in speech («Пешка на дэ четыре — …»), as written in the bubble — the
 * notation keeps its case («d4 — это по плану», never «D4»).
 */
function capMove(v: Voice, move: (v: Voice) => string): string {
  return v.mode === 'speech' ? capRu(move(v)) : move(v);
}

interface TextPart {
  tpl: Template;
  /** a shorter wording of the same part, tried before the part is dropped */
  alt?: Template;
  /** 100 = the core of the turn (never dropped, only shortened) */
  prio: number;
  /**
   * The part's twin in the recorded voice (docs/voice-clips/SPEC.md §3.4, ./clips/twins.ts): the sentence(s) it is
   * said as from clips, each with its own prio; absent / empty = the part is not voiced from clips (free text of the
   * strategist, an opening name, a plan that names moves).
   */
  clip?: readonly (TwinSentence | null)[];
}

/** The first template that fits the style's budget (else the shortest one). */
function fitFirst(tpls: readonly Template[], profile: StudentProfile, style: TeachStyle): Template {
  let best: { tpl: Template; words: number } | null = null;
  for (const tpl of tpls) {
    const { text } = render(tpl, profile);
    const w = countWords(text);
    if (w <= TEACH_TEXT_WORDS[style] && countSentences(text) <= TEACH_TEXT_SENTENCES[style]) return tpl;
    if (!best || w < best.words) best = { tpl, words: w };
  }
  return (best ?? { tpl: tpls[0] as Template }).tpl;
}

/**
 * The composition that fits the style's words and sentences (one or two short sentences, ≤ 25 words): the least
 * important part goes first — shortened when its short wording helps, else dropped; the core (prio 100) is only
 * shortened.
 */
function fitText(parts: readonly TextPart[], profile: StudentProfile, style: TeachStyle): Template {
  const maxWords = TEACH_TEXT_WORDS[style];
  const maxSentences = TEACH_TEXT_SENTENCES[style];
  const measure = (list: readonly TextPart[]): { words: number; sentences: number } => {
    const { text } = render(join(...list.map((p) => p.tpl)), profile);
    return { words: countWords(text), sentences: countSentences(text) };
  };
  const one = (p: TextPart): { words: number; sentences: number } => measure([p]);
  let cur = [...parts];
  for (let guard = 0; guard < 40 && cur.length > 0; guard++) {
    const m = measure(cur);
    const overSentences = m.sentences > maxSentences;
    if (!overSentences && m.words <= maxWords) break;
    const helps = (p: TextPart): boolean => {
      if (!p.alt) return false;
      const a = one({ tpl: p.alt, prio: p.prio });
      const b = one(p);
      return overSentences ? a.sentences < b.sentences : a.words < b.words;
    };
    const order = cur.map((p, i) => ({ p, i })).sort((x, y) => x.p.prio - y.p.prio || y.i - x.i);
    const extra = order.find(({ p }) => p.prio < 100);
    if (extra) {
      if (helps(extra.p)) cur = cur.map((p, i) => (i === extra.i ? { tpl: p.alt as Template, prio: p.prio } : p));
      else cur = cur.filter((_, i) => i !== extra.i);
      continue;
    }
    const core = order.find(({ p }) => helps(p));
    if (!core) break;
    cur = cur.map((p, i) => (i === core.i ? { tpl: p.alt as Template, prio: p.prio } : p));
  }
  return join(...cur.map((p) => p.tpl));
}

/** «Помним план: …» — a goal of the plan beside advice that is no step of it (off the strategy's road). */
const GOAL_HEADS: readonly string[] = ['Помним план:', 'План прежний:', 'Наша цель прежняя:'];

/** The move in the instrumental case for «отвечаем …» / «Ходи …» in speech, its notation in the bubble; null when the case does not fit (a capture). */
function insTpl(san: string, fen: string): ((v: Voice) => string) | null {
  const ins = moveInsRu(san);
  if (!ins) return null;
  return (v) => (v.mode === 'speech' ? ins : v.move(san, fen));
}

/**
 * The primary advice sentence and a shorter wording of it, begun as `plan.opener` says (never the
 * same start twice in a row; the opponent's move first about every second turn). The reason: the strategist's «why»
 * for its fresh re-plan choice, the plan goal the move serves, the card's step, or the explainer's ideas (`maxIdeas`).
 * A goal / step that names the move itself («прыгаем конём на е четыре») replaces the move in speech; the bubble still
 * shows the move in notation.
 */
/**
 * The reason parts of an advice sentence: a goal / the card's step that names the move itself («прыгаем конём на е
 * четыре» — it replaces the move in speech), and the «why» of `n` ideas: the strategist's «why» for its fresh re-plan
 * choice, the plan goal the move serves, the card's step, or the explainer's ideas.
 */
function adviceReasonParts(a: AdviceCandidate, strategy: TeachStrategy | null): { names: string | null; namedByGoal: boolean; why: (n: 1 | 2) => string } {
  const goal = a.noReason || a.planWhyRu ? undefined : a.planGoal;
  const step = a.noReason || a.planWhyRu || goal || !strategy ? undefined : a.planStepRu;
  const names = goal?.namesMove ? goal.textRu : step?.namesMove ? step.textRu : null;
  const planWhy = goal && !goal.namesMove ? goal.textRu : step && !step.namesMove ? step.textRu.replace(/^\S+\s+/u, '') : null;
  return { names, namedByGoal: !!goal?.namesMove, why: (n) => (a.noReason ? '' : (a.planWhyRu ?? planWhy ?? whyRu(a, 'you', n))) };
}

/** The «why» words of the advice sentence (`n` ideas; '' without a reason). */
function adviceWhyRu(a: AdviceCandidate, strategy: TeachStrategy | null, n: 1 | 2): string {
  return adviceReasonParts(a, strategy).why(n);
}

/**
 * «Соперник вывел коня на эф шесть — по плану отвечаем слоном на цэ четыре: выводишь слона.» — the opponent-first
 * format, with the reason words `w` ('' = none). A goal that names the move is said instead of the move and needs no `w`.
 */
function oppAdviceTemplate(mention: string, a: AdviceCandidate, strategy: TeachStrategy | null, fen: string, w: string): Template {
  const move = moveTpl(a.san, fen);
  const byPlan = isPlanMove(a, strategy);
  const planWord = a.planFit === 'replan' ? 'по новому плану' : 'по плану';
  const ins = insTpl(a.san, fen);
  const lead = mention.replace(/[.!]+$/u, '');
  const { names, namedByGoal } = adviceReasonParts(a, strategy);
  // (a goal is a «мы» phrase — «а мы по плану прыгаем конём …»; the card's step speaks of the piece — «по плану ладья встаёт …»)
  if (names && byPlan) return (v) => `${lead} — ${namedByGoal ? 'а мы ' : ''}${planWord} ${names}${v.mode === 'bubble' ? ` (${move(v)})` : ''}.`;
  const answer = (v: Voice): string => `${byPlan ? `${planWord} ` : ''}${ins ? `отвечаем ${ins(v)}` : `наш ответ: ${move(v)}`}`;
  return (v) => `${lead} — ${answer(v)}${w ? `${ins ? ': ' : ', '}${w}` : ''}.`;
}

function adviceSentence(plan: TeachPlan, a: AdviceCandidate, maxIdeas: 1 | 2 = 2): { tpl: Template; alt: Template } {
  const move = moveTpl(a.san, plan.fen);
  const byPlan = isPlanMove(a, plan.strategy);
  const replan = a.planFit === 'replan';
  const { names, why } = adviceReasonParts(a, plan.strategy);
  const wMain = why(maxIdeas);
  const w1 = why(1);
  const wShort = maxIdeas === 2 && w1 !== wMain ? w1 : '';
  const sep = (w: string): string => (w.includes(':') ? ' — ' : ': ');
  const opener: TeachOpener = plan.opener === 'opp' && !plan.opponentMentionRu ? 'advice' : (plan.opener ?? (byPlan ? 'plan' : 'advice'));
  const ins = insTpl(a.san, plan.fen);

  // «Соперник вывел коня на эф шесть — по плану отвечаем слоном на цэ четыре: …» (the opponent-first format; chosen only
  // when his move, our answer and one reason fit together — planTeachTurn)
  if (opener === 'opp' && plan.opponentMentionRu) {
    const mention = plan.opponentMentionRu;
    const mk = (w: string): Template => oppAdviceTemplate(mention, a, plan.strategy, plan.fen, w);
    // ONE sentence holds three things here — his move, our answer, why: it stays within the voice's twenty words
    const fits = (tpl: Template): boolean => countWords(render(tpl, plan.profile).text) <= OPP_SENTENCE_WORDS;
    const tpl = [mk(wMain), mk(w1)].find(fits) ?? mk('');
    return { tpl, alt: mk('') };
  }
  // a goal / step that names the move: «Дальше по плану прыгаем конём на е четыре.»
  if (names && byPlan && !replan) {
    const inBubble = (v: Voice): string => (v.mode === 'bubble' ? ` (${move(v)})` : '');
    switch (opener) {
      case 'planNext':
        return { tpl: (v) => `Дальше по плану ${names}${inBubble(v)}.`, alt: (v) => `Дальше по плану — ${move(v)}.` };
      case 'planStep':
        return { tpl: (v) => `Следующий шаг плана: ${names}${inBubble(v)}.`, alt: (v) => `Следующий шаг плана — ${move(v)}.` };
      case 'planMove':
        return { tpl: (v) => `${capRu(names)}${inBubble(v)} — это наш план.`, alt: (v) => `${capMove(v, move)} — это наш план.` };
      default:
        return { tpl: (v) => `По нашему плану ${names}${inBubble(v)}.`, alt: (v) => `По нашему плану — ${move(v)}.` };
    }
  }
  const mk = (w: string): Template => {
    if (replan && opener !== 'opp') return (v) => `По новому плану — ${move(v)}${w ? `${sep(w)}${w}` : ''}.`;
    switch (opener) {
      case 'planNext':
        return (v) => `Дальше по плану — ${move(v)}${w ? `${sep(w)}${w}` : ''}.`;
      case 'planStep':
        return (v) => `Следующий шаг плана — ${move(v)}${w ? `${sep(w)}${w}` : ''}.`;
      case 'planMove':
        return (v) => `${capMove(v, move)} — это по плану${w ? `: ${w}` : ''}.`;
      case 'arrow':
        return (v) => (w.includes(':') ? `Смотри на зелёную стрелку — ${move(v)}, ${w}.` : `Смотри на зелёную стрелку: ${move(v)}${w ? ` — ${w}` : ''}.`);
      case 'good':
        return (v) => `Хороший ход — ${move(v)}${w ? `${sep(w)}${w}` : ''}.`;
      case 'go':
        return (v) => (v.mode === 'speech' && ins ? `Ходи ${ins(v)}${w ? ` — ${w}` : ''}.` : `Ходи: ${move(v)}${w ? ` — ${w}` : ''}.`);
      case 'calm':
        // («можно пойти конём на эф три»; a move without that case is shown by its arrow)
        return (v) => (v.mode === 'speech' && ins ? `Спокойно: можно пойти ${ins(v)}${w ? ` — ${w}` : ''}.` : `Спокойно, зелёная стрелка: ${move(v)}${w ? ` — ${w}` : ''}.`);
      case 'advice':
        return (v) => `Мой совет — ${move(v)}${w ? `${sep(w)}${w}` : ''}.`;
      default:
        // 'plan' (and a plan move without a family) — «По нашему плану — …»
        return byPlan ? (v) => `По нашему плану — ${move(v)}${w ? `${sep(w)}${w}` : ''}.` : (v) => `Мой совет — ${move(v)}${w ? `${sep(w)}${w}` : ''}.`;
    }
  };
  return { tpl: mk(wMain), alt: mk(wShort) };
}

/** The alternative (blue arrow): with the rare invitation to choose, or plain. */
function altSentence(plan: TeachPlan, a: AdviceCandidate, rng: Rng, withChoice: boolean): Template {
  const move = moveTpl(a.san, plan.fen);
  // the move is a noun phrase in the nominative («пешка на дэ четыре»): after a colon, never after «можно и»
  if (!withChoice) return pick([(v: Voice) => `Или синяя стрелка: ${move(v)}.`, (v: Voice) => `Ещё можно так: ${move(v)} — синяя стрелка.`], rng, 'teach.alt.plain');
  return pick([(v: Voice) => `Или синяя стрелка: ${move(v)} — выбирай!`, (v: Voice) => `Ещё можно так: ${move(v)} — это синяя стрелка, выбирай!`, (v: Voice) => `А синяя стрелка — ${move(v)}, решай ${v.g('сам', 'сама')}!`], rng, 'teach.alt');
}

/**
 * The `teachTurn` event of a planned turn (§6.2): `moment` 'turn' / 'openingPlan'; the treasure goes out with
 * `reveal: 'later'` (highlights, no arrow). Priority 1 (2 with a mate threat), the clock stands while it is said.
 */
export function buildTeachTurn(plan: TeachPlan, rng: Rng = Math.random): CoachEvent {
  const primary = plan.advice[0];
  const treasure = plan.treasure;
  const priority: 1 | 2 = plan.danger?.kind === 'mate' ? 2 : 1;
  const brief = teachTurnBrief(plan).brief;
  const parts = teachTurnParts(plan, rng);
  const template = fitText(parts, plan.profile, plan.style);

  const teach: TeachSummary = {
    moment: plan.moment,
    style: plan.style,
    ply: plan.ply,
    advice: treasure ? [] : plan.advice.map(toTeachAdvice),
  };
  if (plan.conceptId) teach.conceptId = plan.conceptId;
  if (treasure) teach.reveal = 'later';
  else if (primary) teach.reveal = 'now';

  const pose = plan.danger || treasure ? 'think' : 'talk';
  const event = makeEvent({
    kind: 'teachTurn',
    priority,
    pose,
    pauseClock: true,
    profile: plan.profile,
    template,
    board: teachAnnotations(plan, { arrows: !treasure }),
    brief,
    teach,
  });
  return withClip(event, teachTurnTwin(plan, parts, pose));
}

/**
 * The recorded twin of a teacher turn (docs/voice-clips/SPEC.md §3.4): the same parts as `text`, each as catalogue
 * lines + the advised move as a typed slot, fitted to 2 sentences / 18 words (the short style: 1 / 10). Pure — the
 * same plan always gives the same twin; `buildTeachTurn` attaches it as `event.clip`.
 */
export function teachTurnClip(plan: TeachPlan): ClipUtterance | null {
  return teachTurnTwin(plan, teachTurnParts(plan, () => 0), plan.danger || plan.treasure ? 'think' : 'talk');
}

function teachTurnTwin(plan: TeachPlan, parts: readonly TextPart[], pose: 'think' | 'talk'): ClipUtterance | null {
  return twinUtterance({
    sentences: parts.flatMap((p) => p.clip ?? []),
    kind: 'teachTurn',
    pose,
    moment: plan.moment,
    caps: twinCapsFor({ teacher: true, style: plan.style }),
  });
}

/** The optional facts of a turn as they appear in the brief (so the planner can see which ones fit the budget). */
function ruleFactRu(r: string): string {
  return r;
}
function planFactRu(p: NonNullable<TeachPlan['plan']>): string {
  return p.factRu;
}
/** «это Итальянская партия» / «это «Дебют Уэра»» — never «пошла по дебюту «Дебют …»». */
function nameFactRu(name: string): string {
  return /^дебют\b/iu.test(name) ? `это «${name}»` : `партия пошла по дебюту «${name}»`;
}

/** The opponent's news of a turn whose extra is his move: the early-queen rule, his threat, or ≤ 6 words about the move. */
function opponentFactRu(plan: TeachPlan, s: StudentWords): string | null {
  if (plan.extra !== 'opponent' || !plan.opponent) return null;
  const rule = plan.rules.find((r) => r.startsWith('соперник рано'));
  if (rule) return rule;
  if (plan.opponent.wants && !plan.danger) return threatFactsRu(plan.fen, plan.opponent.wants, s).join('. ');
  if (plan.opponentMentionRu) return plan.opponentMentionRu.replace(/[.!]+$/u, '');
  return plan.opponent.ideas.length > 0 ? `соперник ${joinIdeasRu(plan.opponent.ideas)}` : null;
}

/** What the turn says first / after the advice, for its one extra (the «Цель» line). */
function extraGoalRu(plan: TeachPlan, s: StudentWords): { before?: string; after?: string } {
  switch (plan.extra) {
    case 'danger':
      return { before: plan.concept ? `сначала в нескольких словах назови опасность — это «${plan.concept.title}»` : 'сначала в нескольких словах назови опасность, спокойно' };
    case 'deviation':
      return { before: 'сначала в нескольких словах: соперник свернул с нашей дороги, и что теперь' };
    case 'bookLeft':
      return { before: 'сначала в нескольких словах: соперник сыграл не по нашему плану' };
    case 'ownGood':
      return { before: `сначала одним-двумя словами похвали ${s.acc} за свой хороший ход` };
    case 'opponent':
      return { before: 'сначала ход соперника — не больше шести слов' };
    case 'unguarded':
      return { after: 'в нескольких словах скажи, почему защищать сейчас не нужно' };
    case 'newPlan':
      return { after: 'назови новый план в нескольких словах' };
    case 'openingPlan':
    case 'plan':
      // (a goal of the strategy beside a move that is no step of it: a reminder, not the move's reason)
      if (plan.plan?.key.startsWith('goal:')) return { after: 'потом одной короткой фразой напомни цель нашего плана из фактов' };
      return { after: 'одной короткой фразой скажи план' };
    case 'name':
      return { after: 'назови дебют в двух-трёх словах' };
    case 'onlyMove':
      return { after: 'скажи, что тут только один хороший ход' };
    default:
      return {};
  }
}

/**
 * How the voice should begin the advice (plan.opener): «начни со слов «Дальше по плану»» / «начни прямо с хода» — the
 * live model copied the one «по нашему плану …» of every goal (16 of 20 remarks). After another extra it is the advice
 * part that begins so («совет начни …»). null: the opponent-first phrase has its own goal; no advice.
 */
function openerGoalRu(plan: TeachPlan, afterExtra: boolean): string | null {
  const o = plan.opener;
  const primary = plan.advice[0];
  if (!o || o === 'opp' || !primary) return null;
  const first = primary.planFit === 'replan' ? 'По новому плану' : OPENER_WORDS[o];
  const what = afterExtra ? 'совет начни' : 'начни';
  return first ? `${what} со слов «${first}»` : `${what} прямо с хода`;
}

/** «ничего не добавляй от себя: ни хода соперника, ни похвалы, ни новой темы, ни всего плана, ни вопроса» — minus the extra of the turn. */
function nothingExtraRu(plan: TeachPlan): string {
  const x = plan.extra;
  const items: string[] = [];
  if (x !== 'opponent' && x !== 'danger' && x !== 'deviation' && x !== 'bookLeft') items.push('хода соперника');
  if (x !== 'ownGood') items.push('похвалы');
  if (x !== 'topic' && !plan.concept) items.push('новой темы');
  if (plan.strategy) items.push('всего плана');
  if (!plan.choice && !plan.treasure) items.push('вопроса');
  return `ничего не добавляй от себя: ни ${items.join(', ни ')}`;
}

/**
 * The brief of a teacher turn (§6.2) within its style's budget: the advice — the move and ONE reason — plus at most the
 * one extra `planTeachTurn` chose (`plan.extra`); every other field of the plan is empty then. `kept` = the texts of the
 * facts that made it in — the planner uses it so that a rule / plan / name dropped for the budget is not remembered as said.
 */
function teachTurnBrief(plan: TeachPlan): { brief: string; kept: ReadonlySet<string> } {
  const s = words(plan.profile);
  const treasure = plan.treasure;
  const primary = plan.advice[0];
  // facts in the logical order of §2.3; `prio` decides what survives the budget (higher = kept longer)
  const facts: Fact[] = [];
  for (const n of plan.notes) facts.push({ text: n, prio: n === RULES_NOTE ? 11 : 8 });
  if (plan.reaction) facts.push({ text: plan.reaction.factRu, prio: plan.reaction.prio });
  if (plan.deviation) facts.push({ text: plan.deviation.factRu, prio: 9 });
  if (plan.newPlanRu) facts.push({ text: `новый план: ${plan.newPlanRu}`, prio: 8 });
  if (plan.danger) facts.push({ text: plan.danger.factRu, prio: 9 });
  if (plan.danger?.unresolvedRu) facts.push({ text: plan.danger.unresolvedRu, prio: 8 });
  if (treasure) facts.push({ text: treasure.factRu, prio: 10 });
  const oppFact = opponentFactRu(plan, s);
  if (oppFact) facts.push({ text: oppFact, prio: 8 });
  if (!treasure) {
    // (the blue arrow's fact only on a choice turn — elsewhere it stays a silent arrow on the board)
    plan.advice.forEach((a, i) => {
      if (i > 0 && !plan.choice) return;
      facts.push({ text: adviceFactRu(a, plan.strategy, plan.extra !== 'topic'), prio: i === 0 ? 10 : 7 });
    });
    if (plan.advice.length === 0) facts.push({ text: 'хода, который можно показать, сейчас нет: напомни правило — сначала что хочет соперник, потом шахи, взятия и угрозы', prio: 10 });
  }
  // the first turn of a game without a strategy is about the plan (§6.2 «План дебюта»)
  if (plan.plan) facts.push({ text: planFactRu(plan.plan), prio: plan.moment === 'openingPlan' ? 9 : 7 });
  if (plan.openingName) facts.push({ text: nameFactRu(plan.openingName), prio: 6 });
  // a topic of the turn: an opening principle or a concept card — it explains the advice
  if (plan.extra === 'topic') for (const r of plan.rules) facts.push({ text: ruleFactRu(r), prio: 7 });
  if (plan.concept) plan.concept.factsRu.forEach((f) => facts.push({ text: f, prio: (plan.concept as { prio: number }).prio }));
  // (a topic's fact is «новая тема «…»: …» — see topicExplanationRu; its goal asks for ONE sentence with the move)

  // the blue arrow is spoken only on the rare choice turns: elsewhere the voice model may name only the green one (with
  // the blue move in «Можно назвать» the model may advise it instead of the green)
  const spokenAdvice = plan.choice ? plan.advice : plan.advice.filter((a) => a.arrow === 'green');
  const nameable: string[] = treasure ? [`сам ход ученика не называй — ${s.nom} ищет его ${s.g('сам', 'сама')}`] : adviceLineRu(spokenAdvice.length > 0 ? spokenAdvice : plan.advice, true);
  if (plan.danger?.threatSpoken) nameable.push(`${plan.danger.threatSpoken} (ход соперника, только как угрозу)`);
  if (nameable.length === 0) nameable.push('ходов ученика не называй — точной проверки сейчас нет');

  const goals: string[] = [];
  if (plan.hurry) goals.push('начни со слова «Поторопись!»');
  const short = plan.style === 'short';
  const byPlan = !!primary && isPlanMove(primary, plan.strategy);
  // the opponent-first format: his move first, then our answer — in ONE phrase (plan.opener 'opp')
  const oppFirst = plan.opener === 'opp' && !!plan.opponentMentionRu;
  if (plan.mode === 'rules') {
    goals.push(`честно скажи, что сейчас не можешь точно проверить ходы${plan.advice.length > 0 ? ', и покажи знакомый ход начала партии' : ', и напомни правило'}`);
    goals.push(`решает ${s.nom}`);
  } else if (treasure) {
    // (not «Тут есть подарок: выигрыш материала. Это может сделать конь. Попробуй найти сам.» — three items, three sentences)
    goals.push(`две короткие фразы, не больше: первая — тут подарок и какая фигура может его взять, вторая — пусть ${s.nom} поищет ход ${s.g('сам', 'сама')}`);
  } else if (plan.intro) {
    goals.push('одной-двумя короткими фразами скажи, какую стратегию разыграем в этой партии и зачем, и назови первый ход');
  } else if (short) {
    if (oppFirst) goals.push(`одно короткое предложение: ход соперника в двух-трёх словах, наш ответ${byPlan ? ' по плану' : ''} и одна причина`);
    else goals.push(byPlan ? 'одно короткое предложение: назови ход и одну причину — шаг нашего плана' : 'одно короткое предложение: назови ход и одну причину');
    const start = openerGoalRu(plan, false);
    if (start) goals.push(start);
  } else {
    const extraGoal = extraGoalRu(plan, s);
    if (extraGoal.before && !oppFirst) goals.push(extraGoal.before);
    const planHead = byPlan ? ' как шаг нашего плана' : '';
    if (oppFirst) goals.push(`одной фразой: сначала ход соперника — не больше шести слов, потом наш ответ${byPlan ? ' по плану' : ''} и одна причина`);
    else if (plan.extra === 'topic' && plan.concept) goals.push(`одной фразой назови ход${planHead} и объясни его новой темой «${plan.concept.title}» — в пяти словах, это и есть причина`);
    else if (plan.extra === 'topic' && plan.rules.length > 0) goals.push(`одной фразой назови ход${planHead} и объясни его правилом из фактов — в нескольких словах, это и есть причина`);
    else if (primary) goals.push(byPlan ? 'назови ход и одну причину — как шаг нашего плана' : 'назови ход и одну причину');
    else goals.push('напомни правило в одной фразе');
    const start = openerGoalRu(plan, !!extraGoal.before && !oppFirst);
    if (start) goals.push(start);
    if (extraGoal.after) goals.push(extraGoal.after);
    // (not «… Или можно двинуть пешку на е пять. Какую стрелку выбираешь?» — the choice in two sentences)
    if (plan.choice) goals.push(`вторая и последняя фраза — синяя стрелка и вопрос вместе: «или …, что выберешь?»`);
  }
  // FORBID_SHAME, «ход делает ученик» and FORBID_POPULARITY are left to the system prompt here: a teachTurn is not about a
  // mistake, and its facts carry no «how common» words (only the rules mode's «так часто начинают партию»)
  const popularity = plan.mode === 'rules' && plan.advice.length > 0;
  const forbid = [FORBID_OTHER_MOVES, FORBID_BEST_WORD, popularity ? FORBID_POPULARITY : null].filter((f): f is string => f !== null).map((f) => forbidFor(f, s));
  if (treasure) forbid.unshift('не называй сам ход и клетку, куда идти');
  forbid.push(FORBID_OBVIOUS);
  forbid.push(short ? 'не больше одного предложения' : FORBID_TWO_SENTENCES);
  if (!plan.intro) forbid.push(nothingExtraRu(plan));
  if (plan.danger) forbid.push('не пугай');
  return fittedBrief({ moment: momentRu(plan, s), facts, advice: nameable, goal: goals, forbid }, TEACH_BRIEF_CHARS[plan.style]);
}

/**
 * The parts of a teacher turn — the template `text` (the browser voice / bubble fallback: one or two short sentences,
 * ≤ 25 words, `fitText`) and, part by part, its recorded twin (`clip`, fitted by `teachTurnTwin`). The twins never use
 * `rng`: the text's random choices are exactly those of the text alone.
 */
function teachTurnParts(plan: TeachPlan, rng: Rng): TextPart[] {
  const primary = plan.advice[0];
  const treasure = plan.treasure;
  const g = genderOf(plan.profile);
  const parts: TextPart[] = [];
  const hurry: TextPart | null = plan.hurry ? { tpl: say('Поторопись!'), prio: 85, clip: [wholeSentence('teach.hurry', 85)] } : null;
  if (hurry) parts.push(hurry);
  if (treasure) {
    // in check the check comes first — the gift has to answer it (G04 7…Кxc2+)
    if (plan.danger?.kind === 'check') parts.push({ tpl: say(plan.danger.textRu), alt: say('Шах!'), prio: 100, clip: [wholeSentence('danger.check', 100)] });
    // (what the gift is, never where: the move is the child's to find, `reveal: 'later'`)
    parts.push({ tpl: say(treasure.textRu), prio: 100, clip: [wholeSentence(treasure.clip ?? lineItem('treasure.gift'), 100)] });
    parts.push({ tpl: (v) => `Найдёшь ход ${v.g('сам', 'сама')}?`, prio: 60, clip: [wholeSentence(lineItem('ask.find', { g }), 60)] });
  } else if (plan.intro && primary && plan.strategy) {
    // «В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е четыре.»
    parts.push({
      tpl: strategyIntroTemplate(plan.strategy, { san: primary.san, fenBefore: plan.fen }, plan.childColor),
      prio: 100,
      clip: strategyIntroSentences(plan.strategy, { san: primary.san, fenBefore: plan.fen }, plan.childColor, g),
    });
  } else if (plan.style === 'short') {
    // one sentence, one reason: «Спокойно: можно …», «Дальше по плану …», «Соперник … — отвечаем …»
    if (primary) {
      const s = adviceSentence(plan, primary, 1);
      parts.push({ tpl: s.tpl, alt: s.alt, prio: 100, clip: adviceClip(plan, primary) });
    } else parts.push({ tpl: say('Всё спокойно — подумай, какая фигура стоит хуже всех.'), prio: 100, clip: [wholeSentence('teach.calm.noAdvice', 100)] });
  } else {
    const danger = plan.danger;
    if (plan.mode === 'rules') parts.push({ tpl: say('Точно проверить ходы сейчас не могу.'), prio: 80, clip: [wholeSentence('teach.rules', 80)] });
    if (plan.reaction) {
      const prio = plan.reaction.kind === 'ownGood' ? 50 : plan.reaction.kind === 'fine' ? 12 : 15;
      parts.push({ tpl: plan.reaction.textRu, ...(plan.reaction.shortRu ? { alt: plan.reaction.shortRu } : {}), prio, clip: plan.reaction.clip ? [wholeSentence(plan.reaction.clip, prio)] : [] });
    }
    // (the opponent's move that leads the advice sentence is said there, not as a sentence of its own)
    if (plan.opponentMentionRu && plan.opener !== 'opp') parts.push({ tpl: say(plan.opponentMentionRu), prio: 40, clip: plan.opponentClip ? [wholeSentence(plan.opponentClip, 40)] : [] });
    if (danger) parts.push({ tpl: say(danger.textRu), ...(danger.kind === 'check' ? { alt: say('Шах!') } : {}), prio: 90, clip: danger.clip ? [wholeSentence(danger.clip, 90)] : [] });
    // (the strategist's new plan is free text: never voiced from clips)
    if (plan.deviation) parts.push({ tpl: say(plan.deviation.textRu), alt: say(plan.deviation.shortRu), prio: 70, clip: plan.deviation.clip ? [wholeSentence(plan.deviation.clip, 70)] : [] });
    else if (plan.newPlanRu) parts.push({ tpl: say(`Новый план: ${plan.newPlanRu}.`), prio: 65, clip: [] });
    if (primary) {
      // (a goal of the plan follows: the advice keeps one idea, so that both fit the 25 words)
      const s = adviceSentence(plan, primary, plan.plan?.key.startsWith('goal:') ? 1 : 2);
      parts.push({ tpl: s.tpl, alt: s.alt, prio: 100, clip: adviceClip(plan, primary) });
    } else parts.push({ tpl: say('Сначала проверь, что хочет соперник, потом — шахи, взятия и угрозы.'), prio: 100, clip: [wholeSentence('teach.noAdvice', 100)] });
    if (plan.openingName) parts.push({ tpl: say(`${capRu(nameFactRu(plan.openingName))}.`), prio: 15, clip: [] });
    if (plan.concept) {
      const topic = `topic.${plan.concept.id}`;
      parts.push({ tpl: say(plan.concept.textRu), prio: 35, clip: hasClipLine(topic) ? [wholeSentence(topic, 35)] : [] });
    }
    if (plan.plan?.textRu) parts.push({ tpl: say(plan.plan.textRu), prio: 25, clip: plan.plan.clip ? [wholeSentence(plan.plan.clip, 25)] : [] });
    // the blue arrow is on the board — it is SAID only on the rare choice turn (nothing superfluous)
    const alt = plan.advice[1];
    if (alt && plan.choice) {
      const choose = moveSentence({ head: 'teach.head.alt', san: alt.san, fen: plan.fen, reason: lineItem('teach.tail.choose', { g }), reasonWeight: 34, prio: 33 });
      parts.push({ tpl: altSentence(plan, alt, rng, true), alt: altSentence(plan, alt, () => 0, false), prio: 33, clip: [choose] });
    }
  }
  return parts;
}

/**
 * The advice sentence as recorded clips, begun as `plan.opener` says (the same head family as `adviceSentence`):
 * [head ·] the move as a slot [· one reason]. The 'opp' opener says the opponent's move first as its own piece-only
 * sentence, then «Отвечаем так: …». Reasons: one idea of the explainer, the plan goal the move serves (its line
 * without squares), the plain plan tail for a card's step — never the strategist's words.
 */
function adviceClip(plan: TeachPlan, a: AdviceCandidate): (TwinSentence | null)[] {
  const byPlan = isPlanMove(a, plan.strategy);
  const replan = a.planFit === 'replan';
  // (the short style keeps one sentence: his move would be cut, and «Отвечаем так: …» would answer nothing)
  const oppFirst = plan.opener === 'opp' && !!plan.opponentMentionRu && plan.style !== 'short';
  const opener: TeachOpener = plan.opener === 'opp' && !oppFirst ? (byPlan ? 'plan' : 'advice') : (plan.opener ?? (byPlan ? 'plan' : 'advice'));
  let head: string | null;
  if (oppFirst) head = byPlan ? 'teach.head.answer.plan' : 'teach.head.answer';
  else if (replan) head = 'teach.head.replan';
  // a goal / step that names the move is said «по плану» whatever the opener (as `adviceSentence`)
  else if (byPlan && adviceReasonParts(a, plan.strategy).names) head = opener === 'planNext' || opener === 'planStep' || opener === 'planMove' ? ADVICE_HEADS[opener] : 'teach.head.plan';
  else head = opener === 'plan' && !byPlan ? 'teach.head.advice' : ADVICE_HEADS[opener];
  const planHead = head !== null && PLAN_HEADS.has(head);
  let reason = head === null ? lineItem('teach.tail.plan') : adviceReasonClip(plan, a, planHead);
  // (the deviation line said where the plan goes; its goal is the reason of the advice that follows)
  if (!reason && a.noReason && plan.extra === 'deviation' && plan.deviation?.goalRu) reason = goalItemOf(plan.deviation.goalRu);
  const advice = moveSentence({ head, san: a.san, fen: plan.fen, reason, prio: 100, moveNews: true });
  if (!oppFirst) return [advice];
  // his move in its own short sentence (piece only), then our answer — one extra of the turn, like the text's lead
  return [plan.opponentClip ? wholeSentence(plan.opponentClip, 45) : null, advice];
}

/** The recorded head of each advice opener (the same families as `adviceSentence`); null = the move first. */
const ADVICE_HEADS: Readonly<Record<TeachOpener, string | null>> = {
  opp: 'teach.head.answer',
  plan: 'teach.head.plan',
  planNext: 'teach.head.planNext',
  planStep: 'teach.head.planStep',
  // «Пешка на дэ четыре — это по нашему плану.»: the move first, the plan tail after it
  planMove: null,
  advice: 'teach.head.advice',
  arrow: 'teach.head.arrow',
  good: 'teach.head.good',
  go: 'teach.head.go',
  calm: 'teach.head.calm',
};

/** Heads that already say «по плану» (a plan move after them needs no plain plan tail). */
const PLAN_HEADS: ReadonlySet<string> = new Set(['teach.head.plan', 'teach.head.planNext', 'teach.head.planStep', 'teach.head.replan', 'teach.head.answer.plan']);

/** The one reason of the advice sentence as a tail item (null = the move alone). */
function adviceReasonClip(plan: TeachPlan, a: AdviceCandidate, planHead: boolean): ClipItem | null {
  if (a.noReason) return null;
  const byPlan = isPlanMove(a, plan.strategy);
  // the strategist's «why» is free text: a plan head says the plan already, another head gets the plain plan tail
  if (a.planWhyRu) return byPlan && !planHead ? lineItem('teach.tail.plan') : null;
  if (a.planGoal) return goalItemOf(a.planGoal.textRu);
  if (plan.strategy && a.planStepRu) return planHead ? null : lineItem('teach.tail.plan');
  const idea = a.ideas.find((i) => !(i.id === 'promotion' && a.san.includes('=')));
  return reasonOfIdea(idea, plan.fen, a.uci);
}

/**
 * The treasure's reveal (§2.6 п. 2): after `treasureRevealMs(stage)` without a move, or when the child asks («покажи»,
 * «Совет»): the green arrow and one phrase. `moment: 'reveal'`.
 */
export function buildTeachReveal(plan: TeachPlan, rng: Rng = Math.random, opts: { asked?: boolean } = {}): CoachEvent {
  const s = words(plan.profile);
  const t = plan.treasure;
  const move = t ? { uci: t.uci, san: t.san } : plan.advice[0] ? { uci: plan.advice[0].uci, san: plan.advice[0].san } : null;
  const primary = plan.advice[0];
  const why = primary ? whyRu(primary, 'you', 1) : '';
  const whyBrief = primary ? whyRu(primary, 'brief', 1) : '';
  const spoken = move ? spokenMoveRu(move.san, plan.fen) : '';
  const mt = move ? moveTpl(move.san, plan.fen) : null;
  const tpls: readonly Template[] = mt
    ? [(v) => `Вот он: ${mt(v)}${why ? ` — ${why}` : ''}!`, (v) => `Смотри на зелёную стрелку: ${mt(v)}${why ? ` — ${why}` : ''}.`, (v) => `Подарок такой: ${mt(v)}${why ? ` — ${why}` : ''}!`]
    : [say('Посмотри ещё раз на фигуры соперника без защиты.')];
  const arrows: BoardAnnotations['arrows'] = [];
  const p = move ? parseUci(move.uci) : null;
  if (p) arrows.push({ from: p.from, to: p.to, color: 'green' });
  const { brief } = fittedBrief(
    {
      moment: opts.asked ? `${s.nom} ${s.g('попросил', 'попросила')} показать подарок` : `${s.nom} не ${s.g('нашёл', 'нашла')} подарок сразу — пора показать`,
      facts: [{ text: t?.factRu, prio: 5 }, { text: spoken ? `ход: ${spoken}${whyBrief ? ` — ${whyBrief}` : ''}; на доске зелёная стрелка` : null, prio: 10 }],
      advice: spoken ? [`${spoken} (зелёная стрелка)`] : ['ходов ученика не называй'],
      goal: ['покажи ход и объясни одной фразой', `ход делает ${s.nom}`],
      forbid: [FORBID_MOVE_FOR_CHILD, FORBID_BEST_WORD, FORBID_SHAME].map((f) => forbidFor(f, s)),
    },
    TEACH_BRIEF_CHARS.short,
  );
  const advice: TeachAdvice[] = move ? [{ uci: move.uci, san: move.san, source: primary?.source ?? 'engine', arrow: 'green' }] : [];
  const chosen = pick(tpls, rng, 'teach.reveal');
  const bare: Template = mt ? (v) => `Вот он: ${mt(v)}!` : chosen;
  const event = makeEvent({
    kind: 'teachTurn',
    priority: 1,
    pose: 'talk',
    pauseClock: true,
    profile: plan.profile,
    template: fitFirst([chosen, bare], plan.profile, 'short'),
    board: { arrows, highlights: [] },
    brief,
    teach: { moment: 'reveal', style: 'short', ply: plan.ply, advice, reveal: 'now' },
  });
  // «Вот он:» · the move · its one reason (the treasure's own news — a mate — first)
  const idea = primary?.ideas.find((i) => !(i.id === 'promotion' && primary.san.includes('=')));
  const said = move
    ? moveSentence({ head: 'reveal.head', san: move.san, fen: plan.fen, reason: primary ? reasonOfIdea(idea, plan.fen, primary.uci) : null, prio: 100, moveNews: true })
    : wholeSentence('reveal.none', 100);
  return withClip(event, twinUtterance({ sentences: [said], kind: 'teachTurn', pose: 'talk', moment: 'reveal', caps: twinCapsFor({ teacher: true, style: 'short' }) }));
}

/**
 * «Совет» again (the button, «подскажи», after «Верну ход»): the advice of this ply as it was, arrows again, the short
 * style (§1.4, §6.2 «Повтор»). A hidden treasure is revealed instead (`opts.revealed` = it was already shown).
 * Priority 2 when the child asked (`opts.asked`, default), else 1.
 */
export function buildTeachRepeat(plan: TeachPlan, rng: Rng = Math.random, opts: { asked?: boolean; revealed?: boolean } = {}): CoachEvent {
  const asked = opts.asked ?? true;
  if (plan.treasure && !opts.revealed) {
    const ev = buildTeachReveal(plan, rng, { asked });
    return asked ? { ...ev, priority: 2 } : ev;
  }
  const s = words(plan.profile);
  const advice = plan.treasure
    ? [{ ...(plan.advice[0] as AdviceCandidate), arrow: 'green' as const, role: 'primary' as const }].filter((a) => a.uci !== undefined)
    : plan.advice;
  const moves = advice.map((a) => moveTpl(a.san, plan.fen));
  const tpls: readonly Template[] =
    moves.length >= 2
      ? [(v) => `Вот мои варианты: ${(moves[0] as (v: Voice) => string)(v)} или ${(moves[1] as (v: Voice) => string)(v)} — выбирай!`, (v) => `Зелёная стрелка — ${(moves[0] as (v: Voice) => string)(v)}, синяя — ${(moves[1] as (v: Voice) => string)(v)}. Выбирай!`]
      : moves.length === 1
        ? [(v) => `Мой совет — ${(moves[0] as (v: Voice) => string)(v)}. Решай ${v.g('сам', 'сама')}!`, (v) => `Вот мой вариант: ${(moves[0] as (v: Voice) => string)(v)} — выбирай!`]
        : [say('Сначала проверь, что хочет соперник, потом — шахи, взятия и угрозы.')];
  const ideas = advice.map((a) => (a.ideas.length > 0 ? `${a.spokenRu} — ${whyRu(a, 'brief', 1)}` : a.spokenRu));
  const { brief } = fittedBrief(
    {
      moment: asked ? `${s.nom} ${s.g('попросил', 'попросила')} совет ещё раз` : 'совет этого хода ещё раз',
      facts: [{ text: ideas.length > 0 ? `совет: ${ideas.join('; ')}` : 'точного совета сейчас нет: напомни правило — сначала что хочет соперник, потом шахи, взятия и угрозы', prio: 10 }],
      advice: advice.length > 0 ? adviceLineRu(advice, true) : ['ходов ученика не называй'],
      goal: ['коротко повтори совет', `решает ${s.nom}`],
      forbid: [FORBID_OTHER_MOVES, FORBID_BEST_WORD, FORBID_MOVE_FOR_CHILD, 'не больше двух коротких предложений'].map((f) => forbidFor(f, s)),
    },
    TEACH_BRIEF_CHARS.short,
  );
  const arrows: BoardAnnotations['arrows'] = [];
  for (const a of advice) {
    const p = parseUci(a.uci);
    if (p) arrows.push({ from: p.from, to: p.to, color: a.arrow });
  }
  const event = makeEvent({
    kind: 'teachTurn',
    priority: asked ? 2 : 1,
    pose: 'talk',
    pauseClock: true,
    profile: plan.profile,
    template: fitFirst([pick(tpls, rng, 'teach.repeat'), ...tpls], plan.profile, 'short'),
    board: { arrows, highlights: [] },
    brief,
    teach: { moment: 'repeat', style: 'short', ply: plan.ply, advice: advice.map(toTeachAdvice), reveal: 'now' },
  });
  // «Повторяю совет:» · the move — then «Решай сам!» / the blue arrow «— выбирай!» (the short style keeps one sentence)
  const g = genderOf(plan.profile);
  const [first, second] = advice;
  const sentences: (TwinSentence | null)[] = !first
    ? [wholeSentence('teach.noAdvice', 100)]
    : second
      ? [
          moveSentence({ head: 'teach.head.arrow', san: first.san, fen: plan.fen, prio: 100, moveNews: true }),
          moveSentence({ head: 'teach.head.alt', san: second.san, fen: plan.fen, reason: lineItem('teach.tail.choose', { g }), reasonWeight: 61, prio: 60 }),
        ]
      : [moveSentence({ head: 'repeat.head', san: first.san, fen: plan.fen, prio: 100, moveNews: true }), wholeSentence(lineItem('ask.decide', { g }), 50)];
  return withClip(event, twinUtterance({ sentences, kind: 'teachTurn', pose: 'talk', moment: 'repeat', caps: twinCapsFor({ teacher: true, style: 'short' }) }));
}

/**
 * «Почему так?» (the «Спроси» chip of «Записи», docs/voice-clips/SPEC.md §8.2) on the child's turn: the advice of this
 * ply WITH its reason, in one sentence «конь на эф три — выводишь коня в игру» (S·T: a move said in its split form
 * still keeps the reason — ≤ 3 clips). A move without an idea is «спокойный крепкий ход».
 *
 * A treasure that is still hidden (`opts.revealed` false) is never shown by this answer: the gift line again and
 * «Найдёшь ход сам?» — no move, no arrow (the board keeps its blue / yellow squares). Unlike `buildTeachRepeat` this
 * builder never reveals anything: the caller marks nothing as revealed and leaves the reveal timer alone.
 * Priority 1 (the child's question waits for the phrase being said), the clock stands while it is said.
 */
export function buildTeachWhy(plan: TeachPlan, opts: { revealed?: boolean } = {}): CoachEvent {
  const s = words(plan.profile);
  const g = genderOf(plan.profile);
  const t = plan.treasure;
  const primary = plan.advice[0];
  const forbid = [FORBID_OTHER_MOVES, FORBID_BEST_WORD, FORBID_MOVE_FOR_CHILD, 'не больше двух коротких предложений'].map((f) => forbidFor(f, s));
  const asked = `${s.nom} ${s.g('спросил', 'спросила')}, почему этот ход`;

  if (t && opts.revealed !== true) {
    // the gift is the child's to find: what it is, never where, never the move (reveal: 'later')
    const { brief } = fittedBrief(
      {
        moment: `${s.nom} ${s.g('спросил', 'спросила')} «почему так?», а в позиции спрятан подарок — его ${s.nom} ищет ${s.g('сам', 'сама')}`,
        facts: [{ text: t.factRu, prio: 10 }],
        advice: ['ходов ученика не называй: подарок ищет ученик'],
        goal: ['скажи, что тут есть подарок, и спроси, найдёт ли ход'],
        forbid: [FORBID_MOVE_FOR_CHILD, FORBID_BEST_MOVE, FORBID_SHAME].map((f) => forbidFor(f, s)),
      },
      TEACH_BRIEF_CHARS.short,
    );
    const event = makeEvent({
      kind: 'teachTurn',
      priority: 1,
      pose: 'think',
      pauseClock: true,
      profile: plan.profile,
      template: join(say(t.textRu), (v) => `Найдёшь ход ${v.g('сам', 'сама')}?`),
      // the same squares as the turn, never an arrow
      board: teachAnnotations(plan, { arrows: false }),
      brief,
      teach: { moment: 'repeat', style: 'full', ply: plan.ply, advice: [], reveal: 'later' },
    });
    const sentences = [wholeSentence(t.clip ?? lineItem('treasure.gift'), 100), wholeSentence(lineItem('ask.find', { g }), 60)];
    return withClip(event, twinUtterance({ sentences, kind: 'teachTurn', pose: 'think', moment: 'repeat', caps: twinCapsFor({ teacher: true, style: 'full' }) }));
  }

  // the move explained: the (revealed) gift, else the primary advice
  const move = t ? { uci: t.uci, san: t.san } : primary ? { uci: primary.uci, san: primary.san } : null;
  if (!move || !primary) {
    const event = makeEvent({
      kind: 'teachTurn',
      priority: 1,
      pose: 'think',
      pauseClock: true,
      profile: plan.profile,
      template: say('Сначала проверь, что хочет соперник, потом — шахи, взятия и угрозы.'),
      brief: fittedBrief({ moment: asked, facts: [{ text: 'точного совета сейчас нет: напомни правило — сначала что хочет соперник, потом шахи, взятия и угрозы', prio: 10 }], advice: ['ходов ученика не называй'], goal: ['одной фразой напомни правило'], forbid }, TEACH_BRIEF_CHARS.short).brief,
      teach: { moment: 'repeat', style: 'short', ply: plan.ply, advice: [], reveal: 'now' },
    });
    return withClip(event, twinUtterance({ sentences: [wholeSentence('teach.noAdvice', 100)], kind: 'teachTurn', pose: 'think', moment: 'repeat', caps: twinCapsFor({ teacher: true, style: 'short' }) }));
  }
  const mt = moveTpl(move.san, plan.fen);
  // the reason: a revealed gift says the gift's own idea (as the reveal does), the advice its plan / idea
  const why = t ? whyRu(primary, 'you', 1) : adviceWhyRu(primary, plan.strategy, 1);
  const idea = primary.ideas.find((i) => !(i.id === 'promotion' && primary.san.includes('=')));
  // (the strategist's free «why» is never voiced: then the move's own idea, else «спокойный крепкий ход»)
  const reason = (t ? null : adviceReasonClip(plan, primary, false)) ?? reasonOfIdea(idea, plan.fen, primary.uci) ?? lineItem('reason.quiet');
  const said = why || 'спокойный крепкий ход';
  const spoken = spokenMoveRu(move.san, plan.fen);
  const { brief } = fittedBrief(
    {
      moment: asked,
      facts: [{ text: `совет: ${spoken}${why ? ` — ${whyRu(primary, 'brief', 1) || why}` : ' — спокойный крепкий ход'}; на доске зелёная стрелка`, prio: 10 }],
      advice: [`${spoken} (зелёная стрелка)`],
      goal: ['одной фразой объясни, зачем этот ход', `решает ${s.nom}`],
      forbid,
    },
    TEACH_BRIEF_CHARS.short,
  );
  const arrows: BoardAnnotations['arrows'] = [];
  const p = parseUci(move.uci);
  if (p) arrows.push({ from: p.from, to: p.to, color: 'green' });
  const event = makeEvent({
    kind: 'teachTurn',
    priority: 1,
    pose: 'talk',
    pauseClock: true,
    profile: plan.profile,
    template: (v) => `${capMove(v, mt)} — ${said}.`,
    board: { arrows, highlights: [] },
    brief,
    teach: { moment: 'repeat', style: 'short', ply: plan.ply, advice: [{ uci: move.uci, san: move.san, source: primary.source, arrow: 'green' }], reveal: 'now' },
  });
  // «Конь на эф три» · «— выводишь коня в игру.» (a mate / promotion is its own reason: `moveNews`)
  const sentence = moveSentence({ head: null, san: move.san, fen: plan.fen, reason, prio: 100, moveNews: true });
  return withClip(event, twinUtterance({ sentences: [sentence], kind: 'teachTurn', pose: 'talk', moment: 'repeat', caps: twinCapsFor({ teacher: true, style: 'short' }) }));
}

// ═════════════════════════ the smart strategist: re-plans ═════════════════════════

/** Why the game should ask the strategist for a re-plan now: the opponent left the strategy's road with his last move, or the phase changed. */
export type ReplanReason = 'deviation' | 'phase';

/**
 * Should the game ask POST /coach/replan for this position? Called on the REAL bot move (the moment the bot engine
 * decided it, before it is shown) with `ctx.fen` after that move — never on a guess. null = no reason.
 */
export function replanReason(ctx: Pick<TeachContext, 'fen' | 'ply' | 'childColor' | 'historySan' | 'strategy' | 'strategyCard' | 'memory' | 'facts'>): ReplanReason | null {
  const strategy = resolveTeachStrategy(ctx);
  if (!strategy) return null;
  const p = strategyProgress(strategy, ctx.historySan ?? [], ctx.childColor);
  if (p?.left && p.left.by === 'opponent' && p.left.ply === ctx.ply - 1) return 'deviation';
  const phase = (ctx.facts ?? safeFacts(ctx.fen))?.phase;
  const last = ctx.memory?.lastPhase ?? null;
  if (phase && last && phase !== last) return 'phase';
  return null;
}

/** The engine's accepted moves of the position with the code's ideas — the only moves a re-plan may choose. */
export function replanCandidates(ctx: TeachContext, max = 4): ReplanRequest['candidates'] {
  const engine = engineState(ctx.analysis);
  if (engine.mode === 'rules' || !engine.best) return [];
  const api = ideasApi(ctx);
  const facts = ctx.facts ?? safeFacts(ctx.fen);
  const opening = isOpeningTime(facts?.phase, ctx.ply);
  const bestCp = lineCp(engine.best);
  const prev = prevOf(ctx.lastBotMove);
  const lines = [...(ctx.analysis?.lines ?? [])].sort((a, b) => a.multipv - b.multipv);
  const out: ReplanRequest['candidates'] = [];
  const seen = new Set<string>();
  for (const line of [...lines, ...(opening ? (ctx.verified ?? []) : [])]) {
    const uci = line.pvUci[0];
    if (!uci || seen.has(uci)) continue;
    seen.add(uci);
    const mv = resolveUciMove(ctx.fen, uci);
    if (!mv) continue;
    const cp = lineCp(line);
    if (winOf(bestCp) - winOf(cp) >= TEACH_MAX_WIN_PCT_LOSS) continue;
    if (bestCp - cp > engine.tolerance && !(winOf(bestCp) >= 90 && winOf(cp) >= 90)) continue;
    const ideas = safeExplain(api, { fen: ctx.fen, uci, pvUci: line.pvUci, lineScore: { cp: line.mate === null ? line.cp : null, mate: line.mate }, phase: facts?.phase, prev });
    if (opening && isKidFilteredQueenMove(ctx.fen, uci, ideas)) continue;
    out.push({ uci, san: mv.san, cp: Math.max(-2000, Math.min(2000, Math.round(cp))), ideasRu: api.pickIdeas(ideas, { stage: ctx.profile.stage, max: 2 }).map((i) => i.phraseYouRu) });
    if (out.length >= max) break;
  }
  return out;
}

/** The body of POST /coach/replan for this position (null without a strategy or without engine candidates). */
export function buildReplanRequest(ctx: TeachContext, max = 4): ReplanRequest | null {
  const strategy = resolveTeachStrategy(ctx);
  if (!strategy) return null;
  const candidates = replanCandidates(ctx, max);
  if (candidates.length === 0) return null;
  return { ply: ctx.ply, fen: ctx.fen, childColor: ctx.childColor, strategyId: strategy.strategyId, movesSan: [...(ctx.historySan ?? [])], candidates, stage: ctx.profile.stage };
}

/**
 * Validates the strategist's answer against its request: the same ply, `preferredUci` one of the candidates (else
 * null), Latin-free short words (else empty). null = unusable (another ply, broken shape) — the game drops it.
 */
export function acceptReplan(answer: unknown, request: Pick<ReplanRequest, 'ply' | 'candidates'>): ReplanResponse | null {
  if (!answer || typeof answer !== 'object') return null;
  const r = answer as Partial<ReplanResponse>;
  if (r.ply !== request.ply) return null;
  const preferred = typeof r.preferredUci === 'string' && request.candidates.some((c) => c.uci === r.preferredUci) ? r.preferredUci : null;
  const words = replanWords({ ply: request.ply, planRu: typeof r.planRu === 'string' ? r.planRu : '', whyRu: typeof r.whyRu === 'string' ? r.whyRu : '', preferredUci: preferred, provider: 'template' });
  const provider: ReplanResponse['provider'] = r.provider === 'codex' || r.provider === 'openrouter' || r.provider === 'openai-api' ? r.provider : 'template';
  return { ply: request.ply, planRu: words.planRu ?? '', preferredUci: preferred, whyRu: preferred ? (words.whyRu ?? '') : '', provider };
}

/**
 * A late re-plan changed this ply's advice (planned again with `ctx.replan`) while the child has not moved yet: one
 * short follow-up line, only when it adds something — the green arrow moved to the strategist's move. null otherwise.
 */
export function buildReplanFollowUp(prev: TeachPlan, next: TeachPlan, rng: Rng = Math.random): CoachEvent | null {
  if (prev.ply !== next.ply || prev.treasure || next.treasure) return null;
  const a = next.advice[0];
  if (!a || a.planFit !== 'replan' || prev.advice[0]?.uci === a.uci) return null;
  const s = words(next.profile);
  const why = a.planWhyRu ?? whyRu(a, 'you', 1);
  const move = moveTpl(a.san, next.fen);
  const tpl = pick<Template>([(v) => `Подумал ещё — по плану сильнее ${move(v)}${why ? `: ${why}` : ''}.`, (v) => `Есть идея точнее: ${move(v)}${why ? ` — ${why}` : ''}.`], rng, 'teach.followup');
  const { brief } = fittedBrief(
    {
      moment: `${s.nom} ещё думает; у тебя появилась мысль точнее по нашему плану`,
      facts: [{ text: `новый совет: ${a.spokenRu}${why ? ` — ${a.planWhyRu ?? whyRu(a)}` : ''}`, prio: 10 }, { text: next.newPlanRu ? `новый план: ${next.newPlanRu}` : null, prio: 5 }],
      advice: adviceLineRu(next.advice, true),
      goal: ['одной короткой фразой предложи этот ход и зачем он по плану', `решает ${s.nom}`],
      forbid: [FORBID_OTHER_MOVES, FORBID_BEST_WORD, FORBID_MOVE_FOR_CHILD, FORBID_OBVIOUS, 'не больше одного предложения'].map((f) => forbidFor(f, s)),
    },
    TEACH_BRIEF_CHARS.short,
  );
  const arrows: BoardAnnotations['arrows'] = [];
  for (const x of next.advice) {
    const p = parseUci(x.uci);
    if (p) arrows.push({ from: p.from, to: p.to, color: x.arrow });
  }
  const event = makeEvent({
    kind: 'teachTurn',
    priority: 1,
    pose: 'talk',
    pauseClock: true,
    profile: next.profile,
    template: fitFirst([tpl, (v) => `По плану сильнее ${move(v)}.`], next.profile, 'short'),
    board: { arrows, highlights: [] },
    brief,
    teach: { moment: 'turn', style: 'short', ply: next.ply, advice: next.advice.map(toTeachAdvice), reveal: 'now' },
  });
  // «По новому плану —» · the move [· the explainer's reason] — the strategist's «why» is free text, never recorded
  const said = moveSentence({ head: 'teach.head.replan', san: a.san, fen: next.fen, reason: a.planWhyRu ? null : reasonOfIdea(a.ideas[0], next.fen, a.uci), prio: 100, moveNews: true });
  return withClip(event, twinUtterance({ sentences: [said], kind: 'teachTurn', pose: 'talk', moment: 'turn', caps: twinCapsFor({ teacher: true, style: 'short' }) }));
}

// ═════════════════════════ §3.1: the queen chase ═════════════════════════

export interface QueenChase {
  /** how often an opponent move attacks the queen and the child's next move is a queen move */
  count: number;
  /** the chasers as they stand after their move: «пешка на же шесть» */
  chasersRu: string[];
  /** the opponent develops a knight / bishop in that line */
  opponentDevelops: boolean;
}

/**
 * «Погоня» (§3.1): along the engine line after a queen move (`pvUci` starts with the OPPONENT's reply, `fen` = after
 * the queen move), the first `maxPlies` plies: an opponent move whose piece attacks the queen (SEE > 0 or a cheaper
 * piece) followed by a queen move of the child counts once.
 */
export function queenChase(fen: string, pvUci: readonly string[], maxPlies = 6): QueenChase {
  const out: QueenChase = { count: 0, chasersRu: [], opponentDevelops: false };
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return out;
  }
  const child: Color = chess.turn() === 'w' ? 'b' : 'w';
  let pendingChaser: string | null = null;
  for (const uci of pvUci.slice(0, maxPlies)) {
    const parts = parseUci(uci);
    if (!parts) break;
    let mv;
    try {
      mv = chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
    } catch {
      break;
    }
    const board = parsePlacement(chess.fen());
    if (mv.color !== child) {
      if ((mv.piece === 'n' || mv.piece === 'b') && MINOR_HOMES[mv.color].includes(mv.from)) out.opponentDevelops = true;
      const queenSq = board.findIndex((p) => !!p && p.type === 'q' && p.color === child);
      const to = squareIndex(mv.to);
      if (queenSq >= 0 && attacksFrom(board, to).includes(queenSq)) {
        const cheaper = VALUE_PAWNS[mv.piece] < VALUE_PAWNS.q;
        if (cheaper || seeCapture(board, to, queenSq) > 0) pendingChaser = pieceOnRu(mv.piece, mv.to);
        else pendingChaser = null;
      } else pendingChaser = null;
    } else {
      if (pendingChaser && mv.piece === 'q') {
        out.count += 1;
        out.chasersRu.push(pendingChaser);
      }
      pendingChaser = null;
    }
  }
  return out;
}

function chaseFactRu(c: QueenChase): string | null {
  if (c.count === 0 || !c.chasersRu[0]) return null;
  return `в этом варианте ${c.chasersRu[0]} нападает на ферзя, и ферзю приходится уходить${c.opponentDevelops ? ', а соперник тем временем выводит фигуры' : ''}`;
}

// ═════════════════════════ §2.5: teachReaction ═════════════════════════

export interface TeachReactionArgs {
  profile: StudentProfile;
  /** the bot's move before the child's (the recapture rule of the explainer) */
  prev?: { uci: string; fenBefore: string } | null;
  /** the treasure of that ply was missed: what it was («конь соперника на дэ четыре стоит без защиты») */
  missedTreasureRu?: string | null;
  /** the square the child's previous move went to (the same piece twice in the first ten moves, §3.1) */
  lastChildMoveTo?: Square | null;
  ideas?: MoveIdeasApi;
  /** `getConceptCard` — the early-queen rule comes from its card when given */
  conceptCard?: (id: string) => ConceptCard | undefined;
}

/**
 * The separate `teachReaction` (§2.5 «weaker», §3.1 the child's early queen): the honest consequence by the engine —
 * the opponent's reply, the material, what the advice did and the move does not — «чуть / заметно слабее» only from
 * `winPctLoss`. Priority 1, the clock stands (the bot waits for the end of the phrase). Returns null for verdicts that
 * are not said separately (followed / ownGood / fine without an early queen / takeback / tactic).
 */
/** A separate reaction brief carries at most this many facts (the verdict + one consequence; an early queen: the chase). */
export const REACTION_MAX_FACTS = 2;

export function buildTeachReaction(v: ReactionVerdict, a: TeachReactionArgs, rng: Rng = Math.random): CoachEvent | null {
  if (!v.speakNow) return null;
  const s = words(a.profile);
  const j = v.judgement;
  const loss = explainMoveLoss({ judgement: j, adviceUci: v.advice.map((x) => x.uci), prev: a.prev ?? null });
  const facts: Fact[] = [];
  const weaker = v.kind === 'weaker';
  if (weaker) facts.push({ text: `этот ход ${loss.severityRu}, чем совет`, prio: 9 });
  // a reply that only develops says less than what the advice did or what the move loses (two facts at most are said)
  const replyMvEarly = loss.reply ? resolveUciMove(j.fenAfter, loss.reply.uci) : undefined;
  const replyNews = !!loss.reply && (loss.reply.ideas.some((i) => i.group === 'A' || i.group === 'B') || !!replyMvEarly?.captured);
  for (const f of loss.factsRu) facts.push({ text: f, prio: f.startsWith('соперник может ответить') && !replyNews ? 6 : 8 });
  if (a.missedTreasureRu) facts.push({ text: `тут можно было взять подарок: ${a.missedTreasureRu}`, prio: 7 });
  let chase: QueenChase | null = null;
  if (v.earlyQueen) {
    chase = queenChase(j.fenAfter, j.refutationPvUci);
    const card = safeCard(a.conceptCard, 'opening-early-queen');
    facts.unshift({ text: 'ферзь сильный — понятно, почему им хочется ходить', prio: 9 });
    facts.push({ text: card ? firstSentences(card.explanation, 2) : RULE_FACTS.earlyQueenChild, prio: 8 });
    const cf = chaseFactRu(chase);
    // the engine's concrete chase outranks the card's general words
    if (cf) facts.push({ text: cf, prio: 9 });
  }
  const mv = resolveUciMove(j.fenBefore, j.uci);
  // «та же фигура второй раз» only when it did not HAVE to move (it was not en prise — G07 4.Фd1 ran from …e5) and the
  // advice moved another piece (the advice 4.Фxe5+ moved the queen too)
  const advisedMv = v.advice[0] ? resolveUciMove(j.fenBefore, v.advice[0].uci) : undefined;
  const hadToMove = v.ideas.some((i) => i.id === 'escape') || safeHanging(j.fenBefore).some((h) => h.square === mv?.from && h.color === j.color && h.seeLossCp >= 100);
  const adviceSamePiece = !!advisedMv && !!mv && advisedMv.from === mv.from;
  if (weaker && a.lastChildMoveTo && mv && mv.from === a.lastChildMoveTo && mv.piece !== 'p' && j.ply <= TEACH_BOOK_MAX_PLY && !hadToMove && !adviceSamePiece) {
    facts.push({ text: `та же фигура ходит второй раз подряд — ${RULE_FACTS.sameTwice}`, prio: 6 });
  }
  const adviceSpoken = v.advice.map((x) => spokenMoveRu(x.san, j.fenBefore)).filter((x) => x !== '');
  if (adviceSpoken.length > 0) facts.push({ text: `раньше ты советовал: ${adviceSpoken.join(' или ')}`, prio: 4 });
  // (nothing extra: the two most important facts — the voice model says every fact it gets; and the goal asks for what
  // those facts say — «что теперь может соперник» next to a brief that kept only what the advice did would make the
  // model invent his reply from «Можно назвать»)
  const compose = (kept: ReadonlySet<string> | null): { brief: string; kept: ReadonlySet<string> } => {
    const replyKept = kept === null || [...kept].some((f) => /^соперник может/u.test(f) || /^в итоге теряется/u.test(f));
    const nameable = [...adviceSpoken];
    if (loss.reply && replyKept) nameable.push(`${loss.reply.spokenRu} (ход соперника)`);
    if (nameable.length === 0) nameable.push('ходов ученика не называй');
    return fittedBrief(
      {
        moment: `${s.nom} ${s.g('сыграл', 'сыграла')} ${playedMoveRu(j)} — это не ход из совета; соперник ещё думает`,
        facts,
        advice: nameable,
        goal: v.earlyQueen
          ? ['одной-двумя короткими фразами: ферзём ходить хочется, но что показал вариант — по-доброму, без упрёка']
          : replyKept
            ? ['одной-двумя короткими фразами честно и по-доброму скажи, что теперь может соперник, — без упрёка: ход уже сделан']
            : ['одной-двумя короткими фразами по-доброму скажи, что делал совет, — без упрёка: ход уже сделан'],
        forbid: [FORBID_SHAME, FORBID_OTHER_MOVES, FORBID_BEST_WORD, 'не предлагай вернуть ход', FORBID_OBVIOUS, FORBID_TWO_SENTENCES].map((f) => forbidFor(f, s)),
      },
      TEACH_BRIEF_CHARS.full,
      REACTION_MAX_FACTS,
    );
  };
  const { brief } = compose(compose(null).kept);
  // a red arrow means danger: only for a reply that threatens / wins something, never for «конь на цэ шесть» (G02)
  const replyMv = loss.reply ? resolveUciMove(j.fenAfter, loss.reply.uci) : undefined;
  const replyDangerous = !!loss.reply && (loss.reply.ideas.some((i) => i.group === 'A' || i.group === 'B') || !!replyMv?.captured);
  const replyTo = loss.reply && replyDangerous ? parseUci(loss.reply.uci) : null;
  const board: BoardAnnotations = { arrows: replyTo ? [{ from: replyTo.from, to: replyTo.to, color: 'red' }] : [], highlights: [] };
  // the template names the strongest verified consequence: a real threat of the reply → material → what the advice did
  const replyIdea = loss.reply && loss.reply.ideas.length > 0 ? pickIdeas(loss.reply.ideas, { stage: a.profile.stage, max: 1 })[0] : undefined;
  const missing = loss.factsRu.find((f) => f.startsWith('этот ход не'))?.replace(/ — а совет это делал$/u, '');
  const adviceWinYou = loss.adviceWin ? `а мой совет ${loss.adviceWin.phraseRu}` : null;
  const consequence =
    replyIdea && (replyIdea.group === 'A' || replyIdea.group === 'B')
      ? `соперник теперь ${replyIdea.phraseRu}`
      : j.materialLossPawns >= 1
        ? `так теряется ${pawnsNom(j.materialLossPawns)}`
        : adviceWinYou ?? missing ?? (replyIdea ? `соперник теперь ${replyIdea.phraseRu}` : '');
  const severity = weaker ? loss.severityRu : 'чуть слабее';
  const chaseRu = chase ? chaseFactRu(chase) : null;
  const tpls: readonly Template[] = v.earlyQueen
    ? [
        say(`Ферзь сильный — понятно, почему хочется! Но рано выходить опасно: ${chaseRu ? 'соперник будет гонять его и выводить фигуры' : 'его будут гонять кони и слоны'}.`),
        say('Ферзём ходить интересно! Только соперник теперь будет на него нападать и выводить свои фигуры.'),
      ]
    : [
        say(`Так тоже можно, но ${severity}${consequence ? `: ${consequence}` : ''}.`),
        say(`Твой ход ${severity}, чем совет${consequence ? `: ${consequence}` : ''}.`),
        // (after «Смотри:» the contrast «а …» has nothing to contrast with: «Смотри: мой совет нападает …», never «Смотри: а мой совет …»)
        say(`Смотри: ${consequence.replace(/^а\s+/u, '') || `этот ход ${severity}`}. Ничего, играем дальше!`),
      ];
  const template = fitText([{ tpl: pick(tpls, rng, v.earlyQueen ? 'teach.queen' : 'teach.weaker'), prio: 100 }], a.profile, 'full');
  return makeEvent({
    kind: 'teachReaction',
    priority: 1,
    pose: 'talk',
    pauseClock: true,
    profile: a.profile,
    template,
    board,
    judgement: j,
    brief,
    teach: { moment: 'reaction', style: 'full', ply: j.ply, advice: v.advice },
  });
}

function pawnsNom(n: number): string {
  const acc = pawnsAccRu(n);
  return acc.replace(/^одну пешку$/u, 'одна пешка');
}

function safeCard(lookup: ((id: string) => ConceptCard | undefined) | undefined, id: string): ConceptCard | undefined {
  try {
    const card = lookup?.(id);
    return card && card.id === id ? card : undefined;
  } catch {
    return undefined;
  }
}

// ═════════════════════════ §7.1: «а почему не ферзём?» ═════════════════════════

export interface CompareMoveArgs {
  /** the current position, the child to move */
  fen: string;
  /** what the child asked about */
  query: { move?: string; piece?: PieceType };
  /** the compared move: the named one, or the representative of the piece (its best move by `searchmoves`); null = none */
  move: { uci: string; san: string } | null;
  /** `judgeHypothetical(fen, move.uci)` */
  judgement: MoveJudgement | null;
  /** the current advice with child-POV scores from the MultiPV cache */
  advice: readonly ScoredAdvice[];
  /** the compared move's score (child POV) when a search gave it; else derived from the judgement */
  moveScoreCp?: number | null;
  profile?: Pick<StudentProfile, 'address'>;
  phase?: PositionFacts['phase'];
  /** `getConceptCard` — the principle's words come from the card when given */
  conceptCard?: (id: string) => ConceptCard | undefined;
  /** the move text could not be used: `moveTextProblemRu(...)` */
  problemRu?: string | null;
}

const PIECE_INS: Readonly<Record<PieceType, string>> = { p: 'пешкой', n: 'конём', b: 'слоном', r: 'ладьёй', q: 'ферзём', k: 'королём' };

/**
 * Facts for «а почему не ферзём?» / «а почему не конём на цэ три?» (§7.1): how the move compares with the advice
 * (≤ 30 cp «примерно так же хорошо», 30–100 «немного слабее», 100–250 «заметно слабее», more or ≥ 2 pawns lost → what
 * is lost), the engine line in words, the queen chase, the principle of the card. Latin-free; the model may name only
 * this move, the advice and the moves of the line.
 */
export function buildCompareMoveAnswerRu(a: CompareMoveArgs): string {
  const s = studentWords(a.profile);
  const out: string[] = [];
  const pieceQ = a.query.piece;
  out.push(pieceQ ? `${capRu(s.nom)} спрашивает, почему не ходить ${PIECE_INS[pieceQ]}.` : `${capRu(s.nom)} спрашивает, почему не ${a.query.move ?? 'другой ход'}.`);
  const advice = a.advice.slice(0, 2);
  const adviceSpoken = advice.map((x) => spokenMoveRu(x.san, a.fen)).filter((x) => x !== '');
  const rulesRu = (lineMoves: readonly string[]): string => {
    const allowed = [...(a.move ? [spokenMoveRu(a.move.san, a.fen)] : []), ...adviceSpoken, ...lineMoves].filter((x) => x !== '');
    return `Как говорить: своими словами, коротко и по-доброму. Можно назвать только эти ходы: ${allowed.length > 0 ? allowed.join('; ') : 'никакие'}. Не говори «лучший ход» и никаких цифр.`;
  };
  if (!a.move) {
    if (a.problemRu) out.push(a.problemRu);
    else if (pieceQ) out.push(`Сейчас ${PIECE_INS[pieceQ]} ходить некуда.`);
    if (adviceSpoken.length > 0) out.push(`Совет учителя: ${adviceSpoken.join(' или ')}.`);
    out.push(rulesRu([]));
    return cleanRu(out);
  }
  const spoken = spokenMoveRu(a.move.san, a.fen) || 'этот ход';
  if (pieceQ) out.push(`Самый крепкий ход ${PIECE_INS[pieceQ]} сейчас — ${spoken}.`);
  const inAdvice = advice.find((x) => x.uci === a.move?.uci);
  const j = a.judgement;
  const lineMoves = j ? spokenLineRu(j.fenAfter, j.refutationPvSan, 4) : [];
  if (inAdvice) {
    out.push(`Это и есть ход из совета (${inAdvice.arrow === 'green' ? 'зелёная' : 'синяя'} стрелка) — хороший ход.`);
  } else if (advice.length === 0) {
    // the helper mode: no advice to compare with — safe or dangerous, as «а если я пойду…» says it
    if (j) {
      const dangerous = j.winPctLoss >= 10 || j.materialLossPawns >= 2 || (j.evalAfter.mate !== null && j.evalAfter.mate < 0);
      const captured = capturedAlongRu(j.fenAfter, j.refutationPvUci, 4);
      if (dangerous) out.push(`Этот ход опасный${captured.length > 0 ? `: соперник забирает ${captured.slice(0, 2).join(', а потом ')}` : ''}.`);
      else out.push(j.winPctLoss < TEACH_MAX_WIN_PCT_LOSS ? 'Ход безопасный: ничего не теряется.' : 'Ход не опасный, но есть ходы посильнее.');
    } else out.push('Точной проверки сейчас нет — скажи честно, что проверить не получилось.');
  } else if (j || (a.moveScoreCp !== undefined && a.moveScoreCp !== null)) {
    const primaryCp = advice[0]?.scoreCp;
    const moveCp = a.moveScoreCp ?? (j ? teachScoreCp(j.evalAfter) : null);
    const gap = primaryCp !== undefined && primaryCp !== null && moveCp !== null ? adviceGapOf(primaryCp - moveCp) : j ? (j.winPctLoss < 2 ? 'same' : j.winPctLoss < 5 ? 'bitWeaker' : j.winPctLoss < 10 ? 'weaker' : 'muchWeaker') : null;
    const lost = j && (gap === 'muchWeaker' || j.materialLossPawns >= 2);
    if (lost && j) {
      const mateIn = j.evalAfter.mate !== null && j.evalAfter.mate < 0 ? -j.evalAfter.mate : null;
      const captured = capturedAlongRu(j.fenAfter, j.refutationPvUci, 4);
      out.push(`Этот ход ${ADVICE_GAP_RU.muchWeaker}.`);
      if (mateIn !== null && mateIn <= 5) out.push(mateIn === 1 ? 'После него соперник сразу ставит мат.' : 'После него соперник может поставить мат.');
      else if (captured.length > 0) out.push(`После него соперник забирает ${captured.slice(0, 2).join(', а потом ')}.`);
      if (j.materialLossPawns >= 1 && mateIn === null) out.push(`${capRu(s.nom)} теряет ${pawnsAccRu(j.materialLossPawns)} материала.`);
    } else if (gap) {
      out.push(`Он ${ADVICE_GAP_RU[gap]}${adviceSpoken.length > 0 ? ` (совет: ${adviceSpoken.join(' или ')})` : ''}.`);
    }
  } else {
    out.push('Точной проверки сейчас нет — скажи честно, что проверить не получилось.');
  }
  if (lineMoves.length >= 2) out.push(`Дальше может быть так: ${lineMoves.slice(0, 4).join(', ')}.`);
  // the queen chase and the principle
  const mv = resolveUciMove(a.fen, a.move.uci);
  const opening = a.phase === 'opening' || (a.phase === undefined && safeFacts(a.fen)?.phase === 'opening');
  if (mv && j && mv.piece === 'q') {
    const cf = chaseFactRu(queenChase(j.fenAfter, j.refutationPvUci));
    if (cf) out.push(`${capRu(cf)}.`);
  }
  if (mv && opening) {
    const cardId = mv.piece === 'q' && mv.from === QUEEN_HOME[mv.color] ? 'opening-early-queen' : mv.piece === 'k' && !mv.isCastle ? 'opening-king-safety' : mv.piece === 'p' && 'abgh'.includes(mv.from[0] ?? '') ? 'opening-center' : null;
    if (cardId) {
      const card = safeCard(a.conceptCard, cardId);
      const fallback: Readonly<Record<string, string>> = {
        'opening-early-queen': RULE_FACTS.earlyQueenChild,
        'opening-king-safety': RULE_FACTS.castle,
        'opening-center': RULE_FACTS.center,
      };
      out.push(`Правило: ${card ? firstSentences(card.explanation, 2) : `${capRu(fallback[cardId] ?? '')}.`}`);
    }
  }
  out.push(rulesRu(lineMoves.slice(0, 4)));
  return cleanRu(out);
}

function cleanRu(parts: readonly string[]): string {
  const text = parts.filter((p) => p.trim() !== '').join(' ').replace(/\s+/g, ' ').replace(/\.\./g, '.').trim();
  return /[A-Za-z]/.test(text) ? text.replace(/[A-Za-z][A-Za-z0-9+#=\-]*/g, '').replace(/\s+/g, ' ').replace(/\s+([,.!?:;])/g, '$1').trim() : text;
}

