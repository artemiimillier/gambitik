/**
 * The goals of a strategy card as structure, not text (docs/TEACHING.md §6.4): what the goal is, when it is
 * achieved by the child, when it has become impossible. The lesson uses it instead of the regex `planGoalDone` (praise
 * «цель выполнена», the theme link, the takeaway «тема сработала»): losing the bishop is not «the bishop aims at f7».
 *
 * Every library goal text (`planGoalsRu` of the 24 cards) is mapped twice: to its squareless line key by
 * `PLAN_GOAL_LINES` (../clips/catalog.ru.ts: text → `goal.<key>`), and to a checkable shape by `GOAL_SHAPES` below
 * (text → kind + board parameters). The squares of a text are absolute: a text belongs to the card of one colour.
 * Truth rules (§6.4): castling counts only by a castling move in the history, never by a king
 * walk; «aim at» holds only while the target pawn stands and our piece of that type really attacks it; a goal about a
 * piece we no longer have is impossible, never «done».
 */
import type { Color, PieceType } from '@gambit/shared';
import { LESSON_GOAL_KEYS } from '@gambit/content';
import type { LessonGoalKey } from '@gambit/content';
import type { StrategyCardLike } from '../teacher.ts';
import { VALUE_PAWNS, attackersOf, attacksFrom, fileOf, findKing, firstPieceAlong, materialOf, opposite, parsePlacement, rankOf, squareIndex } from '../../analysis/board.ts';
import type { Board, Direction } from '../../analysis/board.ts';
import { planGoalLineOf } from '../clips/catalog.ru.ts';

export type ThemeGoalKind = 'castle' | 'develop' | 'pieceOn' | 'aimAt' | 'pawnStrike' | 'pin' | 'longDiagonal' | 'hold';

export interface ThemeGoal {
  /** the squareless goal line: `v3.goal.<key>` / `v3.goalDone.<key>` */
  key: LessonGoalKey;
  kind: ThemeGoalKind;
  /** the card's goal text it comes from (`planGoalsRu`, for the journal) */
  textRu: string;
  /** kind-specific parameters (piece type, squares, the target square…), in board terms — never spoken */
  params: Readonly<Record<string, string | readonly string[]>>;
}

type Params = Readonly<Record<string, string | readonly string[]>>;
interface GoalShape {
  kind: ThemeGoalKind;
  params: Params;
}

const CENTER: readonly string[] = ['d4', 'e4', 'd5', 'e5'];

/**
 * The shape of every library goal text (the keys of PLAN_GOAL_LINES). Parameters by kind:
 *  - castle: {} — a castling move of the child in the history;
 *  - develop: `mode` 'all' (no knight / bishop at home), 'knights' (both knights out, not on the edge), 'allCastle'
 *    (all minors out AND castled);
 *  - pieceOn: `piece` + `squares` (one of them), or `file` ('c' … or 'halfOpen' = a file without our pawns), or
 *    `beyond: 'yes'` (the bishop of the `home` square is out past our pawn rank); `home` + `before` (a pawn square
 *    that shuts the piece in when it is played first);
 *  - aimAt: `pieces` (all of these attack), `target` (squares, one of them holds an enemy `targetPiece`), or
 *    `targetPiece` alone (any such enemy piece, `defendsCentre: 'yes'` = one that guards an enemy centre pawn),
 *    `target: 'kingZone'` (the enemy king and its neighbours);
 *  - pawnStrike: `square` (our pawn stands there; `hits: 'yes'` = and attacks an enemy pawn), or `files` + `count` +
 *    `minRank` (that many of our pawns on those files reached that relative rank);
 *  - pin: `piece` (our pinning piece) + `targetPiece` (the enemy piece pinned to a queen, rook or king behind it);
 *  - longDiagonal: `side` 'king' (g2 / g7), 'queen' (b2 / b7) or 'any';
 *  - hold: `pawns` (our pawns stand on all of them), or `control` + `by` (+ `count`: our pieces of those types
 *    attack the square), or `mode: 'trade'` (a pair of pieces is traded and we are not behind).
 */
