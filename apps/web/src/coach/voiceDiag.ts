/**
 * Voice black box — a small flight recorder of what the voice pipeline did, for the family's real Chrome, where nobody
 * can look at the screen (when the child cannot hear him, or he cannot hear the child).
 *
 *   diag('out.play', { ok: false, err: 'NotAllowedError' })   → ring buffer (last 400 entries, `voiceDiagRecent()`)
 *                                                              → every 5 s a batch → POST /api/voice/diag (JSON)
 *                                                              → on 'pagehide' the rest → navigator.sendBeacon (text/plain)
 *   the server appends JSON lines to <DATA_DIR>/voice-diag.log (2 MB, one rotation).
 *
 * PRIVACY BY CONSTRUCTION: an entry is an event name plus a few short fields; a string field must match
 * `DIAG_STRING_RE` (Latin letters, digits and a little punctuation, ≤ 64 characters) or it is replaced by '?'. The
 * child's and the coach's words are Russian (Cyrillic) and can never pass — no transcripts, no names, no SDP, no keys.
 * The server validates the same rules again (apps/server/src/routes/diag.ts).
 *
 * Off under automation (`navigator.webdriver`: e2e / smoke runs never write the family's log) and outside a browser —
 * except an automated run that opted into the real «Записи» layer (`gambit.e2eClips`, clips/clipFlags.ts): there the
 * black box records IN MEMORY ONLY (never posted, never beaconed), so the run can read `clip.plan` / `clip.end`.
 * For a curious parent in the console: `__gambitVoiceDiag.recent()`.
 */
import { API_BASE } from '@gambit/shared';
import { isAutomatedBrowser } from '../automation.ts';
import { e2eClipsOptIn } from './clips/clipFlags.ts';

export type DiagValue = string | number | boolean | null;

export interface VoiceDiagEntry {
  /** ms since the page started recording (small numbers, sortable) */
  t: number;
  /** event name, e.g. 'sess.connected' */
  e: string;
  [field: string]: DiagValue;
}

export const VOICE_DIAG_PATH = '/voice/diag';
export const DIAG_FLUSH_MS = 5000;
export const DIAG_RING_SIZE = 400;
export const DIAG_BATCH_MAX = 200;
export const DIAG_MAX_FIELDS = 16;
/** the only strings that may leave the page: codes, error names, Latin reasons — never Russian text */
export const DIAG_STRING_RE = /^[A-Za-z0-9 _.:/+()-]{0,64}$/;
export const DIAG_EVENT_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
export const DIAG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,23}$/;
export const DIAG_PAGE_RE = /^[a-z0-9-]{4,40}$/;

export interface VoiceDiagBatch {
  /** a random id of this page load (groups the lines of one visit) */
  page: string;
  events: VoiceDiagEntry[];
}

export interface VoiceDiagOptions {
  enabled?: boolean;
  /** record in the ring only, never send (default: an automated run with the `gambit.e2eClips` opt-in) */
  localOnly?: boolean;
  now?: () => number;
  /** POST the JSON batch (default: fetch keepalive); rejects / false = keep the events for the next try */
  post?: (json: string) => Promise<boolean>;
  /** the page is closing (default: navigator.sendBeacon, text/plain) */
  beacon?: (json: string) => boolean;
  /** installs the page listeners (default: window 'pagehide' + document 'visibilitychange'); returns an uninstaller */
  listenPage?: (onLeave: () => void) => () => void;
  flushMs?: number;
}

interface DiagState {
  enabled: boolean;
  localOnly: boolean;
  now: () => number;
  post: (json: string) => Promise<boolean>;
  beacon: (json: string) => boolean;
  listenPage: (onLeave: () => void) => () => void;
  flushMs: number;
  page: string;
  startedAt: number;
  recent: VoiceDiagEntry[];
  pending: VoiceDiagEntry[];
  timer: ReturnType<typeof setTimeout> | null;
  posting: boolean;
  unlisten: (() => void) | null;
  opened: boolean;
}

function randomPageId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID().slice(0, 13);
  } catch {
    /* fall through */
  }
  return `p-${Math.random().toString(36).slice(2, 12)}`;
}

