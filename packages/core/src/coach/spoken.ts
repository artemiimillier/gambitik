/**
 * Russian chess language: SAN → speech ("конь на эф три") and SAN → Russian bubble notation ("Кf3").
 *
 * `text` of every CoachEvent is fed verbatim to a TTS voice, so it must never contain Latin
 * notation. Everything that turns a move or a square into words lives here.
 */
import { Chess } from 'chess.js';
import type { PieceType, Square } from '@gambit/shared';

export type GrammaticalCase = 'nom' | 'acc' | 'gen' | 'ins';

/** How chess players pronounce file letters in Russian (exported for the clip keys: coach/clips/keys.ts). */
export const FILE_SPOKEN: Readonly<Record<string, string>> = {
  a: 'а',
  b: 'бэ',
  c: 'цэ',
  d: 'дэ',
  e: 'е',
  f: 'эф',
  g: 'же',
  h: 'аш',
};

export const RANK_SPOKEN: Readonly<Record<string, string>> = {
  '1': 'один',
  '2': 'два',
  '3': 'три',
  '4': 'четыре',
  '5': 'пять',
  '6': 'шесть',
  '7': 'семь',
  '8': 'восемь',
};

/** "с первого ряда" — used only when SAN disambiguates by rank and no FEN is available. */
const RANK_ORDINAL_GEN: Readonly<Record<string, string>> = {
  '1': 'первого',
  '2': 'второго',
  '3': 'третьего',
  '4': 'четвёртого',
  '5': 'пятого',
  '6': 'шестого',
  '7': 'седьмого',
  '8': 'восьмого',
};

const PIECE_NAMES: Readonly<Record<PieceType, Readonly<Record<GrammaticalCase, string>>>> = {
  p: { nom: 'пешка', acc: 'пешку', gen: 'пешки', ins: 'пешкой' },
  n: { nom: 'конь', acc: 'коня', gen: 'коня', ins: 'конём' },
  b: { nom: 'слон', acc: 'слона', gen: 'слона', ins: 'слоном' },
  r: { nom: 'ладья', acc: 'ладью', gen: 'ладьи', ins: 'ладьёй' },
  q: { nom: 'ферзь', acc: 'ферзя', gen: 'ферзя', ins: 'ферзём' },
  k: { nom: 'король', acc: 'короля', gen: 'короля', ins: 'королём' },
};

/** Russian notation letters: Кр Ф Л С К (pawn has none). */
const PIECE_LETTER_RU: Readonly<Record<string, string>> = {
  K: 'Кр',
  Q: 'Ф',
  R: 'Л',
  B: 'С',
  N: 'К',
};

const SAN_LETTER_TO_PIECE: Readonly<Record<string, PieceType>> = {
  K: 'k',
  Q: 'q',
  R: 'r',
  B: 'b',
  N: 'n',
};

/** Spoken fallback when a string is not a recognisable SAN move (never leaks Latin into speech). */
const UNKNOWN_MOVE_SPOKEN = 'этот ход';

