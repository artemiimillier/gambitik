import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTtsVoice, pickRussianVoice, scoreRussianVoice } from './browserTtsVoice.ts';
import type { RankableVoice } from './browserTtsVoice.ts';

// ───────────────────────── a tiny fake of window.speechSynthesis ─────────────────────────

interface FakeUtterance {
  text: string;
  lang: string;
  voice: unknown;
  rate: number;
  pitch: number;
  volume: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onboundary: (() => void) | null;
}

function makeUtterance(text: string): FakeUtterance {
  return { text, lang: '', voice: null, rate: 1, pitch: 1, volume: 1, onstart: null, onend: null, onerror: null, onboundary: null };
}

interface FakeSynth {
  speaking: boolean;
  pending: boolean;
  paused: boolean;
  voices: RankableVoice[];
  queue: FakeUtterance[];
  cancelCalls: number;
  /** when set, speak() immediately fails with this error (autoplay policy) */
  failWith: string | null;
  getVoices(): RankableVoice[];
  speak(utterance: FakeUtterance): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  /** test helpers */
  startNext(): FakeUtterance | undefined;
  endCurrent(): void;
  fireVoicesChanged(): void;
}

function createFakeSynth(voices: RankableVoice[]): FakeSynth {
  const listeners = new Set<() => void>();
  let current: FakeUtterance | null = null;
  const synth: FakeSynth = {
    speaking: false,
    pending: false,
    paused: false,
    voices,
    queue: [],
    cancelCalls: 0,
    failWith: null,
    getVoices: () => synth.voices,
    speak(utterance) {
      if (synth.failWith) {
        const error = synth.failWith;
        queueMicrotask(() => utterance.onerror?.({ error }));
        return;
      }
      synth.queue.push(utterance);
      synth.pending = true;
    },
    cancel() {
      synth.cancelCalls++;
      const dropped = current;
      current = null;
      synth.queue = [];
      synth.speaking = false;
      synth.pending = false;
      dropped?.onerror?.({ error: 'interrupted' });
    },
    pause: () => undefined,
    resume: () => undefined,
    addEventListener: (_type, cb) => listeners.add(cb),
    removeEventListener: (_type, cb) => listeners.delete(cb),
    startNext() {
      const next = synth.queue.shift();
      if (!next) return undefined;
      current = next;
      synth.speaking = true;
      synth.pending = synth.queue.length > 0;
      next.onstart?.();
      return next;
    },
    endCurrent() {
      const ending = current;
      current = null;
      synth.speaking = false;
      ending?.onend?.();
    },
    fireVoicesChanged() {
      for (const cb of [...listeners]) cb();
    },
  };
  return synth;
}

const MILENA: RankableVoice = { name: 'Milena', lang: 'ru-RU', localService: true };
const MILENA_ENHANCED: RankableVoice = { name: 'Milena (Enhanced)', lang: 'ru-RU', localService: true };
const YURI_PREMIUM: RankableVoice = { name: 'Yuri (Premium)', lang: 'ru-RU', localService: true };
const GOOGLE_RU: RankableVoice = { name: 'Google русский', lang: 'ru-RU', localService: false };
const SAMANTHA: RankableVoice = { name: 'Samantha (Premium)', lang: 'en-US', localService: true };

function createVoice(synth: FakeSynth, activated = true) {
  return createBrowserTtsVoice({
    synth: synth as unknown as SpeechSynthesis,
    createUtterance: (text) => makeUtterance(text) as unknown as SpeechSynthesisUtterance,
    hasUserActivation: () => activated,
  });
}

const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

describe('Russian voice ranking', () => {
  it('prefers Premium > Enhanced > Google network > compact local, never a foreign voice', () => {
    expect(pickRussianVoice([SAMANTHA, MILENA, GOOGLE_RU, MILENA_ENHANCED, YURI_PREMIUM])).toBe(YURI_PREMIUM);
    expect(pickRussianVoice([SAMANTHA, MILENA, GOOGLE_RU, MILENA_ENHANCED])).toBe(MILENA_ENHANCED);
    expect(pickRussianVoice([SAMANTHA, MILENA, GOOGLE_RU])).toBe(GOOGLE_RU);
    expect(pickRussianVoice([SAMANTHA, MILENA])).toBe(MILENA);
    expect(pickRussianVoice([SAMANTHA])).toBeNull();
    expect(pickRussianVoice([])).toBeNull();
  });

  it('understands underscore locales and Russian labels', () => {
    expect(scoreRussianVoice({ name: 'Милена (улучшенный)', lang: 'ru_RU', localService: true })).toBeGreaterThan(scoreRussianVoice(MILENA));
    expect(scoreRussianVoice(SAMANTHA)).toBe(-1);
  });
});

