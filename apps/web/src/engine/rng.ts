import type { Rng } from './types.ts';

/** Small deterministic PRNG (mulberry32) for tests and reproducible bot games. */
export function createSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const defaultRng: Rng = () => Math.random();

/** Uniform pick; `items` must not be empty. */
export function pickUniform<T>(items: readonly T[], rng: Rng): T {
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index] as T;
}
