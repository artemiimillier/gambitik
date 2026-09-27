/**
 * Move-idea explainer of the «Учитель» mode (docs/TEACHER-MODE.md §4): WHY a move is good, in words a 7–10 year old
 * understands — «выводит коня и нападает на пешку на е пять».
 *
 * Deterministic: chess.js + the static geometry of `../analysis` (attacks, SEE, motifs). No LLM and no engine search
 * while explaining — the engine has already chosen the move and (optionally) given its line. The detectors are
 * CONSERVATIVE: a wrong idea is worse than no idea (research 07 §5.4), so every rule demands the concrete fact on the
 * board (the target really can be won, the mate really is prevented, the square really is free …).
 *
 * Every phrase is Russian, Latin-free (squares via `squareToSpokenRu`), at most 12 words: `phraseRu` in the third
 * person for briefs («нападает на пешку на е пять»), `phraseYouRu` on «ты» for templates («нападаешь на …»).
 * Phrases stay neutral about WHO plays the move, so the same idea describes the child's advice and the bot's move
 * (only the «ты» variants and ideas `explainOpponentMove` never names speak of «соперник» or «мы»).
 */
import { Chess } from 'chess.js';
import type { Color, EvalScore, MoveJudgement, PieceType, PositionFacts, Square, Threat } from '@gambit/shared';
import type { Board, BoardPiece } from '../analysis/board.ts';
import {
  ALL_DIRS,
  BISHOP_DIRS,
  ROOK_DIRS,
  VALUE_CP,
  VALUE_PAWNS,
  absolutePins,
  attackersOf,
  attacksFrom,
  captureCandidates,
  defendersOf,
  fileOf,
  findKing,
  firstPieceAlong,
  isBetween,
  materialOf,
  onBoard,
  opposite,
  parsePlacement,
  rankOf,
  seeCapture,
  seeLoss,
  squareIndex,
  squareName,
  toIndex,
} from '../analysis/board.ts';
import { computePositionFacts } from '../analysis/facts.ts';
import { findHanging } from '../analysis/hanging.ts';
import { describeMotif } from '../analysis/motifs.ts';
import type { MotifDetail } from '../analysis/motifs.ts';
import { materialSwing } from '../analysis/pv.ts';
import { resolveUciMove } from './board.ts';
import type { ResolvedMove } from './board.ts';
import { pieceGenderRu, pieceNameRu, sanToSpokenRu, squareToSpokenRu } from './spoken.ts';
import { mateInOneThreat } from './threats.ts';

// ───────────────────────── public types ─────────────────────────

export type MoveIdeaId =
  | 'mate'
  | 'mateSoon'
  | 'promotion'
  | 'fork'
  | 'pin'
  | 'skewer'
  | 'discoveredAttack'
  | 'doubleCheck'
  | 'removeDefender'
  | 'trappedPiece'
  | 'freeCapture'
  | 'winMaterial'
  | 'recapture'
  | 'defendMate'
  | 'answerCheck'
  | 'escape'
  | 'defend'
  | 'block'
  | 'threatMate'
  | 'attack'
  | 'check'
  | 'castle'
  | 'develop'
  | 'centerPawn'
  | 'fightCenter'
  | 'supportCenter'
  | 'openLine'
  | 'aimWeakSquare'
  | 'prepareCastle'
  | 'centerControl'
  | 'connectRooks'
  | 'rookOpenFile'
  | 'rookSeventh'
  | 'passedPawn'
  | 'trade'
  | 'space'
  | 'kingActivity'
  | 'restrictKing'
  | 'opposition'
  | 'improvePiece'
  | 'quiet';

/** A: tactics / material / mate safety; B: threats; C: opening principles; D: middlegame; E: endgame; F: the rest. */
export type MoveIdeaGroup = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface MoveIdea {
  id: MoveIdeaId;
  group: MoveIdeaGroup;
  /**
   * The sub-case of the idea the words depend on (docs/TEACHING.md §6; the pool variants of
   * @gambit/content IDEA_TAILS — e.g. answerCheck 'capture' | 'king' | 'block', develop 'center' | 'plain').
   */
  variant?: string;
  /** squares of the idea for highlights (the attacked piece, the defended piece, the target of a fork …) */
  squares: Square[];
  /** for briefs: third person, Latin-free, ≤ 12 words — «нападает на пешку на е пять» */
  phraseRu: string;
  /** for the `text` template: on «ты» — «нападаешь на пешку на е пять» */
  phraseYouRu: string;
  /** id of a ConceptCard (packages/content CONCEPT_CARDS) when there is one */
  conceptId?: string;
  /** group A: the material this idea wins, in pawns (1/3/3/5/9) — absent for mates and for saving ideas */
  gainPawns?: number;
  /** ideas this phrase already says («выводит коня и нападает на ферзя» covers `develop`); `pickIdeas` never adds them */
  covers?: MoveIdeaId[];
}

export interface ExplainMoveArgs {
  /** position BEFORE the move */
  fen: string;
  uci: string;
  /** the engine line STARTING with this move (for the tactical motifs); a line that does not start with `uci` is read
   *  as the continuation after it */
  pvUci?: readonly string[];
  /** score of that line, from the point of view of the side to move in `fen` */
  lineScore?: EvalScore;
  /** the move played just BEFORE `fen` (the opponent's for an advice, the child's for a bot move): a capture on the
   *  same square is then a recapture — a trade, never a «free» gift */
  prev?: { uci: string; fenBefore: string } | null;
  /** phase of `fen` (computed with `computePositionFacts` when absent) */
  phase?: PositionFacts['phase'];
}

// ───────────────────────── constants ─────────────────────────

/** Every phrase (third person and «ты») has at most this many words. */
export const MAX_IDEA_WORDS = 12;
/** Two ideas are named together only when both phrases fit into this many words. */
export const MAX_IDEA_PAIR_WORDS = 14;

/** Priority order of §4.2 (row order = priority, the first is the most important). */
export const IDEA_PRIORITY: readonly MoveIdeaId[] = [
  'mate',
  'mateSoon',
  'promotion',
  'fork',
  'pin',
  'skewer',
  'discoveredAttack',
  'doubleCheck',
  'removeDefender',
  'trappedPiece',
  'freeCapture',
  'winMaterial',
  'recapture',
  'defendMate',
  'answerCheck',
  'escape',
  'defend',
  'block',
  'threatMate',
  'attack',
  'check',
  'castle',
  'develop',
  'centerPawn',
  'fightCenter',
  'supportCenter',
  'openLine',
  'aimWeakSquare',
  'prepareCastle',
  'centerControl',
  'connectRooks',
  'rookOpenFile',
  'rookSeventh',
  'passedPawn',
  'trade',
  'space',
  'kingActivity',
  'restrictKing',
  'opposition',
  'improvePiece',
  'quiet',
];

export const IDEA_GROUP: Readonly<Record<MoveIdeaId, MoveIdeaGroup>> = {
  mate: 'A',
  mateSoon: 'A',
  promotion: 'A',
  fork: 'A',
  pin: 'A',
  skewer: 'A',
  discoveredAttack: 'A',
  doubleCheck: 'A',
  removeDefender: 'A',
  trappedPiece: 'A',
  freeCapture: 'A',
  winMaterial: 'A',
  recapture: 'A',
  defendMate: 'A',
  answerCheck: 'A',
  escape: 'A',
  defend: 'A',
  block: 'A',
  threatMate: 'B',
  attack: 'B',
  check: 'B',
  castle: 'C',
  develop: 'C',
  centerPawn: 'C',
  fightCenter: 'C',
  supportCenter: 'C',
  openLine: 'C',
  aimWeakSquare: 'C',
  prepareCastle: 'C',
  centerControl: 'C',
  connectRooks: 'C',
  rookOpenFile: 'D',
  rookSeventh: 'D',
  passedPawn: 'D',
  trade: 'D',
  space: 'D',
  kingActivity: 'E',
  restrictKing: 'E',
  opposition: 'E',
  improvePiece: 'F',
  quiet: 'F',
};

/** Ideas `explainOpponentMove` may name (§4.3: rules 5–21, 25, 26, 28 — no engine line, no tactics, no «quiet»). */
export const STATIC_IDEA_IDS: readonly MoveIdeaId[] = [
  'freeCapture',
  'winMaterial',
  'recapture',
  'defendMate',
  'answerCheck',
  'escape',
  'defend',
  'block',
  'threatMate',
  'attack',
  'check',
  'castle',
  'develop',
  'centerPawn',
  'fightCenter',
  'supportCenter',
  'openLine',
  'aimWeakSquare',
  'prepareCastle',
  'centerControl',
  'passedPawn',
  'trade',
  'kingActivity',
];

const TACTIC_MOTIFS = new Set<MoveIdeaId>(['fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck', 'removeDefender', 'trappedPiece']);
/** Never the main idea («смотрит в центр» is only ever added to another idea). */
const SECOND_ONLY = new Set<MoveIdeaId>(['centerControl']);
/** Never paired with anything (next to a mate nothing else matters; «quiet» has nothing to add to). */
const SOLO_ONLY = new Set<MoveIdeaId>(['mate', 'mateSoon', 'quiet']);
/** Stage 1–2 pairs (§4.2): a principle + its consequence; a rescue + attack / development; a winning capture that saves. */
const PRINCIPLE = new Set<MoveIdeaId>(['develop', 'centerPawn', 'castle', 'fightCenter']);
// «выводит слона и грозит матом» — the development is said first, so a stage-1 child hears the principle, not only the mate
const PRINCIPLE_WITH = new Set<MoveIdeaId>(['attack', 'threatMate', 'openLine', 'centerControl', 'aimWeakSquare', 'prepareCastle', 'fightCenter']);
const RESCUE = new Set<MoveIdeaId>(['escape', 'defend', 'defendMate', 'answerCheck']);
const RESCUE_WITH = new Set<MoveIdeaId>(['attack', 'develop']);
const WIN_THAT_SAVES = new Set<MoveIdeaId>(['escape', 'defend', 'block']);

const CENTER: readonly number[] = ['d4', 'e4', 'd5', 'e5'].map(squareIndex);
/** The `pin` variant: the piece behind the pinned one (docs/TEACHING.md §6, @gambit/content IDEA_TAILS.pin). */
const BEHIND_VARIANT: Partial<Readonly<Record<PieceType, string>>> = { k: 'king', q: 'queen', r: 'rook' };
const MINOR_HOME: Readonly<Record<Color, Readonly<Record<'n' | 'b', readonly number[]>>>> = {
  w: { n: ['b1', 'g1'].map(squareIndex), b: ['c1', 'f1'].map(squareIndex) },
  b: { n: ['b8', 'g8'].map(squareIndex), b: ['c8', 'f8'].map(squareIndex) },
};

// ───────────────────────── Russian helpers ─────────────────────────

