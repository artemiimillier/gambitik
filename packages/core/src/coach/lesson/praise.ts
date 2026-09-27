/**
 * Praise for a deed (docs/TEACHING.md §2.5, §6.5): said at once after the child's move, in the past tense, as its own
 * short utterance. What was really done, proven by code on the position — never «молодец», never a generic «так думают
 * мастера», never for following Гамбитик's own arrow:
 *  - always (a real find): mate, a found treasure, a tactic found alone (the actor from `describeMotif`; a motif from
 *    the 2nd half-move is «начал комбинацию»), a queen from a pawn, a closed mate threat;
 *  - routine reasons only for a move made without a shown arrow (quiz, «Сам», hidden advice, an own move), provably
 *    good (`routinePraiseSure`: `winPctLoss < 1.5`, classed best / excellent or < 1 %), re-checked on the position (the
 *    piece stands safe), one reason once a game, fading as a habit; the «своя идея» reasons `own.*` (no concrete deed on
 *    the board) only for the engine's own first choice or a move within 0.5 % (`ownIdeaSure`);
 *  - a followed arrow gets at most an outcome line `v3.result.<idea>` (no «ты»).
 *
 * Pure: ./reaction.ts picks the words and keeps the memory.
 */
import { Chess } from 'chess.js';
import type { Color, MoveJudgement, PieceType, Square, TeachAdvice, Threat } from '@gambit/shared';
import { RESULT_IDEAS } from '@gambit/content';
import { findHanging } from '../../analysis/hanging.ts';
import { describeMotif } from '../../analysis/motifs.ts';
import { parsePlacement, seeLoss, squareIndex } from '../../analysis/board.ts';
import type { Board } from '../../analysis/board.ts';
import { parseUci, resolveUciMove } from '../board.ts';
import type { ResolvedMove } from '../board.ts';
import { explainMove, pickIdeas } from '../moveIdeas.ts';
import type { MoveIdea, MoveIdeaId } from '../moveIdeas.ts';
import { TEACH_MAX_WIN_PCT_LOSS } from '../teacher.ts';
import type { StrategyCardLike } from '../teacher.ts';
import type { LessonHistory } from './book.ts';
import type { CueFacts } from './cues.ts';
import { goalDoneBy, goalsOfCard } from './goals.ts';
import { ideaVariant } from './truth.ts';
import type { LessonMemory } from './types.ts';

/** Praise per game (§2.5): stages 1–2 / 3–5. Over it only the joy pose. */
export const PRAISE_CAP_YOUNG = 6;
export const PRAISE_CAP_OLD = 4;
/**
 * Routine praise needs the move to be this good: win% lost at the judged depth. Checked deeper over 50 games
 * (Stockfish 18, MultiPV 5), a gate of 2 % let 12 of 235 praises through at 2–3.9 % below the deep best.
 */
export const ROUTINE_MAX_WIN_PCT_LOSS = 1.5;
/** … and is classed best / excellent — or, of any praisable class, loses less than this (win%). */
export const ROUTINE_ANY_CLASS_MAX_WIN_PCT_LOSS = 1;
/**
 * The «своя идея» reasons (`own.*`: an attack, the centre, the plan's move … — praise with no concrete deed on the board)
 * need the engine's own first choice or a move within this much win%. Both praises a deeper check of 50 games found
 * ≥ 5 % below the deep best were of this kind: own.attack 5.7 % (c5g07, ply 17 — the engine's 2nd
 * line, judged within 1 %) and own.plan 5.1 % (c5g10, ply 24 — the card's move, judged ≈ 1 %).
 */
