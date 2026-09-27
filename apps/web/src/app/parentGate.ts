/**
 * Parent gate of the settings page (research 08 §6–7) — pure logic.
 *
 * Not a lock, a speed bump: a 7–10-year-old should not switch the PAID live voice on, rename himself or move the
 * curriculum stage by accident. Two ways in: hold a button for three seconds (the text says so — a non-reader
 * does not know it), or add two two-digit numbers with a carry. Once opened, the gate stays open for ten
 * minutes of the same browser tab (sessionStorage), so a parent going back and forth is not nagged.
 */
export const PARENT_GATE_HOLD_MS = 3000;
export const PARENT_GATE_VALID_MS = 10 * 60_000;
export const PARENT_GATE_STORAGE_KEY = 'gambit.parentGate';

export type GateStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** sessionStorage can throw (private mode) — then the gate simply asks every time. */
export function getGateStorage(): GateStorage | null {
  try {
    // `window` first: newer Node versions have experimental global storages that warn when touched (unit tests)
    return typeof window === 'undefined' || typeof window.sessionStorage === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export interface GateQuestion {
  a: number;
  b: number;
  answer: number;
  /** «47 + 38» */
  text: string;
}

/** Two two-digit numbers whose units carry over (7 + 8): quick for an adult, real work for a second-grader. */
export function makeGateQuestion(rng: () => number = Math.random): GateQuestion {
  const digit = (min: number, max: number): number => min + Math.floor(Math.min(0.999999, Math.max(0, rng())) * (max - min + 1));
  const tensA = digit(2, 5);
  const tensB = digit(2, 4);
  const unitsA = digit(5, 9);
  const unitsB = digit(11 - unitsA > 5 ? 11 - unitsA : 5, 9); // unitsA + unitsB ≥ 11 → always a carry
  const a = tensA * 10 + unitsA;
  const b = tensB * 10 + unitsB;
  return { a, b, answer: a + b, text: `${a} + ${b}` };
}

/** Accepts the digits with spaces around; anything else is simply «not yet». */
export function checkGateAnswer(question: Pick<GateQuestion, 'answer'>, input: string): boolean {
  const cleaned = input.trim();
  return /^\d{1,4}$/.test(cleaned) && Number(cleaned) === question.answer;
}

export function isGateOpen(storage: GateStorage | null, now: number): boolean {
  if (!storage) return false;
  try {
    const until = Number(storage.getItem(PARENT_GATE_STORAGE_KEY));
    return Number.isFinite(until) && until > now && until - now <= PARENT_GATE_VALID_MS;
  } catch {
    return false;
  }
}

export function openGate(storage: GateStorage | null, now: number): void {
  if (!storage) return;
  try {
    storage.setItem(PARENT_GATE_STORAGE_KEY, String(now + PARENT_GATE_VALID_MS));
  } catch {
    /* private mode: the gate will ask again next time */
  }
}
