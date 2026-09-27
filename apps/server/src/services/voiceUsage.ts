/**
 * A tiny voice usage log so a parent can see what drives the spend (the Live API bills every
 * connected second, silence included). The browser reports increments with
 * `POST /api/voice/usage { provider, seconds }`; totals come back from `GET /api/voice/usage`.
 *
 * Stored in the kv table as `{ days: { 'YYYY-MM-DD': { <provider>: seconds } } }` (local calendar
 * days, the last ~13 months). Seconds only — no audio, no transcripts, nothing personal.
 */
import type { Repo } from '../storage/repo.ts';

export const VOICE_USAGE_PROVIDERS = ['openai-live', 'openai-realtime', 'browser-tts'] as const;
export type VoiceUsageProvider = (typeof VOICE_USAGE_PROVIDERS)[number];

export interface VoiceUsageTotals {
  todaySeconds: number;
  monthSeconds: number;
}

/** Answer of `GET /api/voice/usage`. */
export interface VoiceUsageSummary extends VoiceUsageTotals {
  /** local calendar day / month the totals refer to */
  today: string;
  month: string;
  byProvider: Partial<Record<VoiceUsageProvider, VoiceUsageTotals>>;
}

type DayUsage = Partial<Record<VoiceUsageProvider, number>>;

const KEEP_DAYS = 400;
/** the browser reports once per closed session: at most six hours; a day cannot have more than 24 h per provider */
export const MAX_REPORT_SECONDS = 21_600;
const MAX_DAY_SECONDS = 86_400;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProvider(value: string): value is VoiceUsageProvider {
  return (VOICE_USAGE_PROVIDERS as readonly string[]).includes(value);
}

export class VoiceUsageService {
  private readonly repo: Repo;
  private readonly now: () => Date;

  constructor(repo: Repo, now: () => Date = () => new Date()) {
    this.repo = repo;
    this.now = now;
  }

  /** Stored days, with anything malformed dropped. */
  private load(): Map<string, DayUsage> {
    const raw = this.repo.loadVoiceUsageRaw();
    const days = new Map<string, DayUsage>();
    if (!isRecord(raw) || !isRecord(raw.days)) return days;
    for (const [day, value] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isRecord(value)) continue;
      const usage: DayUsage = {};
      for (const [provider, seconds] of Object.entries(value)) {
        if (isProvider(provider) && typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) usage[provider] = Math.min(seconds, MAX_DAY_SECONDS);
      }
      days.set(day, usage);
    }
    return days;
  }

  record(provider: VoiceUsageProvider, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const add = Math.min(seconds, MAX_REPORT_SECONDS);
    this.repo.tx(() => {
      const days = this.load();
      const key = localDayKey(this.now());
      const day = days.get(key) ?? {};
      day[provider] = Math.min(MAX_DAY_SECONDS, Math.round(((day[provider] ?? 0) + add) * 10) / 10);
      days.set(key, day);
      const kept = [...days.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(-KEEP_DAYS);
      this.repo.saveVoiceUsage({ days: Object.fromEntries(kept) });
    });
  }

  summary(): VoiceUsageSummary {
    const today = localDayKey(this.now());
    const month = today.slice(0, 7);
    const byProvider: Partial<Record<VoiceUsageProvider, VoiceUsageTotals>> = {};
    let todaySeconds = 0;
    let monthSeconds = 0;
    for (const [day, usage] of this.load()) {
      if (!day.startsWith(month)) continue;
      for (const provider of VOICE_USAGE_PROVIDERS) {
        const seconds = usage[provider] ?? 0;
        if (seconds <= 0) continue;
        const totals = byProvider[provider] ?? { todaySeconds: 0, monthSeconds: 0 };
        totals.monthSeconds += seconds;
        monthSeconds += seconds;
        if (day === today) {
          totals.todaySeconds += seconds;
          todaySeconds += seconds;
        }
        byProvider[provider] = totals;
      }
    }
    const round = (n: number) => Math.round(n);
    for (const totals of Object.values(byProvider)) {
      totals.todaySeconds = round(totals.todaySeconds);
      totals.monthSeconds = round(totals.monthSeconds);
    }
    return { today, month, todaySeconds: round(todaySeconds), monthSeconds: round(monthSeconds), byProvider };
  }
}
