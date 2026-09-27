/**
 * The lint of the pre-written words of «Учитель» (docs/TEACHING.md §4.2): what a wording of
 * `@gambit/content` LESSON_LINES may never contain, and how many wordings every pool needs at every stage.
 * Pure; used by the gate test (content.test.ts), the report tool and the writers.
 */
import type { PieceType } from '@gambit/shared';
import type { LessonLine, LessonWording } from '@gambit/content';
import { countWords } from '../phrase.ts';
import { pieceNameRu } from '../spoken.ts';
import { expandWording, usesGender, usesPiece } from '../clips/catalog.ts';
import { hasFeminineSelfReference, hasSpokenSquare } from '../clips/lint.ts';
import { SPOKEN_FILES } from '../clips/keys.ts';
import { isOptionPool } from './quizWords.ts';

export type LessonLintRule =
  | 'empty'
  | 'latin'
  | 'digit'
  | 'placeholder'
  | 'square'
  | 'file'
  | 'selfFeminine'
  | 'banned'
  | 'length'
  | 'sentences'
  | 'seam'
  | 'end'
  | 'pieceWord'
  | 'subject'
  | 'deixis'
  | 'childGender'
  | 'duplicate'
  | 'count'
  | 'band'
  | 'opener'
  | 'variant'
  | 'term'
  | 'blame'
  | 'stages';

export interface LessonLintIssue {
  pool: string;
  rule: LessonLintRule;
  text: string;
  detail?: string;
}

/** Words per role; a mini-lesson / takeaway may hold `maxSentences` sentences of ≤ 14 words each. */
export const LESSON_LENGTH_CAPS = { whole: 14, lead: 7, tail: 10, option: 3, optionChars: 18, praise: 10, bark: 2 } as const;

/**
 * The words a child meets first at a stage (docs/TEACHING.md §2.10): a wording available at stage s must not use a
 * term of a later stage. Regexes over the lower-cased, ё→е text.
 */
export const STAGE_TERMS: readonly { re: RegExp; stage: number; term: string }[] = [
  { re: /(?<![а-я])развити/u, stage: 2, term: 'развитие' },
  { re: /детск\S* мат/u, stage: 2, term: 'детский мат' },
  { re: /(?<![а-я])вилк/u, stage: 2, term: 'вилка' },
  { re: /(?<![а-я])пат(?![а-я])|(?<![а-я])пата(?![а-я])/u, stage: 2, term: 'пат' },
  { re: /(?<![а-я])связк|(?<![а-я])связ(ал|ыва|ан)/u, stage: 3, term: 'связка' },
  { re: /сквозн/u, stage: 3, term: 'сквозной удар' },
  { re: /диагонал/u, stage: 3, term: 'диагональ' },
  { re: /вертикал/u, stage: 3, term: 'вертикаль' },
  { re: /горизонтал/u, stage: 3, term: 'горизонталь' },
  { re: /открыт\S* лини/u, stage: 3, term: 'открытая линия' },
  { re: /(?<![а-я])фланг/u, stage: 3, term: 'фланг' },
  { re: /вскрыт/u, stage: 4, term: 'вскрытое нападение' },
  { re: /защитник/u, stage: 4, term: 'убрать защитника' },
  { re: /отвлеч/u, stage: 4, term: 'отвлечение' },
  { re: /проходн/u, stage: 5, term: 'проходная' },
  { re: /эндшпил/u, stage: 5, term: 'эндшпиль' },
  { re: /оппозиц/u, stage: 5, term: 'оппозиция' },
];

/** Words that sound like a reproach — never in a mistake, a rule, a take-back or a quiz reply. */
const BLAME_RE = /(?<![а-яё])(?:ты не|ты забыл\S*|забыл\S*|зря|я же говорил|я предупреждал|опять|снова|неверно)/iu;

/** «бить/бьёт … клетки» — at stages 1–2 «бить» is only about pieces (a child reads it as capturing). */
const HIT_SQUARES_RE = /(?<![а-яё])(?:бить|бьёт|бьет|бьют|будет бить)\s+(?:\S+\s+){0,2}клет/iu;

