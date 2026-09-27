/**
 * Typed fetch wrappers for every REST route listed at the bottom of
 * packages/shared/src/contracts.ts. All requests are same-origin (`/api/...`):
 * in dev Vite proxies them to the local server, in prod the server serves the SPA itself.
 *
 * Every function rejects with an {@link ApiError} on a non-2xx answer, a network
 * failure or a malformed JSON body. Aborting via `signal` rethrows the native AbortError.
 */
import { API_BASE } from '@gambit/shared';
import { automationSilenced, isAutomatedBrowser } from '../automation.ts';
import type {
  ClipGenRequest,
  ClipGenRequestResult,
  ClipGenSettings,
  ClipGenStatus,
  CoachEvent,
  ConceptCard,
  CurriculumStage,
  GameListItem,
  GameRecord,
  GameReview,
  GameStrategy,
  GameThought,
  GameThoughtsResponse,
  HealthInfo,
  LiveVoiceSessionResponse,
  ProgressSnapshot,
  Puzzle,
  PuzzleAttempt,
  ReplanRequest,
  ReplanResponse,
  StrategyRequest,
  StudentProfile,
  ThemeSkill,
  VoiceSessionResponse,
} from '@gambit/shared';

// ───────────────────────── request / response shapes ─────────────────────────

/** Body of `PUT /student`. */
export type StudentUpdate = Partial<Pick<StudentProfile, 'nickname' | 'address' | 'stage'>>;

export interface SaveGameResponse {
  id: string;
}

export interface PuzzleAttemptResponse {
  puzzleRating: ThemeSkill;
}

export interface CurriculumResponse {
  stages: CurriculumStage[];
  /** current stage number of the student */
  current: number;
}

export interface RephraseResponse {
  text: string;
  provider: string;
}

/**
 * `GET /games/:id/review` — the contract type plus two OPTIONAL fields: what the reviewer suggests to practise next.
 * A server may omit them.
 */
export interface GameReviewWithAdvice extends GameReview {
  /** lichess theme key, e.g. 'fork'; null / absent = no suggestion */
  suggestedTheme?: string | null;
  /** 1–3 short Russian takeaways */
  keyTakeaways?: string[];
}

/** `GET /voice/usage` — how long the paid live voice was connected (seconds). */
export interface VoiceUsage {
  todaySeconds: number;
  monthSeconds: number;
  /** month seconds per provider key, e.g. { 'openai-live': 310, 'openai-realtime': 45 } */
  byProvider: Record<string, number>;
}

export interface NextPuzzlesQuery {
  /** lichess theme key; omitted = adaptive mix */
  theme?: string;
  count?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/** A request that must not hang: `timeoutMs` (default per route) ends it with `ApiError { code: 'timeout' }`. */
export interface TimedRequestOptions extends RequestOptions {
  timeoutMs?: number;
}

// ───────────────────────── errors ─────────────────────────

/**
 * - `'network'`  — fetch itself failed (server not running, offline); `status` is 0
 * - `'timeout'`  — a timed request (`TimedRequestOptions.timeoutMs`) got no answer in time; `status` is 0
 * - `'bad-json'` — 2xx answer whose body is not valid JSON
 * - otherwise the server's `{ error: string }` value (e.g. `'no-api-key'`), or `'http-<status>'`
 */
export type ApiErrorCode = 'network' | 'bad-json' | (string & {});

export interface ApiErrorInit {
  status: number;
  code: ApiErrorCode;
  method: string;
  path: string;
  body?: unknown;
  cause?: unknown;
}

export class ApiError extends Error {
  /** HTTP status; 0 when the request never reached the server */
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly method: string;
  /** path relative to the API base, e.g. `/games/abc` */
  readonly path: string;
  /** parsed JSON error body when there was one, else the raw text (may be empty) */
  readonly body: unknown;

