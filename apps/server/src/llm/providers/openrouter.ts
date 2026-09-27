/**
 * Provider: OpenRouter chat completions with strict structured output — TEXT ONLY (game reviews).
 * Voice never goes through OpenRouter (by design: voice = OpenAI Live / Realtime).
 *
 *   POST https://openrouter.ai/api/v1/chat/completions            (research 10 §3, §6.3)
 *   { model, models: [<fallbacks>], messages, response_format: { type: 'json_schema', json_schema: { name, strict, schema } },
 *     reasoning: { effort: 'low' }, max_completion_tokens, provider: { data_collection: 'deny' }, user, stream: false }
 *
 *  - `provider.data_collection: 'deny'` — only upstreams that do not collect / train on the prompt;
 *    the prompt carries moves + engine judgements + the pseudonym, nothing else;
 *  - `provider.require_parameters: true` — only endpoints that honour EVERY parameter, i.e. really
 *    enforce the JSON schema. Checked against the public endpoint catalogue: for
 *    gpt-5.6-terra / -luna the Amazon Bedrock endpoint has no structured outputs, the Azure endpoints
 *    (zero data retention) accept `max_completion_tokens`, the first-party OpenAI ones list
 *    `max_tokens` instead. If this filter leaves no endpoint (404), the call is repeated once
 *    without it rather than giving up on OpenRouter;
 *  - NO attribution headers (HTTP-Referer / X-OpenRouter-Title): without them OpenRouter creates
 *    no public "app" page for a private family tool;
 *  - errors are classified by HTTP status + `error.metadata.error_type`, never by message text,
 *    and upstream text never reaches logs (sanitize.ts): 402 credits → circuit breaker for 6 h,
 *    402 in-flight budget / 429 → Retry-After, 401 → auth, 400/403/404 → rejected (no retry);
 *  - plain `fetch`, non-streaming, 60 s timeout. Tests use a fake fetch; the real endpoint is never
 *    called from tests.
 */
import { createHash } from 'node:crypto';
import { describeUpstreamError, upstreamErrorInfo } from '../../sanitize.ts';
import type { UpstreamErrorInfo } from '../../sanitize.ts';
import { LlmProviderError } from '../types.ts';
import type { LlmProvider, LlmRequest } from '../types.ts';

export interface OpenRouterProviderOptions {
  apiKey: string | null;
  /** e.g. 'openai/gpt-5.6-terra' */
  model: string;
  /** tried by OpenRouter itself, in order, when the main model is down / filtered out */
  fallbackModels?: readonly string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxCompletionTokens?: number;
  log?: (message: string) => void;
}

export const OPENROUTER_TIMEOUT_MS = 60_000;
/** «Пополните кредиты» is a job for a parent, not something that fixes itself in minutes. */
export const OPENROUTER_CREDITS_COOLDOWN_MS = 6 * 3_600_000;
const RATE_LIMIT_DEFAULT_MS = 60_000;
const RETRY_AFTER_CAP_S = 3_600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function buildOpenRouterBody(
  options: Pick<OpenRouterProviderOptions, 'model' | 'fallbackModels' | 'maxCompletionTokens'>,
  request: Pick<LlmRequest, 'prompt' | 'schemaName' | 'jsonSchema' | 'model' | 'maxOutputTokens' | 'reasoningEffort'>,
  routing: { requireParameters: boolean } = { requireParameters: true },
): Record<string, unknown> {
  // a per-task model (the strategist's OPENROUTER_STRATEGY_MODEL) replaces the review model for this call only
  const model = request.model ?? options.model;
  const fallbacks = [...new Set(options.fallbackModels ?? [])].filter((id) => id !== model).slice(0, 3);
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: request.prompt }],
    response_format: { type: 'json_schema', json_schema: { name: request.schemaName, strict: true, schema: request.jsonSchema } },
    reasoning: { effort: request.reasoningEffort ?? 'low' },
    max_completion_tokens: request.maxOutputTokens ?? options.maxCompletionTokens ?? 4000,
    stream: false,
    provider: routing.requireParameters ? { data_collection: 'deny', require_parameters: true } : { data_collection: 'deny' },
    // stable pseudonymous id for abuse monitoring — no personal data
    user: createHash('sha256').update('gambit-local-student').digest('hex'),
  };
  if (fallbacks.length > 0) body.models = fallbacks;
  return body;
}

/** `choices[0].message.content` as text; null on refusal / empty output. */
export function extractChatContent(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.choices)) return null;
  const first: unknown = body.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  if (typeof content === 'string') return content.trim() === '' ? null : content;
  if (Array.isArray(content)) {
    const text = (content as unknown[]).map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
    return text.trim() === '' ? null : text;
  }
  return null;
}

function stripCodeFence(text: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i.exec(text);
  return match?.[1] ?? text;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, RETRY_AFTER_CAP_S) * 1000 : null;
}

