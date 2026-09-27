/**
 * @gambit/content — pedagogical content of «Гамбитик»: bot personas, the «Путь пешки» curriculum,
 * Lichess theme titles, concept cards, the opening repertoire, the mascot and the LLM prompts.
 * Pure data + tiny lookups; isomorphic (no DOM, no node: imports; chess.js is the only runtime dependency — it
 * recognises the repertoire line of a running game).
 */
export { PERSONAS, PERSONA_ORDER, listPersonas, getPersona } from './personas.ts';
export { CURRICULUM, getCurriculumStage, getNextCurriculumStage } from './curriculum.ts';
export {
  LICHESS_PUZZLE_THEMES,
  THEMES_NOT_FOR_DRILL,
  MIXED_THEME_KEY,
  THEME_TITLES_RU,
  THEME_DESCRIPTIONS_RU,
  themeTitleRu,
  themeDescriptionRu,
  isLichessPuzzleTheme,
} from './themes.ts';
export type { LichessPuzzleTheme } from './themes.ts';
export {
  CONCEPT_CARDS,
  getConceptCard,
  getConceptCardByMotif,
  getConceptCardByTheme,
  getConceptCardsForStage,
} from './conceptCards.ts';
export {
  OPENING_REPERTOIRE,
  REPERTOIRE_MIN_PLIES,
  getRepertoireAdvice,
  getRepertoireEntry,
  getRepertoireForSide,
  // «Учитель» (docs/TEACHER-MODE.md §3.3, §3.5)
  PLAN_CHILD_MOVES,
  getRepertoirePlan,
  MAIN_LINE_EXPLORER_CHECKED,
  MAIN_LINE_TABLE,
  MAIN_LINE_MOVES,
  mainLineMoves,
} from './openings.ts';
export type { OpeningRepertoireEntry, RepertoireAdvice, RepertoireAdviceOptions, RepertoireLine, RepertoirePlan } from './openings.ts';
// «Учитель»: one named strategy per game (variety + strategic logic)
export {
  STRATEGIES,
  STRATEGY_NO_REPEAT,
  STRATEGY_THEMES,
  getStrategiesFor,
  getStrategy,
  pickStrategyDeterministic,
  strategyGroupOf,
} from './strategies.ts';
export type { StrategyEntry, StrategyTheme } from './strategies.ts';
export { MASCOT } from './mascot.ts';
export type { MascotSpec, MascotSituation } from './mascot.ts';
export { COACH_SYSTEM_PROMPT_RU, REVIEW_PROMPT_RU, TEACHER_ADDENDUM_RU, buildReviewPrompt } from './prompts.ts';
export type { ReviewPromptInput } from './prompts.ts';
export { REPLAN_PROMPT_RU, STRATEGIST_PROMPT_RU, buildReplanPrompt, buildStrategistPrompt, replanJsonSchema, strategistJsonSchema } from './strategist.ts';
export type { ReplanPromptInput, StrategistPromptInput } from './strategist.ts';
// «Учитель»: the pre-written words of the lesson model — no generative AI in the child's game (docs/TEACHING.md)
export {
  AIM_IDEAS,
  IDEA_TAILS,
  MINI_TOPICS,
  QUESTION_IDEAS,
  RESULT_IDEAS,
  lessonFamilyOf,
  LESSON_GOAL_KEYS,
  LESSON_IDEA_IDS,
  LESSON_LINES,
  LESSON_POOLS,
  LESSON_STRATEGY_IDS,
  LESSON_THEME_FAMILIES,
  LESSON_WORDING_FILES,
  THEME_FAMILY_CUE,
  THEME_FOCUS,
  THEME_PRIMARY_FAMILY,
  lessonLine,
  lessonPoolSpec,
  wordingFitsStage,
} from './teaching/index.ts';
export type {
  LessonGoalKey,
  LessonIdeaId,
  LessonLine,
  LessonPoolSpec,
  LessonStage,
  LessonSubject,
  LessonThemeFamily,
  LessonWording,
  LessonWordings,
} from './teaching/index.ts';
