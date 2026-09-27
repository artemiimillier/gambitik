/**
 * The parent gate of the settings (app/parentGate.ts — the same speed bump, the same ten minutes per tab) in a small
 * inline form for the progress screen: hold the button three seconds, or add two numbers. Opening it here also opens
 * the settings, and the other way round.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { PARENT_GATE_HOLD_MS, checkGateAnswer, getGateStorage, makeGateQuestion, openGate } from '../../app/parentGate.ts';
import { Button, Card, Icon } from '../../ui/index.ts';
import styles from './ProgressScreen.module.css';

export interface ParentLockProps {
  onPass(): void;
  onCancel(): void;
}

export function ParentLock({ onPass, onCancel }: ParentLockProps) {
  const [holding, setHolding] = useState(false);
  const [question] = useState(() => makeGateQuestion());
  const [answer, setAnswer] = useState('');
  const [wrong, setWrong] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pass = useCallback(() => {
    openGate(getGateStorage(), Date.now());
    onPass();
  }, [onPass]);

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
      pass();
    }, PARENT_GATE_HOLD_MS);
  }, [pass]);

  useEffect(() => stopHold, [stopHold]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) startHold();
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (checkGateAnswer(question, answer)) pass();
    else setWrong(true);
  };

  return (
    <Card padding="lg" tone="tint" as="section" aria-label="Только для взрослых" className={styles.lock}>
      <h4 className={styles.lockTitle}>
        <Icon name="lock" /> Это для мамы и папы
      </h4>
      <p className={styles.lockHelp}>Здесь можно отметить партии, которые играл взрослый, начать прогресс заново и открыть журнал партии.</p>
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
        <span className={styles.holdLabel}>{holding ? 'Держите…' : 'Нажать и держать 3 секунды'}</span>
      </button>
      <form className={styles.lockForm} onSubmit={submit} noValidate>
        <label className={styles.lockLabel} htmlFor="progress-gate-answer">
          Или решите пример: сколько будет {question.text}?
        </label>
        <div className={styles.lockRow}>
          <input
            id="progress-gate-answer"
            className={styles.lockInput}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            aria-invalid={wrong}
            value={answer}
            onChange={(event) => {
              setAnswer(event.target.value);
              setWrong(false);
            }}
          />
          <Button type="submit" size="md" variant="secondary" disabled={answer.trim() === ''}>
            Войти
          </Button>
          <Button type="button" size="md" variant="ghost" onClick={onCancel}>
            Отмена
          </Button>
        </div>
        <p className={styles.lockHelp} data-problem={wrong ? 'true' : 'false'} role="status">
          {wrong ? 'Не сходится. Попробуйте ещё раз.' : 'Ребёнку сюда не нужно: его партии и успехи видны и так.'}
        </p>
      </form>
    </Card>
  );
}
