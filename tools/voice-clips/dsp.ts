/**
 * Pure signal analysis on mono Float32 PCM (no ffmpeg, no I/O), shared by `process`, `verify` and `review`.
 * Methods follow docs/voice-clips/SPEC.md §10.1: 10 ms RMS frames for levels, silence below −55 dBFS, F0 by
 * normalised autocorrelation over 110–520 Hz (voiced when r > 0.65 and louder than −45 dBFS).
 */
import { EDGE_F0_MAX_HZ, FADE_MS, SILENCE_DB } from './config.ts';

export interface Span {
  /** first sample (inclusive) */
  start: number;
  /** last sample + 1 */
  end: number;
}

const FRAME_MS = 10;

export function msToSamples(ms: number, rate: number): number {
  return Math.round((ms * rate) / 1000);
}

export function samplesToMs(samples: number, rate: number): number {
  return (samples * 1000) / rate;
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function db(power: number): number {
  return power > 0 ? 10 * Math.log10(power) : -120;
}

/** RMS level (dBFS) of consecutive, non-overlapping 10 ms frames; the last partial frame counts too. */
export function frameLevels(pcm: Float32Array, rate: number): { hop: number; levels: Float64Array } {
  const hop = msToSamples(FRAME_MS, rate);
  const count = Math.ceil(pcm.length / hop);
  const levels = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    const start = f * hop;
    const end = Math.min(pcm.length, start + hop);
    let sum = 0;
    for (let i = start; i < end; i++) sum += pcm[i]! * pcm[i]!;
    levels[f] = db(sum / Math.max(1, end - start));
  }
  return { hop, levels };
}

/** Runs of frames below `thresholdDb` (in samples), in time order. */
export function silentRuns(pcm: Float32Array, rate: number, thresholdDb = SILENCE_DB): Span[] {
  const { hop, levels } = frameLevels(pcm, rate);
  const runs: Span[] = [];
  let from = -1;
  for (let f = 0; f <= levels.length; f++) {
    const silent = f < levels.length && levels[f]! < thresholdDb;
    if (silent && from < 0) from = f;
    if (!silent && from >= 0) {
      runs.push({ start: from * hop, end: Math.min(pcm.length, f * hop) });
      from = -1;
    }
  }
  return runs;
}

