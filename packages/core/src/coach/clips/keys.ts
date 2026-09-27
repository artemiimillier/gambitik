/**
 * Keys and ids of the «Записи» clip library (docs/voice-clips/SPEC.md §3.2, §4.2): the same code in the browser and in
 * the tools, so a move, a line or a fragment always maps to the same recording.
 *
 *  - clip id: `c` + 13 hex of cyrb53(voiceKey \n prompt \n cutIndex [\n take]) — changes only when a new take is paid for
 *    (identical to tools/voice-clips/ids.ts; pinned by golden values in keys.test.ts);
 *  - slot key: typed from chess.js-verified SAN (`ins:n:f6`, `nom:p:e4`, `cap:q:h7`, `nom:castle:short`), never parsed
 *    from Russian text; `canonicalSlotText` says it exactly as `sanToSpokenRu` / `moveInsRu` do, minus disambiguation;
 *  - the split set (`sq:f6` «на эф шесть», `xsq:d5` «бьёт на дэ пять», `head:ins:n` «конём», `head:nom:n` «конь»);
 *  - unit keys of the manifest: `slot:<slotKey>`, `line:<pool>#<n>`, `frag:f:<norm>|<end>`; pool keys `line@piece/g`.
 */
import { Chess } from 'chess.js';
import type { PieceType, Square } from '@gambit/shared';
import { FILE_SPOKEN, RANK_SPOKEN, pieceNameRu, squareToSpokenRu } from '../spoken.ts';
import type { ClipIndex, ClipUnitMeta, FragEnd, MergedClipIndex, MoveSlotKey, ParsedSlotKey, SlotForm, SlotKey, SplitSlotKey } from './types.ts';

/** The one voice of the first library: Higgsfield text2speech_v2 / minimax / preset «Giselle». */
export const CLIP_VOICE_KEY = 'giselle-mm1';

// ───────────────────────── ids ─────────────────────────

/** cyrb53 (public domain, bryc): a fast 53-bit string hash over UTF-16 code units; same result in Node and browsers. */
export function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const LOW_52 = 2 ** 52;

/** 13 lowercase hex characters: the low 52 bits of cyrb53, zero-padded. */
export function hash13(text: string): string {
  return (cyrb53(text) % LOW_52).toString(16).padStart(13, '0');
}

/**
 * The id of one recorded take: `c` + hash13(voiceKey \n prompt \n cutIndex), with `\n take` appended from the second
 * take on (two paid takes of one prompt never collide; take-1 ids stay the SPEC formula). The prompt is hashed exactly
 * as it was sent — never normalised — so the id means «what was paid for».
 */
export function clipId(voiceKey: string, prompt: string, cutIndex = 0, take = 1): string {
  const base = `${voiceKey}\n${prompt}\n${cutIndex}`;
  return `c${hash13(take > 1 ? `${base}\n${take}` : base)}`;
}

/** Hex ids pass the black box's `DIAG_STRING_RE`. */
export const CLIP_ID_RE = /^c[0-9a-f]{13}$/;

/** `c3f0a91b2c4d5` → `3f/c3f0a91b2c4d5.mp3` (256 folders by the two hex digits after the `c`, SPEC §4.1). */
export function clipFile(id: string): string {
  return `${id.slice(1, 3)}/${id}.mp3`;
}

// ───────────────────────── moves → slot keys ─────────────────────────

export const CLIP_PIECES: readonly PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const PIECE_SET: ReadonlySet<string> = new Set(CLIP_PIECES);
const SQUARE_RE = /^[a-h][1-8]$/;

export function isSquare(s: string): boolean {
  return SQUARE_RE.test(s);
}

/** A move as the board says it — never as a text says it. */
export interface VerifiedMove {
  piece: PieceType;
  from: Square;
  to: Square;
  capture: boolean;
  castle?: 'short' | 'long';
  promotion?: PieceType;
  /** '+' check, '#' mate */
  suffix?: '+' | '#';
  /** chess.js's canonical SAN */
  san: string;
}

const VERIFY_MEMO_MAX = 512;
const verifyMemo = new Map<string, VerifiedMove | null>();

