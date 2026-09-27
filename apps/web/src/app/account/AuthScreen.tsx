/**
 * The public site's door (accounts on — ./accountApi.ts): «Войти», «Новый ученик» (the site's invite code, a nickname,
 * a password, «мальчик / девочка», a stage) and «Забыли пароль?» (the recovery code shown once at sign-up). No e-mail,
 * no real name. After a sign-in the page reloads and the app starts with the child's own data; after a sign-up or a
 * recovery the (new) recovery code is shown first, once.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { CURRICULUM } from '@gambit/content';
import { BigChoice, Button, Icon } from '../../ui/index.ts';
import onboarding from '../Onboarding.module.css';
import shell from '../shell.module.css';
import { authErrorRu, recover, register, signIn } from './accountApi.ts';
import type { AuthFailure } from './accountApi.ts';
import { earnPow } from './pow.ts';
import type { PowAnswer } from './pow.ts';
import styles from './AuthScreen.module.css';

export interface AuthScreenProps {
  /** the server takes sign-ups (an invite code is set) */
  registration: boolean;
  /** sign-up needs an invite code (false: open registration) */
  invite?: boolean;
  /** signed in: the app reloads with the child's data */
  onSignedIn: () => void;
}

type Mode = 'login' | 'register' | 'recover';

/** A labelled field: the label names the input, the hint describes it (`<id>-hint`). */
function Field(props: { id: string; label: string; hint?: string | undefined; children: ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={props.id}>
        {props.label}
      </label>
      {props.children}
      {props.hint ? (
        <span id={`${props.id}-hint`} className={styles.hint}>
          {props.hint}
        </span>
      ) : null}
    </div>
  );
}

