/**
 * «Записи» — the pre-recorded clip voice (docs/voice-clips/SPEC.md §3): keys and ids, the catalogue (interface, the
 * Russian lines, lint), the builders' clip twins, the text compiler (bridge) and the planner. Pure and isomorphic: the browser layer (apps/web/src/coach/clips) and
 * the tools (tools/voice-clips) share every function here.
 */
export {
  CLIP_ID_RE,
  CLIP_PIECES,
  CLIP_VOICE_KEY,
  SPOKEN_FILES,
  SPOKEN_RANKS,
  allMoveSlotKeys,
  allSplitSlotKeys,
  buildClipIndex,
  canonicalSlotText,
  clipFile,
  clipId,
  cyrb53,
  fragEndOf,
  fragKey,
  fragUnitKey,
  hash13,
  isSquare,
  lessonQuizKey,
  lineUnitKey,
  mergeClipIndexes,
  moveTailsOf,
  normUnitText,
  normalizeFragment,
  normalizeSan,
  parseSlotKey,
  poolKeyOf,
  slotFormOf,
  slotKeyOf,
  slotUnitKey,
  splitOf,
  squareFromSpoken,
  takesForUnit,
  unitTextKey,
  verifyMove,
} from './keys.ts';
export type { ClipIndexEntry, ClipIndexLayer, VerifiedMove } from './keys.ts';

// «Дозапись голоса»: lesson playback by exact keys and the TTS text / pack recipe of a recording
export { LESSON_GAPS_MS, expectedPartText, expectedQuizText, expectedSentenceText, lessonSentencesOf, planLessonClips, requestSentenceOf } from './lessonPlan.ts';
export type { LessonClipPlan, LessonPlanContext, LessonPlanEvent, LessonQuizIds } from './lessonPlan.ts';
export { PACK_MAX_CHARS, PACK_MAX_PARTS, PACK_SPLIT, PACK_TAG, packProblem, packPrompt, ttsPartText } from './tts.ts';
export type { PackProblem, TtsPartRole } from './tts.ts';

export { DEFAULT_LINE_PIECES, catalogFallbacks, catalogUnits, expandWording, linePieces, usesGender, usesPiece } from './catalog.ts';
export type { CatalogUnit } from './catalog.ts';

// «Дозапись голоса» for the builders' events: a whole catalogue sentence as request ids, one key lookup for both namespaces
export {
  LESSON_POOL_PREFIX,
  cheapestLineWording,
  isExcludedLine,
  isLessonPoolId,
  lineKeyPlaceholderWords,
  lineKeyText,
  lineKeyTwins,
  lineRequestOf,
  lineUnitKeyOf,
  lineWordingOf,
  lineWordingText,
  parseLineUnitKey,
  placeholderWordsOf,
  recordableLineWordings,
  resolveClipGenLine,
  spokenLineOf,
  takesForLine,
  twinWholeWordings,
  twinWordingsOf,
} from './lines.ts';
export type { LineRequestProblem, LineResolution, SpokenLine } from './lines.ts';

// the Russian catalogue (the lines the tools record) and the builders' clip twins
export { CLIP_CATALOG, CLIP_TAP_LINES, PLAN_GOAL_LINES, clipCatalogLine, hasClipLine, planGoalLineOf, strategyLineOf } from './catalog.ru.ts';
export {
  HEAD_SLOT_FORM,
  TWIN_MATE_TAIL_WEIGHT,
  TWIN_OTHER_MAX_WORDS,
  TWIN_PROMO_TAIL_WEIGHT,
  TWIN_TAIL_WEIGHT,
  fitTwin,
  genderOf,
  goalItemOf,
  ideaPieceOf,
  itemWords,
  lineItem,
  moveSentence,
  moveTailItem,
  reasonOfIdea,
  slotItem,
  strategyIntroSentences,
  twinCapsFor,
  twinUtterance,
  wholeSentence,
  withClip,
} from './twins.ts';
export type { TwinCaps, TwinSentence } from './twins.ts';

export { CLIP_LENGTH_CAPS, hasFeminineSelfReference, hasSpokenSquare, lintCatalog, lintLine, lintText } from './lint.ts';
export type { ClipLintIssue, ClipLintRole, ClipLintRule } from './lint.ts';

export { clipInputOf, compileSentence, compileText, genericLineOf, slotGuardOf, splitSentences, stripName } from './compile.ts';
export type { CompileOptions } from './compile.ts';

export {
  CLIP_BARK_P,
  CLIP_BLITZ_GAP_FACTOR,
  CLIP_CAPS,
  CLIP_GAPS_MS,
  CLIP_GAP_JITTER_MS,
  CLIP_MAX_CLIPS_PER_SENTENCE,
  CLIP_MAX_SENTENCES,
  CLIP_RECENCY_CAPACITY,
  CLIP_RECENCY_WINDOW,
  CLIP_RECENCY_WINDOW_LONG,
  CLIP_SHORT_MAX_WORDS,
  CLIP_TEACH_MAX_WORDS,
  clipCapsFor,
  clipSentenceShape,
  createClipRecency,
  defaultRecencyWindow,
  planClips,
  validateClipUtterance,
} from './plan.ts';
export type { ClipSentenceShape } from './plan.ts';

export type {
  ClipCaps,
  ClipIndex,
  ClipInput,
  ClipLevel,
  ClipManifest,
  ClipMiss,
  ClipPlan,
  ClipRecency,
  ClipRecencyView,
  ClipUnitMeta,
  CompiledSentence,
  CompiledText,
  CompiledUnit,
  FragEnd,
  LineId,
  MergedClipIndex,
  MoveSlotKey,
  ParsedSlotKey,
  PlanContext,
  PlannedClip,
  PlannedRole,
  PlannedSentence,
  SlotForm,
  SlotKey,
  SplitSlotKey,
} from './types.ts';
