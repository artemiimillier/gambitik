/**
 * The catalogue lint of the «Записи» voice (docs/voice-clips/SPEC.md §10 `script`, with the catalogue's voice rules): what a
 * recorded wording may never contain, checked for free before a single credit is spent.
 *
 *  - no Latin, no square outside slots: opponent moves, dangers and treasures are named WITHOUT squares (the board
 *    highlights them), squares live only in slot units;
 *  - Гамбитик is a boy: his self-reference is MASCULINE («я готов», «я заметил», «я рад»), even in Giselle's voice —
 *    a feminine first-person form is an error (this overrides the SPEC's gender-neutral rule);
 *  - the right piece word for each piece variant, no piece word in a wording shared by every piece;
 *  - length caps: whole ≤ 12 words / 80 chars, head ≤ 5 words, tail ≤ 8, slot ≤ 5, bark ≤ 3;
 *  - seams: a head ends with — or :, a tail starts with its `join` (default —), a whole line / bark / tail ends a sentence.
 */
import type { ClipCatalogLine, PieceType } from '@gambit/shared';
import { countWords } from '../phrase.ts';
import { pieceNameRu } from '../spoken.ts';
import { catalogUnits, linePieces, usesGender, usesPiece } from './catalog.ts';
import { CLIP_PIECES, SPOKEN_FILES, SPOKEN_RANKS } from './keys.ts';

export type ClipLintRule = 'latin' | 'square' | 'placeholder' | 'selfFeminine' | 'length' | 'pieceWord' | 'join' | 'end' | 'empty' | 'variant' | 'duplicate' | 'fallback';

export interface ClipLintIssue {
  line: string;
  unitKey?: string;
  rule: ClipLintRule;
  text: string;
  detail?: string;
}

export type ClipLintRole = ClipCatalogLine['role'] | 'slot';

/** Words (and characters) per role, SPEC §10. */
export const CLIP_LENGTH_CAPS: Readonly<Record<ClipLintRole, { words: number; chars?: number }>> = {
  whole: { words: 12, chars: 80 },
  head: { words: 5 },
  tail: { words: 8 },
  slot: { words: 5 },
  bark: { words: 3 },
};

const NOT_LETTER = '(?![а-яё])';
const AFTER_NON_LETTER = '(?<![а-яё])';

const SQUARE_WORDS_RE = new RegExp(`${AFTER_NON_LETTER}(?:${SPOKEN_FILES.join('|')})\\s+(?:${SPOKEN_RANKS.join('|')})${NOT_LETTER}`, 'iu');

/** Feminine short adjectives / pronouns a speaker says about herself. */
const FEM_SELF_WORDS: ReadonlySet<string> = new Set(['рада', 'готова', 'уверена', 'довольна', 'согласна', 'должна', 'сама', 'одна', 'горда', 'счастлива', 'удивлена', 'спокойна', 'занята', 'голодна', 'влюблена', 'восхищена', 'весела', 'мала']);
/** Another subject between «я» and the verb: «я вижу ты нашла» is about the child. */
const OTHER_SUBJECTS: ReadonlySet<string> = new Set(['ты', 'вы', 'он', 'она', 'оно', 'мы', 'они']);
/** Words in -ла that are no past verbs. */
const NOT_VERBS: ReadonlySet<string> = new Set(['дела', 'сила', 'стрела', 'пчела', 'тела', 'игла', 'скала', 'мела', 'села']);
const FEM_PAST_RE = /^[а-я]{2,}л(?:а|ась)$/u;
const CLAUSE_STOP_RE = /^[,.!?…:;—–()]$/u;

/**
 * «я» and, within the next three words of the same clause (no other subject in between), a feminine past verb or short
 * adjective: «я заметила», «я так рада», «я же тебе говорила».
 */
function feminineAfterI(text: string): boolean {
  const tokens = text.toLowerCase().replace(/ё/g, 'е').match(/[а-я]+(?:-[а-я]+)*|[,.!?…:;—–()]/gu) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'я') continue;
    for (let j = i + 1; j <= i + 3 && j < tokens.length; j++) {
      const t = tokens[j] as string;
      if (CLAUSE_STOP_RE.test(t) || OTHER_SUBJECTS.has(t)) break;
      if (FEM_SELF_WORDS.has(t) || (FEM_PAST_RE.test(t) && !NOT_VERBS.has(t))) return true;
    }
  }
  return false;
}
/** Self-reference without «я»: «Рада тебя видеть!» at a sentence start, «мне самой». */
const SELF_FEM_BARE_RE = new RegExp(`(?:^|[.!?…]\\s+|—\\s+)(?:рада|горда|счастлива|довольна)${NOT_LETTER}|${AFTER_NON_LETTER}(?:мне|меня)\\s+самой${NOT_LETTER}`, 'iu');

