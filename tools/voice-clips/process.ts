/**
 * `voice:process` (free): every downloaded master in the ledger → library units (SPEC §10 `process`).
 *
 *   loudnorm the whole take to −18 LUFS / −1.5 dBTP (linear gain, measured by ffmpeg)
 *   → split at tag silences (≥ 550 ms below −55 dBFS; piece count ≠ expected ⇒ the job is re-queued, no units)
 *   → per unit: strip edge breaths, trim at −55 dBFS, clamp inner slot pauses > 120 ms to 60 ms
 *   → tempo gate 4.0 ± 0.6 syl/s (`atempo` 0.8–1.3 pulls a take just inside the band; a take that needs more is kept
 *     with the clamped factor, flagged for a listener's ear and listed for a re-render while it has < 3 recordings)
 *   → edge F0 ≤ 190 Hz for falling units → `atempo` on the speech core → 30 ms / 60 ms margins → 5 ms raised-cosine
 *     fades → per-unit loudness touch-up → MP3 48k mono 32 kHz
 *   → onset/offset re-measured on the decoded MP3 → unit store → manifest + index (atomic).
 * Nothing is played; ffmpeg only reads and writes files.
 *
 * «Дозапись голоса» (`qa: 'overlay'`, ./overlay.ts): the same chain with the overlay's rule — the rate after `atempo`
 * is a hard gate only outside 3.2–5.4 syl/s (outside 3.4–4.6 it is the soft `tempo-soft`); a lead (`role`) whose end
 * stays above 210 Hz is kept as `ctx: 'cont'`, an end of 190–210 Hz is soft; a unit whose encoded loudness is off by
 * 1–2.5 LU is re-encoded with the corrected gain (`regain`); «всё/все», names and comma-heavy options are soft flags;
 * a pack whose tags gave the wrong count is re-cut for free at its longest pauses ≥ 250 ms (soft `recut`: each piece
 * must still pass ASR); a job that still does not split is remembered in the store (`requeued`: a paid attempt without
 * a take); the manifest is published with `ctx`, `alsoKeys` and `blocked`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  ATEMPO_MAX,
  ATEMPO_MIN,
  CONT_F0_HZ,
  EDGE_F0_MAX_HZ,
  KEEP_AFTER_MS,
  KEEP_BEFORE_MS,
  LOUDNESS_SLACK_DB,
  LUFS_TOLERANCE,
  MAX_TEMPO_RENDERS,
  OVERLAY_TEMPO_MAX,
  OVERLAY_TEMPO_MIN,
  RECUT_MIN_SILENCE_MS,
  REGAIN_MAX_LU,
  SAMPLE_RATE,
  SLOT_PAUSE_CLAMP_MS,
  SLOT_PAUSE_MAX_MS,
  TAG_SILENCE_MS,
  TARGET_LUFS,
  TARGET_TRUE_PEAK,
  TEMPO_MIN_SYLLABLES,
  TEMPO_PAUSE_MS,
  TEMPO_PULL_MARGIN,
  TEMPO_TARGET,
  TEMPO_TOLERANCE,
  VOICE_KEY,
} from './config.ts';
import { atempoPcm, decodeToPcm, encodeMp3, measureLoudness, normalisingGain } from './audio.ts';
import {
  applyFades,
  applyGain,
  articulationMs,
  clampInnerPauses,
  edgeFallOk,
  msToSamples,
  pitchStats,
  samplesToMs,
  soundSpan,
  splitAtSilences,
  stripEdgeBreaths,
  syllables,
  withMargins,
} from './dsp.ts';
import type { Span } from './dsp.ts';
import { clipFile, clipId } from './ids.ts';
import { isDiscard } from './jobs.ts';
import type { GenJob, UnitEnd, UnitPiece } from './jobs.ts';
import type { LedgerJob } from './ledger.ts';
import { isPublishable, publishManifest, readStore, readVerdicts, writeJsonAtomic, writeStore } from './manifest.ts';
import type { PublishResult, UnitRecord, UnitStore } from './manifest.ts';
import { readOnDemandLedger } from './ondemand.ts';
import { blockedKeys, isHardFlag, partRoleOf, softTextFlags } from './overlay.ts';
import type { QaRule } from './overlay.ts';

export interface ProcessOptions {
  ledgerFile: string;
  mastersDir: string;
  storeFile: string;
  reviewFile: string;
  reportFile: string;
  libraryRoot: string;
  /** base folder for temp files (a fresh sub-folder is made and removed per run) */
  work: string;
  /** re-process jobs whose units already exist */
  force?: boolean;
  /** only these Higgsfield job ids */
  only?: readonly string[];
  /** 'overlay' = «Дозапись голоса»: the overlay's QA rule and manifest (default 'static': the committed library) */
  qa?: QaRule;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RequeueEntry {
  jobId: string;
  jobKey: string;
  prompt: string;
  reason: string;
  keys: string[];
}

