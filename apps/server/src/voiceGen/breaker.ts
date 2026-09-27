/**
 * «Дозапись голоса»: the circuit breaker — why the recorder stopped by itself and until when (`until` null = until the
 * owner acts and the server restarts). The gates of the service come first (flag, DATA_DIR pin, temp DATA_DIR, the
 * overlay, the budget, the parent switch); the breaker holds what the CLI and the finish told us:
 *
 *   login       the Higgsfield sign-in expired            30 min, then one free `generate cost` tells again
 *   rate        the account is rate-limited               1 min (the create already backed off 2 → 60 s)
 *   no-credits  the account is empty                      1 h (the owner tops it up; a refused create is free)
 *   unresolved  a create whose job is not known yet       1 min, then list adoption again (it counts at full price)
 *   tool-busy   the owner's `voice:generate` holds the lock  30 s
 *   failing     3 failures in a row                       15 min; the third trip in a day lasts until a restart
 *   price / model / audit / duplicate                     until a restart (the owner must look first)
 *
 * The `failing` trips are kept in the overlay's state.json, so a restart does not reset them (S7).
 */
import type { ClipGenPauseReason } from '@gambit/shared';

export type BreakerReason = Extract<ClipGenPauseReason, 'login' | 'rate' | 'no-credits' | 'unresolved' | 'tool-busy' | 'failing' | 'price' | 'model' | 'audit' | 'duplicate'>;

export const BREAKER_PAUSE_MS: Readonly<Record<'login' | 'rate' | 'no-credits' | 'unresolved' | 'tool-busy' | 'failing', number>> = {
  login: 30 * 60_000,
  rate: 60_000,
  'no-credits': 60 * 60_000,
  unresolved: 60_000,
  'tool-busy': 30_000,
  failing: 15 * 60_000,
};
/** consecutive failures (create errors, lost downloads, failed finishes) that trip the breaker */
export const FAILURES_TO_TRIP = 3;
/** the trip that lasts until a restart (1st and 2nd: 15 min) */
export const TRIPS_UNTIL_RESTART = 3;
/** trips older than this are forgotten */
const TRIP_MEMORY_MS = 24 * 60 * 60_000;

export interface BreakerPause {
  reason: BreakerReason;
  until: number | null;
}

export interface TripMemory {
  failingTrips: number;
  lastTripAt: string | null;
}

export class Breaker {
  private readonly now: () => number;
  private readonly load: () => TripMemory;
  private readonly save: (memory: TripMemory) => void;
  private paused: BreakerPause | null = null;
  private failures = 0;

  constructor(o: { now: () => number; load?: () => TripMemory; save?: (memory: TripMemory) => void }) {
    this.now = o.now;
    this.load = o.load ?? (() => ({ failingTrips: 0, lastTripAt: null }));
    this.save = o.save ?? (() => undefined);
  }

  /** The pause in force (a timed one that has run out is gone), or null. */
  current(): BreakerPause | null {
    if (this.paused !== null && this.paused.until !== null && this.paused.until <= this.now()) this.paused = null;
    return this.paused;
  }

  /** Pauses for the reason's standard time (`BREAKER_PAUSE_MS`) or until a restart; a pause in force is never shortened. */
  pause(reason: BreakerReason, until?: number | null): void {
    const standard = (BREAKER_PAUSE_MS as Record<string, number | undefined>)[reason];
    const next: BreakerPause = { reason, until: until !== undefined ? until : standard !== undefined ? this.now() + standard : null };
    const cur = this.current();
    if (cur !== null && next.until !== null && (cur.until === null || cur.until > next.until)) return;
    this.paused = next;
  }

  /** One failure; the third in a row trips 'failing'. */
  failure(): void {
    this.failures++;
    if (this.failures < FAILURES_TO_TRIP) return;
    this.failures = 0;
    const memory = this.load();
    const recent = memory.lastTripAt !== null && this.now() - Date.parse(memory.lastTripAt) < TRIP_MEMORY_MS;
    const trips = (recent ? memory.failingTrips : 0) + 1;
    this.save({ failingTrips: trips, lastTripAt: new Date(this.now()).toISOString() });
    this.pause('failing', trips >= TRIPS_UNTIL_RESTART ? null : this.now() + BREAKER_PAUSE_MS.failing);
  }

  /** A job went through: the failure streak ends. */
  success(): void {
    this.failures = 0;
  }
}
