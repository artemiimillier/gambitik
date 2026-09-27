/**
 * Live API session creation is tested against a FAKE fetch only — api.openai.com is never called.
 */
import { describe, expect, it } from 'vitest';
import type { LiveVoiceSessionResponse } from '@gambit/shared';
import { createTestServer } from '../testing/fixtures.ts';
import { LIVE_ALLOWED_CLIENT_EVENTS, LIVE_INSTRUCTIONS_ADDENDUM_RU, buildLiveInstructions, buildLiveSessionBody, createLiveSession, isPlausibleSdp } from './live.ts';
import type { LiveSessionConfig } from './live.ts';

const KEY = 'sk-test-permanent-key';
const CRLF = '\r\n';
const OFFER = ['v=0', 'o=- 46117317 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', ''].join(CRLF);
const ANSWER = ['v=0', 'o=- 99 2 IN IP4 0.0.0.0', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', ''].join(CRLF);

interface LiveBody {
  session: Record<string, unknown> & { instructions: string };
  transport: { type: string; sdp: string };
}

interface Call {
  url: string;
  init: RequestInit;
  body: LiveBody;
}

function recordingFetch(responses: (Response | Error)[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) as LiveBody });
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error('unexpected call'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const created = (extra: Record<string, unknown> = {}) => json({ session: { id: 'live_123', ...extra }, transport: { type: 'webrtc', sdp: ANSWER } }, 201);

function config(fetchImpl: typeof fetch, overrides: Partial<LiveSessionConfig> = {}): LiveSessionConfig {
  return { apiKey: KEY, baseUrl: 'https://api.openai.com/v1', model: 'gpt-live-1', voice: 'marin', instructions: 'Ты — Гамбитик.', sdp: OFFER, fetchImpl, retryDelayMs: 0, ...overrides };
}

/** what undici throws when no HTTP answer came back: TypeError('fetch failed') with the real reason in `cause` */
const fetchFailed = (code: string, name = 'Error', message = `connect ${code} 2a06:98c1:58::f3:443`) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { name, code }) });

const KEY_ECHO = { error: { message: `Incorrect API key provided: sk-test-********************abcd (${KEY}) <script>alert(1)</script>`, type: 'invalid_request_error', code: 'invalid_api_key' } };

