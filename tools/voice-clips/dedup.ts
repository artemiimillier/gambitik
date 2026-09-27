/**
 * «Дозапись голоса»: dedup by UNIT (docs/voice-clips/ONDEMAND.md) for the parent's `voice:generate` into the overlay (the
 * prefetch) and for the whole-library campaign (`voice:library-plan` / `voice:library-run`, ./library.ts). A plan is
 * made hours before it is paid for; meanwhile the server records phrases on demand, packed into OTHER prompts — so its
 * job keys never match the plan's, and a job-key check alone would pay for the same words again (and past the 2 paid
 * attempts per unit). Right before each create the run asks here, under the locks, whether any piece of the job is
 * already covered. Node-only, reads files only, no side effects on import.
 *
 * The rule is the server's (apps/server/src/voiceGen/service.ts `unitState`), in its order: published (exact key, a
 * twin's key or the text index, the static library or the overlay) → blocked or rejected by the parent → held by an
 * overlay job or an unresolved intent → (with the checkout's tools files) a `pilot`-tier take the recogniser confirmed that
 * waits for the parent's ear → the paid attempts used up (both ledgers, MAX_PAID_ATTEMPTS, +1 after a `redo`).
 * The files are re-read only when they change (stamps), so a long run sees every publication of the server at the cost
 * of a few `stat` calls per job.
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { mergeClipIndexes } from '../../packages/core/src/coach/clips/keys.ts';
import type { ClipIndexLayer } from '../../packages/core/src/coach/clips/keys.ts';
import type { MergedClipIndex } from '../../packages/core/src/coach/clips/types.ts';
import { lineKeyTwins, takesForLine } from '../../packages/core/src/coach/clips/lines.ts';
import { VOICE_KEY } from './config.ts';
import { clipId } from './ids.ts';
import { isDiscard } from './jobs.ts';
import type { GenJob } from './jobs.ts';
import { readCurrentManifest, readStore, readVerdicts } from './manifest.ts';
import type { Manifest } from './manifest.ts';
import { MAX_PAID_ATTEMPTS, onDemandViewOf, readOnDemandLedger, unitAttempts } from './ondemand.ts';
import type { OnDemandView } from './ondemand.ts';
import { overlayCheckOf, overlayPaths } from './overlay.ts';

/** Why a unit needs no new paid take (null = it does). */
export type UnitCovered = (piece: { key: string; text: string }, view: OnDemandView) => string | null;

/** The checkout's own files of the static library (the `pilot` tier): its unit store, verdicts and ledger. */
export interface ToolsFiles {
  ledgerFile: string;
  storeFile: string;
  reviewFile: string;
}

export interface CoverageInput {
  overlayDir: string;
  staticLibrary: string | null;
  /**
   * The checkout's tools files: a `pilot`-tier take the recogniser confirmed that waits for the parent's ear covers its words,
   * and the tools ledger's paid attempts count towards MAX_PAID_ATTEMPTS — as the server counts them. Absent = neither.
   */
  tools?: ToolsFiles | null;
  /**
   * 'held' (default): any overlay job that did not fail covers its units (pending, or charged — recorded, or its paid
   * attempt used even if the check failed: the plan never buys a second take); 'retake': a charged job whose takes of
   * the unit were all checked and failed — or whose split did not match — no longer covers it, only the paid attempts
   * decide (the server's rule for its one paid take 2; the library's re-render pass).
   */
  mode?: 'held' | 'retake';
}

