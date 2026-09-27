import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { PERSONA_IDS } from '@gambit/shared';
import { FALLBACK_CONCEPT_CARDS, fallbackCurriculum, loadContent, stageFor } from './content.ts';
import { conceptCardSchema, curriculumStageSchema } from './schemas.ts';
import { sampleGameRecord } from './testing/fixtures.ts';
import { defaultProfile } from './services/profile.ts';

const empty = { loadContentModule: () => Promise.resolve({}), loadCoreModule: () => Promise.resolve({}) };

describe('built-in fallbacks', () => {
  it('provides a complete, valid content bundle when the packages export nothing', async () => {
    const content = await loadContent(empty);
    expect(content.sources).toEqual({ content: [], core: [] });
    expect(Object.keys(content.personas).sort()).toEqual([...PERSONA_IDS].sort());
    expect(content.personaOrder).toEqual([...PERSONA_IDS]);
    expect(content.curriculum.map((s) => s.stage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const stage of content.curriculum) expect(curriculumStageSchema.safeParse(stage).success).toBe(true);
    expect(content.templateReview).toBeNull();
    expect(content.motifTitleRu('fork')).toBe('Вилка');
    expect(content.coachSystemPromptRu).toContain('Гамбитик');
    expect(content.reviewPromptRu).toContain('движк');
  });

  it('has playable examples in every fallback concept card', () => {
    for (const card of FALLBACK_CONCEPT_CARDS) {
      expect(conceptCardSchema.safeParse(card).success, card.id).toBe(true);
      for (const example of card.examples) {
        const chess = new Chess(example.fen);
        for (const san of example.solutionSan) expect(() => chess.move(san), `${card.id}: ${san}`).not.toThrow();
      }
    }
    const mate = FALLBACK_CONCEPT_CARDS.find((c) => c.id === 'mate-in-1')?.examples[0];
    const chess = new Chess(mate?.fen);
    chess.move(mate?.solutionSan[0] ?? '');
    expect(chess.isCheckmate()).toBe(true);
  });

  it('survives packages that throw on import or export garbage', async () => {
    const content = await loadContent({
      loadContentModule: () => Promise.reject(new Error('syntax error in a half-written file')),
      loadCoreModule: () => Promise.resolve({ buildTemplateReview: 'not a function', motifTitleRu: () => 42 }),
    });
    expect(content.curriculum).toHaveLength(10);
    expect(content.templateReview).toBeNull();
    expect(content.motifTitleRu('pin')).toBe('Связка');

    const partial = await loadContent({
      loadContentModule: () => Promise.resolve({ PERSONAS: { petya: { id: 'petya' } }, CURRICULUM: [{ stage: 2 }], CONCEPT_CARDS: [{ id: 'x' }], THEME_TITLES_RU: { fork: 'Двойной удар' }, PERSONA_ORDER: ['petya'] }),
      loadCoreModule: () => Promise.resolve({}),
    });
    expect(partial.personas.petya.name).toBe('Петя');
    expect(partial.curriculum[0]?.stage).toBe(1);
    expect(partial.conceptCards).toEqual(FALLBACK_CONCEPT_CARDS);
    expect(partial.themeTitlesRu.fork).toBe('Двойной удар');
    expect(partial.themeTitlesRu.pin).toBe('Связка');
    expect(partial.sources.content).toEqual(['THEME_TITLES_RU']);
  });

  it('uses the real exports when they are valid', async () => {
    const curriculum = fallbackCurriculum().slice(0, 2).map((s) => ({ ...s, title: `Настоящая ${s.stage}` }));
    const content = await loadContent({
      loadContentModule: () => Promise.resolve({ CURRICULUM: curriculum, COACH_SYSTEM_PROMPT_RU: 'боевой промпт', REVIEW_PROMPT_RU: 'боевой разбор', PERSONA_ORDER: [...PERSONA_IDS].reverse() }),
      loadCoreModule: () => Promise.resolve({ buildTemplateReview: () => '## Разбор из core', motifTitleRu: (m: string) => `core:${m}` }),
    });
    expect(content.curriculum.map((s) => s.title)).toEqual(['Настоящая 1', 'Настоящая 2']);
    expect(content.coachSystemPromptRu).toBe('боевой промпт');
    expect(content.personaOrder[0]).toBe('dima');
    expect(content.motifTitleRu('fork')).toBe('core:fork');
    expect(content.templateReview?.(sampleGameRecord(), content.personas.petya, defaultProfile())).toBe('## Разбор из core');
    expect(content.sources.core).toEqual(['buildTemplateReview', 'motifTitleRu']);
  });

  it('clamps stage lookups', () => {
    const curriculum = fallbackCurriculum();
    expect(stageFor(curriculum, 0).stage).toBe(1);
    expect(stageFor(curriculum, 99).stage).toBe(10);
    expect(stageFor(curriculum, 4).stage).toBe(4);
  });
});

describe('the real workspace packages (whatever state they are in)', () => {
  it('always yields a usable bundle', async () => {
    const content = await loadContent();
    expect(content.curriculum.length).toBeGreaterThan(0);
    expect(content.curriculum.map((s) => s.stage)).toEqual(content.curriculum.map((_, i) => i + 1));
    expect(Object.keys(content.personas)).toHaveLength(PERSONA_IDS.length);
    expect(content.coachSystemPromptRu.length).toBeGreaterThan(100);
  });
});
