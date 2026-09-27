/**
 * What «Учитель» reads from the content packages (docs/TEACHER-MODE.md §3): the repertoire plan, the curated main-line
 * moves, the Russian opening names and the concept cards. `@gambit/core` does not depend on the content packages, so
 * the game passes these in through `TeachContext`. Nothing here throws: a failing lookup means «no plan / no name».
 */
import { LESSON_THEME_FAMILIES, THEME_PRIMARY_FAMILY, getConceptCard, getRepertoirePlan, mainLineMoves } from '@gambit/content';
import type { LessonThemeFamily } from '@gambit/content';
import type { RepertoirePlanLike } from '@gambit/core';
import type { Color, ConceptCard } from '@gambit/shared';
import type { TeacherContent } from './gameTypes.ts';

export function repertoirePlanOf(history: readonly string[], childColor: Color): RepertoirePlanLike | null {
  try {
    return getRepertoirePlan(history, childColor) ?? null;
  } catch {
    return null;
  }
}

export function mainLineMovesOf(fen: string): readonly string[] {
  try {
    return mainLineMoves(fen);
  } catch {
    return [];
  }
}

export function conceptCardOf(id: string): ConceptCard | undefined {
  try {
    return getConceptCard(id);
  } catch {
    return undefined;
  }
}

/** Defaults of the controller; the opening names need the lazily loaded book (gameDeps.ts preloads it). */
export const DEFAULT_TEACHER_CONTENT: TeacherContent = {
  repertoirePlan: repertoirePlanOf,
  mainLineMoves: mainLineMovesOf,
  openingNameRu: () => undefined,
  conceptCard: conceptCardOf,
};

type OpeningsModule = typeof import('@gambit/openings');

/**
 * `lookupOpening(fen)?.nameRu` for the browser: the ~460 kB book is imported in the background when the game starts;
 * until it is there no name is known (a move is then «проверен движком», never «известный»).
 */
export function createOpeningNames(load: () => Promise<OpeningsModule> = () => import('@gambit/openings')): (fen: string) => string | undefined {
  let book: OpeningsModule | null = null;
  void load().then(
    (module) => {
      book = module;
    },
    () => undefined,
  );
  return (fen) => {
    try {
      return book?.lookupOpening(fen)?.nameRu ?? undefined;
    } catch {
      return undefined;
    }
  };
}

// ───────────────────────── the lesson: the «Тема: …» badge ─────────────────────────

/**
 * The short label of a theme family on the screen for stages 1–2 (docs/TEACHING.md §2.1: the young ones hear the
 * idea of the family, not the name of the opening). A UI map only — never spoken, so it is not a content pool.
 */
export const THEME_FAMILY_BADGE_RU: Readonly<Record<LessonThemeFamily, string>> = {
  center: 'Центр',
  counterCenter: 'Удар по центру',
  development: 'Все фигуры в игру',
  castle: 'Король в домике',
  f7: 'Слабая пешка у короля',
  fortress: 'Крепость',
  gambit: 'Гамбит',
  openFile: 'Открытые линии',
  kingsideAttack: 'Атака на короля',
  queensideAttack: 'Игра на стороне ферзя',
};

function isFamily(value: string): value is LessonThemeFamily {
  return (LESSON_THEME_FAMILIES as readonly string[]).includes(value);
}

/**
 * The text after «Тема: » for a teacher game: stages 3–5 — the card's title («Итальянская партия») once the game has
 * earned the name (`named`: the lesson said it and the game is still on the card's line — §2.1, «Итальянская после
 * 1…c5 невозможна»), otherwise — and always at stages 1–2 — the family label of the card (its primary family, else the
 * first family among its themes). null = nothing to show.
 */
export function themeBadgeRu(strategy: { strategyId: string; titleRu: string } | null, stage: number, themes: readonly string[] = [], named = false): string | null {
  if (!strategy) return null;
  if (stage >= 3 && named && strategy.titleRu.trim() !== '') return strategy.titleRu.trim();
  const family = THEME_PRIMARY_FAMILY[strategy.strategyId] ?? themes.find(isFamily);
  return family ? THEME_FAMILY_BADGE_RU[family] : null;
}