/** First and last sound (frames at or above the threshold), or null for an all-silent signal. */
export function soundSpan(pcm: Float32Array, rate: number, thresholdDb = SILENCE_DB): Span | null {
  const { hop, levels } = frameLevels(pcm, rate);
  let first = -1;
  let last = -1;
  for (let f = 0; f < levels.length; f++) {
    if (levels[f]! >= thresholdDb) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return null;
  return { start: first * hop, end: Math.min(pcm.length, (last + 1) * hop) };
}

/** Silences strictly inside the sound span (leading and trailing silence excluded). */
export function innerSilences(pcm: Float32Array, rate: number, thresholdDb = SILENCE_DB): Span[] {
  const span = soundSpan(pcm, rate, thresholdDb);
  if (span === null) return [];
  return silentRuns(pcm, rate, thresholdDb).filter((run) => run.start > span.start && run.end < span.end);
}

export type SplitResult = { ok: true; segments: Span[] } | { ok: false; found: number; expected: number };

/** Less sound than this between two gaps is a click or a lip noise, never a piece of speech. */
const MIN_PIECE_SOUND_MS = 80;

/**
 * Drops the gaps that only cut off a blip: while some piece between gaps holds < 80 ms of sound (e.g. the 20 ms click
 * at −44 dBFS that ends the splice-test take M), the gap separating it from its closer neighbour is removed.
 */
function withoutBlipGaps(pcm: Float32Array, rate: number, gaps: Span[]): Span[] {
  const minSound = msToSamples(MIN_PIECE_SOUND_MS, rate);
  const kept = [...gaps];
  for (;;) {
    const bounds = [0, ...kept.map((g) => Math.round((g.start + g.end) / 2)), pcm.length];
    let tiny = -1;
    for (let i = 0; i + 1 < bounds.length; i++) {
      const s = soundSpan(pcm.subarray(bounds[i]!, bounds[i + 1]!), rate);
      if (s === null || s.end - s.start < minSound) {
        tiny = i;
        break;
      }
    }
    if (tiny < 0 || kept.length === 0) return kept;
    // piece i lies between gap i−1 and gap i: drop the shorter of the two (or the only one at an edge)
    const before = tiny - 1;
    const after = tiny;
    const drop = before < 0 ? after : after >= kept.length ? before : kept[before]!.end - kept[before]!.start <= kept[after]!.end - kept[after]!.start ? before : after;
    kept.splice(drop, 1);
  }
}

/**
 * Cuts a take into `pieces` segments at inner silences of at least `minSilenceMs`, cutting in the middle of each gap.
 *  - `tags`: every such gap is a tag boundary; their count must be exactly pieces − 1 (else the job is re-queued);
 *  - `longest`: the pieces − 1 longest such gaps are used (a head cut at its natural dash pause).
 */
export function splitAtSilences(pcm: Float32Array, rate: number, pieces: number, mode: 'tags' | 'longest', minSilenceMs: number): SplitResult {
  const min = msToSamples(minSilenceMs, rate);
  const gaps = withoutBlipGaps(pcm, rate, innerSilences(pcm, rate).filter((run) => run.end - run.start >= min));
  let cuts: Span[];
  if (mode === 'tags') {
    if (gaps.length !== pieces - 1) return { ok: false, found: gaps.length + 1, expected: pieces };
    cuts = gaps;
  } else {
    if (gaps.length < pieces - 1) return { ok: false, found: gaps.length + 1, expected: pieces };
    cuts = [...gaps].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, pieces - 1).sort((a, b) => a.start - b.start);
  }
  const segments: Span[] = [];
  let start = 0;
  for (const cut of cuts) {
    const mid = Math.round((cut.start + cut.end) / 2);
    segments.push({ start, end: mid });
    start = mid;
  }
  segments.push({ start, end: pcm.length });
  return { ok: true, segments };
}

// ── F0 and voicing ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PitchFrame {
  /** centre of the frame, in samples of the original signal */
  at: number;
  /** Hz, or 0 when unvoiced */
  f0: number;
  levelDb: number;
}

/**
 * F0 track: 40 ms frames every 10 ms on a 2:1 decimated copy, normalised autocorrelation over 110–520 Hz, the shortest
 * lag within 5 % of the best correlation (avoids octave-down errors), parabolic refinement.
 */
export function pitchTrack(pcm: Float32Array, rate: number, span: Span = { start: 0, end: pcm.length }): PitchFrame[] {
  const decim = 2;
  const r = rate / decim;
  const n = Math.floor((span.end - span.start) / decim);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = span.start + i * decim;
    x[i] = (pcm[j]! + (pcm[j + 1] ?? pcm[j]!)) / 2;
  }
  const win = Math.round(0.04 * r);
  const hop = Math.round(0.01 * r);
  const minLag = Math.floor(r / 520);
  const maxLag = Math.ceil(r / 110);
  const frames: PitchFrame[] = [];
  for (let s = 0; s + win + maxLag <= n; s += hop) {
    let energy = 0;
    for (let i = s; i < s + win; i++) energy += x[i]! * x[i]!;
    const levelDb = db(energy / win);
    const at = span.start + (s + win / 2) * decim;
    if (levelDb < -45) {
      frames.push({ at, f0: 0, levelDb });
      continue;
    }
    const corr = new Float64Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let num = 0;
      let e2 = 0;
      for (let i = s; i < s + win; i++) {
        num += x[i]! * x[i + lag]!;
        e2 += x[i + lag]! * x[i + lag]!;
      }
      const c = num / Math.sqrt(energy * e2 || 1);
      corr[lag] = c;
      if (lag <= maxLag && c > best) best = c;
    }
    if (best <= 0.65) {
      frames.push({ at, f0: 0, levelDb });
      continue;
    }
    let lag = minLag;
    for (; lag <= maxLag; lag++) {
      if (corr[lag]! >= best * 0.95 && corr[lag]! >= corr[lag - 1]! && corr[lag]! >= corr[lag + 1]!) break;
    }
    const a = corr[lag - 1] ?? 0;
    const b = corr[lag]!;
    const c = corr[lag + 1] ?? 0;
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    frames.push({ at, f0: r / (lag + shift), levelDb });
  }
  return frames;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface PitchStats {
  medianF0: number;
  /** median of the last 5 voiced frames (the unit's right edge), 0 when unvoiced */
  edgeF0: number;
  voicedFraction: number;
}

