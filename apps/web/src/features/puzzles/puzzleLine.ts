/**
 * Pure puzzle-line logic (no React, no DOM): is the child's move the solution move, what does the
 * opponent answer, where is the puzzle after N plies, which squares does a hint point at.
 *
 * Contract reminder (`Puzzle` in contracts.ts): `fen` has the CHILD to move (the opponent's first
 * move is already applied), `solutionUci` alternates child, opponent, child, …
 *
 * Alternate mates: like Lichess, ANY move that checkmates is accepted as correct — a mate is never
 * a wrong answer, even when the stored line mates with another piece.
 */
import { Chess } from 'chess.js';
import type { Color, PieceType, Puzzle, Square } from '@gambit/shared';

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export interface ParsedUci {
  from: Square;
  to: Square;
  promotion?: PromotionPiece;
}

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export function parseUci(uci: string): ParsedUci | null {
  const match = UCI_RE.exec(uci.trim().toLowerCase());
  if (!match) return null;
  const [, from, to, promotion] = match;
  if (from === undefined || to === undefined) return null;
  return promotion === undefined ? { from, to } : { from, to, promotion: promotion as PromotionPiece };
}

export function toUci(from: Square, to: Square, promotion?: PromotionPiece): string {
  return `${from}${to}${promotion ?? ''}`;
}

export interface AppliedMove {
  /** normalised UCI (castling is always king-two-squares, e.g. e1g1) */
  uci: string;
  san: string;
  from: Square;
  to: Square;
  color: Color;
  piece: PieceType;
  promotion?: PromotionPiece;
  fenBefore: string;
  fenAfter: string;
  isCapture: boolean;
  isCheck: boolean;
  isMate: boolean;
  /** the game is over after this move (mate, stalemate, insufficient material, …) */
  isGameOver: boolean;
}

