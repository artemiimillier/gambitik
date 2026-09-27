/**
 * Settings (behind the parent gate), public site only: who is signed in, «Выйти», «Удалить аккаунт» (with the
 * password; the account, its games, journal, progress and the browser's memory of the child are removed).
 */
import { useState } from 'react';
import { Button, Card, Modal } from '../../ui/index.ts';
import shell from '../shell.module.css';
import { authErrorRu } from './accountApi.ts';
import { accountUser, deleteHere, signOutHere } from './accountSession.ts';
import styles from './AuthScreen.module.css';

export function AccountCard() {
  const user = accountUser();
  const [leaving, setLeaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [leaveProblem, setLeaveProblem] = useState<string | null>(null);
  if (user === null) return null;

  const remove = async (): Promise<void> => {
    if (deleting) return;
    setDeleting(true);
    setProblem(null);
    const r = await deleteHere(password);
    if (!r.ok) {
      setProblem(authErrorRu(r));
      setDeleting(false);
    }
  };

  return (
    <Card as="section" title="Аккаунт" padding="lg">
      <p>
        Вы вошли как <b>{user.login}</b>. Партии, дневник и успехи этого ученика хранятся на сервере только в его аккаунте.
      </p>
      <div className={styles.row} style={{ justifyContent: 'flex-start' }}>
        <Button
          variant="secondary"
          loading={leaving}
          onClick={() => {
            setLeaving(true);
            setLeaveProblem(null);
            void signOutHere().then((r) => {
              if (!r.ok) {
                setLeaving(false);
                setLeaveProblem(`Выйти не получилось: ${authErrorRu(r)}`);
              }
            });
          }}
        >
          Выйти
        </Button>
        <Button variant="ghost" onClick={() => setConfirm(true)}>
          Удалить аккаунт…
        </Button>
      </div>
      {leaveProblem !== null ? (
        <p role="status" className={styles.hint} style={{ color: 'var(--color-coral-deep)' }}>
          {leaveProblem}
        </p>
      ) : null}
      <Modal
        open={confirm}
        onClose={() => {
          setConfirm(false);
          setPassword('');
          setProblem(null);
        }}
        title="Удалить аккаунт?"
        icon="🗑️"
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Отмена
            </Button>
            <Button variant="danger" loading={deleting} disabled={password === ''} onClick={() => void remove()}>
              Удалить навсегда
            </Button>
          </>
        }
      >
        <p>
          Аккаунт «{user.login}» будет удалён вместе со всеми партиями, дневником, успехами и настройками. Вернуть их будет нельзя.
        </p>
        <label className={styles.field}>
          <span className={styles.label}>Пароль для подтверждения</span>
          <input className={shell.field} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <p role="status" className={styles.hint} style={{ color: 'var(--color-coral-deep)' }}>
          {problem ?? ''}
        </p>
      </Modal>
    </Card>
  );
}
