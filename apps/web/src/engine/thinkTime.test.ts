import { describe, expect, it } from 'vitest';
import { createSeededRng } from './rng.ts';
import { MAX_THINK_MS, MIN_THINK_MS, computeThinkMs } from './thinkTime.ts';
import type { ThinkTimeInput } from './thinkTime.ts';

const base: Omit<ThinkTimeInput, 'rng'> = {
  moveNumber: 18,
  remainingMs: null,
  legalMoveCount: 30,
  inCheck: false,
  topGapCp: null,
};

function average(input: Omit<ThinkTimeInput, 'rng'>, seed = 1): number {
  const rng = createSeededRng(seed);
  let total = 0;
  for (let i = 0; i < 500; i += 1) total += computeThinkMs({ ...input, rng });
  return total / 500;
}

describe('computeThinkMs', () => {
  it('always stays within [MIN_THINK_MS, MAX_THINK_MS]', () => {
    const rng = createSeededRng(123);
    for (const remainingMs of [null, 600_000, 300_000, 60_000, 10_000, 2_000, 0]) {
      for (const moveNumber of [1, 6, 12, 40]) {
        for (const legalMoveCount of [1, 2, 20, 45]) {
          const ms = computeThinkMs({ ...base, remainingMs, moveNumber, legalMoveCount, rng });
          expect(ms).toBeGreaterThanOrEqual(MIN_THINK_MS);
          expect(ms).toBeLessThanOrEqual(MAX_THINK_MS);
          expect(Number.isInteger(ms)).toBe(true);
        }
      }
    }
  });

  it('is shorter in bullet and on a low clock', () => {
    const untimed = average(base);
    const rapid = average({ ...base, remainingMs: 600_000 });
    const bullet = average({ ...base, remainingMs: 60_000 });
    const lowClock = average({ ...base, remainingMs: 6_000 });
    expect(bullet).toBeLessThan(untimed);
    expect(bullet).toBeLessThan(rapid);
    expect(lowClock).toBeLessThan(bullet);
    expect(bullet).toBeLessThan(1_800);
  });

  it('never spends more than 1/12 of the remaining clock (above the floor)', () => {
    const rng = createSeededRng(9);
    for (let i = 0; i < 200; i += 1) {
      expect(computeThinkMs({ ...base, remainingMs: 12_000, rng })).toBeLessThanOrEqual(1_000);
    }
  });

  it('plays the opening faster than the middlegame', () => {
    expect(average({ ...base, moveNumber: 3 })).toBeLessThan(average({ ...base, moveNumber: 8 }));
    expect(average({ ...base, moveNumber: 8 })).toBeLessThan(average({ ...base, moveNumber: 20 }));
  });

  it('thinks longer in complex positions and shorter on obvious / forced moves', () => {
    const quiet = average({ ...base, legalMoveCount: 8 });
    const rich = average({ ...base, legalMoveCount: 40 });
    expect(rich).toBeGreaterThan(quiet);
    expect(average({ ...base, topGapCp: 10 })).toBeGreaterThan(average({ ...base, topGapCp: 120 }));
    expect(average({ ...base, topGapCp: 450 })).toBeLessThan(average({ ...base, topGapCp: 120 }));
    expect(average({ ...base, inCheck: true })).toBeLessThan(average(base));
    expect(average({ ...base, legalMoveCount: 1 })).toBeLessThan(MIN_THINK_MS + 300);
  });

  it('is slightly random but reproducible with a seeded rng', () => {
    const rng = createSeededRng(77);
    const values = new Set(Array.from({ length: 20 }, () => computeThinkMs({ ...base, rng })));
    expect(values.size).toBeGreaterThan(10);
    const again = createSeededRng(77);
    expect(computeThinkMs({ ...base, rng: again })).toBe([...values][0]);
  });
});