const DATIVE: Readonly<Record<PieceType, string>> = { p: 'пешке', n: 'коню', b: 'слону', r: 'ладье', q: 'ферзю', k: 'королю' };
const PLURAL_INS: Readonly<Record<PieceType, string>> = { p: 'пешками', n: 'конями', b: 'слонами', r: 'ладьями', q: 'ферзями', k: 'королями' };
const STEPS_RU: readonly string[] = ['', 'один шаг', 'два шага', 'три шага', 'четыре шага', 'пять шагов', 'шесть шагов'];
const MOVES_RU: readonly string[] = ['', 'один ход', 'два хода', 'три хода'];

function sqRu(idx: number): string {
  return squareToSpokenRu(squareName(idx));
}

/** «коня на эф три» */
function accOn(piece: PieceType, idx: number): string {
  return `${pieceNameRu(piece, 'acc')} на ${sqRu(idx)}`;
}

/** «конь на эф три» */
function nomOn(piece: PieceType, idx: number): string {
  return `${pieceNameRu(piece, 'nom')} на ${sqRu(idx)}`;
}

/** «коня на эф три» (genitive) */
function genOn(piece: PieceType, idx: number): string {
  return `${pieceNameRu(piece, 'gen')} на ${sqRu(idx)}`;
}

/** «ним» / «ней» — after «за». */
function pronIns(piece: PieceType): string {
  return pieceGenderRu(piece) === 'f' ? 'ней' : 'ним';
}

/** «ему» / «ей». */
function pronDat(piece: PieceType): string {
  return pieceGenderRu(piece) === 'f' ? 'ей' : 'ему';
}

/** «он» / «она». */
function pronNom(piece: PieceType): string {
  return pieceGenderRu(piece) === 'f' ? 'она' : 'он';
}

/** «тот» / «та». */
function thatOne(piece: PieceType): string {
  return pieceGenderRu(piece) === 'f' ? 'та' : 'тот';
}

/** Words of a phrase — every whitespace-separated token counts (a dash too), so the limit is a safe upper bound. */
export function ideaWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ───────────────────────── context ─────────────────────────

interface Ctx {
  fen: string;
  mv: ResolvedMove;
  b0: Board;
  b1: Board;
  me: Color;
  them: Color;
  from: number;
  to: number;
  /** piece type after the move (a promoted pawn is the new piece) */
  P: PieceType;
  phase: PositionFacts['phase'];
  fullMove: number;
  /** [uci, ...continuation] */
  line: string[];
  lineScore?: EvalScore;
  /** the piece is safe on its new square (nobody wins material by taking it) */
  safeLanding: boolean;
  /** `describeMotif` of `line`, computed once on first use (null = nothing found) */
  motif?: MotifDetail | null;
  /** the previous move (`ExplainMoveArgs.prev`) captured on this square: what it took (pawns) */
  prevCapture: { square: number; value: number } | null;
  /** explaining the OPPONENT's move (`explainOpponentMove`): a capture on the square the child just captured on is
   *  always told as a recapture («забирает коня в ответ»), never as a gift */
  forOpponent: boolean;
  /** the engine line took back the material of a «winning» capture (set by `collect`) */
  captureRefuted?: boolean;
}

