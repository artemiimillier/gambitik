import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachEventKind, CoachToolHost, HealthInfo, Talkativeness } from '@gambit/shared';
import { SILENCE_NUDGE_BRIEF_RU } from './coachBrief.ts';
import {
  CONVERSATION_GOODBYE_RU,
  GAME_SLEEP_BUBBLE_RU,
  VOICE_LIMIT_BUBBLE_RU,
  createCoachController,
  localDayKey,
  passesTalkativeness,
  runtimeAiOf,
  selectVoiceChain,
  selectVoiceKind,
} from './coachController.ts';
import type { CoachController, CoachTimings } from './coachController.ts';
import { createCoachStore } from './coachStore.ts';
import type { CoachStore } from './coachStore.ts';
import { AI_OFF_VOICE, SETTINGS_STORAGE_KEY } from './settings.ts';
import { createSilentVoice } from './silentVoice.ts';
import { createFakePage, createFakeVoice, createMemoryStorage, makeEvent, makeHealth } from './testUtils.ts';
import type { FakePage, FakeVoice, FakeVoiceOptions } from './testUtils.ts';
import type { VoiceKind } from './voiceTypes.ts';

interface Harness {
  coach: CoachController;
  store: CoachStore;
  /** the most recently created non-silent voice */
  voice(): FakeVoice;
  /** every fake layer that was created, in order */
  voices: FakeVoice[];
  created: VoiceKind[];
  storage: ReturnType<typeof createMemoryStorage>;
}

interface HarnessOptions {
  health?: HealthInfo | Error;
  settings?: Record<string, unknown>;
  voices?: Partial<Record<VoiceKind, FakeVoiceOptions>>;
  timings?: Partial<CoachTimings>;
  /** automation run (navigator.webdriver without the opt-in) */
  silenced?: boolean;
  /** GET /api/health never answers */
  healthHangs?: boolean;
  /** GET /api/voice/usage (daily limit); absent = the controller counts only this page's sessions */
  usage?: () => Promise<{ todaySeconds: number } | null>;
  /** the page lifecycle (visibility, pagehide, touches) */
  page?: FakePage;
}

function setup(options: HarnessOptions = {}): Harness {
  const store = createCoachStore();
  const storage = createMemoryStorage(options.settings ? { [SETTINGS_STORAGE_KEY]: JSON.stringify(options.settings) } : {});
  const created: VoiceKind[] = [];
  const voices: FakeVoice[] = [];
  let last: FakeVoice | null = null;
  const health = options.health ?? makeHealth(false);
  const coach = createCoachController({
    store,
    getStorage: () => storage,
    getHealth: () => (options.healthHangs ? new Promise<HealthInfo>(() => undefined) : health instanceof Error ? Promise.reject(health) : Promise.resolve(health)),
    createVoice(kind) {
      created.push(kind);
      // the very first layer is the controller's private silent one (used while muted)
      if (created.length === 1) return createSilentVoice();
      last = createFakeVoice({ kind, ...options.voices?.[kind] });
      voices.push(last);
      return last;
    },
    timings: options.timings,
    isSilenced: () => options.silenced === true,
    ...(options.usage ? { getVoiceUsage: options.usage } : {}),
    ...(options.page ? { page: options.page.page } : {}),
  });
  return {
    coach,
    store,
    created,
    voices,
    storage,
    voice() {
      if (!last) throw new Error('no voice was created yet');
      return last;
    },
  };
}

/** lets pending promise continuations run under fake timers */
const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

/** the layer that speaks without runtime AI (docs/TEACHING.md §4.4) — the tests follow the one constant */
const AI_OFF_KIND: VoiceKind = AI_OFF_VOICE === 'clips' ? 'clips' : 'browser-tts';

describe('selectVoiceKind', () => {
  it('maps preference + health to a layer kind', () => {
    expect(selectVoiceKind('off', makeHealth(true))).toBe('silent');
    expect(selectVoiceKind('browser', makeHealth(true))).toBe('browser-tts');
    expect(selectVoiceKind('auto', makeHealth(true))).toBe('openai-realtime');
    expect(selectVoiceKind('realtime', makeHealth(true))).toBe('openai-realtime');
    expect(selectVoiceKind('auto', makeHealth(false))).toBe('browser-tts');
    expect(selectVoiceKind('realtime', makeHealth(false))).toBe('browser-tts');
    // no answer from the server = no runtime AI: the AI-off voice
    expect(selectVoiceKind('auto', null)).toBe(AI_OFF_KIND);
  });

  it('selectVoiceChain: auto follows the server preference (live by default), then the other OpenAI voice, browser, silent', () => {
    const both = makeHealth(true, { live: true });
    expect(selectVoiceChain('auto', both)).toEqual(['openai-live', 'openai-realtime', 'browser-tts', 'silent']);
    expect(selectVoiceChain('auto', makeHealth(true, { live: true, preferred: 'realtime' }))).toEqual(['openai-realtime', 'openai-live', 'browser-tts', 'silent']);
    // a server set to VOICE_PREFERRED=clips (a test instance): «auto» speaks with the free pre-recorded voice
    expect(selectVoiceChain('auto', makeHealth(true, { live: true, preferred: 'clips' }))).toEqual(['clips', 'silent']);
    expect(selectVoiceChain('live', both)).toEqual(['openai-live', 'openai-realtime', 'browser-tts', 'silent']);
    expect(selectVoiceChain('realtime', both)).toEqual(['openai-realtime', 'openai-live', 'browser-tts', 'silent']);
    // only what the server can really open is in the chain
    expect(selectVoiceChain('live', makeHealth(true, { live: false }))).toEqual(['openai-realtime', 'browser-tts', 'silent']);
    expect(selectVoiceChain('auto', makeHealth(true))).toEqual(['openai-realtime', 'browser-tts', 'silent']); // an older server without `live`
    expect(selectVoiceChain('realtime', makeHealth(false, { live: true }))).toEqual(['openai-live', 'browser-tts', 'silent']);
    expect(selectVoiceChain('auto', null)).toEqual([AI_OFF_KIND, 'silent']);
    expect(selectVoiceChain('browser', both)).toEqual(['browser-tts', 'silent']);
    expect(selectVoiceChain('off', both)).toEqual(['silent']);
    expect(selectVoiceKind('auto', both)).toBe('openai-live');
  });

  it('no runtime AI (docs/TEACHING.md §4.4): auto / live / realtime speak with AI_OFF_VOICE — never an OpenAI layer, whatever the keys', () => {
    expect(AI_OFF_VOICE).toBe('clips');
    const keysButOff = makeHealth(true, { live: true, preferred: 'live' }, { runtimeAi: false });
    const oldServer = makeHealth(true, { live: true, preferred: 'live' }, { runtimeAi: null });
    for (const health of [keysButOff, oldServer, null]) {
      for (const preference of ['auto', 'live', 'realtime'] as const) {
        expect(selectVoiceChain(preference, health), preference).toEqual(['clips', 'silent']);
      }
      // the free choices keep their meaning
      expect(selectVoiceChain('clips', health)).toEqual(['clips', 'silent']);
      expect(selectVoiceChain('browser', health)).toEqual(['browser-tts', 'silent']);
      expect(selectVoiceChain('off', health)).toEqual(['silent']);
      // automation still wins
      expect(selectVoiceChain('live', health, true)).toEqual(['silent']);
    }
    expect(runtimeAiOf(keysButOff)).toBe(false);
    expect(runtimeAiOf(oldServer)).toBe(false);
    expect(runtimeAiOf(null)).toBe(false);
    expect(runtimeAiOf(makeHealth(false))).toBe(true);
  });

  it('an automation-driven browser is always silent, whatever the settings and the server offer', () => {
    for (const preference of ['auto', 'live', 'browser', 'realtime', 'off'] as const) {
      expect(selectVoiceChain(preference, makeHealth(true, { live: true }), true)).toEqual(['silent']);
      expect(selectVoiceKind(preference, makeHealth(true), true)).toBe('silent');
      expect(selectVoiceKind(preference, makeHealth(false), true)).toBe('silent');
      expect(selectVoiceKind(preference, null, true)).toBe('silent');
    }
  });
});

