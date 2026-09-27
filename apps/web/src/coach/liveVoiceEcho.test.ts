/**
 * The Live adapter's own echo-guard signal (the output transcript's timeline) and its black-box lines — for
 * laptop speakers: the mic must stay closed while the coach's words still sound, even
 * when the analyser cannot hear them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveVoiceSessionResponse } from '@gambit/shared';
import { LIVE_TRANSCRIPT_MAX_AHEAD_MS, LIVE_TRANSCRIPT_TAIL_MS, createLiveEchoHold, createOpenAiLiveVoice } from './liveVoice.ts';
import { RTC_TIMEOUTS } from './rtcSession.ts';
import { installFakeRtc } from './testRtc.ts';
import { createFakeVoice } from './testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';

describe('createLiveEchoHold — the transcript timeline keeps the echo guard closed', () => {
  it('a word without a timeline holds for the tail; a timeline holds until its end (capped)', () => {
    let t = 1000;
    const hold = createLiveEchoHold(() => t);
    expect(hold.holding).toBe(false);
    hold.noteOutputDelta({ delta: 'Смотри' });
    expect(hold.evidence).toBe(1);
    t += LIVE_TRANSCRIPT_TAIL_MS - 10;
    expect(hold.holding).toBe(true);
    t += 20;
    expect(hold.holding).toBe(false);

    // a new utterance: its first word at 0 ms of the timeline, this delta already reaches 3.2 s of speech
    t += 5000;
    const start = t;
    hold.noteOutputDelta({ delta: 'Осторожно', start_ms: 40_000, end_ms: 40_600 });
    hold.noteOutputDelta({ delta: ' слон', start_ms: 40_600, end_ms: 43_200 });
    t = start + 3100;
    expect(hold.holding).toBe(true);
    t = start + 3300;
    expect(hold.holding).toBe(false);

    // a broken timeline can never hold longer than the cap after the last word
    t += 5000;
    const late = t;
    hold.noteOutputDelta({ delta: 'x', start_ms: 0, end_ms: 60_000 });
    t = late + LIVE_TRANSCRIPT_MAX_AHEAD_MS + 1;
    expect(hold.holding).toBe(false);
  });

  it('reset() drops the hold (the session is gone)', () => {
    const hold = createLiveEchoHold(() => 0);
    hold.noteOutputDelta({ delta: 'a' });
    hold.reset();
    expect(hold.holding).toBe(false);
  });
});

describe('Live layer — echo guard and black box on the wire', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function connected() {
    const rtc = installFakeRtc();
    const answer: LiveVoiceSessionResponse = { provider: 'openai-live', sdp: 'v=0 fake-answer', model: 'gpt-live-1', voice: 'marin', sessionId: 'live_1', expiresAt: null };
    const voice = createOpenAiLiveVoice({ createSession: () => Promise.resolve(answer), createFallback: () => createFakeVoice({ kind: 'browser-tts' }), reportUsage: () => undefined });
    await voice.init();
    const opened = voice.openConversation();
    await vi.advanceTimersByTimeAsync(0);
    rtc.dc().receive({ type: 'session.started', session: { id: 'live_1' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(await opened).toBe(true);
    return { rtc, voice };
  }

  it('a long sentence whose words all came at once keeps the microphone closed until its timeline ends (deaf analyser)', async () => {
    const { rtc } = await connected();
    const mic = rtc.micTracks[0];
    expect(mic?.enabled).toBe(true);
    rtc.dc().receive({ type: 'session.output_transcript.delta', delta: 'Осторожно, соперник может пойти слоном и поставить мат.', start_ms: 0, end_ms: 3500 });
    expect(mic?.enabled).toBe(false);
    // the protocol's own «active» signal (1.5 s after the last word) is long over — the sound is not
    await vi.advanceTimersByTimeAsync(3000);
    expect(mic?.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(500 + RTC_TIMEOUTS.echoTailMs + 100);
    expect(mic?.enabled).toBe(true);
  });

  it('the black box: mute sent + acknowledged, the child heard (no words), server event types, no transcript text', async () => {
    const { rtc } = await connected();
    rtc.dc().receive({ type: 'session.output_transcript.delta', delta: 'Привет!' });
    rtc.dc().receive({ type: 'session.input_audio.muted' });
    rtc.dc().receive({ type: 'session.input_transcript.delta', delta: 'А что хочет соперник' });
    rtc.dc().receive({ type: 'session.input_transcript.delta', delta: '?' });
    rtc.dc().receive({ type: 'response.event', event: { anything: 'Слова' } });
    rtc.dc().receive({ type: 'error', error: { code: 'context_injection_incomplete', message: 'Ошибка текста' } });
    const entries = voiceDiagRecent();
    expect(entries.find((entry) => entry.e === 'mic.mute.sent')).toMatchObject({ muted: true });
    expect(entries.find((entry) => entry.e === 'mic.mute.ack')).toMatchObject({ muted: true });
    expect(entries.filter((entry) => entry.e === 'child.heard')).toHaveLength(1);
    expect(entries.find((entry) => entry.e === 'srv' && entry.type === 'response.event')).toBeDefined();
    expect(entries.find((entry) => entry.e === 'srv.error')).toMatchObject({ code: 'context_injection_incomplete' });
    expect(entries.find((entry) => entry.e === 'sess.up')).toBeDefined();
    expect(JSON.stringify(entries)).not.toMatch(/[А-Яа-яЁё]/);
  });
});
