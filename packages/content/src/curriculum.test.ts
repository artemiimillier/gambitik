import { describe, expect, it } from 'vitest';
import { PERSONA_IDS } from '@gambit/shared';
import { CURRICULUM, getCurriculumStage, getNextCurriculumStage } from './curriculum.ts';
import { PERSONAS, PERSONA_ORDER } from './personas.ts';
import { PLACEHOLDER_RE } from './testUtils.ts';
import {
  LICHESS_PUZZLE_THEMES,
  MIXED_THEME_KEY,
  THEMES_NOT_FOR_DRILL,
  THEME_DESCRIPTIONS_RU,
  THEME_TITLES_RU,
  isLichessPuzzleTheme,
  themeDescriptionRu,
  themeTitleRu,
} from './themes.ts';

describe('CURRICULUM', () => {
  it('has 10 stages numbered 1..10 without gaps', () => {
    expect(CURRICULUM).toHaveLength(10);
    expect(CURRICULUM.map((s) => s.stage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('has unique, non-empty Russian texts without placeholders', () => {
    expect(new Set(CURRICULUM.map((s) => s.title)).size).toBe(10);
    for (const s of CURRICULUM) {
      for (const text of [s.title, s.ratingBand, s.goal, s.openingFocus, s.mastery.description, ...s.skills, ...s.endgames]) {
        expect(text.trim().length, `stage ${s.stage}`).toBeGreaterThan(0);
        expect(text, `stage ${s.stage}: ${text}`).not.toMatch(PLACEHOLDER_RE);
        expect(text, `stage ${s.stage}: ${text}`).toMatch(/[А-Яа-яЁё0-9]/);
      }
      expect(s.skills.length, `stage ${s.stage} skills`).toBeGreaterThanOrEqual(3);
      expect(s.title.length).toBeLessThanOrEqual(50);
    }
  });

  it('rating bands are contiguous and ascending', () => {
    const bounds = CURRICULUM.map((s) => s.ratingBand.match(/^(\d+)(?:–(\d+)|\+)$/));
    for (const m of bounds) expect(m).not.toBeNull();
    for (let i = 1; i < bounds.length; i += 1) {
      const prevUpper = bounds[i - 1]?.[2];
      const lower = bounds[i]?.[1];
      expect(lower, `stage ${i + 1} must start where stage ${i} ends`).toBe(prevUpper);
    }
    expect(CURRICULUM[9]?.ratingBand.endsWith('+')).toBe(true);
  });

  it('uses only VALID Lichess puzzle theme keys, each with a Russian title and description', () => {
    for (const s of CURRICULUM) {
      expect(s.puzzleThemes.length, `stage ${s.stage}`).toBeGreaterThanOrEqual(2);
      expect(new Set(s.puzzleThemes).size).toBe(s.puzzleThemes.length);
      for (const theme of s.puzzleThemes) {
        expect(isLichessPuzzleTheme(theme), `stage ${s.stage}: '${theme}' is not a tag of the Lichess CSV`).toBe(true);
        expect(THEMES_NOT_FOR_DRILL, `stage ${s.stage}: '${theme}' must not be drilled`).not.toContain(theme);
        expect(THEME_TITLES_RU[theme], `no Russian title for '${theme}'`).toBeTruthy();
        expect(THEME_DESCRIPTIONS_RU[theme], `no Russian description for '${theme}'`).toBeTruthy();
      }
    }
  });

  it('follows the verified research: stage 1 drills hanging pieces, mates come with stage 1–2, no mix/oneMove/castling/opening', () => {
    expect(CURRICULUM[0]?.puzzleThemes).toContain('hangingPiece');
    expect(CURRICULUM[1]?.puzzleThemes).toEqual(expect.arrayContaining(['mateIn1', 'backRankMate']));
    expect(CURRICULUM[2]?.puzzleThemes).toEqual(expect.arrayContaining(['fork', 'pin', 'skewer', 'mateIn2']));
    const all = CURRICULUM.flatMap((s) => s.puzzleThemes);
    for (const banned of ['mix', 'oneMove', 'castling', 'opening', 'playerGames']) expect(all).not.toContain(banned);
  });

  it('mastery is measurable and gets stricter', () => {
    const withRating = CURRICULUM.filter((s) => s.mastery.minPuzzleRating !== undefined);
    expect(withRating.length).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < withRating.length; i += 1) {
      expect(withRating[i]?.mastery.minPuzzleRating).toBeGreaterThan(withRating[i - 1]?.mastery.minPuzzleRating ?? 0);
    }
    const accuracies = CURRICULUM.map((s) => s.mastery.minAccuracy).filter((a): a is number => a !== undefined);
    expect(accuracies).toEqual([...accuracies].sort((a, b) => a - b));
    for (const a of accuracies) {
      expect(a).toBeGreaterThanOrEqual(50);
      expect(a).toBeLessThanOrEqual(95);
    }
    for (const s of CURRICULUM.slice(0, 9)) {
      expect(s.mastery.maxBlundersPerGame, `stage ${s.stage}`).toBeDefined();
      expect(s.mastery.maxBlundersPerGame).toBeGreaterThanOrEqual(0);
    }
  });

  it('recommends existing personas that fit the stage, and every persona is recommended somewhere', () => {
    const used = new Set<string>();
    for (const s of CURRICULUM) {
      expect(s.recommendedPersonas.length, `stage ${s.stage}`).toBeGreaterThanOrEqual(1);
      for (const id of s.recommendedPersonas) {
        expect(PERSONA_IDS).toContain(id);
        expect(PERSONAS[id].recommendedFromStage, `${id} is recommended too early (stage ${s.stage})`).toBeLessThanOrEqual(s.stage);
        used.add(id);
      }
      // listed weakest → strongest
      const order = s.recommendedPersonas.map((id) => PERSONA_ORDER.indexOf(id));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
    expect([...used].sort()).toEqual([...PERSONA_IDS].sort());
    // a persona's first recommendation is exactly its recommendedFromStage
    for (const id of PERSONA_IDS) {
      const first = CURRICULUM.find((s) => s.recommendedPersonas.includes(id));
      expect(first?.stage, id).toBe(PERSONAS[id].recommendedFromStage);
    }
  });

  it('endgames are taught from stage 2 on, in the researched order', () => {
    expect(CURRICULUM[0]?.endgames).toEqual([]);
    expect(CURRICULUM[1]?.endgames[0]).toMatch(/лесенка/);
    expect(CURRICULUM[1]?.endgames[1]).toMatch(/коробочка/);
    expect(CURRICULUM[2]?.endgames[0]).toMatch(/квадрата/);
    expect(CURRICULUM[5]?.endgames.join(' ')).toMatch(/Лусены/);
    expect(CURRICULUM[5]?.endgames.join(' ')).toMatch(/Филидора/);
    for (const s of CURRICULUM.slice(1)) expect(s.endgames.length, `stage ${s.stage}`).toBeGreaterThanOrEqual(1);
  });

  it('getCurriculumStage clamps, getNextCurriculumStage ends with null', () => {
    expect(getCurriculumStage(1).stage).toBe(1);
    expect(getCurriculumStage(7).stage).toBe(7);
    expect(getCurriculumStage(0).stage).toBe(1);
    expect(getCurriculumStage(-5).stage).toBe(1);
    expect(getCurriculumStage(99).stage).toBe(10);
    expect(getCurriculumStage(3.9).stage).toBe(3);
    expect(getCurriculumStage(Number.NaN).stage).toBe(1);
    expect(getNextCurriculumStage(1)?.stage).toBe(2);
    expect(getNextCurriculumStage(9)?.stage).toBe(10);
    expect(getNextCurriculumStage(10)).toBeNull();
  });
});

describe('themes', () => {
  it('lists the 73 distinct tags of the Lichess puzzle CSV', () => {
    expect(LICHESS_PUZZLE_THEMES).toHaveLength(73);
    expect(new Set(LICHESS_PUZZLE_THEMES).size).toBe(73);
    expect(isLichessPuzzleTheme('fork')).toBe(true);
    expect(isLichessPuzzleTheme('enPassant')).toBe(true);
    expect(isLichessPuzzleTheme(MIXED_THEME_KEY)).toBe(false);
    expect(isLichessPuzzleTheme('playerGames')).toBe(false);
    expect(isLichessPuzzleTheme('toString')).toBe(false);
  });

  it('has a Russian title and an own description for every tag (+ the app pseudo theme)', () => {
    const expectedKeys = [...LICHESS_PUZZLE_THEMES, MIXED_THEME_KEY].sort();
    expect(Object.keys(THEME_TITLES_RU).sort()).toEqual(expectedKeys);
    expect(Object.keys(THEME_DESCRIPTIONS_RU).sort()).toEqual(expectedKeys);
    for (const key of expectedKeys) {
      const title = THEME_TITLES_RU[key] ?? '';
      const description = THEME_DESCRIPTIONS_RU[key] ?? '';
      expect(title, key).toMatch(/^[А-ЯЁ]/);
      expect(title, key).not.toMatch(/[A-Za-z]/);
      expect(title.length, key).toBeLessThanOrEqual(40);
      expect(description, key).toMatch(/^[А-ЯЁ]/);
      expect(description, key).toMatch(/[.!?]$/);
      expect(description, key).not.toMatch(/[A-Za-z]/);
      expect(description, key).not.toMatch(/сантипеш/i); // adult engine jargon has no place here
      expect(description.length, key).toBeLessThanOrEqual(160);
      expect(description, key).not.toMatch(PLACEHOLDER_RE);
    }
  });

  it('uses the agreed kid-friendly titles for the common themes', () => {
    expect(THEME_TITLES_RU.fork).toBe('Вилка');
    expect(THEME_TITLES_RU.pin).toBe('Связка');
    expect(THEME_TITLES_RU.skewer).toBe('Сквозной удар');
    expect(THEME_TITLES_RU.discoveredAttack).toBe('Вскрытое нападение');
    expect(THEME_TITLES_RU.doubleCheck).toBe('Двойной шах');
    expect(THEME_TITLES_RU.hangingPiece).toBe('Незащищённая фигура');
    expect(THEME_TITLES_RU.mateIn1).toBe('Мат в 1 ход');
    expect(THEME_TITLES_RU.smotheredMate).toBe('Спёртый мат');
  });

  it('titles are unique so the progress table is unambiguous', () => {
    const titles = Object.values(THEME_TITLES_RU);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('helpers fall back safely', () => {
    expect(themeTitleRu('fork')).toBe('Вилка');
    expect(themeTitleRu('someFutureTheme')).toBe('someFutureTheme');
    expect(themeTitleRu('constructor')).toBe('constructor');
    expect(themeDescriptionRu('pin')).toMatch(/приклеенная/);
    expect(themeDescriptionRu('someFutureTheme')).toBeUndefined();
    expect(themeDescriptionRu('constructor')).toBeUndefined();
  });
});
