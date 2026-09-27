/**
 * Provider B: OpenAI Responses API with structured output (`text.format = json_schema`).
 * Used only when OPENAI_API_KEY is set. Plain `fetch` keeps it trivially testable; the key is
 * sent in the Authorization header only. Error messages carry the HTTP status and the short
 * `error.type` / `error.code` identifiers — never upstream free text (it can echo a masked key).
 */
import { createHash } from 'node:crypto';
import { describeUpstreamError, upstreamErrorInfo } from '../../sanitize.ts';
import { LlmProviderError } from '../types.ts';
import type { LlmProvider, LlmRequest } from '../types.ts';

export interface OpenAiApiProviderOptions {
  apiKey: string | null;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** First `output_text` part of a Responses API result; null on refusal / empty output. */
export function extractOutputText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.output_text === 'string' && body.output_text !== '') return body.output_text;
  if (!Array.isArray(body.output)) return null;
  for (const item of body.output as unknown[]) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as unknown[]) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string' && part.text !== '') return part.text;
    }
  }
  return null;
}

function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-[5-9]|gpt-\d{2,}|o\d)/.test(model);
}

function retryAfter(response: Response, now: number): Date | null {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(now + Math.min(seconds, 3600) * 1000) : null;
}

export function createOpenAiApiProvider(options: OpenAiApiProviderOptions): LlmProvider {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;

  return {
    id: 'openai-api',
    isConfigured: () => options.apiKey !== null,

    async generate(request: LlmRequest): Promise<unknown> {
      const apiKey = options.apiKey;
      if (apiKey === null) throw new LlmProviderError('openai-api', 'auth', 'OPENAI_API_KEY is not set');

      // a per-task model (the strategist's OPENAI_STRATEGY_MODEL) replaces the text model for this call only
      const model = request.model ?? options.model;
      const body: Record<string, unknown> = {
        model,
        input: request.prompt,
        store: false,
        max_output_tokens: request.maxOutputTokens ?? 4000,
        safety_identifier: createHash('sha256').update('gambit-local-student').digest('hex'),
        text: { format: { type: 'json_schema', name: request.schemaName, schema: request.jsonSchema, strict: true } },
      };
      if (supportsReasoningEffort(model)) body.reasoning = { effort: request.reasoningEffort ?? 'low' };

      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/responses`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (error) {
        const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') throw new LlmProviderError('openai-api', 'timeout', `OpenAI API timed out after ${request.timeoutMs} ms`);
        throw new LlmProviderError('openai-api', 'failed', 'OpenAI API is unreachable');
      }

      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        // status + error.type / error.code only: the upstream MESSAGE may echo a partly masked key
        const message = describeUpstreamError('OpenAI API', upstreamErrorInfo(response.status, parsed));
        if (response.status === 401 || response.status === 403) throw new LlmProviderError('openai-api', 'auth', message);
        if (response.status === 429) throw new LlmProviderError('openai-api', 'usage_limit', message, retryAfter(response, Date.now()) ?? new Date(Date.now() + 5 * 60_000));
        if (response.status === 400 || response.status === 404 || response.status === 422) throw new LlmProviderError('openai-api', 'rejected', message);
        throw new LlmProviderError('openai-api', 'failed', message);
      }

      const text = extractOutputText(parsed);
      if (text === null) throw new LlmProviderError('openai-api', 'bad_output', 'the response has no output text (refusal or empty output)');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new LlmProviderError('openai-api', 'bad_output', 'the response text is not valid JSON');
      }
    },
  };
}
