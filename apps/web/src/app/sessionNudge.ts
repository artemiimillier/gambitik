/**
 * «Пора отдохнуть» — a soft, never blocking break suggestion after ~35 minutes of real activity
 * (research 08: sessions of 15–30 min). Pure bookkeeping; the shell feeds it the clock and
 * the activity and lets Гамбитик say the line once — outside a running game.
 *
 * Only ACTIVE time counts: minutes with no click, key press or screen change for a while (the child walked
 * away, the laptop slept) are not counted, and a long gap between ticks is never added as one block.
 */
import { MASCOT } from '@gambit/content';

export const BREAK_AFTER_ACTIVE_MS = 35 * 60_000;
/** no activity for this long → the clock of the session stands still */
export const IDLE_CUTOFF_MS = 3 * 60_000;
/** a tick never adds more than this (timer throttling, sleep) */
export const MAX_TICK_MS = 60_000;
export const NUDGE_TICK_MS = 30_000;

export interface BreakNudge {
  noteActivity(now: number): void;
  /** Call regularly; returns the active time so far, ms. */
  tick(now: number): number;
  /** True when a break should be suggested now (35 active minutes since the start or since the last suggestion). */
  due(): boolean;
  /** The suggestion was made: the next one is due after another 35 active minutes. */
  markNudged(): void;
}

export function createBreakNudge(startedAt: number, thresholdMs: number = BREAK_AFTER_ACTIVE_MS): BreakNudge {
  let lastTick = startedAt;
  let lastActivity = startedAt;
  let activeMs = 0;
  let nudgedAtActiveMs = 0;
  return {
    noteActivity(now) {
      if (now > lastActivity) lastActivity = now;
    },
    tick(now) {
      const elapsed = now - lastTick;
      lastTick = now;
      if (elapsed > 0 && now - lastActivity <= IDLE_CUTOFF_MS) activeMs += Math.min(elapsed, MAX_TICK_MS);
      return activeMs;
    },
    due: () => activeMs - nudgedAtActiveMs >= thresholdMs,
    markNudged() {
      nudgedAtActiveMs = activeMs;
    },
  };
}

const FALLBACK_BREAK_LINES = ['Мы сегодня здорово потрудились. Может, перерыв?'] as const;

/** One of the mascot's own break lines (gender-neutral, no Latin) — with a fallback if the content has none. */
export function breakLine(rng: () => number = Math.random): string {
  const lines = MASCOT.phrases.break.filter((line) => line.trim() !== '');
  const pool = lines.length > 0 ? lines : FALLBACK_BREAK_LINES;
  return pool[Math.min(pool.length - 1, Math.floor(Math.max(0, rng()) * pool.length))] ?? FALLBACK_BREAK_LINES[0];
}
