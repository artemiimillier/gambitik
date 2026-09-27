/**
 * `voice:verify` (free): quality gates on every processed unit, then the automatic listening check (SPEC §10).
 *
 * Gates (on the decoded library MP3):
 *   - duration per character of speech 55–140 ms (texts of ≥ 8 characters; catches skipped or doubled words);
 *   - sample peak ≤ −1 dBFS and no clipped samples;
 *   - integrated loudness within ±1 LU of −18 (units long enough to gate);
 *   - median F0 140–480 Hz and a voiced share ≥ 20 % (catches noise, garbage and octave-broken takes);
 *   - edge F0 ≤ 190 Hz for falling units;
 *   - ASR (whisper.cpp, optional but on by default when installed): transcript vs text, `asr.ts` rules.
 * A unit that passes everything becomes `qa: "asr"` (or keeps `ear` if a listener already approved it); any failure
 * makes it `needsEar` with the reasons in `flags`. The unit store and the manifest are rewritten atomically.
 *
 * «Дозапись голоса» (`qa: 'overlay'`, ./overlay.ts): only the HARD gates hold a take back — loudness only when it is
 * more than 2.5 LU off (process re-gains closer ones), no edge check (process decided `ctx` / the soft flag), ASR with
 * the placeholder words and an opening interjection as critical items and 0.75 for units of 1–2 words; soft flags
 * publish. A take still needs the recogniser's agreement (`qa: "asr"`): without whisper nothing new is published.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  EDGE_F0_MAX_HZ,
  REGAIN_MAX_LU,
  F0_MEDIAN_MAX_HZ,
  F0_MEDIAN_MIN_HZ,
  LUFS_TOLERANCE,
  MS_PER_CHAR_MAX,
  MS_PER_CHAR_MIN,
  MS_PER_CHAR_MIN_CHARS,
  PEAK_MAX_DBFS,
  SAMPLE_RATE,
  TARGET_LUFS,
  VOICE_KEY,
} from './config.ts';
import { matchTranscript, transcribe, whisperProblem } from './asr.ts';
import type { WhisperSetup } from './asr.ts';
import { decodeToPcm, measureLoudness } from './audio.ts';
import { clippedSamples, pitchStats, samplePeakDb, soundSpan, speechChars } from './dsp.ts';
import { isPublishable, publishManifest, readStore, readVerdicts, writeJsonAtomic, writeStore } from './manifest.ts';
import type { PublishResult, UnitRecord } from './manifest.ts';
import { readOnDemandLedger } from './ondemand.ts';
import { asrRuleOf, blockedKeys, isHardFlag } from './overlay.ts';
import type { QaRule } from './overlay.ts';

export interface VerifyOptions {
  storeFile: string;
  reviewFile: string;
  libraryRoot: string;
  work: string;
  /** where the JSON report goes (e.g. test-results/voice-review/verify.json) */
  reportFile: string;
  /** null: no ASR (gates only) */
  whisper: WhisperSetup | null;
  /** re-run ASR on units that already have a result */
  reasr?: boolean;
  only?: readonly string[];
  /** 'overlay' = «Дозапись голоса»: the overlay's hard / soft gates and manifest (default 'static') */
  qa?: QaRule;
  /** (overlay) its ledger: paid attempts per unit key for `blocked[]` */
  ledgerFile?: string;
  now?: () => Date;
  log?: (line: string) => void;
  /** injectable for tests */
  transcribeFn?: (file: string, setup: WhisperSetup, work: string) => Promise<string>;
}

export interface UnitVerdict {
  id: string;
  key: string;
  text: string;
  flags: string[];
  heard?: string;
  score?: number;
}

export interface VerifyReport {
  at: string;
  units: number;
  passed: number;
  needsEar: UnitVerdict[];
  asr: 'on' | 'off';
  asrNote?: string;
  publish: PublishResult | null;
}

/** Flags that `verify` owns (recomputed every run); flags from `process` (tempo, breath, edge) are kept. */
const VERIFY_FLAG = /^(ms-per-char|peak|clipped|lufs|f0-median|voiced|edge-f0-verify|asr|asr-missing|asr-error|missing-file)/;

export function gateFlags(unit: UnitRecord, pcm: Float32Array, rate: number, lufs: number, rule: QaRule = 'static'): string[] {
  const overlay = rule === 'overlay';
  const flags: string[] = [];
  const chars = speechChars(unit.text);
  const span = soundSpan(pcm, rate);
  const speechMs = span === null ? 0 : ((span.end - span.start) * 1000) / rate;
  if (chars >= MS_PER_CHAR_MIN_CHARS) {
    const perChar = speechMs / chars;
    if (perChar < MS_PER_CHAR_MIN || perChar > MS_PER_CHAR_MAX) flags.push(`ms-per-char:${Math.round(perChar)}`);
  }
  const peak = samplePeakDb(pcm);
  if (peak > PEAK_MAX_DBFS) flags.push(`peak:${peak.toFixed(1)}`);
  const clipped = clippedSamples(pcm);
  if (clipped > 0) flags.push(`clipped:${clipped}`);
  if (Number.isFinite(lufs) && lufs > -70 && Math.abs(lufs - TARGET_LUFS) > (overlay ? REGAIN_MAX_LU : LUFS_TOLERANCE)) flags.push(`lufs:${lufs.toFixed(1)}`);
  const stats = pitchStats(pcm, rate);
  if (stats.medianF0 > 0 && (stats.medianF0 < F0_MEDIAN_MIN_HZ || stats.medianF0 > F0_MEDIAN_MAX_HZ)) flags.push(`f0-median:${Math.round(stats.medianF0)}`);
  if (stats.voicedFraction < 0.2) flags.push(`voiced:${Math.round(stats.voicedFraction * 100)}%`);
  if (!overlay && unit.end === 'fall' && stats.edgeF0 > EDGE_F0_MAX_HZ) flags.push(`edge-f0-verify:${Math.round(stats.edgeF0)}`);
  return flags;
}

