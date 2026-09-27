import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import { cx } from './cx.ts';
import { Icon } from './icons.tsx';
import styles from './Screen.module.css';

/**
 * Where the page keeps free room for the fixed mascot dock (bottom-right, ~220 px):
 *  - 'side'   — an empty gutter on the right for the whole height (safe for scrolling pages); on narrow
 *               windows it turns into 'bottom'. Default.
 *  - 'bottom' — empty room under the content only.
 *  - 'none'   — the screen lays the dock area out itself (use the --mascot-dock-size token).
 */
export type ScreenDockSpace = 'side' | 'bottom' | 'none';

export interface ScreenProps {
  /** Page heading (<h1>). Keep it to 1–3 Russian words. */
  title: ReactNode;
  /** Optional short line under the title. */
  subtitle?: ReactNode;
  /** Shows the big back button when provided. */
  onBack?: () => void;
  /** Visible text of the back button; also its accessible name. Default «Назад». */
  backLabel?: string;
  /** Right side of the header: small buttons, badges. */
  actions?: ReactNode;
  dock?: ScreenDockSpace;
  /** 'wide' stretches the content to the full window (game board), 'normal' caps it at --screen-max-width. */
  width?: 'normal' | 'wide';
  /** Centers the content vertically — for one-viewport choice screens. */
  center?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Screen({ title, subtitle, onBack, backLabel = 'Назад', actions, dock = 'side', width = 'normal', center = false, className, children }: ScreenProps) {
  return (
    <div className={cx(styles.screen, className)} data-dock={dock} data-width={width}>
      <header className={styles.header}>
        <div className={styles.back}>
          {onBack ? (
            <Button variant="secondary" size="lg" icon={<Icon name="back" />} onClick={onBack} className={styles.backButton}>
              {backLabel}
            </Button>
          ) : null}
        </div>
        <div className={styles.titles}>
          <h1 className={styles.title}>{title}</h1>
          {subtitle !== undefined ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        <div className={styles.actions}>{actions}</div>
      </header>
      <main className={cx(styles.main, center && styles.center)}>
        <div className={styles.content}>{children}</div>
      </main>
    </div>
  );
}
