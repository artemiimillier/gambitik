/**
 * The unit store and the published manifest (SPEC §4.1–4.2).
 *
 *  - `units.<voiceKey>.json` (committed, tools only): every processed unit with its provenance (job, cut, atempo,
 *    loudness, flags, ASR). Rejected units stay here, so a changed verdict can bring them back.
 *  - `apps/web/public/voice/<voiceKey>/manifest.<hash>.json` (immutable, content-hashed) + `apps/web/public/voice/index.json`:
 *    what the browser reads. Derived from the store and the listener's verdicts (`review.<voiceKey>.json`): only CHECKED
 *    units are published — the recogniser agreed (`qa: "asr"`) or a listener said «Хорошо» (verdict `ok` → `qa: "ear"`);
 *    `reject` and `redo` never, nor a unit that is unchecked (`auto`), failed the recogniser or a process gate
 *    (`needsEar`): nothing at runtime reads `qa`, so a take with a wrong square must never reach the manifest (the
 *    planner then treats it as missing: the split form, or the generic line). Written with tmp + rename, the index
 *    last, so a reader sees either the old library or the new one, never a half-written file.
 *  - «Дозапись голоса»: the overlay (./overlay.ts) is published by the same code with `rule: 'overlay'` — its units
 *    reach `qa: "asr"` under the overlay's hard / soft gates (verify.ts), and its manifest also carries `ctx`, the
 *    `alsoKeys` of each take (folded into `keys`) and `blocked`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CLIP_CATALOG } from '../../packages/core/src/coach/clips/catalog.ru.ts';
import { catalogFallbacks } from '../../packages/core/src/coach/clips/catalog.ts';
import { CODEC, LIBRARY_WARN_BYTES, LOUDNESS, VOICE, VOICE_KEY } from './config.ts';
import type { PartRole, UnitEnd, UnitKind } from './jobs.ts';
import { alsoKeysOf } from './overlay.ts';
import type { QaRule } from './overlay.ts';

export type Qa = 'auto' | 'needsEar' | 'asr' | 'ear';

export interface AsrResult {
  heard: string;
  score: number;
  ok: boolean;
  missing: string[];
  model: string;
  at: string;
}

export interface UnitRecord {
  id: string;
  key: string;
  text: string;
  take: number;
  ms: number;
  on: number;
  off: number;
  file: string;
  qa: Qa;
  mood?: string;
  sylps?: number;
  tier?: string;
  // ── tools only (never published) ──
  pool?: string;
  /** every pool the take serves (a plain wording of a `byPiece` / `byGender` line joins every variant pool) */
  pools?: string[];
  kind?: UnitKind;
  end?: UnitEnd;
  /** the lesson model (overlay): how the part is said — a `lead` / `leadAlone` is checked for a continuing end */
  role?: PartRole;
  /** the words a placeholder produced (the overlay's ASR must hear them) */
  critical?: string[];
  /** a lead whose end did not fall (F0 > 210 Hz): published `ctx: 'cont'`, played only right before its tail */
  ctx?: 'cont';
  jobId: string;
  jobKey: string;
  cut: number;
  bytes: number;
  atempo?: number;
  lufs?: number;
  truePeak?: number;
  flags: string[];
  asr?: AsrResult;
  processedAt: string;
}

export interface UnitStore {
  v: 1;
  voiceKey: string;
  units: Record<string, UnitRecord>;
  /** (overlay) charged jobs whose master did not split into its pieces → the reason: a paid attempt without a take */
  requeued?: Record<string, string>;
}

export type Verdict = 'ok' | 'redo' | 'reject';
export type Verdicts = Record<string, { verdict: Verdict; note?: string }>;

export interface ManifestUnit {
  key: string;
  text: string;
  take: number;
  ms: number;
  on: number;
  off: number;
  file: string;
  qa: Qa;
  mood?: string;
  sylps?: number;
  tier?: string;
  /** an interjection («Ого!», a bark): the planner puts no bark in front of it */
  interj?: boolean;
  /** (overlay) a continuing lead: only right before its tail */
  ctx?: 'cont';
}

