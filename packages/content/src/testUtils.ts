/**
 * Test-only helpers (imported by the colocated *.test.ts files, never by index.ts).
 * chess.js is used here only to machine-verify the hand-made positions and move lists.
 */
import { Chess } from 'chess.js';
import type { Color, PieceSymbol, Square } from 'chess.js';

/** Any Latin letter — child-facing strings that may be spoken must not contain notation. */
export const LATIN_RE = /[A-Za-z]/;

/** Typical leftovers of unfinished texts. */
export const PLACEHOLDER_RE = /\{\{|\}\}|\$\{|<[^>\n]*>|\[[^\]\n]*\]|TODO|FIXME|XXX|lorem|undefined|\bnull\b|NaN/i;

const PIECE_VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

/** Loads a FEN (chess.js throws on an invalid one). */
export function load(fen: string): Chess {
  return new Chess(fen);
}

/** True when the side that is NOT to move is in check — such a position can never arise in a game. */
export function opponentKingCapturable(fen: string): boolean {
  const chess = new Chess(fen);
  const mover = chess.turn();
  const [king] = chess.findPiece({ type: 'k', color: opposite(mover) });
  return king !== undefined && chess.isAttacked(king, mover);
}

/**
 * Plays SAN moves and insists on the canonical SAN (so '+', '#', 'x' and disambiguation in the
 * content are exactly what chess.js would print). Returns the verbose moves.
 */
export function playLine(chess: Chess, sans: readonly string[]) {
  return sans.map((san, i) => {
    let move;
    try {
      move = chess.move(san, { strict: true });
    } catch {
      throw new Error(`illegal move #${i + 1} '${san}' in position ${chess.fen()}`);
    }
    if (move.san !== san) {
      throw new Error(`non-canonical SAN '${san}', chess.js prints '${move.san}'`);
    }
    return move;
  });
}

/** Material of `color` minus material of the opponent, in pawns. */
export function materialBalance(chess: Chess, color: Color): number {
  let balance = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (cell) balance += (cell.color === color ? 1 : -1) * PIECE_VALUE[cell.type];
    }
  }
  return balance;
}

/** The side to move can force checkmate within `moves` of its own moves (brute force, tiny positions only). */
export function canForceMate(chess: Chess, moves: number): boolean {
  if (moves <= 0) return false;
  for (const move of chess.moves()) {
    chess.move(move);
    let forced: boolean;
    if (chess.isCheckmate()) {
      forced = true;
    } else if (moves === 1 || chess.isGameOver()) {
      forced = false;
    } else {
      forced = everyReplyLosesToMate(chess, moves - 1);
    }
    chess.undo();
    if (forced) return true;
  }
  return false;
}

/** Every legal reply of the side to move still allows the opponent to force mate within `moves`. */
export function everyReplyLosesToMate(chess: Chess, moves: number): boolean {
  const replies = chess.moves();
  if (replies.length === 0) return chess.isCheckmate();
  for (const reply of replies) {
    chess.move(reply);
    const stillMated = canForceMate(chess, moves);
    chess.undo();
    if (!stillMated) return false;
  }
  return true;
}

/** Destination squares of all legal moves of the piece standing on `square`. */
export function destinations(chess: Chess, square: Square): Square[] {
  return chess.moves({ square, verbose: true }).map((m) => m.to);
}

/**
 * Number of sentences in a Russian text: groups of terminal punctuation followed by a space, a
 * closing quote or the end. An ellipsis counts only at the very end («Ну… почти.» is one sentence).
 */
export function sentenceCount(text: string): number {
  const terminal = text.match(/[.!?]+(?=\s|$|[»")])/g) ?? [];
  const trailingEllipsis = /…\s*$/.test(text) ? 1 : 0;
  return terminal.length + trailingEllipsis;
}