export interface RerenderEntry {
  id: string;
  key: string;
  jobKey: string;
  sylps: number;
  recordings: number;
}

export interface ProcessReport {
  at: string;
  processedJobs: number;
  skippedJobs: number;
  units: number;
  requeue: RequeueEntry[];
  rerender: RerenderEntry[];
  needsEar: { id: string; key: string; flags: string[] }[];
  missingMasters: string[];
  publish: PublishResult | null;
}

export interface TempoDecision {
  /** the atempo factor to apply (1 = none) */
  factor: number;
  /** false when the take needed more than the allowed atempo range */
  inRange: boolean;
}

/**
 * Tempo gate: inside 4.0 ± 0.6 syl/s nothing happens; outside, pull to 0.1 inside the band within atempo 0.8–1.3.
 * `inRange` judges the rate AFTER the clamped factor (5.63 syl/s needs ×0.799 for 4.5 but reaches 4.504 at ×0.8:
 * that take is in the band, not a re-render).
 */
export function tempoDecision(sylps: number): TempoDecision {
  const lo = TEMPO_TARGET - TEMPO_TOLERANCE;
  const hi = TEMPO_TARGET + TEMPO_TOLERANCE;
  if (!Number.isFinite(sylps) || sylps <= 0 || (sylps >= lo && sylps <= hi)) return { factor: 1, inRange: true };
  const target = sylps < lo ? lo + TEMPO_PULL_MARGIN : hi - TEMPO_PULL_MARGIN;
  const factor = target / sylps;
  if (factor >= ATEMPO_MIN && factor <= ATEMPO_MAX) return { factor, inRange: true };
  const clamped = Math.min(ATEMPO_MAX, Math.max(ATEMPO_MIN, factor));
  const final = sylps * clamped;
  return { factor: clamped, inRange: final >= lo - 1e-9 && final <= hi + 1e-9 };
}

/** Falling edge expected: explicit `end`, else slot units and lines ending in «.» or «—». */
export function unitEnd(piece: UnitPiece): UnitEnd {
  if (piece.end !== undefined) return piece.end;
  if (piece.kind === 'slot') return 'fall';
  return /[.—]\s*$/.test(piece.text) ? 'fall' : 'any';
}

/**
 * The overlay's loudness touch-up after the first encode (dB; 0 = leave the unit as it is): the step to −18 LUFS when
 * the unit is 1–2.5 LU off, but a quiet unit is raised only up to the −1.5 dBTP true-peak ceiling. The re-encode is a
 * plain gain without a limiter, so raising a peak-limited unit (a short exclamation with a high crest factor) by the
 * full step would put its peaks near 0 dBFS — `peak` / `clipped` in verify, a lost take and a paid take 2 — while the
 * unit as it is passes verify's 2.5 LU window. A loud unit is always brought down.
 */
export function regainDb(measured: { lufs: number; truePeak: number }): number {
  const off = TARGET_LUFS - measured.lufs;
  if (!Number.isFinite(off) || Math.abs(off) <= LUFS_TOLERANCE || Math.abs(off) > REGAIN_MAX_LU) return 0;
  const headroom = Number.isFinite(measured.truePeak) ? TARGET_TRUE_PEAK - measured.truePeak : 0;
  const add = off > 0 ? Math.min(off, Math.max(0, headroom)) : off;
  return Math.abs(add) >= LOUDNESS_SLACK_DB ? add : 0;
}

