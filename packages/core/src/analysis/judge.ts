/**
 * judgeMove — the engine-grounded verdict on one move (ARCHITECTURE §2, research 07 §4.2).
 * "Engine decides, code proves": everything here is deterministic given the engine output.
 */
import { Chess } from 'chess.js';
import type { Move } from 'chess.js';
import type { AnalysisResult, Color, EngineLine, EvalScore, IJudgeEngine, MotifId, MoveJudgement } from '@gambit/shared';
import { VALUE_PAWNS, opposite } from './board.ts';
import { classifyByLoss, classifyMove, moveAccuracy, toMoverPov, winPct } from './eval.ts';
import { describeMotif } from './motifs.ts';
import { applyUci, materialSwing, uciToSan } from './pv.ts';

export const DEFAULT_QUICK_DEPTH = 12;
export const DEFAULT_CONFIRM_DEPTH = 16;
/** A quick win% loss of at least this much triggers the deeper confirmation search. */
export const CONFIRM_LOSS_THRESHOLD = 10;
/** Motifs are only attached when the move really cost something (win% points). */
export const MOTIF_LOSS_THRESHOLD = 5;
/** PVs stored in a judgement are cut to this many plies. */
export const MAX_STORED_PV = 8;
/** A `missedWin` that loses at least this many pawns along the refutation is re-labelled by win% loss. */
export const MISSED_WIN_MAX_MATERIAL_LOSS = 2;
/** `materialLossPawns` looks this many plies into the refutation (plus the running exchange). */
export const MATERIAL_LOSS_PLIES = 4;

export interface JudgeMoveArgs {
  fenBefore: string;
  uci: string;
  ply: number;
  /** background MultiPV analysis of `fenBefore`, if the caller has one */
  cachedBefore?: AnalysisResult;
  quickDepth?: number;
  confirmDepth?: number;
  /**
   * The move ends the game as a draw by a rule the FEN alone cannot show (threefold repetition —
   * the caller owns the game history). Treated exactly like stalemate: `evalAfter = 0.00`, the
   * final position is never analysed, so repeating a won position away is a `missedWin` / `blunder`.
   * When the engine's own first choice is the repeating move (it sees only the FEN), the best of the other
   * moves becomes `bestUci` — so the judgement never says "best" about the move that threw the win away.
   */
  drawnByRepetition?: boolean;
}

const MATE_NOW: EvalScore = { cp: null, mate: 1 };
const DRAWN: EvalScore = { cp: 0, mate: null };

function samePosition(a: string, b: string): boolean {
  const key = (fen: string): string => fen.trim().split(/\s+/).slice(0, 4).join(' ');
  return key(a) === key(b);
}

function normalizeUci(uci: string): string {
  return uci.trim().toLowerCase();
}

function toUci(move: Move): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

/** Lines whose first move is legal in `fen`, best first. Throws when the best line is unusable (engine quirk И1). */
function usableLines(result: AnalysisResult, fen: string, legal: Set<string>): EngineLine[] {
  const lines = [...result.lines]
    .sort((a, b) => a.multipv - b.multipv)
    .filter((l) => l.pvUci.length > 0 && legal.has(normalizeUci(l.pvUci[0] as string)));
  const first = result.lines.find((l) => l.multipv === 1) ?? result.lines[0];
  if (!first || lines.length === 0 || lines[0] !== first) {
    throw new Error(`Engine analysis is unusable for ${fen} (no legal best move in the output)`);
  }
  return lines;
}

function cacheIsUsable(cached: AnalysisResult | undefined, fen: string, legal: Set<string>, minDepth: number): EngineLine[] | null {
  if (!cached || !samePosition(cached.fen, fen)) return null;
  let lines: EngineLine[];
  try {
    lines = usableLines(cached, fen, legal);
  } catch {
    return null;
  }
  if (lines.length < Math.min(2, legal.size)) return null;
  return (lines[0] as EngineLine).depth >= minDepth ? lines : null;
}

interface Verdict {
  /** mover POV */
  evalBefore: EvalScore;
  /** mover POV */
  evalAfter: EvalScore;
  bestLine: EngineLine;
  /** opponent's PV from `fenAfter` */
  refutationPv: string[];
}