function fullMoveOf(fen: string): number {
  const n = Number.parseInt(fen.trim().split(/\s+/)[5] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function phaseOf(fen: string): PositionFacts['phase'] {
  try {
    return computePositionFacts(fen).phase;
  } catch {
    return 'middlegame';
  }
}

function makeCtx(a: ExplainMoveArgs): Ctx | null {
  const mv = resolveUciMove(a.fen, a.uci);
  if (!mv) return null;
  const b0 = parsePlacement(a.fen);
  const b1 = parsePlacement(mv.fenAfter);
  const from = squareIndex(mv.from);
  const to = squareIndex(mv.to);
  const uci = a.uci.trim().toLowerCase();
  const pv = (a.pvUci ?? []).map((m) => m.trim().toLowerCase());
  const line = pv[0] === uci ? pv : [uci, ...pv];
  const ctx: Ctx = {
    fen: a.fen,
    mv,
    b0,
    b1,
    me: mv.color,
    them: opposite(mv.color),
    from,
    to,
    P: mv.promotion ?? mv.piece,
    phase: a.phase ?? phaseOf(a.fen),
    fullMove: fullMoveOf(a.fen),
    line,
    safeLanding: seeLoss(b1, to) === 0,
    prevCapture: prevCaptureOf(a),
    forOpponent: false,
  };
  if (a.lineScore) ctx.lineScore = a.lineScore;
  return ctx;
}

/** What the previous move captured and where — only when it really led to `a.fen` (same placement). */
function prevCaptureOf(a: ExplainMoveArgs): Ctx['prevCapture'] {
  const prev = a.prev;
  if (!prev) return null;
  const mv = resolveUciMove(prev.fenBefore, prev.uci);
  if (!mv || !mv.captured) return null;
  if ((mv.fenAfter.split(' ')[0] ?? '') !== (a.fen.trim().split(/\s+/)[0] ?? '')) return null;
  return { square: squareIndex(mv.to), value: VALUE_PAWNS[mv.captured] };
}

function piece(board: Board, idx: number): BoardPiece | null {
  return idx >= 0 && idx < 64 ? (board[idx] ?? null) : null;
}

function samePiece(a: BoardPiece | null, b: BoardPiece | null): boolean {
  return !!a && !!b && a.type === b.type && a.color === b.color;
}

/** Builds an idea, choosing the first variant whose BOTH phrases fit into `MAX_IDEA_WORDS`. */
function idea(
  id: MoveIdeaId,
  squares: readonly number[],
  variants: readonly (readonly [ru: string, you: string])[],
  extra: Pick<MoveIdea, 'conceptId' | 'gainPawns' | 'covers' | 'variant'> = {},
): MoveIdea {
  const chosen =
    variants.find(([ru, you]) => ideaWordCount(ru) <= MAX_IDEA_WORDS && ideaWordCount(you) <= MAX_IDEA_WORDS) ??
    (variants[variants.length - 1] as readonly [string, string]);
  const out: MoveIdea = {
    id,
    group: IDEA_GROUP[id],
    squares: [...new Set(squares.filter((s) => s >= 0 && s < 64).map(squareName))],
    phraseRu: chosen[0],
    phraseYouRu: chosen[1],
  };
  if (extra.conceptId) out.conceptId = extra.conceptId;
  if (extra.gainPawns !== undefined && extra.gainPawns > 0) out.gainPawns = extra.gainPawns;
  if (extra.covers && extra.covers.length > 0) out.covers = [...extra.covers];
  if (extra.variant) out.variant = extra.variant;
  return out;
}

function lineMotif(c: Ctx): MotifDetail | undefined {
  if (c.motif === undefined) {
    try {
      c.motif = describeMotif(c.fen, c.line) ?? null;
    } catch {
      c.motif = null;
    }
  }
  return c.motif ?? undefined;
}

/** Board after the first `plies` moves of `line` (null when a move is illegal). */
function boardAfter(fen: string, line: readonly string[], plies: number): Board | null {
  const chess = new Chess(fen);
  for (let i = 0; i < plies; i++) {
    const m = line[i];
    if (!m) return null;
    try {
      chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    } catch {
      return null;
    }
  }
  return parsePlacement(chess.fen());
}

function minorsAtHome(board: Board, color: Color): number {
  let n = 0;
  for (const type of ['n', 'b'] as const) {
    for (const sq of MINOR_HOME[color][type]) {
      const p = piece(board, sq);
      if (p && p.color === color && p.type === type) n += 1;
    }
  }
  return n;
}

// ───────────────────────── A: mate, promotion, tactics ─────────────────────────

function detectMate(c: Ctx): MoveIdea | null {
  if (!c.mv.givesMate) return null;
  return idea('mate', [findKing(c.b1, c.them)], [['ставит мат', 'ставишь мат']], { conceptId: 'mate-in-1' });
}

/** P1 in the spec (P0 only for a treasure's mate in two); the rule is cheap, so it is complete here. */
function detectMateSoon(c: Ctx): MoveIdea | null {
  const n = c.lineScore?.mate;
  if (c.mv.givesMate || (n !== 2 && n !== 3)) return null;
  const d = lineMotif(c);
  if (!d || (d.motif !== 'mateIn2' && d.motif !== 'mateIn3' && d.motif !== 'backRankMate')) return null;
  // The PV itself must deliver the mate after exactly `n` of our moves.
  if (d.ply / 2 + 1 !== n) return null;
  const moves = MOVES_RU[n] as string;
  const king = findKing(c.b1, c.them);
  if (d.motif === 'backRankMate') {
    return idea(
      'mateSoon',
      [king],
      [
        [`ведёт к мату в ${moves}: король соперника заперт своими пешками`, `ведёшь к мату в ${moves}: король соперника заперт своими пешками`],
        [`ведёт к мату в ${moves}`, `ведёшь к мату в ${moves}`],
      ],
      { conceptId: 'back-rank-mate', covers: ['threatMate', 'check'], variant: 'backRank' },
    );
  }
  return idea('mateSoon', [king], [[`ведёт к мату в ${moves}`, `ведёшь к мату в ${moves}`]], {
    conceptId: n === 2 ? 'mate-in-2' : 'mate-in-3',
    covers: ['threatMate', 'check'],
    variant: n === 2 ? 'm2' : 'm3',
  });
}

function detectPromotion(c: Ctx): MoveIdea | null {
  const promo = c.mv.promotion;
  if (!promo) return null;
  const captured = c.mv.captured ? VALUE_PAWNS[c.mv.captured] : 0;
  const gain = Math.round(VALUE_PAWNS[promo] - 1 + captured - seeLoss(c.b1, c.to) / 100);
  const into = pieceNameRu(promo, 'acc');
  return idea('promotion', [c.to], [[`пешка превращается в ${into}`, `пешка превращается в ${into}`]], {
    conceptId: 'promotion',
    gainPawns: gain,
  });
}

function sortByValue(board: Board, squares: readonly number[]): number[] {
  return [...squares].sort((a, b) => VALUE_CP[(piece(board, b) as BoardPiece).type] - VALUE_CP[(piece(board, a) as BoardPiece).type]);
}

/** Rule 4: a tactic of `describeMotif` on THIS move (a fork also two plies later, after a check / capture). */
function detectTactic(c: Ctx): MoveIdea | null {
  const d = lineMotif(c);
  if (!d || !TACTIC_MOTIFS.has(d.motif as MoveIdeaId)) return null;
  if (d.ply !== 0 && !(d.motif === 'fork' && d.ply === 2)) return null;
  const board = d.ply === 0 ? c.b1 : boardAfter(c.fen, c.line, d.ply + 1);
  if (!board) return null;
  const targets = d.targets.map(squareIndex).filter((sq) => piece(board, sq));
  let gain = 0;
  try {
    gain = Math.round(materialSwing(c.fen, c.line, Math.min(c.line.length, 5)));
  } catch {
    gain = 0;
  }
  const extra = (conceptId: string, variant?: string): Pick<MoveIdea, 'conceptId' | 'gainPawns' | 'variant'> => ({ conceptId, gainPawns: gain, ...(variant ? { variant } : {}) });
  const typeAt = (sq: number): PieceType => (piece(board, sq) as BoardPiece).type;

  switch (d.motif) {
    case 'fork': {
      if (targets.length < 2) return null;
      const [t1, t2] = sortByValue(board, targets) as [number, number];
      const p1 = typeAt(t1);
      const p2 = typeAt(t2);
      const plain = p1 === p2 ? 'две фигуры' : `${pieceNameRu(p1, 'acc')} и ${pieceNameRu(p2, 'acc')}`;
      if (d.ply === 0) {
        return idea(
          'fork',
          [t1, t2],
          [
            [`нападает сразу на ${accOn(p1, t1)} и ${accOn(p2, t2)} — это вилка`, `нападаешь сразу на ${accOn(p1, t1)} и ${accOn(p2, t2)} — это вилка`],
            [`нападает сразу на ${plain} — это вилка`, `нападаешь сразу на ${plain} — это вилка`],
          ],
          extra('fork'),
        );
      }
      return idea(
        'fork',
        [t1, t2],
        [
          [`готовит вилку: следом нападёт на ${accOn(p1, t1)} и ${accOn(p2, t2)}`, `готовишь вилку: следом нападёшь на ${accOn(p1, t1)} и ${accOn(p2, t2)}`],
          [`готовит вилку: следом нападёт на ${plain}`, `готовишь вилку: следом нападёшь на ${plain}`],
        ],
        extra('fork'),
      );
    }
    case 'pin': {
      // The pin detector names [front, back]; a one-target «pin» is a capture of a piece whose defender is pinned —
      // told by the capture ideas instead.
      if (targets.length < 2) return null;
      const [front, back] = targets as [number, number];
      const pf = typeAt(front);
      const pb = typeAt(back);
      const behind = pb === 'k' ? 'король' : nomOn(pb, back);
      return idea(
        'pin',
        [front, back],
        [
          [`связывает ${accOn(pf, front)}: за ${pronIns(pf)} стоит ${behind}`, `связываешь ${accOn(pf, front)}: за ${pronIns(pf)} стоит ${behind}`],
          [`связывает ${accOn(pf, front)}: за ${pronIns(pf)} стоит ${pieceNameRu(pb, 'nom')}`, `связываешь ${accOn(pf, front)}: за ${pronIns(pf)} стоит ${pieceNameRu(pb, 'nom')}`],
        ],
        // the piece behind the pinned one (a minor piece behind has no wording of its own: no variant)
        extra('pin', BEHIND_VARIANT[pb]),
      );
    }
    case 'skewer': {
      if (targets.length < 2) return null;
      const [front, back] = targets as [number, number];
      const tf = typeAt(front);
      const pf = pieceNameRu(tf, 'nom');
      const pb = typeAt(back);
      return idea(
        'skewer',
        [front, back],
        [
          [`сквозной удар: ${pf} уйдёт — и заберём ${accOn(pb, back)}`, `сквозной удар: ${pf} уйдёт — и ты заберёшь ${accOn(pb, back)}`],
          [`сквозной удар: ${pf} уйдёт — и заберём ${pieceNameRu(pb, 'acc')}`, `сквозной удар: ${pf} уйдёт — и ты заберёшь ${pieceNameRu(pb, 'acc')}`],
        ],
        // the dear piece in FRONT that has to step aside: the king or the queen
        extra('skewer', tf === 'k' ? 'king' : tf === 'q' ? 'queen' : undefined),
      );
    }
    case 'discoveredAttack': {
      const target = targets[0];
      if (target === undefined) return null;
      const slider = discoveringSlider(c, target);
      if (slider < 0) return null;
      const ps = typeAt(slider);
      const pt = typeAt(target);
      const what = pt === 'k' ? 'ставит шах' : `нападает на ${accOn(pt, target)}`;
      const whatShort = pt === 'k' ? 'ставит шах' : `нападает на ${pieceNameRu(pt, 'acc')}`;
      return idea(
        'discoveredAttack',
        [slider, target],
        [
          [`открывает дорогу ${DATIVE[ps]}, и ${thatOne(ps)} ${what}`, `открываешь дорогу ${DATIVE[ps]}, и ${thatOne(ps)} ${what}`],
          [`открывает дорогу ${DATIVE[ps]}, и ${thatOne(ps)} ${whatShort}`, `открываешь дорогу ${DATIVE[ps]}, и ${thatOne(ps)} ${whatShort}`],
        ],
        extra('discovered-attack'),
      );
    }
    case 'doubleCheck':
      return idea(
        'doubleCheck',
        [findKing(c.b1, c.them)],
        [['ставит двойной шах — королю остаётся только уйти', 'ставишь двойной шах — королю остаётся только уйти']],
        extra('double-check'),
      );
    case 'removeDefender': {
      const [defender, prize] = d.targets.map(squareIndex) as [number, number];
      const pp = piece(c.b0, prize);
      if (!pp || defender === undefined) return null;
      return idea(
        'removeDefender',
        [defender, prize],
        [
          [`забирает защитника ${genOn(pp.type, prize)}`, `забираешь защитника ${genOn(pp.type, prize)}`],
          [`забирает защитника ${pieceNameRu(pp.type, 'gen')}`, `забираешь защитника ${pieceNameRu(pp.type, 'gen')}`],
        ],
        extra('remove-defender'),
      );
    }
    case 'trappedPiece': {
      const target = targets[0];
      if (target === undefined) return null;
      const pt = typeAt(target);
      return idea(
        'trappedPiece',
        [target],
        [
          [`ловит ${accOn(pt, target)}: ${pronDat(pt)} некуда уйти`, `ловишь ${accOn(pt, target)}: ${pronDat(pt)} некуда уйти`],
          [`ловит ${pieceNameRu(pt, 'acc')}: ${pronDat(pt)} некуда уйти`, `ловишь ${pieceNameRu(pt, 'acc')}: ${pronDat(pt)} некуда уйти`],
        ],
        extra('trapped-piece'),
      );
    }
    default:
      return null;
  }
}

/** The own line piece whose ray through the vacated `from` square now reaches `target`. -1 when none. */
function discoveringSlider(c: Ctx, target: number): number {
  for (let sq = 0; sq < 64; sq++) {
    const p = piece(c.b1, sq);
    if (!p || p.color !== c.me || sq === c.to) continue;
    const dirs = p.type === 'b' ? BISHOP_DIRS : p.type === 'r' ? ROOK_DIRS : p.type === 'q' ? ALL_DIRS : [];
    for (const dir of dirs) {
      if (firstPieceAlong(c.b1, sq, dir) !== target) continue;
      if (!isBetween(sq, c.from, target)) continue;
      if (firstPieceAlong(c.b0, sq, dir) !== c.from) continue;
      return sq;
    }
  }
  return -1;
}

// ───────────────────────── A: captures ─────────────────────────

interface CaptureInfo {
  victim: BoardPiece;
  see: number;
}

/** A normal capture (en passant is left out: SEE does not see the captured pawn). */
function captureInfo(c: Ctx): CaptureInfo | null {
  const victim = piece(c.b0, c.to);
  if (!c.mv.captured || !victim || victim.color !== c.them) return null;
  return { victim, see: seeCapture(c.b0, c.from, c.to) };
}

/**
 * A capture on the square the previous move captured on (G09 4.bxa3 after 3…Сxa3, G08 5.Фxf3 after 4…Сxf3): a
 * recapture, not a gift — unless it still wins ≥ 2 pawns over the two moves (2…Кxd4 3.Фxd4: a knight for a pawn).
 * For the opponent's move it is always a recapture: the child has just captured there (often on our own advice).
 */
function isRecapture(c: Ctx, cap: CaptureInfo | null): boolean {
  if (!cap || cap.see < 0 || !c.prevCapture || c.prevCapture.square !== c.to) return false;
  if (c.forOpponent) return true;
  return Math.round(cap.see / 100) - c.prevCapture.value < 2;
}

function detectRecapture(c: Ctx, cap: CaptureInfo | null): MoveIdea | null {
  if (!cap || !isRecapture(c, cap)) return null;
  const v = cap.victim.type;
  const net = c.prevCapture === null ? null : Math.round(cap.see / 100) - c.prevCapture.value;
  const even = net === 0;
  const tail = even ? ' — это размен' : '';
  // even — just a trade; gain — and we come out ahead; a recapture that only limits a loss (a bishop back for the rook)
  // is neither: no variant, so only the wordings true for every recapture are said
  const variant = even ? 'even' : net !== null && net > 0 ? 'gain' : undefined;
  return idea(
    'recapture',
    [c.to],
    [
      [`забирает ${accOn(v, c.to)} в ответ${tail}`, `забираешь ${accOn(v, c.to)} в ответ${tail}`],
      [`забирает ${pieceNameRu(v, 'acc')} в ответ${tail}`, `забираешь ${pieceNameRu(v, 'acc')} в ответ${tail}`],
    ],
    { covers: ['trade', 'freeCapture', 'winMaterial'], ...(variant ? { variant } : {}) },
  );
}

/**
 * The engine line confirms that a «winning» capture really keeps its material (G08 4.dxe5: +1 by SEE, but the line
 * dxe5 Сxf3 Фxf3 dxe5 ends even). Without a line (the opponent's move, a one-move line) SEE decides alone.
 */
function captureKeepsMaterial(c: Ctx): boolean {
  if (c.line.length < 2) return true;
  try {
    return materialSwing(c.fen, c.line, 4) >= 0.99;
  } catch {
    return true;
  }
}

function detectFreeCapture(c: Ctx, cap: CaptureInfo | null): MoveIdea | null {
  if (!cap || cap.see < 100 || isRecapture(c, cap) || c.captureRefuted) return null;
  if (captureCandidates(c.b1, c.to, c.them).length > 0) return null;
  const nobody = attackersOf(c.b1, c.to, c.them).length === 0;
  const tail = nobody ? 'никто не защищал' : 'взять назад нельзя';
  const v = cap.victim.type;
  return idea(
    'freeCapture',
    [c.to],
    [
      [`забирает ${accOn(v, c.to)} бесплатно: ${tail}`, `забираешь ${accOn(v, c.to)} бесплатно: ${tail}`],
      [`забирает ${pieceNameRu(v, 'acc')} бесплатно: ${tail}`, `забираешь ${pieceNameRu(v, 'acc')} бесплатно: ${tail}`],
    ],
    { conceptId: 'free-capture', gainPawns: Math.round(cap.see / 100) },
  );
}

function detectWinMaterial(c: Ctx, cap: CaptureInfo | null): MoveIdea | null {
  if (!cap || cap.see < 100 || isRecapture(c, cap) || c.captureRefuted) return null;
  if (captureCandidates(c.b1, c.to, c.them).length === 0) return null;
  const v = cap.victim.type;
  return idea(
    'winMaterial',
    [c.to],
    [
      [`выгодно бьёт ${accOn(v, c.to)}: даже после размена в плюсе`, `выгодно бьёшь ${accOn(v, c.to)}: даже после размена ты в плюсе`],
      [`выгодно бьёт ${pieceNameRu(v, 'acc')}: даже после размена в плюсе`, `выгодно бьёшь ${pieceNameRu(v, 'acc')}: даже после размена ты в плюсе`],
    ],
    { conceptId: 'bad-trade', gainPawns: Math.round(cap.see / 100) },
  );
}

// ───────────────────────── A: safety ─────────────────────────

function detectDefendMate(c: Ctx): MoveIdea | null {
  if (c.mv.givesMate) return null;
  const threat = mateInOneThreat(c.fen);
  if (!threat) return null;
  const after = new Chess(c.mv.fenAfter);
  for (const reply of after.moves({ verbose: true })) {
    after.move(reply);
    const mate = after.isCheckmate();
    after.undo();
    if (mate) return null;
  }
  const target = squareIndex(threat.uci.slice(2, 4));
  const mater = piece(c.b0, squareIndex(threat.uci.slice(0, 2)));
  const weakSquare = target === squareIndex(c.me === 'w' ? 'f2' : 'f7');
  const bishopHelps = attackersOf(c.b0, target, c.them).some((sq) => piece(c.b0, sq)?.type === 'b');
  const scholars = weakSquare && mater?.type === 'q' && bishopHelps;
  return idea('defendMate', [target], [['закрывает угрозу мата', 'закрываешь угрозу мата']], {
    conceptId: scholars ? 'scholars-mate' : 'mate-in-1',
  });
}

/**
 * The child was in check: HOW the move answers it (the three ways of the «escape-check» lesson) — the king steps away,
 * the checking piece is taken, or a piece closes the line (G06 6…c6 after 6.Сb5+: «закрывается от шаха»).
 */
function detectAnswerCheck(c: Ctx, found: readonly MoveIdea[]): MoveIdea | null {
  const king = findKing(c.b0, c.me);
  if (king < 0) return null;
  const checkers = attackersOf(c.b0, king, c.them);
  if (checkers.length === 0) return null;
  // «забирает коня бесплатно» already says the checker is taken
  if (checkers.includes(c.to) && found.some((i) => i.squares.includes(squareName(c.to)))) return null;
  if (checkers.includes(c.to)) {
    return idea('answerCheck', [c.to], [['забирает фигуру, которая ставит шах', 'забираешь фигуру, которая ставит шах']], { variant: 'capture' });
  }
  if (c.mv.piece === 'k') return idea('answerCheck', [c.to], [['уходит королём от шаха', 'уводишь короля от шаха']], { variant: 'king' });
  return idea('answerCheck', [c.to], [['закрывается от шаха', 'закрываешься от шаха']], { variant: 'block' });
}

function detectEscape(c: Ctx): MoveIdea | null {
  if (c.mv.piece === 'k' || !c.safeLanding) return null;
  let hanging;
  try {
    hanging = findHanging(c.fen);
  } catch {
    return null;
  }
  const own = hanging.find((h) => h.color === c.me && h.square === c.mv.from && h.seeLossCp >= 100);
  if (!own) return null;
  const name = pieceNameRu(c.mv.piece, 'acc');
  return idea('escape', [c.from], [[`уводит ${name} из-под боя`, `уводишь ${name} из-под боя`]], { conceptId: 'hanging-piece' });
}

/**
 * Own pieces (not the king, not the moving piece, standing still) that were en prise before the move and are safe after
 * it: SEE loss ≥ 200 as in the spec (#9–10), or ≥ 100 — a single pawn — when the helper is not the queen / king.
 * The pawn case serves T3 of §8.2 (2…Кc6 after 2.Фh5 «защищает пешку на е пять»); a queen guarding a pawn is not an
 * idea to teach (2…Фe7 there must stay without a group-A idea so the early-queen filter of §2.4 can catch it).
 */
function rescuedPieces(c: Ctx): number[] {
  const out: number[] = [];
  const minLoss = c.mv.piece === 'q' || c.mv.piece === 'k' ? 200 : 100;
  for (let sq = 0; sq < 64; sq++) {
    const p = piece(c.b0, sq);
    if (!p || p.color !== c.me || p.type === 'k' || sq === c.from) continue;
    if (!samePiece(p, piece(c.b1, sq))) continue;
    if (seeLoss(c.b0, sq) < minLoss) continue;
    if (seeLoss(c.b1, sq) !== 0) continue;
    out.push(sq);
  }
  return sortByValue(c.b0, out);
}

function detectDefend(c: Ctx, rescued: readonly number[]): MoveIdea | null {
  const defended = rescued.filter((x) => defendersOf(c.b1, x, c.me).includes(c.to));
  const x = defended[0];
  if (x === undefined) return null;
  const px = (piece(c.b0, x) as BoardPiece).type;
  return idea('defend', defended, [[`защищает ${accOn(px, x)}`, `защищаешь ${accOn(px, x)}`]], { conceptId: 'hanging-piece' });
}

function detectBlock(c: Ctx, rescued: readonly number[]): MoveIdea | null {
  if (!c.safeLanding) return null;
  for (const x of rescued) {
    const attacker = attackersOf(c.b0, x, c.them).find((a) => {
      const t = piece(c.b0, a)?.type;
      return (t === 'b' || t === 'r' || t === 'q') && isBetween(a, c.to, x);
    });
    if (attacker === undefined) continue;
    const px = (piece(c.b0, x) as BoardPiece).type;
    const pa = (piece(c.b0, attacker) as BoardPiece).type;
    return idea(
      'block',
      [x, attacker],
      [
        [`закрывает ${accOn(px, x)} от ${pieceNameRu(pa, 'gen')}`, `закрываешь ${accOn(px, x)} от ${pieceNameRu(pa, 'gen')}`],
        [`закрывает ${pieceNameRu(px, 'acc')} от ${pieceNameRu(pa, 'gen')}`, `закрываешь ${pieceNameRu(px, 'acc')} от ${pieceNameRu(pa, 'gen')}`],
      ],
      { conceptId: 'hanging-piece' },
    );
  }
  return null;
}

// ───────────────────────── B: threats ─────────────────────────

function detectThreatMate(c: Ctx): MoveIdea | null {
  if (c.mv.givesMate) return null;
  const threat = mateInOneThreat(c.mv.fenAfter);
  if (!threat) return null;
  return idea('threatMate', [squareIndex(threat.uci.slice(2, 4)), findKing(c.b1, c.them)], [['грозит матом', 'грозишь матом']], {
    conceptId: 'mate-in-1',
  });
}

function isDevelopingMove(c: Ctx): boolean {
  if (c.mv.promotion || (c.mv.piece !== 'n' && c.mv.piece !== 'b')) return false;
  if (!MINOR_HOME[c.me][c.mv.piece].includes(c.from)) return false;
  return c.phase === 'opening' || c.fullMove <= 12;
}

function detectAttack(c: Ctx): MoveIdea | null {
  // An attacker that can simply be taken attacks nothing worth telling.
  if (!c.safeLanding) return null;
  const targets = attacksFrom(c.b1, c.to).filter((t) => {
    const p = piece(c.b1, t);
    if (!p || p.color !== c.them || p.type === 'k') return false;
    // the moved piece may really take it (not pinned to its king) and would win at least a pawn
    if (!captureCandidates(c.b1, t, c.me).includes(c.to) || seeCapture(c.b1, c.to, t) < 100) return false;
    // New: before the move the target could not be won by any of our pieces.
    return !captureCandidates(c.b0, t, c.me).some((from) => seeCapture(c.b0, from, t) > 0);
  });
  if (targets.length === 0) return null;
  const sorted = sortByValue(c.b1, targets);
  const t1 = sorted[0] as number;
  const p1 = (piece(c.b1, t1) as BoardPiece).type;
  const earlyQueen = c.phase === 'opening' && (c.P === 'q' || sorted.some((t) => piece(c.b1, t)?.type === 'q'));
  const conceptId = earlyQueen ? 'opening-early-queen' : undefined;
  const extra = conceptId ? { conceptId } : {};

  if (p1 === 'q' && isDevelopingMove(c)) {
    const who = pieceNameRu(c.mv.piece, 'acc');
    return idea(
      'attack',
      [t1],
      [
        [`выводит ${who} и нападает на ${accOn('q', t1)}`, `выводишь ${who} и нападаешь на ${accOn('q', t1)}`],
        [`выводит ${who} и нападает на ферзя`, `выводишь ${who} и нападаешь на ферзя`],
      ],
      { ...extra, covers: ['develop'], variant: 'queenDevelop' },
    );
  }
  const t2 = sorted[1];
  if (t2 !== undefined) {
    const p2 = (piece(c.b1, t2) as BoardPiece).type;
    const plain = p1 === p2 ? `две фигуры` : `${pieceNameRu(p1, 'acc')} и ${pieceNameRu(p2, 'acc')}`;
    return idea(
      'attack',
      [t1, t2],
      [
        [`нападает на ${accOn(p1, t1)} и ${accOn(p2, t2)}`, `нападаешь на ${accOn(p1, t1)} и ${accOn(p2, t2)}`],
        [`нападает на ${plain}`, `нападаешь на ${plain}`],
      ],
      { ...extra, variant: 'two' },
    );
  }
  return idea('attack', [t1], [[`нападает на ${accOn(p1, t1)}`, `нападаешь на ${accOn(p1, t1)}`]], { ...extra, variant: 'one' });
}

function detectCheck(c: Ctx, found: readonly MoveIdea[]): MoveIdea | null {
  // A checking piece that is simply taken (Фxd8+ Крxd8) is a trade, not a check worth telling.
  if (!c.mv.givesCheck || c.mv.givesMate || !c.safeLanding || found.some((i) => i.group === 'A')) return null;
  return idea('check', [findKing(c.b1, c.them)], [['ставит шах — королю придётся спасаться', 'ставишь шах — королю соперника придётся спасаться']]);
}

// ───────────────────────── C: opening principles ─────────────────────────

function detectCastle(c: Ctx): MoveIdea | null {
  if (!c.mv.isCastle) return null;
  const text = 'рокировка: король прячется в домик, а ладья выходит в игру';
  return idea('castle', [c.to], [[text, text]], { conceptId: 'opening-king-safety' });
}

function detectDevelop(c: Ctx): MoveIdea | null {
  if (!isDevelopingMove(c)) return null;
  const who = pieceNameRu(c.mv.piece, 'acc');
  // center — from its new square the piece hits at least one centre square («в центр» is true); plain — it does not
  const variant = centerHits(c.b1, c.to).length > 0 ? 'center' : 'plain';
  return idea('develop', [c.to], [[`выводит ${who} в игру`, `выводишь ${who} в игру`]], { conceptId: 'opening-development', variant });
}

function isPawnMove(c: Ctx): boolean {
  return c.mv.piece === 'p' && !c.mv.promotion;
}

function detectCenterPawn(c: Ctx): MoveIdea | null {
  if (!isPawnMove(c)) return null;
  const squares = c.me === 'w' ? ['d4', 'e4'] : ['d5', 'e5'];
  if (!squares.includes(c.mv.to)) return null;
  return idea('centerPawn', [c.to], [['ставит пешку в центр', 'ставишь пешку в центр']], { conceptId: 'opening-center' });
}

/**
 * A pawn move that attacks an enemy CENTRE pawn even when it cannot win it yet (2.c4 after 1.d4 d5 — the point of the
 * Queen's Gambit is the attack on d5, not «открывает дорогу ферзю»). An attack that wins material is `attack` (B).
 */
function detectFightCenter(c: Ctx, found: readonly MoveIdea[]): MoveIdea | null {
  if (!isPawnMove(c) || c.mv.captured) return null;
  if (c.phase !== 'opening' && c.fullMove > 12) return null;
  const hit = attacksFrom(c.b1, c.to).find((t) => CENTER.includes(t) && samePiece(piece(c.b1, t), { type: 'p', color: c.them }));
  if (hit === undefined) return null;
  if (found.some((i) => i.id === 'attack' && i.squares.includes(squareName(hit)))) return null;
  const sq = sqRu(hit);
  return idea('fightCenter', [hit], [[`нападает на пешку на ${sq} в центре`, `нападаешь на пешку на ${sq} в центре`]], { conceptId: 'opening-center' });
}

function detectSupportCenter(c: Ctx, found: readonly MoveIdea[] = []): MoveIdea | null {
  if (!isPawnMove(c)) return null;
  return supportCenterStep(c) ?? supportCenterPawn(c, found);
}

/**
 * 2…e6 / 2…c6 after 1.d4 d5 2.c4: the pawn move adds a defender to an own centre pawn that is under attack — «поддерживает
 * пешку на дэ пять» (the pawn is not lost yet, so it is not the group-A `defend`).
 */
function supportCenterPawn(c: Ctx, found: readonly MoveIdea[]): MoveIdea | null {
  for (const x of CENTER) {
    if (!samePiece(piece(c.b1, x), { type: 'p', color: c.me })) continue;
    if (attackersOf(c.b1, x, c.them).length === 0 || !defendersOf(c.b1, x, c.me).includes(c.to)) continue;
    if (found.some((i) => (i.id === 'defend' || i.id === 'block') && i.squares.includes(squareName(x)))) continue;
    return idea('supportCenter', [c.to, x], [[`поддерживает пешку на ${sqRu(x)}`, `поддерживаешь пешку на ${sqRu(x)}`]], { conceptId: 'opening-center', variant: 'pawn' });
  }
  return null;
}

function supportCenterStep(c: Ctx): MoveIdea | null {
  const white = c.me === 'w';
  const plan: Readonly<Record<string, { target: string; file: string }>> = white
    ? { c3: { target: 'd4', file: 'd' }, f3: { target: 'e4', file: 'e' } }
    : { c6: { target: 'd5', file: 'd' }, f6: { target: 'e5', file: 'e' } };
  const p = plan[c.mv.to];
  if (!p) return null;
  const target = squareIndex(p.target);
  if (piece(c.b1, target) || !attacksFrom(c.b1, c.to).includes(target)) return null;
  // Can the own d/e pawn step to the target next move?
  const dir = white ? 1 : -1;
  const f = fileOf(target);
  const one = toIndex(f, rankOf(target) - dir);
  const two = toIndex(f, rankOf(target) - 2 * dir);
  const ownPawn = (sq: number): boolean => samePiece(piece(c.b1, sq), { type: 'p', color: c.me });
  const startRank = white ? 1 : 6;
  const canStep = ownPawn(one) || (rankOf(two) === startRank && ownPawn(two) && !piece(c.b1, one));
  if (!canStep) return null;
  return idea('supportCenter', [c.to, target], [['готовит пешке дорогу в центр', 'готовишь пешке дорогу в центр']], {
    conceptId: 'opening-center',
    variant: 'step',
  });
}

function detectOpenLine(c: Ctx): MoveIdea | null {
  if (c.mv.piece !== 'p') return null;
  const opened: number[] = [];
  let bishops = 0;
  let queen = false;
  for (let sq = 0; sq < 64; sq++) {
    const p = piece(c.b1, sq);
    if (!p || p.color !== c.me || (p.type !== 'b' && p.type !== 'q') || sq === c.to) continue;
    if (!samePiece(p, piece(c.b0, sq))) continue;
    if (attacksFrom(c.b1, sq).length - attacksFrom(c.b0, sq).length < 2) continue;
    opened.push(sq);
    if (p.type === 'b') bishops += 1;
    else queen = true;
  }
  if (opened.length === 0) return null;
  const whom = [bishops === 1 ? 'слону' : bishops > 1 ? 'слонам' : null, queen ? 'ферзю' : null].filter(Boolean).join(' и ');
  return idea('openLine', opened, [[`открывает дорогу ${whom}`, `открываешь дорогу ${whom}`]], { conceptId: 'opening-center' });
}

function detectAimWeakSquare(c: Ctx): MoveIdea | null {
  if ((c.P !== 'b' && c.P !== 'q') || c.phase !== 'opening') return null;
  const white = c.me === 'w';
  const king = squareIndex(white ? 'e8' : 'e1');
  const weak = squareIndex(white ? 'f7' : 'f2');
  if (!samePiece(piece(c.b1, king), { type: 'k', color: c.them })) return null;
  if (!samePiece(piece(c.b1, weak), { type: 'p', color: c.them })) return null;
  if (!attacksFrom(c.b1, c.to).includes(weak) || attacksFrom(c.b0, c.from).includes(weak)) return null;
  const sq = sqRu(weak);
  return idea(
    'aimWeakSquare',
    [weak],
    [[`нацеливается на слабую клетку ${sq} рядом с королём`, `нацеливаешься на слабую клетку ${sq} рядом с королём`]],
    { conceptId: 'scholars-mate' },
  );
}

function castlingRights(fen: string): string {
  return fen.trim().split(/\s+/)[2] ?? '-';
}

function detectPrepareCastle(c: Ctx): MoveIdea | null {
  if (c.mv.piece === 'k' || c.mv.isCastle) return null;
  const rights = castlingRights(c.fen);
  const white = c.me === 'w';
  const rank = white ? '1' : '8';
  const sides = [
    { right: white ? 'K' : 'k', rook: `h${rank}`, between: ['f', 'g'] },
    { right: white ? 'Q' : 'q', rook: `a${rank}`, between: ['b', 'c', 'd'] },
  ];
  const king = squareIndex(`e${rank}`);
  if (!samePiece(piece(c.b0, king), { type: 'k', color: c.me })) return null;
  for (const side of sides) {
    if (!rights.includes(side.right)) continue;
    if (!samePiece(piece(c.b0, squareIndex(side.rook)), { type: 'r', color: c.me })) continue;
    const between = side.between.map((f) => squareIndex(`${f}${rank}`));
    if (!between.includes(c.from)) continue;
    if (!between.every((sq) => !piece(c.b0, sq) || piece(c.b0, sq)?.color === c.me)) continue;
    if (between.some((sq) => piece(c.b1, sq))) continue;
    return idea('prepareCastle', [king], [['освобождает место для рокировки', 'освобождаешь место для рокировки']], {
      conceptId: 'opening-king-safety',
    });
  }
  return null;
}

function centerHits(board: Board, sq: number): number[] {
  return attacksFrom(board, sq).filter((t) => CENTER.includes(t));
}

function detectCenterControl(c: Ctx): MoveIdea | null {
  if (c.P === 'p' || c.P === 'k' || c.mv.promotion) return null;
  const after = centerHits(c.b1, c.to);
  if (after.length < 1 || after.length <= centerHits(c.b0, c.from).length) return null;
  return idea('centerControl', after, [['смотрит в центр', `${pieceNameRu(c.P, 'nom')} смотрит в центр`]], { conceptId: 'opening-center' });
}

/** P1 (no concept card yet): both rooks on the back rank see each other only after this move. */
function detectConnectRooks(c: Ctx): MoveIdea | null {
  const rank = c.me === 'w' ? 0 : 7;
  const rooks: number[] = [];
  for (let f = 0; f < 8; f++) {
    const sq = toIndex(f, rank);
    if (samePiece(piece(c.b1, sq), { type: 'r', color: c.me })) rooks.push(sq);
  }
  if (rooks.length !== 2) return null;
  const [r1, r2] = rooks as [number, number];
  if (!rooks.every((sq) => samePiece(piece(c.b0, sq), { type: 'r', color: c.me }))) return null;
  const between: number[] = [];
  for (let sq = r1 + 1; sq < r2; sq++) between.push(sq);
  if (between.length === 0 || between.some((sq) => piece(c.b1, sq))) return null;
  if (!between.some((sq) => piece(c.b0, sq))) return null;
  return idea('connectRooks', rooks, [['соединяет ладьи — дебют почти закончен', 'соединяешь ладьи — дебют почти закончен']]);
}

// ───────────────────────── D: middlegame ─────────────────────────

function pawnsOnFile(board: Board, file: number, color: Color): number {
  let n = 0;
  for (let r = 0; r < 8; r++) if (samePiece(piece(board, toIndex(file, r)), { type: 'p', color })) n += 1;
  return n;
}

/** P1: a rook comes to an open (no pawns) or half-open (no own pawns, an enemy pawn) file. */
function detectRookOpenFile(c: Ctx): MoveIdea | null {
  if (c.mv.piece !== 'r' || c.mv.isCastle || !c.safeLanding) return null;
  const f = fileOf(c.to);
  if (f === fileOf(c.from)) return null;
  const openness = (board: Board, file: number): 'open' | 'half' | null => {
    if (pawnsOnFile(board, file, c.me) > 0) return null;
    return pawnsOnFile(board, file, c.them) > 0 ? 'half' : 'open';
  };
  const now = openness(c.b1, f);
  if (!now || openness(c.b0, fileOf(c.from))) return null;
  if (now === 'open') {
    return idea('rookOpenFile', [c.to], [['ставит ладью на открытую линию', 'ставишь ладью на открытую линию']], { variant: 'open' });
  }
  return idea(
    'rookOpenFile',
    [c.to],
    [['ставит ладью на полуоткрытую линию — смотрит на пешку соперника', 'ставишь ладью на полуоткрытую линию — смотришь на пешку соперника']],
    { variant: 'halfOpen' },
  );
}

/** P1: a rook breaks into the 7th rank, where enemy pawns stand or in front of the enemy king on the 8th. */
function detectRookSeventh(c: Ctx): MoveIdea | null {
  if (c.mv.piece !== 'r' || c.mv.isCastle || !c.safeLanding) return null;
  const seventh = c.me === 'w' ? 6 : 1;
  const eighth = c.me === 'w' ? 7 : 0;
  if (rankOf(c.to) !== seventh || rankOf(c.from) === seventh) return null;
  let pawns = false;
  for (let f = 0; f < 8; f++) if (samePiece(piece(c.b1, toIndex(f, seventh)), { type: 'p', color: c.them })) pawns = true;
  const king = findKing(c.b1, c.them);
  if (!pawns && !(king >= 0 && rankOf(king) === eighth)) return null;
  return idea('rookSeventh', [c.to], [['врывается ладьёй на седьмую горизонталь', 'врываешься ладьёй на седьмую горизонталь']]);
}

function isPassedPawn(board: Board, sq: number, color: Color): boolean {
  const dir = color === 'w' ? 1 : -1;
  const enemy = opposite(color);
  for (let r = rankOf(sq) + dir; r >= 0 && r < 8; r += dir) {
    for (let f = fileOf(sq) - 1; f <= fileOf(sq) + 1; f++) {
      if (onBoard(f, r) && samePiece(piece(board, toIndex(f, r)), { type: 'p', color: enemy })) return false;
    }
  }
  return true;
}

function detectPassedPawn(c: Ctx): MoveIdea | null {
  if (!isPawnMove(c) || !isPassedPawn(c.b1, c.to, c.me)) return null;
  const steps = c.me === 'w' ? 7 - rankOf(c.to) : rankOf(c.to);
  const stepsRu = STEPS_RU[steps];
  if (!stepsRu) return null;
  return idea(
    'passedPawn',
    [c.to],
    [[`двигает проходную пешку: до превращения ${stepsRu}`, `двигаешь проходную пешку: до превращения ${stepsRu}`]],
    { conceptId: 'promotion' },
  );
}

function detectTrade(c: Ctx, cap: CaptureInfo | null): MoveIdea | null {
  // an even trade by SEE, or a «winning» capture whose material the engine line takes back
  if (!cap || isRecapture(c, cap) || !(cap.see === 0 || (c.captureRefuted && tradeEven(c)))) return null;
  const mover = c.mv.piece;
  const victim = cap.victim.type;
  const [ru, you] =
    mover === victim
      ? [`меняется ${PLURAL_INS[mover]}`, `меняешься ${PLURAL_INS[mover]}`]
      : [`меняет ${pieceNameRu(mover, 'acc')} на ${pieceNameRu(victim, 'acc')}`, `меняешь ${pieceNameRu(mover, 'acc')} на ${pieceNameRu(victim, 'acc')}`];
  const ahead = materialOf(c.b0, c.me) - materialOf(c.b0, c.them) >= 2;
  const tail = ': когда фигур больше, размены выгодны';
  // ahead — we have more material (the teaching point wins); same — the same pieces; diff — different pieces of the
  // same value (a bishop for a knight). A trade of unequal pieces the line evened out has no variant.
  const variant = ahead ? 'ahead' : mover === victim ? 'same' : VALUE_PAWNS[mover] === VALUE_PAWNS[victim] ? 'diff' : undefined;
  return idea('trade', [c.to], ahead ? [[ru + tail, you + tail], [ru, you]] : [[ru, you]], { conceptId: 'bad-trade', ...(variant ? { variant } : {}) });
}

/** The line after a refuted capture ends with even material (not a loss): then it is a trade. */
function tradeEven(c: Ctx): boolean {
  try {
    return Math.round(materialSwing(c.fen, c.line, 4)) === 0;
  } catch {
    return false;
  }
}

/** Rank counted from `color`'s own side: 0 = its first rank, 3 = its fourth. */
function relativeRank(sq: number, color: Color): number {
  return color === 'w' ? rankOf(sq) : 7 - rankOf(sq);
}

/** Every square an own pawn of `color` attacks. */
function pawnControl(board: Board, color: Color): Set<number> {
  const out = new Set<number>();
  for (let sq = 0; sq < 64; sq++) {
    if (samePiece(piece(board, sq), { type: 'p', color })) for (const t of attacksFrom(board, sq)) out.add(t);
  }
  return out;
}

/**
 * Space (docs/TEACHING.md §6.3, the queen's-side family): a pawn on the queen's side (files a–c) steps to its own
 * 4th rank or further, lands safely and newly controls at least two squares in the opponent's half that no own pawn
 * controlled before — «забирает место». CONSERVATIVE: never a capture, a promotion or a passed pawn (that is
 * `passedPawn`), never an answer to a check or a move with a tactic / material / rescue idea (group A: the move is about
 * that), never when it leaves an own unit en prise. An a-pawn never qualifies: it controls one square only.
 */
function detectSpace(c: Ctx, found: readonly MoveIdea[]): MoveIdea | null {
  if (!isPawnMove(c) || c.mv.captured || !c.safeLanding) return null;
  if (fileOf(c.to) > 2 || relativeRank(c.to, c.me) < 3) return null;
  if (found.some((i) => i.group === 'A')) return null;
  const king = findKing(c.b0, c.me);
  if (king >= 0 && attackersOf(c.b0, king, c.them).length > 0) return null;
  if (isPassedPawn(c.b1, c.to, c.me)) return null;
  const before = pawnControl(c.b0, c.me);
  const gained = attacksFrom(c.b1, c.to).filter((t) => relativeRank(t, c.me) >= 4 && !before.has(t));
  if (gained.length < 2) return null;
  let hanging;
  try {
    hanging = findHanging(c.mv.fenAfter);
  } catch {
    return null;
  }
  if (hanging.some((h) => h.color === c.me && h.seeLossCp >= 100)) return null;
  return idea('space', [c.to, ...gained], [['забирает пешкой место на стороне ферзя', 'забираешь пешкой место на стороне ферзя']]);
}

// ───────────────────────── E: endgame ─────────────────────────

function chebyshev(a: number, b: number): number {
  return Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)));
}

