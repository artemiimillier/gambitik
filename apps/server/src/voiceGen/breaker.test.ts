/** «Дозапись голоса»: the breaker's pauses (timed ones run out, none is ever shortened) and its remembered trips. */
import { describe, expect, it } from 'vitest';
import { BREAKER_PAUSE_MS, Breaker } from './breaker.ts';
import type { TripMemory } from './breaker.ts';

function breaker(memory: TripMemory = { failingTrips: 0, lastTripAt: null }) {
  const clock = { now: 1_000_000 };
  const saved: TripMemory[] = [];
  let stored = memory;
  const b = new Breaker({
    now: () => clock.now,
    load: () => stored,
    save: (m) => {
      stored = m;
      saved.push(m);
    },
  });
  return { b, clock, saved };
}

describe('Breaker', () => {
  it('a timed pause runs out; a pause until a restart does not', () => {
    const { b, clock } = breaker();
    b.pause('rate');
    expect(b.current()).toEqual({ reason: 'rate', until: clock.now + BREAKER_PAUSE_MS.rate });
    clock.now += BREAKER_PAUSE_MS.rate;
    expect(b.current()).toBeNull();
    b.pause('price', null);
    clock.now += 7 * 24 * 60 * 60_000;
    expect(b.current()).toEqual({ reason: 'price', until: null });
  });

  it('a pause in force is never shortened (a longer one wins)', () => {
    const { b, clock } = breaker();
    b.pause('login');
    b.pause('tool-busy');
    expect(b.current()).toEqual({ reason: 'login', until: clock.now + BREAKER_PAUSE_MS.login });
    b.pause('no-credits');
    expect(b.current()?.reason).toBe('no-credits');
    b.pause('model', null);
    b.pause('rate');
    expect(b.current()).toEqual({ reason: 'model', until: null });
  });

  it('three failures in a row trip `failing`; a success ends the streak; the third trip in a day lasts until a restart', () => {
    const { b, clock, saved } = breaker();
    b.failure();
    b.failure();
    b.success();
    b.failure();
    b.failure();
    expect(b.current()).toBeNull();
    b.failure();
    expect(b.current()).toEqual({ reason: 'failing', until: clock.now + BREAKER_PAUSE_MS.failing });
    expect(saved.at(-1)).toMatchObject({ failingTrips: 1 });
    clock.now += BREAKER_PAUSE_MS.failing;
    for (let i = 0; i < 3; i++) b.failure();
    expect(saved.at(-1)).toMatchObject({ failingTrips: 2 });
    clock.now += BREAKER_PAUSE_MS.failing;
    for (let i = 0; i < 3; i++) b.failure();
    expect(b.current()).toEqual({ reason: 'failing', until: null });
  });

  it('remembered trips count after a restart, and are forgotten after a day', () => {
    const recent = breaker({ failingTrips: 2, lastTripAt: new Date(1_000_000 - 60_000).toISOString() });
    for (let i = 0; i < 3; i++) recent.b.failure();
    expect(recent.b.current()).toEqual({ reason: 'failing', until: null });
    const old = breaker({ failingTrips: 2, lastTripAt: new Date(1_000_000 - 25 * 60 * 60_000).toISOString() });
    for (let i = 0; i < 3; i++) old.b.failure();
    expect(old.b.current()?.until).not.toBeNull();
    expect(old.saved.at(-1)).toMatchObject({ failingTrips: 1 });
  });
});
