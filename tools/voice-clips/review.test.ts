/**
 * The review page: static, never plays anything by itself, safe against any text, exports verdicts; composed
 * lines are rendered offline with the runtime gap table (real ffmpeg on tones in $TMPDIR; skipped without ffmpeg).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeToPcm, encodeMp3, ffmpegAvailable } from './audio.ts';
import { GAP_MS, VOICE_KEY } from './config.ts';
import { clipFile } from './ids.ts';
import { writeStore } from './manifest.ts';
import type { UnitRecord, UnitStore } from './manifest.ts';
import { gapMs, mulberry32, renderComposed, reviewHtml, runReview } from './review.ts';
import { RATE, concat, silence, tone } from './testkit.ts';

const hasFfmpeg = await ffmpegAvailable();
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gambit-voice-review-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pageUnit(text: string) {
  return { id: 'c0000000000001', key: 'line:x#1', text, pool: 'x', tier: 'pilot', kind: 'line', qa: 'needsEar', flags: ['tempo:5.4'], heard: 'Ого', score: 0.9, ms: 800, take: 1, src: '../../apps/web/public/voice/giselle-mm1/00/c0000000000001.mp3' };
}

describe('the page', () => {
  const html = reviewHtml([pageUnit('Ого!')], [{ name: 'фраза 1', text: 'Мой совет — конём на эф шесть', src: 'composed/001.mp3' }], { c0000000000001: { verdict: 'ok' } }, '2026-09-24T12:00:00Z');

  it('never starts audio by itself: no autoplay, no play() call, clips load only on demand', () => {
    expect(html).not.toMatch(/autoplay/i);
    expect(html).not.toMatch(/\.play\s*\(/);
    expect(html).toContain("a.preload = 'none'");
    expect(html).toContain('a.controls = true');
  });

  it('has the three verdicts and the JSON export named for the voice', () => {
    for (const label of ['Хорошо', 'Переписать', 'Убрать', 'Скачать оценки']) expect(html).toContain(label);
    expect(html).toContain("'review.' + DATA.voiceKey + '.json'");
    expect(html).toContain(`"voiceKey":"${VOICE_KEY}"`);
    expect(html).toContain('"verdicts":{"c0000000000001":{"verdict":"ok"}}');
  });

  it('embedded text can never close the script element', () => {
    const evil = reviewHtml([pageUnit('</script><script>alert(1)</script>')], [], {}, 't');
    expect(evil).not.toContain('</script><script>alert(1)');
    expect(evil).toContain('\\u003c/script>');
    expect(evil.match(/<\/script>/g)).toHaveLength(2); // the data block and the page script
  });

  it('browser storage is wrapped (private windows, blocked storage)', () => {
    expect(html).toMatch(/try \{ draft = JSON\.parse\(localStorage\.getItem/);
    expect(html).toMatch(/try \{ localStorage\.setItem/);
  });
});

describe('gap table', () => {
  it('uses SPEC §5.3 values with ±30 ms jitter, ×0.75 in blitz, deterministically', () => {
    expect(gapMs('—', () => 0.5)).toBe(280);
    expect(gapMs('.', () => 0)).toBe(420);
    expect(gapMs('?', () => 1)).toBe(530);
    expect(gapMs('—', () => 0.5, true)).toBe(210);
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(GAP_MS).toEqual({ '.': 450, '!': 450, '?': 500, '—': 280, ':': 240, ';': 260, split: 250, bark: 200 });
  });
});

describe.skipIf(!hasFfmpeg)('composed lines and the page on disk (real ffmpeg, silent)', () => {
  async function library(dir: string) {
    const libraryRoot = path.join(dir, 'public', 'voice');
    const mk = async (id: string, text: string, core: Float32Array): Promise<UnitRecord> => {
      const pcm = concat(silence(30), core, silence(60));
      await encodeMp3(pcm, path.join(libraryRoot, VOICE_KEY, clipFile(id)), { work: dir });
      const decoded = await decodeToPcm(path.join(libraryRoot, VOICE_KEY, clipFile(id)));
      const ms = Math.round((decoded.length * 1000) / RATE);
      return { id, key: `line:${id}#1`, text, take: 1, ms, on: 30, off: ms - 60, file: clipFile(id), qa: 'auto', jobId: 'j', jobKey: 'k', cut: 0, bytes: 1, flags: [], processedAt: 't', kind: 'line' };
    };
    const head = await mk('c1000000000001', 'Мой совет —', tone(220, 700, 0.3));
    const slot = await mk('c2000000000002', 'конём на эф шесть.', tone(180, 1000, 0.3));
    const store: UnitStore = { v: 1, voiceKey: VOICE_KEY, units: { [head.id]: head, [slot.id]: { ...slot, kind: 'slot' } } };
    const storeFile = path.join(dir, 'units.json');
    writeStore(storeFile, store);
    return { libraryRoot, store, storeFile, head, slot };
  }

  it('renders head · «—» · slot like the player: onset→offset with fades, 280 ± 30 ms between', async () => {
    const dir = tempDir();
    const { libraryRoot, store, head, slot } = await library(dir);
    const out = await renderComposed({ items: [{ id: head.id }, { gap: '—' }, { id: slot.id }] }, store, libraryRoot, 1);
    expect('pcm' in out).toBe(true);
    if (!('pcm' in out)) return;
    expect(out.text).toBe('Мой совет — конём на эф шесть.');
    const expected = head.off - head.on + 10 + 280 + (slot.off - slot.on + 10);
    expect(Math.abs((out.pcm.length * 1000) / RATE - expected)).toBeLessThanOrEqual(31);
    expect(await renderComposed({ items: [{ id: 'c9999999999999' }] }, store, libraryRoot, 1)).toEqual({ missing: 'c9999999999999' });
  }, 60_000);

  it('writes index.html with relative links to the library and the composed MP3s', async () => {
    const dir = tempDir();
    const { libraryRoot, storeFile, slot } = await library(dir);
    const composedFile = path.join(dir, 'composed.json');
    writeFileSync(composedFile, JSON.stringify({ lines: [{ name: 'совет', items: [{ id: 'c1000000000001' }, { gap: '—' }, { id: slot.id }] }, { items: [{ id: 'c9999999999999' }] }] }));
    const outDir = path.join(dir, 'test-results', 'voice-review');
    const result = await runReview({ storeFile, reviewFile: path.join(dir, 'review.json'), libraryRoot, outDir, work: dir, composedFile });
    expect(result).toMatchObject({ units: 2, composed: 1 });
    expect(result.skipped).toEqual(['фраза 2: нет записи c9999999999999']);
    const html = readFileSync(result.page, 'utf8');
    expect(html).toContain(`"src":"../../public/voice/${VOICE_KEY}/${slot.file}"`);
    expect(html).toContain('"src":"composed/001.mp3"');
    // slot units come before plain lines (the parent hears moves first)
    expect(html.indexOf(slot.id)).toBeLessThan(html.indexOf('c1000000000001'));
  }, 60_000);
});
