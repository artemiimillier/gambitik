/**
 * «Дозапись голоса»: the recorded overlay — ONE folder per Mac, outside every checkout (docs/voice-clips/ONDEMAND.md):
 *
 *   index.json                          which manifest is current (written last, atomically, by the tools)
 *   giselle-mm1/manifest.<hash>.json    the published takes (only ASR-confirmed ones), `blocked[]`
 *   giselle-mm1/<xx>/<id>.mp3           the takes
 *   ledger.giselle-mm1.jsonl            the ONE on-demand ledger (server + the owner's prefetch): the money
 *   units.giselle-mm1.json              every processed take (tools only); review.giselle-mm1.json the owner's verdicts
 *   .masters/                           downloaded masters; state.json the server's own notes; *.lock the locks
 *
 * The same layout as the tools' `overlayPaths` (tools/voice-clips/overlay.ts): the finish passes `--overlay` AND every
 * path explicitly, so the two can never disagree.
 *
 * Serving (GET /api/voice/clips/overlay/*) is independent of generation: strict path regexes, then the real path must
 * lie inside the overlay, be a regular file and stay under a size cap. Anything else is a JSON 404.
 *
 * `Libraries` reads what is already recorded — the static library (apps/web/public/voice) merged with the overlay by
 * core `mergeClipIndexes`, and the checkout's own unit store (the starter set's takes the owner has not heard yet) —
 * cached by the files' stamps, so a request or a status poll costs a few `stat` calls.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { mergeClipIndexes } from '@gambit/core';
import type { ClipIndexLayer, MergedClipIndex } from '@gambit/core';
import { OVERLAY_LEDGER, PUBLISH_LOCK, VOICE_KEY, overlayCheckOf, readCurrentManifest, readStore, readVerdicts, tryLock } from './bridge.ts';
import type { Manifest } from './bridge.ts';

export interface OverlayPaths {
  dir: string;
  index: string;
  ledger: string;
  units: string;
  review: string;
  masters: string;
  state: string;
  processReport: string;
  verifyReport: string;
  /** the machine-wide generator lock is `<dir>/higgsfield.lock` (tools `lockGlobal`); this one serialises publishing */
  publishLock: string;
}

export function overlayPaths(dir: string): OverlayPaths {
  return {
    dir,
    index: join(dir, 'index.json'),
    ledger: join(dir, OVERLAY_LEDGER),
    units: join(dir, `units.${VOICE_KEY}.json`),
    review: join(dir, `review.${VOICE_KEY}.json`),
    masters: join(dir, '.masters'),
    state: join(dir, 'state.json'),
    processReport: join(dir, `process-report.${VOICE_KEY}.json`),
    verifyReport: join(dir, `verify-report.${VOICE_KEY}.json`),
    publishLock: join(dir, PUBLISH_LOCK),
  };
}

// ───────────────────────── serving files ─────────────────────────

export type OverlayFileKind = 'index' | 'manifest' | 'mp3';

const INDEX_RE = /^index\.json$/;
const MANIFEST_RE = /^([A-Za-z0-9_-]{1,40})\/manifest\.[0-9a-f]{6,64}\.json$/;
const MP3_RE = /^([A-Za-z0-9_-]{1,40})\/([0-9a-f]{2})\/(c[0-9a-f]{13})\.mp3$/;

/** Size caps: an index is tiny, a manifest of thousands of takes stays well under 8 MB, one take under 2 MB. */
export const OVERLAY_FILE_LIMITS: Readonly<Record<OverlayFileKind, number>> = { index: 64 * 1024, manifest: 8 * 1024 * 1024, mp3: 2 * 1024 * 1024 };