describe('coach controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('init', () => {
    it('uses the browser voice when the server has no realtime voice', async () => {
      const h = setup({ health: makeHealth(false) });
      await h.coach.init();
      expect(h.store.getState()).toMatchObject({ ready: true, voiceKind: 'browser-tts', micAvailable: false, muted: false });
      expect(h.created).toEqual(['silent', 'browser-tts']);
    });

    it('uses realtime voice when /api/health offers it', async () => {
      const h = setup({ health: makeHealth(true), voices: { 'openai-realtime': { conversational: true } } });
      await h.coach.init();
      expect(h.store.getState()).toMatchObject({ voiceKind: 'openai-realtime', micAvailable: true });
    });

    it('still works when the server is down (no runtime AI then: the AI-off voice)', async () => {
      const h = setup({ health: new Error('offline') });
      await h.coach.init();
      expect(h.store.getState()).toMatchObject({ voiceKind: AI_OFF_KIND, runtimeAi: false });
      expect(h.coach.runtimeAi()).toBe(false);
    });

    it('falls back realtime → browser → silent when layers fail to start', async () => {
      const h = setup({ health: makeHealth(true), voices: { 'openai-realtime': { failInit: true }, 'browser-tts': { failInit: true } } });
      await h.coach.init();
      expect(h.created).toEqual(['silent', 'openai-realtime', 'browser-tts', 'silent']);
      expect(h.store.getState().voiceKind).toBe('silent');
    });

    it('reads voice preference and mute from gambit.settings', async () => {
      const h = setup({ health: makeHealth(true), settings: { voice: 'off', muted: true } });
      await h.coach.init();
      expect(h.store.getState()).toMatchObject({ voiceKind: 'silent', muted: true, voicePreference: 'off' });
    });

    it('under automation only the silent layer is ever created — no speech, no realtime session, no mic', async () => {
      const h = setup({ health: makeHealth(true), settings: { voice: 'realtime' }, silenced: true, voices: { 'openai-realtime': { conversational: true } } });
      await h.coach.init();
      expect(h.created).toEqual(['silent', 'silent']);
      expect(h.store.getState()).toMatchObject({ ready: true, voiceKind: 'silent', micAvailable: false, needsUserGesture: false });

      // a settings change during the run cannot wake a real voice either
      await h.coach.setVoicePreference('browser');
      expect(h.created.every((kind) => kind === 'silent')).toBe(true);
      expect(h.store.getState().voiceKind).toBe('silent');
    });

    it('is idempotent', async () => {
      const h = setup();
      await Promise.all([h.coach.init(), h.coach.init()]);
      await h.coach.init();
      expect(h.created).toEqual(['silent', 'browser-tts']);
    });

    it('say() before init() starts init lazily and speaks afterwards', async () => {
      const h = setup();
      const done = h.coach.say(makeEvent({ text: 'Привет!' }));
      await flush();
      expect(h.voice().spoken).toEqual([{ text: 'Привет!', interrupt: false }]);
      h.voice().finish();
      await done;
    });
  });

  describe('say: store transitions', () => {
    it('shows pose, bubble and annotations while speaking, then idles and clears the bubble after ~6 s', async () => {
      const h = setup();
      await h.coach.init();
      const board = { arrows: [{ from: 'e2', to: 'e4', color: 'green' as const }], highlights: [] };
      const done = h.coach.say(makeEvent({ pose: 'think', bubbleText: 'Кf3!', text: 'Конь на эф три!', board }));
      await flush();

      expect(h.store.getState()).toMatchObject({ pose: 'think', bubbleText: 'Кf3!', annotations: board, speaking: true });
      expect(h.voice().spoken).toEqual([{ text: 'Конь на эф три!', interrupt: false }]);

      h.voice().finish();
      await done;
      expect(h.store.getState()).toMatchObject({ pose: 'idle', bubbleText: 'Кf3!', speaking: false, annotations: board });

      await vi.advanceTimersByTimeAsync(5900);
      expect(h.store.getState().bubbleText).toBe('Кf3!');
      await vi.advanceTimersByTimeAsync(200);
      expect(h.store.getState().bubbleText).toBe('');
    });

    it('an event without a board clears old arrows', async () => {
      const h = setup();
      await h.coach.init();
      h.coach.showAnnotations({ arrows: [], highlights: [{ square: 'e4', color: 'yellow' }] });
      void h.coach.say(makeEvent());
      await flush();
      expect(h.store.getState().annotations).toBeNull();
    });

    it('keeps an animated pose for its minimum time even if the phrase was very short', async () => {
      const h = setup();
      await h.coach.init();
      const done = h.coach.say(makeEvent({ pose: 'cheer', text: 'Ура!' }));
      await flush();
      h.voice().finish();
      await done;
      expect(h.store.getState().pose).toBe('cheer');
      await vi.advanceTimersByTimeAsync(2500);
      expect(h.store.getState().pose).toBe('idle');
    });

    it('forwards the mouth level (quantised) and closes the mouth at the end', async () => {
      const h = setup();
      await h.coach.init();
      const done = h.coach.say(makeEvent());
      await flush();
      h.voice().emitLevel(0.537);
      expect(h.store.getState().mouthLevel).toBeCloseTo(0.54, 5);
      h.voice().emitLevel(7);
      expect(h.store.getState().mouthLevel).toBe(1);
      h.voice().finish();
      await done;
      expect(h.store.getState().mouthLevel).toBe(0);
    });
  });

  describe('say: priority queue', () => {
    it('speaks normal phrases one after another in order', async () => {
      const h = setup();
      await h.coach.init();
      const order: string[] = [];
      const a = h.coach.say(makeEvent({ text: 'A' })).then(() => order.push('A'));
      const b = h.coach.say(makeEvent({ text: 'B', pose: 'wave' })).then(() => order.push('B'));
      await flush();
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['A']);
      h.voice().finish();
      await a;
      await flush();
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['A', 'B']);
      expect(h.store.getState().pose).toBe('wave');
      h.voice().finish();
      await b;
      expect(order).toEqual(['A', 'B']);
    });

    it('priority 2 interrupts the current phrase and jumps the queue', async () => {
      const h = setup();
      await h.coach.init();
      const first = h.coach.say(makeEvent({ text: 'обычная' }));
      const second = h.coach.say(makeEvent({ text: 'вторая' }));
      await flush();
      const urgent = h.coach.say(makeEvent({ text: 'Стоп-стоп!', priority: 2, pose: 'oops', bubbleText: 'Стоп!' }));
      await flush();

      expect(h.voice().stopCalls).toBe(1);
      await first; // interrupted phrases resolve too
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['обычная', 'Стоп-стоп!']);
      expect(h.voice().spoken[1]?.interrupt).toBe(true);
      expect(h.store.getState()).toMatchObject({ pose: 'oops', bubbleText: 'Стоп!' });

      h.voice().finish();
      await urgent;
      await flush();
      // the normal phrase that was waiting is still said afterwards
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['обычная', 'Стоп-стоп!', 'вторая']);
      h.voice().finish();
      await second;
    });

    it('priority 0 is dropped while the coach is busy', async () => {
      const h = setup();
      await h.coach.init();
      void h.coach.say(makeEvent({ text: 'важное' }));
      await flush();
      await h.coach.say(makeEvent({ text: 'болтовня', priority: 0 })); // resolves immediately
      h.voice().finish();
      await flush();
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['важное']);
    });

    it('priority 0 is dropped within 4 s after the last phrase and spoken later', async () => {
      const h = setup();
      await h.coach.init();
      const first = h.coach.say(makeEvent({ text: 'важное' }));
      await flush();
      h.voice().finish();
      await first;

      await vi.advanceTimersByTimeAsync(3000);
      await h.coach.say(makeEvent({ text: 'рано', priority: 0 }));
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['важное']);

      await vi.advanceTimersByTimeAsync(1500);
      void h.coach.say(makeEvent({ text: 'теперь можно', priority: 0 }));
      await flush();
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['важное', 'теперь можно']);
    });

    it('does not say the same event id twice', async () => {
      const h = setup();
      await h.coach.init();
      const event = makeEvent();
      const a = h.coach.say(event);
      const b = h.coach.say(event);
      expect(a).toBe(b);
      await flush();
      h.voice().finish();
      await a;
      await flush();
      expect(h.voice().spoken).toHaveLength(1);
    });

    it('caps the backlog: the oldest normal phrase is dropped', async () => {
      const h = setup({ timings: { maxQueue: 2 } });
      await h.coach.init();
      void h.coach.say(makeEvent({ text: 'сейчас' }));
      await flush();
      const dropped = h.coach.say(makeEvent({ text: 'старое' }));
      void h.coach.say(makeEvent({ text: 'среднее' }));
      void h.coach.say(makeEvent({ text: 'новое' }));
      await dropped; // resolved without being spoken
      h.voice().finish();
      await flush();
      h.voice().finish();
      await flush();
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['сейчас', 'среднее', 'новое']);
    });

    it('stopSpeaking() silences the coach and empties the queue', async () => {
      const h = setup();
      await h.coach.init();
      const a = h.coach.say(makeEvent({ text: 'A' }));
      const b = h.coach.say(makeEvent({ text: 'B' }));
      await flush();
      h.coach.stopSpeaking();
      await Promise.all([a, b]);
      await flush();
      expect(h.voice().stopCalls).toBe(1);
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['A']);
      expect(h.store.getState()).toMatchObject({ pose: 'idle', speaking: false });
      await vi.advanceTimersByTimeAsync(2100);
      expect(h.store.getState().bubbleText).toBe('');
    });

    it('a broken voice that never finishes cannot block the queue', async () => {
      const h = setup({ voices: { 'browser-tts': { stuck: true } } });
      await h.coach.init();
      const a = h.coach.say(makeEvent({ text: 'застряла' }));
      void h.coach.say(makeEvent({ text: 'следующая' }));
      await flush();
      await vi.advanceTimersByTimeAsync(46_000);
      await a;
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['застряла', 'следующая']);
    });
  });

  describe('mute', () => {
    it('muted phrases go to the silent layer: bubble yes, sound no', async () => {
      const h = setup({ settings: { muted: true } });
      await h.coach.init();
      const done = h.coach.say(makeEvent({ text: 'Тихая фраза.', bubbleText: 'Тихая фраза.' }));
      await flush();
      expect(h.voice().spoken).toEqual([]);
      expect(h.store.getState()).toMatchObject({ bubbleText: 'Тихая фраза.', speaking: true, muted: true });
      await vi.advanceTimersByTimeAsync(3000);
      await done;
      expect(h.store.getState().speaking).toBe(false);
    });

    it('setMuted persists without losing foreign settings fields and cuts the sound', async () => {
      const h = setup({ settings: { voice: 'browser', theme: 'mint' } });
      await h.coach.init();
      void h.coach.say(makeEvent());
      await flush();
      h.coach.setMuted(true);
      expect(h.voice().stopCalls).toBe(1);
      expect(JSON.parse(h.storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toEqual({ voice: 'browser', theme: 'mint', muted: true });
      h.coach.toggleMuted();
      expect(h.store.getState().muted).toBe(false);
    });
  });

  describe('voice preference', () => {
    it('setVoicePreference swaps the layer and persists', async () => {
      const h = setup({ health: makeHealth(true) });
      await h.coach.init();
      const realtime = h.voice();
      expect(realtime.kind).toBe('openai-realtime');
      await h.coach.setVoicePreference('browser');
      expect(realtime.disposed).toBe(true);
      expect(h.voice().kind).toBe('browser-tts');
      expect(h.store.getState()).toMatchObject({ voiceKind: 'browser-tts', voicePreference: 'browser' });
      expect(JSON.parse(h.storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({ voice: 'browser' });
    });
  });

  describe('first user gesture', () => {
    it('holds phrases until audio is unlocked, then speaks them', async () => {
      const h = setup({ voices: { 'browser-tts': { gestureGated: true, needsGesture: true } } });
      await h.coach.init();
      expect(h.store.getState().needsUserGesture).toBe(true);

      const greeting = h.coach.say(makeEvent({ text: 'Привет-привет!' }));
      await h.coach.say(makeEvent({ text: 'болтовня', priority: 0 })); // chatter is not held back
      await flush();
      expect(h.voice().spoken).toEqual([]);

      h.coach.unlockAudio();
      await flush();
      expect(h.store.getState().needsUserGesture).toBe(false);
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['Привет-привет!']);
      h.voice().finish();
      await greeting;
    });

    it('drops phrases that waited too long behind the lock', async () => {
      const h = setup({ voices: { 'browser-tts': { gestureGated: true, needsGesture: true } } });
      await h.coach.init();
      const stale = h.coach.say(makeEvent({ text: 'давно' }));
      await vi.advanceTimersByTimeAsync(50_000);
      h.coach.unlockAudio();
      await stale;
      expect(h.voice().spoken).toEqual([]);
    });

    it('a muted coach needs no gesture', async () => {
      const h = setup({ settings: { muted: true }, voices: { 'browser-tts': { gestureGated: true, needsGesture: true } } });
      await h.coach.init();
      expect(h.store.getState().needsUserGesture).toBe(false);
    });
  });

  describe('idle behaviour', () => {
    it('falls asleep after 60 s of nothing; say() wakes him up', async () => {
      const h = setup();
      await h.coach.init();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(h.store.getState().pose).toBe('idle');
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.store.getState()).toMatchObject({ pose: 'sleep', asleep: true });

      void h.coach.say(makeEvent({ pose: 'wave' }));
      await flush();
      expect(h.store.getState()).toMatchObject({ pose: 'wave', asleep: false });
    });

    it('noteActivity() postpones sleep and wake() greets with a wave', async () => {
      const h = setup();
      await h.coach.init();
      await vi.advanceTimersByTimeAsync(50_000);
      h.coach.noteActivity();
      await vi.advanceTimersByTimeAsync(50_000);
      expect(h.store.getState().pose).toBe('idle');
      await vi.advanceTimersByTimeAsync(11_000);
      expect(h.store.getState().pose).toBe('sleep');
      h.coach.wake();
      expect(h.store.getState()).toMatchObject({ pose: 'wave', asleep: false });
      await vi.advanceTimersByTimeAsync(2100);
      expect(h.store.getState().pose).toBe('idle');
    });

    it('does not fall asleep in the middle of a long phrase', async () => {
      const h = setup({ timings: { sleepAfterMs: 1000 } });
      await h.coach.init();
      void h.coach.say(makeEvent({ pose: 'talk' }));
      await flush();
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.store.getState().pose).toBe('talk');
    });
  });

  describe('hints and tool host', () => {
    const host = (): CoachToolHost => ({
      getPositionSummary: () => Promise.resolve('…'),
      getHint: vi.fn((level) => Promise.resolve(makeEvent({ kind: 'hint', hintLevel: level, text: `подсказка ${level}` }))),
      explainLastMove: () => Promise.resolve(null),
      showOnBoard: () => undefined,
      takeBackMove: () => false,
    });

    it('setToolHost toggles the hint button flag and reaches the voice layer', async () => {
      const h = setup({ health: makeHealth(true), voices: { 'openai-realtime': { conversational: true } } });
      await h.coach.init();
      const toolHost = host();
      h.coach.setToolHost(toolHost);
      expect(h.store.getState().hasToolHost).toBe(true);
      expect(h.voice().toolHost).toBe(toolHost);
      h.coach.setToolHost(null);
      expect(h.store.getState().hasToolHost).toBe(false);
    });

    it('setHintAvailable(false) hides the hint button flag and mutes requestHint() until the game leaves', async () => {
      const h = setup();
      await h.coach.init();
      const toolHost = host();
      const getHint = vi.spyOn(toolHost, 'getHint');
      let asked = 0;
      h.coach.onHintRequested(() => asked++);
      h.coach.setToolHost(toolHost);
      expect(h.store.getState().hintAvailable).toBe(true);

      h.coach.setHintAvailable(false);
      expect(h.store.getState().hintAvailable).toBe(false);
      h.coach.requestHint();
      expect(asked).toBe(0);
      expect(getHint).not.toHaveBeenCalled();

      // the exam game is gone: the next game gets its button back even if nobody re-enabled it
      h.coach.setToolHost(null);
      expect(h.store.getState().hintAvailable).toBe(true);
      h.coach.setToolHost(toolHost);
      h.coach.requestHint();
      expect(asked).toBe(1);
    });

    it('requestHint() notifies subscribers; unsubscribe works', async () => {
      const h = setup();
      await h.coach.init();
      const cb = vi.fn();
      const off = h.coach.onHintRequested(cb);
      h.coach.requestHint();
      expect(cb).toHaveBeenCalledTimes(1);
      off();
      h.coach.requestHint();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('without subscribers it climbs a simple ladder through the tool host', async () => {
      const h = setup();
      await h.coach.init();
      const toolHost = host();
      h.coach.setToolHost(toolHost);
      h.coach.requestHint();
      await flush();
      expect(toolHost.getHint).toHaveBeenLastCalledWith(1);
      expect(h.voice().spoken.map((s) => s.text)).toEqual(['подсказка 1']);
      h.voice().finish();
      await flush();
      h.coach.requestHint();
      await flush();
      expect(toolHost.getHint).toHaveBeenLastCalledWith(2);
    });
  });

  describe('conversational voice', () => {
    const conversational = {
      health: makeHealth(true),
      settings: { micMode: 'push' },
      voices: { 'openai-realtime': { conversational: true } },
    } satisfies HarnessOptions;

    it('push-to-talk: listen pose, current speech is cut, release returns to idle', async () => {
      const h = setup(conversational);
      await h.coach.init();
      const phrase = h.coach.say(makeEvent());
      await flush();
      await h.coach.startListening();
      await phrase;
      expect(h.voice().listenCalls.start).toBe(1);
      expect(h.store.getState()).toMatchObject({ pose: 'listen', listening: true, bubbleText: '' });
      h.coach.stopListening();
      expect(h.voice().listenCalls.stop).toBe(1);
      expect(h.store.getState()).toMatchObject({ pose: 'idle', listening: false });
    });

    it('shows thinking, then the free answer as a caption with the talk pose', async () => {
      const h = setup(conversational);
      await h.coach.init();
      h.voice().emitThinking(true);
      expect(h.store.getState().pose).toBe('think');
      h.voice().emitThinking(false);
      h.voice().emitSpeaking(true);
      h.voice().emitCaption('Хороший вопрос!');
      expect(h.store.getState()).toMatchObject({ pose: 'talk', bubbleText: 'Хороший вопрос!', speaking: true });
      h.voice().emitSpeaking(false);
      expect(h.store.getState()).toMatchObject({ pose: 'idle', speaking: false, bubbleText: 'Хороший вопрос!' });
      await vi.advanceTimersByTimeAsync(6100);
      expect(h.store.getState().bubbleText).toBe('');
    });

    it('forwards transcripts for the game journal', async () => {
      const h = setup(conversational);
      await h.coach.init();
      const heard: string[] = [];
      h.coach.onTranscript((who, text) => heard.push(`${who}: ${text}`));
      h.voice().emitTranscript('child', 'а почему конь?');
      expect(heard).toEqual(['child: а почему конь?']);
    });

    it('does nothing for push-to-talk on a non-conversational voice', async () => {
      const h = setup();
      await h.coach.init();
      await h.coach.startListening();
      expect(h.store.getState().listening).toBe(false);
    });
  });

  describe('live voice: selection and the fallback chain', () => {
    const both = makeHealth(true, { live: true });
    const talkers = { 'openai-live': { conversational: true }, 'openai-realtime': { conversational: true } } satisfies HarnessOptions['voices'];

    it('auto picks the full-duplex live voice when the server offers it', async () => {
      const h = setup({ health: both, voices: talkers });
      await h.coach.init();
      expect(h.created).toEqual(['silent', 'openai-live']);
      expect(h.store.getState()).toMatchObject({ voiceKind: 'openai-live', micAvailable: true, micMode: 'open', headphonesConfirmed: false });
    });

    it('old settings keep working: voice "realtime" still means the realtime voice first', async () => {
      const h = setup({ health: both, settings: { voice: 'realtime', muted: false }, voices: talkers });
      await h.coach.init();
      expect(h.store.getState()).toMatchObject({ voiceKind: 'openai-realtime', voicePreference: 'realtime', micMode: 'open' });
    });

    it('start-up chain: live → realtime → browser → silent', async () => {
      const h = setup({ health: both, voices: { 'openai-live': { failInit: true }, 'openai-realtime': { failInit: true }, 'browser-tts': { failInit: true } } });
      await h.coach.init();
      expect(h.created).toEqual(['silent', 'openai-live', 'openai-realtime', 'browser-tts', 'silent']);
      expect(h.store.getState().voiceKind).toBe('silent');
    });

    it('runtime chain: the live layer gives up → realtime takes over with the same tool host and mic settings', async () => {
      const h = setup({ health: both, voices: talkers });
      await h.coach.init();
      const host = { getPositionSummary: vi.fn(), getHint: vi.fn(), explainLastMove: vi.fn(), showOnBoard: vi.fn(), takeBackMove: vi.fn() } as unknown as CoachToolHost;
      h.coach.setToolHost(host);
      const live = h.voice();

      live.emitUnavailable('cannot connect');
      await flush();
      expect(live.disposed).toBe(true);
      expect(h.voice().kind).toBe('openai-realtime');
      expect(h.voice().toolHost).toBe(host);
      expect(h.voice().micCalls.modes).toEqual(['open']);
      expect(h.store.getState()).toMatchObject({ voiceKind: 'openai-realtime', micAvailable: true });

      h.voice().emitUnavailable('cannot connect');
      await flush();
      expect(h.store.getState()).toMatchObject({ voiceKind: 'browser-tts', micAvailable: false });
      expect(h.created).toEqual(['silent', 'openai-live', 'openai-realtime', 'browser-tts']);
    });

    it('a layer that gives up in the middle of a phrase is replaced right after it — the phrase (its fallback voice) is not cut', async () => {
      const h = setup({ health: both, voices: talkers });
      await h.coach.init();
      const live = h.voice();
      const first = h.coach.say(makeEvent({ text: 'первая' }));
      const second = h.coach.say(makeEvent({ text: 'вторая' }));
      await flush();
      live.emitUnavailable('the model keeps silent');
      await flush();
      expect(live.disposed).toBe(false);
      live.finish();
      await first;
      await flush();
      expect(live.disposed).toBe(true);
      expect(h.voice().kind).toBe('openai-realtime');
      expect(h.voice().spoken.map((p) => p.text)).toEqual(['вторая']);
      h.voice().finish();
      await second;
    });

    it('under automation no live layer, session or microphone is ever created — also not through applySettings()', async () => {
      const h = setup({ health: both, settings: { voice: 'live', micMode: 'open' }, silenced: true, voices: talkers });
      await h.coach.init();
      expect(h.created).toEqual(['silent', 'silent']);
      expect(h.store.getState()).toMatchObject({ voiceKind: 'silent', micAvailable: false, voiceConnected: false });

      h.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ voice: 'realtime', micMode: 'push' }));
      await h.coach.applySettings();
      h.coach.wake();
      await h.coach.startListening();
      expect(h.created.every((kind) => kind === 'silent')).toBe(true);
      expect(h.store.getState()).toMatchObject({ voiceKind: 'silent', listening: false });
    });
  });

  describe('timeouts: nothing on the network can keep the coach mute', () => {
    it('a health request that never answers → after 4 s the coach starts on the free AI-off voice and says the queued greeting', async () => {
      const h = setup({ healthHangs: true });
      const greeting = h.coach.say(makeEvent({ text: 'Привет!' }));
      await vi.advanceTimersByTimeAsync(3900);
      expect(h.store.getState().ready).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.store.getState()).toMatchObject({ ready: true, voiceKind: AI_OFF_KIND, runtimeAi: false });
      expect(h.voice().spoken.map((p) => p.text)).toEqual(['Привет!']);
      h.voice().finish();
      await greeting;
    });

    it('a voice layer whose init() hangs is skipped after 4 s', async () => {
      const h = setup({ health: makeHealth(true, { live: true }), voices: { 'openai-live': { hangInit: true }, 'openai-realtime': { conversational: true } } });
      const ready = h.coach.init();
      await vi.advanceTimersByTimeAsync(4100);
      await ready;
      expect(h.voices[0]?.disposed).toBe(true);
      expect(h.store.getState()).toMatchObject({ ready: true, voiceKind: 'openai-realtime' });
    });

    it('a voice that never finishes a phrase cannot hold the queue: hard cap per utterance', async () => {
      const h = setup({ voices: { 'browser-tts': { stuck: true } } });
      await h.coach.init();
      let done = false;
      void h.coach.say(makeEvent({ text: 'Коротко.' })).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(9000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(done).toBe(true);
    });
  });

  describe('open microphone and the session lifecycle', () => {
    const live = { health: makeHealth(true, { live: true }), voices: { 'openai-live': { conversational: true } } } satisfies HarnessOptions;
    const host = (): CoachToolHost =>
      ({ getPositionSummary: vi.fn(), getHint: vi.fn(), explainLastMove: vi.fn(), showOnBoard: vi.fn(), takeBackMove: vi.fn() }) as unknown as CoachToolHost;

    it('hands mic mode, echo guard (no headphones yet) and the mic switch to the layer', async () => {
      const h = setup(live);
      await h.coach.init();
      expect(h.voice().micCalls).toEqual({ modes: ['open'], muted: [false], echoGuard: [true] });

      h.coach.confirmHeadphones();
      expect(h.voice().micCalls.echoGuard.at(-1)).toBe(false);
      expect(h.store.getState().headphonesConfirmed).toBe(true);
      expect(JSON.parse(h.storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({ headphonesConfirmed: true });

      h.coach.setMicMode('push');
      expect(h.voice().micCalls.modes.at(-1)).toBe('push');
      expect(h.voice().micCalls.echoGuard.at(-1)).toBe(false); // push-to-talk needs no guard
      expect(JSON.parse(h.storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({ micMode: 'push' });
    });

    it('«Буду нажимать кнопку» from the headphones note = push mode, and then the button really listens', async () => {
      const h = setup(live);
      await h.coach.init();
      await h.coach.startListening(); // open mode: nothing to hold
      expect(h.voice().listenCalls.start).toBe(0);
      expect(h.store.getState().listening).toBe(false);

      h.coach.setMicMode('push');
      await h.coach.startListening();
      expect(h.voice().listenCalls.start).toBe(1);
      expect(h.store.getState()).toMatchObject({ listening: true, pose: 'listen' });
    });

    it('the child talking shows the listen pose and the indicator state; tapping the indicator mutes the microphone', async () => {
      const h = setup(live);
      await h.coach.init();
      h.voice().emitChildSpeaking(true);
      expect(h.store.getState()).toMatchObject({ pose: 'listen', childSpeaking: true });
      h.voice().emitChildSpeaking(false);
      expect(h.store.getState()).toMatchObject({ pose: 'idle', childSpeaking: false });

      h.coach.toggleMic();
      expect(h.store.getState().micMuted).toBe(true);
      expect(h.voice().micCalls.muted.at(-1)).toBe(true);
      h.coach.toggleMic();
      expect(h.voice().micCalls.muted.at(-1)).toBe(false);
    });

    it('no game: 90 s without speech or activity → sleep pose AND the paid session + microphone are closed', async () => {
      const h = setup(live);
      await h.coach.init();
      h.voice().emitConnected(true);
      expect(h.store.getState().voiceConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(89_000);
      expect(h.voice().sessionCalls.suspend).toBe(0);
      expect(h.store.getState().asleep).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.voice().sessionCalls.suspend).toBe(1);
      expect(h.store.getState()).toMatchObject({ pose: 'sleep', asleep: true, voiceConnected: false });
    });

    it('closing an idle session that re-announces «child not speaking» does NOT reopen it', async () => {
      const h = setup(live);
      await h.coach.init();
      h.voice().emitConnected(true);
      // what the real layer did while closing: connected=false, childSpeaking=false, conversation off
      const voice = h.voice() as unknown as { suspend: () => void };
      const suspend = voice.suspend;
      voice.suspend = () => {
        suspend();
        h.voice().emitChildSpeaking(false);
      };
      await vi.advanceTimersByTimeAsync(91_000);
      expect(h.voice().sessionCalls.suspend).toBe(1);
      expect(h.voice().sessionCalls.resume).toBe(0);
      expect(h.store.getState()).toMatchObject({ asleep: true, voiceConnected: false });
      // a real «started speaking» is activity: it wakes him (and the session) up
      h.voice().emitChildSpeaking(true);
      expect(h.voice().sessionCalls.resume).toBe(1);
      expect(h.store.getState().asleep).toBe(false);
    });

    it('during a game the limit is 2 minutes without the child; the end of the game brings the 90 s back', async () => {
      const h = setup(live);
      await h.coach.init();
      h.coach.setToolHost(host());
      await vi.advanceTimersByTimeAsync(119_000);
      expect(h.voice().sessionCalls.suspend).toBe(0);
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.voice().sessionCalls.suspend).toBe(1);

      h.coach.wake();
      h.coach.setToolHost(null);
      await vi.advanceTimersByTimeAsync(91_000);
      expect(h.voice().sessionCalls.suspend).toBe(2);
    });

    it('speech from either side keeps the session awake', async () => {
      const h = setup(live);
      await h.coach.init();
      await vi.advanceTimersByTimeAsync(80_000);
      h.voice().emitTranscript('child', 'а почему конь?');
      await vi.advanceTimersByTimeAsync(80_000);
      h.voice().emitChildSpeaking(true);
      await vi.advanceTimersByTimeAsync(120_000); // still talking (or the signal got stuck): not idle
      expect(h.voice().sessionCalls.suspend).toBe(0);
      h.voice().emitChildSpeaking(false);
      await vi.advanceTimersByTimeAsync(91_000);
      expect(h.voice().sessionCalls.suspend).toBe(1);
    });

    it('a click on the mascot, a move on the board or a phrase wakes him up and reconnects at once', async () => {
      const h = setup(live);
      await h.coach.init();
      await vi.advanceTimersByTimeAsync(91_000);
      expect(h.store.getState().asleep).toBe(true);

      h.coach.wake();
      expect(h.voice().sessionCalls.resume).toBe(1);
      expect(h.store.getState()).toMatchObject({ asleep: false, pose: 'wave', voiceConnected: true });

      await vi.advanceTimersByTimeAsync(91_000);
      h.coach.noteActivity();
      expect(h.voice().sessionCalls.resume).toBe(2);

      await vi.advanceTimersByTimeAsync(91_000);
      void h.coach.say(makeEvent({ text: 'Я снова тут!' }));
      await flush();
      expect(h.voice().sessionCalls.resume).toBe(3);
      expect(h.voice().spoken.map((p) => p.text)).toEqual(['Я снова тут!']);
    });

    it('wake() on an awake coach whose session is not open (nothing said yet, connection dropped) opens it', async () => {
      const h = setup(live);
      await h.coach.init();
      expect(h.store.getState()).toMatchObject({ asleep: false, voiceConnected: false });
      h.coach.wake();
      expect(h.voice().sessionCalls.resume).toBe(1);
      expect(h.store.getState().voiceConnected).toBe(true);
    });

    it('muting the coach closes the paid session; unmuting brings a running conversation back', async () => {
      const h = setup(live);
      await h.coach.init();
      h.voice().emitConnected(true);
      h.coach.setMuted(true);
      expect(h.voice().sessionCalls.suspend).toBe(1);
      h.coach.noteActivity();
      expect(h.voice().sessionCalls.resume).toBe(0);
      h.coach.setMuted(false);
      expect(h.voice().sessionCalls.resume).toBe(1);
    });

    it('pushContext reaches the conversational model silently — never while muted, never on a free voice', async () => {
      const h = setup(live);
      await h.coach.init();
      h.coach.pushContext('Ход 3: ученик сыграл конь эф три.');
      expect(h.voice().contextNotes).toEqual(['Ход 3: ученик сыграл конь эф три.']);
      expect(h.voice().spoken).toEqual([]);
      h.coach.setMuted(true);
      h.coach.pushContext('ещё');
      expect(h.voice().contextNotes).toHaveLength(1);

      const free = setup();
      await free.coach.init();
      expect(() => free.coach.pushContext('заметка')).not.toThrow();
    });
  });

  describe('applySettings()', () => {
    const both = makeHealth(true, { live: true });
    const talkers = { 'openai-live': { conversational: true }, 'openai-realtime': { conversational: true } } satisfies HarnessOptions['voices'];

    it('re-picks the voice layer when the Settings screen changed the voice', async () => {
      const h = setup({ health: both, voices: talkers });
      await h.coach.init();
      const live = h.voice();
      h.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ voice: 'realtime', micMode: 'push', headphonesConfirmed: true, fontScale: 1.2 }));
      await h.coach.applySettings();
      expect(live.disposed).toBe(true);
      expect(h.voice().kind).toBe('openai-realtime');
      expect(h.voice().micCalls).toEqual({ modes: ['push'], muted: [false], echoGuard: [false] });
      expect(h.store.getState()).toMatchObject({ voiceKind: 'openai-realtime', voicePreference: 'realtime', micMode: 'push', headphonesConfirmed: true });
    });

    it('only the microphone settings changed → the running layer is kept and just told', async () => {
      const h = setup({ health: both, voices: talkers });
      await h.coach.init();
      const live = h.voice();
      h.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ voice: 'auto', micMode: 'push' }));
      await h.coach.applySettings();
      expect(live.disposed).toBe(false);
      expect(h.created).toEqual(['silent', 'openai-live']);
      expect(live.micCalls.modes).toEqual(['open', 'push']);
    });

    it('picks up mute and works before init()', async () => {
      const h = setup({ health: both, voices: talkers });
      h.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ voice: 'browser', muted: true }));
      await h.coach.applySettings();
      expect(h.created).toEqual(['silent']);
      await h.coach.init();
      expect(h.store.getState()).toMatchObject({ voiceKind: 'browser-tts', muted: true });
    });
  });

  describe('words from the model: say(event) with a brief', () => {
    const live = { health: makeHealth(true, { live: true }), voices: { 'openai-live': { conversational: true } } } satisfies HarnessOptions;
    const BRIEF = 'Ребёнок сыграл ферзь на дэ два. Конь соперника может напасть на ферзя. Цель: предложить вернуть ход.';

    it('a conversational voice gets speakBrief(brief) with the template as fallbackText', async () => {
      const h = setup(live);
      await h.coach.init();
      const done = h.coach.say(makeEvent({ text: 'Стоп-стоп! Давай вернём ход.', bubbleText: 'Стоп! Вернём ход?', brief: BRIEF, priority: 2, pose: 'oops' }));
      await flush();
      expect(h.voice().briefs).toEqual([{ brief: BRIEF, interrupt: true, fallbackText: 'Стоп-стоп! Давай вернём ход.' }]);
      expect(h.voice().spoken).toEqual([{ text: `brief:${BRIEF}`, interrupt: true }]);
      expect(h.store.getState().pose).toBe('oops');
      h.voice().finish();
      await done;
    });

    it('otherwise the template text exactly as before: no brief, a free voice, a muted coach', async () => {
      const noBrief = setup(live);
      await noBrief.coach.init();
      void noBrief.coach.say(makeEvent({ text: 'Выбери соперника!' }));
      await flush();
      expect(noBrief.voice().spoken).toEqual([{ text: 'Выбери соперника!', interrupt: false }]);
      expect(noBrief.voice().briefs).toEqual([]);

      const browser = setup();
      await browser.coach.init();
      void browser.coach.say(makeEvent({ text: 'Твой ход!', brief: BRIEF }));
      await flush();
      expect(browser.voice().spoken).toEqual([{ text: 'Твой ход!', interrupt: false }]);

      const muted = setup({ ...live, settings: { muted: true } });
      await muted.coach.init();
      void muted.coach.say(makeEvent({ text: 'Тихо.', bubbleText: 'Тихо.', brief: BRIEF }));
      await flush();
      expect(muted.voice().spoken).toEqual([]);
      expect(muted.store.getState().bubbleText).toBe('Тихо.');
    });

    it("the bubble shows the model's own words as they stream; the template only if none come within 1.5 s", async () => {
      const h = setup(live);
      await h.coach.init();
      const done = h.coach.say(makeEvent({ text: 'Шаблон.', bubbleText: 'Шаблон', brief: BRIEF }));
      await flush();
      expect(h.store.getState().bubbleText).toBe('');
      h.voice().emitSayProgress({ type: 'caption', text: 'Ой, подожди!' });
      expect(h.store.getState().bubbleText).toBe('Ой, подожди!');
      h.voice().emitSayProgress({ type: 'caption', text: 'Ой, подожди! Давай вернём ход?' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.store.getState().bubbleText).toBe('Ой, подожди! Давай вернём ход?');
      h.voice().finish();
      await done;
      expect(h.store.getState().bubbleText).toBe('Ой, подожди! Давай вернём ход?'); // what was said stays readable

      const late = setup(live);
      await late.coach.init();
      void late.coach.say(makeEvent({ text: 'Шаблон.', bubbleText: 'Шаблон', brief: BRIEF }));
      await flush();
      await vi.advanceTimersByTimeAsync(1400);
      expect(late.store.getState().bubbleText).toBe('');
      await vi.advanceTimersByTimeAsync(200);
      expect(late.store.getState().bubbleText).toBe('Шаблон');
      // the model's words arrive later: they replace the template
      late.voice().emitSayProgress({ type: 'caption', text: 'Смотри-ка!' });
      expect(late.store.getState().bubbleText).toBe('Смотри-ка!');
    });

    it("'sent' restarts the 1.5 s (the brief waited for a gap in the conversation); 'fallback' shows the template at once", async () => {
      const h = setup(live);
      await h.coach.init();
      void h.coach.say(makeEvent({ text: 'Шаблон.', bubbleText: 'Шаблон', brief: BRIEF }));
      await flush();
      await vi.advanceTimersByTimeAsync(1000);
      h.voice().emitSayProgress({ type: 'sent' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.store.getState().bubbleText).toBe('');
      h.voice().emitSayProgress({ type: 'fallback' });
      expect(h.store.getState().bubbleText).toBe('Шаблон');
    });

    it('progress of an old brief never paints the bubble of another phrase', async () => {
      const h = setup(live);
      await h.coach.init();
      void h.coach.say(makeEvent({ text: 'Просто фраза.', bubbleText: 'Просто фраза' }));
      await flush();
      h.voice().emitSayProgress({ type: 'caption', text: 'чужие слова' });
      expect(h.store.getState().bubbleText).toBe('Просто фраза');
    });

    it("a tool answer: arrows at once, the template's bubble only if the model's own words do not come", async () => {
      const h = setup(live);
      await h.coach.init();
      const board = { arrows: [], highlights: [{ square: 'e4', color: 'yellow' as const }] };
      h.voice().emitToolCoachEvent(makeEvent({ kind: 'hint', bubbleText: 'Что под боем?', board }));
      expect(h.store.getState().annotations).toEqual(board);
      expect(h.store.getState().bubbleText).toBe('');
      h.voice().emitCaption('Давай посмотрим, что под ударом!');
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.store.getState().bubbleText).toBe('Давай посмотрим, что под ударом!');

      h.voice().emitSpeaking(false);
      await vi.advanceTimersByTimeAsync(7000);
      h.voice().emitToolCoachEvent(makeEvent({ kind: 'hint', bubbleText: 'Подсказка' }));
      await vi.advanceTimersByTimeAsync(1600);
      expect(h.store.getState().bubbleText).toBe('Подсказка');
    });
  });

  describe('talkativeness (design D)', () => {
    it('matrix: priority 2 and answers always; quiet nothing else; normal ≥ 1; chatty everything', () => {
      const cases: [Talkativeness, 0 | 1 | 2, CoachEventKind, boolean][] = [
        ['quiet', 2, 'takebackOffer', true],
        ['quiet', 1, 'gameStart', false],
        ['quiet', 0, 'praise', false],
        ['quiet', 1, 'hint', true],
        ['quiet', 0, 'answer', true],
        ['normal', 2, 'takebackOffer', true],
        ['normal', 1, 'threatWarning', true],
        ['normal', 0, 'praise', false],
        ['normal', 0, 'answer', true],
        ['chatty', 0, 'praise', true],
        ['chatty', 0, 'botMoveComment', true],
        ['chatty', 1, 'gameEnd', true],
      ];
      for (const [talkativeness, priority, kind, passes] of cases) expect(passesTalkativeness({ priority, kind }, talkativeness)).toBe(passes);
    });

    it('the conversational coach drops what the setting does not allow; answers and urgent phrases always come', async () => {
      const h = setup({ health: makeHealth(true, { live: true }), voices: { 'openai-live': { conversational: true } }, settings: { talkativeness: 'quiet' } });
      await h.coach.init();
      expect(h.store.getState().talkativeness).toBe('quiet');
      await h.coach.say(makeEvent({ text: 'Твой ход!', priority: 1, kind: 'encourage' })); // resolves at once, never said
      void h.coach.say(makeEvent({ text: 'Подсказка.', priority: 1, kind: 'hint' }));
      await flush();
      expect(h.voice().spoken.map((p) => p.text)).toEqual(['Подсказка.']);
      h.voice().finish();
      await flush();
      void h.coach.say(makeEvent({ text: 'Стоп!', priority: 2, kind: 'takebackOffer' }));
      await flush();
      expect(h.voice().spoken.map((p) => p.text)).toEqual(['Подсказка.', 'Стоп!']);

      h.voice().finish();
      await flush();
      h.coach.setTalkativeness('chatty');
      expect(JSON.parse(h.storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({ talkativeness: 'chatty' });
      await vi.advanceTimersByTimeAsync(5000);
      void h.coach.say(makeEvent({ text: 'Ура!', priority: 0, kind: 'praise' }));
      await flush();
      expect(h.voice().spoken.map((p) => p.text)).toEqual(['Подсказка.', 'Стоп!', 'Ура!']);
    });

    it('free voices: optional chatter is said when the coach is free', async () => {
      const h = setup({ settings: { talkativeness: 'quiet' } });
      await h.coach.init();
      void h.coach.say(makeEvent({ text: 'Молодец!', priority: 0, kind: 'praise' }));
      await flush();
      expect(h.voice().spoken.map((p) => p.text)).toEqual(['Молодец!']);
    });
  });

  describe('the «Поговорить» conversation', () => {
    const live = { health: makeHealth(true, { live: true }), voices: { 'openai-live': { conversational: true } } } satisfies HarnessOptions;
    const host = (): CoachToolHost =>
      ({ getPositionSummary: vi.fn(), getHint: vi.fn(), explainLastMove: vi.fn(), showOnBoard: vi.fn(), takeBackMove: vi.fn() }) as unknown as CoachToolHost;

    it('the store follows the layer: off → connecting → listening → childSpeaking → thinking → coachSpeaking; the model id for a parent', async () => {
      const h = setup(live);
      await h.coach.init();
      expect(h.store.getState()).toMatchObject({ conversationState: 'off', conversationOn: false, voiceModel: 'gpt-live-test' });
      const seen: string[] = [];
      h.store.subscribe((state, previous) => {
        if (state.conversationState !== previous.conversationState) seen.push(state.conversationState);
      });
      await h.coach.startConversation();
      expect(h.voice().openCalls).toBe(1);
      for (const state of ['childSpeaking', 'thinking', 'coachSpeaking', 'listening'] as const) h.voice().emitConversationState(state);
      expect(seen).toEqual(['connecting', 'listening', 'childSpeaking', 'thinking', 'coachSpeaking', 'listening']);
      expect(h.coach.conversationState).toBe('listening');
      expect(h.store.getState().conversationOn).toBe(true);
    });

    it('a tap outside a game greets briefly in the model\'s own words (not twice within a minute); the microphone is on again', async () => {
      const h = setup(live);
      await h.coach.init();
      h.coach.toggleMic();
      expect(h.store.getState().micMuted).toBe(true);
      h.coach.toggleConversation();
      await flush();
      expect(h.store.getState().micMuted).toBe(false);
      expect(h.voice().briefs).toHaveLength(1);
      expect(h.voice().briefs[0]?.brief).toMatch(/нажал кнопку «Поговорить»/);
      h.voice().finish();
      await flush();
      h.coach.endConversation();
      h.coach.toggleConversation();
      await flush();
      expect(h.voice().briefs).toHaveLength(1);
    });

    it('a tap while it runs ends it: «Пока!» in the bubble, session closed, later phrases stay in the bubble (no session)', async () => {
      const h = setup(live);
      await h.coach.init();
      await h.coach.startConversation();
      h.voice().finish();
      await flush();
      h.coach.toggleConversation();
      expect(h.voice().sessionCalls.suspend).toBe(1);
      expect(h.store.getState()).toMatchObject({ conversationState: 'off', conversationOn: false, bubbleText: CONVERSATION_GOODBYE_RU, pose: 'wave' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.store.getState().bubbleText).toBe('');

      const spokenBefore = h.voice().spoken.length;
      void h.coach.say(makeEvent({ text: 'Хороший ход!', bubbleText: 'Хороший ход!', brief: 'Похвали.' }));
      await flush();
      expect(h.voice().spoken).toHaveLength(spokenBefore);
      expect(h.store.getState().bubbleText).toBe('Хороший ход!');
      h.coach.noteActivity();
      expect(h.voice().sessionCalls.resume).toBe(0);

      // the next tap talks again
      await vi.advanceTimersByTimeAsync(10_000);
      await h.coach.startConversation();
      expect(h.voice().openCalls).toBe(2);
    });

    it('an error state: the tap tries again', async () => {
      const h = setup({ ...live, voices: { 'openai-live': { conversational: true, failOpen: true } } });
      await h.coach.init();
      await h.coach.startConversation();
      expect(h.store.getState().conversationState).toBe('error');
      h.coach.toggleConversation();
      await flush();
      expect(h.voice().openCalls).toBe(2);
    });

    it('nothing on a free voice, and nothing under automation', async () => {
      const free = setup();
      await free.coach.init();
      await free.coach.startConversation();
      expect(free.store.getState()).toMatchObject({ conversationState: 'off', conversationOn: false });

      const robot = setup({ ...live, silenced: true });
      await robot.coach.init();
      await robot.coach.startConversation();
      robot.coach.onGameStart({ timeControlId: 'training' });
      await flush();
      expect(robot.created.every((kind) => kind === 'silent')).toBe(true);
      expect(robot.store.getState().conversationOn).toBe(false);
    });

    it('the microphone level reaches the store quantised (the dock ring)', async () => {
      const h = setup(live);
      await h.coach.init();
      h.voice().emitMicLevel(0.537);
      expect(h.store.getState().micLevel).toBe(0.55);
      h.voice().emitMicLevel(0);
      expect(h.store.getState().micLevel).toBe(0);
    });

    describe('auto-start on game start', () => {
      it('a game (not bullet) opens the conversation by itself, without a hello of its own (the game greets)', async () => {
        const h = setup(live);
        await h.coach.init();
        h.coach.setToolHost(host());
        h.coach.onGameStart({ timeControlId: 'rapid10' });
        await flush();
        expect(h.voice().openCalls).toBe(1);
        expect(h.store.getState()).toMatchObject({ conversationOn: true, conversationState: 'listening' });
        expect(h.voice().briefs).toEqual([]);
      });

      it('says «connecting» SYNCHRONOUSLY (the game journals its opening phrases right after the call)', async () => {
        const h = setup(live);
        await h.coach.init();
        h.coach.setToolHost(host());
        h.coach.onGameStart({ timeControlId: 'training' });
        expect(h.coach.conversationState).toBe('connecting');
        expect(h.store.getState().conversationState).toBe('connecting');
        await flush();
        expect(h.coach.conversationState).toBe('listening');

        // a free voice / muted coach never pretends to connect
        const free = setup();
        await free.coach.init();
        free.coach.onGameStart({ timeControlId: 'training' });
        expect(free.coach.conversationState).toBe('off');
        const muted = setup({ ...live, settings: { muted: true } });
        await muted.coach.init();
        muted.coach.onGameStart({ timeControlId: 'training' });
        expect(muted.coach.conversationState).toBe('off');
      });

      it('never in 1-minute bullet — a conversation that ran before is closed there', async () => {
        const h = setup(live);
        await h.coach.init();
        await h.coach.startConversation();
        h.voice().finish();
        await flush();
        h.coach.setToolHost(host());
        h.coach.onGameStart({ timeControlId: 'bullet1' });
        await flush();
        expect(h.voice().openCalls).toBe(1);
        expect(h.voice().sessionCalls.suspend).toBe(1);
        expect(h.store.getState().conversationOn).toBe(false);
      });

      it('not when the setting is off, not on a free voice, not while muted', async () => {
        const off = setup({ ...live, settings: { autoConversation: false } });
        await off.coach.init();
        off.coach.onGameStart({ timeControlId: 'training' });
        await flush();
        expect(off.voice().openCalls).toBe(0);
        off.coach.setAutoConversation(true);
        expect(JSON.parse(off.storage.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({ autoConversation: true });
        off.coach.onGameStart({ timeControlId: 'training' });
        await flush();
        expect(off.voice().openCalls).toBe(1);

        const free = setup();
        await free.coach.init();
        free.coach.onGameStart({ timeControlId: 'training' });
        await flush();
        expect(free.store.getState().conversationOn).toBe(false);

        const muted = setup({ ...live, settings: { muted: true } });
        await muted.coach.init();
        muted.coach.onGameStart({ timeControlId: 'training' });
        await flush();
        expect(muted.voice().openCalls).toBe(0);
      });

      it('a new game starts it again even after the child ended it in the last one', async () => {
        const h = setup(live);
        await h.coach.init();
        h.coach.onGameStart({ timeControlId: 'training' });
        await flush();
        h.coach.endConversation();
        h.coach.onGameEnd();
        h.coach.onGameStart({ timeControlId: 'blitz5' });
        await flush();
        expect(h.voice().openCalls).toBe(2);
        expect(h.store.getState().conversationOn).toBe(true);
      });
    });

    it('during a game the conversation stays open while the child plays; 2 minutes without the child close it, the next move reopens it', async () => {
      const h = setup(live);
      await h.coach.init();
      h.coach.setToolHost(host());
      h.coach.onGameStart({ timeControlId: 'blitz5' });
      await flush();
      for (let minute = 0; minute < 10; minute++) {
        await vi.advanceTimersByTimeAsync(60_000);
        h.coach.noteActivity(); // a move every minute
      }
      expect(h.voice().sessionCalls.suspend).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 1000);
      expect(h.voice().sessionCalls.suspend).toBe(1);
      expect(h.store.getState().asleep).toBe(true);
      // the next move wakes it and reconnects
      h.coach.noteActivity();
      expect(h.voice().sessionCalls.resume).toBe(1);
    });

    it('outside a game the ordinary idle rule (90 s) applies to a conversation too', async () => {
      const h = setup(live);
      await h.coach.init();
      await h.coach.startConversation();
      h.voice().finish();
      await flush();
      await vi.advanceTimersByTimeAsync(91_000);
      expect(h.voice().sessionCalls.suspend).toBe(1);
    });

    it('a session that drops during a game is reopened (bounded), not outside a game and not after «Пока!»', async () => {
      const h = setup(live);
      await h.coach.init();
      h.coach.setToolHost(host());
      h.coach.onGameStart({ timeControlId: 'training' });
      await flush();
      h.voice().emitConversationState('off'); // expired / connection lost
      await vi.advanceTimersByTimeAsync(1600);
      expect(h.voice().openCalls).toBe(2);
      expect(h.store.getState().conversationState).toBe('listening');

      // a connection that keeps failing: three retries in a row, then the button waits for the child
      const failing = setup({ ...live, voices: { 'openai-live': { conversational: true, failOpen: true } } });
      await failing.coach.init();
      failing.coach.setToolHost(host());
      failing.coach.onGameStart({ timeControlId: 'training' });
      await flush();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(failing.voice().openCalls).toBe(4);
      expect(failing.store.getState().conversationState).toBe('error');

      const ended = setup(live);
      await ended.coach.init();
      ended.coach.setToolHost(host());
      ended.coach.onGameStart({ timeControlId: 'training' });
      await flush();
      ended.coach.endConversation();
      ended.voice().emitConversationState('off');
      await vi.advanceTimersByTimeAsync(5000);
      expect(ended.voice().openCalls).toBe(1);
    });

    describe('the long-silence nudge', () => {
      it('untimed / 10-minute game: 60 s of silent thinking → one gentle nudge (a brief, never a move); not again before a move', async () => {
        const h = setup(live);
        await h.coach.init();
        h.coach.setToolHost(host());
        h.coach.onGameStart({ timeControlId: 'training' });
        await flush();
        await vi.advanceTimersByTimeAsync(59_000);
        expect(h.voice().briefs).toEqual([]);
        await vi.advanceTimersByTimeAsync(1500);
        expect(h.voice().briefs.map((b) => b.brief)).toEqual([SILENCE_NUDGE_BRIEF_RU]);
        expect(SILENCE_NUDGE_BRIEF_RU).toMatch(/Ход и клетки не называй/);
        // no duration and no clock in it (the coach does not talk about the time)
        expect(SILENCE_NUDGE_BRIEF_RU).not.toMatch(/минут|секунд/);
        h.voice().finish();
        await flush();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(h.voice().briefs).toHaveLength(1);
      });

      it('never twice within 2 minutes, even after a move; activity and the position changing restart the clock', async () => {
        const h = setup(live);
        await h.coach.init();
        h.coach.setToolHost(host());
        h.coach.onGameStart({ timeControlId: 'rapid10' });
        await flush();
        await vi.advanceTimersByTimeAsync(50_000);
        h.coach.pushContext('Ход соперника: конь на эф шесть.');
        await vi.advanceTimersByTimeAsync(50_000);
        expect(h.voice().briefs).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(11_000);
        expect(h.voice().briefs).toHaveLength(1);
        h.voice().finish();
        await flush();
        h.coach.noteActivity(); // the child moved
        await vi.advanceTimersByTimeAsync(61_000);
        expect(h.voice().briefs).toHaveLength(1); // 2-minute gap
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.voice().briefs).toHaveLength(2);
      });

      it('not in 5-minute blitz, not in bullet, not in an exam, not without the conversation, not when quiet', async () => {
        for (const [timeControlId, examMode, settings] of [
          ['blitz5', false, {}],
          ['bullet1', false, {}],
          ['training', true, {}],
          ['training', false, { talkativeness: 'quiet' }],
          ['training', false, { autoConversation: false }],
        ] as const) {
          const h = setup({ ...live, settings });
          await h.coach.init();
          h.coach.setToolHost(host());
          h.coach.onGameStart({ timeControlId, examMode });
          await flush();
          await vi.advanceTimersByTimeAsync(3 * 60_000);
          expect(h.voice().briefs).toEqual([]);
        }
      });

      it('the game ending stops it', async () => {
        const h = setup(live);
        await h.coach.init();
        h.coach.setToolHost(host());
        h.coach.onGameStart({ timeControlId: 'training' });
        await flush();
        h.coach.onGameEnd();
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(h.voice().briefs).toEqual([]);
      });
    });
  });

  describe('money: an abandoned game, a hidden tab, a closed page, the daily limit', () => {
    const live = { health: makeHealth(true, { live: true }), voices: { 'openai-live': { conversational: true } } } satisfies HarnessOptions;
    const host = (): CoachToolHost =>
      ({ getPositionSummary: vi.fn(), getHint: vi.fn((level) => Promise.resolve(makeEvent({ kind: 'hint', hintLevel: level }))), explainLastMove: vi.fn(), showOnBoard: vi.fn(), takeBackMove: vi.fn() }) as unknown as CoachToolHost;

    /** a game with the conversation on (the default auto-start), session open */
    async function gameWithConversation(options: HarnessOptions = {}, timeControlId: 'training' | 'blitz5' = 'blitz5'): Promise<Harness> {
      const h = setup({ ...live, ...options });
      await h.coach.init();
      h.coach.setToolHost(host());
      h.coach.onGameStart({ timeControlId });
      await flush();
      expect(h.voice().openCalls).toBe(1);
      expect(h.store.getState().voiceConnected).toBe(true);
      return h;
    }

    /** every bubble text the store showed, in order */
    function bubbles(h: Harness): string[] {
      const seen: string[] = [];
      h.store.subscribe((state, previous) => {
        if (state.bubbleText !== previous.bubbleText && state.bubbleText !== '') seen.push(state.bubbleText);
      });
      return seen;
    }

    describe('rule 1: in a game, 2 minutes without the CHILD close the paid session', () => {
      it('the coach talking, the bot moving, context notes and the coach\'s transcripts do not keep it open', async () => {
        const h = await gameWithConversation();
        await vi.advanceTimersByTimeAsync(30_000);
        // the bot moved: a note for the model and a phrase of the coach in his own words
        h.coach.pushContext('Ход соперника: конь на эф шесть.');
        void h.coach.say(makeEvent({ brief: 'Соперник пошёл конём.' }));
        await flush();
        h.voice().emitCaption('Ого, конь прыгнул!');
        h.voice().emitThinking(true);
        h.voice().emitThinking(false);
        h.voice().finish();
        await flush();
        h.voice().emitTranscript('coach', 'Ого, конь прыгнул!');
        await vi.advanceTimersByTimeAsync(60_000);
        h.coach.pushContext('Ход соперника: слон на цэ пять.');
        void h.coach.say(makeEvent({ brief: 'Соперник пошёл слоном.' }));
        await flush();
        h.voice().finish();
        await flush();
        await vi.advanceTimersByTimeAsync(28_000); // 118 s after the child's last activity (the game start)
        expect(h.voice().sessionCalls.suspend).toBe(0);
        await vi.advanceTimersByTimeAsync(2500);
        expect(h.voice().sessionCalls.suspend).toBe(1);
        expect(h.store.getState()).toMatchObject({ asleep: true, pose: 'sleep', voiceConnected: false, bubbleText: GAME_SLEEP_BUBBLE_RU });
      });

      it('dozing: the bubble says it once; the coach\'s phrases, notes, timers and the nudge never reopen it; the next move reconnects at once', async () => {
        const h = await gameWithConversation({}, 'training');
        const shown = bubbles(h);
        // the silence nudge comes at 60 s (a phrase of the coach — not the child's activity)
        await vi.advanceTimersByTimeAsync(61_000);
        expect(h.voice().briefs.map((b) => b.brief)).toEqual([SILENCE_NUDGE_BRIEF_RU]);
        h.voice().finish();
        await flush();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(h.voice().sessionCalls.suspend).toBe(1);
        expect(shown.filter((text) => text === GAME_SLEEP_BUBBLE_RU)).toHaveLength(1);

        // the clock ran out / the game ended while he dozes: the bubble says it, no session, no robot voice
        const spokenBefore = h.voice().spoken.length;
        void h.coach.say(makeEvent({ priority: 2, kind: 'gameEnd', text: 'Время вышло!', bubbleText: 'Время вышло!', brief: 'Время вышло.' }));
        await flush();
        expect(h.store.getState().bubbleText).toBe('Время вышло!');
        h.coach.pushContext('Партия окончена.');
        h.voice().emitTranscript('coach', 'эхо');
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(h.voice().spoken).toHaveLength(spokenBefore);
        expect(h.voice().sessionCalls.resume).toBe(0);
        expect(h.voice().openCalls).toBe(1);
        expect(h.store.getState()).toMatchObject({ asleep: true, pose: 'sleep', voiceConnected: false });
        expect(shown.filter((text) => text === GAME_SLEEP_BUBBLE_RU)).toHaveLength(1); // said once
        expect(h.voice().briefs).toHaveLength(1); // no second nudge while he sleeps

        // the child is back: a move wakes him and reconnects at once — nothing special to press
        h.coach.noteActivity();
        expect(h.voice().sessionCalls.resume).toBe(1);
        expect(h.store.getState()).toMatchObject({ asleep: false, voiceConnected: true });
      });

      it('the sleep notice leaves the bubble when the child comes back', async () => {
        const h = await gameWithConversation();
        await vi.advanceTimersByTimeAsync(121_000);
        expect(h.store.getState().bubbleText).toBe(GAME_SLEEP_BUBBLE_RU);
        await vi.advanceTimersByTimeAsync(60_000); // it stays there while he sleeps (no 6 s linger)
        expect(h.store.getState().bubbleText).toBe(GAME_SLEEP_BUBBLE_RU);
        h.coach.wake(); // a tap on the mascot
        expect(h.store.getState()).toMatchObject({ bubbleText: '', asleep: false, pose: 'wave' });
        expect(h.voice().sessionCalls.resume).toBe(1);
      });

      it('child activity = a move, the child\'s words, the child speaking, «Подсказка», a tap on the page / the mascot, «Поговорить»', async () => {
        const page = createFakePage();
        const h = await gameWithConversation({ page });
        const steps: (() => void)[] = [
          () => h.voice().emitTranscript('child', 'а почему конь?'),
          () => {
            h.voice().emitChildSpeaking(true);
            h.voice().emitChildSpeaking(false);
          },
          () => h.coach.requestHint(),
          () => page.touch(), // the board, the take-back buttons …
          () => h.coach.wake(), // the mascot
          () => h.coach.noteActivity(), // a move
        ];
        for (const step of steps) {
          await vi.advanceTimersByTimeAsync(110_000);
          step();
          await flush();
        }
        expect(h.voice().sessionCalls.suspend).toBe(0);
        await vi.advanceTimersByTimeAsync(121_000);
        expect(h.voice().sessionCalls.suspend).toBe(1);

        // «Поговорить» after he fell asleep: the tap reopens and restarts the clock
        await h.coach.startConversation();
        expect(h.voice().openCalls).toBe(2);
        await vi.advanceTimersByTimeAsync(110_000);
        expect(h.voice().sessionCalls.suspend).toBe(1);
        await vi.advanceTimersByTimeAsync(11_000);
        expect(h.voice().sessionCalls.suspend).toBe(2);
      });

      it('a touch on the page outside a game is not activity (the screens report their own)', async () => {
        const page = createFakePage();
        const h = setup({ ...live, page });
        await h.coach.init();
        await vi.advanceTimersByTimeAsync(91_000);
        expect(h.store.getState().asleep).toBe(true);
        page.touch();
        expect(h.voice().sessionCalls.resume).toBe(0);
        expect(h.store.getState().asleep).toBe(true);
      });

      it('closing re-announcing activity (flushed transcripts, «stopped speaking», thinking) does not reopen it', async () => {
        const h = await gameWithConversation();
        const voice = h.voice() as unknown as { suspend: () => void };
        const suspend = voice.suspend;
        voice.suspend = () => {
          h.voice().emitThinking(true);
          h.voice().emitTranscript('child', 'хвост фразы');
          h.voice().emitTranscript('coach', 'хвост ответа');
          h.voice().emitChildSpeaking(true);
          h.voice().emitChildSpeaking(false);
          h.voice().emitCaption('хвост');
          suspend();
        };
        await vi.advanceTimersByTimeAsync(121_000);
        expect(h.voice().sessionCalls.suspend).toBe(1);
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(h.voice().sessionCalls.resume).toBe(0);
        expect(h.voice().openCalls).toBe(1);
        expect(h.store.getState()).toMatchObject({ asleep: true, voiceConnected: false });
      });

      it('the conversation off (a session opened by a phrase) follows the same 2 minutes', async () => {
        const h = setup({ ...live, settings: { autoConversation: false } });
        await h.coach.init();
        h.coach.setToolHost(host());
        h.coach.onGameStart({ timeControlId: 'rapid10' });
        await flush();
        h.voice().emitConnected(true);
        await vi.advanceTimersByTimeAsync(119_000);
        expect(h.voice().sessionCalls.suspend).toBe(0);
        await vi.advanceTimersByTimeAsync(1500);
        expect(h.voice().sessionCalls.suspend).toBe(1);
      });

      it('a phrase in flight when the time is up may finish first (bounded)', async () => {
        const h = await gameWithConversation();
        await vi.advanceTimersByTimeAsync(110_000);
        void h.coach.say(makeEvent({ brief: 'Длинная мысль.' }));
        await flush();
        await vi.advanceTimersByTimeAsync(15_000); // past the 2 minutes, the phrase is still being said
        expect(h.voice().sessionCalls.suspend).toBe(0);
        h.voice().finish();
        await flush();
        await vi.advanceTimersByTimeAsync(1100);
        expect(h.voice().sessionCalls.suspend).toBe(1);
      });
    });

    describe('rule 2: a hidden tab', () => {
      it('hidden ≥ 15 s closes the session (shorter does nothing); visible again in a game with the conversation on reconnects', async () => {
        const page = createFakePage();
        const h = await gameWithConversation({ page });
        page.setHidden(true);
        await vi.advanceTimersByTimeAsync(14_000);
        page.setHidden(false);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(h.voice().sessionCalls.suspend).toBe(0);

        page.setHidden(true);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(h.voice().sessionCalls.suspend).toBe(1);
        expect(h.store.getState()).toMatchObject({ asleep: true, voiceConnected: false });
        // while hidden nothing of the coach opens it (the clock may run out behind the child's back)
        const spokenBefore = h.voice().spoken.length;
        void h.coach.say(makeEvent({ priority: 2, text: 'Время вышло!', brief: 'Время вышло.' }));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.voice().spoken).toHaveLength(spokenBefore);
        expect(h.voice().sessionCalls.resume).toBe(0);

        page.setHidden(false);
        expect(h.voice().sessionCalls.resume).toBe(1);
        expect(h.store.getState()).toMatchObject({ asleep: false, voiceConnected: true });
        // and the child's clock started over: 2 more minutes
        await vi.advanceTimersByTimeAsync(119_000);
        expect(h.voice().sessionCalls.suspend).toBe(1);
      });

      it('outside a game it stays asleep until needed (a phrase or a tap)', async () => {
        const page = createFakePage();
        const h = setup({ ...live, page });
        await h.coach.init();
        await h.coach.startConversation();
        h.voice().finish();
        await flush();
        page.setHidden(true);
        await vi.advanceTimersByTimeAsync(16_000);
        expect(h.voice().sessionCalls.suspend).toBe(1);
        page.setHidden(false);
        await flush();
        expect(h.voice().sessionCalls.resume).toBe(0);
        expect(h.store.getState().asleep).toBe(true);
        void h.coach.say(makeEvent({ text: 'Привет снова!' }));
        await flush();
        expect(h.voice().sessionCalls.resume).toBe(1);
      });

      it('a game without the conversation stays asleep until the child comes back', async () => {
        const page = createFakePage();
        const h = setup({ ...live, page, settings: { autoConversation: false } });
        await h.coach.init();
        h.coach.setToolHost(host());
        h.coach.onGameStart({ timeControlId: 'rapid10' });
        h.voice().emitConnected(true);
        page.setHidden(true);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(h.voice().sessionCalls.suspend).toBe(1);
        page.setHidden(false);
        void h.coach.say(makeEvent({ text: 'Твой ход!' }));
        await vi.advanceTimersByTimeAsync(5000);
        expect(h.voice().sessionCalls.resume).toBe(0);
        h.coach.noteActivity();
        expect(h.voice().sessionCalls.resume).toBe(1);
      });
    });

    describe('rule 3: the page closes', () => {
      it('pagehide closes the session at once and asks the layer for a beacon report', async () => {
        const page = createFakePage();
        const h = await gameWithConversation({ page });
        page.pageHide();
        expect(h.voice().sessionCalls.suspend).toBe(1);
        expect(h.voice().suspendOptions.at(-1)).toEqual({ pageHide: true });
        expect(h.store.getState().voiceConnected).toBe(false);
        // nothing reopens it behind the closing page
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(h.voice().sessionCalls.resume).toBe(0);
        expect(h.voice().openCalls).toBe(1);
      });

      it('an idle close or a hidden tab closes without a beacon (an ordinary report)', async () => {
        const h = await gameWithConversation();
        await vi.advanceTimersByTimeAsync(121_000);
        expect(h.voice().suspendOptions).toEqual([undefined]);
      });
    });

    describe('rule 4: the daily limit', () => {
      it('used up before the game: no session opens today, the coach goes on in the bubble, «Лимит» said once', async () => {
        const usage = vi.fn(() => Promise.resolve({ todaySeconds: 61 * 60 }));
        const h = setup({ ...live, usage });
        const shown = bubbles(h);
        await h.coach.init();
        await flush();
        expect(usage).toHaveBeenCalledTimes(1);
        expect(h.store.getState()).toMatchObject({ voiceLimitReached: true, voiceDailyLimitMin: 60 });

        h.coach.setToolHost(host());
        h.coach.onGameStart({ timeControlId: 'training' });
        await flush();
        expect(h.voice().openCalls).toBe(0);
        expect(h.store.getState()).toMatchObject({ conversationOn: false, conversationState: 'off' });
        expect(shown).toContain(VOICE_LIMIT_BUBBLE_RU);

        // a move, a tap, «Поговорить», a phrase: still no paid session, no robot voice, no second announcement
        h.coach.noteActivity();
        h.coach.wake();
        await h.coach.startConversation();
        void h.coach.say(makeEvent({ text: 'Хороший ход!', bubbleText: 'Хороший ход!', brief: 'Похвали.' }));
        await vi.advanceTimersByTimeAsync(20_000);
        expect(h.voice().openCalls).toBe(0);
        expect(h.voice().sessionCalls.resume).toBe(0);
        expect(h.voice().spoken).toEqual([]);
        expect(shown).toContain('Хороший ход!');
        expect(shown.filter((text) => text === VOICE_LIMIT_BUBBLE_RU)).toHaveLength(1);
      });

      it('used up while the session is open: closed when the minutes run out, not reopened by the child', async () => {
        const usage = vi.fn(() => Promise.resolve({ todaySeconds: 58 * 60 }));
        const h = await gameWithConversation({ usage });
        const shown = bubbles(h);
        for (let step = 0; step < 3; step++) {
          await vi.advanceTimersByTimeAsync(39_000);
          h.coach.noteActivity(); // the child keeps playing
        }
        expect(h.voice().sessionCalls.suspend).toBe(0); // 117 s: 2 min 57 s … not yet
        await vi.advanceTimersByTimeAsync(4000);
        expect(h.voice().sessionCalls.suspend).toBe(1);
        expect(h.store.getState()).toMatchObject({ voiceLimitReached: true, conversationOn: false, voiceConnected: false });
        expect(shown.filter((text) => text === VOICE_LIMIT_BUBBLE_RU)).toHaveLength(1);
        // GET /api/voice/usage at most once a minute
        expect(usage.mock.calls.length).toBeLessThanOrEqual(3);

        h.coach.noteActivity();
        await h.coach.startConversation();
        await vi.advanceTimersByTimeAsync(3 * 60_000);
        expect(h.voice().sessionCalls.resume).toBe(0);
        expect(h.voice().openCalls).toBe(1);
      });

      it('a failing usage route is tolerated: this page\'s own sessions are summed up', async () => {
        const usage = vi.fn(() => Promise.reject(new Error('offline')));
        const h = setup({ ...live, usage, settings: { voiceDailyLimitMin: 30 } });
        await h.coach.init();
        await h.coach.startConversation();
        for (let minute = 0; minute < 20; minute++) {
          await vi.advanceTimersByTimeAsync(60_000);
          h.voice().emitTranscript('child', 'ага');
        }
        h.coach.endConversation(); // 20 minutes
        expect(h.voice().sessionCalls.suspend).toBe(1);
        await h.coach.startConversation();
        expect(h.voice().openCalls).toBe(2);
        for (let minute = 0; minute < 9; minute++) {
          await vi.advanceTimersByTimeAsync(60_000);
          h.voice().emitTranscript('child', 'ага');
        }
        expect(h.voice().sessionCalls.suspend).toBe(1);
        await vi.advanceTimersByTimeAsync(61_000);
        expect(h.voice().sessionCalls.suspend).toBe(2);
        expect(h.store.getState().voiceLimitReached).toBe(true);
      });

      it('resets at local midnight', async () => {
        vi.setSystemTime(new Date(2026, 8, 22, 23, 50, 0));
        let today = 90 * 60;
        const usage = vi.fn(() => Promise.resolve({ todaySeconds: today }));
        const h = setup({ ...live, usage });
        await h.coach.init();
        await flush();
        expect(h.store.getState().voiceLimitReached).toBe(true);
        await h.coach.startConversation();
        expect(h.voice().openCalls).toBe(0);

        today = 0; // a new day on the server too
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        expect(localDayKey(Date.now())).toBe('2026-09-23');
        expect(h.store.getState().voiceLimitReached).toBe(false);
        await h.coach.startConversation();
        expect(h.voice().openCalls).toBe(1);
      });

      it('0 = no limit: nothing is fetched, nothing is closed for money', async () => {
        const usage = vi.fn(() => Promise.resolve({ todaySeconds: 10 * 3600 }));
        const h = setup({ ...live, usage, settings: { voiceDailyLimitMin: 0 } });
        await h.coach.init();
        await h.coach.startConversation();
        for (let minute = 0; minute < 5; minute++) {
          await vi.advanceTimersByTimeAsync(60_000);
          h.voice().emitTranscript('child', 'ага');
        }
        expect(usage).not.toHaveBeenCalled();
        expect(h.voice().sessionCalls.suspend).toBe(0);
        expect(h.store.getState().voiceLimitReached).toBe(false);
      });

      it('a parent raising the limit in Settings lets the voice back today', async () => {
        const usage = vi.fn(() => Promise.resolve({ todaySeconds: 65 * 60 }));
        const h = setup({ ...live, usage });
        await h.coach.init();
        await flush();
        expect(h.store.getState().voiceLimitReached).toBe(true);
        h.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ voiceDailyLimitMin: 90 }));
        await h.coach.applySettings();
        expect(h.store.getState()).toMatchObject({ voiceLimitReached: false, voiceDailyLimitMin: 90 });
        await h.coach.startConversation();
        expect(h.voice().openCalls).toBe(1);
      });

      it('free voices know no limit', async () => {
        const usage = vi.fn(() => Promise.resolve({ todaySeconds: 10 * 3600 }));
        const h = setup({ usage });
        await h.coach.init();
        await flush();
        expect(usage).not.toHaveBeenCalled();
        expect(h.store.getState().voiceLimitReached).toBe(false);
        void h.coach.say(makeEvent({ text: 'Привет!' }));
        await flush();
        expect(h.voice().spoken.map((p) => p.text)).toEqual(['Привет!']);
      });
    });
  });

  it('dispose() resolves everything and releases the voice', async () => {
    const h = setup();
    await h.coach.init();
    const a = h.coach.say(makeEvent());
    const b = h.coach.say(makeEvent());
    await flush();
    h.coach.dispose();
    await Promise.all([a, b]);
    expect(h.voice().disposed).toBe(true);
    await h.coach.say(makeEvent()); // no-op after dispose
  });
});

