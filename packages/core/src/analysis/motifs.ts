/**
 * Conservative tactical-motif detection along an engine PV.
 *
 * Principle (research 07): a wrong label is worse than no label. Every tactical detector needs
 * BOTH the geometric pattern on the board AND the payoff inside the PV (the material is really
 * won / the mate is really on the board), otherwise `undefined` is returned.
 *
 * The detectors are written from scratch on top of chess.js + ./board.ts (no GPL/AGPL code).
 */
import { Chess } from 'chess.js';
import type { Move } from 'chess.js';
import type { Color, MotifId, PieceType, Square } from '@gambit/shared';
import type { Board, BoardPiece } from './board.ts';
import {
  ALL_DIRS,
  BISHOP_DIRS,
  ROOK_DIRS,
  VALUE_CP,
  VALUE_PAWNS,
  attackersOf,
  attacksFrom,
  captureCandidates,
  fileOf,
  findKing,
  firstPieceAlong,
  isBetween,
  onBoard,
  opposite,
  parsePlacement,
  rankOf,
  seeCapture,
  seeLoss,
  squareIndex,
  squareName,
  toIndex,
} from './board.ts';
import { applyUci, isCaptureMove, materialSwing } from './pv.ts';

/** Only the first plies of a PV are inspected: a child cannot follow (and we cannot trust) more. */
const MAX_PLIES = 5;
/** A capture winning at least this much (cp, by SEE) is "the" point of the line: explain it first. */
const BIG_CAPTURE_CP = 200;

export interface MotifDetail {
  motif: MotifId;
  /** 0-based index of the PV move on which the motif appears (always a move of the side to move). */
  ply: number;
  /** square of the piece that carries the idea (forking piece, pinning piece, capturing piece …) */
  actor?: Square;
  /** squares of the enemy pieces the idea is aimed at */
  targets: Square[];
}

interface Ply {
  move: Move;
  before: Board;
  after: Board;
  from: number;
  to: number;
}

interface Line {
  fen: string;
  pv: string[];
  side: Color;
  enemy: Color;
  plies: Ply[];
  /** checkmate delivered by PV move index (or -1) */
  mateAt: number;
}

function sliderDirs(type: PieceType): readonly (readonly [number, number])[] {
  if (type === 'b') return BISHOP_DIRS;
  if (type === 'r') return ROOK_DIRS;
  return type === 'q' ? ALL_DIRS : [];
}

function value(piece: BoardPiece): number {
  return VALUE_CP[piece.type];
}

function buildLine(fen: string, pvUci: string[]): Line {
  const chess = new Chess(fen);
  const side = chess.turn();
  const plies: Ply[] = [];
  let mateAt = -1;
  for (let i = 0; i < pvUci.length && i < MAX_PLIES; i++) {
    const move = applyUci(chess, pvUci[i] as string);
    if (!move) break;
    plies.push({
      move,
      before: parsePlacement(move.before),
      after: parsePlacement(move.after),
      from: squareIndex(move.from),
      to: squareIndex(move.to),
    });
    if (chess.isCheckmate()) {
      mateAt = i;
      break;
    }
  }
  return { fen, pv: pvUci, side, enemy: opposite(side), plies, mateAt };
}

/** Net pawns won by the side to move once PV move `throughPly` (0-based) and its exchange are done. */
function gainThrough(line: Line, throughPly: number): number {
  return materialSwing(line.fen, line.pv, throughPly + 1);
}

/** Follows a piece through the opponent's reply: where does the piece from `square` stand before ply `ply`? */
function trackSquare(line: Line, square: number, fromPly: number, toPly: number): number {
  let sq = square;
  for (let i = fromPly; i < toPly && i < line.plies.length; i++) {
    const p = line.plies[i] as Ply;
    if (p.from === sq) sq = p.to;
    else if (p.to === sq) return -1; // captured on the way
  }
  return sq;
}

