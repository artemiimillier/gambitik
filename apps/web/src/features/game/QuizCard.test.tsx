/**
 * <QuizCard/> (docs/TEACHING.md §2.4): the question and three big buttons with their icons — piece figures for the
 * piece options, ✓ ⇄ ✗ for «съесть?» —, «3 подряд!» above them from two right answers in a row; after the answer the
 * right option is marked and nothing can be pressed any more. Server render (no DOM, no sound); the game's side of it
 * (journal, clock, the explanation) is in gameStore.lesson.test.ts. Also the result card's lesson lines.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LessonSummary, quizScoreRu } from './GameScreen.tsx';
import type { GameQuiz } from './gameTypes.ts';
import { QuizCard, quizIconGlyph, quizStreakText } from './QuizCard.tsx';

const PIECE_QUIZ: GameQuiz = {
  id: 'q7-whichPiece',
  kind: 'whichPiece',
  ply: 7,
  question: 'Какой фигурой лучше пойти?',
  options: [
    { id: 'n', label: 'Конём', icon: 'n' },
    { id: 'b', label: 'Слоном', icon: 'b' },
    { id: 'p', label: 'Пешкой', icon: 'p' },
  ],
  correctId: 'n',
  answeredId: null,
  streak: 0,
};

const CAPTURE_QUIZ: GameQuiz = {
  id: 'q9-canCapture',
  kind: 'canCapture',
  ply: 9,
  question: 'Выгодно ли съесть коня?',
  options: [
    { id: 'capYes', label: 'Да, бесплатно', icon: '✓' },
    { id: 'capTrade', label: 'Будет размен', icon: '⇄' },
    { id: 'capLose', label: 'Нет, потеряем', icon: '✗' },
  ],
  correctId: 'capYes',
  answeredId: null,
  streak: 3,
};

function buttons(html: string): string[] {
  return html.match(/<button[^]*?<\/button>/g) ?? [];
}

describe('<QuizCard/>', () => {
  it('the question, three buttons with their labels and piece figures; a group named by the question', () => {
    const html = renderToStaticMarkup(<QuizCard quiz={PIECE_QUIZ} onAnswer={() => undefined} />);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Какой фигурой лучше пойти?"');
    expect(html).toContain('Какой фигурой лучше пойти?');
    const list = buttons(html);
    expect(list).toHaveLength(3);
    expect(list[0]).toContain('Конём');
    expect(list[0]).toContain('♞');
    expect(list[1]).toContain('♝');
    expect(list[2]).toContain('♟');
    for (const b of list) {
      expect(b).not.toContain('disabled');
      expect(b).toContain('data-state="open"');
      expect(b).toContain('aria-pressed="false"');
    }
    // no streak before two right answers in a row
    expect(html).not.toContain('подряд');
  });

  it('«съесть?»: ✓ ⇄ ✗; the streak «3 подряд!» above the buttons', () => {
    const html = renderToStaticMarkup(<QuizCard quiz={CAPTURE_QUIZ} onAnswer={() => undefined} />);
    const list = buttons(html);
    expect(list.map((b) => ['✓', '⇄', '✗'].find((g) => b.includes(g)))).toEqual(['✓', '⇄', '✗']);
    expect(html).toContain('3 подряд!');
    expect(html.indexOf('3 подряд!')).toBeLessThan(html.indexOf('<button'));
  });

  it('answered: the right option marked, the tapped wrong one too, nothing can be pressed', () => {
    const html = renderToStaticMarkup(<QuizCard quiz={{ ...PIECE_QUIZ, answeredId: 'b' }} onAnswer={() => undefined} />);
    const list = buttons(html);
    expect(list[0]).toContain('data-state="right"');
    expect(list[1]).toContain('data-state="wrong"');
    expect(list[1]).toContain('aria-pressed="true"');
    expect(list[2]).toContain('data-state="other"');
    for (const b of list) expect(b).toContain('disabled');
    expect(html).toContain('data-answered="true"');
  });

  it('the icon and streak helpers', () => {
    expect(quizIconGlyph('q')).toBe('♛');
    expect(quizIconGlyph('K')).toBe('♚');
    expect(quizIconGlyph('×')).toBe('×');
    expect(quizIconGlyph(undefined)).toBeNull();
    expect(quizIconGlyph(' ')).toBeNull();
    expect(quizStreakText(0)).toBeNull();
    expect(quizStreakText(1)).toBeNull();
    expect(quizStreakText(2)).toBe('2 подряд!');
  });
});

describe('the result card\'s lesson lines', () => {
  it('the takeaway and «Ответил на 3 из 4 вопросов» (the verb agrees with the child)', () => {
    const html = renderToStaticMarkup(<LessonSummary takeaway="В следующий раз проверим, кто защищает фигуру." quizScore={{ right: 3, total: 4 }} address="m" />);
    expect(html).toContain('В следующий раз проверим, кто защищает фигуру.');
    expect(html).toContain('Ответил на 3 из 4 вопросов');
    expect(quizScoreRu({ right: 1, total: 1 }, 'f')).toBe('Ответила на 1 из 1 вопроса');
    expect(quizScoreRu({ right: 0, total: 5 }, 'm')).toBe('Ответил на 0 из 5 вопросов');
  });

  it('no quiz this game: no score line; nothing at all: nothing rendered', () => {
    const html = renderToStaticMarkup(<LessonSummary takeaway="Король в домике — и можно атаковать." quizScore={null} address="m" />);
    expect(html).not.toContain('Ответил');
    expect(renderToStaticMarkup(<LessonSummary takeaway={null} quizScore={null} address="m" />)).toBe('');
  });
});