describe('teacher mode (docs/TEACHER-MODE.md §2.7, §7.1, §7.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const live = { health: makeHealth(true, { live: true }), voices: { 'openai-live': { conversational: true } } } satisfies HarnessOptions;
  const ADVICE_BRIEF = 'Момент: ход ученика.\nФакты: Пешка встаёт в центр.\nМожно назвать: пешка на е четыре (зелёная стрелка).\nЦель: покажи ход.\nНельзя: не называй других ходов.';
  const teach = (style: 'full' | 'short' | 'concept', ply = 1, moment: 'turn' | 'openingPlan' | 'repeat' | 'reveal' | 'reaction' = 'turn') => ({
    moment,
    style,
    ply,
    advice: [{ uci: 'e2e4', san: 'e4', source: 'mainLine' as const, arrow: 'green' as const }],
  });
  const teachTurn = (style: 'full' | 'short' | 'concept' = 'full', ply = 1, patch: Partial<Parameters<typeof makeEvent>[0]> = {}) =>
    makeEvent({ kind: 'teachTurn', priority: 1, pauseClock: true, brief: ADVICE_BRIEF, text: 'Пешка на е четыре — в центр!', teach: teach(style, ply), ...patch });
  const host = (extra: Partial<CoachToolHost> = {}): CoachToolHost => ({
    getPositionSummary: () => Promise.resolve('…'),
    getHint: vi.fn((level) => Promise.resolve(makeEvent({ kind: 'hint', hintLevel: level, text: `подсказка ${level}` }))),
    explainLastMove: () => Promise.resolve(null),
    showOnBoard: () => undefined,
    takeBackMove: () => false,
    ...extra,
  });

  it('passesTalkativeness: teachTurn / teachReaction pass in EVERY talkativeness (it sets their length, not whether they are said)', () => {
    for (const talkativeness of ['quiet', 'normal', 'chatty'] as const) {
      for (const kind of ['teachTurn', 'teachReaction'] as const) {
        for (const priority of [0, 1, 2] as const) expect(passesTalkativeness({ priority, kind }, talkativeness)).toBe(true);
      }
    }
    // the strategy intro that starts a teacher game is a `gameStart` WITH a teacher summary: never filtered either
    const intro = { priority: 1 as const, kind: 'gameStart' as const, teach: { moment: 'openingPlan' as const, style: 'full' as const, ply: 1, advice: [] } };
    for (const talkativeness of ['quiet', 'normal', 'chatty'] as const) expect(passesTalkativeness(intro, talkativeness)).toBe(true);
    // nothing else changed
    expect(passesTalkativeness({ priority: 1, kind: 'gameStart' }, 'quiet')).toBe(false);
    expect(passesTalkativeness({ priority: 1, kind: 'threatWarning' }, 'quiet')).toBe(false);
    expect(passesTalkativeness({ priority: 0, kind: 'praise' }, 'normal')).toBe(false);
  });

  it('«Тихо»: a conversational coach still says the teacher\'s advice and reaction (T4: not filtered when quiet); other chatter stays filtered', async () => {
    const h = setup({ ...live, settings: { talkativeness: 'quiet' } });
    await h.coach.init();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    await flush();
    await h.coach.say(makeEvent({ kind: 'threatWarning', priority: 1, text: 'Осторожно!', brief: 'Угроза.' })); // filtered at once
    void h.coach.say(teachTurn('short', 1));
    await flush();
    expect(h.voice().briefs.map((b) => b.brief)).toEqual([ADVICE_BRIEF]);
    h.voice().finish();
    await flush();
    void h.coach.say(makeEvent({ kind: 'teachReaction', priority: 1, text: 'Соперник теперь заберёт пешку.', brief: 'Момент: реакция.', teach: teach('short', 3, 'reaction') }));
    await flush();
    expect(h.voice().briefs.map((b) => b.brief)).toEqual([ADVICE_BRIEF, 'Момент: реакция.']);
  });

  it('the talkativeness is exposed for the game (store + getter): the teacher brain picks «short» from it', async () => {
    const h = setup({ settings: { talkativeness: 'quiet' } });
    await h.coach.init();
    expect(h.coach.talkativeness).toBe('quiet');
    expect(h.store.getState().talkativeness).toBe('quiet');
    h.coach.setTalkativeness('chatty');
    expect(h.coach.talkativeness).toBe('chatty');
  });

  it('the brief frame carries the phrase\'s sentence budget: short 1, full 2, concept 2 («коротко»); other events none', async () => {
    const h = setup(live);
    await h.coach.init();
    for (const style of ['short', 'full', 'concept'] as const) {
      void h.coach.say(teachTurn(style, 1, { id: `advice-${style}` }));
      await flush();
      h.voice().finish();
      await flush();
    }
    void h.coach.say(makeEvent({ kind: 'gameStart', brief: 'Момент: начало партии.' }));
    await flush();
    expect(h.voice().briefs.map((b) => b.maxSentences)).toEqual([1, 2, 2, undefined]);
    // an urgent teacher take-back offer keeps its urgency and gets its budget too
    h.voice().finish();
    await flush();
    void h.coach.say(makeEvent({ kind: 'takebackOffer', priority: 2, brief: 'Момент: ход теряет коня.', teach: teach('full', 5) }));
    await flush();
    expect(h.voice().briefs.at(-1)).toMatchObject({ interrupt: true, maxSentences: 2 });
  });

  it('onGameStart({ coachStyle }) is kept in the store for the dock (null outside a game); older games derive it from examMode', async () => {
    const h = setup();
    await h.coach.init();
    expect(h.coach.coachStyle).toBeNull();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    expect(h.store.getState().coachStyle).toBe('teacher');
    expect(h.coach.coachStyle).toBe('teacher');
    h.coach.onGameEnd();
    expect(h.store.getState().coachStyle).toBeNull();
    h.coach.onGameStart({ timeControlId: 'rapid10', examMode: true });
    expect(h.coach.coachStyle).toBe('exam');
    h.coach.setToolHost(null);
    expect(h.coach.coachStyle).toBeNull();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'blitz5' });
    expect(h.coach.coachStyle).toBe('helper');
  });

  it('an exam never says a teacher phrase (no proactive speech); a helper / teacher game does', async () => {
    for (const info of [{ coachStyle: 'exam' as const }, { examMode: true }]) {
      const h = setup(live);
      await h.coach.init();
      h.coach.setToolHost(host());
      h.coach.onGameStart({ timeControlId: 'rapid10', ...info });
      await flush();
      await h.coach.say(teachTurn('full', 1));
      await h.coach.say(makeEvent({ kind: 'teachReaction', brief: 'Момент: реакция.', teach: teach('short', 1, 'reaction') }));
      expect(h.voice().briefs).toEqual([]);
    }
    const teacher = setup(live);
    await teacher.coach.init();
    teacher.coach.setToolHost(host());
    teacher.coach.onGameStart({ timeControlId: 'rapid10', coachStyle: 'teacher' });
    await flush();
    void teacher.coach.say(teachTurn('full', 1));
    await flush();
    expect(teacher.voice().briefs).toHaveLength(1);
  });

  it('no 60 s silence nudge in teacher mode (the teacher speaks every move; P1 = a reminder by the game)', async () => {
    const h = setup(live);
    await h.coach.init();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    await flush();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(h.voice().briefs).toEqual([]);
    // the same game in helper style nudges (unchanged behaviour)
    const helper = setup(live);
    await helper.coach.init();
    helper.coach.setToolHost(host());
    helper.coach.onGameStart({ timeControlId: 'training', coachStyle: 'helper' });
    await flush();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(helper.voice().briefs.map((b) => b.brief)).toEqual([SILENCE_NUDGE_BRIEF_RU]);
  });

  it('advice for a newer position drops a still waiting teachTurn of an older one (the child has moved on)', async () => {
    const h = setup();
    await h.coach.init();
    const first = h.coach.say(makeEvent({ text: 'Что-то говорю.' }));
    await flush();
    const stale = h.coach.say(teachTurn('full', 3, { text: 'Совет для третьего полухода.' }));
    const reaction = h.coach.say(makeEvent({ kind: 'teachReaction', text: 'Реакция на ход.', teach: teach('short', 3, 'reaction') }));
    const fresh = h.coach.say(teachTurn('full', 5, { text: 'Совет для пятого полухода.' }));
    await stale; // resolved without being said
    h.voice().finish();
    await first;
    await flush();
    h.voice().finish();
    await reaction;
    await flush();
    h.voice().finish();
    await fresh;
    expect(h.voice().spoken.map((p) => p.text)).toEqual(['Что-то говорю.', 'Реакция на ход.', 'Совет для пятого полухода.']);
  });

  it('«Совет» with nobody subscribed repeats the advice through host.repeatAdvice (no ladder); helper games keep the ladder', async () => {
    const h = setup();
    await h.coach.init();
    const repeat = teachTurn('short', 1, { text: 'Вот мой совет ещё раз.', teach: teach('short', 1, 'repeat') });
    const repeatAdvice = vi.fn(() => Promise.resolve(repeat));
    const toolHost = host({ repeatAdvice });
    h.coach.setToolHost(toolHost);
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    h.coach.requestHint();
    await flush();
    expect(repeatAdvice).toHaveBeenCalledTimes(1);
    expect(toolHost.getHint).not.toHaveBeenCalled();
    expect(h.voice().spoken.map((p) => p.text)).toEqual(['Вот мой совет ещё раз.']);

    // a game that subscribed handles the button itself (it calls repeatAdvice / its own flow)
    let asked = 0;
    const off = h.coach.onHintRequested(() => asked++);
    h.coach.requestHint();
    expect(asked).toBe(1);
    expect(repeatAdvice).toHaveBeenCalledTimes(1);
    off();

    // a teacher game without repeatAdvice, and a helper game: the ladder as before
    const helper = setup();
    await helper.coach.init();
    const ladderHost = host();
    helper.coach.setToolHost(ladderHost);
    helper.coach.onGameStart({ timeControlId: 'training', coachStyle: 'helper' });
    helper.coach.requestHint();
    await flush();
    expect(ladderHost.getHint).toHaveBeenCalledWith(1);
  });

  it('money rules stay: a teacher game still sleeps after 2 minutes without the CHILD — the advice itself is not his activity', async () => {
    const h = setup(live);
    await h.coach.init();
    h.coach.setToolHost(host());
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    await flush();
    // the teacher speaks after every bot move — that never keeps the paid session open
    for (let i = 0; i < 4; i++) {
      void h.coach.say(teachTurn('short', 1 + 2 * i, { id: `a-${i}` }));
      await flush();
      h.voice().finish();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.voice().sessionCalls.suspend).toBe(1);
    expect(h.store.getState().asleep).toBe(true);
    // the child's next move reopens it
    h.coach.noteActivity();
    expect(h.voice().sessionCalls.resume).toBe(1);
  });
});