/** Index (2 or 4 …) of a later move of the side to move that captures the piece first seen on `target` after ply `at`. */
function laterCaptureOf(line: Line, target: number, at: number): number {
  for (let j = at + 2; j < line.plies.length; j += 2) {
    const where = trackSquare(line, target, at + 1, j);
    if (where < 0) return -1;
    const p = line.plies[j] as Ply;
    if (isCaptureMove(p.move) && p.to === where) return j;
  }
  return -1;
}

// ───────────────────────── mates ─────────────────────────

function isBackRankPattern(ply: Ply, enemy: Color): boolean {
  const board = ply.after;
  const king = findKing(board, enemy);
  if (king < 0) return false;
  const backRank = enemy === 'w' ? 0 : 7;
  if (rankOf(king) !== backRank) return false;
  const mover = board[ply.to];
  if (!mover || (mover.type !== 'r' && mover.type !== 'q') || rankOf(ply.to) !== backRank) return false;
  if (!attacksFrom(board, ply.to).includes(king)) return false;
  // Every square in front of the king is blocked by its own men.
  const forward = enemy === 'w' ? 1 : -1;
  let blocked = 0;
  for (const df of [-1, 0, 1]) {
    const f = fileOf(king) + df;
    if (!onBoard(f, backRank + forward)) continue;
    const p = board[toIndex(f, backRank + forward)];
    if (!p || p.color !== enemy) return false;
    blocked += 1;
  }
  return blocked >= 2;
}

function detectMate(line: Line): MotifDetail | undefined {
  if (line.mateAt < 0 || line.mateAt % 2 !== 0) return undefined;
  const moves = line.mateAt / 2 + 1;
  if (moves > 3) return undefined;
  const ply = line.plies[line.mateAt] as Ply;
  const king = findKing(ply.after, line.enemy);
  const targets = king >= 0 ? [squareName(king)] : [];
  if (isBackRankPattern(ply, line.enemy)) return { motif: 'backRankMate', ply: line.mateAt, actor: squareName(ply.to), targets };
  const motif: MotifId = moves === 1 ? 'mateIn1' : moves === 2 ? 'mateIn2' : 'mateIn3';
  return { motif, ply: line.mateAt, actor: squareName(ply.to), targets };
}

// ───────────────────────── captures ─────────────────────────

/**
 * A capture that simply wins material. `freeCapture`: nothing can recapture at all;
 * `hangingPiece`: the piece is defended, but not enough (or a cheaper piece takes it);
 * `pin`: its only defenders are pinned to their king and cannot recapture.
 */
function detectWinningCapture(line: Line, minGainCp: number): MotifDetail | undefined {
  const ply = line.plies[0];
  if (!ply || !isCaptureMove(ply.move) || ply.move.isEnPassant()) return undefined;
  const gainCp = seeCapture(ply.before, ply.from, ply.to);
  if (gainCp < minGainCp) return undefined;
  if (line.plies.length >= 2 && gainThrough(line, 0) < 1) return undefined;
  // Who could take back once the capture is on the board?
  const usable = captureCandidates(ply.after, ply.to, line.enemy);
  const pinnedOut = attackersOf(ply.after, ply.to, line.enemy).filter(
    (from) => (ply.after[from] as BoardPiece).type !== 'k' && !usable.includes(from),
  );
  const motif: MotifId = usable.length > 0 ? 'hangingPiece' : pinnedOut.length > 0 ? 'pin' : 'freeCapture';
  return { motif, ply: 0, actor: squareName(ply.from), targets: [squareName(ply.to)] };
}

// ───────────────────────── double check / discovered attack ─────────────────────────

function detectDoubleCheck(line: Line): MotifDetail | undefined {
  const ply = line.plies[0];
  if (!ply) return undefined;
  const king = findKing(ply.after, line.enemy);
  if (king < 0) return undefined;
  const checkers = attackersOf(ply.after, king, line.side);
  if (checkers.length < 2) return undefined;
  return { motif: 'doubleCheck', ply: 0, actor: squareName(ply.to), targets: [squareName(king)] };
}

