/**
 * «Дозапись голоса» — `process` + `verify` under the overlay's rule, end to end with REAL ffmpeg on synthetic tones in
 * $TMPDIR (nothing is played; skipped without ffmpeg) and a fake recogniser: a pack master cut at its 700 ms tags, a lead
 * whose end keeps rising published `ctx: 'cont'`, soft flags that still publish, a wrong piece word that does not, a
 * split that does not match counted as a paid attempt, and `blocked[]` in the overlay manifest.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIP_CATALOG } from '../../packages/core/src/coach/clips/catalog.ru.ts';
import { catalogFallbacks } from '../../packages/core/src/coach/clips/catalog.ts';
import { PACK_SPLIT, PACK_TAG } from '../../packages/core/src/coach/clips/tts.ts';
import { decodeToPcm, ffmpegAvailable, writeMp3 } from './audio.ts';
import { PEAK_MAX_DBFS, VOICE_KEY } from './config.ts';
import { jobMilli } from './cost.ts';
import { samplePeakDb } from './dsp.ts';
import { clipId } from './ids.ts';
import { keyOfJob } from './jobs.ts';
import type { GenJob } from './jobs.ts';
import { appendLedger } from './ledger.ts';
import { readCurrentManifest, readStore } from './manifest.ts';
import { ONDEMAND_CAMPAIGN, ONDEMAND_TAKE_BASE } from './ondemand.ts';
import { overlayPaths } from './overlay.ts';
import { regainDb, runProcess } from './process.ts';
import { RATE, concat, silence, tone } from './testkit.ts';
import { runVerify } from './verify.ts';

const hasFfmpeg = await ffmpegAvailable();
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const LEAD = 'Конь просится в бой';
const TAIL = '— и это мат!';
const WHOLE = 'Вот и всё, молодец.';
const PACK: GenJob = {
  prompt: [LEAD, TAIL, WHOLE].join(PACK_TAG),
  take: ONDEMAND_TAKE_BASE,
  recipe: 'pack',
  split: { ...PACK_SPLIT },
  pieces: [
    { key: 'line:v3.lead.subject@n#1', text: LEAD, pool: 'v3.lead.subject@n', kind: 'line', role: 'lead' },
    { key: 'line:v3.idea.mate#1', text: TAIL, pool: 'v3.idea.mate', kind: 'line', role: 'tail' },
    { key: 'line:v3.praise.done#1', text: WHOLE, pool: 'v3.praise.done', kind: 'line', role: 'whole' },
  ],
};
// ≈ 4 syl/s each: the lead (5 syllables) ends HIGH (240 Hz: a continuing lead); the whole (6) has a natural 450 ms pause
const PACK_PCM = concat(
  silence(150),
  tone(240, 1250),
  silence(850),
  tone(175, 1000),
  silence(950),
  tone(180, 800),
  silence(450),
  tone(170, 700),
  silence(250),
);

/** The same two-part tail job twice (takes 101, 102): the master only has one piece — the split never matches. */
const TWO: (take: number) => GenJob = (take) => ({
  prompt: ['Смотри сюда', '— тут подарок!'].join(PACK_TAG),
  take,
  recipe: 'pack',
  split: { ...PACK_SPLIT },
  pieces: [
    { key: 'line:v3.lead.look#1', text: 'Смотри сюда', kind: 'line', role: 'lead' },
    { key: 'line:v3.treasure.gift#1', text: '— тут подарок!', kind: 'line', role: 'tail' },
  ],
});

