/**
 * A mistake explained by a concept (docs/TEACHING.md §2.8): what the child's weaker move
 * allows, in the fixed order of recognition — last rank → mate → the opponent's tactic → an ignored warning → a piece
 * without defence / attacked by a cheaper piece / outnumbered → a bad trade → a missed gift → the early queen (only when
 * it really gets chased) → «был ход сильнее» (stages 3–5, proven). Only code-proven facts; no square is ever spoken:
 * the concept names the idea, the board cue shows where.
 *
 * Pure: the lesson memory and the phrase book stay with ./reaction.ts.
 */
import { Chess } from 'chess.js';
import type { Color, MotifId, MoveJudgement, PieceType, Square, TeachAdvice, Threat } from '@gambit/shared';
import { VALUE_PAWNS, attackersOf, defendersOf, materialOf, opposite, parsePlacement, seeCapture, squareIndex } from '../../analysis/board.ts';
import type { Board } from '../../analysis/board.ts';
import { describeMotif } from '../../analysis/motifs.ts';
import { parseUci, resolveUciMove } from '../board.ts';
import { explainMoveLoss, isEarlyQueenMove } from '../moveIdeas.ts';
import { TEACH_MAX_WIN_PCT_LOSS, queenChase } from '../teacher.ts';
import type { CueFacts } from './cues.ts';
import type { LessonMemory, PendingTakeback } from './types.ts';

/** The concepts of `v3.mistake.<concept>` (content spec MISTAKES). */
export type MistakeConcept =
  | 'backRank'
  | 'mate'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'discovered'
  | 'removeDefender'
  | 'trapped'
  | 'promotion'
  | 'ignoredDanger'
  | 'hanging.undefended'
  | 'hanging.cheaper'
  | 'hanging.outnumbered'
  | 'badTrade'
  | 'missedTreasure'
  | 'earlyQueen'
  | 'slower';

/** Every concept, in the order of recognition (§2.8). */
export const MISTAKE_CONCEPTS: readonly MistakeConcept[] = [
  'backRank',
  'mate',
  'fork',
  'pin',
  'skewer',
  'discovered',
  'removeDefender',
  'trapped',
  'promotion',
  'ignoredDanger',
  'hanging.undefended',
  'hanging.cheaper',
  'hanging.outnumbered',
  'badTrade',
  'missedTreasure',
  'earlyQueen',
  'slower',
];

/** The rules of `v3.rule.<key>` / `v3.rule.ask.<key>` (content spec RULES). */
export type RuleKey = 'mate' | 'backRank' | 'fork' | 'pin' | 'tactic' | 'hanging' | 'badTrade' | 'ignoredDanger' | 'missedTreasure' | 'earlyQueen' | 'promotion';

/** Speak about a weaker move only when the judgement is confirmed, or the loss is ≥ 15 win% (§2.8). */
export const MISTAKE_CONFIRM_WIN_PCT = 15;
/** «Был ход сильнее»: the proven gap between the advice and the played move (§2.8 п. 11). */
export const SLOWER_GAP_WIN_PCT = 5;
/** A mistake reaction at most every this many plies of the child's moves (3 child moves), unless ≥ 3 pawns or mate. */
export const MISTAKE_EVERY_PLIES = 6;
/** «Потеря решила партию» / the frequency exception: this many pawns. */
export const BIG_LOSS_PAWNS = 3;

const RULE_OF: Readonly<Record<MistakeConcept, RuleKey | null>> = {
  backRank: 'backRank',
  mate: 'mate',
  fork: 'fork',
  pin: 'pin',
  skewer: 'tactic',
  discovered: 'tactic',
  removeDefender: 'tactic',
  trapped: 'tactic',
  promotion: 'promotion',
  ignoredDanger: 'ignoredDanger',
  'hanging.undefended': 'hanging',
  'hanging.cheaper': 'hanging',
  'hanging.outnumbered': 'hanging',
  badTrade: 'badTrade',
  missedTreasure: 'missedTreasure',
  earlyQueen: 'earlyQueen',
  slower: null,
};

