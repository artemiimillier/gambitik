import type { CSSProperties, ReactNode } from 'react';
import { cx } from './cx.ts';
import styles from './ProgressBar.module.css';

export type ProgressTone = 'teal' | 'sunny' | 'green' | 'coral';

export interface ProgressBarProps {
  /** Current value in 0..max (NOT a 0..1 fraction unless max is 1). Clamped. */
  value: number;
  /** Default 100. */
  max?: number;
  /** Visible caption above the bar; also the accessible name when it is a string. */
  label?: ReactNode;
  /** Accessible name when `label` is absent or not plain text (Russian). */
  'aria-label'?: string;
  /** Text on the right of the caption, e.g. «3 из 8». Default: no text. Pass true for a percentage. */
  valueText?: string | true;
  tone?: ProgressTone;
  /** Bar thickness. Default 'md' (20 px). */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  style?: CSSProperties;
}

export function ProgressBar({ value, max = 100, label, 'aria-label': ariaLabel, valueText, tone = 'teal', size = 'md', className, style }: ProgressBarProps) {
  const safeMax = max > 0 ? max : 100;
  const clamped = Math.max(0, Math.min(safeMax, Number.isFinite(value) ? value : 0));
  const pct = Math.round((clamped / safeMax) * 100);
  const text = valueText === true ? `${pct}%` : valueText;
  const name = ariaLabel ?? (typeof label === 'string' ? label : undefined) ?? 'Прогресс';

  return (
    <div className={cx(styles.wrap, className)} style={style}>
      {label !== undefined || text !== undefined ? (
        <div className={styles.caption}>
          <span className={styles.label}>{label}</span>
          {text !== undefined ? (
            <span className={styles.value} data-numeric>
              {text}
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        className={styles.track}
        data-tone={tone}
        data-size={size}
        role="progressbar"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={text}
      >
        <div className={styles.bar} style={{ width: `${pct}%` }} data-empty={pct === 0 || undefined} />
      </div>
    </div>
  );
}
