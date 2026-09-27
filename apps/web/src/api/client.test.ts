import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoachEvent, GameStrategy, HealthInfo, PuzzleAttempt, ReplanRequest, ReplanResponse, StrategyRequest } from '@gambit/shared';
import {
  AUTOMATION_HEADER,
  ApiError,
  REPLAN_TIMEOUT_MS,
  STRATEGY_TIMEOUT_MS,
  createLiveVoiceSession,
  createVoiceSession,
  getClipGenStatus,
  getConceptCard,
  getGame,
  getGameReview,
  getHealth,
  getStrategy,
  getVoiceUsage,
  isApiError,
  listGames,
  nextPuzzles,
  parseVoiceUsage,
  rephraseCoachEvent,
  replan,
  requestClipGen,
  saveClipGenSettings,
  submitPuzzleAttempt,
  updateStudent,
} from './client.ts';

type FetchArgs = [input: string, init: RequestInit];

function stubFetch(respond: (...args: FetchArgs) => Response | Promise<Response>) {
  const mock = vi.fn<(...args: FetchArgs) => Promise<Response>>(async (input, init) => respond(input, init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('GETs /api/health and returns the parsed body', async () => {
    const health: HealthInfo = {
      ok: true,
      llm: { codexCli: false, codexLoggedIn: false, openaiKey: false },
      voice: { realtime: false, model: 'gpt-realtime-2.1', voice: 'marin' },
      puzzles: { count: 0 },
    };
    const fetchMock = stubFetch(() => json(health));

    await expect(getHealth()).resolves.toEqual(health);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/health');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('builds query strings and skips empty parameters', async () => {
    const fetchMock = stubFetch(() => json([]));

    await listGames();
    await listGames(5);
    await nextPuzzles();
    await nextPuzzles({ theme: 'fork', count: 3 });
    await nextPuzzles({ theme: '', count: 10 });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/games?limit=50',
      '/api/games?limit=5',
      '/api/puzzles/next',
      '/api/puzzles/next?theme=fork&count=3',
      '/api/puzzles/next?count=10',
    ]);
  });

  it('URL-encodes path parameters', async () => {
    const fetchMock = stubFetch(() => json({}));

    await getGame('2026/09 a');
    await getGameReview('id#1');
    await getConceptCard('вилка');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/games/2026%2F09%20a',
      '/api/games/id%231/review',
      `/api/kb/${encodeURIComponent('вилка')}`,
    ]);
  });

  it('sends JSON bodies with the right method and content type', async () => {
    const fetchMock = stubFetch(() => json({}));
    const attempt: PuzzleAttempt = { puzzleId: 'p1', solved: true, msSpent: 4200, hintsUsed: 0, themes: ['fork'], puzzleRating: 700 };
    const event: CoachEvent = { id: 'e1', kind: 'praise', priority: 0, text: 'Отличный ход!', bubbleText: 'Отличный ход!', pose: 'cheer', pauseClock: false };

    await updateStudent({ nickname: 'Лисёнок', stage: 2 });
    await submitPuzzleAttempt(attempt);
    await rephraseCoachEvent(event);

    const [putCall, attemptCall, rephraseCall] = fetchMock.mock.calls;
    expect(putCall![0]).toBe('/api/student');
    expect(putCall![1].method).toBe('PUT');
    expect(new Headers(putCall![1].headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(putCall![1].body))).toEqual({ nickname: 'Лисёнок', stage: 2 });

    expect(attemptCall![0]).toBe('/api/puzzles/attempt');
    expect(attemptCall![1].method).toBe('POST');
    expect(JSON.parse(String(attemptCall![1].body))).toEqual(attempt);

    expect(rephraseCall![0]).toBe('/api/coach/rephrase');
    expect(JSON.parse(String(rephraseCall![1].body))).toEqual({ event });
  });

  it('throws a typed ApiError carrying the server error code on non-2xx', async () => {
    stubFetch(() => json({ error: 'no-api-key' }, 503));

    const error = await captureError(createVoiceSession());

    expect(error).toBeInstanceOf(ApiError);
    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.status).toBe(503);
    expect(error.code).toBe('no-api-key');
    expect(error.method).toBe('POST');
    expect(error.path).toBe('/voice/session');
    expect(error.body).toEqual({ error: 'no-api-key' });
    expect(error.message).toContain('503');
  });

  it('falls back to an http-<status> code when the error body is not JSON', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 }));

    const error = await captureError(getGame('missing'));

    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.status).toBe(404);
    expect(error.code).toBe('http-404');
    expect(error.body).toBe('Not Found');
  });

  it('wraps network failures as ApiError with status 0', async () => {
    const cause = new TypeError('fetch failed');
    stubFetch(() => Promise.reject(cause));

    const error = await captureError(getHealth());

    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.status).toBe(0);
    expect(error.code).toBe('network');
    expect(error.cause).toBe(cause);
  });

  it('reports a malformed 2xx body as bad-json', async () => {
    stubFetch(() => new Response('<html>oops</html>', { status: 200 }));

    const error = await captureError(getHealth());

    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) return;
    expect(error.status).toBe(200);
    expect(error.code).toBe('bad-json');
  });

  it('rethrows AbortError untouched and forwards the signal', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const fetchMock = stubFetch(() => Promise.reject(abortError));
    const controller = new AbortController();

    const error = await captureError(getHealth({ signal: controller.signal }));

    expect(error).toBe(abortError);
    expect(fetchMock.mock.calls[0]![1].signal).toBe(controller.signal);
  });
});

