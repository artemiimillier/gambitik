/**
 * The book with the REAL words of @gambit/content: without a voice policy — no getter, a getter that returns null, or a
 * policy that finds nothing recorded and does not grow cheaply — every pick over every pool, stage, piece and gender
 * is exactly the default book's (the 50-game report stays byte-identical). With cheap growth the book does differ.
 */
import { describe, expect, it } from 'vitest';
import type { PieceType } from '@gambit/shared';
import { LESSON_LINES } from '@gambit/content';
import { createLessonBook, lessonUnitKey } from './book.ts';
import type { LessonBookInit, PickArgs } from './book.ts';

const PIECES: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];

/** 6 games × 3 picks per pool, with every argument the engine passes varied; what was said, then the stored book. */
function run(extra: Pick<LessonBookInit, 'voice'> = {}): { said: string[]; history: unknown } {
  const said: string[] = [];
  const pools = LESSON_LINES.map((l) => l.id);
  let history: unknown;
  for (let g = 0; g < 6; g++) {
    const book = createLessonBook({ seed: 77 + g, history, ...extra });
    for (let i = 0; i < pools.length * 3; i++) {
      const args: PickArgs = {
        stage: 1 + ((i + g) % 5),
        piece: PIECES[i % PIECES.length] ?? null,
        g: i % 2 ? 'f' : 'm',
        variant: null,
        deixis: i % 3 !== 0,
        allowBest: i % 4 === 0,
        ...(i % 5 === 0 ? { maxWords: 6 } : {}),
      };
      const p = book.pick(pools[(i * 7 + g) % pools.length] as string, args);
      if (!p) {
        said.push('-');
        continue;
      }
      book.noteSaid(p.text);
      said.push(`${lessonUnitKey(p)} ${p.text}`);
    }
    book.finishGame();
    history = book.snapshotHistory();
  }
  return { said, history };
}

describe('the book on the real library without a voice policy', () => {
  const plain = run();

  it('picks thousands of wordings', () => {
    expect(plain.said.filter((s) => s !== '-').length).toBeGreaterThan(5000);
  });

  it('a getter that returns null is the default book', () => {
    expect(run({ voice: () => null })).toEqual(plain);
  });

  it('a policy that finds nothing recorded (no cheap growth, nothing blocked) is the default book', () => {
    expect(run({ voice: () => ({ minVoiced: 3, growCheap: false, voiced: () => false }) })).toEqual(plain);
  });

  it('cheap growth does change the picks (the policy is live, not ignored)', () => {
    expect(run({ voice: () => ({ minVoiced: 3, growCheap: true, voiced: () => false }) })).not.toEqual(plain);
  });
});