const NOT_LETTER = '(?![а-яё])';
const AFTER_NON_LETTER = '(?<![а-яё])';

/** «линия цэ», «по вертикали е», «на эф» — a file named by its letter (the square rule does not catch a bare file). */
const FILE_WORD_RE = new RegExp(`${AFTER_NON_LETTER}(?:лини[яиюей]|вертикал[ьиюей]|линией)\\s+(?:${SPOKEN_FILES.join('|')})${NOT_LETTER}`, 'iu');

/** Words the child must not hear (docs/TEACHING.md §2.2, §2.5): generic praise, «ходи сюда», the clock. */
const BANNED_RE =
  /(?<![а-яё])(?:молод(?:ец|цы|чина)|умниц[аы]|так держать|ходи сюда|сходи сюда|смотри на (?:зелёную |зеленую )?стрелк|зел[её]н\S* стрелк|минут\S*|секунд\S*|лучший ход|самый сильный ход|зевок|зевнул\S*|ошибк\S*|ошиб\S*ся|плох\S* ход|неправильн\S*)/iu;

/** Pointing at the board: only in a pool that highlights something. */
const DEIXIS_RE = /(?<![а-яё])(?:вот (?:эт\S*|сюда|туда|здесь)|эт(?:от|у|и|ой) (?:фланг\S*|клетк\S*|лини\S*|диагонал\S*|вертикал\S*|горизонтал\S*|пешк\S*)|сюда)(?![а-яё])/iu;

/** A bare «ты …л» past form without {g:…} would be wrong for a girl. */
const CHILD_PAST_RE = /(?<![а-яё])ты\s+(?:[а-яё]+\s+)?[а-яё]{2,}(?:л|лся)(?![а-яё])/iu;

const PIECES: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const NON_KING: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q'];

/** Every piece word in every case → its piece (king words are allowed everywhere: «рядом с королём»). */
const PIECE_WORDS: ReadonlyMap<string, PieceType> = (() => {
  const m = new Map<string, PieceType>();
  for (const p of PIECES) for (const c of ['nom', 'acc', 'gen', 'ins'] as const) m.set(pieceNameRu(p, c).replace(/ё/g, 'е'), p);
  for (const [w, p] of [
    ['коне', 'n'], ['коню', 'n'], ['кони', 'n'], ['коней', 'n'], ['конями', 'n'], ['коням', 'n'],
    ['слону', 'b'], ['слоне', 'b'], ['слоны', 'b'], ['слонов', 'b'], ['слонами', 'b'], ['слонам', 'b'],
    ['ладье', 'r'], ['ладьи', 'r'], ['ладей', 'r'], ['ладьями', 'r'], ['ладьям', 'r'],
    ['ферзю', 'q'], ['ферзе', 'q'],
    ['пешке', 'p'], ['пешки', 'p'], ['пешек', 'p'], ['пешками', 'p'], ['пешкам', 'p'],
  ] as const) m.set(w, p);
  return m;
})();

function pieceWordsIn(text: string): PieceType[] {
  const out: PieceType[] = [];
  for (const w of text.toLowerCase().replace(/ё/g, 'е').split(/[^а-я-]+/u)) {
    const p = PIECE_WORDS.get(w);
    if (p) out.push(p);
  }
  return out;
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter((s) => /[а-яёА-ЯЁ]/u.test(s));
}

/** The pieces a pool's subject can be (the king only where it can move / be moved). */
export function subjectPieces(line: Pick<LessonLine, 'subject'>): readonly PieceType[] {
  if (!line.subject) return [];
  return line.subject === 'mover' || line.subject === 'oppPiece' || line.subject === 'attacker' ? PIECES : NON_KING;
}

/** Is the text pointing at the board («вот эти клетки», «этот фланг», «сюда»)? */
export function isDeictic(text: string): boolean {
  return DEIXIS_RE.test(text);
}

/** Does a lead claim the move is the best («лучше всего», «сильнее всего», «самый»)? The book gates these. */
export function claimsBest(text: string): boolean {
  return /(?<![а-яё])(?:лучше всего|сильнее всего|самый|самая|самое|лучший)(?![а-яё])/iu.test(text);
}