  constructor(init: ApiErrorInit) {
    super(`${init.method} ${API_BASE}${init.path} failed: ${init.status === 0 ? init.code : `${init.status} ${init.code}`}`, {
      cause: init.cause,
    });
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.method = init.method;
    this.path = init.path;
    this.body = init.body;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// ───────────────────────── core request helper ─────────────────────────

type HttpMethod = 'GET' | 'POST' | 'PUT';

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function errorCodeFromBody(body: unknown, status: number): ApiErrorCode {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' && body.error !== '') {
    return body.error;
  }
  return `http-${status}`;
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * A browser driven by automation (Playwright & co, see ../automation.ts) marks its requests, and the server then
 * never spends money on them: template game reviews only, no voice session, no LLM rephrase.
 */
export const AUTOMATION_HEADER = 'X-Gambit-Automation';

/**
 * Accounts (the public site): the account this page belongs to, repeated on every request — a tab of a child who
 * signed out in another tab is told `account-changed` instead of writing into the next child's account.
 */
export const ACCOUNT_HEADER = 'X-Gambit-Account';
let pageAccount: string | null = null;

export function setPageAccount(account: string | null): void {
  pageAccount = account;
}

export function pageAccountHeader(): Record<string, string> {
  return pageAccount === null ? {} : { [ACCOUNT_HEADER]: pageAccount };
}

function requestHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...pageAccountHeader() };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (automationSilenced()) headers[AUTOMATION_HEADER] = '1';
  return headers;
}

/** Accounts (the public site): what to do when the server says the session is gone (set by app/account/accountSession.ts). */
let authRequired: (() => void) | null = null;

/** Registers the reaction to `401 auth-required` (the page goes back to the sign-in door). Never set on the family server. */
export function onAuthRequired(handler: (() => void) | null): void {
  authRequired = handler;
}

async function request<T>(method: HttpMethod, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const hasBody = body !== undefined;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: requestHeaders(hasBody),
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: options.signal,
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiError({ status: 0, code: 'network', method, path, cause });
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiError({ status: response.status, code: 'network', method, path, cause });
  }

  if (!response.ok) {
    const errorBody = parseJsonOrText(text);
    const code = errorCodeFromBody(errorBody, response.status);
    if (response.status === 401 && (code === 'auth-required' || code === 'account-changed')) authRequired?.();
    throw new ApiError({ status: response.status, code, method, path, body: errorBody });
  }

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ApiError({ status: response.status, code: 'bad-json', method, path, body: text, cause });
  }
}

/**
 * `request` with a deadline: the caller's `signal` still aborts it (the native AbortError comes back untouched), and
 * after `timeoutMs` the fetch is aborted and the promise rejects with `ApiError { status: 0, code: 'timeout' }`.
 */