function centerDistance(sq: number): number {
  return Math.min(...CENTER.map((t) => chebyshev(sq, t)));
}

function passedPawnSquares(board: Board, color: Color): number[] {
  const out: number[] = [];
  for (let sq = 0; sq < 64; sq++) {
    if (samePiece(piece(board, sq), { type: 'p', color }) && isPassedPawn(board, sq, color)) out.push(sq);
  }
  return out;
}

function detectKingActivity(c: Ctx): MoveIdea | null {
  if (c.phase !== 'endgame' || c.mv.piece !== 'k' || c.mv.isCastle) return null;
  const toCenter = centerDistance(c.to) < centerDistance(c.from);
  // Extension of the spec rule: a king stepping FORWARD without leaving the centre is active too (E10: Крf4).
  const forwardRank = (sq: number): number => (c.me === 'w' ? rankOf(sq) : 7 - rankOf(sq));
  const forward = forwardRank(c.to) > forwardRank(c.from) && centerDistance(c.to) <= centerDistance(c.from);
  const dir = c.me === 'w' ? 1 : -1;
  const ownFronts = passedPawnSquares(c.b1, c.me)
    .map((sq) => toIndex(fileOf(sq), rankOf(sq) + dir))
    .filter((sq) => sq >= 0 && sq < 64);
  const theirs = passedPawnSquares(c.b1, c.them);
  const closer = (targets: readonly number[]): boolean => targets.some((t) => chebyshev(c.to, t) < chebyshev(c.from, t));
  const toPawns = closer(ownFronts) || closer(theirs);
  if (!toCenter && !forward && !toPawns) return null;
  const tail = 'в эндшпиле король — сильная фигура';
  if (forward) return idea('kingActivity', [c.to], [[`король идёт вперёд: ${tail}`, `ведёшь короля вперёд: ${tail}`]], { variant: 'forward' });
  if (toCenter) return idea('kingActivity', [c.to], [[`король идёт к центру: ${tail}`, `ведёшь короля к центру: ${tail}`]], { variant: 'center' });
  return idea('kingActivity', [c.to], [[`король подходит к пешкам: ${tail}`, `ведёшь короля к пешкам: ${tail}`]], { variant: 'pawns' });
}

