/**
 * What the «Записи» voice remembers between page loads (docs/voice-clips/SPEC.md §6.2, §7.3, §8.1) — all in
 * localStorage, all inside try/catch, and every read may come back empty (private mode, cleared storage). None of it
 * is needed for the voice to work; it only makes it better.
 *
 *  - `gambit.clipRecency`: the takes heard lately (≤ 240 ids ≈ 3.8 KB) — no identical take within 10 plays of its
 *    pool (20 for greeting / game start / game end), across games;
 *  - `gambit.clipStats`: the last finished game's coverage — «прошлая партия: 96 % записями» in Settings;
 *  - `gambit.clipMisses`: which units were missing and how often (L2–L6) — for `pnpm voice:fill --from-misses` later.
 *    Local only: keys of compiled fragments are Russian text and never go to the black box.
 */
import { CLIP_ID_RE } from '@gambit/core';
import type { ClipMiss } from '@gambit/core';
import type { SettingsStorage } from '../settings.ts';
import { CLIP_MISSES_STORAGE_KEY, CLIP_RECENCY_STORAGE_KEY, CLIP_STATS_STORAGE_KEY } from './clipFlags.ts';

function readJson(storage: SettingsStorage | null | undefined, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: SettingsStorage | null | undefined, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // quota / private mode: simply not remembered
  }
}

// ───────────────────────── recency ─────────────────────────

export function readRecency(storage: SettingsStorage | null | undefined): string[] {
  const raw = readJson(storage, CLIP_RECENCY_STORAGE_KEY);
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && CLIP_ID_RE.test(id)) : [];
}

export function writeRecency(storage: SettingsStorage | null | undefined, ids: readonly string[]): void {
  writeJson(storage, CLIP_RECENCY_STORAGE_KEY, ids.filter((id) => CLIP_ID_RE.test(id)));
}

// ───────────────────────── per-game coverage ─────────────────────────

/**
 * One game's utterances: voiced from recordings as written (L1–L4), by a generic line (L5), or not at all (L6).
 * `late` («Дозапись голоса» G2): silent ones that were played after all, their recording having arrived while the bubble
 * was still up — they stay counted as silent (the child waited for them).
 */
export interface ClipGameStats {
  utterances: number;
  recorded: number;
  generic: number;
  silent: number;
  late: number;
}

export interface StoredClipStats extends ClipGameStats {
  /** ISO time the game ended */
  at: string;
  timeControlId: string;
}

export function emptyGameStats(): ClipGameStats {
  return { utterances: 0, recorded: 0, generic: 0, silent: 0, late: 0 };
}

/** «96 %»: the share voiced by recordings as written; null without utterances. */
export function recordedPercent(stats: Pick<ClipGameStats, 'utterances' | 'recorded'> | null | undefined): number | null {
  if (!stats || stats.utterances <= 0) return null;
  return Math.round((100 * stats.recorded) / stats.utterances);
}

export function readClipStats(storage: SettingsStorage | null | undefined): StoredClipStats | null {
  const raw = readJson(storage, CLIP_STATS_STORAGE_KEY) as Partial<StoredClipStats> | null;
  if (!raw || typeof raw !== 'object') return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const stats: StoredClipStats = {
    utterances: n(raw.utterances),
    recorded: n(raw.recorded),
    generic: n(raw.generic),
    silent: n(raw.silent),
    late: n(raw.late),
    at: typeof raw.at === 'string' ? raw.at : '',
    timeControlId: typeof raw.timeControlId === 'string' ? raw.timeControlId : '',
  };
  return stats.utterances > 0 ? stats : null;
}

export function writeClipStats(storage: SettingsStorage | null | undefined, stats: StoredClipStats): void {
  if (stats.utterances > 0) writeJson(storage, CLIP_STATS_STORAGE_KEY, stats);
}

// ───────────────────────── the miss log ─────────────────────────

export const CLIP_MISS_LOG_MAX_KEYS = 300;

export interface ClipMissLog {
  v: 1;
  /** `<level>|<unit key>` → how often */
  counts: Record<string, number>;
}

export function readClipMisses(storage: SettingsStorage | null | undefined): ClipMissLog {
  const raw = readJson(storage, CLIP_MISSES_STORAGE_KEY) as Partial<ClipMissLog> | null;
  const counts: Record<string, number> = {};
  if (raw && typeof raw === 'object' && raw.counts && typeof raw.counts === 'object') {
    for (const [key, value] of Object.entries(raw.counts)) if (typeof value === 'number' && Number.isFinite(value) && value > 0) counts[key] = Math.floor(value);
  }
  return { v: 1, counts };
}

/** Adds misses (L2–L6); the log keeps its most frequent `CLIP_MISS_LOG_MAX_KEYS` keys. */
export function recordClipMisses(storage: SettingsStorage | null | undefined, misses: readonly ClipMiss[]): void {
  if (!storage || misses.length === 0) return;
  const log = readClipMisses(storage);
  for (const miss of misses) {
    const key = `${miss.level}|${miss.key}`.slice(0, 200);
    log.counts[key] = (log.counts[key] ?? 0) + 1;
  }
  const entries = Object.entries(log.counts);
  if (entries.length > CLIP_MISS_LOG_MAX_KEYS) {
    entries.sort((a, b) => b[1] - a[1]);
    log.counts = Object.fromEntries(entries.slice(0, CLIP_MISS_LOG_MAX_KEYS));
  }
  writeJson(storage, CLIP_MISSES_STORAGE_KEY, log);
}

/**
 * The coarse, Latin-only class of a missing unit for the black box (`voiceDiag` refuses Russian): a slot key is
 * Latin and kept (`slot:ins:n:f6`), a line key keeps its line id, a fragment or anything else is only named.
 */
export function missDiagKey(key: string): string {
  if (key === 'library') return 'library';
  if (key.startsWith('slot:')) return key.slice(0, 40);
  if (key.startsWith('line:')) return `line:${key.slice(5).replace(/[@/#]/g, '.')}`.replace(/[^A-Za-z0-9 _.:/+()-]/g, '').slice(0, 64);
  if (key.startsWith('frag:')) return 'frag';
  if (key.startsWith('san:')) return key.slice(0, 16);
  if (key.startsWith('text:')) return key.slice(0, 24);
  return key === 'shape' ? 'shape' : 'other';
}

// ───────────────────────── the child's name ─────────────────────────

const CYRILLIC_NAME_RE = /^[А-Яа-яЁё][А-Яа-яЁё \-]{0,23}$/;
const PROFILE_KEYS = ['gambit.profile.cache', 'gambit.studentCache'] as const;

/**
 * The child's name as the templates say it (Cyrillic only — the same rule as core's `speakableName`), from the
 * profile the shell / the game cached. Clips never say names: the compiler strips it from `event.text`.
 */
export function cachedChildName(storage: SettingsStorage | null | undefined): string | undefined {
  for (const key of PROFILE_KEYS) {
    const raw = readJson(storage, key) as { nickname?: unknown } | null;
    const name = raw && typeof raw.nickname === 'string' ? raw.nickname.trim() : '';
    if (CYRILLIC_NAME_RE.test(name)) return name;
  }
  return undefined;
}