/** Which kind of overlay file a request path names, or null (the only three shapes the browser ever asks for). */
export function overlayFileKind(rel: string): OverlayFileKind | null {
  if (INDEX_RE.test(rel)) return 'index';
  if (MANIFEST_RE.test(rel)) return 'manifest';
  const mp3 = MP3_RE.exec(rel);
  // the folder is the id's two hex digits after the `c` (tools `clipFile`)
  if (mp3 && mp3[2] === (mp3[3] as string).slice(1, 3)) return 'mp3';
  return null;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The file to serve for `rel`, or null: regex, then real-path containment (no symlink out), a regular file, the size cap. */
export function resolveOverlayFile(dir: string, rel: string): { path: string; kind: OverlayFileKind; size: number } | null {
  const kind = overlayFileKind(rel);
  if (kind === null) return null;
  try {
    const root = realpathSync(dir);
    const real = realpathSync(join(dir, rel));
    if (!inside(real, root)) return null;
    const st = statSync(real);
    if (!st.isFile() || st.size > OVERLAY_FILE_LIMITS[kind]) return null;
    return { path: real, kind, size: st.size };
  } catch {
    return null;
  }
}

// ───────────────────────── what is recorded already ─────────────────────────

/** A file's identity for caching (null = missing). */
export function fileStamp(file: string | null): string {
  if (file === null) return '-';
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

function manifestOf(root: string | null): Manifest | null {
  if (root === null) return null;
  try {
    return readCurrentManifest(root, VOICE_KEY);
  } catch {
    // a torn or foreign manifest = no library (the web does the same)
    return null;
  }
}

function layerOf(manifest: Manifest | null): ClipIndexLayer | null {
  if (manifest === null) return null;
  const raw = manifest as unknown as ClipIndexLayer & { blocked?: unknown };
  const blocked = Array.isArray(raw.blocked) ? raw.blocked.filter((k): k is string => typeof k === 'string') : [];
  return { units: raw.units, keys: raw.keys, pools: raw.pools, fallbacks: raw.fallbacks ?? {}, voiceKey: manifest.voiceKey, blocked };
}

export interface LibraryState {
  /** the static library + the overlay (exact keys, the text index, `blocked`) */
  merged: MergedClipIndex;
  /** the overlay manifest's version and size; null = no overlay manifest yet */
  overlay: { version: number; units: number } | null;
  /** clip ids the overlay manifest publishes */
  overlayIds: ReadonlySet<string>;
  /** clip ids the tools have processed into the overlay store (published or not) */
  processed: ReadonlySet<string>;
  /**
   * clip ids whose check is known (tools `overlayCheckOf`): 'ok' — may be heard; 'failed' — really checked and turned
   * down (only such a take may cost a take 2). A processed take that is not in here is still being checked.
   */
  checks: ReadonlyMap<string, 'ok' | 'failed'>;
  /** charged jobs the tools processed whose master did not split into its pieces (a paid attempt without a take) */
  requeued: ReadonlySet<string>;
  /**
   * `key|text` of the units whose overlay take the owner marked «redo» (one more paid attempt) or «reject» (never
   * again) — by the words, so a verdict on old words never touches the new words a shifted key names
   */
  redo: ReadonlySet<string>;
  rejected: ReadonlySet<string>;
  /**
   * `key|text` of the checkout's own takes (the tools' unit store of the static library — the starter set) that the recogniser
   * confirmed and the owner has not turned down, but that are not published: they wait for the owner's ear
   * (`voice:review`). Paid for already — buying the same words again on demand would pay twice.
   */
  awaitingEar: ReadonlySet<string>;
}

/** The checkout's own unit store and verdicts (the static library's: tools/voice-clips/units|review.<voice>.json). */
export interface ToolsStorePaths {
  units: string;
  review: string;
}

/** The recorded libraries, re-read only when one of their files changed. */
export class Libraries {
  private readonly staticDir: string | null;
  private readonly overlay: OverlayPaths | null;
  private readonly tools: ToolsStorePaths | null;
  private cache: { key: string; state: LibraryState } | null = null;

  constructor(o: { staticDir: string | null; overlay: OverlayPaths | null; tools?: ToolsStorePaths | null }) {
    this.staticDir = o.staticDir;
    this.overlay = o.overlay;
    this.tools = o.tools ?? null;
  }

  current(): LibraryState {
    const ov = this.overlay;
    const tools = this.tools;
    const key = [
      fileStamp(this.staticDir === null ? null : join(this.staticDir, 'index.json')),
      fileStamp(ov?.index ?? null),
      fileStamp(ov?.units ?? null),
      fileStamp(ov?.review ?? null),
      fileStamp(tools?.units ?? null),
      fileStamp(tools?.review ?? null),
    ].join('|');
    if (this.cache?.key === key) return this.cache.state;
    const overlayManifest = manifestOf(ov?.dir ?? null);
    const merged = mergeClipIndexes(layerOf(manifestOf(this.staticDir)), layerOf(overlayManifest));
    const processed = new Set<string>();
    const checks = new Map<string, 'ok' | 'failed'>();
    const requeued = new Set<string>();
    const redo = new Set<string>();
    const rejected = new Set<string>();
    if (ov !== null) {
      try {
        const store = readStore(ov.units);
        const verdicts = readVerdicts(ov.review);
        for (const [id, unit] of Object.entries(store.units)) {
          processed.add(id);
          const check = overlayCheckOf(unit, verdicts[id]?.verdict);
          if (check !== null) checks.set(id, check);
        }
        for (const jobId of Object.keys(store.requeued ?? {})) requeued.add(jobId);
        for (const [id, v] of Object.entries(verdicts)) {
          const unit = store.units[id];
          if (unit === undefined) continue;
          if (v.verdict === 'redo') redo.add(`${unit.key}|${unit.text}`);
          if (v.verdict === 'reject') rejected.add(`${unit.key}|${unit.text}`);
        }
      } catch {
        // a torn store: nothing processed yet as far as the server can tell (the ledger still counts every attempt)
      }
    }
    const awaitingEar = new Set<string>();
    if (tools !== null) {
      try {
        const store = readStore(tools.units);
        const verdicts = readVerdicts(tools.review);
        for (const [id, unit] of Object.entries(store.units)) {
          const verdict = verdicts[id]?.verdict;
          // a take the owner turned down (or asked to redo) may be bought again, within the paid attempts
          if (unit.asr?.ok === true && verdict !== 'reject' && verdict !== 'redo') awaitingEar.add(`${unit.key}|${unit.text}`);
        }
      } catch {
        // a torn store: nothing waits as far as the server can tell (the tools ledger still counts every paid attempt)
      }
    }
    const state: LibraryState = {
      merged,
      overlay: overlayManifest === null ? null : { version: overlayManifest.libraryVersion, units: Object.keys(overlayManifest.units).length },
      overlayIds: new Set(overlayManifest === null ? [] : Object.keys(overlayManifest.units)),
      processed,
      checks,
      requeued,
      redo,
      rejected,
      awaitingEar,
    };
    this.cache = { key, state };
    return state;
  }
}

// ───────────────────────── the publish lock ─────────────────────────

/**
 * Two writers of one overlay (two servers, or a server and the owner's `voice:process` / `voice:verify --overlay`)
 * would rewrite its unit store and manifest over each other: the tools' pid-file protocol on `<ov>/publish.lock`
 * (tools `lockPublish` — the owner's commands wait for it; the finish's own children see it held by their parent, the
 * server, and go on). A dead holder's lock is taken over. Returns the release, or null while a live process holds it.
 * Kept apart from `lockLedger` on purpose: that one also takes the machine-wide generator lock (docs/voice-clips/ONDEMAND.md), which
 * publishing does not need.
 */
export function tryLockFile(file: string): (() => void) | null {
  const got = tryLock(file);
  return 'release' in got ? got.release : null;
}

// ───────────────────────── the server's own notes (state.json) ─────────────────────────

/**
 * What the ledger cannot say: which charged jobs the server has finished (and which of their units failed the check,
 * so they may get their one paid take 2), which paid jobs could not be downloaded or finished after every retry
 * (`stuck`: their phrases are not «being recorded» any more — the owner is told, and the next start tries again, never
 * paying twice), and the breaker's `failing` trips — all survive a restart (S6 / S7) and are shared by every server
 * instance that uses this overlay.
 */
export interface OverlayState {
  v: 1;
  failingTrips: number;
  lastTripAt: string | null;
  finished: Record<string, { at: string; failed: string[] }>;
  stuck: Record<string, { at: string; step: 'download' | 'finish' }>;
}

export function emptyOverlayState(): OverlayState {
  return { v: 1, failingTrips: 0, lastTripAt: null, finished: {}, stuck: {} };
}

export function readOverlayState(file: string): OverlayState {
  try {
    if (!existsSync(file)) return emptyOverlayState();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<OverlayState>;
    const finished: OverlayState['finished'] = {};
    if (raw.finished && typeof raw.finished === 'object') {
      for (const [jobId, f] of Object.entries(raw.finished)) {
        if (f && typeof f.at === 'string' && Array.isArray(f.failed)) finished[jobId] = { at: f.at, failed: f.failed.filter((k): k is string => typeof k === 'string') };
      }
    }
    const stuck: OverlayState['stuck'] = {};
    if (raw.stuck && typeof raw.stuck === 'object') {
      for (const [jobId, f] of Object.entries(raw.stuck)) {
        if (f && typeof f.at === 'string' && (f.step === 'download' || f.step === 'finish')) stuck[jobId] = { at: f.at, step: f.step };
      }
    }
    return {
      v: 1,
      failingTrips: typeof raw.failingTrips === 'number' && Number.isInteger(raw.failingTrips) && raw.failingTrips >= 0 ? raw.failingTrips : 0,
      lastTripAt: typeof raw.lastTripAt === 'string' ? raw.lastTripAt : null,
      finished,
      stuck,
    };
  } catch {
    return emptyOverlayState();
  }
}

/** Read, change, write back atomically (tmp + rename): a reader sees the old notes or the new ones. */
export function updateOverlayState(file: string, change: (state: OverlayState) => void): OverlayState {
  const state = readOverlayState(file);
  change(state);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  return state;
}
