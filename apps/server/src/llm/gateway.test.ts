import { describe, expect, it } from 'vitest';
import { LlmGateway, providerChain } from './gateway.ts';
import { JobQueue } from './queue.ts';
import { REVIEW_JSON_SCHEMA, parseReviewOutput } from './reviewSchema.ts';
import { LlmProviderError } from './types.ts';
import type { LlmProvider, LlmRequest, LlmTask, ProviderId } from './types.ts';

const TASK: LlmTask = { kind: 'rephrase', event: { id: 'e', kind: 'praise', priority: 0, text: 'Молодец', bubbleText: 'Молодец', pose: 'cheer', pauseClock: false } };
const GOOD = { markdown: 'Очень внимательная партия, так держать!', keyTakeaways: ['Проверяй защиту'], suggestedTheme: 'fork' };
const OPTIONS = { validate: parseReviewOutput, schemaName: 'game_review', timeoutMs: 1000 };

function provider(id: ProviderId, behaviour: () => Promise<unknown>, configured = true): LlmProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    isConfigured: () => configured,
    generate: () => {
      p.calls += 1;
      return behaviour();
    },
  };
  return p;
}

describe('providerChain', () => {
  it('always ends with the template', () => {
    // codex first (the owner's subscription); its usage-limit breaker makes the chain fall through at once
    expect(providerChain('auto')).toEqual(['codex', 'openrouter', 'openai-api', 'template']);
    expect(providerChain('codex')).toEqual(['codex', 'template']);
    expect(providerChain('openrouter')).toEqual(['openrouter', 'template']);
    expect(providerChain('openai-api')).toEqual(['openai-api', 'template']);
    expect(providerChain('template')).toEqual(['template']);
  });
});

