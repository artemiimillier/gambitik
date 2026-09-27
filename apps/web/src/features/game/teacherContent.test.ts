/**
 * The game's content wiring for «Учитель» (docs/TEACHER-MODE.md §3.3, §3.5): the real repertoire plan and the curated
 * main-line table of @gambit/content reach the teacher — so e4 / d4 at the start are «так часто начинают» and the plan
 * names the next model moves — and nothing throws on garbage.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { DEFAULT_TEACHER_CONTENT, conceptCardOf, createOpeningNames, mainLineMovesOf, repertoirePlanOf } from './teacherContent.ts';

const START = new Chess().fen();

function fenOf(sans: readonly string[]): string {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  return chess.fen();
}

describe('teacher content wiring', () => {
  it('the main-line table: e4 / d4 at the start, Кf3 after 1.e4 e5, nothing for an unknown position', () => {
    expect(mainLineMovesOf(START)).toEqual(['e4', 'd4']);
    expect(mainLineMovesOf(fenOf(['e4', 'e5']))).toEqual(['Nf3']);
    expect(mainLineMovesOf(fenOf(['a3', 'h6']))).toEqual([]);
    expect(mainLineMovesOf('not a fen')).toEqual([]);
  });

  it('the repertoire plan: White gets a plan before the first move; after 1.e4 e5 the next model move is Кf3', () => {
    const start = repertoirePlanOf([], 'w');
    expect(start?.inBook).toBe(true);
    expect(start?.nextChildSans[0]).toBe('e4');
    const e5 = repertoirePlanOf(['e4', 'e5'], 'w');
    expect(e5?.inBook).toBe(true);
    expect(e5?.nextChildSans[0]).toBe('Nf3');
    expect(e5?.continuationSan?.length ?? 0).toBeGreaterThan(1);
    expect(repertoirePlanOf(['e4', 'e5', 'Zz9'], 'w')).toBeNull();
  });

  it('concept cards and the defaults', () => {
    expect(conceptCardOf('scholars-mate')?.id).toBe('scholars-mate');
    expect(conceptCardOf('no-such-card')).toBeUndefined();
    expect(DEFAULT_TEACHER_CONTENT.mainLineMoves(START)).toEqual(['e4', 'd4']);
    expect(DEFAULT_TEACHER_CONTENT.openingNameRu(START)).toBeUndefined();
  });

  it('opening names come from the book once it has loaded; a failed load means no names', async () => {
    const names = createOpeningNames(() => import('@gambit/openings'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await import('@gambit/openings');
    expect(names(fenOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']))).toBe('Итальянская партия');
    const none = createOpeningNames(() => Promise.reject(new Error('offline')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(none(START)).toBeUndefined();
  });
});
