import type { CSSProperties, ReactNode } from 'react';
import styles from './Badge.module.css';
import { cx } from './cx.ts';

export type BadgeTone = 'teal' | 'sunny' | 'coral' | 'green' | 'blue' | 'neutral';

export interface BadgeProps {
  tone?: BadgeTone;
  /** 'solid' = saturated fill (attention), 'soft' = tinted (status). Default 'soft'. */
  variant?: 'solid' | 'soft';
  size?: 'sm' | 'md';
  /** Decorative icon before the text. */
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Small pill label: «Гамбитик советует», «Новое», «В самый раз». */
export function Badge({ tone = 'teal', variant = 'soft', size = 'md', icon, children, className, style }: BadgeProps) {
  return (
    <span className={cx(styles.badge, className)} data-tone={tone} data-variant={variant} data-size={size} style={style}>
      {icon !== undefined ? (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
