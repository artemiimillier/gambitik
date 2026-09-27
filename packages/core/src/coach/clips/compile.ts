/**
 * The text compiler — the bridge for event families that have no clip twin (docs/voice-clips/SPEC.md §3.4 route 2,
 * grafted from the «fragments» design). The same function runs in the browser (clip layer) and in the tools (harvest):
 *
 *  1. the child's name is stripped (clips never say names; the bubble keeps it);
 *  2. sentences end at `. ! ? …`; inside a sentence fragments end at `— : ;` (commas never split);
 *  3. a square («на эф шесть», «бьёт на дэ пять») is a slot; the fragment left of it must carry the piece word
 *     («Соперник вывел коня» · «на эф шесть»). A lone piece word merges with its square into a whole move unit
 *     («Мой совет —» · «конём на эф шесть»);
 *  4. every fragment is keyed `f:<norm>|<end>` and resolved by EXACT match in the manifest (no fuzzy lookup);
 *  5. when the advised moves are known (`known`), a square must be the target of one of them (and a merged move must
 *     be that move) — otherwise the sentence is marked `mismatch` and falls down the ladder.
 *
 * The planner (plan.ts) resolves the result: it trims after the slot when only later units miss, never drops
 * anything before a slot, never voices a slot without its piece fragment.
 */
import type { CoachEvent, CoachEventKind, MascotPose, PieceType } from '@gambit/shared';
import { capitalize } from '../phrase.ts';
import { parseSan, pieceNameRu } from '../spoken.ts';
import { CLIP_PIECES, SPOKEN_FILES, SPOKEN_RANKS, fragEndOf, fragKey, normalizeFragment, squareFromSpoken } from './keys.ts';
import type { ClipInput, CompiledSentence, CompiledText, CompiledUnit, FragEnd, MoveSlotKey } from './types.ts';

export interface CompileOptions {
  /** the child's spoken name, stripped wherever it stands («Миша, смотри…», «Молодец, Миша!») */
  name?: string;
  /** SANs a square may belong to (`slotGuardOf(event)`); [] = no square may be said; undefined = no check */
  known?: readonly string[];
  /** the recorded generic line of this moment (ladder L5), `genericLineOf(kind, moment, pose)` */
  generic: string;
  bark?: MascotPose;
  moment?: string;
}

// ───────────────────────── names ─────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The text without the child's name: «Миша, смотри!» → «Смотри!», «Молодец, Миша!» → «Молодец!»,
 * «Привет-привет, Миша! Я Гамбитик.» → «Привет-привет! Я Гамбитик.»
 */
