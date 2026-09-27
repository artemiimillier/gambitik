import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveVoiceSessionResponse } from '@gambit/shared';
import { ApiError } from '../api/client.ts';
import type { ConversationState } from '@gambit/shared';
import { buildBriefCommentary } from './coachBrief.ts';
import { buildContextNote } from './liveProtocol.ts';
import { createOpenAiLiveVoice } from './liveVoice.ts';
import type { LiveVoiceOptions, OpenAiLiveVoice } from './liveVoice.ts';
import { installFakeRtc } from './testRtc.ts';
import type { FakeRtcEnvironment } from './testRtc.ts';
import { createFakeVoice } from './testUtils.ts';
import type { FakeVoice } from './testUtils.ts';

const answer = (): LiveVoiceSessionResponse => ({ provider: 'openai-live', sdp: 'v=0 fake-answer', model: 'gpt-live-1', voice: 'marin', sessionId: 'live_123', expiresAt: null });

interface Harness {
  voice: OpenAiLiveVoice;
  rtc: FakeRtcEnvironment;
  fallback: FakeVoice;
  createSession: ReturnType<typeof vi.fn<(sdp: string) => Promise<LiveVoiceSessionResponse>>>;
  usage: { provider: string; seconds: number; beacon?: boolean }[];
  /** completes the handshake of the connection that is being opened right now */
  startSession(): Promise<void>;
}

