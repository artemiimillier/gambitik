/**
 * What the code must PROVE before the lesson says it (docs/TEACHING.md §6): the engine gap of a quiz by the
 * MultiPV closure, the true / provably-false predicates of the quiz buttons, the danger guards (a poisoned «hanging»
 * piece, «спасаем» only when the advice saves it), the «лучше всего» gate and the sub-cases (variants) of the ideas.
 *
 * Pure chess: chess.js + the static geometry of ../../analysis. No words here — the lesson picks them elsewhere.
 * The detectors of ../moveIdeas.ts avoid false positives; they never prove a negative. A «wrong» button is used only
 * when its FALSE predicate below holds on the board.
 */
import { Chess } from 'chess.js';
import type { AnalysisResult, Color, EngineLine, PieceType, Square, Threat } from '@gambit/shared';
import {
  VALUE_CP,
  attackersOf,
  attacksFrom,
  captureCandidates,
  fileOf,
  findKing,
  isBetween,
  materialOf,
  opposite,
  parsePlacement,
  rankOf,
  seeCapture,
  seeLoss,
  squareIndex,
  squareName,
} from '../../analysis/board.ts';
import type { Board } from '../../analysis/board.ts';
import { winPct } from '../../analysis/eval.ts';
import { findHanging } from '../../analysis/hanging.ts';
import { resolveUciMove } from '../board.ts';
import type { ResolvedMove } from '../board.ts';
import type { MoveIdea } from '../moveIdeas.ts';
import { isMateMotif } from '../motifs.ts';
import { mateInOneThreat } from '../threats.ts';
import type { TeachDanger } from '../teacher.ts';

// ───────────────────────── thresholds (win%, lichess formula) ─────────────────────────

/** A quiz (and the «лучше всего» lead) needs at least this analysis depth. */
export const QUIZ_MIN_DEPTH = 12;
/** whichPiece: every move within this many win% of the best is of one piece type… */
export const WHICH_PIECE_NEAR = 5;
/** …and the other types shown as buttons are proven this much worse. */
export const WHICH_PIECE_GAP = 8;
/** canCapture: «бесплатно» / «размен» only when the capture is proven within this of the best… */
export const CAPTURE_NEAR = 5;
/** …«потеряем» only when it is proven this much worse. */
export const CAPTURE_LOSE_GAP = 10;
/** checkEscape: the best way out is at least this much better than every other available way. */
export const ESCAPE_GAP = 5;
/** «лучше всего / сильнее всего»: the advice is the engine's first move and the second is this much worse. */
export const BEST_CLAIM_GAP = 3;

const CENTER: readonly number[] = ['d4', 'e4', 'd5', 'e5'].map(squareIndex);
const MINOR_HOME: Readonly<Record<Color, Readonly<Record<'n' | 'b', readonly number[]>>>> = {
  w: { n: ['b1', 'g1'].map(squareIndex), b: ['c1', 'f1'].map(squareIndex) },
  b: { n: ['b8', 'g8'].map(squareIndex), b: ['c8', 'f8'].map(squareIndex) },
};

function safeBoard(fen: string): Board | null {
  try {
    return parsePlacement(fen);
  } catch {
    return null;
  }
}

