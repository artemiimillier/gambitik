/**
 * `process` end to end with REAL ffmpeg on synthetic tones in $TMPDIR (nothing is played; skipped without ffmpeg):
 * a ledger with downloaded masters → split, trim, breath strip, pause clamp, tempo, edge F0, loudness, MP3 48k mono
 * 32 kHz → unit store → content-hashed manifest + index.json, written atomically; verdicts applied on publish.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegAvailable, measureLoudness, probe, writeMp3 } from './audio.ts';
import { VOICE_KEY } from './config.ts';
import { jobMilli } from './cost.ts';
import { clipId } from './ids.ts';
import { keyOfJob } from './jobs.ts';
import type { GenJob } from './jobs.ts';
import { appendLedger } from './ledger.ts';
import { buildManifest, isPublishable, readCurrentManifest, readIndex, readStore } from './manifest.ts';
import type { Manifest, UnitStore } from './manifest.ts';
import { runProcess } from './process.ts';
import type { ProcessOptions } from './process.ts';
import { concat, noise, silence, tone } from './testkit.ts';

const hasFfmpeg = await ffmpegAvailable();

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-process-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Setup {
  dir: string;
  opts: ProcessOptions;
  addJob: (job: GenJob, pcm: Float32Array, jobId: string) => Promise<void>;
}

function setup(): Setup {
  const dir = tempDir();
  const opts: ProcessOptions = {
    ledgerFile: path.join(dir, 'ledger.jsonl'),
    mastersDir: path.join(dir, '.masters'),
    storeFile: path.join(dir, 'units.json'),
    reviewFile: path.join(dir, 'review.json'),
    reportFile: path.join(dir, 'report.json'),
    libraryRoot: path.join(dir, 'public', 'voice'),
    work: path.join(dir, 'work'),
    now: () => new Date('2026-09-24T12:00:00.000Z'),
  };
  const addJob = async (job: GenJob, pcm: Float32Array, jobId: string) => {
    // a Higgsfield-like master: MP3 128 kbps, 32 kHz, mono
    await writeMp3(pcm, path.join(opts.mastersDir, `${jobId}.mp3`), 128, dir);
    const key = keyOfJob(job);
    appendLedger(opts.ledgerFile, { ev: 'created', at: '2026-09-24T11:00:00Z', run: 'r1', campaign: 'pilot', key, jobId, milli: jobMilli(job.prompt), job });
    appendLedger(opts.ledgerFile, { ev: 'charged', at: '2026-09-24T11:00:04Z', key, jobId, campaign: 'pilot', milli: jobMilli(job.prompt), status: 'completed', resultUrl: `https://cdn.example/${jobId}.mp3` });
    appendLedger(opts.ledgerFile, { ev: 'downloaded', at: '2026-09-24T11:00:05Z', key, jobId, master: `${jobId}.mp3`, bytes: 1, sha256: 'x' });
  };
  return { dir, opts, addJob };
}

/** Three units separated by tag silences (750 ms); the slot has a 230 ms «эф | шесть» pause; C ends in a breath. */
const BATCH: GenJob = {
  prompt: 'Смотри, тут подарок!<#0.6#>конём на эф шесть<#0.6#>Ход сделан.',
  take: 1,
  recipe: 'whole',
  tier: 'pilot',
  pieces: [
    { key: 'line:treasure.look#1', text: 'Смотри, тут подарок!', pool: 'treasure.look', mood: 'excited' },
    { key: 'slot:ins:n:f6', text: 'конём на эф шесть', kind: 'slot' },
    { key: 'line:test.done#1', text: 'Ход сделан.', pool: 'test.done' },
  ],
};
const BATCH_PCM = concat(
  silence(200),
  tone(230, 1500), // 6 syllables / 1.5 s = 4.0 syl/s: in the band
  silence(750),
  tone(170, 550),
  silence(230), // the pause minimax puts between file and rank
  tone(165, 550), // 5 syllables / 1.16 s after the clamp ≈ 4.3 syl/s; falls to 165 Hz
  silence(750),
  tone(260, 900), // 3 syllables / 0.9 s = 3.3 syl/s → atempo ≈ 1.05; ends high (260 Hz) although it should fall
  silence(150),
  noise(150, -50, 11), // a breath after the line
  silence(300),
);