describe('createLiveSession', () => {
  it('answers no-api-key without touching the network', async () => {
    const { fetchImpl, calls } = recordingFetch([]);
    expect(await createLiveSession(config(fetchImpl, { apiKey: null }))).toEqual({ ok: false, status: 503, error: 'no-api-key' });
    expect(calls).toHaveLength(0);
  });

  it('posts { session, transport: { type: webrtc, sdp } } as JSON and returns only the SDP answer', async () => {
    const { fetchImpl, calls } = recordingFetch([created({ expires_at: 1_790_003_600 })]);
    const result = await createLiveSession(config(fetchImpl));
    expect(result).toEqual({
      ok: true,
      session: { provider: 'openai-live', sdp: ANSWER, model: 'gpt-live-1', voice: 'marin', sessionId: 'live_123', expiresAt: 1_790_003_600_000 },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);

    const call = calls[0];
    expect(call?.url).toBe('https://api.openai.com/v1/live/sessions');
    expect(call?.init.method).toBe('POST');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['OpenAI-Safety-Identifier']).toMatch(/^[0-9a-f]{64}$/);
    expect(call?.body.transport).toEqual({ type: 'webrtc', sdp: OFFER });
    // exactly the documented session fields — the API validates the object strictly
    expect(call?.body.session).toEqual({
      model: 'gpt-live-1',
      instructions: 'Ты — Гамбитик.',
      audio: { output: { voice: 'marin' } },
      delegation: { type: 'client' },
      store: false,
      client: { data_channel: { allowed_client_events: [...LIVE_ALLOWED_CLIENT_EVENTS] } },
    });
    expect(LIVE_ALLOWED_CLIENT_EVENTS).toEqual(
      expect.arrayContaining(['session.thinking.append', 'session.commentary.append', 'session.instructions.append', 'session.input_audio.mute', 'session.input_audio.unmute']),
    );
    expect(LIVE_ALLOWED_CLIENT_EVENTS).not.toContain('session.update');
  });

  it('works without session.id / expires_at in the answer', async () => {
    const { fetchImpl } = recordingFetch([json({ transport: { type: 'webrtc', sdp: ANSWER } }, 201)]);
    const result = await createLiveSession(config(fetchImpl));
    expect(result).toMatchObject({ ok: true, session: { sessionId: null, expiresAt: null } });
  });

  it('retries once without the data-channel allow-list when the API rejects it', async () => {
    const rejected = json({ error: { message: "Invalid value in 'session.client.data_channel.allowed_client_events[5]'", type: 'invalid_request_error', param: 'session.client.data_channel.allowed_client_events' } }, 400);
    const { fetchImpl, calls } = recordingFetch([rejected, created()]);
    const result = await createLiveSession(config(fetchImpl));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.session).toHaveProperty('client');
    expect(calls[1]?.body.session).not.toHaveProperty('client');
    expect(buildLiveSessionBody(config(fetchImpl), { restrictClientEvents: false }).session).not.toHaveProperty('client');
  });

  it('does not retry any other 400', async () => {
    const { fetchImpl, calls } = recordingFetch([json({ error: { message: 'Invalid SDP offer', type: 'invalid_request_error', param: 'transport.sdp' } }, 400)]);
    const result = await createLiveSession(config(fetchImpl));
    expect(result).toMatchObject({ ok: false, upstreamStatus: 400, detail: 'OpenAI Live answered 400 (type=invalid_request_error, param=transport.sdp)' });
    expect(calls).toHaveLength(1);
  });

  it('maps upstream problems to 502 with the status and identifiers only — never upstream text', async () => {
    const rejected = await createLiveSession(config(recordingFetch([json(KEY_ECHO, 401)]).fetchImpl));
    expect(rejected).toEqual({
      ok: false,
      status: 502,
      error: 'voice-upstream',
      upstreamStatus: 401,
      detail: 'OpenAI Live answered 401 (type=invalid_request_error, code=invalid_api_key)',
      reason: 'http:401',
      attempts: 1,
    });

    const notFound = await createLiveSession(config(recordingFetch([json({ error: { message: 'The model gpt-live-1 does not exist', code: 'model_not_found' } }, 404)]).fetchImpl));
    expect(notFound).toMatchObject({ upstreamStatus: 404, detail: 'OpenAI Live answered 404 (code=model_not_found)' });

    const noSdp = await createLiveSession(config(recordingFetch([json({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: '<html>' } }, 201)]).fetchImpl));
    expect(noSdp).toMatchObject({ ok: false, status: 502, detail: 'OpenAI Live answered without an SDP answer' });

    const offline = await createLiveSession(config(recordingFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]).fetchImpl));
    expect(offline).toEqual({
      ok: false,
      status: 502,
      error: 'voice-upstream',
      upstreamStatus: null,
      detail: 'OpenAI Live is unreachable (net:unknown) [2 attempts]',
      reason: 'net:unknown',
      attempts: 2,
    });
    const slow = await createLiveSession(config(recordingFetch([Object.assign(new Error('t'), { name: 'TimeoutError' })]).fetchImpl));
    expect(slow).toMatchObject({ detail: 'OpenAI Live did not answer in time (8000 ms)', reason: 'timeout', attempts: 1 });
  });
});

