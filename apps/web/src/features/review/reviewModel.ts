/**
 * Pure view-model of a finished game for the review screen: the main line with FENs, the child's
 * judgements matched to it, the attempts that were taken back and a small timeline of what happened
 * between the child and the coach. No React, no DOM.
 *
 * Matching is position-based (FEN + SAN), never ply-based, so it does not matter whether the game
 * module counts plies from 0 or from 1.
 */
import { Chess } from 'chess.js';
import type { Color, GameEvent, GameRecord, HintLevel, MoveClass, MoveJudgement, Square } from '@gambit/shared';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface ReviewMove {
  /** 1-based index in the main line */
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  from: Square;
  to: Square;
  fenBefore: string;
  fenAfter: string;
  byChild: boolean;
  /** only the child's moves are judged */
  judgement?: MoveJudgement;
}

export type TimelineItem =
  /**
   * the child played `san`, the coach asked, the move was taken back.
   * `improved` is a FACT: the move that stayed on the board in the same position is a
   * different one and lost fewer win% — only then may the screen say that a better move was found.
   */
  | { kind: 'takenBack'; id: string; cursor: number; san: string; judgement?: MoveJudgement; improved: boolean }
  /** the coach asked, the child kept the move */
  | { kind: 'keptMove'; id: string; cursor: number; san: string; judgement?: MoveJudgement }
  | { kind: 'hint'; id: string; cursor: number; level: HintLevel | null }
  | { kind: 'childSaid'; id: string; cursor: number; text: string };

export interface ReviewModel {
  startFen: string;
  moves: ReviewMove[];
  /** judged attempts of the child that did not stay on the board */
  takenBack: MoveJudgement[];
  timeline: TimelineItem[];
}

