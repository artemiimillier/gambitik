/**
 * POST /api/coach/strategy and /api/coach/replan through the whole app (security middleware, zod,
 * kv history) on a throw-away DATA_DIR. Providers are fakes; nothing leaves the machine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { GameStrategy, HealthInfo, ReplanRequest, ReplanResponse, StrategyRequest } from '@gambit/shared';
import { createTemplateProvider } from '../llm/providers/template.ts';
import { LlmProviderError } from '../llm/types.ts';
import type { LlmProvider, LlmRequest } from '../llm/types.ts';
import { gameStrategySchema, replanResponseSchema } from '../schemas.ts';
import { namesNoSquare } from '../strategist/strategist.ts';
import { spokenProblem } from '../strategist/text.ts';
import { createTestServer } from '../testing/fixtures.ts';
import type { TestServer } from '../testing/fixtures.ts';

const servers: TestServer[] = [];
async function start(...args: Parameters<typeof createTestServer>): Promise<TestServer> {
  const server = await createTestServer(...args);
  servers.push(server);
  return server;
}
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.cleanup();
});

const WHITE: StrategyRequest = { childColor: 'w', stage: 1, personaId: 'petya', timeControlId: 'rapid10' };
const REPLAN: ReplanRequest = {
  ply: 7,
  fen: 'r1bqkbnr/pppp1pp1/2n4p/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
  childColor: 'w',
  strategyId: 'italian',
  movesSan: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6'],
  candidates: [
    { uci: 'd2d4', san: 'd4', cp: 65, ideasRu: ['ставит пешку в центр и нападает на пешку на е пять'] },
    { uci: 'e1g1', san: 'O-O', cp: 53, ideasRu: ['рокировка: король прячется в домик'] },
  ],
  stage: 1,
};

const template = (): LlmProvider => createTemplateProvider({ templateReview: null, motifTitleRu: (m) => m, themeTitleRu: (t) => t, defaultTheme: () => 'fork' });

function fakeCodex(answer: (request: LlmRequest) => unknown): LlmProvider & { calls: LlmRequest[] } {
  const provider = {
    id: 'codex' as const,
    calls: [] as LlmRequest[],
    isConfigured: () => true,
    generate: async (request: LlmRequest) => {
      provider.calls.push(request);
      return answer(request);
    },
  };
  return provider;
}

describe('POST /api/coach/strategy', () => {
  it('answers from the free template without any model and remembers the strategy', async () => {
    const server = await start();
    const res = await server.request('/api/coach/strategy', { method: 'POST', json: WHITE });
    expect(res.status).toBe(200);
    const strategy = gameStrategySchema.parse(await res.json()) as GameStrategy;
    expect(strategy.provider).toBe('template');
    expect(spokenProblem(strategy.introRu, { maxWords: 20 })).toBeNull();
    expect(strategy.introRu).toMatch(/^В этот раз разыграем .+ Начни (пешкой|конём|слоном)\.$/u);
    // the voice never names a square (docs/TEACHING.md §0): the piece and the idea, the board shows where
    expect(strategy.introRu).not.toMatch(/(?<![а-яё])(а|бэ|цэ|дэ|е|эф|же|аш) (один|два|три|четыре|пять|шесть|семь|восемь)(?![а-яё])/u);
    expect(server.ctx.repo.loadStrategyHistoryRaw()).toMatchObject({ ids: [strategy.strategyId] });
  });

  it('uses the smart model when there is one — but never for an automated run', async () => {
    const codex = fakeCodex((request) => {
      const ids = (request.jsonSchema.properties as { strategyId: { enum: string[] } }).strategyId.enum;
      return { strategyId: ids.includes('london') ? 'london' : ids[0], introRu: 'В этот раз разыграем Лондонскую систему — строим крепость. Начни пешкой на дэ четыре.' };
    });
    const server = await start({ runtimeAi: true, codexStrategyModel: 'gpt-5.6-sol' }, { providers: [codex, template()] });
    const automated = (await (await server.request('/api/coach/strategy', { method: 'POST', json: WHITE, headers: { 'x-gambit-automation': '1' } })).json()) as GameStrategy;
    expect(automated.provider).toBe('template');
    expect(codex.calls).toHaveLength(0);
    expect(server.ctx.repo.loadStrategyHistoryRaw()).toBeUndefined();

    const smart = (await (await server.request('/api/coach/strategy', { method: 'POST', json: WHITE })).json()) as GameStrategy;
    expect(smart).toMatchObject({ strategyId: 'london', titleRu: 'Лондонская система', provider: 'codex' });
    expect(codex.calls[0]?.model).toBe('gpt-5.6-sol');
  });

  it('answers within the budget when the model hangs', async () => {
    const codex = fakeCodex(() => new Promise(() => undefined));
    const server = await start({ runtimeAi: true }, { providers: [codex, template()], strategistTiming: { strategyTotalMs: 300, graceMs: 100 } });
    const startedAt = Date.now();
    const strategy = (await (await server.request('/api/coach/strategy', { method: 'POST', json: WHITE })).json()) as GameStrategy;
    expect(strategy.provider).toBe('template');
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('a codex over its limit: the strategy says «платно» (OpenRouter) and GET /api/health no longer promises the subscription', async () => {
    const limited = fakeCodex(() => {
      throw new LlmProviderError('codex', 'usage_limit', 'You have hit your usage limit', new Date(Date.now() + 3_600_000));
    });
    const codex = { ...limited, status: async () => ({ cli: true, loggedIn: true }), dispose: () => undefined };
    const openrouter: LlmProvider = { id: 'openrouter', isConfigured: () => true, generate: async (request) => ({ strategyId: (request.jsonSchema.properties as { strategyId: { enum: string[] } }).strategyId.enum[0], introRu: 'Играем по плану!' }) };
    const server = await start({ runtimeAi: true, openrouterStrategyModel: 'openai/gpt-5.6-sol' }, { providers: [codex, openrouter, template()], codex });
    const before = (await (await server.request('/api/health')).json()) as HealthInfo;
    expect(before.llm.codexPaused).toBeUndefined();
    const strategy = gameStrategySchema.parse(await (await server.request('/api/coach/strategy', { method: 'POST', json: WHITE })).json()) as GameStrategy;
    expect(strategy).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-5.6-sol', billing: 'paid' });
    const after = (await (await server.request('/api/health')).json()) as HealthInfo;
    expect(after.llm.codexPaused?.reason).toBe('limit');
    expect(after.llm.codexPaused?.until).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it('runtime AI off (the default): GET /api/health never asks codex (no `codex login status`) and promises nothing of it', async () => {
    let statusCalls = 0;
    const codex = { ...fakeCodex(() => ({})), status: async () => ((statusCalls += 1), { cli: true, loggedIn: true }), dispose: () => undefined };
    const server = await start({}, { codex });
    const health = (await (await server.request('/api/health')).json()) as HealthInfo;
    expect(statusCalls).toBe(0);
    expect(health.llm).toMatchObject({ codexCli: false, codexLoggedIn: false });
    expect(health.llm.codexPaused).toBeUndefined();
    expect(health.ai).toEqual({ runtime: false });
    // the strategy is the template, and the history still gives the next game another card
    const first = (await (await server.request('/api/coach/strategy', { method: 'POST', json: WHITE })).json()) as GameStrategy;
    const second = (await (await server.request('/api/coach/strategy', { method: 'POST', json: WHITE })).json()) as GameStrategy;
    expect([first.provider, second.provider]).toEqual(['template', 'template']);
    expect(second.strategyId).not.toBe(first.strategyId);
    expect(namesNoSquare(first.introRu) && namesNoSquare(second.introRu)).toBe(true);
  });

  it('validates the body', async () => {
    const server = await start();
    for (const body of [{ ...WHITE, childColor: 'x' }, { ...WHITE, stage: 0 }, { ...WHITE, personaId: 'magnus' }, { ...WHITE, opponentFirstUci: 'e4' }, { childColor: 'w' }]) {
      const res = await server.request('/api/coach/strategy', { method: 'POST', json: body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid-body' });
    }
    // JSON only (security.ts)
    expect((await server.request('/api/coach/strategy', { method: 'POST', body: JSON.stringify(WHITE), headers: { 'content-type': 'text/plain' } })).status).toBe(415);
  });
});

describe('POST /api/coach/replan', () => {
  it('echoes the ply and picks one of the candidates', async () => {
    const server = await start();
    const res = await server.request('/api/coach/replan', { method: 'POST', json: REPLAN });
    expect(res.status).toBe(200);
    const answer = replanResponseSchema.parse(await res.json()) as ReplanResponse;
    expect(answer).toMatchObject({ ply: 7, preferredUci: 'd2d4', provider: 'template' });
    expect(spokenProblem(answer.planRu, { maxWords: 15 })).toBeNull();
    expect(spokenProblem(answer.whyRu, { maxWords: 15 })).toBeNull();
    // the template names no square: «Готовим удар пешкой.», «Ставит пешку в центр и нападает на пешку.»
    expect(answer).toMatchObject({ planRu: 'Готовим удар пешкой.', whyRu: 'Ставит пешку в центр и нападает на пешку.' });
    expect(namesNoSquare(answer.planRu) && namesNoSquare(answer.whyRu)).toBe(true);
  });

  it('refuses impossible positions and oversized requests', async () => {
    const server = await start();
    const noKings = await server.request('/api/coach/replan', { method: 'POST', json: { ...REPLAN, fen: '8/8/8/8/8/8/8/8 w - - 0 1' } });
    expect(noKings.status).toBe(400);
    expect(await noKings.json()).toEqual({ error: 'invalid-body' });
    const many = Array.from({ length: 9 }, () => REPLAN.candidates[0]);
    expect((await server.request('/api/coach/replan', { method: 'POST', json: { ...REPLAN, candidates: many } })).status).toBe(400);
    expect((await server.request('/api/coach/replan', { method: 'POST', json: { ...REPLAN, strategyId: '../x' } })).status).toBe(400);
    expect((await server.request('/api/coach/replan', { method: 'POST', json: { ...REPLAN, fen: '<b>bold</b>' } })).status).toBe(400);
  });
});