export const OWN_IDEA_MAX_WIN_PCT_LOSS = 0.5;
/** Praise is one short utterance (§2.5 «≤ 10 слов»): the book picks only among wordings this short (`PickArgs.maxWords`). */
export const PRAISE_MAX_WORDS = 10;
/** A habit (the learner model, not praise) is counted for a move this good (the praise gate above is stricter). */
export const HABIT_MAX_WIN_PCT_LOSS = 2;
/** An outcome line of a followed arrow at most every this many turns. */
export const RESULT_EVERY_TURNS = 3;
/** Fading (§2.5): a reason done by the child himself in this many games in a row is a habit … */
export const HABIT_GAMES = 3;
/** … said only in 1 game of this many … */
export const HABIT_SAY_EVERY = 3;
/** … and the habit praise (`v3.praise.habit.<reason>`) at most every this many games (≈ a week at 1 game a day). */
export const HABIT_PRAISE_EVERY_GAMES = 7;
/** The reasons that can become a habit (with a `v3.praise.habit.<reason>` pool). */
export const HABIT_REASONS: readonly string[] = ['knightFirst', 'castled', 'centerPawn', 'developed'];
/** Every reason `praiseChoices` can give (`v3.praise.<reason>`; goals are `v3.goalDone.<key>`, habits `habit.<reason>`). */
export const PRAISE_REASONS: readonly string[] = [
  'mate',
  'treasureFound',
  'tactic.fork',
  'tactic.pin',
  'tactic.skewer',
  'tactic.discovered',
  'tactic.removeDefender',
  'tactic.trapped',
  'tactic.doubleCheck',
  'promotion',
  'stoppedMate',
  'freeCapture',
  'winMaterial',
  'recaptured',
  'answeredCheck',
  'escaped',
  'defended',
  'castled',
  'knightFirst',
  'developed',
  'centerPawn',
  'connectedRooks',
  'rookOpenFile',
  'passedPush',
  'kingActive',
  'tradeAhead',
  'own.attack',
  'own.center',
  'own.defend',
  'own.develop',
  'own.plan',
  'own.good',
];
/** A developing move up to this ply is «в дебюте» (`developed`); later it is `own.develop`. */
const OPENING_PLY = 24;

export function praiseCap(stage: number): number {
  return stage <= 2 ? PRAISE_CAP_YOUNG : PRAISE_CAP_OLD;
}

export type PraiseTier = 'always' | 'routine' | 'habit';

/** One praise that is true for the move (the caller takes the first with words that passes the caps). */
export interface PraiseChoice {
  /** memory reason: 'mate', 'tactic.fork', 'castled', 'goal.aimF7', 'habit.castled' … */
  reason: string;
  /** `v3.praise.<…>` or `v3.goalDone.<key>` */
  pool: string;
  piece: PieceType | null;
  variant: string | null;
  facts: CueFacts;
  tier: PraiseTier;
}

/** The move classes routine praise may follow (a «missed win» can lose little win% and still drop a won game). */
const PRAISABLE_CLASSES: readonly MoveJudgement['classification'][] = ['best', 'excellent', 'good'];
/** The classes that prove a move good on their own (with the win% gate); 'good' needs < 1 % besides. */
const SURE_CLASSES: readonly MoveJudgement['classification'][] = ['best', 'excellent'];

/**
 * Is the verdict sure enough for routine praise (not a mate / a found tactic / a treasure)? The move lost less than
 * `ROUTINE_MAX_WIN_PCT_LOSS` at the judged depth, is classed best / excellent / good (never a «missed win», which
 * can lose little win% and still drop a won game), and is provably good: classed best / excellent, or it lost less
 * than `ROUTINE_ANY_CLASS_MAX_WIN_PCT_LOSS`. A verdict without a number (NaN) is never sure.
 *
 * Confidence: the judge (analysis/judge.ts) re-searches deeper only a move that looked ≥ 10 % worse; one the deeper
 * search cleared keeps 'quick' with the DEEPER numbers, and 'confirmed' means «still ≥ 10 % worse» (or a delivered
 * mate). So for a quietly good move no deeper verdict exists: when one is there its numbers are the ones judged here,
 * otherwise the judged depth with this stricter gate is all there is. A deeper re-check of a praise candidate would
 * have to be made by the caller before `lessonReaction` (it owns the engine).
 */
export function routinePraiseSure(j: Pick<MoveJudgement, 'winPctLoss' | 'classification'>): boolean {
  if (!(j.winPctLoss < ROUTINE_MAX_WIN_PCT_LOSS) || !PRAISABLE_CLASSES.includes(j.classification)) return false;
  return SURE_CLASSES.includes(j.classification) || j.winPctLoss < ROUTINE_ANY_CLASS_MAX_WIN_PCT_LOSS;
}

