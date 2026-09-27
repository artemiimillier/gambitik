/**
 * Safety net for finished games when the local server is not reachable: the full GameRecord is parked in
 * localStorage under `gambit.unsavedGames` and re-sent the next time a game starts (POST /games is idempotent
 * by id, so a double send is harmless).
 */
import type { GameRecord } from '@gambit/shared';
import type { KeyValueStorage } from './gameTypes.ts';

export const UNSAVED_GAMES_KEY = 'gambit.unsavedGames';
/** A record with a long journal is 50–300 kB; localStorage holds ~5 MB. */
export const MAX_UNSAVED_GAMES = 8;

function isRecordLike(value: unknown): value is GameRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; pgn?: unknown; events?: unknown; judgements?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.pgn === 'string' && Array.isArray(candidate.events) && Array.isArray(candidate.judgements);
}

export function readUnsavedGames(storage: KeyValueStorage | null | undefined): GameRecord[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(UNSAVED_GAMES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRecordLike) : [];
  } catch {
    return [];
  }
}

function write(storage: KeyValueStorage, records: GameRecord[]): boolean {
  try {
    if (records.length === 0) storage.removeItem(UNSAVED_GAMES_KEY);
    else storage.setItem(UNSAVED_GAMES_KEY, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

/**
 * Parks a record. Keeps the newest {@link MAX_UNSAVED_GAMES}; when the quota is exceeded the oldest parked
 * games are dropped one by one until the new one fits. Returns false when it could not be stored at all.
 */
export function storeUnsavedGame(storage: KeyValueStorage | null | undefined, record: GameRecord): boolean {
  if (!storage) return false;
  let records = [...readUnsavedGames(storage).filter((r) => r.id !== record.id), record].slice(-MAX_UNSAVED_GAMES);
  while (records.length > 0) {
    if (write(storage, records)) return records.some((r) => r.id === record.id);
    if (records.length === 1) return false;
    records = records.slice(1);
  }
  return false;
}

export function removeUnsavedGame(storage: KeyValueStorage | null | undefined, id: string): void {
  if (!storage) return;
  const records = readUnsavedGames(storage);
  const rest = records.filter((r) => r.id !== id);
  if (rest.length !== records.length) write(storage, rest);
}

/** A 4xx answer means "this record will never be accepted" — unlike a network error it is not worth waiting for. */
export function isClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false;
  const status = error.status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

/**
 * Tries to deliver every parked game. A network / server failure stops the pass (the server is still down);
 * a record the server refuses (4xx) stays parked for inspection but does not block the ones behind it.
 * Returns how many were sent.
 */
export async function flushUnsavedGames(
  storage: KeyValueStorage | null | undefined,
  save: (record: GameRecord) => Promise<unknown>,
): Promise<number> {
  let sent = 0;
  for (const record of readUnsavedGames(storage)) {
    try {
      await save(record);
    } catch (error) {
      if (isClientError(error)) continue;
      break;
    }
    removeUnsavedGame(storage, record.id);
    sent += 1;
  }
  return sent;
}
