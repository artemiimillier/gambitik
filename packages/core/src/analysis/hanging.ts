/**
 * Hanging / en-prise piece detection by static exchange evaluation.
 */
import { Chess } from 'chess.js';
import type { HangingPiece } from '@gambit/shared';
import type { BoardPiece } from './board.ts';
import { VALUE_CP, captureCandidates, defendersOf, opposite, parsePlacement, seeLoss, squareIndex, squareName } from './board.ts';

/**
 * Pieces (and pawns) of BOTH colours that can be won right now: attacked by the opponent and
 * losing material by static exchange evaluation (`seeLossCp > 0`, values 100/300/300/500/900).
 *
 *  - SEE handles x-ray batteries, absolutely pinned attackers / defenders, kings that may not
 *    capture a protected piece, and capture-promotions. En passant is ignored.
 *  - For pieces of the side NOT to move, the first capture must be a fully legal move (so nothing
 *    is reported as "free" while the side to move has to answer a check first). For pieces of the
 *    side to move, the opponent's captures are checked pin-aware but without full legality.
 *  - `attackers` / `defenders` list direct, really usable attackers / defenders (no x-rays).
 *  - Kings are never listed. Sorted by `seeLossCp`, then piece value, descending.
 *
 * Throws on an invalid FEN.
 */
export function findHanging(fen: string): HangingPiece[] {
  const chess = new Chess(fen);
  const board = parsePlacement(fen);
  const sideToMove = chess.turn();

  const legalCaptures = new Map<number, number[]>();
  for (const move of chess.moves({ verbose: true })) {
    if (!move.isCapture() || move.isEnPassant()) continue;
    const to = squareIndex(move.to);
    const list = legalCaptures.get(to) ?? [];
    const from = squareIndex(move.from);
    if (!list.includes(from)) list.push(from);
    legalCaptures.set(to, list);
  }

  const out: HangingPiece[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece || piece.type === 'k') continue;
    const enemy = opposite(piece.color);
    const attackers = enemy === sideToMove ? (legalCaptures.get(sq) ?? []) : captureCandidates(board, sq, enemy);
    if (attackers.length === 0) continue;
    const lossCp = seeLoss(board, sq, attackers);
    if (lossCp <= 0) continue;
    out.push({
      square: squareName(sq),
      piece: piece.type,
      color: piece.color,
      attackers: attackers.map(squareName),
      defenders: defendersOf(board, sq, piece.color).map(squareName),
      seeLossCp: lossCp,
    });
  }

  const value = (h: HangingPiece): number => VALUE_CP[h.piece as BoardPiece['type']];
  return out.sort((a, b) => b.seeLossCp - a.seeLossCp || value(b) - value(a) || a.square.localeCompare(b.square));
}
