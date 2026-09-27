/**
 * A concept card in a modal: the idea in a few sentences, the question to ask yourself and an example
 * board. The child may PLAY the solution (a wrong move just wiggles) or step through it with the buttons.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { sanLineToBubbleRu } from '@gambit/core';
import type { ConceptCard } from '@gambit/shared';
import { coach } from '../../coach/index.ts';
import { Button, Icon, Modal, playSound } from '../../ui/index.ts';
import { MiniBoard } from '../puzzles/MiniBoard.tsx';
import type { MiniBoardMove } from '../puzzles/MiniBoard.tsx';
import { makeLocalEvent } from '../puzzles/puzzleCoach.ts';
import { checkPuzzleMove, sideToMove } from '../puzzles/puzzleLine.ts';
import { useTimers } from '../puzzles/useTimers.ts';
import styles from './CurriculumScreen.module.css';
import { exampleLine } from './curriculumModel.ts';

export interface ConceptCardModalProps {
  card: ConceptCard | null;
  onClose(): void;
}

const REPLY_DELAY_MS = 600;

export function ConceptCardModal({ card, onClose }: ConceptCardModalProps) {
  const [exampleIndex, setExampleIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [shakeKey, setShakeKey] = useState(0);
  const [nudge, setNudge] = useState(false);
  const timers = useTimers();

  const example = card?.examples[exampleIndex] ?? null;
  const line = useMemo(() => (example ? exampleLine(example.fen, example.solutionSan) : []), [example]);
  const pseudoPuzzle = useMemo(() => (example ? { fen: example.fen, solutionUci: line.map((m) => m.uci) } : null), [example, line]);

  // a new card: start from its first example and let the mascot explain the idea
  useEffect(() => {
    setExampleIndex(0);
    setStep(0);
    setNudge(false);
    timers.clear();
    if (card) void coach.say(makeLocalEvent({ kind: 'answer', priority: 1, pose: 'talk', text: `${card.title}. ${card.explanation}` }));
  }, [card, timers]);

  const restart = useCallback(
    (index: number) => {
      timers.clear();
      setExampleIndex(index);
      setStep(0);
      setNudge(false);
    },
    [timers],
  );

  const showStep = useCallback(
    (next: number) => {
      const move = line[next - 1];
      if (move) playSound(move.isCheck ? 'check' : move.isCapture ? 'capture' : 'move');
      setStep(next);
      setNudge(false);
    },
    [line],
  );

  const manualStep = useCallback(
    (next: number) => {
      timers.clear();
      showStep(next);
    },
    [showStep, timers],
  );

  const handleMove = useCallback(
    (move: MiniBoardMove): boolean => {
      if (!pseudoPuzzle || step % 2 !== 0) return false;
      coach.noteActivity();
      const verdict = checkPuzzleMove(pseudoPuzzle, step, move.uci);
      if (verdict.kind === 'illegal') return false;
      if (verdict.kind === 'wrong') {
        setShakeKey((key) => key + 1);
        setNudge(true);
        return false;
      }
      if (verdict.alternateMate) {
        // fine chess, but the card tells a specific story: show its own line instead
        showStep(step + 1);
        return false;
      }
      showStep(step + 1);
      return true;
    },
    [pseudoPuzzle, showStep, step],
  );

  // the opponent's scripted answer plays by itself, however the hero move was made
  useEffect(() => {
    if (step % 2 === 1 && step < line.length) timers.after(REPLY_DELAY_MS, () => showStep(step + 1));
  }, [line.length, showStep, step, timers]);

  if (!card) return <Modal open={false} onClose={onClose} title="" />;

  const current = step > 0 ? line[step - 1] : undefined;
  const fen = current ? current.fenAfter : (example?.fen ?? '');
  const finished = step >= line.length;
  const heroColor = example ? sideToMove(example.fen) : 'w';
  const heroToMove = !finished && step % 2 === 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={card.title}
      size="lg"
      actions={
        <Button size="lg" onClick={onClose}>
          Понятно!
        </Button>
      }
    >
      <div className={styles.cardBody}>
        <p className={styles.cardExplanation}>{card.explanation}</p>
        <p className={styles.cardQuestion}>
          <Icon name="bulb" /> <span>{card.question}</span>
        </p>

        {example ? (
          <div className={styles.example}>
            {card.examples.length > 1 ? (
              <div className={styles.exampleTabs} role="group" aria-label="Примеры">
                {card.examples.map((_, i) => (
                  <Button key={i} size="md" variant={i === exampleIndex ? 'primary' : 'secondary'} aria-pressed={i === exampleIndex} onClick={() => restart(i)}>
                    Пример {i + 1}
                  </Button>
                ))}
              </div>
            ) : null}

            <div className={styles.exampleBoard}>
              <MiniBoard
                id={`concept-${card.id}`}
                fen={fen}
                orientation={heroColor}
                interactive={heroToMove}
                onMove={handleMove}
                lastMove={current ? { from: current.from, to: current.to } : null}
                shakeKey={shakeKey}
                maxSize={380}
                maxViewportShare={0.42}
                label={`Пример: ${card.title}`}
              />
            </div>

            <p className={styles.exampleStatus} role="status" aria-live="polite">
              {finished ? example.comment : nudge ? 'Есть ход посильнее. Попробуй ещё — или нажми «Показать ход».' : heroToMove ? `Ход ${heroColor === 'w' ? 'белых' : 'чёрных'}. Найди его на доске!` : 'Соперник отвечает…'}
            </p>
            {step > 0 ? <p className={styles.exampleMoves}>{sanLineToBubbleRu(line.slice(0, step).map((m) => m.san))}</p> : null}

            <div className={styles.exampleActions}>
              <Button variant="secondary" size="md" icon={<Icon name="back" />} disabled={step === 0} onClick={() => manualStep(Math.max(0, step - (step % 2 === 0 ? 2 : 1)))}>
                Назад
              </Button>
              {finished ? (
                <Button variant="secondary" size="md" icon={<Icon name="refresh" />} onClick={() => restart(exampleIndex)}>
                  Сначала
                </Button>
              ) : (
                <Button variant="accent" size="md" iconAfter={<Icon name="forward" />} onClick={() => manualStep(step + 1)}>
                  Показать ход
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