/** Squares next to `color`'s king it may step to (no own piece, not attacked — the king itself is lifted off). */
function kingFreeSquares(board: Board, color: Color): number {
  const king = findKing(board, color);
  if (king < 0) return 0;
  const enemy = opposite(color);
  const lifted = [...board];
  lifted[king] = null;
  let n = 0;
  for (const [df, dr] of ALL_DIRS) {
    const f = fileOf(king) + df;
    const r = rankOf(king) + dr;
    if (!onBoard(f, r)) continue;
    const sq = toIndex(f, r);
    const p = piece(lifted, sq);
    if (p && p.color === color) continue;
    if (attackersOf(lifted, sq, enemy).length > 0) continue;
    n += 1;
  }
  return n;
}

function detectRestrictKing(c: Ctx): MoveIdea | null {
  if (c.mv.givesMate || !c.safeLanding) return null;
  const theirs = c.b1.filter((p): p is BoardPiece => !!p && p.color === c.them);
  if (theirs.some((p) => p.type !== 'k' && p.type !== 'p')) return null;
  if (materialOf(c.b1, c.me) - materialOf(c.b1, c.them) < 5) return null;
  if (kingFreeSquares(c.b0, c.them) - kingFreeSquares(c.b1, c.them) < 1) return null;
  if (new Chess(c.mv.fenAfter).isStalemate()) return null;
  const mine = c.b1.filter((p): p is BoardPiece => !!p && p.color === c.me);
  const queens = mine.filter((p) => p.type === 'q').length;
  const rooks = mine.filter((p) => p.type === 'r').length;
  const conceptId =
    queens + rooks >= 2 ? 'endgame-ladder-mate' : queens === 1 ? 'endgame-queen-mate' : rooks === 1 ? 'endgame-rook-mate' : undefined;
  return idea(
    'restrictKing',
    [findKing(c.b1, c.them)],
    [['отнимает у короля клетки — загоняем его к краю', 'отнимаешь у короля клетки — загоняем его к краю']],
    conceptId ? { conceptId } : {},
  );
}