/**
 * Judges the move `uci` played in `fenBefore`.
 *
 * Pipeline
 *  1. BEFORE: `cachedBefore` is reused when it is the same position (first four FEN fields), has
 *     ≥ 2 usable lines (≥ 1 when there is a single legal move) and its best line reached depth
 *     ≥ quickDepth − 2. Otherwise `fenBefore` is analysed with MultiPV 3 at `quickDepth` (12).
 *  2. PLAYED MOVE: if it is one of those lines its score is reused (same search, same depth — the
 *     most consistent comparison). Otherwise `fenAfter` is analysed (MultiPV 1, `quickDepth`)
 *     and the score is negated to the mover's POV; that PV is the refutation.
 *  3. CONFIRM: if the quick win% loss is ≥ 10, `fenAfter` and `fenBefore` are re-searched with
 *     MultiPV 1 at `confirmDepth` (16) — skipped for the part whose data is already that deep —
 *     and ALL numbers (evals, best move, refutation) are replaced by the deeper ones.
 *     `confidence` is `'confirmed'` only if the loss is still ≥ 10 afterwards; a move that the
 *     deeper search clears is downgraded using the deeper numbers and stays `'quick'`. If the
 *     confirmation search fails or is superseded by `stop()`, the quick verdict is returned.
 *     Moves that never looked bad are `'quick'`; a delivered checkmate is `'confirmed'` (certain
 *     by the rules, no engine involved).
 *  4. FACTS: `bestUci/bestSan/bestPvSan`, `refutationPvUci/San` (both cut to 8 plies; the
 *     refutation is also filled for good moves — `[uci, ...refutationPvUci]` is then the line the
 *     child found, handy for praise), `materialLossPawns = max(0, materialSwing(fenAfter,
 *     refutation, 4) − what the played move itself captured / promoted)` (an even trade loses
 *     nothing), and for moves losing ≥ 5 win%: `allowedMotif` (motif of the refutation,
 *     told from the child's side: a capture that simply wins the piece is `hangingPiece`; a
 *     capture with the more valuable piece that gets recaptured at a loss is `badTrade`) and
 *     `missedMotif` (motif of the best line, told from the attacker's side: `freeCapture`).
 *
 *  5. CLASS: `classifyMove`, with one extra rule only judgeMove can apply: a `missedWin` whose
 *     refutation wins ≥ 2 pawns of material NET of the move's own capture is a plain `mistake` / `blunder` (the move dropped
 *     something — that is not "you missed a gift").
 *
 * Game-ending moves never reach the engine: checkmate → `best`, evals `mate: 1`; stalemate or
 * a dead draw → `evalAfter = 0.00` and the usual loss logic (stalemating a won position is a
 * `missedWin` / `blunder`). With a single legal move the move is `best` by definition.
 *
 * Rejects when the move is illegal, the FEN is invalid, or the engine fails / returns a best move
 * that is illegal in the analysed position (WASM Stockfish "CRITICAL ERROR" quirk).
 */