describe('browser TTS voice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('init clears a stuck queue and picks the best Russian voice', async () => {
    const synth = createFakeSynth([SAMANTHA, MILENA, MILENA_ENHANCED]);
    const voice = createVoice(synth);
    await voice.init();
    expect(synth.cancelCalls).toBe(1);
    expect(voice.kind).toBe('browser-tts');
    expect(voice.voiceName).toBe('Milena (Enhanced)');
  });

  it('waits for Chrome’s late voiceschanged and re-picks when better voices arrive', async () => {
    const synth = createFakeSynth([]);
    const voice = createVoice(synth);
    const ready = voice.init();
    await flush();
    synth.voices = [MILENA];
    synth.fireVoicesChanged();
    await ready;
    expect(voice.voiceName).toBe('Milena');
    synth.voices = [MILENA, YURI_PREMIUM];
    synth.fireVoicesChanged();
    expect(voice.voiceName).toBe('Yuri (Premium)');
  });

  it('does not hang when no voices ever load', async () => {
    const synth = createFakeSynth([]);
    const voice = createVoice(synth);
    const ready = voice.init();
    await vi.advanceTimersByTimeAsync(1600);
    await ready;
    expect(voice.voiceName).toBeNull();
  });

  it('rejects init when speech synthesis does not exist', async () => {
    await expect(createBrowserTtsVoice().init()).rejects.toThrow(/speechSynthesis/);
  });

  it('speaks sentence by sentence with a young voice and reports speaking + mouth level', async () => {
    const synth = createFakeSynth([MILENA]);
    const voice = createVoice(synth);
    await voice.init();
    const speaking: boolean[] = [];
    const levels: number[] = [];
    voice.onSpeakingChange((v) => speaking.push(v));
    voice.onLevel((v) => levels.push(v));

    let finished = false;
    void voice.speak('Стоп-стоп! Давай подумаем ещё разок?').then(() => (finished = true));
    await flush();

    expect(synth.queue).toHaveLength(1); // the second sentence is queued only after the first ended
    const first = synth.startNext();
    expect(first).toMatchObject({ text: 'Стоп-стоп!', lang: 'ru-RU', voice: MILENA, rate: 1.02, pitch: 1.25 });
    expect(speaking).toEqual([true]);

    await vi.advanceTimersByTimeAsync(400);
    first?.onboundary?.();
    await vi.advanceTimersByTimeAsync(200);
    expect(Math.max(...levels)).toBeGreaterThan(0.1);
    for (const level of levels) expect(level).toBeGreaterThanOrEqual(0);

    synth.endCurrent();
    await flush();
    expect(synth.startNext()?.text).toBe('Давай подумаем ещё разок?');
    expect(finished).toBe(false);
    synth.endCurrent();
    await flush();
    expect(finished).toBe(true);
    expect(speaking).toEqual([true, false]);
    expect(levels.at(-1)).toBe(0);
  });

  it('stop() cancels the synthesis and resolves the pending speak', async () => {
    const synth = createFakeSynth([MILENA]);
    const voice = createVoice(synth);
    await voice.init();
    const spoken = voice.speak('Первое. Второе. Третье.');
    await flush();
    synth.startNext();
    voice.stop();
    await spoken;
    expect(synth.cancelCalls).toBe(2); // init + stop
    expect(synth.queue).toEqual([]);
  });

  it('interrupt replaces the current phrase; without interrupt phrases wait their turn', async () => {
    const synth = createFakeSynth([MILENA]);
    const voice = createVoice(synth);
    await voice.init();

    const first = voice.speak('Первая фраза.');
    await flush();
    synth.startNext();
    const polite = voice.speak('Вежливая.');
    await flush();
    expect(synth.queue).toEqual([]); // still waiting for the first one

    const urgent = voice.speak('Срочная!', { interrupt: true });
    await first;
    await vi.advanceTimersByTimeAsync(100); // Chrome needs a breath after cancel()
    expect(synth.startNext()?.text).toBe('Срочная!');
    synth.endCurrent();
    await urgent;
    await flush();
    expect(synth.startNext()?.text).toBe('Вежливая.');
    synth.endCurrent();
    await polite;
  });

  it('a watchdog rescues an utterance that never ends (Chrome 15-second bug)', async () => {
    const synth = createFakeSynth([MILENA]);
    const voice = createVoice(synth);
    await voice.init();
    let finished = false;
    void voice.speak('Короткая фраза.').then(() => (finished = true));
    await flush();
    synth.startNext();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(finished).toBe(true);
    expect(synth.cancelCalls).toBe(2);
  });

  describe('user gesture', () => {
    it('needs a gesture until the page was activated; unlock() warms the engine up', async () => {
      const synth = createFakeSynth([MILENA]);
      const voice = createVoice(synth, false);
      await voice.init();
      const changes: boolean[] = [];
      voice.onNeedsUserGestureChange((v) => changes.push(v));
      expect(voice.needsUserGesture).toBe(true);

      voice.unlock();
      expect(voice.needsUserGesture).toBe(false);
      expect(changes).toEqual([false]);
      expect(synth.queue.map((u) => [u.text, u.volume])).toEqual([[' ', 0]]);
    });

    it('is unlocked from the start when the page already had a click', async () => {
      const voice = createVoice(createFakeSynth([MILENA]), true);
      await voice.init();
      expect(voice.needsUserGesture).toBe(false);
    });

    it('a not-allowed error locks again and resolves instead of hanging', async () => {
      const synth = createFakeSynth([MILENA]);
      const voice = createVoice(synth, true);
      await voice.init();
      synth.failWith = 'not-allowed';
      await voice.speak('Привет! Как дела?');
      expect(voice.needsUserGesture).toBe(true);
    });
  });

  it('dispose() stops everything and later calls are harmless', async () => {
    const synth = createFakeSynth([MILENA]);
    const voice = createVoice(synth);
    await voice.init();
    const spoken = voice.speak('Пока!');
    await flush();
    voice.dispose();
    await spoken;
    await voice.speak('после dispose');
    expect(synth.queue).toEqual([]);
  });
});
