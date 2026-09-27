/**
 * The smart strategist against FAKE providers only (no codex binary, no network): which provider
 * answers, what the server accepts from a model, the budgets, the automation path and the variety
 * between games. The real library of @gambit/content is used.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReplanRequest, StrategyRequest } from '@gambit/shared';
import { loadContent } from '../content.ts';
import type { ContentBundle } from '../content.ts';
import { LlmGateway } from '../llm/gateway.ts';
import { createTemplateProvider } from '../llm/providers/template.ts';
import { LlmProviderError } from '../llm/types.ts';
import type { LlmProvider, LlmRequest, ProviderId } from '../llm/types.ts';
import { defaultProfile } from '../services/profile.ts';
import { StrategyHistory } from './history.ts';
import { Strategist, StrategistInputError, namesNoSquare, squareFreeRu, startWithRu, templateIntroRu, templatePlanRu, templateWhyRu } from './strategist.ts';
import type { StrategistTiming } from './strategist.ts';
import { spokenProblem } from './text.ts';

let content: ContentBundle;
beforeAll(async () => {
  content = await loadContent();
});

interface Fake extends LlmProvider {
  calls: LlmRequest[];
}

function fake(id: ProviderId, behaviour: (request: LlmRequest) => unknown): Fake {
  const provider: Fake = {
    id,
    calls: [],
    isConfigured: () => true,
    generate: async (request) => {
      provider.calls.push(request);
      return behaviour(request);
    },
  };
  return provider;
}

function enumOf(request: LlmRequest, key: string): string[] {
  const properties = request.jsonSchema.properties as Record<string, { enum?: string[] }>;
  return properties[key]?.enum ?? [];
}

const templateProvider = (): LlmProvider => createTemplateProvider({ templateReview: null, motifTitleRu: (m) => m, themeTitleRu: (t) => t, defaultTheme: () => 'fork' });

interface Setup {
  strategist: Strategist;
  gateway: LlmGateway;
  history: StrategyHistory;
  logs: string[];
  /** moves the history clock on (one game later) */
  nextGame(): void;
  /** a lost game and an immediate rematch: 20 s later */
  quickRematch(): void;
}

function setup(providers: LlmProvider[], timing: Partial<StrategistTiming> = {}, extra: { codexFirst?: boolean; now?: () => number } = {}): Setup {
  const logs: string[] = [];
  let clock = Date.UTC(2026, 8, 22, 12, 0, 0);
  const store = { value: undefined as unknown, loadStrategyHistoryRaw: () => store.value, saveStrategyHistory: (v: unknown) => (store.value = v) };
  const history = new StrategyHistory(store, () => clock);
  const gateway = new LlmGateway({ providers: [...providers, templateProvider()], log: (m) => logs.push(m) });
  const strategist = new Strategist({
    gateway,
    library: content.strategyLibrary,
    history,
    getProfile: () => ({ ...defaultProfile(), nickname: 'Тигрёнок', weaknesses: ['Вилка'], strengths: ['Мат в 1 ход'] }),
    personas: content.personas,
    sanToSpokenRu: content.sanToSpokenRu,
    models: { codex: 'gpt-5.6-sol', openrouter: 'openai/gpt-5.6-sol', openaiApi: 'gpt-5.6-sol' },
    log: (m) => logs.push(m),
    timing,
    ...(extra.codexFirst !== undefined ? { codexFirst: extra.codexFirst } : {}),
    ...(extra.now !== undefined ? { now: extra.now } : {}),
  });
  return { strategist, gateway, history, logs, nextGame: () => (clock += 30 * 60_000), quickRematch: () => (clock += 20_000) };
}