function safeChess(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

function uciOf(m: { from: string; to: string; promotion?: string }): string {
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

// ───────────────────────── the engine proof (MultiPV closure) ─────────────────────────

/** Win% (0..100) of an engine line, from the point of view of the side to move (the child). */
export function lineWin(l: Pick<EngineLine, 'cp' | 'mate'>): number {
  return winPct({ cp: l.cp, mate: l.mate });
}

/**
 * What the analysis proves about the moves of a position. MultiPV gives the top-k moves in order, so any legal move
 * NOT listed is at most as good as the last listed line (`floor`) — the closure rule of §6.1. When every legal move is
 * listed there is no unlisted move (`floor` = 0).
 */
export interface EngineProof {
  depth: number;
  /** win% of the first line */
  best: number;
  bestUci: string;
  /** an upper bound for every legal move that is not in `known` */
  floor: number;
  /** uci → win% of the moves the engine scored (MultiPV lines, then `searchmoves` checks) */
  known: ReadonlyMap<string, number>;
  lines: readonly { uci: string; win: number; mate: number | null }[];
}

export function engineProof(fen: string, analysis: AnalysisResult | null | undefined, verified?: readonly EngineLine[] | null): EngineProof | null {
  if (!analysis) return null;
  const raw = [...analysis.lines].filter((l) => (l.pvUci[0] ?? '') !== '').sort((a, b) => a.multipv - b.multipv);
  if (raw.length === 0) return null;
  const depth = Math.max(analysis.depth ?? 0, ...raw.map((l) => l.depth));
  const lines = raw.map((l) => ({ uci: (l.pvUci[0] as string).toLowerCase(), win: lineWin(l), mate: l.mate }));
  const known = new Map<string, number>();
  for (const l of lines) if (!known.has(l.uci)) known.set(l.uci, l.win);
  for (const v of verified ?? []) {
    const u = v.pvUci[0]?.toLowerCase();
    if (u && !known.has(u)) known.set(u, lineWin(v));
  }
  const legal = safeChess(fen)?.moves().length ?? Number.POSITIVE_INFINITY;
  const listed = new Set(lines.map((l) => l.uci)).size;
  const first = lines[0] as { uci: string; win: number };
  const last = lines[lines.length - 1] as { win: number };
  return { depth, best: first.win, bestUci: first.uci, floor: listed >= legal ? 0 : last.win, known, lines };
}

/** The move is scored and within `gap` win% of the best. */
export function provenWithin(p: EngineProof, uci: string, gap: number): boolean {
  const w = p.known.get(uci.toLowerCase());
  return w !== undefined && w >= p.best - gap;
}

/** The move is at least `gap` win% worse than the best (its own score, or the closure bound when unlisted). */
export function provenWorse(p: EngineProof, uci: string, gap: number): boolean {
  const w = p.known.get(uci.toLowerCase());
  return (w ?? p.floor) <= p.best - gap;
}

/** The best win% any of these moves can have (listed: its score; unlisted: the closure bound). −1 for none. */
export function upperBound(p: EngineProof, ucis: readonly string[]): number {
  let out = -1;
  for (const u of ucis) out = Math.max(out, p.known.get(u.toLowerCase()) ?? p.floor);
  return out;
}

/**
 * «Лучше всего / сильнее всего» (docs/TEACHING.md §2.3): only when the advice IS the engine's first move at a real
 * depth and the second line is at least `BEST_CLAIM_GAP` win% worse (or there is no second line).
 */
export function allowBestClaim(fen: string, analysis: AnalysisResult | null | undefined, uci: string | undefined): boolean {
  if (!uci) return false;
  const p = engineProof(fen, analysis);
  if (!p || p.depth < QUIZ_MIN_DEPTH || p.bestUci !== uci.toLowerCase()) return false;
  const second = p.lines.find((l) => l.uci !== p.bestUci);
  return !second || second.win <= p.best - BEST_CLAIM_GAP;
}

// ───────────────────────── the facts of one move ─────────────────────────

export interface MoveFacts {
  fenBefore: string;
  uci: string;
  mv: ResolvedMove;
  b0: Board;
  b1: Board;
  from: number;
  to: number;
  /** the side that made the move */
  mover: Color;
  /** the other side (whose pieces the move may attack) */
  other: Color;
}

export function moveFacts(fenBefore: string, uci: string): MoveFacts | null {
  const mv = resolveUciMove(fenBefore, uci);
  if (!mv) return null;
  const b0 = safeBoard(fenBefore);
  const b1 = safeBoard(mv.fenAfter);
  if (!b0 || !b1) return null;
  return { fenBefore, uci, mv, b0, b1, from: squareIndex(mv.from), to: squareIndex(mv.to), mover: mv.color, other: opposite(mv.color) };
}

/** Squares of `color`'s pieces (the king left out) attacked by any piece of the other side (pseudo-legal). */
function attackedPieces(board: Board, color: Color): Set<number> {
  const out = new Set<number>();
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (!p || p.color !== color || p.type === 'k') continue;
    if (attackersOf(board, sq, opposite(color)).length > 0) out.add(sq);
  }
  return out;
}

function centerHits(board: Board, sq: number): number {
  return attacksFrom(board, sq).filter((t) => CENTER.includes(t)).length;
}

function relativeRank(sq: number, color: Color): number {
  return color === 'w' ? rankOf(sq) : 7 - rankOf(sq);
}

/** The weak pawn square next to `color`'s king (f2 / f7). */
function weakSquareOf(color: Color): number {
  return squareIndex(color === 'w' ? 'f2' : 'f7');
}

/** The move takes a minor piece off its home square (the «вывести фигуру» of §6.1). */
export function isMinorFromHome(f: Pick<MoveFacts, 'mv' | 'from' | 'mover'>): boolean {
  const p = f.mv.piece;
  if (p !== 'n' && p !== 'b') return false;
  return MINOR_HOME[f.mover][p].includes(f.from);
}

// ───────────────────────── the quiz buttons: TRUE and provably FALSE ─────────────────────────

/** The goals a quiz button can name (`v3.quiz.opt.*`; stages 1–2 read five of them as `v3.quiz.cat.*`). */
export type GoalOption =
  | 'attack'
  | 'capture'
  | 'mate'
  | 'check'
  | 'fork'
  | 'develop'
  | 'center'
  | 'castle'
  | 'defend'
  | 'escape'
  | 'trade'
  | 'queenOut'
  | 'aimWeak'
  | 'openLine'
  | 'promote'
  | 'kingForward';

export const GOAL_OPTIONS: readonly GoalOption[] = ['attack', 'capture', 'mate', 'check', 'fork', 'develop', 'center', 'castle', 'defend', 'escape', 'trade', 'queenOut', 'aimWeak', 'openLine', 'promote', 'kingForward'];
/** The five fixed categories of «Что задумал соперник?» at stages 1–2 (`v3.quiz.cat.<id>`). */
export const YOUNG_CATEGORIES: readonly GoalOption[] = ['attack', 'capture', 'develop', 'center', 'castle'];

/**
 * Buttons that say nearly the same as the answer: never a distractor next to it, even when the predicate calls them
 * false (a child hears «Нападает» and «Хочет съесть» as one thing).
 */
export const OPTION_NEIGHBOURS: Readonly<Record<GoalOption, readonly GoalOption[]>> = {
  attack: ['capture', 'fork', 'check', 'mate', 'aimWeak'],
  capture: ['attack', 'trade', 'fork'],
  mate: ['check', 'attack', 'aimWeak'],
  check: ['attack', 'mate', 'fork'],
  fork: ['attack', 'capture', 'check'],
  develop: ['queenOut', 'openLine'],
  center: ['openLine'],
  castle: ['defend', 'escape'],
  defend: ['escape', 'castle'],
  escape: ['defend', 'castle'],
  trade: ['capture', 'attack'],
  queenOut: ['develop', 'attack'],
  aimWeak: ['attack', 'mate'],
  openLine: ['develop', 'center'],
  promote: ['kingForward'],
  kingForward: ['promote'],
};

/** The button of an idea (null: the idea has no button). */
export function ideaOption(id: string): GoalOption | null {
  switch (id) {
    case 'attack':
      return 'attack';
    case 'fork':
      return 'fork';
    case 'freeCapture':
    case 'winMaterial':
    case 'recapture':
      return 'capture';
    case 'trade':
      return 'trade';
    case 'check':
      return 'check';
    case 'mate':
    case 'mateSoon':
    case 'threatMate':
      return 'mate';
    case 'develop':
      return 'develop';
    case 'centerPawn':
    case 'fightCenter':
    case 'supportCenter':
      return 'center';
    case 'castle':
      return 'castle';
    case 'defend':
    case 'block':
      return 'defend';
    case 'escape':
      return 'escape';
    case 'aimWeakSquare':
      return 'aimWeak';
    case 'openLine':
      return 'openLine';
    case 'promotion':
    case 'passedPawn':
      return 'promote';
    case 'kingActivity':
      return 'kingForward';
    default:
      return null;
  }
}

export interface OptionEnv {
  /**
   * the engine null-move threat of the position AFTER the move with the other side to move: a Threat, null = searched
   * and none, undefined = not known (then «мат» is never provably false)
   */
  threatAfter?: Threat | null;
  /** static only (no search after the move, e.g. the child's own move of «Зачем мы так сходили?») */
  staticMate?: boolean;
}

/** Is the button TRUE for the move (it says what the move does)? */
export function optionTrue(opt: GoalOption, f: MoveFacts): boolean {
  const { mv, b0, b1, from, to, mover, other } = f;
  switch (opt) {
    case 'capture':
    case 'trade':
      return !!mv.captured;
    case 'check':
      return mv.givesCheck;
    case 'mate':
      return mv.givesMate || safeMateInOne(mv.fenAfter);
    case 'castle':
      return mv.isCastle;
    case 'queenOut':
      return mv.piece === 'q';
    case 'develop':
      return isMinorFromHome(f);
    case 'center':
      return CENTER.includes(to) || centerHits(b1, to) > centerHits(b0, from);
    case 'attack': {
      const before = attackedPieces(b0, other);
      for (const sq of attackedPieces(b1, other)) if (!before.has(sq) && b1[sq]?.type !== 'p') return true;
      return false;
    }
    case 'fork':
      return attacksFrom(b1, to).filter((t) => b1[t]?.color === other && b1[t]?.type !== 'p').length >= 2;
    case 'defend':
      return attacksFrom(b1, to).some((t) => b1[t]?.color === mover && b1[t]?.type !== 'k' && attackersOf(b1, t, other).length > 0);
    case 'escape':
      return attackersOf(b0, from, other).length > 0 && seeLoss(b1, to) === 0;
    case 'aimWeak':
      return attacksFrom(b1, to).includes(weakSquareOf(other));
    case 'openLine':
      return slidersGained(f);
    case 'promote':
      return !!mv.promotion || (mv.piece === 'p' && relativeRank(to, mover) >= 5);
    case 'kingForward':
      return mv.piece === 'k' && !mv.isCastle;
  }
}

/** Is the button provably FALSE for the move (docs/TEACHING.md §6.1)? Only then it may be a wrong answer. */
export function optionFalse(opt: GoalOption, f: MoveFacts, env: OptionEnv = {}): boolean {
  const { mv, b0, b1, from, to, mover, other } = f;
  switch (opt) {
    case 'capture':
    case 'trade':
      return !mv.captured;
    case 'check':
      return !mv.givesCheck;
    case 'mate': {
      if (mv.givesMate || mv.givesCheck || safeMateInOne(mv.fenAfter)) return false;
      if (env.staticMate) return true;
      return env.threatAfter === null || (!!env.threatAfter && !isMateMotif(env.threatAfter.motif));
    }
    case 'castle': {
      if (mv.isCastle || mv.piece === 'k') return false;
      // a piece leaving the king's back rank between king and rook «prepares» the castle — not provably false
      const home = mover === 'w' ? 0 : 7;
      return !(rankOf(from) === home && [1, 2, 3, 5, 6].includes(fileOf(from)));
    }
    case 'queenOut':
      return mv.piece !== 'q';
    case 'develop':
      return !isMinorFromHome(f);
    case 'center':
      return !CENTER.includes(to) && centerHits(b1, to) === 0;
    case 'attack': {
      // a check is an attack on the king (`attackedPieces` leaves the king out): «Напасть» is never wrong for it
      if (mv.givesCheck) return false;
      const before = attackedPieces(b0, other);
      for (const sq of attackedPieces(b1, other)) if (!before.has(sq)) return false;
      return true;
    }
    case 'fork':
      return attacksFrom(b1, to).filter((t) => b1[t]?.color === other).length < 2;
    case 'defend':
      return !attacksFrom(b1, to).some((t) => b1[t]?.color === mover && b1[t]?.type !== 'k');
    case 'escape':
      return attackersOf(b0, from, other).length === 0;
    case 'aimWeak':
      return !attacksFrom(b1, to).includes(weakSquareOf(other));
    case 'openLine':
      return !slidersGained(f);
    case 'promote':
      return !mv.promotion && (mv.piece !== 'p' || relativeRank(to, mover) < 5);
    case 'kingForward':
      return mv.piece !== 'k';
  }
}

/** Some own bishop / rook / queen (not the moved piece) sees more squares after the move. */
function slidersGained(f: MoveFacts): boolean {
  for (let sq = 0; sq < 64; sq++) {
    const p = f.b1[sq];
    if (!p || p.color !== f.mover || sq === f.to || (p.type !== 'b' && p.type !== 'r' && p.type !== 'q')) continue;
    const q = f.b0[sq];
    if (!q || q.type !== p.type || q.color !== p.color) continue;
    if (attacksFrom(f.b1, sq).length > attacksFrom(f.b0, sq).length) return true;
  }
  return false;
}

function safeMateInOne(fenAfter: string): boolean {
  try {
    return mateInOneThreat(fenAfter) !== null;
  } catch {
    return false;
  }
}

// ───────────────────────── dangers (§6.2) ─────────────────────────

/** Can the side to move in `fen` mate at once? (After the child's advice: can the opponent mate in one?) */
export function sideToMoveMatesInOne(fen: string): boolean {
  const chess = safeChess(fen);
  if (!chess) return false;
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    const mate = chess.isCheckmate();
    chess.undo();
    if (mate) return true;
  }
  return false;
}

