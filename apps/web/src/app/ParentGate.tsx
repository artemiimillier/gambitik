/**
 * «Страница для взрослых» — the speed bump in front of the settings (logic in parentGate.ts).
 * Hold the big button for three seconds, or add two numbers. Гамбитик tells a child who cannot read yet what
 * this page is; nothing here blames or scares — the way home is the biggest thing on the screen after the button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { coach } from '../coach/index.ts';
import { Button, Card, Icon, Screen } from '../ui/index.ts';
import { shellCoachEvent } from './greeting.ts';
import { PARENT_GATE_PHRASE } from './shellPhrases.ts';
import { PARENT_GATE_HOLD_MS, checkGateAnswer, makeGateQuestion } from './parentGate.ts';
import styles from './Settings.module.css';
import shell from './shell.module.css';

export interface ParentGateProps {
  onPass: () => void;
  onExit: () => void;
  /** heading of the page behind the gate */
  title?: string;
}

export function ParentGate({ onPass, onExit, title = 'Настройки' }: ParentGateProps) {
  const [holding, setHolding] = useState(false);
  const [question] = useState(() => makeGateQuestion());
  const [answer, setAnswer] = useState('');
  const [wrong, setWrong] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const spoke = useRef(false);

  useEffect(() => {
    if (spoke.current) return; // StrictMode runs effects twice in dev
    spoke.current = true;
    void coach.say(shellCoachEvent(PARENT_GATE_PHRASE));
  }, []);

  const stopHold = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);

  const startHold = useCallback(() => {
    if (timer.current !== null) return;
    setHolding(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      onPass();
    }, PARENT_GATE_HOLD_MS);
  }, [onPass]);

  useEffect(() => stopHold, [stopHold]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) startHold();
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (checkGateAnswer(question, answer)) onPass();
    else setWrong(true);
  };

  return (
    <Screen title={title} subtitle="Страница для взрослых" onBack={onExit} backLabel="Домой">
      <div className={styles.sections}>
        <Card as="section" padding="lg" className={styles.gate}>
          <h2 className={styles.gateTitle}>Эта страница — для мамы и папы</h2>
          <p className={styles.help}>Здесь настраиваются голос Гамбитика, микрофон и ступень обучения. Чтобы войти, нажмите кнопку и держите её три секунды.</p>

          <button
            type="button"
            className={styles.holdButton}
            data-holding={holding ? 'true' : 'false'}
            onPointerDown={startHold}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onPointerCancel={stopHold}
            onKeyDown={onKeyDown}
            onKeyUp={stopHold}
            onBlur={stopHold}
            onContextMenu={(event) => event.preventDefault()}
          >
            <span className={styles.holdFill} aria-hidden="true" />
            <span className={styles.holdLabel}>
              <Icon name="gear" /> {holding ? 'Держите…' : 'Нажать и держать 3 секунды'}
            </span>
          </button>

          <form className={styles.gateForm} onSubmit={submit} noValidate>
            <label className={styles.label} htmlFor="parent-gate-answer">
              Или решите пример: сколько будет {question.text}?
            </label>
            <div className={styles.nameRow}>
              <input
                id="parent-gate-answer"
                className={shell.field}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                aria-invalid={wrong}
                aria-describedby="parent-gate-help"
                value={answer}
                onChange={(event) => {
                  setAnswer(event.target.value);
                  setWrong(false);
                }}
              />
              <Button type="submit" size="lg" variant="secondary" disabled={answer.trim() === ''}>
                Войти
              </Button>
            </div>
            <p id="parent-gate-help" className={styles.help} data-problem={wrong ? 'true' : 'false'} role="status">
              {wrong ? 'Не сходится. Попробуйте ещё раз.' : 'Ребёнку сюда не нужно: всё для игры есть на главном экране.'}
            </p>
          </form>
        </Card>
      </div>
    </Screen>
  );
}