const WHITE: StrategyRequest = { childColor: 'w', stage: 1, personaId: 'petya', timeControlId: 'rapid10' };
const LONDON_INTRO = 'В этот раз разыграем Лондонскую систему — сначала слон, потом крепость из пешек. Начни пешкой на дэ четыре.';
const choose = (id: string, introRu: string) => (request: LlmRequest) => (enumOf(request, 'strategyId').includes(id) ? { strategyId: id, introRu } : { strategyId: 'nope', introRu });
const pickFirst = (request: LlmRequest) => ({ strategyId: enumOf(request, 'strategyId')[0], introRu: 'Играем по плану!' });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('POST /coach/strategy — the smart strategist', () => {
  it('codex (the subscription) chooses with the strategist model; the answer is the library card + the model’s intro', async () => {
    const codex = fake('codex', choose('london', LONDON_INTRO));
    const { strategist, history, logs } = setup([codex]);
    const strategy = await strategist.chooseStrategy(WHITE, { automation: false });
    // who produced it: the owner's subscription with Sol («через подписку»)
    expect(strategy).toEqual({ strategyId: 'london', titleRu: 'Лондонская система', introRu: LONDON_INTRO, ideaRu: content.strategyLibrary.byId('london')?.ideaRu, provider: 'codex', model: 'gpt-5.6-sol', billing: 'subscription' });
    const call = codex.calls[0];
    expect(call?.model).toBe('gpt-5.6-sol');
    expect(call?.maxOutputTokens).toBe(2000);
    expect(call?.timeoutMs).toBeLessThanOrEqual(8000); // nothing after codex could answer: the whole budget
    expect(call?.timeoutMs).toBeGreaterThan(5000);
    expect(enumOf(call as LlmRequest, 'strategyId').sort()).toEqual(['bishops-opening', 'colle', 'four-knights', 'italian', 'london']);
    // the prompt: stage, weaknesses, candidates with their first move in words — never the nickname
    expect(call?.prompt).toContain('"ступень":1');
    expect(call?.prompt).toContain('Вилка');
    expect(call?.prompt).toContain('пешка на дэ четыре');
    expect(call?.prompt).toContain('не придумывай');
    expect(call?.prompt).not.toContain('Тигрёнок');
    expect(history.recent()).toEqual(['london']);
    // provider + latency, never the prompt
    expect(logs.join('\n')).toMatch(/\[strategist\] strategy london via codex gpt-5\.6-sol \(subscription\) in \d+ ms/);
    expect(logs.join('\n')).toMatch(/\[llm\] strategy: codex answered in \d+ ms/);
    expect(logs.join('\n')).not.toContain('Вилка');
  });

  it('the owner\'s subscription FIRST: codex Sol answers within its cap, OpenRouter is not called', async () => {
    const codex = fake('codex', choose('london', LONDON_INTRO));
    const openrouter = fake('openrouter', choose('italian', LONDON_INTRO));
    const { strategist } = setup([codex, openrouter]);
    expect(strategist.strategyChain()).toEqual(['codex', 'openrouter', 'template']);
    const strategy = await strategist.chooseStrategy(WHITE, { automation: false });
    expect(strategy).toMatchObject({ strategyId: 'london', provider: 'codex', model: 'gpt-5.6-sol', billing: 'subscription' });
    expect(openrouter.calls).toHaveLength(0);
    // an API could answer after it: codex gets its share (7.5 s), not the whole budget
    expect(codex.calls[0]?.timeoutMs).toBe(7_500);
    // a choice among curated cards: no reasoning pass until codex is measured fast enough for one
    expect(codex.calls[0]?.reasoningEffort).toBe('none');
  });

  it('STRATEGY_CODEX_FIRST=0: the fast API first, codex only with what is left', async () => {
    const codex = fake('codex', choose('italian', LONDON_INTRO));
    const openrouter = fake('openrouter', choose('london', LONDON_INTRO));
    const { strategist } = setup([codex, openrouter], {}, { codexFirst: false });
    const strategy = await strategist.chooseStrategy(WHITE, { automation: false });
    expect(strategy).toMatchObject({ provider: 'openrouter', strategyId: 'london', model: 'openai/gpt-5.6-sol', billing: 'paid' });
    expect(openrouter.calls[0]?.model).toBe('openai/gpt-5.6-sol');
    expect(openrouter.calls[0]?.reasoningEffort).toBe('none');
    expect(openrouter.calls[0]?.timeoutMs).toBeLessThanOrEqual(8000);
    expect(codex.calls).toHaveLength(0);
  });

  it('a codex over its usage limit: OpenRouter answers at once («платно»), the next games skip codex, the settings are told', async () => {
    const codex = fake('codex', () => {
      throw new LlmProviderError('codex', 'usage_limit', 'You have hit your usage limit', new Date(Date.now() + 3_600_000));
    });
    const openrouter = fake('openrouter', choose('london', LONDON_INTRO));
    const { strategist, nextGame } = setup([codex, openrouter]);
    const strategy = await strategist.chooseStrategy(WHITE, { automation: false });
    expect(strategy).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-5.6-sol', billing: 'paid' });
    expect(codex.calls).toHaveLength(1);
    // OpenRouter got what codex left: (almost) the whole budget
    expect(openrouter.calls[0]?.timeoutMs).toBeGreaterThan(7_000);
    expect(strategist.codexPause()).toMatchObject({ reason: 'limit' });
    expect(strategist.codexPause()?.until).toBeGreaterThan(Date.now() + 3_500_000);
    nextGame();
    await strategist.chooseStrategy(WHITE, { automation: false });
    expect(codex.calls).toHaveLength(1);
    expect(openrouter.calls).toHaveLength(2);
  });

  it('a logged-out codex is paused too (the settings must not promise the subscription)', async () => {
    const codex = fake('codex', () => {
      throw new LlmProviderError('codex', 'auth', 'Not logged in');
    });
    const openrouter = fake('openrouter', choose('london', LONDON_INTRO));
    const { strategist } = setup([codex, openrouter]);
    expect(strategist.codexPause()).toBeNull();
    expect((await strategist.chooseStrategy(WHITE, { automation: false })).provider).toBe('openrouter');
    expect(strategist.codexPause()?.reason).toBe('login');
  });

  it('a SLOW codex costs one game: the template answers in time, the next games ask OpenRouter first, codex is retried later', async () => {
    // (the strategist's clock must stay the gateway's: the deadline of a call is shared) — only moved on
    let offset = 0;
    let codexAnswers = false;
    const codex = fake('codex', (request) => (codexAnswers ? pickFirst(request) : new Promise(() => undefined))); // hangs, ignores its timeout
    const openrouter = fake('openrouter', choose('london', LONDON_INTRO));
    const timing = { strategyTotalMs: 600, strategyCodexMs: 300, strategyApiMinMs: 400, graceMs: 100, codexSlowPauseMs: 60_000 };
    const { strategist, logs, nextGame } = setup([codex, openrouter], timing, { now: () => Date.now() + offset });
    const startedAt = Date.now();
    const first = await strategist.chooseStrategy(WHITE, { automation: false });
    // codex took its 300 ms (+ the gateway's hard-race grace); too little was left for a paid call → the free template
    expect(first.provider).toBe('template');
    expect(first.billing).toBe('free');
    expect(first.model).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(openrouter.calls).toHaveLength(0);
    expect(strategist.codexPause()?.reason).toBe('slow');
    expect(strategist.codexPause()?.until).toBeGreaterThan(Date.now() + 58_000);
    expect(logs.join('\n')).toMatch(/codex was too slow for the strategy/);
    // the next game: the fast API first, codex not even started
    nextGame();
    expect(strategist.strategyChain()).toEqual(['openrouter', 'template']);
    expect((await strategist.chooseStrategy(WHITE, { automation: false })).provider).toBe('openrouter');
    expect(codex.calls).toHaveLength(1);
    // after the pause codex leads again — and a good answer clears the memory
    offset += 60_001;
    codexAnswers = true;
    nextGame();
    expect(strategist.strategyChain()).toEqual(['codex', 'openrouter', 'template']);
    expect((await strategist.chooseStrategy(WHITE, { automation: false })).provider).toBe('codex');
    expect(strategist.codexPause()).toBeNull();
  });

  it('a slow codex that is the only model is still asked (nothing faster could answer)', async () => {
    const codex = fake('codex', () => new Promise(() => undefined));
    // (nothing after it: codex may use the whole budget — the gateway gives up on it before the strategist does)
    const { strategist, nextGame } = setup([codex], { strategyTotalMs: 700, strategyCodexMs: 200, strategyApiMinMs: 100, graceMs: 400 });
    expect(strategist.strategyChain()).toEqual(['codex', 'template']);
    expect((await strategist.chooseStrategy(WHITE, { automation: false })).provider).toBe('template');
    expect(strategist.codexPause()?.reason).toBe('slow');
    nextGame();
    expect(strategist.strategyChain()).toEqual(['codex', 'template']);
  });

  it('a codex failing late leaves no room for a paid call that could not finish: the template answers', async () => {
    const codex = fake('codex', async () => {
      await sleep(350);
      throw new LlmProviderError('codex', 'failed', 'stream disconnected');
    });
    const openrouter = fake('openrouter', choose('london', LONDON_INTRO));
    const { strategist } = setup([codex, openrouter], { strategyTotalMs: 500, strategyCodexMs: 450, strategyApiMinMs: 300, graceMs: 100 });
    expect((await strategist.chooseStrategy(WHITE, { automation: false })).provider).toBe('template');
    expect(openrouter.calls).toHaveLength(0);
  });

  it('a bad codex answer that ate the paid API\'s room counts as slow; a quick bad answer does not', async () => {
    const timing = { strategyTotalMs: 600, strategyCodexMs: 500, strategyApiMinMs: 300, graceMs: 100, codexSlowPauseMs: 60_000 };
    // late: 350 ms > 600 − 300 → nothing paid could finish after it → the template, and codex waits behind the APIs
    const late = fake('codex', async () => {
      await sleep(350);
      return { strategyId: 'nope', introRu: 'Играем!' };
    });
    const lateApi = fake('openrouter', choose('london', LONDON_INTRO));
    const slow = setup([late, lateApi], timing);
    expect((await slow.strategist.chooseStrategy(WHITE, { automation: false })).provider).toBe('template');
    expect(lateApi.calls).toHaveLength(0);
    expect(slow.strategist.codexPause()?.reason).toBe('slow');
    expect(slow.logs.join('\n')).toMatch(/codex failed \(bad_output\) for the strategy/);
    slow.nextGame();
    expect(slow.strategist.strategyChain()).toEqual(['openrouter', 'template']);
    // quick: OpenRouter still had its time — codex stays first
    const quick = fake('codex', () => ({ strategyId: 'nope', introRu: 'Играем!' }));
    const quickApi = fake('openrouter', choose('london', LONDON_INTRO));
    const fine = setup([quick, quickApi], timing);
    expect((await fine.strategist.chooseStrategy(WHITE, { automation: false })).provider).toBe('openrouter');
    expect(fine.strategist.codexPause()).toBeNull();
    expect(fine.strategist.strategyChain()).toEqual(['codex', 'openrouter', 'template']);
  });

  it('reasoning effort «low» for Sol only when the measured speed leaves room for it within the cap', async () => {
    // a fast codex (a fake: ~0 ms): 0 + 2.4 s fits 80 % of 7.5 s → the second strategy thinks with 'low'
    const fast = fake('codex', pickFirst);
    const openrouter = fake('openrouter', pickFirst);
    const quick = setup([fast, openrouter]);
    await quick.strategist.chooseStrategy(WHITE, { automation: false });
    quick.nextGame();
    await quick.strategist.chooseStrategy(WHITE, { automation: false });
    expect(fast.calls.map((c) => c.reasoningEffort)).toEqual(['none', 'low']);
    // Sol as measured on a development Mac (≈ 7 s with 'none'): 7 + 2.4 s never fits 7.5 s → always 'none'
    const slow = fake('codex', async (request) => {
      await sleep(120);
      return pickFirst(request);
    });
    const measured = setup([slow, fake('openrouter', pickFirst)], { strategyCodexMs: 2_600 });
    for (let game = 0; game < 3; game += 1) {
      await measured.strategist.chooseStrategy(WHITE, { automation: false });
      measured.nextGame();
    }
    expect(slow.calls.map((c) => c.reasoningEffort)).toEqual(['none', 'none', 'none']);
  });

  it('a «low» attempt that ran out of time: the next games ask with «none» again', async () => {
    // (codex alone: nothing faster exists, so it stays first; its own timeout comes back as a 'timeout' error)
    const codex = fake('codex', (request) => {
      if (request.reasoningEffort === 'low') throw new LlmProviderError('codex', 'timeout', 'codex did not answer within 7500 ms');
      return pickFirst(request);
    });
    const { strategist, nextGame } = setup([codex]);
    const providers: string[] = [];
    for (let game = 0; game < 3; game += 1) {
      providers.push((await strategist.chooseStrategy(WHITE, { automation: false })).provider);
      nextGame();
    }
    expect(codex.calls.map((c) => c.reasoningEffort)).toEqual(['none', 'low', 'none']);
    expect(providers).toEqual(['codex', 'template', 'codex']);
  });

  it('the OpenAI API answers when codex and OpenRouter cannot', async () => {
    const codex = fake('codex', () => {
      throw new LlmProviderError('codex', 'auth', 'Not logged in');
    });
    const openrouter = fake('openrouter', () => {
      throw new LlmProviderError('openrouter', 'rejected', 'OpenRouter answered 404');
    });
    const api = fake('openai-api', choose('london', LONDON_INTRO));
    const { strategist } = setup([codex, openrouter, api]);
    const strategy = await strategist.chooseStrategy(WHITE, { automation: false });
    expect(strategy.provider).toBe('openai-api');
    expect(api.calls[0]?.model).toBe('gpt-5.6-sol');
  });

  it('an invalid choice or phrase moves on (no retry) and ends with the deterministic template', async () => {
    const codex = fake('codex', () => ({ strategyId: 'queens-gambit', introRu: 'В этот раз разыграем Ферзевый гамбит. Начни пешкой на дэ четыре.' })); // stage 3 card
    const openrouter = fake('openrouter', choose('london', 'В этот раз играем London System! Начни пешкой на дэ четыре.'));
    const api = fake('openai-api', choose('london', 'Лондонская система: слон на цэ четыре и пешка на дэ четыре.')); // a square nobody gave it
    const { strategist, logs } = setup([codex, openrouter, api]);
    const strategy = await strategist.chooseStrategy(WHITE, { automation: false });
    expect(strategy.provider).toBe('template');
    expect([codex.calls.length, openrouter.calls.length, api.calls.length]).toEqual([1, 1, 1]);
    // the free choice: the first never-played card of the library, with its template intro
    expect(strategy.strategyId).toBe('italian');
    // the template names the piece, never the square (docs/TEACHING.md §0): the board shows it
    expect(strategy.introRu).toBe('В этот раз разыграем Итальянскую партию — быстро выводим фигуры и целимся в слабую точку. Начни пешкой.');
    const log = logs.join('\n');
    expect(log).toContain('strategyId is not one of the candidates');
    expect(log).toContain('Latin letters');
    expect(log).toContain('names squares nobody allowed: c4');
  });

  it('rejects clock talk and over-long intros', async () => {
    const codex = fake('codex', choose('london', 'У тебя десять минут, так что разыграем Лондонскую систему. Начни пешкой на дэ четыре.'));
    const openrouter = fake('openrouter', choose('london', `${'Очень '.repeat(20)}длинно. Начни пешкой на дэ четыре.`));
    const { strategist, logs } = setup([codex, openrouter]);
    expect((await strategist.chooseStrategy(WHITE, { automation: false })).provider).toBe('template');
    expect(logs.join('\n')).toContain('the clock / time');
    expect(logs.join('\n')).toMatch(/2\d words \(max 20\)/);
  });

  it('adds the first move when the model leaves it out', async () => {
    const codex = fake('codex', choose('italian', 'В этот раз разыграем Итальянскую партию — целимся в слабую точку!'));
    const { strategist } = setup([codex]);
    const strategy = await strategist.chooseStrategy(WHITE, { automation: false });
    expect(strategy.provider).toBe('codex');
    expect(strategy.introRu).toBe('В этот раз разыграем Итальянскую партию — целимся в слабую точку! Начни пешкой на е четыре.');
  });

  it('a silent provider costs at most the budget: the template answers in time', async () => {
    const codex = fake('codex', () => new Promise(() => undefined)); // never answers, ignores its timeout
    const { strategist } = setup([codex], { strategyTotalMs: 300, strategyApiMinMs: 100, graceMs: 100 });
    const startedAt = Date.now();
    const strategy = await strategist.chooseStrategy(WHITE, { automation: false });
    expect(strategy.provider).toBe('template');
    expect(Date.now() - startedAt).toBeLessThan(1500);
    // the next request is not stuck behind the hung one either
    const again = Date.now();
    expect((await strategist.chooseStrategy(WHITE, { automation: false })).provider).toBe('template');
    expect(Date.now() - again).toBeLessThan(1500);
  });

  it('automated runs get the template: no provider call, the history untouched', async () => {
    const codex = fake('codex', choose('london', LONDON_INTRO));
    const { strategist, history } = setup([codex]);
    const strategy = await strategist.chooseStrategy(WHITE, { automation: true });
    expect(strategy.provider).toBe('template');
    expect(strategy.strategyId).toBe('italian');
    expect(codex.calls).toHaveLength(0);
    expect(history.recent()).toEqual([]);
  });

  it('every game a different strategy: the last three are never offered while there is an alternative', async () => {
    const { strategist, nextGame } = setup([]); // template only
    const served: string[] = [];
    for (let game = 0; game < 6; game += 1) {
      served.push((await strategist.chooseStrategy(WHITE, { automation: false })).strategyId);
      nextGame();
    }
    expect(served).toEqual(['italian', 'four-knights', 'london', 'bishops-opening', 'colle', 'italian']);
    for (let i = 1; i < served.length; i += 1) expect(served.slice(Math.max(0, i - 3), i)).not.toContain(served[i]);
  });

  it('two quick games in a row (a loss and an immediate rematch): three different strategies, also with a Black game between', async () => {
    const { strategist, quickRematch } = setup([]); // template only
    const white1 = (await strategist.chooseStrategy(WHITE, { automation: false })).strategyId;
    quickRematch();
    const white2 = (await strategist.chooseStrategy(WHITE, { automation: false })).strategyId;
    quickRematch();
    const black = (await strategist.chooseStrategy({ ...WHITE, childColor: 'b', opponentFirstUci: 'e2e4' }, { automation: false })).strategyId;
    quickRematch();
    const white3 = (await strategist.chooseStrategy(WHITE, { automation: false })).strategyId;
    expect(new Set([white1, white2, white3]).size).toBe(3);
    expect(content.strategyLibrary.byId(black)?.side).toBe('b');
  });

  it('Black against 1.b3 (the bots do that): a different plan in each of three games, not «Классическое развитие» every time', async () => {
    const { strategist, quickRematch } = setup([]);
    const served: string[] = [];
    const firstMoves: string[] = [];
    for (let game = 0; game < 3; game += 1) {
      const strategy = await strategist.chooseStrategy({ ...WHITE, childColor: 'b', opponentFirstUci: 'b2b3' }, { automation: false });
      served.push(strategy.strategyId);
      firstMoves.push(strategy.introRu.split('Ответь ')[1] ?? '');
      quickRematch();
    }
    expect(new Set(served).size).toBe(3);
    expect(served.every((id) => content.strategyLibrary.byId(id)?.against === 'other')).toBe(true);
    expect(new Set(firstMoves).size).toBeGreaterThanOrEqual(2);
  });

  it('Black against 1.c4: never the classic 1…d5 (engine: 70 cp behind 1…e5)', async () => {
    const { strategist, nextGame } = setup([]);
    for (let game = 0; game < 4; game += 1) {
      const strategy = await strategist.chooseStrategy({ ...WHITE, childColor: 'b', stage: 3, opponentFirstUci: 'c2c4' }, { automation: false });
      expect(strategy.strategyId).not.toBe('classic-development');
      nextGame();
    }
  });

  it('the model only sees fresh cards', async () => {
    const codex = fake('codex', (request) => ({ strategyId: enumOf(request, 'strategyId')[0], introRu: 'Играем по плану!' }));
    const { strategist, nextGame } = setup([codex]);
    const first = await strategist.chooseStrategy(WHITE, { automation: false });
    nextGame();
    await strategist.chooseStrategy(WHITE, { automation: false });
    expect(enumOf(codex.calls[1] as LlmRequest, 'strategyId')).not.toContain(first.strategyId);
  });

  it('Black: the intro names the reply to the opponent’s first move — or no move while it is unknown', async () => {
    const { strategist, nextGame } = setup([]);
    const vsE4 = await strategist.chooseStrategy({ ...WHITE, childColor: 'b', opponentFirstUci: 'e2e4' }, { automation: false });
    const card = content.strategyLibrary.byId(vsE4.strategyId);
    expect(card?.side).toBe('b');
    expect(card?.against).toBe('e4');
    expect(vsE4.introRu).toMatch(/^В этот раз разыграем .+ Ответь (пешкой|конём)\.$/u);
    expect(namesNoSquare(vsE4.introRu)).toBe(true);
    nextGame();
    const unknown = await strategist.chooseStrategy({ ...WHITE, childColor: 'b' }, { automation: false });
    expect(content.strategyLibrary.byId(unknown.strategyId)?.side).toBe('b');
    expect(unknown.introRu).not.toMatch(/Начни/u);
  });
});

