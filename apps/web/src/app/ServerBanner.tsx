import { useEffect, useState } from 'react';
import styles from './shell.module.css';

export interface ServerBannerProps {
  online: boolean;
  /** «Проверить ещё раз» — resolves when the check finished */
  onRetry: () => Promise<void>;
  /** the live game needs the room: start collapsed to a small chip */
  compact?: boolean;
}

/**
 * Shown while GET /api/health fails. It never blocks anything: the engine runs in the browser,
 * so the game stays playable, and saving is simply deferred until the server is back.
 */
export function ServerBanner({ online, onRetry, compact = false }: ServerBannerProps) {
  const [collapsed, setCollapsed] = useState(compact);
  const [checking, setChecking] = useState(false);

  // every new outage is announced in full again (except over the board)
  useEffect(() => {
    if (!online) setCollapsed(compact);
  }, [online, compact]);

  if (online) return null;

  if (collapsed) {
    return (
      <button type="button" className={styles.bannerChip} onClick={() => setCollapsed(false)} aria-label="Сервер тренера не отвечает. Подробнее">
        <span aria-hidden="true">🔌</span> Нет связи с сервером
      </button>
    );
  }

  const retry = (): void => {
    setChecking(true);
    void onRetry().finally(() => setChecking(false));
  };

  return (
    <aside className={styles.banner} role="status" aria-live="polite">
      <span className={styles.bannerIcon} aria-hidden="true">
        🔌
      </span>
      <div className={styles.bannerBody}>
        <p className={styles.bannerTitle}>Сервер тренера не отвечает</p>
        <p className={styles.bannerText}>Играть можно! Партии и успехи сохранятся, когда сервер снова заработает.</p>
        <p className={styles.bannerText}>Родителям: запустите «Шахматы.command» ещё раз.</p>
        <div className={styles.bannerActions}>
          <button type="button" className={styles.bannerButton} onClick={retry} disabled={checking}>
            {checking ? 'Проверяю…' : 'Проверить ещё раз'}
          </button>
          <button type="button" className={styles.bannerButton} onClick={() => setCollapsed(true)}>
            Понятно
          </button>
        </div>
      </div>
    </aside>
  );
}
