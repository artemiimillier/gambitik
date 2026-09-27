/**
 * Chess clock for the live game (ARCHITECTURE §5, research 07 §4.4-B).
 *
 *  - Drift-free: remaining time is always derived from `now()` timestamps, never from counting ticks.
 *  - Reason-counted pause: the clock stands still while ANY reason is active ('coach' — the mascot speaks with
 *    `pauseClock`, 'modal' — a decision dialog is open). `pause('coach')` twice needs `resume('coach')` twice.
 *  - One side only (`holdFor(color)` — the CHILD's clock must not run while Гамбитик speaks):
 *    that side's clock stands whenever it is its turn; the other side's clock and `whenRunning()` during the other
 *    side's turn are not affected (the bot neither waits for the words nor gets extra time).
 *  - Safety: 'coach' pauses and one-side holds end by themselves after 25 s (a voice layer that never reports
 *    "finished" must not freeze the game). 'modal' pauses have no timeout — a dialog is closed by the child.
 *  - Flag fall: `onFlag(color)` fires once, the clock stops.
 *  - Untimed games (`initialMs: null`) keep the pause bookkeeping (the bot waits while the coach speaks) but have
 *    no times and never flag.
 */
import type { Color } from '@gambit/shared';

export type PauseReason = 'coach' | 'modal';

export interface ClockSnapshot {
  /** remaining ms; null = untimed */
  w: number | null;
  b: number | null;
  /** side whose clock is ticking (or would tick if not paused); null before start / after stop */
  running: Color | null;
  /** the clock of the side to move stands (a pause reason, or a hold of that side) */
  paused: boolean;
  flagged: Color | null;
}

export interface GameClockOptions {
  /** null = no clock */
  initialMs: number | null;
  incrementMs?: number;
  /** monotonic milliseconds; default performance.now */
  now?: () => number;
  onFlag?: (color: Color) => void;
  /** called on every structural change and every `tickMs` while a clock is ticking */
  onChange?: (snapshot: ClockSnapshot) => void;
  /** UI refresh rate while ticking. Default 100 ms. */
  tickMs?: number;
  /** 'coach' pauses and one-side holds are force-released after this long. Default 25 000 ms. */
  coachAutoResumeMs?: number;
}

export interface GameClock {
  readonly timed: boolean;
  /** Starts `color`'s clock (first move of the game). */
  start(color: Color): void;
  /** The side that was running has moved: commit its time, add the increment, start `color`. */
  switchTo(color: Color, opts?: { increment?: boolean }): void;
  pause(reason: PauseReason): void;
  resume(reason: PauseReason): void;
  /**
   * `pause(reason)` that hands back its own idempotent release function. A release that arrives after the
   * 25 s safety already freed the 'coach' pauses does nothing (it cannot eat a newer pause).
   */
  hold(reason: PauseReason): () => void;
  /**
   * Stops `color`'s clock whenever it is `color`'s turn, until the returned (idempotent) release is called or the 25 s
   * safety frees it. The other side's clock is untouched.
   */
  holdFor(color: Color): () => void;
  /** The clock of the side to move stands (before the start: a pause reason is active). */
  isPaused(): boolean;
  /** Resolves as soon as the clock of the side to move is not paused (immediately when not; also on stop/dispose). */
  whenRunning(): Promise<void>;
  remaining(color: Color): number | null;
  /** Overwrites one side's time (take-back restores the value before the move). */
  set(color: Color, ms: number): void;
  /** Game over: freezes both times. */
  stop(): void;
  snapshot(): ClockSnapshot;
  dispose(): void;
}

export const COACH_AUTO_RESUME_MS = 25_000;
const DEFAULT_TICK_MS = 100;

function defaultNow(): number {
  return performance.now();
}