describe('POST /coach/replan', () => {
  // 1.e4 e5 2.Nf3 Nc6 3.Bc4 h6 — the opponent left the Italian plan (docs/TEACHER-MODE.md E8)
  const REPLAN: ReplanRequest = {
    ply: 7,
    fen: 'r1bqkbnr/pppp1pp1/2n4p/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
    childColor: 'w',
    strategyId: 'italian',
    movesSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6'],
    candidates: [
      { uci: 'd2d4', san: 'd4', cp: 65, ideasRu: ['ставит пешку в центр и нападает на пешку на е пять'] },
      { uci: 'e1g1', san: 'O-O', cp: 53, ideasRu: ['рокировка: король прячется в домик, а ладья выходит в игру'] },
      { uci: 'c2c3', san: 'c3', cp: 35, ideasRu: ['готовит пешке дорогу в центр'] },
    ],
    stage: 1,
  };
  const GOOD = { planRu: 'Прячем короля и готовим удар по центру.', preferredUci: 'e1g1', whyRu: 'Король уходит в домик, а ладья выходит в игру.' };

  it('OpenRouter re-plans with one of the engine’s candidates', async () => {
    const openrouter = fake('openrouter', () => GOOD);
    const { strategist, logs } = setup([openrouter]);
    const answer = await strategist.replan(REPLAN, { automation: false });
    expect(answer).toEqual({ ply: 7, ...GOOD, provider: 'openrouter' });
    const call = openrouter.calls[0] as LlmRequest;
    expect(call.model).toBe('openai/gpt-5.6-sol');
    expect(call.timeoutMs).toBeLessThanOrEqual(15_000);
    expect(call.reasoningEffort).toBe('none');
    expect(enumOf(call, 'preferredUci')).toEqual(['d2d4', 'e1g1', 'c2c3']);
    expect(call.prompt).toContain('короткая рокировка');
    // the plan outlives its ply (the teacher uses it from the next turn): a general plan, not the move itself
    expect(call.prompt).toContain('общий план, а не один ход');
    expect(call.prompt).toContain('Итальянская партия');
    expect(call.prompt).toContain('"стадия":"дебют"');
    expect(logs.join('\n')).toMatch(/\[strategist\] replan ply 7 \(italian\) via openrouter in \d+ ms \(3 candidates\)/);
  });

  it('a move that is not a candidate, or a plan naming another square, falls back to the first candidate', async () => {
    const codex = fake('codex', () => ({ ...GOOD, preferredUci: 'a2a4' }));
    const openrouter = fake('openrouter', () => ({ ...GOOD, planRu: 'Потом конь прыгает на же пять.' }));
    const { strategist, logs } = setup([codex, openrouter]);
    const answer = await strategist.replan(REPLAN, { automation: false });
    expect(answer).toEqual({
      ply: 7,
      // the strategy goes on: its goal that names the move — without the square (the arrow shows it)
      planRu: 'Готовим удар пешкой.',
      preferredUci: 'd2d4',
      whyRu: 'Ставит пешку в центр и нападает на пешку.',
      provider: 'template',
    });
    expect(logs.join('\n')).toContain('preferredUci is not one of the candidates');
    expect(logs.join('\n')).toContain('names squares nobody allowed: g5');
  });

  it('the opponent’s last move and the chosen move’s ideas may be named', async () => {
    const openrouter = fake('openrouter', () => ({ planRu: 'Пешка аш шесть не мешает: бьём в центр.', preferredUci: 'd2d4', whyRu: 'Пешка на дэ четыре нападает на пешку на е пять.' }));
    const { strategist } = setup([openrouter]);
    expect((await strategist.replan(REPLAN, { automation: false })).provider).toBe('openrouter');
  });

  it('only legal candidates count; none → no move, no model', async () => {
    const openrouter = fake('openrouter', () => GOOD);
    const { strategist } = setup([openrouter]);
    const junk = { uci: 'e2e5', san: 'e5', cp: 999, ideasRu: ['выигрывает всё'] };
    const answer = await strategist.replan({ ...REPLAN, candidates: [junk, ...REPLAN.candidates, REPLAN.candidates[0] ?? junk] }, { automation: true });
    expect(answer.preferredUci).toBe('d2d4');
    await strategist.replan({ ...REPLAN, candidates: [junk, ...REPLAN.candidates] }, { automation: false });
    expect(enumOf(openrouter.calls[0] as LlmRequest, 'preferredUci')).toEqual(['d2d4', 'e1g1', 'c2c3']);
    const empty = await strategist.replan({ ...REPLAN, candidates: [junk] }, { automation: false });
    expect(empty).toMatchObject({ preferredUci: null, provider: 'template', whyRu: 'Я проверил: это крепкий ход.' });
    expect(openrouter.calls).toHaveLength(1);
  });

  it('refuses an impossible position', async () => {
    const { strategist } = setup([]);
    await expect(strategist.replan({ ...REPLAN, fen: '8/8/8/8/8/8/8/8 w - - 0 1' }, { automation: false })).rejects.toBeInstanceOf(StrategistInputError);
  });

  it('automated runs never call a model', async () => {
    const codex = fake('codex', () => GOOD);
    const { strategist } = setup([codex]);
    expect((await strategist.replan(REPLAN, { automation: true })).provider).toBe('template');
    expect(codex.calls).toHaveLength(0);
  });

  it('latest wins: a re-plan superseded while it waited is answered from the template, unbilled', async () => {
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const codex = fake('codex', async (request) => {
      if (request.schemaName === 'game_strategy') {
        await blocker;
        return { strategyId: enumOf(request, 'strategyId')[0], introRu: 'Играем по плану!' };
      }
      return GOOD;
    });
    const { strategist } = setup([codex]);
    const busy = strategist.chooseStrategy(WHITE, { automation: false }); // occupies the interactive lane
    const older = strategist.replan({ ...REPLAN, ply: 7 }, { automation: false });
    const newer = strategist.replan({ ...REPLAN, ply: 9 }, { automation: false });
    release();
    await busy;
    const [a, b] = await Promise.all([older, newer]);
    expect(a).toMatchObject({ ply: 7, provider: 'template' });
    expect(b).toMatchObject({ ply: 9, provider: 'codex' });
    expect(codex.calls.filter((c) => c.schemaName === 'game_replan')).toHaveLength(1);
  });

  it('a new game\'s strategy supersedes the last game\'s re-plans still waiting in the lane (they cost it its budget)', async () => {
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const codex = fake('codex', async (request) => {
      if (request.schemaName === 'game_replan') {
        await blocker;
        return GOOD;
      }
      return pickFirst(request);
    });
    const { strategist } = setup([codex]);
    const running = strategist.replan({ ...REPLAN, ply: 7 }, { automation: false }); // occupies the interactive lane
    while (codex.calls.length === 0) await sleep(1);
    const waiting = strategist.replan({ ...REPLAN, ply: 9 }, { automation: false });
    const rematch = strategist.chooseStrategy(WHITE, { automation: false });
    release();
    const [a, b, strategy] = await Promise.all([running, waiting, rematch]);
    expect(a).toMatchObject({ ply: 7, provider: 'codex' });
    // the waiting re-plan of the finished game: its template, no call
    expect(b).toMatchObject({ ply: 9, provider: 'template' });
    expect(codex.calls.filter((c) => c.schemaName === 'game_replan')).toHaveLength(1);
    expect(strategy.provider).toBe('codex');
  });

  it('a strategy that waited behind a RUNNING re-plan: a codex timeout of its shortened attempt is not «slow»', async () => {
    const codex = fake('codex', async (request) => {
      if (request.schemaName === 'game_replan') {
        await sleep(900); // the last game's re-plan is already running: a new strategy does not abandon it
        return GOOD;
      }
      return new Promise(() => undefined); // the strategy: hangs, ignores its timeout
    });
    const openrouter = fake('openrouter', choose('london', LONDON_INTRO));
    const timing = { strategyTotalMs: 1_600, strategyCodexMs: 1_400, strategyApiMinMs: 400, graceMs: 100, codexSlowPauseMs: 60_000 };
    const { strategist, logs } = setup([codex, openrouter], timing);
    const running = strategist.replan({ ...REPLAN, ply: 7 }, { automation: false });
    while (codex.calls.length === 0) await sleep(1);
    const strategy = await strategist.chooseStrategy(WHITE, { automation: false });
    expect(strategy.provider).toBe('template');
    await running;
    await sleep(400); // the gateway's report of the abandoned codex attempt
    const attempt = codex.calls.find((c) => c.schemaName === 'game_strategy');
    expect(attempt?.timeoutMs).toBeLessThan(1_000); // it got what was left of the 1.6 s, not its 1.4 s
    // the owner's subscription still leads the next game: not 30 minutes of paid OpenRouter
    expect(strategist.codexPause()).toBeNull();
    expect(strategist.strategyChain()).toEqual(['codex', 'openrouter', 'template']);
    expect(logs.join('\n')).toMatch(/codex ran out of a shortened strategy attempt/);
  });

  it('does not wait behind a game review running on the background lane', async () => {
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const codex = fake('codex', async (request) => {
      if (request.schemaName === 'game_review') await blocker;
      return GOOD;
    });
    const { strategist, gateway } = setup([codex]);
    const review = gateway.generateJson({ kind: 'strategy', fallback: { strategyId: 'x', introRu: 'x' } }, 'review', {}, { validate: (d) => d, schemaName: 'game_review', timeoutMs: 60_000 });
    const answer = await strategist.replan(REPLAN, { automation: false });
    expect(answer.provider).toBe('codex');
    release();
    await review;
  });
});