function loadFen(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/** Some data sources write castling as "king takes own rook" (e1h1). Map it to the standard e1g1 / e1c1. */
function normaliseCastling(chess: Chess, move: ParsedUci): ParsedUci {
  const king = chess.get(move.from as Parameters<Chess['get']>[0]);
  const target = chess.get(move.to as Parameters<Chess['get']>[0]);
  if (!king || king.type !== 'k' || !target || target.type !== 'r' || target.color !== king.color) return move;
  const rank = move.from[1];
  if (rank === undefined || move.to[1] !== rank) return move;
  const kingSide = move.to.charCodeAt(0) > move.from.charCodeAt(0);
  return { from: move.from, to: `${kingSide ? 'g' : 'c'}${rank}` };
}

/** Plays `uci` on `fen`. Returns null when the FEN or the move is not legal. Never throws. */
export function applyUci(fen: string, uci: string): AppliedMove | null {
  const parsed = parseUci(uci);
  if (!parsed) return null;
  const chess = loadFen(fen);
  if (!chess) return null;
  const wanted = normaliseCastling(chess, parsed);
  try {
    const move = chess.move({ from: wanted.from, to: wanted.to, promotion: wanted.promotion });
    const promotion = move.promotion as PromotionPiece | undefined;
    return {
      uci: toUci(move.from, move.to, promotion),
      san: move.san,
      from: move.from,
      to: move.to,
      color: move.color,
      piece: move.piece,
      ...(promotion !== undefined ? { promotion } : {}),
      fenBefore: move.before,
      fenAfter: move.after,
      // chess.js 1.4: isCapture() is false for en passant although a pawn disappears
      isCapture: move.isCapture() || move.isEnPassant(),
      isCheck: chess.inCheck(),
      isMate: chess.isCheckmate(),
      isGameOver: chess.isGameOver(),
    };
  } catch {
    return null;
  }
}

/** True when both strings describe the same move (promotion piece included, castling spelling ignored). */
export function sameMove(fen: string, a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const left = applyUci(fen, a);
  const right = applyUci(fen, b);
  return left !== null && right !== null && left.uci === right.uci;
}

/**
 * FEN after the first `index` plies of the solution were played from `puzzle.fen`.
 * `index` 0 = the start position of the puzzle. Returns null when the stored line is broken.
 */
export function puzzlePositionAt(puzzle: Pick<Puzzle, 'fen' | 'solutionUci'>, index: number): string | null {
  let fen = puzzle.fen;
  if (loadFen(fen) === null) return null;
  const plies = Math.max(0, Math.min(index, puzzle.solutionUci.length));
  for (let i = 0; i < plies; i++) {
    const uci = puzzle.solutionUci[i];
    if (uci === undefined) return null;
    const applied = applyUci(fen, uci);
    if (!applied) return null;
    fen = applied.fenAfter;
  }
  return fen;
}

/** A puzzle is usable when it has a legal start position and a fully legal, non-empty solution line. */
export function isPlayablePuzzle(puzzle: Pick<Puzzle, 'fen' | 'solutionUci'>): boolean {
  return puzzle.solutionUci.length > 0 && puzzlePositionAt(puzzle, puzzle.solutionUci.length) !== null;
}

export type PuzzleMoveVerdict =
  /** not a legal chess move in this position (the board normally prevents this) */
  | { kind: 'illegal' }
  /** legal, but not the solution — «Попробуй ещё» */
  | { kind: 'wrong'; played: AppliedMove; expectedUci: string }
  | {
      kind: 'correct';
      played: AppliedMove;
      /** the move differs from the stored line but checkmates — accepted */
      alternateMate: boolean;
      /** the opponent's scripted answer to auto-play, null when the line is over */
      reply: AppliedMove | null;
      /** index of the child's next move in `solutionUci` (meaningless when `done`) */
      nextIndex: number;
      done: boolean;
    };

/**
 * Checks the child's move number `index` (0, 2, 4, … in `solutionUci`).
 * The position is always re-derived from the puzzle itself, so UI state can never desync the check.
 */
export function checkPuzzleMove(puzzle: Pick<Puzzle, 'fen' | 'solutionUci'>, index: number, uci: string): PuzzleMoveVerdict {
  const expectedUci = puzzle.solutionUci[index];
  const fen = puzzlePositionAt(puzzle, index);
  if (expectedUci === undefined || fen === null || index % 2 !== 0) return { kind: 'illegal' };

  const played = applyUci(fen, uci);
  if (!played) return { kind: 'illegal' };

  const expected = applyUci(fen, expectedUci);
  const matches = expected !== null && expected.uci === played.uci;

  if (!matches) {
    if (played.isMate) return { kind: 'correct', played, alternateMate: true, reply: null, nextIndex: puzzle.solutionUci.length, done: true };
    return { kind: 'wrong', played, expectedUci: expected?.uci ?? expectedUci };
  }

  const replyUci = puzzle.solutionUci[index + 1];
  const reply = replyUci !== undefined && !played.isGameOver ? applyUci(played.fenAfter, replyUci) : null;
  const nextIndex = index + 2;
  const done = reply === null || reply.isGameOver || nextIndex >= puzzle.solutionUci.length;
  return { kind: 'correct', played, alternateMate: false, reply, nextIndex, done };
}

/** The solution move the child is looking for at `index` — for hints and «Показать решение». */
export function expectedMove(puzzle: Pick<Puzzle, 'fen' | 'solutionUci'>, index: number): AppliedMove | null {
  const uci = puzzle.solutionUci[index];
  const fen = puzzlePositionAt(puzzle, index);
  if (uci === undefined || fen === null) return null;
  return applyUci(fen, uci);
}

/** Every remaining move of the line from `index` on, already applied — for the solution replay. */
export function remainingLine(puzzle: Pick<Puzzle, 'fen' | 'solutionUci'>, index: number): AppliedMove[] {
  const out: AppliedMove[] = [];
  let fen = puzzlePositionAt(puzzle, index);
  for (let i = index; fen !== null && i < puzzle.solutionUci.length; i++) {
    const uci = puzzle.solutionUci[i];
    if (uci === undefined) break;
    const applied = applyUci(fen, uci);
    if (!applied) break;
    out.push(applied);
    fen = applied.fenAfter;
  }
  return out;
}

/** Side to move of a FEN ('w' when the FEN is unreadable). */
export function sideToMove(fen: string): Color {
  return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

// ───────────────────────── "position before the opponent's move" (for the intro animation) ─────────────────────────

type Board = (string | null)[][];

function parsePlacement(fen: string): Board | null {
  const rows = (fen.split(/\s+/)[0] ?? '').split('/');
  if (rows.length !== 8) return null;
  const board: Board = [];
  for (const row of rows) {
    const cells: (string | null)[] = [];
    for (const ch of row) {
      if (/[1-8]/.test(ch)) for (let i = 0; i < Number(ch); i++) cells.push(null);
      else if (/[prnbqkPRNBQK]/.test(ch)) cells.push(ch);
      else return null;
    }
    if (cells.length !== 8) return null;
    board.push(cells);
  }
  return board;
}

function placementOf(board: Board): string {
  return board
    .map((row) => {
      let out = '';
      let empty = 0;
      for (const cell of row) {
        if (cell === null) empty++;
        else {
          if (empty > 0) out += String(empty);
          empty = 0;
          out += cell;
        }
      }
      return empty > 0 ? out + String(empty) : out;
    })
    .join('/');
}

function coords(square: Square): { row: number; col: number } | null {
  if (!/^[a-h][1-8]$/.test(square)) return null;
  return { row: 8 - Number(square[1]), col: square.charCodeAt(0) - 97 };
}

/**
 * Piece placement as it looked BEFORE `lastMoveUci` was played, reconstructed from the position after it.
 * Used only to animate the opponent's move into the puzzle: the moved piece goes back to its start square
 * (a promoted piece turns back into a pawn, a castled rook goes back to its corner). A captured piece cannot
 * be known and is simply absent. Returns the placement of `fen` unchanged when anything looks off.
 */
export function placementBeforeLastMove(fen: string, lastMoveUci: string): string {
  const fallback = fen.split(/\s+/)[0] ?? fen;
  const move = parseUci(lastMoveUci);
  const board = parsePlacement(fen);
  if (!move || !board) return fallback;
  const from = coords(move.from);
  const to = coords(move.to);
  if (!from || !to) return fallback;
  const moved = board[to.row]?.[to.col] ?? null;
  const fromRow = board[from.row];
  const toRow = board[to.row];
  if (moved === null || !fromRow || !toRow || fromRow[from.col] !== null) return fallback;

  const isWhite = moved === moved.toUpperCase();
  toRow[to.col] = null;
  fromRow[from.col] = move.promotion !== undefined ? (isWhite ? 'P' : 'p') : moved;

  // castling: put the rook back into its corner
  if (moved.toLowerCase() === 'k' && from.row === to.row && Math.abs(from.col - to.col) === 2) {
    const kingSide = to.col > from.col;
    const rookNow = kingSide ? 5 : 3;
    const rookHome = kingSide ? 7 : 0;
    const rook = isWhite ? 'R' : 'r';
    if (toRow[rookNow] === rook && toRow[rookHome] === null) {
      toRow[rookNow] = null;
      toRow[rookHome] = rook;
    }
  }
  return placementOf(board);
}
