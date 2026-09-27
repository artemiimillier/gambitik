/**
 * @gambit/core — coach language & policy (docs/ARCHITECTURE.md §3 "src/coach", §5).
 * Pure, isomorphic, LLM-free: Russian chess speech, the take-back policy, CoachEvent builders
 * and the template post-game review.
 */
export {
  parseSan,
  pieceGenderRu,
  pieceNameRu,
  sanLineToBubbleRu,
  sanToBubbleRu,
  sanToSpokenRu,
  squareToSpokenRu,
} from './spoken.ts';
export type { GrammaticalCase, ParsedSan } from './spoken.ts';

export {
  isMateMotif,
  motifExplanationRu,
  motifPracticeLineRu,
  motifTitleInlineRu,
  motifTitleRu,
  motifToPuzzleTheme,
  pickPracticeMotif,
} from './motifs.ts';

export {
  EXPLAINABLE_MATE_WITHIN,
  EXPLAINABLE_MATERIAL_PAWNS,
  MIN_PLIES_BETWEEN_OFFERS,
  MIN_REMAINING_MS,
  MIN_WIN_PCT_BEFORE,
  REVIEW_MIN_WIN_PCT_LOSS,
  TAKEBACK_BUDGET,
  TEACHER_DEFAULT_MAX_STAGE,
  coachStylesFor,
  decideIntervention,
  defaultCoachStyle,
  isExplainable,
  isWorthReviewing,
  takebackThresholdForStage,
} from './policy.ts';
export type { InterventionReason } from './policy.ts';

export {
  MAX_IN_GAME_WORDS,
  ROUTINE_TWO_QUESTIONS_MAX_STAGE,
  THREAT_WARNING_MIN_SEE_CP,
  THREAT_WARNING_NAMED_MAX_STAGE,
  TAKEBACK_DECLINE_REASONS,
  buildDeclineReasonReply,
  buildExplainBest,
  buildGameEnd,
  buildGameHello,
  buildGameResumed,
  buildGameStart,
  buildGreeting,
  buildHint,
  buildOpeningIdea,
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
  declineReasonLabelRu,
  isRealTacticMotif,
} from './events.ts';
export type { ChildOutcome, TakebackDeclineReason } from './events.ts';

export {
  FORBID_BEST_MOVE,
  FORBID_BEST_WORD,
  FORBID_MOVE_FOR_CHILD,
  FORBID_OBVIOUS,
  FORBID_OTHER_MOVES,
  FORBID_POPULARITY,
  FORBID_SHAME,
  FORBID_TWO_SENTENCES,
  FORBID_WHOLE_PLAN,
  MAX_BRIEF_CHARS,
  MAX_TEACH_BRIEF_CHARS,
  composeBrief,
  forbidFor,
  materialBalanceRu,
  spokenLineRu,
  spokenMoveRu,
  stripLatinRu,
  studentWords,
  winChanceChangeRu,
  winChanceWordsRu,
} from './brief.ts';
export type { BriefParts, StudentWords } from './brief.ts';

export { THREAT_MATE_WITHIN, THREAT_MIN_MATERIAL_PAWNS, mateInOneThreat, nullMoveFen, threatFactsRu, threatFromNullMoveLine } from './threats.ts';

export { ADVICE_GAP_RU, LOW_CLOCK_MS, adviceGapOf, buildMoveCheckAnswerRu, buildPositionAnswerRu, moveTextProblemRu, parseMoveText, teachScoreCp } from './answers.ts';
export type { AdviceGap, MoveCheckArgs, MoveTextResult, PositionAnswerArgs, ScoredAdvice } from './answers.ts';

// ── teacher mode (docs/TEACHER-MODE.md) ──
export {
  IDEA_GROUP,
  IDEA_PRIORITY,
  MAX_IDEA_PAIR_WORDS,
  MAX_IDEA_WORDS,
  STATIC_IDEA_IDS,
  explainMove,
  explainMoveLoss,
  explainOpponentMove,
  ideaWordCount,
  isEarlyQueenMove,
  isKidFilteredQueenMove,
  joinIdeasRu,
  pickIdeas,
} from './moveIdeas.ts';
export type { ExplainMoveArgs, MoveIdea, MoveIdeaGroup, MoveIdeaId, MoveLoss, MoveLossArgs } from './moveIdeas.ts';