export interface Manifest {
  v: 1;
  voiceKey: string;
  libraryVersion: number;
  voice: { provider: string; model: string; variant: string; voiceType: string; voiceId: string };
  codec: typeof CODEC;
  loudness: typeof LOUDNESS;
  units: Record<string, ManifestUnit>;
  pools: Record<string, string[]>;
  keys: Record<string, string[]>;
  /** the catalogue's L3 siblings (`fallback` of a line), which the browser's planner walks when a pool is missing */
  fallbacks: Record<string, string>;
  /** (overlay) unit keys that will not be recorded again: the book avoids them, the server never requests them */
  blocked?: string[];
}

/**
 * How a manifest is built: the static library (default) or the overlay («Дозапись голоса»): `ctx` published, every
 * take also under the keys of the variants whose words are the same (`alsoKeysOf`), the `blocked` keys. Both carry the
 * catalogue's fallbacks: the overlay holds lesson-v3 units (played by exact keys) AND whole catalogue sentences of the
 * older events (a greeting, an answer…), which the web's pool route finds by their pools and walks by their siblings
 * — even when the static library is not loaded.
 */
export interface PublishOptions {
  rule?: QaRule;
  blocked?: readonly string[];
}

export interface LibraryIndex {
  default: string;
  voices: Record<string, string>;
}

