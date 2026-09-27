/**
 * The «Записи» library in the browser (docs/voice-clips/SPEC.md §4, §5.4): the manifest, fetching and decoding clips,
 * finding their real audible edges, and caches. It never generates anything — everything here is local and free.
 *
 *   voice/index.json → voice/<voiceKey>/manifest.<hash>.json → the planner's `ClipIndex`
 *   ensure(ids) → fetch voice/<voiceKey>/<id[1..2]>/<id>.mp3 (deduplicated) → decodeAudioData (on a COPY: decoding
 *                  detaches the bytes) → sample scan of the audible edges at −55 dBFS (MP3 priming / padding is never
 *                  trusted) → a mouth envelope (RMS per 20 ms) → the decoded LRU (≤ 60 s of audio)
 *
 * The library may be absent (a dev / e2e build without recordings, or the SPA answering index.html for the missing
 * JSON): `load()` rejects and the voice falls silent (the controller moves down its chain). A clip that fails to load
 * is remembered (`failed(id)`) so the planner picks another take or wording (`PlanContext.available`).
 *
 * «Дозапись голоса» (docs/voice-clips/ONDEMAND.md): phrases recorded on first use live in an overlay the local server serves
 * (`/api/voice/clips/overlay/` — the same index.json → manifest → mp3 layout, outside the app's files). The planner sees
 * ONE index, core `mergeClipIndexes(static, overlay)` — rebuilt as NEW objects on every (re)load, since the planner
 * memoises by identity — with the text index (a take found by its exact words when a wording number shifted) and the
 * overlay's `blocked[]`. Each take is fetched from its own origin (`urlOf`). The overlay is optional in every way:
 * a 404 / an old server / a broken manifest = the static library alone; the static library missing but the overlay
 * there = the overlay alone. `reloadOverlay()` swaps in a newly published overlay (the poller calls it, ./clipOnDemand.ts).
 */
import { CLIP_ID_RE, CLIP_VOICE_KEY, clipFile, mergeClipIndexes, takesForUnit } from '@gambit/core';
import type { ClipIndexLayer, ClipManifest, ClipUnitMeta, MergedClipIndex } from '@gambit/core';
import { API_BASE } from '@gambit/shared';
import { rmsToMouthTarget } from '../voiceUtils.ts';
import type { ClipAudio, ClipBufferLike } from './clipAudio.ts';

/** The part of `fetch`'s Response the library reads (tests pass plain objects). */
export interface ClipResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ClipFetch = (url: string, init?: { cache?: RequestCache; signal?: AbortSignal }) => Promise<ClipResponseLike>;

export interface ClipLibraryOptions {
  /** where `index.json` lives, ending in '/'; default `<app base>voice/` */
  baseUrl?: string;
  /** which voice of the index; default the index's `default`, else `giselle-mm1` */
  voiceKey?: string;
  fetch?: ClipFetch;
  /** decoder; default the clip audio context's `decodeAudioData` */
  decode?: (bytes: ArrayBuffer) => Promise<ClipBufferLike>;
  audio?: ClipAudio;
  /** decoded LRU budget, seconds of audio (SPEC §5.4: ≤ 60 s) */
  maxDecodedSec?: number;
  /** compressed bytes kept for the hot set */
  maxBytes?: number;
  /** audible-edge threshold of the sample scan (SPEC §10.1: −55 dBFS keeps word-final «ф», «ть») */
  trimDb?: number;
  /** a clip slower than this to fetch + decode is left out of the current plan (it still lands in the cache) */
  loadTimeoutMs?: number;
  /** idle scheduling for prefetch / prewarm (tests run it synchronously) */
  idle?: (cb: () => void) => void;
  /**
   * «Дозапись голоса»: where the recorded overlay's `index.json` lives, ending in '/'; default `/api/voice/clips/overlay/`
   * (the local server; a 404 = no overlay). null = the static library only.
   */
  overlayUrl?: string | null;
  /** how long `load()` waits for the overlay; a later one is merged in when it arrives */
  overlayWaitMs?: number;
}

/** A decoded take, ready for the player: plays `buffer` from `offsetSec` for `durSec`. */
export interface LoadedClip {
  id: string;
  buffer: ClipBufferLike;
  offsetSec: number;
  durSec: number;
  /** mouth level 0..1 per `ENVELOPE_STEP_SEC` from `offsetSec` */
  env: Float32Array;
}

