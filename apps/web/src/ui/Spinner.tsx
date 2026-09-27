import type { CSSProperties } from 'react';
import { cx } from './cx.ts';
import styles from './Spinner.module.css';

export interface SpinnerProps {
  /** Pixel size of the little board. Default 48. */
  size?: number;
  /** Russian status text. Read by screen readers; shown next to the spinner when `showLabel`. Default «Загружаю…». */
  label?: string;
  showLabel?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Loading indicator: a tiny 2 × 2 chessboard whose squares light up in turn. */
export function Spinner({ size = 48, label = 'Загружаю…', showLabel = false, className, style }: SpinnerProps) {
  return (
    <span role="status" className={cx(styles.spinner, className)} style={style}>
      <span className={styles.board} style={{ width: size, height: size }} aria-hidden="true">
        <span className={styles.square} />
        <span className={styles.square} />
        <span className={styles.square} />
        <span className={styles.square} />
      </span>
      <span className={showLabel ? styles.label : styles.srOnly}>{label}</span>
    </span>
  );
}
