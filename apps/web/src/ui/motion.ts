/**
 * Reduced-motion switch shared by CSS (global.css reads <html data-reduced-motion>) and JS (confetti, sounds-free effects).
 * `null` override = follow the operating system setting.
 */
const ATTRIBUTE = 'data-reduced-motion';

let override: boolean | null = null;

/** Parent setting «меньше анимации»: true/false forces the mode, null follows the OS. */
export function setReducedMotion(value: boolean | null): void {
  override = value;
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (value === null) root.removeAttribute(ATTRIBUTE);
  else root.setAttribute(ATTRIBUTE, value ? 'true' : 'false');
}

export function getReducedMotionOverride(): boolean | null {
  return override;
}

/** True when animations should be replaced by a static equivalent. Safe to call outside the browser. */
export function prefersReducedMotion(): boolean {
  if (override !== null) return override;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