async function timedRequest<T>(method: HttpMethod, path: string, body: unknown, options: TimedRequestOptions, defaultTimeoutMs: number): Promise<T> {
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : defaultTimeoutMs;
  const outer = options.signal;
  if (outer?.aborted) throw outer.reason instanceof Error ? outer.reason : new DOMException('The operation was aborted.', 'AbortError');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await request<T>(method, path, body, { signal: controller.signal });
  } catch (error) {
    if (timedOut && !(outer?.aborted ?? false)) throw new ApiError({ status: 0, code: 'timeout', method, path, cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query === '' ? path : `${path}?${query}`;
}

// ───────────────────────── routes ─────────────────────────

/** `GET /health` — which optional upgrades (LLM, realtime voice) are available. */
export function getHealth(options?: RequestOptions): Promise<HealthInfo> {
  return request<HealthInfo>('GET', '/health', undefined, options);
}

/** `GET /student` */
export function getStudent(options?: RequestOptions): Promise<StudentProfile> {
  return request<StudentProfile>('GET', '/student', undefined, options);
}

/** `PUT /student` — returns the updated profile. */
export function updateStudent(update: StudentUpdate, options?: RequestOptions): Promise<StudentProfile> {
  return request<StudentProfile>('PUT', '/student', update, options);
}

/** `POST /games` — persists a finished game (PGN + journal), updates the profile, enqueues the review. */
export function saveGame(record: GameRecord, options?: RequestOptions): Promise<SaveGameResponse> {
  return request<SaveGameResponse>('POST', '/games', record, options);
}

/**
 * `POST /games/:id/thoughts` — the child's words about a game that come after its record was saved (the talk after the
 * game, a late diary answer). Idempotent by thought id; 409 `too-old` outside the newest few games.
 */
export function appendGameThoughts(gameId: string, thoughts: GameThought[], options?: RequestOptions): Promise<GameThoughtsResponse> {
  return request<GameThoughtsResponse>('POST', `/games/${encodeURIComponent(gameId)}/thoughts`, { thoughts }, options);
}

/** `GET /games?limit=` — newest first. */
export function listGames(limit = 50, options?: RequestOptions): Promise<GameListItem[]> {
  return request<GameListItem[]>('GET', withQuery('/games', { limit }), undefined, options);
}

/** `GET /games/:id` */
export function getGame(gameId: string, options?: RequestOptions): Promise<GameRecord> {
  return request<GameRecord>('GET', `/games/${encodeURIComponent(gameId)}`, undefined, options);
}

/** `GET /games/:id/review` — poll while `status === 'pending'`. */
export function getGameReview(gameId: string, options?: RequestOptions): Promise<GameReviewWithAdvice> {
  return request<GameReviewWithAdvice>('GET', `/games/${encodeURIComponent(gameId)}/review`, undefined, options);
}

/** `GET /progress` */
export function getProgress(options?: RequestOptions): Promise<ProgressSnapshot> {
  return request<ProgressSnapshot>('GET', '/progress', undefined, options);
}

/** `GET /puzzles/next?theme=&count=` — adaptive to the student's rating. */
export function nextPuzzles(query: NextPuzzlesQuery = {}, options?: RequestOptions): Promise<Puzzle[]> {
  return request<Puzzle[]>('GET', withQuery('/puzzles/next', { theme: query.theme, count: query.count }), undefined, options);
}

/** `POST /puzzles/attempt` — returns the student's updated overall puzzle rating. */
export function submitPuzzleAttempt(attempt: PuzzleAttempt, options?: RequestOptions): Promise<PuzzleAttemptResponse> {
  return request<PuzzleAttemptResponse>('POST', '/puzzles/attempt', attempt, options);
}

/** `GET /curriculum` */
export function getCurriculum(options?: RequestOptions): Promise<CurriculumResponse> {
  return request<CurriculumResponse>('GET', '/curriculum', undefined, options);
}

/** `GET /kb/:id` */
export function getConceptCard(cardId: string, options?: RequestOptions): Promise<ConceptCard> {
  return request<ConceptCard>('GET', `/kb/${encodeURIComponent(cardId)}`, undefined, options);
}

/**
 * `POST /voice/session` — mints an ephemeral realtime-voice secret.
 * Without an API key on the server this rejects with `ApiError { status: 503, code: 'no-api-key' }`.
 */
export function createVoiceSession(options?: RequestOptions): Promise<VoiceSessionResponse> {
  return request<VoiceSessionResponse>('POST', '/voice/session', {}, options);
}

/**
 * `POST /voice/live` — full-duplex Live API: the browser's SDP offer goes to OUR server, which opens the
 * session with the real key and returns OpenAI's SDP answer. The key never reaches the browser.
 * Without an API key this rejects with `ApiError { status: 503, code: 'no-api-key' }`.
 */
export function createLiveVoiceSession(sdp: string, options?: RequestOptions): Promise<LiveVoiceSessionResponse> {
  return request<LiveVoiceSessionResponse>('POST', '/voice/live', { sdp }, options);
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Tolerant reader of the usage body: anything that is not a non-negative number counts as 0. */
export function parseVoiceUsage(body: unknown): VoiceUsage | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const byProvider: Record<string, number> = {};
  if (typeof raw.byProvider === 'object' && raw.byProvider !== null && !Array.isArray(raw.byProvider)) {
    for (const [provider, seconds] of Object.entries(raw.byProvider as Record<string, unknown>)) byProvider[provider] = nonNegative(seconds);
  }
  return { todaySeconds: nonNegative(raw.todaySeconds), monthSeconds: nonNegative(raw.monthSeconds), byProvider };
}

/**
 * `GET /voice/usage` — seconds of paid live voice today / this month.
 * Resolves to `null` when the server does not know this route yet (404) — the caller then shows no numbers.
 */
export async function getVoiceUsage(options?: RequestOptions): Promise<VoiceUsage | null> {
  try {
    return parseVoiceUsage(await request<unknown>('GET', '/voice/usage', undefined, options));
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null;
    throw error;
  }
}

// ───────────────────────── «Дозапись голоса»: recording missing lesson phrases (docs/voice-clips/ONDEMAND.md) ─────────────────────────

/** Default deadlines: a request is only queued by the server (it answers at once), the status is read from memory. */
export const CLIP_GEN_REQUEST_TIMEOUT_MS = 8_000;
export const CLIP_GEN_STATUS_TIMEOUT_MS = 4_000;

/**
 * `POST /voice/clips/request` — the ids of the sentences an utterance could not voice (never text: the server renders
 * the words itself). An automated browser NEVER sends it (resolves null before any fetch — stricter than the
 * automation header, which an e2e voice opt-in keeps); the server refuses the header anyway. 503 `clip-gen-off` /
 * `automation`, 429 `clip-gen-rate`, 400 `invalid-body` reject as `ApiError`.
 */
export function requestClipGen(body: ClipGenRequest, options: TimedRequestOptions = {}): Promise<ClipGenRequestResult | null> {
  if (isAutomatedBrowser()) return Promise.resolve(null);
  return timedRequest<ClipGenRequestResult>('POST', '/voice/clips/request', body, options, CLIP_GEN_REQUEST_TIMEOUT_MS);
}

/** `GET /voice/clips/status` — the parent's card and the poller (answers also when recording is off). */
export function getClipGenStatus(options: TimedRequestOptions = {}): Promise<ClipGenStatus> {
  return timedRequest<ClipGenStatus>('GET', '/voice/clips/status', undefined, options, CLIP_GEN_STATUS_TIMEOUT_MS);
}

/**
 * `PUT /voice/clips/settings` — the parent's switch and daily cap (milli-credits, never above the env's maximum: the
 * server refuses a higher one with 400). Answers the new status; under automation the server stores nothing and
 * answers the old one.
 */
export function saveClipGenSettings(settings: ClipGenSettings, options: TimedRequestOptions = {}): Promise<ClipGenStatus> {
  return timedRequest<ClipGenStatus>('PUT', '/voice/clips/settings', settings, options, CLIP_GEN_STATUS_TIMEOUT_MS);
}

/**
 * The server's own budget for `POST /coach/strategy` is ≤ 8 s (smart strategist openrouter → openai-api → codex →
 * template — the fast APIs first, the game's first line waits for it): the
 * browser gives up a little later. The game never waits that long for its first line (`GameTimings.strategyWaitMs`) —
 * a late strategy is used from the next move.
 */
export const STRATEGY_TIMEOUT_MS = 9_000;
/** A re-plan older than this is useless: the child has moved on twice by then. (The server answers ≤ 15.3 s: codex first.) */
export const REPLAN_TIMEOUT_MS = 16_000;

/**
 * `POST /coach/strategy` — «Учитель»: which strategy of the curated library this game is played with, and the one
 * line that announces it («В этот раз разыграем …, поэтому начни …»). The wizard prefetches it as soon as colour,
 * opponent and time control are known (features/game/strategy.ts). Rejects with `ApiError { code: 'timeout' }`
 * after `timeoutMs` (default {@link STRATEGY_TIMEOUT_MS}).
 */
export function getStrategy(body: StrategyRequest, options: TimedRequestOptions = {}): Promise<GameStrategy> {
  return timedRequest<GameStrategy>('POST', '/coach/strategy', body, options, STRATEGY_TIMEOUT_MS);
}

/**
 * `POST /coach/replan` — «Учитель»: the smart model re-plans after the opponent left the plan or the phase changed.
 * It may only CHOOSE one of the engine candidates of the request (the caller checks that again); the answer carries the
 * request's `ply` so a stale one can be dropped. Default timeout {@link REPLAN_TIMEOUT_MS}.
 */
export function replan(body: ReplanRequest, options: TimedRequestOptions = {}): Promise<ReplanResponse> {
  return timedRequest<ReplanResponse>('POST', '/coach/replan', body, options, REPLAN_TIMEOUT_MS);
}

/**
 * `POST /coach/rephrase` — optional LLM polish; the server falls back to `event.text`.
 *
 * Deliberately NOT called by the app: in-game phrases are code-proven templates that are
 * spoken verbatim, so the child hears them at once and never waits for an LLM. The wrapper stays so the route of
 * the contract keeps a typed client (and its test); wire it only for non-urgent phrases behind a parent setting.
 */
export function rephraseCoachEvent(event: CoachEvent, options?: RequestOptions): Promise<RephraseResponse> {
  return request<RephraseResponse>('POST', '/coach/rephrase', { event }, options);
}