describe('LlmGateway', () => {
  it('uses the first provider that answers with valid output', async () => {
    const codex = provider('codex', () => Promise.resolve(GOOD));
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, template] });
    const result = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(result).toEqual({ data: GOOD, provider: 'codex' });
    expect(template.calls).toBe(0);
  });

  it('skips unconfigured providers and falls through to the template', async () => {
    const codex = provider('codex', () => Promise.resolve(GOOD), false);
    const api = provider('openai-api', () => Promise.resolve(GOOD), false);
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, api, template] });
    expect(gateway.hasLlm()).toBe(false);
    const result = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(result.provider).toBe('template');
    expect(codex.calls + api.calls).toBe(0);
  });

  it('opens the circuit breaker on a usage limit until the reset time', async () => {
    let now = Date.UTC(2026, 8, 21, 12, 0, 0);
    const retryAt = new Date(now + 2 * 3600_000);
    const codex = provider('codex', () => Promise.reject(new LlmProviderError('codex', 'usage_limit', 'limit', retryAt)));
    const api = provider('openai-api', () => Promise.resolve(GOOD));
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, api, template], now: () => now });

    expect((await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS)).provider).toBe('openai-api');
    expect(codex.calls).toBe(1); // no retry on a usage limit
    expect(gateway.isAvailable('codex')).toBe(false);
    expect(gateway.breakerState('codex').openUntil).toBe(retryAt.getTime());

    await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(codex.calls).toBe(1); // still skipped

    now = retryAt.getTime() + 1;
    expect(gateway.isAvailable('codex')).toBe(true);
    await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(codex.calls).toBe(2);
  });

  it('falls back to one hour when the reset time is unknown', async () => {
    const now = 1_000_000;
    const codex = provider('codex', () => Promise.reject(new LlmProviderError('codex', 'usage_limit', 'limit')));
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, template], now: () => now });
    await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(gateway.breakerState('codex').openUntil).toBe(now + 3_600_000);
  });

  it('retries flaky output once, treats invalid output as a failure and moves on', async () => {
    const outputs: unknown[] = [{ markdown: 'x' }, { nonsense: true }];
    const codex = provider('codex', () => Promise.resolve(outputs.shift()));
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, template] });
    const result = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(codex.calls).toBe(2);
    expect(result.provider).toBe('template');
    expect(gateway.breakerState('codex').consecutiveFailures).toBe(2);
  });

  it('does not retry timeouts and pauses a provider after repeated failures', async () => {
    const now = 5_000_000;
    const api = provider('openai-api', () => Promise.reject(new LlmProviderError('openai-api', 'timeout', 'slow')));
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [api, template], now: () => now });
    for (let i = 0; i < 3; i += 1) await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(api.calls).toBe(3);
    expect(gateway.isAvailable('openai-api')).toBe(false);
    await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(api.calls).toBe(3);
  });

  it('pauses codex on auth problems and tells the parent what to do', async () => {
    const logs: string[] = [];
    const codex = provider('codex', () => Promise.reject(new LlmProviderError('codex', 'auth', 'Not logged in')));
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, template], log: (m) => logs.push(m) });
    await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(gateway.isAvailable('codex')).toBe(false);
    expect(logs.join('\n')).toContain('codex login');
  });

  it('rejects when even the template fails', async () => {
    const template = provider('template', () => Promise.reject(new LlmProviderError('template', 'failed', 'boom')));
    const gateway = new LlmGateway({ providers: [template] });
    await expect(gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS)).rejects.toThrow('boom');
    expect(gateway.isAvailable('template')).toBe(true); // the baseline is never switched off
  });

  it('runs jobs strictly one at a time, in order', async () => {
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    let n = 0;
    const slow = provider('codex', async () => {
      const mine = (n += 1);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      order.push(mine);
      return GOOD;
    });
    const gateway = new LlmGateway({ providers: [slow] });
    await Promise.all([1, 2, 3, 4].map(() => gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS)));
    expect(maxRunning).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('answers in-game calls from the template right away while a background job runs', async () => {
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = provider('openai-api', async () => {
      await blocker;
      return GOOD;
    });
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [api, template] });
    const background = gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    await Promise.resolve();
    const quick = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, { ...OPTIONS, skipQueueWhenBusy: true });
    expect(quick.provider).toBe('template');
    release();
    expect((await background).provider).toBe('openai-api');
  });

  it('never retries a rejected request and masks key-like text in its log', async () => {
    const logs: string[] = [];
    const router = provider('openrouter', () => Promise.reject(new LlmProviderError('openrouter', 'rejected', 'OpenRouter answered 400 sk-or-v1-abcdefgh12345678')));
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [router, template], log: (m) => logs.push(m) });
    expect((await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS)).provider).toBe('template');
    expect(router.calls).toBe(1);
    expect(logs.join('\n')).not.toContain('abcdefgh');
  });

  it('sends a provider-specific prompt only to the providers it was written for', async () => {
    const seen: Record<string, string> = {};
    const recording = (id: ProviderId, fail: boolean): LlmProvider => ({
      id,
      isConfigured: () => true,
      generate: (request) => {
        seen[id] = request.prompt;
        return fail ? Promise.reject(new LlmProviderError(id, 'timeout', 'slow')) : Promise.resolve(GOOD);
      },
    });
    const gateway = new LlmGateway({ providers: [recording('codex', true), recording('openrouter', false)] });
    const result = await gateway.generateJson(TASK, 'base prompt', REVIEW_JSON_SCHEMA, { ...OPTIONS, promptOverrides: { openrouter: 'richer prompt' } });
    expect(result.provider).toBe('openrouter');
    expect(seen).toEqual({ codex: 'base prompt', openrouter: 'richer prompt' });
  });

  it('honours a per-call provider list', async () => {
    const codex = provider('codex', () => Promise.resolve(GOOD));
    const api = provider('openai-api', () => Promise.resolve(GOOD));
    const template = provider('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, api, template] });
    const result = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, { ...OPTIONS, providers: ['openai-api', 'template'] });
    expect(result.provider).toBe('openai-api');
    expect(codex.calls).toBe(0);
  });
});

