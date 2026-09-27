import { describe, expect, it } from 'vitest';
import { CHILD_POLICY, DEFAULT_GAMES, STAGE_PERSONAS, childPlans, gameConfigs, gameId, mixSeed, seededRng, workerChildren } from './config.ts';
import { CURRICULUM } from '../../packages/content/src/index.ts';

describe('the plan of the run', () => {
  it('50 games = 5 children (stages 1..5) × 10', () => {
    const plans = childPlans(DEFAULT_GAMES);
    expect(plans.map((p) => [p.child, p.stage, p.games])).toEqual([
      [1, 1, 10],
      [2, 2, 10],
      [3, 3, 10],
      [4, 4, 10],
      [5, 5, 10],
    ]);
    expect(new Set(plans.map((p) => p.address))).toEqual(new Set(['m', 'f']));
  });

  it('a smoke run spreads the games over the children, the first ones get the extra', () => {
    expect(childPlans(5).map((p) => p.games)).toEqual([1, 1, 1, 1, 1]);
    expect(childPlans(7).map((p) => p.games)).toEqual([2, 2, 1, 1, 1]);
    expect(childPlans(3).map((p) => p.child)).toEqual([1, 2, 3]);
  });

  it('colours alternate, half the games are blitz, the rest rapid10 / training, one game id per game', () => {
    for (const plan of childPlans(DEFAULT_GAMES)) {
      const games = gameConfigs(plan, 7);
      for (let i = 1; i < games.length; i++) expect(games[i]?.childColor).not.toBe(games[i - 1]?.childColor);
      expect(games.filter((g) => g.tc === 'blitz5')).toHaveLength(5);
      expect(games.every((g) => ['blitz5', 'rapid10', 'training'].includes(g.tc))).toBe(true);
      expect(games.some((g) => g.tc === 'blitz5' && g.childColor === 'w') && games.some((g) => g.tc === 'blitz5' && g.childColor === 'b')).toBe(true);
      expect(games.map((g) => g.game)).toEqual(games.map((g) => gameId(plan.child, g.gameNo)));
    }
  });

  it('the sample-transcript games exist in the default plan (blitz stage 1 White, rapid10 stage 2 Black, training stage 4)', () => {
    const all = childPlans(DEFAULT_GAMES).flatMap((p) => gameConfigs(p, 1));
    expect(all.some((g) => g.stage === 1 && g.tc === 'blitz5' && g.childColor === 'w')).toBe(true);
    expect(all.some((g) => g.stage === 2 && g.tc === 'rapid10' && g.childColor === 'b')).toBe(true);
    expect(all.some((g) => g.stage === 4 && g.tc === 'training')).toBe(true);
  });

  it('bots are the recommended personas of the stage (CURRICULUM)', () => {
    for (const s of CURRICULUM.filter((c) => c.stage <= 5)) expect(STAGE_PERSONAS[s.stage]).toEqual(s.recommendedPersonas);
    for (const plan of childPlans(DEFAULT_GAMES)) for (const g of gameConfigs(plan, 1)) expect(STAGE_PERSONAS[plan.stage]).toContain(g.persona);
  });

  it('deterministic per seed, separate streams per game', () => {
    const a = gameConfigs(childPlans(50)[2]!, 42);
    const b = gameConfigs(childPlans(50)[2]!, 42);
    const c = gameConfigs(childPlans(50)[2]!, 43);
    expect(a).toEqual(b);
    expect(a.map((g) => g.seed)).not.toEqual(c.map((g) => g.seed));
    const g = a[0]!;
    expect(new Set([g.seed, g.bookSeed, g.botSeed, g.stratSeed, g.legacySeed]).size).toBe(5);
    expect(mixSeed(1, 2, 3)).toBe(mixSeed(1, 2, 3));
    const r1 = seededRng(9);
    const r2 = seededRng(9);
    const xs = [r1(), r1(), r1()];
    expect(xs).toEqual([r2(), r2(), r2()]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('one child per worker, at most 5 workers', () => {
    const plans = childPlans(50);
    expect(workerChildren(plans, 5).map((w) => w.map((p) => p.child))).toEqual([[1], [2], [3], [4], [5]]);
    expect(workerChildren(plans, 2).map((w) => w.map((p) => p.child))).toEqual([[1, 3, 5], [2, 4]]);
    expect(workerChildren(plans, 16)).toHaveLength(5);
    expect(workerChildren(childPlans(2), 5)).toHaveLength(2);
  });

  it('the child model adds up', () => {
    const m = CHILD_POLICY.move;
    expect(m.arrow + m.second + m.pv + m.random).toBeCloseTo(1, 6);
    const q = CHILD_POLICY.quiz;
    expect(q.right + q.wrong + q.ignore).toBeCloseTo(1, 6);
  });
});
