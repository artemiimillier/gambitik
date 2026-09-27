/**
 * «Звук вкл / выкл» (docs/TEACHING.md §0.7, §4.4): one switch for the voice and the move sounds; the child's mute
 * lasts until local midnight, the parent's «Всегда без звука» wins, «Звук вкл» unlocks audio inside the click.
 * Fake channels and storage, fake time — no sound, no browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOUND_ALWAYS_MUTED_KEY, SOUND_MUTED_UNTIL_KEY, WALL_CLOCK_CHECK_MS, createSoundMute, listenPageWake, nextLocalMidnight } from './soundMute.ts';
import type { SoundChannel, SoundMute } from './soundMute.ts';

interface FakeChannel extends SoundChannel {
  sets: boolean[];
}

function channel(initial = false): FakeChannel {
  let muted = initial;
  const listeners = new Set<(muted: boolean) => void>();
  const sets: boolean[] = [];
  return {
    sets,
    isMuted: () => muted,
    setMuted(value) {
      sets.push(value);
      if (muted === value) return;
      muted = value;
      for (const cb of [...listeners]) cb(value);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

interface Rig {
  sound: SoundMute;
  voice: FakeChannel;
  sfx: FakeChannel;
  storage: ReturnType<typeof memoryStorage>;
  unlocks: number;
  /** the page woke up (what `listenPageWake` reports); a no-op once the switch unlistened */
  wake: () => void;
  /** the wake listener is installed */
  listening: () => boolean;
}

function rig(opts: { voice?: boolean; sfx?: boolean; stored?: Record<string, string>; storage?: 'none' | 'throws' } = {}): Rig {
  const voice = channel(opts.voice ?? false);
  const sfx = channel(opts.sfx ?? false);
  const storage = memoryStorage(opts.stored);
  let onWake: (() => void) | null = null;
  const r: Rig = {
    voice,
    sfx,
    storage,
    unlocks: 0,
    sound: null as unknown as SoundMute,
    wake: () => onWake?.(),
    listening: () => onWake !== null,
  };
  r.sound = createSoundMute({
    voice,
    sfx,
    unlockAudio: () => {
      r.unlocks += 1;
    },
    storage: () => {
      if (opts.storage === 'none') return null;
      if (opts.storage === 'throws') throw new Error('SecurityError');
      return storage;
    },
    listenWake(cb) {
      onWake = cb;
      return () => {
        onWake = null;
      };
    },
  });
  return r;
}

// 2026-09-24 15:30 local time
const AFTERNOON = new Date(2026, 8, 24, 15, 30, 0).getTime();
const MIDNIGHT = new Date(2026, 8, 25, 0, 0, 0).getTime();