describe('createLiveSession — why «OpenAI Live is unreachable», and one retry', () => {
  it('keeps the CAUSE of a failed fetch as a code (DNS, a closed keep-alive socket, a reset) — never its message', async () => {
    const { fetchImpl } = recordingFetch([fetchFailed('ENOTFOUND', 'Error', 'getaddrinfo ENOTFOUND api.openai.com'), fetchFailed('ENOTFOUND')]);
    const result = await createLiveSession(config(fetchImpl));
    expect(result).toMatchObject({ ok: false, upstreamStatus: null, reason: 'net:ENOTFOUND', attempts: 2, detail: 'OpenAI Live is unreachable (net:ENOTFOUND) [2 attempts]' });
    expect(JSON.stringify(result)).not.toMatch(/getaddrinfo|2a06/);
    // undici's own classes: the code wins over the class name
    const socket = await createLiveSession(config(recordingFetch([fetchFailed('UND_ERR_SOCKET', 'SocketError'), fetchFailed('ECONNRESET')]).fetchImpl));
    expect(socket).toMatchObject({ reason: 'net:ECONNRESET', detail: 'OpenAI Live is unreachable (net:ECONNRESET) [2 attempts, first: net:UND_ERR_SOCKET]' });
  });

  it('a network blip is retried once: the second attempt opens the session (and says after what)', async () => {
    const { fetchImpl, calls } = recordingFetch([fetchFailed('UND_ERR_SOCKET', 'SocketError', 'other side closed'), created()]);
    const result = await createLiveSession(config(fetchImpl));
    expect(result).toMatchObject({ ok: true, retriedAfter: 'net:UND_ERR_SOCKET', session: { provider: 'openai-live', sdp: ANSWER } });
    expect(calls).toHaveLength(2);
    // the retry is the same request (same offer, same allow-list)
    expect(calls[1]?.body).toEqual(calls[0]?.body);
  });

  it('a 5xx of the service is retried once; a 4xx (key, model, SDP) and a 429 never are', async () => {
    const hiccup = recordingFetch([json({ error: { type: 'server_error' } }, 503), created()]);
    expect(await createLiveSession(config(hiccup.fetchImpl))).toMatchObject({ ok: true, retriedAfter: 'http:503' });
    expect(hiccup.calls).toHaveLength(2);

    const down = recordingFetch([json({}, 502), json({}, 502)]);
    expect(await createLiveSession(config(down.fetchImpl))).toMatchObject({ ok: false, upstreamStatus: 502, reason: 'http:502', attempts: 2 });

    for (const status of [401, 404, 429]) {
      const refused = recordingFetch([json({ error: { code: 'x' } }, status), created()]);
      expect(await createLiveSession(config(refused.fetchImpl)), String(status)).toMatchObject({ ok: false, upstreamStatus: status, reason: `http:${status}`, attempts: 1 });
      expect(refused.calls).toHaveLength(1);
    }
  });

  it('a timeout is not retried (the budget is spent), and no retry starts without enough budget left', async () => {
    const slow = recordingFetch([Object.assign(new Error('t'), { name: 'TimeoutError' }), created()]);
    expect(await createLiveSession(config(slow.fetchImpl))).toMatchObject({ ok: false, reason: 'timeout', attempts: 1 });
    expect(slow.calls).toHaveLength(1);

    let t = 0;
    const late = recordingFetch([fetchFailed('ECONNRESET'), created()]);
    // the first attempt failed after 6 s of an 8 s budget: a second one could not finish in time
    const lateFetch: typeof fetch = (input, init) => {
      t += 6000;
      return late.fetchImpl(input, init);
    };
    const result = await createLiveSession(config(lateFetch, { now: () => t }));
    expect(result).toMatchObject({ ok: false, reason: 'net:ECONNRESET', attempts: 1 });
    expect(late.calls).toHaveLength(1);
  });

  it('the allow-list fallback still works and is not counted as the retry', async () => {
    const rejected = json({ error: { message: 'bad', type: 'invalid_request_error', param: 'session.client.data_channel.allowed_client_events' } }, 400);
    const { fetchImpl, calls } = recordingFetch([rejected, fetchFailed('ECONNRESET'), created()]);
    const result = await createLiveSession(config(fetchImpl));
    expect(result).toMatchObject({ ok: true, retriedAfter: 'net:ECONNRESET' });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body.session).not.toHaveProperty('client');
  });
});