export interface ClipLibraryInfo {
  voiceKey: string;
  libraryVersion: number;
  /** recorded takes */
  units: number;
  /** distinct unit keys (phrases, moves, fragments) — «1 240 фраз» */
  phrases: number;
  /** takes that come from the recorded overlay («Дозапись голоса»); 0 = none */
  overlayUnits: number;
}

export interface ClipLibrary {
  /** index + manifest; memoised while it succeeds, retried on the next call after a failure */
  load(): Promise<ClipLibraryInfo>;
  /**
   * the planner's view: the static manifest merged with the overlay (a NEW object per load / overlay reload — the planner
   * memoises by identity; never capture it, read it on every use); null before load
   */
  readonly index: MergedClipIndex | null;
  info(): ClipLibraryInfo | null;
  /** decodes what it can within `loadTimeoutMs`; ids that could not be loaded are simply absent from the map */
  ensure(ids: readonly string[], opts?: { timeoutMs?: number }): Promise<Map<string, LoadedClip>>;
  cached(id: string): LoadedClip | null;
  /** fetch or decode failed for good (the planner skips it) */
  failed(id: string): boolean;
  /** compressed bytes only, in idle time */
  prefetch(ids: readonly string[]): void;
  /** decode in idle time (strategy intro, candidate moves, the game end) */
  prewarm(ids: readonly string[]): void;
  /** barks, generic lines, the split set, greeting / start / end, urgent lines (SPEC §5.4 «hot set») */
  hotIds(): string[];
  /**
   * «Дозапись голоса»: re-reads the overlay's index.json (no cache); a new manifest is merged in as a NEW index. true =
   * the index changed. Failures keep what is loaded (false). Before `load()` succeeded it does nothing.
   */
  reloadOverlay(): Promise<boolean>;
  /** the overlay manifest's version; null = no overlay loaded */
  overlayVersion(): number | null;
  /**
   * A take says exactly `text` for this unit (exact key, else the text index) and has not failed to load — the book's
   * «is it recorded» probe. A take that failed is not a recording: the book would keep picking a wording that never plays.
   */
  hasTake(unitKey: string, text: string): boolean;
  /** the unit will not be recorded (the overlay's `blocked[]`) */
  isBlocked(unitKey: string): boolean;
  dispose(): void;
}

export const DEFAULT_MAX_DECODED_SEC = 60;
export const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
export const DEFAULT_TRIM_DB = -55;
export const DEFAULT_LOAD_TIMEOUT_MS = 1500;
export const ENVELOPE_STEP_SEC = 0.02;
/** where the local server serves the recorded overlay (docs/voice-clips/ONDEMAND.md `GET /api/voice/clips/overlay/*`) */
export const DEFAULT_OVERLAY_URL = `${API_BASE}/voice/clips/overlay/`;
/** `load()` waits this long for the overlay (the static library does not wait for a slow server) */
export const DEFAULT_OVERLAY_WAIT_MS = 1500;
/** a sane cap on `blocked[]` keys read from a manifest */
const MAX_BLOCKED = 20_000;
/** kept before the first / after the last audible sample (the 5 ms fades sit inside) */
const PRE_ROLL_SEC = 0.006;
const POST_ROLL_SEC = 0.012;

const FILE_RE = /^[0-9a-f]{2}\/c[0-9a-f]{13}\.mp3$/;
const MANIFEST_REL_RE = /^[A-Za-z0-9_-]{1,40}\/manifest\.[0-9a-f]{6,64}\.json$/;
const VOICE_KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** SPEC §5.4 hot set: what must never wait for the network (urgent lines included). */
const HOT_POOL_RE = /^(?:bark\.|generic(?:[.@/]|$)|greeting|gameStart|gameEnd|takeback|danger|urgent|stop|ask\.|poke|thought\.)/;
const HOT_KEY_RE = /^slot:(?:head|sq|xsq):/;

// ───────────────────────── pure helpers (exported for tests) ─────────────────────────

