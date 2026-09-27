/**
 * The quiz button words and the stage 1–2 options sentence (moved out of turn.ts unchanged): the lesson engine, the clip
 * planner and the server that records the sentence all build it here, so the recording says exactly the bubble.
 */
import { describe, expect, it } from 'vitest';
import { isOptionPool, pieceLabel, quizOptionLabel, quizOptionsText } from './quizWords.ts';

describe('quiz words', () => {
  it('knows the button pools', () => {
    expect(isOptionPool('v3.quiz.opt.attack')).toBe(true);
    expect(isOptionPool('v3.quiz.cat.capture')).toBe(true);
    expect(isOptionPool('v3.quiz.question.oppIdea')).toBe(false);
    expect(isOptionPool('v3.lead.advice')).toBe(false);
  });

  it('names a piece button «which piece moves» in the instrumental, the attacked one (danger) in the accusative', () => {
    expect(pieceLabel('n', 'whichPiece')).toBe('Конём');
    expect(pieceLabel('n', 'danger')).toBe('Коня');
    expect(pieceLabel('q', 'danger')).toBe('Ферзя');
  });

  it('drops the end mark of a picked wording', () => {
    expect(quizOptionLabel('Защитить короля.')).toBe('Защитить короля');
    expect(quizOptionLabel('Будет размен!')).toBe('Будет размен');
    expect(quizOptionLabel('Съесть фигуру')).toBe('Съесть фигуру');
  });

  it('says the three labels as one question, the first capitalised, the others lower-cased', () => {
    expect(quizOptionsText(['Коня', 'Слона', 'Ладью'])).toBe('Коня, слона или ладью?');
    expect(quizOptionsText(['нападает', 'Съедает фигуру', 'Выводит фигуру'])).toBe('Нападает, съедает фигуру или выводит фигуру?');
  });
});
