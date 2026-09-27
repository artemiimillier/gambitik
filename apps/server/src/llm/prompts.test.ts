import { describe, expect, it } from 'vitest';
import { loadContent } from '../content.ts';
import { defaultProfile } from '../services/profile.ts';
import { sampleGameRecord, sampleTeacherGameRecord } from '../testing/fixtures.ts';
import { buildReviewFacts } from './prompts.ts';

const content = await loadContent({ loadContentModule: () => Promise.resolve({}), loadCoreModule: () => Promise.resolve({}) });
const ctx = { motifTitleRu: content.motifTitleRu };
const profile = { ...defaultProfile(new Date('2026-09-22T10:00:00Z')), nickname: 'Миша' };

describe('review facts in teacher mode (docs/TEACHER-MODE.md §7.5)', () => {
  it('a teacher game tells the reviewer how the coach helped and how often the child played the advice', () => {
    const facts = buildReviewFacts(sampleTeacherGameRecord(), content.personas.petya, profile, ctx);
    expect(facts.game).toMatchObject({ coachHelp: '«Учитель» — сам показывал хорошие ходы стрелками и объяснял, выбирал ученик' });
    expect(facts.teacherAdvice).toEqual({ advisedMoves: 4, playedAsAdvised: 3, ownMoves: 1, ownGoodMoves: 0 });
    // Russian only in what is said about the mode
    expect(String((facts.game as Record<string, unknown>).coachHelp)).not.toMatch(/[A-Za-z]/);
  });

  it('names the strategy the teacher led the game with (Russian text only)', () => {
    const base = sampleTeacherGameRecord();
    const withStrategy = { ...base, events: [...base.events, { t: 900, type: 'coachSaid' as const, ply: 0, data: { kind: 'strategy', strategyId: 'italian', titleRu: 'Итальянская партия', provider: 'codex' } }] };
    expect((buildReviewFacts(withStrategy, content.personas.petya, profile, ctx).game as Record<string, unknown>).teacherStrategy).toBe('Итальянская партия');
    const latin = { ...base, events: [...base.events, { t: 900, type: 'coachSaid' as const, data: { kind: 'strategy', titleRu: 'Italian Game' } }] };
    expect((buildReviewFacts(latin, content.personas.petya, profile, ctx).game as Record<string, unknown>).teacherStrategy).toBeNull();
    expect((buildReviewFacts(base, content.personas.petya, profile, ctx).game as Record<string, unknown>).teacherStrategy).toBeNull();
  });

  it('older games (no coachStyle) and other styles carry no advice statistics', () => {
    const old = buildReviewFacts(sampleGameRecord(), content.personas.petya, profile, ctx);
    expect((old.game as Record<string, unknown>).coachHelp).toBeNull();
    expect(old).not.toHaveProperty('teacherAdvice');
    const exam = buildReviewFacts(sampleGameRecord({ coachStyle: 'exam', examMode: true }), content.personas.petya, profile, ctx);
    expect((exam.game as Record<string, unknown>).coachHelp).toBe('«Экзамен» — молчал до конца партии');
    expect(exam).not.toHaveProperty('teacherAdvice');
  });
});
