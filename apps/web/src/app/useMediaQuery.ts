import { useCallback, useSyncExternalStore } from 'react';

/**
 * A phone held upright or a narrow tablet: the game is one column that fits the screen (no page scroll), and Гамбитик
 * stands in a bar at the bottom instead of floating over the board (GameScreen.module.css, MascotDock layout="bar").
 */
export const STACKED_GAME_QUERY = '(max-width: 899px) and (orientation: portrait)';

/** A phone on its side: board on the left, the panel on the right with Гамбитик's bar under it. */
export const SHORT_LANDSCAPE_QUERY = '(max-height: 540px) and (orientation: landscape)';

/** Re-renders when a CSS media query starts or stops matching. False where `matchMedia` is missing. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    [query],
  );
  const getSnapshot = useCallback(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
