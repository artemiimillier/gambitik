/**
 * Internal board geometry for the analysis module: a plain 64-square array derived from a
 * FEN / chess.js position, attack generation, absolute pins and static exchange evaluation.
 *
 * chess.js stays the only rules library (legality, SAN, FEN); this file only adds the static
 * geometry chess.js does not expose (x-rays, pins, SEE). Not re-exported from index.ts on
 * purpose (generic names would collide with the coach module's helpers).
 *
 * Square index: `rank * 8 + file`, a1 = 0, h1 = 7, a8 = 56, h8 = 63.
 */
import type { Color, PieceType, Square } from '@gambit/shared';

export interface BoardPiece {
  type: PieceType;
  color: Color;
}

export type Board = (BoardPiece | null)[];

export type Direction = readonly [df: number, dr: number];

/** Material values in pawns, as used by the contracts (king = 0). */
export const VALUE_PAWNS: Readonly<Record<PieceType, number>> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Exchange values in centipawns; the king is "priceless" so it is always the last attacker. */
export const VALUE_CP: Readonly<Record<PieceType, number>> = { p: 100, n: 300, b: 300, r: 500, q: 900, k: 20000 };

export const ROOK_DIRS: readonly Direction[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
export const BISHOP_DIRS: readonly Direction[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
export const ALL_DIRS: readonly Direction[] = [...ROOK_DIRS, ...BISHOP_DIRS];
const KNIGHT_JUMPS: readonly Direction[] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

const FILES = 'abcdefgh';

export function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

export function fileOf(idx: number): number {
  return idx & 7;
}

export function rankOf(idx: number): number {
  return idx >> 3;
}

export function toIndex(file: number, rank: number): number {
  return rank * 8 + file;
}

export function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

export function squareName(idx: number): Square {
  return `${FILES[fileOf(idx)]}${rankOf(idx) + 1}`;
}

/** Returns -1 for anything that is not a valid algebraic square. */
export function squareIndex(square: string): number {
  if (square.length !== 2) return -1;
  const file = FILES.indexOf(square.charAt(0));
  const rank = square.charCodeAt(1) - 49;
  return file >= 0 && rank >= 0 && rank < 8 ? toIndex(file, rank) : -1;
}

/** Parses the piece-placement field of a FEN. Throws on a malformed placement. */
export function parsePlacement(fen: string): Board {
  const placement = fen.trim().split(/\s+/)[0] ?? '';
  const rows = placement.split('/');
  if (rows.length !== 8) throw new Error(`Invalid FEN placement: "${fen}"`);
  const board: Board = new Array<BoardPiece | null>(64).fill(null);
  rows.forEach((row, r) => {
    const rank = 7 - r;
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const lower = ch.toLowerCase();
      if (!'pnbrqk'.includes(lower) || file > 7) throw new Error(`Invalid FEN placement: "${fen}"`);
      board[toIndex(file, rank)] = { type: lower as PieceType, color: ch === lower ? 'b' : 'w' };
      file += 1;
    }
    if (file !== 8) throw new Error(`Invalid FEN placement: "${fen}"`);
  });
  return board;
}

export function findKing(board: Board, color: Color): number {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.type === 'k' && p.color === color) return i;
  }
  return -1;
}

function slides(type: PieceType, dir: Direction): boolean {
  if (type === 'q') return true;
  const diagonal = dir[0] !== 0 && dir[1] !== 0;
  return diagonal ? type === 'b' : type === 'r';
}

/** First occupied square from `from` (exclusive) along `dir`, or -1. */
export function firstPieceAlong(board: Board, from: number, dir: Direction): number {
  let f = fileOf(from) + dir[0];
  let r = rankOf(from) + dir[1];
  while (onBoard(f, r)) {
    const idx = toIndex(f, r);
    if (board[idx]) return idx;
    f += dir[0];
    r += dir[1];
  }
  return -1;
}

/** Unit direction from `a` to `b` when they share a rank, file or diagonal; otherwise null. */
export function directionBetween(a: number, b: number): Direction | null {
  if (a === b) return null;
  const df = fileOf(b) - fileOf(a);
  const dr = rankOf(b) - rankOf(a);
  if (df !== 0 && dr !== 0 && Math.abs(df) !== Math.abs(dr)) return null;
  return [Math.sign(df), Math.sign(dr)];
}

