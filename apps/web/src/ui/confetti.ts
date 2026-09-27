/**
 * canvas-confetti wrapper. Confetti is reserved for real milestones (a win, a new curriculum step, an earned star)
 * and respects reduced motion: `celebrate` then returns false and the caller shows a static reward instead
 * (research 08 §9: «конфетти заменяется статичной звездой»).
 *
 * The library is imported lazily so it never loads before the first celebration (and never on the server).
 */
import type { Options as ConfettiOptions } from 'canvas-confetti';
import { prefersReducedMotion } from './motion.ts';

export type CelebrationKind = 'win' | 'star' | 'stage';

export interface CelebrateOptions {
  /** Launch point in viewport fractions (0..1). Default depends on the kind. */
  origin?: { x: number; y: number };
}

/** Palette of the app: teal, sunny, star, coral, mint, sky. */
export const CONFETTI_COLORS = ['#0F6F69', '#FFB938', '#FFD23F', '#FF6B5E', '#3CCB9B', '#4DB5FF'] as const;

type ConfettiFn = (options?: ConfettiOptions) => Promise<undefined> | null;
interface ConfettiModule {
  fire: ConfettiFn;
  reset: () => void;
}

let modulePromise: Promise<ConfettiModule | null> | null = null;
const timers = new Set<ReturnType<typeof setTimeout>>();

function loadConfetti(): Promise<ConfettiModule | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null);
  modulePromise ??= import('canvas-confetti')
    .then((mod): ConfettiModule => {
      const confetti = mod.default;
      return { fire: (options) => confetti(options), reset: () => confetti.reset() };
    })
    .catch(() => null);
  return modulePromise;
}

/** One burst description: delay in ms + canvas-confetti options. Exported for tests and the gallery. */
export interface Burst {
  delayMs: number;
  options: ConfettiOptions;
}

export function planCelebration(kind: CelebrationKind, origin?: { x: number; y: number }): Burst[] {
  const colors = [...CONFETTI_COLORS];
  const base: ConfettiOptions = { colors, disableForReducedMotion: false, zIndex: 1000, scalar: 1.15, ticks: 220 };
  switch (kind) {
    case 'star':
      return [
        {
          delayMs: 0,
          options: { ...base, particleCount: 36, spread: 70, startVelocity: 28, gravity: 0.9, shapes: ['star'], colors: ['#FFD23F', '#FFB938', '#FFF0CC'], origin: origin ?? { x: 0.5, y: 0.5 } },
        },
      ];
    case 'stage': {
      const bursts: Burst[] = [];
      for (let i = 0; i < 6; i++) {
        bursts.push({
          delayMs: i * 320,
          options: { ...base, particleCount: 44, spread: 100, startVelocity: 38, shapes: i % 2 === 0 ? ['star', 'circle'] : ['square', 'circle'], origin: origin ?? { x: 0.15 + 0.14 * i, y: 0.35 } },
        });
      }
      return bursts;
    }
    case 'win':
      return [
        { delayMs: 0, options: { ...base, particleCount: 90, spread: 75, startVelocity: 52, angle: 60, origin: origin ?? { x: 0, y: 0.75 } } },
        { delayMs: 0, options: { ...base, particleCount: 90, spread: 75, startVelocity: 52, angle: 120, origin: origin ?? { x: 1, y: 0.75 } } },
        { delayMs: 380, options: { ...base, particleCount: 70, spread: 120, startVelocity: 36, shapes: ['star', 'circle', 'square'], origin: origin ?? { x: 0.5, y: 0.45 } } },
      ];
  }
}

/**
 * Fires the celebration. Resolves `true` when confetti was launched, `false` when it was skipped
 * (reduced motion, no DOM, library failed to load) — show a static star / badge in that case.
 */
export async function celebrate(kind: CelebrationKind = 'win', options: CelebrateOptions = {}): Promise<boolean> {
  if (prefersReducedMotion()) return false;
  const confetti = await loadConfetti();
  if (!confetti) return false;
  // The setting may have changed while the chunk was loading.
  if (prefersReducedMotion()) return false;

  for (const burst of planCelebration(kind, options.origin)) {
    if (burst.delayMs === 0) {
      void confetti.fire(burst.options);
      continue;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!prefersReducedMotion()) void confetti.fire(burst.options);
    }, burst.delayMs);
    timers.add(timer);
  }
  return true;
}

/** Removes all confetti immediately (leaving a screen, opening a dialog). */
export function stopConfetti(): void {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  if (!modulePromise) return;
  void modulePromise.then((confetti) => confetti?.reset());
}
