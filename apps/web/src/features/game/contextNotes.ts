/**
 * Silent context notes for the conversational voice model (`VoiceLayer.pushContext`): one or two short Russian
 * sentences after every bot move and every judgement, so that the coach «sees» the board while he listens.
 *
 * Rules: only facts computed by code; no Latin notation (the model may echo a note aloud); never the best move,
 * never the refutation — what a note reveals is what the child can already see on the board.
 */
import { pieceNameRu, sanToSpokenRu, squareToSpokenRu } from '@gambit/core';
import type { Color, MoveClass, MoveJudgement, PositionFacts } from '@gambit/shared';

/** A child's piece must stand to lose at least this much (SEE, cp) to be mentioned as «под боем». */
const NOTE_MIN_SEE_CP = 100;

const CLASS_RU: Readonly<Record<MoveClass, string>> = {
  best: 'лучший ход',
  excellent: 'отличный ход',
  good: 'хороший ход',
  inaccuracy: 'неточность',
  mistake: 'ошибка',
  blunder: 'зевок',
  missedWin: 'упущенный шанс',
};

function spoken(san: string, fenBefore: string): string {
  try {
    return sanToSpokenRu(san, fenBefore);
  } catch {
    return 'ход сделан';
  }
}

function dangerLine(facts: PositionFacts, child: Color): string {
  if (facts.inCheck && facts.sideToMove === child) return 'Королю ученика шах.';
  const mine = facts.hanging.filter((h) => h.color === child && h.piece !== 'k' && h.seeLossCp >= NOTE_MIN_SEE_CP).slice(0, 2);
  if (mine.length === 0) return 'Под боем у ученика ничего нет.';
  return `Под боем у ученика: ${mine.map((h) => `${pieceNameRu(h.piece, 'nom')} на ${squareToSpokenRu(h.square)}`).join(', ')}.`;
}

/** «Ход соперника: конь на эф шесть. Под боем у ученика ничего нет.» `facts` = the position after the move; omit in exams. */
export function botMoveNoteRu(a: { san: string; fenBefore: string; childColor: Color; facts?: PositionFacts | null }): string {
  const head = `Ход соперника: ${spoken(a.san, a.fenBefore)}.`;
  return a.facts ? `${head} ${dangerLine(a.facts, a.childColor)}` : head;
}

/** «Ход ученика: ферзь на аш пять — зевок. Тренер предложил вернуть ход.» */
export function judgementNoteRu(j: Pick<MoveJudgement, 'san' | 'fenBefore' | 'classification'>, a: { offered: boolean }): string {
  const head = `Ход ученика: ${spoken(j.san, j.fenBefore)} — ${CLASS_RU[j.classification]}.`;
  return a.offered ? `${head} Тренер предложил вернуть ход — лучший ход не называй.` : head;
}
