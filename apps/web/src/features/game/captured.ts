/**
 * Captured material derived from a FEN (no move history needed): what is missing from the starting army.
 * Promotions make the pawn count ambiguous, so numbers are clamped at zero and promoted pieces simply
 * show up as "extra" material in the balance.
 */
import type { Color, PieceType } from '@gambit/shared';

const START_COUNT: Record<Exclude<PieceType, 'k'>, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
/** strongest first — the order the pieces are shown in */
const DISPLAY_ORDER: readonly Exclude<PieceType, 'k'>[] = ['q', 'r', 'b', 'n', 'p'];

export interface CapturedMaterial {
  /** pieces of this colour that are gone from the board, strongest first */
  lost: Record<Color, PieceType[]>;
  /** material on the board in pawns, white minus black */
  diff: number;
}

function isPieceLetter(ch: string): ch is PieceType {
  return ch === 'p' || ch === 'n' || ch === 'b' || ch === 'r' || ch === 'q' || ch === 'k';
}

export function capturedFromFen(fen: string): CapturedMaterial {
  const placement = fen.trim().split(/\s+/)[0] ?? '';
  const count: Record<Color, Record<PieceType, number>> = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
  for (const ch of placement) {
    const lower = ch.toLowerCase();
    if (!isPieceLetter(lower)) continue;
    count[ch === lower ? 'b' : 'w'][lower] += 1;
  }

  const lost: Record<Color, PieceType[]> = { w: [], b: [] };
  let diff = 0;
  for (const color of ['w', 'b'] as const) {
    for (const piece of DISPLAY_ORDER) {
      const missing = Math.max(0, START_COUNT[piece] - count[color][piece]);
      for (let i = 0; i < missing; i++) lost[color].push(piece);
      diff += (color === 'w' ? 1 : -1) * count[color][piece] * VALUE[piece];
    }
  }
  return { lost, diff };
}

const GLYPH: Record<Color, Record<PieceType, string>> = {
  w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
  b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
};

export function pieceGlyph(color: Color, piece: PieceType): string {
  return GLYPH[color][piece];
}
