import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceSessionResponse } from '@gambit/shared';
import { ApiError } from '../api/client.ts';
import { BRIEF_RESPONSE_INSTRUCTIONS_RU, buildBriefItem } from './coachBrief.ts';
import { createOpenAiRealtimeVoice } from './realtimeVoice.ts';
import type { OpenAiRealtimeVoice, RealtimeVoiceOptions } from './realtimeVoice.ts';
import { installFakeRtc } from './testRtc.ts';
import type { FakeRtcEnvironment } from './testRtc.ts';
import { createFakeVoice } from './testUtils.ts';
import type { FakeVoice } from './testUtils.ts';

const noApiKey = (): Promise<VoiceSessionResponse> =>
  Promise.reject(new ApiError({ status: 503, code: 'no-api-key', method: 'POST', path: '/voice/session' }));

const session = (): Promise<VoiceSessionResponse> =>
  Promise.resolve({ provider: 'openai-realtime', clientSecret: 'ek_test', model: 'test-model', voice: 'marin', expiresAt: 0, instructionsApplied: true });

/**
 * Plain Node has no RTCPeerConnection, which is exactly the "realtime is unavailable" situation
 * the automatic fallback exists for.
 */
describe('createOpenAiRealtimeVoice — automatic fallback', () => {
  let fallback: FakeVoice;

  beforeEach(() => {
    fallback = createFakeVoice({ kind: 'browser-tts', gestureGated: true, needsGesture: true });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('init() is lazy: no secret is minted until the coach has something to say', async () => {
    const createSession = vi.fn(session);
    const voice = createOpenAiRealtimeVoice({ createSession, createFallback: () => fallback });
    await voice.init();
    expect(createSession).not.toHaveBeenCalled();
    expect(voice.kind).toBe('openai-realtime');
    expect(voice.connected).toBe(false);
  });

  it('unavailable on the first phrase → the browser voice says it, the kind changes for good, the controller is told', async () => {
    const voice = createOpenAiRealtimeVoice({ createSession: noApiKey, createFallback: () => fallback });
    const kinds: string[] = [];
    const reasons: string[] = [];
    voice.onKindChange((kind) => kinds.push(kind));
    voice.onUnavailable((reason) => reasons.push(reason));
    await voice.init();

    const spoken = voice.speak('Привет!');
    await vi.waitFor(() => expect(fallback.spoken).toEqual([{ text: 'Привет!', interrupt: false }]));
    fallback.finish();
    await spoken;

    expect(voice.kind).toBe('browser-tts');
    expect(kinds).toEqual(['browser-tts']);
    expect(reasons).toEqual(['cannot connect']);
    expect(voice.micAvailable).toBe(false);
    await expect(voice.startListening?.()).rejects.toThrow();
  });

  it('speaks through the fallback and forwards its speaking state and mouth level', async () => {
    const voice = createOpenAiRealtimeVoice({ createSession: noApiKey, createFallback: () => fallback });
    await voice.init();
    const speaking: boolean[] = [];
    const levels: number[] = [];
    voice.onSpeakingChange((v) => speaking.push(v));
    voice.onLevel((v) => levels.push(v));

    const spoken = voice.speak('Привет-привет!', { interrupt: true });
    await vi.waitFor(() => expect(fallback.spoken).toEqual([{ text: 'Привет-привет!', interrupt: true }]));
    fallback.emitLevel(0.4);
    fallback.finish();
    await spoken;
    expect(speaking).toEqual([true, false]);
    expect(levels).toEqual([0.4]);

    voice.stop();
    expect(fallback.stopCalls).toBe(1);
  });

  it('mirrors the gesture lock of the fallback layer once it has taken over', async () => {
    const voice = createOpenAiRealtimeVoice({ createSession: noApiKey, createFallback: () => fallback });
    await voice.init();
    voice.resume();
    await vi.waitFor(() => expect(voice.kind).toBe('browser-tts'));
    expect(voice.needsUserGesture).toBe(true);
    const changes: boolean[] = [];
    voice.onNeedsUserGestureChange((v) => changes.push(v));
    voice.unlock();
    expect(voice.needsUserGesture).toBe(false);
    expect(changes.at(-1)).toBe(false);
  });

  it('a browser without WebRTC also ends up on the fallback — and does not keep asking the server for secrets', async () => {
    const createSession = vi.fn(session);
    const voice = createOpenAiRealtimeVoice({ createSession, createFallback: () => fallback });
    await voice.init();
    const first = voice.speak('Раз.');
    await vi.waitFor(() => expect(fallback.spoken).toHaveLength(1));
    fallback.finish();
    await first;
    expect(voice.kind).toBe('browser-tts');
    const second = voice.speak('Ещё раз.');
    await vi.waitFor(() => expect(fallback.spoken).toHaveLength(2));
    fallback.finish();
    await second;
    expect(createSession).not.toHaveBeenCalled(); // WebRTC is checked before anything is minted
  });

  it('no browser voice either: init() still succeeds, the silent layer keeps the bubble timing', async () => {
    const broken = createFakeVoice({ failInit: true });
    const voice = createOpenAiRealtimeVoice({ createSession: noApiKey, createFallback: () => broken });
    await expect(voice.init()).resolves.toBeUndefined();
    expect(broken.disposed).toBe(true);
  });

  it('dispose() releases the fallback and makes speak() a no-op', async () => {
    const voice = createOpenAiRealtimeVoice({ createSession: noApiKey, createFallback: () => fallback });
    await voice.init();
    voice.dispose();
    expect(fallback.disposed).toBe(true);
    await voice.speak('после dispose');
    expect(fallback.spoken).toEqual([]);
  });
});

describe('createOpenAiRealtimeVoice — WebRTC session', () => {
  interface Harness {
    voice: OpenAiRealtimeVoice;
    rtc: FakeRtcEnvironment;
    fallback: FakeVoice;
    fetchImpl: ReturnType<typeof vi.fn>;
    usage: { provider: string; seconds: number }[];
  }

  function setup(options: Partial<RealtimeVoiceOptions> = {}): Harness {
    const rtc = installFakeRtc();
    const fallback = createFakeVoice({ kind: 'browser-tts' });
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('v=0 fake-answer', { status: 201 })));
    const usage: { provider: string; seconds: number }[] = [];
    const voice = createOpenAiRealtimeVoice({
      createSession: session,
      createFallback: () => fallback,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      reportUsage: (provider, seconds) => usage.push({ provider, seconds }),
      ...options,
    });
    return { voice, rtc, fallback, fetchImpl, usage };
  }

  const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('connects on the first need with the ephemeral secret and keeps server VAD for the open microphone', async () => {
    const h = setup();
    await h.voice.init();
    h.voice.resume();
    await flush();

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/realtime/calls');
    expect(init.body).toBe('v=0 fake-offer');
    expect(init.headers).toEqual({ Authorization: 'Bearer ek_test', 'Content-Type': 'application/sdp' });

    expect(h.voice.connected).toBe(true);
    const update = h.rtc.dc().sent[0] as { type: string; session: { audio: { input: { turn_detection: { type: string } | null } } } };
    expect(update.type).toBe('session.update');
    expect(update.session.audio.input.turn_detection).toMatchObject({ type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true });
  });

  it('open mode: the mic track is enabled continuously; the child barging in clears the playback and resolves speak() without a repeat', async () => {
    const h = setup();
    await h.voice.init();
    h.voice.setEchoGuard(false); // headphones
    const talking: boolean[] = [];
    h.voice.onChildSpeakingChange((value) => talking.push(value));

    let done = false;
    void h.voice.speak('Длинное объяснение про вилку.').then(() => (done = true));
    await flush();
    const track = h.rtc.micTracks[0];
    expect(track?.enabled).toBe(true);
    expect(h.rtc.pc().sentTrack).toBe(track);

    const dc = h.rtc.dc();
    dc.receive({ type: 'response.created', response: { id: 'resp_1', metadata: { source: 'gambit-say' } } });
    dc.receive({ type: 'output_audio_buffer.started' });
    await vi.advanceTimersByTimeAsync(200);
    expect(track?.enabled).toBe(true); // full duplex: he talks, the microphone stays open
    dc.sent.length = 0;

    dc.receive({ type: 'input_audio_buffer.speech_started' });
    await flush();
    expect(dc.types()).toEqual(['response.cancel', 'output_audio_buffer.clear']);
    expect(done).toBe(true);
    expect(talking).toEqual([true]);
    expect(h.fallback.spoken).toEqual([]);
  });

  it('echo guard (no headphones): the mic track is disabled while the coach is audible and reopens after the echo tail', async () => {
    const h = setup();
    await h.voice.init();
    void h.voice.speak('Фраза тренера.');
    await flush();
    const track = h.rtc.micTracks[0];
    const dc = h.rtc.dc();
    expect(track?.enabled).toBe(true);

    dc.receive({ type: 'response.created', response: { id: 'resp_1', metadata: { source: 'gambit-say' } } });
    dc.receive({ type: 'output_audio_buffer.started' });
    await vi.advanceTimersByTimeAsync(100);
    expect(track?.enabled).toBe(false);

    dc.receive({ type: 'response.done', response: { id: 'resp_1', status: 'completed', output: [] } });
    dc.receive({ type: 'output_audio_buffer.stopped' });
    await vi.advanceTimersByTimeAsync(1200);
    expect(track?.enabled).toBe(true);
  });

  it('push mode: no server VAD, no microphone until the button is held; release commits the turn', async () => {
    const h = setup();
    await h.voice.init();
    await h.voice.setMicMode?.('push');
    h.voice.resume();
    await flush();
    const dc = h.rtc.dc();
    expect((dc.sent[0] as { session: { audio: { input: { turn_detection: unknown } } } }).session.audio.input.turn_detection).toBeNull();
    expect(h.rtc.getUserMedia).not.toHaveBeenCalled();

    await h.voice.startListening?.();
    expect(h.rtc.micTracks[0]?.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    dc.sent.length = 0;
    h.voice.stopListening?.();
    expect(h.rtc.micTracks[0]?.enabled).toBe(false);
    expect(dc.types()).toEqual(['input_audio_buffer.commit', 'response.create']);
  });

  it('switching to the open microphone at runtime turns server VAD on and opens the track', async () => {
    const h = setup();
    await h.voice.init();
    await h.voice.setMicMode?.('push');
    h.voice.resume();
    await flush();
    h.rtc.dc().sent.length = 0;
    await h.voice.setMicMode?.('open');
    await flush();
    expect(h.rtc.dc().sent[0]).toMatchObject({ type: 'session.update', session: { audio: { input: { turn_detection: { type: 'semantic_vad' } } } } });
    expect(h.rtc.micTracks[0]?.enabled).toBe(true);
  });

  it('registers the fact tools at connect; a function call goes to the host and its FACTS go back, then the model answers', async () => {
    const h = setup();
    await h.voice.init();
    const evaluateMove = vi.fn(() => Promise.resolve('Ход возможен, но конь там попадёт под удар пешки.'));
    h.voice.setToolHost({
      getPositionSummary: () => Promise.resolve('Материал равный.'),
      getHint: () => Promise.reject(new Error('no')),
      explainLastMove: () => Promise.resolve(null),
      showOnBoard: () => undefined,
      takeBackMove: () => false,
      evaluateMove,
    });
    h.voice.resume();
    await flush();
    const dc = h.rtc.dc();
    const update = dc.sent[0] as { session: { tools: { name: string }[]; tool_choice: string } };
    expect(update.session.tools.map((t) => t.name)).toEqual(['analyze_position', 'evaluate_move', 'compare_move', 'get_hint', 'explain_last_move', 'show_on_board', 'take_back_move', 'wait_for_user']);
    expect(update.session.tool_choice).toBe('auto');

    dc.sent.length = 0;
    dc.receive({
      type: 'response.done',
      response: { id: 'resp_1', status: 'completed', output: [{ type: 'function_call', name: 'evaluate_move', call_id: 'c1', arguments: JSON.stringify({ move: 'конь на эф пять' }) }] },
    });
    await flush();
    expect(evaluateMove).toHaveBeenCalledWith('Nf5');
    expect(dc.types()).toEqual(['conversation.item.create', 'response.create']);
    const output = JSON.parse((dc.sent[0] as { item: { output: string } }).item.output) as Record<string, unknown>;
    expect(output).toMatchObject({ факты: 'Ход возможен, но конь там попадёт под удар пешки.' });
  });

  it('speakBrief over the session: the situation as a system item + a response asking for its own words', async () => {
    const h = setup();
    await h.voice.init();
    void h.voice.speakBrief('Ребёнок нашёл вилку. Цель: коротко похвалить.', { fallbackText: 'Вилка! Здорово!' });
    await flush();
    const dc = h.rtc.dc();
    const [item, response] = dc.sent.slice(-2) as [{ item: { content: { text: string }[] } }, { response: { instructions: string } }];
    expect(item.item.content[0]?.text).toBe(buildBriefItem('Ребёнок нашёл вилку. Цель: коротко похвалить.'));
    expect(response.response.instructions).toBe(BRIEF_RESPONSE_INSTRUCTIONS_RU);
    expect(h.fallback.spoken).toEqual([]);
  });

  it('suspend() closes the peer connection and the microphone and reports the seconds of the session', async () => {
    const h = setup();
    await h.voice.init();
    h.voice.resume();
    await flush();
    await vi.advanceTimersByTimeAsync(12_000);
    h.voice.suspend();
    expect(h.rtc.pc().closed).toBe(true);
    expect(h.rtc.micTracks[0]?.readyState).toBe('ended');
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]).toMatchObject({ provider: 'openai-realtime' });
    expect(Math.round(h.usage[0]?.seconds ?? 0)).toBe(12);
  });

  it('503 no-api-key from our server is permanent at once: one attempt, then the fallback and a message to the controller', async () => {
    const createSession = vi.fn(noApiKey);
    const h = setup({ createSession });
    await h.voice.init();
    const reasons: string[] = [];
    h.voice.onUnavailable((reason) => reasons.push(reason));
    const spoken = h.voice.speak('Привет!');
    await flush();
    expect(h.fallback.spoken).toEqual([{ text: 'Привет!', interrupt: false }]);
    h.fallback.finish();
    await spoken;
    expect(reasons).toEqual(['no API key']);
    expect(h.voice.kind).toBe('browser-tts');
    h.voice.resume();
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('401 from the calls endpoint is permanent; a stalled endpoint is cut off and the phrase is still said', async () => {
    const refused = setup({ fetchImpl: (() => Promise.resolve(new Response('no', { status: 401 }))) as unknown as typeof fetch });
    await refused.voice.init();
    const reasons: string[] = [];
    refused.voice.onUnavailable((reason) => reasons.push(reason));
    refused.voice.resume();
    await flush();
    expect(reasons).toEqual(['cannot connect']);
    vi.unstubAllGlobals();

    const stalled = setup({ fetchImpl: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch });
    await stalled.voice.init();
    let done = false;
    void stalled.voice.speak('Твой ход!').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(6100); // DEFAULT_RECONNECT_WAIT_MS
    expect(stalled.fallback.spoken).toEqual([{ text: 'Твой ход!', interrupt: false }]);
    stalled.fallback.finish();
    await flush();
    expect(done).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stalled.rtc.pc().closed).toBe(true);
  });
});
