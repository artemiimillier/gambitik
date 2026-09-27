/**
 * localStorage access that never throws (private mode, blocked storage, server-side tests).
 * Kept in its own tiny module so that light-weight helpers (resume.ts) do not pull the engines in.
 */
import type { KeyValueStorage } from './gameTypes.ts';

export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // private mode / blocked storage
  }
}
