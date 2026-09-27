/**
 * `verify`: gates on synthetic units (pure) and the full run on a processed library with a fake recogniser
 * (real ffmpeg on tones in $TMPDIR; nothing is played; skipped without ffmpeg).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ffmpegAvailable, writeMp3 } from './audio.ts';
import { VOICE_KEY } from './config.ts';
import { jobMilli } from './cost.ts';
import { clipId } from './ids.ts';
import { keyOfJob } from './jobs.ts';
import type { GenJob } from './jobs.ts';
import { appendLedger } from './ledger.ts';
import { readCurrentManifest, readStore } from './manifest.ts';
import type { UnitRecord } from './manifest.ts';
import { runProcess } from './process.ts';
import { RATE, concat, noise, silence, tone } from './testkit.ts';
import { gateFlags, runVerify } from './verify.ts';

const hasFfmpeg = await ffmpegAvailable();
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function unit(text: string, extra: Partial<UnitRecord> = {}): UnitRecord {
  return { id: 'c0000000000001', key: 'line:x#1', text, take: 1, ms: 0, on: 30, off: 0, file: '00/c0000000000001.mp3', qa: 'auto', jobId: 'j', jobKey: 'k', cut: 0, bytes: 0, flags: [], processedAt: 't', ...extra };
}

describe('gates (pure)', () => {
  it('a clean 4 syl/s line passes', () => {
    // «Смотри, тут подарок!» = 18 speech chars; 1.5 s → 83 ms per char
    expect(gateFlags(unit('Смотри, тут подарок!'), concat(silence(30), tone(230, 1500, 0.3), silence(60)), RATE, -18.2)).toEqual([]);
  });

  it('too short for its text (a skipped word), too loud, clipped, noise, a high end on a falling unit', () => {
    expect(gateFlags(unit('Ходи конём на эф шесть — так мы давим на центр.'), concat(silence(30), tone(230, 1200, 0.3), silence(60)), RATE, -18)[0]).toMatch(/^ms-per-char:2\d$/);
    expect(gateFlags(unit('Ого!'), concat(silence(30), tone(230, 500, 0.95), silence(60)), RATE, -18)).toContain('peak:-0.4');
    const clipped = new Float32Array(3200).fill(0.5);
    clipped[100] = 1;
    expect(gateFlags(unit('Ого!'), clipped, RATE, -18).some((f) => f.startsWith('clipped:'))).toBe(true);
    expect(gateFlags(unit('Ого!'), concat(silence(30), tone(230, 500, 0.3)), RATE, -14.5)).toContain('lufs:-14.5');
    expect(gateFlags(unit('Ого!'), noise(600, -25), RATE, -18).some((f) => f.startsWith('voiced:'))).toBe(true);
    expect(gateFlags(unit('Соперник вывел коня.', { end: 'fall' }), concat(tone(250, 1400, 0.3), silence(60)), RATE, -18)).toContain('edge-f0-verify:250');
  });
});

describe.skipIf(!hasFfmpeg)('verify on a processed library (fake recogniser)', () => {
  it('passes what the recogniser confirms, flags a wrong piece, re-judges cached transcripts for free', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-verify-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const job: GenJob = {
      prompt: 'Смотри, тут подарок!<#0.6#>конём на эф шесть',
      take: 1,
      recipe: 'whole',
      pieces: [
        { key: 'line:treasure.look#1', text: 'Смотри, тут подарок!', pool: 'treasure.look' },
        { key: 'slot:ins:n:f6', text: 'конём на эф шесть', kind: 'slot' },
      ],
    };
    const ledgerFile = path.join(dir, 'ledger.jsonl');
    const mastersDir = path.join(dir, '.masters');
    await writeMp3(concat(silence(200), tone(230, 1500), silence(750), tone(170, 1200), silence(300)), path.join(mastersDir, 'j1.mp3'), 128, dir);
    appendLedger(ledgerFile, { ev: 'created', at: 't', run: 'r', campaign: 'pilot', key: keyOfJob(job), jobId: 'j1', milli: jobMilli(job.prompt), job });
    appendLedger(ledgerFile, { ev: 'charged', at: 't', key: keyOfJob(job), jobId: 'j1', campaign: 'pilot', milli: 150, status: 'completed', resultUrl: 'https://cdn.example/j1.mp3' });
    appendLedger(ledgerFile, { ev: 'downloaded', at: 't', key: keyOfJob(job), jobId: 'j1', master: 'j1.mp3', bytes: 1, sha256: 'x' });
    const common = {
      storeFile: path.join(dir, 'units.json'),
      reviewFile: path.join(dir, 'review.json'),
      libraryRoot: path.join(dir, 'public', 'voice'),
      work: path.join(dir, 'work'),
    };
    await runProcess({ ...common, ledgerFile, mastersDir, reportFile: path.join(dir, 'process.json') });
    const [lineId, slotId] = [clipId(VOICE_KEY, job.prompt, 0), clipId(VOICE_KEY, job.prompt, 1)];

    const heardBy: Record<string, string> = { [lineId]: 'Смотри, тут подарок!', [slotId]: 'Слоном на F6.' };
    const calls: string[] = [];
    const report = await runVerify({
      ...common,
      reportFile: path.join(dir, 'verify.json'),
      whisper: { bin: 'whisper-cli', model: '/nonexistent/model.bin' },
      transcribeFn: async (file) => {
        const id = path.basename(file, '.mp3');
        calls.push(id);
        return heardBy[id]!;
      },
    });
    expect(report.asr).toBe('on');
    expect(report.units).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.needsEar).toEqual([expect.objectContaining({ id: slotId, heard: 'Слоном на F6.', flags: expect.arrayContaining(['asr-missing:конем']) })]);
    const store = readStore(common.storeFile);
    expect(store.units[lineId]!.qa).toBe('asr');
    expect(store.units[slotId]!.qa).toBe('needsEar');
    expect(store.units[lineId]!.asr).toMatchObject({ heard: 'Смотри, тут подарок!', ok: true, model: 'model.bin' });
    // the recogniser heard «слоном» for «конём»: that take is NOT published (a child must never hear a wrong piece);
    // the planner treats the move as missing (split form / generic line) until a listener has approved it
    const manifest = readCurrentManifest(common.libraryRoot)!;
    expect(manifest.units[lineId]!.qa).toBe('asr');
    expect(manifest.units[slotId]).toBeUndefined();
    expect(manifest.keys['slot:ins:n:f6']).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(dir, 'verify.json'), 'utf8')).needsEar).toHaveLength(1);

    // second run without a model: cached transcripts are re-judged, nothing is transcribed again
    const again = await runVerify({ ...common, reportFile: path.join(dir, 'verify2.json'), whisper: null });
    expect(again.asr).toBe('off');
    expect(again.passed).toBe(1);
    expect(calls).toHaveLength(2);

    // a listener approves the slot by ear: qa becomes «ear» even with the recogniser's doubt
    writeFileSync(common.reviewFile, JSON.stringify({ [slotId]: { verdict: 'ok' } }));
    await runVerify({ ...common, reportFile: path.join(dir, 'verify3.json'), whisper: null });
    expect(readCurrentManifest(common.libraryRoot)!.units[slotId]!.qa).toBe('ear');
  }, 60_000);

  it('without whisper it says why and still runs the gates', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-verify-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const logs: string[] = [];
    const report = await runVerify({
      storeFile: path.join(dir, 'units.json'),
      reviewFile: path.join(dir, 'review.json'),
      libraryRoot: path.join(dir, 'public', 'voice'),
      work: path.join(dir, 'work'),
      reportFile: path.join(dir, 'verify.json'),
      whisper: { bin: 'whisper-cli', model: path.join(dir, 'no-model.bin') },
      log: (l) => logs.push(l),
    });
    expect(report.asr).toBe('off');
    expect(report.asrNote).toMatch(/no whisper model/);
    expect(logs[0]).toMatch(/ASR выключен/);
  }, 60_000);
});
