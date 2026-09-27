import { describe, expect, it } from 'vitest';
import { defaultProfile } from '../services/profile.ts';
import { createTestServer } from '../testing/fixtures.ts';
import { FALLBACK_TRANSCRIBE_MODEL, buildRealtimeSessionBody, mintVoiceSession, studentBrief } from './session.ts';
import type { VoiceSessionConfig } from './session.ts';

const KEY = 'sk-test-permanent-key';

function config(fetchImpl: typeof fetch, overrides: Partial<VoiceSessionConfig> = {}): VoiceSessionConfig {
  return {
    apiKey: KEY,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    transcribeModel: 'gpt-live-transcribe',
    ttlSeconds: 120,
    instructions: 'Ты — Гамбитик.',
    fetchImpl,
    now: () => 1_790_000_000_000,
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit;
  body: { expires_after: Record<string, unknown>; session: Record<string, unknown> & { audio: { input: Record<string, Record<string, unknown>>; output: Record<string, unknown> } } };
}

function recordingFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) as Call['body'] });
    const next = responses.shift();
    return next === undefined ? Promise.reject(new Error('unexpected call')) : Promise.resolve(next);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('mintVoiceSession', () => {
  it('answers no-api-key without touching the network', async () => {
    const { fetchImpl, calls } = recordingFetch([]);
    expect(await mintVoiceSession(config(fetchImpl, { apiKey: null }))).toEqual({ ok: false, status: 503, error: 'no-api-key' });
    expect(calls).toHaveLength(0);
  });

  it('posts the researched session shape and returns only the ephemeral secret', async () => {
    const { fetchImpl, calls } = recordingFetch([json({ value: 'ek_ephemeral', expires_at: 1_790_000_120, session: { id: 'sess' } })]);
    const result = await mintVoiceSession(config(fetchImpl));
    expect(result).toEqual({
      ok: true,
      session: { provider: 'openai-realtime', clientSecret: 'ek_ephemeral', model: 'gpt-realtime-2.1', voice: 'marin', expiresAt: 1_790_000_120_000, instructionsApplied: true },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);

    const call = calls[0];
    expect(call?.url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['OpenAI-Safety-Identifier']).toMatch(/^[0-9a-f]{64}$/);
    expect(call?.body.expires_after).toEqual({ anchor: 'created_at', seconds: 120 });
    expect(call?.body.session).toMatchObject({
      type: 'realtime',
      model: 'gpt-realtime-2.1',
      instructions: 'Ты — Гамбитик.',
      output_modalities: ['audio'],
      reasoning: { effort: 'low' },
    });
    expect(call?.body.session.audio.input.noise_reduction).toEqual({ type: 'far_field' });
    expect(call?.body.session.audio.input.turn_detection).toMatchObject({ type: 'semantic_vad', eagerness: 'low' });
    expect(call?.body.session.audio.input.transcription).toMatchObject({ model: 'gpt-live-transcribe', languages: ['ru'] });
    expect(call?.body.session.audio.output).toMatchObject({ voice: 'marin' });
    // deprecated stored prompts are never used
    expect(call?.body.session.prompt).toBeUndefined();
  });

  it('retries once with the fallback transcription model when the preferred one is rejected', async () => {
    const { fetchImpl, calls } = recordingFetch([
      json({ error: { message: "Invalid value for 'session.audio.input.transcription.model'" } }, 400),
      json({ value: 'ek_2', expires_at: 1_790_000_060 }),
    ]);
    const result = await mintVoiceSession(config(fetchImpl));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.session.audio.input.transcription).toEqual({ model: FALLBACK_TRANSCRIBE_MODEL });
  });

  it('maps upstream problems to 502 without leaking the key', async () => {
    const rejected = await mintVoiceSession(config(recordingFetch([json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401)]).fetchImpl));
    expect(rejected).toMatchObject({ ok: false, status: 502, error: 'voice-upstream' });
    expect(JSON.stringify(rejected)).not.toContain(KEY);
    expect(JSON.stringify(rejected)).toContain('401');

    const empty = await mintVoiceSession(config(recordingFetch([json({ nothing: true })]).fetchImpl));
    expect(empty).toMatchObject({ ok: false, status: 502 });

    const offline = await mintVoiceSession(config(() => Promise.reject(new TypeError('fetch failed'))));
    expect(offline).toEqual({ ok: false, status: 502, error: 'voice-upstream', upstreamStatus: null, detail: 'OpenAI is unreachable (net:unknown)', reason: 'net:unknown' });
    // undici keeps the real reason in `cause`: it reaches the log and the browser as a code, never as text
    const dns = await mintVoiceSession(config(() => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.openai.com'), { code: 'ENOTFOUND' }) }))));
    expect(dns).toMatchObject({ upstreamStatus: null, detail: 'OpenAI is unreachable (net:ENOTFOUND)', reason: 'net:ENOTFOUND' });
    expect(JSON.stringify(dns)).not.toContain('getaddrinfo');
  });

  it('never repeats upstream error TEXT: it carries the masked key and markup', async () => {
    const upstream = { error: { message: 'Incorrect API key provided: sk-test-********************abcd. You can find your API key at ... <script>alert(1)</script>', type: 'invalid_request_error', code: 'invalid_api_key' } };
    const rejected = await mintVoiceSession(config(recordingFetch([json(upstream, 401)]).fetchImpl));
    expect(rejected).toEqual({ ok: false, status: 502, error: 'voice-upstream', upstreamStatus: 401, detail: 'OpenAI answered 401 (type=invalid_request_error, code=invalid_api_key)', reason: 'http:401' });
    // identifiers that do not look like identifiers are dropped as well
    const odd = await mintVoiceSession(config(recordingFetch([json({ error: { message: 'x', type: 'sk-test-abcdefghijkl', code: '<b>bold</b>' } }, 500)]).fetchImpl));
    expect(odd).toMatchObject({ detail: 'OpenAI answered 500' });
  });

  it('omits reasoning for models that do not support it and computes expiry when the API omits it', async () => {
    expect(buildRealtimeSessionBody({ model: 'gpt-realtime-1.5', voice: 'cedar', ttlSeconds: 60, instructions: 'x' }, 'gpt-live-transcribe').session).not.toHaveProperty('reasoning');
    const { fetchImpl } = recordingFetch([json({ value: 'ek_3' })]);
    const result = await mintVoiceSession(config(fetchImpl));
    expect(result.ok && result.session.expiresAt).toBe(1_790_000_000_000 + 120_000);
  });
});

describe('studentBrief', () => {
  it('contains the pseudonym and chess facts only', () => {
    const brief = studentBrief({ ...defaultProfile(), nickname: 'Миша', address: 'f', stage: 3, weaknesses: ['Вилка'], strengths: [] });
    expect(brief).toContain('Псевдоним: Миша');
    expect(brief).toContain('женском роде');
    expect(brief).toContain('Ступень программы: 3');
    expect(brief).toContain('Вилка');
  });
});

describe('POST /api/voice/session with a key', () => {
  it('mints through the injected fetch with the coach prompt applied', async () => {
    const { fetchImpl, calls } = recordingFetch([json({ value: 'ek_route', expires_at: 1_790_000_100 })]);
    const server = await createTestServer({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl });
    try {
      const res = await server.request('/api/voice/session', { method: 'POST', json: {} });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(JSON.parse(text)).toMatchObject({ provider: 'openai-realtime', clientSecret: 'ek_route', instructionsApplied: true });
      const instructions = String(calls[0]?.body.session.instructions);
      expect(instructions).toContain(server.ctx.content.coachSystemPromptRu.trim().slice(0, 40));
      expect(instructions).toContain('# Об ученике');
    } finally {
      await server.cleanup();
    }
  });

  it('answers 502 with the upstream status only: no upstream text in the browser or in the log', async () => {
    const { fetchImpl } = recordingFetch([json({ error: { message: `Incorrect API key provided: sk-test-****abcd (${KEY}) <script>alert(1)</script>`, type: 'invalid_request_error', code: 'invalid_api_key' } }, 401)]);
    const logs: string[] = [];
    const server = await createTestServer({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl, log: (m) => logs.push(m) });
    try {
      const res = await server.request('/api/voice/session', { method: 'POST', json: {} });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'voice-upstream', status: 401, reason: 'http:401' });
      const logged = logs.join(' | ');
      expect(logged).toContain('[voice] realtime: OpenAI answered 401 (type=invalid_request_error, code=invalid_api_key)');
      expect(logged).not.toMatch(/sk-test|abcd|script/);
    } finally {
      await server.cleanup();
    }
  });

  it('stops a reconnect loop: at most 10 session creations per minute', async () => {
    const responses = Array.from({ length: 12 }, () => json({ value: 'ek_loop', expires_at: 1_790_000_100 }));
    const { fetchImpl, calls } = recordingFetch(responses);
    const server = await createTestServer({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) statuses.push((await server.request('/api/voice/session', { method: 'POST', json: {} })).status);
      expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 200));
      expect(statuses.slice(10)).toEqual([429, 429]);
      expect(calls).toHaveLength(10);
    } finally {
      await server.cleanup();
    }
  });
});
