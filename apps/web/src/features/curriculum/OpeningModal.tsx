/**
 * One part of the opening repertoire «по идеям» in a modal: the plan in plain words, what to watch out for, and
 * the model lines on a board the child steps through (no memorising, no quiz — the IDEA is the content).
 */
import { useCallback, useEffect, useState } from 'react';
import { sanLineToBubbleRu } from '@gambit/core';
import { coach } from '../../coach/index.ts';
import { Badge, Button, Icon, Modal, playSound } from '../../ui/index.ts';
import { MiniBoard } from '../puzzles/MiniBoard.tsx';
import { makeLocalEvent } from '../puzzles/puzzleCoach.ts';
import styles from './CurriculumScreen.module.css';
import { START_FEN } from './curriculumModel.ts';
import type { RepertoireView } from './curriculumModel.ts';

export interface OpeningModalProps {
  entry: RepertoireView | null;
  onClose(): void;
}

export function OpeningModal({ entry, onClose }: OpeningModalProps) {
  const [lineIndex, setLineIndex] = useState(0);
  const [step, setStep] = useState(0);

  // a new part of the repertoire: first line, start position, and Гамбитик tells what it is about
  useEffect(() => {
    setLineIndex(0);
    setStep(0);
    if (entry && entry.summary !== '') void coach.say(makeLocalEvent({ kind: 'answer', priority: 1, pose: 'talk', text: `${entry.title}. ${entry.summary}` }));
  }, [entry]);

  const line = entry?.lines[lineIndex] ?? null;

  const chooseLine = useCallback(
    (index: number) => {
      const next = entry?.lines[index];
      if (!next) return;
      setLineIndex(index);
      setStep(0);
      // the previous explanation is stale now — never let two explanations queue up
      coach.stopSpeaking({ clearBubble: true });
      if (next.idea !== '') void coach.say(makeLocalEvent({ kind: 'answer', priority: 1, pose: next.warning ? 'think' : 'talk', text: `${next.title}. ${next.idea}` }));
    },
    [entry],
  );

  const goTo = useCallback(
    (next: number) => {
      if (!line) return;
      const clamped = Math.max(0, Math.min(line.moves.length, next));
      const move = clamped > step ? line.moves[clamped - 1] : undefined;
      if (move) playSound(move.isCheck ? 'check' : move.isCapture ? 'capture' : 'move');
      setStep(clamped);
      coach.noteActivity();
    },
    [line, step],
  );

  if (!entry || !line) return <Modal open={false} onClose={onClose} title="" />;

  const current = step > 0 ? line.moves[step - 1] : undefined;
  const finished = step >= line.moves.length;

  return (
    <Modal
      open
      onClose={onClose}
      title={entry.title}
      size="lg"
      actions={
        <Button size="lg" onClick={onClose}>
          Понятно!
        </Button>
      }
    >
      <div className={styles.cardBody}>
        {entry.against !== '' ? <p className={styles.muted}>{entry.against}</p> : null}
        {entry.summary !== '' ? <p className={styles.cardExplanation}>{entry.summary}</p> : null}

        <div className={styles.example}>
          {entry.lines.length > 1 ? (
            // up to six lines per part: compact chips, so the board stays on the first screen of the dialog
            <div className={styles.lineTabs} role="group" aria-label="Варианты">
              {entry.lines.map((item, index) => (
                <button key={item.id} type="button" className={styles.lineTab} aria-pressed={index === lineIndex} onClick={() => chooseLine(index)}>
                  {item.title}
                </button>
              ))}
            </div>
          ) : null}

          {line.warning ? <Badge tone="coral">Так играть не надо — смотри, почему</Badge> : null}
          {line.idea !== '' ? (
            <p className={styles.cardQuestion}>
              <Icon name="bulb" /> <span>{line.idea}</span>
            </p>
          ) : null}

          <div className={styles.exampleBoard}>
            <MiniBoard
              id={`opening-${entry.id}`}
              fen={current ? current.fenAfter : START_FEN}
              orientation={entry.side}
              lastMove={current ? { from: current.from, to: current.to } : null}
              maxSize={380}
              maxViewportShare={0.42}
              label={`Дебют: ${line.title}`}
            />
          </div>

          <p className={styles.exampleStatus} role="status" aria-live="polite">
            {finished ? (line.nextIdea ?? 'Дебют разыгран. Дальше — свой план: какую фигуру улучшить?') : step === 0 ? 'Листай ходы кнопкой «Вперёд» и следи за идеей.' : `Ход ${step} из ${line.moves.length}`}
          </p>
          {step > 0 ? <p className={styles.exampleMoves}>{sanLineToBubbleRu(line.moves.slice(0, step).map((move) => move.san))}</p> : null}

          <div className={styles.exampleActions}>
            <Button variant="secondary" size="md" icon={<Icon name="back" />} disabled={step === 0} onClick={() => goTo(step - 1)}>
              Назад
            </Button>
            {finished ? (
              <Button variant="secondary" size="md" icon={<Icon name="refresh" />} onClick={() => goTo(0)}>
                Сначала
              </Button>
            ) : (
              <Button variant="accent" size="md" iconAfter={<Icon name="forward" />} onClick={() => goTo(step + 1)}>
                Вперёд
              </Button>
            )}
          </div>
        </div>

        {entry.keyIdeas.length > 0 ? (
          <div>
            <h3 className={styles.blockTitle}>Главные идеи</h3>
            <ul className={styles.skills}>
              {entry.keyIdeas.map((idea) => (
                <li key={idea}>{idea}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {entry.watchOut.length > 0 ? (
          <div>
            <h3 className={styles.blockTitle}>Осторожно</h3>
            <ul className={styles.skills}>
              {entry.watchOut.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
