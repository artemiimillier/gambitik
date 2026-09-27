/**
 * The turn half of the lesson director (docs/TEACHING.md §2.1–§2.7): the theme, the child turn (danger, treasure,
 * quiz, «Сам», mini-lesson, advice, quiet), the quiz answer, reveal / repeat / why, the opponent chip, hurry — and the
 * installation of the whole director (turn half + ./reaction.ts).
 */
import { installLessonDirector } from './director.ts';
import type { LessonDirectorImpl } from './director.ts';
import { REACTION_IMPL } from './reaction.ts';
import {
  lessonAnswerImpl,
  lessonGameStartImpl,
  lessonHurryImpl,
  lessonOpponentImpl,
  lessonRepeatImpl,
  lessonRevealImpl,
  lessonTurnImpl,
  lessonWhyImpl,
} from './turn.ts';

export const TURN_IMPL: Omit<LessonDirectorImpl, keyof typeof REACTION_IMPL> = {
  lessonGameStart: (args, memory, book) => lessonGameStartImpl(args, memory, book),
  lessonTurn: (ctx, book, rng) => lessonTurnImpl(ctx, book, rng),
  lessonAnswer: (plan, memory, optionId, book) => lessonAnswerImpl(plan, memory, optionId, book),
  lessonReveal: (plan, memory, book) => lessonRevealImpl(plan, memory, book),
  lessonRepeat: (plan, memory, book) => lessonRepeatImpl(plan, memory, book),
  lessonWhy: (plan, memory, book) => lessonWhyImpl(plan, memory, book),
  lessonOpponent: (args, _memory, book) => lessonOpponentImpl(args, book),
  lessonHurry: (profile, book) => lessonHurryImpl(profile, book),
};

installLessonDirector({ ...TURN_IMPL, ...REACTION_IMPL });