const GOAL_SHAPES: Readonly<Record<string, GoalShape>> = {
  'целимся слоном в слабую точку эф семь': { kind: 'aimAt', params: { pieces: ['b'], target: ['f7'], targetPiece: 'p' } },
  'держим центр пешками цэ три и дэ три': { kind: 'hold', params: { pawns: ['c3', 'd3'] } },
  'держим центр пешками дэ три и цэ три': { kind: 'hold', params: { pawns: ['c3', 'd3'] } },
  'готовим удар пешкой дэ четыре': { kind: 'pawnStrike', params: { square: 'd4' } },
  'готовим пешку дэ четыре в центр': { kind: 'pawnStrike', params: { square: 'd4' } },
  'готовим пешку дэ четыре': { kind: 'pawnStrike', params: { square: 'd4' } },
  'готовим удар пешкой е четыре': { kind: 'pawnStrike', params: { square: 'e4' } },
  'готовим удар пешкой цэ пять': { kind: 'pawnStrike', params: { square: 'c5' } },
  'выводим обоих коней к центру': { kind: 'develop', params: { mode: 'knights' } },
  'связываем коня соперника слоном на же пять': { kind: 'pin', params: { piece: 'b', targetPiece: 'n' } },
  'связываем коня соперника слоном на же четыре': { kind: 'pin', params: { piece: 'b', targetPiece: 'n' } },
  'выводим слона на эф четыре раньше пешки е три': { kind: 'pieceOn', params: { piece: 'b', squares: ['f4'], home: 'c1', before: 'e3' } },
  'выводим слона раньше пешки е шесть': { kind: 'pieceOn', params: { piece: 'b', beyond: 'yes', home: 'c8', before: 'e6' } },
  'выводим слона на эф пять раньше пешки е шесть': { kind: 'pieceOn', params: { piece: 'b', squares: ['f5'], home: 'c8', before: 'e6' } },
  'строим крепость из пешек в центре': { kind: 'hold', params: { pawns: ['c3', 'd4', 'e3'] } },
  'строим крепость пешками дэ четыре, е три и цэ три': { kind: 'hold', params: { pawns: ['c3', 'd4', 'e3'] } },
  'прыгаем конём на е пять': { kind: 'pieceOn', params: { piece: 'n', squares: ['e5'] } },
  'прыгаем конём на е четыре': { kind: 'pieceOn', params: { piece: 'n', squares: ['e4'] } },
  'ставим слона на дэ три смотреть на короля': { kind: 'pieceOn', params: { piece: 'b', squares: ['d3'] } },
  'сразу бьёмся за центр пешкой дэ четыре': { kind: 'pawnStrike', params: { square: 'd4', hits: 'yes' } },
  'выводим фигуры на открытые линии': { kind: 'pieceOn', params: { piece: 'r', file: 'halfOpen' } },
  'держим центр конём на цэ три': { kind: 'pieceOn', params: { piece: 'n', squares: ['c3'] } },
  'давим слоном на коня, который защищает центр': { kind: 'aimAt', params: { pieces: ['b'], targetPiece: 'n', defendsCentre: 'yes' } },
  'ставим ладью на е один в помощь центру': { kind: 'pieceOn', params: { piece: 'r', squares: ['e1'] } },
  'бьём пешкой цэ четыре по центру соперника': { kind: 'pawnStrike', params: { square: 'c4', hits: 'yes' } },
  'сразу бьём по центру пешкой дэ пять': { kind: 'pawnStrike', params: { square: 'd5', hits: 'yes' } },
  'бьём по центру пешкой е пять': { kind: 'pawnStrike', params: { square: 'e5', hits: 'yes' } },
  'бьём по центру пешкой дэ пять': { kind: 'pawnStrike', params: { square: 'd5', hits: 'yes' } },
  'давим ладьёй по линии цэ': { kind: 'pieceOn', params: { piece: 'r', file: 'c' } },
  'занимаем центр пешкой е четыре': { kind: 'pawnStrike', params: { square: 'e4' } },
  'ставим пешку на е пять в центр': { kind: 'pawnStrike', params: { square: 'e5' } },
  'держим центр пешкой е пять': { kind: 'hold', params: { pawns: ['e5'] } },
  'держим центр пешкой дэ пять': { kind: 'hold', params: { pawns: ['d5'] } },
  'крепко держим пешку дэ пять': { kind: 'hold', params: { pawns: ['d5'] } },
  'держим центр пешками цэ шесть и дэ пять': { kind: 'hold', params: { pawns: ['c6', 'd5'] } },
  'держим центр крепкими пешками цэ шесть и дэ пять': { kind: 'hold', params: { pawns: ['c6', 'd5'] } },
  'держим центр пешками дэ шесть и е пять': { kind: 'hold', params: { pawns: ['d6', 'e5'] } },
  'держим центр пешками цэ пять и е пять': { kind: 'hold', params: { pawns: ['c5', 'e5'] } },
  'быстро выводим все фигуры': { kind: 'develop', params: { mode: 'all' } },
  'прячем короля рокировкой': { kind: 'castle', params: {} },
  'прячем короля в крепость рокировкой': { kind: 'castle', params: {} },
  'нападаем конями на пешку е четыре': { kind: 'aimAt', params: { pieces: ['n'], target: ['e4'], targetPiece: 'p' } },
  'давим конями на пешку в центре': { kind: 'aimAt', params: { pieces: ['n'], target: CENTER, targetPiece: 'p' } },
  'давим конём и ферзём на пешку дэ четыре': { kind: 'aimAt', params: { pieces: ['n', 'q'], target: ['d4'], targetPiece: 'p' } },
  'прогоняем слона соперника пешками': { kind: 'aimAt', params: { pieces: ['p'], targetPiece: 'b' } },
  'бьём по цепочке пешек ударом цэ пять': { kind: 'pawnStrike', params: { square: 'c5', hits: 'yes' } },
  'ломаем цепочку ударом эф шесть': { kind: 'pawnStrike', params: { square: 'f6', hits: 'yes' } },
  'спорим за центр пешкой цэ пять сбоку': { kind: 'pawnStrike', params: { square: 'c5' } },
  'ставим слона-дракона на длинную диагональ': { kind: 'longDiagonal', params: { side: 'king' } },
  'ставим слона на длинную диагональ': { kind: 'longDiagonal', params: { side: 'any' } },
  'ставим слона на бэ семь смотреть на центр': { kind: 'longDiagonal', params: { side: 'queen' } },
  'меняем фигуры, чтобы стало просторнее': { kind: 'hold', params: { mode: 'trade' } },
  'освобождаем слона ударом е пять': { kind: 'pawnStrike', params: { square: 'e5' } },
  'держим клетку е четыре стеной из пешек': { kind: 'hold', params: { control: 'e4', by: ['p'], count: '2' } },
  'держим клетку е четыре слоном и конём': { kind: 'hold', params: { control: 'e4', by: ['b', 'n'] } },
  'ведём ферзя и ладью в атаку на короля': { kind: 'aimAt', params: { pieces: ['q', 'r'], target: 'kingZone' } },
  'идём пешкой эф пять в атаку на короля': { kind: 'pawnStrike', params: { square: 'f5' } },
  'выводим фигуры и прячем короля': { kind: 'develop', params: { mode: 'allCastle' } },
  'двигаем пешки ферзевого фланга вперёд': { kind: 'pawnStrike', params: { files: ['a', 'b', 'c'], count: '2', minRank: '4' } },
  'готовим пешку эф пять вперёд': { kind: 'pawnStrike', params: { square: 'f5' } },
};