export async function runVerify(opts: VerifyOptions): Promise<VerifyReport> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const store = readStore(opts.storeFile);
  const verdicts = readVerdicts(opts.reviewFile);
  mkdirSync(opts.work, { recursive: true });
  const work = mkdtempSync(path.join(opts.work, 'verify-'));
  let whisper = opts.whisper;
  let asrNote: string | undefined;
  if (whisper !== null) {
    const problem = await whisperProblem(whisper);
    if (problem !== null && opts.transcribeFn === undefined) {
      asrNote = `ASR выключен: ${problem}`;
      log(asrNote);
      whisper = null;
    }
  }
  const transcribeFn = opts.transcribeFn ?? transcribe;
  const rule: QaRule = opts.qa ?? 'static';
  const report: VerifyReport = { at: now().toISOString(), units: 0, passed: 0, needsEar: [], asr: whisper === null ? 'off' : 'on', ...(asrNote ? { asrNote } : {}), publish: null };
  try {
    for (const unit of Object.values(store.units)) {
      if (opts.only !== undefined && !opts.only.includes(unit.id)) continue;
      report.units++;
      const file = path.join(opts.libraryRoot, VOICE_KEY, unit.file);
      const kept = unit.flags.filter((f) => !VERIFY_FLAG.test(f));
      let flags: string[];
      const asrRule = asrRuleOf(unit, rule);
      try {
        const pcm = await decodeToPcm(file, SAMPLE_RATE);
        const loud = await measureLoudness(file);
        flags = gateFlags(unit, pcm, SAMPLE_RATE, loud.lufs, rule);
      } catch {
        flags = ['missing-file'];
      }
      let heard: string | undefined;
      let score: number | undefined;
      if (!flags.includes('missing-file')) {
        if (unit.asr !== undefined && (opts.reasr !== true || whisper === null)) {
          // an earlier transcript is re-judged with the current rules (free, no model needed)
          heard = unit.asr.heard;
          const again = matchTranscript(unit.text, unit.asr.heard, asrRule.minScore, asrRule.extra);
          score = again.score;
          unit.asr = { ...unit.asr, score: again.score, ok: again.ok, missing: again.missing };
          if (!again.ok) flags.push(again.missing.length > 0 ? `asr-missing:${again.missing.join('|')}` : `asr:${again.score}`);
        } else if (whisper !== null) {
          try {
            heard = await transcribeFn(file, whisper, work);
            const m = matchTranscript(unit.text, heard, asrRule.minScore, asrRule.extra);
            score = m.score;
            unit.asr = { heard, score: m.score, ok: m.ok, missing: m.missing, model: path.basename(whisper.model), at: now().toISOString() };
            if (!m.ok) flags.push(m.missing.length > 0 ? `asr-missing:${m.missing.join('|')}` : `asr:${m.score}`);
          } catch (err) {
            flags.push('asr-error');
            log(`ASR ${unit.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      const processFlagsNeedEar = kept.some((f) => f.startsWith('tempo') || f.startsWith('edge-f0'));
      unit.flags = [...kept, ...flags];
      const approved = verdicts[unit.id]?.verdict === 'ok';
      // the overlay publishes past its soft flags; the static library holds back on any flag
      const clean = rule === 'overlay' ? !unit.flags.some((f) => isHardFlag(f, 'overlay')) : flags.length === 0 && !processFlagsNeedEar;
      if (clean) {
        unit.qa = approved ? 'ear' : unit.asr?.ok === true ? 'asr' : 'auto';
        report.passed++;
      } else {
        unit.qa = approved ? 'ear' : 'needsEar';
        report.needsEar.push({ id: unit.id, key: unit.key, text: unit.text, flags: unit.flags, ...(heard !== undefined ? { heard } : {}), ...(score !== undefined ? { score } : {}) });
      }
    }
    writeStore(opts.storeFile, store);
    report.publish =
      rule === 'overlay'
        ? publishManifest(opts.libraryRoot, store, verdicts, {
            rule,
            blocked: blockedKeys(store, verdicts, opts.ledgerFile === undefined ? null : readOnDemandLedger(opts.ledgerFile), (u) => isPublishable(u, verdicts[u.id]?.verdict)),
          })
        : publishManifest(opts.libraryRoot, store, verdicts);
    writeJsonAtomic(opts.reportFile, report);
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
