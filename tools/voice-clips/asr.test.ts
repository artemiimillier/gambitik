/**
 * The automatic listening check. The transcripts below are what whisper.cpp («small», `-l ru`) really heard on the
 * splice-test takes (docs/voice-samples/clips-test); no human listening was involved. The last block runs
 * whisper itself when the model and a take are present (silent: it only reads the file) and is skipped otherwise.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../lib/cli.ts';
import { ASR_MIN_SCORE, criticalWords, matchTranscript, normalizeRu, numberRu, phoneticKey, substringDistance, transcribe, whisperProblem } from './asr.ts';
import { DEFAULT_WHISPER_MODEL, WHISPER_BIN } from './config.ts';

const A = 'Ходи конём на эф шесть — так мы давим на центр.';
const B = 'Слон на цэ четыре целится в пешку на эф семь.';

/** [expected text, what whisper heard] — every one of these is a correct take. */
const HEARD_CORRECT: [string, string][] = [
  [A, 'Ходи к нему на F6, так мы давим на центр.'],
  [A, 'Ходи к нём на F6, так мы давим на центр.'],
  [A, 'Ходи сканем на F6. Так мы давим на центр.'],
  [A, 'Ходи! Канём! На F6! Так мы давим на центр!'],
  [B, 'Слон на C4 целится в пешку на F7.'],
  ['конём', 'Канём!'],
  ['на эф шесть', 'на F6'],
  ['Ходи конём на эф шесть — это хороший ход.', 'Ходи к нём на F6! Это хороший ход!'],
  ['Ходи слоном на цэ четыре — так мы давим на центр.', 'Ходи слоном на C4, так мы давим на центр.'],
  ['Слон на цэ четыре целится в короля.', 'Слон на Ц-4 целится в короля!'],
  ['Ферзь на дэ восемь смотрит на пешку на эф семь.', 'Ферс на D8 смотрит на пешку на F7.'],
  ['Ходи<#0.5#>конём на эф шесть<#0.5#>давим на центр.', 'Ходи! Канем на F6. Давим на центр.'],
];

describe('Russian normalisation', () => {
  it('lowercases, drops punctuation and stress marks, ё → е', () => {
    expect(normalizeRu('Конём — на Эф шесть!')).toEqual(['конем', 'на', 'эф', 'шесть']);
    expect(normalizeRu('ферзём́')).toEqual(['ферзем']);
    expect(normalizeRu('[BLANK_AUDIO] Ого!')).toEqual(['ого']);
  });

  it('squares in any spelling become the coach’s words', () => {
    for (const heard of ['F6', 'f6', 'Ф6', 'ф-6', 'эф 6', 'эф шесть']) expect(normalizeRu(heard), heard).toEqual(['эф', 'шесть']);
    expect(normalizeRu('C4')).toEqual(['цэ', 'четыре']);
    expect(normalizeRu('С4')).toEqual(['цэ', 'четыре']); // Cyrillic С glued to a rank
    expect(normalizeRu('с конём')).toEqual(['с', 'конем']); // …but a lone «с» stays a preposition
    expect(normalizeRu('E2')).toEqual(['е', 'два']);
    expect(normalizeRu('h8 g1 b3 d5 a7')).toEqual(['аш', 'восемь', 'же', 'один', 'бэ', 'три', 'дэ', 'пять', 'а', 'семь']);
  });

  it('numbers become words', () => {
    expect(numberRu('0')).toBe('ноль');
    expect(numberRu('12')).toBe('двенадцать');
    expect(numberRu('40')).toBe('сорок');
    expect(numberRu('105')).toBe('сто пять');
    expect(numberRu('007')).toBe('ноль ноль семь');
  });

  it('the phonetic key hears akanye and devoicing', () => {
    expect(phoneticKey('конем')).toBe(phoneticKey('канем'));
    expect(phoneticKey('ферзь')).toBe(phoneticKey('ферс'));
    expect(phoneticKey('слон')).not.toBe(phoneticKey('конь'));
    expect(substringDistance('каним', 'кним')).toBe(1);
    expect(substringDistance('каним', 'хатисканимнаиф')).toBe(0);
  });

  it('critical words: squares as pairs, pieces, captures; a lone «а» is a conjunction', () => {
    expect(criticalWords(normalizeRu('Конь бьёт на дэ пять — шах!'))).toEqual(['конь', 'бьет', 'дэ пять', 'шах']);
    expect(criticalWords(normalizeRu('А мой совет — ладьёй на а один.'))).toEqual(['ладьей', 'а один']);
  });
});

