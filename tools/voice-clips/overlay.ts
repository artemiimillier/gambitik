/**
 * «Дозапись голоса» on the tools' side: where the recorded overlay lives, and the overlay's own publishing rule
 * (docs/voice-clips/ONDEMAND.md). Node-only, no side effects on import.
 *
 * One overlay folder per Mac, outside every checkout (a `git clean` never deletes paid audio, every checkout and the
 * server share one ledger, one budget and one lock). The server serves it read-only under /api/voice/clips/overlay/:
 *
 *   <ov>/index.json                         the library index (same shape as apps/web/public/voice/index.json)
 *   <ov>/giselle-mm1/manifest.<hash>.json    the overlay manifest: published takes, `ctx`, `alsoKeys` folded into `keys`, `blocked`
 *   <ov>/giselle-mm1/<xx>/<id>.mp3           the takes (MP3 48k mono 32 kHz, −18 LUFS)
 *   <ov>/ledger.giselle-mm1.jsonl            the ONE on-demand ledger (server campaign `ondemand`, the operator's `prefetch`)
 *   <ov>/higgsfield.lock                     the machine-wide generator lock (server and `voice:generate`)
 *   <ov>/units.giselle-mm1.json              the unit store (provenance, flags, ASR) · review.giselle-mm1.json the verdicts
 *   <ov>/process-report.giselle-mm1.json     the last `process` · verify-report.giselle-mm1.json the last `verify`
 *   <ov>/.masters/                           the raw masters · state.json (the server's breaker)
 *
 * The overlay's QA rule (the static library keeps the strict rule of manifest.ts `isPublishable` + verify.ts): HARD
 * gates keep a take out (ASR ≥ 0.90 with the critical words in order — the placeholder words and an opening interjection
 * too; units of 1–2 words ≥ 0.75 —, 55–140 ms per character, ≥ 20 % voiced, no clipping, the split count, the rate after
 * `atempo` in 3.2–5.4 syl/s, loudness within 2.5 LU after the re-gain); SOFT flags publish but list the take first on
 * the review page (rate outside 3.4–4.6, an end F0 of 190–210 Hz, «всё/все», an opening's name, an options sentence with
 * more commas than its own, a piece of a free re-cut). A lead whose end stays above 210 Hz is no failure: it is
 * published `ctx: 'cont'`.
 */
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { lineKeyPlaceholderWords, lineKeyText, lineKeyTwins, parseLineUnitKey, placeholderWordsOf, spokenLineOf } from '../../packages/core/src/coach/clips/lines.ts';
import type { PieceType } from '../../packages/shared/src/index.ts';
import { REPO_ROOT, UsageError } from '../lib/cli.ts';
import { ASR_SHORT_MIN_SCORE, DEFAULT_OVERLAY_DIR, PUBLISH_LOCK, SHORT_UNIT_WORDS, VOICE_KEY } from './config.ts';
import { ASR_MIN_SCORE, normalizeRu } from './asr.ts';
import type { CriticalExtra } from './asr.ts';
import { isDiscard } from './jobs.ts';
import type { GenJob, PartRole, UnitKind } from './jobs.ts';
import { acquireLock, tryLock } from './ledger.ts';
import type { LockWait } from './ledger.ts';
import type { UnitRecord, UnitStore, Verdicts } from './manifest.ts';
import { MAX_PAID_ATTEMPTS, OVERLAY_LEDGER } from './ondemand.ts';
import type { OnDemandView } from './ondemand.ts';
import { dotEnvValue, overlayDirProblem, realish, within } from './placement.ts';

// ── Where it lives ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface OverlayPaths {
  dir: string;
  ledgerFile: string;
  mastersDir: string;
  storeFile: string;
  reviewFile: string;
  reportFile: string;
  /** the last `verify` (the server reads which takes the recogniser confirmed) */
  verifyReportFile: string;
  /** the library root the manifest and the takes go into: the overlay folder itself */
  libraryRoot: string;
}

export function overlayPaths(dir: string): OverlayPaths {
  return {
    dir,
    ledgerFile: join(dir, OVERLAY_LEDGER),
    mastersDir: join(dir, '.masters'),
    storeFile: join(dir, `units.${VOICE_KEY}.json`),
    reviewFile: join(dir, `review.${VOICE_KEY}.json`),
    reportFile: join(dir, `process-report.${VOICE_KEY}.json`),
    verifyReportFile: join(dir, `verify-report.${VOICE_KEY}.json`),
    libraryRoot: dir,
  };
}

