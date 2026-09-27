/**
 * The smart strategist's browser side (strategy.ts): the wizard's prefetch registry, the strategist the game gets, and
 * the checks of every answer (a strategy must be Russian and complete; a re-plan may only pick one of its candidates).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameStrategy, ReplanRequest, StrategyCard, StrategyRequest } from '@gambit/shared';
import {
  STRATEGY_PREFETCH_MAX_AGE_MS,
  STRATEGY_PREFETCH_REUSE_MS,
  acceptReplan,
  createBrowserStrategist,
  createStrategyPrefetcher,
  prefetchStrategyFor,
  sanitizeStrategy,
  strategyCardOf,
  strategyRequestKey,
} from './strategy.ts';

const ITALIAN: GameStrategy = {
  strategyId: 'italian',
  titleRu: 'Итальянская партия',
  introRu: 'В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой на е четыре.',
  ideaRu: 'Быстро выводим фигуры и целимся в слабую точку эф семь.',
  provider: 'codex',
};

const WHITE: StrategyRequest = { childColor: 'w', stage: 1, personaId: 'petya', timeControlId: 'training' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sanitizeStrategy: what the game accepts as the strategy of a game', () => {
  it('a complete Russian strategy passes (trimmed); an unknown provider reads as «template»', () => {
    expect(sanitizeStrategy(ITALIAN)).toEqual(ITALIAN);
    expect(sanitizeStrategy({ ...ITALIAN, titleRu: '  Итальянская   партия ', provider: 'mystery' })).toEqual({ ...ITALIAN, titleRu: 'Итальянская партия', provider: 'template' });
    // the idea is optional
    expect(sanitizeStrategy({ ...ITALIAN, ideaRu: undefined })?.ideaRu).toBe('');
    // who chose it and who paid survive (the journal's «ИИ в этой партии»); junk is dropped
    expect(sanitizeStrategy({ ...ITALIAN, model: 'gpt-5.6-sol', billing: 'subscription' })).toEqual({ ...ITALIAN, model: 'gpt-5.6-sol', billing: 'subscription' });
    expect(sanitizeStrategy({ ...ITALIAN, model: 'сол <script>', billing: 'free-ish' })).toEqual(ITALIAN);
  });

  it('no id, no Russian title, junk → null', () => {
    for (const bad of [null, 'Итальянская', [], { ...ITALIAN, strategyId: '' }, { ...ITALIAN, strategyId: 'a b' }, { ...ITALIAN, titleRu: '' }, { ...ITALIAN, titleRu: 'Italian Game' }]) {
      expect(sanitizeStrategy(bad)).toBeNull();
    }
  });

  it('a bad intro or idea (Latin letters, too long, missing) is emptied — the teacher then says its own intro', () => {
    for (const introRu of [42, undefined, 'Начни ходом e4.', 'В этот раз '.repeat(40)]) {
      expect(sanitizeStrategy({ ...ITALIAN, introRu })).toEqual({ ...ITALIAN, introRu: '' });
    }
    expect(sanitizeStrategy({ ...ITALIAN, ideaRu: 'Play Bc4' })?.ideaRu).toBe('');
  });
});

describe('acceptReplan: the model may only CHOOSE among the engine candidates', () => {
  const request: Pick<ReplanRequest, 'ply' | 'candidates'> = {
    ply: 7,
    candidates: [
      { uci: 'e1g1', san: 'O-O', cp: 30, ideasRu: ['рокировка'] },
      { uci: 'd2d3', san: 'd3', cp: 22, ideasRu: ['защищает пешку на е четыре'] },
    ],
  };

  it('same ply, a candidate, Russian words → accepted as is', () => {
    const answer = { ply: 7, planRu: 'Прячем короля и готовим атаку.', preferredUci: 'e1g1', whyRu: 'Король в домике — можно нападать.', provider: 'codex' };
    expect(acceptReplan(request, answer)).toEqual(answer);
  });

  it('a move that is not a candidate becomes «no preferred move» (and its reason goes with it); the plan stays', () => {
    const answer = acceptReplan(request, { ply: 7, planRu: 'Нападаем на короля.', preferredUci: 'd1h5', whyRu: 'Ферзь рядом с королём.', provider: 'openrouter' });
    expect(answer).toEqual({ ply: 7, planRu: 'Нападаем на короля.', preferredUci: null, whyRu: '', provider: 'openrouter' });
  });

  it('another ply (stale), no plan, Latin in the plan or junk → null; a Latin reason is dropped', () => {
    expect(acceptReplan(request, { ply: 5, planRu: 'План.', preferredUci: null, whyRu: '', provider: 'codex' })).toBeNull();
    expect(acceptReplan(request, { ply: 7, planRu: '', preferredUci: 'e1g1', whyRu: 'Да.', provider: 'codex' })).toBeNull();
    expect(acceptReplan(request, { ply: 7, planRu: 'Castle and attack', preferredUci: 'e1g1', whyRu: '', provider: 'codex' })).toBeNull();
    expect(acceptReplan(request, null)).toBeNull();
    expect(acceptReplan(request, { ply: 7, planRu: 'Рокировка.', preferredUci: 'e1g1', whyRu: 'Because O-O', provider: 'codex' })?.whyRu).toBe('');
  });
});

describe('the wizard prefetch registry', () => {
  function fetcher() {
    const calls: StrategyRequest[] = [];
    let resolve: (value: GameStrategy | null) => void = () => undefined;
    const fn = vi.fn((request: StrategyRequest) => {
      calls.push(request);
      return new Promise<GameStrategy | null>((r) => {
        resolve = r;
      });
    });
    return { fn, calls, resolve: (value: GameStrategy | null) => resolve(value) };
  }

  it('the key: colour, opponent, time control and the first opponent move — not the stage', () => {
    expect(strategyRequestKey(WHITE)).toBe('w|petya|training|');
    const olderChild: StrategyRequest = { ...WHITE, stage: 4 };
    expect(strategyRequestKey(olderChild)).toBe(strategyRequestKey(WHITE));
    expect(strategyRequestKey({ ...WHITE, childColor: 'b', opponentFirstUci: 'e2e4' })).toBe('b|petya|training|e2e4');
  });

  it('prefetch starts the request at once; the game takes that very promise (no second request)', async () => {
    const f = fetcher();
    let t = 1_000;
    const registry = createStrategyPrefetcher(f.fn, () => t);
    registry.prefetch(WHITE);
    registry.prefetch(WHITE); // a double tap keeps the first request
    expect(f.fn).toHaveBeenCalledTimes(1);
    t += 3_000;
    const taken = registry.take(WHITE);
    expect(taken).not.toBeNull();
    f.resolve(ITALIAN);
    await expect(taken).resolves.toEqual(ITALIAN);
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it('another game setup, a stale prefetch, or a second take long after the first → nothing (the game asks itself)', () => {
    const f = fetcher();
    let t = 0;
    const registry = createStrategyPrefetcher(f.fn, () => t);
    registry.prefetch(WHITE);
    expect(registry.take({ ...WHITE, personaId: 'sonya' })).toBeNull();
    expect(registry.take({ ...WHITE, timeControlId: 'rapid10' })).toBeNull();
    // React StrictMode mounts the game twice: the second controller gets the same promise, no second paid request
    const first = registry.take(WHITE);
    t += 500;
    expect(registry.take(WHITE)).toBe(first);
    // a rematch much later asks anew — each game its own strategy
    t += STRATEGY_PREFETCH_REUSE_MS;
    expect(registry.take(WHITE)).toBeNull();
    registry.prefetch(WHITE);
    t += STRATEGY_PREFETCH_MAX_AGE_MS;
    expect(registry.take(WHITE)).toBeNull();
    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('a failing fetcher never rejects the prefetched promise (null = no strategy)', async () => {
    const registry = createStrategyPrefetcher(() => Promise.reject(new Error('offline')));
    registry.prefetch(WHITE);
    await expect(registry.take(WHITE)).resolves.toBeNull();
    const throwing = createStrategyPrefetcher(() => {
      throw new Error('boom');
    });
    throwing.prefetch(WHITE);
    await expect(throwing.take(WHITE)).resolves.toBeNull();
  });

  it('prefetchStrategyFor: only «Учитель» as White — Black waits for the bot\'s real first move', () => {
    const f = fetcher();
    const registry = createStrategyPrefetcher(f.fn);
    const choice = { coachStyle: 'teacher', childColor: 'w' as const, personaId: 'petya' as const, timeControlId: 'rapid10' as const, stage: 2 };
    expect(prefetchStrategyFor({ ...choice, coachStyle: 'helper' }, registry)).toBe(false);
    expect(prefetchStrategyFor({ ...choice, coachStyle: 'exam' }, registry)).toBe(false);
    expect(prefetchStrategyFor({ ...choice, childColor: 'b' }, registry)).toBe(false);
    expect(f.fn).not.toHaveBeenCalled();
    expect(prefetchStrategyFor(choice, registry)).toBe(true);
    expect(f.calls).toEqual([{ childColor: 'w', stage: 2, personaId: 'petya', timeControlId: 'rapid10' }]);
  });
});

describe('the browser strategist (GameDeps.strategist)', () => {
  it('takes the prefetch when there is one, otherwise asks itself with the game\'s signal', async () => {
    const own = vi.fn((_: StrategyRequest, opts: { signal?: AbortSignal }) => Promise.resolve(opts.signal ? ITALIAN : null));
    const registry = createStrategyPrefetcher(() => Promise.resolve({ ...ITALIAN, strategyId: 'prefetched' }));
    registry.prefetch(WHITE);
    const strategist = createBrowserStrategist(registry, own);
    await expect(strategist.strategy(WHITE)).resolves.toMatchObject({ strategyId: 'prefetched' });
    expect(own).not.toHaveBeenCalled();
    const controller = new AbortController();
    await expect(strategist.strategy({ ...WHITE, childColor: 'b', opponentFirstUci: 'e2e4' }, { signal: controller.signal })).resolves.toEqual(ITALIAN);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('re-plans go to POST /api/coach/replan with the signal', async () => {
    const answer = { ply: 3, planRu: 'Выводим коня.', preferredUci: 'g1f3', whyRu: 'Конь нападает на пешку.', provider: 'codex' };
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const strategist = createBrowserStrategist(createStrategyPrefetcher(() => Promise.resolve(null)));
    const request: ReplanRequest = { ply: 3, fen: 'x', childColor: 'w', strategyId: 'italian', movesSan: ['e4', 'e5'], candidates: [], stage: 1 };
    await expect(strategist.replan(request, { signal: new AbortController().signal })).resolves.toEqual(answer);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/coach/replan');
  });
});

describe('strategyCardOf: the curated library, read structurally', () => {
  const card: StrategyCard = {
    id: 'italian',
    titleRu: 'Итальянская партия',
    ideaRu: 'Быстро выводим фигуры.',
    side: 'w',
    against: 'any',
    lineSan: ['e4', 'Nf3', 'Bc4'],
    stepsRu: ['пешка в центр'],
    middlegameRu: [],
    minStage: 1,
    themes: [],
  };

  it('STRATEGIES as a list or a record, or a lookup function', () => {
    expect(strategyCardOf('italian', { STRATEGIES: [card] })).toBe(card);
    expect(strategyCardOf('italian', { STRATEGIES: { italian: card } })).toBe(card);
    expect(strategyCardOf('italian', { getStrategyCard: (id: string) => (id === 'italian' ? card : undefined) })).toBe(card);
  });

  it('an unknown id, a content package without a library, or junk → undefined', () => {
    expect(strategyCardOf('london', { STRATEGIES: [card] })).toBeUndefined();
    expect(strategyCardOf('italian', {})).toBeUndefined();
    expect(strategyCardOf('italian', { STRATEGIES: [{ id: 'italian' }] })).toBeUndefined();
    expect(
      strategyCardOf('italian', {
        getStrategyCard: () => {
          throw new Error('boom');
        },
      }),
    ).toBeUndefined();
  });
});
