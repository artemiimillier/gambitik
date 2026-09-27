/**
 * The parent's pick of Гамбитик's voice (a young, childlike voice — the .env default `marin` is an adult woman)
 * and the voice black box line of a failed Live session. FAKE fetch only — api.openai.com is never called.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestServer } from '../testing/fixtures.ts';
import type { TestServer } from '../testing/fixtures.ts';
import { VOICE_DIAG_FILE } from '../routes/diag.ts';
import { LIVE_ONLY_VOICES, LIVE_VOICES, REALTIME_VOICES, VoiceChoiceStore, resolveVoice } from './voices.ts';
import type { VoiceChoiceInfo } from './voices.ts';

const KEY = 'sk-test-permanent-key';
const CRLF = '\r\n';
const OFFER = ['v=0', 'o=- 46117317 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', ''].join(CRLF);
const ANSWER = ['v=0', 'o=- 99 2 IN IP4 0.0.0.0', 's=-', 't=0 0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', ''].join(CRLF);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Recorded {
  fetchImpl: typeof fetch;
  bodies: Record<string, unknown>[];
}

/** every call answers with the next response (or throws the next error) */
function recordingFetch(responses: (Response | Error)[]): Recorded {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error('unexpected call'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetchImpl, bodies };
}

const liveCreated = () => json({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: ANSWER } }, 201);
const secret = () => json({ value: 'ek_test_secret', expires_at: 1_790_000_120 });
const voiceOf = (body: Record<string, unknown> | undefined): unknown => ((body?.session as { audio?: { output?: { voice?: unknown } } } | undefined)?.audio?.output?.voice);

const servers: TestServer[] = [];
async function start(...args: Parameters<typeof createTestServer>): Promise<TestServer> {
  const server = await createTestServer(...args);
  servers.push(server);
  return server;
}
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.cleanup();
});

describe('the voice lists (research 03 §3.6, §4.3 — never fetched from the API)', () => {
  it('22 voices for gpt-live-1, the first 10 of them for gpt-realtime-2.x; marin and cedar in both', () => {
    expect(LIVE_VOICES).toHaveLength(22);
    expect(REALTIME_VOICES).toHaveLength(10);
    expect(new Set(LIVE_VOICES).size).toBe(22);
    for (const voice of REALTIME_VOICES) expect(LIVE_VOICES).toContain(voice);
    for (const voice of LIVE_ONLY_VOICES) expect(REALTIME_VOICES).not.toContain(voice);
    expect(REALTIME_VOICES).toEqual(expect.arrayContaining(['marin', 'cedar', 'coral', 'shimmer']));
    expect(LIVE_ONLY_VOICES).toEqual(expect.arrayContaining(['gleam', 'meridian']));
  });

  it('resolveVoice: the pick where that API has it, else the .env voice', () => {
    expect(resolveVoice('live', null, 'marin')).toBe('marin');
    expect(resolveVoice('live', 'gleam', 'marin')).toBe('gleam');
    // a Live-only voice: the fallback model keeps its own
    expect(resolveVoice('realtime', 'gleam', 'marin')).toBe('marin');
    expect(resolveVoice('realtime', 'cedar', 'marin')).toBe('cedar');
  });
});