/** P1: kings and pawns only; the kings face each other with one square between and the opponent may only move the king. */
function detectOpposition(c: Ctx): MoveIdea | null {
  if (c.mv.piece !== 'k' || c.mv.isCastle) return null;
  if (c.b1.some((p) => p && p.type !== 'k' && p.type !== 'p')) return null;
  const mine = c.to;
  const theirs = findKing(c.b1, c.them);
  if (theirs < 0) return null;
  const df = Math.abs(fileOf(mine) - fileOf(theirs));
  const dr = Math.abs(rankOf(mine) - rankOf(theirs));
  if (!((df === 0 && dr === 2) || (dr === 0 && df === 2))) return null;
  const replies = new Chess(c.mv.fenAfter).moves({ verbose: true });
  if (replies.length === 0 || replies.some((m) => m.piece !== 'k')) return null;
  return idea(
    'opposition',
    [mine, theirs],
    [['встаёт в оппозицию: король соперника должен уступить дорогу', 'встаёшь в оппозицию: король соперника должен уступить дорогу']],
    { conceptId: 'endgame-opposition' },
  );
}

// ───────────────────────── F: the rest ─────────────────────────

function mobility(board: Board, sq: number): number {
  const p = piece(board, sq);
  if (!p) return 0;
  return attacksFrom(board, sq).filter((t) => piece(board, t)?.color !== p.color).length;
}

