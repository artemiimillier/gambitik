/**
 * Automatic listening check: whisper.cpp transcribes a clip (offline, silently) and the transcript is compared with the
 * text the clip should say. This is the gate that catches wrong words — «слоном» said for «конём», a skipped «на» —
 * which no level or pitch measure can see (docs/voice-clips/SPEC.md §10.1).
 *
 * Comparison: both sides go through `normalizeRu` (lowercase, ё → е, punctuation out, digits → Russian words, chess
 * file letters → their spoken names: «F6» / «Ц-4» → «эф шесть» / «цэ четыре») and then a coarse phonetic key
 * (whisper spells what was pronounced: «Канём», «к нём» for «конём», «Ферс» for «ферзь»). Then
 *  - `score` = 1 − Levenshtein / max length over the phonetic streams with word boundaries removed;
 *  - the critical items of the expected text must be heard IN ORDER: every square as its file word immediately followed
 *    by its rank word, every piece word, «бьёт», «шах», «мат», castling (piece words may be split or glued by the
 *    recogniser; one phonetic edit allowed for words of ≥ 4 sounds).
 * A clip passes when score ≥ ASR_MIN_SCORE and nothing critical is missing. Calibration on the 26 splice-test files
 * (README.md «ASR calibration»): correct takes 0.92–1.00, texts differing by one or two words ≤ 0.87, and every wrong
 * piece or square caught by the critical check.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { WHISPER_MODEL } from './config.ts';
import { toWav16k } from './audio.ts';

/** Minimum similarity for a pass (calibrated: correct takes ≥ 0.92, a dropped or swapped word ≤ 0.87). */
export const ASR_MIN_SCORE = 0.9;

const UNITS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

/** 0–999 in Russian words (nominative); larger numbers digit by digit. */
export function numberRu(digits: string): string {
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 0 || n > 999 || (digits.length > 1 && digits.startsWith('0'))) return [...digits].map((d) => UNITS[Number(d)]).join(' ');
  if (n < 10) return UNITS[n]!;
  const words: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h > 0) words.push(HUNDREDS[h]!);
  if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10]!);
  else {
    if (rest >= 20) words.push(TENS[Math.floor(rest / 10)]!);
    if (rest % 10 > 0 || (rest === 0 && h === 0)) words.push(UNITS[rest % 10]!);
  }
  return words.join(' ');
}

/** Chess file letters as the coach says them: Latin from the notation, Cyrillic that cannot be a word on its own. */
const FILE_SPOKEN: Record<string, string> = {
  a: 'а', b: 'бэ', c: 'цэ', d: 'дэ', e: 'е', f: 'эф', g: 'же', h: 'аш',
  б: 'бэ', ц: 'цэ', д: 'дэ', ф: 'эф', ж: 'же', х: 'аш',
};
/** Cyrillic look-alikes that are also words («с», «г.») count as files only glued to a rank: «С4», «г5». */
const FILE_BEFORE_RANK: Record<string, string> = { ...FILE_SPOKEN, с: 'цэ', г: 'же', е: 'е', а: 'а' };

