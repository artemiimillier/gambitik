/**
 * Typed fetch helpers for the two voice routes the generic api client does not cover yet:
 *
 *   POST /api/voice/live   { sdp, voice? }        → LiveVoiceSessionResponse  (503 { error: 'no-api-key' } without a key;
 *                                                   502 { error, status, reason } — `reason` says why: 'net:ENOTFOUND' …)
 *   POST /api/voice/session { voice }             → VoiceSessionResponse (only the parent's «Послушать» names a voice;
 *                                                   the coach itself uses ../api/client.ts createVoiceSession)
 *   POST /api/voice/usage  { provider, seconds }  → best-effort cost bookkeeping, failures are ignored; when the page
 *                                                   closes it goes out with navigator.sendBeacon (text/plain JSON — the
 *                                                   server accepts that type on this one route, same-origin only)
 *   GET|PUT /api/voice/voices                     → VoiceChoiceInfo: the parent's pick of Гамбитик's voice (Settings)
 *
 * Same conventions as ../api/client.ts (which this module must not edit): same-origin `/api`, JSON,
 * rejections are `ApiError`, automation runs are marked with `X-Gambit-Automation` — and, as a second
 * lock, an automation run never even sends the request that would open a paid session.
 */
import { API_BASE } from '@gambit/shared';
import type { LiveVoiceSessionRequest, LiveVoiceSessionResponse, VoiceSessionResponse } from '@gambit/shared';
import { ApiError, AUTOMATION_HEADER } from '../api/client.ts';
import { automationSilenced } from '../automation.ts';
import { diag } from './voiceDiag.ts';
import type { OpenAiVoiceKind } from './voiceTypes.ts';

export const LIVE_SESSION_PATH = '/voice/live';
export const REALTIME_SESSION_PATH = '/voice/session';
export const VOICE_USAGE_PATH = '/voice/usage';
export const VOICE_CHOICE_PATH = '/voice/voices';

/** the server's short failure code (`reason` of a 502): 'net:UND_ERR_SOCKET', 'timeout', 'http:503' … — nothing else passes */
const REASON_RE = /^[A-Za-z0-9_.:-]{1,48}$/;

/** `reason` of an error body when it is a plain code, else null */
export function upstreamReason(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const reason = (body as Record<string, unknown>).reason;
  return typeof reason === 'string' && REASON_RE.test(reason) ? reason : null;
}

/** the server talks to OpenAI inside this request, so it gets more time than an ordinary route */
export const LIVE_SESSION_TIMEOUT_MS = 10_000;

export interface VoiceApiOptions {
  signal?: AbortSignal;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
  isSilenced?: () => boolean;
}

function headers(silenced: boolean): Record<string, string> {
  const result: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (silenced) result[AUTOMATION_HEADER] = '1';
  return result;
}

function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return outer;
  const timeout = AbortSignal.timeout(ms);
  if (!outer) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([outer, timeout]) : outer;
}

function isLiveResponse(value: unknown): value is LiveVoiceSessionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<LiveVoiceSessionResponse>;
  return v.provider === 'openai-live' && typeof v.sdp === 'string' && v.sdp !== '';
}

interface PostResult {
  status: number;
  parsed: unknown;
}