function detectImprovePiece(c: Ctx, found: readonly MoveIdea[]): MoveIdea | null {
  const P = c.mv.piece;
  if (c.mv.promotion || (P !== 'n' && P !== 'b' && P !== 'r' && P !== 'q')) return null;
  // Not in the opening (an early queen is never «активнее»), not for a capture or next to «выводит в игру», never onto
  // an unsafe square.
  if (c.phase === 'opening' || c.mv.captured || !c.safeLanding) return null;
  if (found.some((i) => i.id === 'develop' || i.id === 'castle')) return null;
  // a piece pinned to its own king sees nothing it may use
  if (absolutePins(c.b1, c.me).some((p) => p.pinned === c.to)) return null;
  if (mobility(c.b1, c.to) - mobility(c.b0, c.from) < 2) return null;
  const who = pieceNameRu(P, 'acc');
  const pron = pronNom(P);
  return idea('improvePiece', [c.to], [
    [`ставит ${who} активнее: отсюда ${pron} видит больше клеток`, `ставишь ${who} активнее: отсюда ${pron} видит больше клеток`],
  ]);
}

/**
 * «спокойный крепкий ход» — only when nothing else was found AND the move gives nothing away statically: the piece is
 * safe where it lands, it is not a losing capture, no own piece is left en prise, and it is not a king walk in the
 * opening.
 */
function detectQuiet(c: Ctx, found: readonly MoveIdea[], cap: CaptureInfo | null): MoveIdea | null {
  if (found.some((i) => !SECOND_ONLY.has(i.id))) return null;
  if (!c.safeLanding || (cap && cap.see < 0) || c.captureRefuted) return null;
  // A king walk in the opening is never «крепкий».
  if (c.mv.piece === 'k' && c.phase === 'opening') return null;
  let hanging;
  try {
    hanging = findHanging(c.mv.fenAfter);
  } catch {
    return null;
  }
  if (hanging.some((h) => h.color === c.me && h.seeLossCp >= 100)) return null;
  return idea('quiet', [], [['спокойный крепкий ход', 'спокойный крепкий ход']]);
}

// ───────────────────────── collection ─────────────────────────

function collect(c: Ctx, only: ReadonlySet<MoveIdeaId> | null): MoveIdea[] {
  const found: MoveIdea[] = [];
  const allowed = (id: MoveIdeaId): boolean => !only || only.has(id);
  const add = (id: MoveIdeaId, detect: () => MoveIdea | null): void => {
    if (!allowed(id)) return;
    const got = detect();
    if (got) found.push(got);
  };
  const cap = captureInfo(c);
  const staticOnly = only !== null;
  if (cap && cap.see >= 100 && !isRecapture(c, cap) && !captureKeepsMaterial(c)) c.captureRefuted = true;

  add('mate', () => detectMate(c));
  add('mateSoon', () => detectMateSoon(c));
  add('promotion', () => detectPromotion(c));
  if (!staticOnly) {
    const tactic = detectTactic(c);
    if (tactic) found.push(tactic);
  }
  add('freeCapture', () => detectFreeCapture(c, cap));
  add('winMaterial', () => detectWinMaterial(c, cap));
  add('recapture', () => detectRecapture(c, cap));
  add('defendMate', () => detectDefendMate(c));
  add('answerCheck', () => detectAnswerCheck(c, found));
  add('escape', () => detectEscape(c));
  const rescued = allowed('defend') || allowed('block') ? rescuedPieces(c) : [];
  add('defend', () => detectDefend(c, rescued));
  add('block', () => detectBlock(c, rescued));
  add('threatMate', () => detectThreatMate(c));
  add('attack', () => detectAttack(c));
  add('check', () => detectCheck(c, found));
  add('castle', () => detectCastle(c));
  add('develop', () => detectDevelop(c));
  add('centerPawn', () => detectCenterPawn(c));
  add('fightCenter', () => detectFightCenter(c, found));
  add('supportCenter', () => detectSupportCenter(c, found));
  add('openLine', () => detectOpenLine(c));
  add('aimWeakSquare', () => detectAimWeakSquare(c));
  add('prepareCastle', () => detectPrepareCastle(c));
  add('centerControl', () => detectCenterControl(c));
  add('connectRooks', () => detectConnectRooks(c));
  add('rookOpenFile', () => detectRookOpenFile(c));
  add('rookSeventh', () => detectRookSeventh(c));
  add('passedPawn', () => detectPassedPawn(c));
  add('trade', () => detectTrade(c, cap));
  add('space', () => detectSpace(c, found));
  add('kingActivity', () => detectKingActivity(c));
  add('restrictKing', () => detectRestrictKing(c));
  add('opposition', () => detectOpposition(c));
  add('improvePiece', () => detectImprovePiece(c, found));
  add('quiet', () => detectQuiet(c, found, cap));
  return found;
}

// ───────────────────────── public API ─────────────────────────

/**
 * Every idea of the move `uci` played in `fen`, most important first (§4.2 order). Empty for an illegal move or a broken
 * FEN, and when the move gives material away with no idea to show for it (then even «спокойный ход» would be a lie).
 *
 * The tactics (fork, pin …) need the engine line in `pvUci` — their payoff must be inside the line. `quiet` claims the
 * move is solid: it is meant for engine-approved moves (advice), not for describing a weak move.
 */
export function explainMove(a: ExplainMoveArgs): MoveIdea[] {
  try {
    const ctx = makeCtx(a);
    return ctx ? collect(ctx, null) : [];
  } catch {
    return [];
  }
}

function pairOf(a: MoveIdea, b: MoveIdea, left: ReadonlySet<MoveIdeaId>, right: ReadonlySet<MoveIdeaId>): boolean {
  return (left.has(a.id) && right.has(b.id)) || (left.has(b.id) && right.has(a.id));
}

const WIN_MATERIAL = new Set<MoveIdeaId>(['winMaterial']);

/**
 * The named pairs of §4.2 are allowed on every stage — even inside one group («ставит пешку в центр и открывает дорогу
 * слону» is C + C, «выгодно бьёт … и уводит …» is A + A); from stage 3 on also any pair of two different groups.
 */
function pairAllowed(a: MoveIdea, b: MoveIdea, stage: number): boolean {
  if (pairOf(a, b, PRINCIPLE, PRINCIPLE_WITH) || pairOf(a, b, RESCUE, RESCUE_WITH) || pairOf(a, b, WIN_MATERIAL, WIN_THAT_SAVES)) return true;
  return stage >= 3 && a.group !== b.group;
}

/**
 * The ideas to SAY (§4.2 «Сколько идей называть»): usually one — the first by priority (`centerControl` is never the
 * first, `quiet` never gets a partner); two when `max` is 2: the partner is the best-ranked other idea whose phrase fits
 * with the first into 14 words and that makes an allowed pair — on stages 1–2 only the named principle pairs, from
 * stage 3 also any two ideas of different groups.
 * `avoid` removes ideas (e.g. the main idea of the previous utterance); the caller may retry without it.
 *
 * The result is in SPEECH order: a principle before its consequence («выводит коня и нападает на пешку»), otherwise
 * by priority. Join with `joinIdeasRu`.
 */
export function pickIdeas(ideas: readonly MoveIdea[], o: { stage: number; max: 1 | 2; avoid?: readonly MoveIdeaId[] }): MoveIdea[] {
  const avoid = new Set(o.avoid ?? []);
  const pool = ideas.filter((i) => !avoid.has(i.id));
  const first = pool.find((i) => !SECOND_ONLY.has(i.id));
  if (!first) return [];
  if (o.max < 2 || SOLO_ONLY.has(first.id)) return [first];
  const covered = new Set<MoveIdeaId>(first.covers ?? []);
  const concrete = (i: MoveIdea): boolean => i.group === 'A' || i.group === 'B';
  const second = pool.find(
    (i) =>
      i !== first &&
      i.id !== first.id &&
      !SOLO_ONLY.has(i.id) &&
      !covered.has(i.id) &&
      !(i.covers ?? []).includes(first.id) &&
      // «ловит слона …» + «нападает на слона …» say the same thing twice
      !(concrete(first) && concrete(i) && i.squares.length > 0 && i.squares.every((sq) => first.squares.includes(sq))) &&
      // «смотрит в центр» only rounds off a principle or a piece move, never a tactic, a threat or an endgame idea
      !(SECOND_ONLY.has(i.id) && first.group !== 'C' && first.group !== 'F') &&
      // the capture of a combination is part of it, not a separate «меняет слона на коня»
      !(i.id === 'trade' && first.group === 'A') &&
      // «ставит ладью на открытую линию и ставит ладью активнее» — one verb once
      firstWordRu(i.phraseRu) !== firstWordRu(first.phraseRu) &&
      pairAllowed(first, i, o.stage) &&
      ideaWordCount(first.phraseRu) + ideaWordCount(i.phraseRu) <= MAX_IDEA_PAIR_WORDS &&
      ideaWordCount(first.phraseYouRu) + ideaWordCount(i.phraseYouRu) <= MAX_IDEA_PAIR_WORDS,
  );
  if (!second) return [first];
  return PRINCIPLE.has(second.id) && first.group === 'B' ? [second, first] : [first, second];
}

function firstWordRu(text: string): string {
  return text.trim().split(/\s+/)[0] ?? '';
}

/**
 * One or two picked ideas as one phrase: «выводит коня и нападает на пешку на е пять» (`voice: 'you'` →
 * «выводишь коня и нападаешь …»). «в игру» is dropped from a leading «выводит … в игру».
 */
export function joinIdeasRu(ideas: readonly MoveIdea[], voice: 'brief' | 'you' = 'brief'): string {
  const say = (i: MoveIdea): string => (voice === 'you' ? i.phraseYouRu : i.phraseRu);
  const [a, b] = ideas;
  if (!a) return '';
  if (!b) return say(a);
  const head = a.id === 'develop' ? say(a).replace(/ в игру$/, '') : say(a);
  if (/[:—]/.test(head)) return `${head}; ещё ${say(b)}`;
  // «выводишь коня, и он смотрит в центр» — not «выводишь коня и конь смотрит в центр» (the «ты» form names the piece)
  if (voice === 'you' && b.id === 'centerControl') {
    const noun = b.phraseYouRu.split(' ')[0] ?? '';
    const named = CENTER_PIECE_ACC[noun];
    if (named && new RegExp(`(^|\\s)${named}(\\s|$)`, 'u').test(head)) return `${head}, и ${noun === 'ладья' ? 'она' : 'он'} смотрит в центр`;
  }
  return `${head} и ${say(b)}`;
}

/** The pieces «смотрит в центр» can be about (nominative → accusative), to avoid naming the piece twice. */
const CENTER_PIECE_ACC: Readonly<Record<string, string>> = { конь: 'коня', слон: 'слона', ферзь: 'ферзя', ладья: 'ладью' };

