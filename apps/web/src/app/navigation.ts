/**
 * DOM binding of the hash router: `useRoute()` re-renders on every hash change,
 * `navigate()` pushes (or replaces) a typed route.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { formatRoute, parseHash } from './router.ts';
import type { Route } from './router.ts';

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('hashchange', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', listener);
  };
}

function getHash(): string {
  return window.location.hash;
}

function getServerHash(): string {
  return '';
}

export interface NavigateOptions {
  /** Replace the current history entry (e.g. a finished game → its review, so «Back» never restarts the game). */
  replace?: boolean;
}

export function navigate(route: Route, options: NavigateOptions = {}): void {
  const hash = formatRoute(route);
  if (options.replace) {
    // replaceState does not fire `hashchange`
    window.history.replaceState(window.history.state, '', hash);
    for (const listener of [...listeners]) listener();
    return;
  }
  if (window.location.hash !== hash) window.location.hash = hash;
}

export function goHome(options?: NavigateOptions): void {
  navigate({ name: 'home' }, options);
}

/** Current route, parsed from `location.hash`. The object identity is stable while the hash is. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, getServerHash);
  return useMemo(() => parseHash(hash), [hash]);
}