describe('matching a transcript to the expected text', () => {
  it(`every correct splice-test take passes (threshold ${ASR_MIN_SCORE})`, () => {
    for (const [expected, heard] of HEARD_CORRECT) {
      const m = matchTranscript(expected, heard);
      expect(m.ok, `${expected} ⇐ ${heard} (${m.score}, missing ${m.missing.join(',')})`).toBe(true);
    }
  });

  it('a wrong piece fails even when the rest is identical', () => {
    expect(matchTranscript('Ходи слоном на эф шесть — так мы давим на центр.', 'Ходи к нему на F6, так мы давим на центр.')).toMatchObject({ ok: false, missing: ['слоном'] });
    expect(matchTranscript('Конь на цэ четыре целится в короля.', 'Слон на Ц-4 целится в короля!')).toMatchObject({ ok: false, missing: ['конь'] });
    expect(matchTranscript('конём', 'Слоном!').ok).toBe(false);
    expect(matchTranscript('ферзём', 'Канём!').ok).toBe(false);
  });

  it('a wrong square fails, and the rank must belong to its file (no borrowing from a later square)', () => {
    expect(matchTranscript('на эф пять', 'на F6')).toMatchObject({ ok: false, missing: ['эф пять'] });
    expect(matchTranscript('на дэ шесть', 'на F6')).toMatchObject({ ok: false, missing: ['дэ шесть'] });
    expect(matchTranscript(B.replace('цэ четыре', 'цэ пять'), 'Слон на C4 целится в пешку на F7.').missing).toEqual(['цэ пять']);
    expect(matchTranscript('Ферзь на дэ семь смотрит на пешку на эф семь.', 'Ферс на D8 смотрит на пешку на F7.').missing).toEqual(['дэ семь']);
  });

  it('dropped or swapped words fall below the threshold', () => {
    expect(matchTranscript(A, 'Ходи! Канем на F6. Давим на центр.').ok).toBe(false); // «так мы» missing
    expect(matchTranscript('Ходи слоном на цэ четыре — так мы давим на фланг.', 'Ходи слоном на C4, так мы давим на центр.').ok).toBe(false);
    expect(matchTranscript('так мы защищаем короля', 'Так мы давим на центр.').ok).toBe(false);
    expect(matchTranscript('Ого!', '').ok).toBe(false);
  });

  it('a garbled list item is flagged for a human listener (the recogniser lost «на же один»)', () => {
    const m = matchTranscript('Конём на эф шесть, слоном на цэ четыре, пешкой на е четыре, ферзём на дэ один, ладьёй на а один, королём на же один.', 'Канем на F6. Слоном на C4. Пешкой на E4. Ферзем на D1. Абрам Ладьёйна А1. Кролём ножа 1.');
    expect(m.ok).toBe(false);
    expect(m.missing).toEqual(['же один']);
  });
});

const MODEL_READY = (await whisperProblem({ bin: WHISPER_BIN, model: DEFAULT_WHISPER_MODEL })) === null;
const TAKE = repoPath('docs', 'voice-samples', 'clips-test', 'src', 'W_B.mp3');

describe.skipIf(!MODEL_READY || !existsSync(TAKE))('whisper.cpp on a real take (offline, nothing is played)', () => {
  it('hears «Слон на цэ четыре целится в пешку на эф семь.»', async () => {
    const heard = await transcribe(TAKE, { bin: WHISPER_BIN, model: DEFAULT_WHISPER_MODEL }, os.tmpdir());
    expect(matchTranscript(B, heard)).toMatchObject({ ok: true });
    expect(matchTranscript(B.replace('Слон', 'Конь'), heard).ok).toBe(false);
  }, 120_000);
});