describe('live voice routes', () => {
  it('POSTs the SDP offer to /api/voice/live — the key never leaves the server', async () => {
    const answer = { provider: 'openai-live', sdp: 'v=0 answer', model: 'gpt-live-1', voice: 'marin', sessionId: null, expiresAt: null };
    const fetchMock = stubFetch(() => json(answer));

    await expect(createLiveVoiceSession('v=0 offer')).resolves.toEqual(answer);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/voice/live');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ sdp: 'v=0 offer' });
  });

  it('reads the voice usage and tolerates junk in the body', async () => {
    stubFetch(() => json({ todaySeconds: 95, monthSeconds: 3600, byProvider: { 'openai-live': 3000, 'openai-realtime': 'many', odd: -4 } }));
    await expect(getVoiceUsage()).resolves.toEqual({ todaySeconds: 95, monthSeconds: 3600, byProvider: { 'openai-live': 3000, 'openai-realtime': 0, odd: 0 } });

    expect(parseVoiceUsage(null)).toBeNull();
    expect(parseVoiceUsage([1, 2])).toBeNull();
    expect(parseVoiceUsage({ todaySeconds: Number.NaN })).toEqual({ todaySeconds: 0, monthSeconds: 0, byProvider: {} });
  });

  it('an older server without /voice/usage (404) means "no numbers", not an error', async () => {
    stubFetch(() => json({ error: 'not-found' }, 404));
    await expect(getVoiceUsage()).resolves.toBeNull();
  });

  it('other usage failures still reject', async () => {
    stubFetch(() => json({ error: 'internal-error' }, 500));
    const error = await captureError(getVoiceUsage());
    expect(isApiError(error) && error.status).toBe(500);
  });
});

