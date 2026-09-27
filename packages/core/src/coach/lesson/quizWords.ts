/**
 * The words of a quiz's answer buttons (docs/TEACHING.md §2.4) and, at stages 1–2, the options sentence said aloud
 * («Ладью, коня или слона?»). One implementation for the lesson engine (turn.ts), the clip planner and the server that
 * records the sentence («Дозапись голоса»), so what is recorded is always exactly what the bubble shows.
 */
import type { PieceType, QuizKind } from '@gambit/shared';
import { capitalize } from '../phrase.ts';
import { pieceNameRu } from '../spoken.ts';

/** A quiz-button pool (`v3.quiz.opt.*` goals, `v3.quiz.cat.*` stage 1–2 categories): a label, never said alone. */
export function isOptionPool(pool: string): boolean {
  return pool.startsWith('v3.quiz.opt.') || pool.startsWith('v3.quiz.cat.');
}

/** The label of a button that names a piece type (no pool for it): «Конём» (which piece moves), «Коня» (danger: which one is attacked). */
export function pieceLabel(p: PieceType, kind: QuizKind): string {
  return capitalize(pieceNameRu(p, kind === 'danger' ? 'acc' : 'ins'));
}

/** The label of a button from its picked wording's text: the end mark goes («Защитить короля.» → «Защитить короля»). */
export function quizOptionLabel(text: string): string {
  return text.replace(/[.!?…]+$/u, '');
}

/** The three labels as one spoken question: «Ладью, коня или слона?» (first capitalised, the others lower-cased). */
export function quizOptionsText(labels: readonly [string, string, string]): string {
  const [a, b, c] = labels;
  const low = (s: string): string => (s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  return `${capitalize(a)}, ${low(b)} или ${low(c)}?`;
}
