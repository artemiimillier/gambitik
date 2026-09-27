/**
 * The gate of the pre-written words of «Учитель» (docs/TEACHING.md §4.2, §7): every pool of
 * `@gambit/content` LESSON_POOLS has enough wordings at every stage, and no wording names a square, speaks of
 * Гамбитик as a girl, praises with «молодец» or breaks the sentence seams.
 */
import { describe, expect, it } from 'vitest';
import { LESSON_IDEA_IDS, LESSON_LINES, LESSON_POOLS, LESSON_WORDING_FILES } from '@gambit/content';
import { IDEA_PRIORITY } from '../moveIdeas.ts';
import { lintLessonLine, lintLessonLines, lintLessonText } from './lint.ts';

describe('lesson content', () => {
  it('pool ids are unique and every family file only fills known pools, each pool in one file', () => {
    const ids = new Set<string>();
    for (const p of LESSON_POOLS) {
      expect(ids.has(p.id), p.id).toBe(false);
      ids.add(p.id);
    }
    const owner = new Map<string, string>();
    for (const [file, wordings] of Object.entries(LESSON_WORDING_FILES)) {
      for (const id of Object.keys(wordings)) {
        expect(ids.has(id), `${file}: unknown pool ${id}`).toBe(true);
        expect(owner.get(id), `${id} is in ${owner.get(id)} and ${file}`).toBeUndefined();
        owner.set(id, file);
      }
    }
  });

  it('the idea ids of the content equal the core MoveIdeaId list', () => {
    expect([...LESSON_IDEA_IDS].sort()).toEqual([...IDEA_PRIORITY].sort());
  });

  it('every pool has its wordings at every stage of its range, and none breaks a rule', () => {
    const issues = lintLessonLines(LESSON_LINES);
    const summary = issues.slice(0, 60).map((i) => `${i.pool} [${i.rule}] ${i.detail ?? ''} «${i.text}»`);
    expect(summary, `${issues.length} issues`).toEqual([]);
  });

  describe('the lint itself', () => {
    const idea = { id: 'v3.idea.develop', role: 'tail' as const, cue: ['attacks' as const], subject: 'mover' as const };
    it('catches squares, files, Latin and digits', () => {
      expect(lintLessonText(idea, '— и конь встанет на эф три.', 'n').map((i) => i.rule)).toContain('square');
      expect(lintLessonText({ ...idea, id: 'v3.idea.rookOpenFile', subject: undefined }, '— ладья встанет на линию цэ.').map((i) => i.rule)).toContain('file');
      expect(lintLessonText(idea, '— и Nf3 в игре.', 'n').map((i) => i.rule)).toContain('latin');
      expect(lintLessonText(idea, '— и 3 клетки в центре.', 'n').map((i) => i.rule)).toContain('digit');
    });
    it('catches a feminine Гамбитик, generic praise, the clock and a bare «ты …л»', () => {
      const whole = { id: 'v3.praise.castled', role: 'whole' as const, cue: ['king' as const] };
      expect(lintLessonText(whole, 'Я так рада, король в домике!').map((i) => i.rule)).toContain('selfFeminine');
      expect(lintLessonText(whole, 'Рокировка — молодец!').map((i) => i.rule)).toContain('banned');
      expect(lintLessonText(whole, 'Осталась минута!').map((i) => i.rule)).toContain('banned');
      expect(lintLessonText(whole, 'Ты спрятал короля в домик!').map((i) => i.rule)).toContain('childGender');
      expect(lintLessonText(whole, 'Король в домике — я рад!')).toEqual([]);
    });
    it('checks the seams of leads, tails and button labels', () => {
      expect(lintLessonText({ id: 'v3.lead.advice', role: 'lead', cue: ['move'], subject: 'mover' }, 'Давай пойдём конём.', 'n').map((i) => i.rule)).toContain('end');
      expect(lintLessonText(idea, 'пусть выходит в игру.', 'n').map((i) => i.rule)).toContain('seam');
      expect(lintLessonText({ id: 'v3.quiz.opt.castle', role: 'whole', cue: [] }, 'Спрятать короля.').map((i) => i.rule)).toContain('end');
    });
    it('pointing at the board needs a cue; the subject piece must not be swapped', () => {
      expect(lintLessonText({ id: 'v3.opp.nothing', role: 'whole', cue: [] }, 'Смотри на этот фланг!').map((i) => i.rule)).toContain('deixis');
      expect(lintLessonText(idea, '— и слон смотрит в центр.', 'n').map((i) => i.rule)).toContain('pieceWord');
    });
    it('counts wordings per stage', () => {
      const line = { id: 'v3.test', role: 'whole' as const, cue: [], min: 2, purpose: '', wordings: [{ t: 'Раз.' }, { t: 'Два.', stages: [3, 5] as const }] };
      expect(lintLessonLine(line).filter((i) => i.rule === 'count').map((i) => i.detail)).toEqual(['stage 1: 1 wordings < 2', 'stage 2: 1 wordings < 2']);
    });
  });
});