/**
 * Is the verdict sure enough for an `own.*` praise («своя идея»: the board shows no concrete deed that would hold even
 * for a slightly weaker move)? The routine gate, and the move is the engine's own first choice or lost less than
 * `OWN_IDEA_MAX_WIN_PCT_LOSS` — a near-tie with the engine's 2nd line at the judged depth is no proof (it can be 5 %
 * worse deeper).
 */
export function ownIdeaSure(j: Pick<MoveJudgement, 'winPctLoss' | 'classification' | 'uci' | 'bestUci'>): boolean {
  if (!routinePraiseSure(j)) return false;
  return j.bestUci === j.uci || j.winPctLoss < OWN_IDEA_MAX_WIN_PCT_LOSS;
}

/** What the child found himself (memory `found`), independent of whether the praise is said. */
export interface FoundThing {
  kind: 'tactic' | 'treasure' | 'mate';
  motif?: string;
}

export interface PraiseInput {
  judgement: MoveJudgement;
  advice: readonly TeachAdvice[];
  stage: number;
  /** the child moved without a shown arrow (hidden advice, a quiz, or not the advised move) */
  own: boolean;
  /** the advice arrow was hidden (quiz / «Сам» / treasure / reveal-later not revealed) */
  adviceHidden: boolean;
  treasureHidden: boolean;
  prev?: { uci: string; fenBefore: string } | null;
  card?: StrategyCardLike | null;
  /** SAN from the initial position up to and including the child's move */
  historySan: readonly string[];
  threatAfter?: Threat | null;
  lesson: LessonMemory;
  history: Readonly<LessonHistory>;
}

/** The tactic motifs of `describeMotif` → the praise pool suffix. */
const TACTIC_PRAISE: Readonly<Record<string, string>> = {
  fork: 'tactic.fork',
  pin: 'tactic.pin',
  skewer: 'tactic.skewer',
  discoveredAttack: 'tactic.discovered',
  removeDefender: 'tactic.removeDefender',
  trappedPiece: 'tactic.trapped',
  doubleCheck: 'tactic.doubleCheck',
};

const KNIGHT_HOME: Readonly<Record<Color, readonly string[]>> = { w: ['b1', 'g1'], b: ['b8', 'g8'] };
const KNIGHT_FIRST_TO: Readonly<Record<Color, readonly string[]>> = { w: ['c3', 'f3'], b: ['c6', 'f6'] };
const MINOR_HOME: Readonly<Record<Color, readonly { sq: string; type: 'n' | 'b' }[]>> = {
  w: [
    { sq: 'b1', type: 'n' },
    { sq: 'g1', type: 'n' },
    { sq: 'c1', type: 'b' },
    { sq: 'f1', type: 'b' },
  ],
  b: [
    { sq: 'b8', type: 'n' },
    { sq: 'g8', type: 'n' },
    { sq: 'c8', type: 'b' },
    { sq: 'f8', type: 'b' },
  ],
};
const CENTER: readonly string[] = ['d4', 'e4', 'd5', 'e5'];

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

/** The piece on `sq` is not lost by static exchange (it stands safe). */
function safeOn(board: Board | null, sq: Square | null | undefined): boolean {
  if (!board || !sq) return false;
  const i = squareIndex(sq);
  return i >= 0 && !!board[i] && seeLoss(board, i) === 0;
}

function minorsHome(board: Board | null, color: Color): number {
  if (!board) return 0;
  return MINOR_HOME[color].filter((h) => {
    const p = board[squareIndex(h.sq)];
    return !!p && p.color === color && p.type === h.type;
  }).length;
}