/** The audible edges of a decoded buffer: first / last sample above `thresholdDb`; null for pure silence. */
export function scanAudible(buffer: ClipBufferLike, thresholdDb = DEFAULT_TRIM_DB): { onsetSec: number; offsetSec: number } | null {
  if (buffer.length === 0 || buffer.numberOfChannels === 0) return null;
  const data = buffer.getChannelData(0);
  const threshold = 10 ** (thresholdDb / 20);
  let first = -1;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i] as number) > threshold) {
      first = i;
      break;
    }
  }
  if (first < 0) return null;
  let last = first;
  for (let i = data.length - 1; i > first; i--) {
    if (Math.abs(data[i] as number) > threshold) {
      last = i;
      break;
    }
  }
  return { onsetSec: first / buffer.sampleRate, offsetSec: (last + 1) / buffer.sampleRate };
}

/** Where to play a take from and for how long: the scanned edges, else the manifest's `on` / `off`, else all of it. */
export function playWindow(buffer: ClipBufferLike, meta: Pick<ClipUnitMeta, 'on' | 'off'> | undefined, thresholdDb = DEFAULT_TRIM_DB): { offsetSec: number; durSec: number } {
  const total = buffer.duration;
  const scanned = scanAudible(buffer, thresholdDb);
  if (scanned) {
    const offsetSec = Math.max(0, scanned.onsetSec - PRE_ROLL_SEC);
    const end = Math.min(total, scanned.offsetSec + POST_ROLL_SEC);
    return { offsetSec, durSec: Math.max(0, end - offsetSec) };
  }
  if (meta && typeof meta.on === 'number' && typeof meta.off === 'number' && meta.off > meta.on) {
    const offsetSec = Math.min(total, Math.max(0, meta.on / 1000));
    return { offsetSec, durSec: Math.max(0, Math.min(total, meta.off / 1000) - offsetSec) };
  }
  return { offsetSec: 0, durSec: total };
}

/** Mouth level per 20 ms of the played window (RMS → the same gate / gain as the live voices' meter). */
export function mouthEnvelope(buffer: ClipBufferLike, offsetSec: number, durSec: number): Float32Array {
  if (buffer.numberOfChannels === 0 || durSec <= 0) return new Float32Array(0);
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const step = Math.max(1, Math.round(ENVELOPE_STEP_SEC * rate));
  const from = Math.floor(offsetSec * rate);
  const to = Math.min(data.length, Math.ceil((offsetSec + durSec) * rate));
  const frames = Math.max(0, Math.ceil((to - from) / step));
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    let n = 0;
    for (let i = from + f * step; i < Math.min(to, from + (f + 1) * step); i++) {
      const v = data[i] as number;
      sum += v * v;
      n++;
    }
    env[f] = n > 0 ? rmsToMouthTarget(Math.sqrt(sum / n), 0.01, 5) : 0;
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A manifest as the browser trusts it: v1, units with hex ids and sane numbers, pools / keys only naming known units,
 * string fallbacks. null when it is not a manifest at all.
 */
export function parseManifest(raw: unknown): ClipManifest | null {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.units) || !isRecord(raw.pools) || !isRecord(raw.keys)) return null;
  const units: Record<string, ClipUnitMeta> = {};
  for (const [id, value] of Object.entries(raw.units)) {
    if (!CLIP_ID_RE.test(id) || !isRecord(value)) continue;
    const text = typeof value.text === 'string' ? value.text : '';
    const ms = typeof value.ms === 'number' && Number.isFinite(value.ms) && value.ms >= 0 ? value.ms : null;
    if (ms === null) continue;
    const meta: ClipUnitMeta = { text, ms };
    if (typeof value.key === 'string') meta.key = value.key;
    if (typeof value.on === 'number' && Number.isFinite(value.on)) meta.on = value.on;
    if (typeof value.off === 'number' && Number.isFinite(value.off)) meta.off = value.off;
    if (typeof value.file === 'string' && FILE_RE.test(value.file)) meta.file = value.file;
    if (typeof value.take === 'number') meta.take = value.take;
    if (typeof value.mood === 'string') meta.mood = value.mood;
    if (typeof value.qa === 'string') meta.qa = value.qa;
    if (typeof value.tier === 'string') meta.tier = value.tier;
    if (value.interj === true) meta.interj = true;
    // «Дозапись голоса»: a lead take that may only be played right before its tail
    if (value.ctx === 'cont') meta.ctx = 'cont';
    units[id] = meta;
  }
  const lists = (source: Record<string, unknown>): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(source)) {
      if (!Array.isArray(value)) continue;
      const ids = value.filter((id): id is string => typeof id === 'string' && units[id] !== undefined);
      if (ids.length > 0) out[key] = [...new Set(ids)];
    }
    return out;
  };
  const fallbacks: Record<string, string> = {};
  if (isRecord(raw.fallbacks)) for (const [k, v] of Object.entries(raw.fallbacks)) if (typeof v === 'string') fallbacks[k] = v;
  // the overlay's unit keys that will never be recorded (attempts used up, rejected on review)
  const blocked = Array.isArray(raw.blocked) ? [...new Set(raw.blocked.filter((k): k is string => typeof k === 'string' && k !== '' && k.length <= 300))].slice(0, MAX_BLOCKED) : [];
  return {
    v: 1,
    voiceKey: typeof raw.voiceKey === 'string' ? raw.voiceKey : CLIP_VOICE_KEY,
    libraryVersion: typeof raw.libraryVersion === 'number' && Number.isFinite(raw.libraryVersion) ? raw.libraryVersion : 0,
    units,
    pools: lists(raw.pools),
    keys: lists(raw.keys),
    fallbacks,
    ...(blocked.length > 0 ? { blocked } : {}),
  };
}

