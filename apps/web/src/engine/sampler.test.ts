import { describe, expect, it } from 'vitest';
import type { EngineLine } from '@gambit/shared';
import { createSeededRng } from './rng.ts';
import { MATE_SCORE_CP, buildCandidatePool, samplePool, scoreToCp } from './sampler.ts';

const line = (multipv: number, uci: string, score: { cp?: number; mate?: number }): EngineLine => ({
  multipv,
  depth: 5,
  cp: score.cp ?? null,
  mate: score.mate ?? null,
  pvUci: [uci],
});

const LEGAL = new Set(['e2e4', 'd2d4', 'g1f3', 'a2a4', 'g2g4', 'f2f3']);

describe('scoreToCp', () => {
  it('maps mates onto the centipawn axis keeping the order "faster mate is better"', () => {
    expect(scoreToCp({ cp: 35, mate: null })).toBe(35);
    expect(scoreToCp({ cp: -120, mate: null })).toBe(-120);
    expect(scoreToCp({ cp: null, mate: 1 })).toBe(MATE_SCORE_CP - 10);
    expect(scoreToCp({ cp: null, mate: 3 })).toBe(MATE_SCORE_CP - 30);
    expect(scoreToCp({ cp: null, mate: -2 })).toBe(-(MATE_SCORE_CP - 20));
    expect(scoreToCp({ cp: null, mate: 0 })).toBe(-MATE_SCORE_CP);
    expect(scoreToCp({ cp: null, mate: 1 })).toBeGreaterThan(scoreToCp({ cp: null, mate: 4 }));
    expect(scoreToCp({ cp: null, mate: -5 })).toBeGreaterThan(scoreToCp({ cp: null, mate: -1 }));
  });
});

describe('buildCandidatePool', () => {
  const lines = [
    line(1, 'e2e4', { cp: 40 }),
    line(2, 'd2d4', { cp: 30 }),
    line(3, 'g1f3', { cp: -60 }),
    line(4, 'g2g4', { cp: -560 }),
    line(5, 'f2f3', { cp: -2100 }),
  ];

  it('drops candidates above maxLossCp and weights the rest by softmax over the eval loss', () => {
    const pool = buildCandidatePool(lines, LEGAL, { tempCp: 100, maxLossCp: 600 });
    expect(pool.map((c) => c.uci)).toEqual(['e2e4', 'd2d4', 'g1f3', 'g2g4']);
    expect(pool.map((c) => c.lossCp)).toEqual([0, 10, 100, 600]);
    const total = pool.reduce((sum, c) => sum + c.probability, 0);
    expect(total).toBeCloseTo(1, 10);
    // w = exp(-loss / temp): ratios between candidates are fixed by the formula.
    expect(pool[1]!.probability / pool[0]!.probability).toBeCloseTo(Math.exp(-0.1), 10);
    expect(pool[2]!.probability / pool[0]!.probability).toBeCloseTo(Math.exp(-1), 10);
    expect(pool[3]!.probability / pool[0]!.probability).toBeCloseTo(Math.exp(-6), 10);
  });

  it('always keeps the best move, even with maxLossCp 0 or a zero temperature', () => {
    expect(buildCandidatePool(lines, LEGAL, { tempCp: 100, maxLossCp: 0 }).map((c) => c.uci)).toEqual(['e2e4']);
    const greedy = buildCandidatePool(lines, LEGAL, { tempCp: 0, maxLossCp: 5000 });
    expect(greedy[0]).toMatchObject({ uci: 'e2e4', probability: 1 });
    expect(greedy.slice(1).every((c) => c.probability === 0)).toBe(true);
  });

  it('ignores lines whose first move is not legal', () => {
    const pool = buildCandidatePool([line(1, 'e7e5', { cp: 900 }), ...lines], LEGAL, { tempCp: 100, maxLossCp: 50 });
    expect(pool.map((c) => c.uci)).toEqual(['e2e4', 'd2d4']);
    expect(buildCandidatePool([line(1, 'e7e5', { cp: 900 })], LEGAL, { tempCp: 100, maxLossCp: 50 })).toEqual([]);
  });

  it('a found mate crowds out every non-mating move for any realistic maxLossCp', () => {
    const pool = buildCandidatePool([line(1, 'e2e4', { mate: 1 }), line(2, 'd2d4', { cp: 850 }), line(3, 'g1f3', { mate: 2 })], LEGAL, {
      tempCp: 400,
      maxLossCp: 2000,
    });
    expect(pool.map((c) => c.uci)).toEqual(['e2e4', 'g1f3']);
  });

  it('uniform weights with an infinite temperature', () => {
    const pool = buildCandidatePool(lines, LEGAL, { tempCp: Number.POSITIVE_INFINITY, maxLossCp: 15 });
    expect(pool.map((c) => c.probability)).toEqual([0.5, 0.5]);
  });
});

describe('samplePool', () => {
  it('follows the pool probabilities (seeded, 20 000 draws)', () => {
    const pool = buildCandidatePool(
      [line(1, 'e2e4', { cp: 40 }), line(2, 'd2d4', { cp: -60 }), line(3, 'g1f3', { cp: -160 })],
      LEGAL,
      { tempCp: 100, maxLossCp: 1000 },
    );
    const rng = createSeededRng(2026);
    const counts = new Map<string, number>();
    const draws = 20_000;
    for (let i = 0; i < draws; i += 1) {
      const pick = samplePool(pool, rng).uci;
      counts.set(pick, (counts.get(pick) ?? 0) + 1);
    }
    for (const candidate of pool) {
      expect((counts.get(candidate.uci) ?? 0) / draws).toBeCloseTo(candidate.probability, 1);
    }
    expect(counts.get('e2e4')!).toBeGreaterThan(counts.get('d2d4')!);
    expect(counts.get('d2d4')!).toBeGreaterThan(counts.get('g1f3')!);
  });

  it('is deterministic for a given seed', () => {
    const pool = buildCandidatePool([line(1, 'e2e4', { cp: 10 }), line(2, 'd2d4', { cp: 0 })], LEGAL, { tempCp: 300, maxLossCp: 1000 });
    const run = (seed: number): string => {
      const rng = createSeededRng(seed);
      return Array.from({ length: 30 }, () => samplePool(pool, rng).uci).join(',');
    };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
  });
});