describe('soundMute — the one sound switch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(AFTERNOON);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('nextLocalMidnight: the start of the next local day', () => {
    expect(nextLocalMidnight(AFTERNOON)).toBe(MIDNIGHT);
    expect(nextLocalMidnight(new Date(2026, 8, 24, 0, 0, 0).getTime())).toBe(MIDNIGHT);
    expect(nextLocalMidnight(new Date(2026, 11, 31, 23, 59, 0).getTime())).toBe(new Date(2027, 0, 1).getTime());
  });

  it('«Звук выкл»: the voice AND the move sounds go off until local midnight; «Звук вкл» brings both back and unlocks audio in the click', () => {
    const r = rig();
    expect(r.sound.state()).toMatchObject({ muted: false, always: false, until: null });
    r.sound.muteUntilMidnight();
    expect(r.voice.isMuted()).toBe(true);
    expect(r.sfx.isMuted()).toBe(true);
    expect(r.storage.data.get(SOUND_MUTED_UNTIL_KEY)).toBe(String(MIDNIGHT));
    expect(r.sound.state()).toMatchObject({ voiceMuted: true, sfxMuted: true, muted: true, until: MIDNIGHT });
    expect(r.unlocks).toBe(0);

    expect(r.sound.unmute()).toBe(true);
    expect(r.voice.isMuted()).toBe(false);
    expect(r.sfx.isMuted()).toBe(false);
    expect(r.storage.data.has(SOUND_MUTED_UNTIL_KEY)).toBe(false);
    expect(r.sound.state()).toMatchObject({ muted: false, until: null });
    expect(r.unlocks).toBe(1);
  });

  it('toggle(): all silent → on; anything audible → off (a half-muted state is not «Звук выкл»)', () => {
    const r = rig({ sfx: true });
    expect(r.sound.state().muted).toBe(false);
    r.sound.toggle();
    expect(r.sound.state()).toMatchObject({ voiceMuted: true, sfxMuted: true, muted: true });
    r.sound.toggle();
    expect(r.sound.state()).toMatchObject({ voiceMuted: false, sfxMuted: false, muted: false });
    expect(r.unlocks).toBe(1);
  });

  it('the mute lifts by itself at midnight when the page stays open', async () => {
    const r = rig();
    r.sound.muteUntilMidnight();
    await vi.advanceTimersByTimeAsync(MIDNIGHT - AFTERNOON - 60_000);
    expect(r.sound.state().muted).toBe(true);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(r.voice.isMuted()).toBe(false);
    expect(r.sfx.isMuted()).toBe(false);
    expect(r.storage.data.has(SOUND_MUTED_UNTIL_KEY)).toBe(false);
  });

  it('reconcile() at start-up: yesterday\'s mute lifts; today\'s stays (and lifts at midnight); nothing stored = nothing touched', async () => {
    const yesterday = rig({ voice: true, sfx: true, stored: { [SOUND_MUTED_UNTIL_KEY]: String(AFTERNOON - 1000) } });
    yesterday.sound.reconcile();
    expect(yesterday.voice.isMuted()).toBe(false);
    expect(yesterday.sfx.isMuted()).toBe(false);
    expect(yesterday.storage.data.has(SOUND_MUTED_UNTIL_KEY)).toBe(false);

    const today = rig({ voice: true, sfx: true, stored: { [SOUND_MUTED_UNTIL_KEY]: String(MIDNIGHT) } });
    today.sound.reconcile();
    expect(today.sound.state()).toMatchObject({ muted: true, until: MIDNIGHT });
    await vi.advanceTimersByTimeAsync(MIDNIGHT - AFTERNOON + 2000);
    expect(today.sound.state().muted).toBe(false);

    // the parent switched the move sounds off in Settings, no child's mute stored: left alone
    const parent = rig({ sfx: true });
    parent.sound.reconcile();
    expect(parent.sfx.isMuted()).toBe(true);
    expect(parent.voice.sets).toEqual([]);
    expect(parent.sfx.sets).toEqual([]);
  });

  it('the parent\'s «Всегда без звука» wins: both off, the child\'s «Звук вкл» does nothing, no midnight lift; off again = both on', async () => {
    const r = rig();
    r.sound.setAlwaysMuted(true);
    expect(r.storage.data.get(SOUND_ALWAYS_MUTED_KEY)).toBe('1');
    expect(r.sound.state()).toMatchObject({ muted: true, always: true, until: null });
    expect(r.sound.unmute()).toBe(false);
    r.sound.toggle();
    expect(r.sound.state().muted).toBe(true);
    expect(r.unlocks).toBe(0);
    // the child's «Звук выкл» under it stores no midnight
    r.sound.muteUntilMidnight();
    expect(r.storage.data.has(SOUND_MUTED_UNTIL_KEY)).toBe(false);
    await vi.advanceTimersByTimeAsync(MIDNIGHT - AFTERNOON + 2000);
    expect(r.sound.state().muted).toBe(true);

    // something unmuted a channel behind the switch's back (an old tab): reconcile re-applies the parent's choice
    r.voice.setMuted(false);
    r.sound.reconcile();
    expect(r.voice.isMuted()).toBe(true);

    r.sound.setAlwaysMuted(false);
    expect(r.storage.data.has(SOUND_ALWAYS_MUTED_KEY)).toBe(false);
    expect(r.sound.state()).toMatchObject({ muted: false, always: false });
  });

  it('switching «Всегда без звука» on drops a child\'s mute of today (the parent\'s choice is the only one)', () => {
    const r = rig();
    r.sound.muteUntilMidnight();
    r.sound.setAlwaysMuted(true);
    expect(r.storage.data.has(SOUND_MUTED_UNTIL_KEY)).toBe(false);
    expect(r.sound.state()).toMatchObject({ always: true, until: null });
  });

  it('a stable snapshot for React: the same object until something changes; subscribers hear every change of either channel', () => {
    const r = rig();
    const first = r.sound.state();
    expect(r.sound.state()).toBe(first);
    const seen: boolean[] = [];
    const off = r.sound.subscribe(() => seen.push(r.sound.state().sfxMuted));
    r.sfx.setMuted(true); // e.g. Settings' «Звуки ходов и кнопок»
    expect(seen).toEqual([true]);
    expect(r.sound.state()).not.toBe(first);
    const second = r.sound.state();
    r.sfx.setMuted(true); // no change
    expect(r.sound.state()).toBe(second);
    off();
    r.sfx.setMuted(false);
    expect(seen).toEqual([true]);
  });

  it('no storage (private mode) or storage that throws: the switch still works for this page', () => {
    for (const storage of ['none', 'throws'] as const) {
      const r = rig({ storage });
      r.sound.muteUntilMidnight();
      expect(r.sound.state()).toMatchObject({ muted: true, until: null, always: false });
      expect(r.sound.unmute()).toBe(true);
      expect(r.sound.state().muted).toBe(false);
      r.sound.reconcile();
      expect(r.sound.state().muted).toBe(false);
    }
  });

  it('dispose(): no midnight timer, no listeners', async () => {
    const r = rig();
    r.sound.muteUntilMidnight();
    const seen: number[] = [];
    r.sound.subscribe(() => seen.push(1));
    expect(r.listening()).toBe(true);
    r.sound.dispose();
    expect(r.listening()).toBe(false);
    await vi.advanceTimersByTimeAsync(MIDNIGHT - AFTERNOON + 2000);
    expect(r.voice.isMuted()).toBe(true);
    r.sfx.setMuted(false);
    expect(seen).toEqual([]);
  });
});