export function pitchStats(pcm: Float32Array, rate: number, span?: Span): PitchStats {
  const frames = pitchTrack(pcm, rate, span);
  const loud = frames.filter((f) => f.levelDb >= -45);
  const voiced = frames.filter((f) => f.f0 > 0).map((f) => f.f0);
  return {
    medianF0: median(voiced),
    edgeF0: median(voiced.slice(-5)),
    voicedFraction: loud.length === 0 ? 0 : voiced.length / loud.length,
  };
}

export function edgeFallOk(stats: PitchStats): boolean {
  return stats.edgeF0 === 0 || stats.edgeF0 <= EDGE_F0_MAX_HZ;
}

// ── Breaths at unit edges ──────────────────────────────────────────────────────────────────────────────────────────

/** Share of high-frequency energy: E[(x[n]−x[n−1])²] / E[x²] (≈ 2 for white noise, ≪ 1 for voiced speech). */
export function hfRatio(pcm: Float32Array, span: Span): number {
  let e = 0;
  let d = 0;
  for (let i = Math.max(1, span.start); i < span.end; i++) {
    e += pcm[i]! * pcm[i]!;
    const diff = pcm[i]! - pcm[i - 1]!;
    d += diff * diff;
  }
  return e > 0 ? d / e : 0;
}

function peakDb(pcm: Float32Array, rate: number, span: Span): number {
  const { levels } = frameLevels(pcm.subarray(span.start, span.end), rate);
  let max = -120;
  for (const l of levels) max = Math.max(max, l);
  return max;
}

/**
 * Breath islands at the start or end of a segment: a separate sound island (a gap of ≥ 80 ms to the speech), 80–400 ms
 * long, quieter than −38 dBFS, almost unvoiced and noise-like (SPEC §10.1: −42…−47 dBFS, 130–200 ms, no F0, flat
 * spectrum); also clicks — islands under 60 ms, quieter than −35 dBFS, ≥ 120 ms away from the speech (take M ends in
 * one). Word-final «ф»/«ть» are attached to their word (no gap) and are never touched. Returns the span to keep.
 */
export function stripEdgeBreaths(pcm: Float32Array, rate: number, span: Span): Span {
  const seg = pcm.subarray(span.start, span.end);
  const gapMin = msToSamples(80, rate);
  const runs = silentRuns(seg, rate).filter((run) => run.end - run.start >= gapMin);
  const islands: Span[] = [];
  let from = 0;
  for (const run of runs) {
    if (run.start > from) islands.push({ start: from, end: run.start });
    from = run.end;
  }
  if (from < seg.length) islands.push({ start: from, end: seg.length });
  const sounding = islands.filter((isl) => soundSpan(seg.subarray(isl.start, isl.end), rate) !== null);
  if (sounding.length < 2) return span;
  let first = 0;
  let last = sounding.length - 1;
  /** Is the island at `index` (currently the first or the last kept one) a breath or a click? */
  const isBreath = (index: number): boolean => {
    const isl = sounding[index]!;
    const inner = soundSpan(seg.subarray(isl.start, isl.end), rate);
    if (inner === null) return false;
    const len = samplesToMs(inner.end - inner.start, rate);
    const abs = { start: isl.start + inner.start, end: isl.start + inner.end };
    const peak = peakDb(seg, rate, abs);
    // a click or lip noise: < 60 ms, quiet, at least 120 ms away from the speech
    if (len < 60) {
      const neighbour = index === first ? sounding[index + 1]! : sounding[index - 1]!;
      const gap = index === first ? neighbour.start - isl.end : isl.start - neighbour.end;
      return peak < -35 && samplesToMs(gap, rate) >= 120;
    }
    if (len > 400 || peak >= -38) return false;
    const stats = pitchStats(seg, rate, abs);
    return stats.voicedFraction < 0.2 && hfRatio(seg, abs) > 0.5;
  };
  while (first < last && isBreath(first)) first++;
  while (last > first && isBreath(last)) last--;
  return { start: span.start + sounding[first]!.start, end: span.start + sounding[last]!.end };
}