function defaultPost(json: string): Promise<boolean> {
  if (typeof fetch !== 'function') return Promise.resolve(false);
  return fetch(`${API_BASE}${VOICE_DIAG_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: json,
    keepalive: true,
  }).then(
    (response) => response.ok,
    () => false,
  );
}

function defaultBeacon(json: string): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
    // a string body goes out as text/plain — the server takes that type on this route only, same-origin only
    return navigator.sendBeacon(`${API_BASE}${VOICE_DIAG_PATH}`, json);
  } catch {
    return false;
  }
}

function defaultListenPage(onLeave: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  const onHide = (): void => onLeave();
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') onLeave();
  };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

function defaultEnabled(): boolean {
  try {
    return typeof window !== 'undefined' && typeof document !== 'undefined' && !isAutomatedBrowser();
  } catch {
    return false;
  }
}

/** An automated run that asked for the real clips layer: the black box in memory, for that run to read. */
function defaultLocalOnly(): boolean {
  try {
    return typeof window !== 'undefined' && typeof document !== 'undefined' && isAutomatedBrowser() && e2eClipsOptIn();
  } catch {
    return false;
  }
}

function makeState(options: VoiceDiagOptions = {}): DiagState {
  const now = options.now ?? (() => Date.now());
  const localOnly = options.localOnly ?? (options.enabled === undefined && defaultLocalOnly());
  return {
    enabled: options.enabled ?? (localOnly || defaultEnabled()),
    localOnly,
    now,
    post: options.post ?? defaultPost,
    beacon: options.beacon ?? defaultBeacon,
    listenPage: options.listenPage ?? defaultListenPage,
    flushMs: options.flushMs ?? DIAG_FLUSH_MS,
    page: randomPageId(),
    startedAt: now(),
    recent: [],
    pending: [],
    timer: null,
    posting: false,
    unlisten: null,
    opened: false,
  };
}

let current: DiagState | null = null;

function state(): DiagState {
  current ??= makeState();
  return current;
}

/** A string that may leave the page, or '?' (Cyrillic, long or odd text never passes). */
export function diagString(value: string): string {
  return DIAG_STRING_RE.test(value) ? value : '?';
}

/** `error.name` of an Error / DOMException ('NotAllowedError', 'AbortError' …), else 'Error' */
export function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' && error.name !== '') return diagString(error.name.slice(0, 40));
  return 'Error';
}

function sanitize(data: Record<string, DiagValue | undefined>): Record<string, DiagValue> {
  const out: Record<string, DiagValue> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(data)) {
    if (raw === undefined || key === 't' || key === 'e' || !DIAG_KEY_RE.test(key)) continue;
    if (count >= DIAG_MAX_FIELDS) break;
    let value: DiagValue;
    if (typeof raw === 'number') value = Number.isFinite(raw) ? Math.round(raw * 1000) / 1000 : null;
    else if (typeof raw === 'string') value = diagString(raw);
    else value = raw;
    out[key] = value;
    count += 1;
  }
  return out;
}

function browserFacts(): Record<string, DiagValue> {
  if (typeof navigator === 'undefined') return {};
  const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  const chrome = /(?:Chrome|Chromium)\/(\d+)/.exec(ua)?.[1];
  const safari = /Version\/(\d+)[^ ]* Safari/.exec(ua)?.[1];
  const firefox = /Firefox\/(\d+)/.exec(ua)?.[1];
  const browser = firefox ? `firefox ${firefox}` : chrome ? `${/Edg\//.test(ua) ? 'edge' : 'chrome'} ${chrome}` : safari ? `safari ${safari}` : 'other';
  const os = /Mac OS X/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : /Android/.test(ua) ? 'android' : /iPhone|iPad/.test(ua) ? 'ios' : /Linux/.test(ua) ? 'linux' : 'other';
  const visible = typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : null;
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? null;
  return { browser, os, visible, activated: activation };
}

function scheduleFlush(s: DiagState): void {
  if (s.timer !== null || s.pending.length === 0) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    void flushNow(s);
  }, s.flushMs);
}

async function flushNow(s: DiagState): Promise<void> {
  if (s.posting || s.pending.length === 0) return;
  const events = s.pending.splice(0, DIAG_BATCH_MAX);
  s.posting = true;
  let ok = false;
  try {
    ok = await s.post(JSON.stringify({ page: s.page, events } satisfies VoiceDiagBatch));
  } catch {
    ok = false;
  } finally {
    s.posting = false;
  }
  if (!ok) {
    // the server was not there: keep them for the next try (bounded like the ring)
    s.pending = [...events, ...s.pending].slice(-DIAG_RING_SIZE);
  }
  if (current === s) scheduleFlush(s);
}

function onLeave(s: DiagState): void {
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  while (s.pending.length > 0) {
    const events = s.pending.splice(0, DIAG_BATCH_MAX);
    const json = JSON.stringify({ page: s.page, events } satisfies VoiceDiagBatch);
    if (!s.beacon(json)) {
      // no beacon: a keepalive POST may still make it
      void s.post(json).catch(() => false);
    }
  }
}

