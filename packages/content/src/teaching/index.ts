/**
 * «Учитель» — the pre-written words of the lesson model (docs/TEACHING.md). No generative AI in the child's
 * game: the lesson engine of @gambit/core picks one of these wordings for every sentence it says.
 */
import type { CueKind } from '@gambit/shared';
import { WORDINGS as ADVICE } from './lines/advice.ru.ts';
import { WORDINGS as ENDINGS } from './lines/endings.ru.ts';
import { WORDINGS as GOALS } from './lines/goals.ru.ts';
import { WORDINGS as MOMENTS } from './lines/moments.ru.ts';
import { WORDINGS as IDEAS_PLAY } from './lines/ideasPlay.ru.ts';
import { WORDINGS as IDEAS_TACTICS } from './lines/ideasTactics.ru.ts';
import { WORDINGS as LESSONS } from './lines/lessons.ru.ts';
import { WORDINGS as MISTAKES } from './lines/mistakes.ru.ts';
import { WORDINGS as OPPONENT } from './lines/opponent.ru.ts';
import { WORDINGS as PLAN } from './lines/plan.ru.ts';
import { WORDINGS as PRAISE } from './lines/praise.ru.ts';
import { WORDINGS as QUIZ } from './lines/quiz.ru.ts';
import { WORDINGS as THEME } from './lines/theme.ru.ts';
import { LESSON_POOLS } from './spec.ts';
import type { LessonIdeaId, LessonThemeFamily } from './spec.ts';
import type { LessonLine, LessonStage, LessonWording, LessonWordings } from './types.ts';

export type { LessonLine, LessonPoolSpec, LessonStage, LessonSubject, LessonWording, LessonWordings } from './types.ts';
export {
  LESSON_GOAL_KEYS,
  LESSON_IDEA_IDS,
  LESSON_POOLS,
  LESSON_STRATEGY_IDS,
  LESSON_THEME_FAMILIES,
  AIM_IDEAS,
  IDEA_TAILS,
  MINI_TOPICS,
  QUESTION_IDEAS,
  RESULT_IDEAS,
  lessonFamilyOf,
  lessonPoolSpec,
} from './spec.ts';
export type { LessonGoalKey, LessonIdeaId, LessonThemeFamily } from './spec.ts';

/** Every family file, in a fixed order (a pool id must live in exactly one — teaching.test.ts). */
export const LESSON_WORDING_FILES: Readonly<Record<string, LessonWordings>> = {
  advice: ADVICE,
  moments: MOMENTS,
  ideasTactics: IDEAS_TACTICS,
  ideasPlay: IDEAS_PLAY,
  theme: THEME,
  plan: PLAN,
  goals: GOALS,
  opponent: OPPONENT,
  praise: PRAISE,
  mistakes: MISTAKES,
  quiz: QUIZ,
  lessons: LESSONS,
  endings: ENDINGS,
};

function wordingsOf(id: string): readonly LessonWording[] {
  for (const file of Object.values(LESSON_WORDING_FILES)) {
    const w = file[id];
    if (w) return w;
  }
  return [];
}

/** The pools with their wordings (a pool without wordings is still listed — the gate test reports it). */
export const LESSON_LINES: readonly LessonLine[] = LESSON_POOLS.map((spec) => ({ ...spec, wordings: wordingsOf(spec.id) }));

const LINE_BY_ID = new Map(LESSON_LINES.map((l) => [l.id, l] as const));

export function lessonLine(id: string): LessonLine | undefined {
  return LINE_BY_ID.get(id);
}

/** Is a wording meant for this stage (its own range, else its pool's range)? */
export function wordingFitsStage(line: Pick<LessonLine, 'stages'>, w: LessonWording, stage: number): boolean {
  const [lo, hi] = w.stages ?? line.stages ?? [1, 5];
  const s = Math.min(5, Math.max(1, Math.round(stage))) as LessonStage;
  return s >= lo && s <= hi;
}

/**
 * The theme family a strategy card is announced and summed up by (docs/TEACHING.md §2.1). One per card: the most
 * characteristic of its `themes`.
 */
export const THEME_PRIMARY_FAMILY: Readonly<Record<string, LessonThemeFamily>> = {
  italian: 'f7',
  'four-knights': 'development',
  london: 'fortress',
  'bishops-opening': 'f7',
  colle: 'fortress',
  scotch: 'center',
  vienna: 'center',
  spanish: 'center',
  'queens-gambit': 'gambit',
  'open-game': 'development',
  'two-knights': 'development',
  french: 'counterCenter',
  scandinavian: 'counterCenter',
  sicilian: 'counterCenter',
  'caro-kann': 'fortress',
  orthodox: 'fortress',
  slav: 'fortress',
  'dutch-stonewall': 'kingsideAttack',
  'kings-indian': 'kingsideAttack',
  'classic-development': 'development',
  'kings-indian-setup': 'castle',
  'queens-indian-setup': 'center',
  'botvinnik-system': 'center',
  'reversed-sicilian': 'center',
};

/** The move ideas that serve a theme family («идеи по теме», docs/TEACHING.md §6.3). */
export const THEME_FOCUS: Readonly<Record<LessonThemeFamily, readonly LessonIdeaId[]>> = {
  center: ['centerPawn', 'fightCenter', 'supportCenter', 'centerControl'],
  counterCenter: ['fightCenter', 'centerPawn', 'trade'],
  development: ['develop', 'prepareCastle', 'connectRooks', 'centerControl'],
  castle: ['castle', 'prepareCastle'],
  f7: ['aimWeakSquare', 'develop', 'threatMate'],
  fortress: ['supportCenter', 'defend', 'centerPawn'],
  gambit: ['fightCenter', 'openLine', 'develop'],
  openFile: ['rookOpenFile', 'rookSeventh', 'connectRooks', 'openLine'],
  kingsideAttack: ['threatMate', 'aimWeakSquare', 'attack', 'check'],
  queensideAttack: ['space', 'attack', 'rookOpenFile'],
};

/** What the board highlights for a theme family (the announcement, the reminder, the takeaway). */
export const THEME_FAMILY_CUE: Readonly<Record<LessonThemeFamily, readonly CueKind[]>> = {
  center: ['center'],
  counterCenter: ['center'],
  development: [],
  castle: ['king'],
  f7: ['weak'],
  fortress: ['center'],
  gambit: ['center'],
  openFile: [],
  kingsideAttack: ['flank'],
  queensideAttack: ['flank'],
};