interface JobResult {
  units: UnitRecord[];
  requeue?: RequeueEntry;
  rerender: RerenderEntry[];
}

function unitPieces(job: GenJob): { piece: UnitPiece; cut: number }[] {
  const out: { piece: UnitPiece; cut: number }[] = [];
  job.pieces.forEach((piece, cut) => {
    if (!isDiscard(piece)) out.push({ piece, cut });
  });
  return out;
}

function round(n: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function processJob(ledgered: LedgerJob, master: string, opts: ProcessOptions & { work: string }, recordings: Map<string, number>, at: string): Promise<JobResult> {
  const { job } = ledgered;
  const overlay = opts.qa === 'overlay';
  const rate = SAMPLE_RATE;
  const pcm = await decodeToPcm(master, rate);
  applyGain(pcm, normalisingGain(await measureLoudness(master)));

  const split = job.split ?? { mode: 'tags' as const, minSilenceMs: TAG_SILENCE_MS };
  let parts = job.pieces.length === 1 ? { ok: true as const, segments: [{ start: 0, end: pcm.length }] } : splitAtSilences(pcm, rate, job.pieces.length, split.mode, split.minSilenceMs);
  // the overlay's free re-cut (docs/voice-clips/ONDEMAND.md): a tag that came out short is looked for at the longest pauses ≥ 250 ms;
  // a wrong cut cannot slip through — each piece must still pass ASR on its own words (a hard gate of the overlay)
  let recut = false;
  if (!parts.ok && overlay && split.mode === 'tags') {
    const again = splitAtSilences(pcm, rate, job.pieces.length, 'longest', RECUT_MIN_SILENCE_MS);
    if (again.ok) {
      parts = again;
      recut = true;
    }
  }
  const requeueOf = (reason: string): JobResult => ({
    units: [],
    rerender: [],
    requeue: { jobId: ledgered.jobId, jobKey: ledgered.key, prompt: job.prompt, reason, keys: unitPieces(job).map((u) => u.piece.key) },
  });
  if (!parts.ok) return requeueOf(`split: ${parts.found} pieces, expected ${parts.expected}`);

  const units: UnitRecord[] = [];
  const rerender: RerenderEntry[] = [];
  for (const { piece, cut } of unitPieces(job)) {
    const seg = parts.segments[cut]!;
    const segPcm = pcm.subarray(seg.start, seg.end);
    const sound = soundSpan(segPcm, rate);
    if (sound === null) return requeueOf(`piece ${cut + 1} is silent`);
    const kept: Span = stripEdgeBreaths(segPcm, rate, sound);
    const flags: string[] = recut ? ['recut'] : [];
    if (kept.start !== sound.start || kept.end !== sound.end) flags.push('breath-stripped');
    // the speech core (trimmed at −55 dBFS, breaths gone); margins are added last so atempo cannot smear them
    let core: Float32Array = segPcm.slice(kept.start, kept.end);
    if (piece.kind === 'slot') {
      const clamped = clampInnerPauses(core, rate, SLOT_PAUSE_MAX_MS, SLOT_PAUSE_CLAMP_MS);
      core = clamped.pcm;
      if (clamped.clamped > 0) flags.push(`pauses-clamped:${clamped.clamped}`);
    }

    let atempo = 1;
    let sylps: number | undefined;
    const syl = syllables(piece.text);
    if (piece.tempo !== false && syl >= TEMPO_MIN_SYLLABLES) {
      const art = articulationMs(core, rate, TEMPO_PAUSE_MS);
      const measured = art > 0 ? syl / (art / 1000) : 0;
      const decision = tempoDecision(measured);
      atempo = decision.factor;
      sylps = round(measured * atempo, 2);
      const final = measured * atempo;
      // the overlay: only a rate outside 3.2–5.4 after atempo is a defect; outside the strict band it is a soft flag
      const hard = overlay ? measured > 0 && (final < OVERLAY_TEMPO_MIN || final > OVERLAY_TEMPO_MAX) : !decision.inRange;
      if (hard) {
        const key = piece.key;
        const count = recordings.get(key) ?? 1;
        flags.push(`tempo:${round(measured, 2)}`);
        if (count < MAX_TEMPO_RENDERS) rerender.push({ id: clipId(VOICE_KEY, job.prompt, cut, job.take), key, jobKey: ledgered.key, sylps: round(measured, 2), recordings: count });
      } else if (overlay && !decision.inRange) flags.push(`tempo-soft:${round(final, 2)}`);
    }

    let ctx: 'cont' | undefined;
    const role = overlay ? partRoleOf(piece) : piece.role;
    if (overlay && (role === 'lead' || role === 'leadAlone')) {
      // a lead: one falling take serves both uses; a take whose end keeps rising is no failure, only 'cont'
      const edge = pitchStats(core, rate).edgeF0;
      if (edge > CONT_F0_HZ) {
        ctx = 'cont';
        flags.push(`cont:${Math.round(edge)}`);
      } else if (edge > EDGE_F0_MAX_HZ) flags.push(`edge-f0-soft:${Math.round(edge)}`);
    } else if (unitEnd(piece) === 'fall') {
      const stats = pitchStats(core, rate);
      if (!edgeFallOk(stats)) flags.push(`${overlay ? 'edge-f0-soft' : 'edge-f0'}:${Math.round(stats.edgeF0)}`);
    }
    if (overlay) flags.push(...softTextFlags(piece));

    if (atempo !== 1) {
      const stretched = await atempoPcm(core, atempo, opts.work);
      const span = soundSpan(stretched, rate);
      core = span === null ? stretched : stretched.slice(span.start, span.end);
    }
    const unit = withMargins(core, { start: 0, end: core.length }, msToSamples(KEEP_BEFORE_MS, rate), msToSamples(KEEP_AFTER_MS, rate));
    applyFades(unit, rate);
    const loud = await measureLoudness({ pcm: unit, work: opts.work });
    const touch = normalisingGain(loud);
    let gainDb = Math.abs(touch) >= LOUDNESS_SLACK_DB ? touch : 0;

    const id = clipId(VOICE_KEY, job.prompt, cut, job.take);
    const file = clipFile(id);
    const out = path.join(opts.libraryRoot, VOICE_KEY, file);
    await encodeMp3(unit, out, { gainDb, work: opts.work });
    if (overlay) {
      // the overlay re-gains a unit the encoder left 1–2.5 LU off instead of flagging it (the same PCM, a new gain) —
      // within the true-peak headroom: a peak-limited unit stays a little quiet, which verify's 2.5 LU window accepts
      const add = regainDb(await measureLoudness(out));
      if (add !== 0) {
        gainDb += add;
        await encodeMp3(unit, out, { gainDb, work: opts.work });
        flags.push(`regain:${add > 0 ? '+' : ''}${add.toFixed(1)}`);
      }
    }
    const decoded = await decodeToPcm(out, rate);
    const final = soundSpan(decoded, rate) ?? { start: 0, end: decoded.length };

    const needsEar = overlay ? flags.some((f) => isHardFlag(f, 'overlay')) : flags.some((f) => f.startsWith('tempo') || f.startsWith('edge-f0'));
    units.push({
      id,
      key: piece.key,
      text: piece.text,
      take: job.take,
      ms: Math.round(samplesToMs(decoded.length, rate)),
      on: Math.round(samplesToMs(final.start, rate)),
      off: Math.round(samplesToMs(final.end, rate)),
      file,
      qa: needsEar ? 'needsEar' : 'auto',
      ...(piece.mood !== undefined ? { mood: piece.mood } : {}),
      ...(sylps !== undefined ? { sylps } : {}),
      ...((piece.tier ?? job.tier) !== undefined ? { tier: piece.tier ?? job.tier } : {}),
      ...(piece.pool !== undefined ? { pool: piece.pool } : {}),
      ...(piece.pools !== undefined && piece.pools.length > 0 ? { pools: piece.pools } : {}),
      ...(piece.kind !== undefined ? { kind: piece.kind } : {}),
      end: unitEnd(piece),
      ...(role !== undefined ? { role } : {}),
      ...(piece.critical !== undefined && piece.critical.length > 0 ? { critical: piece.critical } : {}),
      ...(ctx !== undefined ? { ctx } : {}),
      jobId: ledgered.jobId,
      jobKey: ledgered.key,
      cut,
      bytes: statSync(out).size,
      ...(atempo !== 1 ? { atempo: round(atempo, 4) } : {}),
      ...(Number.isFinite(loud.lufs) ? { lufs: round(loud.lufs + gainDb, 1) } : {}),
      ...(Number.isFinite(loud.truePeak) ? { truePeak: round(loud.truePeak + gainDb, 1) } : {}),
      flags,
      processedAt: at,
    });
  }
  return { units, rerender };
}

/** How many recordings each unit key has in the ledger (charged jobs that contain it). */
export function recordingsByKey(jobs: Iterable<LedgerJob>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    if (job.state !== 'charged') continue;
    for (const { piece } of unitPieces(job.job)) counts.set(piece.key, (counts.get(piece.key) ?? 0) + 1);
  }
  return counts;
}

