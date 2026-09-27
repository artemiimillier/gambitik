/**
 * Facts for the conversational coach's TOOLS (contracts: `CoachToolHost.analyzePosition` / `evaluateMove`).
 *
 * The game module gathers the engine data (cached analysis, the null-move threat, a scratch judgement of a
 * hypothetical move); this module turns it into short Russian facts the voice model retells in its own words.
 * Same rules as the briefs: spoken notation only (no Latin letters), the child in the third person («ученик»),
 * no numbers of evaluation, and NEVER the best move — not even «this is the best move» about a proposed one
 * (that would let the child brute-force the answer): a proposed move is only called safe or dangerous.
 *
 * `parseMoveText` understands what a voice model is likely to pass: SAN («Nf3», «exd5», «O-O»), UCI («g1f3»,
 * «e2-e4»), Russian notation («Кf3», «Крe2», «Фxh7», «Сc4», «Лd1», Cyrillic «е4» / «х» for the capture sign) and plain
 * words («конь на эф три», «слон бьёт на цэ четыре», «короткая рокировка»).
 */
import { Chess } from 'chess.js';
import type { Move, Square as ChessSquare } from 'chess.js';
import type { AnalysisResult, Color, EvalScore, MoveJudgement, PieceType, PositionFacts, StudentProfile, TeachAdvice, Threat } from '@gambit/shared';
import { toMoverPov, winPct } from '../analysis/eval.ts';
import { pieceAt } from './board.ts';
import {
  allowedFactRu,
  capRu,
  capturedAlongRu,
  chanceTrendRu,
  hangingListRu,
  materialBalanceRu,
  pawnsAccRu,
  pieceOnRu,
  spokenLineRu,
  spokenMoveRu,
  stripLatinRu,
  studentWords,
  winChanceWordsRu,
} from './brief.ts';
import type { StudentWords } from './brief.ts';
import { isMateMotif } from './motifs.ts';
import { pieceNameRu, squareToSpokenRu } from './spoken.ts';
import { mateInOneThreat, threatFactsRu } from './threats.ts';

// ═════════════════════════ move text → move ═════════════════════════

export type MoveTextResult =
  | { ok: true; uci: string; san: string; spoken: string }
  /** the text is not a move we can understand */
  | { ok: false; reason: 'unparsable' }
  /** several legal moves fit («конь на эф три» with two knights) */
  | { ok: false; reason: 'ambiguous'; spoken: string; why: string }
  /** understood, but not possible in this position; `why` is Russian, Latin-free */
  | { ok: false; reason: 'illegal'; spoken: string; why: string };

interface MoveIntent {
  piece?: PieceType;
  from?: string;
  to?: string;
  promotion?: PieceType;
  castle?: 'short' | 'long' | 'any';
  capture?: boolean;
}

const PIECE_WORDS: readonly [RegExp, PieceType][] = [
  [/(?<![а-яё])(ферз[а-яё]*)/u, 'q'],
  [/(?<![а-яё])(ладь[а-яё]*|ладей)/u, 'r'],
  [/(?<![а-яё])(слон[а-яё]*)/u, 'b'],
  [/(?<![а-яё])(кон[ьяёеюи][а-яё]*|конь)/u, 'n'],
  [/(?<![а-яё])(корол[а-яё]*)/u, 'k'],
  [/(?<![а-яё])(пешк[а-яё]*|пешечк[а-яё]*)/u, 'p'],
];

const FILE_WORDS: Readonly<Record<string, string>> = {
  а: 'a',
  бэ: 'b',
  бе: 'b',
  б: 'b',
  цэ: 'c',
  це: 'c',
  ц: 'c',
  дэ: 'd',
  де: 'd',
  д: 'd',
  е: 'e',
  э: 'e',
  эф: 'f',
  ф: 'f',
  же: 'g',
  жэ: 'g',
  ж: 'g',
  аш: 'h',
  ха: 'h',
};

const RANK_WORDS: Readonly<Record<string, string>> = {
  один: '1',
  два: '2',
  три: '3',
  четыре: '4',
  пять: '5',
  шесть: '6',
  семь: '7',
  восемь: '8',
};

const PROMO_WORDS: readonly [RegExp, PieceType][] = [
  [/(в|на)\s+ферз/u, 'q'],
  [/(в|на)\s+ладь/u, 'r'],
  [/(в|на)\s+слон/u, 'b'],
  [/(в|на)\s+кон/u, 'n'],
];

const UCI_RE = /^([a-h][1-8])\s*[-x:–—]?\s*([a-h][1-8])\s*=?([qrbn])?$/i;

