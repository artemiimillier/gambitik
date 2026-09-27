import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGestureGate } from './gestureGate.ts';
import { createSilentVoice } from './silentVoice.ts';

function createTarget() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  return {
    listeners,
    addEventListener(type: string, cb: EventListenerOrEventListenerObject | null) {
      if (!cb) return;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(cb);
    },
    removeEventListener(type: string, cb: EventListenerOrEventListenerObject | null) {
      if (cb) listeners.get(type)?.delete(cb);
    },
    fire(type: string) {
      for (const cb of [...(listeners.get(type) ?? [])]) {
        if (typeof cb === 'function') cb(new Event(type));
        else cb.handleEvent(new Event(type));
      }
    },
    count() {
      return [...listeners.values()].reduce((n, set) => n + set.size, 0);
    },
  };
}

describe('gesture gate', () => {
  it('is open when the page was already activated', () => {
    const target = createTarget();
    const gate = createGestureGate({ hasUserActivation: () => true, target });
    expect(gate.needsUserGesture).toBe(false);
    expect(target.count()).toBe(0);
  });

  it('unlocks on the first gesture anywhere, runs the unlock work once and stops listening', () => {
    const target = createTarget();
    const onUnlock = vi.fn();
    const gate = createGestureGate({ hasUserActivation: () => false, target, onUnlock });
    const changes: boolean[] = [];
    gate.onChange((v) => changes.push(v));
    expect(gate.needsUserGesture).toBe(true);
    expect(target.count()).toBe(3);

    target.fire('pointerdown');
    expect(gate.needsUserGesture).toBe(false);
    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(target.count()).toBe(0);

    gate.unlock(); // already open → nothing happens
    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([false]);
  });

  it('lock() asks for a gesture again; a failing unlock callback does not break the gate', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const target = createTarget();
    const gate = createGestureGate({
      hasUserActivation: () => true,
      target,
      onUnlock: () => {
        throw new Error('AudioContext refused');
      },
    });
    gate.lock();
    expect(gate.needsUserGesture).toBe(true);
    target.fire('keydown');
    expect(gate.needsUserGesture).toBe(false);
  });

  it('dispose() removes the listeners', () => {
    const target = createTarget();
    const gate = createGestureGate({ hasUserActivation: () => false, target });
    gate.dispose();
    expect(target.count()).toBe(0);
  });

  it('works without a window (tests, SSR)', () => {
    const gate = createGestureGate({ hasUserActivation: () => false, target: null });
    expect(gate.needsUserGesture).toBe(true);
    gate.unlock();
    expect(gate.needsUserGesture).toBe(false);
  });
});

describe('silent voice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('takes a natural reading time, flaps the mouth quietly and ends with a closed mouth', async () => {
    const voice = createSilentVoice();
    await voice.init();
    const speaking: boolean[] = [];
    const levels: number[] = [];
    voice.onSpeakingChange((v) => speaking.push(v));
    voice.onLevel((v) => levels.push(v));

    let finished = false;
    void voice.speak('Помни наш секрет: сначала смотрим — потом ходим!').then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(finished).toBe(false);
    expect(speaking).toEqual([true]);
    expect(Math.max(...levels)).toBeGreaterThan(0.05);
    expect(Math.max(...levels)).toBeLessThanOrEqual(0.55);

    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).toBe(true);
    expect(speaking).toEqual([true, false]);
    expect(levels.at(-1)).toBe(0);
  });

  it('stop() and a new speak() both end the current phrase', async () => {
    const voice = createSilentVoice();
    const first = voice.speak('Первая длинная фраза для чтения.');
    const second = voice.speak('Вторая.');
    await first;
    voice.stop();
    await second;
    expect(voice.kind).toBe('silent');
  });

  it('resolves immediately for empty text and after dispose', async () => {
    const voice = createSilentVoice();
    await voice.speak('   ');
    voice.dispose();
    await voice.speak('после dispose');
  });
});