function alreadyProcessed(job: LedgerJob, store: UnitStore, libraryRoot: string): boolean {
  return unitPieces(job.job).every(({ cut }) => {
    const id = clipId(VOICE_KEY, job.job.prompt, cut, job.job.take);
    const unit = store.units[id];
    return unit !== undefined && existsSync(path.join(libraryRoot, VOICE_KEY, unit.file));
  });
}

export async function runProcess(opts: ProcessOptions): Promise<ProcessReport> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const at = now().toISOString();
  mkdirSync(opts.work, { recursive: true });
  const work = mkdtempSync(path.join(opts.work, 'process-'));
  const overlay = opts.qa === 'overlay';
  const onDemand = readOnDemandLedger(opts.ledgerFile);
  const view = onDemand.ledger;
  const store = readStore(opts.storeFile);
  const recordings = recordingsByKey(view.jobs.values());
  const report: ProcessReport = { at, processedJobs: 0, skippedJobs: 0, units: 0, requeue: [], rerender: [], needsEar: [], missingMasters: [], publish: null };
  try {
    for (const job of view.jobs.values()) {
      if (job.state !== 'charged') continue;
      if (opts.only !== undefined && !opts.only.includes(job.jobId)) continue;
      const master = job.master === undefined ? null : path.join(opts.mastersDir, job.master);
      if (master === null || !existsSync(master)) {
        report.missingMasters.push(job.jobId);
        continue;
      }
      if (opts.force !== true && alreadyProcessed(job, store, opts.libraryRoot)) {
        report.skippedJobs++;
        continue;
      }
      const result = await processJob(job, master, { ...opts, work }, recordings, at);
      report.processedJobs++;
      for (const [id, unit] of Object.entries(store.units)) if (unit.jobId === job.jobId && !result.units.some((u) => u.id === id)) delete store.units[id];
      for (const unit of result.units) {
        store.units[unit.id] = unit;
        report.units++;
        if (unit.qa === 'needsEar') report.needsEar.push({ id: unit.id, key: unit.key, flags: unit.flags });
      }
      if (result.requeue) {
        report.requeue.push(result.requeue);
        log(`задание ${job.jobId}: ${result.requeue.reason} — юниты вернутся в очередь меньшими заданиями`);
      }
      if (overlay) {
        // a split that did not match is still a paid attempt at its units (they count towards blocked[])
        const requeued = { ...(store.requeued ?? {}) };
        if (result.requeue) requeued[job.jobId] = result.requeue.reason;
        else delete requeued[job.jobId];
        store.requeued = requeued;
      }
      report.rerender.push(...result.rerender);
    }
    writeStore(opts.storeFile, store);
    const verdicts = readVerdicts(opts.reviewFile);
    report.publish = overlay
      ? publishManifest(opts.libraryRoot, store, verdicts, { rule: 'overlay', blocked: blockedKeys(store, verdicts, onDemand, (u) => isPublishable(u, verdicts[u.id]?.verdict)) })
      : publishManifest(opts.libraryRoot, store, verdicts);
    writeJsonAtomic(opts.reportFile, report);
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