export function AuthScreen({ registration, invite: needsInvite = true, onSignedIn }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [invite, setInvite] = useState('');
  /** the hidden field: a person never fills it (a script that fills every field does) */
  const [website, setWebsite] = useState('');
  /** the proof of work of the sign-up, earned in the background while the form is filled (./pow.ts) */
  const pow = useRef<Promise<PowAnswer | null> | null>(null);
  const [address, setAddress] = useState<'m' | 'f' | null>(null);
  const [stage, setStage] = useState(1);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** a recovery code to show once (after a sign-up or a recovery) */
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const problemId = useId();

  const switchTo = (next: Mode): void => {
    setMode(next);
    setProblem(null);
    setPassword('');
    setPassword2('');
  };

  const fail = (f: AuthFailure): void => setProblem(authErrorRu(f));

  // the task is started as soon as the sign-up form opens: by the time the child presses the button it is solved
  useEffect(() => {
    if (mode === 'register' && pow.current === null) pow.current = earnPow().catch(() => null);
  }, [mode]);

  const signUp = async (): Promise<void> => {
    const input = { login, password, invite: needsInvite ? invite : '', website, address: address ?? 'm', stage };
    let answer = await (pow.current ?? (pow.current = earnPow().catch(() => null)));
    let r = await register(answer === null ? input : { ...input, pow: answer });
    if (!r.ok && r.code === 'bad-challenge' && website === '') {
      // the task went stale (a restart of the server, a long pause): one new one, once
      pow.current = earnPow().catch(() => null);
      answer = await pow.current;
      r = await register(answer === null ? input : { ...input, pow: answer });
    }
    if (!r.ok) {
      fail(r);
      return;
    }
    pow.current = null;
    setShownCode(r.recoveryCode);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setProblem(null);
    if ((mode === 'register' || mode === 'recover') && password !== password2) {
      setProblem('Пароли не совпадают.');
      return;
    }
    if (mode === 'register' && address === null) {
      setProblem('Выберите: мальчик или девочка.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        const r = await signIn(login, password);
        if (!r.ok) fail(r);
        else onSignedIn();
      } else if (mode === 'register') {
        await signUp();
      } else {
        const r = await recover(login, code, password);
        if (!r.ok) fail(r);
        else setShownCode(r.recoveryCode);
      }
    } finally {
      setBusy(false);
    }
  };

  if (shownCode !== null) {
    return (
      <div className={onboarding.page}>
        <section className={onboarding.card} aria-labelledby="recovery-title">
          <div className={onboarding.hello} aria-hidden="true">
            🔑
          </div>
          <h1 id="recovery-title" className={onboarding.question}>
            Код восстановления
          </h1>
          <p className={styles.code} data-testid="recovery-code">
            {shownCode}
          </p>
          <p className={onboarding.lead}>Запишите его или сфотографируйте. Если забудете пароль, по этому коду можно задать новый. Мы покажем его только один раз.</p>
          <div className={styles.row}>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(shownCode)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'Скопировано' : 'Скопировать'}
            </Button>
            <Button size="lg" variant="accent" icon={<Icon name="play" />} onClick={onSignedIn}>
              Я записал(а) код — дальше
            </Button>
          </div>
        </section>
      </div>
    );
  }

  const title = mode === 'login' ? 'Вход' : mode === 'register' ? 'Новый ученик' : 'Новый пароль';
  return (
    <div className={onboarding.page}>
      <form className={`${onboarding.card} ${styles.card}`} onSubmit={(e) => void submit(e)} noValidate aria-busy={busy}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            ♞
          </span>
          <span>Гамбитик — шахматный тренер</span>
        </div>
        {mode !== 'recover' ? (
          <div className={styles.tabs} role="tablist" aria-label="Вход или регистрация">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={styles.tab} onClick={() => switchTo('login')}>
              Войти
            </button>
            <button type="button" role="tab" aria-selected={mode === 'register'} className={styles.tab} onClick={() => switchTo('register')}>
              Новый ученик
            </button>
          </div>
        ) : null}
        <h1 className={onboarding.question}>{title}</h1>

        {mode === 'register' && !registration ? <p className={shell.note} data-tone="warn">Регистрация сейчас закрыта. Войти можно, если аккаунт уже есть.</p> : null}

        <Field id="auth-login" label="Ник" hint={mode === 'register' ? 'Так Гамбитик будет обращаться к ребёнку. Не настоящее имя — придумайте прозвище.' : undefined}>
          <input
            id="auth-login"
            className={shell.field}
            name="username"
            autoComplete="username"
            autoCapitalize="words"
            spellCheck={false}
            maxLength={40}
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="Например, Тигр"
            aria-describedby={mode === 'register' ? `auth-login-hint ${problemId}` : problemId}
          />
        </Field>

        {mode === 'recover' ? (
          <Field id="auth-recovery" label="Код восстановления" hint="Его показали один раз, когда создавали аккаунт.">
            <input id="auth-recovery" className={shell.field} name="recovery" autoComplete="off" spellCheck={false} maxLength={40} value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" aria-describedby="auth-recovery-hint" />
          </Field>
        ) : null}

        <Field id="auth-password" label={mode === 'recover' ? 'Новый пароль' : 'Пароль'} hint={mode === 'login' ? undefined : 'Не меньше 8 символов. Лучше несколько слов — такой пароль легко запомнить и трудно угадать.'}>
          <input
            id="auth-password"
            aria-describedby={mode === 'login' ? undefined : 'auth-password-hint'}
            className={shell.field}
            type="password"
            name="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {mode !== 'login' ? (
          <Field id="auth-password2" label="Пароль ещё раз">
            <input id="auth-password2" className={shell.field} type="password" name="password2" autoComplete="new-password" maxLength={200} value={password2} onChange={(e) => setPassword2(e.target.value)} />
          </Field>
        ) : null}

        {mode === 'register' ? (
          <>
            {needsInvite ? (
              <Field id="auth-invite" label="Код приглашения" hint="Его даёт тот, кто прислал ссылку на сайт.">
                <input id="auth-invite" className={shell.field} name="invite" autoComplete="off" spellCheck={false} maxLength={120} value={invite} onChange={(e) => setInvite(e.target.value)} aria-describedby="auth-invite-hint" />
              </Field>
            ) : null}
            <div className={styles.trap} aria-hidden="true">
              <label>
                Сайт
                <input name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </label>
            </div>
            <p className={styles.label}>Ребёнок — мальчик или девочка?</p>
            <div className={onboarding.pair}>
              <BigChoice accent="blue" icon="👦" title="Мальчик" subtitle="«ты нашёл»" selected={address === 'm'} disabled={busy} onClick={() => setAddress('m')} />
              <BigChoice accent="coral" icon="👧" title="Девочка" subtitle="«ты нашла»" selected={address === 'f'} disabled={busy} onClick={() => setAddress('f')} />
            </div>
            <Field id="auth-stage" label="Ступень" hint="Новичок начинает с первой. Потом Гамбитик сам предложит перейти выше.">
              <select id="auth-stage" className={shell.field} value={stage} onChange={(e) => setStage(Number(e.target.value))} aria-describedby="auth-stage-hint">
                {CURRICULUM.map((s) => (
                  <option key={s.stage} value={s.stage}>
                    {s.stage}. {s.title} ({s.ratingBand})
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}

        <p id={problemId} className={onboarding.problem} role="status">
          {problem ?? ''}
        </p>

        <Button type="submit" size="xl" loading={busy} disabled={mode === 'register' && !registration} iconAfter={<Icon name="forward" />}>
          {mode === 'login' ? 'Войти' : mode === 'register' ? 'Создать аккаунт' : 'Сменить пароль'}
        </Button>

        {mode === 'login' ? (
          <button type="button" className={styles.link} onClick={() => switchTo('recover')}>
            Забыли пароль?
          </button>
        ) : null}
        {mode === 'recover' ? (
          <button type="button" className={styles.link} onClick={() => switchTo('login')}>
            Назад ко входу
          </button>
        ) : null}

        <p className={onboarding.parentNote}>
          Для родителей: один аккаунт — один ученик. Мы не спрашиваем почту и настоящее имя: храним только ник, «мальчик / девочка» для русской грамматики, ступень, партии и
          успехи. Удалить аккаунт со всеми данными можно в настройках.
        </p>
      </form>
    </div>
  );
}

/** The public site's server does not answer at start: wait for it (never open the last child's data without a session). */
export function OfflineScreen() {
  return (
    <div className={onboarding.page}>
      <section className={onboarding.card} aria-labelledby="offline-title">
        <div className={onboarding.hello} aria-hidden="true">
          ♞
        </div>
        <h1 id="offline-title" className={onboarding.question}>
          Сервер не отвечает
        </h1>
        <p className={onboarding.lead}>Проверьте интернет и попробуйте ещё раз через минуту.</p>
        <Button size="lg" onClick={() => window.location.reload()}>
          Попробовать снова
        </Button>
      </section>
    </div>
  );
}