/** Lowercase words of Russian speech, ready to compare. */
export function normalizeRu(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u0300-\u036f]/g, '') // stress marks (U+0301) and other combining signs
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // whisper's [BLANK_AUDIO], (музыка)
    .replace(/<#[\d.]+#>/g, ' ')
    .replace(/(^|[^\p{L}])([a-hбцдфжхсгеа])-?([1-8])(?!\d)/gu, (_m, pre: string, file: string, rank: string) => `${pre}${FILE_BEFORE_RANK[file]} ${rank}`)
    .replace(/(\p{L})(\d)/gu, '$1 $2')
    .replace(/(\d)(\p{L})/gu, '$1 $2');
  const words: string[] = [];
  for (const raw of cleaned.split(/[^\p{L}\p{N}]+/u)) {
    if (raw === '') continue;
    if (/^\d+$/.test(raw)) words.push(...numberRu(raw).split(' '));
    else if (raw.length === 1 && FILE_SPOKEN[raw] !== undefined) words.push(FILE_SPOKEN[raw]!);
    else words.push(raw);
  }
  return words;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * A coarse phonetic key of Russian speech, so the recogniser's spelling of what was actually pronounced matches the
 * written text: unstressed «о» is said «а» («конём» → «канём»), final consonants are devoiced («ферзь» → «ферс»),
 * soft/hard signs are silent. Vowels collapse to two classes (а/о/ы/у vs е/и/э/я/ю), voiced consonants to voiceless.
 */
export function phoneticKey(word: string): string {
  const map: Record<string, string> = {
    о: 'а', ы: 'а', у: 'у', э: 'и', е: 'и', я: 'и', ю: 'у', й: 'и',
    б: 'п', в: 'ф', г: 'к', д: 'т', ж: 'ш', з: 'с', щ: 'ш', ь: '', ъ: '',
  };
  let out = '';
  for (const ch of word) out += map[ch] ?? ch;
  return out;
}

/** Similarity of two word lists on their phonetic keys, word boundaries ignored («к нём» = «конём»). */
export function similarity(expected: string[], heard: string[]): number {
  const a = expected.map(phoneticKey).join('');
  const b = heard.map(phoneticKey).join('');
  const len = Math.max(a.length, b.length);
  return len === 0 ? 1 : 1 - levenshtein(a, b) / len;
}

/** Smallest edit distance between `needle` and any substring of `hay` (approximate substring search). */
export function substringDistance(needle: string, hay: string): number {
  if (needle.length === 0) return 0;
  let prev: number[] = new Array<number>(hay.length + 1).fill(0);
  for (let i = 1; i <= needle.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= hay.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (needle[i - 1] === hay[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.min(...prev);
}

const PIECE_RE = /^(корол|ферз|ладь|ладе|слон|пешк|пешек|кон(ь|я|ю|ем|ей|и|ям|ями|ях)$)/;
const FILES = new Set(['а', 'бэ', 'цэ', 'дэ', 'е', 'эф', 'же', 'аш']);
const RANKS = new Set(['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь']);
const ACTIONS = new Set(['бьет', 'шах', 'мат', 'рокировку', 'рокировка', 'рокировкой']);

type Critical = { kind: 'square'; file: string; rank: string } | { kind: 'word'; word: string };

/** Interjections that may open a sentence («Ого, вилка!», «Хм…»): alone they are what the recogniser mishears most. */
const INTERJECTION_RE = /^(хм+|ого|ой|ай|ах|ох|ух|эх|ура|ага|упс|вау|опа|оп|тс+|ну)$/;

/**
 * Extra critical words of the overlay's rule (design-audio §3): every word a placeholder produced (`words`, e.g. the
 * piece in its case, «сама»), and — with `interjection` — an interjection that opens the text.
 */
export interface CriticalExtra {
  words?: readonly string[];
  interjection?: boolean;
}

/** What must be heard, in order: squares (a file word right before a rank word), pieces, actions, numbers. A lone «а»/«е» is a conjunction, not a file. */
export function criticalItems(expected: string[], extra: CriticalExtra = {}): Critical[] {
  const words = new Set((extra.words ?? []).flatMap((w) => normalizeRu(w)));
  const items: Critical[] = [];
  for (let i = 0; i < expected.length; i++) {
    const w = expected[i]!;
    const next = expected[i + 1];
    if (FILES.has(w) && next !== undefined && RANKS.has(next)) {
      items.push({ kind: 'square', file: w, rank: next });
      i++;
    } else if (PIECE_RE.test(w) || RANKS.has(w) || ACTIONS.has(w) || words.has(w) || (extra.interjection === true && i === 0 && INTERJECTION_RE.test(w))) items.push({ kind: 'word', word: w });
  }
  return items;
}

/** Words of the expected text that must be heard (flat list, for reports). */
export function criticalWords(expected: string[]): string[] {
  return criticalItems(expected).map((item) => (item.kind === 'square' ? `${item.file} ${item.rank}` : item.word));
}

function rankMatches(rank: string, heard: string | undefined): boolean {
  if (heard === undefined) return false;
  const a = phoneticKey(rank);
  const b = phoneticKey(heard);
  return a === b || (rank.length >= 5 && levenshtein(a, b) <= 1);
}

/**
 * Index just after the match of `item` in `heard` at or after `from`, or −1. Files must be heard as those exact
 * words (the recogniser writes «F6», «Ц-4», which normalise to them) and immediately followed by the rank; a piece or
 * action word may be split or glued by the recogniser («к нём», «Ладьёйна»), so it is searched in the phonetic keys of
 * two neighbouring words with at most one edit (none for keys of ≤ 3 sounds).
 */
function findItem(item: Critical, heard: string[], from: number): number {
  for (let j = from; j < heard.length; j++) {
    if (item.kind === 'square') {
      if (heard[j] === item.file && rankMatches(item.rank, heard[j + 1])) return j + 2;
      continue;
    }
    const { word } = item;
    if (RANKS.has(word)) {
      if (rankMatches(word, heard[j])) return j + 1;
      continue;
    }
    const key = phoneticKey(word);
    const tolerance = key.length <= 3 ? 0 : 1;
    const one = phoneticKey(heard[j]!);
    if (substringDistance(key, one) <= tolerance) return j + 1;
    if (j + 1 < heard.length && substringDistance(key, one + phoneticKey(heard[j + 1]!)) <= tolerance) return j + 2;
  }
  return -1;
}

export interface MatchResult {
  score: number;
  missing: string[];
  ok: boolean;
}

export function matchTranscript(expectedText: string, heardText: string, minScore = ASR_MIN_SCORE, extra: CriticalExtra = {}): MatchResult {
  const expected = normalizeRu(expectedText);
  const heard = normalizeRu(heardText);
  const score = Math.round(similarity(expected, heard) * 1000) / 1000;
  const missing: string[] = [];
  let pos = 0;
  for (const item of criticalItems(expected, extra)) {
    const next = findItem(item, heard, pos);
    if (next < 0) missing.push(item.kind === 'square' ? `${item.file} ${item.rank}` : item.word);
    else pos = next;
  }
  return { score, missing, ok: score >= minScore && missing.length === 0 };
}

// ── whisper.cpp ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WhisperSetup {
  bin: string;
  model: string;
}

function run(bin: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, [...args], { maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 }, (err, stdout, stderr) => {
      const exit: unknown = err === null ? 0 : (err as { code?: unknown }).code;
      resolve({ code: typeof exit === 'number' ? exit : 1, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Why ASR cannot run (binary missing, model missing or truncated), or null when it can. */
export async function whisperProblem(setup: WhisperSetup): Promise<string | null> {
  if (!existsSync(setup.model)) return `no whisper model at ${setup.model} (see tools/voice-clips/README.md)`;
  if (path.basename(setup.model) === WHISPER_MODEL.file && statSync(setup.model).size !== WHISPER_MODEL.bytes) return `${setup.model} has the wrong size (download interrupted?)`;
  const probe = await run(setup.bin, ['--help']);
  if (probe.code !== 0 && !/usage/i.test(probe.stdout + probe.stderr)) return `${setup.bin} is not installed (brew install whisper-cpp)`;
  return null;
}

/** Transcribes one clip (any format ffmpeg reads) in Russian. Nothing is played. */
export async function transcribe(file: string, setup: WhisperSetup, workBase: string): Promise<string> {
  const work = mkdtempSync(path.join(workBase, 'asr-'));
  try {
    const wav = path.join(work, 'in.wav');
    await toWav16k(file, wav);
    const base = path.join(work, 'out');
    const result = await run(setup.bin, ['-m', setup.model, '-l', 'ru', '-nt', '-np', '-otxt', '-of', base, '-f', wav]);
    if (result.code !== 0) throw new Error(`whisper-cli failed: ${result.stderr.trim().split('\n').slice(-2).join(' | ')}`);
    const txt = `${base}.txt`;
    return (existsSync(txt) ? readFileSync(txt, 'utf8') : result.stdout).replace(/\s+/g, ' ').trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** SHA-256 of the model file, compared with the checksum Hugging Face publishes for it. */
export async function checkWhisperModel(file: string): Promise<{ ok: boolean; sha256: string; bytes: number }> {
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  const sha256 = hash.digest('hex');
  return { ok: sha256 === WHISPER_MODEL.sha256 && bytes === WHISPER_MODEL.bytes, sha256, bytes };
}