/**
 * The bot's move for the teacher (§4.3): its static ideas only (rules 5–21, 25, 26, 28: no engine line, no tactics,
 * never «quiet» — a move without an idea is not commented), and what the opponent WANTS: `opts.threat` (the null-move
 * threat of the background search, when there is one), else a static mate-in-one threat in `childFenAfter`.
 */
export function explainOpponentMove(
  fenBefore: string,
  uci: string,
  childFenAfter: string,
  opts: { threat?: Threat | null; prev?: { uci: string; fenBefore: string } | null } = {},
): { ideas: MoveIdea[]; wants: Threat | null } {
  let ideas: MoveIdea[] = [];
  let fenAfter = childFenAfter;
  try {
    const ctx = makeCtx({ fen: fenBefore, uci, prev: opts.prev ?? null });
    if (ctx) {
      ctx.forOpponent = true;
      ideas = collect(ctx, new Set(STATIC_IDEA_IDS));
      if (!isUsableFen(fenAfter)) fenAfter = ctx.mv.fenAfter;
    }
  } catch {
    ideas = [];
  }
  let wants: Threat | null = opts.threat ?? null;
  if (!wants && isUsableFen(fenAfter)) {
    try {
      wants = mateInOneThreat(fenAfter);
    } catch {
      wants = null;
    }
  }
  return { ideas, wants };
}

function isUsableFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

/** Reasons a queen move is NOT the early-queen mistake: it wins ≥ 2 pawns, mates, saves from mate / check, saves a
 *  piece or recaptures. A pawn grab with the queen (`freeCapture` of one pawn) is no excuse. */
const QUEEN_EXCUSES: ReadonlySet<MoveIdeaId> = new Set(['mate', 'mateSoon', 'promotion', 'defendMate', 'answerCheck', 'escape', 'defend', 'block', 'recapture']);

function isQueenExcuse(i: MoveIdea): boolean {
  return QUEEN_EXCUSES.has(i.id) || (i.group === 'A' && (i.gainPawns ?? 0) >= 2);
}

/**
 * The kid filter of the advice (§2.4 п. 4; cf. G02 / G08): ANY queen move while at least two own minor pieces
 * still sleep at home — not only the first one from d1 / d8 — unless one of `ideas` excuses it (`QUEEN_EXCUSES`). The
 * caller limits it to the opening.
 */
export function isKidFilteredQueenMove(fen: string, uci: string, ideas: readonly MoveIdea[]): boolean {
  const mv = resolveUciMove(fen, uci);
  if (!mv || mv.piece !== 'q') return false;
  if (minorsAtHome(parsePlacement(fen), mv.color) < 2) return false;
  return !ideas.some(isQueenExcuse);
}

/**
 * «Ранний выход ферзя» (§2.4, §3.1): the queen leaves its original square (d1 / d8) within the first 10 moves while at
 * least two own minor pieces are still at home — and the move is not a DEFENCE (G03 5…Фe7 guarding f7, G08 7…Фe7):
 * no excusing idea (`QUEEN_EXCUSES`), and not a short step (≤ 2 squares) that newly guards an own attacked unit.
 */
export function isEarlyQueenMove(fen: string, uci: string): boolean {
  const mv = resolveUciMove(fen, uci);
  if (!mv || mv.piece !== 'q') return false;
  if (mv.from !== (mv.color === 'w' ? 'd1' : 'd8') || fullMoveOf(fen) > 10) return false;
  const b0 = parsePlacement(fen);
  if (minorsAtHome(b0, mv.color) < 2) return false;
  return !isDefensiveQueenMove(fen, uci, mv, b0);
}

function isDefensiveQueenMove(fen: string, uci: string, mv: ResolvedMove, b0: Board): boolean {
  if (explainMove({ fen, uci }).some(isQueenExcuse)) return true;
  const from = squareIndex(mv.from);
  const to = squareIndex(mv.to);
  if (chebyshev(from, to) > 2) return false;
  const b1 = parsePlacement(mv.fenAfter);
  const them = opposite(mv.color);
  for (let x = 0; x < 64; x++) {
    const p = piece(b1, x);
    if (!p || p.color !== mv.color || p.type === 'k' || x === to) continue;
    if (attackersOf(b1, x, them).length === 0 || !defendersOf(b1, x, mv.color).includes(to)) continue;
    if (defendersOf(b0, x, mv.color).includes(from)) continue;
    return true;
  }
  return false;
}

// ───────────────────────── §4.4: what the child's move loses ─────────────────────────

/** «не …» phrases for §2.5 п. 3 (groups C–E). */
const MISSING_RU: Partial<Record<MoveIdeaId, string>> = {
  castle: 'не прячет короля',
  // «фигура» would be false after an early queen move — the queen IS a piece that came out
  develop: 'не выводит коня или слона',
  centerPawn: 'не занимает центр',
  fightCenter: 'не борется за центр',
  supportCenter: 'не готовит центр',
  openLine: 'не открывает дорогу фигурам',
  aimWeakSquare: 'не целится в слабую клетку',
  prepareCastle: 'не готовит рокировку',
  centerControl: 'не борется за центр',
  connectRooks: 'не соединяет ладьи',
  rookOpenFile: 'не ставит ладью на открытую линию',
  rookSeventh: 'не пускает ладью на седьмую',
  passedPawn: 'не двигает проходную',
  trade: 'не меняет фигуры',
  kingActivity: 'не ведёт короля вперёд',
  restrictKing: 'не теснит короля',
  opposition: 'не встаёт в оппозицию',
};

const PAWNS_RU: readonly string[] = ['', 'одна пешка', 'две пешки', 'три пешки', 'четыре пешки', 'пять пешек', 'шесть пешек', 'семь пешек', 'восемь пешек', 'девять пешек'];
const MATE_IN_RU: readonly string[] = ['', 'сразу', 'за два хода', 'за три хода', 'за четыре хода', 'за пять ходов'];

export interface MoveLossArgs {
  judgement: Pick<MoveJudgement, 'fenBefore' | 'fenAfter' | 'uci' | 'winPctLoss' | 'materialLossPawns' | 'refutationPvUci' | 'evalAfter'>;
  /** the advice the child had for this move, primary first (UCI) */
  adviceUci?: readonly string[];
  /** the move before the child's (the bot's): a recapture of the child is told as one */
  prev?: { uci: string; fenBefore: string } | null;
  /** phase of `fenBefore` (computed when absent) */
  phase?: PositionFacts['phase'];
}

export interface MoveLoss {
  /** only from `winPctLoss`: < 10 → «чуть слабее», ≥ 10 → «заметно слабее» */
  severityRu: 'чуть слабее' | 'заметно слабее';
  /** the opponent's first refutation move with its static ideas (third person, as `explainOpponentMove`) */
  reply: { uci: string; san: string; spokenRu: string; ideas: MoveIdea[] } | null;
  /** C–E ideas of the primary advice that the played move does not have */
  missing: MoveIdea[];
  /** the concrete (A / B) idea of the primary advice the played move does not have («нападает на ферзя») */
  adviceWin: MoveIdea | null;
  /** up to two facts for the brief, in the order of §2.5: the reply → material / mate → missing ideas → «так тоже можно» */
  factsRu: string[];
}

/**
 * What a weaker own move of the child costs (§4.4, §2.5 «weaker»): only code-verified facts — the refutation's first
 * move seen with the opponent's eyes, the material / mate the judgement measured, the principles the advice had and the
 * played move lacks. Nothing is invented: with none of these the fact is «так тоже можно, но чуть слабее».
 */
export function explainMoveLoss(a: MoveLossArgs): MoveLoss {
  const j = a.judgement;
  const severityRu = j.winPctLoss >= 10 ? 'заметно слабее' : 'чуть слабее';
  const facts: string[] = [];

  let reply: MoveLoss['reply'] = null;
  const first = j.refutationPvUci[0];
  if (first) {
    const mv = resolveUciMove(j.fenAfter, first);
    if (mv) {
      const { ideas } = explainOpponentMove(j.fenAfter, first, mv.fenAfter, { prev: { uci: j.uci, fenBefore: j.fenBefore } });
      reply = { uci: first, san: mv.san, spokenRu: sanToSpokenRu(mv.san, j.fenAfter), ideas };
      const said = pickIdeas(ideas, { stage: 3, max: 1 });
      if (said.length > 0) facts.push(`соперник может ответить: ${reply.spokenRu} — ${joinIdeasRu(said)}`);
    }
  }

  const mateIn = j.evalAfter.mate !== null && j.evalAfter.mate < 0 ? -j.evalAfter.mate : null;
  if (mateIn !== null && mateIn <= 5) {
    facts.push(`соперник может поставить мат ${MATE_IN_RU[mateIn]}`);
  } else {
    const pawns = Math.round(j.materialLossPawns);
    if (pawns >= 1) facts.push(`в итоге теряется материал: ${PAWNS_RU[pawns] ?? 'больше девяти пешек'}`);
  }

  let missing: MoveIdea[] = [];
  let adviceWin: MoveIdea | null = null;
  const advice = (a.adviceUci ?? []).map((m) => m.trim().toLowerCase());
  const primary = advice[0];
  if (primary && !advice.includes(j.uci.trim().toLowerCase())) {
    const phase = a.phase ?? phaseOf(j.fenBefore);
    const prev = a.prev ?? null;
    const played = new Set(explainMove({ fen: j.fenBefore, uci: j.uci, phase, prev }).map((i) => i.id));
    const primaryIdeas = explainMove({ fen: j.fenBefore, uci: primary, phase, prev });
    // G03 5…Фe7 instead of 5…Кd4: the advice ATTACKED the queen — say that first, it is the real point
    // concrete only: a group-A idea, a mate threat, or an attack on a PIECE (an attack on a pawn is weaker than the
    // missing principles «не выводит коня…»)
    adviceWin =
      primaryIdeas.find((i) => {
        if (played.has(i.id)) return false;
        if (i.group === 'A') return true;
        if (i.id === 'threatMate') return true;
        return i.id === 'attack' && i.squares.some((sq) => (piece(parsePlacement(j.fenBefore), squareIndex(sq))?.type ?? 'p') !== 'p');
      }) ?? null;
    const primaryMove = resolveUciMove(j.fenBefore, primary);
    if (adviceWin && primaryMove) facts.push(`а ход из совета, ${sanToSpokenRu(primaryMove.san, j.fenBefore)}, ${adviceWin.phraseRu}`);
    const seen = new Set<string>();
    missing = primaryIdeas.filter((i) => {
      const neg = MISSING_RU[i.id];
      if (!neg || played.has(i.id) || seen.has(neg) || !['C', 'D', 'E'].includes(i.group)) return false;
      seen.add(neg);
      return true;
    });
    const negs = missing.slice(0, 2).map((i) => MISSING_RU[i.id] as string);
    if (negs.length > 0) facts.push(`этот ход ${negs.join(' и ')} — а совет это делал`);
  }

  const factsRu = facts.slice(0, 2);
  if (factsRu.length === 0) factsRu.push(`так тоже можно, но ${severityRu}`);
  return { severityRu, reply, missing, adviceWin, factsRu };
}