describe.skipIf(!hasFfmpeg)('process + verify under the overlay rule (synthetic tones, silent)', () => {
  it('cuts a pack at its tags, keeps a continuing lead as ctx cont, publishes past soft flags, blocks a key after two paid attempts', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-overlay-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ov = overlayPaths(path.join(dir, 'voice-overlay'));
    const work = path.join(dir, 'work');
    const addJob = async (job: GenJob, pcm: Float32Array, jobId: string) => {
      await writeMp3(pcm, path.join(ov.mastersDir, `${jobId}.mp3`), 128, dir);
      const key = keyOfJob(job);
      appendLedger(ov.ledgerFile, { ev: 'created', at: '2026-09-24T20:00:00Z', run: 'r', campaign: ONDEMAND_CAMPAIGN, key, jobId, milli: jobMilli(job.prompt), job, via: 'parse' });
      appendLedger(ov.ledgerFile, { ev: 'charged', at: '2026-09-24T20:00:05Z', key, jobId, campaign: ONDEMAND_CAMPAIGN, milli: jobMilli(job.prompt), status: 'completed', resultUrl: `https://cdn.example/${jobId}.mp3` });
      appendLedger(ov.ledgerFile, { ev: 'downloaded', at: '2026-09-24T20:00:06Z', key, jobId, master: `${jobId}.mp3`, bytes: 1, sha256: 'x' });
    };
    await addJob(PACK, PACK_PCM, 'job-pack');
    const lonely = concat(silence(150), tone(200, 1400), silence(300));
    await addJob(TWO(101), lonely, 'job-two-1');
    await addJob(TWO(102), lonely, 'job-two-2');

    const common = { storeFile: ov.storeFile, reviewFile: ov.reviewFile, libraryRoot: ov.libraryRoot, work };
    const processed = await runProcess({ ...common, ledgerFile: ov.ledgerFile, mastersDir: ov.mastersDir, reportFile: ov.reportFile, qa: 'overlay' });
    expect(processed.units).toBe(3);
    expect(processed.requeue.map((r) => r.jobId).sort()).toEqual(['job-two-1', 'job-two-2']);
    const ids = [0, 1, 2].map((cut) => clipId(VOICE_KEY, PACK.prompt, cut, PACK.take));
    let store = readStore(ov.storeFile);
    const [lead, tail, whole] = ids.map((id) => store.units[id]!);
    expect(lead).toMatchObject({ role: 'lead', ctx: 'cont', qa: 'auto' });
    expect(lead!.flags.some((f) => f.startsWith('cont:'))).toBe(true);
    expect(tail).toMatchObject({ role: 'tail', qa: 'auto' });
    expect(tail!.ctx).toBeUndefined();
    // the whole kept its natural 450 ms pause inside (one unit), and «всё» is a soft flag
    expect(whole!.ms).toBeGreaterThan(800 + 450 + 700);
    expect(whole!.flags).toContain('yo');
    expect(whole!.qa).toBe('auto');
    expect(store.requeued).toEqual({ 'job-two-1': 'split: 1 pieces, expected 2', 'job-two-2': 'split: 1 pieces, expected 2' });
    // nothing is published before the recogniser agreed; the two failed attempts already block their keys
    const before = readCurrentManifest(ov.libraryRoot)!;
    expect(before.units).toEqual({});
    expect(before.blocked).toEqual(['line:v3.lead.look#1', 'line:v3.treasure.gift#1']);

    // the recogniser: the lead heard with a wrong piece, the others right
    const heard: Record<string, string> = { [ids[0]!]: 'Слон просится в бой', [ids[1]!]: 'И это мат!', [ids[2]!]: 'Вот и все, молодец.' };
    const verified = await runVerify({
      ...common,
      reportFile: path.join(dir, 'verify.json'),
      whisper: { bin: 'whisper-cli', model: '/nonexistent/model.bin' },
      transcribeFn: async (file) => heard[path.basename(file, '.mp3')]!,
      qa: 'overlay',
      ledgerFile: ov.ledgerFile,
    });
    expect(verified.passed).toBe(2);
    store = readStore(ov.storeFile);
    expect(store.units[ids[0]!]!.qa).toBe('needsEar');
    expect(store.units[ids[0]!]!.flags.some((f) => f.startsWith('asr-missing:'))).toBe(true);
    expect(store.units[ids[2]!]!.qa).toBe('asr');
    const manifest = readCurrentManifest(ov.libraryRoot)!;
    expect(Object.keys(manifest.units).sort()).toEqual([ids[1], ids[2]].sort());
    expect(manifest.keys['line:v3.praise.done#1']).toEqual([ids[2]]);
    expect(manifest.fallbacks).toEqual(catalogFallbacks(CLIP_CATALOG));
    // the lead is neither published nor blocked: it has one attempt left
    expect(manifest.blocked).toEqual(['line:v3.lead.look#1', 'line:v3.treasure.gift#1']);

    // a listener hears the lead and says «Хорошо»: published with its ctx
    writeFileSync(ov.reviewFile, JSON.stringify({ [ids[0]!]: { verdict: 'ok' } }));
    await runVerify({ ...common, reportFile: path.join(dir, 'verify2.json'), whisper: null, qa: 'overlay', ledgerFile: ov.ledgerFile });
    expect(readCurrentManifest(ov.libraryRoot)!.units[ids[0]!]).toMatchObject({ ctx: 'cont', qa: 'ear' });
  }, 90_000);

  it('a tag that came out short is re-cut for free at the longest pauses (soft `recut`); the static rule re-queues', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-overlay-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // the second tag gave only 600 ms: the 700 ms tag split finds 2 pieces for 3
    const short = concat(silence(150), tone(240, 1250), silence(850), tone(175, 1000), silence(600), tone(180, 1500), silence(250));
    const run = async (qa: 'overlay' | 'static') => {
      const ov = overlayPaths(path.join(dir, qa));
      await writeMp3(short, path.join(ov.mastersDir, 'job-short.mp3'), 128, dir);
      const key = keyOfJob(PACK);
      appendLedger(ov.ledgerFile, { ev: 'created', at: 't', run: 'r', campaign: ONDEMAND_CAMPAIGN, key, jobId: 'job-short', milli: jobMilli(PACK.prompt), job: PACK });
      appendLedger(ov.ledgerFile, { ev: 'charged', at: 't', key, jobId: 'job-short', campaign: ONDEMAND_CAMPAIGN, milli: jobMilli(PACK.prompt), status: 'completed', resultUrl: 'https://cdn.example/s.mp3' });
      appendLedger(ov.ledgerFile, { ev: 'downloaded', at: 't', key, jobId: 'job-short', master: 'job-short.mp3', bytes: 1, sha256: 'x' });
      return runProcess({ ledgerFile: ov.ledgerFile, mastersDir: ov.mastersDir, storeFile: ov.storeFile, reviewFile: ov.reviewFile, reportFile: ov.reportFile, libraryRoot: ov.libraryRoot, work: path.join(dir, 'work'), qa });
    };
    const overlay = await run('overlay');
    expect(overlay.units).toBe(3);
    expect(overlay.requeue).toEqual([]);
    const store = readStore(overlayPaths(path.join(dir, 'overlay')).storeFile);
    expect(Object.values(store.units).every((u) => u.flags.includes('recut') && u.qa === 'auto')).toBe(true);
    const strict = await run('static');
    expect(strict.units).toBe(0);
    expect(strict.requeue).toHaveLength(1);
  }, 90_000);

  it('a peak-limited short exclamation is re-gained only up to the true-peak ceiling: no `peak`, published', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-overlay-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ov = overlayPaths(path.join(dir, 'voice-overlay'));
    // a quiet 180 Hz voice with three 1.5 ms bursts near full scale (a high crest factor, like «Так!»): the first encode
    // is held at −1.5 dBTP and ends up ≈ 1–2 LU under −18
    const rate = RATE;
    const n = Math.round(rate * 1.2);
    const spiky = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const burst = [0.2, 0.6, 1.0].some((c) => Math.abs(t - c) < 0.0015);
      spiky[i] = (burst ? 0.9 : 0.2) * Math.sin(2 * Math.PI * 180 * t);
    }
    const job: GenJob = { prompt: 'Так!', take: ONDEMAND_TAKE_BASE, recipe: 'single', pieces: [{ key: 'line:v3.test.so#1', text: 'Так!', kind: 'line', role: 'whole' }] };
    await writeMp3(concat(silence(150), spiky, silence(250)), path.join(ov.mastersDir, 'job-so.mp3'), 128, dir);
    const key = keyOfJob(job);
    appendLedger(ov.ledgerFile, { ev: 'created', at: 't', run: 'r', campaign: ONDEMAND_CAMPAIGN, key, jobId: 'job-so', milli: jobMilli(job.prompt), job });
    appendLedger(ov.ledgerFile, { ev: 'charged', at: 't', key, jobId: 'job-so', campaign: ONDEMAND_CAMPAIGN, milli: jobMilli(job.prompt), status: 'completed', resultUrl: 'https://cdn.example/so.mp3' });
    appendLedger(ov.ledgerFile, { ev: 'downloaded', at: 't', key, jobId: 'job-so', master: 'job-so.mp3', bytes: 1, sha256: 'x' });
    const common = { storeFile: ov.storeFile, reviewFile: ov.reviewFile, libraryRoot: ov.libraryRoot, work: path.join(dir, 'work') };
    await runProcess({ ...common, ledgerFile: ov.ledgerFile, mastersDir: ov.mastersDir, reportFile: ov.reportFile, qa: 'overlay' });
    const id = clipId(VOICE_KEY, job.prompt, 0, job.take);
    await runVerify({ ...common, reportFile: path.join(dir, 'verify.json'), whisper: { bin: 'whisper-cli', model: '/nonexistent/model.bin' }, transcribeFn: async () => 'Так!', qa: 'overlay', ledgerFile: ov.ledgerFile });
    const unit = readStore(ov.storeFile).units[id]!;
    expect(unit.flags.filter((f) => /^(?:peak|clipped|lufs):/.test(f))).toEqual([]);
    const decoded = await decodeToPcm(path.join(ov.libraryRoot, VOICE_KEY, unit.file), rate);
    expect(samplePeakDb(decoded)).toBeLessThanOrEqual(PEAK_MAX_DBFS);
    expect(unit.qa).toBe('asr');
    expect(Object.keys(readCurrentManifest(ov.libraryRoot)!.units)).toEqual([id]);
  }, 90_000);
});

describe('the overlay re-gain (pure)', () => {
  it('to −18 LUFS within the true-peak headroom; a loud unit always down; nothing within ±1 LU or past 2.5', () => {
    // 1.25 LU quiet with 0.49 dB of headroom: only the headroom
    expect(regainDb({ lufs: -19.25, truePeak: -1.99 })).toBeCloseTo(0.49, 5);
    // plenty of headroom: the whole step
    expect(regainDb({ lufs: -19.5, truePeak: -6 })).toBeCloseTo(1.5, 5);
    // no headroom at all (or too little to bother): left as it is, verify's 2.5 LU window accepts it
    expect(regainDb({ lufs: -19.8, truePeak: -1.5 })).toBe(0);
    expect(regainDb({ lufs: -19.8, truePeak: -1.3 })).toBe(0);
    expect(regainDb({ lufs: -19.8, truePeak: -1.6 })).toBe(0);
    // too loud: down by the full step
    expect(regainDb({ lufs: -16.5, truePeak: -0.5 })).toBeCloseTo(-1.5, 5);
    expect(regainDb({ lufs: -18.5, truePeak: -1 })).toBe(0);
    expect(regainDb({ lufs: -21, truePeak: -9 })).toBe(0);
  });
});