function sameSan(a: string, b: string): boolean {
  const n = (s: string): string => s.replace(/[+#!?]/g, '').trim();
  return n(a) === n(b);
}

/** The card plays a bishop before its first knight (London, Bishop's Opening, Caro-Kann): no «сначала конь». */
function cardBishopFirst(card: StrategyCardLike | null | undefined): boolean {
  const line = card?.lineSan ?? [];
  const b = line.findIndex((s) => s.startsWith('B'));
  const n = line.findIndex((s) => s.startsWith('N'));
  return b >= 0 && (n < 0 || b < n);
}

export interface MoveFacts {
  mv: ResolvedMove;
  child: Color;
  before: Board | null;
  after: Board | null;
  ideas: MoveIdea[];
}

/** One reaction asks for the same move's facts several times (praise, outcome, habits): computed once per judgement. */
const FACTS_CACHE = new WeakMap<MoveJudgement, MoveFacts | null>();
const MOTIF_CACHE = new WeakMap<MoveJudgement, MotifFacts | undefined>();

/** The played move with the boards and its ideas (null for an illegal move / broken FEN). */
export function moveFacts(j: MoveJudgement, prev?: { uci: string; fenBefore: string } | null): MoveFacts | null {
  if (FACTS_CACHE.has(j)) return FACTS_CACHE.get(j) ?? null;
  const out = computeMoveFacts(j, prev);
  FACTS_CACHE.set(j, out);
  return out;
}

function computeMoveFacts(j: MoveJudgement, prev?: { uci: string; fenBefore: string } | null): MoveFacts | null {
  const mv = resolveUciMove(j.fenBefore, j.uci);
  if (!mv) return null;
  let ideas: MoveIdea[] = [];
  try {
    ideas = explainMove({ fen: j.fenBefore, uci: j.uci, pvUci: [j.uci, ...j.refutationPvUci], prev: prev ?? null });
  } catch {
    ideas = [];
  }
  return { mv, child: mv.color, before: boardOf(j.fenBefore), after: boardOf(mv.fenAfter), ideas };
}

function idea(f: MoveFacts, id: MoveIdeaId): MoveIdea | undefined {
  return f.ideas.find((i) => i.id === id);
}

/** The pool variant of an idea of the played move (the detector's, else read from the board — ./truth.ts). */
function variantOf(j: MoveJudgement, i: MoveIdea | undefined): string | null {
  if (!i) return null;
  try {
    return ideaVariant(i, j.fenBefore, j.uci) ?? null;
  } catch {
    return i.variant ?? null;
  }
}

/** The piece the placeholders of an idea pool are about (content IDEA_TAILS `subject`). */
function subjectPiece(f: MoveFacts, i: MoveIdea): PieceType | null {
  switch (i.id) {
    case 'freeCapture':
    case 'winMaterial':
    case 'recapture':
    case 'trade':
      return f.mv.captured ?? pieceOn(f.after, i.squares[0]);
    case 'attack':
    case 'pin':
    case 'skewer':
    case 'removeDefender':
    case 'trappedPiece':
      return pieceOn(f.after, i.squares[0]);
    case 'defend':
    case 'block':
      return pieceOn(f.after, i.squares[0]);
    default:
      return f.mv.piece;
  }
}

function cueFacts(j: MoveJudgement, f: MoveFacts, over: Partial<CueFacts> = {}): CueFacts {
  return { fen: j.fenBefore, childColor: f.child, move: { uci: j.uci }, piece: f.mv.to, ...(f.mv.captured ? { target: f.mv.to } : {}), ...over };
}

interface MotifFacts {
  motif: string;
  ply: number;
  actorPiece: PieceType | null;
  targetPiece: PieceType | null;
  actor: Square | null;
  targets: Square[];
}

/** The motif the child's move realises (actor / targets as the board shows them), or undefined. */
function motifOf(j: MoveJudgement): MotifFacts | undefined {
  if (MOTIF_CACHE.has(j)) return MOTIF_CACHE.get(j);
  const out = computeMotif(j);
  MOTIF_CACHE.set(j, out);
  return out;
}

function computeMotif(j: MoveJudgement): MotifFacts | undefined {
  let d: ReturnType<typeof describeMotif>;
  try {
    d = describeMotif(j.fenBefore, [j.uci, ...j.refutationPvUci]);
  } catch {
    return undefined;
  }
  if (!d) return undefined;
  // the boards around the motif's move, to name the actor's and the target's pieces
  let beforeAt: Board | null = null;
  let afterAt: Board | null = null;
  try {
    const chess = new Chess(j.fenBefore);
    const pv = [j.uci, ...j.refutationPvUci];
    for (let i = 0; i <= d.ply && i < pv.length; i++) {
      if (i === d.ply) beforeAt = boardOf(chess.fen());
      const parts = parseUci(pv[i] as string);
      if (!parts) break;
      chess.move({ from: parts.from, to: parts.to, promotion: parts.promotion });
      if (i === d.ply) afterAt = boardOf(chess.fen());
    }
  } catch {
    // a broken line: name nothing
  }
  const actor = d.actor ?? null;
  const target = d.targets[0] ?? null;
  return {
    motif: d.motif,
    ply: d.ply,
    actor,
    targets: d.targets as Square[],
    actorPiece: pieceOn(afterAt, actor) ?? pieceOn(beforeAt, actor),
    targetPiece: pieceOn(afterAt, target) ?? pieceOn(beforeAt, target),
  };
}

/** What the child found himself with this move (a mate, the hidden treasure, a real tactic). */
export function foundBy(input: PraiseInput): FoundThing | null {
  const j = input.judgement;
  if (j.winPctLoss >= TEACH_MAX_WIN_PCT_LOSS) return null;
  const primary = input.advice[0];
  if (input.treasureHidden && primary && primary.uci === j.uci) {
    const m = motifOf(j);
    return { kind: 'treasure', ...(m ? { motif: m.motif } : {}) };
  }
  if (!input.own) return null;
  if (j.san.includes('#')) return { kind: 'mate', motif: 'mateIn1' };
  const m = motifOf(j);
  if (m && TACTIC_PRAISE[m.motif] && (m.ply === 0 || (m.motif === 'fork' && m.ply === 2))) return { kind: 'tactic', motif: m.motif };
  return null;
}

/** How a habit reason sounds this game: normally, as the habit praise, or not at all (faded). */
export function habitMode(reason: string, history: Readonly<LessonHistory>): 'normal' | 'habit' | 'skip' {
  if (!HABIT_REASONS.includes(reason)) return 'normal';
  const games = history.habits[reason] ?? [];
  const seq = history.gameSeq;
  let streak = 0;
  for (let g = seq - 1; g >= 0 && games.includes(g); g--) streak++;
  if (streak < HABIT_GAMES) return 'normal';
  const last = history.habitSaid[reason];
  if (last === undefined || seq - last >= HABIT_PRAISE_EVERY_GAMES) return 'habit';
  return seq % HABIT_SAY_EVERY === 0 ? 'normal' : 'skip';
}

/**
 * Every praise that is true for the move, most important first: 'always' finds, then the routine reasons (own moves
 * only, re-checked on the position). Reasons already praised this game are left out (tactics and mate may repeat).
 */
export function praiseChoices(input: PraiseInput): PraiseChoice[] {
  const j = input.judgement;
  const f = moveFacts(j, input.prev);
  if (!f) return [];
  const out: PraiseChoice[] = [];
  const said = new Set(input.lesson.praises.map((p) => p.reason));
  const good = j.winPctLoss < TEACH_MAX_WIN_PCT_LOSS;
  const primary = input.advice[0];
  const add = (c: Omit<PraiseChoice, 'pool'> & { pool?: string }): void => {
    out.push({ ...c, pool: c.pool ?? `v3.praise.${c.reason}` });
  };

  // ── always ──
  if (j.san.includes('#')) add({ reason: 'mate', piece: null, variant: null, facts: cueFacts(j, f), tier: 'always' });
  if (good && input.treasureHidden && primary?.uci === j.uci && !said.has('treasureFound')) {
    add({ reason: 'treasureFound', piece: null, variant: null, facts: cueFacts(j, f), tier: 'always' });
  }
  if (good && input.own) {
    const m = motifOf(j);
    const pool = m ? TACTIC_PRAISE[m.motif] : undefined;
    if (m && pool && (m.ply === 0 || (m.motif === 'fork' && m.ply === 2))) {
      const variant = m.motif === 'fork' ? (m.ply === 0 ? 'now' : 'ply2') : null;
      const piece = m.motif === 'fork' ? m.actorPiece : m.motif === 'pin' || m.motif === 'trappedPiece' ? m.targetPiece : null;
      const line = (m.motif === 'pin' || m.motif === 'skewer') && m.actor && m.targets[1] ? { line: { from: m.actor, to: m.targets[1] } } : {};
      const facts = cueFacts(j, f, { ...line, ...(m.motif === 'trappedPiece' && m.targets[0] ? { piece: m.targets[0] } : {}) });
      // a fork from the 2nd half-move has not happened yet: the board shows nothing of it (the rest is the child's to play)
      add({ reason: pool, piece, variant, facts: m.ply === 0 ? facts : { fen: j.fenBefore, childColor: f.child }, tier: 'always' });
    }
  }
  if (f.mv.promotion === 'q' && input.own && good) add({ reason: 'promotion', piece: null, variant: null, facts: cueFacts(j, f), tier: 'always' });
  if (input.own && good && idea(f, 'defendMate') && !(j.evalAfter.mate !== null && j.evalAfter.mate < 0) && !said.has('stoppedMate')) {
    add({ reason: 'stoppedMate', piece: null, variant: null, facts: cueFacts(j, f, { kingOf: f.child }), tier: 'always' });
  }

  // ── routine: only the child's own move, and a surely good one ──
  if (!input.own || !routinePraiseSure(j)) return out;
  const ownIdeaOk = ownIdeaSure(j);
  const routine = (reason: string, piece: PieceType | null, facts: CueFacts, variant: string | null = null, pool?: string): void => {
    if (said.has(reason) || said.has(`habit.${reason}`)) return;
    if (reason.startsWith('own.') && !ownIdeaOk) return;
    const mode = habitMode(reason, input.history);
    if (mode === 'skip') return;
    if (mode === 'habit') add({ reason: `habit.${reason}`, piece: null, variant: null, facts, tier: 'habit' });
    else add({ reason, piece, variant, facts, tier: 'routine', ...(pool ? { pool } : {}) });
  };
  const to = f.mv.to;
  const free = idea(f, 'freeCapture');
  if (free && safeOn(f.after, to)) routine('freeCapture', subjectPiece(f, free), cueFacts(j, f));
  const win = idea(f, 'winMaterial');
  if (win) routine('winMaterial', subjectPiece(f, win), cueFacts(j, f));
  const recap = idea(f, 'recapture');
  if (recap) routine('recaptured', subjectPiece(f, recap), cueFacts(j, f));
  const inCheck = (() => {
    try {
      return new Chess(j.fenBefore).inCheck();
    } catch {
      return false;
    }
  })();
  if (inCheck && idea(f, 'answerCheck')) routine('answeredCheck', null, cueFacts(j, f, { kingOf: f.child }));
  if (idea(f, 'escape') && safeOn(f.after, to)) routine('escaped', f.mv.piece, cueFacts(j, f));
  const def = idea(f, 'defend');
  const defSq = def?.squares[0];
  if (def && defSq && safeOn(f.after, defSq)) routine('defended', subjectPiece(f, def), cueFacts(j, f, { defended: defSq }));
  // the goal of the card's plan, structurally (§6.4)
  const goals = goalsOfCard(input.card ?? null, f.child);
  if (goals.length > 0) {
    const historyBefore = input.historySan.slice(0, Math.max(0, input.historySan.length - 1));
    const g = goalDoneBy(goals, j.fenBefore, f.mv.fenAfter, f.child, historyBefore, input.historySan);
    if (g && !input.lesson.goalsDone.includes(g.key)) routine(`goal.${g.key}`, null, cueFacts(j, f, { kingOf: g.kind === 'castle' ? f.child : null }), null, `v3.goalDone.${g.key}`);
  }
  if (f.mv.isCastle && castledCalm(j, f, input.threatAfter)) routine('castled', null, cueFacts(j, f, { kingOf: f.child }));
  if (knightFirst(j, f, input.card ?? null)) routine('knightFirst', null, cueFacts(j, f));
  const developing = isDevelopingSafe(f);
  if (developing && j.ply <= OPENING_PLY) routine('developed', f.mv.piece, cueFacts(j, f));
  if (f.mv.piece === 'p' && CENTER.includes(to) && safeOn(f.after, to)) routine('centerPawn', null, cueFacts(j, f));
  if (idea(f, 'connectRooks')) routine('connectedRooks', null, cueFacts(j, f));
  if (variantOf(j, idea(f, 'rookOpenFile')) === 'open') routine('rookOpenFile', null, cueFacts(j, f));
  if (idea(f, 'passedPawn') && safeOn(f.after, to)) routine('passedPush', null, cueFacts(j, f));
  if (idea(f, 'kingActivity')) routine('kingActive', null, cueFacts(j, f, { kingOf: f.child }));
  if (variantOf(j, idea(f, 'trade')) === 'ahead') routine('tradeAhead', null, cueFacts(j, f));
  const attack = idea(f, 'attack');
  if (attack && safeOn(f.after, to)) routine('own.attack', subjectPiece(f, attack), cueFacts(j, f, { target: attack.squares[0] ?? null }));
  if ((idea(f, 'fightCenter') || idea(f, 'supportCenter')) && safeOn(f.after, to)) routine('own.center', null, cueFacts(j, f));
  const block = idea(f, 'block');
  if (block) routine('own.defend', null, cueFacts(j, f, { defended: block.squares[0] ?? null }));
  if (developing && j.ply > OPENING_PLY) routine('own.develop', f.mv.piece, cueFacts(j, f));
  if (input.card && [...(input.card.lineSan ?? []), ...(input.card.middlegameSan ?? [])].some((s) => sameSan(s, j.san))) routine('own.plan', null, cueFacts(j, f));
  if (input.adviceHidden && (primary?.uci === j.uci || j.winPctLoss < 1)) routine('own.good', null, cueFacts(j, f));
  return out;
}

/** A knight or bishop leaves its home square, not to the edge, and stands safe there. */
function isDevelopingSafe(f: MoveFacts): boolean {
  if (f.mv.piece !== 'n' && f.mv.piece !== 'b') return false;
  if (!MINOR_HOME[f.child].some((h) => h.sq === f.mv.from && h.type === f.mv.piece)) return false;
  if (f.mv.to.startsWith('a') || f.mv.to.startsWith('h')) return false;
  return safeOn(f.after, f.mv.to);
}

/** §6.5 knightFirst: home → c3/f3 (c6/f6), all four minors were home, the engine's best is not a bishop (or < 1 %), the card has no bishop first. */
function knightFirst(j: MoveJudgement, f: MoveFacts, card: StrategyCardLike | null): boolean {
  if (f.mv.piece !== 'n' || !KNIGHT_HOME[f.child].includes(f.mv.from) || !KNIGHT_FIRST_TO[f.child].includes(f.mv.to)) return false;
  if (minorsHome(f.before, f.child) !== 4) return false;
  const best = resolveUciMove(j.fenBefore, j.bestUci);
  if (best?.piece === 'b' && j.winPctLoss >= 1) return false;
  if (cardBishopFirst(card)) return false;
  return safeOn(f.after, f.mv.to);
}

/** §6.5 castled: nothing of ours hangs after it and no threat is known (no «теперь можно спокойно атаковать»). */
function castledCalm(j: MoveJudgement, f: MoveFacts, threatAfter: Threat | null | undefined): boolean {
  if (threatAfter) return false;
  try {
    return !findHanging(f.mv.fenAfter).some((h) => h.color === f.child && h.seeLossCp >= 100);
  } catch {
    return false;
  }
}

/** The ideas a followed advice carried (as stored when it was given), else the move's own. */
function followedIdeas(input: Pick<PraiseInput, 'judgement' | 'lesson' | 'stage'>, f: MoveFacts): { i: MoveIdea; variant: string | null }[] {
  const j = input.judgement;
  const stored = input.lesson.lastAdvice && input.lesson.lastAdvice.uci === j.uci ? input.lesson.lastAdvice.ideas : null;
  if (stored && stored.length > 0) {
    const out: { i: MoveIdea; variant: string | null }[] = [];
    for (const s of stored) {
      const i = f.ideas.find((x) => x.id === s.id);
      if (i) out.push({ i, variant: s.variant ?? variantOf(j, i) });
    }
    if (out.length > 0) return out;
  }
  return pickIdeas(f.ideas, { stage: input.stage, max: 2 }).map((i) => ({ i, variant: variantOf(j, i) }));
}

/** The outcome line of a followed arrow (`v3.result.<idea>`), or null. */
export function resultChoice(input: Pick<PraiseInput, 'judgement' | 'lesson' | 'stage' | 'prev'>): PraiseChoice | null {
  const j = input.judgement;
  const f = moveFacts(j, input.prev);
  if (!f) return null;
  const ideas: readonly string[] = RESULT_IDEAS;
  for (const { i, variant } of followedIdeas(input, f)) {
    if (!ideas.includes(i.id)) continue;
    // the outcome must still be true on the board: the moved piece is not simply lost
    if (i.id !== 'trade' && i.id !== 'recapture' && i.id !== 'castle' && !safeOn(f.after, f.mv.to) && f.mv.piece !== 'k') continue;
    const facts = cueFacts(j, f, {
      ...(i.id === 'defend' || i.id === 'block' ? { defended: i.squares[0] ?? null } : {}),
      ...(i.id === 'attack' ? { target: i.squares[0] ?? null } : {}),
      ...(i.id === 'castle' || i.id === 'answerCheck' || i.id === 'defendMate' || i.id === 'kingActivity' || i.id === 'prepareCastle' ? { kingOf: f.child } : {}),
    });
    return { reason: `result.${i.id}`, pool: `v3.result.${i.id}`, piece: subjectPiece(f, i), variant, facts, tier: 'routine' };
  }
  return null;
}

/** The habit reasons the child did himself with this move (the learner model counts games, §2.5 fading). */
export function habitsDone(input: PraiseInput): string[] {
  if (!input.own || input.judgement.winPctLoss >= HABIT_MAX_WIN_PCT_LOSS) return [];
  const f = moveFacts(input.judgement, input.prev);
  if (!f) return [];
  const out: string[] = [];
  if (f.mv.isCastle) out.push('castled');
  if (knightFirst(input.judgement, f, input.card ?? null)) out.push('knightFirst');
  if (isDevelopingSafe(f) && input.judgement.ply <= OPENING_PLY) out.push('developed');
  if (f.mv.piece === 'p' && CENTER.includes(f.mv.to) && safeOn(f.after, f.mv.to)) out.push('centerPawn');
  return out;
}

/** A found motif → the mini-lesson topic it shows (content MINI_TOPICS). */
const MOTIF_MINI: Readonly<Record<string, string>> = {
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  discoveredAttack: 'discovered',
  removeDefender: 'removeDefender',
  trappedPiece: 'trapped',
};

/**
 * The mini-lesson topics the child has just SHOWN with his own move (§2.6: the next level of a topic needs the last one
 * heard and the concept shown) — only topics already told, each at most once a game: castling, development, the centre,
 * a found tactic, a mate, a found gift. The caller feeds them to `book.learner.miniShown` (before `habitDone`).
 */
export function miniShownBy(input: PraiseInput, found: FoundThing | null): string[] {
  const j = input.judgement;
  const out = new Set<string>();
  const h = input.history;
  const doneThisGame = (reason: string): boolean => (h.habits[reason] ?? []).includes(h.gameSeq);
  const habits = habitsDone(input);
  if (habits.includes('castled')) out.add('castle');
  if ((habits.includes('developed') || habits.includes('knightFirst')) && !doneThisGame('developed') && !doneThisGame('knightFirst')) out.add('development');
  if (habits.includes('centerPawn') && !doneThisGame('centerPawn')) out.add('center');
  if (found) {
    const earlier = input.lesson.found.filter((f) => f.ply !== j.ply);
    if (found.kind === 'mate') out.add('mateInOne');
    else if (found.kind === 'tactic' && found.motif && !earlier.some((f) => f.motif === found.motif)) {
      const t = MOTIF_MINI[found.motif];
      if (t) out.add(t);
    } else if (found.kind === 'treasure' && !earlier.some((f) => f.kind === 'treasure')) {
      const t = found.motif ? MOTIF_MINI[found.motif] : undefined;
      if (t) out.add(t);
      else if (resolveUciMove(j.fenBefore, j.uci)?.captured) out.add('freeCapture');
    }
  }
  return [...out].filter((t) => (h.minis[t]?.level ?? 0) >= 1);
}
