import { Chess } from 'chess.js';
import { EngineError } from './types.ts';

export interface PositionInfo {
  fen: string;
  /** Every legal move in UCI notation ('e2e4', 'e7e8q'); castling is king-from/king-to like Stockfish. */
  legalUci: string[];
  legalSet: ReadonlySet<string>;
  inCheck: boolean;
  isCheckmate: boolean;
}

/**
 * chess.js is the only authority on legality: every position is validated BEFORE it reaches Stockfish
 * (a bad FEN would trigger the CRITICAL ERROR path) and every engine move is validated AFTER.
 * Throws EngineError('invalid-fen').
 */
export function inspectPosition(fen: string): PositionInfo {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch (error) {
    throw new EngineError('invalid-fen', `invalid FEN "${fen}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const legalUci = chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ''}`);
  return {
    fen,
    legalUci,
    legalSet: new Set(legalUci),
    inCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
  };
}
