/**
 * «Дозапись голоса»: money. Spend is read from the overlay ledger — never from a counter of our own that a crash could
 * leave behind (docs/voice-clips/ONDEMAND.md): charged jobs at their price, pending jobs AND unresolved intents (a create whose job is
 * not known yet — the provider may have debited it) at full price, failed jobs not at all. The overlay ledger is the
 * one on-demand ledger of this Mac, so every server instance and every checkout shares these numbers (S3).
 *
 * Caps: CLIP_GEN_BUDGET (lifetime, campaign `ondemand`) and a local-day cap = min(the parent's cap in kv
 * `voice.clipGen`, CLIP_GEN_DAILY_MAX). The owner's paid prefetch (campaign `prefetch`, his own `--budget`) is shown
 * but not charged to the child's caps.
 */
import type { ClipGenSettings } from '@gambit/shared';
import { kvGetJson, kvSetJson } from '../storage/db.ts';
import type { Db } from '../storage/db.ts';
import { ONDEMAND_CAMPAIGN, PREFETCH_CAMPAIGN, localDay, spentByDay } from './bridge.ts';
import type { OnDemandView } from './bridge.ts';

export const KV_CLIP_GEN = 'voice.clipGen';
/** the parent's daily cap until he picks one (never above the env maximum) */
export const DEFAULT_PARENT_DAILY_MILLI = 10_000;
/** the cheapest possible job (0.15 credits): less than this left = nothing more can be recorded */
export const MIN_JOB_MILLI = 150;

/**
 * The parent's switch and daily cap, stored in kv like the voice choice. ON by default (parents must not
 * have to turn anything on): only an explicit «off» from the parent stops recording. Whether this server may record at all
 * is still decided by the owner's env (GAMBIT_CLIP_GEN, the caps, the DATA_DIR pin) and every refusal of the service.
 */
export class ClipGenSettingsStore {
  private readonly db: Db;
  private readonly dailyMaxMilli: number;

  constructor(db: Db, dailyMaxMilli: number) {
    this.db = db;
    this.dailyMaxMilli = dailyMaxMilli;
  }

  get(): ClipGenSettings {
    let raw: unknown;
    try {
      raw = kvGetJson(this.db, KV_CLIP_GEN);
    } catch {
      raw = undefined;
    }
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const cap = typeof value.dailyCapMilli === 'number' && Number.isInteger(value.dailyCapMilli) && value.dailyCapMilli >= 0 ? value.dailyCapMilli : DEFAULT_PARENT_DAILY_MILLI;
    return { enabled: value.enabled !== false, dailyCapMilli: Math.min(cap, this.dailyMaxMilli) };
  }

  /** Stores the parent's choice; the cap is clipped to the env maximum (it can only be lower). */
  set(settings: ClipGenSettings): ClipGenSettings {
    const next: ClipGenSettings = { enabled: settings.enabled, dailyCapMilli: Math.max(0, Math.min(Math.round(settings.dailyCapMilli), this.dailyMaxMilli)) };
    kvSetJson(this.db, KV_CLIP_GEN, next);
    return next;
  }
}

export interface Spend {
  /** the server's local day (YYYY-MM-DD) */
  today: string;
  todayMilli: number;
  totalMilli: number;
  prefetchMilli: number;
}

/** On-demand spend today and in total, plus the owner's prefetch — all conservative (S1). */
export function spendOf(view: OnDemandView, now: Date): Spend {
  const today = localDay(now);
  const ondemand = spentByDay(view, undefined, ONDEMAND_CAMPAIGN);
  const prefetch = spentByDay(view, undefined, PREFETCH_CAMPAIGN);
  return { today, todayMilli: ondemand.days[today] ?? 0, totalMilli: ondemand.totalMilli, prefetchMilli: prefetch.totalMilli };
}

export interface Caps {
  /** the effective daily cap: min(parent, env maximum) */
  dailyMilli: number;
  dailyMaxMilli: number;
  totalMilli: number;
}

/** Which cap one more job of `priceMilli` would cross (the total first: it is the owner's), or null. */
export function capReached(spend: Pick<Spend, 'todayMilli' | 'totalMilli'>, priceMilli: number, caps: Caps): 'total-cap' | 'day-cap' | null {
  if (spend.totalMilli + priceMilli > caps.totalMilli) return 'total-cap';
  if (spend.todayMilli + priceMilli > caps.dailyMilli) return 'day-cap';
  return null;
}

/** Epoch ms of the next local midnight (when a 'day-cap' pause lifts). */
export function nextLocalMidnight(nowMs: number): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}