/** Records one event of the voice pipeline. Allocation-free no-op when the black box is off. */
export function diag(event: string, data: Record<string, DiagValue | undefined> = {}): void {
  const s = state();
  if (!s.enabled || !DIAG_EVENT_RE.test(event)) return;
  if (!s.opened) {
    s.opened = true;
    try {
      s.unlisten = s.listenPage(() => onLeave(s));
    } catch {
      s.unlisten = null;
    }
    push(s, 'page.open', browserFacts());
  }
  push(s, event, sanitize(data));
}

function push(s: DiagState, event: string, fields: Record<string, DiagValue>): void {
  const entry: VoiceDiagEntry = { ...fields, t: Math.max(0, Math.round(s.now() - s.startedAt)), e: event };
  s.recent.push(entry);
  if (s.recent.length > DIAG_RING_SIZE) s.recent.splice(0, s.recent.length - DIAG_RING_SIZE);
  if (s.localOnly) return;
  s.pending.push(entry);
  if (s.pending.length > DIAG_RING_SIZE) s.pending.splice(0, s.pending.length - DIAG_RING_SIZE);
  scheduleFlush(s);
}

/** true while the black box records (a real browser; an automated run only with the clips opt-in, in memory) */
export function voiceDiagEnabled(): boolean {
  return state().enabled;
}

/** the last entries (newest last) — for tests and for `__gambitVoiceDiag.recent()` in the console */
export function voiceDiagRecent(): VoiceDiagEntry[] {
  return state().recent.slice();
}

/** sends what is pending now (tests; the page's own flushes are timed) */
export function flushVoiceDiag(): Promise<void> {
  return flushNow(state());
}

/** Test seam: a fresh black box with injected clock / transport. `enabled` defaults to the real rule. */
export function configureVoiceDiagForTests(options: VoiceDiagOptions = {}): void {
  resetVoiceDiagForTests();
  current = makeState(options);
}

export function resetVoiceDiagForTests(): void {
  if (current) {
    if (current.timer !== null) clearTimeout(current.timer);
    current.unlisten?.();
  }
  current = null;
}

// ───────────────────────── microphone permission (Chrome: navigator.permissions 'microphone') ─────────────────────────

export type MicPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

let permissionWatch: Promise<MicPermission> | null = null;
let lastPermission: MicPermission = 'unknown';
const permissionListeners = new Set<(state: MicPermission) => void>();

/**
 * The microphone permission as the browser reports it ('unknown' where the Permissions API has no 'microphone').
 * The first call also records every later change in the black box.
 */
export function queryMicPermission(): Promise<MicPermission> {
  if (typeof navigator === 'undefined' || typeof navigator.permissions?.query !== 'function') return Promise.resolve('unknown');
  permissionWatch ??= navigator.permissions
    .query({ name: 'microphone' as PermissionName })
    .then((status) => {
      lastPermission = asPermission(status.state);
      try {
        status.addEventListener('change', () => {
          lastPermission = asPermission(status.state);
          diag('mic.perm', { state: lastPermission, change: true });
          for (const listener of [...permissionListeners]) listener(lastPermission);
        });
      } catch {
        /* an old browser without events on PermissionStatus */
      }
      return lastPermission;
    })
    .catch(() => 'unknown' as const);
  return permissionWatch.then((first) => (lastPermission === 'unknown' ? first : lastPermission));
}

/**
 * The microphone permission as last reported, synchronously ('unknown' until a query answered). A click handler reads
 * it without awaiting (when the site is on «Блокировать», asking again cannot work).
 */
export function micPermissionNow(): MicPermission {
  return lastPermission;
}

/**
 * Later CHANGES of the microphone permission (the parent allowed it in Chrome's site settings after a refusal): the
 * open voice session attaches the microphone by itself, no tap needed. Starts the watch if nobody did. Returns an
 * unsubscriber.
 */
export function onMicPermissionChange(listener: (state: MicPermission) => void): () => void {
  permissionListeners.add(listener);
  void queryMicPermission();
  return () => {
    permissionListeners.delete(listener);
  };
}

function asPermission(value: unknown): MicPermission {
  return value === 'granted' || value === 'prompt' || value === 'denied' ? value : 'unknown';
}

/** Test seam: forget the watched permission. */
export function resetMicPermissionForTests(): void {
  permissionWatch = null;
  lastPermission = 'unknown';
  permissionListeners.clear();
}

// a parent can peek at the recorder from the console of the real browser (no secrets in it by construction)
if (typeof window !== 'undefined') {
  try {
    (window as Window & { __gambitVoiceDiag?: { recent: () => VoiceDiagEntry[] } }).__gambitVoiceDiag = { recent: voiceDiagRecent };
  } catch {
    /* a frozen window object: nothing to expose */
  }
}
