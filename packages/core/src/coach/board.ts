/**
 * Small chess.js-backed helpers the phrase builders need (who stands where, which squares are in
 * danger along a refutation, a board zone around a square). Kept local to `coach/` on purpose:
 * the analysis half of the package is developed independently.
 */
import { Chess } from 'chess.js';
import type { Square as ChessJsSquare } from 'chess.js';
import type { Color, PieceRef, PieceType, Square } from '@gambit/shared';

const FILES = 'abcdefgh';
const SQUARE_RE = /^[a-h][1-8]$/;
const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export interface UciParts {
  from: Square;
  to: Square;
  promotion?: PieceType;
}

export function isSquare(s: string): boolean {
  return SQUARE_RE.test(s);
}

export function parseUci(uci: string): UciParts | null {
  const m = UCI_RE.exec(uci.trim().toLowerCase());
  if (!m) return null;
  return { from: m[1]!, to: m[2]!, promotion: m[3] ? (m[3] as PieceType) : undefined };
}

function loadPosition(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/** Side to move of a FEN ('w' when the FEN is malformed). */
export function sideToMove(fen: string): Color {
  return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

/** Full-move number of a FEN (1 when malformed). */
export function fullMoveNumber(fen: string): number {
  const n = Number.parseInt(fen.split(/\s+/)[5] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** The piece standing on `square` in `fen`, if any. */
export function pieceAt(fen: string, square: Square): PieceRef | undefined {
  if (!isSquare(square)) return undefined;
  const chess = loadPosition(fen);
  const p = chess?.get(square as ChessJsSquare);
  return p ? { square, piece: p.type, color: p.color } : undefined;
}

export function kingSquare(fen: string, color: Color): Square | undefined {
  const chess = loadPosition(fen);
  return chess?.findPiece({ type: 'k', color })[0];
}

export interface ResolvedMove {
  san: string;
  from: Square;
  to: Square;
  piece: PieceType;
  color: Color;
  captured?: PieceType;
  promotion?: PieceType;
  isCastle: boolean;
  givesCheck: boolean;
  givesMate: boolean;
  fenAfter: string;
}

/** Plays a UCI move on a FEN; undefined when the FEN is broken or the move illegal. */
export function resolveUciMove(fen: string, uci: string): ResolvedMove | undefined {
  const parts = parseUci(uci);
  const chess = loadPosition(fen);
  if (!parts || !chess) return undefined;
  try {
    const mv = chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
    return {
      san: mv.san,
      from: mv.from,
      to: mv.to,
      piece: mv.piece,
      color: mv.color,
      captured: mv.captured,
      promotion: mv.promotion,
      isCastle: mv.isKingsideCastle() || mv.isQueensideCastle(),
      givesCheck: chess.isCheck(),
      givesMate: chess.isCheckmate(),
      fenAfter: chess.fen(),
    };
  } catch {
    return undefined;
  }
}

const PIECE_VALUE: Readonly<Record<PieceType, number>> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

export function pieceValue(p: PieceType): number {
  return PIECE_VALUE[p];
}

/**
 * Squares of the VICTIM's pieces (the side that is NOT to move in `fen`) that are in danger along
 * the opponent's punishing line `pvUci` (pv[0] is played by the side to move in `fen`).
 *
 * Squares are reported as they stand in `fen` — if the PV has the victim move a piece before it
 * gets captured, the piece is traced back to where the child currently sees it.
 * Never includes anything about the victim's better alternatives (it is not "the solution").
 *
 *  1. every victim piece captured by the attacker within `maxPlies` plies of the PV;
 *  2. the victim's king when `mateThreat` is set or the PV ends in mate;
 *  3. fallback: the most valuable victim pieces attacked by the piece that just moved (pv[0]);
 *  4. last resort: the landing square of pv[0].
 */
export function endangeredSquares(
  fen: string,
  pvUci: readonly string[],
  opts: { mateThreat?: boolean; maxPlies?: number; maxSquares?: number } = {},
): Square[] {
  const maxPlies = opts.maxPlies ?? 5;
  const maxSquares = opts.maxSquares ?? 3;
  const chess = loadPosition(fen);
  if (!chess || pvUci.length === 0) return [];

  const attacker = chess.turn();
  const victim: Color = attacker === 'w' ? 'b' : 'w';
  const victimKing = chess.findPiece({ type: 'k', color: victim })[0];

  // current square → square in the starting position, for the victim's pieces
  const origin = new Map<string, string>();
  for (const row of chess.board()) {
    for (const cell of row) if (cell && cell.color === victim) origin.set(cell.square, cell.square);
  }

  const found: Square[] = [];
  const add = (sq: Square | undefined): void => {
    if (sq && !found.includes(sq)) found.push(sq);
  };

  let firstMoveTo: Square | undefined;
  let endedInMate = false;
  let played = 0;
  for (const uci of pvUci.slice(0, maxPlies)) {
    const parts = parseUci(uci);
    if (!parts) break;
    let mv;
    try {
      mv = chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
    } catch {
      break;
    }
    played += 1;
    if (played === 1) firstMoveTo = mv.to;
    if (mv.color === attacker) {
      if (mv.captured) {
        // en passant captures a pawn that is NOT on the landing square
        const capturedOn = mv.isEnPassant() ? `${mv.to[0]}${mv.from[1]}` : mv.to;
        add(origin.get(capturedOn) ?? capturedOn);
        origin.delete(capturedOn);
      }
    } else {
      const from0 = origin.get(mv.from);
      origin.delete(mv.from);
      if (from0) origin.set(mv.to, from0);
      if (mv.isKingsideCastle() || mv.isQueensideCastle()) {
        const rank = mv.from[1];
        const rookFrom = `${mv.isKingsideCastle() ? 'h' : 'a'}${rank}`;
        const rookTo = `${mv.isKingsideCastle() ? 'f' : 'd'}${rank}`;
        const rook0 = origin.get(rookFrom);
        origin.delete(rookFrom);
        if (rook0) origin.set(rookTo, rook0);
      }
    }
    if (chess.isCheckmate()) {
      endedInMate = mv.color === attacker;
      break;
    }
  }

  if (opts.mateThreat || endedInMate) add(victimKing);

  if (found.length === 0 && firstMoveTo) {
    // Nothing concrete in the PV (short PV, or a pure threat): what does the moved piece attack?
    const after = loadPosition(fen);
    const parts = parseUci(pvUci[0] ?? '');
    if (after && parts) {
      try {
        after.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
        const targets: { square: Square; value: number }[] = [];
        for (const row of after.board()) {
          for (const cell of row) {
            if (!cell || cell.color !== victim || cell.type === 'p') continue;
            if (after.attackers(cell.square, attacker).includes(firstMoveTo as ChessJsSquare)) {
              targets.push({ square: cell.square, value: PIECE_VALUE[cell.type] });
            }
          }
        }
        targets.sort((a, b) => b.value - a.value);
        for (const t of targets.slice(0, 2)) add(t.square);
      } catch {
        /* keep going to the last resort */
      }
    }
  }

  if (found.length === 0) add(firstMoveTo);
  return found.slice(0, maxSquares);
}

export type BoardZone = 'kingside' | 'queenside' | 'center';

/** Which part of the board a square belongs to (absolute: files a–d = queenside, e–h = kingside). */
export function zoneOf(square: Square): BoardZone {
  const file = FILES.indexOf(square[0] ?? '');
  const rank = Number.parseInt(square[1] ?? '', 10) - 1;
  if (file >= 2 && file <= 5 && rank >= 2 && rank <= 5) return 'center';
  return file <= 3 ? 'queenside' : 'kingside';
}

/** FNV-1a — a tiny deterministic string hash (no crypto needed: it only varies a highlight). */
function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A 3×3 block of squares that contains `square` — the «зона доски» of hint level 2.
 *
 * The block must NOT give the target away: a block centred on the target makes the middle square
 * the answer (level 2 would leak level 4). So the target's place inside the block is chosen
 * deterministically from `seed` (the FEN): any of the nine cells, the same one every time the
 * same hint is asked again. Blocks are shifted inwards at the board edge, always nine squares.
 */
export function zoneSquares(square: Square, seed = ''): Square[] {
  if (!isSquare(square)) return [];
  const clamp = (n: number): number => Math.min(6, Math.max(1, n));
  const h = hashText(`${seed}|${square}`);
  // offset of the block's centre from the target: −1, 0 or +1 on each axis
  const df = (h % 3) - 1;
  const dr = (Math.floor(h / 3) % 3) - 1;
  const cf = clamp(FILES.indexOf(square[0]!) + df);
  const cr = clamp(Number.parseInt(square[1]!, 10) - 1 + dr);
  const out: Square[] = [];
  for (let r = cr + 1; r >= cr - 1; r--) {
    for (let f = cf - 1; f <= cf + 1; f++) out.push(`${FILES[f]}${r + 1}`);
  }
  return out;
}