/** Plays `san` on `fen` with chess.js; null when the FEN is broken or the move is illegal there. Memoised. */
export function verifyMove(san: string, fen: string): VerifiedMove | null {
  const clean = typeof san === 'string' ? san.trim().replace(/[!?]+$/, '') : '';
  if (!clean || typeof fen !== 'string' || fen.trim() === '') return null;
  const memoKey = `${fen}|${clean}`;
  const hit = verifyMemo.get(memoKey);
  if (hit !== undefined) return hit;
  let result: VerifiedMove | null = null;
  try {
    const m = new Chess(fen).move(clean);
    const suffix = m.san.endsWith('#') ? '#' : m.san.endsWith('+') ? '+' : undefined;
    result = {
      piece: m.piece as PieceType,
      from: m.from,
      to: m.to,
      capture: m.captured !== undefined,
      ...(m.flags.includes('k') ? { castle: 'short' as const } : m.flags.includes('q') ? { castle: 'long' as const } : {}),
      ...(m.promotion ? { promotion: m.promotion as PieceType } : {}),
      ...(suffix ? { suffix } : {}),
      san: m.san,
    };
  } catch {
    result = null;
  }
  if (verifyMemo.size >= VERIFY_MEMO_MAX) verifyMemo.delete(verifyMemo.keys().next().value as string);
  verifyMemo.set(memoKey, result);
  return result;
}

/**
 * The slot key of a move said in `form`, from chess.js-verified SAN (SPEC §3.2); null when the move is illegal in `fen`
 * or the form does not fit it: 'ins' is for non-captures without promotion (as `moveInsRu`), 'nom' for non-captures,
 * 'cap' for captures only. Castling: 'nom' / 'ins' → `nom:castle:short` …; disambiguation, promotion and check are
 * never part of the key (promotion / check are tails of their own, SPEC §3.2).
 */
export function slotKeyOf(san: string, fen: string, form: SlotForm): MoveSlotKey | null {
  const m = verifyMove(san, fen);
  if (!m) return null;
  if (m.castle) return form === 'cap' ? null : `${form}:castle:${m.castle}`;
  if (form === 'cap') return m.capture ? `cap:${m.piece}:${m.to}` : null;
  if (m.capture) return null;
  if (form === 'ins' && m.promotion) return null;
  return `${form}:${m.piece}:${m.to}`;
}

/** The form a twin can use for this move: `prefer` when it fits, 'nom' for a promotion said with 'ins', 'cap' for a capture. */
export function slotFormOf(san: string, fen: string, prefer: 'nom' | 'ins'): SlotForm | null {
  const m = verifyMove(san, fen);
  if (!m) return null;
  if (m.castle) return prefer;
  if (m.capture) return 'cap';
  if (prefer === 'ins' && m.promotion) return 'nom';
  return prefer;
}

/** What a move needs besides its slot: a promotion tail («— и станет ферзём!»), a check / mate tail («— шах!»). */
export function moveTailsOf(san: string, fen: string): { promotion?: PieceType; check?: 'check' | 'mate' } | null {
  const m = verifyMove(san, fen);
  if (!m) return null;
  return {
    ...(m.promotion ? { promotion: m.promotion } : {}),
    ...(m.suffix === '#' ? { check: 'mate' as const } : m.suffix === '+' ? { check: 'check' as const } : {}),
  };
}

