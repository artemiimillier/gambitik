/**
 * «Что хочет соперник?» — the opponent's threat in the child's position, found with a NULL MOVE: the side to move
 * passes, the opponent moves twice. The engine searches the null-move position (the game runs that search in the
 * background, after the normal analysis of the child's position); this module turns its best line into a
 * contract `Threat` and describes it in spoken Russian. A static mate-in-one check needs no engine at all.
 *
 * A threat is only reported when a child could see it and it really costs something: a mate within three moves,
 * or at least two pawns of material along the line. Positional "threats" are not explainable — none is returned.
 */
import { Chess } from 'chess.js';
import type { EngineLine, MotifId, PieceType, Square, Threat } from '@gambit/shared';
import { describeMotif } from '../analysis/motifs.ts';
import type { MotifDetail } from '../analysis/motifs.ts';
import { materialSwing } from '../analysis/pv.ts';
import { endangeredSquares, parseUci, pieceAt } from './board.ts';
import { motifAccRu, pieceOnRu, studentWords } from './brief.ts';
import type { StudentWords } from './brief.ts';
import { isMateMotif } from './motifs.ts';
import { pieceNameRu, sanToSpokenRu } from './spoken.ts';

/** A null-move line must win at least this much material (pawns) to count as a threat. */
export const THREAT_MIN_MATERIAL_PAWNS = 2;
/** …or mate within this many moves. */
export const THREAT_MATE_WITHIN = 3;

/**
 * The same position with the OTHER side to move (en passant cleared). Null when the side to move is in check
 * (a null move is illegal then) or the FEN is broken.
 */
export function nullMoveFen(fen: string): string | null {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  if (chess.inCheck()) return null;
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) return null;
  fields[1] = fields[1] === 'w' ? 'b' : 'w';
  fields[3] = '-';
  const flipped = fields.join(' ');
  try {
    return new Chess(flipped).fen();
  } catch {
    return null;
  }
}

function mateMotif(n: number): MotifId {
  return n <= 1 ? 'mateIn1' : n === 2 ? 'mateIn2' : 'mateIn3';
}

/**
 * The opponent's threat in `fen` (the child to move) from the engine's best line of `nullMoveFen(fen)`.
 * `line` scores are from the side-to-move point of view of the null-move position, i.e. the OPPONENT's.
 */
export function threatFromNullMoveLine(fen: string, line: Pick<EngineLine, 'cp' | 'mate' | 'pvUci'>): Threat | null {
  const nullFen = nullMoveFen(fen);
  const pv = line.pvUci.slice(0, 8);
  const first = pv[0];
  if (!nullFen || !first) return null;
  let san: string;
  try {
    const chess = new Chess(nullFen);
    const parts = parseUci(first);
    if (!parts) return null;
    san = chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion }).san;
  } catch {
    return null;
  }
  const mateSoon = line.mate !== null && line.mate > 0 && line.mate <= THREAT_MATE_WITHIN;
  let detail: MotifDetail | undefined;
  try {
    detail = describeMotif(nullFen, pv);
  } catch {
    detail = undefined;
  }
  const motif = detail?.motif;
  if (mateSoon) {
    const mate = isMateMotif(motif) ? (motif as MotifId) : mateMotif(line.mate as number);
    return { uci: first, san, motif: mate, targetSquares: endangeredSquares(nullFen, pv, { mateThreat: true }), gainCp: 10_000 };
  }
  let swing = 0;
  try {
    swing = materialSwing(nullFen, pv, 4);
  } catch {
    swing = 0;
  }
  if (swing < THREAT_MIN_MATERIAL_PAWNS) return null;
  const named: MotifId = motif && !isMateMotif(motif) ? motif : 'hangingPiece';
  return { uci: first, san, motif: named, targetSquares: forkTargets(fen, detail) ?? endangeredSquares(nullFen, pv), gainCp: Math.round(swing * 100) };
}

