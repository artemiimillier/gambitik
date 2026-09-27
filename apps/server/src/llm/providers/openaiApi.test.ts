import { describe, expect, it } from 'vitest';
import { REVIEW_JSON_SCHEMA } from '../reviewSchema.ts';
import { LlmProviderError } from '../types.ts';
import type { LlmRequest } from '../types.ts';
import { createOpenAiApiProvider, extractOutputText } from './openaiApi.ts';

const KEY = 'sk-test-permanent-key';
const REQUEST: LlmRequest = {
  task: { kind: 'rephrase', event: { id: 'e', kind: 'praise', priority: 0, text: 'Молодец', bubbleText: 'Молодец', pose: 'cheer', pauseClock: false } },
  prompt: 'Перескажи',
  jsonSchema: REVIEW_JSON_SCHEMA,
  schemaName: 'game_review',
  timeoutMs: 2_000,
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const message = (text: string) => ({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text }] }] });

describe('openai-api provider', () => {
  it('is configured only with a key', async () => {
    const provider = createOpenAiApiProvider({ apiKey: null, model: 'gpt-5.6-luna' });
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.generate(REQUEST)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('calls the Responses API with a strict json_schema format and parses the output text', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const provider = createOpenAiApiProvider({
      apiKey: KEY,
      model: 'gpt-5.6-luna',
      fetchImpl: (url, init) => {
        seen = { url: String(url), init: init ?? {} };
        return Promise.resolve(json(message('{"markdown":"ok","keyTakeaways":[],"suggestedTheme":"fork"}')));
      },
    });
    expect(await provider.generate(REQUEST)).toEqual({ markdown: 'ok', keyTakeaways: [], suggestedTheme: 'fork' });
    const call = seen as { url: string; init: RequestInit } | null;
    expect(call?.url).toBe('https://api.openai.com/v1/responses');
    expect((call?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-5.6-luna',
      input: 'Перескажи',
      store: false,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'game_review', strict: true, schema: REVIEW_JSON_SCHEMA } },
    });
  });

  it('uses a per-task model and output budget', async () => {
    let body: Record<string, unknown> = {};
    const provider = createOpenAiApiProvider({
      apiKey: KEY,
      model: 'gpt-5.6-luna',
      fetchImpl: (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(json(message('{"text":"ok"}')));
      },
    });
    await provider.generate({ ...REQUEST, model: 'gpt-5.6-sol', maxOutputTokens: 2000 });
    expect(body).toMatchObject({ model: 'gpt-5.6-sol', max_output_tokens: 2000, reasoning: { effort: 'low' }, store: false });
    await provider.generate({ ...REQUEST, model: 'gpt-5.6-sol', reasoningEffort: 'none' });
    expect(body).toMatchObject({ reasoning: { effort: 'none' } });
  });

  it('classifies failures and never leaks the key', async () => {
    const failing = async (response: Response | Error): Promise<LlmProviderError> => {
      const provider = createOpenAiApiProvider({ apiKey: KEY, model: 'gpt-4.1', fetchImpl: () => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)) });
      const error: unknown = await provider.generate(REQUEST).then(
        () => new Error('expected a failure'),
        (e: unknown) => e,
      );
      if (!(error instanceof LlmProviderError)) throw new Error('expected an LlmProviderError');
      return error;
    };

    const auth = await failing(json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401));
    expect(auth).toMatchObject({ kind: 'auth' });
    expect(auth.message).not.toContain(KEY);

    // OpenAI's real 401 text carries the key prefix + last 4 characters and may carry markup
    const masked = await failing(json({ error: { message: 'Incorrect API key provided: sk-test-********************abcd. <script>alert(1)</script>', type: 'invalid_request_error', code: 'invalid_api_key' } }, 401));
    expect(masked.message).toBe('OpenAI API answered 401 (type=invalid_request_error, code=invalid_api_key)');
    expect(masked.message).not.toMatch(/sk-|abcd|script/);
    expect(await failing(json({ error: { message: 'bad schema', type: 'invalid_request_error' } }, 400))).toMatchObject({ kind: 'rejected' });

    const limited = await failing(json({ error: { message: 'Rate limit' } }, 429, { 'retry-after': '30' }));
    expect(limited.kind).toBe('usage_limit');
    expect(limited.retryAt).toBeInstanceOf(Date);

    expect(await failing(json({ error: { message: 'boom' } }, 500))).toMatchObject({ kind: 'failed' });
    expect(await failing(json({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }))).toMatchObject({ kind: 'bad_output' });
    expect(await failing(json(message('not json')))).toMatchObject({ kind: 'bad_output' });
    expect(await failing(new TypeError('fetch failed'))).toMatchObject({ kind: 'failed' });
    expect(await failing(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))).toMatchObject({ kind: 'timeout' });
  });

  it('extracts output text from both response shapes', () => {
    expect(extractOutputText({ output_text: 'direct' })).toBe('direct');
    expect(extractOutputText(message('nested'))).toBe('nested');
    expect(extractOutputText({ output: [] })).toBeNull();
    expect(extractOutputText(null)).toBeNull();
  });
});