describe('live helpers', () => {
  it('recognises an SDP blob', () => {
    expect(isPlausibleSdp(OFFER)).toBe(true);
    expect(isPlausibleSdp('v=0\nm=audio 9 RTP/AVP 0\n')).toBe(true);
    expect(isPlausibleSdp('hello, this is not an SDP offer')).toBe(false);
    expect(isPlausibleSdp(['v=0', 's=-', 't=0 0', 'a=no-media-section', ''].join(CRLF))).toBe(false);
    expect(isPlausibleSdp(`${OFFER}${String.fromCharCode(0)}`)).toBe(false);
    expect(isPlausibleSdp(42)).toBe(false);
  });

  it('keeps the live addendum Russian-only (Latin tokens invite language drift)', () => {
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).not.toMatch(/[A-Za-z]/);
    // silent context notes must not be read aloud — the instructions name their marker
    // (apps/web/src/coach/liveProtocol.ts LIVE_CONTEXT_PREFIX_RU starts with the same two words)
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toContain('«Служебная заметка»');
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/вслух не произноси/);
    // a second question right after a hint is delegated again, not answered from memory
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/Каждый новый такой вопрос передавай заново/);
    // nothing is read out verbatim (it sounds canned) — own words, small talk answered directly
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).not.toMatch(/дословно|целиком|близко к тексту/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/своими словами/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/в любой момент, не нажимая никаких кнопок/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/«а если я пойду…»/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/Болтовня — отвечай сам/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/«Момент», «Факты», «Можно назвать», «Цель», «Нельзя»/);
    // teacher mode (docs/TEACHER-MODE.md §6.1): the advice every move is an important moment, never «don't comment on every move»
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/совете учителя на ходу ученика/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/В режиме «Учитель» приложение присылает совет почти на каждом ходу ученика/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/Ходы ученика называй только из строки «Можно назвать»/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/ход за него не делай/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/«а почему не ферзём\?»/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).not.toMatch(/комментируй каждый ход|не комментируй/i);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).not.toMatch(/(?<!не говори «)лучший ход(?!»)/);
    // no reading out what is visible («у тебя осталось четыре минуты…»), no extra talk:
    // never the clock / colours / whose turn; short; the opponent's move only when it matters; no «что выберешь?» every move
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/Никогда не говори о часах, минутах и секундах, о цвете фигур, о том, чей сейчас ход/);
    // …but a direct question gets its two words, as in the main prompt (the addendum comes after it and must not forbid that)
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/если ученик сам спросил, каким цветом он играет или чей ход, — ответь в двух словах/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/Говори очень коротко, не больше двадцати слов: какой ход советуешь и одну причину/);
    // the same teacher rules as the main prompt: defence / tactics are never «the plan», the start varies
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/защиту, взятие, тактику планом не называй/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/Начинай так, как просит «Цель», а не всегда «По нашему плану»/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).not.toMatch(/одну причину по плану этой партии/);
    // («ничего лишнего»: no opponent's move, praise, topic or question the «Цель» did not ask for)
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/Ничего не добавляй от себя: ни похвалы, ни хода соперника, ни новой темы, ни вопроса — только то, что просит «Цель»/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).not.toMatch(/до пяти|больше — только когда/);
    expect(LIVE_INSTRUCTIONS_ADDENDUM_RU).toMatch(/не больше двадцати слов — даже когда объясняешь новую тему/);
    const text = buildLiveInstructions('  ПРОМПТ  ', '# Об ученике\nПсевдоним: Миша.');
    expect(text.startsWith('ПРОМПТ\n\n# Живой разговор')).toBe(true);
    expect(text.endsWith('Псевдоним: Миша.')).toBe(true);
  });
});