/**
 * A fork made by the threat move itself: its targets are the pieces the forking piece attacks (G06 4.Кg5 → Кxf7:
 * «ферзь на дэ восемь, ладья на аш восемь»), not every square the line touches (the pawn it takes, a knight that is
 * only attacked later). Most valuable first. Null when the fork comes later in the line.
 */
function forkTargets(fen: string, detail: MotifDetail | undefined): Square[] | null {
  if (!detail || detail.motif !== 'fork' || detail.ply !== 0 || detail.targets.length < 2) return null;
  const VALUE: Readonly<Record<PieceType, number>> = { k: 100, q: 9, r: 5, b: 3, n: 3, p: 1 };
  const present = detail.targets.map((sq) => ({ sq, p: pieceAt(fen, sq) })).filter((x): x is { sq: Square; p: NonNullable<ReturnType<typeof pieceAt>> } => !!x.p);
  if (present.length < 2) return null;
  return present.sort((a, b) => VALUE[b.p.piece] - VALUE[a.p.piece]).map((x) => x.sq);
}

/** Static check (no engine): can the opponent mate in one if the child passes? */
export function mateInOneThreat(fen: string): Threat | null {
  const nullFen = nullMoveFen(fen);
  if (!nullFen) return null;
  const chess = new Chess(nullFen);
  for (const move of chess.moves({ verbose: true })) {
    chess.move(move);
    const mate = chess.isCheckmate();
    chess.undo();
    if (mate) {
      const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
      return { uci, san: move.san, motif: 'mateIn1', targetSquares: endangeredSquares(nullFen, [uci], { mateThreat: true }), gainCp: 10_000 };
    }
  }
  return null;
}

/** The piece that makes the threat, in the nominative: «конь соперника». */
function threatActorRu(fen: string, threat: Threat): string | null {
  const parts = parseUci(threat.uci);
  const nullFen = nullMoveFen(fen);
  if (!parts || !nullFen) return null;
  const actor = pieceAt(nullFen, parts.from);
  return actor ? `${pieceNameRu(actor.piece, 'nom')} соперника` : null;
}

/** The child's pieces standing on the threat's target squares: «ладья на а один, король на е один». */
export function threatTargetsRu(fen: string, threat: Threat): string | null {
  const names: string[] = [];
  for (const sq of threat.targetSquares.slice(0, 3)) {
    const p = pieceAt(fen, sq);
    if (p) names.push(pieceOnRu(p.piece, sq));
  }
  return names.length > 0 ? names.join(', ') : null;
}

/**
 * The threat as facts for the voice model: «Соперник грозит: конь бьёт на цэ семь — вилка. Под прицелом: король на
 * е восемь, ладья на а восемь.» The threat move is the OPPONENT's — never the child's best move.
 */
export function threatFactsRu(fen: string, threat: Threat, s: StudentWords = studentWords()): string[] {
  const parts = parseUci(threat.uci);
  const nullFen = nullMoveFen(fen);
  const spoken = nullFen && parts ? sanToSpokenRu(threat.san, nullFen) : '';
  const actor = threatActorRu(fen, threat);
  const what = isMateMotif(threat.motif) ? 'мат' : motifAccRu(threat.motif);
  const out: string[] = [];
  const move = spoken && spoken !== 'этот ход' ? spoken : null;
  if (move) out.push(`Если ${s.nom} ничего не сделает, соперник сыграет ${move} и получит ${what}`);
  else out.push(`Соперник грозит: ${what}${actor ? ` (${actor})` : ''}`);
  const targets = threatTargetsRu(fen, threat);
  if (targets) out.push(`Под прицелом: ${targets}`);
  return out;
}

/** Piece type standing on the first target square — used by the warning templates. */
export function threatTargetPiece(fen: string, threat: Threat): { piece: PieceType; square: Square } | null {
  for (const sq of threat.targetSquares) {
    const p = pieceAt(fen, sq);
    if (p && p.piece !== 'k') return { piece: p.piece, square: sq };
  }
  return null;
}
