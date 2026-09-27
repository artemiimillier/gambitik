/**
 * The OpenRouter provider is tested against a FAKE fetch only — the real endpoint is never called.
 */
import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../gateway.ts';
import { REVIEW_JSON_SCHEMA, parseReviewOutput } from '../reviewSchema.ts';
import { LlmProviderError } from '../types.ts';
import type { LlmProvider, LlmRequest } from '../types.ts';
import { OPENROUTER_CREDITS_COOLDOWN_MS, buildOpenRouterBody, createOpenRouterProvider, extractChatContent } from './openrouter.ts';

const KEY = 'sk-or-v1-test-permanent-key-0123456789';
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const GOOD = { markdown: 'Очень внимательная партия, так держать!', keyTakeaways: ['Проверяй защиту'], suggestedTheme: 'fork' };
const REQUEST: LlmRequest = {
  task: { kind: 'rephrase', event: { id: 'e', kind: 'praise', priority: 0, text: 'Молодец', bubbleText: 'Молодец', pose: 'cheer', pauseClock: false } },
  prompt: 'Разбери партию',
  jsonSchema: REVIEW_JSON_SCHEMA,
  schemaName: 'game_review',
  timeoutMs: 90_000,
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const completion = (content: unknown, model = 'openai/gpt-5.6-terra') => ({ id: 'gen-1', model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });

interface Seen {
  url: string;
  init: RequestInit;
}

function providerWith(responses: (Response | Error)[], seen: Seen[] = [], logs: string[] = []): LlmProvider {
  return createOpenRouterProvider({
    apiKey: KEY,
    model: 'openai/gpt-5.6-terra',
    fallbackModels: ['openai/gpt-5.6-luna'],
    now: () => NOW,
    log: (m) => logs.push(m),
    fetchImpl: (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (next === undefined) return Promise.reject(new Error('unexpected call'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  });
}

async function failure(response: Response | Error): Promise<LlmProviderError> {
  const error: unknown = await providerWith([response])
    .generate(REQUEST)
    .then(
      () => new Error('expected a failure'),
      (e: unknown) => e,
    );
  if (!(error instanceof LlmProviderError)) throw new Error('expected an LlmProviderError');
  expect(error.provider).toBe('openrouter');
  expect(error.message).not.toContain(KEY);
  return error;
}

describe('openrouter provider', () => {
  it('is configured only with a key', async () => {
    const provider = createOpenRouterProvider({ apiKey: null, model: 'openai/gpt-5.6-terra' });
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.generate(REQUEST)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('posts a strict json_schema chat completion with the privacy routing and no attribution headers', async () => {
    const seen: Seen[] = [];
    const provider = providerWith([json(completion(JSON.stringify(GOOD)))], seen);
    expect(await provider.generate(REQUEST)).toEqual(GOOD);

    const call = seen[0];
    expect(call?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(Object.keys(headers).map((h) => h.toLowerCase()).sort()).toEqual(['authorization', 'content-type']);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'openai/gpt-5.6-terra',
      models: ['openai/gpt-5.6-luna'],
      messages: [{ role: 'user', content: 'Разбери партию' }],
      response_format: { type: 'json_schema', json_schema: { name: 'game_review', strict: true, schema: REVIEW_JSON_SCHEMA } },
      provider: { data_collection: 'deny', require_parameters: true },
      max_completion_tokens: 4000,
      stream: false,
    });
    expect(body.user).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('uses a per-task model and output budget (the strategist’s Sol) with the same privacy routing', () => {
    const body = buildOpenRouterBody({ model: 'openai/gpt-5.6-terra', fallbackModels: ['openai/gpt-5.6-luna', 'openai/gpt-5.6-sol'] }, { ...REQUEST, model: 'openai/gpt-5.6-sol', maxOutputTokens: 2000 });
    expect(body).toMatchObject({ model: 'openai/gpt-5.6-sol', max_completion_tokens: 2000, reasoning: { effort: 'low' }, provider: { data_collection: 'deny', require_parameters: true } });
    expect(body.models).toEqual(['openai/gpt-5.6-luna']); // never the main model again
    // the strategist's game-start call skips the reasoning pass
    expect(buildOpenRouterBody({ model: 'openai/gpt-5.6-terra' }, { ...REQUEST, reasoningEffort: 'none' }).reasoning).toEqual({ effort: 'none' });
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
  });

  it('omits `models` without fallbacks and never repeats the main model in it', () => {
    expect(buildOpenRouterBody({ model: 'a/b', fallbackModels: [] }, REQUEST)).not.toHaveProperty('models');
    expect(buildOpenRouterBody({ model: 'a/b', fallbackModels: ['a/b', 'c/d', 'c/d'] }, REQUEST).models).toEqual(['c/d']);
  });

  it('accepts fenced JSON and reports the fallback model that answered', async () => {
    const logs: string[] = [];
    const provider = providerWith([json(completion(`\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``, 'openai/gpt-5.6-luna'))], [], logs);
    expect(await provider.generate(REQUEST)).toEqual(GOOD);
    expect(logs.join('\n')).toContain('openai/gpt-5.6-luna');
  });

  it('402 without credits pauses the provider for six hours', async () => {
    const error = await failure(json({ error: { code: 402, message: `Insufficient credits for ${KEY}`, metadata: { error_type: 'payment_required', limit_source: 'openrouter_credits' } } }, 402));
    expect(error.kind).toBe('usage_limit');
    expect(error.retryAt?.getTime()).toBe(NOW + OPENROUTER_CREDITS_COOLDOWN_MS);
    expect(error.message).toContain('402');
    expect(error.message).toContain('limit_source=openrouter_credits');
  });

  it('402 "in flight budget" and 429 wait for Retry-After only', async () => {
    const inFlight = await failure(json({ error: { code: 402, message: 'x', metadata: { error_type: 'payment_required', limit_source: 'openrouter_in_flight_budget' } } }, 402, { 'retry-after': '7' }));
    expect(inFlight.kind).toBe('usage_limit');
    expect(inFlight.retryAt?.getTime()).toBe(NOW + 7_000);

    const limited = await failure(json({ error: { code: 429, message: 'slow down', metadata: { error_type: 'rate_limit_exceeded' } } }, 429, { 'retry-after': '30' }));
    expect(limited.kind).toBe('usage_limit');
    expect(limited.retryAt?.getTime()).toBe(NOW + 30_000);

    const noHeader = await failure(json({ error: { code: 429, message: 'slow down' } }, 429));
    expect(noHeader.retryAt?.getTime()).toBe(NOW + 60_000);
  });

  it('classifies the other failures by status and never forwards upstream text', async () => {
    const auth = await failure(json({ error: { code: 401, message: `No auth credentials found sk-or-v1-****6789 <b>x</b>`, metadata: { error_type: 'authentication' } } }, 401));
    expect(auth.kind).toBe('auth');
    expect(auth.message).toBe('OpenRouter answered 401 (code=401, error_type=authentication)');

    expect((await failure(json({ error: { code: 400, message: 'bad', metadata: { error_type: 'invalid_request' } } }, 400))).kind).toBe('rejected');
    expect((await failure(json({ error: { code: 403, message: 'moderated', metadata: { error_type: 'content_policy_violation' } } }, 403))).kind).toBe('rejected');
    expect((await failure(json({ error: { code: 503, message: 'down', metadata: { error_type: 'provider_unavailable' } } }, 503))).kind).toBe('failed');
    expect((await failure(json({ error: { code: 408, message: 'slow' } }, 408))).kind).toBe('timeout');
    // HTTP 200 with a top-level error (the upstream failed after routing)
    expect((await failure(json({ error: { code: 502, message: 'upstream', metadata: { error_type: 'provider_unavailable' } } }))).kind).toBe('failed');
    expect((await failure(new Response('<html>bad gateway</html>', { status: 502 }))).kind).toBe('failed');
  });

  it('relaxes provider.require_parameters once when no endpoint passes the filter (404)', async () => {
    const seen: Seen[] = [];
    const logs: string[] = [];
    const notFound = () => json({ error: { code: 404, message: 'No endpoints found matching your data policy', metadata: { error_type: 'not_found' } } }, 404);
    const provider = providerWith([notFound(), json(completion(JSON.stringify(GOOD)))], seen, logs);
    expect(await provider.generate(REQUEST)).toEqual(GOOD);
    const providers = seen.map((call) => (JSON.parse(String(call.init.body)) as { provider: unknown }).provider);
    expect(providers).toEqual([{ data_collection: 'deny', require_parameters: true }, { data_collection: 'deny' }]);
    expect(logs.join(' ')).toContain('require_parameters');

    // still nothing: a withdrawn model / a privacy filter nobody passes is a final answer
    const seenAgain: Seen[] = [];
    const error: unknown = await providerWith([notFound(), notFound()], seenAgain).generate(REQUEST).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'rejected' });
    expect(seenAgain).toHaveLength(2);
  });

  it('maps a timeout, an unreachable network and unusable output', async () => {
    expect((await failure(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }))).kind).toBe('timeout');
    expect((await failure(new TypeError('fetch failed'))).kind).toBe('failed');
    expect((await failure(json(completion('это не JSON')))).kind).toBe('bad_output');
    expect((await failure(json(completion(null)))).kind).toBe('bad_output');
    expect((await failure(json({ choices: [] }))).kind).toBe('bad_output');
    // the 200 headers came at once, the body did not arrive before the timeout: a timeout, not «no content»
    const late = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
        },
      }),
      { status: 200 },
    );
    expect((await failure(late)).kind).toBe('timeout');
  });

  it('caps the request timeout at 60 s', async () => {
    const seen: Seen[] = [];
    const timeouts: number[] = [];
    const original = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) => {
      timeouts.push(ms);
      return original(ms);
    };
    try {
      await providerWith([json(completion(JSON.stringify(GOOD)))], seen).generate(REQUEST);
      await providerWith([json(completion(JSON.stringify(GOOD)))], seen).generate({ ...REQUEST, timeoutMs: 4_000 });
    } finally {
      AbortSignal.timeout = original;
    }
    expect(timeouts).toEqual([60_000, 4_000]);
  });

  it('extracts content from string and part-array messages', () => {
    expect(extractChatContent(completion('text'))).toBe('text');
    expect(extractChatContent(completion([{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }]))).toBe('{"a":1}');
    expect(extractChatContent(completion('   '))).toBeNull();
    expect(extractChatContent(null)).toBeNull();
  });
});

describe('openrouter inside the gateway', () => {
  const template: LlmProvider = { id: 'template', isConfigured: () => true, generate: () => Promise.resolve(GOOD) };
  const options = { validate: parseReviewOutput, schemaName: 'game_review', timeoutMs: 1_000 };

  it('schema-invalid JSON is retried once, then the next provider answers', async () => {
    const seen: Seen[] = [];
    const router = providerWith([json(completion(JSON.stringify({ markdown: 'x' }))), json(completion(JSON.stringify({ nonsense: true })))], seen);
    const gateway = new LlmGateway({ providers: [router, template], now: () => NOW });
    const result = await gateway.generateJson(REQUEST.task, REQUEST.prompt, REVIEW_JSON_SCHEMA, options);
    expect(result.provider).toBe('template');
    expect(seen).toHaveLength(2);
  });

  it('exhausted credits open the breaker: the next review does not even call OpenRouter', async () => {
    const seen: Seen[] = [];
    const router = providerWith([json({ error: { code: 402, message: 'no credits', metadata: { error_type: 'payment_required', limit_source: 'openrouter_key_limit' } } }, 402)], seen);
    const gateway = new LlmGateway({ providers: [router, template], now: () => NOW });
    expect((await gateway.generateJson(REQUEST.task, REQUEST.prompt, REVIEW_JSON_SCHEMA, options)).provider).toBe('template');
    expect(gateway.isAvailable('openrouter')).toBe(false);
    expect(gateway.breakerState('openrouter').openUntil).toBe(NOW + OPENROUTER_CREDITS_COOLDOWN_MS);
    expect((await gateway.generateJson(REQUEST.task, REQUEST.prompt, REVIEW_JSON_SCHEMA, options)).provider).toBe('template');
    expect(seen).toHaveLength(1);
  });
});
