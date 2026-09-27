/**
 * The app's answers to a child's question, as FACTS for the voice model to phrase (never a ready-made script):
 * the same engine-backed calls for the Live layer (client delegation) and the Realtime layer (function tools).
 *
 *   position  → host.analyzePosition()   (older games without it: host.getPositionSummary())
 *   a move    → host.evaluateMove(move)  (older games: the position facts + «check it by playing it»)
 *   why not?  → host.compareMove({ move } | { piece })   (older games: evaluateMove, see compareFacts)
 *   hints     → the hint ladder (./hintLadder.ts) — clamped in CODE, never more than one step up; in teacher mode the
 *               host answers with its advice (a `teachTurn`), which may name the advised moves
 *   last move → host.explainLastMove()
 *
 * Everything is bounded by a timeout: a slow engine never leaves the model (and the child) hanging.
 */
import type { CoachToolHost, PieceType } from '@gambit/shared';
import { CLARIFY_MOVE_FACTS_RU, clarifyPieceMoveFacts } from './coachBrief.ts';

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tool-timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Engine facts about the current position (never the best move — the host guarantees that). */
export function positionFacts(host: CoachToolHost, timeoutMs: number): Promise<string> {
  // `analyzePosition` is optional in the contract: a game written before it still answers with its summary
  const call = host.analyzePosition ? host.analyzePosition() : host.getPositionSummary();
  return withTimeout(call, timeoutMs);
}

export interface MoveFacts {
  /** false = it was not clear which move the child meant: `facts` asks the model to clarify */
  understood: boolean;
  facts: string;
}

/**
 * Facts about a HYPOTHETICAL move of the side to move (`move` = SAN / UCI from ./spokenMove.ts, null = unclear).
 * The move itself is not repeated in the facts (Latin notation must not reach the model's speech).
 */
export async function moveFacts(host: CoachToolHost, move: string | null, timeoutMs: number): Promise<MoveFacts> {
  if (move === null) return { understood: false, facts: CLARIFY_MOVE_FACTS_RU };
  if (!host.evaluateMove) {
    const summary = await withTimeout(host.getPositionSummary(), timeoutMs);
    return {
      understood: true,
      facts: `Проверить этот ход отдельно сейчас не получится. Факты о позиции: ${summary} Предложи ребёнку самому проверить: что ответит соперник, если так пойти? Сам ход не оценивай.`,
    };
  }
  return { understood: true, facts: await withTimeout(host.evaluateMove(move), timeoutMs) };
}

/** «а почему не ферзём?» / «а почему не конём на цэ три?» / «а если не так?» (docs/TEACHER-MODE.md §7.1) */
export interface WhyNotQuery {
  /** SAN / UCI (./spokenMove.ts); null = no concrete move was named */
  move: string | null;
  /** the piece named without a square («ферзём»); null = none */
  piece: PieceType | null;
}

/**
 * Facts that compare the move (or the best move of a piece) the child asks about with the coach's advice:
 *   host.compareMove({ move }) / ({ piece })   — the game compares with the current advice (teacher) or judges it
 *   host.evaluateMove(move)                    — an older game without compareMove: the move alone, as «а если…»
 * Nothing named at all, or only a piece and no compareMove → the model asks the child to be more precise.
 */
export async function compareFacts(host: CoachToolHost, query: WhyNotQuery, timeoutMs: number): Promise<MoveFacts> {
  const { move, piece } = query;
  // a concrete move wins over the piece word («а почему не конём на цэ три?»)
  if (move !== null) {
    if (host.compareMove) return { understood: true, facts: await withTimeout(host.compareMove({ move }), timeoutMs) };
    return moveFacts(host, move, timeoutMs);
  }
  if (piece === null) return { understood: false, facts: CLARIFY_MOVE_FACTS_RU };
  if (host.compareMove) return { understood: true, facts: await withTimeout(host.compareMove({ piece }), timeoutMs) };
  return { understood: false, facts: clarifyPieceMoveFacts(piece) };
}
