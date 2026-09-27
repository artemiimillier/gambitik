/** Pricing, prompt validation, stable ids and the jobs-file contract (pure, no I/O). */
import { describe, expect, it } from 'vitest';
import { VOICE_KEY } from './config.ts';
import { codePoints, creditsToMilli, fmtCredits, jobMilli, promptProblem } from './cost.ts';
import { CLIP_ID_RE, clipFile, clipId, cyrb53, hash13, jobKey } from './ids.ts';
import { JobsFileError, jobProblems, keyOfJob, parseJobsFile } from './jobs.ts';

describe('price = 0.15 × ⌈code points / 50⌉ per job (docs/voice-clips/SPEC.md §10.1)', () => {
  it('matches every measured bucket', () => {
    const table: [number, number][] = [[1, 150], [50, 150], [51, 300], [100, 300], [101, 450], [200, 600], [201, 750], [300, 900], [400, 1200]];
    for (const [chars, milli] of table) expect(jobMilli('а'.repeat(chars)), `${chars} chars`).toBe(milli);
    expect(jobMilli('')).toBe(0);
  });

  it('counts code points: Cyrillic, ё and spaces are one each, a pause tag is 7', () => {
    expect(codePoints('Ходи конём на эф шесть — так мы давим на центр.')).toBe(47);
    expect(codePoints('<#0.6#>')).toBe(7);
    expect(codePoints('ё\u0301')).toBe(2); // ё + U+0301 stress mark
    expect(jobMilli('Ходи<#0.5#>конём на эф шесть<#0.5#>давим на центр.')).toBe(150); // 50 chars, the measured M job
  });

  it('keeps money in integer milli-credits', () => {
    expect(creditsToMilli(0.15 + 0.15 + 0.15)).toBe(450);
    expect(fmtCredits(13_500)).toBe('13.5');
    expect(fmtCredits(150)).toBe('0.15');
  });

  it('refuses empty, over-long and malformed prompts', () => {
    expect(promptProblem('')).toMatch(/empty/);
    expect(promptProblem(' \n ')).toMatch(/empty/);
    expect(promptProblem('<#0.6#>')).toMatch(/no words/);
    expect(promptProblem('а'.repeat(480))).toBeNull();
    expect(promptProblem('а'.repeat(481))).toMatch(/481/);
    expect(promptProblem('Ого!<#0.6#>Ух ты!')).toBeNull();
    expect(promptProblem('Ого!<#0.6>Ух ты!')).toMatch(/pause tag/);
    expect(promptProblem('Ого!\u0007')).toMatch(/control/);
    expect(promptProblem(42)).toMatch(/not a string/);
  });
});

describe('ids', () => {
  it('cyrb53 is the reference implementation (golden values)', () => {
    expect(cyrb53('')).toBe(3338908027751811);
    expect(cyrb53('a')).toBe(7929297801672961);
    expect(hash13('')).toHaveLength(13);
  });

  it('clip ids: c + 13 hex, stable, take-1 ids follow the SPEC formula exactly', () => {
    const id = clipId(VOICE_KEY, 'Попробуй так: конём на эф шесть.', 0);
    expect(id).toMatch(CLIP_ID_RE);
    expect(id).toBe(`c${hash13(`${VOICE_KEY}\nПопробуй так: конём на эф шесть.\n0`)}`);
    expect(clipId(VOICE_KEY, 'Попробуй так: конём на эф шесть.', 0)).toBe(id);
    expect(clipId(VOICE_KEY, 'Попробуй так: конём на эф шесть.', 0, 1)).toBe(id);
    expect(clipId(VOICE_KEY, 'Попробуй так: конём на эф шесть.', 1)).not.toBe(id);
    expect(clipId(VOICE_KEY, 'Попробуй так: конём на эф шесть.', 0, 2)).not.toBe(id);
    expect(clipId('other-voice', 'Попробуй так: конём на эф шесть.', 0)).not.toBe(id);
  });

  it('ids equal the browser side (packages/core/src/coach/clips/keys.ts golden values)', () => {
    expect(clipId(VOICE_KEY, 'Попробуй так:', 0)).toBe('c4bbe3eca06d0d');
    expect(clipId(VOICE_KEY, 'конём на эф шесть', 0)).toBe('c9a6ce27f9ef28');
    expect(clipId(VOICE_KEY, 'конём на эф шесть', 0, 2)).toBe('c3c3f98fb9682b');
    expect(clipId(VOICE_KEY, 'Мой совет — конь на эф три.<#0.6#>Попробуй так:', 1)).toBe('c7989fdb4c1b07');
    expect(hash13('')).toBe('bdcb81aee8d83');
  });

  it('files are spread over 256 folders by the two hex digits after the c', () => {
    expect(clipFile('c3f0a91b2c4d5')).toBe('3f/c3f0a91b2c4d5.mp3');
  });

  it('job keys separate takes of the same prompt', () => {
    expect(jobKey(VOICE_KEY, 'Ого!', 1)).not.toBe(jobKey(VOICE_KEY, 'Ого!', 2));
    expect(keyOfJob({ prompt: 'Ого!', take: 1 })).toBe(jobKey(VOICE_KEY, 'Ого!', 1));
  });
});

describe('jobs file contract', () => {
  const job = { prompt: 'Мой совет — конь на эф три.', take: 1, recipe: 'head', split: { mode: 'longest', minSilenceMs: 150 }, pieces: [{ key: 'line:teach.head.advice#1', text: 'Мой совет —', pool: 'teach.head.advice' }, { discard: true, text: 'конь на эф три.' }] };

  it('accepts a head recipe with a discarded carrier', () => {
    expect(jobProblems(job)).toEqual([]);
    const file = parseJobsFile({ v: 1, voiceKey: VOICE_KEY, campaign: 'pilot', jobs: [job] });
    expect(file.jobs).toHaveLength(1);
  });

  it('rejects wrong voice, version, campaign names, duplicates and broken jobs', () => {
    expect(() => parseJobsFile({ v: 2, voiceKey: VOICE_KEY, campaign: 'pilot', jobs: [] })).toThrow(JobsFileError);
    expect(() => parseJobsFile({ v: 1, voiceKey: 'milena', campaign: 'pilot', jobs: [] })).toThrow(/voice/);
    expect(() => parseJobsFile({ v: 1, voiceKey: VOICE_KEY, campaign: 'Pilot Run!', jobs: [] })).toThrow(/campaign/);
    expect(() => parseJobsFile({ v: 1, voiceKey: VOICE_KEY, campaign: 'pilot', jobs: [job, job] })).toThrow(/twice/);
    expect(() => parseJobsFile({ v: 1, voiceKey: VOICE_KEY, campaign: 'pilot', jobs: [{ ...job, take: 2 }, job] })).not.toThrow();
    expect(jobProblems({ ...job, pieces: [{ discard: true }] })).toContain('job keeps no unit');
    expect(jobProblems({ ...job, pieces: [{ key: 'x' }] })).toContain('piece x without text');
    expect(jobProblems({ ...job, recipe: 'song' })).toContain('unknown recipe song');
    expect(jobProblems({ ...job, split: { mode: 'tags', minSilenceMs: 5 } })[0]).toMatch(/split/);
    expect(jobProblems({ ...job, prompt: '' })).toContain('empty prompt');
  });
});