/** POST JSON to one of our voice routes; a failure is an ApiError with the code and the server's `reason` only */
async function postJson(path: string, body: unknown, silenced: boolean, options: VoiceApiOptions): Promise<PostResult> {
  const method = 'POST';
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${API_BASE}${path}`, {
      method,
      headers: headers(silenced),
      body: JSON.stringify(body),
      signal: timeoutSignal(LIVE_SESSION_TIMEOUT_MS, options.signal),
    });
  } catch (cause) {
    throw new ApiError({ status: 0, code: 'network', method, path, cause });
  }

  let text = '';
  try {
    text = await response.text();
  } catch (cause) {
    throw new ApiError({ status: response.status, code: 'network', method, path, cause });
  }
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    /* keep the raw text */
  }

  if (!response.ok) {
    const code =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string' && parsed.error !== ''
        ? parsed.error
        : `http-${response.status}`;
    // the body may carry upstream details: keep only the code and the server's own short reason, never text
    const reason = upstreamReason(parsed);
    if (reason !== null) diag('sess.upstream', { path, status: response.status, reason });
    throw new ApiError({ status: response.status, code, method, path, ...(reason !== null ? { body: { reason } } : {}) });
  }
  return { status: response.status, parsed };
}

/**
 * Sends the browser's SDP offer to OUR server, which creates the Live session with the real key and
 * returns OpenAI's SDP answer. The browser never sees a key or a client secret on this path.
 * `voice`: only the parent's «Послушать» names one; the coach's sessions use the stored pick.
 */
export async function createLiveVoiceSession(sdp: string, options: VoiceApiOptions & { voice?: string } = {}): Promise<LiveVoiceSessionResponse> {
  const path = LIVE_SESSION_PATH;
  const silenced = (options.isSilenced ?? automationSilenced)();
  // an automated browser never opens a paid session — it looks like a server without a key
  if (silenced) throw new ApiError({ status: 503, code: 'no-api-key', method: 'POST', path });

  const body: LiveVoiceSessionRequest & { voice?: string } = options.voice !== undefined ? { sdp, voice: options.voice } : { sdp };
  const { status, parsed } = await postJson(path, body, silenced, options);
  if (!isLiveResponse(parsed)) throw new ApiError({ status, code: 'bad-json', method: 'POST', path });
  return parsed;
}

function isRealtimeResponse(value: unknown): value is VoiceSessionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<VoiceSessionResponse>;
  return v.provider === 'openai-realtime' && typeof v.clientSecret === 'string' && v.clientSecret !== '';
}

/** The parent's «Послушать» on a server without Live: an ephemeral Realtime secret for one named voice. */
export async function createRealtimeVoiceSession(options: VoiceApiOptions & { voice?: string } = {}): Promise<VoiceSessionResponse> {
  const path = REALTIME_SESSION_PATH;
  const silenced = (options.isSilenced ?? automationSilenced)();
  if (silenced) throw new ApiError({ status: 503, code: 'no-api-key', method: 'POST', path });
  const { status, parsed } = await postJson(path, options.voice !== undefined ? { voice: options.voice } : {}, silenced, options);
  if (!isRealtimeResponse(parsed)) throw new ApiError({ status, code: 'bad-json', method: 'POST', path });
  return parsed;
}

// ───────────────────────── the parent's pick of the voice ─────────────────────────

/** One voice of the picker: which of the two paid models can speak with it. */
export interface VoiceOption {
  id: string;
  live: boolean;
  realtime: boolean;
}

/** `GET|PUT /api/voice/voices` — the voice Гамбитик speaks with (apps/server/src/voice/voices.ts). */
export interface VoiceChoiceInfo {
  /** the parent's pick; null = none yet (the server's .env voices apply, `marin` by default) */
  selected: string | null;
  /** what the next Live / Realtime session will use */
  live: string;
  realtime: string;
  defaults: { live: string; realtime: string };
  voices: VoiceOption[];
}

const VOICE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Tolerant reader: anything malformed is dropped; null when the answer is not a choice at all (an older server). */
export function parseVoiceChoice(body: unknown): VoiceChoiceInfo | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const id = (value: unknown): string | null => (typeof value === 'string' && VOICE_ID_RE.test(value) ? value : null);
  const live = id(raw.live);
  const realtime = id(raw.realtime);
  const defaults = typeof raw.defaults === 'object' && raw.defaults !== null ? (raw.defaults as Record<string, unknown>) : {};
  if (live === null || realtime === null || !Array.isArray(raw.voices)) return null;
  const voices: VoiceOption[] = [];
  for (const entry of raw.voices as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const v = entry as Record<string, unknown>;
    const voiceId = id(v.id);
    if (voiceId !== null) voices.push({ id: voiceId, live: v.live === true, realtime: v.realtime === true });
  }
  return {
    selected: id(raw.selected),
    live,
    realtime,
    defaults: { live: id(defaults.live) ?? live, realtime: id(defaults.realtime) ?? realtime },
    voices,
  };
}

async function voiceChoiceRequest(method: 'GET' | 'PUT', body: unknown, options: VoiceApiOptions): Promise<VoiceChoiceInfo | null> {
  const silenced = (options.isSilenced ?? automationSilenced)();
  const path = VOICE_CHOICE_PATH;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${API_BASE}${path}`, {
      method,
      headers: headers(silenced),
      ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}),
      signal: timeoutSignal(5000, options.signal),
    });
  } catch (cause) {
    throw new ApiError({ status: 0, code: 'network', method, path, cause });
  }
  // an older server without the route: no picker
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError({ status: response.status, code: `http-${response.status}`, method, path });
  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch (cause) {
    throw new ApiError({ status: response.status, code: 'bad-json', method, path, cause });
  }
  return parseVoiceChoice(parsed);
}

/** The voices and the parent's pick; null = the server has no picker (older version). */
export function getVoiceChoice(options: VoiceApiOptions = {}): Promise<VoiceChoiceInfo | null> {
  return voiceChoiceRequest('GET', undefined, options);
}

/** Stores the parent's pick (null = the server's default again). Automated runs change nothing on the server. */
export function saveVoiceChoice(voice: string | null, options: VoiceApiOptions = {}): Promise<VoiceChoiceInfo | null> {
  return voiceChoiceRequest('PUT', { voice }, options);
}

export interface ReportUsageOptions extends VoiceApiOptions {
  /** the page is closing ('pagehide'): send with navigator.sendBeacon, which outlives the page */
  beacon?: boolean;
  /** injectable for tests; defaults to `navigator.sendBeacon` */
  sendBeacon?: (url: string, data: string) => boolean;
}

function browserBeacon(): ((url: string, data: string) => boolean) | null {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return null;
  return (url, data) => navigator.sendBeacon(url, data);
}

/** Tells the server how long a paid voice session lasted. Best effort: never throws, never blocks. */
export function reportVoiceUsage(provider: OpenAiVoiceKind, seconds: number, options: ReportUsageOptions = {}): void {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded === 0 || !Number.isFinite(rounded)) return;
  const silenced = (options.isSilenced ?? automationSilenced)();
  if (silenced) return; // nothing paid ever ran
  const url = `${API_BASE}${VOICE_USAGE_PATH}`;
  const body = JSON.stringify({ provider, seconds: rounded });
  if (options.beacon) {
    // A string body is sent as text/plain (a "simple" request, never preflighted) — the one type besides JSON the
    // server accepts on this route, and only from our own origin. A refused / missing beacon falls back to keepalive.
    try {
      const send = options.sendBeacon ?? browserBeacon();
      if (send?.(url, body) === true) return;
    } catch {
      /* fall through to fetch */
    }
  }
  try {
    void (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: headers(false),
      body,
      // the page may be closing: let the request outlive it
      keepalive: true,
      signal: timeoutSignal(5000),
    }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    /* fetch is missing or threw synchronously: bookkeeping only */
  }
}
