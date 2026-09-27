/**
 * Move navigation of the review board as a pure reducer.
 * `cursor` = number of plies already played on the board: 0 is the start position, `length` the final one.
 */

export interface NavState {
  cursor: number;
  length: number;
}

export type NavAction =
  | { type: 'first' }
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'last' }
  | { type: 'goto'; cursor: number }
  /** a (new) game was loaded; `cursor` defaults to the final position */
  | { type: 'reset'; length: number; cursor?: number };

export const INITIAL_NAV: NavState = { cursor: 0, length: 0 };

function clamp(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length, Math.trunc(value)));
}

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'first':
      return state.cursor === 0 ? state : { ...state, cursor: 0 };
    case 'prev':
      return state.cursor === 0 ? state : { ...state, cursor: state.cursor - 1 };
    case 'next':
      return state.cursor >= state.length ? state : { ...state, cursor: state.cursor + 1 };
    case 'last':
      return state.cursor === state.length ? state : { ...state, cursor: state.length };
    case 'goto': {
      const cursor = clamp(action.cursor, state.length);
      return cursor === state.cursor ? state : { ...state, cursor };
    }
    case 'reset': {
      const length = Math.max(0, Number.isFinite(action.length) ? Math.trunc(action.length) : 0);
      return { length, cursor: clamp(action.cursor ?? length, length) };
    }
  }
}

/** Keyboard map of the review board: ← → step, Home / End jump. Anything else is not ours. */
export function keyToNavAction(key: string): NavAction | null {
  switch (key) {
    case 'ArrowLeft':
      return { type: 'prev' };
    case 'ArrowRight':
      return { type: 'next' };
    case 'Home':
      return { type: 'first' };
    case 'End':
      return { type: 'last' };
    default:
      return null;
  }
}

export function canGoBack(state: NavState): boolean {
  return state.cursor > 0;
}

export function canGoForward(state: NavState): boolean {
  return state.cursor < state.length;
}