const GOAL_KEYS: ReadonlySet<string> = new Set(LESSON_GOAL_KEYS);

function normalizeGoalText(text: string): string {
  const t = text.trim().replace(/[.!…]+$/u, '').replace(/\s+/g, ' ');
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/** The structured shape of one library goal text, or null when the text is not known. */
export function themeGoalOf(textRu: string): ThemeGoal | null {
  const line = planGoalLineOf(textRu);
  const key = line?.startsWith('goal.') ? line.slice(5) : null;
  const shape = GOAL_SHAPES[normalizeGoalText(textRu)];
  if (!key || !GOAL_KEYS.has(key) || !shape) return null;
  return { key: key as LessonGoalKey, kind: shape.kind, textRu, params: shape.params };
}

/** The structured goals of a card for the child's colour ([] = none known). */
export function goalsOfCard(card: StrategyCardLike | null | undefined, color: Color): ThemeGoal[] {
  if (!card) return [];
  if (card.side && card.side !== color) return [];
  const out: ThemeGoal[] = [];
  for (const text of card.planGoalsRu ?? []) {
    const g = themeGoalOf(text);
    if (g && !out.some((o) => o.key === g.key && o.textRu === g.textRu)) out.push(g);
  }
  return out;
}

// ───────────────────────── board helpers ─────────────────────────

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

const KNIGHT_HOME: Readonly<Record<Color, readonly string[]>> = { w: ['b1', 'g1'], b: ['b8', 'g8'] };
const DIAGONALS: readonly Direction[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function boardOf(fen: string): Board | null {
  try {
    return parsePlacement(fen);
  } catch {
    return null;
  }
}

function isLight(idx: number): boolean {
  return (fileOf(idx) + rankOf(idx)) % 2 === 1;
}

/** The rank of `idx` counted from `color`'s side (1..8). */
function relRank(idx: number, color: Color): number {
  return color === 'w' ? rankOf(idx) + 1 : 8 - rankOf(idx);
}

function at(board: Board, sq: string): Board[number] {
  const i = squareIndex(sq);
  return i >= 0 ? (board[i] ?? null) : null;
}

function has(board: Board, sq: string, color: Color, type: PieceType): boolean {
  const p = at(board, sq);
  return !!p && p.color === color && p.type === type;
}

function squaresOf(board: Board, color: Color, type: PieceType): number[] {
  const out: number[] = [];
  board.forEach((p, i) => {
    if (p && p.color === color && p.type === type) out.push(i);
  });
  return out;
}

function list(v: string | readonly string[] | undefined): readonly string[] {
  if (v === undefined) return [];
  return typeof v === 'string' ? [v] : v;
}

function str(v: string | readonly string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Our bishops that can ever stand on `sq` (the same square colour). */
function bishopsFor(board: Board, color: Color, sq: string): number[] {
  const i = squareIndex(sq);
  return squaresOf(board, color, 'b').filter((b) => i < 0 || isLight(b) === isLight(i));
}

/** Does any of our pawns stand on `sq`, or can one still get there (same file behind it, or a neighbour file behind)? */
function pawnCanReach(board: Board, color: Color, sq: string): boolean {
  const target = squareIndex(sq);
  if (target < 0) return false;
  if (has(board, sq, color, 'p')) return true;
  const tf = fileOf(target);
  const tr = relRank(target, color);
  return squaresOf(board, color, 'p').some((p) => Math.abs(fileOf(p) - tf) <= 1 && relRank(p, color) < tr);
}

/** The side-to-move-agnostic castling rights of `color` in the FEN. */
function castlingRights(fen: string, color: Color): boolean {
  const field = fen.trim().split(/\s+/)[2] ?? '-';
  return color === 'w' ? /[KQ]/.test(field) : /[kq]/.test(field);
}

/** The king stands castled: g1 + rook f1, or c1 + rook d1 (g8 / c8 for Black). */
function castledShape(board: Board, color: Color): boolean {
  const r = color === 'w' ? '1' : '8';
  return (has(board, `g${r}`, color, 'k') && has(board, `f${r}`, color, 'r')) || (has(board, `c${r}`, color, 'k') && has(board, `d${r}`, color, 'r'));
}

/** The child's moves of a history that starts from the initial position (White = even indices). */
function childMoves(historySan: readonly string[], color: Color): string[] {
  const first = color === 'w' ? 0 : 1;
  return historySan.filter((_, i) => i % 2 === first);
}

function castledInHistory(historySan: readonly string[], color: Color): boolean {
  return childMoves(historySan, color).some((san) => /^O-O(-O)?[+#]?$/.test(san.trim()));
}

function minorsHome(board: Board, color: Color): number {
  return MINOR_HOME[color].filter((h) => has(board, h.sq, color, h.type)).length;
}

/** The first two pieces along a ray from `from` (the front one and the one behind it), or null. */
function rayPair(board: Board, from: number, dir: Direction): { front: number; back: number } | null {
  const front = firstPieceAlong(board, from, dir);
  if (front < 0) return null;
  const back = firstPieceAlong(board, front, dir);
  return back < 0 ? null : { front, back };
}

function kingZone(board: Board, color: Color): number[] {
  const k = findKing(board, color);
  if (k < 0) return [];
  const out = [k];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const f = fileOf(k) + df;
      const r = rankOf(k) + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) out.push(r * 8 + f);
    }
  }
  return out;
}

function nonPawnPieces(board: Board, color: Color): number {
  return board.filter((p) => !!p && p.color === color && p.type !== 'p' && p.type !== 'k').length;
}

// ───────────────────────── achieved ─────────────────────────

function achievedOn(goal: ThemeGoal, board: Board, color: Color, historySan: readonly string[]): boolean {
  const p = goal.params;
  const them = opposite(color);
  switch (goal.kind) {
    case 'castle':
      return castledInHistory(historySan, color);
    case 'develop': {
      const mode = str(p.mode) ?? 'all';
      if (mode === 'knights') {
        const knights = squaresOf(board, color, 'n');
        return knights.length >= 2 && knights.every((k) => !KNIGHT_HOME[color].includes(sqName(k)) && fileOf(k) !== 0 && fileOf(k) !== 7);
      }
      const developed = minorsHome(board, color) === 0;
      return mode === 'allCastle' ? developed && castledInHistory(historySan, color) : developed;
    }
    case 'pieceOn': {
      const piece = (str(p.piece) ?? 'n') as PieceType;
      const squares = list(p.squares);
      if (squares.length > 0) return squares.some((sq) => has(board, sq, color, piece));
      const file = str(p.file);
      if (file) {
        return squaresOf(board, color, piece).some((i) => {
          if (file === 'halfOpen') return !squaresOf(board, color, 'p').some((pw) => fileOf(pw) === fileOf(i));
          return 'abcdefgh'.charAt(fileOf(i)) === file;
        });
      }
      if (str(p.beyond) === 'yes') {
        const home = str(p.home) ?? '';
        return bishopsFor(board, color, home).some((b) => relRank(b, color) >= 4);
      }
      return false;
    }
    case 'aimAt': {
      const pieces = list(p.pieces) as readonly PieceType[];
      const targetPiece = str(p.targetPiece) as PieceType | undefined;
      const attackedBy = (target: number, type: PieceType): boolean => attackersOf(board, target, color).some((a) => board[a]?.type === type);
      const allAttack = (target: number): boolean => pieces.length > 0 && pieces.every((t) => attackedBy(target, t));
      if (str(p.target) === 'kingZone') {
        const zone = kingZone(board, them);
        return pieces.every((t) => zone.some((z) => attackedBy(z, t)));
      }
      const targets = list(p.target);
      if (targets.length > 0) {
        return targets.some((sq) => {
          const i = squareIndex(sq);
          const q = board[i];
          return i >= 0 && !!q && q.color === them && (!targetPiece || q.type === targetPiece) && allAttack(i);
        });
      }
      if (!targetPiece) return false;
      return squaresOf(board, them, targetPiece).some((i) => {
        if (!allAttack(i)) return false;
        if (str(p.defendsCentre) !== 'yes') return true;
        return attacksFrom(board, i).some((c) => CENTER.includes(sqName(c)) && board[c]?.color === them && board[c]?.type === 'p');
      });
    }
    case 'pawnStrike': {
      const square = str(p.square);
      if (square) {
        const i = squareIndex(square);
        if (i < 0 || !has(board, square, color, 'p')) return false;
        if (str(p.hits) !== 'yes') return true;
        return attacksFrom(board, i).some((c) => board[c]?.color === them && board[c]?.type === 'p');
      }
      const files = list(p.files);
      const count = Number(str(p.count) ?? '1');
      const minRank = Number(str(p.minRank) ?? '4');
      const advanced = squaresOf(board, color, 'p').filter((pw) => files.includes('abcdefgh'.charAt(fileOf(pw))) && relRank(pw, color) >= minRank);
      return advanced.length >= count;
    }
    case 'pin': {
      const piece = (str(p.piece) ?? 'b') as PieceType;
      const targetPiece = (str(p.targetPiece) ?? 'n') as PieceType;
      return squaresOf(board, color, piece).some((from) =>
        DIAGONALS.concat(piece === 'b' ? [] : ([[1, 0], [-1, 0], [0, 1], [0, -1]] as Direction[])).some((dir) => {
          const pair = rayPair(board, from, dir);
          if (!pair) return false;
          const front = board[pair.front];
          const back = board[pair.back];
          return !!front && !!back && front.color === them && front.type === targetPiece && back.color === them && VALUE_PAWNS[back.type] + (back.type === 'k' ? 100 : 0) > VALUE_PAWNS[targetPiece];
        }),
      );
    }
    case 'longDiagonal':
      return longDiagonalSquares(color, str(p.side) ?? 'any').some((sq) => has(board, sq, color, 'b'));
    case 'hold': {
      const pawns = list(p.pawns);
      if (pawns.length > 0) return pawns.every((sq) => has(board, sq, color, 'p'));
      const control = str(p.control);
      if (control) {
        const i = squareIndex(control);
        if (i < 0) return false;
        const by = list(p.by) as readonly PieceType[];
        const attackers = attackersOf(board, i, color).map((a) => board[a]?.type);
        const count = Number(str(p.count) ?? '1');
        return by.every((t) => attackers.filter((a) => a === t).length >= (by.length === 1 ? count : 1));
      }
      if (str(p.mode) === 'trade') return nonPawnPieces(board, color) <= 6 && nonPawnPieces(board, them) <= 6 && materialOf(board, color) >= materialOf(board, them);
      return false;
    }
  }
}

function sqName(i: number): string {
  return `${'abcdefgh'.charAt(fileOf(i))}${rankOf(i) + 1}`;
}

function longDiagonalSquares(color: Color, side: string): string[] {
  const r = color === 'w' ? '2' : '7';
  if (side === 'king') return [`g${r}`];
  if (side === 'queen') return [`b${r}`];
  return [`b${r}`, `g${r}`];
}

/** Is the goal achieved in `fen` (castle only by a castling move in `historySan`)? */
export function goalAchieved(goal: ThemeGoal, fen: string, color: Color, historySan: readonly string[]): boolean {
  const board = boardOf(fen);
  if (!board) return false;
  try {
    return achievedOn(goal, board, color, historySan);
  } catch {
    return false;
  }
}

// ───────────────────────── impossible ─────────────────────────

function impossibleOn(goal: ThemeGoal, board: Board, color: Color, fen: string): boolean {
  const p = goal.params;
  const them = opposite(color);
  const castleGone = (): boolean => !castlingRights(fen, color) && !castledShape(board, color);
  switch (goal.kind) {
    case 'castle':
      return castleGone();
    case 'develop': {
      const mode = str(p.mode) ?? 'all';
      if (mode === 'knights') return squaresOf(board, color, 'n').length < 2;
      if (mode === 'allCastle') return castleGone();
      return false;
    }
    case 'pieceOn': {
      const piece = (str(p.piece) ?? 'n') as PieceType;
      const squares = list(p.squares);
      const home = str(p.home);
      const before = str(p.before);
      if (piece === 'b' && (home || squares.length > 0)) {
        const ref = home ?? (squares[0] as string);
        const bishops = bishopsFor(board, color, ref);
        if (bishops.length === 0) return true;
        // the bishop still at home and the pawn move it had to come before is made: it is shut in
        if (home && before && has(board, home, color, 'b') && has(board, before, color, 'p')) return true;
        return false;
      }
      return squaresOf(board, color, piece).length === 0;
    }
    case 'aimAt': {
      const pieces = list(p.pieces) as readonly PieceType[];
      const targetPiece = str(p.targetPiece) as PieceType | undefined;
      const targets = list(p.target).filter((t) => t !== 'kingZone');
      if (targets.length > 0) {
        const standing = targets.filter((sq) => {
          const q = at(board, sq);
          return !!q && q.color === them && (!targetPiece || q.type === targetPiece);
        });
        if (standing.length === 0) return true;
        // a bishop can only ever aim at squares of its own colour
        return pieces.some((t) => (t === 'b' ? standing.every((sq) => bishopsFor(board, color, sq).length === 0) : squaresOf(board, color, t).length === 0));
      }
      if (targetPiece && squaresOf(board, them, targetPiece).length === 0) return true;
      return pieces.some((t) => squaresOf(board, color, t).length === 0);
    }
    case 'pawnStrike': {
      const square = str(p.square);
      if (square) return !pawnCanReach(board, color, square);
      const files = list(p.files);
      const count = Number(str(p.count) ?? '1');
      return squaresOf(board, color, 'p').filter((pw) => files.includes('abcdefgh'.charAt(fileOf(pw)))).length < count;
    }
    case 'pin': {
      const piece = (str(p.piece) ?? 'b') as PieceType;
      const targetPiece = (str(p.targetPiece) ?? 'n') as PieceType;
      return squaresOf(board, color, piece).length === 0 || squaresOf(board, them, targetPiece).length === 0;
    }
    case 'longDiagonal': {
      const squares = longDiagonalSquares(color, str(p.side) ?? 'any');
      return squares.every((sq) => bishopsFor(board, color, sq).length === 0);
    }
    case 'hold': {
      const pawns = list(p.pawns);
      if (pawns.length > 0) return pawns.some((sq) => !pawnCanReach(board, color, sq));
      const control = str(p.control);
      if (control) {
        const by = list(p.by) as readonly PieceType[];
        const count = Number(str(p.count) ?? '1');
        return by.some((t) => squaresOf(board, color, t).length < (by.length === 1 ? count : 1));
      }
      return false;
    }
  }
}

/** Has the goal become impossible (the piece is gone, the target pawn moved, castling rights lost …)? */
export function goalImpossible(goal: ThemeGoal, fen: string, color: Color): boolean {
  const board = boardOf(fen);
  if (!board) return false;
  try {
    return impossibleOn(goal, board, color, fen);
  } catch {
    return false;
  }
}

/** The goal a move achieves: not achieved before, achieved after, not impossible after (null = none). */
export function goalDoneBy(goals: readonly ThemeGoal[], fenBefore: string, fenAfter: string, color: Color, historyBefore: readonly string[], historyAfter: readonly string[]): ThemeGoal | null {
  for (const g of goals) {
    if (!goalAchieved(g, fenBefore, color, historyBefore) && goalAchieved(g, fenAfter, color, historyAfter) && !goalImpossible(g, fenAfter, color)) return g;
  }
  return null;
}
