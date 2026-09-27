import { describe, expect, it } from 'vitest';
import { INITIAL_NAV, canGoBack, canGoForward, keyToNavAction, navReducer } from './reviewNav.ts';
import type { NavAction, NavState } from './reviewNav.ts';

function run(state: NavState, ...actions: NavAction[]): NavState {
  return actions.reduce(navReducer, state);
}

describe('navReducer', () => {
  const game: NavState = { cursor: 3, length: 10 };

  it('starts empty', () => {
    expect(INITIAL_NAV).toEqual({ cursor: 0, length: 0 });
    expect(canGoBack(INITIAL_NAV)).toBe(false);
    expect(canGoForward(INITIAL_NAV)).toBe(false);
  });

  it('steps forward and back', () => {
    expect(run(game, { type: 'next' }).cursor).toBe(4);
    expect(run(game, { type: 'prev' }).cursor).toBe(2);
    expect(run(game, { type: 'next' }, { type: 'next' }, { type: 'prev' }).cursor).toBe(4);
  });

  it('jumps to both ends', () => {
    expect(run(game, { type: 'first' }).cursor).toBe(0);
    expect(run(game, { type: 'last' }).cursor).toBe(10);
  });

  it('never leaves 0..length', () => {
    expect(run({ cursor: 0, length: 10 }, { type: 'prev' }).cursor).toBe(0);
    expect(run({ cursor: 10, length: 10 }, { type: 'next' }).cursor).toBe(10);
    expect(run(game, { type: 'goto', cursor: 99 }).cursor).toBe(10);
    expect(run(game, { type: 'goto', cursor: -4 }).cursor).toBe(0);
    expect(run(game, { type: 'goto', cursor: Number.NaN }).cursor).toBe(0);
    expect(run(game, { type: 'goto', cursor: 6.9 }).cursor).toBe(6);
  });

  it('returns the same object when nothing changes (no needless re-render)', () => {
    const atStart: NavState = { cursor: 0, length: 5 };
    const atEnd: NavState = { cursor: 5, length: 5 };
    expect(navReducer(atStart, { type: 'prev' })).toBe(atStart);
    expect(navReducer(atStart, { type: 'first' })).toBe(atStart);
    expect(navReducer(atEnd, { type: 'next' })).toBe(atEnd);
    expect(navReducer(atEnd, { type: 'last' })).toBe(atEnd);
    expect(navReducer(game, { type: 'goto', cursor: 3 })).toBe(game);
  });

  it('reset loads a game: the final position by default, or a given cursor', () => {
    expect(run(game, { type: 'reset', length: 40 })).toEqual({ cursor: 40, length: 40 });
    expect(run(game, { type: 'reset', length: 40, cursor: 0 })).toEqual({ cursor: 0, length: 40 });
    expect(run(game, { type: 'reset', length: 4, cursor: 9 })).toEqual({ cursor: 4, length: 4 });
    expect(run(game, { type: 'reset', length: -3 })).toEqual({ cursor: 0, length: 0 });
    expect(run(game, { type: 'reset', length: Number.NaN })).toEqual({ cursor: 0, length: 0 });
  });

  it('reports whether the arrows are enabled', () => {
    expect(canGoBack(game)).toBe(true);
    expect(canGoForward(game)).toBe(true);
    expect(canGoForward({ cursor: 10, length: 10 })).toBe(false);
    expect(canGoBack({ cursor: 0, length: 10 })).toBe(false);
  });
});

describe('keyToNavAction', () => {
  it('maps the arrow keys, Home and End', () => {
    expect(keyToNavAction('ArrowLeft')).toEqual({ type: 'prev' });
    expect(keyToNavAction('ArrowRight')).toEqual({ type: 'next' });
    expect(keyToNavAction('Home')).toEqual({ type: 'first' });
    expect(keyToNavAction('End')).toEqual({ type: 'last' });
  });

  it('ignores everything else (scrolling keys stay with the browser)', () => {
    for (const key of ['ArrowUp', 'ArrowDown', ' ', 'Enter', 'a', 'PageDown', 'Escape']) expect(keyToNavAction(key)).toBeNull();
  });

  it('walks a whole game with the keyboard', () => {
    let state: NavState = { cursor: 0, length: 3 };
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      const action = keyToNavAction(key);
      if (action) state = navReducer(state, action);
    }
    expect(state.cursor).toBe(3);
  });
});
