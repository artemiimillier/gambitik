/**
 * Checks for the strategist's spoken Russian (the intro of a game, the re-plan phrases). A model may
 * only CHOOSE; whatever it says goes to a child through a voice, so the code proves it before use:
 * short, Russian only, no digits / notation, no clock / colour / whose-turn talk (never voice
 * what the board already shows), no «лучший ход», and no square that the code did not allow
 * (a model that invents a move names a square nobody gave it).
 */

/** How the files are pronounced (the same words as sanToSpokenRu in @gambit/core). */
const FILE_WORDS: Readonly<Record<string, string>> = { а: 'a', бэ: 'b', цэ: 'c', дэ: 'd', е: 'e', эф: 'f', же: 'g', аш: 'h' };
const RANK_WORDS: Readonly<Record<string, string>> = { один: '1', два: '2', три: '3', четыре: '4', пять: '5', шесть: '6', семь: '7', восемь: '8' };
/** «а» and «же» are also a conjunction and a particle («а два хода», «это же три хода»): only after «на / с / клетка / поле». */
const AMBIGUOUS_FILES = new Set(['а', 'же']);
const SQUARE_RE = /(?<![а-яё])(на\s+|с\s+|клетк[а-яё]*\s+|пол[еяю]\s+)?(а|бэ|цэ|дэ|е|эф|же|аш)[\s-]+(один|два|три|четыре|пять|шесть|семь|восемь)(?![а-яё])/giu;

/** Words that are not how a coach talks to a child about the board. */
const FORBIDDEN: readonly { re: RegExp; why: string }[] = [
  { re: /лучш(ий|его|ему|им|ем)\s+ход/iu, why: '«лучший ход»' },
  { re: /минут|секунд|(?<![а-яё])час(ы|ов|ах|ам|ами)?(?![а-яё])|(?<![а-яё])врем(я|ени|енем)(?![а-яё])/iu, why: 'the clock / time' },
  { re: /(?<![а-яё])(бел|чёрн|черн)(ые|ых|ыми|ым|ый|ая|ой|ую|ое|ого)(?![а-яё])/iu, why: 'the colour of the pieces' },
  { re: /тво[йя]\s+(ход|очередь)|ход\s+за\s+тобой|чей\s+ход/iu, why: 'whose turn it is' },
  { re: /(?<![а-яё])движ(ок|ка|ку|ком|ке)(?![а-яё])|ребён|ребен|ученик|приложени/iu, why: 'backstage words' },
];

/** Tokens that carry a letter or a digit (dashes and quotes are not words). */
export function wordCount(text: string): number {
  return text.split(/\s+/u).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

export function hasLatin(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/** Every square spoken in the text, as algebraic names ('e4'). */
export function spokenSquares(text: string): string[] {
  const squares: string[] = [];
  for (const match of text.toLowerCase().matchAll(SQUARE_RE)) {
    const lead = match[1];
    const fileWord = match[2] ?? '';
    const rankWord = match[3] ?? '';
    if (AMBIGUOUS_FILES.has(fileWord) && lead === undefined) continue;
    const file = FILE_WORDS[fileWord];
    const rank = RANK_WORDS[rankWord];
    if (file !== undefined && rank !== undefined) squares.push(`${file}${rank}`);
  }
  return squares;
}

export interface SpokenCheck {
  maxWords: number;
  /** squares the text may name; undefined = any (the code's own templates) */
  allowedSquares?: ReadonlySet<string>;
}

/** null when the phrase may be spoken, otherwise why not (for the log; never shown to the child). */
export function spokenProblem(text: string, check: SpokenCheck): string | null {
  const t = text.trim();
  if (t === '') return 'empty';
  if (hasLatin(t)) return 'Latin letters';
  if (/\d/.test(t)) return 'digits';
  if (/[<>{}[\]\\|`#*_=+]/.test(t)) return 'markup characters';
  const words = wordCount(t);
  if (words > check.maxWords) return `${words} words (max ${check.maxWords})`;
  for (const rule of FORBIDDEN) if (rule.re.test(t)) return rule.why;
  if (check.allowedSquares !== undefined) {
    const extra = spokenSquares(t).filter((sq) => !check.allowedSquares?.has(sq));
    if (extra.length > 0) return `names squares nobody allowed: ${[...new Set(extra)].join(', ')}`;
  }
  return null;
}

/** Collapses whitespace and makes sure the phrase ends like a sentence. */
export function tidySentence(text: string): string {
  const t = text.replace(/\s+/gu, ' ').trim();
  if (t === '') return t;
  const capital = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…»]$/u.test(capital) ? capital : `${capital}.`;
}

export function lowerFirst(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/** «слон на цэ четыре, шах» → 'c4' squares are found by spokenSquares; this adds a move's own squares by UCI. */
export function uciSquares(uci: string): string[] {
  return /^[a-h][1-8][a-h][1-8]/.test(uci) ? [uci.slice(0, 2), uci.slice(2, 4)] : [];
}
