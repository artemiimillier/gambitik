/**
 * Being heard and hearing the child — two controller-level rules:
 *  - `coach.interrupt()`: the child's tap while Гамбитик speaks cuts him off (on loudspeakers he cannot be talked over);
 *  - a paid layer that gave up for a passing reason (e.g. «OpenAI Live is unreachable», then minutes on the fallback
 *    gpt-realtime) is tried again at the next conversation start, with a growing pause, and the parent is told which
 *    model speaks and why (`voiceFallback`).
 * Fake layers only — no network, no sound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthInfo } from '@gambit/shared';
import { createCoachController } from './coachController.ts';
import type { CoachController, CoachTimings } from './coachController.ts';
import { createCoachStore } from './coachStore.ts';
import type { CoachStore } from './coachStore.ts';
import { SETTINGS_STORAGE_KEY } from './settings.ts';
import { createSilentVoice } from './silentVoice.ts';
import { createFakeVoice, createMemoryStorage, makeEvent, makeHealth } from './testUtils.ts';
import type { FakeVoice, FakeVoiceOptions } from './testUtils.ts';
import { configureVoiceDiagForTests, resetVoiceDiagForTests, voiceDiagRecent } from './voiceDiag.ts';
import type { VoiceKind } from './voiceTypes.ts';

interface Harness {
  coach: CoachController;
  store: CoachStore;
  voice(): FakeVoice;
  created: VoiceKind[];
  storage: ReturnType<typeof createMemoryStorage>;
}

function setup(options: { health?: HealthInfo; voices?: Partial<Record<VoiceKind, FakeVoiceOptions>>; timings?: Partial<CoachTimings>; settings?: Record<string, unknown> } = {}): Harness {
  const store = createCoachStore();
  const storage = createMemoryStorage(options.settings ? { [SETTINGS_STORAGE_KEY]: JSON.stringify(options.settings) } : {});
  const created: VoiceKind[] = [];
  let last: FakeVoice | null = null;
  const health = options.health ?? makeHealth(true, { live: true });
  const coach = createCoachController({
    store,
    getStorage: () => storage,
    getHealth: () => Promise.resolve(health),
    createVoice(kind) {
      created.push(kind);
      if (created.length === 1) return createSilentVoice();
      last = createFakeVoice({ kind, ...options.voices?.[kind] });
      return last;
    },
    timings: options.timings,
  });
  return {
    coach,
    store,
    created,
    storage,
    voice() {
      if (!last) throw new Error('no voice was created yet');
      return last;
    },
  };
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);
const talkers = { 'openai-live': { conversational: true }, 'openai-realtime': { conversational: true } } satisfies Partial<Record<VoiceKind, FakeVoiceOptions>>;
const NET = { permanent: false, code: '502:voice-upstream:net:ENOTFOUND' };

describe('coach.interrupt() — the child cuts in with a tap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('while he speaks: the layer cuts him off (microphone opens), the phrase ends, the queue is dropped, he listens', async () => {
    const h = setup({ voices: talkers });
    await h.coach.init();
    await h.coach.startConversation();
    const layer = h.voice();
    const first = h.coach.say(makeEvent({ text: 'Длинная реплика про план партии.' }));
    const second = h.coach.say(makeEvent({ text: 'А это уже не прозвучит.' }));
    await flush();
    expect(h.store.getState().speaking).toBe(true);

    h.coach.interrupt();
    await first;
    await second;
    await flush();
    expect(layer.interruptCalls).toBe(1);
    expect(layer.spoken.map((p) => p.text)).not.toContain('brief:А это уже не прозвучит.');
    expect(h.store.getState().speaking).toBe(false);
    expect(h.store.getState().pose).toBe('listen');
    expect(voiceDiagRecent().find((entry) => entry.e === 'coach.interrupt')).toMatchObject({ kind: 'openai-live' });
    // the conversation goes on: nothing was closed
    expect(h.store.getState().conversationOn).toBe(true);
    expect(layer.sessionCalls.suspend).toBe(0);
  });

  it('a free voice (no interrupt of its own) simply stops', async () => {
    const h = setup({ health: makeHealth(false) });
    await h.coach.init();
    const layer = h.voice();
    const phrase = h.coach.say(makeEvent({ text: 'Привет!' }));
    await flush();
    expect(() => h.coach.interrupt()).not.toThrow();
    await phrase;
    expect(layer.stopCalls).toBeGreaterThanOrEqual(1);
    expect(h.store.getState().speaking).toBe(false);
  });
});

describe('the preferred paid voice: given up → told to the parent → tried again later', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    configureVoiceDiagForTests({ enabled: true, post: () => Promise.resolve(true), beacon: () => true, listenPage: () => () => undefined });
  });
  afterEach(() => {
    resetVoiceDiagForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Live gives up (no connection): Realtime speaks, and the store says which, why and when Live is tried again', async () => {
    const h = setup({ voices: talkers });
    await h.coach.init();
    const live = h.voice();
    const t0 = Date.now();
    live.emitUnavailable('cannot connect', NET);
    await flush();
    expect(h.voice().kind).toBe('openai-realtime');
    const fallback = h.store.getState().voiceFallback;
    expect(fallback).toMatchObject({ from: 'openai-live', to: 'openai-realtime', reason: 'cannot connect', code: NET.code });
    expect(fallback?.retryAt).toBe(t0 + 60_000);
    expect(voiceDiagRecent().find((entry) => entry.e === 'voice.degraded')).toMatchObject({ from: 'openai-live', failures: 1, retryS: 60 });
  });

  it('not before the pause: a conversation start stays on the fallback; after it, the next start brings Live back (once connected, the note is gone)', async () => {
    const h = setup({ voices: talkers });
    await h.coach.init();
    h.voice().emitUnavailable('cannot connect', NET);
    await flush();
    const realtime = h.voice();

    await h.coach.startConversation();
    expect(h.voice()).toBe(realtime);
    expect(realtime.openCalls).toBe(1);
    h.coach.endConversation();
    await flush();

    await vi.advanceTimersByTimeAsync(60_000);
    await h.coach.startConversation();
    await flush();
    const live = h.voice();
    expect(live).not.toBe(realtime);
    expect(live.kind).toBe('openai-live');
    expect(realtime.disposed).toBe(true);
    expect(live.openCalls).toBe(1);
    expect(h.store.getState()).toMatchObject({ voiceKind: 'openai-live', voiceFallback: null, voiceConnected: true });
    expect(voiceDiagRecent().some((entry) => entry.e === 'voice.restore' && entry.why === 'talk')).toBe(true);
    expect(voiceDiagRecent().some((entry) => entry.e === 'voice.restored')).toBe(true);
    expect(h.created.filter((kind) => kind === 'openai-live')).toHaveLength(2);
  });

  it('a game start is such a moment too; a Live that fails again waits twice as long (growing pause, capped)', async () => {
    const h = setup({ voices: talkers });
    await h.coach.init();
    h.voice().emitUnavailable('cannot connect', NET);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    h.coach.setToolHost({ getPositionSummary: vi.fn(), getHint: vi.fn(), explainLastMove: vi.fn(), showOnBoard: vi.fn(), takeBackMove: vi.fn() } as never);
    h.coach.onGameStart({ timeControlId: 'rapid10' });
    await flush();
    await flush();
    expect(h.voice().kind).toBe('openai-live');
    expect(voiceDiagRecent().some((entry) => entry.e === 'voice.restore' && entry.why === 'gameStart')).toBe(true);

    const t1 = Date.now();
    h.voice().emitUnavailable('the model keeps silent', { permanent: false, code: 'silent:3' });
    await flush();
    expect(h.voice().kind).toBe('openai-realtime');
    expect(h.store.getState().voiceFallback).toMatchObject({ reason: 'the model keeps silent', code: 'silent:3', retryAt: t1 + 120_000 });
  });

  it('a permanent failure (no key, key refused, no WebRTC) is not tried again', async () => {
    const h = setup({ voices: talkers });
    await h.coach.init();
    h.voice().emitUnavailable('cannot connect', { permanent: true, code: '502:voice-upstream:http:401' });
    await flush();
    const realtime = h.voice();
    expect(h.store.getState().voiceFallback).toMatchObject({ retryAt: null });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await h.coach.startConversation();
    expect(h.voice()).toBe(realtime);
    expect(h.created.filter((kind) => kind === 'openai-live')).toHaveLength(1);
  });

  it('never in the middle of a phrase: the fallback finishes, the restore waits for the next start', async () => {
    const h = setup({ voices: talkers });
    await h.coach.init();
    h.voice().emitUnavailable('cannot connect', NET);
    await flush();
    const realtime = h.voice();
    await vi.advanceTimersByTimeAsync(60_000);
    const phrase = h.coach.say(makeEvent({ text: 'Сейчас скажу важное.' }));
    await flush();
    await h.coach.startConversation();
    expect(h.voice()).toBe(realtime);
    realtime.finish();
    await phrase;
  });

  it('new settings (another voice preference) forget the old fallback', async () => {
    const h = setup({ voices: talkers });
    await h.coach.init();
    h.voice().emitUnavailable('cannot connect', NET);
    await flush();
    expect(h.store.getState().voiceFallback).not.toBeNull();
    h.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ voice: 'realtime' }));
    await h.coach.applySettings();
    await flush();
    expect(h.store.getState().voiceFallback).toBeNull();
  });
});