/** A file's identity: the tools write with tmp + rename (a new inode), the ledgers append (a new size). */
function stamp(file: string | null): string {
  if (file === null) return '-';
  try {
    const st = statSync(file);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

function layerOf(root: string | null): ClipIndexLayer | null {
  if (root === null) return null;
  let m: Manifest | null;
  try {
    m = readCurrentManifest(root);
  } catch {
    // a torn manifest: nothing published there as far as we can tell (the ledger still holds every paid attempt)
    return null;
  }
  return m === null ? null : { units: m.units, keys: m.keys, pools: m.pools, fallbacks: m.fallbacks ?? {}, voiceKey: m.voiceKey, blocked: m.blocked ?? [] };
}

/** What the libraries and stores say, read once per change of their files. */
export interface CoverageSnapshot {
  merged: MergedClipIndex;
  /** `key|text` of overlay takes the parent rejected / asked to redo */
  rejected: ReadonlySet<string>;
  redo: ReadonlySet<string>;
  /** overlay clip id → the check that settled it (tools `overlayCheckOf`); absent = not checked yet */
  checks: ReadonlyMap<string, 'ok' | 'failed'>;
  /** overlay jobs whose master did not split into its pieces (a paid attempt without a take) */
  requeued: ReadonlySet<string>;
  /** `key|text` of the checkout's takes the recogniser confirmed that wait for the parent's ear */
  awaitingEar: ReadonlySet<string>;
  /** the tools ledger's paid attempts (no intents there) */
  toolsView: OnDemandView;
}

/** A loader of the snapshot that re-reads only what changed since the last call. */
export function coverageSnapshots(o: Pick<CoverageInput, 'overlayDir' | 'staticLibrary' | 'tools'>): () => CoverageSnapshot {
  const ov = overlayPaths(o.overlayDir);
  const tools = o.tools ?? null;
  let last: { key: string; snap: CoverageSnapshot } | null = null;
  return () => {
    const key = [
      stamp(o.staticLibrary === null ? null : path.join(o.staticLibrary, 'index.json')),
      stamp(path.join(ov.libraryRoot, 'index.json')),
      stamp(ov.storeFile),
      stamp(ov.reviewFile),
      stamp(tools?.storeFile ?? null),
      stamp(tools?.reviewFile ?? null),
      stamp(tools?.ledgerFile ?? null),
    ].join('|');
    if (last?.key === key) return last.snap;
    const merged = mergeClipIndexes(layerOf(o.staticLibrary), layerOf(ov.libraryRoot));
    const rejected = new Set<string>();
    const redo = new Set<string>();
    const checks = new Map<string, 'ok' | 'failed'>();
    const requeued = new Set<string>();
    try {
      const store = readStore(ov.storeFile);
      const verdicts = readVerdicts(ov.reviewFile);
      for (const [id, u] of Object.entries(store.units)) {
        const verdict = verdicts[id]?.verdict;
        if (verdict === 'reject') rejected.add(`${u.key}|${u.text}`);
        if (verdict === 'redo') redo.add(`${u.key}|${u.text}`);
        const check = overlayCheckOf(u, verdict);
        if (check !== null) checks.set(id, check);
      }
      for (const jobId of Object.keys(store.requeued ?? {})) requeued.add(jobId);
    } catch {
      // a torn store: the ledger below still knows every paid attempt
    }
    const awaitingEar = new Set<string>();
    let toolsView: OnDemandView = onDemandViewOf([]);
    if (tools !== null) {
      try {
        const store = readStore(tools.storeFile);
        const verdicts = readVerdicts(tools.reviewFile);
        for (const [id, u] of Object.entries(store.units)) {
          const verdict = verdicts[id]?.verdict;
          // a take the parent turned down (or asked to redo) may be bought again, within the paid attempts
          if (u.asr?.ok === true && verdict !== 'reject' && verdict !== 'redo') awaitingEar.add(`${u.key}|${u.text}`);
        }
      } catch {
        // a torn store: nothing waits as far as we can tell (its ledger still counts the paid attempts)
      }
      // the tools ledger has no intent lines: its view is the plain one
      toolsView = readOnDemandLedger(tools.ledgerFile);
    }
    const snap: CoverageSnapshot = { merged, rejected, redo, checks, requeued, awaitingEar, toolsView };
    last = { key, snap };
    return snap;
  };
}

/** Every key with exactly these words (its own first): the piece / gender variants, a catalogue line's twins. */
export function twinKeysOf(piece: { key: string; text: string }): ReadonlySet<string> {
  return new Set([piece.key, ...lineKeyTwins(piece.key, piece.text)]);
}

/** A job holds the unit: its words under its key or a twin's (the same words for another piece, or another line). */
function holds(job: GenJob, piece: { text: string }, twins: ReadonlySet<string>): boolean {
  return job.pieces.some((p) => !isDiscard(p) && twins.has(p.key) && p.text === piece.text);
}

/** The clip ids a job's pieces with these words became (what `process` names them). */
export function takeIdsOf(job: GenJob, piece: { text: string }, twins: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  job.pieces.forEach((p, cut) => {
    if (!isDiscard(p) && twins.has(p.key) && p.text === piece.text) ids.push(clipId(VOICE_KEY, job.prompt, cut, job.take));
  });
  return ids;
}

/**
 * Why `piece` needs no new paid take under the snapshot `snap` and the overlay ledger's view `view` (null = it does);
 * see the module comment for the order. Pure: the callers read the files. `tools`: the checkout's awaiting-ear takes
 * and paid attempts count (the snapshot was made with its tools files).
 */
export function coveredWhy(piece: { key: string; text: string }, view: OnDemandView, snap: CoverageSnapshot, o: { mode?: 'held' | 'retake'; tools?: boolean } = {}): string | null {
  const twins = twinKeysOf(piece);
  if (takesForLine(snap.merged, piece.key, piece.text).length > 0) return 'уже записана';
  if (snap.merged.blocked.has(piece.key)) return 'больше не записывается (blocked)';
  if (snap.rejected.has(`${piece.key}|${piece.text}`)) return 'отклонена владельцем';
  const retake = o.mode === 'retake';
  for (const job of view.ledger.jobs.values()) {
    if (job.state === 'failed' || !holds(job.job, piece, twins)) continue;
    if (retake && job.state === 'charged') {
      // settled: the split did not match, or every take of these words was really checked (and none is published)
      const ids = takeIdsOf(job.job, piece, twins);
      if (snap.requeued.has(job.jobId) || (ids.length > 0 && ids.every((id) => snap.checks.has(id)))) continue;
    }
    return `уже в задании ${job.jobId} («${job.campaign}»)`;
  }
  if (view.unresolved.some((i) => holds(i.job, piece, twins))) return 'в задании, которое ещё выясняется';
  if (o.tools === true) {
    for (const key of twins) if (snap.awaitingEar.has(`${key}|${piece.text}`)) return 'ждёт ушей владельца (voice:review)';
  }
  // the overlay ledger's paid attempts always count (a retake pass may never buy a third take); the tools ledger's too
  // when the snapshot has the checkout's files
  const unit = { key: piece.key, text: piece.text, twins };
  const attempts = unitAttempts(view, unit) + (o.tools === true ? unitAttempts(snap.toolsView, unit) : 0);
  if (attempts >= MAX_PAID_ATTEMPTS + (snap.redo.has(`${piece.key}|${piece.text}`) ? 1 : 0)) return `платные попытки исчерпаны (${attempts})`;
  return null;
}

/**
 * A unit is covered — never bought again — when it is published (exact key, a twin's key — the same words — or the
 * text index, the static library or the overlay), blocked or rejected by the parent, or held by any overlay job that did
 * not fail (pending, or charged: recorded, or its paid attempt used even if the check failed — the server gives it its
 * take 2 on demand, within the 2-attempt cap) or by an unresolved intent; with `tools`, also a `pilot`-tier take waiting for
 * the parent's ear and a unit out of paid attempts (both ledgers). `mode: 'retake'` lets a settled failed take through
 * (the paid attempts decide). The libraries are re-read whenever they change: the server may publish while the run
 * holds the machine-wide lock.
 */
export function unitCoverage(o: CoverageInput): UnitCovered {
  const snapshot = coverageSnapshots(o);
  const tools = (o.tools ?? null) !== null;
  return (piece, view) => coveredWhy(piece, view, snapshot(), { mode: o.mode ?? 'held', tools });
}

/**
 * What `voice:generate` checks by unit before each create (./generate.ts `unitCovered`), by the ledger it writes:
 *  - into the overlay (the parent's prefetch): the static library and the overlay, and the tools ledger's job ids are
 *    never adopted (`otherLedgers`);
 *  - a static campaign (the tools ledger) while this Mac has an overlay: what the server recorded, or is recording, on
 *    demand — whole catalogue sentences under the static library's own keys (the static library itself stays the
 *    campaign's own business: its plan and its job keys);
 *  - no overlay at all: nothing (no server records anything here).
 */
export function generateCoverage(o: { overlayDir: string | null; intoOverlay: boolean; staticLibrary: string; toolsLedger: string }): { otherLedgers?: readonly string[]; unitCovered?: UnitCovered } {
  if (o.overlayDir === null) return {};
  if (o.intoOverlay) return { otherLedgers: [o.toolsLedger], unitCovered: unitCoverage({ overlayDir: o.overlayDir, staticLibrary: o.staticLibrary }) };
  return { unitCovered: unitCoverage({ overlayDir: o.overlayDir, staticLibrary: null }) };
}
