/**
 * «А если я пойду конём на эф три?» — finds the move a child names in a (Russian, speech-to-text) sentence, or the move
 * argument a voice model passes to `evaluate_move`, and turns it into something `CoachToolHost.evaluateMove` accepts:
 *
 *   SAN without the capture sign   'Nf3', 'Bc4', 'e4', 'exd5', 'O-O', 'O-O-O'   (chess.js accepts a piece move without
 *                                                                                  «x» for a capture, but refuses a
 *                                                                                  spurious «x» — so it is dropped)
 *   UCI when two squares are named 'e2e4', 'g1f3'
 *
 * It never decides anything about chess: whether the move is legal, good or bad is the tool host's (engine's) job.
 * When the words are about a move but it is not clear WHICH one («а если конём?»), the result is 'partial' and the
 * model is asked to clarify instead of guessing. Pure functions, no DOM.
 */
import type { PieceType } from '@gambit/shared';

export type SpokenMove =
  /** a concrete move (SAN or UCI) */
  | { kind: 'move'; move: string }
  /** the child talks about a move, but which one is unclear — ask again, never guess */
  | { kind: 'partial' }
  | { kind: 'none' };

// ───────────────────────── vocabulary ─────────────────────────

/** files as they are spoken («эф», «жэ»), written in Latin, or typed with a look-alike Cyrillic letter (е, с, а) */
const FILE_WORDS: readonly [string, string][] = [
  ['эйч', 'h'],
  ['джи', 'g'],
  ['бэ', 'b'],
  ['бе', 'b'],
  ['би', 'b'],
  ['цэ', 'c'],
  ['це', 'c'],
  ['си', 'c'],
  ['дэ', 'd'],
  ['де', 'd'],
  ['ди', 'd'],
  ['эф', 'f'],
  ['еф', 'f'],
  ['жэ', 'g'],
  ['же', 'g'],
  ['гэ', 'g'],
  ['ге', 'g'],
  ['аш', 'h'],
  ['ха', 'h'],
  ['а', 'a'],
  ['a', 'a'],
  ['б', 'b'],
  ['b', 'b'],
  ['ц', 'c'],
  ['с', 'c'],
  ['c', 'c'],
  ['д', 'd'],
  ['d', 'd'],
  ['е', 'e'],
  ['э', 'e'],
  ['e', 'e'],
  ['ф', 'f'],
  ['f', 'f'],
  ['ж', 'g'],
  ['g', 'g'],
  ['х', 'h'],
  ['h', 'h'],
];

