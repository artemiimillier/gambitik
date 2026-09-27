/**
 * «Учитель» — the lesson engine (docs/TEACHING.md §4.3): no generative AI in the child's game. The director is
 * the one entry point for the game and the 50-game report; the rest is exported for tests and tools.
 */
import './engine.ts'; // installs the director implementation
export * from './types.ts';
export { lessonEvent, lessonGender, lessonStage } from './event.ts';
export type { LessonEventSpec } from './event.ts';
export {
  RECENT_PER_POOL,
  LEARNER_GAMES,
  MINI_GUARD,
  THEME_GUARD,
  VOICE_NEUTRAL_POOL,
  createLessonBook,
  emptyLessonHistory,
  lessonUnitKey,
  restoreLessonGame,
  restoreLessonHistory,
} from './book.ts';
export type { LessonBook, LessonBookInit, LessonGameState, LessonHistory, LessonVoicePolicy, PickArgs, Picked } from './book.ts';
export { joinSentence, renderUtterance } from './render.ts';
export { isOptionPool, pieceLabel, quizOptionLabel, quizOptionsText } from './quizWords.ts';
export type { Rendered, SentenceSpec } from './render.ts';
export { resolveCue, resolveCues } from './cues.ts';
export type { CueFacts } from './cues.ts';
export { DRAWABLE_CUES, cueDrawable, cuesToBoard } from './board.ts';
export { initialLessonMemory, restoreLessonMemory, restoreTeachMemory } from './memory.ts';
export {
  LESSON_LENGTH_CAPS,
  STAGE_TERMS,
  claimsBest,
  expandLessonWording,
  isDeictic,
  lintLessonLine,
  lintLessonLines,
  lintLessonText,
  subjectPieces,
} from './lint.ts';
export type { LessonLintIssue, LessonLintRule } from './lint.ts';
export {
  installLessonDirector,
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
  quizOf,
} from './director.ts';
export type { LessonDirectorImpl, LessonEndArgs, LessonEndResult, LessonHintsStop, LessonReactionArgs, LessonReactionResult, LessonStartArgs, LessonTakebackArgs } from './director.ts';
export { lessonHintsLive } from './turn.ts';