/** Every piece word in every case, → its piece. */
const PIECE_WORDS: ReadonlyMap<string, PieceType> = (() => {
  const m = new Map<string, PieceType>();
  for (const p of CLIP_PIECES) for (const c of ['nom', 'acc', 'gen', 'ins'] as const) m.set(pieceNameRu(p, c).replace(/ё/g, 'е'), p);
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

/** Does the text refer to the speaker in the feminine («я заметила», «я рада», «Рада тебя видеть!»)? */
export function hasFeminineSelfReference(text: string): boolean {
  return feminineAfterI(text) || SELF_FEM_BARE_RE.test(text);
}

/** Does the text name a square in words («эф шесть»)? Squares belong only in slot units. */
export function hasSpokenSquare(text: string): boolean {
  return SQUARE_WORDS_RE.test(text.replace(/ё/g, 'е').replace(/Ё/g, 'Е'));
}

/**
 * The rules one expanded text breaks (rule + detail). `piece` = the variant's piece (every piece word must be its own);
 * `sharedByPieces` = a plain wording of a `byPiece` line (it may name no piece at all); `join` = the line's seam.
 */
export function lintText(
  text: string,
  role: ClipLintRole,
  opts: { piece?: PieceType; sharedByPieces?: boolean; join?: '—' | ':' } = {},
): { rule: ClipLintRule; detail?: string }[] {
  const issues: { rule: ClipLintRule; detail?: string }[] = [];
  const t = text.trim();
  if (t === '') return [{ rule: 'empty' }];
  if (/[A-Za-z]/.test(t)) issues.push({ rule: 'latin' });
  if (/[{}]/.test(t)) issues.push({ rule: 'placeholder', detail: 'unfilled placeholder' });
  if (role !== 'slot' && hasSpokenSquare(t)) issues.push({ rule: 'square', detail: 'squares are said only by slot units' });
  if (hasFeminineSelfReference(t)) issues.push({ rule: 'selfFeminine', detail: 'Гамбитик is a boy: «я готов», «я заметил», «я рад»' });
  const cap = CLIP_LENGTH_CAPS[role];
  const words = countWords(t);
  if (words > cap.words) issues.push({ rule: 'length', detail: `${words} words > ${cap.words}` });
  if (cap.chars !== undefined && [...t].length > cap.chars) issues.push({ rule: 'length', detail: `${[...t].length} chars > ${cap.chars}` });
  const pieces = pieceWordsIn(t);
  if (opts.piece && pieces.some((p) => p !== opts.piece)) issues.push({ rule: 'pieceWord', detail: `names another piece than '${opts.piece}'` });
  if (opts.sharedByPieces && pieces.length > 0) issues.push({ rule: 'pieceWord', detail: 'a wording shared by every piece names a piece' });
  const endsSentence = /[.!?…]$/u.test(t);
  if (role === 'head') {
    // (a wording may pick either seam: «Мой совет —», «Попробуй так:» — the gap follows what is recorded)
    if (!/[—:]$/u.test(t)) issues.push({ rule: 'join', detail: 'a head ends with — or :' });
  } else if (role === 'tail') {
    const join = opts.join ?? '—';
    if (!t.startsWith(join)) issues.push({ rule: 'join', detail: `a tail starts with ${join}` });
    if (!endsSentence) issues.push({ rule: 'end', detail: 'a tail ends the sentence' });
  } else if (role === 'whole' || role === 'bark') {
    if (!endsSentence) issues.push({ rule: 'end', detail: `a ${role} line ends with . ! ? or …` });
  }
  return issues;
}

/** Every issue of one catalogue line, over all its piece / gender variants. */
export function lintLine(line: ClipCatalogLine): ClipLintIssue[] {
  const out: ClipLintIssue[] = [];
  if (line.wordings.length === 0) out.push({ line: line.id, rule: 'empty', text: '', detail: 'no wordings' });
  const pieces = linePieces(line);
  for (const w of line.wordings) {
    if (usesPiece(w.t) && pieces.length === 0) out.push({ line: line.id, rule: 'variant', text: w.t, detail: 'names a piece placeholder but the line is not byPiece' });
    if (usesGender(w.t) && !line.byGender) out.push({ line: line.id, rule: 'variant', text: w.t, detail: 'uses {g:…} but the line is not byGender' });
  }
  for (const u of catalogUnits(line)) {
    if (u.text === null) {
      out.push({ line: line.id, unitKey: u.unitKey, rule: 'placeholder', text: line.wordings[u.wording - 1]?.t ?? '', detail: 'cannot be expanded' });
      continue;
    }
    const opts = { ...(u.piece ? { piece: u.piece } : {}), ...(pieces.length > 0 && !u.piece ? { sharedByPieces: true } : {}), ...(line.join ? { join: line.join } : {}) };
    for (const i of lintText(u.text, line.role, opts)) out.push({ line: line.id, unitKey: u.unitKey, rule: i.rule, text: u.text, ...(i.detail ? { detail: i.detail } : {}) });
  }
  return out;
}

/** The whole catalogue: every line, unique ids, fallbacks that exist and never loop. */
export function lintCatalog(lines: readonly ClipCatalogLine[]): ClipLintIssue[] {
  const out: ClipLintIssue[] = [];
  const byId = new Map<string, ClipCatalogLine>();
  for (const l of lines) {
    if (byId.has(l.id)) out.push({ line: l.id, rule: 'duplicate', text: '', detail: 'duplicate line id' });
    else byId.set(l.id, l);
  }
  for (const l of lines) {
    out.push(...lintLine(l));
    if (!l.fallback) continue;
    if (!byId.has(l.fallback)) {
      out.push({ line: l.id, rule: 'fallback', text: '', detail: `unknown fallback '${l.fallback}'` });
      continue;
    }
    const seen = new Set<string>([l.id]);
    for (let cur: string | undefined = l.fallback; cur; cur = byId.get(cur)?.fallback) {
      if (seen.has(cur)) {
        out.push({ line: l.id, rule: 'fallback', text: '', detail: 'fallback loop' });
        break;
      }
      seen.add(cur);
    }
  }
  return out;
}