describe.skipIf(!hasFfmpeg)('process with real ffmpeg (synthetic tones, silent)', () => {
  let batchIds: string[] = [];
  beforeAll(() => {
    batchIds = [0, 1, 2].map((cut) => clipId(VOICE_KEY, BATCH.prompt, cut, 1));
  });

  it('turns a batch master into three library units and an atomic, content-hashed manifest', async () => {
    const s = setup();
    await s.addJob(BATCH, BATCH_PCM, 'job-batch');
    const report = await runProcess(s.opts);
    expect(report.processedJobs).toBe(1);
    expect(report.units).toBe(3);
    expect(report.requeue).toEqual([]);

    const store = readStore(s.opts.storeFile);
    const [a, b, c] = batchIds.map((id) => store.units[id]!);
    expect(a && b && c).toBeTruthy();

    // format: MP3 CBR 48 kbps, mono, 32 kHz, in <id[1..2]>/<id>.mp3
    for (const u of [a!, b!, c!]) {
      const file = path.join(s.opts.libraryRoot, VOICE_KEY, u.file);
      expect(u.file).toBe(`${u.id.slice(1, 3)}/${u.id}.mp3`);
      const info = await probe(file);
      expect(info).toMatchObject({ codec: 'mp3', sampleRate: 32000, channels: 1, bitRate: 48000 });
      // trimmed at −55 dBFS keeping 30 ms before and 60 ms after (10 ms analysis frames)
      expect(u.on).toBeGreaterThanOrEqual(15);
      expect(u.on).toBeLessThanOrEqual(45);
      expect(u.ms - u.off).toBeGreaterThanOrEqual(40);
      expect(u.ms - u.off).toBeLessThanOrEqual(75);
      // every unit at −18 LUFS, true peak ≤ −1.5 dBTP (± MP3 tolerance)
      const loud = await measureLoudness(file);
      expect(Math.abs(loud.lufs + 18)).toBeLessThan(1);
      expect(loud.truePeak).toBeLessThan(-1);
    }

    // A: in the tempo band → untouched, 1.5 s + margins
    expect(a!.atempo).toBeUndefined();
    expect(a!.ms).toBeGreaterThan(1550);
    expect(a!.ms).toBeLessThan(1650);
    expect(a!.qa).toBe('auto');
    expect(a!.mood).toBe('excited');

    // B: the slot's 230 ms inner pause is clamped to 60 ms; it falls to 165 Hz → no edge flag
    expect(b!.flags).toContain('pauses-clamped:1');
    expect(b!.ms).toBeLessThan(1100 + 60 + 90 + 40);
    expect(b!.flags.some((f) => f.startsWith('edge-f0'))).toBe(false);

    // C: breath stripped, atempo pulled in, and the high end (260 Hz) flagged for a listener's ear
    expect(c!.flags).toContain('breath-stripped');
    expect(c!.atempo).toBeGreaterThan(1.03);
    expect(c!.atempo).toBeLessThan(1.08);
    expect(c!.flags.some((f) => f.startsWith('edge-f0:'))).toBe(true);
    expect(c!.qa).toBe('needsEar');
    expect(c!.ms).toBeLessThan(1000);

    // nothing is checked yet (no recogniser, no listener): nothing is published — an unchecked take (maybe a wrong
    // square) must never reach a child
    expect(report.publish?.changed).toBe(false);
    expect(readCurrentManifest(s.opts.libraryRoot)).toBeNull();
    // a listener's «Хорошо» on all three (a take flagged for the ear included): then they are published
    const ok = { verdict: 'ok' };
    writeFileSync(s.opts.reviewFile, JSON.stringify({ [batchIds[0]!]: ok, [batchIds[1]!]: ok, [batchIds[2]!]: ok }));
    const checked = await runProcess(s.opts);
    expect(checked.publish?.changed).toBe(true);

    // manifest + index: SPEC §4.2 shape, pools and keys, tools-only fields left out
    const index = readIndex(s.opts.libraryRoot)!;
    expect(index.default).toBe(VOICE_KEY);
    expect(index.voices[VOICE_KEY]).toMatch(/^giselle-mm1\/manifest\.[0-9a-f]{12}\.json$/);
    const manifest = readCurrentManifest(s.opts.libraryRoot)!;
    expect(manifest).toMatchObject({ v: 1, voiceKey: VOICE_KEY, libraryVersion: 1, codec: { c: 'mp3', kbps: 48, hz: 32000, ch: 1 }, loudness: { lufs: -18, truePeak: -1.5 } });
    expect(manifest.voice).toEqual({ provider: 'higgsfield', model: 'text2speech_v2', variant: 'minimax', voiceType: 'preset', voiceId: '9d3128b8-dd25-5158-9bdb-2e69ac8998b9' });
    expect(Object.keys(manifest.units).sort()).toEqual([...batchIds].sort());
    expect(manifest.pools).toEqual({ 'test.done': [batchIds[2]], 'treasure.look': [batchIds[0]] });
    expect(manifest.keys['slot:ins:n:f6']).toEqual([batchIds[1]]);
    expect(manifest.units[batchIds[0]!]).not.toHaveProperty('jobId');
    expect(manifest.units[batchIds[0]!]).not.toHaveProperty('flags');
    expect(Object.keys(manifest.units[batchIds[0]!]!).sort()).toEqual(['file', 'key', 'mood', 'ms', 'off', 'on', 'qa', 'sylps', 'take', 'text', 'tier'].sort());
    // no temp files left next to the published ones
    expect(readdirSync(path.join(s.opts.libraryRoot, VOICE_KEY)).filter((n) => n.includes('.tmp'))).toEqual([]);
    expect(existsSync(s.opts.reportFile)).toBe(true);

    // second run: nothing to do, the manifest stays byte-identical
    const before = readFileSync(path.join(s.opts.libraryRoot, index.voices[VOICE_KEY]!), 'utf8');
    const again = await runProcess(s.opts);
    expect(again.skippedJobs).toBe(1);
    expect(again.processedJobs).toBe(0);
    expect(again.publish?.changed).toBe(false);
    expect(readFileSync(path.join(s.opts.libraryRoot, readIndex(s.opts.libraryRoot)!.voices[VOICE_KEY]!), 'utf8')).toBe(before);

    // a listener rejects A: the next publish leaves it out (the MP3 stays on disk), version 2, previous manifest kept
    writeFileSync(s.opts.reviewFile, JSON.stringify({ [batchIds[0]!]: { verdict: 'reject', note: 'не живо' }, [batchIds[1]!]: ok, [batchIds[2]!]: ok }));
    const third = await runProcess(s.opts);
    expect(third.publish?.changed).toBe(true);
    const v2 = readCurrentManifest(s.opts.libraryRoot)!;
    expect(v2.libraryVersion).toBe(2);
    expect(v2.units[batchIds[0]!]).toBeUndefined();
    expect(v2.pools['treasure.look']).toBeUndefined();
    expect(v2.units[batchIds[2]!]!.qa).toBe('ear');
    expect(existsSync(path.join(s.opts.libraryRoot, VOICE_KEY, a!.file))).toBe(true);
    const manifests = readdirSync(path.join(s.opts.libraryRoot, VOICE_KEY)).filter((n) => n.startsWith('manifest.'));
    expect(manifests).toHaveLength(2);
  }, 60_000);

  it('a split that does not match the pieces re-queues the job and publishes nothing for it', async () => {
    const s = setup();
    const two: GenJob = { ...BATCH, pieces: BATCH.pieces.slice(0, 2) };
    await s.addJob(two, BATCH_PCM, 'job-mismatch');
    const report = await runProcess(s.opts);
    expect(report.units).toBe(0);
    expect(report.requeue).toHaveLength(1);
    expect(report.requeue[0]).toMatchObject({ jobId: 'job-mismatch', reason: 'split: 3 pieces, expected 2', keys: ['line:treasure.look#1', 'slot:ins:n:f6'] });
    // nothing recorded yet → no empty library is created for the app to load
    expect(report.publish?.changed).toBe(false);
    expect(readCurrentManifest(s.opts.libraryRoot)).toBeNull();
  }, 60_000);

  it('a head recipe keeps the head and throws the dummy slot away', async () => {
    const s = setup();
    const head: GenJob = {
      prompt: 'Мой совет — конь на эф три.',
      take: 1,
      recipe: 'head',
      split: { mode: 'longest', minSilenceMs: 150 },
      pieces: [{ key: 'line:teach.head.advice#1', text: 'Мой совет —', pool: 'teach.head.advice' }, { discard: true, text: 'конь на эф три.' }],
    };
    await s.addJob(head, concat(silence(100), tone(180, 800), silence(290), tone(200, 1000), silence(200)), 'job-head');
    writeFileSync(s.opts.reviewFile, JSON.stringify({ [clipId(VOICE_KEY, head.prompt, 0)]: { verdict: 'ok' } }));
    const report = await runProcess(s.opts);
    expect(report.units).toBe(1);
    const unit = readStore(s.opts.storeFile).units[clipId(VOICE_KEY, head.prompt, 0)]!;
    expect(unit.ms).toBeGreaterThan(850);
    expect(unit.ms).toBeLessThan(1000);
    expect(readCurrentManifest(s.opts.libraryRoot)!.pools['teach.head.advice']).toEqual([unit.id]);
  }, 60_000);

  it('a take too slow for atempo is kept at ×1.3, flagged, and listed for a re-render', async () => {
    const s = setup();
    const slow: GenJob = { prompt: 'конём на эф шесть.', take: 1, recipe: 'slot-batch', pieces: [{ key: 'slot:ins:n:f6', text: 'конём на эф шесть', kind: 'slot' }] };
    await s.addJob(slow, concat(silence(100), tone(170, 2000), silence(200)), 'job-slow'); // 2.5 syl/s
    const report = await runProcess(s.opts);
    const unit = readStore(s.opts.storeFile).units[clipId(VOICE_KEY, slow.prompt, 0)]!;
    expect(unit.atempo).toBe(1.3);
    expect(unit.flags.some((f) => f.startsWith('tempo:'))).toBe(true);
    expect(unit.qa).toBe('needsEar');
    expect(unit.ms).toBeGreaterThan((2000 + 90) / 1.3 - 40);
    expect(unit.ms).toBeLessThan((2000 + 90) / 1.3 + 40);
    expect(report.rerender).toEqual([expect.objectContaining({ key: 'slot:ins:n:f6', recordings: 1 })]);
  }, 60_000);

  it('a missing master is reported, not fatal', async () => {
    const s = setup();
    await s.addJob(BATCH, BATCH_PCM, 'job-gone');
    rmSync(path.join(s.opts.mastersDir, 'job-gone.mp3'));
    const report = await runProcess(s.opts);
    expect(report.missingMasters).toEqual(['job-gone']);
  }, 60_000);
});

