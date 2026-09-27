/**
 * Browsers only allow sound (speechSynthesis, <audio>.play(), AudioContext) after the user has
 * interacted with the page. The gate tracks that state, listens for the first gesture anywhere
 * on the page and lets a voice layer run its unlock work inside the gesture handler.
 */
import { createEmitter } from './voiceUtils.ts';
import type { Unsubscribe } from './voiceUtils.ts';

export interface GestureGate {
  readonly needsUserGesture: boolean;
  onChange(cb: (needs: boolean) => void): Unsubscribe;
  /** Runs the unlock callbacks; call synchronously from a gesture handler. */
  unlock(): void;
  /** Sound was refused after all (e.g. `not-allowed`): ask for a gesture again. */
  lock(): void;
  dispose(): void;
}

export interface GestureGateOptions {
  /** work that must happen inside the gesture (resume AudioContext, warm-up utterance, audio.play()) */
  onUnlock?: () => void;
  /** probe for sticky activation; defaults to `navigator.userActivation.hasBeenActive` */
  hasUserActivation?: () => boolean;
  /** event target for the first-gesture listeners; defaults to `window` */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
}

const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

export function probeUserActivation(): boolean {
  if (typeof navigator === 'undefined') return false;
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  // Without the API we cannot know — stay locked until the first gesture listener fires.
  return activation?.hasBeenActive ?? false;
}

export function createGestureGate(options: GestureGateOptions = {}): GestureGate {
  const change = createEmitter<boolean>();
  const probe = options.hasUserActivation ?? probeUserActivation;
  const target = options.target === undefined ? (typeof window === 'undefined' ? null : window) : options.target;

  let needs = !probe();
  let listening = false;
  let disposed = false;

  const onGesture = (): void => {
    unlock();
  };

  function listen(): void {
    if (listening || disposed || !target) return;
    listening = true;
    for (const name of GESTURE_EVENTS) target.addEventListener(name, onGesture, true);
  }

  function unlisten(): void {
    if (!listening || !target) return;
    listening = false;
    for (const name of GESTURE_EVENTS) target.removeEventListener(name, onGesture, true);
  }

  function set(next: boolean): void {
    if (needs === next) return;
    needs = next;
    change.emit(next);
  }

  function unlock(): void {
    if (disposed || !needs) return;
    unlisten();
    try {
      options.onUnlock?.();
    } catch (error) {
      console.warn('[coach] audio unlock failed', error);
    }
    set(false);
  }

  function lock(): void {
    if (disposed) return;
    set(true);
    listen();
  }

  if (needs) listen();

  return {
    get needsUserGesture() {
      return needs;
    },
    onChange: (cb) => change.on(cb),
    unlock,
    lock,
    dispose() {
      unlisten();
      disposed = true;
      change.clear();
    },
  };
}