export async function judgeMove(engine: IJudgeEngine, args: JudgeMoveArgs): Promise<MoveJudgement> {
  const quickDepth = args.quickDepth ?? DEFAULT_QUICK_DEPTH;
  const confirmDepth = Math.max(quickDepth, args.confirmDepth ?? DEFAULT_CONFIRM_DEPTH);
  const { fenBefore, ply } = args;
  const uci = normalizeUci(args.uci);

  const chess = new Chess(fenBefore);
  const mover: Color = chess.turn();
  const legalBefore = new Set(chess.moves({ verbose: true }).map(toUci));
  const played = applyUci(chess, uci);
  if (!played || !legalBefore.has(uci)) throw new Error(`Illegal move ${args.uci} in ${fenBefore}`);
  const fenAfter = chess.fen();
  const legalAfter = new Set(chess.moves({ verbose: true }).map(toUci));
  const deliveredMate = chess.isCheckmate();
  /** Stalemate or a dead draw (insufficient material, 50-move rule): nothing left to analyse. */
  const gameOver = !deliveredMate && (chess.isGameOver() || args.drawnByRepetition === true);

  const base = { ply, color: mover, san: played.san, uci, fenBefore, fenAfter };

  if (deliveredMate) {
    const pct = winPct(MATE_NOW);
    return {
      ...base,
      evalBefore: MATE_NOW,
      evalAfter: MATE_NOW,
      winPctBefore: pct,
      winPctAfter: pct,
      winPctLoss: 0,
      classification: 'best',
      accuracy: 100,
      bestUci: uci,
      bestSan: played.san,
      bestPvSan: [played.san],
      refutationPvSan: [],
      refutationPvUci: [],
      materialLossPawns: 0,
      confidence: 'confirmed',
    };
  }

  const analyseAfter = async (depth: number): Promise<{ score: EvalScore; pv: string[] }> => {
    const result = await engine.analyze(fenAfter, { depth, multipv: 1 });
    const line = usableLines(result, fenAfter, legalAfter)[0] as EngineLine;
    return { score: toMoverPov(line, opposite(mover), mover), pv: line.pvUci.map(normalizeUci) };
  };

  // 1. position before the move
  let linesBefore = cacheIsUsable(args.cachedBefore, fenBefore, legalBefore, quickDepth - 2);
  if (!linesBefore) {
    const result = await engine.analyze(fenBefore, { depth: quickDepth, multipv: 3 });
    linesBefore = usableLines(result, fenBefore, legalBefore);
  }

  // 2. the played move
  /** `ownMinDepth`: reuse the played move's own MultiPV line only if it is at least this deep. */
  const evaluate = async (lines: EngineLine[], afterDepth: number, ownMinDepth: number): Promise<Verdict> => {
    let bestLine = lines[0] as EngineLine;
    if (args.drawnByRepetition === true && gameOver && normalizeUci(bestLine.pvUci[0] as string) === uci && legalBefore.size > 1) {
      // The engine searched the bare FEN: it cannot know that its first choice repeats the position for the
      // third time. The real best move is the best of the OTHER moves — from the same search when it has
      // several lines, otherwise from one more search restricted to them.
      const other = lines.find((l) => normalizeUci(l.pvUci[0] as string) !== uci);
      if (other) bestLine = other;
      else {
        const searchmoves = [...legalBefore].filter((m) => m !== uci);
        const result = await engine.analyze(fenBefore, { depth: afterDepth, multipv: 1, searchmoves });
        const alternative = result.lines.find((l) => l.pvUci.length > 0 && searchmoves.includes(normalizeUci(l.pvUci[0] as string)));
        if (alternative) bestLine = alternative;
      }
    }
    const evalBefore = toMoverPov(bestLine, mover, mover);
    if (gameOver) return { evalBefore, evalAfter: DRAWN, bestLine, refutationPv: [] };
    const own = lines.find((l) => normalizeUci(l.pvUci[0] as string) === uci);
    if (own && own.depth >= ownMinDepth) {
      return { evalBefore, evalAfter: toMoverPov(own, mover, mover), bestLine, refutationPv: own.pvUci.slice(1).map(normalizeUci) };
    }
    const after = await analyseAfter(afterDepth);
    return { evalBefore, evalAfter: after.score, bestLine, refutationPv: after.pv };
  };

  let verdict = await evaluate(linesBefore, quickDepth, 0);
  let confidence: MoveJudgement['confidence'] = 'quick';
  const lossOf = (v: Verdict): number => Math.max(0, winPct(v.evalBefore) - winPct(v.evalAfter));

  // 3. confirmation
  if (lossOf(verdict) >= CONFIRM_LOSS_THRESHOLD) {
    try {
      let deepLines = linesBefore;
      if ((linesBefore[0] as EngineLine).depth < confirmDepth) {
        const result = await engine.analyze(fenBefore, { depth: confirmDepth, multipv: 1 });
        deepLines = usableLines(result, fenBefore, legalBefore);
      }
      const deep = await evaluate(deepLines, confirmDepth, confirmDepth);
      verdict = deep;
      if (lossOf(deep) >= CONFIRM_LOSS_THRESHOLD) confidence = 'confirmed';
    } catch {
      // Engine stopped / failed during confirmation: keep the quick verdict, never 'confirmed'.
    }
  }

  // 4. numbers and facts
  const bestUci = normalizeUci(verdict.bestLine.pvUci[0] as string);
  const isBest = bestUci === uci || legalBefore.size === 1;
  const winPctBefore = winPct(verdict.evalBefore);
  const winPctAfter = isBest ? Math.max(winPct(verdict.evalAfter), winPctBefore) : winPct(verdict.evalAfter);
  const winPctLoss = Math.max(0, winPctBefore - winPctAfter);
  let classification = classifyMove({
    winPctBefore,
    winPctAfter,
    evalBefore: verdict.evalBefore,
    evalAfter: verdict.evalAfter,
    isBest,
  });

  const bestPv = verdict.bestLine.pvUci.slice(0, MAX_STORED_PV).map(normalizeUci);
  const bestPvSan = uciToSan(fenBefore, bestPv);
  const refutationPvSan = uciToSan(fenAfter, verdict.refutationPv.slice(0, MAX_STORED_PV));
  const refutationPvUci = verdict.refutationPv.slice(0, refutationPvSan.length);
  const swing = refutationPvUci.length > 0 ? materialSwing(fenAfter, refutationPvUci, MATERIAL_LOSS_PLIES) : 0;
  // `materialSwing` starts counting AFTER the played move, so what the move itself took (or
  // promoted to) has to be netted out: QxQ followed by a recapture is an even trade, not a lost queen.
  const netLoss = swing - wonByMove(played);
  // "There was a gift" is the wrong story when the move itself drops material: that is a blunder.
  if (classification === 'missedWin' && netLoss >= MISSED_WIN_MAX_MATERIAL_LOSS) classification = classifyByLoss(winPctLoss);

  const judgement: MoveJudgement = {
    ...base,
    evalBefore: verdict.evalBefore,
    evalAfter: verdict.evalAfter,
    winPctBefore,
    winPctAfter,
    winPctLoss,
    classification,
    accuracy: moveAccuracy(winPctBefore, winPctAfter),
    bestUci,
    bestSan: bestPvSan[0] ?? played.san,
    bestPvSan,
    refutationPvSan,
    refutationPvUci,
    materialLossPawns: Math.max(0, netLoss),
    confidence,
  };

  if (!isBest && winPctLoss >= MOTIF_LOSS_THRESHOLD) {
    const allowed = allowedMotifOf(played, fenAfter, refutationPvUci, netLoss, verdict);
    if (allowed) judgement.allowedMotif = allowed;
    const missed = describeMotif(fenBefore, bestPv)?.motif;
    if (missed) judgement.missedMotif = missed === 'hangingPiece' ? 'freeCapture' : missed;
  }
  return judgement;
}