/**
 * The overlay folder the tools use (null = none): `--overlay <dir|off>` first, then `VOICE_OVERLAY_DIR` (`off` = none)
 * from the environment, then the same line of this checkout's `.env` — the file the server reads it from (the voice
 * scripts run without `--env-file`; only that one line is read, never a key) —, then DEFAULT_OVERLAY_DIR. Otherwise a
 * custom folder in `.env` would give the operator's `voice:generate` another machine-wide lock and another ledger than
 * the server's, and both could create paid jobs at once. Under vitest only an explicit folder counts and `.env` is
 * never read (a test never touches the real overlay). The folder must pass the server's own check (./placement.ts):
 * absolute, outside every git checkout, DATA_DIR and the web build — the server would never serve anything else.
 */
export function resolveOverlayDir(flag: string | undefined, env: NodeJS.ProcessEnv = process.env, repoRoot: string = REPO_ROOT): string | null {
  const dotEnv = join(repoRoot, '.env');
  // belt and braces: no test ever reads this checkout's real .env, whatever environment it passes in
  const readsDotEnv = !env.VITEST && !(process.env.VITEST && resolve(repoRoot) === resolve(REPO_ROOT));
  const fromDotEnv = flag === undefined && env.VOICE_OVERLAY_DIR === undefined && readsDotEnv ? dotEnvValue(dotEnv, 'VOICE_OVERLAY_DIR') : undefined;
  const raw = (flag ?? env.VOICE_OVERLAY_DIR ?? fromDotEnv ?? (env.VITEST ? 'off' : DEFAULT_OVERLAY_DIR)).trim();
  if (raw === '' || raw === 'off' || raw === 'none') return null;
  const from = flag !== undefined ? '--overlay' : env.VOICE_OVERLAY_DIR !== undefined ? 'VOICE_OVERLAY_DIR' : fromDotEnv !== undefined ? 'VOICE_OVERLAY_DIR (.env)' : 'default';
  if (!isAbsolute(raw)) throw new UsageError(`${from}: the overlay folder must be an absolute path (or off), got «${raw}»`);
  const dir = resolve(raw);
  const dataEnv = env.DATA_DIR ?? (readsDotEnv ? dotEnvValue(dotEnv, 'DATA_DIR') : undefined);
  const dataDir = dataEnv !== undefined && dataEnv.trim() !== '' ? resolve(repoRoot, dataEnv.trim()) : join(repoRoot, 'data');
  const problem = overlayDirProblem(dir, { repoRoot, dataDir, webDistDir: join(repoRoot, 'apps', 'web', 'dist') });
  if (problem === null) return dir;
  const why =
    problem === 'repo'
      ? within(realish(dir), realish(repoRoot))
        ? 'is inside this checkout'
        : 'is inside (or around) a git checkout — the server refuses it and a git clean there would delete it'
      : problem === 'data'
        ? 'is inside (or around) the child’s data folder (DATA_DIR)'
        : 'is inside (or around) the web build (apps/web/dist)';
  throw new UsageError(`${from}: the overlay folder ${dir} ${why} — paid audio lives outside every repository (default ${DEFAULT_OVERLAY_DIR})`);
}

/**
 * The overlay's publish lock `<dir>/publish.lock` (the pid-file protocol of every generator lock): `process` and
 * `verify` read, change and rewrite the overlay's unit store and manifest, so two writers at once — the operator's
 * command and the server's finish — could drop each other's takes. The server holds it around its whole finish and
 * runs `process` + `verify` as its own children: a lock held by this process's parent is ours already (no deadlock).
 * `waitMs` 0 (default) = fail at once with `LedgerLocked`.
 */
export async function lockPublish(dir: string, o: LockWait = {}): Promise<() => void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, PUBLISH_LOCK);
  const first = tryLock(lock);
  if ('release' in first) return first.release;
  if (first.holder > 0 && first.holder === process.ppid) return () => {};
  return acquireLock(lock, {
    ...o,
    held: (holder) => `замок ${lock} держит${holder > 0 ? ` процесс ${holder}` : ' другой процесс'}: сервер публикует новые фразы — повторите через пару минут`,
  });
}

// ── What a line unit key says ───────────────────────────────────────────────────────────────────────────────────────
//
// One lookup for both namespaces (core ./clips/lines.ts): a lesson-v3 pool (`v3.*`, @gambit/content) or a whole
// catalogue sentence recorded on demand for an older event (a greeting, an answer …), so a catalogue take gets its twin
// keys, the critical words of its placeholders and its attempts / `blocked[]` accounting exactly as a lesson take does.