export function createGameClock(options: GameClockOptions): GameClock {
  const now = options.now ?? defaultNow;
  const timed = options.initialMs !== null;
  const incrementMs = options.incrementMs ?? 0;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const coachAutoResumeMs = options.coachAutoResumeMs ?? COACH_AUTO_RESUME_MS;

  const base: Record<Color, number> = { w: options.initialMs ?? 0, b: options.initialMs ?? 0 };
  const pauses: Record<PauseReason, number> = { coach: 0, modal: 0 };
  /** active one-side holds per colour */
  const sideHolds: Record<Color, number> = { w: 0, b: 0 };
  /** safety timers of the one-side holds */
  const sideTimers = new Set<ReturnType<typeof setTimeout>>();
  let running: Color | null = null;
  /** timestamp since which `running` has been ticking; null while paused / stopped */
  let tickingSince: number | null = null;
  let flagged: Color | null = null;
  let stopped = false;
  let disposed = false;

  let flagTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let coachTimer: ReturnType<typeof setTimeout> | null = null;
  /** bumped whenever the safety timer force-releases the 'coach' pauses */
  let coachGeneration = 0;
  let waiters: (() => void)[] = [];

  const isPaused = (): boolean => pauses.coach > 0 || pauses.modal > 0 || (running !== null && sideHolds[running] > 0);

  function remaining(color: Color): number | null {
    if (!timed) return null;
    const elapsed = running === color && tickingSince !== null ? now() - tickingSince : 0;
    return Math.max(0, base[color] - elapsed);
  }

  function snapshot(): ClockSnapshot {
    return { w: remaining('w'), b: remaining('b'), running, paused: isPaused(), flagged };
  }

  function emit(): void {
    if (!disposed) options.onChange?.(snapshot());
  }

  function clearTimers(): void {
    if (flagTimer !== null) clearTimeout(flagTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    flagTimer = null;
    tickTimer = null;
  }

  function releaseWaiters(): void {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  }

  function fall(color: Color): void {
    if (flagged !== null || stopped) return;
    base[color] = 0;
    flagged = color;
    tickingSince = null;
    stopped = true;
    clearTimers();
    releaseWaiters();
    emit();
    options.onFlag?.(color);
  }

  /** Moves the elapsed time of the ticking side into `base`. Returns false when that side's flag fell. */
  function commit(): boolean {
    if (running === null || tickingSince === null) return true;
    const at = now();
    base[running] -= at - tickingSince;
    tickingSince = at;
    if (timed && base[running] <= 0) {
      fall(running);
      return false;
    }
    return true;
  }

  function checkFlag(): void {
    flagTimer = null;
    if (running === null || tickingSince === null || stopped) return;
    const left = remaining(running);
    if (left !== null && left <= 0) fall(running);
    else arm();
  }

  /** (Re)starts the flag timer and the UI tick for the current state. */
  function arm(): void {
    clearTimers();
    if (!timed || stopped || disposed || running === null || tickingSince === null) return;
    const left = remaining(running) ?? 0;
    flagTimer = setTimeout(checkFlag, Math.max(1, Math.ceil(left) + 1));
    tickTimer = setInterval(emit, tickMs);
  }

  function beginTicking(): void {
    if (stopped || running === null || isPaused()) {
      tickingSince = null;
      clearTimers();
      return;
    }
    tickingSince = now();
    arm();
  }

  function clearCoachTimer(): void {
    if (coachTimer !== null) clearTimeout(coachTimer);
    coachTimer = null;
  }

  function clearSideTimers(): void {
    for (const timer of sideTimers) clearTimeout(timer);
    sideTimers.clear();
  }

  function afterPauseChange(wasPaused: boolean): void {
    const paused = isPaused();
    if (paused && !wasPaused) {
      if (commit()) {
        tickingSince = null;
        clearTimers();
      }
    } else if (!paused && wasPaused) {
      beginTicking();
      releaseWaiters();
    }
    emit();
  }

  const api: GameClock = {
    timed,

    start(color: Color): void {
      if (stopped || disposed) return;
      running = color;
      beginTicking();
      // (a one-side hold of the other colour does not keep anybody waiting)
      if (!isPaused()) releaseWaiters();
      emit();
    },

    switchTo(color: Color, opts?: { increment?: boolean }): void {
      if (stopped || disposed) return;
      if (running !== null && running !== color) {
        if (!commit()) return;
        if (timed && (opts?.increment ?? true)) base[running] += incrementMs;
      }
      running = color;
      beginTicking();
      if (!isPaused()) releaseWaiters();
      emit();
    },

    pause(reason: PauseReason): void {
      if (disposed) return;
      const wasPaused = isPaused();
      pauses[reason] += 1;
      if (reason === 'coach') {
        clearCoachTimer();
        coachTimer = setTimeout(() => {
          coachTimer = null;
          if (pauses.coach === 0) return;
          const before = isPaused();
          pauses.coach = 0;
          coachGeneration += 1;
          afterPauseChange(before);
        }, coachAutoResumeMs);
      }
      afterPauseChange(wasPaused);
    },

    resume(reason: PauseReason): void {
      if (disposed || pauses[reason] === 0) return;
      const wasPaused = isPaused();
      pauses[reason] -= 1;
      if (reason === 'coach' && pauses.coach === 0) clearCoachTimer();
      afterPauseChange(wasPaused);
    },

    hold(reason: PauseReason): () => void {
      const generation = coachGeneration;
      api.pause(reason);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (reason === 'coach' && generation !== coachGeneration) return;
        api.resume(reason);
      };
    },

    holdFor(color: Color): () => void {
      if (disposed) return () => undefined;
      const wasPaused = isPaused();
      sideHolds[color] += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        sideTimers.delete(timer);
        if (disposed) return;
        const before = isPaused();
        sideHolds[color] = Math.max(0, sideHolds[color] - 1);
        afterPauseChange(before);
      };
      const timer = setTimeout(release, coachAutoResumeMs);
      sideTimers.add(timer);
      afterPauseChange(wasPaused);
      return release;
    },

    isPaused,

    whenRunning(): Promise<void> {
      if (!isPaused() || stopped || disposed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },

    remaining,

    set(color: Color, ms: number): void {
      if (!timed || stopped || disposed) return;
      if (running === color && tickingSince !== null) tickingSince = now();
      base[color] = Math.max(0, ms);
      if (running === color) arm();
      emit();
    },

    stop(): void {
      if (stopped) return;
      if (flagged === null) commit();
      if (stopped) return; // the final commit made the flag fall
      stopped = true;
      tickingSince = null;
      running = null;
      clearTimers();
      clearCoachTimer();
      clearSideTimers();
      releaseWaiters();
      emit();
    },

    snapshot,

    dispose(): void {
      if (disposed) return;
      clearTimers();
      clearCoachTimer();
      clearSideTimers();
      stopped = true;
      tickingSince = null;
      releaseWaiters();
      disposed = true;
    },
  };
  return api;
}

/** `4:59`, `0:09.4` under ten seconds, `1:02:03` beyond an hour. */
export function formatClock(ms: number | null): string {
  if (ms === null) return '';
  const clamped = Math.max(0, ms);
  if (clamped < 10_000) {
    const tenths = Math.floor(clamped / 100);
    return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  // a clock face never shows more than what is left: round down to whole seconds
  const total = Math.floor(clamped / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