function detectDiscoveredAttack(line: Line): MotifDetail | undefined {
  const ply = line.plies[0];
  if (!ply) return undefined;
  const { after, before, from, to } = ply;
  for (let sq = 0; sq < 64; sq++) {
    const slider = after[sq];
    if (!slider || slider.color !== line.side || sq === to) continue;
    for (const dir of sliderDirs(slider.type)) {
      const hit = firstPieceAlong(after, sq, dir);
      if (hit < 0 || !isBetween(sq, from, hit)) continue;
      // The vacated square must have been the blocker (otherwise the attack is not new).
      if (firstPieceAlong(before, sq, dir) !== from) continue;
      const target = after[hit] as BoardPiece;
      if (target.color !== line.enemy || target.type === 'p') continue;
      const detail: MotifDetail = { motif: 'discoveredAttack', ply: 0, actor: squareName(to), targets: [squareName(hit)] };
      if (target.type === 'k') {
        // Discovered check: the moved piece (or anyone) must cash in while the king is busy.
        const cashIn = line.plies.some((p, i) => i % 2 === 0 && isCaptureMove(p.move));
        if (cashIn && gainThrough(line, Math.min(line.plies.length - 1, 4)) >= 1) return detail;
        continue;
      }
      if (seeCapture(after, sq, hit) <= 0) continue;
      const j = laterCaptureOf(line, hit, 0);
      if (j > 0 && (line.plies[j] as Ply).from === sq && gainThrough(line, j) >= 1) return detail;
    }
  }
  return undefined;
}

// ───────────────────────── fork ─────────────────────────

function detectForkAt(line: Line, at: number): MotifDetail | undefined {
  const ply = line.plies[at];
  if (!ply) return undefined;
  const board = ply.after;
  const forker = board[ply.to];
  if (!forker || forker.type === 'k') return undefined;
  // The forking piece must not simply be lost on its new square.
  if (seeLoss(board, ply.to) > 0) return undefined;

  const targets: number[] = [];
  for (const sq of attacksFrom(board, ply.to)) {
    const t = board[sq];
    if (!t || t.color !== line.enemy || t.type === 'p') continue;
    // A real target: the king, or a piece the forker would win material on (more valuable,
    // undefended or under-defended).
    if (t.type === 'k' || seeCapture(board, ply.to, sq) > 0) targets.push(sq);
  }
  if (targets.length < 2) return undefined;

  // Payoff: one of the forked pieces is really captured and the line wins material.
  for (const target of targets) {
    if ((board[target] as BoardPiece).type === 'k') continue;
    const j = laterCaptureOf(line, target, at);
    if (j > 0 && gainThrough(line, j) >= 1) {
      return { motif: 'fork', ply: at, actor: squareName(ply.to), targets: targets.map(squareName) };
    }
  }
  return undefined;
}

function detectFork(line: Line): MotifDetail | undefined {
  const now = detectForkAt(line, 0);
  if (now) return now;
  // "Check (or capture) first, fork next" — only after a forcing first move.
  const first = line.plies[0];
  if (!first) return undefined;
  const forcing = isCaptureMove(first.move) || first.move.san.includes('+');
  return forcing ? detectForkAt(line, 2) : undefined;
}

// ───────────────────────── skewer / pin ─────────────────────────

interface RayPair {
  slider: number;
  front: number;
  back: number;
}

/** Enemy piece pairs lined up behind each other on a ray of one of `side`'s line pieces. */
function rayPairs(board: Board, side: Color): RayPair[] {
  const out: RayPair[] = [];
  for (let sq = 0; sq < 64; sq++) {
    const slider = board[sq];
    if (!slider || slider.color !== side) continue;
    for (const dir of sliderDirs(slider.type)) {
      const front = firstPieceAlong(board, sq, dir);
      if (front < 0 || (board[front] as BoardPiece).color === side) continue;
      const back = firstPieceAlong(board, front, dir);
      if (back < 0 || (board[back] as BoardPiece).color === side) continue;
      out.push({ slider: sq, front, back });
    }
  }
  return out;
}