/** The takeaway key a concept is summed up by at the end (`v3.takeaway.<key>`, content spec TAKEAWAYS). */
const TAKEAWAY_OF: Readonly<Record<MistakeConcept, string | null>> = {
  backRank: 'mistake.backRank',
  mate: 'mistake.mate',
  fork: 'mistake.fork',
  pin: 'mistake.pin',
  skewer: 'mistake.tactic',
  discovered: 'mistake.tactic',
  removeDefender: 'mistake.tactic',
  trapped: 'mistake.tactic',
  promotion: null,
  ignoredDanger: 'mistake.ignoredDanger',
  'hanging.undefended': 'mistake.hanging',
  'hanging.cheaper': 'mistake.hanging',
  'hanging.outnumbered': 'mistake.hanging',
  badTrade: 'mistake.badTrade',
  missedTreasure: 'mistake.missedTreasure',
  earlyQueen: 'mistake.earlyQueen',
  slower: null,
};

export function ruleOfConcept(c: string): RuleKey | null {
  return (RULE_OF as Record<string, RuleKey | null>)[c] ?? null;
}

export function takeawayOfConcept(c: string): string | null {
  return (TAKEAWAY_OF as Record<string, string | null>)[c] ?? null;
}

/** A recognised mistake with everything its words and cues need. */
export interface MistakeFacts {
  concept: MistakeConcept;
  /** `v3.mistake.<concept>` */
  pool: string;
  rule: RuleKey | null;
  takeaway: string | null;
  /** the piece of the pool's subject (victim / attacker / target / mover), or null */
  piece: PieceType | null;
  /** what the board shows while it is said */
  facts: CueFacts;
  /** the child's piece that is lost / in danger (for the take-back reply highlight) */
  victim: Square | null;
  /** the refutation mates */
  mated: boolean;
}

export interface MistakeInput {
  judgement: MoveJudgement;
  /** the advice of that half-move (primary first) */
  advice?: readonly TeachAdvice[];
  stage: number;
  /** the danger said before this move (lesson memory) */
  lastDanger?: LessonMemory['lastDanger'];
  /** the advice was a hidden treasure the child was invited to find */
  treasureHidden?: boolean;
  /** the bot's move before the child's */
  prev?: { uci: string; fenBefore: string } | null;
}

/** Is the move weaker (≥ 5 win%) and proven enough to explain (confirmed, or ≥ 15 win%)? */
export function isMistakeMove(j: Pick<MoveJudgement, 'winPctLoss' | 'confidence'>): boolean {
  return j.winPctLoss >= TEACH_MAX_WIN_PCT_LOSS && (j.confidence === 'confirmed' || j.winPctLoss >= MISTAKE_CONFIRM_WIN_PCT);
}

/** The refutation mates the child within 3 moves (mover POV of `evalAfter`). */
export function refutationMates(j: Pick<MoveJudgement, 'evalAfter'>): boolean {
  const m = j.evalAfter.mate;
  return m !== null && m < 0 && m >= -3;
}