//                     piece     from-file from-rank  x    target        promotion        check   glyphs
const SAN_RE = /^([KQRBN])?([a-h])?([1-8])?(x|:)?([a-h][1-8])(?:=?([QRBN]))?\s*([+#])?[!?]*$/;
const CASTLE_RE = /^(O-O-O|0-0-0|O-O|0-0)\s*([+#])?[!?]*$/;

export interface ParsedSan {
  kind: 'castleShort' | 'castleLong' | 'move';
  piece: PieceType;
  fromFile?: string;
  fromRank?: string;
  capture: boolean;
  /** target square; for castling it is undefined */
  to?: Square;
  promotion?: PieceType;
  suffix?: '+' | '#';
}

/** Parses a SAN string. Returns null when the string is not SAN. */
export function parseSan(san: string): ParsedSan | null {
  const trimmed = san.trim();
  const castle = CASTLE_RE.exec(trimmed);
  if (castle) {
    const long = castle[1] === 'O-O-O' || castle[1] === '0-0-0';
    return {
      kind: long ? 'castleLong' : 'castleShort',
      piece: 'k',
      capture: false,
      suffix: toSuffix(castle[2]),
    };
  }
  const m = SAN_RE.exec(trimmed);
  if (!m) return null;
  const [, pieceLetter, fromFile, fromRank, capture, to, promo, suffix] = m;
  const piece: PieceType = pieceLetter ? (SAN_LETTER_TO_PIECE[pieceLetter] ?? 'p') : 'p';
  // A promotion is only legal for pawns; "Nf8=Q" is not SAN.
  if (promo && piece !== 'p') return null;
  return {
    kind: 'move',
    piece,
    fromFile: fromFile || undefined,
    fromRank: fromRank || undefined,
    capture: Boolean(capture),
    to,
    promotion: promo ? SAN_LETTER_TO_PIECE[promo] : undefined,
    suffix: toSuffix(suffix),
  };
}

function toSuffix(s: string | undefined): '+' | '#' | undefined {
  return s === '+' || s === '#' ? s : undefined;
}

/** 'f3' → 'эф три'. Returns an empty string for anything that is not a square. */
export function squareToSpokenRu(sq: Square): string {
  if (typeof sq !== 'string' || sq.length !== 2) return '';
  const file = FILE_SPOKEN[sq[0]!.toLowerCase()];
  const rank = RANK_SPOKEN[sq[1]!];
  return file && rank ? `${file} ${rank}` : '';
}

/** 'n','acc' → 'коня'. */
export function pieceNameRu(p: PieceType, grammaticalCase: GrammaticalCase): string {
  return PIECE_NAMES[p][grammaticalCase];
}

/** Grammatical gender of the Russian piece name (пешка, ладья are feminine). */
export function pieceGenderRu(p: PieceType): 'm' | 'f' {
  return p === 'p' || p === 'r' ? 'f' : 'm';
}

/** Resolves the origin square of a SAN move in a position; undefined when illegal / unparsable. */
function resolveFromSquare(san: string, fenBefore: string): Square | undefined {
  try {
    const chess = new Chess(fenBefore);
    const move = chess.move(san.replace(/[!?]+$/, ''));
    return move.from;
  } catch {
    return undefined;
  }
}

/**
 * SAN → words for TTS.
 *  'Nf3' → 'конь на эф три'; 'exd5' → 'пешка бьёт на дэ пять'; 'O-O' → 'короткая рокировка';
 *  'Rad1' → 'ладья с линии а на дэ один' (or 'ладья с а один на дэ один' when `fenBefore` is given
 *  or the SAN carries the full origin square); 'e8=Q' → 'пешка на е восемь превращается в ферзя';
 *  '+' → ', шах'; '#' → ', мат'.
 *
 * `fenBefore` is optional: it is only used to turn a partial disambiguation into a full square.
 * The result never contains Latin letters; an unparsable input yields 'этот ход'.
 */
export function sanToSpokenRu(san: string, fenBefore?: string): string {
  const parsed = parseSan(san);
  if (!parsed) return UNKNOWN_MOVE_SPOKEN;
  const suffix = parsed.suffix === '#' ? ', мат' : parsed.suffix === '+' ? ', шах' : '';
  if (parsed.kind === 'castleShort') return `короткая рокировка${suffix}`;
  if (parsed.kind === 'castleLong') return `длинная рокировка${suffix}`;

  const to = squareToSpokenRu(parsed.to ?? '');
  const words: string[] = [pieceNameRu(parsed.piece, 'nom')];

  // Pawn captures ('exd5') carry the origin file by SAN rules — that is not a disambiguation.
  if (parsed.piece !== 'p' && (parsed.fromFile || parsed.fromRank)) {
    words.push(spokenOrigin(parsed, san, fenBefore));
  }
  words.push(parsed.capture ? `бьёт на ${to}` : `на ${to}`);

  let phrase = words.join(' ');
  if (parsed.promotion) {
    const into = pieceNameRu(parsed.promotion, 'acc');
    phrase += parsed.capture ? ` и превращается в ${into}` : ` превращается в ${into}`;
  }
  return phrase + suffix;
}

function spokenOrigin(parsed: ParsedSan, san: string, fenBefore: string | undefined): string {
  if (parsed.fromFile && parsed.fromRank) {
    return `с ${squareToSpokenRu(parsed.fromFile + parsed.fromRank)}`;
  }
  if (typeof fenBefore === 'string' && fenBefore.length > 0) {
    const from = resolveFromSquare(san, fenBefore);
    const spoken = from ? squareToSpokenRu(from) : '';
    if (spoken) return `с ${spoken}`;
  }
  if (parsed.fromFile) return `с линии ${FILE_SPOKEN[parsed.fromFile]}`;
  return `с ${RANK_ORDINAL_GEN[parsed.fromRank ?? '1']} ряда`;
}

/**
 * SAN → Russian notation for the speech bubble: 'Nf3' → 'Кf3', 'Qxh7#' → 'Фxh7#',
 * 'e8=Q' → 'e8=Ф', 'O-O' → '0-0'. Only piece letters change; squares stay algebraic.
 * An unparsable input is returned unchanged.
 */
export function sanToBubbleRu(san: string): string {
  const trimmed = san.trim();
  const castle = CASTLE_RE.exec(trimmed);
  if (castle) {
    const long = castle[1] === 'O-O-O' || castle[1] === '0-0-0';
    return (long ? '0-0-0' : '0-0') + trimmed.slice(castle[1]!.length);
  }
  if (!SAN_RE.test(trimmed)) return san;
  return trimmed
    .replace(/^[KQRBN]/, (l) => PIECE_LETTER_RU[l] ?? l)
    .replace(/(=?)([QRBN])(?=\s*[+#]?[!?]*$)/, (_all, eq: string, l: string) => `${eq}${PIECE_LETTER_RU[l] ?? l}`);
}

/** A whole SAN line → 'Кf3 Фxh4+ …' for bubbles and markdown. */
export function sanLineToBubbleRu(sans: readonly string[]): string {
  return sans.map(sanToBubbleRu).join(' ');
}
