import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Color } from '@gambit/shared';
import { COACH_AUTO_RESUME_MS, createGameClock, formatClock } from './clock.ts';
import type { ClockSnapshot, GameClock } from './clock.ts';

/** Fake timers also fake Date, so Date.now is a monotonic clock the tests fully control. */
const now = (): number => Date.now();

function makeClock(initialMs: number | null, extra: { incrementMs?: number } = {}) {
  const flags: Color[] = [];
  const changes: ClockSnapshot[] = [];
  const clock: GameClock = createGameClock({
    initialMs,
    incrementMs: extra.incrementMs,
    now,
    onFlag: (color) => flags.push(color),
    onChange: (snapshot) => changes.push(snapshot),
  });
  return { clock, flags, changes };
}

describe('createGameClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not tick before start and ticks only the running side', () => {
    const { clock } = makeClock(60_000);
    vi.advanceTimersByTime(5_000);
    expect(clock.remaining('w')).toBe(60_000);

    clock.start('w');
    vi.advanceTimersByTime(1_500);
    expect(clock.remaining('w')).toBe(58_500);
    expect(clock.remaining('b')).toBe(60_000);
    clock.dispose();
  });

  it('is drift-free: the time comes from timestamps, not from the number of ticks', () => {
    const { clock } = makeClock(60_000);
    clock.start('w');
    // jump the system clock without running any timer callbacks
    vi.setSystemTime(Date.now() + 12_345);
    expect(clock.remaining('w')).toBe(60_000 - 12_345);
    clock.dispose();
  });

  it('switchTo commits the mover, adds the increment and starts the other side', () => {
    const { clock } = makeClock(60_000, { incrementMs: 2_000 });
    clock.start('w');
    vi.advanceTimersByTime(3_000);
    clock.switchTo('b');
    expect(clock.remaining('w')).toBe(59_000);
    vi.advanceTimersByTime(4_000);
    expect(clock.remaining('w')).toBe(59_000);
    expect(clock.remaining('b')).toBe(56_000);

    clock.switchTo('w', { increment: false });
    expect(clock.remaining('b')).toBe(56_000);
    expect(clock.snapshot().running).toBe('w');
    clock.dispose();
  });

  it('pauses are counted per reason', () => {
    const { clock } = makeClock(60_000);
    clock.start('w');
    vi.advanceTimersByTime(1_000);

    clock.pause('coach');
    clock.pause('coach');
    clock.pause('modal');
    vi.advanceTimersByTime(5_000);
    expect(clock.remaining('w')).toBe(59_000);
    expect(clock.isPaused()).toBe(true);

    clock.resume('coach');
    clock.resume('modal');
    vi.advanceTimersByTime(1_000);
    expect(clock.isPaused()).toBe(true);
    expect(clock.remaining('w')).toBe(59_000);

    clock.resume('coach');
    expect(clock.isPaused()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(clock.remaining('w')).toBe(57_000);
    clock.dispose();
  });

  it('ignores a resume without a matching pause', () => {
    const { clock } = makeClock(60_000);
    clock.start('w');
    clock.resume('coach');
    clock.pause('modal');
    clock.resume('coach');
    expect(clock.isPaused()).toBe(true);
    clock.dispose();
  });

  it("a 'coach' pause resumes by itself after 25 s, a 'modal' pause never does", () => {
    const { clock } = makeClock(300_000);
    clock.start('b');
    clock.pause('coach');
    clock.pause('coach');
    vi.advanceTimersByTime(COACH_AUTO_RESUME_MS - 1);
    expect(clock.isPaused()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(clock.isPaused()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(clock.remaining('b')).toBe(299_000);

    clock.pause('modal');
    vi.advanceTimersByTime(10 * 60_000);
    expect(clock.isPaused()).toBe(true);
    expect(clock.remaining('b')).toBe(299_000);
    clock.dispose();
  });

  it('a new coach pause restarts the 25 s safety timer', () => {
    const { clock } = makeClock(300_000);
    clock.start('w');
    clock.pause('coach');
    vi.advanceTimersByTime(20_000);
    clock.resume('coach');
    clock.pause('coach');
    vi.advanceTimersByTime(20_000);
    expect(clock.isPaused()).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(clock.isPaused()).toBe(false);
    clock.dispose();
  });

  it('whenRunning resolves on resume and immediately when not paused', async () => {
    const { clock } = makeClock(null);
    await expect(clock.whenRunning()).resolves.toBeUndefined();

    clock.pause('coach');
    let released = false;
    const waiting = clock.whenRunning().then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    clock.resume('coach');
    await waiting;
    expect(released).toBe(true);
    clock.dispose();
  });

  it('flag fall fires once for the running side and freezes the clock', () => {
    const { clock, flags } = makeClock(60_000);
    clock.start('w');
    vi.advanceTimersByTime(30_000);
    clock.switchTo('b');
    vi.advanceTimersByTime(59_999);
    expect(flags).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(flags).toEqual(['b']);
    expect(clock.remaining('b')).toBe(0);
    expect(clock.snapshot().flagged).toBe('b');

    vi.advanceTimersByTime(60_000);
    expect(flags).toEqual(['b']);
    expect(clock.remaining('w')).toBe(30_000);
    clock.dispose();
  });

  it('does not flag while paused, and flags later by exactly the paused time', () => {
    const { clock, flags } = makeClock(10_000);
    clock.start('w');
    vi.advanceTimersByTime(9_000);
    clock.pause('modal');
    vi.advanceTimersByTime(60_000);
    expect(flags).toEqual([]);
    clock.resume('modal');
    vi.advanceTimersByTime(999);
    expect(flags).toEqual([]);
    vi.advanceTimersByTime(5);
    expect(flags).toEqual(['w']);
    clock.dispose();
  });

  it('a move made after the time ran out (late timer) still loses on time', () => {
    const { clock, flags } = makeClock(1_000);
    clock.start('w');
    vi.setSystemTime(Date.now() + 1_500); // the flag timer has not run yet
    clock.switchTo('b');
    expect(flags).toEqual(['w']);
    expect(clock.snapshot().running).toBe('w');
    clock.dispose();
  });

  it('set() restores a value (take-back) and re-arms the flag', () => {
    const { clock, flags } = makeClock(60_000);
    clock.start('w');
    vi.advanceTimersByTime(20_000);
    clock.set('w', 50_000);
    expect(clock.remaining('w')).toBe(50_000);
    vi.advanceTimersByTime(49_000);
    expect(flags).toEqual([]);
    vi.advanceTimersByTime(1_010);
    expect(flags).toEqual(['w']);
    clock.dispose();
  });

  it('stop() freezes the times and cancels the flag', () => {
    const { clock, flags } = makeClock(5_000);
    clock.start('w');
    vi.advanceTimersByTime(2_000);
    clock.stop();
    vi.advanceTimersByTime(60_000);
    expect(flags).toEqual([]);
    expect(clock.remaining('w')).toBe(3_000);
    expect(clock.snapshot().running).toBeNull();
    clock.dispose();
  });

  it('untimed clocks have no times and never flag, but still pause', () => {
    const { clock, flags } = makeClock(null);
    expect(clock.timed).toBe(false);
    clock.start('w');
    vi.advanceTimersByTime(3_600_000);
    expect(clock.remaining('w')).toBeNull();
    expect(flags).toEqual([]);
    clock.pause('coach');
    expect(clock.isPaused()).toBe(true);
    vi.advanceTimersByTime(COACH_AUTO_RESUME_MS);
    expect(clock.isPaused()).toBe(false);
    clock.dispose();
  });

  describe('holdFor — one side only (the child\'s clock stands while Гамбитик speaks)', () => {
    it('stops the held side on its turn; the other side ticks as usual', () => {
      const { clock } = makeClock(300_000);
      const release = clock.holdFor('w');
      clock.start('w');
      expect(clock.isPaused()).toBe(true);
      vi.advanceTimersByTime(4_000);
      expect(clock.remaining('w')).toBe(300_000);

      // the child moved while he still speaks: the bot's clock runs, nobody waits for the words
      clock.switchTo('b');
      expect(clock.isPaused()).toBe(false);
      expect(clock.snapshot().paused).toBe(false);
      vi.advanceTimersByTime(2_000);
      expect(clock.remaining('b')).toBe(298_000);

      // the bot answered, he is still speaking: the child's clock waits for the end of the words
      clock.switchTo('w');
      expect(clock.isPaused()).toBe(true);
      vi.advanceTimersByTime(3_000);
      expect(clock.remaining('w')).toBe(300_000);
      release();
      expect(clock.isPaused()).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(clock.remaining('w')).toBe(299_000);
      expect(clock.remaining('b')).toBe(298_000);
      clock.dispose();
    });

    it('whenRunning() of the other side does not wait for it', async () => {
      const { clock } = makeClock(300_000);
      clock.start('w');
      clock.holdFor('w');
      let done = false;
      void clock.whenRunning().then(() => {
        done = true;
      });
      await Promise.resolve();
      expect(done).toBe(false);
      clock.switchTo('b'); // the bot's turn: its clock is not held
      await Promise.resolve();
      expect(done).toBe(true);
      clock.dispose();
    });

    it('counts holds, the release is idempotent, and the 25 s safety frees a forgotten one', () => {
      const { clock } = makeClock(300_000);
      clock.start('w');
      const first = clock.holdFor('w');
      const second = clock.holdFor('w');
      first();
      first();
      expect(clock.isPaused()).toBe(true);
      second();
      expect(clock.isPaused()).toBe(false);

      clock.holdFor('w'); // never released (a voice that never says «done»)
      vi.advanceTimersByTime(COACH_AUTO_RESUME_MS - 1);
      expect(clock.isPaused()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(clock.isPaused()).toBe(false);
      clock.dispose();
    });

    it('works together with the pause reasons and never flags while held', () => {
      const { clock, flags } = makeClock(5_000);
      clock.start('w');
      const release = clock.holdFor('w');
      clock.pause('modal');
      clock.resume('modal');
      expect(clock.isPaused()).toBe(true);
      vi.advanceTimersByTime(10_000);
      expect(flags).toEqual([]);
      release();
      vi.advanceTimersByTime(5_001);
      expect(flags).toEqual(['w']);
      clock.dispose();
    });
  });

  it('emits ticks while running and nothing after dispose', () => {
    const { clock, changes } = makeClock(60_000);
    clock.start('w');
    const before = changes.length;
    vi.advanceTimersByTime(1_000);
    expect(changes.length).toBeGreaterThanOrEqual(before + 9);
    clock.dispose();
    const after = changes.length;
    vi.advanceTimersByTime(5_000);
    expect(changes.length).toBe(after);
  });
});

describe('formatClock', () => {
  it('formats minutes, tenths under ten seconds and hours', () => {
    expect(formatClock(null)).toBe('');
    expect(formatClock(300_000)).toBe('5:00');
    expect(formatClock(299_999)).toBe('4:59');
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(9_940)).toBe('0:09.9');
    expect(formatClock(450)).toBe('0:00.4');
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(-5)).toBe('0:00.0');
    expect(formatClock(3_723_000)).toBe('1:02:03');
  });
});