/** The SEE loss of the child's piece on `sq` (0 when not en prise). */
export function hangingLoss(fen: string, sq: Square): number {
  try {
    return findHanging(fen).find((h) => h.square === sq)?.seeLossCp ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The poisoned-hanging guard (§6.2). The static «hanging» piece is checked against the engine's null-move threat
 * search of the same position: search done and no threat → a piece with SEE ≥ 200 cannot be won with profit (taking it
 * loses to a tactic): no danger. A bigger threat elsewhere → that threat is the danger. Search unknown → as found.
 */
export function guardDanger(danger: TeachDanger | null, a: { fen: string; threat?: Threat | null; inCheck?: boolean }): TeachDanger | null {
  if (!danger || danger.kind !== 'hanging' || !danger.piece || a.inCheck) return danger;
  if (a.threat === undefined) return danger;
  const sq = danger.piece.square;
  const loss = hangingLoss(a.fen, sq);
  if (a.threat === null) return loss >= 200 ? null : danger;
  const t = a.threat;
  if (t.targetSquares.includes(sq)) return danger;
  if (t.gainCp >= loss) {
    const from = t.uci.slice(0, 2);
    const to = t.uci.slice(2, 4);
    return {
      kind: isMateMotif(t.motif) ? 'mate' : 'threat',
      factRu: danger.factRu,
      textRu: danger.textRu,
      squares: t.targetSquares.slice(0, 2),
      arrows: from && to ? [{ from, to }] : [],
      ...(t.motif === 'fork' ? { conceptId: 'fork' } : {}),
    };
  }
  return danger;
}

/**
 * Does the advice deal with the danger (§6.2 «спасаем {коня}» only when after the advice the piece is safe)?
 * hanging: the piece moved to a safe square or stays and is no longer en prise; mate: the opponent has no mate in one
 * after it; check: any legal move answers it; threat: every threatened piece is safe after it.
 */
export function adviceSaves(danger: Pick<TeachDanger, 'kind' | 'piece' | 'squares'>, fen: string, uci: string): boolean {
  const mv = resolveUciMove(fen, uci);
  if (!mv) return false;
  if (danger.kind === 'check') return true;
  if (danger.kind === 'mate') return !sideToMoveMatesInOne(mv.fenAfter);
  const b0 = safeBoard(fen);
  const b1 = safeBoard(mv.fenAfter);
  if (!b0 || !b1) return false;
  const squares = danger.kind === 'hanging' ? (danger.piece ? [danger.piece.square] : []) : danger.squares;
  let any = false;
  for (const sq of squares) {
    const idx = squareIndex(sq);
    const p0 = b0[idx];
    if (!p0 || p0.color !== mv.color || p0.type === 'k') continue;
    any = true;
    if (mv.from === sq) {
      if (seeLoss(b1, squareIndex(mv.to)) !== 0) return false;
      continue;
    }
    const p1 = b1[idx];
    if (!p1 || p1.type !== p0.type || p1.color !== p0.color) return false;
    if (seeLoss(b1, idx) !== 0) return false;
  }
  return any || danger.kind === 'threat';
}

// ───────────────────────── checkEscape (§6.1) ─────────────────────────

export type EscapeWay = 'escKing' | 'escBlock' | 'escCapture';

export interface EscapeProof {
  correct: EscapeWay;
  available: EscapeWay[];
  /** the checking piece(s) */
  checkers: Square[];
  king: Square;
}

/**
 * «Шах! Как спасаемся?»: the three ways (a non-king piece takes the checker; any king move; a non-king move between the
 * checker and the king). No quiz when the best move is a king capture (it is both «уйти» and «съесть»), when the best
 * reply is still mated, on a double check at stages 3+, or when the best way is not ≥ `ESCAPE_GAP` win% better than
 * every other AVAILABLE way (proven by the closure bound).
 */
export function checkEscapeProof(fen: string, p: EngineProof | null, stage: number): EscapeProof | null {
  if (!p || p.depth < QUIZ_MIN_DEPTH) return null;
  const chess = safeChess(fen);
  const b0 = safeBoard(fen);
  if (!chess || !b0 || !chess.inCheck()) return null;
  const me = chess.turn();
  const king = findKing(b0, me);
  if (king < 0) return null;
  const checkers = attackersOf(b0, king, opposite(me));
  if (checkers.length === 0) return null;
  if (checkers.length >= 2 && stage >= 3) return null;
  const best = p.lines[0];
  if (!best || (best.mate !== null && best.mate < 0)) return null;
  const ways = new Map<EscapeWay, string[]>();
  let bestWay: EscapeWay | null = null;
  let bestKingCapture = false;
  for (const m of chess.moves({ verbose: true })) {
    const uci = uciOf(m).toLowerCase();
    const to = squareIndex(m.to);
    let way: EscapeWay;
    if (m.piece === 'k') way = 'escKing';
    else if (checkers.includes(to) || (m.isEnPassant() && checkers.includes(squareIndex(`${m.to[0]}${m.from[1]}`)))) way = 'escCapture';
    else if (checkers.length === 1 && isBetween(checkers[0] as number, to, king)) way = 'escBlock';
    else continue;
    ways.set(way, [...(ways.get(way) ?? []), uci]);
    if (uci === best.uci) {
      bestWay = way;
      bestKingCapture = m.piece === 'k' && !!m.captured;
    }
  }
  if (!bestWay || bestKingCapture) return null;
  for (const [way, moves] of ways) {
    if (way === bestWay) continue;
    if (upperBound(p, moves) > p.best - ESCAPE_GAP) return null;
  }
  return { correct: bestWay, available: [...ways.keys()], checkers: checkers.map(squareName), king: squareName(king) };
}

// ───────────────────────── canCapture (§6.1) ─────────────────────────

export type CaptureBucket = 'capYes' | 'capTrade' | 'capLose';

export interface CaptureProof {
  bucket: CaptureBucket;
  /** the capture the question shows (its arrow) */
  uci: string;
  from: Square;
  target: Square;
  victim: PieceType;
  mover: PieceType;
}

/**
 * «Выгодно ли съесть {коня}?» — only the three unambiguous cases, for one target whose every legal capturer (no en
 * passant) falls into the same bucket: FREE = SEE ≥ 100, nobody recaptures, and the capture is the advice or proven
 * within `CAPTURE_NEAR`; TRADE = SEE 0 between equal pieces, proven within `CAPTURE_NEAR`; LOSE = SEE ≤ −100 and proven
 * ≥ `CAPTURE_LOSE_GAP` worse. An engine-approved sacrifice (Сxf7+) is never «потеряем».
 *
 * The answer is followed by the advice arrow (§2.4): «да» and «размен» only when that capture IS the advice (after «Да,
 * бесплатно» the arrow shows that very capture), «нет» only when the advice is another move. No advice — no question.
 */
export function canCaptureProof(fen: string, p: EngineProof | null, adviceUci: string | null | undefined): CaptureProof | null {
  if (!p || p.depth < QUIZ_MIN_DEPTH || !adviceUci) return null;
  const chess = safeChess(fen);
  const b0 = safeBoard(fen);
  if (!chess || !b0 || chess.inCheck()) return null;
  const them = opposite(chess.turn());
  const byTarget = new Map<string, { uci: string; from: string; piece: PieceType; captured: PieceType }[]>();
  for (const m of chess.moves({ verbose: true })) {
    if (!m.captured || m.isEnPassant()) continue;
    const list = byTarget.get(m.to) ?? [];
    list.push({ uci: uciOf(m).toLowerCase(), from: m.from, piece: m.piece, captured: m.captured });
    byTarget.set(m.to, list);
  }
  const advice = adviceUci?.toLowerCase() ?? null;
  const bucketOf = (c: { uci: string; from: string; piece: PieceType; captured: PieceType }, target: string): CaptureBucket | null => {
    const see = seeCapture(b0, squareIndex(c.from), squareIndex(target));
    if (see >= 100) {
      const mv = resolveUciMove(fen, c.uci);
      const b1 = mv ? safeBoard(mv.fenAfter) : null;
      if (!b1 || captureCandidates(b1, squareIndex(target), them).length > 0) return null;
      return c.uci === advice || provenWithin(p, c.uci, CAPTURE_NEAR) ? 'capYes' : null;
    }
    if (see === 0) return VALUE_CP[c.piece] === VALUE_CP[c.captured] && provenWithin(p, c.uci, CAPTURE_NEAR) ? 'capTrade' : null;
    if (see <= -100) return provenWorse(p, c.uci, CAPTURE_LOSE_GAP) ? 'capLose' : null;
    return null;
  };
  const found: CaptureProof[] = [];
  for (const [target, list] of byTarget) {
    const buckets = list.map((c) => bucketOf(c, target));
    const first = buckets[0];
    if (!first || buckets.some((b) => b !== first)) continue;
    const advised = list.find((c) => c.uci === advice);
    // «да» / «размен» about the advised capture only; «нет» never about a capture the advice makes
    if (first === 'capLose' ? !!advised : !advised) continue;
    const rep = advised ?? list[0];
    if (!rep) continue;
    found.push({ bucket: first, uci: rep.uci, from: rep.from, target, victim: rep.captured, mover: rep.piece });
  }
  // a trap teaches most, then a fair trade, then a free pawn (a free piece is usually the treasure)
  const order: Readonly<Record<CaptureBucket, number>> = { capLose: 0, capTrade: 1, capYes: 2 };
  found.sort((a, b) => order[a.bucket] - order[b.bucket] || VALUE_CP[b.victim] - VALUE_CP[a.victim] || a.target.localeCompare(b.target));
  return found[0] ?? null;
}

// ───────────────────────── the danger quiz (§6.1) ─────────────────────────

export interface DangerQuizProof {
  correct: PieceType;
  /** two types on the board none of whose pieces is attacked at all */
  distractors: PieceType[];
  victim: Square;
}

/**
 * «Что соперник может съесть?»: every child piece the danger rules call en prise (pieces SEE ≥ 200, pawns from stage 3
 * SEE ≥ 100) is of ONE type; a wrong button is a type with a piece on the board and NONE of them attacked at all.
 */
export function dangerQuizProof(fen: string, danger: Pick<TeachDanger, 'kind' | 'piece'> | null, childColor: Color, stage: number): DangerQuizProof | null {
  if (!danger || danger.kind !== 'hanging' || !danger.piece) return null;
  const b = safeBoard(fen);
  if (!b) return null;
  let hanging;
  try {
    hanging = findHanging(fen);
  } catch {
    return null;
  }
  const mine = hanging.filter((h) => h.color === childColor && h.piece !== 'k' && (h.piece === 'p' ? stage >= 3 && h.seeLossCp >= 100 : h.seeLossCp >= 200));
  const types = new Set(mine.map((h) => h.piece));
  if (types.size !== 1 || !types.has(danger.piece.piece)) return null;
  const correct = danger.piece.piece;
  const them = opposite(childColor);
  const clean: PieceType[] = [];
  for (const t of ['n', 'b', 'r', 'p', 'q'] as const) {
    if (t === correct) continue;
    const squares: number[] = [];
    b.forEach((p, i) => {
      if (p && p.color === childColor && p.type === t) squares.push(i);
    });
    if (squares.length === 0) continue;
    if (squares.some((sq) => attackersOf(b, sq, them).length > 0)) continue;
    clean.push(t);
  }
  if (clean.length < 2) return null;
  return { correct, distractors: clean.slice(0, 2), victim: danger.piece.square };
}

// ───────────────────────── whichPiece (§6.1) ─────────────────────────

export interface WhichPieceProof {
  correct: PieceType;
  distractors: PieceType[];
}

/**
 * «Какой фигурой лучше пойти?»: every move within `WHICH_PIECE_NEAR` win% of the best is of one type T and the advice is
 * a T move; the two other types shown are proven ≥ `WHICH_PIECE_GAP` worse (every move of the type, by its score or the
 * closure bound). Never about castling, a capture, a check answer or a promotion.
 */
export function whichPieceProof(fen: string, p: EngineProof | null, adviceUci: string | null | undefined): WhichPieceProof | null {
  if (!p || p.depth < QUIZ_MIN_DEPTH || !adviceUci) return null;
  const chess = safeChess(fen);
  if (!chess || chess.inCheck()) return null;
  const mv = resolveUciMove(fen, adviceUci);
  if (!mv || mv.isCastle || mv.captured || mv.promotion) return null;
  const T = mv.piece;
  const moves = chess.moves({ verbose: true });
  const typeOf = new Map(moves.map((m) => [uciOf(m).toLowerCase(), m.piece as PieceType] as const));
  for (const l of p.lines) {
    if (l.win < p.best - WHICH_PIECE_NEAR) continue;
    if (typeOf.get(l.uci) !== T) return null;
  }
  if (!provenWithin(p, adviceUci, WHICH_PIECE_NEAR)) return null;
  const byType = new Map<PieceType, string[]>();
  for (const m of moves) {
    const t = m.piece as PieceType;
    if (t === T) continue;
    byType.set(t, [...(byType.get(t) ?? []), uciOf(m).toLowerCase()]);
  }
  const distractors: PieceType[] = [];
  for (const t of ['n', 'b', 'p', 'r', 'q', 'k'] as const) {
    const list = byType.get(t);
    if (!list || list.length === 0) continue;
    if (upperBound(p, list) <= p.best - WHICH_PIECE_GAP) distractors.push(t);
    if (distractors.length === 2) break;
  }
  return distractors.length === 2 ? { correct: T, distractors } : null;
}

// ───────────────────────── the sub-cases of the ideas (the pool variants) ─────────────────────────

/**
 * The variant of an idea for its pool (`@gambit/content` IDEA_TAILS variants): the detector's own `variant` when it
 * set one, else read from the board. undefined = unknown (the book then takes only wordings true for every sub-case).
 */
export function ideaVariant(idea: Pick<MoveIdea, 'id' | 'variant' | 'squares' | 'phraseRu' | 'covers' | 'conceptId'>, fen: string, uci: string, extra: { mate?: number | null } = {}): string | undefined {
  if (idea.variant) return idea.variant;
  const f = moveFacts(fen, uci);
  switch (idea.id) {
    case 'mateSoon':
      if (idea.conceptId === 'back-rank-mate') return 'backRank';
      return extra.mate === 2 ? 'm2' : extra.mate === 3 ? 'm3' : undefined;
    case 'pin': {
      const back = f && idea.squares[1] ? f.b1[squareIndex(idea.squares[1])] : null;
      return back?.type === 'k' ? 'king' : back?.type === 'q' ? 'queen' : back?.type === 'r' ? 'rook' : undefined;
    }
    case 'skewer': {
      const front = f && idea.squares[0] ? f.b1[squareIndex(idea.squares[0])] : null;
      return front?.type === 'k' ? 'king' : front?.type === 'q' ? 'queen' : undefined;
    }
    case 'recapture':
      // (a recapture that only limits a loss is neither «even» nor «gain»: the detector sets its own variant)
      return /размен/u.test(idea.phraseRu) ? 'even' : undefined;
    case 'answerCheck': {
      if (!f) return undefined;
      const king = findKing(f.b0, f.mover);
      const checkers = king >= 0 ? attackersOf(f.b0, king, f.other) : [];
      if (checkers.includes(f.to) && f.mv.piece !== 'k') return 'capture';
      if (f.mv.piece === 'k') return 'king';
      return 'block';
    }
    case 'supportCenter': {
      if (!f || !idea.squares[1]) return undefined;
      const x = f.b1[squareIndex(idea.squares[1])];
      return x && x.type === 'p' && x.color === f.mover ? 'pawn' : 'step';
    }
    case 'attack':
      if (idea.covers?.includes('develop')) return 'queenDevelop';
      return idea.squares.length >= 2 ? 'two' : 'one';
    case 'trade': {
      if (!f) return undefined;
      if (materialOf(f.b0, f.mover) - materialOf(f.b0, f.other) >= 2) return 'ahead';
      return f.mv.captured === f.mv.piece ? 'same' : 'diff';
    }
    case 'kingActivity':
      return /вперёд/u.test(idea.phraseRu) ? 'forward' : /к центру/u.test(idea.phraseRu) ? 'center' : /к пешкам/u.test(idea.phraseRu) ? 'pawns' : undefined;
    case 'develop':
      return f ? (centerHits(f.b1, f.to) >= 1 ? 'center' : 'plain') : undefined;
    case 'rookOpenFile':
      return /полуоткрыт/u.test(idea.phraseRu) ? 'halfOpen' : 'open';
    default:
      return undefined;
  }
}

/** The squares an idea is about, for the cues and the subject pieces of its words. */
export interface IdeaSquares {
  /** the opponent's piece we take / attack / pin / trap */
  target?: Square;
  /** our piece the move defends */
  defended?: Square;
  /** a line of the idea (pin, skewer): from the moved piece to the back piece */
  line?: { from: Square; to: Square };
}

export function ideaSquares(idea: Pick<MoveIdea, 'id' | 'squares'> | undefined, fen: string, uci: string): IdeaSquares {
  const mv = resolveUciMove(fen, uci);
  if (!mv) return {};
  const out: IdeaSquares = {};
  if (mv.captured) out.target = mv.to;
  if (!idea) return out;
  const [a, b] = idea.squares;
  switch (idea.id) {
    case 'attack':
    case 'removeDefender':
    case 'trappedPiece':
    case 'fork':
      if (a) out.target = a;
      break;
    case 'pin':
    case 'skewer':
      if (a) out.target = a;
      if (b) out.line = { from: mv.to, to: b };
      break;
    case 'defend':
    case 'block':
      if (a) out.defended = a;
      break;
    default:
      break;
  }
  return out;
}

/** The piece standing on a square of a FEN (null when none). */
export function pieceOn(fen: string, sq: Square | undefined | null): PieceType | null {
  if (!sq) return null;
  const b = safeBoard(fen);
  return b?.[squareIndex(sq)]?.type ?? null;
}
