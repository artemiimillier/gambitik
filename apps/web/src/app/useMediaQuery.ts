import { useCallback, useSyncExternalStore } from 'react';

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
