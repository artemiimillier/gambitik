import { describe, expect, it } from 'vitest';
import { BREAK_AFTER_ACTIVE_MS, IDLE_CUTOFF_MS, NUDGE_TICK_MS, breakLine, createBreakNudge } from './sessionNudge.ts';

const MIN = 60_000;

/** Runs the 30-second ticker for `minutes`, with or without the child touching anything. */
function run(nudge: ReturnType<typeof createBreakNudge>, from: number, minutes: number, active: boolean): number {
  let now = from;
  for (let i = 0; i < (minutes * MIN) / NUDGE_TICK_MS; i++) {
    now += NUDGE_TICK_MS;
    if (active) nudge.noteActivity(now - 1000);
    nudge.tick(now);
  }
  return now;
}

describe('break nudge (a gentle «пора отдохнуть» after ~35 minutes)', () => {
  it('is due after 35 ACTIVE minutes, not before', () => {
    const nudge = createBreakNudge(0);
    const at34 = run(nudge, 0, 34, true);
    expect(nudge.due()).toBe(false);
    run(nudge, at34, 1, true);
    expect(nudge.due()).toBe(true);
  });

  it('does not count the time the child was away', () => {
    const nudge = createBreakNudge(0);
    let now = run(nudge, 0, 20, true);
    now = run(nudge, now, 120, false); // dinner
    expect(nudge.due()).toBe(false);
    // only the first idle minutes before the cut-off were still counted
    expect(nudge.tick(now)).toBeLessThanOrEqual(20 * MIN + IDLE_CUTOFF_MS + NUDGE_TICK_MS);
    now = run(nudge, now, 14, true);
    expect(nudge.due()).toBe(true);
  });

  it('a laptop that slept does not add the night as one block', () => {
    const nudge = createBreakNudge(0);
    nudge.noteActivity(8 * 3600_000 - 1000);
    expect(nudge.tick(8 * 3600_000)).toBeLessThanOrEqual(MIN);
    expect(nudge.due()).toBe(false);
  });

  it('after the suggestion the next one needs another 35 active minutes', () => {
    const nudge = createBreakNudge(0);
    let now = run(nudge, 0, 36, true);
    expect(nudge.due()).toBe(true);
    nudge.markNudged();
    expect(nudge.due()).toBe(false);
    now = run(nudge, now, 30, true);
    expect(nudge.due()).toBe(false);
    run(nudge, now, 6, true);
    expect(nudge.due()).toBe(true);
    expect(BREAK_AFTER_ACTIVE_MS).toBe(35 * MIN);
  });

  it('says one of the mascot\'s own break lines: Russian, kind, no Latin', () => {
    for (const r of [0, 0.5, 0.999, 1, -3]) {
      const line = breakLine(() => r);
      expect(line.length).toBeGreaterThan(10);
      expect(line).not.toMatch(/[A-Za-z]/);
      expect(line).toMatch(/отдохн|перерыв/);
    }
  });
});