/** `line:v3.lead.subject@p/f#4` → its pool, piece, gender and wording number; null for any other key. */
export function parseLineKey(key: string): { pool: string; piece?: PieceType; g?: 'm' | 'f'; n: number } | null {
  return parseLineUnitKey(key);
}

/**
 * Other unit keys a take serves (published as more `keys` entries): the piece / gender variants of the same wording
 * whose expansion is exactly the same words («{он} ушёл» is «он ушёл» for the knight, the bishop and the king). The
 * web and the server find it under any of them, so the same words are never paid for twice.
 */
export function alsoKeysOf(unitKey: string, text: string): string[] {
  return lineKeyTwins(unitKey, text);
}

/**
 * The words a line unit key names in today's content (null: not a line key, or its wording is gone). Writers insert
 * wordings (docs/voice-clips/ONDEMAND.md), so a key's number can come to name other words than a take recorded under it.
 */
export function currentTextOfKey(unitKey: string): string | null {
  return lineKeyText(unitKey);
}

/**
 * A piece's role: its own (`role`), else — a line unit of a lead pool — `lead`, so a take recorded by any tool gets the
 * continuing-lead check (`ctx: 'cont'`) even when its job did not say how the part was said.
 */
export function partRoleOf(piece: { key: string; role?: PartRole }): PartRole | undefined {
  if (piece.role !== undefined) return piece.role;
  const k = parseLineUnitKey(piece.key);
  return k !== null && spokenLineOf(k.pool)?.role === 'lead' ? 'lead' : undefined;
}

/** The words each placeholder of a wording produced for this variant (`{Конём}` → «Конём», `{g:сам|сама}` → «сама»). */
export function placeholderWords(template: string, variant: { piece?: PieceType; g?: 'm' | 'f' }): string[] {
  return placeholderWordsOf(template, variant);
}

/** The placeholder words of a line unit key (from the content, so a take recorded by any tool gets the same check). */
export function criticalWordsOfKey(unitKey: string): string[] {
  return lineKeyPlaceholderWords(unitKey);
}

// ── The overlay's QA rule ───────────────────────────────────────────────────────────────────────────────────────────

/** Which rule a run publishes with: the static library's strict one, or the overlay's (hard / soft gates). */
export type QaRule = 'static' | 'overlay';

/**
 * Soft flags (overlay): published, listed first on the review page. A sample peak above −1 dBFS is one of them: D6's
 * hard gate is clipping (`clipped:` stays hard), and a peak-limited short exclamation may sit at −0.8 dBFS without a
 * single clipped sample. `f0-median` stays hard: a median outside 140–480 Hz is an octave-broken or noisy take, which
 * a recogniser can still read.
 */
const SOFT_FLAG_RE = /^(?:tempo-soft|edge-f0-soft|yo|name|frag-comma|recut|peak)(?::|$)/;
/** What processing did (never a gate): breaths stripped, pauses clamped, a continuing lead, a loudness re-gain. */
const INFO_FLAG_RE = /^(?:breath-stripped|pauses-clamped|cont|regain)(?::|$)/;

export function isSoftFlag(flag: string): boolean {
  return SOFT_FLAG_RE.test(flag);
}

/** Does this flag keep a take back? Static: every gate flag. Overlay: only the hard ones. */
export function isHardFlag(flag: string, rule: QaRule): boolean {
  if (INFO_FLAG_RE.test(flag)) return false;
  return rule === 'static' || !SOFT_FLAG_RE.test(flag);
}

/** A check that could not run (the recogniser crashed, the take's file is missing): no verdict about the take. */
const TOOL_FAILURE_FLAG_RE = /^(?:asr-error|missing-file)(?::|$)/;

export function isToolFailureFlag(flag: string): boolean {
  return TOOL_FAILURE_FLAG_RE.test(flag);
}

/**
 * What the overlay's check knows about a processed take: 'ok' (it may be heard), 'failed' (really checked and turned
 * down: the recogniser disagreed, a hard gate of `process` or `verify`, a listener's reject / redo), or null — not
 * checked yet: processed but not verified (`qa: 'auto'`), or verified while the recogniser could not run. Only a
 * 'failed' take may cost a paid take 2; an unchecked one is still on its way.
 */
export function overlayCheckOf(u: Pick<UnitRecord, 'qa' | 'asr' | 'flags'>, verdict: Verdicts[string]['verdict'] | undefined): 'ok' | 'failed' | null {
  if (verdict === 'reject' || verdict === 'redo') return 'failed';
  if (verdict === 'ok') return 'ok';
  if (u.asr?.ok === false) return 'failed';
  if (u.qa === 'asr' || u.qa === 'ear') return 'ok';
  if (u.qa === 'needsEar' && u.flags.some((f) => isHardFlag(f, 'overlay') && !isToolFailureFlag(f))) return 'failed';
  return null;
}