/** Maps a failed OpenRouter answer to the gateway's error kinds (status + error_type, never message text). */
export function classifyOpenRouterError(info: UpstreamErrorInfo, response: Response, now: number): LlmProviderError {
  const message = describeUpstreamError('OpenRouter', info);
  const status = info.status;
  const errorType = info.errorType ?? '';
  if (status === 401 || errorType === 'authentication') return new LlmProviderError('openrouter', 'auth', message);
  if (status === 402 || errorType === 'payment_required') {
    // a temporary "in flight" budget lock clears by itself; an empty balance / key limit does not
    const transient = info.limitSource === 'openrouter_in_flight_budget';
    const wait = transient ? (retryAfterMs(response) ?? RATE_LIMIT_DEFAULT_MS) : OPENROUTER_CREDITS_COOLDOWN_MS;
    return new LlmProviderError('openrouter', 'usage_limit', transient ? message : `${message} — OpenRouter credits are exhausted, top up the key`, new Date(now + wait));
  }
  if (status === 429 || errorType === 'rate_limit_exceeded') {
    return new LlmProviderError('openrouter', 'usage_limit', message, new Date(now + (retryAfterMs(response) ?? RATE_LIMIT_DEFAULT_MS)));
  }
  if (status === 408 || status === 524) return new LlmProviderError('openrouter', 'timeout', message);
  // our bug, moderation, a withdrawn model or no endpoint passing the privacy filter: retrying cannot help
  if (status === 400 || status === 403 || status === 404 || status === 413 || status === 422) return new LlmProviderError('openrouter', 'rejected', message);
  // 5xx: upstream down / overloaded — failed generations are not billed; the gateway retries once
  return new LlmProviderError('openrouter', 'failed', message);
}

export function createOpenRouterProvider(options: OpenRouterProviderOptions): LlmProvider {
  const baseUrl = (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);

  return {
    id: 'openrouter',
    isConfigured: () => options.apiKey !== null,

    async generate(request: LlmRequest): Promise<unknown> {
      const apiKey = options.apiKey;
      if (apiKey === null) throw new LlmProviderError('openrouter', 'auth', 'OPENROUTER_API_KEY is not set');
      const timeoutMs = Math.min(request.timeoutMs, OPENROUTER_TIMEOUT_MS);

      const post = async (requireParameters: boolean): Promise<{ response: Response; parsed: unknown }> => {
        let answer: Response;
        try {
          answer = await doFetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            // deliberately no HTTP-Referer / X-OpenRouter-Title attribution headers
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(buildOpenRouterBody(options, request, { requireParameters })),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
          if (name === 'TimeoutError' || name === 'AbortError') throw new LlmProviderError('openrouter', 'timeout', `OpenRouter timed out after ${timeoutMs} ms`);
          throw new LlmProviderError('openrouter', 'failed', 'OpenRouter is unreachable');
        }
        let body: unknown = null;
        try {
          body = await answer.json();
        } catch (error) {
          // OpenRouter sends the 200 headers at once and the body only when the model is done: a timeout while
          // reading it is a timeout, not an empty answer («no content»)
          const name = isRecord(error) && typeof error.name === 'string' ? error.name : '';
          if (name === 'TimeoutError' || name === 'AbortError') throw new LlmProviderError('openrouter', 'timeout', `OpenRouter timed out after ${timeoutMs} ms`);
          body = null;
        }
        return { response: answer, parsed: body };
      };

      let { response, parsed } = await post(true);
      if (response.status === 404) {
        // no endpoint passed the strict parameter filter: relax it once (the schema is validated locally anyway)
        log('[llm] openrouter: no endpoint supports every parameter — retrying without provider.require_parameters');
        ({ response, parsed } = await post(false));
      }

      if (!response.ok) throw classifyOpenRouterError(upstreamErrorInfo(response.status, parsed), response, now());

      // OpenRouter can answer 200 with a top-level `error` (the upstream failed after routing)
      if (isRecord(parsed) && isRecord(parsed.error)) {
        const code = typeof parsed.error.code === 'number' && parsed.error.code >= 400 && parsed.error.code < 600 ? parsed.error.code : 502;
        throw classifyOpenRouterError(upstreamErrorInfo(code, parsed), response, now());
      }

      const text = extractChatContent(parsed);
      if (text === null) throw new LlmProviderError('openrouter', 'bad_output', 'the completion has no content (refusal, or the token budget was used up by reasoning)');
      if (isRecord(parsed) && typeof parsed.model === 'string' && !parsed.model.startsWith(request.model ?? options.model) && /^[A-Za-z0-9._:/-]{1,80}$/.test(parsed.model)) {
        log(`[llm] openrouter answered with the fallback model ${parsed.model}`);
      }
      try {
        return JSON.parse(stripCodeFence(text)) as unknown;
      } catch {
        throw new LlmProviderError('openrouter', 'bad_output', 'the completion is not valid JSON');
      }
    },
  };
}