function colorOf(fen: string): Color {
  return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

function boardOf(fen: string): Board | null {
  try {
    return parsePlacement(fen);
  } catch {
    return null;
  }
}

function pieceOn(board: Board | null, sq: Square | null | undefined): PieceType | null {
  if (!board || !sq) return null;
  const i = squareIndex(sq);
  return i >= 0 ? (board[i]?.type ?? null) : null;
}

interface Capture {
  /** index in the refutation */
  index: number;
  square: Square;
  victim: PieceType;
  capturer: Square;
  capturerPiece: PieceType;
  uci: string;
  /** the board right before the capture */
  board: Board;
  fen: string;
}

/** How far the refutation is read for the lost piece: this many plies, +2 for every even trade passed over … */
export const LOST_PIECE_PLIES = 4;
/** … and never further than this (the judge stores 8 plies of the refutation). */
export const LOST_PIECE_MAX_PLIES = 8;

/**
 * The opponent's capture on `board` (before it) is only an even trade: the static exchange on that square wins him
 * nothing AND the child takes back at once (the next move of the refutation) something worth at least as much.
 */
function evenTrade(board: Board, mv: { from: Square; to: Square; captured?: PieceType; promotion?: PieceType; isEnPassant(): boolean }, fenAfterCapture: string, reply: string | undefined): boolean {
  if (!mv.captured || mv.promotion || mv.isEnPassant() || !reply) return false;
  if (seeCapture(board, squareIndex(mv.from), squareIndex(mv.to)) > 0) return false;
  const parts = parseUci(reply);
  if (!parts) return false;
  try {
    const back = new Chess(fenAfterCapture).move({ from: parts.from, to: parts.to, promotion: parts.promotion });
    return !!back.captured && VALUE_PAWNS[back.captured] >= VALUE_PAWNS[mv.captured];
  } catch {
    return false;
  }
}

/**
 * The first child piece the opponent really wins in the refutation, within `plies` plies of it. An even trade on the
 * way is passed over and the reading goes 2 plies further (c5g02 15…Qe8?: Qxe8 Rxe8 Nxe6 — the queens go off, the
 * bishop on e6 is the loss; stopping at the traded queen would find no concept for the take-back).
 */
export function firstLostPiece(j: Pick<MoveJudgement, 'fenAfter' | 'refutationPvUci'>, plies = LOST_PIECE_PLIES): Capture | null {
  let chess: Chess;
  try {
    chess = new Chess(j.fenAfter);
  } catch {
    return null;
  }
  let window = Math.min(plies, LOST_PIECE_MAX_PLIES);
  for (let i = 0; i < Math.min(window, j.refutationPvUci.length); i++) {
    const parts = parseUci(j.refutationPvUci[i] as string);
    if (!parts) return null;
    const fen = chess.fen();
    const board = boardOf(fen);
    let mv;
    try {
      mv = chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
    } catch {
      return null;
    }
    if (i % 2 === 0 && mv.captured && board) {
      if (evenTrade(board, mv, chess.fen(), j.refutationPvUci[i + 1])) {
        window = Math.min(LOST_PIECE_MAX_PLIES, window + 2);
        continue;
      }
      const square = mv.isEnPassant() ? `${mv.to.charAt(0)}${mv.from.charAt(1)}` : mv.to;
      return { index: i, square, victim: mv.captured, capturer: mv.from, capturerPiece: mv.piece, uci: j.refutationPvUci[i] as string, board, fen };
    }
  }
  return null;
}

/** The refutation's position before its move `k` (k = 0: `fenAfter`), or null. */
function fenAtRefutation(j: Pick<MoveJudgement, 'fenAfter' | 'refutationPvUci'>, k: number): string | null {
  try {
    const chess = new Chess(j.fenAfter);
    for (let i = 0; i < k; i++) {
      const parts = parseUci(j.refutationPvUci[i] as string);
      if (!parts) return null;
      chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
    }
    return chess.fen();
  } catch {
    return null;
  }
}

function threatOf(uci: string | undefined, targets: Square[], motif: MotifId = 'hangingPiece'): Threat | null {
  if (!uci) return null;
  return { uci, san: '', motif, targetSquares: targets, gainCp: 0 };
}

const TACTIC_CONCEPT: Partial<Record<MotifId, MistakeConcept>> = {
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discoveredAttack: 'discovered',
  removeDefender: 'removeDefender',
  trappedPiece: 'trapped',
};

function mk(concept: MistakeConcept, piece: PieceType | null, facts: CueFacts, victim: Square | null, mated = false): MistakeFacts {
  return { concept, pool: `v3.mistake.${concept}`, rule: RULE_OF[concept], takeaway: TAKEAWAY_OF[concept], piece, facts, victim, mated };
}

/** Why the lost piece is lost, read on the board right before the capture: no defender / a cheaper attacker / outnumbered. */
function hangingConcept(lost: Capture, child: Color, base: CueFacts): MistakeFacts | null {
  const them = opposite(child);
  const victimIdx = squareIndex(lost.square);
  const defenders = defendersOf(lost.board, victimIdx, child);
  const attackers = attackersOf(lost.board, victimIdx, them);
  const cheapest = Math.min(...attackers.map((a) => VALUE_PAWNS[lost.board[a]?.type ?? 'k'] || 99), VALUE_PAWNS[lost.capturerPiece] || 99);
  const facts: CueFacts = { ...base, fen: lost.fen, victim: lost.square, threat: threatOf(lost.uci, [lost.square]) };
  if (defenders.length === 0) return mk('hanging.undefended', lost.victim, facts, lost.square);
  if (cheapest < VALUE_PAWNS[lost.victim]) return mk('hanging.cheaper', lost.victim, facts, lost.square);
  if (attackers.length > defenders.length) return mk('hanging.outnumbered', lost.victim, facts, lost.square);
  return null;
}

/**
 * Every concept that truly describes the weaker move, in the order of §2.8 (the first one with words wins; the next
 * ones are fall-backs for a stage whose pool is empty). [] = nothing provable (the move is quietly worse).
 * The caller checks `isMistakeMove` first.
 */
export function mistakeConcepts(input: MistakeInput): MistakeFacts[] {
  const j = input.judgement;
  const child: Color = j.color ?? colorOf(j.fenBefore);
  const them = opposite(child);
  const out: MistakeFacts[] = [];
  const base: CueFacts = { fen: j.fenAfter, childColor: child };
  const firstReply = j.refutationPvUci[0];
  const mated = refutationMates(j);
  const lost = firstLostPiece(j);

  // 1. the last rank
  if (j.allowedMotif === 'backRankMate') out.push(mk('backRank', null, { ...base, kingOf: child, threat: threatOf(firstReply, []) }, null, true));
  // 2. mate
  if (mated) out.push(mk('mate', null, { ...base, kingOf: child, threat: threatOf(firstReply, []) }, null, true));

  // 3. the opponent's tactic
  const tactic = j.allowedMotif ? TACTIC_CONCEPT[j.allowedMotif] : undefined;
  if (tactic) {
    let detail: ReturnType<typeof describeMotif>;
    try {
      detail = describeMotif(j.fenAfter, [...j.refutationPvUci]);
    } catch {
      detail = undefined;
    }
    const same = detail && TACTIC_CONCEPT[detail.motif] === tactic ? detail : undefined;
    const fenAt = same ? (fenAtRefutation(j, same.ply) ?? j.fenAfter) : j.fenAfter;
    const boardAt = boardOf(fenAt);
    const afterAt = same ? fenAtRefutation(j, same.ply + 1) : null;
    const boardAfterAt = afterAt ? boardOf(afterAt) : null;
    const targets = (same?.targets ?? []) as Square[];
    const actorPiece = same?.actor ? (pieceOn(boardAfterAt, same.actor) ?? pieceOn(boardAt, same.actor)) : null;
    const front = targets[0] ?? null;
    const facts: CueFacts = { ...base, fen: fenAt, threat: threatOf(j.refutationPvUci[same?.ply ?? 0], targets, j.allowedMotif) };
    if (tactic === 'fork') out.push(mk('fork', actorPiece, { ...facts, piece: same?.actor ?? null }, front));
    else if (tactic === 'pin') out.push(mk('pin', pieceOn(boardAt, front) ?? pieceOn(boardAfterAt, front), { ...facts, ...(same?.actor && targets[1] ? { line: { from: same.actor, to: targets[1] } } : {}) }, front));
    else if (tactic === 'trapped') out.push(mk('trapped', pieceOn(boardAt, front), { ...facts, piece: front }, front));
    else if (tactic === 'removeDefender') out.push(mk('removeDefender', null, { ...facts, target: front, move: j.refutationPvUci[same?.ply ?? 0] ? { uci: j.refutationPvUci[same?.ply ?? 0] as string } : null }, front));
    else out.push(mk(tactic, null, { ...facts, ...(same?.actor && targets[1] ? { line: { from: same.actor, to: targets[1] } } : {}) }, front));
  }
  // the opponent's pawn runs to a queen
  if (j.allowedMotif === 'promotion') {
    const k = j.refutationPvUci.findIndex((u, i) => i % 2 === 0 && u.length === 5);
    const fen = k >= 0 ? fenAtRefutation(j, k) : null;
    out.push(mk('promotion', null, { fen: fen ?? j.fenAfter, childColor: child, move: k >= 0 ? { uci: j.refutationPvUci[k] as string } : null }, null));
  }

  // 4. a warning that was not heeded: the piece of the said danger stayed and is taken
  const danger = input.lastDanger;
  const moved = resolveUciMove(j.fenBefore, j.uci);
  if (
    danger &&
    !danger.kind.startsWith('takeback') &&
    danger.ply === j.ply &&
    danger.square &&
    lost &&
    lost.square === danger.square &&
    moved?.from !== danger.square &&
    j.materialLossPawns >= 1
  ) {
    out.push(mk('ignoredDanger', lost.victim, { ...base, fen: lost.fen, victim: lost.square, threat: threatOf(lost.uci, [lost.square]) }, lost.square));
  }

  // 5–7. a piece left en prise, split by why: no defender, a cheaper attacker, more attackers than defenders
  if (lost && j.materialLossPawns >= 1) {
    const h = hangingConcept(lost, child, base);
    if (h) out.push(h);
  }

  // 8. a trade that gives more than it takes
  if (moved?.captured) {
    const b0 = boardOf(j.fenBefore);
    const see = b0 ? seeCapture(b0, squareIndex(moved.from), squareIndex(moved.to)) : 0;
    if (see <= -100 || j.allowedMotif === 'badTrade') out.push(mk('badTrade', moved.captured, { fen: j.fenBefore, childColor: child, move: { uci: j.uci }, target: moved.to }, null));
  }

  // 9. a gift that was there: the hidden treasure, or a free capture the advice showed
  const primary = input.advice?.[0];
  const missedFree = (j.missedMotif === 'freeCapture' || j.missedMotif === 'hangingPiece') && !!primary && primary.uci === j.bestUci;
  if (primary && primary.uci !== j.uci && (input.treasureHidden === true || missedFree)) {
    const gift = resolveUciMove(j.fenBefore, primary.uci);
    out.push(mk('missedTreasure', gift?.captured ?? null, { fen: j.fenBefore, childColor: child, move: { uci: primary.uci }, target: gift?.captured ? gift.to : null }, null));
  }

  // 10. the early queen — only when the refutation really chases it
  if (isEarlyQueenMove(j.fenBefore, j.uci) && queenChase(j.fenAfter, j.refutationPvUci).count >= 1) {
    out.push(mk('earlyQueen', null, { fen: j.fenAfter, childColor: child, piece: moved?.to ?? null }, null));
  }

  // 11. «был ход сильнее»: stages 3–5, the advice had a concrete gain, the gap is proven
  if (input.stage >= 3 && primary && primary.uci !== j.uci && !input.advice?.some((a) => a.uci === j.uci)) {
    const proven = primary.uci === j.bestUci ? j.winPctLoss >= SLOWER_GAP_WIN_PCT : j.winPctLoss >= TEACH_MAX_WIN_PCT_LOSS + SLOWER_GAP_WIN_PCT;
    if (proven) {
      let gain = false;
      try {
        gain = explainMoveLoss({ judgement: j, adviceUci: input.advice?.map((a) => a.uci) ?? [], prev: input.prev ?? null }).adviceWin !== null;
      } catch {
        gain = false;
      }
      const adv = resolveUciMove(j.fenBefore, primary.uci);
      if (gain && adv) out.push(mk('slower', adv.piece, { fen: j.fenBefore, childColor: child, move: { uci: primary.uci } }, null));
    }
  }
  return out;
}

// ───────────────────────── the take-back: its concept, kept until the reply ─────────────────────────

/**
 * The concepts a take-back offer may name, best first (§2.8): those of `mistakeConcepts` without «был ход сильнее»;
 * when none is provable, the piece the refutation really wins further on (up to 8 plies, even trades passed over, a net
 * loss, split by why as in 5–7); «был ход сильнее» (stages 3–5, proven) only as the last resort. So after «да» / «нет»
 * at stages 3–5 the reply names a concept whenever anything at all is provable (c5g02: 1 reply of 15 had none).
 */
export function takebackConcepts(input: MistakeInput): MistakeFacts[] {
  const all = mistakeConcepts(input);
  const main = all.filter((m) => m.concept !== 'slower');
  if (main.length === 0) {
    const deep = deepLossConcept(input.judgement);
    if (deep) main.push(deep);
  }
  return [...main, ...all.filter((m) => m.concept === 'slower')];
}

/** The child's net material along the whole stored refutation (pawns; > 0 = he loses), or 0 when it cannot be read. */
function refutationNetLoss(j: Pick<MoveJudgement, 'fenAfter' | 'refutationPvUci'>, child: Color): number {
  try {
    const chess = new Chess(j.fenAfter);
    const diff = (): number => {
      const b = parsePlacement(chess.fen());
      return materialOf(b, child) - materialOf(b, opposite(child));
    };
    const start = diff();
    for (const u of j.refutationPvUci.slice(0, LOST_PIECE_MAX_PLIES)) {
      const parts = parseUci(u);
      if (!parts) break;
      chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
    }
    return start - diff();
  } catch {
    return 0;
  }
}

function deepLossConcept(j: MoveJudgement): MistakeFacts | null {
  const child: Color = j.color ?? colorOf(j.fenBefore);
  const lost = firstLostPiece(j, LOST_PIECE_MAX_PLIES);
  if (!lost || refutationNetLoss(j, child) < 1) return null;
  return hangingConcept(lost, child, { fen: j.fenAfter, childColor: child });
}

/** What the reply of an offered take-back names (lesson memory `pendingTakeback`, until the reply). */
export function takebackPending(j: Pick<MoveJudgement, 'ply' | 'uci' | 'fenBefore' | 'fenAfter' | 'color'>, m: MistakeFacts | null): PendingTakeback {
  const f = m?.facts;
  return {
    ply: j.ply,
    uci: j.uci,
    childColor: j.color ?? colorOf(j.fenBefore),
    concept: m?.concept ?? null,
    piece: m?.piece ?? null,
    square: m?.victim ?? null,
    cue: {
      fen: f?.fen ?? j.fenAfter,
      victim: f?.victim ?? m?.victim ?? null,
      target: f?.target ?? null,
      piece: f?.piece ?? null,
      kingOf: f?.kingOf ?? null,
      move: f?.move?.uci ?? null,
      line: f?.line ?? null,
      threat: f?.threat ? { uci: f.threat.uci, targets: [...f.threat.targetSquares] } : null,
    },
  };
}

/** The board facts of the pending concept (the red square and the capture arrow come only with the reply). */
export function pendingCueFacts(p: PendingTakeback): CueFacts {
  const c = p.cue;
  return {
    fen: c.fen,
    childColor: p.childColor,
    ...(c.victim ? { victim: c.victim } : {}),
    ...(c.target ? { target: c.target } : {}),
    ...(c.piece ? { piece: c.piece } : {}),
    ...(c.kingOf ? { kingOf: c.kingOf } : {}),
    ...(c.move ? { move: { uci: c.move } } : {}),
    ...(c.line ? { line: c.line } : {}),
    ...(c.threat ? { threat: { uci: c.threat.uci, san: '', motif: 'hangingPiece' as const, targetSquares: [...c.threat.targets], gainCp: 0 } } : {}),
  };
}

const TAKEBACK_PREFIX = 'takeback:';

/** The pending take-back of a game saved without `pendingTakeback`: `lastDanger` with kind `takeback:<concept>:<piece>`. */
export function takebackMark(ply: number, m: MistakeFacts | null): NonNullable<LessonMemory['lastDanger']> {
  return { ply, square: m?.victim ?? null, kind: `${TAKEBACK_PREFIX}${m?.concept ?? ''}:${m?.piece ?? '-'}` };
}

/** Reads that mark (a game saved without `pendingTakeback` and resumed between the offer and the reply). */
export function readTakebackMark(d: LessonMemory['lastDanger']): { ply: number; concept: MistakeConcept | null; piece: PieceType | null; victim: Square | null } | null {
  if (!d || !d.kind.startsWith(TAKEBACK_PREFIX)) return null;
  const [concept, piece] = d.kind.slice(TAKEBACK_PREFIX.length).split(':');
  const known = concept && concept in RULE_OF ? (concept as MistakeConcept) : null;
  const p = piece && 'pnbrqk'.includes(piece) && piece.length === 1 ? (piece as PieceType) : null;
  return { ply: d.ply, concept: known, piece: p, victim: d.square };
}

// ───────────────────────── the danger of the next turn: said already? ─────────────────────────

/**
 * The mistake words said right after the child's previous move about one of these pieces, or null — for the turn
 * package before its danger sentence (§2.2: «Если о той же фигуре только что говорила реакция на ошибку, опасность не
 * повторяем — сразу совет»).
 *
 * What it reads: `lesson.mistakes` gets an entry for every mistake said — the reaction (`lessonReaction`) and the
 * take-back offer (`lessonTakebackOffer`; at stages 3–5 the reply says that concept) — with `ply` = the child's move,
 * `uci` = that move (a taken-back attempt keeps its own uci; the retry was told the same), `concept` and `victim` =
 * the square of the child's piece the words named (null for a mate, a bad trade, a missed gift, the early queen). `childPly` is the
 * ply the child is about to play (the turn's `ctx.ply`), so the previous move is `childPly - 2`. Pass the squares of
 * the CHILD's pieces the danger is about (`danger.piece.square`; a fork's targets) — a check or a mate threat is said
 * always (§2.2 table), so it is not asked about.
 */
export function mistakeSaidAbout(lesson: Pick<LessonMemory, 'mistakes'>, childPly: number, squares: readonly (Square | null | undefined)[]): LessonMemory['mistakes'][number] | null {
  const want = new Set(squares.filter((s): s is Square => typeof s === 'string' && s !== ''));
  if (want.size === 0) return null;
  const said = lesson.mistakes.filter((m) => m.ply === childPly - 2 && !!m.victim && want.has(m.victim));
  return said[said.length - 1] ?? null;
}

// ───────────────────────── the realized loss (for the takeaway, §2.9) ─────────────────────────

export interface MaterialTrack {
  /** child material − opponent material (pawns) after ply k (k = 0: the initial position) */
  diff: number[];
  /** the ply (1-based) of the last move when it mated, and who mated */
  matedAt: { ply: number; by: Color } | null;
}

/** Replays a game from the initial position: the child's material balance after every ply. */
export function materialTrack(historySan: readonly string[], childColor: Color): MaterialTrack {
  const chess = new Chess();
  const diffOf = (): number => {
    const b = parsePlacement(chess.fen());
    return materialOf(b, childColor) - materialOf(b, opposite(childColor));
  };
  const diff = [diffOf()];
  let matedAt: MaterialTrack['matedAt'] = null;
  for (let i = 0; i < historySan.length; i++) {
    let mv;
    try {
      mv = chess.move(historySan[i] as string);
    } catch {
      break;
    }
    diff.push(diffOf());
    if (chess.isCheckmate()) matedAt = { ply: i + 1, by: mv.color };
  }
  return { diff, matedAt };
}

/** Pawns really lost within 4 plies after the child's move of ply `ply` (≥ 0), and whether he was mated within 6. */
export function realizedLoss(track: MaterialTrack, ply: number, childColor: Color): { pawns: number; mated: boolean } {
  const base = track.diff[ply];
  if (base === undefined) return { pawns: 0, mated: false };
  const next = track.diff.slice(ply + 1, ply + 5);
  const low = next.length > 0 ? Math.min(...next) : base;
  const mated = !!track.matedAt && track.matedAt.by !== childColor && track.matedAt.ply - ply <= 6 && track.matedAt.ply > ply;
  return { pawns: Math.max(0, base - low), mated };
}
