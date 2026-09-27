/**
 * Was Гамбитик heard saying hello? (he waves and then talks when the game starts).
 *
 * The shell greets once per app start, but the wizard's remarks and its «stop speaking» taps often cut that hello off —
 * the child would never hear «Привет». The game therefore asks this watch before its first line and
 * greets itself when no hello was heard recently.
 *
 * «Heard» = the mascot WAVED and SPOKE (the coach store's `pose === 'wave'` while `speaking`) for at least
 * `HELLO_HEARD_MIN_MS` — every hello of the app waves (the shell's greeting, the game's start line, the onboarding); a
 * hello cut after a syllable does not count. The watch has to run from the app's start: NewGame.tsx (loaded with the
 * shell) arms it; `helloHeardRecently()` is false while nobody armed it — the game then simply says hello.
 */

/** The part of the coach store the watch reads (the app's `useCoachStore` satisfies it). */
export interface HelloWatchState {
  pose: string;
  speaking: boolean;
}

export interface HelloWatchStore {
  getState(): HelloWatchState;
  subscribe(listener: (state: HelloWatchState) => void): () => void;
}

/** A wave with words at least this long is a hello the child heard. */
export const HELLO_HEARD_MIN_MS = 1_500;
/** …and it is fresh this long: a game started later greets again. */
export const HELLO_FRESH_MS = 15 * 60_000;

export interface HelloWatch {
  /** A hello was heard less than `HELLO_FRESH_MS` ago (or is being heard right now, long enough). */
  heardRecently(): boolean;
  dispose(): void;
}

export function createHelloWatch(store: HelloWatchStore, now: () => number = () => Date.now()): HelloWatch {
  let waveSince: number | null = null;
  let heardAt: number | null = null;

  const observe = (state: HelloWatchState): void => {
    const waving = state.speaking && state.pose === 'wave';
    if (waving && waveSince === null) waveSince = now();
    else if (!waving && waveSince !== null) {
      if (now() - waveSince >= HELLO_HEARD_MIN_MS) heardAt = now();
      waveSince = null;
    }
  };

  const unsubscribe = store.subscribe(observe);
  observe(store.getState());

  return {
    heardRecently(): boolean {
      const at = now();
      // still waving and talking: long enough already counts
      if (waveSince !== null && at - waveSince >= HELLO_HEARD_MIN_MS) heardAt = at;
      return heardAt !== null && at - heardAt < HELLO_FRESH_MS;
    },
    dispose: unsubscribe,
  };
}

let shared: HelloWatch | null = null;

/** Arms the app-wide watch once (idempotent). */
export function watchHello(store: HelloWatchStore): void {
  shared ??= createHelloWatch(store);
}

/** The game's question: was a hello heard recently? False when the watch was never armed. */
export function helloHeardRecently(): boolean {
  return shared?.heardRecently() ?? false;
}
