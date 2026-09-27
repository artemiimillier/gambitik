/**
 * Deterministic position facts for the coach (no engine involved).
 */
import { Chess } from 'chess.js';
import type { Color, PositionFacts } from '@gambit/shared';
import type { Board } from './board.ts';
import { VALUE_PAWNS, attackersOf, materialOf, parsePlacement, squareIndex } from './board.ts';
import { findHanging } from './hanging.ts';

const CENTER = ['d4', 'e4', 'd5', 'e5'].map(squareIndex);
const MINOR_HOMES: Record<Color, { knights: number[]; bishops: number[] }> = {
  w: { knights: ['b1', 'g1'].map(squareIndex), bishops: ['c1', 'f1'].map(squareIndex) },
  b: { knights: ['b8', 'g8'].map(squareIndex), bishops: ['c8', 'f8'].map(squareIndex) },
};

function has(board: Board, square: string, color: Color, type: string): boolean {
  const p = board[squareIndex(square)];
  return !!p && p.color === color && p.type === type;
}

/** Minor pieces that have left their home squares (0..4); a captured minor counts as developed. */
function developedMinors(board: Board, color: Color): number {
  const homes = MINOR_HOMES[color];
  const atHome =
    homes.knights.filter((sq) => board[sq]?.color === color && board[sq]?.type === 'n').length +
    homes.bishops.filter((sq) => board[sq]?.color === color && board[sq]?.type === 'b').length;
  return 4 - atHome;
}

/**
 * A FEN has no history, so "castled" is a placement heuristic: the king sits on the g/h (or
 * c/b/a) file of its back rank, has no castling rights left and no own rook is boxed into the
 * corner behind it (which would mean the king walked there by hand).
 */
function looksCastled(board: Board, color: Color, canCastle: boolean): boolean {
  if (canCastle) return false;
  const rank = color === 'w' ? '1' : '8';
  const kingOn = (file: string): boolean => has(board, `${file}${rank}`, color, 'k');
  const rookOn = (file: string): boolean => has(board, `${file}${rank}`, color, 'r');
  if (kingOn('g') && !rookOn('h')) return true;
  if (kingOn('h') && !rookOn('g')) return true;
  if (kingOn('c') && !rookOn('a') && !rookOn('b')) return true;
  if (kingOn('b') && !rookOn('a')) return true;
  return false;
}

function centerControl(board: Board, color: Color): number {
  return CENTER.filter((sq) => {
    const p = board[sq];
    if (p && p.color === color && p.type === 'p') return true;
    return attackersOf(board, sq, color).some((from) => board[from]?.type === 'p');
  }).length;
}

function nonPawnMaterial(board: Board): { total: number; queens: number } {
  let total = 0;
  let queens = 0;
  for (const p of board) {
    if (!p || p.type === 'p' || p.type === 'k') continue;
    total += VALUE_PAWNS[p.type];
    if (p.type === 'q') queens += 1;
  }
  return { total, queens };
}

function gamePhase(board: Board, fullMove: number): PositionFacts['phase'] {
  const { total, queens } = nonPawnMaterial(board);
  if (total <= 26 || (queens === 0 && total <= 32)) return 'endgame';
  if (total >= 50) {
    const minorsAtHome = 8 - developedMinors(board, 'w') - developedMinors(board, 'b');
    if (fullMove <= 10 || (fullMove <= 15 && minorsAtHome >= 3)) return 'opening';
  }
  return 'middlegame';
}

/**
 * Facts the coach may state about a position. `openingName` is passed through untouched.
 *
 *  - `phase`: endgame when the non-pawn material of both sides is ≤ 26 pawns (≤ 32 without queens);
 *    opening when ≥ 50 and (move ≤ 10, or move ≤ 15 with ≥ 3 minor pieces still at home).
 *  - `development`: minor pieces that left their home squares, 0..4 per side.
 *  - `castled`: placement heuristic (see `looksCastled`), `canStillCastle`: FEN castling rights.
 *  - `centerControl`: how many of d4/e4/d5/e5 are occupied or attacked by the side's pawns.
 *
 * Throws on an invalid FEN.
 */
export function computePositionFacts(fen: string, openingName?: string): PositionFacts {
  const chess = new Chess(fen);
  const board = parsePlacement(fen);
  const fields = fen.trim().split(/\s+/);
  const rights = fields[2] ?? '-';
  const fullMove = Number.parseInt(fields[5] ?? '1', 10) || 1;
  const canStillCastle = { w: /[KQ]/.test(rights), b: /[kq]/.test(rights) };
  const w = materialOf(board, 'w');
  const b = materialOf(board, 'b');

  const facts: PositionFacts = {
    fen,
    sideToMove: chess.turn(),
    phase: gamePhase(board, fullMove),
    inCheck: chess.inCheck(),
    legalMoveCount: chess.moves().length,
    material: { w, b, diff: w - b },
    hanging: findHanging(fen),
    development: { w: developedMinors(board, 'w'), b: developedMinors(board, 'b') },
    castled: { w: looksCastled(board, 'w', canStillCastle.w), b: looksCastled(board, 'b', canStillCastle.b) },
    canStillCastle,
    centerControl: { w: centerControl(board, 'w'), b: centerControl(board, 'b') },
  };
  if (openingName !== undefined) facts.openingName = openingName;
  return facts;
}