/** Every expansion of a wording: per subject piece (when it uses one) × per child's gender (when it uses one). */
export function expandLessonWording(line: Pick<LessonLine, 'subject'>, w: LessonWording): { text: string | null; piece?: PieceType; g?: 'm' | 'f' }[] {
  const pieces = usesPiece(w.t) ? subjectPieces(line) : [];
  const genders = usesGender(w.t) ? (['m', 'f'] as const) : [];
  const out: { text: string | null; piece?: PieceType; g?: 'm' | 'f' }[] = [];
  for (const piece of pieces.length > 0 ? pieces : [undefined]) {
    for (const g of genders.length > 0 ? genders : [undefined]) {
      out.push({ text: expandWording(w.t, { ...(piece ? { piece } : {}), ...(g ? { g } : {}) }), ...(piece ? { piece } : {}), ...(g ? { g } : {}) });
    }
  }
  return out;
}

/** The rules one expanded text of `line` breaks. */
export function lintLessonText(line: Pick<LessonLine, 'id' | 'role' | 'cue' | 'subject' | 'maxSentences'>, text: string, piece?: PieceType): { rule: LessonLintRule; detail?: string }[] {
  const issues: { rule: LessonLintRule; detail?: string }[] = [];
  const t = text.trim();
  if (t === '') return [{ rule: 'empty' }];
  if (/[A-Za-z]/.test(t)) issues.push({ rule: 'latin' });
  if (/[0-9]/.test(t)) issues.push({ rule: 'digit', detail: 'numbers are said in words' });
  if (/[{}]/.test(t)) issues.push({ rule: 'placeholder', detail: 'unfilled placeholder' });
  if (hasSpokenSquare(t)) issues.push({ rule: 'square', detail: 'the voice never names a square' });
  if (FILE_WORD_RE.test(t)) issues.push({ rule: 'file', detail: 'a file is named by its letter' });
  if (hasFeminineSelfReference(t)) issues.push({ rule: 'selfFeminine', detail: 'Гамбитик is a boy: «я готов», «я заметил»' });
  const banned = BANNED_RE.exec(t);
  if (banned) issues.push({ rule: 'banned', detail: `«${banned[0]}»` });
  if (DEIXIS_RE.test(t) && line.cue.length === 0) issues.push({ rule: 'deixis', detail: 'points at the board, but the pool has no cue' });
  const option = isOptionPool(line.id);
  const words = countWords(t);
  if (option) {
    if (words > LESSON_LENGTH_CAPS.option) issues.push({ rule: 'length', detail: `${words} words > ${LESSON_LENGTH_CAPS.option}` });
    if ([...t].length > LESSON_LENGTH_CAPS.optionChars) issues.push({ rule: 'length', detail: `${[...t].length} chars > ${LESSON_LENGTH_CAPS.optionChars}` });
    if (/[.!?…]$/u.test(t)) issues.push({ rule: 'end', detail: 'a button label has no end mark' });
  } else if (line.role === 'lead') {
    if (words > LESSON_LENGTH_CAPS.lead) issues.push({ rule: 'length', detail: `${words} words > ${LESSON_LENGTH_CAPS.lead}` });
    if (/[.!?…,:;—–-]$/u.test(t)) issues.push({ rule: 'end', detail: 'a lead has no end mark: its tail goes on' });
    if (/^[—–,:]/u.test(t)) issues.push({ rule: 'seam', detail: 'a lead starts a sentence' });
  } else if (line.role === 'tail') {
    if (words > LESSON_LENGTH_CAPS.tail) issues.push({ rule: 'length', detail: `${words} words > ${LESSON_LENGTH_CAPS.tail}` });
    if (!/^[—,:]/u.test(t)) issues.push({ rule: 'seam', detail: 'a tail starts with —, «,» or «:»' });
    if (!/[.!?…]$/u.test(t)) issues.push({ rule: 'end', detail: 'a tail ends the sentence' });
  } else {
    if (!/[.!?…]$/u.test(t)) issues.push({ rule: 'end', detail: 'a whole line ends with . ! ? or …' });
    const max = line.maxSentences ?? 1;
    const sentences = sentencesOf(t);
    if (sentences.length > max) issues.push({ rule: 'sentences', detail: `${sentences.length} sentences > ${max}` });
    for (const s of sentences) {
      const n = countWords(s);
      if (n > LESSON_LENGTH_CAPS.whole) issues.push({ rule: 'length', detail: `${n} words in a sentence > ${LESSON_LENGTH_CAPS.whole}` });
    }
    if (line.id.startsWith('v3.praise.') && words > LESSON_LENGTH_CAPS.praise) issues.push({ rule: 'length', detail: `praise: ${words} words > ${LESSON_LENGTH_CAPS.praise}` });
    if (line.id.startsWith('v3.bark.') && words > LESSON_LENGTH_CAPS.bark) issues.push({ rule: 'length', detail: `bark: ${words} words > ${LESSON_LENGTH_CAPS.bark}` });
  }
  if (/^v3\.(mistake|rule|takeback|quiz\.wrong|quiz\.explain)\./u.test(line.id) || line.id === 'v3.quiz.wrong') {
    const b = BLAME_RE.exec(t);
    if (b) issues.push({ rule: 'blame', detail: `«${b[0]}» sounds like a reproach` });
  }
  if (line.id === 'v3.quiz.q.canCapture' && /можно ли/iu.test(t)) issues.push({ rule: 'banned', detail: '«можно ли съесть» — съесть можно всегда; спрашиваем «выгодно ли / стоит ли»' });
  if (line.subject && piece) {
    const others = pieceWordsIn(t).filter((p) => p !== piece && p !== 'k');
    if (others.length > 0) issues.push({ rule: 'pieceWord', detail: `names another piece (${others.join(',')}) than the subject's '${piece}' — use the placeholders` });
  }
  if (CHILD_PAST_RE.test(t)) issues.push({ rule: 'childGender', detail: 'a «ты …л» form needs {g:…}' });
  return issues;
}