export function stripName(text: string, name: string | undefined): string {
  const n = (name ?? '').trim();
  if (!n) return text;
  const nm = escapeRe(n);
  return text
    .replace(new RegExp(`(^|[.!?…]\\s+)${nm}\\s*,\\s*(\\S)`, 'gu'), (_all, lead: string, first: string) => `${lead}${first.toUpperCase()}`)
    .replace(new RegExp(`\\s*,\\s*${nm}(?=\\s*[,.!?…:;—]|\\s*$)`, 'gu'), '')
    .replace(new RegExp(`(^|[.!?…]\\s+)${nm}\\s*([.!?…]+)\\s*`, 'gu'), '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────── sentences and fragments ─────────────────────────

/** «Смотри! Тут подарок… Найдёшь?» → [«Смотри!», «Тут подарок…», «Найдёшь?»]; «...» counts as «…». */
export function splitSentences(text: string): string[] {
  const t = text.replace(/\.\.\./g, '…').trim();
  const out: string[] = [];
  for (const m of t.matchAll(/[^.!?…]+(?:[.!?…]+|$)/gu)) {
    const s = m[0].trim();
    if (/[А-Яа-яЁёA-Za-z0-9]/u.test(s)) out.push(s);
  }
  return out;
}

/** The raw pieces of one sentence between seams: [text, the seam or sentence end after it]. */
function splitSeams(sentence: string): { text: string; end: FragEnd }[] {
  const m = /[.!?…]+$/u.exec(sentence);
  const terminator = m ? fragEndOf(m[0]) : '.';
  const body = m ? sentence.slice(0, m.index) : sentence;
  // a seam: a spaced dash («слово — слово»), or a colon / semicolon after a word
  const re = /\s+[—–]\s*|\s+-\s+|\s*[:;]\s*/gu;
  const out: { text: string; end: FragEnd }[] = [];
  let last = 0;
  for (const s of body.matchAll(re)) {
    const piece = body.slice(last, s.index).trim();
    const end = fragEndOf(s[0].includes(':') ? ':' : s[0].includes(';') ? ';' : '—');
    if (piece) out.push({ text: piece, end });
    else if (out.length > 0) out[out.length - 1] = { ...(out[out.length - 1] as { text: string; end: FragEnd }), end };
    last = (s.index ?? 0) + s[0].length;
  }
  const tail = body.slice(last).trim();
  if (tail) out.push({ text: tail, end: terminator });
  else if (out.length > 0) out[out.length - 1] = { ...(out[out.length - 1] as { text: string; end: FragEnd }), end: terminator };
  return out;
}

// ───────────────────────── squares and piece words ─────────────────────────

const FILE_ALT = SPOKEN_FILES.join('|');
const RANK_ALT = SPOKEN_RANKS.join('|');
/** a square with its lead-in, in normalised text (ё → е): «на эф шесть», «бьет на дэ пять» */
const SLOT_RE = new RegExp(`(?<![а-я])(?:(бьет)\\s+)?на\\s+(${FILE_ALT})\\s+(${RANK_ALT})(?![а-я])`, 'u');
const ANY_SQUARE_RE = new RegExp(`(?<![а-я])(?:${FILE_ALT})\\s+(?:${RANK_ALT})(?![а-я])`, 'u');

type PieceWord = { piece: PieceType; form: 'nom' | 'ins' | 'other' };
const PIECE_WORD: ReadonlyMap<string, PieceWord> = (() => {
  const m = new Map<string, PieceWord>();
  for (const p of CLIP_PIECES) {
    for (const c of ['acc', 'gen', 'nom', 'ins'] as const) {
      m.set(pieceNameRu(p, c).replace(/ё/g, 'е'), { piece: p, form: c === 'nom' || c === 'ins' ? c : 'other' });
    }
  }
  return m;
})();

/** «ходи конём» → { words: ['ходи', 'конем'], last: knight / ins }. */
function lastPieceWord(norm: string): PieceWord | null {
  const words = norm.split(/[\s,]+/u).filter(Boolean);
  return words.length > 0 ? (PIECE_WORD.get(words[words.length - 1] as string) ?? null) : null;
}

/** The first `n` words of the original text that match `norm`'s first `n` words — keeps the writer's case and ё. */
function originalPrefix(original: string, words: number): string {
  const parts = original.trim().split(/\s+/u);
  return parts.slice(0, words).join(' ');
}

interface KnownMove {
  piece: PieceType;
  to: string;
  capture: boolean;
  castle: boolean;
  san: string;
}

function knownMoves(known: readonly string[] | undefined): KnownMove[] | undefined {
  if (!known) return undefined;
  const out: KnownMove[] = [];
  for (const san of known) {
    const p = parseSan(san);
    if (!p) continue;
    out.push({ piece: p.piece, to: p.to ?? '', capture: p.capture, castle: p.kind !== 'move', san });
  }
  return out;
}

/** Compiles one fragment; a slot found in it is appended as a 'move' or a 'square' unit. */
function compileFragment(
  frag: { text: string; end: FragEnd },
  known: KnownMove[] | undefined,
): { units: CompiledUnit[]; slot: boolean; bad?: CompiledSentence['bad'] } {
  const norm = normalizeFragment(frag.text);
  const m = SLOT_RE.exec(norm);
  if (!m) {
    if (ANY_SQUARE_RE.test(norm)) return { units: [], slot: false, bad: 'bareSquare' };
    return { units: [{ kind: 'frag', key: fragKey(frag.text, frag.end), text: frag.text, end: frag.end }], slot: false };
  }
  const capture = m[1] === 'бьет';
  const sq = squareFromSpoken(m[2] as string, m[3] as string);
  if (!sq) return { units: [], slot: false, bad: 'bareSquare' };
  const pre = norm.slice(0, m.index).trim();
  const post = norm.slice(m.index + m[0].length).replace(/^[\s,]+/u, '').trim();
  if (post && ANY_SQUARE_RE.test(post)) return { units: [], slot: false, bad: 'twoSlots' };
  const piece = lastPieceWord(pre);
  if (!piece) return { units: [], slot: false, bad: 'noPiece' };
  const preWords = pre.split(/\s+/u).filter(Boolean);
  const units: CompiledUnit[] = [];

  const lone = preWords.length === 1 && (piece.form === 'nom' || (piece.form === 'ins' && !capture));
  if (lone) {
    const form = capture ? 'cap' : piece.form === 'ins' ? 'ins' : 'nom';
    const key = `${form}:${piece.piece}:${sq}` as MoveSlotKey;
    let san: string | undefined;
    if (known) {
      const hit = known.find((k) => !k.castle && k.to === sq && k.piece === piece.piece && k.capture === capture);
      if (!hit) return { units: [], slot: false, bad: 'mismatch' };
      san = hit.san;
    }
    const spoken = `${pieceNameRu(piece.piece, form === 'ins' ? 'ins' : 'nom')}${capture ? ' бьёт' : ''} на ${m[2]} ${m[3]}`;
    units.push({ kind: 'move', key, text: spoken, end: post ? '' : frag.end, ...(san ? { san } : {}) });
  } else {
    let san: string | undefined;
    if (known) {
      const hit = known.find((k) => !k.castle && k.to === sq && k.capture === capture);
      if (!hit) return { units: [], slot: false, bad: 'mismatch' };
      san = hit.san;
    }
    const preText = originalPrefix(frag.text, preWords.length);
    units.push({ kind: 'frag', key: fragKey(preText, ''), text: preText, end: '' });
    units.push({ kind: 'square', key: capture ? `xsq:${sq}` : `sq:${sq}`, text: `${capture ? 'бьёт на' : 'на'} ${m[2]} ${m[3]}`, end: post ? '' : frag.end, ...(san ? { san } : {}) });
  }
  if (post) {
    // the words after the square keep the fragment's own end: «Твой конь» · «на эф четыре» · «под боем!»
    const words = frag.text.trim().split(/\s+/u);
    const postWords = post.split(/\s+/u).filter(Boolean).length;
    const postText = words.slice(words.length - postWords).join(' ').replace(/^,\s*/u, '');
    units.push({ kind: 'frag', key: fragKey(postText, frag.end), text: postText, end: frag.end });
  }
  return { units, slot: true };
}

/** One sentence → its units; `bad` when it can never be voiced from clips. */
export function compileSentence(raw: string, known?: readonly string[]): CompiledSentence {
  const sentence = raw.trim();
  const endMatch = /[.!?…]+$/u.exec(sentence);
  const endPunct = endMatch ? fragEndOf(endMatch[0]) : '.';
  const end: CompiledSentence['end'] = endPunct === '?' || endPunct === '!' || endPunct === '…' ? endPunct : '.';
  const moves = knownMoves(known);
  const units: CompiledUnit[] = [];
  let slotAt = -1;
  for (const frag of splitSeams(sentence)) {
    const r = compileFragment(frag, moves);
    if (r.bad) return { units: [], end, text: sentence, slotAt: -1, bad: r.bad };
    if (r.slot) {
      if (slotAt >= 0) return { units: [], end, text: sentence, slotAt: -1, bad: 'twoSlots' };
      slotAt = units.length + r.units.findIndex((u) => u.kind === 'move' || u.kind === 'square');
    }
    units.push(...r.units);
  }
  if (units.length === 0) return { units, end, text: sentence, slotAt: -1, bad: 'empty' };
  return { units, end, text: sentence, slotAt };
}

/** `event.text` (or any spoken text) → the compiled route's input for `planClips`. */
export function compileText(text: string, opts: CompileOptions): CompiledText {
  const clean = stripName(text, opts.name);
  const sentences = splitSentences(clean).map((s) => compileSentence(capitalize(s), opts.known));
  return {
    src: 'text',
    sentences,
    generic: opts.generic,
    ...(opts.bark ? { bark: opts.bark } : {}),
    ...(opts.moment ? { moment: opts.moment } : {}),
  };
}

// ───────────────────────── from an event ─────────────────────────

/**
 * The generic line of a moment (ladder L5): `generic.<kind>[.<moment>][.<pose>]`. The planner walks up the dots when
 * a pool is missing (`generic.teachTurn.repeat.talk` → `generic.teachTurn.repeat` → `generic.teachTurn` → `generic`);
 * a «think» line (a danger, a hidden treasure: no arrow on the board) walks only `generic.<kind>.think` → `generic`.
 */
export function genericLineOf(kind: CoachEventKind, moment?: string, pose?: MascotPose): string {
  return ['generic', kind, moment, pose].filter((s): s is string => typeof s === 'string' && s !== '').join('.');
}

/**
 * The SAN guard of an event (§6.2): the moves its sentences may name — the teacher's advice; nothing while a treasure
 * waits to be found (`reveal: 'later'`); undefined (no guard) for events that carry no advice.
 */
export function slotGuardOf(event: Pick<CoachEvent, 'teach'>): string[] | undefined {
  const t = event.teach;
  if (!t) return undefined;
  if (t.reveal === 'later') return [];
  return t.advice.map((a) => a.san);
}

/**
 * What the clip layer plans for an event: its clip twin when a builder set one, else its compiled text.
 *
 * A lesson event (it carries `say`, docs/TEACHING.md §4.5) has no recorded twin: null — the planner then
 * plans nothing (silence) and the bubble alone shows the words («не озвучено»). Never its compiled text: an unrecorded
 * sentence would fall down the ladder to a generic line («Смотри на зелёную стрелку!»).
 */
export function clipInputOf(event: Pick<CoachEvent, 'kind' | 'text' | 'pose' | 'teach' | 'clip' | 'say'>, opts: { name?: string } = {}): ClipInput | null {
  if (event.say) return null;
  if (event.clip) return event.clip;
  return compileText(event.text, {
    ...(opts.name ? { name: opts.name } : {}),
    ...(event.teach ? { known: slotGuardOf(event) ?? [] } : {}),
    generic: genericLineOf(event.kind, event.teach?.moment, event.pose),
    bark: event.pose,
    ...(event.teach ? { moment: event.teach.moment } : {}),
  });
}