describe('the smart strategist («Учитель»): /coach/strategy and /coach/replan', () => {
  const strategyRequest: StrategyRequest = { childColor: 'w', stage: 1, personaId: 'petya', timeControlId: 'training' };
  const strategy: GameStrategy = {
    strategyId: 'italian',
    titleRu: 'Итальянская партия',
    introRu: 'В этот раз разыграем Итальянскую партию, поэтому начни пешкой на е четыре.',
    ideaRu: 'Быстро выводим фигуры и целимся в слабую точку.',
    provider: 'template',
  };
  const replanRequest: ReplanRequest = {
    ply: 5,
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
    childColor: 'w',
    strategyId: 'italian',
    movesSan: ['e4', 'e5', 'Nf3', 'Nc6'],
    candidates: [{ uci: 'f1c4', san: 'Bc4', cp: 20, ideasRu: ['выводит слона'] }],
    stage: 1,
  };
  const replanAnswer: ReplanResponse = { ply: 5, planRu: 'Выводим слона и готовим рокировку.', preferredUci: 'f1c4', whyRu: 'Слон смотрит на слабую точку.', provider: 'openrouter' };

  /** A fetch that never answers on its own — it only settles when its signal aborts (like the real one). */
  function hangingFetch() {
    return stubFetch(
      (_input, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
        }),
    );
  }

  it('POSTs the request as JSON and returns the answer', async () => {
    const fetchMock = stubFetch((input) => json(input.endsWith('/strategy') ? strategy : replanAnswer));
    await expect(getStrategy(strategyRequest)).resolves.toEqual(strategy);
    await expect(replan(replanRequest)).resolves.toEqual(replanAnswer);
    const [strategyCall, replanCall] = fetchMock.mock.calls;
    expect(strategyCall![0]).toBe('/api/coach/strategy');
    expect(strategyCall![1].method).toBe('POST');
    expect(new Headers(strategyCall![1].headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(strategyCall![1].body))).toEqual(strategyRequest);
    expect(replanCall![0]).toBe('/api/coach/replan');
    expect(JSON.parse(String(replanCall![1].body))).toEqual(replanRequest);
    // the fetch always gets a signal: the timeout can end it
    expect(strategyCall![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('a server that does not answer in time → ApiError «timeout» (the fetch is aborted)', async () => {
    const fetchMock = hangingFetch();
    const error = await captureError(getStrategy(strategyRequest, { timeoutMs: 20 }));
    expect(isApiError(error) && error.code).toBe('timeout');
    expect(isApiError(error) && error.status).toBe(0);
    expect(fetchMock.mock.calls[0]![1].signal?.aborted).toBe(true);
    const late = await captureError(replan(replanRequest, { timeoutMs: 20 }));
    expect(isApiError(late) && late.code).toBe('timeout');
    // the defaults: a little over the server's 8 s budget; a re-plan is useless after two moves
    expect(STRATEGY_TIMEOUT_MS).toBeGreaterThan(8_000);
    expect(REPLAN_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
  });

  it('the caller\'s signal aborts it with the native AbortError (a stale re-plan is cancelled, not timed out)', async () => {
    hangingFetch();
    const controller = new AbortController();
    const pending = captureError(replan(replanRequest, { signal: controller.signal, timeoutMs: 5_000 }));
    controller.abort();
    const error = await pending;
    expect(isApiError(error)).toBe(false);
    expect((error as Error).name).toBe('AbortError');
    // an already aborted signal never reaches the network
    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const again = await captureError(getStrategy(strategyRequest, { signal: controller.signal }));
    expect((again as Error).name).toBe('AbortError');
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
  });

  it('an older server without the route → ApiError 404; automation marks the request (the server answers with its free template)', async () => {
    stubFetch(() => json({ error: 'not-found' }, 404));
    const error = await captureError(getStrategy(strategyRequest));
    expect(isApiError(error) && error.status).toBe(404);
    const fetchMock = stubFetch(() => json(strategy));
    vi.stubGlobal('navigator', { webdriver: true });
    await getStrategy(strategyRequest);
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get(AUTOMATION_HEADER)).toBe('1');
  });
});

describe('automation marker', () => {
  it('ordinary browsers send no marker; an automation-driven browser marks every request', async () => {
    const fetchMock = stubFetch(() => json({ ok: true }));

    await getHealth();
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).has(AUTOMATION_HEADER)).toBe(false);

    vi.stubGlobal('navigator', { webdriver: true });
    await getHealth();
    await updateStudent({ nickname: 'Лисёнок' });
    expect(new Headers(fetchMock.mock.calls[1]![1].headers).get(AUTOMATION_HEADER)).toBe('1');
    expect(new Headers(fetchMock.mock.calls[2]![1].headers).get(AUTOMATION_HEADER)).toBe('1');
    expect(new Headers(fetchMock.mock.calls[2]![1].headers).get('Content-Type')).toBe('application/json');
  });
});

describe('«Дозапись голоса» routes', () => {
  it('POST /api/voice/clips/request with the ids; GET status; PUT settings — the server\'s answers come back as they are', async () => {
    const result = { results: [{ outcome: 'queued', keys: ['line:v3.whole.castle#1'] }], health: { state: 'ready', overlay: true }, queue: 1 };
    const fetchMock = stubFetch(() => json(result, 202));
    const body = { sentences: [{ parts: [{ pool: 'v3.whole.castle', n: 1 }] as [{ pool: string; n: number }] }], kind: 'teachTurn' as const };
    await expect(requestClipGen(body)).resolves.toEqual(result);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/voice/clips/request');
    expect(fetchMock.mock.calls[0]![1].method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))).toEqual(body);

    const status = { health: { state: 'paused', reason: 'parent-off', until: null, overlay: true }, enabled: false, queue: 0, busy: false, overlay: null, spent: { today: '2026-09-24', todayMilli: 0, totalMilli: 0, prefetchMilli: 0 }, caps: { dailyMilli: 3000, dailyMaxMilli: 3000, totalMilli: 60000 }, givenUp: 0 };
    const statusMock = stubFetch(() => json(status));
    await expect(getClipGenStatus()).resolves.toEqual(status);
    expect(statusMock.mock.calls[0]![0]).toBe('/api/voice/clips/status');
    await saveClipGenSettings({ enabled: true, dailyCapMilli: 3000 });
    expect(statusMock.mock.calls[1]![0]).toBe('/api/voice/clips/settings');
    expect(statusMock.mock.calls[1]![1].method).toBe('PUT');
    expect(JSON.parse(String(statusMock.mock.calls[1]![1].body))).toEqual({ enabled: true, dailyCapMilli: 3000 });
  });

  it('recording off → ApiError 503 clip-gen-off; an automated browser never POSTs (not even with the marker)', async () => {
    stubFetch(() => json({ error: 'clip-gen-off' }, 503));
    const error = await captureError(requestClipGen({ sentences: [{ parts: [{ pool: 'v3.whole.castle', n: 1 }] }] }));
    expect(isApiError(error) && error.status === 503 && error.code).toBe('clip-gen-off');
    const fetchMock = stubFetch(() => json({}));
    vi.stubGlobal('navigator', { webdriver: true });
    await expect(requestClipGen({ sentences: [{ parts: [{ pool: 'v3.whole.castle', n: 1 }] }] })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
