/**
 * The parent's routes of the progress screen (packages/shared/src/contracts.ts, «the child's progress»): every game
 * page by page, «играл взрослый / проверка», «Начать прогресс заново», the journal of one game. Same-origin JSON like
 * api/client.ts, rejecting with its ApiError; kept here so the shared client stays untouched by this screen.
 */
import { API_BASE } from '@gambit/shared';
import type { GameExclusionResponse, GameJournalResponse, GameListItem, ProgressResetResponse } from '@gambit/shared';
import { ApiError, AUTOMATION_HEADER } from '../../api/client.ts';
import type { RequestOptions } from '../../api/client.ts';
import { automationSilenced } from '../../automation.ts';

type Method = 'GET' | 'POST' | 'PUT';

async function call<T>(method: Method, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (automationSilenced()) headers[AUTOMATION_HEADER] = '1';
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: options.signal });
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError') throw cause;
    throw new ApiError({ status: 0, code: 'network', method, path, cause });
  }
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    if (response.ok) throw new ApiError({ status: response.status, code: 'bad-json', method, path, body: text });
  }
  if (!response.ok) {
    const code = typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string' ? parsed.error : `http-${response.status}`;
    throw new ApiError({ status: response.status, code, method, path, body: parsed });
  }
  return parsed as T;
}

/** `GET /games?limit=&offset=` — newest first, every game (the ones that do not count carry `excluded`). */
export function listGamesPage(limit: number, offset: number, options?: RequestOptions): Promise<GameListItem[]> {
  return call<GameListItem[]>('GET', `/games?limit=${limit}&offset=${offset}`, undefined, options);
}

/** `PUT /games/:id/excluded` — «играл взрослый / проверка» on (adult) or off (null); returns the recounted profile. */
export function setGameExcluded(gameId: string, excluded: 'adult' | null, options?: RequestOptions): Promise<GameExclusionResponse> {
  return call<GameExclusionResponse>('PUT', `/games/${encodeURIComponent(gameId)}/excluded`, { excluded }, options);
}

/** `POST /student/reset-progress` — archives the games that count now (never deletes them). */
export function resetProgress(options?: RequestOptions): Promise<ProgressResetResponse> {
  return call<ProgressResetResponse>('POST', '/student/reset-progress', { confirm: true }, options);
}

/** `GET /games/:id/journal` — the markdown journal of that one game. */
export function getGameJournal(gameId: string, options?: RequestOptions): Promise<GameJournalResponse> {
  return call<GameJournalResponse>('GET', `/games/${encodeURIComponent(gameId)}/journal`, undefined, options);
}