/** Placement + side to move + castling + en passant: identifies a position regardless of move counters. */
export function positionKey(fen: string): string {
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

function moveNumberOf(fen: string, fallbackPly: number): number {
  const n = Number(fen.trim().split(/\s+/)[5]);
  return Number.isInteger(n) && n > 0 ? n : Math.ceil(fallbackPly / 2);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** GameEvent.data is untyped: look for a string under one of `keys`, also inside common nested containers. */
function findString(data: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const direct = str(data[key]);
    if (direct !== null) return direct;
  }
  for (const container of ['event', 'coachEvent', 'judgement', 'move']) {
    const nested = data[container];
    if (!isRecord(nested)) continue;
    for (const key of keys) {
      const value = str(nested[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function hintLevelOf(data: Record<string, unknown>): HintLevel | null {
  for (const candidate of [data.level, data.hintLevel, isRecord(data.event) ? data.event.hintLevel : undefined]) {
    if (candidate === 1 || candidate === 2 || candidate === 3 || candidate === 4) return candidate;
  }
  return null;
}

// ───────────────────────── main line ─────────────────────────

interface RawMove {
  san: string;
  from: Square;
  to: Square;
  promotion?: string;
  color: Color;
  before: string;
  after: string;
}

function mainLineFromPgn(pgn: string): RawMove[] {
  if (pgn.trim() === '') return [];
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess.history({ verbose: true }).map((m) => ({ san: m.san, from: m.from, to: m.to, promotion: m.promotion, color: m.color, before: m.before, after: m.after }));
  } catch {
    return [];
  }
}

/** Fallback when the PGN is missing or broken: replay the 'move' events that were not taken back. */
function mainLineFromEvents(events: readonly GameEvent[]): RawMove[] {
  const chess = new Chess();
  const out: RawMove[] = [];
  for (const event of events) {
    if (event.type !== 'move' || event.data.takenBack === true) continue;
    const san = str(event.data.san);
    const uci = str(event.data.uci);
    try {
      const move =
        uci !== null && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)
          ? chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
          : san !== null
            ? chess.move(san)
            : null;
      if (move === null) break;
      out.push({ san: move.san, from: move.from, to: move.to, promotion: move.promotion, color: move.color, before: move.before, after: move.after });
    } catch {
      // A taken-back attempt that was not flagged would land here (illegal in the replay): skip it.
      continue;
    }
  }
  return out;
}

// ───────────────────────── judgements ─────────────────────────

function matchJudgements(moves: RawMove[], judgements: readonly MoveJudgement[], childColor: Color): { byIndex: Map<number, MoveJudgement>; takenBack: MoveJudgement[] } {
  const byIndex = new Map<number, MoveJudgement>();
  const used = new Set<MoveJudgement>();
  moves.forEach((move, index) => {
    if (move.color !== childColor) return;
    const sameSan = judgements.filter((j) => !used.has(j) && j.san === move.san && j.color === move.color);
    const samePosition = sameSan.filter((j) => positionKey(j.fenBefore) === positionKey(move.before));
    // the LAST matching judgement is the move that stayed; earlier identical attempts were taken back
    const chosen = samePosition[samePosition.length - 1] ?? sameSan.filter((j) => j.ply === index + 1 || j.ply === index).pop();
    if (chosen) {
      byIndex.set(index, chosen);
      used.add(chosen);
    }
  });
  return { byIndex, takenBack: judgements.filter((j) => !used.has(j)) };
}

/** Nav cursor (= plies played) at which `fen` is on the board; -1 when the position never occurred. */
export function cursorOfPosition(model: Pick<ReviewModel, 'startFen' | 'moves'>, fen: string): number {
  const key = positionKey(fen);
  // search from the end: with repeated positions the later one is where a recorded attempt usually belongs
  for (let i = model.moves.length - 1; i >= 0; i--) {
    const move = model.moves[i];
    if (move && positionKey(move.fenBefore) === key) return i;
  }
  const last = model.moves[model.moves.length - 1];
  if (last && positionKey(last.fenAfter) === key) return model.moves.length;
  return positionKey(model.startFen) === key ? 0 : -1;
}

// ───────────────────────── timeline ─────────────────────────

function cursorOfEvent(model: Pick<ReviewModel, 'startFen' | 'moves'>, event: GameEvent, judgement: MoveJudgement | undefined): number {
  if (judgement) {
    const byFen = cursorOfPosition(model, judgement.fenBefore);
    if (byFen >= 0) return byFen;
  }
  const fen = findString(event.data, ['fenBefore', 'fen']);
  if (fen !== null) {
    const byFen = cursorOfPosition(model, fen);
    if (byFen >= 0) return byFen;
  }
  // plies are 1-based by convention: the position BEFORE ply n has n-1 plies on the board
  const ply = typeof event.ply === 'number' && Number.isFinite(event.ply) ? event.ply : 1;
  return Math.max(0, Math.min(model.moves.length, Math.trunc(ply) - 1));
}

/** Did the move that stayed on the board really improve on the attempt that was taken back? */
export function takebackImproved(attempt: MoveJudgement | undefined, kept: readonly MoveJudgement[]): boolean {
  if (!attempt) return false;
  const key = positionKey(attempt.fenBefore);
  const final = [...kept].reverse().find((j) => positionKey(j.fenBefore) === key);
  return final !== undefined && final.uci !== attempt.uci && final.winPctLoss < attempt.winPctLoss;
}

function buildTimeline(base: Pick<ReviewModel, 'startFen' | 'moves'>, record: GameRecord, takenBack: readonly MoveJudgement[], kept: readonly MoveJudgement[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const unusedTakenBack = [...takenBack];
  let pendingSan: string | null = null;
  let n = 0;
  const id = (kind: string) => `${kind}-${n++}`;

  for (const event of record.events) {
    switch (event.type) {
      case 'takebackOffered':
        pendingSan = findString(event.data, ['san', 'playedSan']);
        break;
      case 'takebackAccepted': {
        const san = findString(event.data, ['san', 'playedSan']) ?? pendingSan;
        const at = unusedTakenBack.findIndex((j) => san === null || j.san === san);
        const judgement = at >= 0 ? unusedTakenBack.splice(at, 1)[0] : undefined;
        const shownSan = san ?? judgement?.san;
        if (shownSan !== undefined) {
          items.push({ kind: 'takenBack', id: id('tb'), cursor: cursorOfEvent(base, event, judgement), san: shownSan, ...(judgement ? { judgement } : {}), improved: takebackImproved(judgement, kept) });
        }
        pendingSan = null;
        break;
      }
      case 'takebackDeclined': {
        const san = findString(event.data, ['san', 'playedSan']) ?? pendingSan;
        const judgement = san !== null ? [...kept].reverse().find((j) => j.san === san) : undefined;
        if (san !== null) items.push({ kind: 'keptMove', id: id('kept'), cursor: cursorOfEvent(base, event, judgement), san, ...(judgement ? { judgement } : {}) });
        pendingSan = null;
        break;
      }
      case 'hintGiven':
        items.push({ kind: 'hint', id: id('hint'), cursor: cursorOfEvent(base, event, undefined), level: hintLevelOf(event.data) });
        break;
      case 'childSaid': {
        const text = findString(event.data, ['text', 'transcript', 'said', 'message']);
        if (text !== null) items.push({ kind: 'childSaid', id: id('said'), cursor: cursorOfEvent(base, event, undefined), text: text.slice(0, 280) });
        break;
      }
      default:
        break;
    }
  }

  // attempts that were taken back without a journal event (e.g. a manual take-back) still belong to the story
  for (const judgement of unusedTakenBack) {
    const cursor = cursorOfPosition(base, judgement.fenBefore);
    items.push({ kind: 'takenBack', id: id('tb'), cursor: Math.max(0, cursor), san: judgement.san, judgement, improved: takebackImproved(judgement, kept) });
  }
  return items;
}

// ───────────────────────── public ─────────────────────────

export function buildReviewModel(record: GameRecord): ReviewModel {
  let raw = mainLineFromPgn(record.pgn);
  if (raw.length === 0) raw = mainLineFromEvents(record.events);
  const { byIndex, takenBack } = matchJudgements(raw, record.judgements, record.childColor);

  const moves: ReviewMove[] = raw.map((move, index) => {
    const judgement = byIndex.get(index);
    return {
      ply: index + 1,
      moveNumber: moveNumberOf(move.before, index + 1),
      color: move.color,
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion ?? ''}`,
      from: move.from,
      to: move.to,
      fenBefore: move.before,
      fenAfter: move.after,
      byChild: move.color === record.childColor,
      ...(judgement ? { judgement } : {}),
    };
  });

  const base = { startFen: moves[0]?.fenBefore ?? START_FEN, moves };
  return { ...base, takenBack, timeline: buildTimeline(base, record, takenBack, [...byIndex.values()]) };
}

/** Position and last move for a nav cursor (0 = start position). */
export function boardAt(model: Pick<ReviewModel, 'startFen' | 'moves'>, cursor: number): { fen: string; lastMove: { from: Square; to: Square } | null; move: ReviewMove | null } {
  const move = cursor > 0 ? (model.moves[cursor - 1] ?? null) : null;
  return { fen: move ? move.fenAfter : model.startFen, lastMove: move ? { from: move.from, to: move.to } : null, move };
}

// ───────────────────────── marks ─────────────────────────

/** Shape + colour + title, never colour alone (research 08 §9). Same symbols as the written review. */
export const CLASS_MARK: Record<MoveClass, string> = {
  best: '★',
  excellent: '✓',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
  missedWin: '◇',
};

export type MarkTone = 'great' | 'fine' | 'careful' | 'oops';

export const CLASS_TONE: Record<MoveClass, MarkTone> = {
  best: 'great',
  excellent: 'great',
  good: 'fine',
  inaccuracy: 'careful',
  mistake: 'oops',
  blunder: 'oops',
  missedWin: 'careful',
};

export interface MoveRow {
  moveNumber: number;
  white: ReviewMove | null;
  black: ReviewMove | null;
}

/** Groups the main line into «1. e4 e5» rows; a game that starts with Black gets an empty white cell. */
export function toMoveRows(moves: readonly ReviewMove[]): MoveRow[] {
  const rows: MoveRow[] = [];
  for (const move of moves) {
    const last = rows[rows.length - 1];
    if (move.color === 'w' || !last || last.black !== null || last.moveNumber !== move.moveNumber) {
      rows.push({ moveNumber: move.moveNumber, white: move.color === 'w' ? move : null, black: move.color === 'b' ? move : null });
    } else {
      last.black = move;
    }
  }
  return rows;
}

// ───────────────────────── review polling ─────────────────────────

export const REVIEW_POLL_INTERVAL_MS = 3000;
export const REVIEW_POLL_MAX_MS = 60_000;

/** Keep asking the server while the review is still being written — but not forever. */
export function shouldKeepPolling(status: 'pending' | 'ready' | 'template' | 'failed', elapsedMs: number): boolean {
  return status === 'pending' && elapsedMs + REVIEW_POLL_INTERVAL_MS <= REVIEW_POLL_MAX_MS;
}