/** Every issue of one pool: each wording expanded over its variants, the per-stage count, duplicates. */
export function lintLessonLine(line: LessonLine): LessonLintIssue[] {
  const out: LessonLintIssue[] = [];
  const [lo, hi] = line.stages ?? [1, 5];
  const seen = new Set<string>();
  for (const w of line.wordings) {
    if (seen.has(w.t)) out.push({ pool: line.id, rule: 'duplicate', text: w.t, detail: 'the same wording twice in a pool' });
    seen.add(w.t);
    if (usesPiece(w.t) && !line.subject) out.push({ pool: line.id, rule: 'subject', text: w.t, detail: 'a piece placeholder in a pool without a subject' });
    if (w.stages) {
      const [a, b] = w.stages;
      if (a > b || a < lo || b > hi) out.push({ pool: line.id, rule: 'stages', text: w.t, detail: `wording stages ${a}–${b} outside the pool's ${lo}–${hi}` });
    }
    if (w.when) {
      for (const v of w.when) if (!(line.variants ?? []).includes(v)) out.push({ pool: line.id, rule: 'variant', text: w.t, detail: `unknown variant '${v}'` });
    }
    const [wa] = w.stages ?? [lo, hi];
    const plain = w.t.toLowerCase().replace(/ё/g, 'е');
    for (const term of STAGE_TERMS) {
      if (wa < term.stage && term.re.test(plain)) out.push({ pool: line.id, rule: 'term', text: w.t, detail: `«${term.term}» is a stage-${term.stage} word, the wording is available from stage ${wa} (tag it stages [${term.stage}, …])` });
    }
    if (wa <= 2 && HIT_SQUARES_RE.test(w.t)) out.push({ pool: line.id, rule: 'term', text: w.t, detail: 'stages 1–2: «бить» only pieces — squares are «стреляет по / смотрит на / держит»' });
    for (const x of expandLessonWording(line, w)) {
      if (x.text === null) {
        out.push({ pool: line.id, rule: 'placeholder', text: w.t, detail: 'cannot be expanded' });
        continue;
      }
      for (const i of lintLessonText(line, x.text, x.piece)) out.push({ pool: line.id, rule: i.rule, text: x.text, ...(i.detail ? { detail: i.detail } : {}) });
    }
  }
  // every sub-case has its own true wordings at every stage
  for (const v of line.variants ?? []) {
    const need = Math.max(2, Math.ceil(line.min / 2));
    for (let s = lo; s <= hi; s++) {
      const n = line.wordings.filter((w) => (!w.when || w.when.includes(v)) && s >= (w.stages ?? [lo, hi])[0] && s <= (w.stages ?? [lo, hi])[1]).length;
      if (n < need) out.push({ pool: line.id, rule: 'variant', text: '', detail: `variant '${v}', stage ${s}: ${n} wordings < ${need}` });
    }
  }
  // pointing words need a fallback: the board may be unable to show the cue
  if (line.wordings.some((w) => DEIXIS_RE.test(w.t))) {
    const need = Math.max(2, Math.ceil(line.min / 2));
    for (let s = lo; s <= hi; s++) {
      const n = line.wordings.filter((w) => !DEIXIS_RE.test(w.t) && s >= (w.stages ?? [lo, hi])[0] && s <= (w.stages ?? [lo, hi])[1]).length;
      if (n < need) out.push({ pool: line.id, rule: 'deixis', text: '', detail: `stage ${s}: ${n} wordings without «вот эти / сюда» < ${need}` });
    }
  }
  for (let s = lo; s <= hi; s++) {
    const n = line.wordings.filter((w) => {
      const [a, b] = w.stages ?? [lo, hi];
      return s >= a && s <= b;
    }).length;
    if (n < line.min) out.push({ pool: line.id, rule: 'count', text: '', detail: `stage ${s}: ${n} wordings < ${line.min}` });
  }
  // «разный контент для ступеней»: a banded pool that spans both bands has its own words for each
  if (line.stageMode === 'banded' && lo <= 2 && hi >= 3) {
    const bandMin = Math.max(2, Math.ceil(line.min / 2));
    for (const [a, b] of [[lo, 2], [3, hi]] as const) {
      const n = line.wordings.filter((w) => w.stages && w.stages[0] >= a && w.stages[1] <= b).length;
      if (n < bandMin) out.push({ pool: line.id, rule: 'band', text: '', detail: `stages ${a}–${b}: ${n} own wordings < ${bandMin}` });
    }
  }
  // the ear hears the first word: no first word opens too many wordings of a pool
  if (line.wordings.length >= 6 && !isOptionPool(line.id)) {
    const firsts = new Map<string, number>();
    for (const w of line.wordings) {
      const words = w.t.toLowerCase().replace(/ё/g, 'е').replace(/\{[^}]*\}/g, 'X').match(/[а-яx]+/gu) ?? [];
      const first = words.find((x) => x !== 'и' && x !== 'а') ?? '';
      if (first !== '') firsts.set(first, (firsts.get(first) ?? 0) + 1);
    }
    const cap = Math.max(2, Math.ceil(line.wordings.length / 4));
    for (const [word, n] of firsts) if (n > cap) out.push({ pool: line.id, rule: 'opener', text: word, detail: `${n} wordings start with «${word}» (> ${cap})` });
  }
  return out;
}

/** The whole library: every pool plus the same sentence reused in two pools (the child would hear it as a repeat). */
export function lintLessonLines(lines: readonly LessonLine[]): LessonLintIssue[] {
  const out: LessonLintIssue[] = [];
  const owner = new Map<string, string>();
  for (const l of lines) {
    out.push(...lintLessonLine(l));
    if (isOptionPool(l.id)) continue;
    for (const w of l.wordings) {
      const key = w.t.toLowerCase().replace(/ё/g, 'е').replace(/[^а-я{}|: ]/gu, '').replace(/\s+/g, ' ').trim();
      const first = owner.get(key);
      if (first !== undefined && first !== l.id) out.push({ pool: l.id, rule: 'duplicate', text: w.t, detail: `also in ${first}` });
      else owner.set(key, l.id);
    }
  }
  return out;
}
