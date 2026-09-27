import { describe, expect, it } from 'vitest';
import * as content from './index.ts';

describe('@gambit/content public API (ARCHITECTURE §3)', () => {
  it('exports everything other modules rely on', () => {
    expect(Object.keys(content.PERSONAS)).toHaveLength(8);
    expect(content.PERSONA_ORDER).toHaveLength(8);
    expect(content.CURRICULUM).toHaveLength(10);
    expect(content.CONCEPT_CARDS.length).toBeGreaterThanOrEqual(24);
    expect(typeof content.getConceptCard).toBe('function');
    expect(content.THEME_TITLES_RU.fork).toBe('Вилка');
    expect(content.THEME_DESCRIPTIONS_RU.fork).toBeTruthy();
    expect(typeof content.COACH_SYSTEM_PROMPT_RU).toBe('string');
    expect(typeof content.REVIEW_PROMPT_RU).toBe('string');
    expect(content.MASCOT.name).toBe('Гамбитик');
    expect(content.OPENING_REPERTOIRE).toHaveLength(3);
  });

  it('exposes the documented helper functions', () => {
    const helpers = [
      content.listPersonas,
      content.getPersona,
      content.getCurriculumStage,
      content.getNextCurriculumStage,
      content.themeTitleRu,
      content.themeDescriptionRu,
      content.isLichessPuzzleTheme,
      content.getConceptCardByMotif,
      content.getConceptCardByTheme,
      content.getConceptCardsForStage,
      content.getRepertoireEntry,
      content.getRepertoireForSide,
      content.buildReviewPrompt,
    ];
    for (const fn of helpers) expect(typeof fn).toBe('function');
  });

  it('exports the strategy library and the strategist prompts (teacher mode)', () => {
    expect(content.STRATEGIES.length).toBeGreaterThanOrEqual(12);
    for (const fn of [content.getStrategy, content.getStrategiesFor, content.pickStrategyDeterministic, content.strategyGroupOf, content.buildStrategistPrompt, content.buildReplanPrompt, content.strategistJsonSchema, content.replanJsonSchema]) {
      expect(typeof fn).toBe('function');
    }
    expect(typeof content.TEACHER_ADDENDUM_RU).toBe('string');
    expect(JSON.parse(JSON.stringify(content.STRATEGIES))).toEqual(content.STRATEGIES);
  });

  it('the data is JSON-serialisable (it travels through GET /api/curriculum and /api/kb/:id)', () => {
    for (const value of [content.PERSONAS, content.CURRICULUM, content.CONCEPT_CARDS, content.OPENING_REPERTOIRE, content.MASCOT]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });
});
