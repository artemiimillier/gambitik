import { describe, expect, it, vi } from 'vitest';
import type { CoachEvent } from '@gambit/shared';
import { scheduleGreeting, shellCoachEvent } from './greeting.ts';
import type { GreetingCoachState, GreetingStore } from './greeting.ts';

function fakeStore(initial: GreetingCoachState): GreetingStore & { set(patch: Partial<GreetingCoachState>): void; listeners: number } {
  let state = initial;
  const listeners = new Set<(state: GreetingCoachState) => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener(state);
    },
    get listeners() {
      return listeners.size;
    },
  };
}

const hello: CoachEvent = { id: 'hello', kind: 'greeting', priority: 1, text: 'Привет!', bubbleText: 'Привет!', pose: 'wave', pauseClock: false };

describe('scheduleGreeting', () => {
  it('speaks at once when the coach is ready and sound is unlocked', () => {
    const store = fakeStore({ ready: true, needsUserGesture: false });
    const say = vi.fn();
    scheduleGreeting({ store, say, buildEvent: () => hello });
    expect(say).toHaveBeenCalledExactlyOnceWith(hello);
    expect(store.listeners).toBe(0);
  });

  it('waits for the coach to be ready AND for the first user gesture', () => {
    const store = fakeStore({ ready: false, needsUserGesture: false });
    const say = vi.fn();
    const buildEvent = vi.fn(() => hello);
    scheduleGreeting({ store, say, buildEvent });
    expect(say).not.toHaveBeenCalled();

    store.set({ ready: true, needsUserGesture: true }); // init finished: the browser still blocks audio
    expect(say).not.toHaveBeenCalled();
    expect(buildEvent).not.toHaveBeenCalled(); // built lazily, at the moment he really speaks

    store.set({ needsUserGesture: false }); // the first click
    expect(say).toHaveBeenCalledExactlyOnceWith(hello);
  });

  it('greets only once, whatever happens to the store later', () => {
    const store = fakeStore({ ready: true, needsUserGesture: true });
    const say = vi.fn();
    scheduleGreeting({ store, say, buildEvent: () => hello });
    store.set({ needsUserGesture: false });
    store.set({ needsUserGesture: true });
    store.set({ needsUserGesture: false });
    expect(say).toHaveBeenCalledTimes(1);
    expect(store.listeners).toBe(0);
  });

  it('can be cancelled (the child went straight into a game)', () => {
    const store = fakeStore({ ready: true, needsUserGesture: true });
    const say = vi.fn();
    const cancel = scheduleGreeting({ store, say, buildEvent: () => hello });
    cancel();
    store.set({ needsUserGesture: false });
    expect(say).not.toHaveBeenCalled();
    expect(store.listeners).toBe(0);
    cancel(); // harmless
  });
});

describe('shellCoachEvent', () => {
  it('builds complete events with unique ids and a bubble text', () => {
    const a = shellCoachEvent({ kind: 'encourage', priority: 0, pose: 'talk', text: 'Раз' });
    const b = shellCoachEvent({ kind: 'encourage', priority: 0, pose: 'talk', text: 'Два', bubbleText: 'Два!' });
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ text: 'Раз', bubbleText: 'Раз', pauseClock: false, priority: 0 });
    expect(b.bubbleText).toBe('Два!');
  });
});
