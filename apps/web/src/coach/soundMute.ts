/**
 * «Звук вкл / выкл» (docs/TEACHING.md §0.7, §4.4): ONE sound switch for the child — Гамбитик's voice AND the move and
 * button sounds together.
 *
 *   - The child's «Звук выкл» lasts until local midnight (`gambit.sound.mutedUntil` = epoch ms): the next day the game
 *     speaks again by itself, so a muted afternoon is not a silent week. «Звук вкл» brings both back at once and
 *     unlocks the audio inside the same click (`coach.unlockAudio()`).
 *   - The parent's «Всегда без звука» (Settings, behind the parental lock; `gambit.sound.alwaysMuted`) wins: the
 *     child's button cannot switch the sound on then.
 *   - `reconcile()` at start-up (the dock calls it), at midnight and whenever the page may have slept (visible again,
 *     shown, focused — `listenPageWake`): an expired child's mute lifts, the parent's permanent one is re-applied. A
 *     browser timer stands still while the Mac sleeps, so the midnight timer is never one long wait: it re-checks the wall
 *     clock at least every `WALL_CLOCK_CHECK_MS`.
 *
 * The coach voice (`coach.setMuted`, persisted as gambit.settings.muted) and the sound effects (ui/sounds
 * `setSoundMuted`, gambit.sfx.muted) keep their own flags; this module only drives both. Every storage access is
 * guarded: without localStorage the switch simply lasts for this page.
 */
import { useSyncExternalStore } from 'react';
import { isSoundMuted, onSoundMutedChange, setSoundMuted } from '../ui/sounds.ts';
import { coach as appCoach } from './coachController.ts';
import { useCoachStore } from './coachStore.ts';
import { getBrowserStorage } from './settings.ts';
import type { SettingsStorage } from './settings.ts';

export const SOUND_MUTED_UNTIL_KEY = 'gambit.sound.mutedUntil';
export const SOUND_ALWAYS_MUTED_KEY = 'gambit.sound.alwaysMuted';
/** While the child's mute runs, the wall clock is looked at least this often (a sleeping laptop pauses every timer). */
export const WALL_CLOCK_CHECK_MS = 60_000;

export type Unsubscribe = () => void;

/** One of the two sounds the switch drives. */
export interface SoundChannel {
  isMuted(): boolean;
  setMuted(muted: boolean): void;
  onChange(cb: (muted: boolean) => void): Unsubscribe;
}

export interface SoundMuteDeps {
  /** Гамбитик's voice (the coach controller + its store) */
  voice: SoundChannel;
  /** move / button sounds (ui/sounds) */
  sfx: SoundChannel;
  /** called inside the click that switches the sound on (the browser's audio unlock) */
  unlockAudio: () => void;
  storage: () => (SettingsStorage & { removeItem?: (key: string) => void }) | null;
  now?: () => number;
  /**
   * calls `onWake` when the page may have slept (visible again, shown, focused) and returns the uninstaller; the app
   * passes `listenPageWake`. Default: none (tests drive `reconcile()` and the timer themselves).
   */
  listenWake?: (onWake: () => void) => Unsubscribe;
}

export interface SoundState {
  /** Гамбитик's voice is off */
  voiceMuted: boolean;
  /** the move / button sounds are off */
  sfxMuted: boolean;
  /** everything is silent: what the big button shows as «Звук выкл» */
  muted: boolean;
  /** the parent's «Всегда без звука»: the child cannot switch the sound on */
  always: boolean;
  /** the child's mute lasts until this epoch ms (local midnight); null = none */
  until: number | null;
}

export interface SoundMute {
  /** a stable snapshot (the same object until something changes) — for useSyncExternalStore */
  state(): SoundState;
  subscribe(cb: () => void): Unsubscribe;
  /** the child's «Звук выкл»: voice + sounds off until local midnight (a no-op under the parent's permanent mute) */
  muteUntilMidnight(): void;
  /** the child's «Звук вкл» (call inside the click): both on, audio unlocked; false = the parent's «Всегда без звука» wins */
  unmute(): boolean;
  /** the button: silent → on; otherwise → off until midnight */
  toggle(): void;
  /** the parent's «Всегда без звука» (Settings) */
  setAlwaysMuted(on: boolean): void;
  /** start-up / midnight / the page woke up: lift an expired child's mute, re-apply the parent's permanent one */
  reconcile(): void;
  dispose(): void;
}

