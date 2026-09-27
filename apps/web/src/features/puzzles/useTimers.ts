import { useCallback, useEffect, useMemo, useRef } from 'react';

export interface Timers {
  /** Like setTimeout, but cleared automatically on unmount or by `clear()`. */
  after(ms: number, fn: () => void): void;
  clear(): void;
}

/** Timeouts that can never fire after the component is gone (or after the puzzle changed). */
export function useTimers(): Timers {
  const ids = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const clear = useCallback(() => {
    for (const id of ids.current) clearTimeout(id);
    ids.current.clear();
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    const id = setTimeout(() => {
      ids.current.delete(id);
      fn();
    }, ms);
    ids.current.add(id);
  }, []);

  useEffect(() => clear, [clear]);

  return useMemo(() => ({ after, clear }), [after, clear]);
}