/** SAN as compared by the guard: annotations, check marks, `=` and castling zeros normalised. */
export function normalizeSan(san: string): string {
  const s = san.trim().replace(/[+#!?]+$/, '').replace(/=/g, '');
  if (s === '0-0-0') return 'O-O-O';
  if (s === '0-0') return 'O-O';
  return s;
}

// ───────────────────────── slot keys → words ─────────────────────────

const FORMS: ReadonlySet<string> = new Set(['nom', 'cap', 'ins']);

export function parseSlotKey(key: string): ParsedSlotKey | null {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts.length === 2) {
    const [kind, sq] = parts as [string, string];
    if ((kind === 'sq' || kind === 'xsq') && isSquare(sq)) return { kind: 'square', capture: kind === 'xsq', square: sq };
    return null;
  }
  if (parts.length !== 3) return null;
  const [a, b, c] = parts as [string, string, string];
  if (a === 'head') return (b === 'nom' || b === 'ins') && PIECE_SET.has(c) ? { kind: 'head', form: b, piece: c as PieceType } : null;
  if (!FORMS.has(a)) return null;
  if (b === 'castle') return (a === 'nom' || a === 'ins') && (c === 'short' || c === 'long') ? { kind: 'castle', form: a, side: c } : null;
  return PIECE_SET.has(b) && isSquare(c) ? { kind: 'move', form: a as SlotForm, piece: b as PieceType, square: c } : null;
}

/**
 * What a slot unit says, word for word — the recording script and the ASR check use it. Equals `sanToSpokenRu(san)`
 * ('nom' / 'cap') and `moveInsRu(san)` ('ins') for the same move without disambiguation, promotion and check.
 * '' for anything that is not a slot key.
 */
export function canonicalSlotText(key: string): string {
  const p = parseSlotKey(key);
  if (!p) return '';
  switch (p.kind) {
    case 'move': {
      const sq = squareToSpokenRu(p.square);
      if (p.form === 'ins') return `${pieceNameRu(p.piece, 'ins')} на ${sq}`;
      return p.form === 'cap' ? `${pieceNameRu(p.piece, 'nom')} бьёт на ${sq}` : `${pieceNameRu(p.piece, 'nom')} на ${sq}`;
    }
    case 'castle':
      if (p.form === 'ins') return p.side === 'short' ? 'короткой рокировкой' : 'длинной рокировкой';
      return p.side === 'short' ? 'короткая рокировка' : 'длинная рокировка';
    case 'square':
      return `${p.capture ? 'бьёт на' : 'на'} ${squareToSpokenRu(p.square)}`;
    case 'head':
      return pieceNameRu(p.piece, p.form);
  }
}

/**
 * The split form of a whole move unit (ladder L2): «конём» · «— на эф шесть», «конь» · «— бьёт на дэ пять».
 * null for castling (no split form: a castling line is whole or falls further down the ladder).
 */
export function splitOf(key: MoveSlotKey): readonly [SplitSlotKey, SplitSlotKey] | null {
  const p = parseSlotKey(key);
  if (!p || p.kind !== 'move') return null;
  const head: SplitSlotKey = `head:${p.form === 'ins' ? 'ins' : 'nom'}:${p.piece}`;
  return [head, p.form === 'cap' ? `xsq:${p.square}` : `sq:${p.square}`];
}

const FILES = 'abcdefgh';
const RANKS = '12345678';

function allSquares(): Square[] {
  const out: Square[] = [];
  for (const f of FILES) for (const r of RANKS) out.push(`${f}${r}`);
  return out;
}

/**
 * Every whole move unit that can occur: 'nom' / 'cap' for each piece on each square (a pawn on the last rank is the
 * base of a promotion), 'ins' for non-captures (pawns on ranks 2–7, as `moveInsRu` refuses promotions), castling.
 */
export function allMoveSlotKeys(): MoveSlotKey[] {
  const out: MoveSlotKey[] = [];
  const squares = allSquares();
  for (const form of ['nom', 'cap', 'ins'] as const) {
    for (const p of CLIP_PIECES) {
      for (const sq of squares) {
        if (form === 'ins' && p === 'p' && (sq[1] === '1' || sq[1] === '8')) continue;
        out.push(`${form}:${p}:${sq}`);
      }
    }
  }
  out.push('nom:castle:short', 'nom:castle:long', 'ins:castle:short', 'ins:castle:long');
  return out;
}

/** The split set (SPEC §4.3 family 1): 64 «на X», 64 «бьёт на X», 6 ins heads, 6 nom heads = 140 units. */
export function allSplitSlotKeys(): SplitSlotKey[] {
  const out: SplitSlotKey[] = [];
  for (const sq of allSquares()) out.push(`sq:${sq}`);
  for (const sq of allSquares()) out.push(`xsq:${sq}`);
  for (const form of ['ins', 'nom'] as const) for (const p of CLIP_PIECES) out.push(`head:${form}:${p}`);
  return out;
}

/** The spoken file / rank words (for the text compiler's square finder). */
export const SPOKEN_FILES: readonly string[] = [...FILES].map((f) => FILE_SPOKEN[f] as string);
export const SPOKEN_RANKS: readonly string[] = [...RANKS].map((r) => RANK_SPOKEN[r] as string);

/** «эф шесть» → 'f6' (after ё/case normalisation); null for anything else. */
export function squareFromSpoken(file: string, rank: string): Square | null {
  const f = SPOKEN_FILES.indexOf(file.toLowerCase());
  const r = SPOKEN_RANKS.indexOf(rank.toLowerCase());
  return f >= 0 && r >= 0 ? `${FILES[f]}${RANKS[r]}` : null;
}

// ───────────────────────── unit and pool keys of the manifest ─────────────────────────

export function slotUnitKey(key: SlotKey): string {
  return `slot:${key}`;
}

/** The pool of one line variant: 'reason.attack', 'reason.attack@n', 'ask.find/f', 'praise.x@q/f'. */
export function poolKeyOf(line: string, piece?: PieceType, g?: 'm' | 'f'): string {
  return `${line}${piece ? `@${piece}` : ''}${g ? `/${g}` : ''}`;
}

/** The unit key of wording `n` (1-based) of a pool: 'line:teach.head.advice#1', 'line:reason.attack@n#2'. */
export function lineUnitKey(pool: string, wording: number): string {
  return `line:${pool}#${wording}`;
}

/**
 * The match form of a fragment (SPEC §3.4 route 2): NFC, lower case, ё → е, stress marks and quotes dropped, spaces
 * collapsed, the seam / sentence punctuation at its edges cut off (it goes into the key's `|end`). Commas and hyphens
 * inside words («Так-так», «И-го-го») stay.
 */
export function normalizeFragment(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/́/g, '')
    .replace(/ё/g, 'е')
    .replace(/[«»"„“”]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/^(?:[\s—–:;.!?…]|-\s)+/u, '')
    .replace(/[\s—–:;.!?…,-]+$/u, '')
    .trim();
}

/** A run of sentence / seam punctuation → the fragment end it stands for. */
export function fragEndOf(punct: string): FragEnd {
  const p = punct.trim();
  if (p === '') return '';
  if (p.includes('?')) return '?';
  if (p.includes('…') || p.includes('...')) return '…';
  if (p.includes('!')) return '!';
  if (p.includes('.')) return '.';
  if (p.includes(':')) return ':';
  if (p.includes(';')) return ';';
  return '—';
}

/** `f:<norm>|<end>` — the exact-match key of a compiled fragment. */
export function fragKey(text: string, end: FragEnd): string {
  return `f:${normalizeFragment(text)}|${end}`;
}

export function fragUnitKey(key: string): string {
  return `frag:${key}`;
}

// ───────────────────────── building an index (tools, tests, overlays) ─────────────────────────

export interface ClipIndexEntry extends ClipUnitMeta {
  id: string;
  /** the unit key it was recorded for (also stored as `meta.key`) */
  key: string;
  /** the line pools it belongs to (`CatalogUnit.pools`), if any */
  pools?: readonly string[];
  /** more unit keys that resolve to this take (a catalogue tail registered as a compiled fragment too) */
  alsoKeys?: readonly string[];
}

/** A manifest body from unit entries: `units`, `pools`, `keys` (deduplicated, in entry order). */
export function buildClipIndex(entries: readonly ClipIndexEntry[], fallbacks: Record<string, string> = {}): ClipIndex {
  const index: ClipIndex = { units: {}, pools: {}, keys: {}, fallbacks: { ...fallbacks } };
  const add = (map: Record<string, string[]>, k: string, id: string): void => {
    const list = map[k] ?? (map[k] = []);
    if (!list.includes(id)) list.push(id);
  };
  for (const e of entries) {
    const { id, pools, alsoKeys, ...meta } = e;
    index.units[id] = meta;
    add(index.keys, e.key, id);
    for (const k of alsoKeys ?? []) add(index.keys, k, id);
    for (const p of pools ?? []) add(index.pools, p, id);
  }
  return index;
}

// ───────────────────────── «Дозапись голоса»: the static library + the recorded overlay ─────────────────────────

/** The quiz options sentence of stages 1–2 («Ладью, коня или слона?») as a unit key: `frag:f:ладью, коня или слона|?`. */
export function lessonQuizKey(text: string): string {
  return fragUnitKey(fragKey(text, '?'));
}

/**
 * A unit text as the text index compares it: NFC, spaces collapsed, trimmed — nothing else (case, ё, quotes and
 * punctuation stay), so a take found by text is exactly the words the bubble shows.
 */
export function normUnitText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * The text-index key of a `line:` unit: its pool variant (the key without `#n`) and its normalised text —
 * `line:v3.lead.subject@p|Давай пойдём пешкой`. null for any other unit kind (frag / slot keys already are text).
 */
export function unitTextKey(unitKey: string, text: string): string | null {
  const m = /^line:(.+)#\d+$/.exec(unitKey);
  return m ? `line:${m[1]}|${normUnitText(text)}` : null;
}

/**
 * The takes that say exactly `text` for a unit: by its exact key first (a take recorded for another text — a shifted
 * wording number — is stale and skipped), then, in a merged index, by the text index. The caller still filters
 * availability and `ctx` ('cont' only before a tail). [] = no recording.
 */
export function takesForUnit(index: ClipIndex | MergedClipIndex, unitKey: string, text: string): string[] {
  const want = normUnitText(text);
  const same = (id: string): boolean => {
    const meta = Object.hasOwn(index.units, id) ? index.units[id] : undefined;
    return meta !== undefined && normUnitText(meta.text) === want;
  };
  const exact = (Object.hasOwn(index.keys, unitKey) ? (index.keys[unitKey] ?? []) : []).filter(same);
  if (exact.length > 0 || !('textIndex' in index)) return exact;
  const tk = unitTextKey(unitKey, text);
  return tk !== null && Object.hasOwn(index.textIndex, tk) ? (index.textIndex[tk] ?? []).filter(same) : [];
}

/** A manifest (or index) as `mergeClipIndexes` reads it: the four planner fields, plus the voice and the blocked keys. */
export type ClipIndexLayer = ClipIndex & { voiceKey?: string; blocked?: readonly string[] | ReadonlySet<string> };

/**
 * The static library merged with the recorded overlay. Always NEW `units` / `keys` / `pools` / `fallbacks` /
 * `textIndex` / `blocked` objects (the planner caches by object identity), never mutating either input; ids and keys
 * are concatenated without duplicates, the base's unit meta wins on an id collision (the take base 101 keeps overlay ids
 * apart anyway). An overlay of another voice (`voiceKey` differs) is ignored — one sentence never mixes two voices.
 */
export function mergeClipIndexes(base: ClipIndexLayer | null | undefined, overlay: ClipIndexLayer | null | undefined): MergedClipIndex {
  const units: Record<string, ClipUnitMeta> = {};
  const keys: Record<string, string[]> = {};
  const pools: Record<string, string[]> = {};
  const fallbacks: Record<string, string> = {};
  const textIndex: Record<string, string[]> = {};
  const blocked = new Set<string>();
  const add = (map: Record<string, string[]>, k: string, id: string): void => {
    const list = Object.hasOwn(map, k) ? (map[k] as string[]) : (map[k] = []);
    if (!list.includes(id)) list.push(id);
  };
  const sameVoice = !base?.voiceKey || !overlay?.voiceKey || base.voiceKey === overlay.voiceKey;
  const layers = [base, sameVoice ? overlay : null].filter((l): l is ClipIndexLayer => l !== null && l !== undefined);
  for (const layer of layers) {
    for (const [id, meta] of Object.entries(layer.units)) if (!Object.hasOwn(units, id)) units[id] = meta;
    for (const [k, ids] of Object.entries(layer.keys)) for (const id of ids) add(keys, k, id);
    for (const [k, ids] of Object.entries(layer.pools)) for (const id of ids) add(pools, k, id);
    for (const [k, v] of Object.entries(layer.fallbacks ?? {})) if (!Object.hasOwn(fallbacks, k)) fallbacks[k] = v;
    for (const k of layer.blocked ?? []) blocked.add(k);
  }
  for (const [k, ids] of Object.entries(keys)) {
    for (const id of ids) {
      const meta = units[id];
      const tk = meta ? unitTextKey(k, meta.text) : null;
      if (tk !== null) add(textIndex, tk, id);
    }
  }
  return { units, keys, pools, fallbacks, textIndex, blocked };
}
