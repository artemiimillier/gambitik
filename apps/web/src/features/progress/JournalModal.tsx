/**
 * The markdown journal of one game, read-only, for the parent (behind the parent gate): the same safe renderer as the
 * review (no HTML, no clickable links), fed in chunks because a journal is longer than one review.
 */
import { useEffect, useMemo, useState } from 'react';
import type { GameJournalResponse } from '@gambit/shared';
import { Button, Icon, Modal, Spinner } from '../../ui/index.ts';
import { Markdown } from '../review/Markdown.tsx';
import { splitJournal } from './gamesModel.ts';
import { getGameJournal } from './progressApi.ts';
import styles from './ProgressScreen.module.css';

export interface JournalModalProps {
  /** the game whose journal is open; null = closed */
  gameId: string | null;
  /** «Партия с Петей, 21 сентября» */
  title: string;
  onClose(): void;
}

type JournalState = { status: 'loading' } | { status: 'error'; missing: boolean } | { status: 'ready'; journal: GameJournalResponse };

export function JournalBody({ journal }: { journal: GameJournalResponse }) {
  const chunks = useMemo(() => splitJournal(journal.markdown), [journal.markdown]);
  return (
    <div className={styles.journal}>
      <p className={styles.journalFile}>
        Файл: <code>{journal.fileName}</code>
      </p>
      {chunks.map((chunk, i) => (
        <Markdown key={i} source={chunk} headingOffset={1} />
      ))}
    </div>
  );
}

export function JournalModal({ gameId, title, onClose }: JournalModalProps) {
  const [state, setState] = useState<JournalState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (gameId === null) return;
    const abort = new AbortController();
    setState({ status: 'loading' });
    getGameJournal(gameId, { signal: abort.signal })
      .then((journal) => {
        if (!abort.signal.aborted) setState({ status: 'ready', journal });
      })
      .catch((error: unknown) => {
        const missing = typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
        if (!abort.signal.aborted) setState({ status: 'error', missing });
      });
    return () => abort.abort();
  }, [gameId, attempt]);

  return (
    <Modal open={gameId !== null} onClose={onClose} title={title} size="lg" closeOnBackdrop>
      {state.status === 'loading' ? (
        <div className={styles.center}>
          <Spinner size={40} label="Открываю журнал…" showLabel />
        </div>
      ) : state.status === 'error' ? (
        <div className={styles.journalError}>
          <p>{state.missing ? 'Файла журнала для этой партии нет в папке data/games.' : 'Не получилось открыть журнал: сервер не ответил.'}</p>
          {!state.missing ? (
            <Button variant="secondary" icon={<Icon name="refresh" />} onClick={() => setAttempt((n) => n + 1)}>
              Попробовать ещё
            </Button>
          ) : null}
        </div>
      ) : (
        <JournalBody journal={state.journal} />
      )}
    </Modal>
  );
}
