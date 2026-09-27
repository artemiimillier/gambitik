import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApiError } from '../api/client.ts';
import { createLiveVoiceSession, createRealtimeVoiceSession, getVoiceChoice, parseVoiceChoice, reportVoiceUsage, saveVoiceChoice, upstreamReason } from './liveApi.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';

const okBody = { provider: 'openai-live', sdp: 'v=0 answer', model: 'gpt-live-1', voice: 'marin', sessionId: 'live_1', expiresAt: null };

function fetchReturning(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })));
}

describe('liveApi', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs the SDP offer as JSON to /api/voice/live and returns the typed answer', async () => {
    const fetchImpl = fetchReturning(201, okBody);
    const result = await createLiveVoiceSession('v=0 offer', { fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false });
    expect(result).toEqual(okBody);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/voice/live');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ sdp: 'v=0 offer' });
    expect(init.signal).toBeInstanceOf(AbortSignal); // bounded: a stalled server cannot hold the coach
  });

  it('503 { error: "no-api-key" } becomes an ApiError the layers understand', async () => {
    const fetchImpl = fetchReturning(503, { error: 'no-api-key' });
    const error = await createLiveVoiceSession('x', { fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false }).catch((e: unknown) => e);
    expect(isApiError(error)).toBe(true);
    expect(error).toMatchObject({ status: 503, code: 'no-api-key', path: '/voice/live' });
  });

  it('never keeps upstream error text (it may carry key fragments): only status and code survive', async () => {
    const fetchImpl = fetchReturning(502, { error: 'voice-upstream', detail: 'Incorrect API key provided: sk-FAKE-masked' });
    const error = await createLiveVoiceSession('x', { fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'voice-upstream' });
    expect(isApiError(error) ? error.body : 'x').toBeUndefined();
    expect(String(error)).not.toMatch(/sk-/);
  });

  it('a network failure and a malformed answer are ApiErrors too', async () => {
    const down = vi.fn(() => Promise.reject(new TypeError('failed to fetch')));
    await expect(createLiveVoiceSession('x', { fetchImpl: down as unknown as typeof fetch, isSilenced: () => false })).rejects.toMatchObject({ status: 0, code: 'network' });
    const html = fetchReturning(200, '<html>');
    await expect(createLiveVoiceSession('x', { fetchImpl: html as unknown as typeof fetch, isSilenced: () => false })).rejects.toMatchObject({ code: 'bad-json' });
    const wrong = fetchReturning(200, { provider: 'openai-realtime', clientSecret: 'ek' });
    await expect(createLiveVoiceSession('x', { fetchImpl: wrong as unknown as typeof fetch, isSilenced: () => false })).rejects.toMatchObject({ code: 'bad-json' });
  });

  it('automation: the request that would open a paid session is never even sent', async () => {
    const fetchImpl = fetchReturning(201, okBody);
    await expect(createLiveVoiceSession('x', { fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => true })).rejects.toMatchObject({ status: 503, code: 'no-api-key' });
    reportVoiceUsage('openai-live', 30, { fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reportVoiceUsage posts { provider, seconds } with keepalive and swallows every failure', () => {
    const fetchImpl = fetchReturning(200, {});
    reportVoiceUsage('openai-realtime', 41.6, { fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/voice/usage');
    expect(JSON.parse(String(init.body))).toEqual({ provider: 'openai-realtime', seconds: 42 });
    expect(init.keepalive).toBe(true);

    const failing = vi.fn(() => Promise.reject(new Error('offline')));
    expect(() => reportVoiceUsage('openai-live', 10, { fetchImpl: failing as unknown as typeof fetch, isSilenced: () => false })).not.toThrow();
    const throwing = vi.fn(() => {
      throw new Error('no fetch');
    });
    expect(() => reportVoiceUsage('openai-live', 10, { fetchImpl: throwing as unknown as typeof fetch, isSilenced: () => false })).not.toThrow();

    // nothing to report
    reportVoiceUsage('openai-live', 0.2, { fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false });
    reportVoiceUsage('openai-live', Number.NaN, { fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('the page is closing: reportVoiceUsage goes out with sendBeacon (a text/plain JSON string); a refused beacon falls back to keepalive', () => {
    const fetchImpl = fetchReturning(200, {});
    const sendBeacon = vi.fn((_url: string, _data: string) => true);
    reportVoiceUsage('openai-live', 95.4, { beacon: true, sendBeacon, fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false });
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, data] = sendBeacon.mock.calls[0] ?? [];
    expect(url).toBe('/api/voice/usage');
    expect(typeof data).toBe('string'); // a string body = text/plain, never preflighted
    expect(JSON.parse(String(data))).toEqual({ provider: 'openai-live', seconds: 95 });
    expect(fetchImpl).not.toHaveBeenCalled();

    const refused = vi.fn(() => false);
    reportVoiceUsage('openai-live', 10, { beacon: true, sendBeacon: refused, fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false });
    expect(refused).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].keepalive).toBe(true);

    const throwing = vi.fn(() => {
      throw new TypeError('beacon blocked');
    });
    expect(() => reportVoiceUsage('openai-live', 10, { beacon: true, sendBeacon: throwing, fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false })).not.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // automation: no beacon either
    const quiet = vi.fn(() => true);
    reportVoiceUsage('openai-live', 10, { beacon: true, sendBeacon: quiet, fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => true });
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe('liveApi — why a session failed, and the voice', () => {
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.restoreAllMocks();
  });

  it('the server\'s 502 `reason` (a short code) survives into the ApiError body and the black box — nothing else does', async () => {
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
    const fetchImpl = fetchReturning(502, { error: 'voice-upstream', status: null, reason: 'net:ENOTFOUND', detail: 'sk-FAKE leaked text' });
    const error = await createLiveVoiceSession('x', { fetchImpl: fetchImpl as unknown as typeof fetch, isSilenced: () => false }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'voice-upstream' });
    expect(isApiError(error) ? error.body : null).toEqual({ reason: 'net:ENOTFOUND' });
    expect(voiceDiagRecent().find((entry) => entry.e === 'sess.upstream')).toMatchObject({ path: '/voice/live', status: 502, reason: 'net:ENOTFOUND' });
    // a reason that is not a plain code is dropped
    expect(upstreamReason({ reason: 'Incorrect API key sk-xyz' })).toBeNull();
    expect(upstreamReason({ reason: 'http:503' })).toBe('http:503');
  });

  it('«Послушать»: the live request may name a voice; the realtime request for the preview too', async () => {
    const live = fetchReturning(201, okBody);
    await createLiveVoiceSession('v=0 offer', { voice: 'cedar', fetchImpl: live as unknown as typeof fetch, isSilenced: () => false });
    expect(JSON.parse(String((live.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ sdp: 'v=0 offer', voice: 'cedar' });

    const secret = fetchReturning(200, { provider: 'openai-realtime', clientSecret: 'ek_x', model: 'gpt-realtime-2.1', voice: 'ash', expiresAt: 1, instructionsApplied: true });
    const minted = await createRealtimeVoiceSession({ voice: 'ash', fetchImpl: secret as unknown as typeof fetch, isSilenced: () => false });
    expect(minted.voice).toBe('ash');
    const [url, init] = secret.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/voice/session');
    expect(JSON.parse(String(init.body))).toEqual({ voice: 'ash' });

    // automation: neither request is ever sent
    const never = fetchReturning(201, okBody);
    await expect(createRealtimeVoiceSession({ voice: 'ash', fetchImpl: never as unknown as typeof fetch, isSilenced: () => true })).rejects.toMatchObject({ status: 503 });
    expect(never).not.toHaveBeenCalled();
  });

  it('the parent\'s pick: GET and PUT /api/voice/voices; a tolerant reader; an older server without the route = no picker', async () => {
    const info = { selected: 'gleam', live: 'gleam', realtime: 'marin', defaults: { live: 'marin', realtime: 'marin' }, voices: [{ id: 'gleam', live: true, realtime: false }, { id: '<b>', live: true }, 'x'] };
    const get = fetchReturning(200, info);
    expect(await getVoiceChoice({ fetchImpl: get as unknown as typeof fetch, isSilenced: () => false })).toEqual({ ...info, voices: [{ id: 'gleam', live: true, realtime: false }] });
    const put = fetchReturning(200, { ...info, selected: 'cedar', live: 'cedar', realtime: 'cedar' });
    await saveVoiceChoice('cedar', { fetchImpl: put as unknown as typeof fetch, isSilenced: () => false });
    const [url, init] = put.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/voice/voices');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ voice: 'cedar' });
    expect(await getVoiceChoice({ fetchImpl: fetchReturning(404, {}) as unknown as typeof fetch, isSilenced: () => false })).toBeNull();
    expect(parseVoiceChoice({ nothing: true })).toBeNull();
    expect(parseVoiceChoice({ selected: null, live: 'marin', realtime: 'marin', voices: [] })).toMatchObject({ selected: null, defaults: { live: 'marin', realtime: 'marin' } });
  });
});