describe('manifest building (pure)', () => {
  const unit = (id: string, key: string, extra: Partial<UnitStore['units'][string]> = {}): UnitStore['units'][string] => ({
    id, key, text: 'Ого!', take: 1, ms: 500, on: 30, off: 440, file: `${id.slice(1, 3)}/${id}.mp3`, qa: 'auto', jobId: 'j', jobKey: 'k', cut: 0, bytes: 3000, flags: [], processedAt: 't', ...extra,
  });

  it('pools and keys are sorted, rejected units vanish, approved ones become ear', () => {
    const store: UnitStore = {
      v: 1,
      voiceKey: VOICE_KEY,
      units: {
        c0000000000002: unit('c0000000000002', 'line:bark.wow#1', { pool: 'bark.wow', qa: 'asr' }),
        c0000000000001: unit('c0000000000001', 'line:bark.wow#1', { pool: 'bark.wow', take: 2 }),
        c0000000000003: unit('c0000000000003', 'line:bark.hmm#1', { pool: 'bark.hmm', qa: 'asr' }),
      },
    };
    const manifest: Manifest = buildManifest(store, { c0000000000003: { verdict: 'reject' }, c0000000000001: { verdict: 'ok' } }, 4);
    expect(Object.keys(manifest.pools)).toEqual(['bark.wow']);
    expect(manifest.pools['bark.wow']).toEqual(['c0000000000002', 'c0000000000001']);
    expect(manifest.units.c0000000000001!.qa).toBe('ear');
    expect(manifest.units.c0000000000003).toBeUndefined();
    expect(manifest.libraryVersion).toBe(4);
  });

  it('publishes only CHECKED units: never unchecked, failed by the recogniser or a gate, «redo» or «reject»', () => {
    const asr = (ok: boolean) => ({ heard: ok ? 'конём на эф шесть' : 'конём на эф три', score: ok ? 1 : 0.8, ok, missing: ok ? [] : ['эф шесть'], model: 'ggml-small.bin', at: 't' });
    const store: UnitStore = {
      v: 1,
      voiceKey: VOICE_KEY,
      units: {
        c0000000000011: unit('c0000000000011', 'slot:ins:n:f6', { text: 'конём на эф шесть', kind: 'slot', qa: 'asr', asr: asr(true) }),
        c0000000000012: unit('c0000000000012', 'slot:ins:n:f6', { text: 'конём на эф шесть', kind: 'slot', take: 2, qa: 'needsEar', asr: asr(false), flags: ['asr-missing:эф шесть'] }),
        c0000000000013: unit('c0000000000013', 'slot:sq:f6', { text: 'на эф шесть', kind: 'slot', qa: 'auto' }),
        c0000000000014: unit('c0000000000014', 'slot:sq:e4', { text: 'на е четыре', kind: 'slot', qa: 'needsEar', flags: ['tempo:2.4'] }),
        c0000000000015: unit('c0000000000015', 'slot:sq:d4', { text: 'на дэ четыре', kind: 'slot', qa: 'asr', asr: asr(true) }),
        c0000000000016: unit('c0000000000016', 'slot:sq:c4', { text: 'на цэ четыре', kind: 'slot', qa: 'needsEar', flags: ['edge-f0:200'] }),
      },
    };
    // the wrong-square take (ASR failed), the unchecked one, the tempo-flagged one: out; a listener's «redo»: out
    const m = buildManifest(store, { c0000000000015: { verdict: 'redo' }, c0000000000016: { verdict: 'ok' } }, 1);
    expect(Object.keys(m.units).sort()).toEqual(['c0000000000011', 'c0000000000016']);
    expect(m.keys['slot:ins:n:f6']).toEqual(['c0000000000011']);
    expect(m.keys['slot:sq:f6']).toBeUndefined();
    expect(m.units.c0000000000016!.qa).toBe('ear');
    for (const [u, v, want] of [
      [{ qa: 'asr', asr: asr(true) }, undefined, true],
      [{ qa: 'asr', asr: asr(false) }, undefined, false],
      [{ qa: 'ear' }, undefined, true],
      [{ qa: 'auto' }, undefined, false],
      [{ qa: 'needsEar' }, undefined, false],
      [{ qa: 'needsEar', asr: asr(false) }, 'ok', true],
      [{ qa: 'asr', asr: asr(true) }, 'redo', false],
      [{ qa: 'ear' }, 'reject', false],
    ] as const) expect(isPublishable(u, v), JSON.stringify([u.qa, v])).toBe(want);
  });
});
