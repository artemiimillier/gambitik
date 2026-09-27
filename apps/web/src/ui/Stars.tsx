import type { CSSProperties } from 'react';
import { cx } from './cx.ts';
import { pluralRu } from './plural.ts';
import styles from './Stars.module.css';

export interface StarsProps {
  /** Earned stars; halves are drawn (2.5 → two and a half). Clamped to 0..max. */
  value: number;
  /** Total number of stars. Default 3. */
  max?: number;
  /** Pixel size of one star. Default 32. */
  size?: number;
  /** Plays a one-time pop-in for the earned stars (ignored with reduced motion). */
  animate?: boolean;
  /** Accessible name override. Default «2 звезды из 3». */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const STAR_PATH = 'M12 2.6l2.75 5.95 6.5.8-4.8 4.45 1.27 6.42L12 17.05l-5.72 3.17 1.27-6.42-4.8-4.45 6.5-.8z';

export function starsLabelRu(value: number, max: number): string {
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(1).replace('.', ',');
  const noun = Number.isInteger(value) ? pluralRu(value, 'звезда', 'звезды', 'звёзд') : 'звезды';
  return `${shown} ${noun} из ${max}`;
}

/** Stars for effort. Earned stars are filled, the rest are dashed outlines — readable without colour. */
export function Stars({ value, max = 3, size = 32, animate = false, label, className, style }: StarsProps) {
  const total = Math.max(1, Math.floor(max));
  const clamped = Math.max(0, Math.min(total, Math.round(value * 2) / 2));
  const items: ('full' | 'half' | 'empty')[] = [];
  for (let i = 0; i < total; i++) {
    items.push(clamped >= i + 1 ? 'full' : clamped >= i + 0.5 ? 'half' : 'empty');
  }

  return (
    <span role="img" aria-label={label ?? starsLabelRu(clamped, total)} className={cx(styles.stars, animate && styles.animate, className)} style={style}>
      {items.map((kind, i) => (
        <svg key={i} className={styles.star} data-kind={kind} style={{ animationDelay: `${i * 140}ms` }} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path className={styles.empty} d={STAR_PATH} />
          {kind !== 'empty' ? <path className={styles.fill} d={STAR_PATH} style={kind === 'half' ? { clipPath: 'inset(0 50% 0 0)' } : undefined} /> : null}
        </svg>
      ))}
    </span>
  );
}
