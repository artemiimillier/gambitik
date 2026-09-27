/**
 * Short Russian description of the current position for the realtime voice model (`getPositionSummary` tool).
 *
 * Rules (research 07 §5.3–5.4): only facts computed by code, no centipawns (the model would read them to
 * the child), no Latin notation (the text may be spoken), and nothing that gives the best move away —
 * the opponent's loose pieces are mentioned without the square; the hint ladder is the way to learn more.
 * What the screen shows (colour, move number, whose move) closes the text as an «only if asked» reference.
 */
import { pieceNameRu, sanToSpokenRu, squareToSpokenRu, toMoverPov, winPct } from '@gambit/core';
import type { AnalysisResult, Color, PositionFacts } from '@gambit/shared';

export interface PositionSummaryArgs {
  facts: PositionFacts;
  childColor: Color;
  /** cached engine analysis of the same position, if there is one */
  analysis?: AnalysisResult | null;
  /** the last move on the board */
  lastMove?: { san: string; fenBefore: string; by: 'child' | 'bot' } | null;
  /** full-move number of the game */
  moveNumber?: number;
  gameOver?: boolean;
}

const COLOR_RU: Record<Color, string> = { w: 'белыми', b: 'чёрными' };
const PHASE_RU: Record<PositionFacts['phase'], string> = { opening: 'дебют', middlegame: 'середина игры', endgame: 'эндшпиль' };

function pawnsRu(n: number): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return `${abs} пешку`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${abs} пешки`;
  return `${abs} пешек`;
}

function materialLine(facts: PositionFacts, child: Color): string {
  const diff = child === 'w' ? facts.material.diff : -facts.material.diff;
  if (diff === 0) return 'Материал равный.';
  return diff > 0 ? `У ребёнка материала больше на ${pawnsRu(diff)}.` : `У соперника материала больше на ${pawnsRu(diff)}.`;
}

/** Engine verdict in words, from the child's point of view. */
export function evalWordsRu(analysis: AnalysisResult | null | undefined, sideToMove: Color, child: Color): string | null {
  const line = analysis?.lines[0];
  if (!line) return null;
  const pct = winPct(toMoverPov(line, sideToMove, child));
  if (pct >= 85) return 'По оценке движка у ребёнка большое преимущество.';
  if (pct >= 62) return 'По оценке движка позиция ребёнка немного лучше.';
  if (pct > 38) return 'По оценке движка шансы примерно равны.';
  if (pct > 15) return 'По оценке движка позиция ребёнка немного хуже.';
  return 'По оценке движка у ребёнка трудная позиция.';
}

/**
 * What everybody sees on the screen — the colour, the move number, whose move it is — only as a reference for a direct
 * question, never as a fact to retell (the Live rules: never the colour or whose move it is).
 */
function obviousReferenceRu(args: PositionSummaryArgs, childToMove: boolean): string {
  const parts = [
    `ребёнок играет ${COLOR_RU[args.childColor]}`,
    args.moveNumber !== undefined ? `идёт ${args.moveNumber}-й ход` : null,
    args.gameOver ? null : childToMove ? 'сейчас ход ребёнка' : 'сейчас ходит соперник',
  ].filter((p): p is string => p !== null);
  return `Только если ребёнок сам спросит об этом: ${parts.join(', ')}. Сам этого не говори — это видно на экране.`;
}

export function describePositionRu(args: PositionSummaryArgs): string {
  const { facts, childColor } = args;
  const childToMove = facts.sideToMove === childColor;
  const parts: string[] = [];

  parts.push(`Сейчас ${PHASE_RU[facts.phase]}.`);
  if (args.gameOver) parts.push('Партия уже закончилась.');
  if (facts.openingName) parts.push(`Дебют: ${facts.openingName}.`);

  if (args.lastMove) {
    const who = args.lastMove.by === 'child' ? 'ребёнка' : 'соперника';
    parts.push(`Последний ход ${who}: ${sanToSpokenRu(args.lastMove.san, args.lastMove.fenBefore)}.`);
  }
  if (facts.inCheck && !args.gameOver) parts.push(childToMove ? 'Королю ребёнка объявлен шах.' : 'Королю соперника объявлен шах.');

  parts.push(materialLine(facts, childColor));

  const mine = facts.hanging.filter((h) => h.color === childColor && h.piece !== 'k').slice(0, 3);
  if (mine.length > 0) {
    const list = mine.map((h) => `${pieceNameRu(h.piece, 'nom')} на ${squareToSpokenRu(h.square)}`).join(', ');
    parts.push(`Под ударом у ребёнка: ${list}.`);
  } else {
    parts.push('У ребёнка все фигуры защищены.');
  }
  if (facts.hanging.some((h) => h.color !== childColor && h.piece !== 'k')) {
    parts.push('У соперника есть фигура без надёжной защиты — какую именно, не называй, пусть ребёнок поищет сам.');
  }

  if (facts.phase !== 'endgame' && !facts.castled[childColor] && facts.canStillCastle[childColor]) {
    parts.push('Король ребёнка ещё не сделал рокировку.');
  }

  const verdict = evalWordsRu(args.analysis, facts.sideToMove, childColor);
  if (verdict) parts.push(verdict);

  parts.push('Лучший ход называть нельзя — для этого есть подсказки по ступенькам.');
  parts.push(obviousReferenceRu(args, childToMove));
  return parts.join(' ');
}