// ───────────────────────── the laptop slept with the game open ─────────────────────────

describe('soundMute — the mute lifts after the laptop slept (a timer stands still while the Mac sleeps)', () => {
  // muted at 19:00; the lid shut at 20:00 (4 h left on a single timer), opened at 08:00 the next day
  const EVENING = new Date(2026, 8, 24, 19, 0, 0).getTime();
  const NEXT_MORNING = new Date(2026, 8, 25, 8, 0, 0).getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EVENING);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Sleep: the wall clock jumps, no timer runs meanwhile (the fake timers are not advanced). */
  function sleepUntil(ms: number): void {
    vi.setSystemTime(ms);
  }

  it('no page event at all: the timer re-checks the wall clock, so the mute lifts within a minute of waking — not at noon', async () => {
    const r = rig();
    r.sound.muteUntilMidnight();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(r.sound.state().muted).toBe(true);
    sleepUntil(NEXT_MORNING);
    await vi.advanceTimersByTimeAsync(WALL_CLOCK_CHECK_MS);
    expect(r.voice.isMuted()).toBe(false);
    expect(r.sfx.isMuted()).toBe(false);
    expect(r.storage.data.has(SOUND_MUTED_UNTIL_KEY)).toBe(false);
    expect(r.sound.state()).toMatchObject({ muted: false, until: null });
  });

  it('the page wakes up (visible / shown / focused): yesterday\'s mute lifts at once; today\'s stays', async () => {
    const r = rig();
    r.sound.muteUntilMidnight();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    // woken the same evening: still today's mute
    r.wake();
    expect(r.sound.state().muted).toBe(true);
    sleepUntil(NEXT_MORNING);
    r.wake();
    expect(r.voice.isMuted()).toBe(false);
    expect(r.sfx.isMuted()).toBe(false);
    expect(r.sound.state()).toMatchObject({ muted: false, until: null });
    // (the parent's «Всегда без звука» is re-applied on waking too, like at start-up)
    r.sound.setAlwaysMuted(true);
    r.voice.setMuted(false);
    r.wake();
    expect(r.voice.isMuted()).toBe(true);
  });

  it('listenPageWake: visibilitychange (visible only), pageshow and focus; unlisten removes all three; no document / window = a no-op', () => {
    // node: no DOM — nothing to listen to, nothing thrown
    const none: number[] = [];
    const offNone = listenPageWake(() => none.push(1));
    offNone();
    expect(none).toEqual([]);

    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    const win = new EventTarget();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    let wakes = 0;
    const off = listenPageWake(() => {
      wakes += 1;
    });
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(wakes).toBe(1);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(wakes).toBe(1);
    win.dispatchEvent(new Event('pageshow'));
    win.dispatchEvent(new Event('focus'));
    expect(wakes).toBe(3);
    off();
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('pageshow'));
    win.dispatchEvent(new Event('focus'));
    expect(wakes).toBe(3);
  });
});