function setup(options: Partial<LiveVoiceOptions> = {}): Harness {
  const rtc = installFakeRtc();
  const fallback = createFakeVoice({ kind: 'browser-tts' });
  const createSession = vi.fn((_sdp: string) => Promise.resolve(answer()));
  const usage: { provider: string; seconds: number; beacon?: boolean }[] = [];
  const voice = createOpenAiLiveVoice({
    createSession,
    createFallback: () => fallback,
    reportUsage: (provider, seconds, opts) => usage.push({ provider, seconds, ...(opts?.beacon ? { beacon: true } : {}) }),
    ...options,
  });
  return {
    voice,
    rtc,
    fallback,
    createSession,
    usage,
    async startSession() {
      await vi.advanceTimersByTimeAsync(0);
      rtc.dc().receive({ type: 'session.started', session: { id: 'live_123' } });
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

/** the model "says" something: with the deaf analyser of the fake environment the transcript is the signal */
async function coachTalks(h: Harness, text: string, ms: number): Promise<void> {
  h.rtc.dc().receive({ type: 'session.output_transcript.delta', delta: text, start_ms: 0, end_ms: ms });
  await vi.advanceTimersByTimeAsync(ms);
}

describe('createOpenAiLiveVoice', () => {
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

  it("is kind 'openai-live' and init() opens NOTHING paid: no session, no peer connection, no microphone", async () => {
    const h = setup();
    await h.voice.init();
    expect(h.voice.kind).toBe('openai-live');
    expect(h.voice.connected).toBe(false);
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.rtc.connections).toHaveLength(0);
    expect(h.rtc.getUserMedia).not.toHaveBeenCalled();
    expect(h.voice.micAvailable).toBe(true);
  });

  it('first speak(): offer → our server → answer → waits for session.started → commentary; open microphone with echo cancellation', async () => {
    const h = setup();
    await h.voice.init();
    const connected: boolean[] = [];
    h.voice.onConnectedChange((value) => connected.push(value));

    let done = false;
    void h.voice.speak('Привет! Сыграем?').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.createSession).toHaveBeenCalledWith('v=0 fake-offer');
    expect(h.rtc.pc().channel?.label).toBe('oai-events');
    expect(h.rtc.pc().remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 fake-answer' });
    // nothing is said — and `session.start` is never sent — before the server confirms the session
    expect(h.rtc.dc().sent).toEqual([]);

    await h.startSession();
    expect(connected).toEqual([true]);
    expect(h.rtc.dc().types()).toEqual(['session.instructions.append', 'session.commentary.append']);
    expect(h.rtc.dc().sent.at(-1)).toMatchObject({ delegation_id: null, content: 'Привет! Сыграем?' });

    expect(h.rtc.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    expect(h.rtc.pc().sentTrack).toBe(h.rtc.micTracks[0]);
    expect(h.rtc.micTracks[0]?.enabled).toBe(true);

    await coachTalks(h, 'Привет! Сыграем?', 1500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(800);
    expect(done).toBe(true);
    expect(h.fallback.spoken).toEqual([]);
  });

  it('a phrase stopped while it waited for the connection is never said after the connect', async () => {
    const h = setup();
    await h.voice.init();
    // the wizard's prompts go out while the session is still connecting; the child moves on, the phrase is stopped
    void h.voice.speakBrief('Момент: мастер новой партии, шаг три.', { fallbackText: 'Хочешь, я буду твоим учителем?' });
    await vi.advanceTimersByTimeAsync(0);
    h.voice.stop();
    // the game's own phrase comes next and must be the first (and only) thing the model gets
    void h.voice.speakBrief('Момент: начинается новая партия.', { fallbackText: 'Начинаем!' });
    await h.startSession();
    const commentary = h.rtc
      .dc()
      .sent.filter((e) => (e as { type?: string }).type === 'session.commentary.append')
      .map((e) => String((e as { content?: string }).content));
    expect(commentary).toHaveLength(1);
    expect(commentary[0]).toMatch(/начинается новая партия/);
    expect(commentary.join(' ')).not.toMatch(/мастер новой партии/);
    expect(h.fallback.spoken).toEqual([]);
  });

  it('echo guard (loudspeakers): while the coach is audible the input is muted — documented event AND a disabled track', async () => {
    const h = setup();
    await h.voice.init();
    void h.voice.speak('Длинная фраза тренера.');
    await h.startSession();
    const track = h.rtc.micTracks[0];
    expect(track?.enabled).toBe(true);
    h.rtc.dc().sent.length = 0;

    h.rtc.dc().receive({ type: 'session.output_transcript.delta', delta: 'Длинная фраза' });
    await vi.advanceTimersByTimeAsync(100);
    expect(track?.enabled).toBe(false);
    expect(h.rtc.dc().types()).toContain('session.input_audio.mute');

    // he stops talking → after the echo tail the microphone opens again
    await vi.advanceTimersByTimeAsync(3000);
    expect(track?.enabled).toBe(true);
    expect(h.rtc.dc().types().at(-1)).toBe('session.input_audio.unmute');
  });

  it('with headphones confirmed the microphone stays open while the coach talks (true full duplex, native barge-in)', async () => {
    const h = setup();
    await h.voice.init();
    h.voice.setEchoGuard(false);
    void h.voice.speak('Фраза.');
    await h.startSession();
    h.rtc.dc().sent.length = 0;
    h.rtc.dc().receive({ type: 'session.output_transcript.delta', delta: 'Фраза' });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.rtc.micTracks[0]?.enabled).toBe(true);
    expect(h.rtc.dc().types()).not.toContain('session.input_audio.mute');
  });

  it('the mic indicator mutes / unmutes the input; push mode keeps the track closed until the button is held', async () => {
    const h = setup();
    await h.voice.init();
    h.voice.setEchoGuard(false);
    void h.voice.speak('Фраза.');
    await h.startSession();
    const track = h.rtc.micTracks[0];

    h.voice.setMicMuted(true);
    expect(track?.enabled).toBe(false);
    h.voice.setMicMuted(false);
    expect(track?.enabled).toBe(true);

    await h.voice.setMicMode?.('push');
    expect(track?.enabled).toBe(false);
    await h.voice.startListening?.();
    expect(track?.enabled).toBe(true);
    h.voice.stopListening?.();
    expect(track?.enabled).toBe(false);
    await h.voice.setMicMode?.('open');
    expect(track?.enabled).toBe(true);
  });

  it('a refused microphone only costs the listening half: the coach still speaks, micAvailable turns false', async () => {
    const h = setup();
    h.rtc.denyMicrophone();
    await h.voice.init();
    const mic: boolean[] = [];
    h.voice.onMicAvailableChange((value) => mic.push(value));
    void h.voice.speak('Привет!');
    await h.startSession();
    expect(h.voice.connected).toBe(true);
    expect(mic).toEqual([false]);
    expect(h.rtc.dc().types()).toContain('session.commentary.append');
  });

  it('reports what the child said and forwards the child-is-talking signal', async () => {
    const h = setup();
    await h.voice.init();
    const said: string[] = [];
    const talking: boolean[] = [];
    h.voice.onTranscript?.((who, text) => said.push(`${who}: ${text}`));
    h.voice.onChildSpeakingChange((value) => talking.push(value));
    h.voice.resume();
    await h.startSession();
    h.rtc.dc().receive({ type: 'session.input_transcript.delta', delta: 'а почему конь?' });
    expect(talking).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1300);
    expect(said).toEqual(['child: а почему конь?']);
    expect(talking).toEqual([true, false]);
  });

  it('pushContext goes out as silent thinking; while the session sleeps the latest notes wait and never wake it', async () => {
    const h = setup();
    await h.voice.init();
    h.voice.pushContext?.('Ход 1: пешка е четыре.');
    expect(h.rtc.connections).toHaveLength(0);
    h.voice.resume();
    await h.startSession();
    expect(h.rtc.dc().sent.filter((e) => e.type === 'session.thinking.append').map((e) => e.content)).toEqual([buildContextNote('Ход 1: пешка е четыре.')]);
    h.voice.pushContext?.('Ход 2: конь эф три.');
    expect(h.rtc.dc().sent.at(-1)).toMatchObject({ type: 'session.thinking.append', content: buildContextNote('Ход 2: конь эф три.') });
  });

  describe('speakBrief: the model speaks the situation in its own words', () => {
    const BRIEF = 'Соперник поставил ферзя под удар коня. Цель: коротко подсказать посмотреть на взятия. Ход не называть.';

    it('connected: the brief goes to the model framed «own words»; the template never reaches the fallback voice', async () => {
      const h = setup();
      await h.voice.init();
      const progress: string[] = [];
      h.voice.onSayProgress((p) => progress.push(p.type === 'caption' ? `caption:${p.text}` : p.type));
      let done = false;
      void h.voice.speakBrief(BRIEF, { fallbackText: 'Посмотри внимательно на взятия!' }).then(() => (done = true));
      await h.startSession();
      expect(h.rtc.dc().sent.at(-1)).toMatchObject({ type: 'session.commentary.append', delegation_id: null, content: buildBriefCommentary(BRIEF) });
      await coachTalks(h, 'Ого, смотри — ферзь соперника под ударом!', 2000);
      await vi.advanceTimersByTimeAsync(2500);
      expect(done).toBe(true);
      expect(progress).toEqual(['sent', 'caption:Ого, смотри — ферзь соперника под ударом!']);
      expect(h.fallback.spoken).toEqual([]);
    });

    it('teacher mode: the sentence budget reaches the model\'s frame through the session layer', async () => {
      const h = setup();
      await h.voice.init();
      void h.voice.speakBrief(BRIEF, { fallbackText: 'Посмотри на взятия!', maxSentences: 1 });
      await h.startSession();
      expect(h.rtc.dc().sent.at(-1)).toMatchObject({ type: 'session.commentary.append', content: buildBriefCommentary(BRIEF, { maxSentences: 1 }) });
      expect(String(h.rtc.dc().sent.at(-1)?.content)).toMatch(/своими словами одно короткое предложение, не больше; всего не больше пятнадцати слов; не пересказывай очевидное/);
    });

    it('no session (no key): the fallback voice says the TEMPLATE text and the bubble is told so', async () => {
      const noKey = (): Promise<LiveVoiceSessionResponse> => Promise.reject(new ApiError({ status: 503, code: 'no-api-key', method: 'POST', path: '/voice/live' }));
      const h = setup({ createSession: noKey });
      await h.voice.init();
      const progress: string[] = [];
      h.voice.onSayProgress((p) => progress.push(p.type));
      const spoken = h.voice.speakBrief(BRIEF, { fallbackText: 'Посмотри внимательно на взятия!' });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fallback.spoken).toEqual([{ text: 'Посмотри внимательно на взятия!', interrupt: false }]);
      expect(progress).toEqual(['fallback']);
      h.fallback.finish();
      await spoken;
    });

    it('the model stays silent in a live session → the template goes to the BUBBLE, never to the robot voice', async () => {
      const h = setup();
      await h.voice.init();
      const progress: string[] = [];
      h.voice.onSayProgress((p) => progress.push(p.type));
      h.voice.resume();
      await h.startSession();
      const first = h.voice.speakBrief(BRIEF, { fallbackText: 'Посмотри на взятия!' });
      await vi.advanceTimersByTimeAsync(6200);
      await first;
      expect(h.fallback.spoken).toEqual([]);
      expect(progress).toEqual(['sent', 'fallback']);
    });

    it('three silent briefs in a row give the layer up — unless the model spoke in between (it is alive, just skipped a moment)', async () => {
      const h = setup();
      await h.voice.init();
      const unavailable: string[] = [];
      h.voice.onUnavailable((reason) => unavailable.push(reason));
      h.voice.resume();
      await h.startSession();
      for (let i = 0; i < 2; i++) {
        const silent = h.voice.speakBrief(BRIEF, { fallbackText: 'Посмотри на взятия!' });
        await vi.advanceTimersByTimeAsync(6200);
        await silent;
      }
      // the model answers the child: alive
      await coachTalks(h, 'Конечно, давай посмотрим!', 1500);
      await vi.advanceTimersByTimeAsync(2000);
      const third = h.voice.speakBrief(BRIEF, { fallbackText: 'Посмотри на взятия!' });
      await vi.advanceTimersByTimeAsync(6200);
      await third;
      expect(unavailable).toEqual([]);
      expect(h.voice.kind).toBe('openai-live');
    });
  });

  describe('conversation state (the «Поговорить» button)', () => {
    it('openConversation: connecting → listening; the child talks, the app thinks, the coach talks; suspend → off', async () => {
      const h = setup();
      await h.voice.init();
      const states: ConversationState[] = [];
      h.voice.onConversationState((state) => states.push(state));
      h.voice.setToolHost({
        getPositionSummary: () => Promise.resolve('Материал равный.'),
        getHint: () => Promise.reject(new Error('no')),
        explainLastMove: () => Promise.resolve(null),
        showOnBoard: () => undefined,
        takeBackMove: () => false,
      });
      const opened = h.voice.openConversation();
      await vi.advanceTimersByTimeAsync(0);
      expect(states).toEqual(['connecting']);
      h.rtc.dc().receive({ type: 'session.started' });
      expect(await opened).toBe(true);
      expect(states).toEqual(['connecting', 'listening']);

      h.rtc.dc().receive({ type: 'session.input_transcript.delta', delta: 'кто выигрывает?' });
      expect(states.at(-1)).toBe('childSpeaking');
      h.rtc.dc().receive({ type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' } });
      await vi.advanceTimersByTimeAsync(1300);
      expect(states.at(-1)).toBe('thinking');
      await coachTalks(h, 'Пока всё поровну!', 200);
      expect(states.at(-1)).toBe('coachSpeaking');
      await vi.advanceTimersByTimeAsync(3000);
      expect(states.at(-1)).toBe('listening');

      h.voice.suspend();
      expect(states.at(-1)).toBe('off');
    });

    it('a failed connect shows error; a refused microphone is NOT an error (he still speaks) and is asked for again by the next openConversation', async () => {
      let fail = true;
      const flaky = (): Promise<LiveVoiceSessionResponse> => (fail ? Promise.reject(new ApiError({ status: 502, code: 'voice-upstream', method: 'POST', path: '/voice/live' })) : Promise.resolve(answer()));
      const h = setup({ createSession: flaky });
      await h.voice.init();
      const states: ConversationState[] = [];
      h.voice.onConversationState((state) => states.push(state));
      expect(await h.voice.openConversation()).toBe(false);
      expect(states).toEqual(['connecting', 'error']);

      fail = false;
      h.rtc.denyMicrophone();
      const before = h.rtc.connections.length;
      const opened = h.voice.openConversation();
      await h.startSession();
      expect(await opened).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      // connected, the open microphone was refused: the conversation goes on (not 'error' for the whole game while the
      // voice works); micAvailable = false tells the dock «Микрофон закрыт — нажми…»
      expect(states.at(-1)).toBe('listening');
      expect(h.voice.micAvailable).toBe(false);
      expect(h.rtc.connections).toHaveLength(before + 1);

      // tapping again: the permission prompt again on the SAME session — never a new billed session for a prompt
      // (closing the working session and opening a fresh one would bill 15 s up front each time)
      const retry = h.voice.openConversation();
      await vi.advanceTimersByTimeAsync(0);
      expect(await retry).toBe(true);
      expect(h.rtc.connections).toHaveLength(before + 1);
      expect(h.rtc.getUserMedia).toHaveBeenCalledTimes(2);
      expect(states.at(-1)).toBe('listening'); // still refused, still talking
      expect(h.voice.micAvailable).toBe(false);
      // after the first failed connect nothing was an error any more
      expect(states.slice(2)).not.toContain('error');
    });
  });

  describe('session lifecycle and cost control', () => {
    it('suspend() says goodbye, stops the microphone at once, reports the seconds; the next phrase reconnects', async () => {
      const h = setup();
      await h.voice.init();
      h.voice.resume();
      await h.startSession();
      await vi.advanceTimersByTimeAsync(42_000);
      h.rtc.dc().receive({ type: 'session.usage.updated', usage: { seconds: 57 } });
      const firstPc = h.rtc.pc();
      const track = h.rtc.micTracks[0];

      h.voice.suspend();
      expect(h.voice.connected).toBe(false);
      expect(track?.readyState).toBe('ended');
      expect(h.rtc.dc().types().at(-1)).toBe('session.close');
      expect(h.usage).toEqual([{ provider: 'openai-live', seconds: 57 }]);
      expect(firstPc.closed).toBe(false); // the goodbye gets a moment to leave
      await vi.advanceTimersByTimeAsync(400);
      expect(firstPc.closed).toBe(true);
      expect(h.rtc.audioElements[0]?.removed).toBe(true);

      void h.voice.speak('Я снова тут!');
      await h.startSession();
      expect(h.rtc.connections).toHaveLength(2);
      expect(h.createSession).toHaveBeenCalledTimes(2);
      expect(h.rtc.dc().sent.at(-1)).toMatchObject({ type: 'session.commentary.append', content: 'Я снова тут!' });
    });

    it('suspend({ pageHide }) — the page is closing: session and microphone closed at once, the seconds go out as a beacon', async () => {
      const h = setup();
      await h.voice.init();
      h.voice.resume();
      await h.startSession();
      await vi.advanceTimersByTimeAsync(20_000);
      const track = h.rtc.micTracks[0];
      h.voice.suspend({ pageHide: true });
      expect(h.voice.connected).toBe(false);
      expect(track?.readyState).toBe('ended');
      expect(h.usage).toHaveLength(1);
      expect(h.usage[0]).toMatchObject({ provider: 'openai-live', beacon: true });
      expect(h.usage[0]?.seconds).toBeGreaterThanOrEqual(20);
      // nothing open: nothing to report
      h.voice.suspend({ pageHide: true });
      expect(h.usage).toHaveLength(1);
    });

    it('a late server event after WE closed the session (the goodbye moment) never reaches the controller as the child\'s activity', async () => {
      const h = setup();
      await h.voice.init();
      const said: string[] = [];
      const talking: boolean[] = [];
      const captions: string[] = [];
      h.voice.onTranscript?.((who, text) => said.push(`${who}: ${text}`));
      h.voice.onChildSpeakingChange((value) => talking.push(value));
      h.voice.onCoachCaption((text) => captions.push(text));
      h.voice.resume();
      await h.startSession();
      // the child's last words are still being transcribed when the session is closed: they reach the journal
      h.rtc.dc().receive({ type: 'session.input_transcript.delta', delta: 'пока' });
      h.voice.suspend();
      expect(said).toEqual(['child: пока']);
      expect(talking).toEqual([true, false]);
      // …but what the server sends while the goodbye leaves (room noise, a late transcript) is dropped
      h.rtc.dc().receive({ type: 'session.input_transcript.delta', delta: 'шум телевизора' });
      h.rtc.dc().receive({ type: 'session.output_transcript.delta', delta: 'Ой', start_ms: 0, end_ms: 300 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(said).toEqual(['child: пока']);
      expect(talking).toEqual([true, false]);
      expect(captions).toEqual([]);
      expect(h.voice.connected).toBe(false);
      expect(h.rtc.connections).toHaveLength(1);
    });

    it('without a server report the session clock is the estimate', async () => {
      const h = setup();
      await h.voice.init();
      h.voice.resume();
      await h.startSession();
      await vi.advanceTimersByTimeAsync(30_500);
      h.voice.suspend();
      expect(h.usage).toHaveLength(1);
      expect(h.usage[0]?.seconds).toBeGreaterThanOrEqual(30);
      expect(h.usage[0]?.seconds).toBeLessThan(32);
    });

    it('suspend() during a connect that is still in flight does not leave a session open behind the back', async () => {
      const h = setup();
      await h.voice.init();
      h.voice.resume();
      await vi.advanceTimersByTimeAsync(0);
      h.voice.suspend();
      h.rtc.dc().receive({ type: 'session.started' });
      await vi.advanceTimersByTimeAsync(500);
      expect(h.voice.connected).toBe(false);
      expect(h.rtc.pc().closed).toBe(true);
    });

    it('a session closed by the server (expired) is accounted for and reopened on the next need', async () => {
      const h = setup();
      await h.voice.init();
      h.voice.resume();
      await h.startSession();
      h.rtc.dc().receive({ type: 'session.closed', reason: 'expired', usage: { seconds: 3600 } });
      expect(h.voice.connected).toBe(false);
      expect(h.usage).toEqual([{ provider: 'openai-live', seconds: 3600 }]);
      void h.voice.speak('Продолжаем!');
      await h.startSession();
      expect(h.voice.connected).toBe(true);
    });

    it('dispose() closes the session and reports it', async () => {
      const h = setup();
      await h.voice.init();
      h.voice.resume();
      await h.startSession();
      await vi.advanceTimersByTimeAsync(5000);
      h.voice.dispose();
      expect(h.usage).toHaveLength(1);
      expect(h.fallback.disposed).toBe(true);
      await vi.advanceTimersByTimeAsync(400);
      expect(h.rtc.pc().closed).toBe(true);
    });
  });

  describe('speak() never hangs the game', () => {
    it('the session does not come up within 6 s → the warm browser voice says the phrase, and speak() resolves', async () => {
      const h = setup();
      await h.voice.init();
      let done = false;
      void h.voice.speak('Твой ход!').then(() => (done = true));
      // a real cold connect takes ≈ 4 s: the greeting must still be there for the live voice
      await vi.advanceTimersByTimeAsync(5900); // session.started never arrives
      expect(h.fallback.spoken).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.fallback.spoken).toEqual([{ text: 'Твой ход!', interrupt: false }]);
      h.fallback.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);
    });

    it('an urgent phrase never waits for a reconnect: the browser voice says it at once while the session opens in the background', async () => {
      const h = setup();
      await h.voice.init();
      void h.voice.speak('Стоп-стоп! Давай вернём ход.', { interrupt: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fallback.spoken).toEqual([{ text: 'Стоп-стоп! Давай вернём ход.', interrupt: true }]);
      await h.startSession();
      expect(h.voice.connected).toBe(true);
    });

    it('a stalled server request is cut off: the connect fails, nothing is left open', async () => {
      const h = setup({ createSession: () => new Promise<LiveVoiceSessionResponse>(() => undefined) });
      await h.voice.init();
      void h.voice.speak('Привет!');
      await vi.advanceTimersByTimeAsync(10_500);
      expect(h.voice.connected).toBe(false);
      expect(h.rtc.pc().closed).toBe(true);
      expect(h.fallback.spoken).toHaveLength(1);
    });

    it('the model stays silent three phrases in a row → the fallback says each of them and the layer declares itself unavailable', async () => {
      const h = setup();
      await h.voice.init();
      const reasons: string[] = [];
      h.voice.onUnavailable((reason) => reasons.push(reason));
      h.voice.resume();
      await h.startSession();

      for (let i = 1; i <= 3; i++) {
        const spoken = h.voice.speak(`фраза ${i}`);
        await vi.advanceTimersByTimeAsync(5200); // never starts talking
        expect(h.fallback.spoken).toHaveLength(i);
        h.fallback.finish();
        await spoken;
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(reasons).toEqual(['the model keeps silent']);
      expect(h.voice.kind).toBe('browser-tts');
      expect(h.voice.connected).toBe(false);
    });
  });

  describe('runtime fallback', () => {
    it('503 no-api-key → says the phrase with the browser voice, reports the new kind and tells the controller to move on', async () => {
      const noKey = (): Promise<LiveVoiceSessionResponse> => Promise.reject(new ApiError({ status: 503, code: 'no-api-key', method: 'POST', path: '/voice/live' }));
      const h = setup({ createSession: noKey });
      await h.voice.init();
      const kinds: string[] = [];
      const reasons: string[] = [];
      h.voice.onKindChange((kind) => kinds.push(kind));
      h.voice.onUnavailable((reason) => reasons.push(reason));

      const spoken = h.voice.speak('Привет-привет!');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.fallback.spoken).toEqual([{ text: 'Привет-привет!', interrupt: false }]);
      h.fallback.finish();
      await spoken;
      expect(kinds).toEqual(['browser-tts']);
      expect(reasons).toEqual(['no API key']);
      expect(h.voice.micAvailable).toBe(false);
      await expect(h.voice.startListening?.()).rejects.toThrow();
    });

    it('three failed connects in a row → unavailable; one success resets the count', async () => {
      let fail = true;
      const flaky = (): Promise<LiveVoiceSessionResponse> => (fail ? Promise.reject(new ApiError({ status: 502, code: 'voice-upstream', method: 'POST', path: '/voice/live' })) : Promise.resolve(answer()));
      const h = setup({ createSession: flaky });
      await h.voice.init();
      const reasons: string[] = [];
      h.voice.onUnavailable((reason) => reasons.push(reason));
      for (let i = 0; i < 2; i++) {
        h.voice.resume();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(reasons).toEqual([]);
      fail = false;
      h.voice.resume();
      await h.startSession();
      expect(h.voice.connected).toBe(true);
      h.voice.suspend();
      fail = true;
      for (let i = 0; i < 3; i++) {
        h.voice.resume();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(reasons).toEqual(['cannot connect']);
    });

    it('a browser without WebRTC is unavailable for good', async () => {
      const h = setup();
      vi.stubGlobal('RTCPeerConnection', undefined);
      await h.voice.init();
      const reasons: string[] = [];
      const details: unknown[] = [];
      h.voice.onUnavailable((reason, detail) => {
        reasons.push(reason);
        details.push(detail);
      });
      h.voice.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(reasons).toEqual(['cannot connect']);
      // for good: the controller will not try this layer again
      expect(details).toEqual([{ permanent: true, code: 'WebRTC is not available in this browser' }]);
      expect(h.createSession).not.toHaveBeenCalled();
    });

    it('giving up says WHY — the server\'s reason travels with it (e.g. «OpenAI Live is unreachable»), and it is not permanent', async () => {
      const unreachable = (): Promise<LiveVoiceSessionResponse> =>
        Promise.reject(new ApiError({ status: 502, code: 'voice-upstream', method: 'POST', path: '/voice/live', body: { reason: 'net:UND_ERR_SOCKET' } }));
      const h = setup({ createSession: unreachable });
      await h.voice.init();
      const details: unknown[] = [];
      h.voice.onUnavailable((_reason, detail) => details.push(detail));
      for (let i = 0; i < 3; i++) {
        h.voice.resume();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(details).toEqual([{ permanent: false, code: '502:voice-upstream:net:UND_ERR_SOCKET' }]);
    });

    it('no browser voice either → the silent layer keeps the timing, init() still succeeds', async () => {
      const broken = createFakeVoice({ failInit: true });
      const h = setup({ createFallback: () => broken });
      await expect(h.voice.init()).resolves.toBeUndefined();
      expect(broken.disposed).toBe(true);
    });
  });

  it('interrupt() (the child\'s tap on loudspeakers): the phrase ends, the playback is hushed, ONE stop goes out and the microphone opens', async () => {
    const h = setup();
    await h.voice.init();
    h.voice.setEchoGuard(true);
    const spoken = h.voice.speak('Сейчас расскажу длинную историю про коня.');
    await h.startSession();
    h.rtc.dc().receive({ type: 'session.output_transcript.delta', delta: 'Сейчас расскажу', start_ms: 0, end_ms: 3000 });
    await vi.advanceTimersByTimeAsync(0);
    // the echo guard closed the microphone while he speaks
    expect(h.rtc.micTracks[0]?.enabled).toBe(false);
    h.rtc.dc().sent.length = 0;

    h.voice.interrupt();
    // the controller's own stop arrives in the same click
    h.voice.stop();
    await spoken;
    expect(h.rtc.audioElements[0]?.muted).toBe(true);
    expect(h.rtc.dc().types().filter((type) => type === 'session.instructions.append')).toHaveLength(1);
    expect(h.rtc.dc().types()).toContain('session.input_audio.unmute');
    expect(h.rtc.micTracks[0]?.enabled).toBe(true);
    expect(h.fallback.spoken).toEqual([]);
  });

  it('stop() ducks the local playback and sends the interrupting instruction; the phrase is not repeated by the fallback', async () => {
    const h = setup();
    await h.voice.init();
    const spoken = h.voice.speak('Длинное объяснение.');
    await h.startSession();
    h.rtc.dc().receive({ type: 'session.output_transcript.delta', delta: 'Длинное' });
    h.rtc.dc().sent.length = 0;
    h.voice.stop();
    await spoken;
    expect(h.rtc.audioElements[0]?.muted).toBe(true);
    expect(h.rtc.dc().types()).toContain('session.instructions.append');
    expect(h.fallback.spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(1600);
    expect(h.rtc.audioElements[0]?.muted).toBe(false);
  });
});
