import { describe, expect, it } from 'vitest';
import type { CoachEvent, PieceType } from '@gambit/shared';
import {
  buildPuzzleHint,
  buildPuzzleMiss,
  buildPuzzleSessionStart,
  buildPuzzleSolved,
  buildSessionSummary,
  buildSolutionShown,
  makeLocalEvent,
  pick,
  stripLatin,
} from './puzzleCoach.ts';

const SHAMING = /(глуп|плох|ужас|позор|стыд|опять зевн|неправильно|ошибся|ошиблась|проиграл|слаб)/i;

/** Every variant of every builder, by sweeping the rng over [0, 1). */
function allVariants(build: (rng: () => number) => CoachEvent): CoachEvent[] {
  const events: CoachEvent[] = [];
  for (let i = 0; i < 12; i++) {
    const value = i / 12;
    events.push(build(() => value));
  }
  return events;
}

function corpus(): CoachEvent[] {
  const pieces: PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
  return [
    ...allVariants((rng) => buildPuzzleSessionStart(undefined, rng)),
    ...allVariants((rng) => buildPuzzleSessionStart('Вилка', rng)),
    ...[0, 1, 2, 3, 5, 7, 10].flatMap((streak) => allVariants((rng) => buildPuzzleSolved({ clean: true, streak, revealTitle: 'Мат в 1 ход' }, rng))),
    ...allVariants((rng) => buildPuzzleSolved({ clean: false, streak: 0 }, rng)),
    ...allVariants((rng) => buildPuzzleSolved({ clean: true, streak: 1, alternateMate: true }, rng)),
    ...[1, 2, 5].flatMap((n) => allVariants((rng) => buildPuzzleMiss(n, rng))),
    ...pieces.flatMap((piece) => allVariants((rng) => buildPuzzleHint(1, { from: 'g1', to: 'f3', piece }, rng))),
    ...allVariants((rng) => buildPuzzleHint(2, { from: 'g1', to: 'f3', piece: 'n' }, rng)),
    ...allVariants((rng) => buildSolutionShown(rng)),
    ...allVariants((rng) => buildSessionSummary({ total: 10, solvedClean: 7, stars: 25 }, rng)),
    ...allVariants((rng) => buildSessionSummary({ total: 10, solvedClean: 0, stars: 12 }, rng)),
  ];
}

describe('local coach events', () => {
  const events = corpus();

  it('never contain Latin letters in the spoken text', () => {
    for (const event of events) expect(event.text, event.text).not.toMatch(/[A-Za-z]/);
  });

  it('are short, warm and never shaming', () => {
    for (const event of events) {
      expect(event.text.length).toBeGreaterThan(3);
      expect(event.text.split(/\s+/).length, event.text).toBeLessThanOrEqual(25);
      expect(event.text, event.text).not.toMatch(SHAMING);
      expect(event.bubbleText, event.bubbleText).not.toMatch(SHAMING);
    }
  });

  it('never pause a clock and only use small priorities', () => {
    for (const event of events) {
      expect(event.pauseClock).toBe(false);
      expect([0, 1]).toContain(event.priority);
    }
  });

  it('have unique ids', () => {
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });
});

describe('builders', () => {
  it('cheer on a solved puzzle and reveal the theme', () => {
    const event = buildPuzzleSolved({ clean: true, streak: 1, revealTitle: 'Вилка' }, () => 0);
    expect(event.kind).toBe('praise');
    expect(event.pose).toBe('cheer');
    expect(event.priority).toBe(0);
    expect(event.text).toContain('«Вилка»');
  });

  it('make streak milestones a little louder', () => {
    expect(buildPuzzleSolved({ clean: true, streak: 5 }, () => 0).priority).toBe(1);
    expect(buildPuzzleSolved({ clean: true, streak: 4 }, () => 0).text).toContain('4');
  });

  it('encourage on a miss without board marks', () => {
    const event = buildPuzzleMiss(1, () => 0);
    expect(event.kind).toBe('encourage');
    expect(event.board).toBeUndefined();
  });

  it('hint 1 marks only the piece, hint 2 draws the arrow', () => {
    const first = buildPuzzleHint(1, { from: 'd5', to: 'e3', piece: 'n' }, () => 0);
    expect(first.hintLevel).toBe(3);
    expect(first.board).toEqual({ arrows: [], highlights: [{ square: 'd5', color: 'blue' }] });
    expect(first.text).toContain('коня');
    expect(first.text).toContain('ему');
    expect(buildPuzzleHint(1, { from: 'a1', to: 'a8', piece: 'r' }, () => 0).text).toContain('ей');
    const second = buildPuzzleHint(2, { from: 'd5', to: 'e3', piece: 'n' }, () => 0);
    expect(second.hintLevel).toBe(4);
    expect(second.board).toEqual({ arrows: [{ from: 'd5', to: 'e3', color: 'green' }], highlights: [] });
  });
});

describe('helpers', () => {
  it('stripLatin removes Latin words but keeps the sentence tidy', () => {
    expect(stripLatin('Это тема «fork» !')).toBe('Это тема «»!');
    expect(stripLatin('Ход Nf3 , шах')).toBe('Ход 3, шах');
    expect(stripLatin('Привет')).toBe('Привет');
  });

  it('makeLocalEvent keeps notation in the bubble only', () => {
    const event = makeLocalEvent({ kind: 'reviewMoment', priority: 1, pose: 'talk', text: 'Сильнее было Кf3', bubbleText: 'Сильнее было Кf3' });
    expect(event.text).not.toMatch(/[A-Za-z]/);
    expect(event.bubbleText).toBe('Сильнее было Кf3');
    expect(event.board).toBeUndefined();
  });

  it('pick is safe for rng edge values', () => {
    expect(pick(['a', 'b', 'c'], () => 0)).toBe('a');
    expect(pick(['a', 'b', 'c'], () => 0.999)).toBe('c');
    expect(pick(['a', 'b', 'c'], () => 1)).toBe('c');
    expect(pick(['a'], () => Number.NaN)).toBe('a');
  });
});