describe('GET / PUT /api/voice/voices — the parent picks Гамбитик\'s voice', () => {
  it('nothing picked: the .env voices (marin) stay, the list has every voice with the API that knows it', async () => {
    const server = await start({ openaiApiKey: KEY, voiceName: 'marin', voiceLiveVoice: 'marin' });
    const info = (await (await server.request('/api/voice/voices')).json()) as VoiceChoiceInfo;
    expect(info).toMatchObject({ selected: null, live: 'marin', realtime: 'marin', defaults: { live: 'marin', realtime: 'marin' } });
    expect(info.voices).toHaveLength(22);
    expect(info.voices.find((v) => v.id === 'gleam')).toEqual({ id: 'gleam', live: true, realtime: false });
    expect(info.voices.find((v) => v.id === 'cedar')).toEqual({ id: 'cedar', live: true, realtime: true });
  });

  it('a pick is stored (kv) and survives a new store; null goes back to the .env voices; unknown voices are refused', async () => {
    const server = await start({ openaiApiKey: KEY });
    const put = (body: unknown) => server.request('/api/voice/voices', { method: 'PUT', json: body });

    const picked = await put({ voice: 'gleam' });
    expect(picked.status).toBe(200);
    expect(await picked.json()).toMatchObject({ selected: 'gleam', live: 'gleam', realtime: 'marin' });
    expect(new VoiceChoiceStore(server.ctx.db).get()).toBe('gleam');

    for (const body of [{ voice: 'nova' }, { voice: 'Marin' }, { voice: 42 }, {}, { voice: 'cedar', extra: 1 }]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(new VoiceChoiceStore(server.ctx.db).get()).toBe('gleam');

    expect(await (await put({ voice: null })).json()).toMatchObject({ selected: null, live: 'marin' });
  });

  it('an automated run never changes the owner\'s choice', async () => {
    const server = await start({ openaiApiKey: KEY });
    const res = await server.request('/api/voice/voices', { method: 'PUT', json: { voice: 'ash' }, headers: { 'x-gambit-automation': '1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ selected: null });
    expect(new VoiceChoiceStore(server.ctx.db).get()).toBeNull();
  });

  it('new sessions speak with the pick: Live always, Realtime when it has that voice', async () => {
    const live = recordingFetch([liveCreated(), liveCreated(), secret(), secret()]);
    const server = await start({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl: live.fetchImpl });
    await server.request('/api/voice/voices', { method: 'PUT', json: { voice: 'gleam' } });

    const opened = await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER } });
    expect(await opened.json()).toMatchObject({ voice: 'gleam' });
    expect(voiceOf(live.bodies[0])).toBe('gleam');

    await server.request('/api/voice/voices', { method: 'PUT', json: { voice: 'cedar' } });
    await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER } });
    expect(voiceOf(live.bodies[1])).toBe('cedar');
    // the app's client sends {} to the realtime route
    const minted = await server.request('/api/voice/session', { method: 'POST', json: {} });
    expect(await minted.json()).toMatchObject({ voice: 'cedar' });
    expect(voiceOf(live.bodies[2])).toBe('cedar');

    await server.request('/api/voice/voices', { method: 'PUT', json: { voice: 'gleam' } });
    await server.request('/api/voice/session', { method: 'POST', json: {} });
    expect(voiceOf(live.bodies[3])).toBe('marin');
  });

  it('«Послушать»: one session may name its own voice (validated before anything is spent)', async () => {
    const live = recordingFetch([liveCreated(), secret()]);
    const server = await start({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl: live.fetchImpl });
    const preview = await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER, voice: 'shimmer' } });
    expect(await preview.json()).toMatchObject({ voice: 'shimmer' });
    expect(voiceOf(live.bodies[0])).toBe('shimmer');
    // the stored choice is untouched
    expect(new VoiceChoiceStore(server.ctx.db).get()).toBeNull();

    expect((await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER, voice: 'nova' } })).status).toBe(400);
    expect((await server.request('/api/voice/session', { method: 'POST', json: { voice: 'gleam' } })).status).toBe(400);
    const minted = await server.request('/api/voice/session', { method: 'POST', json: { voice: 'ash' } });
    expect(await minted.json()).toMatchObject({ voice: 'ash' });
    expect(live.bodies).toHaveLength(2);
  });
});

describe('a failed Live session says WHY — server log, browser and the voice black box', () => {
  it('502 { error, status, reason }, the log line has the cause code, voice-diag.log a server line; never the error text', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.openai.com'), { code: 'ENOTFOUND' });
    const { fetchImpl } = recordingFetch([new TypeError('fetch failed', { cause }), new TypeError('fetch failed', { cause })]);
    const logs: string[] = [];
    const server = await start({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl, log: (m) => logs.push(m) });
    const res = await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'voice-upstream', status: null, reason: 'net:ENOTFOUND' });
    expect(logs.join('\n')).toContain('[voice] live: OpenAI Live is unreachable (net:ENOTFOUND) [2 attempts]');
    await server.ctx.idle();
    // the black box write is fire-and-forget: give it a moment
    await new Promise((resolve) => setTimeout(resolve, 50));
    const path = join(server.dataDir, VOICE_DIAG_FILE);
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('getaddrinfo');
    const line = text
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((entry) => entry.e === 'srv.live.fail');
    expect(line).toMatchObject({ page: 'server', reason: 'net:ENOTFOUND', status: null, attempts: 2 });
  });

  it('a retry that worked is logged too (so a flaky network shows up before it hurts)', async () => {
    const cause = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
    const { fetchImpl } = recordingFetch([new TypeError('fetch failed', { cause }), liveCreated()]);
    const logs: string[] = [];
    const server = await start({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl, log: (m) => logs.push(m) });
    const res = await server.request('/api/voice/live', { method: 'POST', json: { sdp: OFFER } });
    expect(res.status).toBe(200);
    expect(logs.join('\n')).toContain('[voice] live: opened on the second attempt (first: net:UND_ERR_SOCKET)');
  });

  it('the realtime route says why too', async () => {
    const { fetchImpl } = recordingFetch([new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })]);
    const server = await start({ runtimeAi: true, openaiApiKey: KEY }, { fetchImpl });
    const res = await server.request('/api/voice/session', { method: 'POST', json: {} });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'voice-upstream', status: null, reason: 'net:ECONNRESET' });
  });
});
