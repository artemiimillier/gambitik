/**
 * Principal-variation helpers: UCI → SAN and the material outcome of a line.
 */
import { Chess } from 'chess.js';
import type { Move } from 'chess.js';
import { materialOf, opposite, parsePlacement, seeExchange, squareIndex } from './board.ts';

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Plays one UCI move on `chess`. Returns null (position untouched) when it is malformed or illegal. */
export function applyUci(chess: Chess, uci: string): Move | null {
  const text = uci.trim().toLowerCase();
  if (!UCI_RE.test(text)) return null;
  try {
    return chess.move({ from: text.slice(0, 2), to: text.slice(2, 4), promotion: text[4] });
  } catch {
    return null;
  }
}

/**
 * True for every move that removes an enemy piece from the board. chess.js 1.4 `Move.isCapture()`
 * is FALSE for en passant (flag 'e' only), so every "is this a capture?" question goes through here.
 */
export function isCaptureMove(move: Move): boolean {
  return move.isCapture() || move.isEnPassant();
}

/**
 * SAN for every move of a UCI line played from `fen`. Stops silently at the first malformed or
 * illegal move, so the result may be shorter than the input (engine PVs can be cut or stale).
 * Throws on an invalid FEN.
 */
export function uciToSan(fen: string, pvUci: string[]): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of pvUci) {
    const move = applyUci(chess, uci);
    if (!move) break;
    out.push(move.san);
  }
  return out;
}

/**
 * Net material, in pawns (p=1, n=b=3, r=5, q=9), that the side TO MOVE at `fen` wins along the
 * PV — i.e. exactly what the side NOT to move loses. Negative when the side to move comes out
 * behind. Promotions count as the material difference (a new queen = +8).
 *
 * How far the line is followed:
 *  1. the first `plies` half-moves (default 4), stopping early at an illegal move / PV end;
 *  2. then for as long as the next PV move is a capture (so an exchange is never cut in half);
 *  3. if the PV runs out right after a capture, the pending recapture is settled by static
 *     exchange evaluation on that square (a truncated "QxQ" line is not a won queen).
 *
 * `judgeMove` calls it as `materialSwing(fenAfter, refutationPv)`: there the side not to move is
 * the child, so a positive result is the material the child loses.
 * Throws on an invalid FEN.
 */
export function materialSwing(fen: string, pvUci: string[], plies = 4): number {
  const chess = new Chess(fen);
  const side = chess.turn();
  const start = parsePlacement(fen);
  const balanceBefore = materialOf(start, side) - materialOf(start, opposite(side));

  let last: Move | null = null;
  let ranOut = true;
  for (let i = 0; i < pvUci.length; i++) {
    const move = applyUci(chess, pvUci[i] as string);
    if (!move) break;
    if (i >= plies && !isCaptureMove(move)) {
      chess.undo();
      ranOut = false;
      break;
    }
    last = move;
  }

  const board = parsePlacement(chess.fen());
  let balance = materialOf(board, side) - materialOf(board, opposite(side)) - balanceBefore;
  if (last && ranOut && isCaptureMove(last) && !chess.isGameOver()) {
    const toMove = chess.turn();
    const recapture = seeExchange(board, squareIndex(last.to), toMove) / 100;
    balance += toMove === side ? recapture : -recapture;
  }
  return balance;
}