/** Pawns of material the played move itself put in the mover's pocket: the captured piece plus a promotion's upgrade. */
function wonByMove(played: Move): number {
  const captured = played.captured ? VALUE_PAWNS[played.captured] : 0;
  const promoted = played.promotion ? VALUE_PAWNS[played.promotion] - VALUE_PAWNS.p : 0;
  return captured + promoted;
}

/** A pawn-sized loss only "explains" an eval drop of about that size (cp), with this much slack. */
const SMALL_CAPTURE_SLACK_CP = 150;

/**
 * Is "you left something en prise" the honest story of this move? `netLoss` is what the move cost
 * in material once its own capture is netted out.
 *  - nothing lost (an even or favourable trade that gets recaptured) → no;
 *  - ≥ 2 pawns lost → yes, that is a story of its own;
 *  - about a pawn → only when that pawn is commensurate with the eval drop: a pawn grabbed at the
 *    start of a mating attack (or of a much bigger combination) is not "the pawn was hanging".
 */
function captureExplainsLoss(netLoss: number, verdict: Verdict): boolean {
  if (netLoss < 1) return false;
  if (netLoss >= MISSED_WIN_MAX_MATERIAL_LOSS) return true;
  const { evalBefore, evalAfter } = verdict;
  if (evalAfter.mate !== null || evalBefore.mate !== null) return false;
  const cpLoss = (evalBefore.cp ?? 0) - (evalAfter.cp ?? 0);
  return cpLoss <= netLoss * 100 + SMALL_CAPTURE_SLACK_CP;
}

/** Motif of the refutation, told from the side of the player who allowed it. */
function allowedMotifOf(played: Move, fenAfter: string, refutationPv: string[], netLoss: number, verdict: Verdict): MotifId | undefined {
  if (refutationPv.length === 0) return undefined;
  const motif = describeMotif(fenAfter, refutationPv)?.motif;
  if (motif === 'backRankMate' || motif === 'mateIn1' || motif === 'mateIn2' || motif === 'mateIn3') return motif;

  // badTrade: the child captured with a more valuable piece and gets recaptured at a net loss.
  const recapturesThere = (refutationPv[0] as string).slice(2, 4) === played.to;
  if (played.captured && recapturesThere) {
    const risked = VALUE_PAWNS[played.promotion ?? played.piece];
    if (risked > VALUE_PAWNS[played.captured] && netLoss > 0) return 'badTrade';
    // An even or favourable trade: the recapture is the "payoff" every detector would see, and
    // it is not one. Whatever made the move bad, it was not a tactic we can name with confidence.
    if (netLoss < 1) return undefined;
  }
  if (motif === 'freeCapture' || motif === 'hangingPiece') {
    // A wrong label is worse than none: "your piece was hanging" must be what really happened.
    return captureExplainsLoss(netLoss, verdict) ? 'hangingPiece' : undefined;
  }
  return motif;
}