/** True when `mid` lies strictly between `a` and `b` on a common line. */
export function isBetween(a: number, mid: number, b: number): boolean {
  const dir = directionBetween(a, b);
  if (!dir) return false;
  let f = fileOf(a) + dir[0];
  let r = rankOf(a) + dir[1];
  while (onBoard(f, r)) {
    const idx = toIndex(f, r);
    if (idx === b) return false;
    if (idx === mid) return true;
    f += dir[0];
    r += dir[1];
  }
  return false;
}

/** Squares attacked by the piece standing on `from` (sliders stop at, and include, the first blocker). */
export function attacksFrom(board: Board, from: number): number[] {
  const piece = board[from];
  if (!piece) return [];
  const out: number[] = [];
  const f0 = fileOf(from);
  const r0 = rankOf(from);
  const jump = (jumps: readonly Direction[]): void => {
    for (const [df, dr] of jumps) if (onBoard(f0 + df, r0 + dr)) out.push(toIndex(f0 + df, r0 + dr));
  };
  switch (piece.type) {
    case 'p': {
      const dr = piece.color === 'w' ? 1 : -1;
      jump([
        [-1, dr],
        [1, dr],
      ]);
      break;
    }
    case 'n':
      jump(KNIGHT_JUMPS);
      break;
    case 'k':
      jump(ALL_DIRS);
      break;
    default:
      for (const dir of ALL_DIRS) {
        if (!slides(piece.type, dir)) continue;
        let f = f0 + dir[0];
        let r = r0 + dir[1];
        while (onBoard(f, r)) {
          const idx = toIndex(f, r);
          out.push(idx);
          if (board[idx]) break;
          f += dir[0];
          r += dir[1];
        }
      }
  }
  return out;
}

/** All pieces of `by` that attack `target` (pseudo-legal: pins and king safety are ignored). */
export function attackersOf(board: Board, target: number, by: Color): number[] {
  const out: number[] = [];
  const f0 = fileOf(target);
  const r0 = rankOf(target);
  const check = (f: number, r: number, type: PieceType): void => {
    if (!onBoard(f, r)) return;
    const p = board[toIndex(f, r)];
    if (p && p.color === by && p.type === type) out.push(toIndex(f, r));
  };
  // A white pawn attacks "upwards", so it stands one rank below the target.
  const pawnRank = by === 'w' ? r0 - 1 : r0 + 1;
  check(f0 - 1, pawnRank, 'p');
  check(f0 + 1, pawnRank, 'p');
  for (const [df, dr] of KNIGHT_JUMPS) check(f0 + df, r0 + dr, 'n');
  for (const [df, dr] of ALL_DIRS) check(f0 + df, r0 + dr, 'k');
  for (const dir of ALL_DIRS) {
    const idx = firstPieceAlong(board, target, dir);
    if (idx < 0) continue;
    const p = board[idx] as BoardPiece;
    if (p.color === by && p.type !== 'k' && p.type !== 'p' && p.type !== 'n' && slides(p.type, dir)) out.push(idx);
  }
  return out;
}

export interface AbsolutePin {
  pinned: number;
  pinner: number;
  king: number;
}

/** Pieces of `color` that are pinned against their own king. */
export function absolutePins(board: Board, color: Color): AbsolutePin[] {
  const king = findKing(board, color);
  if (king < 0) return [];
  const pins: AbsolutePin[] = [];
  for (const dir of ALL_DIRS) {
    const first = firstPieceAlong(board, king, dir);
    if (first < 0 || (board[first] as BoardPiece).color !== color) continue;
    const second = firstPieceAlong(board, first, dir);
    if (second < 0) continue;
    const p = board[second] as BoardPiece;
    if (p.color !== color && p.type !== 'k' && p.type !== 'p' && p.type !== 'n' && slides(p.type, dir)) {
      pins.push({ pinned: first, pinner: second, king });
    }
  }
  return pins;
}

function collinear(a: number, b: number, c: number): boolean {
  return (fileOf(b) - fileOf(a)) * (rankOf(c) - rankOf(a)) === (rankOf(b) - rankOf(a)) * (fileOf(c) - fileOf(a));
}