describe('the lesson model: no generative AI in the child\'s game (docs/TEACHING.md §4.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('init() publishes runtimeAi from /api/health: only an explicit `ai.runtime: true` counts', async () => {
    const on = setup({ health: makeHealth(false) });
    expect(on.coach.runtimeAi()).toBe(false); // nothing known before /api/health answered
    await on.coach.init();
    expect(on.store.getState().runtimeAi).toBe(true);
    expect(on.coach.runtimeAi()).toBe(true);
    for (const runtimeAi of [false, null] as const) {
      const off = setup({ health: makeHealth(true, { live: true }, { runtimeAi }) });
      await off.coach.init();
      expect(off.store.getState().runtimeAi, String(runtimeAi)).toBe(false);
      expect(off.coach.runtimeAi()).toBe(false);
    }
  });

  it('a stored «live» with keys on the server but AI off: the AI-off voice speaks, the setting is not rewritten, no conversation ever opens', async () => {
    const talkers = { 'openai-live': { conversational: true }, 'openai-realtime': { conversational: true } } satisfies HarnessOptions['voices'];
    const h = setup({ health: makeHealth(true, { live: true, preferred: 'live' }, { runtimeAi: false }), settings: { voice: 'live', autoConversation: true }, voices: talkers });
    await h.coach.init();
    expect(h.created).toEqual(['silent', AI_OFF_KIND]);
    expect(h.store.getState()).toMatchObject({ voiceKind: AI_OFF_KIND, voicePreference: 'live', runtimeAi: false, micAvailable: false });
    expect(JSON.parse(h.storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({ voice: 'live' });

    // a game start (autoConversation on) and a tap on «Поговорить» (should it ever be painted) open nothing
    h.coach.setToolHost({ getHint: vi.fn(), explainLastMove: vi.fn() } as unknown as CoachToolHost);
    h.coach.onGameStart({ timeControlId: 'training', coachStyle: 'teacher' });
    await h.coach.startConversation();
    h.coach.toggleConversation();
    await flush();
    expect(h.store.getState()).toMatchObject({ conversationOn: false, conversationState: 'off' });
    expect(h.created.some((kind) => kind === 'openai-live' || kind === 'openai-realtime')).toBe(false);

    // the settings screen re-applies the same stored choice: still the AI-off voice
    await h.coach.applySettings();
    expect(h.store.getState().voiceKind).toBe(AI_OFF_KIND);
  });

  it('setAskSuppressed hides «Спроси» while the quiz card is open; a game that leaves clears it', async () => {
    const h = setup();
    await h.coach.init();
    h.coach.setToolHost({ getHint: vi.fn(), explainLastMove: vi.fn() } as unknown as CoachToolHost);
    expect(h.store.getState().askSuppressed).toBe(false);
    h.coach.setAskSuppressed(true);
    expect(h.store.getState().askSuppressed).toBe(true);
    h.coach.setAskSuppressed(false);
    expect(h.store.getState().askSuppressed).toBe(false);
    h.coach.setAskSuppressed(true);
    h.coach.setToolHost(null);
    expect(h.store.getState().askSuppressed).toBe(false);
  });
});
