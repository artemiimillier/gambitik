/**
 * Board cues of «Учитель» (docs/TEACHING.md §3): the voice says «оттуда конь будет бить вот эти клетки», the board
 * shows which. The words are pre-written; the squares are computed here from the position — never by an AI. An empty
 * `squares` means the code could not resolve the cue; the phrase stays true, the board just shows less.
 */
import type { Color, CueKind, LessonCue, Square, Threat } from '@gambit/shared';
import { attacksFrom, parsePlacement, squareIndex, squareName } from '../../analysis/board.ts';
import type { Board } from '../../analysis/board.ts';
import { isSquare, kingSquare, parseUci, resolveUciMove } from './../board.ts';

/** What a phrase is about, for resolving its cues. Squares are as they stand in `fen` (before `move`). */
export interface CueFacts {
  /** the position the phrase is about (the child to move, or the position before the move the phrase is about) */
  fen: string;
  /** the side the phrase takes (the child) */
  childColor: Color;
  /** the move the phrase is about (the advice, the child's move, a quiz answer) */
  move?: { uci: string } | null;
  /** the child's previous move (the «Зачем мы так сходили?» quiz) */
  lastMove?: { uci: string } | null;
  /** the opponent's piece we capture / attack / trade */
  target?: Square | null;
  /** our piece in danger */
  victim?: Square | null;
  /** our piece a move defends */
  defended?: Square | null;
  /** the piece the phrase is about (default: the moving piece's square) */
  piece?: Square | null;
  /** the opponent's threat (null-move) */
  threat?: Threat | null;
  /** whose king / weak pawn the phrase is about (default: the opponent's when we act, ours on danger) */
  kingOf?: Color | null;
  /** an explicit line (pin, skewer, discovered attack): from → to inclusive */
  line?: { from: Square; to: Square } | null;
}

const CENTER: readonly Square[] = ['d4', 'e4', 'd5', 'e5'];
const FILES = 'abcdefgh';

const TONE: Readonly<Record<CueKind, LessonCue['tone']>> = {
  move: 'good',
  attacks: 'good',
  line: 'good',
  flank: 'info',
  center: 'info',
  capture: 'good',
  threat: 'danger',
  hanging: 'danger',
  piece: 'info',
  king: 'info',
  weak: 'info',
  path: 'good',
  defend: 'good',
  lastMove: 'info',
};

function opp(c: Color): Color {
  return c === 'w' ? 'b' : 'w';
}

function arrowOf(uci: string | undefined | null): { from: Square; to: Square } | null {
  if (!uci) return null;
  const p = parseUci(uci);
  return p ? { from: p.from, to: p.to } : null;
}

function boardAfter(f: CueFacts): { board: Board; to: Square; fenAfter: string } | null {
  if (!f.move) return null;
  const mv = resolveUciMove(f.fen, f.move.uci);
  if (!mv) return null;
  return { board: parsePlacement(mv.fenAfter), to: mv.to, fenAfter: mv.fenAfter };
}

/** Squares a piece attacks after the move, without our own pieces (where it «shoots»). */
function attackedAfter(f: CueFacts): Square[] {
  const a = boardAfter(f);
  if (!a) return [];
  const from = squareIndex(a.to);
  const me = a.board[from]?.color;
  return attacksFrom(a.board, from)
    .filter((i) => a.board[i]?.color !== me)
    .map(squareName);
}

function between(from: Square, to: Square): Square[] {
  const a = squareIndex(from);
  const b = squareIndex(to);
  const df = Math.sign((b & 7) - (a & 7));
  const dr = Math.sign((b >> 3) - (a >> 3));
  const straight = (a & 7) === (b & 7) || a >> 3 === b >> 3 || Math.abs((b & 7) - (a & 7)) === Math.abs((b >> 3) - (a >> 3));
  if (!straight || a === b) return [from, to].filter(isSquare) as Square[];
  const out: Square[] = [];
  for (let i = a; ; i += dr * 8 + df) {
    out.push(squareName(i));
    if (i === b || out.length > 8) break;
  }
  return out;
}