/**
 * The soft flags a text earns by itself: «всё/все» (ASR folds ё into е, so it cannot tell them apart), a quoted opening
 * name (the recogniser cannot hear its stress), an options sentence with a comma inside a label (the voice may group it
 * wrongly; «A, b или c?» has one comma of its own).
 */
export function softTextFlags(piece: { text: string; kind?: UnitKind }): string[] {
  const flags: string[] = [];
  if (/(?:^|[^\p{L}])вс[её](?:[^\p{L}]|$)/iu.test(piece.text)) flags.push('yo');
  if (/[«»„“”"]/u.test(piece.text)) flags.push('name');
  if (piece.kind === 'frag' && (piece.text.match(/,/g) ?? []).length > 1) flags.push('frag-comma');
  return flags;
}

/**
 * The ASR check of a take under a rule: the static rule as always; the overlay's adds the placeholder words (from the
 * unit, else from its key) and an opening interjection to the critical items, and lets a unit of 1–2 words pass at 0.75.
 */
export function asrRuleOf(unit: Pick<UnitRecord, 'key' | 'text' | 'critical'>, rule: QaRule): { minScore: number; extra: CriticalExtra } {
  if (rule === 'static') return { minScore: ASR_MIN_SCORE, extra: {} };
  const short = normalizeRu(unit.text).length <= SHORT_UNIT_WORDS;
  return { minScore: short ? ASR_SHORT_MIN_SCORE : ASR_MIN_SCORE, extra: { words: unit.critical ?? criticalWordsOfKey(unit.key), interjection: true } };
}

// ── blocked[] ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The overlay's `blocked[]` (S6): unit keys that will not be recorded again — no publishable take, nothing in flight
 * for them, and either a listener rejected a take, or the paid attempts are used up: MAX_PAID_ATTEMPTS charged jobs
 * that were processed (a take came out of them, or the split did not match), one more after a listener's `redo`.
 * Only takes and attempts of the words the key names TODAY count (`currentTextOfKey`): after writers insert a wording,
 * a number that shifted to new words is not blocked by the old words' failures. Recomputed on every publish, so a
 * later good take or verdict unblocks. `publishable` is the rule of the manifest.
 */
export function blockedKeys(store: UnitStore, verdicts: Verdicts, view: OnDemandView | null, publishable: (u: UnitRecord) => boolean, textOf: (key: string) => string | null = currentTextOfKey): string[] {
  const current = new Map<string, string | null>();
  const today = (key: string, text: string): boolean => {
    if (!current.has(key)) current.set(key, textOf(key));
    const words = current.get(key) ?? null;
    return words === null || words === text;
  };
  const byKey = new Map<string, UnitRecord[]>();
  for (const u of Object.values(store.units)) if (today(u.key, u.text)) byKey.set(u.key, [...(byKey.get(u.key) ?? []), u]);
  const processedJobs = new Set([...Object.values(store.units).map((u) => u.jobId), ...Object.keys(store.requeued ?? {})]);
  const charged = new Map<string, number>();
  const inFlight = new Set<string>();
  const keysOf = (job: GenJob): string[] => job.pieces.flatMap((p) => (isDiscard(p) || !today(p.key, p.text) ? [] : [p.key]));
  for (const job of view?.ledger.jobs.values() ?? []) {
    const keys = keysOf(job.job);
    if (job.state === 'pending' || (job.state === 'charged' && !processedJobs.has(job.jobId))) for (const k of keys) inFlight.add(k);
    else if (job.state === 'charged') for (const k of keys) charged.set(k, (charged.get(k) ?? 0) + 1);
  }
  for (const intent of view?.unresolved ?? []) for (const k of keysOf(intent.job)) inFlight.add(k);
  const out = new Set<string>();
  for (const key of new Set([...byKey.keys(), ...charged.keys()])) {
    const takes = byKey.get(key) ?? [];
    if (takes.some(publishable) || inFlight.has(key)) continue;
    const rejected = takes.some((u) => verdicts[u.id]?.verdict === 'reject');
    const redo = takes.some((u) => verdicts[u.id]?.verdict === 'redo');
    if (rejected || (charged.get(key) ?? 0) >= MAX_PAID_ATTEMPTS + (redo ? 1 : 0)) out.add(key);
  }
  return [...out].sort();
}