/** epoch ms of the next local midnight after `ms` */
export function nextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function readItem(deps: SoundMuteDeps, key: string): string | null {
  try {
    return deps.storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeItem(deps: SoundMuteDeps, key: string, value: string | null): void {
  try {
    const storage = deps.storage();
    if (!storage) return;
    if (value !== null) storage.setItem(key, value);
    else if (typeof storage.removeItem === 'function') storage.removeItem(key);
    else storage.setItem(key, '');
  } catch {
    /* private mode / quota: the switch lasts for this page only */
  }
}

export function createSoundMute(deps: SoundMuteDeps): SoundMute {
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let snapshot: SoundState | null = null;
  let midnightTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const readAlways = (): boolean => readItem(deps, SOUND_ALWAYS_MUTED_KEY) === '1';
  const readUntil = (): number | null => {
    const raw = readItem(deps, SOUND_MUTED_UNTIL_KEY);
    const value = raw === null || raw === '' ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  function compute(): SoundState {
    const voiceMuted = deps.voice.isMuted();
    const sfxMuted = deps.sfx.isMuted();
    const until = readUntil();
    return { voiceMuted, sfxMuted, muted: voiceMuted && sfxMuted, always: readAlways(), until: until !== null && until > now() ? until : null };
  }

  function changed(): void {
    const next = compute();
    const before = snapshot;
    if (before && before.voiceMuted === next.voiceMuted && before.sfxMuted === next.sfxMuted && before.always === next.always && before.until === next.until) return;
    snapshot = next;
    for (const cb of [...listeners]) cb();
  }

  const unsubs: Unsubscribe[] = [deps.voice.onChange(changed), deps.sfx.onChange(changed)];

  function clearTimer(): void {
    if (midnightTimer !== null) clearTimeout(midnightTimer);
    midnightTimer = null;
  }

  function armTimer(until: number): void {
    clearTimer();
    if (disposed) return;
    // + 1 s: a timer that fires a hair early must not find the mute still valid. Never one long wait: a timer stands
    // still while the laptop sleeps (the lid shut at 20:00 with 4 h to go would lift the mute at noon) — each step
    // looks at the wall clock again (reconcile re-arms it while the mute runs)
    midnightTimer = setTimeout(
      () => {
        midnightTimer = null;
        reconcile();
      },
      Math.min(Math.max(0, until - now()) + 1000, WALL_CLOCK_CHECK_MS),
    );
  }

  function setBoth(muted: boolean): void {
    if (deps.voice.isMuted() !== muted) deps.voice.setMuted(muted);
    if (deps.sfx.isMuted() !== muted) deps.sfx.setMuted(muted);
  }

  function muteUntilMidnight(): void {
    if (disposed) return;
    if (!readAlways()) {
      const until = nextLocalMidnight(now());
      writeItem(deps, SOUND_MUTED_UNTIL_KEY, String(until));
      armTimer(until);
    }
    setBoth(true);
    changed();
  }

  function unmute(): boolean {
    if (disposed || readAlways()) {
      changed();
      return false;
    }
    clearTimer();
    writeItem(deps, SOUND_MUTED_UNTIL_KEY, null);
    setBoth(false);
    // the click that switched the sound on is the gesture the browser wants for audio
    deps.unlockAudio();
    changed();
    return true;
  }

  function reconcile(): void {
    if (disposed) return;
    if (readAlways()) {
      clearTimer();
      writeItem(deps, SOUND_MUTED_UNTIL_KEY, null);
      setBoth(true);
    } else {
      const until = readUntil();
      if (until !== null && until <= now()) {
        // the child's mute of yesterday is over: Гамбитик speaks again
        writeItem(deps, SOUND_MUTED_UNTIL_KEY, null);
        clearTimer();
        setBoth(false);
      } else if (until !== null) {
        armTimer(until);
      }
    }
    changed();
  }

  // the page woke up (the laptop slept with the game open): yesterday's mute must not wait for a paused timer
  try {
    const unlisten = deps.listenWake?.(() => reconcile());
    if (unlisten) unsubs.push(unlisten);
  } catch {
    /* no page events: the stepping timer still lifts it */
  }

  return {
    state() {
      snapshot ??= compute();
      return snapshot;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    muteUntilMidnight,
    unmute,
    toggle() {
      if (compute().muted) unmute();
      else muteUntilMidnight();
    },
    setAlwaysMuted(on) {
      if (disposed) return;
      writeItem(deps, SOUND_ALWAYS_MUTED_KEY, on ? '1' : null);
      clearTimer();
      writeItem(deps, SOUND_MUTED_UNTIL_KEY, null);
      setBoth(on);
      changed();
    },
    reconcile,
    dispose() {
      disposed = true;
      clearTimer();
      for (const unsub of unsubs.splice(0)) unsub();
      listeners.clear();
    },
  };
}

// ───────────────────────── the app's switch ─────────────────────────

/**
 * The browser's «the page may have slept» moments: visible again (`visibilitychange`), shown from the back-forward cache
 * (`pageshow`), focused. No document / window (tests, SSR): nothing to listen to.
 */
export function listenPageWake(onWake: () => void): Unsubscribe {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined;
  const onVisible = (): void => {
    if (document.visibilityState !== 'hidden') onWake();
  };
  const onShow = (): void => onWake();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onShow);
  window.addEventListener('focus', onShow);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pageshow', onShow);
    window.removeEventListener('focus', onShow);
  };
}

let appSoundMute: SoundMute | null = null;

/** The app's one switch (the coach singleton + ui/sounds), created on first use — never at import. */
export function getAppSoundMute(): SoundMute {
  appSoundMute ??= createSoundMute({
    voice: {
      isMuted: () => useCoachStore.getState().muted,
      setMuted: (muted) => appCoach.setMuted(muted),
      onChange(cb) {
        return useCoachStore.subscribe((state, previous) => {
          if (state.muted !== previous.muted) cb(state.muted);
        });
      },
    },
    sfx: { isMuted: isSoundMuted, setMuted: setSoundMuted, onChange: onSoundMutedChange },
    unlockAudio: () => appCoach.unlockAudio(),
    storage: getBrowserStorage,
    listenWake: listenPageWake,
  });
  return appSoundMute;
}

const OFF_STATE: SoundState = { voiceMuted: false, sfxMuted: false, muted: false, always: false, until: null };
const noSubscribe = (): Unsubscribe => () => undefined;

/** React: the switch's state (null control = never muted, for tests / the playground). */
export function useSoundState(control: SoundMute | null): SoundState {
  return useSyncExternalStore(
    control ? control.subscribe : noSubscribe,
    control ? control.state : () => OFF_STATE,
    control ? control.state : () => OFF_STATE,
  );
}