function detectSkewer(line: Line): MotifDetail | undefined {
  const [first, reply, third] = line.plies;
  if (!first || !reply || !third) return undefined;
  const board = first.after;
  for (const pair of rayPairs(board, line.side)) {
    if (pair.slider !== first.to) continue;
    const slider = board[pair.slider] as BoardPiece;
    const front = board[pair.front] as BoardPiece;
    const back = board[pair.back] as BoardPiece;
    if (back.type === 'k') continue;
    const frontMustMove = front.type === 'k' || (value(front) > value(back) && value(front) > value(slider));
    if (!frontMustMove) continue;
    const stepsAside = reply.from === pair.front;
    const takesBack = third.from === pair.slider && third.to === pair.back && isCaptureMove(third.move);
    if (stepsAside && takesBack && gainThrough(line, 2) >= 1) {
      return { motif: 'skewer', ply: 0, actor: squareName(pair.slider), targets: [squareName(pair.front), squareName(pair.back)] };
    }
  }
  return undefined;
}

function isPin(board: Board, pair: RayPair): boolean {
  const slider = board[pair.slider] as BoardPiece;
  const front = board[pair.front] as BoardPiece;
  const back = board[pair.back] as BoardPiece;
  if (front.type === 'k' || front.type === 'p') return false;
  if (back.type === 'k') return true;
  return value(back) > value(front) && value(back) > value(slider);
}

function detectPin(line: Line): MotifDetail | undefined {
  const first = line.plies[0];
  if (!first) return undefined;
  const pinsBefore = rayPairs(first.before, line.side).filter((p) => isPin(first.before, p));
  for (const pair of rayPairs(first.after, line.side)) {
    if (!isPin(first.after, pair)) continue;
    // Either the pin is new (the same piece was not already pinned to the same piece — a pinner
    // sliding along its line creates nothing), or another piece now piles on the pinned piece.
    const isNew = !pinsBefore.some((p) => p.front === pair.front && p.back === pair.back);
    const pilesOn = first.to !== pair.slider && attacksFrom(first.after, first.to).includes(pair.front);
    if (!isNew && !pilesOn) continue;
    const j = laterCaptureOf(line, pair.front, 0);
    if (j > 0 && gainThrough(line, j) >= 1) {
      return { motif: 'pin', ply: 0, actor: squareName(pair.slider), targets: [squareName(pair.front), squareName(pair.back)] };
    }
  }
  return undefined;
}

// ───────────────────────── removing the defender ─────────────────────────

function detectRemoveDefender(line: Line): MotifDetail | undefined {
  const [first, reply, third] = line.plies;
  if (!first || !reply || !third) return undefined;
  if (!isCaptureMove(first.move) || !isCaptureMove(third.move) || third.to === first.to) return undefined;
  // The classic shape: take the defender, it is taken back, then collect the prize.
  if (!isCaptureMove(reply.move) || reply.to !== first.to) return undefined;
  const board = first.before;
  const prize = board[third.to];
  if (!prize || prize.color !== line.enemy || prize.type === 'k') return undefined;
  // The piece captured first was a defender of the prize …
  if (!attackersOf(board, third.to, line.enemy).includes(first.to)) return undefined;
  // … the prize did not move in between …
  if (trackSquare(line, third.to, 1, 2) !== third.to) return undefined;
  // … and taking it straight away would not have won anything.
  const direct = captureCandidates(board, third.to, line.side);
  if (direct.some((from) => seeCapture(board, from, third.to) > 0)) return undefined;
  if (gainThrough(line, 2) < 1) return undefined;
  return { motif: 'removeDefender', ply: 0, actor: squareName(first.from), targets: [squareName(first.to), squareName(third.to)] };
}

// ───────────────────────── trapped piece ─────────────────────────