export {
  CALM_SHORT_P,
  CHOICE_EVERY_TURNS,
  CONCEPTS_PER_GAME,
  CONCEPT_EVERY_PLIES,
  OPPONENT_MENTION_WORDS,
  STRATEGY_LATER_BONUS,
  STRATEGY_LINE_BONUS,
  STRATEGY_MIDDLEGAME_BONUS,
  STRATEGY_TOLERANCE_CP,
  TEACH_MAX_WORDS,
  acceptReplan,
  buildReplanFollowUp,
  buildReplanRequest,
  replanCandidates,
  replanReason,
  resolveTeachStrategy,
  IDEA_TO_CONCEPT,
  ONLY_MOVE_WIN_PCT_GAP,
  OPENING_NAMES_PER_GAME,
  PLAN_EVERY_PLIES,
  PLAN_EVERY_PLIES_CHATTY,
  TEACH_BOOK_MAX_PLY,
  TEACH_BRIEF_CHARS,
  TEACH_FALLBACK_DEPTH,
  TEACH_MAX_VERIFY,
  TEACH_MAX_WIN_PCT_LOSS,
  TEACH_MIN_DEPTH,
  TEACH_PARTIAL_TOLERANCE_CP,
  TEACH_TEXT_SENTENCES,
  TEACH_TEXT_WORDS,
  TEACH_TOLERANCE_CP,
  PRINCIPLE_BONUS,
  RESCUE_BONUS,
  TEACH_NOISE_CP,
  TEACH_NOISE_DEPTH,
  TEACH_VERIFY_MOVETIME_MS,
  TREASURE_MAX_STAGE,
  bookMovesToVerify,
  buildCompareMoveAnswerRu,
  buildTeachReaction,
  buildTeachRepeat,
  buildTeachReveal,
  buildTeachTurn,
  buildTeachWhy,
  initialTeachMemory,
  middlegamePlan,
  openingPlanFacts,
  pickAdvice,
  planTeachTurn,
  queenChase,
  reactionVerdict,
  teachModeOf,
  teachTurnClip,
  treasureRevealMs,
} from './teacher.ts';
export type {
  AdviceCandidate,
  CompareMoveArgs,
  MoveIdeasApi,
  OpeningPlanArgs,
  OpeningPlanFacts,
  PlanHint,
  QueenChase,
  ReactionArgs,
  ReactionKind,
  ReactionVerdict,
  ReplanReason,
  RepertoirePlanLike,
  StrategyCardLike,
  TeachContext,
  TeachDanger,
  TeachMemory,
  TeachMode,
  TeachOpener,
  TeachPlan,
  TeachReactionArgs,
  TeachShape,
  TeachStyle,
  TeachTreasure,
} from './teacher.ts';

// the game strategy of «Учитель»: the intro, «по нашему плану», deviations, the strategist's re-plans
export {
  CLOCK_WORDS_RE,
  HURRY_MS,
  THEME_IDEAS,
  cleanStrategistRu,
  freshReplan,
  introFromStrategist,
  moveInsRu,
  PLAN_GOAL_MAX_WORDS,
  planFitOf,
  planGoalDone,
  planGoalFits,
  planGoalFor,
  planGoalRu,
  replanWords,
  strategyIntroRu,
  strategyNextSan,
  strategyProgress,
  strategyTitleAcc,
  titleAccRu,
} from './strategy.ts';
export type { PlanFit, ReplanCandidate, StrategyProgress, TeachStrategy } from './strategy.ts';

export { endangeredSquares } from './board.ts';

export { REVIEW_MAX_KEY_MOMENTS, buildTemplateReview, moveClassLabelRu, moveNumberLabel, suggestPuzzleTheme, timesRu } from './review.ts';

export type { Rng } from './phrase.ts';

// «Записи» — the pre-recorded clip voice (docs/voice-clips/SPEC.md §3): keys, catalogue, lint, compiler, planner
export * from './clips/index.ts';

// «Учитель» — the lesson engine without generative AI (docs/TEACHING.md)
export * from './lesson/index.ts';
