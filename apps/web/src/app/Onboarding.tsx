/**
 * First run: two friendly questions, then Гамбитик waves and greets.
 * State logic is in onboarding.ts; this file is the view + the side effects (save, speak).
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { buildGreeting } from '@gambit/core';
import type { StudentProfile } from '@gambit/shared';
import { coach, useCoachStore } from '../coach/index.ts';
import { BigChoice, Button, Icon } from '../ui/index.ts';
import type { SaveStudentResult } from './appStore.ts';
import { scheduleGreeting, shellCoachEvent } from './greeting.ts';
import { ONBOARDING_ADDRESS_PHRASE, ONBOARDING_NAME_PHRASE } from './shellPhrases.ts';
import { NICKNAME_MAX_LENGTH, initialOnboardingState, nicknameProblemRu, onboardingReducer } from './onboarding.ts';
import type { Address, OnboardingStep } from './onboarding.ts';
import styles from './Onboarding.module.css';
import shell from './shell.module.css';

export interface OnboardingProps {
  profile: StudentProfile | null;
  saveStudent: (patch: { nickname: string; address: Address }) => Promise<SaveStudentResult>;
  /** the child pressed «Поехали!» */
  onDone: () => void;
}

const STEPS: readonly OnboardingStep[] = ['name', 'address', 'welcome'];

const QUESTION_NAME = shellCoachEvent(ONBOARDING_NAME_PHRASE);
const QUESTION_ADDRESS = shellCoachEvent(ONBOARDING_ADDRESS_PHRASE);

export function Onboarding({ profile, saveStudent, onDone }: OnboardingProps) {
  const [state, dispatch] = useReducer(onboardingReducer, profile, initialOnboardingState);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelGreeting = useRef<(() => void) | null>(null);

  // Гамбитик asks the questions aloud (held by the coach until the first click unlocks sound)
  useEffect(() => {
    if (state.step === 'name') void coach.say(QUESTION_NAME);
    if (state.step === 'address') void coach.say(QUESTION_ADDRESS);
  }, [state.step]);

  useEffect(() => {
    if (state.step === 'name') inputRef.current?.focus();
  }, [state.step]);

  useEffect(() => () => cancelGreeting.current?.(), []);

  const submitName = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    dispatch({ type: 'submitNickname' });
  };

  const chooseAddress = (address: Address): void => {
    if (saving || state.nickname === null) return;
    const nickname = state.nickname;
    setSaving(true);
    void saveStudent({ nickname, address })
      .then((result) => {
        if (result.status === 'rejected') {
          dispatch({ type: 'nicknameRejected' });
          return;
        }
        dispatch({ type: 'chooseAddress', address });
        cancelGreeting.current?.();
        cancelGreeting.current = scheduleGreeting({
          store: useCoachStore,
          say: (coachEvent) => coach.say(coachEvent),
          buildEvent: () => buildGreeting({ profile: result.profile, hour: new Date().getHours() }),
        });
      })
      .finally(() => setSaving(false));
  };

  const problemId = 'onboarding-name-problem';

  return (
    <div className={styles.page}>
      <ol className={styles.dots} aria-label="Шаги знакомства">
        {STEPS.map((step, index) => (
          <li key={step} data-on={step === state.step ? 'true' : 'false'} data-done={STEPS.indexOf(state.step) > index ? 'true' : 'false'}>
            <span className={styles.srOnly}>
              Шаг {index + 1} из {STEPS.length}
            </span>
          </li>
        ))}
      </ol>

      {state.step === 'name' ? (
        <form className={styles.card} onSubmit={submitName} noValidate>
          <h1 className={styles.question}>Как тебя зовут?</h1>
          <input
            ref={inputRef}
            className={shell.field}
            data-size="hero"
            type="text"
            name="nickname"
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            enterKeyHint="next"
            maxLength={NICKNAME_MAX_LENGTH + 8}
            placeholder="Например, Тигр"
            aria-label="Твоё имя или прозвище"
            aria-invalid={state.problem !== null}
            aria-describedby={state.problem !== null ? problemId : undefined}
            value={state.nicknameInput}
            onChange={(event) => dispatch({ type: 'typeNickname', value: event.target.value })}
            onKeyDown={(event) => {
              // explicit, so «Enter» works the same in every browser and embedded web view
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                dispatch({ type: 'submitNickname' });
              }
            }}
          />
          <p id={problemId} className={styles.problem} role="status">
            {state.problem !== null ? nicknameProblemRu(state.problem) : ''}
          </p>
          <Button type="submit" size="xl" iconAfter={<Icon name="forward" />}>
            Дальше
          </Button>
          <p className={styles.parentNote}>Для родителей: подойдёт имя или прозвище. Фамилию и другие личные данные указывать не нужно.</p>
        </form>
      ) : null}

      {state.step === 'address' ? (
        <section className={styles.card} aria-busy={saving}>
          <h1 className={styles.question}>Ты мальчик или девочка?</h1>
          <div className={styles.pair}>
            <BigChoice accent="blue" icon="👦" title="Мальчик" disabled={saving} onClick={() => chooseAddress('m')} />
            <BigChoice accent="coral" icon="👧" title="Девочка" disabled={saving} onClick={() => chooseAddress('f')} />
          </div>
          <p className={styles.parentNote}>
            Для родителей: это нужно только для русской грамматики — чтобы Гамбитик говорил «ты нашёл» или «ты нашла». Изменить можно в настройках.
          </p>
          <Button variant="ghost" icon={<Icon name="back" />} disabled={saving} onClick={() => dispatch({ type: 'back' })}>
            Назад
          </Button>
        </section>
      ) : null}

      {state.step === 'welcome' ? (
        <section className={styles.card}>
          <div className={styles.hello} aria-hidden="true">
            ♞
          </div>
          <h1 className={styles.question}>Приятно познакомиться, {state.nickname}!</h1>
          <p className={styles.lead}>Я Гамбитик. Будем играть, решать задачи и думать вместе. Если что — я всегда в углу экрана.</p>
          <Button size="xl" variant="accent" icon={<Icon name="play" />} onClick={onDone}>
            Поехали!
          </Button>
        </section>
      ) : null}
    </div>
  );
}