function defaultBaseUrl(): string {
  let base = '/';
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
    if (typeof env?.BASE_URL === 'string' && env.BASE_URL !== '') base = env.BASE_URL;
  } catch {
    base = '/';
  }
  return `${base.endsWith('/') ? base : `${base}/`}voice/`;
}

function defaultFetch(): ClipFetch | null {
  if (typeof fetch !== 'function') return null;
  return (url, init) => fetch(url, init) as unknown as Promise<ClipResponseLike>;
}

function defaultIdle(cb: () => void): void {
  const w = typeof window === 'undefined' ? null : (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number });
  if (w?.requestIdleCallback) w.requestIdleCallback(cb, { timeout: 2000 });
  else setTimeout(cb, 30);
}

// ───────────────────────── the library ─────────────────────────

/** One published library: the static one (the app's `voice/`) or the recorded overlay (the local server). */
interface Layer {
  voiceKey: string;
  /** `<voiceKey>/manifest.<hash>.json` as index.json names it (a new hash = a new manifest) */
  rel: string;
  manifest: ClipManifest;
}

export function createClipLibrary(options: ClipLibraryOptions = {}): ClipLibrary {
  const base = options.baseUrl ?? defaultBaseUrl();
  const doFetch = options.fetch ?? defaultFetch();
  const maxDecodedSec = options.maxDecodedSec ?? DEFAULT_MAX_DECODED_SEC;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const trimDb = options.trimDb ?? DEFAULT_TRIM_DB;
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const idle = options.idle ?? defaultIdle;
  const decode =
    options.decode ??
    ((bytes: ArrayBuffer): Promise<ClipBufferLike> => {
      const ctx = options.audio?.context() ?? null;
      if (!ctx) return Promise.reject(new Error('no audio context'));
      return ctx.decodeAudioData(bytes);
    });

  const overlayRoot = options.overlayUrl === undefined ? DEFAULT_OVERLAY_URL : options.overlayUrl;
  const overlayWaitMs = options.overlayWaitMs ?? DEFAULT_OVERLAY_WAIT_MS;
  let staticLayer: Layer | null = null;
  let overlay: Layer | null = null;
  /** takes fetched from the overlay's origin (its own ids; the static library wins a collision) */
  let overlayIds = new Set<string>();
  let index: MergedClipIndex | null = null;
  let info: ClipLibraryInfo | null = null;
  let loading: Promise<ClipLibraryInfo> | null = null;
  let reloading: Promise<boolean> | null = null;
  /** a caller came while a reload was under way: one more read after it, shared by every such caller */
  let rereading: Promise<boolean> | null = null;
  let disposed = false;

  /** decoded takes, least recently used first */
  const decoded = new Map<string, LoadedClip>();
  let decodedSec = 0;
  /** compressed bytes, least recently used first */
  const bytes = new Map<string, ArrayBuffer>();
  let bytesTotal = 0;
  const inflightBytes = new Map<string, Promise<ArrayBuffer | null>>();
  const inflightDecode = new Map<string, Promise<LoadedClip | null>>();
  const failedIds = new Set<string>();

  async function fetchJson(url: string, cache: RequestCache): Promise<unknown> {
    if (!doFetch) throw new Error('no fetch');
    const res = await doFetch(url, { cache });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const text = await res.text();
    // a missing file comes back as the SPA's index.html (dev server, production fallback): that is «no library»
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error('not json');
    }
  }

  /** which manifest `root`/index.json names for the wanted voice (default: the index's own default) */
  async function manifestEntry(root: string, cache: RequestCache, wantedKey: string | undefined): Promise<{ voiceKey: string; rel: string }> {
    const rawIndex = await fetchJson(`${root}index.json`, cache);
    if (!isRecord(rawIndex) || !isRecord(rawIndex.voices)) throw new Error('bad index');
    const voiceKey = wantedKey ?? (typeof rawIndex.default === 'string' && VOICE_KEY_RE.test(rawIndex.default) ? rawIndex.default : CLIP_VOICE_KEY);
    const rel = rawIndex.voices[voiceKey];
    if (typeof rel !== 'string' || !MANIFEST_REL_RE.test(rel)) throw new Error('no voice');
    return { voiceKey, rel };
  }

  /**
   * `blockedOnly`: the overlay may publish a manifest with no take yet but `blocked[]` (the first phrases it ever tried
   * were given up) — the book must still learn to avoid them. The static library without a take is no library.
   */
  async function manifestAt(root: string, rel: string, blockedOnly = false): Promise<ClipManifest> {
    const parsed = parseManifest(await fetchJson(`${root}${rel}`, 'default'));
    if (!parsed) throw new Error('bad manifest');
    if (Object.keys(parsed.units).length === 0 && !(blockedOnly && (parsed.blocked?.length ?? 0) > 0)) throw new Error('bad manifest');
    return parsed;
  }

  async function fetchLayer(root: string, cache: RequestCache, wantedKey: string | undefined, blockedOnly = false): Promise<Layer> {
    const entry = await manifestEntry(root, cache, wantedKey);
    return { ...entry, manifest: await manifestAt(root, entry.rel, blockedOnly) };
  }

  function indexLayer(layer: Layer): ClipIndexLayer {
    const m = layer.manifest;
    return { units: m.units, pools: m.pools, keys: m.keys, fallbacks: m.fallbacks ?? {}, voiceKey: layer.voiceKey, ...(m.blocked ? { blocked: m.blocked } : {}) };
  }

  /** an overlay of another voice never joins (one sentence never mixes two voices) */
  function sameVoice(candidate: Layer | null): Layer | null {
    if (!candidate) return null;
    if (staticLayer && staticLayer.voiceKey !== candidate.voiceKey) return null;
    return candidate;
  }

  /** the merged index as NEW objects (core `mergeClipIndexes`), the overlay's origin set, the library line */
  function rebuild(): ClipLibraryInfo {
    const merged = mergeClipIndexes(staticLayer ? indexLayer(staticLayer) : null, overlay ? indexLayer(overlay) : null);
    const staticUnits = staticLayer?.manifest.units ?? {};
    overlayIds = new Set(overlay ? Object.keys(overlay.manifest.units).filter((id) => !Object.hasOwn(staticUnits, id)) : []);
    // a take that is gone is forgotten; one that is still there and failed stays failed (the planner keeps skipping it)
    for (const id of [...failedIds]) if (!Object.hasOwn(merged.units, id)) failedIds.delete(id);
    index = merged;
    const voiceKey = staticLayer?.voiceKey ?? overlay?.voiceKey ?? options.voiceKey ?? CLIP_VOICE_KEY;
    info = {
      voiceKey,
      libraryVersion: staticLayer?.manifest.libraryVersion ?? 0,
      units: Object.keys(merged.units).length,
      phrases: Object.keys(merged.keys).length,
      overlayUnits: overlayIds.size,
    };
    return info;
  }

  function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
      void promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(undefined);
        },
      );
    });
  }

  async function loadNow(): Promise<ClipLibraryInfo> {
    // the overlay is asked for at the same time; it never fails the load
    const overlayJob: Promise<Layer | null> = overlayRoot ? fetchLayer(overlayRoot, 'no-cache', options.voiceKey, true).catch(() => null) : Promise.resolve(null);
    const loaded = await fetchLayer(base, 'no-cache', options.voiceKey).then(
      (layer) => ({ layer, error: null }),
      (error: unknown) => ({ layer: null, error }),
    );
    const waited = await within(overlayJob, overlayWaitMs);
    if (disposed) throw new Error('disposed');
    staticLayer = loaded.layer;
    overlay = sameVoice(waited ?? null);
    // an overlay with nothing but `blocked[]` is no library to play from on its own
    if (!staticLayer && (!overlay || Object.keys(overlay.manifest.units).length === 0)) {
      index = null;
      info = null;
      throw loaded.error instanceof Error ? loaded.error : new Error('no library');
    }
    failedIds.clear();
    const result = rebuild();
    if (waited === undefined) {
      // a slow overlay joins when it arrives (never replacing one a reload found meanwhile)
      void overlayJob.then((late) => {
        if (!late || disposed || overlay !== null || info === null) return;
        overlay = sameVoice(late);
        if (overlay) rebuild();
      });
    }
    return result;
  }

  function load(): Promise<ClipLibraryInfo> {
    if (info && index) return Promise.resolve(info);
    loading ??= loadNow().finally(() => {
      loading = null;
    });
    return loading;
  }

  function reloadOverlay(): Promise<boolean> {
    if (!overlayRoot || disposed || info === null) return Promise.resolve(false);
    // one under way may have read the index before the publish this caller heard of: read once more after it (the
    // answer is true when either read changed the library)
    if (reloading !== null) {
      const first = reloading;
      rereading ??= first.then((changedFirst) => {
        rereading = null;
        return reloadOverlay().then((changedAgain) => changedFirst || changedAgain);
      });
      return rereading;
    }
    const root = overlayRoot;
    reloading = (async (): Promise<boolean> => {
      try {
        const entry = await manifestEntry(root, 'no-store', staticLayer?.voiceKey ?? overlay?.voiceKey ?? options.voiceKey);
        if (overlay && entry.rel === overlay.rel) return false;
        const next = sameVoice({ ...entry, manifest: await manifestAt(root, entry.rel, true) });
        if (!next || disposed || info === null) return false;
        overlay = next;
        rebuild();
        return true;
      } catch {
        // 404 / offline / a half-written manifest: keep what plays now
        return false;
      }
    })().finally(() => {
      reloading = null;
    });
    return reloading;
  }

  function urlOf(id: string): string | null {
    if (!CLIP_ID_RE.test(id)) return null;
    const fromOverlay = overlay !== null && overlayRoot !== null && overlayIds.has(id);
    const layer = fromOverlay ? overlay : staticLayer;
    if (!layer) return null;
    const meta = layer.manifest.units[id];
    const file = meta?.file !== undefined && FILE_RE.test(meta.file) ? meta.file : clipFile(id);
    return `${fromOverlay ? overlayRoot : base}${layer.voiceKey}/${file}`;
  }

  function touchBytes(id: string, buf: ArrayBuffer): void {
    const had = bytes.get(id);
    if (had) {
      bytes.delete(id);
      bytesTotal -= had.byteLength;
    }
    bytes.set(id, buf);
    bytesTotal += buf.byteLength;
    for (const [oldId, old] of bytes) {
      if (bytesTotal <= maxBytes || oldId === id) break;
      bytes.delete(oldId);
      bytesTotal -= old.byteLength;
    }
  }

  function fetchBytes(id: string): Promise<ArrayBuffer | null> {
    const have = bytes.get(id);
    if (have) {
      touchBytes(id, have);
      return Promise.resolve(have);
    }
    const running = inflightBytes.get(id);
    if (running) return running;
    const url = urlOf(id);
    if (!url || !doFetch || failedIds.has(id)) return Promise.resolve(null);
    const work = doFetch(url)
      .then(async (res) => {
        if (!res.ok) {
          // 404: that take is not in this build — for good
          if (res.status >= 400 && res.status < 500) failedIds.add(id);
          return null;
        }
        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) {
          failedIds.add(id);
          return null;
        }
        if (!disposed) touchBytes(id, buf);
        return buf;
      })
      .catch(() => null)
      .finally(() => inflightBytes.delete(id));
    inflightBytes.set(id, work);
    return work;
  }

  function remember(clip: LoadedClip): void {
    const had = decoded.get(clip.id);
    if (had) {
      decoded.delete(clip.id);
      decodedSec -= had.buffer.duration;
    }
    decoded.set(clip.id, clip);
    decodedSec += clip.buffer.duration;
    for (const [oldId, old] of decoded) {
      if (decodedSec <= maxDecodedSec || oldId === clip.id) break;
      decoded.delete(oldId);
      decodedSec -= old.buffer.duration;
    }
  }

  function cached(id: string): LoadedClip | null {
    const hit = decoded.get(id);
    if (!hit) return null;
    // most recently used goes last
    decoded.delete(id);
    decoded.set(id, hit);
    return hit;
  }

  function decodeOne(id: string): Promise<LoadedClip | null> {
    const hit = cached(id);
    if (hit) return Promise.resolve(hit);
    const running = inflightDecode.get(id);
    if (running) return running;
    const work = fetchBytes(id)
      .then(async (buf) => {
        if (!buf || disposed) return null;
        let audio: ClipBufferLike;
        try {
          // decodeAudioData detaches its argument: decode a copy, keep the cached bytes intact
          audio = await decode(buf.slice(0));
        } catch {
          failedIds.add(id);
          return null;
        }
        if (disposed) return null;
        const window = playWindow(audio, index?.units[id], trimDb);
        if (window.durSec <= 0) {
          failedIds.add(id);
          return null;
        }
        const clip: LoadedClip = { id, buffer: audio, offsetSec: window.offsetSec, durSec: window.durSec, env: mouthEnvelope(audio, window.offsetSec, window.durSec) };
        remember(clip);
        return clip;
      })
      .catch(() => null)
      .finally(() => inflightDecode.delete(id));
    inflightDecode.set(id, work);
    return work;
  }

  async function ensure(ids: readonly string[], opts: { timeoutMs?: number } = {}): Promise<Map<string, LoadedClip>> {
    const out = new Map<string, LoadedClip>();
    const unique = [...new Set(ids)];
    const jobs = unique.map((id) =>
      decodeOne(id).then((clip) => {
        if (clip) out.set(id, clip);
      }),
    );
    const timeoutMs = opts.timeoutMs ?? loadTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
    });
    await Promise.race([Promise.all(jobs).then(() => undefined), deadline]);
    if (timer !== null) clearTimeout(timer);
    return new Map(out);
  }

  function inIdle(ids: readonly string[], work: (id: string) => Promise<unknown>): void {
    const queue = [...new Set(ids)].filter((id) => CLIP_ID_RE.test(id));
    if (queue.length === 0) return;
    const next = (): void => {
      if (disposed) return;
      const batch = queue.splice(0, 4);
      if (batch.length === 0) return;
      void Promise.all(batch.map((id) => work(id).catch(() => null))).then(() => {
        if (queue.length > 0) idle(next);
      });
    };
    idle(next);
  }

  function hotIds(): string[] {
    if (!index) return [];
    const out = new Set<string>();
    for (const [pool, ids] of Object.entries(index.pools)) if (HOT_POOL_RE.test(pool)) for (const id of ids) out.add(id);
    for (const [key, ids] of Object.entries(index.keys)) if (HOT_KEY_RE.test(key)) for (const id of ids) out.add(id);
    return [...out];
  }

  function hasTake(unitKey: string, text: string): boolean {
    const current = index;
    if (!current) return false;
    return takesForUnit(current, unitKey, text).some((id) => !failedIds.has(id));
  }

  return {
    load,
    get index() {
      return index;
    },
    info: () => info,
    ensure,
    cached,
    failed: (id) => failedIds.has(id),
    prefetch: (ids) => inIdle(ids, fetchBytes),
    prewarm: (ids) => inIdle(ids, decodeOne),
    hotIds,
    reloadOverlay,
    overlayVersion: () => overlay?.manifest.libraryVersion ?? null,
    hasTake,
    isBlocked: (unitKey) => index?.blocked.has(unitKey) ?? false,
    dispose() {
      disposed = true;
      decoded.clear();
      bytes.clear();
      decodedSec = 0;
      bytesTotal = 0;
    },
  };
}