/** Cyrillic look-alikes and Russian piece letters → Latin SAN. Only applied to compact notation, never to words. */
function russianNotationToSan(text: string): string {
  let t = text.replace(/[«»"'`]/g, '').trim();
  t = t.replace(/^Кр/u, 'K').replace(/^К/u, 'N').replace(/^Ф/u, 'Q').replace(/^Л/u, 'R').replace(/^С/u, 'B');
  t = t.replace(/=Ф/u, '=Q').replace(/=Л/u, '=R').replace(/=С/u, '=B').replace(/=К/u, '=N');
  t = t
    .replace(/а/gu, 'a')
    .replace(/[вб]/gu, 'b')
    .replace(/с/gu, 'c')
    .replace(/д/gu, 'd')
    .replace(/[еэ]/gu, 'e')
    .replace(/ф/gu, 'f')
    .replace(/[гж]/gu, 'g')
    .replace(/[хХ:]/gu, 'x')
    .replace(/[оО]/gu, 'O');
  return t.replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O');
}

function spokenSquareToLatin(words: string): string | undefined {
  const m = /(?<![а-яё])(аш|ха|бэ|бе|цэ|це|дэ|де|эф|же|жэ|а|б|ц|д|е|э|ф|ж)[\s-]*(один|два|три|четыре|пять|шесть|семь|восемь|[1-8])(?![а-яё0-9])/u.exec(words);
  if (!m) return undefined;
  const file = FILE_WORDS[m[1] as string];
  const rank = RANK_WORDS[m[2] as string] ?? m[2];
  return file && rank ? `${file}${rank}` : undefined;
}

/** All squares mentioned in a text, Latin («f3») or spoken («эф три»), in order. */
function squaresIn(text: string): string[] {
  const out: { at: number; sq: string }[] = [];
  for (const m of text.matchAll(/(?<![a-z])([a-h])\s*([1-8])(?![0-9])/gi)) out.push({ at: m.index ?? 0, sq: `${(m[1] as string).toLowerCase()}${m[2]}` });
  const spokenRe = /(?<![а-яё])(аш|ха|бэ|бе|цэ|це|дэ|де|эф|же|жэ|а|б|ц|д|е|э|ф|ж)[\s-]*(один|два|три|четыре|пять|шесть|семь|восемь|[1-8])(?![а-яё0-9])/gu;
  for (const m of text.matchAll(spokenRe)) {
    const sq = spokenSquareToLatin(m[0]);
    if (sq) out.push({ at: m.index ?? 0, sq });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.sq);
}

function intentFromWords(text: string): MoveIntent | null {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  if (/рокировк/u.test(lower)) {
    if (/длинн|ферзев/u.test(lower)) return { castle: 'long' };
    if (/коротк|королевск/u.test(lower)) return { castle: 'short' };
    return { castle: 'any' };
  }
  let piece: PieceType | undefined;
  let pieceAt = Number.POSITIVE_INFINITY;
  for (const [re, p] of PIECE_WORDS) {
    const m = re.exec(lower);
    if (m && (m.index ?? 0) < pieceAt) {
      piece = p;
      pieceAt = m.index ?? 0;
    }
  }
  const squares = squaresIn(lower);
  if (squares.length === 0) return null;
  const intent: MoveIntent = { to: squares[squares.length - 1] };
  if (squares.length >= 2) intent.from = squares[0];
  if (piece) intent.piece = piece;
  if (/бь|берет|бере|взят|забира|съе|ест(?![а-яё])/u.test(lower)) intent.capture = true;
  for (const [re, p] of PROMO_WORDS) if (re.test(lower) && /превра/u.test(lower)) intent.promotion = p;
  return intent;
}

function uciOf(m: Pick<Move, 'from' | 'to' | 'promotion'>): string {
  return `${m.from}${m.to}${m.promotion ?? ''}`;
}

function spokenIntentRu(intent: MoveIntent): string {
  if (intent.castle === 'short') return 'короткая рокировка';
  if (intent.castle === 'long') return 'длинная рокировка';
  if (intent.castle === 'any') return 'рокировка';
  const piece = intent.piece ? pieceNameRu(intent.piece, 'nom') : 'фигура';
  const from = intent.from ? ` с ${squareToSpokenRu(intent.from)}` : '';
  const to = intent.to ? ` ${intent.capture ? 'бьёт ' : ''}на ${squareToSpokenRu(intent.to)}` : '';
  return `${piece}${from}${to}`;
}

/** Parses the model's move text in `fen` (the side to move plays it). Never throws. */
export function parseMoveText(fen: string, text: string): MoveTextResult {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return { ok: false, reason: 'unparsable' };
  }
  const raw = (text ?? '').trim().replace(/[.!?]+$/u, '').trim();
  if (raw === '' || raw.length > 80) return { ok: false, reason: 'unparsable' };
  const legal = chess.moves({ verbose: true });
  const found = (m: Move): MoveTextResult => ({ ok: true, uci: uciOf(m), san: m.san, spoken: spokenMoveRu(m.san, fen) || m.san });

  // 1. UCI («g1f3», «e2-e4», «e7e8q»)
  const uci = UCI_RE.exec(raw);
  if (uci) {
    const from = (uci[1] as string).toLowerCase();
    const to = (uci[2] as string).toLowerCase();
    const promo = uci[3]?.toLowerCase() as PieceType | undefined;
    const hit = legal.find((m) => m.from === from && m.to === to && (m.promotion ?? undefined) === (promo ?? (m.promotion ? 'q' : undefined)));
    if (hit) return found(hit);
    const intent: MoveIntent = { from, to, piece: pieceAt(fen, from)?.piece };
    if (promo) intent.promotion = promo;
    return illegal(chess, fen, intent);
  }

  // 2. compact notation: Latin SAN or Russian letters («Кf3», «Крe2», «е4», «Фхh7», «0-0»)
  const compact = raw.replace(/\s+/g, '');
  if (!/[а-яё]{3,}/iu.test(compact)) {
    const san = russianNotationToSan(compact);
    const sanHit = legal.find((m) => m.san === san || m.san.replace(/[+#]$/, '') === san.replace(/[+#!?]+$/, ''));
    if (sanHit) return found(sanHit);
    try {
      const probe = new Chess(fen);
      const m = probe.move(san);
      const hit = legal.find((x) => uciOf(x) === uciOf(m));
      if (hit) return found(hit);
    } catch {
      // not legal as written — work out what was meant and why it is impossible
    }
    const intent = intentFromSan(san);
    if (intent) return resolveIntent(chess, fen, legal, intent);
  }

  // 3. words («конь на эф три», «слон бьёт на цэ четыре», «короткая рокировка»)
  const intent = intentFromWords(raw);
  if (!intent) return { ok: false, reason: 'unparsable' };
  return resolveIntent(chess, fen, legal, intent);
}

const SAN_LETTER: Readonly<Record<string, PieceType>> = { K: 'k', Q: 'q', R: 'r', B: 'b', N: 'n' };

function intentFromSan(san: string): MoveIntent | null {
  if (/^O-O-O/.test(san)) return { castle: 'long' };
  if (/^O-O/.test(san)) return { castle: 'short' };
  const m = /^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(?:=?([QRBN]))?[+#]?$/.exec(san);
  if (!m) return null;
  const intent: MoveIntent = { piece: m[1] ? SAN_LETTER[m[1]] : 'p', to: m[5] };
  if (m[2] && m[3]) intent.from = `${m[2]}${m[3]}`;
  if (m[4]) intent.capture = true;
  if (m[6]) intent.promotion = SAN_LETTER[m[6]];
  return intent;
}

function resolveIntent(chess: Chess, fen: string, legal: Move[], intent: MoveIntent): MoveTextResult {
  if (intent.castle) {
    const castles = legal.filter((m) => (intent.castle === 'long' ? m.isQueensideCastle() : intent.castle === 'short' ? m.isKingsideCastle() : m.isKingsideCastle() || m.isQueensideCastle()));
    const pick = castles.find((m) => m.isKingsideCastle()) ?? castles[0];
    if (pick) return { ok: true, uci: uciOf(pick), san: pick.san, spoken: spokenMoveRu(pick.san, fen) || pick.san };
    return illegal(chess, fen, intent);
  }
  const fits = legal.filter(
    (m) =>
      m.to === intent.to &&
      (intent.piece === undefined || m.piece === intent.piece) &&
      (intent.from === undefined || m.from === intent.from) &&
      (intent.promotion === undefined || m.promotion === intent.promotion),
  );
  // a promotion without a named piece means a queen
  const unique = fits.length > 1 && fits.every((m) => m.promotion) ? fits.filter((m) => m.promotion === 'q') : fits;
  if (unique.length === 1) {
    const m = unique[0] as Move;
    return { ok: true, uci: uciOf(m), san: m.san, spoken: spokenMoveRu(m.san, fen) || m.san };
  }
  if (unique.length > 1) {
    const froms = unique.map((m) => pieceOnRu(m.piece, m.from)).join(' или ');
    return { ok: false, reason: 'ambiguous', spoken: spokenIntentRu(intent), why: `туда могут пойти несколько фигур: ${froms} — уточни, какая` };
  }
  return illegal(chess, fen, intent);
}

const KNIGHT_STEPS: readonly (readonly [number, number])[] = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];

function coords(sq: string): [number, number] {
  return [sq.charCodeAt(0) - 97, Number.parseInt(sq[1] as string, 10) - 1];
}

function squareName(f: number, r: number): string {
  return `${String.fromCharCode(97 + f)}${r + 1}`;
}

/** Can a `piece` of `color` on `from` reach `to` by its move pattern (ignoring checks)? 'blocked' = a slider's path is occupied. */
function geometry(chess: Chess, piece: PieceType, color: Color, from: string, to: string): 'ok' | 'pattern' | 'blocked' {
  const [ff, fr] = coords(from);
  const [tf, tr] = coords(to);
  const df = tf - ff;
  const dr = tr - fr;
  if (df === 0 && dr === 0) return 'pattern';
  const target = chess.get(to as ChessSquare);
  switch (piece) {
    case 'n':
      return KNIGHT_STEPS.some(([a, b]) => a === df && b === dr) ? 'ok' : 'pattern';
    case 'k':
      return Math.abs(df) <= 1 && Math.abs(dr) <= 1 ? 'ok' : 'pattern';
    case 'p': {
      const dir = color === 'w' ? 1 : -1;
      const home = color === 'w' ? 1 : 6;
      if (df === 0 && dr === dir) return target ? 'blocked' : 'ok';
      if (df === 0 && dr === 2 * dir && fr === home) return chess.get(squareName(ff, fr + dir) as ChessSquare) || target ? 'blocked' : 'ok';
      if (Math.abs(df) === 1 && dr === dir) return target ? 'ok' : 'pattern';
      return 'pattern';
    }
    default: {
      const straight = df === 0 || dr === 0;
      const diagonal = Math.abs(df) === Math.abs(dr);
      if ((piece === 'r' && !straight) || (piece === 'b' && !diagonal) || (piece === 'q' && !straight && !diagonal)) return 'pattern';
      const sf = Math.sign(df);
      const sr = Math.sign(dr);
      for (let f = ff + sf, r = fr + sr; f !== tf || r !== tr; f += sf, r += sr) {
        if (chess.get(squareName(f, r) as ChessSquare)) return 'blocked';
      }
      return 'ok';
    }
  }
}

function castleWhy(chess: Chess, fen: string, long: boolean): string {
  const color = chess.turn();
  const rights = fen.split(/\s+/)[2] ?? '-';
  const flag = color === 'w' ? (long ? 'Q' : 'K') : long ? 'q' : 'k';
  if (!rights.includes(flag)) return 'король или ладья уже ходили, рокировка больше невозможна';
  if (chess.inCheck()) return 'сейчас шах — под шахом рокироваться нельзя';
  const rank = color === 'w' ? 1 : 8;
  const between = long ? ['b', 'c', 'd'] : ['f', 'g'];
  if (between.some((f) => chess.get(`${f}${rank}` as ChessSquare))) return 'между королём и ладьёй ещё стоят фигуры';
  return 'король прошёл бы через поле под ударом — так рокироваться нельзя';
}

function illegal(chess: Chess, fen: string, intent: MoveIntent): MoveTextResult {
  const spoken = spokenIntentRu(intent);
  const color = chess.turn();
  if (intent.castle) {
    return { ok: false, reason: 'illegal', spoken, why: castleWhy(chess, fen, intent.castle === 'long') };
  }
  const to = intent.to;
  if (!to) return { ok: false, reason: 'unparsable' };
  const toSpoken = squareToSpokenRu(to);
  const own = chess.get(to as ChessSquare);
  if (own && own.color === color) return { ok: false, reason: 'illegal', spoken, why: `на ${toSpoken} уже стоит своя фигура` };
  const candidates: { square: string; piece: PieceType }[] = [];
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell || cell.color !== color) continue;
      if (intent.piece !== undefined && cell.type !== intent.piece) continue;
      if (intent.from !== undefined && cell.square !== intent.from) continue;
      candidates.push({ square: cell.square, piece: cell.type });
    }
  }
  if (candidates.length === 0) {
    if (intent.from !== undefined) {
      const there = chess.get(intent.from as ChessSquare);
      if (!there) return { ok: false, reason: 'illegal', spoken, why: `на ${squareToSpokenRu(intent.from)} нет фигуры` };
      if (there.color !== color) return { ok: false, reason: 'illegal', spoken, why: `на ${squareToSpokenRu(intent.from)} стоит фигура соперника` };
      return { ok: false, reason: 'illegal', spoken, why: `на ${squareToSpokenRu(intent.from)} стоит ${pieceNameRu(there.type, 'nom')}, а не эта фигура` };
    }
    const name = intent.piece ? pieceNameRu(intent.piece, 'gen') : 'такой фигуры';
    return { ok: false, reason: 'illegal', spoken, why: intent.piece ? `такой фигуры, ${name}, на доске уже нет` : 'такой фигуры нет' };
  }
  if (intent.piece === undefined && intent.from === undefined) {
    return { ok: false, reason: 'illegal', spoken, why: `сейчас ни одна фигура не может пойти на ${toSpoken}` };
  }
  const shapes = candidates.map((c) => ({ ...c, g: geometry(chess, c.piece, color, c.square, to) }));
  if (shapes.some((s) => s.g === 'ok')) {
    if (chess.inCheck()) return { ok: false, reason: 'illegal', spoken, why: 'сейчас шах: сначала нужно спасти короля, а этот ход от шаха не защищает' };
    const king = shapes.find((s) => s.g === 'ok')?.piece === 'k';
    return { ok: false, reason: 'illegal', spoken, why: king ? 'король встал бы под удар, так ходить нельзя' : 'эта фигура связана: если она уйдёт, королю будет шах' };
  }
  if (shapes.some((s) => s.g === 'blocked')) return { ok: false, reason: 'illegal', spoken, why: 'путь загорожен другой фигурой' };
  const piece = intent.piece ?? candidates[0]?.piece ?? 'p';
  const pawnWhy = piece === 'p' ? 'пешка так не ходит: вперёд на одну клетку, с начальной клетки можно на две, а бьёт она наискосок' : null;
  return { ok: false, reason: 'illegal', spoken, why: pawnWhy ?? `${pieceNameRu(piece, 'nom')} так не ходит` };
}

// ═════════════════════════ «а если я пойду…?» ═════════════════════════

const SAFE_MAX_LOSS_PCT = 10;

/** Teacher mode: an advised move of the current position with its engine score (child's point of view, centipawns; a mate as ±100000 ∓ 100·n). */
export type ScoredAdvice = TeachAdvice & { scoreCp?: number | null };

export interface MoveCheckArgs {
  /** judgement of the HYPOTHETICAL move (judgeMove on a scratch position); null when the engine did not answer */
  judgement: MoveJudgement | null;
  /** the move as understood */
  move: { uci: string; san: string; fenBefore: string };
  profile?: Pick<StudentProfile, 'address'>;
  /** the very move that was just taken back */
  takenBackBefore?: boolean;
  /**
   * Teacher mode (docs/TEACHER-MODE.md §6.4): the current advice of this position. With it the answer compares the move
   * with the advice («так же хорошо, как совет» / «слабее совета») and the model may name ONLY the advised moves.
   */
  advice?: readonly ScoredAdvice[];
}

/** An engine score as comparable centipawns: mate in n → ±(100000 − 100·n) (TEACHER-MODE §2.4.1). */
export function teachScoreCp(score: EvalScore): number {
  if (score.mate !== null && score.mate !== undefined) {
    if (score.mate > 0) return 100_000 - 100 * score.mate;
    return -100_000 + 100 * Math.abs(score.mate);
  }
  return score.cp ?? 0;
}

/** How a considered move compares with the advice, by the gap in centipawns (TEACHER-MODE §7.1 step 3). */
export type AdviceGap = 'same' | 'bitWeaker' | 'weaker' | 'muchWeaker';

export function adviceGapOf(gapCp: number): AdviceGap {
  if (gapCp <= 30) return 'same';
  if (gapCp <= 100) return 'bitWeaker';
  if (gapCp <= 250) return 'weaker';
  return 'muchWeaker';
}

export const ADVICE_GAP_RU: Readonly<Record<AdviceGap, string>> = {
  same: 'примерно так же хорошо, как совет',
  bitWeaker: 'немного слабее совета',
  weaker: 'заметно слабее совета',
  muchWeaker: 'намного слабее совета',
};

/** The comparison of a judged move with the advice: null when there is no advice or no data to compare. */
function compareWithAdvice(j: MoveJudgement | null, uci: string, advice: readonly ScoredAdvice[]): { inAdvice: ScoredAdvice | null; gap: AdviceGap | null } {
  const inAdvice = advice.find((a) => a.uci === uci) ?? null;
  if (inAdvice || !j) return { inAdvice, gap: null };
  const primary = advice[0];
  if (primary?.scoreCp !== undefined && primary.scoreCp !== null) return { inAdvice, gap: adviceGapOf(primary.scoreCp - teachScoreCp(j.evalAfter)) };
  // no stored score: the loss against the engine's best move stands in for the loss against the advice
  return { inAdvice, gap: j.winPctLoss < 2 ? 'same' : j.winPctLoss < 5 ? 'bitWeaker' : j.winPctLoss < 10 ? 'weaker' : 'muchWeaker' };
}

/** What the coach may say about a move the child only considers. Never names the best move (in teacher mode: only the advice). */
export function buildMoveCheckAnswerRu(a: MoveCheckArgs): string {
  const s = studentWords(a.profile);
  const spoken = spokenMoveRu(a.move.san, a.move.fenBefore) || 'этот ход';
  const advice = (a.advice ?? []).slice(0, 2);
  const adviceSpoken = advice.map((x) => spokenMoveRu(x.san, a.move.fenBefore)).filter((x) => x !== '');
  const parts: string[] = [`${capRu(s.nom)} спрашивает про ход: ${spoken}. Такой ход возможен, на доске он ещё не сделан.`];
  const probe = new Chess(a.move.fenBefore);
  let mate = false;
  let check = false;
  try {
    probe.move(a.move.san);
    mate = probe.isCheckmate();
    check = probe.inCheck();
  } catch {
    // parseMoveText gave a legal move; nothing else can happen here
  }
  if (a.takenBackBefore) parts.push('Это тот самый ход, который недавно вернули.');
  const cmp = advice.length > 0 ? compareWithAdvice(a.judgement, a.move.uci, advice) : null;
  if (cmp?.inAdvice) parts.push(`Это ход из совета учителя (${cmp.inAdvice.arrow === 'green' ? 'зелёная' : 'синяя'} стрелка).`);
  if (mate) {
    parts.push('Это мат — партия была бы выиграна!');
    parts.push(rules(true, s, adviceSpoken));
    return clean(parts);
  }
  if (check) parts.push('Этот ход даёт шах.');
  const j = a.judgement;
  if (!j) {
    parts.push(staticSafetyRu(a.move, s));
    parts.push(rules(false, s, adviceSpoken));
    return clean(parts);
  }
  const dangerous = j.winPctLoss >= SAFE_MAX_LOSS_PCT || j.materialLossPawns >= 2 || (j.evalAfter.mate !== null && j.evalAfter.mate < 0);
  const best = spokenMoveRu(j.bestSan, j.fenBefore);
  const reply = spokenLineRu(j.fenAfter, j.refutationPvSan, 1).filter((m) => m !== best)[0];
  if (dangerous) {
    const lost = capturedAlongRu(j.fenAfter, j.refutationPvUci, 4);
    const mateIn = j.evalAfter.mate !== null && j.evalAfter.mate < 0 ? -j.evalAfter.mate : null;
    parts.push(`Опасно: после него у соперника сильный ответ${reply ? ` — ${reply}` : ''}.`);
    if (j.allowedMotif) parts.push(`${capRu(allowedFactRu(j.allowedMotif))}.`);
    if (mateIn !== null && mateIn <= 5) parts.push(mateIn === 1 ? 'Соперник сразу ставит мат.' : 'Дальше соперник может поставить мат.');
    else if (lost.length > 0) parts.push(`Соперник забирает ${lost.slice(0, 2).join(', а потом ')}.`);
    else if (j.materialLossPawns >= 1) parts.push(`${capRu(s.nom)} теряет ${pawnsAccRu(j.materialLossPawns)} материала.`);
  } else if (j.classification === 'inaccuracy' || j.classification === 'missedWin') {
    parts.push('Ход не опасный: ничего не теряется, но он не самый точный — можно поискать сильнее.');
  } else {
    parts.push('Ход безопасный и хороший: ничего не теряется.');
    if (reply) parts.push(`Соперник, скорее всего, ответит так: ${reply}.`);
  }
  const trend = chanceTrendRu(j.winPctBefore, j.winPctAfter);
  parts.push(
    trend === 'same'
      ? `Шансы почти не меняются: ${winChanceWordsRu(j.winPctAfter, s)}.`
      : `Шансы: сейчас ${winChanceWordsRu(j.winPctBefore, s)}, а после этого хода ${trend === 'better' ? 'станет лучше' : 'станет хуже'}: ${winChanceWordsRu(j.winPctAfter, s)}.`,
  );
  if (cmp && !cmp.inAdvice && cmp.gap) {
    parts.push(`Сравнение с советом учителя (${adviceSpoken.join(' или ')}): этот ход ${ADVICE_GAP_RU[cmp.gap]}.`);
  }
  parts.push(rules(dangerous, s, adviceSpoken));
  return clean(parts);
}

function staticSafetyRu(move: { san: string; fenBefore: string }, s: StudentWords): string {
  try {
    const chess = new Chess(move.fenBefore);
    const played = chess.move(move.san);
    const attackers = chess.attackers(played.to, chess.turn());
    const defenders = chess.attackers(played.to, played.color);
    if (attackers.length > 0 && defenders.length === 0) {
      return `Проверь: на новой клетке ${pieceNameRu(played.piece, 'nom')} стоит под боем и без защиты — соперник может ${played.piece === 'p' ? 'её' : 'его'} забрать. Точная проверка сейчас недоступна.`;
    }
    return `На новой клетке ${pieceNameRu(played.piece, 'nom')} не стоит под боем без защиты. Точная проверка ${s.dat} сейчас недоступна — скажи честно, что проверили только самое простое.`;
  } catch {
    return 'Точная проверка сейчас недоступна.';
  }
}

function rules(dangerous: boolean, s: StudentWords, adviceSpoken: readonly string[] = []): string {
  // teacher mode: the advice is on the board already — it may be named, nothing else (TEACHER-MODE §6.4)
  const other = adviceSpoken.length > 0 ? `из других ходов можно назвать только ходы совета: ${adviceSpoken.join(' или ')}` : 'не предлагай другой ход';
  return dangerous
    ? `Как говорить: своими словами и коротко; сначала спроси, что может ответить соперник, и только потом подскажи. Не говори, какой ход лучший; ${other}.`
    : `Как говорить: своими словами и коротко. Не говори, лучший ли это ход; ${other} — пусть ${s.nom} решает ${s.g('сам', 'сама')}.`;
}

function clean(parts: readonly string[]): string {
  return stripLatinRu(parts.filter((p) => p.trim() !== '').join(' '));
}

/** Answer when a move cannot be checked (unparsable / illegal / ambiguous). */
export function moveTextProblemRu(result: Exclude<MoveTextResult, { ok: true }>): string {
  switch (result.reason) {
    case 'unparsable':
      return 'Не понял, какой ход имеется в виду. Попроси назвать фигуру и клетку, например: конь на эф три.';
    case 'ambiguous':
      return clean([`Ход «${result.spoken}» можно понять по-разному: ${result.why}.`]);
    case 'illegal':
      return clean([`Ход «${result.spoken}» сейчас сделать нельзя: ${result.why}.`, 'Объясни это по-доброму и предложи поискать другой ход.']);
  }
}

// ═════════════════════════ «что сейчас на доске?» ═════════════════════════

const PHASE_RU: Readonly<Record<PositionFacts['phase'], string>> = { opening: 'дебют', middlegame: 'середина игры', endgame: 'эндшпиль' };

export interface PositionAnswerArgs {
  fen: string;
  facts: PositionFacts;
  childColor: Color;
  profile?: Pick<StudentProfile, 'address'>;
  /** cached engine analysis of `fen` (for the chances in words) */
  analysis?: AnalysisResult | null;
  /** the opponent's engine-verified threat (null = searched, nothing found; undefined = not known yet) */
  threat?: Threat | null;
  /** the last moves on the board, oldest first (up to two are used) */
  lastMoves?: readonly { san: string; fenBefore: string; by: 'child' | 'bot' }[];
  /** full-move number — only in the «только если спросят» reference line, never a fact to retell */
  moveNumber?: number;
  /**
   * remaining clock in ms, null = untimed. Never read out («у тебя осталось четыре минуты…» is what the child sees);
   * only below `LOW_CLOCK_MS` of the child the facts allow one «Поторопись!».
   */
  clock?: { child: number | null; opponent: number | null } | null;
  opening?: { name?: string | null; title?: string; idea?: string } | null;
  gameOver?: boolean;
  /** exam: only neutral facts, no threats, no weak spots */
  examMode?: boolean;
  /**
   * «Учитель» (the game appends the teacher's advice to this answer, TEACHER-MODE §7.1): the advised moves may be named
   * — the helper's «Лучший ход не называй: для этого есть подсказки по ступенькам» would contradict that line.
   */
  teacher?: boolean;
}

/** Below this the child's clock is worth one word: «Поторопись!» (the only clock word the coach ever says). */
export const LOW_CLOCK_MS = 30_000;

/** What the opponent's last move attacks now: «нападает на ладью на а один». */
function lastMoveAttacksRu(fen: string, move: { san: string; fenBefore: string }, victim: Color): string | null {
  try {
    const chess = new Chess(move.fenBefore);
    const played = chess.move(move.san);
    if (chess.fen().split(' ').slice(0, 4).join(' ') !== fen.split(' ').slice(0, 4).join(' ')) return null;
    const targets: string[] = [];
    for (const row of chess.board()) {
      for (const cell of row) {
        if (!cell || cell.color !== victim || cell.type === 'p') continue;
        if (chess.attackers(cell.square, played.color).includes(played.to)) targets.push(pieceOnRu(cell.type, cell.square));
      }
    }
    return targets.length > 0 ? `под ударом этой фигуры: ${targets.slice(0, 3).join(', ')}` : null;
  } catch {
    return null;
  }
}

/**
 * What everybody sees on the screen — the colour, the move number, whose move it is — goes to the model only as a
 * reference for a direct question («а я какими играю?»), never as a fact to retell (no «Сейчас второй ход, ты
 * белыми»). The clock is not in it at all.
 */
function obviousReferenceRu(a: PositionAnswerArgs, s: StudentWords, childToMove: boolean): string {
  const parts = [
    `${s.nom} играет ${a.childColor === 'w' ? 'белыми' : 'чёрными'}`,
    a.moveNumber !== undefined ? `идёт ${a.moveNumber}-й ход` : null,
    a.gameOver ? null : childToMove ? `сейчас ход ${s.gen}` : 'сейчас ходит соперник',
  ].filter((p): p is string => p !== null);
  return `Только если ${s.nom} ${s.g('сам', 'сама')} спросит об этом: ${parts.join(', ')}. Сам этого не говори — это видно на экране.`;
}

/** Facts about the current position for free conversation. Never the best move (in «Учитель»: only the advice). */
export function buildPositionAnswerRu(a: PositionAnswerArgs): string {
  const s = studentWords(a.profile);
  const child = a.childColor;
  const { facts } = a;
  const childToMove = facts.sideToMove === child;
  const out: string[] = [];
  out.push(`Сейчас ${PHASE_RU[facts.phase]}.${a.gameOver ? ' Партия уже закончилась.' : ''}`);

  const last = (a.lastMoves ?? []).slice(-2);
  for (const m of last) {
    const spoken = spokenMoveRu(m.san, m.fenBefore);
    if (!spoken) continue;
    if (m.by === 'bot') {
      const attacks = a.examMode ? null : lastMoveAttacksRu(a.fen, m, child);
      out.push(`Последний ход соперника: ${spoken}${attacks ? `; ${attacks}` : ''}.`);
    } else {
      out.push(`Ход ${s.gen}: ${spoken}.`);
    }
  }
  if (facts.inCheck && !a.gameOver) out.push(childToMove ? `Королю ${s.gen} объявлен шах.` : 'Королю соперника объявлен шах.');
  out.push(`${materialBalanceRu(facts, child, s).replace(/^./u, (c) => c.toUpperCase())}.`);

  // no clock readings at all: the child sees the clock; only a nearly empty one earns «Поторопись!»
  const childMs = a.clock?.child ?? null;
  if (childMs !== null && childMs > 0 && childMs < LOW_CLOCK_MS && !a.gameOver) out.push(`${capRu(s.dat)} пора поторопиться — можно сказать одно слово: «Поторопись!»`);

  if (a.examMode) {
    out.push('Это экзамен: про угрозы, опасные фигуры и ходы не подсказывай — только поддержи.');
    out.push(obviousReferenceRu(a, s, childToMove));
    return clean(out);
  }

  const mine = hangingListRu(facts.hanging, child, 100);
  out.push(mine ? `Под боем у ${s.gen}: ${mine}.` : `Фигуры ${s.gen} сейчас не стоят под боем без защиты.`);
  if (childToMove && !a.gameOver) {
    const threat = a.threat !== undefined ? a.threat : mateInOneThreat(a.fen);
    if (threat) out.push(...threatFactsRu(a.fen, threat, s).map((f) => `${f}.`));
    else if (a.threat === null) out.push('Сильных угроз у соперника сейчас нет.');
    if (threat && isMateMotif(threat.motif)) out.push('Это самое важное: сначала защита короля.');
  }
  if (facts.hanging.some((h) => h.color !== child && h.piece !== 'k')) {
    out.push(`У соперника есть фигура без надёжной защиты — не называй какую, пусть ${s.nom} поищет сам.`.replace('сам.', s.g('сам.', 'сама.')));
  }
  if (facts.phase !== 'endgame' && !facts.castled[child] && facts.canStillCastle[child]) out.push(`Король ${s.gen} ещё не сделал рокировку.`);
  const line = a.analysis?.lines[0];
  if (line) out.push(`Шансы: ${winChanceWordsRu(winPct(toMoverPov(line, facts.sideToMove, child)), s)}.`);
  if (a.opening?.name) out.push(`Дебют: ${a.opening.name}.`);
  if (a.opening?.title && a.opening.idea) out.push(`План: ${a.opening.title} — ${a.opening.idea.charAt(0).toLowerCase()}${a.opening.idea.slice(1).replace(/[.!]+$/u, '')}.`);
  // «Учитель»: the advice closes the answer and may be named — no «ladder» words that would forbid it (TEACHER-MODE §7.1)
  out.push(a.teacher === true ? `Ходы ${s.gen} называй только из совета учителя, если он есть в этом ответе; слово «лучший» не говори.` : 'Лучший ход не называй: для этого есть подсказки по ступенькам.');
  out.push(obviousReferenceRu(a, s, childToMove));
  return clean(out);
}

/** Russian square words of a piece that stands on `square` in `fen` («конь на эф три»), or '' — handy for callers. */
export function pieceOnSquareRu(fen: string, square: string): string {
  const p = pieceAt(fen, square);
  return p ? pieceOnRu(p.piece, square) : '';
}