export function writeJsonAtomic(file: string, data: unknown, pretty = true): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${pretty ? JSON.stringify(data, null, 1) : JSON.stringify(data)}\n`, 'utf8');
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function readStore(file: string): UnitStore {
  const store = readJson<UnitStore>(file);
  if (store === null) return { v: 1, voiceKey: VOICE_KEY, units: {} };
  if (store.v !== 1 || store.voiceKey !== VOICE_KEY) throw new Error(`${file} is not a ${VOICE_KEY} unit store`);
  return store;
}

export function writeStore(file: string, store: UnitStore): void {
  const units: Record<string, UnitRecord> = {};
  for (const id of Object.keys(store.units).sort()) units[id] = store.units[id]!;
  writeJsonAtomic(file, { ...store, units });
}

export function readVerdicts(file: string): Verdicts {
  const raw = readJson<Record<string, unknown>>(file) ?? {};
  const out: Verdicts = {};
  for (const [id, value] of Object.entries(raw)) {
    const v = value as { verdict?: unknown; note?: unknown };
    if (v && (v.verdict === 'ok' || v.verdict === 'redo' || v.verdict === 'reject')) {
      out[id] = { verdict: v.verdict, ...(typeof v.note === 'string' && v.note !== '' ? { note: v.note } : {}) };
    }
  }
  return out;
}

function push(map: Record<string, string[]>, key: string, id: string): void {
  (map[key] ??= []).push(id);
}

/**
 * May this unit be heard by a child? Only a checked one: a listener's «Хорошо», or the recogniser's agreement with no
 * failed ASR — never `reject` / `redo`, never unchecked (`auto`) or flagged (`needsEar`) without a listener's «Хорошо».
 */
export function isPublishable(u: Pick<UnitRecord, 'qa' | 'asr'>, verdict: Verdict | undefined): boolean {
  if (verdict === 'reject' || verdict === 'redo') return false;
  if (verdict === 'ok') return true;
  return (u.qa === 'asr' || u.qa === 'ear') && u.asr?.ok !== false;
}

/** The browser manifest (without `libraryVersion` bookkeeping): deterministic order, only publishable units. */
export function buildManifest(store: UnitStore, verdicts: Verdicts, libraryVersion: number, o: PublishOptions = {}): Manifest {
  const overlay = o.rule === 'overlay';
  const units: Record<string, ManifestUnit> = {};
  const pools: Record<string, string[]> = {};
  const keys: Record<string, string[]> = {};
  const ids = Object.keys(store.units).sort((a, b) => {
    const ua = store.units[a]!;
    const ub = store.units[b]!;
    return ua.key < ub.key ? -1 : ua.key > ub.key ? 1 : ua.take - ub.take || (a < b ? -1 : 1);
  });
  for (const id of ids) {
    const u = store.units[id]!;
    const verdict = verdicts[id]?.verdict;
    if (!isPublishable(u, verdict)) continue;
    units[id] = {
      key: u.key,
      text: u.text,
      take: u.take,
      ms: u.ms,
      on: u.on,
      off: u.off,
      file: u.file,
      qa: verdict === 'ok' ? 'ear' : u.qa,
      ...(u.mood !== undefined ? { mood: u.mood } : {}),
      ...(u.sylps !== undefined ? { sylps: u.sylps } : {}),
      ...(u.tier !== undefined ? { tier: u.tier } : {}),
      ...(u.kind === 'bark' ? { interj: true } : {}),
      ...(overlay && u.ctx === 'cont' ? { ctx: 'cont' as const } : {}),
    };
    push(keys, u.key, id);
    if (overlay) for (const k of alsoKeysOf(u.key, u.text)) push(keys, k, id);
    for (const pool of new Set([...(u.pool !== undefined ? [u.pool] : []), ...(u.pools ?? [])])) push(pools, pool, id);
  }
  const sortObj = (o: Record<string, string[]>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
  return {
    v: 1,
    voiceKey: VOICE_KEY,
    libraryVersion,
    voice: { provider: VOICE.provider, model: VOICE.model, variant: VOICE.variant, voiceType: VOICE.voiceType, voiceId: VOICE.voiceId },
    codec: CODEC,
    loudness: LOUDNESS,
    units,
    pools: sortObj(pools),
    keys: sortObj(keys),
    fallbacks: catalogFallbacks(CLIP_CATALOG),
    ...(overlay ? { blocked: [...new Set(o.blocked ?? [])].sort() } : {}),
  };
}

export function readIndex(libraryRoot: string): LibraryIndex | null {
  return readJson<LibraryIndex>(path.join(libraryRoot, 'index.json'));
}

export function readCurrentManifest(libraryRoot: string, voiceKey = VOICE_KEY): Manifest | null {
  const rel = readIndex(libraryRoot)?.voices[voiceKey];
  return rel === undefined ? null : readJson<Manifest>(path.join(libraryRoot, rel));
}

function contentHash(manifest: Manifest): string {
  const { libraryVersion: _ignored, ...content } = manifest;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 12);
}

export interface PublishResult {
  changed: boolean;
  file: string;
  libraryVersion: number;
  units: number;
  bytes: number;
  warnings: string[];
}

/**
 * Publishes the manifest: when the content changed, a new `manifest.<hash>.json` (version + 1) and then the index,
 * both atomically; manifests older than the previous one are removed (the previous one stays for readers that
 * fetched the old index a moment ago). MP3 files are never deleted here.
 */
export function publishManifest(libraryRoot: string, store: UnitStore, verdicts: Verdicts, o: PublishOptions = {}): PublishResult {
  const current = readCurrentManifest(libraryRoot);
  const draft = buildManifest(store, verdicts, current?.libraryVersion ?? 0, o);
  const bytes = Object.values(store.units).reduce((n, u) => n + (isPublishable(u, verdicts[u.id]?.verdict) ? u.bytes : 0), 0);
  const warnings = bytes > LIBRARY_WARN_BYTES ? [`библиотека ${(bytes / 1e6).toFixed(1)} МБ — больше 60 МБ`] : [];
  const index = readIndex(libraryRoot);
  const currentRel = index?.voices[VOICE_KEY];
  if (current === null && Object.keys(draft.units).length === 0 && (draft.blocked ?? []).length === 0) {
    // nothing recorded yet: do not create an empty library the app would then load
    return { changed: false, file: '', libraryVersion: 0, units: 0, bytes, warnings };
  }
  if (current !== null && currentRel !== undefined && contentHash(current) === contentHash(draft)) {
    return { changed: false, file: path.join(libraryRoot, currentRel), libraryVersion: current.libraryVersion, units: Object.keys(draft.units).length, bytes, warnings };
  }
  const manifest: Manifest = { ...draft, libraryVersion: (current?.libraryVersion ?? 0) + 1 };
  const rel = `${VOICE_KEY}/manifest.${contentHash(manifest)}.json`;
  const file = path.join(libraryRoot, rel);
  writeJsonAtomic(file, manifest, false);
  const nextIndex: LibraryIndex = { default: index?.default ?? VOICE_KEY, voices: { ...(index?.voices ?? {}), [VOICE_KEY]: rel } };
  writeJsonAtomic(path.join(libraryRoot, 'index.json'), nextIndex);
  const keep = new Set([path.basename(rel), ...(currentRel !== undefined ? [path.basename(currentRel)] : [])]);
  const dir = path.join(libraryRoot, VOICE_KEY);
  for (const name of readdirSync(dir)) {
    if (/^manifest\.[0-9a-f]+\.json$/.test(name) && !keep.has(name)) rmSync(path.join(dir, name), { force: true });
  }
  return { changed: true, file, libraryVersion: manifest.libraryVersion, units: Object.keys(manifest.units).length, bytes, warnings };
}