/** The lines of a rook / bishop / queen after the move, or the lines a pawn move opens for our sliders. */
function linesAfter(f: CueFacts): Square[] {
  if (f.line) return between(f.line.from, f.line.to);
  const mv = f.move ? resolveUciMove(f.fen, f.move.uci) : undefined;
  if (!mv) return [];
  const b1 = parsePlacement(mv.fenAfter);
  if (mv.piece === 'b' || mv.piece === 'r' || mv.piece === 'q') {
    const from = squareIndex(mv.to);
    return attacksFrom(b1, from).map(squareName);
  }
  // a pawn (or any) move that opens lines for our bishops / queen / rooks
  const b0 = parsePlacement(f.fen);
  const out = new Set<Square>();
  b1.forEach((pc, i) => {
    if (!pc || pc.color !== mv.color || !['b', 'q', 'r'].includes(pc.type)) return;
    const before = new Set(b0[i]?.type === pc.type && b0[i]?.color === pc.color ? attacksFrom(b0, i) : []);
    for (const s of attacksFrom(b1, i)) if (!before.has(s)) out.add(squareName(s));
  });
  return [...out];
}

function flankOf(sq: Square | undefined): Square[] {
  if (!sq) return [];
  const file = FILES.indexOf(sq.charAt(0));
  const files = file >= 4 ? 'efgh' : 'abcd';
  const out: Square[] = [];
  for (const fl of files) for (let r = 1; r <= 8; r++) out.push(`${fl}${r}` as Square);
  return out;
}

function pathOf(sq: Square | undefined, color: Color): Square[] {
  if (!sq) return [];
  const file = sq.charAt(0);
  const rank = Number(sq.charAt(1));
  const out: Square[] = [];
  if (color === 'w') for (let r = rank; r <= 8; r++) out.push(`${file}${r}` as Square);
  else for (let r = rank; r >= 1; r--) out.push(`${file}${r}` as Square);
  return out;
}

/** The mover's colour: the side to move in `fen`. */
function moverColor(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** Resolves one cue kind for a phrase said in sentence `sentence`. */
export function resolveCue(kind: CueKind, f: CueFacts, sentence: number): LessonCue {
  const cue = (squares: Square[], arrows?: { from: Square; to: Square }[]): LessonCue => ({
    kind,
    sentence,
    squares: [...new Set(squares.filter(isSquare))] as Square[],
    ...(arrows && arrows.length > 0 ? { arrows } : {}),
    tone: TONE[kind],
  });
  const move = arrowOf(f.move?.uci);
  try {
    switch (kind) {
      case 'move':
        return cue(move ? [move.to] : [], move ? [move] : []);
      case 'attacks':
        return cue(attackedAfter(f));
      case 'line':
        return cue(linesAfter(f));
      case 'flank':
        return cue(flankOf(f.target ?? move?.to ?? f.piece ?? undefined));
      case 'center':
        return cue([...CENTER]);
      case 'capture': {
        const target = f.target ?? null;
        return cue(target ? [target] : [], move && target ? [{ from: move.from, to: target }] : []);
      }
      case 'threat': {
        const t = f.threat ?? null;
        const arrow = arrowOf(t?.uci);
        return cue([...(t?.targetSquares ?? []), ...(f.victim ? [f.victim] : [])], arrow ? [arrow] : []);
      }
      case 'hanging':
        return cue([f.victim ?? f.target].filter((s): s is Square => !!s));
      case 'piece':
        return cue([f.piece ?? move?.from].filter((s): s is Square => !!s));
      case 'king': {
        const color = f.kingOf ?? opp(f.childColor);
        const k = kingSquare(f.fen, color);
        const mv = f.move ? resolveUciMove(f.fen, f.move.uci) : undefined;
        const castle = mv?.isCastle && move ? [move] : [];
        return cue(k ? [k] : [], castle);
      }
      case 'weak': {
        const color = f.kingOf ?? opp(f.childColor);
        const sq: Square = color === 'b' ? 'f7' : 'f2';
        return cue([sq]);
      }
      case 'path': {
        const mv = f.move ? resolveUciMove(f.fen, f.move.uci) : undefined;
        const sq = mv?.to ?? f.piece ?? undefined;
        return cue(pathOf(sq, mv?.color ?? moverColor(f.fen)));
      }
      case 'defend':
        return cue([f.defended].filter((s): s is Square => !!s));
      case 'lastMove': {
        const a = arrowOf(f.lastMove?.uci);
        return cue(a ? [a.to] : [], a ? [a] : []);
      }
    }
  } catch {
    // a broken FEN or move: the phrase stays, the board shows nothing for it
  }
  return cue([]);
}

/** The cues of one sentence, from the cue kinds of its lines (each kind once). */
export function resolveCues(kinds: readonly CueKind[], f: CueFacts, sentence: number): LessonCue[] {
  return [...new Set(kinds)].map((k) => resolveCue(k, f, sentence));
}