function detectTrappedPiece(line: Line): MotifDetail | undefined {
  const [first, , third] = line.plies;
  if (!first || !third || !isCaptureMove(third.move)) return undefined;
  if (first.move.san.includes('+')) return undefined;
  const board = first.after;
  const replies = new Chess(first.move.after).moves({ verbose: true });

  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece || piece.color !== line.enemy || piece.type === 'p' || piece.type === 'k') continue;
    // It is attacked and would be lost where it stands — and that is new.
    if (seeLoss(board, sq) <= 0 || seeLoss(first.before, sq) > 0) continue;
    // Every square it can go to loses at least a pawn's worth as well.
    const escapes = replies.filter((m) => squareIndex(m.from) === sq);
    const hasEscape = escapes.some((m) => {
      const next = parsePlacement(m.after);
      const dest = squareIndex(m.to);
      const won = m.captured ? VALUE_CP[m.captured] : 0;
      return seeLoss(next, dest) - won <= 0;
    });
    if (hasEscape) continue;
    // Payoff: the PV really collects this piece.
    const where = trackSquare(line, sq, 1, 2);
    if (where < 0 || third.to !== where) continue;
    if (gainThrough(line, 2) < 1) continue;
    return { motif: 'trappedPiece', ply: 0, actor: squareName(first.to), targets: [squareName(sq)] };
  }
  return undefined;
}

// ───────────────────────── promotion ─────────────────────────

function detectPromotion(line: Line, onlyFirstMove: boolean): MotifDetail | undefined {
  for (let i = 0; i < line.plies.length; i += 2) {
    if (onlyFirstMove && i > 0) break;
    const ply = line.plies[i] as Ply;
    if (!ply.move.isPromotion()) continue;
    if (gainThrough(line, i) < 1) return undefined;
    return { motif: 'promotion', ply: i, actor: squareName(ply.from), targets: [squareName(ply.to)] };
  }
  return undefined;
}

// ───────────────────────── public API ─────────────────────────

/**
 * Like `detectMotif`, but also tells where the motif happens (for arrows / highlights).
 * Throws on an invalid FEN; an illegal PV move just ends the inspected line.
 */
export function describeMotif(fen: string, pvUci: string[]): MotifDetail | undefined {
  const line = buildLine(fen, pvUci);
  if (line.plies.length === 0) return undefined;
  // A line in which the side to move gets mated has nothing to teach about ITS tactics.
  if (line.mateAt >= 0 && line.mateAt % 2 !== 0) return undefined;
  return (
    detectMate(line) ??
    detectPromotion(line, true) ??
    detectWinningCapture(line, BIG_CAPTURE_CP) ??
    detectDoubleCheck(line) ??
    detectFork(line) ??
    detectSkewer(line) ??
    detectPin(line) ??
    detectDiscoveredAttack(line) ??
    detectRemoveDefender(line) ??
    detectTrappedPiece(line) ??
    detectWinningCapture(line, 100) ??
    detectPromotion(line, false)
  );
}

/**
 * The tactical motif that the side to move at `fen` realises along `pvUci` (first 1–5 plies), or
 * `undefined` when nothing is recognised with confidence.
 *
 * Detection order (first hit wins): mate in ≤ 3 (`backRankMate` when the pattern fits, else
 * `mateIn1/2/3`) → immediate `promotion` → a capture winning ≥ 2 pawns outright (`freeCapture`
 * when nothing can recapture, `hangingPiece` when it is merely under-defended, `pin` when its
 * defenders are pinned) → `doubleCheck` → `fork` (on move 1, or on move 2 after a check/capture)
 * → `skewer` → `pin` → `discoveredAttack` → `removeDefender` → `trappedPiece` → small winning
 * capture → later `promotion`.
 *
 * `badTrade` needs the previous move and is therefore only produced by `judgeMove`;
 * `kingSafety`, `development` and `center` are positional labels and never returned here.
 */
export function detectMotif(fen: string, pvUci: string[]): MotifId | undefined {
  return describeMotif(fen, pvUci)?.motif;
}

/** Value in pawns of a piece type (p=1, n=b=3, r=5, q=9, k=0). */
export function pieceValuePawns(type: PieceType): number {
  return VALUE_PAWNS[type];
}