describe('POST /api/voice/live', () => {
  it('creates a gpt-live-1 session with the coach prompt + the student brief', async () => {
    const { fetchImpl, calls } = recordingFetch([created({ expires_at: 1_790_003_600 })]);
    const server = await createTestServer({ runtimeAi: true, openaiApiKey: KEY, voiceLiveVoice: 'cedar' }, { fetchImpl });
    try {
      const res = await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER } });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      const body = JSON.parse(text) as LiveVoiceSessionResponse;
      expect(body).toEqual({ provider: 'openai-live', sdp: ANSWER, model: 'gpt-live-1', voice: 'cedar', sessionId: 'live_123', expiresAt: 1_790_003_600_000 });

      expect(calls[0]?.url).toBe('https://api.openai.com/v1/live/sessions');
      expect(calls[0]?.body.session).toMatchObject({ model: 'gpt-live-1', audio: { output: { voice: 'cedar' } }, delegation: { type: 'client' }, store: false });
      const instructions = String(calls[0]?.body.session.instructions);
      expect(instructions).toContain(server.ctx.content.coachSystemPromptRu.trim().slice(0, 40));
      expect(instructions).toContain('# Живой разговор');
      expect(instructions).toContain('# Об ученике');
      expect(calls[0]?.body.transport.sdp).toBe(OFFER);
    } finally {
      await server.cleanup();
    }
  });

  it('answers 502 { error, status } on an upstream 4xx — sanitised in the browser AND in the log', async () => {
    const { fetchImpl } = recordingFetch([json(KEY_ECHO, 401)]);
    const logs: string[] = [];
    const server = await createTestServer({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl, log: (m) => logs.push(m) });
    try {
      const res = await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER } });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'voice-upstream', status: 401, reason: 'http:401' });
      const logged = logs.join(' | ');
      expect(logged).toContain('[voice] live: OpenAI Live answered 401 (type=invalid_request_error, code=invalid_api_key)');
      expect(logged).not.toMatch(/sk-test|abcd|script/);
    } finally {
      await server.cleanup();
    }
  });

  it('answers 503 no-api-key without a key and never calls out', async () => {
    const { fetchImpl, calls } = recordingFetch([]);
    const server = await createTestServer({}, { fetchImpl });
    try {
      const res = await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER } });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'no-api-key' });
      expect(calls).toHaveLength(0);
    } finally {
      await server.cleanup();
    }
  });

  it('an automated browser never gets a (paid) live session, even with a key', async () => {
    const { fetchImpl, calls } = recordingFetch([created()]);
    const server = await createTestServer({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl });
    try {
      const res = await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER }, headers: { 'x-gambit-automation': '1' } });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'no-api-key' });
      expect(calls).toHaveLength(0);
    } finally {
      await server.cleanup();
    }
  });

  it('runtime AI off (GAMBIT_RUNTIME_AI unset, the default): no paid session on either route, key or not — before the body is read', async () => {
    const { fetchImpl, calls } = recordingFetch([created(), created()]);
    const server = await createTestServer({ openaiApiKey: KEY }, { fetchImpl });
    try {
      expect(server.ctx.config.runtimeAi).toBe(false);
      for (const [path, body] of [
        ['/api/voice/live', { sdp: OFFER }],
        ['/api/voice/live', {}],
        ['/api/voice/session', {}],
        ['/api/voice/session', { voice: 'ash' }],
      ] as const) {
        const res = await server.request(path, { method: 'POST', json: body });
        expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(503);
        expect(await res.json()).toEqual({ error: 'no-api-key' });
      }
      expect(calls).toHaveLength(0);
    } finally {
      await server.cleanup();
    }
  });

  it('validates the body before spending anything', async () => {
    const { fetchImpl, calls } = recordingFetch([]);
    const server = await createTestServer({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl });
    try {
      for (const body of [{}, { sdp: 'hello' }, { sdp: 42 }]) {
        const res = await server.request('/api/voice/live', { method: 'POST', json: body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(calls).toHaveLength(0);
    } finally {
      await server.cleanup();
    }
  });
});

describe('voice usage log', () => {
  it('accumulates reported seconds per provider and exposes today / month totals', async () => {
    const server = await createTestServer();
    try {
      const empty = await (await server.request('/api/voice/usage')).json();
      expect(empty).toMatchObject({ todaySeconds: 0, monthSeconds: 0, byProvider: {} });

      for (const body of [
        { provider: 'openai-live', seconds: 61.4 },
        { provider: 'openai-live', seconds: 30 },
        { provider: 'openai-realtime', seconds: 12 },
      ]) {
        const res = await server.request('/api/voice/usage', { method: 'POST', json: body });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      }
      const usage = (await (await server.request('/api/voice/usage')).json()) as { today: string; month: string; todaySeconds: number; monthSeconds: number; byProvider: Record<string, unknown> };
      expect(usage.todaySeconds).toBe(103);
      expect(usage.monthSeconds).toBe(103);
      expect(usage.byProvider).toEqual({ 'openai-live': { todaySeconds: 91, monthSeconds: 91 }, 'openai-realtime': { todaySeconds: 12, monthSeconds: 12 } });
      expect(usage.today.startsWith(usage.month)).toBe(true);
    } finally {
      await server.cleanup();
    }
  });

  it('accepts the usage beacon of a closing page (navigator.sendBeacon: text/plain JSON) — same-origin only, this route only', async () => {
    const server = await createTestServer();
    try {
      const beacon = (headers: Record<string, string>, body = JSON.stringify({ provider: 'openai-live', seconds: 40 }), path = '/api/voice/usage') =>
        server.app.request(path, { method: 'POST', headers: { host: '127.0.0.1:8787', 'content-type': 'text/plain;charset=UTF-8', ...headers }, body });

      // what Chromium sends (verified): our Origin + Sec-Fetch-Site: same-origin, mode no-cors
      const fromPage = await beacon({ origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors' });
      expect(fromPage.status).toBe(200);
      expect(await fromPage.json()).toEqual({ ok: true });
      // a browser that sends no Origin but fetch metadata
      expect((await beacon({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
      // the dev page behind the Vite proxy
      expect((await beacon({ origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
      expect(((await (await server.request('/api/voice/usage')).json()) as { todaySeconds: number }).todaySeconds).toBe(120);

      // no proof of the origin (curl, an old browser): JSON only
      expect((await beacon({})).status).toBe(415);
      // cross-site: refused before anything is read
      expect((await beacon({ origin: 'https://evil.example' })).status).toBe(403);
      expect((await beacon({ origin: 'null' })).status).toBe(403);
      expect((await beacon({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await beacon({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
      // other routes stay JSON-only even from our own page (the paid session route above all)
      expect((await beacon({ origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }, '{}', '/api/voice/session')).status).toBe(415);
      expect((await beacon({ origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }, '{"sdp":"v=0"}', '/api/voice/live')).status).toBe(415);
      expect((await beacon({ origin: 'http://127.0.0.1:8787' }, '{"address":"f"}', '/api/student')).status).toBe(415);
      // a form post is still refused on this route
      const form = await server.app.request('/api/voice/usage', {
        method: 'POST',
        headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'provider=openai-live&seconds=40',
      });
      expect(form.status).toBe(415);
      // a malformed or invalid beacon body is a 400, and nothing is recorded
      expect((await beacon({ origin: 'http://127.0.0.1:8787' }, 'not json')).status).toBe(400);
      expect((await beacon({ origin: 'http://127.0.0.1:8787' }, JSON.stringify({ provider: 'openai-live', seconds: 99_999 }))).status).toBe(400);
      expect(((await (await server.request('/api/voice/usage')).json()) as { todaySeconds: number }).todaySeconds).toBe(120);
    } finally {
      await server.cleanup();
    }
  });

  it('production: the dev origin cannot send a beacon either', async () => {
    const server = await createTestServer({ production: true });
    try {
      const res = await server.app.request('/api/voice/usage', {
        method: 'POST',
        headers: { host: '127.0.0.1:8787', origin: 'http://localhost:5173', 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ provider: 'openai-live', seconds: 40 }),
      });
      expect(res.status).toBe(403);
      expect(((await (await server.request('/api/voice/usage')).json()) as { todaySeconds: number }).todaySeconds).toBe(0);
    } finally {
      await server.cleanup();
    }
  });

  it('validates reports and ignores automated runs', async () => {
    const server = await createTestServer();
    try {
      for (const body of [{ provider: 'openrouter', seconds: 5 }, { provider: 'openai-live', seconds: -1 }, { provider: 'openai-live', seconds: 99_999 }, { provider: 'openai-live' }]) {
        expect((await server.request('/api/voice/usage', { method: 'POST', json: body })).status, JSON.stringify(body)).toBe(400);
      }
      const automated = await server.request('/api/voice/usage', { method: 'POST', json: { provider: 'openai-live', seconds: 50 }, headers: { 'x-gambit-automation': '1' } });
      expect(automated.status).toBe(200);
      expect(await (await server.request('/api/voice/usage')).json()).toMatchObject({ todaySeconds: 0, monthSeconds: 0 });
    } finally {
      await server.cleanup();
    }
  });
});
