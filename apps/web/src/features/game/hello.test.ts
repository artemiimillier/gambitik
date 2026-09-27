import { describe, expect, it } from 'vitest';
import { HELLO_FRESH_MS, HELLO_HEARD_MIN_MS, createHelloWatch } from './hello.ts';
import type { HelloWatchState, HelloWatchStore } from './hello.ts';

/** A tiny store with the two fields the watch reads, and a clock the test moves by hand. */
function fakeStore(): HelloWatchStore & { set(patch: Partial<HelloWatchState>): void } {
  let state: HelloWatchState = { pose: 'idle', speaking: false };
  const listeners: ((s: HelloWatchState) => void)[] = [];
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l(state);
    },
  };
}

describe('hello watch — was «Привет» really heard? (the game greets itself when not)', () => {
  it('a wave with words long enough is a hello; it stays fresh for a while', () => {
    let t = 1_000;
    const store = fakeStore();
    const watch = createHelloWatch(store, () => t);
    expect(watch.heardRecently()).toBe(false);

    store.set({ pose: 'wave', speaking: true });
    t += HELLO_HEARD_MIN_MS;
    store.set({ speaking: false, pose: 'idle' });
    expect(watch.heardRecently()).toBe(true);
    t += HELLO_FRESH_MS - 1;
    expect(watch.heardRecently()).toBe(true);
    t += 1;
    expect(watch.heardRecently()).toBe(false);
    watch.dispose();
  });

  it('a hello cut off after a syllable (the wizard\'s «stop speaking») does not count', () => {
    let t = 0;
    const store = fakeStore();
    const watch = createHelloWatch(store, () => t);
    store.set({ pose: 'wave', speaking: true });
    t += 300;
    store.set({ speaking: false });
    expect(watch.heardRecently()).toBe(false);
    watch.dispose();
  });

  it('talking without a wave (the wizard\'s remarks) is not a hello; a wave in silence neither', () => {
    let t = 0;
    const store = fakeStore();
    const watch = createHelloWatch(store, () => t);
    store.set({ pose: 'talk', speaking: true });
    t += 5_000;
    store.set({ speaking: false });
    store.set({ pose: 'wave', speaking: false }); // «Нажми на меня» before the first click: waving, no sound
    t += 5_000;
    store.set({ pose: 'idle' });
    expect(watch.heardRecently()).toBe(false);
    watch.dispose();
  });

  it('a hello still being said counts once it is long enough', () => {
    let t = 0;
    const store = fakeStore();
    store.set({ pose: 'wave', speaking: true }); // already speaking when the watch starts
    const watch = createHelloWatch(store, () => t);
    t += HELLO_HEARD_MIN_MS - 1;
    expect(watch.heardRecently()).toBe(false);
    t += 1;
    expect(watch.heardRecently()).toBe(true);
    watch.dispose();
  });
});