/**
 * Pieces of `by` that could really capture on `target`: attackers minus absolutely pinned pieces
 * that would have to leave their pin line, and minus the king when the square stays covered.
 */
export function captureCandidates(board: Board, target: number, by: Color): number[] {
  const raw = attackersOf(board, target, by);
  if (raw.length === 0) return raw;
  const pins = absolutePins(board, by);
  return raw.filter((from) => {
    const piece = board[from] as BoardPiece;
    if (piece.type === 'k') return !kingCaptureIsCovered(board, from, target);
    const pin = pins.find((p) => p.pinned === from);
    return !pin || collinear(pin.king, from, target);
  });
}

/**
 * Pieces of the square's own side that protect it: direct attackers of `target` by `by`, minus
 * absolutely pinned pieces that could not recapture there. The king counts as a defender (whether
 * it may really recapture depends on the exchange and is decided inside SEE).
 */
export function defendersOf(board: Board, target: number, by: Color): number[] {
  const raw = attackersOf(board, target, by);
  if (raw.length === 0) return raw;
  const pins = absolutePins(board, by);
  return raw.filter((from) => {
    const pin = pins.find((p) => p.pinned === from);
    return !pin || collinear(pin.king, from, target);
  });
}

function kingCaptureIsCovered(board: Board, from: number, target: number): boolean {
  const king = board[from] as BoardPiece;
  const victim = board[target] ?? null;
  board[from] = null;
  board[target] = king;
  const covered = attackersOf(board, target, opposite(king.color)).length > 0;
  board[from] = king;
  board[target] = victim;
  return covered;
}

function leastValuable(board: Board, squares: number[]): number {
  let best = -1;
  for (const sq of squares) {
    if (best < 0 || VALUE_CP[(board[sq] as BoardPiece).type] < VALUE_CP[(board[best] as BoardPiece).type]) best = sq;
  }
  return best;
}

/**
 * Static exchange evaluation of one concrete capture `from` x `target` (centipawns, from the
 * capturing side's point of view). The first capture is forced, afterwards each side recaptures
 * with its least valuable piece only while that pays off. X-rays, absolute pins, protected-square
 * king captures and capture-promotions are handled; en passant is not.
 * The board is mutated during the search and restored before returning.
 */
export function seeCapture(board: Board, from: number, target: number): number {
  const mover = board[from];
  if (!mover) return 0;
  const victim = board[target] ?? null;
  let gain = victim ? VALUE_CP[victim.type] : 0;
  let placed: BoardPiece = mover;
  if (mover.type === 'p' && (rankOf(target) === 7 || rankOf(target) === 0)) {
    placed = { type: 'q', color: mover.color };
    gain += VALUE_CP.q - VALUE_CP.p;
  }
  board[from] = null;
  board[target] = placed;
  const reply = seeExchange(board, target, opposite(mover.color));
  board[from] = mover;
  board[target] = victim;
  return gain - reply;
}

/** Best result (>= 0, centipawns) `side` can get by starting / continuing captures on `target`. */
export function seeExchange(board: Board, target: number, side: Color): number {
  if (!board[target]) return 0;
  const attacker = leastValuable(board, captureCandidates(board, target, side));
  if (attacker < 0) return 0;
  return Math.max(0, seeCapture(board, attacker, target));
}

/**
 * Expected loss (centipawns, >= 0) of the piece on `target` if the opponent starts capturing it.
 * `firstAttackers` restricts the first capture (used to honour full legality for the side to move).
 */
export function seeLoss(board: Board, target: number, firstAttackers?: number[]): number {
  const piece = board[target];
  if (!piece) return 0;
  const attackers = firstAttackers ?? captureCandidates(board, target, opposite(piece.color));
  let worst = 0;
  for (const from of attackers) worst = Math.max(worst, seeCapture(board, from, target));
  return worst;
}

/** Material of `color` in pawns (1/3/3/5/9). */
export function materialOf(board: Board, color: Color): number {
  let sum = 0;
  for (const p of board) if (p && p.color === color) sum += VALUE_PAWNS[p.type];
  return sum;
}