describe('deterministic phrases', () => {
  it('build the intro as «В этот раз разыграем …», within 20 words — and never a square', () => {
    for (const card of content.strategyLibrary.cards) {
      const intro = templateIntroRu(card, card.side === 'w' ? content.sanToSpokenRu(card.lineSan[0] ?? '') : null);
      expect(spokenProblem(intro, { maxWords: 20 }), `${card.id}: ${intro}`).toBeNull();
      expect(intro.startsWith('В этот раз разыграем'), intro).toBe(true);
      expect(namesNoSquare(intro), `${card.id}: ${intro}`).toBe(true);
      // Black: the answer to the opponent's first move, also without its square
      const reply = card.side === 'b' ? templateIntroRu(card, content.sanToSpokenRu(card.lineSan[1] ?? card.lineSan[0] ?? ''), 'b') : intro;
      expect(namesNoSquare(reply), `${card.id}: ${reply}`).toBe(true);
    }
    // an idea that says nothing without its square is left out, the title stays
    const bishops = content.strategyLibrary.byId('bishops-opening');
    if (bishops !== undefined) expect(templateIntroRu(bishops, 'слон на цэ четыре')).toBe('В этот раз разыграем Дебют слона. Начни слоном.');
    const scotch = content.strategyLibrary.byId('scotch');
    if (scotch !== undefined) expect(templateIntroRu(scotch, 'пешка на е четыре')).toBe('В этот раз разыграем Шотландскую партию — сразу бьёмся за центр пешкой. Начни пешкой.');
    expect(startWithRu('конь на эф три')).toBe('Начни конём.');
    expect(startWithRu('пешка на дэ пять', 'b')).toBe('Ответь пешкой.');
    expect(startWithRu('конь с бэ один на дэ два')).toBe('Начни конём.');
    expect(startWithRu('короткая рокировка')).toBe('Первый ход — короткая рокировка.');
    expect(startWithRu('на дэ четыре')).toBe('Первый ход покажет стрелка.');
  });

  it('squareFreeRu: the phrase without its squares, or null when it would say nothing then', () => {
    expect(squareFreeRu('ладья встаёт на е один и помогает центру')).toBe('ладья встаёт и помогает центру');
    expect(squareFreeRu('держим центр пешками цэ три и дэ три')).toBe('держим центр пешками');
    expect(squareFreeRu('строим крепость пешками дэ четыре, е три и цэ три')).toBe('строим крепость пешками');
    expect(squareFreeRu('выводим слона на эф четыре раньше пешки е три')).toBe('выводим слона раньше пешки');
    expect(squareFreeRu('целимся слоном в слабую точку эф семь')).toBe('целимся слоном в слабую точку');
    expect(squareFreeRu('бьём по цепочке пешек ударом цэ пять')).toBe('бьём по цепочке пешек ударом пешки');
    expect(squareFreeRu('слон встаёт на е семь, король уходит в домик')).toBe('слон встаёт, король уходит в домик');
    expect(squareFreeRu('конь освобождает дорогу пешке эф')).toBe('конь освобождает дорогу пешке');
    expect(squareFreeRu('пешка же пять начинает атаку')).toBe('пешка начинает атаку');
    expect(squareFreeRu('Выводит коня и нападает на пешку на е пять.', 2)).toBe('Выводит коня и нападает на пешку.');
    // nothing left to say without the square, or a file named by its letter
    expect(squareFreeRu('ладья встаёт на е один')).toBeNull();
    expect(squareFreeRu('держим клетку е четыре стеной из пешек')).toBeNull();
    expect(squareFreeRu('слон выходит первым и сразу смотрит на эф семь')).toBeNull();
    expect(squareFreeRu('пешка цэ три готовит дэ четыре')).toBeNull();
    expect(squareFreeRu('давим ладьёй по линии цэ')).toBeNull();
    // no square at all: as it is
    expect(squareFreeRu('быстро выводим все фигуры')).toBe('быстро выводим все фигуры');
    expect(squareFreeRu('а два хода подряд')).toBe('а два хода подряд');
    // every line of the library that is kept names no square
    for (const card of content.strategyLibrary.cards) {
      for (const line of [card.ideaRu, ...card.middlegameRu, ...(card.planGoalsRu ?? [])]) {
        const plain = squareFreeRu(line);
        if (plain !== null) expect(namesNoSquare(plain), `${card.id}: ${line} → ${plain}`).toBe(true);
      }
    }
  });

  it('re-plan phrases come from the card\'s goals / middlegame ideas or the principles of the phase — without squares', () => {
    const italian = content.strategyLibrary.byId('italian');
    // the opponent left the road in the opening: the strategy's goals go on («давим на цепочку пешек ударом c5»)
    expect(templatePlanRu(italian, 'дебют')).toBe('Целимся слоном в слабую точку.');
    expect(templatePlanRu(italian, 'дебют', 'd4')).toBe('Готовим удар пешкой.');
    expect(templatePlanRu(content.strategyLibrary.byId('french'), 'дебют', 'c5')).toBe('Бьём по цепочке пешек ударом пешки.');
    // the goal that names the move WITH its piece: the knight jump for Ne4, never the knight's goal for a pawn on e4
    const dutch = content.strategyLibrary.byId('dutch-stonewall');
    expect(templatePlanRu(dutch, 'дебют', 'Ne4')).toBe('Прыгаем конём.');
    // «держим клетку е четыре» says nothing without its square: the next goal
    expect(templatePlanRu(dutch, 'дебют', 'e5')).toBe('Ведём ферзя и ладью в атаку на короля.');
    expect(templatePlanRu(content.strategyLibrary.byId('open-game'), 'дебют', 'O-O')).toBe('Прячем короля рокировкой.');
    // a move no goal names: the goals in order
    expect(templatePlanRu(content.strategyLibrary.byId('french'), 'дебют', 'Be7')).toBe('Бьём по цепочке пешек ударом пешки.');
    // …but only what the board shows: after 1.e4 e6 2.d3 there is no chain to strike — the principles
    const offRoad = { fen: 'rnbqkbnr/pppp1ppp/4p3/8/4P3/3P4/PPP2PPP/RNBQKBNR b KQkq - 0 2', color: 'b' as const };
    expect(templatePlanRu(content.strategyLibrary.byId('french'), 'дебют', 'c5', offRoad)).toBe('Выводим фигуры, держим центр и прячем короля.');
    const mainLine = { fen: 'rnbqkbnr/ppp2ppp/4p3/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq - 0 3', color: 'b' as const };
    expect(templatePlanRu(content.strategyLibrary.byId('french'), 'дебют', 'c5', mainLine)).toBe('Бьём по цепочке пешек ударом пешки.');
    expect(templatePlanRu(italian, 'миттельшпиль')).toBe('Ладья встаёт и помогает центру.');
    // in the middlegame too the goal naming the advised move comes before the card's general ideas
    expect(templatePlanRu(italian, 'миттельшпиль', 'd4')).toBe('Готовим удар пешкой.');
    expect(templatePlanRu(dutch, 'миттельшпиль', 'Ne4')).toBe('Прыгаем конём.');
    expect(templatePlanRu(italian, 'эндшпиль')).toBe('Король идёт вперёд, а пешки бегут в ферзи.');
    expect(templatePlanRu(undefined, 'дебют')).toBe('Выводим фигуры, держим центр и прячем короля.');
    expect(templatePlanRu(undefined, 'эндшпиль')).toBe('Король идёт вперёд, а пешки бегут в ферзи.');
    expect(templateWhyRu(['move with Latin', 'выводит коня'])).toBe('Выводит коня.');
    expect(templateWhyRu(['нападает на пешку на е пять'])).toBe('Нападает на пешку.');
    expect(templateWhyRu(['идёт на е пять', 'готовит рокировку'])).toBe('Готовит рокировку.');
    expect(templateWhyRu([])).toBe('Я проверил: это крепкий ход.');
    // every card × phase × its own moves: never a square
    for (const card of content.strategyLibrary.cards) {
      for (const phase of ['дебют', 'миттельшпиль', 'эндшпиль'] as const) {
        for (const san of [undefined, ...card.lineSan]) {
          const plan = templatePlanRu(card, phase, san);
          expect(namesNoSquare(plan), `${card.id} ${phase} ${san ?? ''}: ${plan}`).toBe(true);
        }
      }
    }
  });
});