// ── Editing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Copy of `pcm[span]` with `before`/`after` samples of margin (zero-padded where the source has none). */
export function withMargins(pcm: Float32Array, span: Span, before: number, after: number): Float32Array {
  const out = new Float32Array(span.end - span.start + before + after);
  const from = span.start - before;
  for (let i = 0; i < out.length; i++) {
    const j = from + i;
    out[i] = j >= 0 && j < pcm.length ? pcm[j]! : 0;
  }
  return out;
}

/** Shortens every inner pause longer than `maxMs` to `clampMs` (slot units: «эф | шесть» pauses). */
export function clampInnerPauses(pcm: Float32Array, rate: number, maxMs: number, clampMs: number): { pcm: Float32Array; clamped: number } {
  const max = msToSamples(maxMs, rate);
  const keep = msToSamples(clampMs, rate);
  const long = innerSilences(pcm, rate).filter((run) => run.end - run.start > max);
  if (long.length === 0) return { pcm, clamped: 0 };
  const parts: Float32Array[] = [];
  let from = 0;
  for (const run of long) {
    const head = Math.floor(keep / 2);
    parts.push(pcm.subarray(from, run.start + head));
    from = run.end - (keep - head);
  }
  parts.push(pcm.subarray(from));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { pcm: out, clamped: long.length };
}

/** Raised-cosine fade-in and fade-out of `FADE_MS` on both edges (in place). */
export function applyFades(pcm: Float32Array, rate: number, ms = FADE_MS): Float32Array {
  const n = Math.min(msToSamples(ms, rate), pcm.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
    pcm[i]! *= g;
    pcm[pcm.length - 1 - i]! *= g;
  }
  return pcm;
}

export function applyGain(pcm: Float32Array, gainDb: number): Float32Array {
  if (gainDb === 0) return pcm;
  const g = dbToGain(gainDb);
  for (let i = 0; i < pcm.length; i++) pcm[i]! *= g;
  return pcm;
}

export function samplePeakDb(pcm: Float32Array): number {
  let max = 0;
  for (let i = 0; i < pcm.length; i++) max = Math.max(max, Math.abs(pcm[i]!));
  return max > 0 ? 20 * Math.log10(max) : -120;
}

export function clippedSamples(pcm: Float32Array): number {
  let n = 0;
  for (let i = 0; i < pcm.length; i++) if (Math.abs(pcm[i]!) >= 0.999) n++;
  return n;
}

// ── Text measures ───────────────────────────────────────────────────────────────────────────────────────────────────

const VOWELS = /[аеёиоуыэюя]/giu;

/** Syllables of Russian text = vowel letters. */
export function syllables(text: string): number {
  return (text.match(VOWELS) ?? []).length;
}

/** Characters that take time to say: letters and digits plus single spaces between words (no punctuation, no tags). */
export function speechChars(text: string): number {
  const words = text
    .replace(/<#[\d.]+#>/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
  return words.length === 0 ? 0 : words.join(' ').length;
}

/** Articulation time: the sound span minus inner pauses of at least `pauseMs`. */
export function articulationMs(pcm: Float32Array, rate: number, pauseMs: number): number {
  const span = soundSpan(pcm, rate);
  if (span === null) return 0;
  const min = msToSamples(pauseMs, rate);
  const paused = innerSilences(pcm, rate)
    .filter((run) => run.end - run.start >= min)
    .reduce((n, run) => n + run.end - run.start, 0);
  return samplesToMs(span.end - span.start - paused, rate);
}
