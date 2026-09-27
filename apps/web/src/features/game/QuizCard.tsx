/**
 * <QuizCard/> — the lesson's question with three big buttons (docs/TEACHING.md §2.4): «Как думаешь, что задумал
 * соперник?», «Какой фигурой лучше пойти?», «Выгодно ли съесть коня?»… The game puts it at the top of the panel (on a
 * narrow screen above the board), like the «почему оставляем ход?» card: everything a child has to press sits where
 * Гамбитик's bubble never goes.
 *
 * Only renders the store's `GameState.quiz`: a tap calls `onAnswer(optionId)` (the game journals and answers it). After
 * the answer the card stays a moment — the right option marked, the tapped one too — and the buttons are pressed no more.
 * «3 подряд!» above the buttons once the child has answered two or more questions in a row right.
 */
import type { ReactElement } from 'react';
import { Button, Card } from '../../ui/index.ts';
import type { GameQuiz } from './gameTypes.ts';
import styles from './QuizCard.module.css';

/** The piece glyphs of the piece options (`options[].icon` = a piece letter); other icons (✓ ⇄ ✗ …) are shown as they are. */
const PIECE_GLYPHS: Readonly<Record<string, string>> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };

/** The glyph of an option icon: a piece letter → its figure, ✓ ⇄ ✗ ▮ × as they are, nothing → null. */
export function quizIconGlyph(icon: string | undefined): string | null {
  if (icon === undefined || icon.trim() === '') return null;
  return PIECE_GLYPHS[icon.toLowerCase()] ?? icon;
}

/** «3 подряд!» — only from two right answers in a row. */
export function quizStreakText(streak: number): string | null {
  return streak >= 2 ? `${streak} подряд!` : null;
}

export interface QuizCardProps {
  quiz: GameQuiz;
  onAnswer(optionId: string): void;
  className?: string;
}

export function QuizCard({ quiz, onAnswer, className }: QuizCardProps): ReactElement {
  const answered = quiz.answeredId !== null;
  const streak = quizStreakText(quiz.streak);
  return (
    <Card tone="sunny" padding="sm" className={[styles.quiz, className].filter(Boolean).join(' ')} role="group" aria-label={quiz.question} data-quiz={quiz.kind} data-answered={answered}>
      {streak ? (
        <p className={styles.streak} aria-live="polite">
          {streak}
        </p>
      ) : null}
      <p className={styles.question}>{quiz.question}</p>
      <div className={styles.options}>
        {quiz.options.map((option) => {
          const glyph = quizIconGlyph(option.icon);
          const right = answered && option.id === quiz.correctId;
          const tapped = answered && option.id === quiz.answeredId;
          return (
            <Button
              key={option.id}
              variant={right ? 'primary' : 'secondary'}
              size="md"
              block
              className={styles.option}
              data-option={option.id}
              data-state={right ? 'right' : tapped ? 'wrong' : answered ? 'other' : 'open'}
              aria-pressed={tapped}
              disabled={answered}
              icon={glyph ? <span className={styles.glyph} aria-hidden="true">{glyph}</span> : undefined}
              onClick={() => onAnswer(option.id)}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </Card>
  );
}