describe('LlmGateway — in-game calls (the strategist)', () => {
  const recording = (id: ProviderId, behaviour: (request: LlmRequest) => Promise<unknown>): LlmProvider & { seen: LlmRequest[] } => {
    const p = {
      id,
      seen: [] as LlmRequest[],
      isConfigured: () => true,
      generate: (request: LlmRequest) => {
        p.seen.push(request);
        return behaviour(request);
      },
    };
    return p;
  };

  it('passes the per-task model and output budget to each provider', async () => {
    const codex = recording('codex', () => Promise.reject(new LlmProviderError('codex', 'usage_limit', 'limit')));
    const router = recording('openrouter', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, router] });
    await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, { ...OPTIONS, models: { codex: 'gpt-5.6-sol', openrouter: 'openai/gpt-5.6-sol' }, maxOutputTokens: 2000 });
    expect(codex.seen[0]).toMatchObject({ model: 'gpt-5.6-sol', maxOutputTokens: 2000 });
    expect(router.seen[0]).toMatchObject({ model: 'openai/gpt-5.6-sol', maxOutputTokens: 2000 });
    // without per-task models nothing is overridden
    await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(router.seen[1]?.model).toBeUndefined();
  });

  it('shares the deadline: each provider gets what is left, codex its cap; too little left → template only', async () => {
    let now = 1_000_000;
    const codex = recording('codex', () => {
      now += 4_000; // codex burnt 4 s and failed
      return Promise.reject(new LlmProviderError('codex', 'failed', 'broken'));
    });
    const router = recording('openrouter', () => {
      now += 3_700;
      return Promise.reject(new LlmProviderError('openrouter', 'timeout', 'slow'));
    });
    const api = recording('openai-api', () => Promise.resolve(GOOD));
    const template = recording('template', () => Promise.resolve({ ...GOOD, markdown: 'Шаблонный разбор партии для ребёнка.' }));
    const logs: string[] = [];
    const gateway = new LlmGateway({ providers: [codex, router, api, template], now: () => now, log: (m) => logs.push(m) });
    const result = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, { ...OPTIONS, timeoutMs: 8_000, deadline: now + 8_000, providerTimeoutMs: { codex: 5_000 }, retry: false, label: 'strategy' });
    expect(codex.seen.map((r) => r.timeoutMs)).toEqual([5_000]); // no retry, its cap
    expect(router.seen.map((r) => r.timeoutMs)).toEqual([4_000]); // what was left
    expect(api.seen).toHaveLength(0); // 300 ms left < MIN_ATTEMPT_MS
    expect(result.provider).toBe('template');
    expect(logs.join('\n')).toMatch(/\[llm\] strategy: codex failed \(failed, attempt 1\) after 4000 ms/);
    expect(logs.join('\n')).toMatch(/\[llm\] strategy: template answered in 0 ms/);
  });

  it('a paid provider needs its minimum time left; every LLM attempt is reported; a per-provider effort wins', async () => {
    let now = 2_000_000;
    const codex = recording('codex', () => {
      now += 5_800; // the subscription failed late
      return Promise.reject(new LlmProviderError('codex', 'failed', 'stream disconnected'));
    });
    const router = recording('openrouter', () => Promise.resolve(GOOD));
    const template = recording('template', () => Promise.resolve({ ...GOOD, markdown: 'Шаблонный разбор партии для ребёнка.' }));
    const gateway = new LlmGateway({ providers: [codex, router, template], now: () => now });
    const attempts: unknown[] = [];
    const strategyCall = {
      ...OPTIONS,
      timeoutMs: 8_000,
      deadline: now + 8_000,
      retry: false,
      reasoningEffort: 'none' as const,
      reasoningEffortFor: { codex: 'low' as const },
      minAttemptMs: { openrouter: 2_500 },
      onAttempt: (attempt: unknown) => {
        attempts.push(attempt);
        throw new Error('a broken listener never breaks the chain');
      },
    };
    const late = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, strategyCall);
    // 2.2 s left < 2.5 s: OpenRouter is not even started (it could not finish) — the template answers
    expect(late.provider).toBe('template');
    expect(router.seen).toHaveLength(0);
    expect(codex.seen[0]?.reasoningEffort).toBe('low');
    expect(attempts).toEqual([{ provider: 'codex', errorKind: 'failed', ms: 5_800, timeoutMs: 8_000, effort: 'low' }]);
    // with enough time left OpenRouter answers — with the call's own effort
    const onTime = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, { ...strategyCall, deadline: now + 8_000, providers: ['openrouter', 'template'] });
    expect(onTime.provider).toBe('openrouter');
    expect(router.seen[0]?.reasoningEffort).toBe('none');
    expect(attempts[1]).toEqual({ provider: 'openrouter', errorKind: null, ms: 0, timeoutMs: 8_000, effort: 'none' });
    expect(attempts).toHaveLength(2); // the template is never reported
    // the call waited 3 s in the lane's queue: the attempt gets (and reports) only what is left of its cap
    const queued = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, { ...strategyCall, deadline: now + 5_000, providerTimeoutMs: { openrouter: 7_500 }, providers: ['openrouter', 'template'] });
    expect(queued.provider).toBe('openrouter');
    expect(attempts[2]).toMatchObject({ provider: 'openrouter', timeoutMs: 5_000 });
  });

  it('abandons a provider that ignores its timeout (hard race) when a deadline is set', async () => {
    const codex = recording('codex', () => new Promise(() => undefined));
    const template = recording('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, template] });
    const startedAt = Date.now();
    const result = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, { ...OPTIONS, timeoutMs: 5_000, deadline: Date.now() + 600 });
    expect(result.provider).toBe('template');
    expect(Date.now() - startedAt).toBeLessThan(1_500); // 600 ms + the grace, not 5 s
    expect(codex.seen[0]?.timeoutMs).toBeLessThanOrEqual(600);
  });

  it('skips every LLM when the caller no longer wants the answer', async () => {
    const codex = recording('codex', () => Promise.resolve(GOOD));
    const template = recording('template', () => Promise.resolve(GOOD));
    const gateway = new LlmGateway({ providers: [codex, template] });
    const result = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, { ...OPTIONS, abandonIf: () => true });
    expect(result.provider).toBe('template');
    expect(codex.seen).toHaveLength(0);
  });

  it('in-game slowness pauses a provider for in-game calls only; a usage limit pauses it everywhere', async () => {
    const now = 7_000_000;
    let limit = false;
    const codex = recording('codex', () => Promise.reject(limit ? new LlmProviderError('codex', 'usage_limit', 'limit', new Date(now + 3_600_000)) : new LlmProviderError('codex', 'timeout', 'slow')));
    const template = recording('template', () => Promise.resolve(GOOD));
    const logs: string[] = [];
    const gateway = new LlmGateway({ providers: [codex, template], now: () => now, log: (m) => logs.push(m) });
    const inGame = { ...OPTIONS, lane: 'interactive' as const, retry: false };
    for (let i = 0; i < 3; i += 1) await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, inGame);
    expect(gateway.isAvailable('codex', 'interactive')).toBe(false);
    expect(gateway.isAvailable('codex')).toBe(true); // the (free) reviews still use codex
    expect(gateway.hasLlm(['codex'], 'interactive')).toBe(false);
    expect(logs.join('\n')).toContain('reviews unaffected');
    await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(codex.seen).toHaveLength(4);
    limit = true;
    await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    expect(gateway.isAvailable('codex')).toBe(false);
    expect(gateway.breakerState('codex').openUntil).toBe(now + 3_600_000);
  });

  it('runs interactive calls on their own lane, never behind a review', async () => {
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = recording('openai-api', async (request) => {
      if (request.schemaName === 'game_review') await blocker;
      return GOOD;
    });
    const gateway = new LlmGateway({ providers: [api] });
    const review = gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, OPTIONS);
    const quick = await gateway.generateJson(TASK, 'p', REVIEW_JSON_SCHEMA, { ...OPTIONS, schemaName: 'game_strategy', lane: 'interactive' });
    expect(quick.provider).toBe('openai-api');
    expect(gateway.queue.busy).toBe(true);
    release();
    await review;
    await gateway.onIdle();
    expect(gateway.queue.busy || gateway.interactiveQueue.busy).toBe(false);
  });
});

describe('JobQueue', () => {
  it('keeps going after a failed job and reports idleness', async () => {
    const queue = new JobQueue();
    const failed = queue.enqueue(() => Promise.reject(new Error('nope')));
    const ok = queue.enqueue(() => Promise.resolve(42));
    expect(queue.busy).toBe(true);
    await expect(failed).rejects.toThrow('nope');
    expect(await ok).toBe(42);
    await queue.onIdle();
    expect(queue.size).toBe(0);
  });
});

describe('review output validation', () => {
  it('accepts the contract shape and rejects anything else', () => {
    expect(parseReviewOutput(GOOD)).toEqual(GOOD);
    expect(() => parseReviewOutput({ ...GOOD, markdown: '' })).toThrow();
    expect(() => parseReviewOutput({ markdown: GOOD.markdown })).toThrow();
    expect(() => parseReviewOutput('text')).toThrow();
  });
});