const RANK_WORDS: readonly [string, string][] = [
  ['четыре', '4'],
  ['восемь', '8'],
  ['шесть', '6'],
  ['один', '1'],
  ['одна', '1'],
  ['семь', '7'],
  ['пять', '5'],
  ['два', '2'],
  ['две', '2'],
  ['три', '3'],
  ['раз', '1'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
  ['4', '4'],
  ['5', '5'],
  ['6', '6'],
  ['7', '7'],
  ['8', '8'],
];

const LETTER = 'а-яa-z';
const alternatives = (pairs: readonly [string, string][]): string => pairs.map(([word]) => word).join('|');
const SQUARE_RE = new RegExp(`(?<![${LETTER}0-9])(${alternatives(FILE_WORDS)})\\s?(${alternatives(RANK_WORDS)})(?![${LETTER}0-9])`, 'g');

const FILE_OF = new Map(FILE_WORDS);
const RANK_OF = new Map(RANK_WORDS);

/** SAN letters of the pieces, found by the stem of any case form («конём», «ладью», «пешкой») */
const PIECE_RES: readonly [RegExp, string][] = [
  [/(?<![а-я])кон(?:ь|я|ём|ем|ю|е|и|ей|ями|ям)(?![а-я])/, 'N'],
  [/(?<![а-я])слон(?:а|ом|у|е|ы|ов|ами|ам)?(?![а-я])/, 'B'],
  [/(?<![а-я])лад(?:ья|ью|ьёй|ьей|ьи|ье|ей|ьям|ьями)(?![а-я])/, 'R'],
  [/(?<![а-я])ферз(?:ь|я|ём|ем|ю|е|и|ей)(?![а-я])/, 'Q'],
  [/(?<![а-я])корол(?:ь|я|ём|ем|ю|е|и|ей)(?![а-я])/, 'K'],
  [/(?<![а-я])пешк(?:а|у|ой|ою|и|е)(?![а-я])|(?<![а-я])пешечк/, 'P'],
];

/** words that turn a named square into a move («пойду», «если», «можно», «съем») */
export const MOVE_VERB_RE =
  /(?<![а-я])(если|можно|могу|пойд|пойт|схож|сход|походи|постав|сыгра|двин|съем|съесть|съест|возьм|взять|побь|бить|бьёт|бьет|прыгн|перейд|шагн|а так|а туда)/;

const CASTLE_LONG_RE = /длинн\S*\s+рокировк|рокировк\S*\s+в\s+длинную|(?<![a-z0-9])(o-o-o|0-0-0)(?![a-z0-9])/;
const CASTLE_RE = /рокировк|(?<![a-z0-9])(o-o|0-0)(?![a-z0-9])/;

// ───────────────────────── notation typed by a model ─────────────────────────

const UCI_RE = /(?<![A-Za-z0-9])([a-h][1-8])\s?[-x:]?\s?([a-h][1-8])([qrbnQRBN])?(?![A-Za-z0-9])/;
const PIECE_SAN_RE = /(?<![A-Za-z0-9])([KQRBN])([a-h])?([1-8])?[x:]?([a-h][1-8])(?:=?([QRBN]))?[+#!?]*(?![A-Za-z0-9])/;
const PAWN_CAPTURE_SAN_RE = /(?<![A-Za-z0-9])([a-h])[x:]([a-h][1-8])(?:=?([QRBN]))?[+#!?]*(?![A-Za-z0-9])/;
const PAWN_SAN_RE = /^([a-h][1-8])(?:=?([QRBN]))?[+#!?]*$/;
/** the bubble's Russian piece letters (Кр Ф Л С К) followed by a Latin square: «Кf3» */
const RU_SAN_RE = /(?<![А-Яа-яA-Za-z])(Кр|К|Ф|Л|С)([a-h])?([1-8])?[x:]?([a-h][1-8])/;
const RU_SAN_LETTER: Record<string, string> = { Кр: 'K', К: 'N', Ф: 'Q', Л: 'R', С: 'B' };

function fromNotation(raw: string): string | null {
  const text = raw.trim();
  if (/^(O-O-O|0-0-0)[+#]?$/i.test(text)) return 'O-O-O';
  if (/^(O-O|0-0)[+#]?$/i.test(text)) return 'O-O';
  const uci = UCI_RE.exec(text);
  if (uci?.[1] && uci[2] && uci[1] !== uci[2]) return `${uci[1]}${uci[2]}${(uci[3] ?? '').toLowerCase()}`;
  const piece = PIECE_SAN_RE.exec(text);
  if (piece?.[1] && piece[4]) return `${piece[1]}${piece[2] ?? ''}${piece[3] ?? ''}${piece[4]}${piece[5] ? `=${piece[5]}` : ''}`;
  const ru = RU_SAN_RE.exec(text);
  if (ru?.[1] && ru[4]) return `${RU_SAN_LETTER[ru[1]] ?? 'N'}${ru[2] ?? ''}${ru[3] ?? ''}${ru[4]}`;
  const capture = PAWN_CAPTURE_SAN_RE.exec(text);
  if (capture?.[1] && capture[2]) return `${capture[1]}x${capture[2]}${capture[3] ? `=${capture[3]}` : ''}`;
  const pawn = PAWN_SAN_RE.exec(text);
  if (pawn?.[1]) return `${pawn[1]}${pawn[2] ? `=${pawn[2]}` : ''}`;
  return null;
}

// ───────────────────────── spoken Russian ─────────────────────────

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[-–—‑]/g, ' ')
    .replace(/[«»"“”„,.!?;:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface FoundSquare {
  square: string;
  index: number;
}

function findSquares(text: string): FoundSquare[] {
  const found: FoundSquare[] = [];
  for (const match of text.matchAll(SQUARE_RE)) {
    const file = FILE_OF.get(match[1] ?? '');
    const rank = RANK_OF.get(match[2] ?? '');
    if (file && rank) found.push({ square: `${file}${rank}`, index: match.index });
  }
  return found;
}

function findPiece(text: string, before: number): string | null {
  let best: { letter: string; index: number } | null = null;
  for (const [re, letter] of PIECE_RES) {
    const match = re.exec(text);
    if (!match) continue;
    // the moving piece is named before the square («конём на эф три»); prefer the one closest to it
    const index = match.index;
    const score = index <= before ? before - index : 10_000 + index;
    if (best === null || score < (best.index <= before ? before - best.index : 10_000 + best.index)) best = { letter, index };
  }
  return best?.letter ?? null;
}

/** Finds the move named in a child's sentence (or in notation typed by a model). */
export function parseSpokenMove(text: string): SpokenMove {
  // a model (or a transcript) may already carry notation: take it as it is
  for (const token of text.split(/[\s,;]+/)) {
    if (/^(O-O-O|0-0-0|O-O|0-0)[+#]?$/i.test(token) || /[a-h][1-8]/.test(token)) {
      const move = /^[a-h][1-8]$/.test(token) ? null : fromNotation(token.replace(/[.!?]+$/, ''));
      if (move) return { kind: 'move', move };
    }
  }
  const t = normalize(text);
  if (t === '') return { kind: 'none' };
  if (CASTLE_LONG_RE.test(t)) return { kind: 'move', move: 'O-O-O' };
  if (CASTLE_RE.test(t)) return { kind: 'move', move: 'O-O' };

  const squares = findSquares(t);
  const [first, second] = squares;
  if (first && second && first.square !== second.square) return { kind: 'move', move: `${first.square}${second.square}` };
  if (first) {
    const piece = findPiece(t, first.index);
    if (piece === 'P') return { kind: 'move', move: first.square };
    if (piece) return { kind: 'move', move: `${piece}${first.square}` };
    // «а если на эф три?» — somebody goes there, but who?
    if (/(?:^|\s)на\s$/.test(t.slice(0, first.index))) return { kind: 'partial' };
    // a bare square is a pawn move, as in chess notation («е четыре»)
    return { kind: 'move', move: first.square };
  }
  if (findPiece(t, t.length) !== null && MOVE_VERB_RE.test(t)) return { kind: 'partial' };
  return { kind: 'none' };
}

const PIECE_TYPE_OF: Readonly<Record<string, PieceType>> = { P: 'p', N: 'n', B: 'b', R: 'r', Q: 'q', K: 'k' };

/**
 * The piece a child names in any case form («а почему не ферзём?» → 'q'), or null. With several pieces the one named
 * FIRST wins («почему не конём, а слоном» → 'n'). Also accepts a bare piece letter (p n b r q k) as a model may send it.
 */
export function parsePieceWord(text: string): PieceType | null {
  const raw = text.trim();
  if (/^[pnbrqkPNBRQK]$/.test(raw)) return PIECE_TYPE_OF[raw.toUpperCase()] ?? null;
  const t = normalize(raw);
  let best: { letter: string; index: number } | null = null;
  for (const [re, letter] of PIECE_RES) {
    const match = re.exec(t);
    if (match && (best === null || match.index < best.index)) best = { letter, index: match.index };
  }
  return best ? (PIECE_TYPE_OF[best.letter] ?? null) : null;
}

/**
 * The `move` argument of the realtime `evaluate_move` tool: SAN / UCI as the model typed it (a spurious capture sign
 * of a piece move is dropped), or Russian words. null = it is not clear which move is meant.
 */
export function normalizeMoveArgument(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const notation = fromNotation(raw.trim());
  if (notation) return notation;
  const parsed = parseSpokenMove(raw);
  return parsed.kind === 'move' ? parsed.move : null;
}
