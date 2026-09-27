/**
 * Dev-only test introspection: `window.__gambit`.
 *
 * The Playwright e2e suite (e2e/) reads the live game state and the current puzzle through this hook instead of
 * scraping the board. It exists ONLY on the Vite dev server: every call site is guarded by `import.meta.env.DEV`,
 * so the production bundle contains neither the hook nor the data it exposes (puzzle solutions!).
 */
import type { Puzzle } from '@gambit/shared';
import type { GameState } from './features/game/gameTypes.ts';

export interface GambitGameHook {
  /** the full, live game state (plain data) */
  state(): GameState;
}

export interface GambitPuzzleSnapshot {
  status: string;
  phase: string;
  /** index of the puzzle inside the session */
  index: number;
  total: number;
  /** index of the next expected move inside `puzzle.solutionUci` */
  solutionIndex: number;
  puzzle: Puzzle | null;
}

export interface GambitPuzzlesHook {
  current(): GambitPuzzleSnapshot;
}

/**
 * The coach's UI state. e2e only uses it to PAINT the «Поговорить» button in its conversation states for the
 * screenshots: an automated browser has no real voice session (automation.ts), so those states cannot be reached.
 * Setting the store opens nothing — no session, no microphone, no sound.
 */
export interface GambitCoachHook {
  state(): Record<string, unknown>;
  paint(patch: Record<string, unknown>): void;
}

export interface GambitDevHook {
  game?: GambitGameHook;
  puzzles?: GambitPuzzlesHook;
  coach?: GambitCoachHook;
}

declare global {
  interface Window {
    __gambit?: GambitDevHook;
  }
}

/** Registers one section of the hook; returns the clean-up. A no-op outside the dev server. */
export function registerDevHook<K extends keyof GambitDevHook>(key: K, value: NonNullable<GambitDevHook[K]>): () => void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return () => {};
  const hook: GambitDevHook = window.__gambit ?? (window.__gambit = {});
  hook[key] = value;
  return () => {
    if (window.__gambit?.[key] === value) delete window.__gambit[key];
  };
}
